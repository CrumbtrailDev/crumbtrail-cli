import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeBindingClient,
  RUNTIME_BINDING_ROTATE_AHEAD_MS,
} from "../runtime-binding";
import { HttpTransport } from "../transports/http";
import { Crumbtrail } from "../crumbtrail";

const ENDPOINT = "https://capture.example";
const NOW = Date.parse("2026-09-02T12:00:00.000Z");

function binding(expiresAt: number, suffix = "a") {
  return {
    instanceId: `ri_runtime_${suffix}`,
    instanceProof: `proof_${suffix}_${"x".repeat(40)}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

function response(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

afterEach(() => vi.restoreAllMocks());

describe("runtime binding client", () => {
  it("registers once, reuses the binding, and keeps proof private to the HTTP seam", async () => {
    const first = binding(NOW + 24 * 60 * 60 * 1000, "one");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(first, 201))
      .mockResolvedValue(response({ ok: true }));
    const client = createRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-key",
      fetchImpl: fetcher,
      now: () => NOW,
    });

    const result = await client.getBinding();
    expect(result).toEqual(first);
    expect(await client.getBinding()).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      "/api/runtime/register?projectKey=project-key",
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("rotates before expiry and atomically replaces only after success", async () => {
    let now = NOW;
    const first = binding(NOW + 2 * RUNTIME_BINDING_ROTATE_AHEAD_MS, "one");
    const next = binding(NOW + 2 * 24 * 60 * 60 * 1000, "two");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(first, 201))
      .mockResolvedValueOnce(response(next, 200));
    const client = createRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-key",
      fetchImpl: fetcher,
      now: () => now,
    });

    await expect(client.getBinding()).resolves.toEqual(first);
    now = NOW + RUNTIME_BINDING_ROTATE_AHEAD_MS + 1;
    await expect(client.getBinding()).resolves.toEqual(next);
    const rotation = String(fetcher.mock.calls[1]?.[0]);
    expect(rotation).toContain(`instanceId=${first.instanceId}`);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      headers: { Authorization: `Bearer ${first.instanceProof}` },
    });
  });

  it("honors a bounded Retry After without entering a registration loop", async () => {
    let now = NOW;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({ code: "rate_limited" }, 429, { "Retry-After": "120" }),
      )
      .mockResolvedValueOnce(response(binding(NOW + 86_400_000), 201));
    const client = createRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-key",
      fetchImpl: fetcher,
      now: () => now,
    });

    await expect(client.getBinding()).resolves.toBeUndefined();
    await expect(client.getBinding()).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 120_001;
    await expect(client.getBinding()).resolves.toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("falls back after failed registration and isolates projects", async () => {
    const failed = vi.fn().mockResolvedValue(response({ ok: false }, 503));
    const clientA = createRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-a",
      fetchImpl: failed,
      now: () => NOW,
    });
    const clientB = createRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-b",
      fetchImpl: vi
        .fn()
        .mockResolvedValue(response(binding(NOW + 86_400_000), 201)),
      now: () => NOW,
    });

    await expect(clientA.getBinding()).resolves.toBeUndefined();
    await expect(clientB.getBinding()).resolves.toMatchObject({
      instanceId: expect.stringContaining("ri_runtime"),
    });
    expect(String(failed.mock.calls[0]?.[0])).toContain("project-a");
  });

  it("clears the private binding on stop", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(response(binding(NOW + 86_400_000), 201));
    const client = createRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-key",
      fetchImpl: fetcher,
      now: () => NOW,
    });
    await client.getBinding();
    client.stop();
    await expect(client.getBinding()).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("HttpTransport runtime binding seam", () => {
  it("sends top level session identity and proof without putting it in metadata", async () => {
    const first = binding(NOW + 86_400_000);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(first, 201))
      .mockResolvedValue(response({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    const client = createRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-key",
      fetchImpl: fetcher,
      now: () => NOW,
    });
    const transport = new HttpTransport(ENDPOINT, {
      authToken: "project-key",
      runtimeBinding: client,
    });

    await transport.startSession("ses_test", { service: "web" });
    const start = fetcher.mock.calls.find((call) =>
      String(call[0]).endsWith("/api/session/start"),
    );
    expect(start).toBeDefined();
    const payload = JSON.parse(String(start?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      sessionId: "ses_test",
      instanceId: first.instanceId,
      instanceProof: first.instanceProof,
      metadata: { service: "web" },
    });
    expect((payload.metadata as Record<string, unknown>).instanceProof).toBe(
      undefined,
    );
  });

  it("uses the same binding for session start and config polling", async () => {
    const first = binding(NOW + 86_400_000);
    const fetcher = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/runtime/register")) return response(first, 201);
        if (url.includes("/api/capture-config"))
          return response({ killSwitch: false, maskingMode: "mask_all" });
        return response({ ok: true });
      },
    );
    vi.stubGlobal("fetch", fetcher);
    const logger = Crumbtrail.init({
      httpEndpoint: ENDPOINT,
      httpAuthToken: "project-key",
      remoteConfig: true,
      console: false,
      network: false,
      interactions: false,
      keystrokes: false,
      scroll: false,
      visibility: false,
      clipboard: false,
      errors: false,
      performance: false,
      cookies: false,
      storage: false,
      environment: false,
      heartbeat: false,
      uiNumbers: false,
      listeners: false,
      eventSource: false,
      webSocket: false,
      workers: false,
      domSnapshot: false,
      widget: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
      configPollIntervalMs: 100_000,
      sessionPersistence: "memory",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const poll = fetcher.mock.calls.find((call) =>
      String(call[0]).includes("/api/capture-config"),
    );
    expect(String(poll?.[0])).toContain(`instanceId=${first.instanceId}`);
    expect(poll?.[1]).toMatchObject({
      headers: { Authorization: `Bearer ${first.instanceProof}` },
    });
    const start = fetcher.mock.calls.find((call) =>
      String(call[0]).endsWith("/api/session/start"),
    );
    expect(JSON.parse(String(start?.[1]?.body))).toMatchObject({
      instanceId: first.instanceId,
      instanceProof: first.instanceProof,
    });
    await logger.stop();
  });
});
