/**
 * Building one chunk: the string table, the events, and the size accounting.
 *
 * Two of the five decisions that carry the format's byte budget live here.
 * Events are positional tuples, so a mutation-heavy page does not repeat key
 * names once per record; and every repeated string is interned to an integer,
 * because a framework's generated class attribute is frequently longer than the
 * element carrying it.
 *
 * The table is in first-seen order, which is not cosmetic. An encoder interns
 * strings as it meets them, so any other order is an order no encoder could
 * have produced, and the golden fixtures would be unsatisfiable on this side
 * while still passing every decoder test.
 */

import { REPLAY_SCHEMA_VERSION } from "./format";

/** The JSON shape a chunk is stored as, before compression. */
export interface EncodedChunk {
  v: number;
  seq: number;
  base: number;
  s: string[];
  e: unknown[][];
}

export class ChunkBuilder {
  readonly seq: number;
  readonly baseMs: number;
  private readonly strings: string[] = [];
  private readonly index = new Map<string, number>();
  private readonly events: unknown[][] = [];
  /**
   * Rough encoded size, kept as events are added.
   *
   * An estimate rather than a measurement: the real answer needs
   * `JSON.stringify` over the whole chunk, and the only question it is asked is
   * "is this chunk big enough to flush", where being a few percent out costs
   * nothing and stringifying on every mutation costs a page its frame budget.
   */
  private bytes = 0;

  constructor(seq: number, baseMs: number) {
    this.seq = seq;
    this.baseMs = baseMs;
  }

  /** The table index for a string, interning it on first sight. */
  intern(value: string): number {
    const existing = this.index.get(value);
    if (existing !== undefined) return existing;
    const next = this.strings.length;
    this.index.set(value, next);
    this.strings.push(value);
    this.bytes += value.length + 3;
    return next;
  }

  push(event: unknown[]): void {
    this.events.push(event);
    // Two bytes per tuple slot covers a small integer and its separator; a
    // nested tuple is counted by its own slots through the same walk.
    this.bytes += countSlots(event) * 2;
  }

  get eventCount(): number {
    return this.events.length;
  }

  get estimatedBytes(): number {
    return this.bytes;
  }

  /** Whether this chunk opens with a full snapshot, so a player can start cold. */
  get checkout(): boolean {
    return this.events[0]?.[0] === 0;
  }

  /** Offset of the first event within the chunk, or 0 for an empty one. */
  get firstOffsetMs(): number {
    return (this.events[0]?.[1] as number | undefined) ?? 0;
  }

  /** Offset of the last event within the chunk, or 0 for an empty one. */
  get lastOffsetMs(): number {
    const last = this.events[this.events.length - 1];
    return (last?.[1] as number | undefined) ?? 0;
  }

  toJSON(): EncodedChunk {
    return {
      v: REPLAY_SCHEMA_VERSION,
      seq: this.seq,
      base: this.baseMs,
      s: this.strings,
      e: this.events,
    };
  }
}

function countSlots(value: unknown[]): number {
  let total = value.length;
  for (const entry of value) {
    if (Array.isArray(entry)) total += countSlots(entry);
  }
  return total;
}
