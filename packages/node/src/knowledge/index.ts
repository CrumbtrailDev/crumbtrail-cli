/**
 * Public surface of the spec oracle (`knowledge.v1`).
 *
 * Importing this barrel has **no** side effects on the evidence framework. It
 * registers nothing, so `EVIDENCE_SOURCE_PROVIDERS.length` is identical before
 * and after — the counterpart to `evidence-sources/index.ts`, which exists
 * precisely so that importing it *does* populate the registry. The two barrels
 * behaving differently is the point, and CP4's boundary test pins it.
 *
 * `packages/node/src/index.ts` deliberately does not re-export this yet; the
 * `searchSpecs` MCP tool (CP3) is the intended first consumer.
 *
 * @see docs/specs/2026-07-19-confluence-spec-oracle-design.md
 */
export {
  capExcerptBytes,
  confluenceClientFromEnv,
  ConfluenceKnowledgeClient,
  CONFLUENCE_API_TOKEN_ENV,
  CONFLUENCE_AUTH_FIELDS,
  CONFLUENCE_BASE_URL_ENV,
  CONFLUENCE_EMAIL_ENV,
  CONFLUENCE_SPACE_KEYS_ENV,
  DEFAULT_SPEC_LIMIT,
  htmlToText,
  MAX_EXCERPT_BYTES,
  MAX_SPEC_LIMIT,
  notConfiguredKnowledgeResult,
  parseSpaceKeysEnv,
  type ConfluenceClientConfig,
  type SpecSearchRequest,
} from "./confluence";

export {
  buildSpecSearchCql,
  describeCqlInputLoss,
  MAX_QUERY_LENGTH,
  sanitizeCqlText,
  sanitizeSpaceKeys,
  type CqlInputLoss,
  type SpecCqlInput,
  type SpecCqlResult,
} from "./cql";

export {
  isHardKnowledgeGap,
  knowledgeGap,
  KNOWLEDGE_GAP_LANE,
  type KnowledgeGapInput,
  type KnowledgeGapKind,
} from "./gaps";

export {
  deriveAgeDays,
  KNOWLEDGE_SCHEMA_VERSION,
  systemClock,
  type KnowledgeClock,
  type KnowledgeResult,
  type SpecExcerpt,
} from "./types";
