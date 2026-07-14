import { useEffect, useRef } from "react";

export interface BugStateLogger {
  registerStateProvider(name: string, provider: () => unknown): () => void;
}

export interface UseBugStateOptions {
  captureRawState?: boolean;
}

const REDACTED_VALUE = "[REDACTED]";
const SENSITIVE_NAME_RE =
  /(^|[^a-z0-9])(access[-_]?token|api[-_]?key|auth|authorization|bearer|card[-_]?number|client[-_]?secret|cookie|credential(s)?|creds|csrf|cvv|cvc|id[-_]?token|jsessionid|jwt|mfa|otp|pass[-_]?phrase|pass(code|word)?|passwd|password[-_]?confirmation|pin|private[-_]?key|pwd|refresh[-_]?token|secret|security[-_]?code|session|session[-_]?id|sid|ssn|token|verification[-_]?code|xsrf)([^a-z0-9]|$)/i;
const PII_NAME_RE =
  /(^|[^a-z0-9])(email|phone|address|dob|birthdate|postal|zip)([^a-z0-9]|$)/i;
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
const TOKEN_RE =
  /\b(?:Bearer|Token|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|(?:sk|pk|rk|ghp|gho|ghu|ghs|glpat|xox[baprs])[-_][A-Za-z0-9_.=-]{12,}|\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9_-]{40,}\b/gi;
const JSON_LIKE_KEY_RE = /["']?([A-Za-z0-9_.-]{1,120})["']?\s*:/g;

function isSensitiveName(name: string): boolean {
  const normalized = name.replace(/([a-z])([A-Z])/g, "$1_$2");
  const compact = normalized.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    SENSITIVE_NAME_RE.test(name) ||
    PII_NAME_RE.test(name) ||
    SENSITIVE_NAME_RE.test(normalized) ||
    PII_NAME_RE.test(normalized) ||
    SENSITIVE_COMPACT_NAMES.has(compact) ||
    SENSITIVE_COMPACT_SUFFIXES.some(
      (suffix) => compact.length > suffix.length && compact.endsWith(suffix),
    )
  );
}

function redactJsonLikeString(value: string): string | undefined {
  const trimmed = value.trim();
  if (!/[{[]/.test(value)) return undefined;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return JSON.stringify(redactReactSnapshot(parsed));
    } catch {
      // Fall through to conservative malformed JSON-like detection below.
    }
  }

  JSON_LIKE_KEY_RE.lastIndex = 0;
  for (const match of value.matchAll(JSON_LIKE_KEY_RE)) {
    const key = match[1];
    if (key && isSensitiveName(key)) return REDACTED_VALUE;
  }
  return undefined;
}

export function redactReactSnapshot(value: unknown, keyName?: string): unknown {
  if (keyName && isSensitiveName(keyName)) return REDACTED_VALUE;
  if (typeof value === "string") {
    const jsonLike = redactJsonLikeString(value);
    if (jsonLike !== undefined) return jsonLike;

    if (/^\s*[^:=\n\r]{1,120}\s*[:=]/.test(value)) {
      return value.replace(
        /^(\s*[^:=\n\r]{1,120}\s*[:=]).*$/s,
        (_match, key: string) => {
          return isSensitiveName(key)
            ? `${key}${REDACTED_VALUE}`
            : value.replace(TOKEN_RE, REDACTED_VALUE);
        },
      );
    }
    return value.replace(TOKEN_RE, REDACTED_VALUE);
  }
  if (Array.isArray(value))
    return value.map((entry) => redactReactSnapshot(entry));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      output[key] = redactReactSnapshot(entry, key);
    }
    return output;
  }
  return value;
}

export function useBugState(
  logger: BugStateLogger | null | undefined,
  name: string,
  value: unknown,
  options: UseBugStateOptions = {},
): void {
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (!logger || typeof logger.registerStateProvider !== "function") return;
    return logger.registerStateProvider(name, () =>
      options.captureRawState
        ? valueRef.current
        : redactReactSnapshot(valueRef.current),
    );
  }, [logger, name, options.captureRawState]);
}
