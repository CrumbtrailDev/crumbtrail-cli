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
const TOKEN_RE =
  /\b(?:Bearer|Token|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|(?:sk|pk|rk|ghp|gho|ghu|ghs|glpat|xox[baprs])[-_][A-Za-z0-9_.=-]{12,}|\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9_-]{40,}\b/gi;

function isSensitiveName(name: string): boolean {
  const normalized = name.replace(/([a-z])([A-Z])/g, "$1_$2");
  return SENSITIVE_NAME_RE.test(name) || SENSITIVE_NAME_RE.test(normalized);
}

export function redactReactNativeSnapshot(
  value: unknown,
  keyName?: string,
): unknown {
  if (keyName && isSensitiveName(keyName)) return REDACTED_VALUE;
  if (typeof value === "string") {
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
    return value.map((entry) => redactReactNativeSnapshot(entry));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      output[key] = redactReactNativeSnapshot(entry, key);
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
        : redactReactNativeSnapshot(valueRef.current),
    );
  }, [logger, name, options.captureRawState]);
}
