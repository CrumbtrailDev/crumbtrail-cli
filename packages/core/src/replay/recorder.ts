/**
 * The recorder: a DOM stream, never pixels.
 *
 * One full snapshot, then deltas against it, flushed as gzipped chunks with a
 * manifest rewritten alongside them. A minute of video is megabytes; a minute
 * of DOM deltas on an ordinary page is tens of kilobytes, which is the whole
 * reason this is affordable to store.
 *
 * ## What it refuses to do
 *
 * - **It does not start itself.** Recording only happens for a project that
 *   asked for it, and the answer comes from the server on every config poll.
 * - **It does not hide what it lost.** A stretch of nothing is a `Gap` event
 *   carrying its reason, a chunk that failed to upload is counted on the
 *   manifest, and hitting a ceiling sets `truncated`. A reader who does not
 *   know the tail is missing reads its absence as the user having stopped.
 * - **It does not record anything it cannot mask.** Values are masked at the
 *   point of reading the DOM, so an unmasked value never reaches a buffer.
 *
 * ## Ceilings
 *
 * Bytes and duration are both capped, because this runs inside someone else's
 * production page. Reaching either stops the recording and says so; neither
 * silently trims, because a trimmed replay shows a session that did not happen.
 */

import { ChunkBuilder } from "./chunk";
import {
  REPLAY_FORMAT,
  REPLAY_MANIFEST_NAME,
  REPLAY_SCHEMA_VERSION,
  ReplayEventTag,
  replayChunkName,
  type ReplayChunkRef,
  type ReplayGapReason,
  type ReplayManifest,
  type ReplayMasking,
} from "./format";
import {
  NodeIds,
  isExcluded,
  isRecordableAttribute,
  maskText,
  maskValue,
  serializeNode,
  type SerializeOptions,
} from "./serialize";

export interface ReplayRecorderOptions {
  sessionId: string;
  masking: ReplayMasking;
  /** Upload one stored object. Rejecting counts the chunk as never delivered. */
  send: (name: string, body: Blob) => Promise<void>;
  doc?: Document;
  win?: Window;
  now?: () => number;
  /** How often a chunk is closed and uploaded. */
  chunkMs?: number;
  /** How often a chunk opens with a full snapshot, so a seek is cheap. */
  checkoutMs?: number;
  /** Silence longer than this is recorded as a gap rather than as nothing. */
  idleMs?: number;
  /** Total uploaded bytes before the recording stops and says it is truncated. */
  maxBytes?: number;
  /** Wall clock length before the recording stops and says it is truncated. */
  maxDurationMs?: number;
}

const DEFAULT_CHUNK_MS = 5_000;
const DEFAULT_CHECKOUT_MS = 60_000;
const DEFAULT_IDLE_MS = 5_000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_DURATION_MS = 30 * 60 * 1000;

/** Pointer samples are batched rather than sent one per move. */
const POINTER_BATCH_MS = 500;
/** Scroll is throttled: a wheel produces dozens of events per second. */
const SCROLL_THROTTLE_MS = 100;

/**
 * Whether this runtime can record at all.
 *
 * `CompressionStream` is the one hard requirement. A chunk is stored gzipped,
 * and shipping an inflate library into a customer's bundle to duplicate
 * something the platform already has is a cost paid on every page load for a
 * feature most projects leave off.
 */
export function replaySupported(): boolean {
  const global = globalThis as {
    MutationObserver?: unknown;
    CompressionStream?: unknown;
  };
  return (
    typeof global.MutationObserver === "function" &&
    typeof global.CompressionStream === "function"
  );
}

export class ReplayRecorder {
  private readonly options: Required<
    Omit<ReplayRecorderOptions, "doc" | "win" | "now" | "send">
  > &
    Pick<ReplayRecorderOptions, "send">;
  private readonly doc: Document;
  private readonly win: Window;
  private readonly now: () => number;

  private readonly ids = new NodeIds();
  private chunk: ChunkBuilder | undefined;
  private chunks: ReplayChunkRef[] = [];
  private nextSeq = 0;
  private startedAt = 0;
  private lastCheckoutAt = 0;
  private lastActivityAt = 0;
  private lastEventAbsoluteMs = 0;
  private uploadedBytes = 0;
  private droppedChunks = 0;
  private truncated = false;
  private running = false;

  private observer: MutationObserver | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private teardown: Array<() => void> = [];
  private pointerSamples: Array<[number, number, number]> = [];
  private pointerBatchAt = 0;
  private lastScrollAt = 0;
  private lastUrl = "";
  private hiddenAt: number | undefined;
  /** Uploads are serialized so the manifest never describes an order that did not happen. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: ReplayRecorderOptions) {
    this.doc = options.doc ?? document;
    this.win = options.win ?? window;
    this.now = options.now ?? (() => Date.now());
    this.options = {
      sessionId: options.sessionId,
      masking: options.masking,
      send: options.send,
      chunkMs: options.chunkMs ?? DEFAULT_CHUNK_MS,
      checkoutMs: options.checkoutMs ?? DEFAULT_CHECKOUT_MS,
      idleMs: options.idleMs ?? DEFAULT_IDLE_MS,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      maxDurationMs: options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
    };
  }

  get isRecording(): boolean {
    return this.running;
  }

  /** Take the opening snapshot and start watching. Safe to call twice. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.now();
    this.lastActivityAt = this.startedAt;
    this.lastUrl = this.currentUrl();
    this.openChunk(true);
    this.observe();
    this.timer = setInterval(() => {
      void this.flush();
    }, this.options.chunkMs);
  }

  /**
   * Stop watching and upload whatever is buffered.
   *
   * The final flush runs before the observers come down. A stop that tore down
   * first would discard the last chunk interval, which on a session that ended
   * in a failure is the interval holding the failure.
   */
  async stop(reason: ReplayGapReason = "paused"): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.emitPointerBatch(true);
    if (reason === "budget") this.truncated = true;
    this.observer?.disconnect();
    this.observer = undefined;
    for (const off of this.teardown) off();
    this.teardown = [];
    await this.flush(true);
  }

  /* ---------------------------------------------------------------- *
   * Chunking and upload.
   * ---------------------------------------------------------------- */

  private openChunk(checkout: boolean): void {
    const base = this.now();
    this.chunk = new ChunkBuilder(this.nextSeq, base);
    this.nextSeq += 1;
    if (!checkout) return;
    this.lastCheckoutAt = base;
    const root = serializeNode(this.doc, this.serializeOptions());
    if (!root) return;
    this.chunk.push([
      ReplayEventTag.Snapshot,
      0,
      root,
      this.win.innerWidth || 0,
      this.win.innerHeight || 0,
    ]);
    this.markActivity(base);
  }

  private serializeOptions(): SerializeOptions {
    const chunk = this.chunk;
    return {
      masking: this.options.masking,
      intern: (value: string) => chunk?.intern(value) ?? 0,
      ids: this.ids,
    };
  }

  /**
   * Close the current chunk, upload it, and rewrite the manifest.
   *
   * Uploads are chained rather than fired in parallel: the manifest is a single
   * object rewritten on every flush, and two overlapping writes would leave
   * whichever landed second describing the recording, which may be the older
   * one.
   */
  async flush(final = false): Promise<void> {
    const chunk = this.chunk;
    if (!chunk || chunk.eventCount === 0) {
      if (final) await this.queueManifest();
      return;
    }
    const body = JSON.stringify(chunk.toJSON());
    const startOffsetMs = chunk.baseMs - this.startedAt + chunk.firstOffsetMs;
    const endOffsetMs = chunk.baseMs - this.startedAt + chunk.lastOffsetMs;
    const checkout = chunk.checkout;
    const seq = chunk.seq;

    const needsCheckout =
      this.now() - this.lastCheckoutAt >= this.options.checkoutMs;
    this.chunk = undefined;
    if (this.running && !final) this.openChunk(needsCheckout);

    this.queue = this.queue.then(async () => {
      let compressed: Blob;
      try {
        compressed = await gzip(body);
      } catch {
        this.droppedChunks += 1;
        return;
      }
      try {
        await this.options.send(replayChunkName(seq), compressed);
      } catch {
        // Counted, not hidden. A hole in a replay is evidence about the
        // capture, not about the session.
        this.droppedChunks += 1;
        return;
      }
      this.uploadedBytes += compressed.size;
      this.chunks.push({
        seq,
        startOffsetMs: Math.max(0, startOffsetMs),
        endOffsetMs: Math.max(0, endOffsetMs),
        bytes: compressed.size,
        checkout,
      });
      if (this.uploadedBytes >= this.options.maxBytes) this.truncated = true;
    });
    await this.queueManifest();
    if (this.truncated && this.running) await this.stop("budget");
  }

  private async queueManifest(): Promise<void> {
    this.queue = this.queue.then(async () => {
      const manifest: ReplayManifest = {
        schemaVersion: REPLAY_SCHEMA_VERSION,
        format: REPLAY_FORMAT,
        sessionId: this.options.sessionId,
        startedAt: this.startedAt,
        durationMs: Math.max(0, this.lastEventAbsoluteMs),
        masking: this.options.masking,
        chunks: this.chunks,
        truncated: this.truncated,
        droppedChunks: this.droppedChunks,
      };
      try {
        await this.options.send(
          REPLAY_MANIFEST_NAME,
          new Blob([JSON.stringify(manifest)], { type: "application/json" }),
        );
      } catch {
        // A manifest that failed to land is rewritten on the next flush, so
        // there is nothing to record here that the next write does not fix.
      }
    });
    await this.queue;
  }

  /* ---------------------------------------------------------------- *
   * Event capture.
   * ---------------------------------------------------------------- */

  /**
   * Append an event, first declaring any silence that preceded it.
   *
   * The gap is emitted from the recorder's own clock rather than inferred by a
   * player from a hole in the timestamps: a hole could equally mean the
   * recorder was killed, and those are different things to tell a reader.
   */
  private push(tuple: unknown[]): void {
    if (!this.running || !this.chunk) return;
    const at = this.now();
    if (at - this.startedAt >= this.options.maxDurationMs) {
      this.truncated = true;
      void this.stop("budget");
      return;
    }
    const idle = at - this.lastActivityAt;
    if (idle >= this.options.idleMs) {
      this.chunk.push([
        ReplayEventTag.Gap,
        this.offsetFor(this.lastActivityAt),
        idle,
        this.chunk.intern(this.hiddenAt === undefined ? "idle" : "hidden"),
      ]);
    }
    tuple[1] = this.offsetFor(at);
    this.chunk.push(tuple);
    this.markActivity(at);
  }

  /** A chunk-relative offset that never runs backwards. */
  private offsetFor(at: number): number {
    const chunk = this.chunk;
    if (!chunk) return 0;
    return Math.max(chunk.lastOffsetMs, Math.max(0, at - chunk.baseMs));
  }

  private markActivity(at: number): void {
    this.lastActivityAt = at;
    this.lastEventAbsoluteMs = Math.max(
      this.lastEventAbsoluteMs,
      at - this.startedAt,
    );
  }

  private currentUrl(): string {
    try {
      return this.win.location?.href ?? "";
    } catch {
      return "";
    }
  }

  private observe(): void {
    const observer = new MutationObserver((records: MutationRecord[]) =>
      this.onMutations(records),
    );
    this.observer = observer;
    observer.observe(this.doc, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    this.on(this.doc, "input", (event) => this.onInput(event), true);
    this.on(this.doc, "change", (event) => this.onInput(event), true);
    this.on(this.doc, "click", (event) => this.onInteract(event), true);
    this.on(this.doc, "scroll", (event) => this.onScroll(event), true);
    this.on(this.win, "resize", () => this.onResize());
    this.on(this.win, "popstate", () => this.checkNavigation());
    this.on(this.win, "hashchange", () => this.checkNavigation());
    this.on(this.doc, "visibilitychange", () => this.onVisibility());
    if (
      typeof (globalThis as { PointerEvent?: unknown }).PointerEvent ===
      "function"
    )
      this.on(this.doc, "pointermove", (event) => this.onPointer(event), true);
    else this.on(this.doc, "mousemove", (event) => this.onPointer(event), true);
  }

  private on(
    target: Document | Window,
    type: string,
    handler: (event: Event) => void,
    capture = false,
  ): void {
    const listener = handler as EventListener;
    target.addEventListener(type, listener, { capture, passive: true });
    this.teardown.push(() =>
      target.removeEventListener(type, listener, { capture }),
    );
  }

  private onMutations(records: MutationRecord[]): void {
    if (!this.running || !this.chunk) return;
    const options = this.serializeOptions();
    const adds: unknown[] = [];
    const removes: number[] = [];
    const attrs: unknown[] = [];
    const texts: unknown[] = [];

    for (const record of records) {
      if (isExcluded(record.target)) continue;
      if (record.type === "attributes") {
        const target = record.target as Element;
        const id = this.ids.known(target);
        if (id === undefined || !record.attributeName) continue;
        // The same filter the opening snapshot applies. Without it a page that
        // writes a form value through setAttribute puts the raw value into the
        // chunk, and the snapshot's careful exclusion of `value`, `nonce`,
        // `integrity` and `on*` lasts exactly until the first mutation.
        if (!isRecordableAttribute(record.attributeName)) continue;
        const value = target.getAttribute(record.attributeName);
        attrs.push([
          id,
          [
            options.intern(record.attributeName),
            value === null || value === "" ? null : options.intern(value),
          ],
        ]);
        continue;
      }
      if (record.type === "characterData") {
        const id = this.ids.known(record.target);
        if (id === undefined) continue;
        const raw = record.target.textContent ?? "";
        texts.push([
          id,
          options.intern(
            this.options.masking === "text_masked" ? maskText(raw) : raw,
          ),
        ]);
        continue;
      }
      // Removals are collected before additions. A recorder coalescing a move
      // emits both, and the player applies removals first for the same reason.
      for (const removed of Array.from(record.removedNodes)) {
        const id = this.ids.known(removed);
        if (id !== undefined) removes.push(id);
      }
      for (const added of Array.from(record.addedNodes)) {
        if (isExcluded(added)) continue;
        // A node added and removed again before this batch was processed is no
        // longer anywhere. Serializing it would place content the page does not
        // have.
        if (!added.parentNode) continue;
        const parentId = this.ids.known(added.parentNode);
        if (parentId === undefined) continue;
        const node = serializeNode(added, options);
        if (!node) continue;
        const next = added.nextSibling;
        const nextId = next ? (this.ids.known(next) ?? null) : null;
        adds.push([parentId, nextId, node]);
      }
    }

    if (
      adds.length === 0 &&
      removes.length === 0 &&
      attrs.length === 0 &&
      texts.length === 0
    )
      return;
    this.push([ReplayEventTag.Mutation, 0, adds, removes, attrs, texts]);
    this.checkNavigation();
  }

  private onInput(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element) || isExcluded(target)) return;
    const id = this.ids.known(target);
    if (id === undefined || !this.chunk) return;
    const value =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
        ? target.value
        : "";
    const checked =
      target instanceof HTMLInputElement &&
      (target.type === "checkbox" || target.type === "radio")
        ? target.checked
        : null;
    // Masked here, at the point of reading, in both modes. A recording is not
    // the place a customer's visitor's form values become readable.
    this.push([
      ReplayEventTag.Input,
      0,
      id,
      this.chunk.intern(maskValue(value)),
      checked,
    ]);
  }

  private onInteract(event: Event): void {
    const target = event.target;
    if (!(target instanceof Node) || isExcluded(target)) return;
    const id = this.ids.known(target);
    if (id === undefined || !this.chunk) return;
    this.push([ReplayEventTag.Interact, 0, id, this.chunk.intern(event.type)]);
  }

  private onScroll(event: Event): void {
    const at = this.now();
    if (at - this.lastScrollAt < SCROLL_THROTTLE_MS) return;
    this.lastScrollAt = at;
    const target = event.target;
    const element =
      target instanceof Element
        ? target
        : (this.doc.scrollingElement ?? this.doc.documentElement);
    if (!element || isExcluded(element)) return;
    const id = this.ids.known(element);
    if (id === undefined) return;
    this.push([
      ReplayEventTag.Scroll,
      0,
      id,
      element.scrollLeft,
      element.scrollTop,
    ]);
  }

  private onResize(): void {
    this.push([
      ReplayEventTag.Viewport,
      0,
      this.win.innerWidth || 0,
      this.win.innerHeight || 0,
    ]);
  }

  private onPointer(event: Event): void {
    const pointer = event as MouseEvent;
    const at = this.now();
    if (this.pointerSamples.length === 0) this.pointerBatchAt = at;
    this.pointerSamples.push([
      Math.max(0, at - this.pointerBatchAt),
      pointer.clientX,
      pointer.clientY,
    ]);
    if (at - this.pointerBatchAt >= POINTER_BATCH_MS) this.emitPointerBatch();
  }

  /**
   * Emit the buffered pointer positions as one event.
   *
   * Batched because a pointer produces tens of samples a second, and one event
   * per sample would make the cursor the most expensive thing in the recording
   * while being the least informative.
   */
  private emitPointerBatch(force = false): void {
    if (this.pointerSamples.length === 0) return;
    if (!force && !this.running) return;
    const samples = this.pointerSamples;
    this.pointerSamples = [];
    this.push([ReplayEventTag.Pointer, 0, samples]);
  }

  private checkNavigation(): void {
    const url = this.currentUrl();
    if (url === this.lastUrl || !this.chunk) return;
    this.lastUrl = url;
    this.push([ReplayEventTag.Navigate, 0, this.chunk.intern(url)]);
  }

  /**
   * A hidden page is not an idle one.
   *
   * Nothing was observable while the tab was in the background, which is a
   * different statement from the user sitting still, and a reader deciding
   * whether they have the whole story needs to tell them apart.
   */
  private onVisibility(): void {
    if (this.doc.visibilityState === "hidden") {
      this.hiddenAt = this.now();
      void this.flush();
      return;
    }
    this.hiddenAt = undefined;
  }
}

/** gzip a string. Compression is required, so a failure is the caller's to count. */
async function gzip(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(
    new (
      globalThis as unknown as {
        CompressionStream: new (format: string) => TransformStream;
      }
    ).CompressionStream("gzip"),
  );
  return await new Response(stream as BodyInit).blob();
}
