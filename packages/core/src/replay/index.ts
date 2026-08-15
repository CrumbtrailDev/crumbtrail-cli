/**
 * Session replay, the writing half.
 *
 * The reader is `crumbtrail-replay-protocol` in the main product repository.
 * Neither imports the other; the golden fixtures under
 * `src/__tests__/fixtures/replay/` are what hold them together.
 */

export {
  REPLAY_FORMAT,
  REPLAY_MANIFEST_NAME,
  REPLAY_SCHEMA_VERSION,
  ReplayEventTag,
  ReplayNodeTag,
  replayChunkName,
  type ReplayChunkRef,
  type ReplayGapReason,
  type ReplayManifest,
  type ReplayMasking,
} from "./format";
export { ChunkBuilder, type EncodedChunk } from "./chunk";
export {
  NodeIds,
  isExcluded,
  maskText,
  maskValue,
  serializeAttributes,
  serializeNode,
  type SerializeOptions,
} from "./serialize";
export {
  ReplayRecorder,
  replaySupported,
  type ReplayRecorderOptions,
} from "./recorder";
