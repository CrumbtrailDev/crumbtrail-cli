const UUID_SEGMENT_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_DIGEST_SEGMENT_RE = /^[0-9a-f]{24,}$/i;
const ULID_SEGMENT_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Redacts path segments that are shaped like an opaque identifier, not segments
 * that are merely long. The previous rule redacted every segment of 16 or more
 * word characters, which erased ordinary monorepo directories
 * (`notification-service`, `payment-processing`) from the one field the
 * dashboard uses to find the failing source file, while the identical path
 * survived in the stack string of the same record. Only UUIDs, hex digests,
 * ULIDs and separator-free high entropy blobs are identifiers; a directory or
 * route literal made of words is not.
 *
 * Secrets with a recognisable prefix (Bearer, JWT, `sk_`/`ghp_`/…) and long
 * tokens are already removed by `redactTokenLikeString` before this runs, and
 * query and parameter values are handled by `redactUrl`. This function only
 * decides path structure.
 *
 * Lives in its own module because both the post-process plane and the
 * causal-graph plane redact paths, `post-process.ts` imports `causal-graph.ts`
 * (so the reverse import would be a cycle), and the first version of this rule
 * shipped as two byte-identical copies — which is how the length-based defect
 * survived being fixed once.
 */
export function redactPathTokens(value: string): string {
  return value
    .split("/")
    .map((segment) => {
      // A stack frame carries `:line:col` and closing punctuation on its last
      // segment. Judge the segment without it, so a path is classified the same
      // way in `stk` as it is in `file`.
      const suffix = STACK_LOCATION_SUFFIX_RE.exec(segment)?.[0] ?? "";
      const core = suffix ? segment.slice(0, -suffix.length) : segment;
      return isOpaqueIdSegment(core) ? `[REDACTED]${suffix}` : segment;
    })
    .join("/");
}

const STACK_LOCATION_SUFFIX_RE = /(?::\d+){1,2}[)\]}>,;'"]*$/;

function isOpaqueIdSegment(segment: string): boolean {
  if (segment.length < 16) return false;
  if (UUID_SEGMENT_RE.test(segment)) return true;
  if (HEX_DIGEST_SEGMENT_RE.test(segment)) return true;
  if (ULID_SEGMENT_RE.test(segment)) return true;
  // A file name is the code pointer itself. `index-a1b2c3d4e5f6g7h8.js` is a
  // build hash, not a secret, and losing it costs the source-file match.
  if (/\.[A-Za-z0-9]{1,8}$/.test(segment)) return false;
  return segment.split(/[-_.]/).some(isOpaqueIdChunk);
}

/**
 * A run of 16 or more characters mixing letters and digits with no separator.
 * `1234567890abcdef` in `supersecret-token-1234567890abcdef` is an id; every
 * chunk of `notification-service` is a word.
 */
function isOpaqueIdChunk(chunk: string): boolean {
  return (
    chunk.length >= 16 &&
    /^[A-Za-z0-9]+$/.test(chunk) &&
    /[A-Za-z]/.test(chunk) &&
    /[0-9]/.test(chunk)
  );
}
