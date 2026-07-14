import type { BugEvent } from "crumbtrail-core";

export interface HeadlessSessionOptions {
  endpoint: string;
  sessionId: string;
  metadata?: Record<string, unknown>;
  authToken?: string;
  fetchImpl?: typeof fetch;
}

export interface HeadlessSession {
  sessionId: string;
  record(events: BugEvent | BugEvent[]): Promise<void>;
  end(): Promise<Record<string, unknown>>;
}

export async function startHeadlessSession(
  options: HeadlessSessionOptions,
): Promise<HeadlessSession> {
  const fetcher = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint.replace(/\/+$/, "");
  const headers = buildHeaders(options.authToken);
  await postJson(fetcher, `${endpoint}/api/session/start`, headers, {
    sessionId: options.sessionId,
    metadata: {
      ...options.metadata,
      source: "headless",
    },
  });

  return {
    sessionId: options.sessionId,
    async record(events) {
      const batch = Array.isArray(events) ? events : [events];
      await postJson(fetcher, `${endpoint}/api/events`, headers, {
        sessionId: options.sessionId,
        events: batch,
      });
    },
    async end() {
      return postJson(fetcher, `${endpoint}/api/session/end`, headers, {
        sessionId: options.sessionId,
      });
    },
  };
}

function buildHeaders(authToken: string | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(authToken ? { "x-crumbtrail-auth": authToken } : {}),
  };
}

async function postJson(
  fetcher: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetcher(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? (JSON.parse(text) as unknown) : {};
  } catch {
    parsed = { error: text || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    const message =
      isRecord(parsed) && typeof parsed.error === "string"
        ? parsed.error
        : `HTTP ${response.status}`;
    throw new Error(`Crumbtrail headless session request failed: ${message}`);
  }
  return isRecord(parsed) ? parsed : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
