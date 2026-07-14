export const BROWSER_REDACTION_POLICY = "crumbtrail.browser-redaction.v1";
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
  policy: typeof BROWSER_REDACTION_POLICY;
  fields: RedactionField[];
  summaries?: PayloadSummary[];
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

export interface BodyRedactionOptions {
  contentType?: string | null;
  maxLength?: number;
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

  for (const item of items) {
    if (!item) continue;
    fields.push(...item.fields);
    if (item.summaries) summaries.push(...item.summaries);
  }

  if (fields.length === 0 && summaries.length === 0) return undefined;

  return {
    policy: BROWSER_REDACTION_POLICY,
    fields,
    ...(summaries.length > 0 ? { summaries } : {}),
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

function redactUrlPathComponent(
  component: string,
  previous: string,
  path: string,
): RedactionResult<string> & { lastToken?: string } {
  const fields: RedactionField[] = [];
  let lastToken = previous;
  if (
    (SENSITIVE_PATH_PRECEDERS.has(previous) || isSensitiveName(previous)) &&
    component.length > 0
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
    segment.length <= 256
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
  const reason =
    type === "password" ||
    type === "email" ||
    type === "tel" ||
    type === "search" ||
    isSensitiveName(options.name)
      ? "sensitive_input_value"
      : "input_value";
  const summary = buildSummary("input", "redacted", reason, value.length);

  return withMetadata(
    REDACTED_VALUE,
    { path, reason, action: "redacted" },
    summary,
  );
}
