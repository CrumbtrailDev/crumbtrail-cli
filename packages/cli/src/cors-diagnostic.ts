import { CORRELATION_REQUEST_HEADERS } from "./inject/text";

export const CORS_DIAGNOSTIC_TIMEOUT_MS = 5_000;
export const CORS_REQUEST_METHOD = "POST";
export const CORS_REQUIRED_HEADERS = [
  ...CORRELATION_REQUEST_HEADERS,
  "authorization",
  "x-crumbtrail-auth",
] as const;

export type CorsDiagnosticStatus = "pass" | "fail" | "unknown" | "not-applicable";
export type CorsNetworkCategory =
  | "http"
  | "redirect"
  | "timeout"
  | "dns"
  | "tls"
  | "network"
  | "opaque"
  | "not-applicable";

export interface CorsDiagnosticResult {
  status: CorsDiagnosticStatus;
  endpoint: string;
  origin?: string;
  category: CorsNetworkCategory;
  responseStatus?: number;
  missingHeaders: string[];
  missingMethod?: string;
  reason: string;
  nextStep: string;
}

export interface CorsDiagnosticOptions {
  endpoint: string;
  origin?: string;
  applicable: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const nextStep =
  "Configure the endpoint's CORS middleware to allow this origin, POST, and the listed headers. Do not use a wildcard for credentialed requests.";

function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

function headerValues(response: Response, name: string): string[] {
  return (response.headers.get(name) ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function networkCategory(error: unknown, timedOut: boolean): CorsNetworkCategory {
  if (timedOut) return "timeout";
  const value = error as { code?: string; cause?: { code?: string } };
  const code = value?.code ?? value?.cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (typeof code === "string" && /CERT|TLS|SSL/.test(code)) return "tls";
  return "network";
}

/**
 * Read-only browser preflight approximation. It deliberately sends no key or
 * proof: CORS decisions are made from Origin and requested header names.
 */
export async function diagnoseCors(
  opts: CorsDiagnosticOptions,
): Promise<CorsDiagnosticResult> {
  if (!opts.applicable) {
    return {
      status: "not-applicable",
      endpoint: opts.endpoint,
      category: "not-applicable",
      missingHeaders: [],
      reason: "This project does not run in a browser.",
      nextStep: "No browser CORS check is needed.",
    };
  }
  if (!opts.origin) {
    return {
      status: "unknown",
      endpoint: opts.endpoint,
      category: "network",
      missingHeaders: [],
      reason: "Application origin is not configured, so CORS cannot be verified.",
      nextStep: "Set the application's public origin, then run `crumbtrail doctor` again.",
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? CORS_DIAGNOSTIC_TIMEOUT_MS);
  try {
    const response = await (opts.fetchImpl ?? fetch)(opts.endpoint, {
      method: "OPTIONS",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Origin: opts.origin,
        "Access-Control-Request-Method": CORS_REQUEST_METHOD,
        "Access-Control-Request-Headers": CORS_REQUIRED_HEADERS.join(", "),
      },
    });
    if (response.type === "opaque") {
      return {
        status: "unknown", endpoint: opts.endpoint, origin: opts.origin,
        category: "opaque", missingHeaders: [],
        reason: "Opaque preflight response cannot be verified.", nextStep,
      };
    }
    if (response.status >= 300 && response.status < 400) {
      return {
        status: "fail", endpoint: opts.endpoint, origin: opts.origin,
        category: "redirect", responseStatus: response.status, missingHeaders: [],
        reason: `Preflight received ${statusClass(response.status)} (HTTP ${response.status}) redirect.`, nextStep,
      };
    }
    const allowedOrigin = response.headers.get("access-control-allow-origin");
    const allowsOrigin = allowedOrigin === opts.origin;
    const methods = headerValues(response, "access-control-allow-methods");
    const headers = headerValues(response, "access-control-allow-headers");
    const credentialed = response.headers.get("access-control-allow-credentials")?.toLowerCase() === "true";
    const missingHeaders = CORS_REQUIRED_HEADERS.filter((header) => !headers.includes(header));
    const missingMethod = methods.includes(CORS_REQUEST_METHOD.toLowerCase()) ? undefined : CORS_REQUEST_METHOD;
    const validStatus = response.status >= 200 && response.status < 300;
    if (validStatus && allowsOrigin && credentialed && !missingMethod && missingHeaders.length === 0) {
      return {
        status: "pass", endpoint: opts.endpoint, origin: opts.origin, category: "http",
        responseStatus: response.status, missingHeaders: [],
        reason: `Preflight allowed ${opts.origin} (HTTP ${response.status}).`, nextStep: "No CORS change is needed.",
      };
    }
    const failures = [
      !validStatus ? `response ${statusClass(response.status)} (HTTP ${response.status})` : "",
      !allowsOrigin ? `origin ${opts.origin} is not explicitly allowed` : "",
      !credentialed ? "credentialed requests are not allowed" : "",
      missingMethod ? `missing allowed method ${missingMethod}` : "",
      missingHeaders.length ? `missing allowed headers ${missingHeaders.join(", ")}` : "",
    ].filter(Boolean);
    return {
      status: "fail", endpoint: opts.endpoint, origin: opts.origin, category: "http",
      responseStatus: response.status, missingHeaders, missingMethod,
      reason: failures.join("; ") + ".", nextStep,
    };
  } catch (error) {
    const category = networkCategory(error, timedOut);
    return {
      status: "unknown", endpoint: opts.endpoint, origin: opts.origin, category,
      missingHeaders: [],
      reason: `Preflight could not reach the endpoint (${category}).`, nextStep,
    };
  } finally {
    clearTimeout(timer);
  }
}
