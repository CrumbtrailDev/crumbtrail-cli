/**
 * The recorder, driven against a real document with a clock the test owns.
 *
 * Every assertion here is about something a reader would be misled by if it
 * were wrong: what was uploaded under which name, what a recording admits it
 * lost, and what never leaves the page at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayRecorder, replaySupported } from "../replay/recorder";
import type { EncodedChunk } from "../replay/chunk";
import { ReplayEventTag, type ReplayManifest } from "../replay/format";

interface Upload {
  name: string;
  bytes: Uint8Array;
}

function makeRecorder(
  over: Partial<ConstructorParameters<typeof ReplayRecorder>[0]> = {},
) {
  const uploads: Upload[] = [];
  let clock = 1_000_000;
  const recorder = new ReplayRecorder({
    sessionId: "sess-1",
    masking: "inputs_masked",
    chunkMs: 1_000_000,
    now: () => clock,
    send: async (name, body) => {
      uploads.push({ name, bytes: new Uint8Array(await body.arrayBuffer()) });
    },
    ...over,
  });
  return {
    recorder,
    uploads,
    advance(ms: number) {
      clock += ms;
    },
    at() {
      return clock;
    },
  };
}

/** Gunzip an upload the same way the dashboard does, with the platform's own
 *  decompressor rather than a library. */
async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

async function chunkAt(uploads: Upload[], name: string): Promise<EncodedChunk> {
  const upload = uploads.find((entry) => entry.name === name);
  if (!upload) throw new Error(`no upload named ${name}`);
  return JSON.parse(await gunzip(upload.bytes)) as EncodedChunk;
}

function latestManifest(uploads: Upload[]): ReplayManifest {
  const manifests = uploads.filter((entry) => entry.name === "replay.json");
  const last = manifests[manifests.length - 1];
  if (!last) throw new Error("no manifest was written");
  return JSON.parse(new TextDecoder().decode(last.bytes)) as ReplayManifest;
}

/** Let the MutationObserver deliver its batch before asserting on it. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The events of a chunk, by tag, which is what most assertions are about. */
function tags(chunk: EncodedChunk): number[] {
  return chunk.e.map((event) => event[0] as number);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("replaySupported", () => {
  it("requires compression, because a chunk is stored gzipped", () => {
    expect(replaySupported()).toBe(true);
  });
});

describe("ReplayRecorder", () => {
  it("opens with a full snapshot and uploads it under a padded name", async () => {
    const { recorder, uploads } = makeRecorder();
    recorder.start();
    await recorder.flush();

    // Zero padded so lexical order matches numeric: a store that listed
    // 0, 1, 10, 2 would play the session in an order it never happened in.
    expect(uploads.map((entry) => entry.name)).toEqual([
      "replay-000000.json.gz",
      "replay.json",
    ]);
    const chunk = await chunkAt(uploads, "replay-000000.json.gz");
    expect(chunk.e[0]?.[0]).toBe(ReplayEventTag.Snapshot);
    const manifest = latestManifest(uploads);
    expect(manifest.chunks[0]?.checkout).toBe(true);
    expect(manifest).not.toHaveProperty("release");
    expect(manifest).not.toHaveProperty("build");
    expect(manifest).not.toHaveProperty("sdkVersion");
    await recorder.stop();
  });

  it("carries application and SDK identities in the manifest", async () => {
    const { recorder, uploads } = makeRecorder({
      release: "release-2026.08.26",
      build: "build-2026.08.26",
      sdkVersion: "0.39.0",
    });
    recorder.start();
    await recorder.flush();

    expect(latestManifest(uploads)).toMatchObject({
      release: "release-2026.08.26",
      build: "build-2026.08.26",
      sdkVersion: "0.39.0",
    });
    await recorder.stop();
  });

  it("records a page change as a delta against the snapshot", async () => {
    const { recorder, uploads, advance } = makeRecorder();
    document.body.innerHTML = '<div id="total">$42.00</div>';
    recorder.start();
    await recorder.flush();

    advance(1500);
    const total = document.getElementById("total") as HTMLElement;
    total.textContent = "$38.00";
    await settle();
    await recorder.flush();

    const delta = await chunkAt(uploads, "replay-000001.json.gz");
    expect(tags(delta)).toContain(ReplayEventTag.Mutation);
    expect(delta.s).toContain("$38.00");
    await recorder.stop();
  });

  it("never uploads what someone typed", async () => {
    const { recorder, uploads, advance } = makeRecorder();
    document.body.innerHTML = '<input id="email" type="email">';
    recorder.start();
    await recorder.flush();

    advance(200);
    const input = document.getElementById("email") as HTMLInputElement;
    input.value = "someone@example.com";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await recorder.flush();

    const chunk = await chunkAt(uploads, "replay-000001.json.gz");
    const body = JSON.stringify(chunk);
    expect(body).not.toContain("someone@example.com");
    // Length preserving and content free: an empty box and a filled one are
    // different states of the page.
    expect(chunk.s).toContain("*".repeat("someone@example.com".length));
    await recorder.stop();
  });

  it("declares the silence before an event rather than leaving a hole", async () => {
    const { recorder, uploads, advance } = makeRecorder({ idleMs: 1_000 });
    document.body.innerHTML = "<div>hello</div>";
    recorder.start();
    await recorder.flush();

    advance(30_000);
    (document.querySelector("div") as HTMLElement).textContent = "later";
    await settle();
    await recorder.flush();

    const chunk = await chunkAt(uploads, "replay-000001.json.gz");
    const gap = chunk.e.find((event) => event[0] === ReplayEventTag.Gap);
    expect(gap).toBeTruthy();
    // A player that inferred the gap from a hole in the timestamps could not
    // tell idle from "the recorder was killed".
    expect(gap?.[2]).toBe(30_000);
    expect(chunk.s[gap?.[3] as number]).toBe("idle");
    await recorder.stop();
  });

  it("counts a chunk it could not deliver instead of hiding it", async () => {
    let fail = true;
    const uploads: Upload[] = [];
    const recorder = new ReplayRecorder({
      sessionId: "sess-1",
      masking: "inputs_masked",
      chunkMs: 1_000_000,
      send: async (name, body) => {
        if (fail && name.startsWith("replay-")) throw new Error("shed");
        uploads.push({ name, bytes: new Uint8Array(await body.arrayBuffer()) });
      },
    });
    recorder.start();
    await recorder.flush();
    fail = false;

    const manifest = latestManifest(uploads);
    expect(manifest.droppedChunks).toBe(1);
    // The chunk is absent from the list, not listed as present and empty: a
    // player would wait forever for a chunk the manifest promised.
    expect(manifest.chunks).toEqual([]);
    await recorder.stop();
  });

  it("stops and says so when it reaches its byte ceiling", async () => {
    const { recorder, uploads, advance } = makeRecorder({ maxBytes: 1 });
    recorder.start();
    await recorder.flush();
    advance(100);

    expect(recorder.isRecording).toBe(false);
    expect(latestManifest(uploads).truncated).toBe(true);
  });

  it("does not record the widget the SDK injects", async () => {
    const { recorder, uploads } = makeRecorder();
    document.body.innerHTML =
      '<div id="crumbtrail-widget"><button>Report a bug</button></div><p>real page</p>';
    recorder.start();
    await recorder.flush();

    const chunk = await chunkAt(uploads, "replay-000000.json.gz");
    expect(chunk.s).toContain("real page");
    expect(chunk.s).not.toContain("Report a bug");
    await recorder.stop();
  });

  // The opening snapshot drops `value`, `nonce`, `integrity` and every `on*`
  // handler. The mutation branch used to re-read getAttribute with no filter at
  // all, so the guarantee lasted exactly until the first setAttribute — and
  // `el.setAttribute("value", ...)` is the ordinary vanilla/jQuery way to
  // prefill or clear a field. Asserted against the whole decompressed chunk,
  // not against a sibling field.
  it("never writes a mutated form value or security attribute into a chunk", async () => {
    const { recorder, uploads } = makeRecorder();
    document.body.innerHTML =
      '<form><input id="card" name="card"><script id="s"></script></form>';
    recorder.start();
    await recorder.flush();

    const pan = "4111111111111111";
    document.querySelector("#card")!.setAttribute("value", pan);
    document.querySelector("#s")!.setAttribute("nonce", "n0nc3-abc123");
    document.querySelector("#s")!.setAttribute("integrity", "sha384-zzz");
    document
      .querySelector("#card")!
      .setAttribute("onfocus", "stealTheThing(document.cookie)");
    // A layout attribute through the same path still records, so the filter is
    // a filter and not a mute button.
    document.querySelector("#card")!.setAttribute("class", "is-invalid");
    await settle();
    await recorder.flush();

    const serialized = JSON.stringify(
      await Promise.all(
        uploads
          .filter((entry) => entry.name.endsWith(".json.gz"))
          .map(async (entry) => JSON.parse(await gunzip(entry.bytes))),
      ),
    );
    expect(serialized).not.toContain(pan);
    expect(serialized).not.toContain("n0nc3-abc123");
    expect(serialized).not.toContain("sha384-zzz");
    expect(serialized).not.toContain("stealTheThing");
    expect(serialized).toContain("is-invalid");

    await recorder.stop();
  });

  it("masks rendered text as well under text_masked", async () => {
    const { recorder, uploads } = makeRecorder({ masking: "text_masked" });
    document.body.innerHTML = "<p>Order 4471 failed</p>";
    recorder.start();
    await recorder.flush();

    const chunk = await chunkAt(uploads, "replay-000000.json.gz");
    expect(chunk.s).not.toContain("Order 4471 failed");
    // Whitespace survives, so the page still lays out the way it did.
    expect(chunk.s).toContain("***** **** ******");
    expect(latestManifest(uploads).masking).toBe("text_masked");
    await recorder.stop();
  });
});
