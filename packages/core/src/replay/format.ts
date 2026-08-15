/**
 * `crumbtrail.replay.v1` — the writing half of the session replay format.
 *
 * The reader lives in `crumbtrail-replay-protocol`, in the separate main
 * product repository, and neither side imports the other. That is deliberate:
 * this code runs inside a customer's page and that code turns what it produces
 * into DOM in an employee's browser, so a shared module would make one bug
 * reach both ends of the trust boundary at once.
 *
 * What holds the two together is the golden fixtures under
 * `src/__tests__/fixtures/replay/`, which exist byte for byte in both
 * repositories as parsed JSON. The encoder's suite proves it produces them and
 * the decoder's suite proves it reads them. Neither side can drift without a
 * fixture changing, and a fixture change is visible in both reviews.
 *
 * Every constant here is a wire constant. Renumbering one silently reinterprets
 * every stored session rather than failing.
 */

export const REPLAY_FORMAT = "crumbtrail.replay.v1";
export const REPLAY_SCHEMA_VERSION = 1;

export const ReplayEventTag = {
  Snapshot: 0,
  Mutation: 1,
  Input: 2,
  Pointer: 3,
  Scroll: 4,
  Viewport: 5,
  Interact: 6,
  Navigate: 7,
  Gap: 8,
} as const;

/** Node tags reuse the DOM's own `nodeType` numbers. */
export const ReplayNodeTag = {
  Element: 1,
  Text: 3,
  Comment: 8,
  Document: 9,
  DocumentType: 10,
} as const;

/** Why a stretch of nothing was recorded. Always stated, never silently skipped. */
export type ReplayGapReason = "idle" | "hidden" | "budget" | "paused";

/**
 * How much of the page a recording keeps.
 *
 * `inputs_masked` masks form values and keeps rendered text. `text_masked`
 * masks both, leaving layout and interaction, which is watchable for a flow bug
 * and useless for a wording one. The project chooses; the SDK is told.
 */
export type ReplayMasking = "inputs_masked" | "text_masked";

/** One chunk's reference on the manifest. */
export interface ReplayChunkRef {
  seq: number;
  startOffsetMs: number;
  endOffsetMs: number;
  bytes: number;
  checkout: boolean;
}

export interface ReplayManifest {
  schemaVersion: number;
  format: typeof REPLAY_FORMAT;
  sessionId: string;
  startedAt: number;
  durationMs: number;
  masking: ReplayMasking;
  chunks: ReplayChunkRef[];
  truncated: boolean;
  droppedChunks: number;
}

/** The stored name for a chunk. Zero padded so lexical order matches numeric. */
export function replayChunkName(seq: number): string {
  return `replay-${String(seq).padStart(6, "0")}.json.gz`;
}

/** The manifest's stored name, rewritten on every flush. */
export const REPLAY_MANIFEST_NAME = "replay.json";
