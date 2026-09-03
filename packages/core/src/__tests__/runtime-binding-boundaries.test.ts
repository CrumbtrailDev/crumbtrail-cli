import { afterEach, expect, it, vi } from "vitest";
import { createRuntimeBindingHandle } from "../runtime-binding";
import { startHeadlessSession } from "../serverless/http-transport";
import { HttpTransport } from "../transports/http";
import type { BugEvent } from "../types";

const endpoint = "https://capture.example/base";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([
  { endpoint: "https://other.example/base", authToken: "key" },
  { endpoint: "https://capture.example/other", authToken: "key" },
  { endpoint, authToken: "other-key" },
])("rejects a handle outside its endpoint and project scope: %j", async (target) => {
  const fetcher = vi.fn();
  const runtimeBinding = createRuntimeBindingHandle({ endpoint, projectKey: "key", fetchImpl: fetcher });
  await expect(startHeadlessSession({ ...target, sessionId: "session", runtimeBinding, fetchImpl: fetcher }))
    .rejects.toThrow("does not match");
  expect(fetcher).not.toHaveBeenCalled();
});

it("does not register for an already cancelled caller", async () => {
  const fetcher = vi.fn();
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(startHeadlessSession({ endpoint, authToken: "key", sessionId: "session", fetchImpl: fetcher, signal: controller.signal }))
    .rejects.toThrow("cancelled");
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(["timeout", "abort"])("bounds shared registration on %s without cancelling another caller", async (mode) => {
  vi.useFakeTimers();
  let resolveRegistration!: (value: Response) => void;
  let registrationSignal: AbortSignal | undefined;
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("runtime/register")) {
      registrationSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { resolveRegistration = resolve; });
    }
    return new Response("{}");
  });
  const runtimeBinding = createRuntimeBindingHandle({ endpoint, projectKey: "key", fetchImpl: fetcher });
  const controller = new AbortController();
  const options = { endpoint, authToken: "key", runtimeBinding, fetchImpl: fetcher };
  const short = startHeadlessSession({ ...options, sessionId: "short", timeoutMs: 20, signal: controller.signal });
  const failure = expect(short).rejects.toThrow(mode === "timeout" ? "timed out" : "cancelled");
  const other = startHeadlessSession({ ...options, sessionId: "other", timeoutMs: 1000 });
  await vi.advanceTimersByTimeAsync(0);
  if (mode === "abort") controller.abort(new Error("cancelled"));
  else await vi.advanceTimersByTimeAsync(20);
  await failure;
  expect(registrationSignal?.aborted).toBe(false);
  resolveRegistration(new Response(JSON.stringify({ instanceId: "ri_instance_123", instanceProof: "x".repeat(40), expiresAt: new Date(Date.now() + 86400000).toISOString() })));
  await other;
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes("session/start"))).toHaveLength(1);
  expect(fetcher.mock.calls.find(([url]) => String(url).includes("session/start"))?.[1]?.body).toContain('"sessionId":"other"');
});

it.each([401, 402, 429])("preserves refused session HTTP %s in event delivery", async (status) => {
  const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status }));
  vi.stubGlobal("fetch", fetcher);
  const transport = new HttpTransport(endpoint, { authToken: "key" });
  await expect(transport.startSession("session", {})).rejects.toMatchObject({ status });
  await expect(transport.sendEvents([{ t: 1, k: "console", d: {} } as BugEvent])).rejects.toMatchObject({ status });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
