export const BROWSER_REDACTION_POLICY = "crumbtrail.browser-redaction.v1";
/**
 * Structure-preserving network-body redaction. Emitted only on JSON bodies that
 * went through the v2 per-value classifier; every other capture plane (storage,
 * console, cookies, inputs, headers, URLs) stays on the v1 policy tag.
 */
export const BROWSER_REDACTION_POLICY_V2 = "crumbtrail.browser-redaction.v2";
export type BrowserRedactionPolicy =
  | typeof BROWSER_REDACTION_POLICY
  | typeof BROWSER_REDACTION_POLICY_V2;
export const REDACTED_VALUE = "[REDACTED]";
export const REDACTED_STORAGE_KEY = "[REDACTED_KEY]";

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
   * "structured": JSON bodies ≤ {@link STRUCTURED_BODY_MAX_BYTES} go through the
   * v2 per-value classifier (structure preserved, sensitive values replaced with
   * `[REDACTED]` + shape metadata, policy tag bumped to v2). "full" (default at
   * this layer) keeps the v1 whole-body behavior exactly.
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

export interface StoredValueRedactionOptions {
  key?: string;
  maxLength?: number;
  path?: string;
}

export interface InputValueRedactionOptions {
  name?: string;
  type?: string;
  path?: string;
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

const TOKEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
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
  { pattern: /\b[A-Fa-f0-9]{32,}\b/g, reason: "long_hex_token" },
  { pattern: /\b[A-Za-z0-9_-]{40,}\b/g, reason: "long_token_like_string" },
];
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
): RedactionResult<string> {
  let output = value;
  const fields: RedactionField[] = [];

  for (const { pattern, reason } of TOKEN_PATTERNS) {
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
    // application-declared keep list as a JSON key. `?q=[REDACTED]` on a search
    // defect erases the one input that explains it. Values still go through the
    // classifier, so only a value that survives every check is kept.
    const kept = isStructuredKeepName(key, keepFields);
    for (const value of values) {
      if (value === "") {
        params.append(safeKey, "");
      } else if (
        kept &&
        classifyStructuredValue(value, key, undefined, keepFields).action ===
          "keep"
      ) {
        params.append(safeKey, value);
      } else {
        params.append(safeKey, REDACTED_VALUE);
        fields.push({
          path: `${path}.query.${safeKey}`,
          reason: "url_query_value",
          action: "redacted",
        });
      }
    }
  }

  const serialized = params.toString();
  const metadata = metadataFromFields(fields);

  return {
    value: serialized ? `?${serialized}` : "",
    ...(metadata ? { metadata } : {}),
  };
}

function sanitizeKeyName(key: string): string {
  return redactTokenLikeString(key).value === key ? key : REDACTED_KEY;
}

function uniqueOutputKey(key: string, output: Record<string, unknown>): string {
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
      : encodeURIComponent(subResult.value);
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
 * all-lowercase alphabetic words with no digits, no separators and no
 * mixed case survive. Anything with entropy — a token, a hash, an id, a JWT, a
 * base64 fragment, a uuid — fails at least one of those and is still redacted.
 */
const PLAIN_ROUTE_WORD_RE = /^[a-z]{2,16}$/;

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
    PLAIN_ROUTE_WORD_RE.test(component)
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
  return /^[A-Za-z0-9_-]{16,39}$/.test(segment) && /[A-Z0-9_-]/.test(segment);
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
        : redactTokenLikeString(rawValue, `${path}.${outputName}`);
    output[outputName] = valueResult.value;
    if (valueResult.metadata) fields.push(...valueResult.metadata.fields);
  }

  const metadata = metadataFromFields(fields);

  return { value: output, ...(metadata ? { metadata } : {}) };
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
    const safeName = sanitizeKeyName(name);
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
    return { value: Number.isFinite(time) ? value.toISOString() : null, fields: [] };
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

/** JSON bodies above this size skip the structured walk and keep v1 behavior. */
export const STRUCTURED_BODY_MAX_BYTES = 16_384;

export type RedactedShapeCharset = "alpha" | "num" | "alnum" | "mixed";

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
  hash8?: string;
  /**
   * Session-salted fingerprint of the lowercase value. Present only when case
   * folding changes a sufficiently high-entropy string, so consumers can spot
   * case-only identity collisions without learning or recovering the value.
   */
  casefoldHash8?: string;
}

export type StructuredClassification =
  | { action: "keep" }
  | { action: "redact"; reason: string };

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
  denyFields?: string[],
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

function isHighEntropyString(value: string): boolean {
  if (value.length < 24 || /\s/.test(value)) return false;
  return shannonEntropyBitsPerChar(value) >= 3.5;
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

/**
 * Shape metadata for a redacted value — length, charset class, and a salted
 * one-way hash. The hash is omitted for low-entropy values whose candidate
 * space is trivially enumerable (numeric with len < 12, or any len < 6).
 */
export function computeRedactedShape(value: unknown): RedactedValueShape {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  const charset: RedactedShapeCharset = /^[A-Za-z]+$/.test(text)
    ? "alpha"
    : /^[0-9]+$/.test(text)
      ? "num"
      : /^[A-Za-z0-9]+$/.test(text)
        ? "alnum"
        : "mixed";
  const shape: RedactedValueShape = { len: text.length, charset };
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
  if (value === null || typeof value === "boolean")
    return { action: "keep" };
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
  return { action: "redact", reason: "free_text_value" };
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
  if (shape.hash8 !== undefined) placeholder.hash8 = shape.hash8;
  if (shape.casefoldHash8 !== undefined)
    placeholder.casefoldHash8 = shape.casefoldHash8;
  return placeholder;
}

const PLACEHOLDER_KEYS = new Set([
  "$redacted",
  "len",
  "charset",
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
 * of the five this module emits, `$redacted` must be the literal marker, `len`
 * a finite number, and the hashes 8 hex digits. Nothing that shape can carry a
 * secret, so treating it as already-redacted grants a caller nothing.
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

  if (
    kind === "json" &&
    options.mode === "structured" &&
    body.length <= STRUCTURED_BODY_MAX_BYTES
  ) {
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

export function redactInputValue(
  value: string,
  options: InputValueRedactionOptions = {},
): RedactionResult<string> {
  if (value === "") return { value: "" };

  const path = options.path ?? "input.value";
  const type = options.type?.toLowerCase();
  const keepFields = getRedactionKeepFields();

  // A credential input is redacted on its type alone, before anything looks at what was typed. No
  // field name and no application setting reaches this, because the one thing worse than losing a
  // field is publishing a password because someone named it `note`.
  if (type === "password" || type === "email" || type === "tel") {
    return redactedInput(value, path, "sensitive_input_value");
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
    value,
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
