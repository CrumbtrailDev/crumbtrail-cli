export const BROWSER_REDACTION_POLICY = "crumbtrail.browser-redaction.v1";
/**
 * Structure-preserving network-body redaction. Emitted only on JSON bodies that
 * went through the v2 per-value classifier; every other capture plane (storage,
 * console, cookies, inputs, headers, URLs) stays on the v1 policy tag.
 */
export const BROWSER_REDACTION_POLICY_V2 = "crumbtrail.browser-redaction.v2";
export type BrowserRedactionPolicy =
  typeof BROWSER_REDACTION_POLICY | typeof BROWSER_REDACTION_POLICY_V2;
export const REDACTED_VALUE = "[REDACTED]";
export const REDACTED_STORAGE_KEY = "[REDACTED_KEY]";

/**
 * The marker's own brackets, percent-encoded by a URL or form serializer.
 *
 * `URLSearchParams.toString()` and `encodeURIComponent` both escape `[` and `]`,
 * so a redacted URL was stored as `…/auth/%5BREDACTED%5D/token` and every
 * consumer downstream rendered that literally — issue titles, runtime warnings,
 * error text. The marker is meant to be read by people, so it is written back
 * unescaped after serialization. Nothing else about the encoded string changes:
 * only markers this module just substituted are decoded.
 */
const ENCODED_REDACTED_VALUE_RE = /%5BREDACTED%5D/gi;
const ENCODED_REDACTED_SHAPE_RE =
  /%5BREDACTED%3Blen%3D\d{1,7}%3Bcharset%3D(?:alpha|num|alnum|mixed)(?:%3Bseparators%3D[0-9a-z.,_%-]+)?%5D/gi;

/**
 * Restore a redaction marker in an already percent-encoded URL or query string.
 *
 * Exported because the capture server rebuilds URLs of its own — post-process
 * diagnostics and the LLM bundle both re-serialize through `URLSearchParams` —
 * and a marker that is literal in one artifact and escaped in another is worse
 * than either, since the two no longer compare equal.
 */
export function unescapeRedactionMarker(serialized: string): string {
  const withShapes = serialized.replace(
    ENCODED_REDACTED_SHAPE_RE,
    (encoded) => {
      try {
        const decoded = decodeURIComponent(encoded);
        return isRedactedQueryShape(decoded) ? decoded : encoded;
      } catch {
        return encoded;
      }
    },
  );
  return withShapes.replace(ENCODED_REDACTED_VALUE_RE, REDACTED_VALUE);
}

export type RedactionAction = "redacted" | "dropped" | "summarized";

export interface RedactionField {
  path: string;
  reason: string;
  action: RedactionAction;
}

export interface PayloadSummary {
  kind:
    | "json"
    | "text"
    | "form"
    | "binary"
    | "stream"
    | "storage"
    | "cookie"
    | "input"
    | "unknown";
  action: RedactionAction;
  reason: string;
  originalLength?: number;
  contentLength?: string;
  limit?: number;
  redactedFields?: number;
}

export interface RedactionMetadata {
  policy: BrowserRedactionPolicy;
  fields: RedactionField[];
  summaries?: PayloadSummary[];
  /**
   * Field names the application declared keepable, carried so the capture
   * server's re-classification can apply the same name exemption.
   *
   * Without it the server re-runs with an empty keep list and placeholders
   * every name the application deliberately kept, which is how a declared
   * `error` or `message` still reached disk as `[REDACTED]`. This is a
   * declaration, not a grant: the server re-runs every value-based check, so a
   * token or card number inside a kept field is still caught.
   */
  keep?: string[];
}

export interface RedactionResult<T> {
  value: T;
  metadata?: RedactionMetadata;
  summary?: PayloadSummary;
  /** See {@link CredentialPresence}. Set by {@link redactHeaders} only. */
  credentials?: CredentialPresence;
}

/**
 * Whether a request carried credentials, without carrying them.
 *
 * Redaction removes an `authorization` header and a `cookie` header along with
 * their values, which is right — and it also removes the only evidence that
 * they existed. Downstream, a 401 the client asked for (an app checking whether
 * anyone is signed in, on every page load) and a 401 that means authentication
 * is broken become the same record. One is the product's designed behaviour and
 * the other is a defect, and nothing can tell them apart.
 *
 * These two booleans are computed where the sensitive names are already
 * identified, and carry no value, no prefix and no length. Presence only.
 */
export interface CredentialPresence {
  /** An `authorization` or `proxy-authorization` header was present, non-empty. */
  authorization: boolean;
  /** A `cookie` header was present carrying a cookie whose NAME looks like a
   *  session identifier. The name is matched, never the value. */
  sessionCookie: boolean;
}

/**
 * Cookie names that identify a session. Deliberately name-only: the value is
 * the secret and is never inspected, and a name is not a credential.
 */
const SESSION_COOKIE_NAME =
  /^(.*[-_.])?(sess|session|sessionid|sid|connect\.sid|jsessionid|phpsessid|asp\.net_sessionid|auth|authtoken|token|jwt|access[-_]?token|refresh[-_]?token|remember[-_]?me)([-_.].*)?$/i;

/**
 * Whether these headers carried credentials.
 *
 * Exported separately because it must run even when header CAPTURE is off:
 * storing no headers is a policy about values, and presence is not a value.
 * A deployment that captures no headers still needs to tell a signed-out
 * handshake from broken authentication.
 */
export function credentialPresence(
  headers: Record<string, string> | undefined,
): CredentialPresence {
  const presence: CredentialPresence = {
    authorization: false,
    sessionCookie: false,
  };
  if (!headers) return presence;
  for (const name in headers) {
    if (!Object.prototype.hasOwnProperty.call(headers, name)) continue;
    const value = headers[name];
    const raw = typeof value === "string" ? value : String(value ?? "");
    if (raw.trim() === "") continue;
    const normalized = name.trim().toLowerCase();
    if (normalized === "authorization" || normalized === "proxy-authorization") {
      presence.authorization = true;
    } else if (normalized === "cookie") {
      // Names only. The value after the first `=` is never read.
      if (cookieNames(raw).some((n) => SESSION_COOKIE_NAME.test(n))) {
        presence.sessionCookie = true;
      }
    }
  }
  return presence;
}

/** Cookie NAMES from a raw Cookie header. Values are discarded unread. */
function cookieNames(header: string): string[] {
  const names: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    const name = (eq >= 0 ? part.slice(0, eq) : part).trim();
    if (name !== "") names.push(name);
  }
  return names;
}

export interface BodyRedactionResult {
  body?: string;
  bodySummary?: PayloadSummary;
  metadata?: RedactionMetadata;
}

/**
 * Options for {@link redactNetworkTextBody}. Only the network collector
 * (collectors/network.ts) call sites opt into structured (v2) mode; all other
 * body-redaction callers stay on the v1 path.
 */
export interface BodyRedactionOptions {
  contentType?: string | null;
  maxLength?: number;
  path?: string;
  /**
   * "structured": every JSON body the caller is willing to store goes through
   * the v2 per-value classifier (structure preserved, sensitive values replaced
   * with `[REDACTED]` + shape metadata, policy tag bumped to v2). "full"
   * (default at this layer) keeps the v1 whole-body behavior exactly.
   *
   * There is deliberately no size gate here. Redaction strength must not be a
   * function of payload size: a size-gated downgrade silently applies a weaker
   * policy to exactly the large bodies most likely to contain a card number or
   * an address book. `maxLength` is the only size decision, and it drops the
   * body rather than downgrading how it is scrubbed.
   */
  mode?: StructuredRedactionMode;
  /**
   * Extra field names added to the deny list. Matched the same way as the
   * built-in deny tokens: as substrings of the compacted (lowercased,
   * alphanumeric-only) field name, so `"coupon"` also redacts `couponCode`.
   */
  denyFields?: string[];
  /**
   * Field names exempted from the *name-based* deny rules and from the
   * free-text catch-all, matched on the whole compacted name rather than as a
   * substring — an allowance is a narrower thing than a denial, so `"body"`
   * keeps `body` but not `passwordBody`.
   *
   * The classifier is name-based and application-blind: one rule decides
   * `body` for every JSON it ever sees. That is right for a gateway payload and
   * wrong for a product review, where the submitted text IS the defect. Only
   * the application knows which of its fields carry personal data, so the
   * exception list is the application's to declare.
   *
   * Value-based detection still runs inside a kept field, so an email, a JWT,
   * a card number, a token, or a high-entropy secret pasted into one is still
   * redacted. A `denyFields` entry wins over a keep for the same name.
   */
  keepFields?: string[];
}

/** The name-based half of the structured policy, threaded through the walker. */
export interface StructuredFieldPolicy {
  denyFields?: string[];
  keepFields?: string[];
}

export type DiagnosticScalar = string | number | boolean | null;

/** The maximum number of explicitly selected diagnostic leaves in one event. */
export const DIAGNOSTIC_FIELD_MAX_ENTRIES = 16;

/** The maximum length of a retained diagnostic string. */
export const DIAGNOSTIC_FIELD_MAX_STRING_LENGTH = 256;

/**
 * An explicit, relative field-path allowlist for small diagnostic maps.
 *
 * Paths use dot-separated property names and numeric array indexes such as
 * `checkout.status` and `attempts[0].code`. Wildcards and prototype paths are
 * intentionally not part of this grammar.
 */
export interface DiagnosticFieldRedactionOptions {
  diagnosticFields: readonly string[];
  denyFields?: readonly string[];
  path?: string;
}

export interface StoredValueRedactionOptions {
  key?: string;
  maxLength?: number;
  path?: string;
}

export interface InputValueRedactionOptions {
  name?: string;
  type?: string;
  path?: string;
  /**
   * The caller has already decided this field is masked — the element carries a
   * sensitivity marker, or its `type` is on the deployment's
   * `maskInputTypes` list. Redacted on that alone, before anything reads the
   * value or consults the classifier, exactly as `password` is.
   */
  maskedByPolicy?: boolean;
}

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  "x-xsrf-token",
  "x-session-id",
]);
const URL_HEADER_NAMES = new Set([
  "content-location",
  "location",
  "referer",
  "referrer",
]);
const MAX_HEADER_COUNT = 80;
const MAX_HEADER_NAME_LENGTH = 160;
const MAX_HEADER_VALUE_LENGTH = 2_000;

const SENSITIVE_NAME_RE =
  /(^|[^a-z0-9])(access[-_]?token|api[-_]?key|auth|authorization|bearer|card[-_]?number|client[-_]?secret|cookie|credential(s)?|creds|csrf|cvv|cvc|id[-_]?token|jsessionid|jwt|mfa|otp|pass[-_]?phrase|pass(code|word)?|passwd|password[-_]?confirmation|pin|private[-_]?key|pwd|refresh[-_]?token|secret|security[-_]?code|session|session[-_]?id|sid|ssn|token|verification[-_]?code|xsrf)([^a-z0-9]|$)/i;
const PII_NAME_RE =
  /(^|[^a-z0-9])(email|phone|address|dob|birthdate|postal|zip)([^a-z0-9]|$)/i;
const SENSITIVE_URL_SCHEMES = new Set([
  "blob:",
  "data:",
  "file:",
  "javascript:",
]);
const SENSITIVE_COMPACT_NAMES = new Set([
  "accesskey",
  "accesstoken",
  "accesstokens",
  "apikey",
  "apikeys",
  "apisecret",
  "apisecrets",
  "auth",
  "authentication",
  "authenticationinfo",
  "authkey",
  "authtoken",
  "authorization",
  "authorizationinfo",
  "bearer",
  "cardnumber",
  "clientsecret",
  "clientsecrets",
  "cookie",
  "credentials",
  "creds",
  "csrf",
  "csrfkey",
  "csrftoken",
  "cvc",
  "cvv",
  "idtoken",
  "idtokens",
  "jsessionid",
  "jwt",
  "mfa",
  "otp",
  "passcode",
  "passphrase",
  "passwd",
  "password",
  "passwordconfirmation",
  "passwords",
  "pin",
  "privatekey",
  "proxyauthentication",
  "proxyauthenticationinfo",
  "pwd",
  "refreshtoken",
  "refreshtokens",
  "secret",
  "secrets",
  "securitycode",
  "session",
  "sessionid",
  "sessiontoken",
  "sessiontokens",
  "sid",
  "ssn",
  "token",
  "tokenkey",
  "tokens",
  "verificationcode",
  "xapikey",
  "xauthkey",
  "xauthtoken",
  "xcsrf",
  "xcsrfkey",
  "xcsrftoken",
  "xsrf",
  "xsrfkey",
  "xsrftoken",
  "xxsrf",
  "xxsrfkey",
  "xxsrftoken",
]);
const SENSITIVE_COMPACT_SUFFIXES = [
  "accesstoken",
  "accesstokens",
  "apikey",
  "apikeys",
  "apisecret",
  "apisecrets",
  "authtoken",
  "clientsecret",
  "clientsecrets",
  "csrftoken",
  "idtoken",
  "idtokens",
  "privatekey",
  "refreshtoken",
  "refreshtokens",
  "sessiontoken",
  "sessiontokens",
  "xsrftoken",
];

/**
 * `generic: true` marks a pattern that matches by shape alone rather than by a
 * declared secret prefix. Those two are the ones that also match a correlation
 * id — a W3C trace id is exactly 32 hex characters — so a caller that knows the
 * field is an id can skip them while keeping every prefix-anchored rule.
 */
const TOKEN_PATTERNS: Array<{
  pattern: RegExp;
  reason: string;
  generic?: boolean;
}> = [
  {
    pattern: /\b(?:Bearer|Token|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
    reason: "auth_scheme_token",
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    reason: "jwt_token",
  },
  {
    pattern:
      /(?:sk|pk|rk|ghp|gho|ghu|ghs|glpat|xox[baprs])[-_][A-Za-z0-9_.=-]{12,}/gi,
    reason: "prefixed_token",
  },
  { pattern: /\b[A-Fa-f0-9]{32,}\b/g, reason: "long_hex_token", generic: true },
  {
    pattern: /\b[A-Za-z0-9_-]{40,}\b/g,
    reason: "long_token_like_string",
    generic: true,
  },
];

/**
 * Headers whose entire purpose is to join this session to a record in the
 * customer's own logging (Splunk, Datadog, CloudWatch, any OTel backend).
 *
 * Their values are ids by specification, not credentials, and they are exactly
 * the shape the generic token patterns match — a W3C trace id is 32 hex
 * characters, and so is the usual `x-request-id`. Scrubbing them destroys the
 * one field that makes a captured session findable on the other side, and it
 * only bites the accounts that already propagate tracing, i.e. the ones where
 * the join was going to work. Prefix-anchored secret patterns (Bearer, JWT,
 * `sk_`/`ghp_`/…) still run on these values, so a credential misfiled into one
 * is still caught.
 */
const CORRELATION_HEADER_NAMES = new Set([
  "b3",
  "traceparent",
  "tracestate",
  "x-amzn-trace-id",
  "x-b3-flags",
  "x-b3-parentspanid",
  "x-b3-sampled",
  "x-b3-spanid",
  "x-b3-traceid",
  "x-cloud-trace-context",
  "x-correlation-id",
  "x-datadog-parent-id",
  "x-datadog-span-id",
  "x-datadog-trace-id",
  "x-request-id",
  "x-trace-id",
]);
const REDACTED_KEY = "[REDACTED_KEY]";
const SENSITIVE_PATH_PRECEDERS = new Set([
  "code",
  "invite",
  "magic",
  "mfa",
  "otp",
  "passcode",
  "reset",
  "session",
  "token",
  "verify",
]);

function metadataFromField(
  field: RedactionField,
  summary?: PayloadSummary,
): RedactionMetadata {
  return {
    policy: BROWSER_REDACTION_POLICY,
    fields: [field],
    ...(summary ? { summaries: [summary] } : {}),
  };
}

function metadataFromFields(
  fields: RedactionField[],
  summaries: PayloadSummary[] = [],
): RedactionMetadata | undefined {
  if (fields.length === 0 && summaries.length === 0) return undefined;
  return {
    policy: BROWSER_REDACTION_POLICY,
    fields,
    ...(summaries.length > 0 ? { summaries } : {}),
  };
}

export function mergeRedactionMetadata(
  ...items: Array<RedactionMetadata | undefined>
): RedactionMetadata | undefined {
  const fields: RedactionField[] = [];
  const summaries: PayloadSummary[] = [];

  let policy: BrowserRedactionPolicy = BROWSER_REDACTION_POLICY;
  const keep = new Set<string>();
  for (const item of items) {
    if (!item) continue;
    if (item.policy === BROWSER_REDACTION_POLICY_V2)
      policy = BROWSER_REDACTION_POLICY_V2;
    fields.push(...item.fields);
    if (item.summaries) summaries.push(...item.summaries);
    for (const name of item.keep ?? []) keep.add(name);
  }

  if (fields.length === 0 && summaries.length === 0 && keep.size === 0)
    return undefined;

  return {
    policy,
    fields,
    ...(summaries.length > 0 ? { summaries } : {}),
    ...(keep.size > 0 ? { keep: [...keep] } : {}),
  };
}

export function attachRedactionMetadata(
  target: Record<string, unknown>,
  ...items: Array<RedactionMetadata | undefined>
): void {
  const metadata = mergeRedactionMetadata(...items);
  if (metadata) target.redaction = metadata;
}

function withMetadata<T>(
  value: T,
  field?: RedactionField,
  summary?: PayloadSummary,
): RedactionResult<T> {
  return {
    value,
    ...(field ? { metadata: metadataFromField(field, summary) } : {}),
    ...(summary ? { summary } : {}),
  };
}

function isSensitiveName(name: string | undefined): boolean {
  if (!name) return false;
  const normalized = name.replace(/([a-z])([A-Z])/g, "$1_$2");
  const compact = normalized.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    SENSITIVE_NAME_RE.test(name) ||
    PII_NAME_RE.test(name) ||
    SENSITIVE_NAME_RE.test(normalized) ||
    PII_NAME_RE.test(normalized) ||
    isSensitiveCompactName(compact)
  );
}

function isSensitiveCompactName(compact: string): boolean {
  return (
    SENSITIVE_COMPACT_NAMES.has(compact) ||
    SENSITIVE_COMPACT_SUFFIXES.some(
      (suffix) => compact.length > suffix.length && compact.endsWith(suffix),
    )
  );
}

function buildSummary(
  kind: PayloadSummary["kind"],
  action: RedactionAction,
  reason: string,
  originalLength?: number,
  limit?: number,
  redactedFields?: number,
  contentLength?: string,
): PayloadSummary {
  return {
    kind,
    action,
    reason,
    ...(originalLength !== undefined ? { originalLength } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(redactedFields !== undefined ? { redactedFields } : {}),
    ...(contentLength !== undefined ? { contentLength } : {}),
  };
}

export function redactTokenLikeString(
  value: string,
  path = "value",
  options: { skipGenericShapePatterns?: boolean } = {},
): RedactionResult<string> {
  let output = value;
  const fields: RedactionField[] = [];

  for (const { pattern, reason, generic } of TOKEN_PATTERNS) {
    if (generic && options.skipGenericShapePatterns) continue;
    pattern.lastIndex = 0;
    let matched = false;
    output = output.replace(pattern, () => {
      matched = true;
      return REDACTED_VALUE;
    });
    if (matched) fields.push({ path, reason, action: "redacted" });
  }

  const metadata = metadataFromFields(fields);

  return { value: output, ...(metadata ? { metadata } : {}) };
}

function redactQueryString(
  query: string,
  path: string,
): RedactionResult<string> {
  if (!query) return { value: "" };

  const search = query.startsWith("?") ? query.slice(1) : query;
  const params = new URLSearchParams(search);
  const fields: RedactionField[] = [];
  const keepFields = getRedactionKeepFields();

  for (const key of Array.from(params.keys())) {
    const values = params.getAll(key);
    const safeKey = sanitizeKeyName(key);
    params.delete(key);
    // A query parameter is a field with a name, so it answers to the same
    // application-declared keep list as a JSON key. A bare `?q=[REDACTED]` on a
    // search defect erases the one input that explains it. Values still go through the
    // classifier, so only a value that survives every check is kept.
    const kept = isStructuredKeepName(key, keepFields);
    for (const value of values) {
      if (value === "") {
        params.append(safeKey, "");
      } else if (value === REDACTED_VALUE || isRedactedQueryShape(value)) {
        // Preserve a marker from an earlier redaction pass. A legacy marker has
        // no shape to recover, while a shape marker must not describe itself.
        params.append(safeKey, value);
      } else if (isHarmlessQueryValue(key, value)) {
        // Pagination, sorting and paging cursors made of plain numbers. The
        // keep list is application declared and empty by default, so
        // `?page=1&limit=20` came back as `?page=[REDACTED]&limit=[REDACTED]`
        // on every session — hiding which page a defect happened on, and
        // protecting a number that is not a secret in any deployment. A
        // sensitive NAME still overrides this: `?token=1` is redacted.
        params.append(safeKey, value);
      } else if (
        kept &&
        classifyStructuredValue(
          asNumberIfNumeric(value),
          key,
          undefined,
          keepFields,
        ).action === "keep"
      ) {
        params.append(safeKey, value);
      } else {
        params.append(safeKey, redactedQueryValue(value));
        fields.push({
          path: `${path}.query.${safeKey}`,
          reason: "url_query_value",
          action: "redacted",
        });
      }
    }
  }

  const serialized = unescapeRedactionMarker(params.toString());
  const metadata = metadataFromFields(fields);

  return {
    value: serialized ? `?${serialized}` : "",
    ...(metadata ? { metadata } : {}),
  };
}

const REDACTED_QUERY_SHAPE_RE =
  /^\[REDACTED;len=(\d{1,7});charset=(alpha|num|alnum|mixed)(?:;separators=((?:\d{1,7}\.(?:dot|comma|space))(?:,\d{1,7}\.(?:dot|comma|space))*))?\]$/;

function isRedactedQueryShape(value: string): boolean {
  const match = REDACTED_QUERY_SHAPE_RE.exec(value);
  if (!match) return false;
  const length = Number(match[1]);
  if (match[3] === undefined) return true;
  return match[3].split(",").every((separator) => {
    const index = Number(separator.split(".", 1)[0]);
    return Number.isInteger(index) && index >= 0 && index < length;
  });
}

function redactedQueryValue(value: string): string {
  const shape = computeRedactedShape(value);
  const separators = shape.separators
    ?.map(({ index, char }) => {
      const name = char === "." ? "dot" : char === "," ? "comma" : "space";
      return `${index}.${name}`;
    })
    .join(",");
  return `[REDACTED;len=${shape.len};charset=${shape.charset}${
    separators ? `;separators=${separators}` : ""
  }]`;
}

/**
 * A query value that carries no risk regardless of the keep list: a short plain
 * number under a name that is not sensitive.
 *
 * Deliberately narrow. Numbers only (no free text, no ids that merely look
 * numeric at 12 digits — an account number is numeric too), capped at four
 * digits, and a sensitive name still wins. That admits page, limit, offset,
 * step, quantity and their kin, and nothing that could be a credential.
 */
function isHarmlessQueryValue(key: string, value: string): boolean {
  if (isSensitiveName(key)) return false;
  return /^-?[0-9]{1,4}$/.test(value);
}

/**
 * The only query parameter names campaign capture may read. First-party UTM
 * labels, nothing else.
 *
 * Stated as a closed literal list rather than a prefix test on purpose: a
 * `utm_*` prefix rule would silently admit whatever a vendor invents next, and
 * a widening should be a visible edit to this array with a reviewer attached.
 * Cross-site advertising identifiers — `gclid`, `fbclid`, `msclkid`, `ttclid`,
 * `_fbp`, `li_fat_id` and the rest of that family — are deliberately absent and
 * are never read, so they cannot reach the output path even as `[REDACTED]`.
 */
const CAMPAIGN_PARAM_NAMES = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;

/**
 * A campaign label is a short human-authored word or phrase. Anything past this
 * is not a label, so it is dropped rather than truncated: a truncated prefix of
 * an unexpected value is still that value's first 200 characters resting in the
 * payload, which is exactly the artifact this bound exists to prevent.
 */
const CAMPAIGN_VALUE_MAX_LENGTH = 200;

/**
 * Read first-party campaign labels out of a `location.search` string.
 *
 * This is a narrow, named exception to the policy in {@link redactQueryString},
 * which redacts every query value it sees and CONTINUES to do so — including
 * for `utm_*`. Nothing here changes what any URL captured from a network event,
 * a navigation, a referrer or an error frame reports. The asymmetry is the
 * point: a campaign label read deliberately from the session's own entry URL is
 * a different artifact from an arbitrary URL observed in flight, where the SDK
 * has no idea what a parameter means and must assume the worst.
 *
 * The allowance is deny-biased in three ways. Only the five literal names in
 * {@link CAMPAIGN_PARAM_NAMES} are read at all. Every value that survives still
 * goes through {@link redactTokenLikeString} and the value-based half of
 * {@link classifyStructuredValue}, so an email, a JWT, a card number, an IBAN or
 * a high-entropy secret smuggled into `utm_campaign` is redacted like anywhere
 * else. And anything longer than {@link CAMPAIGN_VALUE_MAX_LENGTH} is dropped.
 *
 * The parameter's own name is passed as its keep name, which exempts it from the
 * free-text catch-all only — a campaign label is frequently a multi-word phrase
 * ("Spring Sale 2026") that the catch-all would otherwise treat as free text.
 * Every value-based check above that catch-all still runs.
 *
 * Repeated parameters are read once: the first occurrence wins, as it does for
 * `URLSearchParams.get`.
 *
 * @param search A `location.search` value, with or without the leading `?`.
 */
export function redactCampaignParams(
  search: string,
): RedactionResult<Record<string, string>> {
  const output: Record<string, string> = {};
  if (!search) return { value: output };

  const hashIndex = search.indexOf("#");
  const beforeHash = hashIndex >= 0 ? search.slice(0, hashIndex) : search;
  const query = beforeHash.startsWith("?") ? beforeHash.slice(1) : beforeHash;
  if (!query) return { value: output };

  const params = new URLSearchParams(query);
  const fields: RedactionField[] = [];

  for (const name of CAMPAIGN_PARAM_NAMES) {
    const raw = params.get(name);
    if (raw === null || raw === "") continue;
    const path = `campaign.${name}`;

    if (raw.length > CAMPAIGN_VALUE_MAX_LENGTH) {
      fields.push({
        path,
        reason: "campaign_value_length_limit",
        action: "dropped",
      });
      continue;
    }

    if (redactTokenLikeString(raw, path).value !== raw) {
      output[name] = REDACTED_VALUE;
      fields.push({
        path,
        reason: "campaign_token_like_value",
        action: "redacted",
      });
      continue;
    }

    const classification = classifyStructuredValue(raw, name, undefined, [
      name,
    ]);
    if (classification.action === "redact") {
      output[name] = REDACTED_VALUE;
      fields.push({
        path,
        reason: `campaign_${classification.reason}`,
        action: "redacted",
      });
      continue;
    }

    output[name] = raw;
  }

  const metadata = metadataFromFields(fields);
  return { value: output, ...(metadata ? { metadata } : {}) };
}

function sanitizeKeyName(key: string): string {
  return redactTokenLikeString(key).value === key ? key : REDACTED_KEY;
}

/**
 * A collision-free name for a redacted key in an output map.
 *
 * Every sensitive key redacts to the same constant, so three tokens in
 * localStorage used to write one entry and the reader could not tell "the token
 * was never written" from "the token was written under three different names".
 * The suffix keeps the cardinality without saying anything about the names.
 */
export function uniqueOutputKey(
  key: string,
  output: Record<string, unknown>,
): string {
  if (!Object.prototype.hasOwnProperty.call(output, key)) return key;
  let suffix = 2;
  while (Object.prototype.hasOwnProperty.call(output, `${key}_${suffix}`))
    suffix += 1;
  return `${key}_${suffix}`;
}

function redactUrlPath(
  pathname: string,
  path: string,
): RedactionResult<string> {
  if (!pathname || pathname === "/") return { value: pathname };
  const fields: RedactionField[] = [];
  let previousDecoded = "";
  const parts = pathname.split("/");
  const output = parts.map((part, index) => {
    if (part === "") return part;
    const decoded = decodeURIComponentDeep(part);
    const subResult = redactUrlPathComponent(
      decoded,
      previousDecoded,
      `${path}.path`,
    );
    previousDecoded = subResult.lastToken || decoded.toLowerCase();
    if (subResult.metadata) fields.push(...subResult.metadata.fields);
    return subResult.value === decoded
      ? part
      : unescapeRedactionMarker(encodeURIComponent(subResult.value));
  });
  const metadata = metadataFromFields(fields);
  return { value: output.join("/"), ...(metadata ? { metadata } : {}) };
}

/**
 * A path segment that is plainly a route name rather than a value.
 *
 * The preceder rule above redacts whatever follows `auth`, `token`, `session`
 * and friends, which is right for `/reset/9f3c…` and wrong for `/api/auth/whoami`
 * — `whoami` became `[REDACTED]`, so a captured session could not say which
 * endpoint returned a 401. Measured on a live run: every `/api/auth/*` request
 * in the capture reported its own pathname as a secret.
 *
 * Deliberately narrow, because it weakens a security control: only short,
 * all-lowercase words survive, with no separators and no mixed case. Anything
 * with entropy — a token, a hash, an id, a JWT, a base64 fragment, a uuid —
 * fails at least one of those and is still redacted.
 *
 * Digits are admitted in exactly two shapes, both API vocabulary rather than
 * entropy: an API version segment (`v1`, `v2`, `v10`) and the named protocol
 * words below. Rejecting them cost real evidence — a captured 400 read
 * `POST http://127.0.0.1:57421/auth/[REDACTED]/token`, where the hidden segment
 * was the literal `v1`, so the title named no endpoint at all.
 *
 * Enumerated rather than generalised to "a word with a trailing digit", because
 * that wider rule keeps `hunter2` after `password` and `abc123` after
 * `client_secret` — the exact segments this control exists to catch. Longer
 * digit runs, mixed case, separators, hex, base64 and uuids all still redact.
 */
const PLAIN_ROUTE_WORD_RE = /^(?:[a-z]{2,16}|v[0-9]{1,3})$/;
const PLAIN_ROUTE_PROTOCOL_WORDS = new Set(["oauth1", "oauth2", "saml2"]);

/**
 * The sensitive preceders that hold a credential in the very next segment.
 *
 * Stated as the exclusion rather than as a list of safe namespaces, so it stays
 * correct as the sensitive-name rules grow: anything newly treated as sensitive
 * (`authentication`, `authorization`, a future name) gets the route-word
 * carve-out without being enumerated here, and only the names that are
 * definitionally followed by the secret itself are opted out. `/reset/…`,
 * `/token/…` and `/otp/…` are followed by the value; `/auth/…` and `/session/…`
 * are followed by endpoint names (`whoami`, `logout`, `refresh`) as often as by
 * values.
 */
const CREDENTIAL_PATH_PRECEDERS = new Set([
  "code",
  "invite",
  "magic",
  "mfa",
  "otp",
  "passcode",
  "reset",
  "token",
  "verify",
]);

function isPlainRouteWord(previous: string, component: string): boolean {
  return (
    !CREDENTIAL_PATH_PRECEDERS.has(previous) &&
    (PLAIN_ROUTE_WORD_RE.test(component) ||
      PLAIN_ROUTE_PROTOCOL_WORDS.has(component))
  );
}

function redactUrlPathComponent(
  component: string,
  previous: string,
  path: string,
): RedactionResult<string> & { lastToken?: string } {
  const fields: RedactionField[] = [];
  let lastToken = previous;
  if (
    (SENSITIVE_PATH_PRECEDERS.has(previous) || isSensitiveName(previous)) &&
    component.length > 0 &&
    !isPlainRouteWord(previous, component)
  ) {
    fields.push({
      path,
      reason: "url_path_secret_segment",
      action: "redacted",
    });
    return {
      value: REDACTED_VALUE,
      lastToken: REDACTED_VALUE.toLowerCase(),
      metadata: { policy: BROWSER_REDACTION_POLICY, fields },
    };
  }
  const parts = component.split(/([/\\;])/);
  const output = parts
    .map((part) => {
      if (part === "/" || part === "\\" || part === ";") return part;
      if (part === "") return part;
      const keyValueIndex = part.indexOf("=");
      if (keyValueIndex > 0) {
        const key = part.slice(0, keyValueIndex);
        const value = part.slice(keyValueIndex + 1);
        const tokenResult = redactTokenLikeString(value, path);
        if (
          isSensitiveName(key) ||
          tokenResult.value !== value ||
          isSecretLikePathSegment(value, key.toLowerCase())
        ) {
          fields.push({
            path,
            reason: isSensitiveName(key)
              ? "url_path_sensitive_key"
              : "url_path_token",
            action: "redacted",
          });
          lastToken = key.toLowerCase();
          return `${key}=${REDACTED_VALUE}`;
        }
      }
      const tokenResult = redactTokenLikeString(part, path);
      if (
        tokenResult.value !== part ||
        isSecretLikePathSegment(part, lastToken)
      ) {
        fields.push({
          path,
          reason:
            tokenResult.value !== part
              ? "url_path_token"
              : "url_path_secret_segment",
          action: "redacted",
        });
        lastToken = REDACTED_VALUE.toLowerCase();
        return REDACTED_VALUE;
      }
      if (part.includes("?") || part.includes("&")) {
        const decodedQueryResult = redactDecodedQueryLikePathComponent(
          part,
          path,
          lastToken,
        );
        if (decodedQueryResult.metadata)
          fields.push(...decodedQueryResult.metadata.fields);
        lastToken = decodedQueryResult.lastToken;
        return decodedQueryResult.value;
      }
      lastToken = part.toLowerCase();
      return part;
    })
    .join("");
  const metadata = metadataFromFields(fields);
  return { value: output, lastToken, ...(metadata ? { metadata } : {}) };
}

function redactDecodedQueryLikePathComponent(
  component: string,
  path: string,
  previous: string,
): RedactionResult<string> & { lastToken: string } {
  const fields: RedactionField[] = [];
  let lastToken = previous;
  let inDecodedQuery = false;
  const output = component
    .split(/([?&])/)
    .map((part) => {
      if (part === "?" || part === "&") {
        inDecodedQuery = true;
        return part;
      }
      if (!inDecodedQuery || part === "") return part;
      const keyValueIndex = part.indexOf("=");
      if (keyValueIndex > 0) {
        const rawKey = part.slice(0, keyValueIndex);
        const rawValue = part.slice(keyValueIndex + 1);
        const safeKey = sanitizeKeyName(rawKey);
        lastToken = safeKey.toLowerCase();
        if (rawValue === "") return `${safeKey}=`;
        fields.push({
          path: `${path}.decoded_query.${safeKey}`,
          reason: "url_path_decoded_query_value",
          action: "redacted",
        });
        return `${safeKey}=${REDACTED_VALUE}`;
      }
      fields.push({
        path: `${path}.decoded_query`,
        reason: "url_path_decoded_query_value",
        action: "redacted",
      });
      lastToken = REDACTED_VALUE.toLowerCase();
      return REDACTED_VALUE;
    })
    .join("");
  const metadata = metadataFromFields(fields);
  return { value: output, lastToken, ...(metadata ? { metadata } : {}) };
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeURIComponentDeep(value: string): string {
  let output = value;
  for (let index = 0; index < 3; index += 1) {
    const decoded = decodeURIComponentSafe(output);
    if (decoded === output) return output;
    output = decoded;
  }
  return output;
}

function isSecretLikePathSegment(segment: string, previous: string): boolean {
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      segment,
    )
  )
    return true;
  if (
    (SENSITIVE_PATH_PRECEDERS.has(previous) || isSensitiveName(previous)) &&
    segment.length > 0 &&
    segment.length <= 256 &&
    // Same carve-out as the branch in redactUrlPathComponent: a plain lowercase
    // route word after `auth` or `session` is an endpoint name, not a value.
    !isPlainRouteWord(previous, segment)
  )
    return true;
  // The length-and-shape rule, for an opaque identifier sitting in a path with
  // nothing around it to say what it is.
  //
  // It used to be `/^[A-Za-z0-9_-]{16,39}$/ && /[A-Z0-9_-]/`, whose second test
  // a single hyphen satisfies — so it read as "any 16 to 39 character slug with
  // a hyphen in it is a secret". `aurora-desk-lamp` (16) was redacted while
  // `nimbus-keyboard` (15) and `flux-mouse` (10) came through untouched: the
  // same URL shape, opposite outcomes, decided by length alone. A session then
  // showed `/product/[REDACTED]` three navigations from `/product/nimbus-keyboard`,
  // and no reader could tell those were the same kind of page.
  //
  // A product slug is words. A key is not. So a segment that decomposes into
  // word-shaped parts is kept, and everything else in that length band is still
  // redacted.
  if (!/^[A-Za-z0-9_-]{16,39}$/.test(segment)) return false;
  return !isWordLikeSlug(segment);
}

/**
 * Does this segment read as words a person wrote, rather than an opaque value?
 *
 * Split on the separators slugs use, every part has to look like a word (letters
 * with a vowel in them) or a small number — `aurora-desk-lamp`, `winter-sale-2024`,
 * `checkout-v2`. One part that is a run of mixed letters and digits, or a
 * consonant run with no vowel, fails the whole segment, which is what keeps
 * `sk_live_4eC39HqLyjWDarjt`, `AKIAIOSFODNN7EXAMPLE` and a raw hex id redacted.
 */
function isWordLikeSlug(segment: string): boolean {
  const parts = segment.split(/[-_]/);
  if (parts.length === 0) return false;
  return parts.every((part) => {
    if (part.length === 0) return false;
    // A version or year fragment: v2, 2024, 3.
    if (/^[A-Za-z]?[0-9]{1,4}$/.test(part)) return true;
    if (!/^[A-Za-z]+$/.test(part)) return false;
    // A word has a vowel. A 16 character run of consonants does not, and is far
    // more likely to be an encoded value than a noun.
    return /[aeiouy]/i.test(part);
  });
}

function redactRelativeUrl(url: string, path: string): RedactionResult<string> {
  const hashIndex = url.indexOf("#");
  const beforeHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const queryIndex = beforeHash.indexOf("?");
  const base = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
  const query = queryIndex >= 0 ? beforeHash.slice(queryIndex) : "";
  const queryResult = redactQueryString(query, path);
  const pathResult = redactUrlPath(base, path);
  const tokenResult = redactTokenLikeString(
    `${pathResult.value}${queryResult.value}`,
    path,
  );
  const fields: RedactionField[] = [];

  if (queryResult.metadata) fields.push(...queryResult.metadata.fields);
  if (pathResult.metadata) fields.push(...pathResult.metadata.fields);
  if (tokenResult.metadata)
    fields.push(
      ...tokenResult.metadata.fields.map((field) => ({
        ...field,
        reason: `url_${field.reason}`,
      })),
    );
  if (hash)
    fields.push({
      path: `${path}.hash`,
      reason: "url_hash",
      action: "dropped",
    });

  const metadata = metadataFromFields(fields);

  return { value: tokenResult.value, ...(metadata ? { metadata } : {}) };
}

function redactMalformedAbsoluteUrl(path: string): RedactionResult<string> {
  return withMetadata(REDACTED_VALUE, {
    path,
    reason: "malformed_absolute_url",
    action: "redacted",
  });
}

export function redactUrl(url: string, path = "url"): RedactionResult<string> {
  if (url.trim().startsWith("//")) {
    const leadingWhitespace = url.match(/^\s*/)?.[0] ?? "";
    const trimmed = url.trim();
    try {
      const parsed = new URL(`https:${trimmed}`);
      const fields: RedactionField[] = [];
      if (parsed.username || parsed.password) {
        parsed.username = "";
        parsed.password = "";
        fields.push({
          path: `${path}.credentials`,
          reason: "url_credentials",
          action: "dropped",
        });
      }
      if (parsed.search) {
        const queryResult = redactQueryString(parsed.search, path);
        parsed.search = queryResult.value;
        if (queryResult.metadata) fields.push(...queryResult.metadata.fields);
      }
      const pathResult = redactUrlPath(parsed.pathname, path);
      parsed.pathname = pathResult.value;
      if (pathResult.metadata) fields.push(...pathResult.metadata.fields);
      if (parsed.hash) {
        parsed.hash = "";
        fields.push({
          path: `${path}.hash`,
          reason: "url_hash",
          action: "dropped",
        });
      }
      const withoutScheme = `//${parsed.host}${parsed.pathname}${parsed.search}`;
      const tokenResult = redactTokenLikeString(
        `${leadingWhitespace}${withoutScheme}`,
        path,
      );
      if (tokenResult.metadata)
        fields.push(
          ...tokenResult.metadata.fields.map((field) => ({
            ...field,
            reason: `url_${field.reason}`,
          })),
        );
      const metadata = metadataFromFields(fields);
      return { value: tokenResult.value, ...(metadata ? { metadata } : {}) };
    } catch {
      return redactMalformedAbsoluteUrl(path);
    }
  }
  const leadingWhitespace = url.match(/^\s*/)?.[0] ?? "";
  const trimmedUrl = url.slice(leadingWhitespace.length);
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(trimmedUrl);
  if (!hasScheme) return redactRelativeUrl(url, path);

  try {
    const parsed = new URL(trimmedUrl);
    const fields: RedactionField[] = [];

    if (SENSITIVE_URL_SCHEMES.has(parsed.protocol.toLowerCase())) {
      const summary = `${parsed.protocol}${REDACTED_VALUE}`;
      return withMetadata(`${leadingWhitespace}${summary}`, {
        path,
        reason: "sensitive_url_scheme",
        action: "redacted",
      });
    }

    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      fields.push({
        path: `${path}.credentials`,
        reason: "url_credentials",
        action: "dropped",
      });
    }

    if (parsed.search) {
      const queryResult = redactQueryString(parsed.search, path);
      parsed.search = queryResult.value;
      if (queryResult.metadata) fields.push(...queryResult.metadata.fields);
    }
    const pathResult = redactUrlPath(parsed.pathname, path);
    parsed.pathname = pathResult.value;
    if (pathResult.metadata) fields.push(...pathResult.metadata.fields);

    if (parsed.hash) {
      parsed.hash = "";
      fields.push({
        path: `${path}.hash`,
        reason: "url_hash",
        action: "dropped",
      });
    }

    const tokenResult = redactTokenLikeString(
      `${leadingWhitespace}${parsed.toString()}`,
      path,
    );
    if (tokenResult.metadata) {
      fields.push(
        ...tokenResult.metadata.fields.map((field) => ({
          ...field,
          reason: `url_${field.reason}`,
        })),
      );
    }

    const metadata = metadataFromFields(fields);

    return { value: tokenResult.value, ...(metadata ? { metadata } : {}) };
  } catch {
    return redactMalformedAbsoluteUrl(path);
  }
}

/**
 * Match an `http(s)://…` URL substring inside free text. Stops at whitespace,
 * quotes, brackets, and other delimiters so a URL sitting inside JSON (`"…"`),
 * markup (`<…>`), or prose is isolated cleanly. Trailing sentence punctuation is
 * trimmed separately (see below) so a period/comma after the URL is not swallowed.
 */
const URL_IN_TEXT_RE = /https?:\/\/[^\s"'`<>\\{}()[\]|^]+/gi;
const URL_TRAILING_PUNCT_RE = /[.,;:!?]+$/;

/**
 * Scrub secrets from `http(s)://…` URL substrings embedded in FREE TEXT, reusing
 * the SAME query-key-aware policy {@link redactUrl} applies to `ref.url`.
 *
 * The token-shape patterns in {@link redactTokenLikeString} catch Bearer/JWT/
 * prefixed/long-hex/long-alnum secrets, but MISS a short/medium secret carried as
 * a URL query param (`?token=abc123def456`, ~12–26 chars) — while `redactUrl` is
 * query-aware and drops every query value. This finds each URL substring and runs
 * it through `redactUrl`, so a tokenized URL sitting in an adapter's `after`/
 * `brief`/gap text loses its query secret while keeping its origin + path as
 * provenance. Non-URL text is left untouched (fast-path bail when no `://`).
 *
 * This shares one implementation with `ref.url` redaction — there is no second
 * URL-redaction policy.
 */
export function redactUrlsInText(
  value: string,
  path = "value",
): RedactionResult<string> {
  if (value.indexOf("://") === -1) return { value };
  const fields: RedactionField[] = [];
  const output = value.replace(URL_IN_TEXT_RE, (match) => {
    const trailing = match.match(URL_TRAILING_PUNCT_RE)?.[0] ?? "";
    const core = trailing
      ? match.slice(0, match.length - trailing.length)
      : match;
    const result = redactUrl(core, path);
    if (result.metadata) fields.push(...result.metadata.fields);
    return `${result.value}${trailing}`;
  });
  const metadata = metadataFromFields(fields);
  return { value: output, ...(metadata ? { metadata } : {}) };
}

export function redactHeaders(
  headers: Record<string, string>,
  path = "headers",
): RedactionResult<Record<string, string>> {
  const output: Record<string, string> = Object.create(null);
  const fields: RedactionField[] = [];
  let processed = 0;
  // Presence only — no value, no prefix, no length. Computed from the headers
  // as given, before any of them are replaced.
  const credentials = credentialPresence(headers);

  for (const originalName in headers) {
    if (!Object.prototype.hasOwnProperty.call(headers, originalName)) continue;
    if (processed >= MAX_HEADER_COUNT) {
      fields.push({
        path: `${path}.__truncatedHeaders`,
        reason: "header_count_limit",
        action: "dropped",
      });
      break;
    }
    processed += 1;
    const value = headers[originalName];
    const name = originalName.slice(0, MAX_HEADER_NAME_LENGTH);
    const rawValue =
      typeof value === "string"
        ? value.slice(0, MAX_HEADER_VALUE_LENGTH)
        : String(value).slice(0, MAX_HEADER_VALUE_LENGTH);
    if (name !== originalName) {
      fields.push({
        path: `${path}.${sanitizeKeyName(name)}`,
        reason: "header_name_truncated",
        action: "summarized",
      });
    }
    if (rawValue !== value) {
      fields.push({
        path: `${path}.${sanitizeKeyName(name)}`,
        reason: "header_value_truncated",
        action: "summarized",
      });
    }
    const normalized = name.toLowerCase();
    const sanitizedName = sanitizeKeyName(name);
    const outputName = uniqueOutputKey(sanitizedName, output);
    if (
      sanitizedName !== name ||
      SENSITIVE_HEADER_NAMES.has(normalized) ||
      isSensitiveName(normalized)
    ) {
      output[outputName] = REDACTED_VALUE;
      fields.push({
        path: `${path}.${outputName}`,
        reason: "sensitive_header_name",
        action: "redacted",
      });
      continue;
    }

    const valueResult = URL_HEADER_NAMES.has(normalized)
      ? redactUrl(rawValue, `${path}.${outputName}`)
      : normalized === "link" || headerValueLooksUrlLike(rawValue)
        ? redactUrlLikeHeaderValue(rawValue, `${path}.${outputName}`)
        : redactTokenLikeString(rawValue, `${path}.${outputName}`, {
            skipGenericShapePatterns: CORRELATION_HEADER_NAMES.has(normalized),
          });
    output[outputName] = valueResult.value;
    if (valueResult.metadata) fields.push(...valueResult.metadata.fields);
  }

  const metadata = metadataFromFields(fields);

  return {
    value: output,
    ...(metadata ? { metadata } : {}),
    credentials,
  };
}

function headerValueLooksUrlLike(value: string): boolean {
  return (
    /^\s*(?:https?:\/\/|\/\/|[./]*[^ \t\r\n;,]+[/?#][^ \t\r\n]*)/i.test(
      value,
    ) ||
    /\bhttps?:\/\/[^\s,;]+/i.test(value) ||
    /\burl\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/i.test(value)
  );
}

function redactUrlLikeHeaderValue(
  value: string,
  path: string,
): RedactionResult<string> {
  const fields: RedactionField[] = [];
  let output = value.replace(
    /<([^>]+)>|https?:\/\/[^\s,;]+/gi,
    (match, bracketed: string | undefined) => {
      const rawUrl = bracketed ?? match;
      const result = redactUrl(rawUrl, path);
      if (result.metadata) fields.push(...result.metadata.fields);
      return bracketed === undefined ? result.value : `<${result.value}>`;
    },
  );
  output = output.replace(
    /\burl(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s,;]+))/gi,
    (
      _match,
      separator: string,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
      unquoted: string | undefined,
    ) => {
      const rawUrl = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
      const quote =
        doubleQuoted !== undefined
          ? '"'
          : singleQuoted !== undefined
            ? "'"
            : "";
      const result = redactUrl(rawUrl, path);
      if (result.metadata) fields.push(...result.metadata.fields);
      return `url${separator}${quote}${result.value}${quote}`;
    },
  );
  output = output.replace(
    /^(\s*)((?:\/|\.\.?\/)[^\s,;]+)/,
    (_match, prefix: string, rawUrl: string) => {
      const result = redactUrl(rawUrl, path);
      if (result.metadata) fields.push(...result.metadata.fields);
      return `${prefix}${result.value}`;
    },
  );
  const tokenResult = redactTokenLikeString(output, path);
  if (tokenResult.metadata) fields.push(...tokenResult.metadata.fields);
  const metadata = metadataFromFields(fields);
  return { value: tokenResult.value, ...(metadata ? { metadata } : {}) };
}

export function redactCookieValue(
  name: string,
  value: string,
  path = `cookies.${name}`,
  configuredMaskNames: string[] = [],
): RedactionResult<string> {
  if (value === "") return { value: "" };

  const configured = configuredMaskNames.includes(name);
  const safeName = sanitizeKeyName(name);
  const safePath = path.replace(name, safeName);
  const summary = buildSummary(
    "cookie",
    "redacted",
    configured ? "configured_cookie_mask" : "cookie_value",
    value.length,
  );
  return withMetadata(
    REDACTED_VALUE,
    {
      path: safePath,
      reason: configured ? "configured_cookie_mask" : "cookie_value",
      action: "redacted",
    },
    summary,
  );
}

export function redactCookieName(name: string): string {
  return sanitizeKeyName(name);
}

export function redactCookieMap(
  cookies: Record<string, string>,
  path = "cookies",
  configuredMaskNames: string[] = [],
): RedactionResult<Record<string, string>> {
  const output: Record<string, string> = {};
  const metadataItems: Array<RedactionMetadata | undefined> = [];

  for (const [name, value] of Object.entries(cookies)) {
    const safeName = uniqueOutputKey(sanitizeKeyName(name), output);
    const result = redactCookieValue(
      name,
      value,
      `${path}.${safeName}`,
      configuredMaskNames,
    );
    output[safeName] = result.value;
    metadataItems.push(result.metadata);
  }

  const metadata = mergeRedactionMetadata(...metadataItems);
  return { value: output, ...(metadata ? { metadata } : {}) };
}

function isJsonContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return lower.includes("application/json") || lower.includes("+json");
}

function isFormContentType(contentType: string): boolean {
  return contentType
    .toLowerCase()
    .includes("application/x-www-form-urlencoded");
}

function isMarkupContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return (
    lower.includes("application/xml") ||
    lower.includes("text/xml") ||
    lower.includes("+xml") ||
    lower.includes("text/html") ||
    lower.includes("multipart/form-data")
  );
}

function looksLikeJson(body: string): boolean {
  const trimmed = body.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function redactJsonValue(
  value: unknown,
  path: string,
  keyName?: string,
): { value: unknown; fields: RedactionField[] } {
  if (keyName && isSensitiveName(keyName)) {
    return {
      value: REDACTED_VALUE,
      fields: [{ path, reason: "sensitive_json_field", action: "redacted" }],
    };
  }

  if (typeof value === "string") {
    // Route embedded URL substrings through the key-aware `redactUrl` policy
    // first (catches a short `?token=…` the token-shape patterns miss), then the
    // generic token scrub for the rest.
    const urlResult = redactUrlsInText(value, path);
    const result = redactTokenLikeString(urlResult.value, path);
    return {
      value: result.value,
      fields: [
        ...(urlResult.metadata?.fields ?? []),
        ...(result.metadata?.fields ?? []),
      ],
    };
  }

  if (Array.isArray(value)) {
    const fields: RedactionField[] = [];
    const output = value.map((entry, index) => {
      const result = redactJsonValue(entry, `${path}[${index}]`);
      fields.push(...result.fields);
      return result.value;
    });
    return { value: output, fields };
  }

  // A Date is an object with no own enumerable properties, so the generic walk
  // below would render every timestamp as `{}`. Timestamps answer the ordering
  // and timing questions a captured session exists for, and rows differing only
  // by one would collapse to a single value — which downstream reads as
  // duplicate work that never happened. An unrepresentable date becomes null
  // rather than the string "Invalid Date", so a reader sees absence, not a
  // value. Applied before the object branch and after the string branch, so
  // key-name redaction above still wins on a sensitive column.
  if (value instanceof Date) {
    const time = value.getTime();
    return {
      value: Number.isFinite(time) ? value.toISOString() : null,
      fields: [],
    };
  }

  if (value !== null && typeof value === "object") {
    const fields: RedactionField[] = [];
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const safeKey = sanitizeKeyName(key);
      if (safeKey !== key) {
        fields.push({
          path: `${path}.${safeKey}`,
          reason: "json_key_token_like",
          action: "redacted",
        });
        output[safeKey] = REDACTED_VALUE;
        continue;
      }
      const result = redactJsonValue(entry, `${path}.${safeKey}`, key);
      fields.push(...result.fields);
      output[safeKey] = result.value;
    }
    return { value: output, fields };
  }

  return { value, fields: [] };
}

/**
 * Redacts an arbitrary JSON-like value (object/array/scalar) through the browser redaction
 * policy: sensitive-looking key names are masked and token-like string values are scrubbed.
 * Used to sanitize declarative env flags/config before they rest in a `k:'env'` event.
 */
export function redactValue<T>(value: T, path = "value"): RedactionResult<T> {
  const result = redactJsonValue(value, path);
  const metadata = metadataFromFields(result.fields);
  return { value: result.value as T, ...(metadata ? { metadata } : {}) };
}

function redactFormBody(body: string, path: string): BodyRedactionResult {
  const params = new URLSearchParams(body);
  const fields: RedactionField[] = [];
  for (const key of Array.from(params.keys())) {
    const values = params.getAll(key);
    const safeKey = sanitizeKeyName(key);
    params.delete(key);
    for (const value of values) {
      if (value === "") {
        params.append(safeKey, "");
      } else {
        params.append(safeKey, REDACTED_VALUE);
        fields.push({
          path: `${path}.${safeKey}`,
          reason: "form_value",
          action: "redacted",
        });
      }
    }
  }

  if (fields.length === 0) return { body };

  const summary = buildSummary(
    "form",
    "redacted",
    "form_value",
    body.length,
    undefined,
    fields.length,
  );
  return {
    body: params.toString(),
    bodySummary: summary,
    metadata: {
      policy: BROWSER_REDACTION_POLICY,
      fields,
      summaries: [summary],
    },
  };
}

function redactTextKeyValueBody(
  body: string,
  path: string,
): BodyRedactionResult | undefined {
  const parts = body.split(/([&;\n\r])/);
  const fields: RedactionField[] = [];
  let changed = false;
  let sawKeyValue = false;
  const output = parts.map((part) => {
    if (part === "&" || part === ";" || part === "\n" || part === "\r")
      return part;
    const match = part.match(/^([^:=\n\r]{1,120})([:=])(.*)$/s);
    if (!match) {
      return part;
    }
    sawKeyValue = true;
    const [, rawKey, delimiter, rawValue] = match;
    const safeKey = sanitizeKeyName(rawKey.trim());
    const sensitive = isSensitiveName(rawKey);
    const valueResult = sensitive
      ? { value: REDACTED_VALUE }
      : redactTokenLikeString(rawValue, `${path}.${safeKey}`);
    if (safeKey !== rawKey.trim() || valueResult.value !== rawValue)
      changed = true;
    if (sensitive || valueResult.value !== rawValue)
      fields.push({
        path: `${path}.${safeKey}`,
        reason: sensitive ? "text_sensitive_field" : "text_token_like_value",
        action: "redacted",
      });
    return `${safeKey}${delimiter}${valueResult.value}`;
  });
  if (!sawKeyValue || !changed) return undefined;
  const bodySummary = buildSummary(
    "text",
    "redacted",
    "text_key_value_fields",
    body.length,
    undefined,
    fields.length,
  );
  const metadata = metadataFromFields(fields, [bodySummary]);
  return { body: output.join(""), bodySummary, metadata };
}

function redactMarkupTextBody(
  body: string,
  path: string,
): BodyRedactionResult | undefined {
  const fields: RedactionField[] = [];
  let output = body.replace(
    /<((?:[\w.-]+:)?(?:access[-_]?token|api[-_]?key|auth|authorization|card[-_]?number|client[-_]?secret|credential|credentials|csrf|cvc|cvv|id[-_]?token|jsessionid|jwt|otp|pass[-_]?phrase|passcode|passwd|password|pin|private[-_]?key|pwd|refresh[-_]?token|secret|security[-_]?code|session[-_]?id|sid|token|verification[-_]?code|xsrf))(\s[^>]*)?>[\s\S]*?<\/\1>/gi,
    (match, tag: string, attrs: string | undefined) => {
      if (!isSensitiveName(tag)) return match;
      fields.push({
        path: `${path}.${sanitizeKeyName(tag)}`,
        reason: "markup_sensitive_tag",
        action: "redacted",
      });
      return `<${tag}${attrs ?? ""}>${REDACTED_VALUE}</${tag}>`;
    },
  );
  output = output.replace(
    /<([A-Za-z][\w:.-]{0,119})([^>]*)>/gi,
    (match, tag: string, attrs: string) => {
      const marker = readSensitiveMarkupMarker(attrs);
      if (!marker) return match;
      const redactedAttrs = replaceSensitiveMarkupPayloadAttributes(attrs);
      if (redactedAttrs === attrs) return match;
      fields.push({
        path: `${path}.${sanitizeKeyName(marker.value)}`,
        reason: "markup_sensitive_payload_attribute",
        action: "redacted",
      });
      return `<${tag}${redactedAttrs}>`;
    },
  );
  output = output.replace(
    /<((?:textarea|select|option)\b)([^>]*)>([\s\S]*?)<\/\1>/gi,
    (match, tag: string, attrs: string) => {
      const marker = readSensitiveMarkupMarker(attrs);
      if (!marker) return match;
      fields.push({
        path: `${path}.${sanitizeKeyName(marker.value)}`,
        reason: "markup_sensitive_control_text",
        action: "redacted",
      });
      return `<${tag}${attrs}>${REDACTED_VALUE}</${tag}>`;
    },
  );
  output = output.replace(
    /<([A-Za-z][\w:.-]{0,119})(\s[^>]*)?>([^<]*)<\/\1>/gi,
    (match, tag: string, attrs: string | undefined) => {
      if (!isSensitiveName(tag)) return match;
      fields.push({
        path: `${path}.${sanitizeKeyName(tag)}`,
        reason: "markup_sensitive_tag",
        action: "redacted",
      });
      return `<${tag}${attrs ?? ""}>${REDACTED_VALUE}</${tag}>`;
    },
  );
  output = output.replace(
    /([A-Za-z_:][\w:.-]{0,119})(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
    (
      match,
      name: string,
      eq: string,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
      _unquoted: string | undefined,
    ) => {
      if (!isSensitiveName(name)) return match;
      const quote =
        doubleQuoted !== undefined
          ? '"'
          : singleQuoted !== undefined
            ? "'"
            : "";
      fields.push({
        path: `${path}.${sanitizeKeyName(name)}`,
        reason: "markup_sensitive_attribute",
        action: "redacted",
      });
      return `${name}${eq}${quote}${REDACTED_VALUE}${quote}`;
    },
  );
  output = output.replace(
    /(name\s*=\s*)(?:"([^"]+)"|'([^']+)'|([^;\s\r\n]+))([\s\S]{0,256}?)(\r?\n\r?\n)([\s\S]*?)(?=\r?\n--|$)/gi,
    (
      match,
      prefix: string,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
      unquoted: string | undefined,
      between: string,
      separator: string,
    ) => {
      const name = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
      if (!isSensitiveName(name)) return match;
      const quote =
        doubleQuoted !== undefined
          ? '"'
          : singleQuoted !== undefined
            ? "'"
            : "";
      fields.push({
        path: `${path}.${sanitizeKeyName(name)}`,
        reason: "multipart_sensitive_field",
        action: "redacted",
      });
      return `${prefix}${quote}${name}${quote}${between}${separator}${REDACTED_VALUE}`;
    },
  );
  if (fields.length === 0) return undefined;
  const bodySummary = buildSummary(
    "text",
    "redacted",
    "markup_sensitive_fields",
    body.length,
    undefined,
    fields.length,
  );
  const metadata = metadataFromFields(fields, [bodySummary]);
  return { body: output, bodySummary, metadata };
}

function readMarkupAttributes(
  attrs: string,
  names: string[],
): Array<{ name: string; value: string }> {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const attributes: Array<{ name: string; value: string }> = [];
  const attrPattern =
    /([A-Za-z_:][\w:.-]{0,119})\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(attrs)) !== null) {
    const name = match[1];
    if (!wanted.has(name.toLowerCase())) continue;
    attributes.push({ name, value: match[2] ?? match[3] ?? match[4] ?? "" });
  }
  return attributes;
}

function readSensitiveMarkupMarker(
  attrs: string,
): { name: string; value: string } | undefined {
  for (const marker of readMarkupAttributes(attrs, [
    "name",
    "id",
    "autocomplete",
    "type",
  ])) {
    const value = marker.value.toLowerCase();
    if (
      isSensitiveName(marker.value) ||
      value === "hidden" ||
      value === "password"
    )
      return marker;
  }
  return undefined;
}

function replaceSensitiveMarkupPayloadAttributes(attrs: string): string {
  const attrPattern =
    /([A-Za-z_:][\w:.-]{0,119})(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  return attrs.replace(
    attrPattern,
    (
      match,
      name: string,
      eq: string,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
    ) => {
      const normalized = name.toLowerCase();
      if (
        normalized !== "value" &&
        normalized !== "content" &&
        normalized !== "href" &&
        normalized !== "src" &&
        !normalized.startsWith("data-")
      )
        return match;
      const quote =
        doubleQuoted !== undefined
          ? '"'
          : singleQuoted !== undefined
            ? "'"
            : "";
      return `${name}${eq}${quote}${REDACTED_VALUE}${quote}`;
    },
  );
}

/* ------------------------------------------------------------------ */
/* Structured redaction v2 (network JSON bodies)                       */
/* ------------------------------------------------------------------ */

export type StructuredRedactionMode = "structured" | "full";

export type RedactedShapeCharset = "alpha" | "num" | "alnum" | "mixed";

export type RedactedShapeSeparator = {
  index: number;
  char: "." | "," | " ";
};

/**
 * Non-recoverable shape metadata attached to every v2-redacted value.
 * `hash8` is salted with a per-session random salt (equality tests work within
 * a session; cross-session recovery does not) and is omitted entirely when the
 * candidate space is small enough to brute-force (short numerics like CVVs,
 * PINs, SSNs, phone numbers, or any very short value).
 */
export interface RedactedValueShape {
  len: number;
  charset: RedactedShapeCharset;
  /** Decimal, grouping, or whitespace separators in numeric-looking text. */
  separators?: RedactedShapeSeparator[];
  hash8?: string;
  /**
   * Session-salted fingerprint of the lowercase value. Present only when case
   * folding changes a sufficiently high-entropy string, so consumers can spot
   * case-only identity collisions without learning or recovering the value.
   */
  casefoldHash8?: string;
}

export type StructuredClassification =
  { action: "keep" } | { action: "redact"; reason: string };

/**
 * V2 additions to the field-name deny list, matched as substrings of the
 * compacted (lowercased, alphanumeric-only) field name. Deny-biased on purpose:
 * `cardigan` matching `card` is an acceptable false positive.
 */
const STRUCTURED_DENY_NAME_TOKENS = [
  "password",
  "token",
  "secret",
  "auth",
  "card",
  "cvv",
  "ssn",
  "email",
  "phone",
  "address",
  "iban",
  "account",
  // Date of birth. `dob` and `birthdate` were matched as whole words only, so
  // "Date of Birth" (compacted: dateofbirth), "date_of_birth" and "Birthday"
  // all classified as keep — and a birth date is directly identifying under
  // GDPR and HIPAA alike. As a substring this also covers birthDay, birthYear,
  // birthPlace and patientBirthDate.
  "birth",
];

/**
 * Short/ambiguous deny tokens matched as whole words (with optional trailing
 * digits) rather than substrings: `pin` ⊂ "shipping", `pan` ⊂ "company",
 * `pass` ⊂ "compass", `otp` ⊂ "spanish"-class collisions would otherwise
 * over-reach into legitimate field names. `pwd2`/`pin2`/`otpCode`/`userPass`
 * still redact; `shipping`/`company`/`ping` survive.
 */
const STRUCTURED_DENY_WORD_RE = /^(?:pwd|pin|pan|otp|pass)\d*$/;

const STRUCTURED_EMAIL_RE = /[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/i;
/** IBAN shape: 2-letter country, 2 check digits, 10–30 alphanumerics. */
const STRUCTURED_IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;
const STRUCTURED_JWT_RE =
  /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{2,}/;
const ENUM_LIKE_RE = /^[A-Za-z0-9_-]{1,24}$/;

function compactFieldName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Field name split into words at camelCase/snake/kebab boundaries. */
function fieldNameWords(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Did the APPLICATION deny this name, as opposed to a built-in heuristic matching it?
 *
 * The distinction decides whether a container is opened. `denyFields` is the strongest statement
 * an application can make about its own schema and is honoured absolutely, subtree and all. The
 * built-in tokens are substring guesses over field names, and a guess should not silently delete a
 * structure it merely shares a syllable with.
 */
function isApplicationDeniedName(
  name: string | undefined,
  denyFields?: readonly string[],
): boolean {
  if (!name || !denyFields || denyFields.length === 0) return false;
  const compact = compactFieldName(name);
  return denyFields.some((deny) => {
    const denyCompact = compactFieldName(deny);
    return denyCompact.length > 0 && compact.includes(denyCompact);
  });
}

/**
 * Built-in name tokens that name a business OBJECT rather than a secret.
 *
 * The rest of `STRUCTURED_DENY_NAME_TOKENS` name the sensitive thing itself: everything under a key
 * called `auth`, `password`, `secret`, `cvv` or `ssn` is that secret, so dropping the whole subtree
 * loses nothing. These two do not. A gift card, a loyalty card, a customer account are ordinary
 * records that may merely CONTAIN a sensitive scalar, and their other fields are often the whole
 * subject of a bug report.
 *
 * Kept deliberately short. Every addition trades a real class of evidence for a name-shaped guess,
 * so a token belongs here only once a measured capture shows the guess destroying the answer.
 */
const STRUCTURED_OPENABLE_NAME_TOKENS = new Set(["card", "account"]);

/**
 * May a CONTAINER under this name be walked into rather than dropped whole?
 *
 * True only when every built-in token the name matched is an object-naming one. `cardToken` matches
 * both `card` and `token`, so it stays closed; `giftCard` matches only `card`, so its leaves are
 * classified individually. Names the application itself denied never reach here.
 */
function isOpenableHeuristicName(name: string | undefined): boolean {
  if (!name) return false;
  if (fieldNameWords(name).some((word) => STRUCTURED_DENY_WORD_RE.test(word)))
    return false;
  const compact = compactFieldName(name);
  const matched = STRUCTURED_DENY_NAME_TOKENS.filter((token) =>
    compact.includes(token),
  );
  if (matched.length === 0) return false;
  return matched.every((token) => STRUCTURED_OPENABLE_NAME_TOKENS.has(token));
}

function isStructuredDenyName(
  name: string | undefined,
  denyFields?: string[],
  keepFields?: string[],
): boolean {
  if (!name) return false;
  const compact = compactFieldName(name);
  if (denyFields && denyFields.length > 0) {
    // Substring-of-compacted-name semantics: denyFields: ["coupon"] also
    // redacts couponCode. Checked first, and unconditionally: the application's
    // own denial is the strongest statement it can make about a field, so it
    // outranks its own keep for the same name.
    const denied = denyFields.some((deny) => {
      const denyCompact = compactFieldName(deny);
      return denyCompact.length > 0 && compact.includes(denyCompact);
    });
    if (denied) return true;
  }
  // A whole-name keep overrides the BUILT-IN name rules below, and only those.
  // Those rules are substring heuristics with real false positives — `auth`
  // matches `author`, `pan` matches `panel` — and without an override an
  // application whose schema trips one has no way to capture the field at all.
  // This is the deliberate escape hatch, so it is narrow on purpose: it takes
  // a whole-name match, it cannot be reached by substring, and every
  // value-based check in classifyStructuredValue still runs behind it, so an
  // email, a JWT, a card number, a token, or a high-entropy secret sitting in
  // a kept field is still redacted.
  if (isStructuredKeepName(name, keepFields)) return false;
  if (isSensitiveName(name)) return true;
  if (STRUCTURED_DENY_NAME_TOKENS.some((token) => compact.includes(token)))
    return true;
  if (fieldNameWords(name).some((word) => STRUCTURED_DENY_WORD_RE.test(word)))
    return true;
  return false;
}

function luhnPasses(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function containsLuhnDigitRun(value: string): boolean {
  const stripped = value.replace(/[\s-]/g, "");
  const runs = stripped.match(/\d{13,19}/g);
  if (!runs) return false;
  return runs.some((run) => luhnPasses(run));
}

function shannonEntropyBitsPerChar(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Whether a string looks randomly generated rather than authored.
 *
 * Two bands. At 24 characters and up, entropy alone decides: nothing an
 * application names its states is that long and that varied. Between 16 and 23
 * characters entropy alone cannot separate `AKIAIOSFODNN7EXAMPLE` (3.68
 * bits/char) from `subscription_active` (3.68), so that band additionally
 * requires the character mixing a generated secret has and an enum name does
 * not: either both letter cases, or digits interleaved into letters with no
 * word separator. `PAYMENT_DECLINED`, `INTERNAL_ERROR_500` and
 * `order_status_new` all fail that second test and stay verbatim.
 *
 * Below 16 characters nothing is claimed: the band is dominated by status
 * words, currency codes and short ids, and the value-shape rules above
 * (Luhn, IBAN, JWT, prefixed tokens) already cover the sensitive cases.
 */
function isHighEntropyString(value: string): boolean {
  if (value.length < 16 || /\s/.test(value)) return false;
  const bits = shannonEntropyBitsPerChar(value);
  if (value.length >= 24) return bits >= 3.5;
  if (bits < 3.6) return false;
  const mixedCase = /[a-z]/.test(value) && /[A-Z]/.test(value);
  const digitsInWord =
    /[0-9]/.test(value) && /[A-Za-z]/.test(value) && !/[_\-./: ]/.test(value);
  return mixedCase || digitsInWord;
}

/** Lazily-initialized per-session random salt for shape hashes. */
let structuredShapeSalt: string | undefined;

function getStructuredShapeSalt(): string {
  if (structuredShapeSalt === undefined) {
    const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
    if (cryptoObj?.getRandomValues) {
      const bytes = new Uint8Array(16);
      cryptoObj.getRandomValues(bytes);
      structuredShapeSalt = Array.from(bytes, (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
    } else {
      structuredShapeSalt = `${Math.random()}${Math.random()}${Date.now()}`;
    }
  }
  return structuredShapeSalt;
}

/** Test-only: clears the session salt so a fresh one is generated. */
export function resetStructuredShapeSaltForTests(): void {
  structuredShapeSalt = undefined;
}

function fnv1a32Hex(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const NUMERIC_SHAPE_RE = /^[+-]?[\d.,\s]+$/;
const MAX_REDACTED_SHAPE_SEPARATORS = 32;

function redactedShapeSeparators(
  text: string,
): RedactedShapeSeparator[] | undefined {
  if (!NUMERIC_SHAPE_RE.test(text) || !/\d/.test(text)) return undefined;
  const separators: RedactedShapeSeparator[] = [];
  for (
    let index = 0;
    index < text.length && separators.length < MAX_REDACTED_SHAPE_SEPARATORS;
    index += 1
  ) {
    const char = text[index];
    if (char === "." || char === "," || char === " ")
      separators.push({ index, char });
  }
  return separators.length > 0 ? separators : undefined;
}

/**
 * Shape metadata for a redacted value — length, charset class, numeric separator
 * positions, and a salted one-way hash. The hash is omitted for low-entropy
 * values whose candidate space is trivially enumerable (numeric with len < 12,
 * or any len < 6).
 */
export function computeRedactedShape(value: unknown): RedactedValueShape {
  const text =
    typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  const charset: RedactedShapeCharset = /^[A-Za-z]+$/.test(text)
    ? "alpha"
    : /^[0-9]+$/.test(text)
      ? "num"
      : /^[A-Za-z0-9]+$/.test(text)
        ? "alnum"
        : "mixed";
  const separators = redactedShapeSeparators(text);
  const shape: RedactedValueShape = {
    len: text.length,
    charset,
    ...(separators ? { separators } : {}),
  };
  const smallCandidateSpace =
    text.length < 6 || (charset === "num" && text.length < 12);
  if (!smallCandidateSpace) {
    shape.hash8 = fnv1a32Hex(`${getStructuredShapeSalt()}:${text}`);
    const casefolded = text.toLowerCase();
    if (casefolded !== text) {
      shape.casefoldHash8 = fnv1a32Hex(
        `${getStructuredShapeSalt()}:${casefolded}`,
      );
    }
  }
  return shape;
}

/**
 * Field names whose value is the server's own account of what happened.
 *
 * A response body that says `{"msg":"Invalid login credentials"}` was stored as
 * `{"$redacted":"[REDACTED]","len":25,"charset":"mixed","hash8":"…"}`, so a
 * session could report that a sign-in failed but never why — the one sentence a
 * reader needed was the one thing removed. These names are not personal-data
 * names: the personal ones (`email`, `phone`, `address`, `dob`, and every deny
 * token) are rejected far earlier in {@link classifyStructuredValue} and never
 * reach this carve-out.
 *
 * `title` is included because a title is a label; it is the loosest entry here
 * and the shape test below is what keeps it honest.
 */
const MESSAGE_FIELD_NAMES = new Set([
  "detail",
  "details",
  "error",
  "errordescription",
  "errormessage",
  "errors",
  "errortext",
  "hint",
  "message",
  "messages",
  "msg",
  "reason",
  "statusmessage",
  "statustext",
  "title",
]);

/** A sentence, not a document. Anything longer is free text and still goes. */
const PLAIN_MESSAGE_MAX_LENGTH = 120;

/**
 * Letters, digits and ordinary sentence punctuation only. No `@`, no `/`, no
 * `\`, no `=`, no `<`, so an address, a URL, a path, a header or a serialized
 * credential cannot satisfy it even under a message-shaped name.
 */
const PLAIN_MESSAGE_CHARS_RE = /^[A-Za-z][A-Za-z0-9 .,;:!?'"()%$+-]*$/;

/** A word, or a small number like an HTTP status or a retry delay. */
function isPlainMessageWord(word: string): boolean {
  if (/[A-Za-z]/.test(word)) return true;
  return /^\d{1,3}[.,;:!?)%]?$/.test(word);
}

/**
 * Is this short free text the server explaining itself, rather than something a
 * person's data ended up in?
 *
 * Reached only at the very bottom of {@link classifyStructuredValue}, so every
 * validated personal and credential pattern — email, JWT, Luhn card run, IBAN,
 * token-like string, high-entropy string — has already been tested and failed,
 * and every deny-listed field name has already been rejected. What is left to
 * exclude here is the shape of personal data that no validator catches: digit
 * runs (a phone number, an SSN, an account number) and anything long enough to
 * be a user-authored note rather than a sentence of prose.
 */
function isPlainMessageValue(value: string, keyName?: string): boolean {
  if (!keyName) return false;
  if (!MESSAGE_FIELD_NAMES.has(compactFieldName(keyName))) return false;
  const text = value.trim();
  if (text.length === 0 || text.length > PLAIN_MESSAGE_MAX_LENGTH) return false;
  if (!PLAIN_MESSAGE_CHARS_RE.test(text)) return false;
  // Four consecutive digits is the smallest run that could be a year of birth,
  // a card fragment, a postcode or the tail of a phone number. Three is a
  // status code or a count.
  if (/\d{4}/.test(text)) return false;
  const words = text.split(/\s+/);
  if (words.length < 2) return false;
  return words.every(isPlainMessageWord);
}

/**
 * Per-value classifier for structured (v2) network-body redaction. Deny-biased:
 * only numbers, booleans, nulls, and short enum-like strings that match no
 * redact rule survive verbatim.
 *
 * Accepted residual: bare 9–11 digit strings under genuinely neutral field
 * names (order numbers, tax refs) are kept — there is deliberately no blanket
 * digit-run rule, because that class is dominated by non-sensitive business
 * identifiers. Sensitive digit runs are caught by name (deny tokens like
 * ssn/pin/account) or by shape (Luhn card runs, IBANs) instead.
 *
 * @param keyName Owning field name, used by external callers (e.g. UI-capture
 * label classification) for deny-list checks; the internal walker checks names
 * itself and passes `undefined` here.
 */
export function classifyStructuredValue(
  value: unknown,
  keyName?: string,
  denyFields?: string[],
  keepFields?: string[],
): StructuredClassification {
  if (isStructuredDenyName(keyName, denyFields, keepFields))
    return { action: "redact", reason: "deny_field" };
  // An application-declared keep exempts the name from the free-text
  // catch-all at the bottom of this function. Every value-based check below
  // still runs, so a secret pasted into a kept field is still caught.
  const kept = isStructuredKeepName(keyName, keepFields);
  if (typeof value === "number") {
    // JSON numbers are ordinarily kept verbatim (prices, qtys, ids,
    // timestamps), but a 13–19 digit Luhn-passing integer is a card number.
    if (Number.isInteger(value) && value > 0) {
      const digits = String(value);
      if (/^\d{13,19}$/.test(digits) && luhnPasses(digits))
        return { action: "redact", reason: "luhn_value" };
      // A 17–19 digit PAN exceeds Number.MAX_SAFE_INTEGER, so JSON.parse
      // rounds it and the rounded rendering usually fails Luhn — but its
      // leading ~16 digits are still the real card digits. Deny-biased:
      // redact any unsafe integer that renders as a 13–20 digit run (a
      // nanosecond timestamp over-redacting is acceptable).
      if (!Number.isSafeInteger(value) && /^\d{13,20}$/.test(digits))
        return { action: "redact", reason: "luhn_value" };
    }
    return { action: "keep" };
  }
  if (value === null || typeof value === "boolean") return { action: "keep" };
  if (typeof value !== "string")
    return { action: "redact", reason: "unknown_value" };
  if (STRUCTURED_EMAIL_RE.test(value))
    return { action: "redact", reason: "email_value" };
  if (STRUCTURED_JWT_RE.test(value))
    return { action: "redact", reason: "jwt_value" };
  if (containsLuhnDigitRun(value))
    return { action: "redact", reason: "luhn_value" };
  if (redactTokenLikeString(value).value !== value)
    return { action: "redact", reason: "token_like_value" };
  // Operational timestamps are correlation evidence, not free-form user
  // content. Keep canonical ISO instants unless the field name itself is
  // sensitive (the deny-name check above still redacts dob/birthdate/etc.).
  // This mirrors Date-object handling, which already serializes to ISO.
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  ) {
    return { action: "keep" };
  }
  // Deny-biased ordering: at the 24-char boundary a string can be both
  // enum-like (≤ 24) and entropy-eligible (≥ 24) — entropy wins.
  if (isHighEntropyString(value))
    return { action: "redact", reason: "high_entropy_value" };
  // IBANs are enum-shaped (≤ 24 alphanumerics for most countries), so this
  // check must run before the enum-keep. Whitespace-stripped: display forms
  // group IBANs in blocks of four ("GB29 NWBK 6016 ...").
  if (STRUCTURED_IBAN_RE.test(value.replace(/\s+/g, "")))
    return { action: "redact", reason: "iban_value" };
  if (ENUM_LIKE_RE.test(value)) return { action: "keep" };
  if (kept) return { action: "keep" };
  if (isPlainMessageValue(value, keyName)) return { action: "keep" };
  return { action: "redact", reason: "free_text_value" };
}

type DiagnosticPathPart =
  | { kind: "key"; value: string }
  | { kind: "index"; value: number };

interface DiagnosticPathNode {
  terminal: boolean;
  keys: Map<string, DiagnosticPathNode>;
  indexes: Map<number, DiagnosticPathNode>;
}

const DIAGNOSTIC_PATH_MAX_LENGTH = 256;
const DIAGNOSTIC_RESERVED_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "body",
  "requestbody",
  "responsebody",
  "header",
  "headers",
  "rawbody",
  "rawheaders",
  "rawstack",
  "stack",
  "locals",
]);
const DIAGNOSTIC_KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;
const DIAGNOSTIC_INDEX_RE = /^(?:0|[1-9][0-9]{0,5})$/;

function newDiagnosticPathNode(): DiagnosticPathNode {
  return { terminal: false, keys: new Map(), indexes: new Map() };
}

function parseDiagnosticFieldPath(path: string): DiagnosticPathPart[] | undefined {
  if (
    path.length === 0 ||
    path.length > DIAGNOSTIC_PATH_MAX_LENGTH ||
    path.trim() !== path
  ) {
    return undefined;
  }

  const parts: DiagnosticPathPart[] = [];
  let offset = 0;
  const readKey = (): boolean => {
    const start = offset;
    while (
      offset < path.length &&
      path[offset] !== "." &&
      path[offset] !== "["
    ) {
      offset += 1;
    }
    const key = path.slice(start, offset);
    if (!DIAGNOSTIC_KEY_RE.test(key)) return false;
    parts.push({ kind: "key", value: key });
    return true;
  };
  const readIndex = (): boolean => {
    const start = offset;
    const closing = path.indexOf("]", offset);
    if (closing < 0) return false;
    const index = path.slice(start, closing);
    if (!DIAGNOSTIC_INDEX_RE.test(index)) return false;
    parts.push({ kind: "index", value: Number(index) });
    offset = closing + 1;
    return true;
  };

  if (path[0] === "[") {
    offset = 1;
    if (!readIndex()) return undefined;
  } else if (!readKey()) {
    return undefined;
  }

  while (offset < path.length) {
    if (path[offset] === ".") {
      offset += 1;
      if (!readKey()) return undefined;
      continue;
    }
    if (path[offset] === "[") {
      offset += 1;
      if (!readIndex()) return undefined;
      continue;
    }
    return undefined;
  }
  return parts;
}

function isDiagnosticReservedKey(key: string): boolean {
  const compact = compactFieldName(key);
  return (
    DIAGNOSTIC_RESERVED_KEYS.has(key.toLowerCase()) ||
    DIAGNOSTIC_RESERVED_KEYS.has(compact)
  );
}

function compileDiagnosticFieldPaths(
  paths: readonly string[],
  denyFields: readonly string[] | undefined,
): DiagnosticPathNode {
  const root = newDiagnosticPathNode();
  const normalized = new Map<string, DiagnosticPathPart[]>();

  for (const candidate of paths) {
    if (typeof candidate !== "string") continue;
    const parsed = parseDiagnosticFieldPath(candidate);
    if (!parsed || parsed.length === 0) continue;
    if (
      parsed.some(
        (part) =>
          part.kind === "key" &&
          (isDiagnosticReservedKey(part.value) ||
            isSensitiveName(part.value) ||
            isApplicationDeniedName(part.value, denyFields)),
      )
    ) {
      continue;
    }
    normalized.set(candidate, parsed);
  }

  for (const [, parts] of [...normalized.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, DIAGNOSTIC_FIELD_MAX_ENTRIES)) {
    let node = root;
    for (const part of parts) {
      let child =
        part.kind === "key"
          ? node.keys.get(part.value)
          : node.indexes.get(part.value);
      if (!child) {
        child = newDiagnosticPathNode();
        if (part.kind === "key") {
          node.keys.set(part.value, child);
        } else {
          node.indexes.set(part.value, child);
        }
      }
      node = child;
    }
    node.terminal = true;
  }
  return root;
}

function diagnosticPathForPart(path: string, part: DiagnosticPathPart): string {
  return part.kind === "key" ? `${path}.${part.value}` : `${path}[${part.value}]`;
}

function safeDiagnosticObject(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function readOwnDiagnosticValue(
  value: object,
  key: string,
): { found: true; value: unknown } | { found: false } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  // Accessors can execute arbitrary code and are not stable telemetry input.
  // Only own, enumerable data properties are eligible.
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    return { found: false };
  }
  return { found: true, value: descriptor.value };
}

function diagnosticLeafValue(
  value: unknown,
  keyName: string | undefined,
  path: string,
  fields: RedactionField[],
  denyFields: readonly string[] | undefined,
): DiagnosticScalar | undefined {
  if (typeof value === "number" && !Number.isFinite(value)) {
    fields.push({ path, reason: "diagnostic_non_finite", action: "redacted" });
    return undefined;
  }

  const classification = classifyStructuredValue(
    value,
    keyName,
    denyFields ? [...denyFields] : undefined,
    undefined,
  );
  if (
    classification.action === "redact" &&
    classification.reason !== "free_text_value"
  ) {
    fields.push({
      path,
      reason: classification.reason,
      action: "redacted",
    });
    return undefined;
  }

  if (typeof value === "string" && value.length > DIAGNOSTIC_FIELD_MAX_STRING_LENGTH) {
    fields.push({
      path,
      reason: "diagnostic_value_too_large",
      action: "redacted",
    });
    return undefined;
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  fields.push({ path, reason: "diagnostic_non_scalar", action: "redacted" });
  return undefined;
}

function collectDiagnosticFields(
  node: DiagnosticPathNode,
  value: unknown,
  path: string,
  keyName: string | undefined,
  fields: RedactionField[],
  denyFields: readonly string[] | undefined,
  seen: WeakSet<object>,
): unknown {
  const isObject = value !== null && typeof value === "object";
  if (!isObject) {
    if (!node.terminal) return undefined;
    return diagnosticLeafValue(value, keyName, path, fields, denyFields);
  }
  if (seen.has(value)) {
    fields.push({ path, reason: "diagnostic_circular", action: "redacted" });
    return undefined;
  }
  seen.add(value);

  try {
    if (node.terminal && node.keys.size === 0 && node.indexes.size === 0) {
      fields.push({ path, reason: "diagnostic_non_scalar", action: "redacted" });
      return undefined;
    }

    const isArray = Array.isArray(value);
    const output = isArray ? [] : safeDiagnosticObject();
    let retained = 0;

    const append = (part: DiagnosticPathPart, child: DiagnosticPathNode) => {
      if (retained >= DIAGNOSTIC_FIELD_MAX_ENTRIES) return;
      if (isArray && part.kind !== "index") return;
      if (!isArray && part.kind !== "key") return;
      const key = part.kind === "key" ? part.value : String(part.value);
      const own = readOwnDiagnosticValue(value, key);
      if (!own.found) return;
      const childValue = collectDiagnosticFields(
        child,
        own.value,
        diagnosticPathForPart(path, part),
        part.kind === "key" ? part.value : keyName,
        fields,
        denyFields,
        seen,
      );
      if (childValue === undefined) return;
      if (part.kind === "index") {
        (output as unknown[])[part.value] = childValue;
      } else {
        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          value: childValue,

          writable: true,
        });
      }
      retained += 1;
    };

    for (const [key, child] of [...node.keys.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      append({ kind: "key", value: key }, child);
    }
    for (const [index, child] of [...node.indexes.entries()].sort(
      ([a], [b]) => a - b,
    )) {
      append({ kind: "index", value: index }, child);
    }

    if (retained === 0) return undefined;
    return output;
  } finally {
    seen.delete(value);
  }
}

/**
 * Selects explicitly named scalar diagnostics from an arbitrary object.
 *
 * This is a narrow opt-in for support evidence, not a general serializer. It
 * never follows unselected fields, inherited properties, accessors, or
 * prototype-like keys. Sensitive names and value patterns are still denied,
 * selected containers are traversed only to reach another selected path, and
 * oversized strings and non-scalars are dropped.
 */
export function redactDiagnosticFields(
  value: unknown,
  options: DiagnosticFieldRedactionOptions,
): RedactionResult<unknown> {
  const fields: RedactionField[] = [];
  const root = compileDiagnosticFieldPaths(
    options.diagnosticFields,
    options.denyFields,
  );
  const output = collectDiagnosticFields(
    root,
    value,
    options.path ?? "diagnosticFields",
    undefined,
    fields,
    options.denyFields,
    new WeakSet<object>(),
  );
  return {
    value: output ?? safeDiagnosticObject(),
    ...(fields.length > 0
      ? {
          metadata: {
            policy: BROWSER_REDACTION_POLICY_V2,
            fields,
          },
        }
      : {}),
  };
}

/**
 * The application's keep list, for the redaction paths that have no config in
 * hand.
 *
 * `redactUrl` is reached from masking, error, performance and navigation
 * capture, none of which are handed the SDK config, so a per-call policy
 * argument would have to be threaded through a dozen unrelated signatures. The
 * list is set once at init and read where it is needed. Empty by default, which
 * is the deny-biased behavior every one of those paths had before.
 */
let redactionKeepFields: string[] = [];

/**
 * Whether what a user types is recorded at all.
 *
 * The opt-out. Recording input values is the default and is what makes a filter or validation
 * defect legible - the ceiling a shopper typed beside the ceiling the request carried. A deployment
 * that would rather hold none of it sets `redaction.captureInputValues: false` and every input
 * becomes a placeholder, whatever the field is called and whatever `keepFields` says. This is a
 * one-way switch by design: it can only remove, never add.
 */
let captureInputValues = true;

/** Set from `config.redaction.captureInputValues` at init. Omitted means `true`. */
export function setCaptureInputValues(enabled: boolean | undefined): void {
  captureInputValues = enabled !== false;
}

export function getCaptureInputValues(): boolean {
  return captureInputValues;
}

/** Set from `config.redaction.keepFields` at init. Pass `[]` to restore defaults. */
export function setRedactionKeepFields(names: readonly string[] = []): void {
  redactionKeepFields = names.filter(
    (name) => typeof name === "string" && name.trim().length > 0,
  );
}

export function getRedactionKeepFields(): string[] {
  return redactionKeepFields;
}

/**
 * Whole-name match, unlike the substring semantics of `denyFields`. Widening a
 * keep by substring would let `"id"` silently exempt `nationalIdNumber`.
 */
function isStructuredKeepName(
  name: string | undefined,
  keepFields?: string[],
): boolean {
  if (!name || !keepFields || keepFields.length === 0) return false;
  const compact = compactFieldName(name);
  if (compact.length === 0) return false;
  return keepFields.some((keep) => compactFieldName(keep) === compact);
}

function redactedShapePlaceholder(value: unknown): Record<string, unknown> {
  const shape = computeRedactedShape(value);
  const placeholder: Record<string, unknown> = {
    $redacted: REDACTED_VALUE,
    len: shape.len,
    charset: shape.charset,
  };
  if (shape.separators !== undefined) placeholder.separators = shape.separators;
  if (shape.hash8 !== undefined) placeholder.hash8 = shape.hash8;
  if (shape.casefoldHash8 !== undefined)
    placeholder.casefoldHash8 = shape.casefoldHash8;
  return placeholder;
}

const PLACEHOLDER_KEYS = new Set([
  "$redacted",
  "len",
  "charset",
  "separators",
  "hash8",
  "casefoldHash8",
]);
const CHARSET_RE = /^[a-z]+$/;
const HASH8_RE = /^[0-9a-f]{8}$/;

/**
 * True only for a value this module itself produced.
 *
 * Redaction runs more than once over the same payload: the SDK classifies a
 * body before sending it, and the capture server re-classifies it at rest,
 * deliberately, so a client that lies about its policy cannot store secrets.
 * Without this check the second pass sees a placeholder OBJECT under a
 * free-text name and wraps it in another placeholder, so the stored value is
 * `$redacted` inside `$redacted` and the `len`/`hash8` shape facts detectors
 * join against describe the first placeholder rather than the original value.
 *
 * The check is exact rather than structural on purpose. Every key must be one
 * of the shape fields this module emits, `$redacted` must be the literal marker,
 * `len` a finite number, and the hashes 8 hex digits. Nothing that shape can
 * carry a secret, so treating it as already-redacted grants a caller nothing.
 */
function isRedactedPlaceholder(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  if (record.$redacted !== REDACTED_VALUE) return false;
  for (const [key, entry] of Object.entries(record)) {
    if (!PLACEHOLDER_KEYS.has(key)) return false;
    if (key === "$redacted") continue;
    if (key === "len") {
      if (typeof entry !== "number" || !Number.isFinite(entry)) return false;
      continue;
    }
    if (typeof entry !== "string") return false;
    if (key === "charset") {
      if (!CHARSET_RE.test(entry) || entry.length > 16) return false;
      continue;
    }
    if (key === "separators") {
      if (!Array.isArray(entry) || entry.length > 32) return false;
      for (const separator of entry) {
        if (
          separator === null ||
          typeof separator !== "object" ||
          Array.isArray(separator)
        )
          return false;
        const separatorRecord = separator as Record<string, unknown>;
        const separatorIndex = separatorRecord.index;
        const separatorChar = separatorRecord.char;
        if (
          Object.keys(separatorRecord).some(
            (separatorKey) => !["index", "char"].includes(separatorKey),
          ) ||
          typeof separatorIndex !== "number" ||
          !Number.isInteger(separatorIndex) ||
          separatorIndex < 0 ||
          (typeof record.len === "number" &&
            separatorIndex >= record.len) ||
          (separatorChar !== "." &&
            separatorChar !== "," &&
            separatorChar !== " ")
        )
          return false;
      }
      continue;
    }
    if (!HASH8_RE.test(entry)) return false;
  }
  return true;
}

function redactStructuredJsonValue(
  value: unknown,
  path: string,
  policy: StructuredFieldPolicy,
  fields: RedactionField[],
  keyName?: string,
): unknown {
  // Already redacted by an earlier pass. Re-wrapping it would replace the
  // original value's shape facts with the placeholder's own.
  if (isRedactedPlaceholder(value)) return value;
  // A deny-listed field name redacts its entire subtree, with one narrow exception: a CONTAINER
  // matched only by an object-naming built-in token is walked into instead.
  //
  // The built-in name tokens are substrings, and `card` is one of them. A gift-card object, a
  // loyalty-card object, a card-layout config: all match, and all had their whole contents replaced
  // by a shape placeholder because of the key they hang from. Measured on a real session, the
  // response that decided the defect rendered as `{[REDACTED_KEY]:[REDACTED]}` while the sibling
  // `/history` endpoint reported the identical number in the clear — it simply was not nested under
  // a key spelled `card`. The redaction was not protecting anything there; it was deleting the
  // answer.
  //
  // Opening the container costs no protection, because a name is not the only defence and never was:
  // every leaf is still classified by its OWN name and, behind that, by its VALUE. A real PAN at
  // `card.number` is caught by the Luhn digit-run check; a token, JWT, email or high-entropy secret
  // by their own value rules. That is the same reasoning the `keepFields` escape hatch already
  // relies on — see `isStructuredDenyName`, which documents that every value-based check still runs
  // behind a kept name.
  //
  // An application's own `denyFields` keeps the old absolute behaviour. When the app says a subtree
  // is sensitive, that is a statement about its data that no heuristic here can outrank.
  const isContainer =
    Array.isArray(value) || (value !== null && typeof value === "object");
  if (isStructuredDenyName(keyName, policy.denyFields, policy.keepFields)) {
    const openable =
      isContainer &&
      !isApplicationDeniedName(keyName, policy.denyFields) &&
      isOpenableHeuristicName(keyName);
    if (!openable) {
      fields.push({ path, reason: "deny_field", action: "redacted" });
      return redactedShapePlaceholder(value);
    }
  }

  if (Array.isArray(value)) {
    // The array's own name carries through to its entries: a kept `tags` is a
    // kept list of tags, not a kept container of anonymous free text.
    return value.map((entry, index) =>
      redactStructuredJsonValue(
        entry,
        `${path}[${index}]`,
        policy,
        fields,
        keyName,
      ),
    );
  }

  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const safeKey = sanitizeKeyName(key);
      if (safeKey !== key) {
        fields.push({
          path: `${path}.${safeKey}`,
          reason: "json_key_token_like",
          action: "redacted",
        });
        output[safeKey] = redactedShapePlaceholder(entry);
        continue;
      }
      output[safeKey] = redactStructuredJsonValue(
        entry,
        `${path}.${safeKey}`,
        policy,
        fields,
        key,
      );
    }
    return output;
  }

  const classification = classifyStructuredValue(
    value,
    keyName,
    policy.denyFields,
    policy.keepFields,
  );
  if (classification.action === "keep") return value;
  fields.push({ path, reason: classification.reason, action: "redacted" });
  return redactedShapePlaceholder(value);
}

function redactStructuredJsonBody(
  body: string,
  path: string,
  policy: StructuredFieldPolicy,
): BodyRedactionResult {
  const parsed = JSON.parse(body) as unknown;
  const fields: RedactionField[] = [];
  const value = redactStructuredJsonValue(parsed, path, policy, fields);
  const summary = buildSummary(
    "json",
    fields.length > 0 ? "redacted" : "summarized",
    "structured_redaction",
    body.length,
    undefined,
    fields.length,
  );
  return {
    body: JSON.stringify(value),
    bodySummary: summary,
    metadata: {
      policy: BROWSER_REDACTION_POLICY_V2,
      fields,
      summaries: [summary],
      ...(policy.keepFields && policy.keepFields.length > 0
        ? { keep: [...policy.keepFields] }
        : {}),
    },
  };
}

export function redactNetworkTextBody(
  body: string,
  options: BodyRedactionOptions = {},
): BodyRedactionResult {
  const path = options.path ?? "body";
  const contentType = options.contentType ?? "";
  const maxLength = options.maxLength;
  const kind: PayloadSummary["kind"] = isFormContentType(contentType)
    ? "form"
    : isJsonContentType(contentType) || looksLikeJson(body)
      ? "json"
      : "text";

  if (maxLength !== undefined && maxLength >= 0 && body.length > maxLength) {
    const summary = buildSummary(
      kind,
      "summarized",
      "payload_too_large",
      body.length,
      maxLength,
    );
    const metadata = metadataFromField(
      { path, reason: "payload_too_large", action: "summarized" },
      summary,
    );
    return { bodySummary: summary, metadata };
  }

  if (kind === "form") return redactFormBody(body, path);

  if (kind === "json" && options.mode === "structured") {
    // Structured (v2) treatment. Any failure — malformed JSON or an unexpected
    // walker error — falls through to the v1 path below; never throw upward.
    try {
      return redactStructuredJsonBody(body, path, {
        ...(options.denyFields ? { denyFields: options.denyFields } : {}),
        ...(options.keepFields ? { keepFields: options.keepFields } : {}),
      });
    } catch {
      /* fall back to v1 behavior */
    }
  }

  if (kind === "json") {
    try {
      const parsed = JSON.parse(body) as unknown;
      const result = redactJsonValue(parsed, path);
      if (result.fields.length === 0) return { body };

      const summary = buildSummary(
        "json",
        "redacted",
        "sensitive_json_field",
        body.length,
        undefined,
        result.fields.length,
      );
      return {
        body: JSON.stringify(result.value),
        bodySummary: summary,
        metadata: {
          policy: BROWSER_REDACTION_POLICY,
          fields: result.fields,
          summaries: [summary],
        },
      };
    } catch {
      const summary = buildSummary(
        "json",
        "dropped",
        "malformed_json_body",
        body.length,
      );
      const metadata = metadataFromField(
        { path, reason: "malformed_json_body", action: "dropped" },
        summary,
      );
      return { bodySummary: summary, metadata };
    }
  }

  if (isMarkupContentType(contentType)) {
    const markupResult = redactMarkupTextBody(body, path);
    if (markupResult) return markupResult;
  }

  // Free-text: route embedded `http(s)://…` URL substrings through the same
  // key-aware `redactUrl` policy used for `ref.url`, so a short `?token=…` (which
  // the token-shape patterns miss) is scrubbed before the key-value / token pass.
  const urlInTextResult = redactUrlsInText(body, path);
  const urlFields = urlInTextResult.metadata?.fields ?? [];
  const workingBody = urlInTextResult.value;

  const keyValueResult = redactTextKeyValueBody(workingBody, path);
  if (keyValueResult) {
    if (urlFields.length === 0) return keyValueResult;
    const mergedFields = [
      ...urlFields,
      ...(keyValueResult.metadata?.fields ?? []),
    ];
    const summaries = keyValueResult.metadata?.summaries ?? [];
    return {
      ...keyValueResult,
      metadata: {
        policy: BROWSER_REDACTION_POLICY,
        fields: mergedFields,
        ...(summaries.length > 0 ? { summaries } : {}),
      },
    };
  }

  const textResult = redactTokenLikeString(workingBody, path);
  const tokenFields = textResult.metadata?.fields ?? [];
  const allFields = [...urlFields, ...tokenFields];
  if (allFields.length === 0) return { body };

  const reason =
    tokenFields.length > 0 ? "token_like_value" : "url_query_value";
  const summary = buildSummary(
    "text",
    "redacted",
    reason,
    body.length,
    undefined,
    allFields.length,
  );
  return {
    body: textResult.value,
    bodySummary: summary,
    metadata: {
      policy: BROWSER_REDACTION_POLICY,
      fields: allFields,
      summaries: [summary],
    },
  };
}

export function summarizeBinaryPayload(
  contentType: string | null | undefined,
  contentLength: string | null | undefined,
  path = "body",
): BodyRedactionResult {
  const reason = contentType
    ? `binary_payload:${contentType}`
    : "binary_payload";
  const summary = buildSummary(
    "binary",
    "summarized",
    reason,
    undefined,
    undefined,
    undefined,
    contentLength ?? undefined,
  );
  const metadata = metadataFromField(
    { path, reason: "binary_payload", action: "summarized" },
    summary,
  );
  return {
    body: contentLength ? `[bin:${contentLength}]` : "[bin]",
    bodySummary: summary,
    metadata,
  };
}

export function summarizeOmittedPayload(
  reason: "stream_payload" | "body_read_failed" | "non_text_request_body",
  path = "body",
): BodyRedactionResult {
  const kind: PayloadSummary["kind"] =
    reason === "stream_payload" ? "stream" : "unknown";
  const summary = buildSummary(kind, "dropped", reason);
  const metadata = metadataFromField(
    { path, reason, action: "dropped" },
    summary,
  );
  return { bodySummary: summary, metadata };
}

export function redactStorageKey(
  key: string,
  path = "storage.key",
): RedactionResult<string> {
  if (isSensitiveName(key)) {
    return withMetadata(REDACTED_STORAGE_KEY, {
      path,
      reason: "sensitive_storage_key",
      action: "redacted",
    });
  }

  const tokenResult = redactTokenLikeString(key, path);
  if (tokenResult.metadata) {
    return {
      value: REDACTED_STORAGE_KEY,
      metadata: {
        policy: BROWSER_REDACTION_POLICY,
        fields: tokenResult.metadata.fields.map((field) => ({
          ...field,
          reason: "storage_key_token_like",
        })),
      },
    };
  }

  return { value: key };
}

/**
 * What stands in for one identifying segment of a probed storage key. A glob, because the treated
 * key is read as a pattern: `session:*:cart` says a `session:<something>:cart` key exists without
 * saying whose.
 */
export const REDACTED_KEY_SEGMENT = "*";

/** Runs of anything that is not a letter or a digit. These are the key's structure. */
const PROBE_KEY_SEPARATOR_RE = /([^A-Za-z0-9]+)/;

/**
 * An email inside a key, matched without crossing the separators a key is built from, so
 * `session:alice@example.com:cart` yields `alice@example.com` and not `session:alice@example.com`.
 */
const PROBE_KEY_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Longest key treated. Beyond this the tail is dropped rather than walked. */
const PROBE_KEY_MAX_LENGTH = 128;

/** Longest word kept verbatim. A longer run of letters is not a word, it is a value. */
const PROBE_KEY_MAX_WORD_LENGTH = 24;

/**
 * Uppercase letters a kept word may carry. `userPrefs` and `APIKey` pass; `ABCDEFGH`, which is a
 * value wearing a word's clothes, does not.
 */
const PROBE_KEY_MAX_UPPERCASE = 4;

function isPlainKeyWord(span: string): boolean {
  if (span.length === 0 || span.length > PROBE_KEY_MAX_WORD_LENGTH)
    return false;
  if (/[0-9]/.test(span)) return false;
  let uppercase = 0;
  for (let index = 0; index < span.length; index += 1) {
    const code = span.charCodeAt(index);
    if (code >= 65 && code <= 90) uppercase += 1;
  }
  if (uppercase > PROBE_KEY_MAX_UPPERCASE) return false;
  return redactTokenLikeString(span).value === span;
}

/**
 * A storage key on its way out of an *uninvolved* browser.
 *
 * A live probe is answered by whichever application instance polls next, which is not the session
 * an agent is investigating and not a person who has anything to do with the defect. The ordinary
 * storage collector can afford to emit a key verbatim, because it is recording the session that
 * actually hit the bug. A probe cannot, so this is a second, stricter treatment and
 * {@link redactStorageKey} is deliberately left alone.
 *
 * What survives is the key's shape and nothing else: separators verbatim, plain words verbatim, and
 * {@link REDACTED_KEY_SEGMENT} for every span that could name a person or carry a value. An email is
 * removed first, because its local part and domain are otherwise ordinary words. After that a span
 * of letters and digits is judged whole, so `order#A1B2C3` cannot leak `A`, `B` and `C` one letter
 * at a time.
 *
 * The result answers what the probe is for, which is which keys exist, how many, and which patterns
 * they follow, and refuses the part that was never the question. A key from which no word survives
 * is reported as {@link REDACTED_STORAGE_KEY} rather than as a skeleton of punctuation.
 *
 * A key with no separator has no pattern to preserve, so structure preservation buys nothing there
 * and the collector's stricter whole key verdict is kept instead. That is why a bare `refreshToken`
 * is still reported as {@link REDACTED_STORAGE_KEY}.
 *
 * Known limit: a bare given name in a key, as in `cart:alice:items`, is indistinguishable from a
 * route word and is kept. Detecting it would need a name list, and every name list is both wrong
 * and enormous.
 */
export function redactProbeStorageKey(
  key: string,
  path = "storage.key",
): RedactionResult<string> {
  if (key === "") return { value: "" };

  const bounded = key.slice(0, PROBE_KEY_MAX_LENGTH);

  // A key that carries a token shape is a value, not a name, and a value has no pattern worth
  // preserving. Checked over the whole key, so a token spanning several spans is caught too.
  if (redactTokenLikeString(bounded, path).metadata) {
    return withMetadata(REDACTED_STORAGE_KEY, {
      path,
      reason: "storage_key_token_like",
      action: "redacted",
    });
  }

  // Nothing to preserve in a key with no separators, so the collector's stricter verdict stands.
  if (/^[A-Za-z0-9]+$/.test(bounded)) {
    const collectorResult = redactStorageKey(bounded, path);
    if (collectorResult.value !== bounded) return collectorResult;
  }

  PROBE_KEY_EMAIL_RE.lastIndex = 0;
  const withoutEmails = bounded.replace(
    PROBE_KEY_EMAIL_RE,
    REDACTED_KEY_SEGMENT,
  );

  let redactedSpans = withoutEmails === bounded ? 0 : 1;
  let keptWords = 0;

  const treated = withoutEmails
    .split(PROBE_KEY_SEPARATOR_RE)
    .map((part, index) => {
      // `split` with one capture group alternates content, separator, content, ...
      if (index % 2 === 1) return part;
      if (part === "") return part;
      if (isPlainKeyWord(part)) {
        keptWords += 1;
        return part;
      }
      redactedSpans += 1;
      return REDACTED_KEY_SEGMENT;
    })
    .join("");

  if (keptWords === 0) {
    return withMetadata(REDACTED_STORAGE_KEY, {
      path,
      reason: "probe_storage_key",
      action: "redacted",
    });
  }

  if (redactedSpans === 0 && treated === key) return { value: key };

  return withMetadata(treated, {
    path,
    reason: "probe_storage_key_segment",
    action: "redacted",
  });
}

export function redactStoredValue(
  value: string | null | undefined,
  options: StoredValueRedactionOptions = {},
): RedactionResult<string | undefined> {
  if (value == null) return { value: undefined };
  if (value === "") return { value: "" };

  const path = options.path ?? "storage.value";
  const reason =
    options.maxLength !== undefined && value.length > options.maxLength
      ? "storage_value_too_large"
      : options.key && isSensitiveName(options.key)
        ? "sensitive_storage_value"
        : "storage_value";
  const summary = buildSummary(
    "storage",
    "redacted",
    reason,
    value.length,
    options.maxLength,
  );

  return withMetadata(
    REDACTED_VALUE,
    { path, reason, action: "redacted" },
    summary,
  );
}

/**
 * The number a text field is carrying, or the text itself.
 *
 * Anywhere a value arrives as text - a form input, a query parameter, a form-encoded body - a number
 * the user or the application meant arrives as a string. `0.29` is not enum-shaped, because the dot
 * is not in the enum alphabet, so the deny-biased classifier reads it as free prose and deletes it.
 * That silently removed every price, rate, weight, percentage and decimal quantity from the text
 * planes while keeping the identical value in a JSON body, and the disagreement between the two is
 * exactly what a filter or rounding defect lives in.
 *
 * Converted only on an exact round trip, so `0123` (a padded code) and `1e5` stay text and are
 * judged as text. Everything the classifier does to a number still applies, including the Luhn check
 * that catches a card number typed into a plain field.
 */
function asNumberIfNumeric(value: string): string | number {
  if (value.trim() !== value) return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || String(parsed) !== value) return value;
  return parsed;
}

export function redactInputValue(
  value: string,
  options: InputValueRedactionOptions = {},
): RedactionResult<string> {
  if (value === "") return { value: "" };

  const path = options.path ?? "input.value";
  const type = options.type?.toLowerCase();
  const keepFields = getRedactionKeepFields();

  // The deployment-level opt-out, checked before anything reads the value or its field name.
  if (!getCaptureInputValues()) {
    return redactedInput(value, path, "input_value");
  }

  // A credential input is redacted on its type alone, before anything looks at what was typed. No
  // field name and no application setting reaches this, because the one thing worse than losing a
  // field is publishing a password because someone named it `note`.
  if (type === "password" || type === "email" || type === "tel") {
    return redactedInput(value, path, "sensitive_input_value");
  }

  // The caller's own masking decision, which is the only place `maskInputTypes`
  // is visible. It settles before the classifier runs, because a deployment
  // that listed `number` did so to stop a 2FA code being recorded, and the
  // classifier keeps a number.
  if (options.maskedByPolicy) {
    return redactedInput(value, path, "masked_input_type");
  }

  // A field the built-in heuristics call sensitive - `ssn`, `cvv`, `dob` - is redacted on the name.
  // An application-declared keep overrides that here for the same reason it does in a request body:
  // those heuristics match by substring and have real false positives.
  if (
    isSensitiveName(options.name) &&
    !isStructuredKeepName(options.name, keepFields)
  ) {
    return redactedInput(value, path, "sensitive_input_value");
  }

  // What is left goes through the same deny-biased classifier as a value in a request body. Numbers
  // and short enum-like strings survive; free prose, emails, JWTs, card numbers, IBANs and
  // high-entropy strings do not, whatever field they were typed into.
  //
  // Recording nothing at all was the safer-looking default and it cost real answers: a shopper types
  // a price ceiling of 0.29, the request carries 28, and a capture holding only one of those two
  // numbers cannot show the defect that sits between them. The value is what the classifier already
  // keeps everywhere else in this SDK; there is no reason the same "250" is evidence in a query
  // string and a secret in the box the user typed it into.
  const classification = classifyStructuredValue(
    asNumberIfNumeric(value),
    options.name,
    undefined,
    keepFields,
  );
  if (classification.action === "keep") return { value };

  return redactedInput(value, path, classification.reason ?? "input_value");
}

function redactedInput(
  value: string,
  path: string,
  reason: string,
): RedactionResult<string> {
  return withMetadata(
    REDACTED_VALUE,
    { path, reason, action: "redacted" },
    buildSummary("input", "redacted", reason, value.length),
  );
}
