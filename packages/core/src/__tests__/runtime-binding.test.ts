import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetRuntimeBindingCacheForTests,
  createRuntimeBindingClient,
  createRuntimeBindingHandle,
  getCachedRuntimeBindingClient,
  RUNTIME_BINDING_CACHE_MAX_ENTRIES,
  RUNTIME_BINDING_CACHE_TTL_MS,
  RUNTIME_BINDING_MAX_PENDING_RETIREMENTS,
  RUNTIME_BINDING_ROTATE_AHEAD_MS,
} from "../runtime-binding";
import { HttpTransport } from "../transports/http";
import { Crumbtrail, REMOTE_POLICY_TIMEOUT_MS } from "../crumbtrail";
import { runServerlessInvocation } from "../serverless";

const ENDPOINT = "https://capture.example";
const NOW = Date.parse("2026-09-02T12:00:00.000Z");

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

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

afterEach(() => {
  __resetRuntimeBindingCacheForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

  it("bounds the complete registration response and revokes a late body privately", async () => {
    vi.useFakeTimers();
    const body = deferred<unknown>();
    const first = binding(NOW + 86_400_000, "late-body");
    const fetcher = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "DELETE")
          return Promise.resolve(response({ ok: true }));
        return Promise.resolve({
          ok: true,
          status: 201,
          headers: new Headers(),
          json: () => body.promise,
        } as Response);
      },
    );
    const client = createRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-key",
      fetchImpl: fetcher,
      now: () => NOW,
    });

    const registration = client.getBinding();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3_001);
    await expect(registration).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);

    body.resolve(first);
    for (let index = 0; index < 6; index += 1) await Promise.resolve();

    const revoke = fetcher.mock.calls[1];
    expect(revoke?.[1]).toMatchObject({
      method: "DELETE",
      headers: { Authorization: `Bearer ${first.instanceProof}` },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("holds same-key restart behind a late response DELETE after timeout", async () => {
    vi.useFakeTimers();
    const late = binding(NOW + 2 * 86_400_000, "late-response");
    const fresh = binding(NOW + 3 * 86_400_000, "fresh-response");
    const pendingResponse = deferred<Response>();
    const pendingDelete = deferred<Response>();
    const operations: string[] = [];
    let postCount = 0;
    const fetcher = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          operations.push("DELETE");
          return pendingDelete.promise;
        }
        postCount += 1;
        operations.push(`POST:${postCount}`);
        return postCount === 1
          ? pendingResponse.promise
          : Promise.resolve(response(fresh, 201));
      },
    );
    const first = createRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-key",
      fetchImpl: fetcher,
      now: () => NOW,
    });
    const firstRegistration = first.getBinding();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3_001);
    await expect(firstRegistration).resolves.toBeUndefined();

    first.stop();
    const second = createRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-key",
      fetchImpl: fetcher,
      now: () => NOW,
      ready: first.getRetirement(),
    });
    const secondRegistration = second.getBinding();
    await Promise.resolve();
    expect(postCount).toBe(1);

    pendingResponse.resolve(response(late, 201));
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    expect(operations).toEqual(["POST:1", "DELETE"]);
    expect(postCount).toBe(1);

    pendingDelete.resolve(response({ ok: true }));
    await expect(secondRegistration).resolves.toEqual(fresh);
    expect(operations).toEqual(["POST:1", "DELETE", "POST:2"]);
  });

  it("holds same-key restart behind a late body DELETE after stop", async () => {
    vi.useFakeTimers();
    const late = binding(NOW + 2 * 86_400_000, "late-body-stop");
    const fresh = binding(NOW + 3 * 86_400_000, "fresh-body-stop");
    const pendingBody = deferred<unknown>();
    const pendingDelete = deferred<Response>();
    const operations: string[] = [];
    let postCount = 0;
    const fetcher = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          operations.push("DELETE");
          return pendingDelete.promise;
        }
        postCount += 1;
        operations.push(`POST:${postCount}`);
        if (postCount === 1)
          return Promise.resolve({
            ok: true,
            status: 201,
            headers: new Headers(),
            json: () => pendingBody.promise,
          } as Response);
        return Promise.resolve(response(fresh, 201));
      },
    );
    const first = createRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-key",
      fetchImpl: fetcher,
      now: () => NOW,
    });
    const firstRegistration = first.getBinding();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3_001);
    await expect(firstRegistration).resolves.toBeUndefined();

    first.stop();
    const second = createRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-key",
      fetchImpl: fetcher,
      now: () => NOW,
      ready: first.getRetirement(),
    });
    const secondRegistration = second.getBinding();
    pendingBody.resolve(late);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    expect(operations).toEqual(["POST:1", "DELETE"]);
    expect(postCount).toBe(1);

    pendingDelete.resolve(response({ ok: true }));
    await expect(secondRegistration).resolves.toEqual(fresh);
    expect(operations).toEqual(["POST:1", "DELETE", "POST:2"]);
  });

  it("keeps a still-live binding on a failed rotation and falls back untargeted after expiry", async () => {
    let now = NOW;
    const first = binding(NOW + 2 * RUNTIME_BINDING_ROTATE_AHEAD_MS + 1, "one");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(first, 201))
      .mockResolvedValue(response({ error: "unavailable" }, 503));
    const client = createRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-key",
      fetchImpl: fetcher,
      now: () => now,
    });

    await expect(client.getBinding()).resolves.toEqual(first);
    now = NOW + RUNTIME_BINDING_ROTATE_AHEAD_MS + 1;
    await expect(client.getBinding()).resolves.toEqual(first);
    now = NOW + 2 * RUNTIME_BINDING_ROTATE_AHEAD_MS + 2;
    await expect(client.getBinding()).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("abandons an uncertain rotation timeout and ignores a late server response", async () => {
    vi.useFakeTimers();
    let now = NOW;
    const first = binding(NOW + 2 * RUNTIME_BINDING_ROTATE_AHEAD_MS, "one");
    const late = binding(NOW + 3 * 86_400_000, "late");
    const fresh = binding(NOW + 4 * 86_400_000, "fresh");
    let resolveLate!: (value: Response) => void;
    let callNumber = 0;
    const fetcher = vi.fn(
      (_input: string | URL | Request, _init?: RequestInit) => {
        const call = callNumber++;
        if (call === 0) return Promise.resolve(response(first, 201));
        if (call === 1)
          return new Promise<Response>((resolve) => {
            resolveLate = resolve;
          });
        if (_init?.method === "DELETE")
          return Promise.resolve(response({ ok: true }));
        return Promise.resolve(response(fresh, 201));
      },
    );
    const client = createRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-key",
      fetchImpl: fetcher,
      now: () => now,
    });

    await expect(client.getBinding()).resolves.toEqual(first);
    now = NOW + RUNTIME_BINDING_ROTATE_AHEAD_MS + 1;
    const rotation = client.getBinding();
    await vi.advanceTimersByTimeAsync(3_001);
    await expect(rotation).resolves.toBeUndefined();
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      signal: expect.objectContaining({ aborted: true }),
    });

    resolveLate({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve(late),
    } as Response);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    const revoke = fetcher.mock.calls[2];
    expect(revoke?.[1]).toMatchObject({
      method: "DELETE",
      headers: { Authorization: `Bearer ${late.instanceProof}` },
    });
    now += 30_001;
    await expect(client.getBinding()).resolves.toEqual(fresh);
    const freshRequest = fetcher.mock.calls[3];
    expect(String(freshRequest?.[0])).not.toContain("instanceId=");
    expect(freshRequest?.[1]).not.toHaveProperty("headers");
  });

  it("revokes a late initial registration after stop without adopting it", async () => {
    const late = binding(NOW + 86_400_000, "stopped-late");
    let resolveRegistration!: (value: Response) => void;
    const fetcher = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "DELETE")
          return Promise.resolve(response({ ok: true }));
        return new Promise<Response>((resolve) => {
          resolveRegistration = resolve;
        });
      },
    );
    const client = createRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-key",
      fetchImpl: fetcher,
      now: () => NOW,
    });

    const registration = client.getBinding();
    await Promise.resolve();
    client.stop();
    resolveRegistration(response(late, 201));
    await expect(registration).resolves.toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: "DELETE",
      headers: { Authorization: `Bearer ${late.instanceProof}` },
    });
    await expect(client.getBinding()).resolves.toBeUndefined();
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

  it("keeps a zero Retry After from retrying on every fast poll", async () => {
    let now = NOW;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({ code: "rate_limited" }, 429, { "Retry-After": "0" }),
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
    now += 1_001;
    await expect(client.getBinding()).resolves.toBeTruthy();
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

  it("clears and revokes the private binding on stop exactly once", async () => {
    const first = binding(NOW + 86_400_000);
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
    await client.getBinding();
    client.stop();
    client.stop();
    await expect(client.getBinding()).resolves.toBeUndefined();
    await client.getRetirement();
    expect(fetcher).toHaveBeenCalledTimes(2);
    const revoke = fetcher.mock.calls[1];
    expect(String(revoke?.[0])).toContain(
      `/api/runtime/register?projectKey=project-key&instanceId=${first.instanceId}`,
    );
    expect(revoke?.[1]).toMatchObject({
      method: "DELETE",
      headers: { Authorization: `Bearer ${first.instanceProof}` },
    });
    expect(revoke?.[1]).not.toHaveProperty("body");
  });

  it("does not revoke when registration never yielded a valid binding", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ ok: false }, 503));
    const client = createRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-key",
      fetchImpl: fetcher,
      now: () => NOW,
    });

    await expect(client.getBinding()).resolves.toBeUndefined();
    client.stop();
    await client.getRetirement();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("bounds a failed revoke and keeps its proof out of the request body", async () => {
    vi.useFakeTimers();
    const first = binding(NOW + 86_400_000);
    let resolveLate!: (value: Response) => void;
    const fetcher = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "DELETE")
          return new Promise<Response>((resolve) => {
            resolveLate = resolve;
          });
        return Promise.resolve(response(first, 201));
      },
    );
    const client = createRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-key",
      fetchImpl: fetcher,
      now: () => NOW,
    });

    await expect(client.getBinding()).resolves.toEqual(first);
    client.stop();
    const retirement = client.getRetirement();
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
    expect(fetcher.mock.calls[1]?.[1]).not.toHaveProperty("body");
    await vi.advanceTimersByTimeAsync(3_001);
    await expect(retirement).resolves.toBeUndefined();
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      signal: expect.objectContaining({ aborted: true }),
    });
    resolveLate(response({ ok: true }));
  });

  it("does not share a cache entry across custom fetch and clock seams", async () => {
    const fetchA = vi
      .fn()
      .mockResolvedValue(response(binding(NOW + 86_400_000, "fetch-a"), 201));
    const fetchB = vi
      .fn()
      .mockResolvedValue(response(binding(NOW + 86_400_000, "fetch-b"), 201));
    const clockA = vi.fn(() => NOW);
    const clockB = vi.fn(() => NOW);
    const first = getCachedRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-key",
      fetchImpl: fetchA,
      now: clockA,
    });
    const second = getCachedRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-key",
      fetchImpl: fetchB,
      now: clockB,
    });

    expect(second).not.toBe(first);
    await expect(first.getBinding()).resolves.toMatchObject({
      instanceId: "ri_runtime_fetch-a",
    });
    await expect(second.getBinding()).resolves.toMatchObject({
      instanceId: "ri_runtime_fetch-b",
    });
    expect(fetchA).toHaveBeenCalledOnce();
    expect(fetchB).toHaveBeenCalledOnce();
    expect(clockA).toHaveBeenCalled();
    expect(clockB).toHaveBeenCalled();
  });

  it("reuses defaults by endpoint and project while isolating project keys", async () => {
    const fetcher = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) => {
        const projectKey = new URL(String(input)).searchParams.get(
          "projectKey",
        );
        return response(
          binding(NOW + 86_400_000, projectKey ?? "unknown"),
          201,
        );
      },
    );
    vi.stubGlobal("fetch", fetcher);
    const first = getCachedRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-a",
    });
    const same = getCachedRuntimeBindingClient({
      endpoint: `${ENDPOINT}/`,
      projectKey: "project-a",
    });
    const other = getCachedRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-b",
    });

    expect(same).toBe(first);
    expect(other).not.toBe(first);
    await expect(first.getBinding()).resolves.toMatchObject({
      instanceId: expect.stringContaining("project-a"),
    });
    await expect(other.getBinding()).resolves.toMatchObject({
      instanceId: expect.stringContaining("project-b"),
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      "projectKey=project-a",
    );
    expect(String(fetcher.mock.calls[1]?.[0])).toContain(
      "projectKey=project-b",
    );
    expect(
      fetcher.mock.calls.filter((call) => call[1]?.method === "DELETE"),
    ).toHaveLength(0);
  });

  it("bounds and expires the warm-runtime default cache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        response(binding(Date.now() + 2 * 86_400_000), 201),
    );
    vi.stubGlobal("fetch", fetcher);
    const first = getCachedRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-0",
    });
    await first.getBinding();
    for (let index = 1; index <= RUNTIME_BINDING_CACHE_MAX_ENTRIES; index += 1)
      getCachedRuntimeBindingClient({
        endpoint: ENDPOINT,
        projectKey: `project-${index}`,
      });
    await expect(first.getBinding()).resolves.toBeUndefined();
    expect(
      fetcher.mock.calls.filter((call) => call[1]?.method === "POST"),
    ).toHaveLength(1);

    vi.setSystemTime(NOW + RUNTIME_BINDING_CACHE_TTL_MS + 1);
    const expired = getCachedRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-1",
    });
    await expect(expired.getBinding()).resolves.toBeTruthy();
    expect(
      fetcher.mock.calls.filter((call) => call[1]?.method === "POST"),
    ).toHaveLength(2);
  });

  it("revokes LRU evictions and waits before same-key reentry", async () => {
    const active = new Set<string>();
    const operations: string[] = [];
    const registrationCounts = new Map<string, number>();
    let releaseFirstRevoke!: () => void;
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const projectKey = url.searchParams.get("projectKey") ?? "unknown";
        if (init?.method === "DELETE") {
          const instanceId = url.searchParams.get("instanceId") ?? "unknown";
          operations.push(`DELETE:${projectKey}`);
          if (projectKey === "project-0")
            await new Promise<void>((resolve) => {
              releaseFirstRevoke = resolve;
            });
          active.delete(instanceId);
          return response({ ok: true });
        }

        const count = (registrationCounts.get(projectKey) ?? 0) + 1;
        registrationCounts.set(projectKey, count);
        const instance = binding(
          NOW + 2 * 86_400_000,
          `${projectKey}-${count}`,
        );
        active.add(instance.instanceId);
        operations.push(`POST:${projectKey}`);
        return response(instance, 201);
      },
    );
    vi.stubGlobal("fetch", fetcher);
    const options = {
      endpoint: ENDPOINT,
    };

    const first = getCachedRuntimeBindingClient({
      ...options,
      projectKey: "project-0",
    });
    await first.getBinding();
    for (
      let index = 1;
      index <= RUNTIME_BINDING_CACHE_MAX_ENTRIES;
      index += 1
    ) {
      const client = getCachedRuntimeBindingClient({
        ...options,
        projectKey: `project-${index}`,
      });
      await client.getBinding();
    }

    expect(operations).toContain("DELETE:project-0");
    // The old row remains active only while its bounded revoke is in flight.
    expect(active.size).toBe(RUNTIME_BINDING_CACHE_MAX_ENTRIES + 1);
    const reentry = getCachedRuntimeBindingClient({
      ...options,
      projectKey: "project-0",
    });
    const reentryBinding = reentry.getBinding();
    await Promise.resolve();
    expect(registrationCounts.get("project-0")).toBe(1);
    releaseFirstRevoke();
    await expect(reentryBinding).resolves.toBeTruthy();
    await Promise.resolve();
    await Promise.resolve();

    const deleteIndex = operations.indexOf("DELETE:project-0");
    const reentryPostIndex = operations.lastIndexOf("POST:project-0");
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(reentryPostIndex).toBeGreaterThan(deleteIndex);
    expect(registrationCounts.get("project-0")).toBe(2);
    expect(operations).toContain("DELETE:project-1");
    expect(active.size).toBe(RUNTIME_BINDING_CACHE_MAX_ENTRIES);
  });

  it("retains more than 32 stalled retirement gates for oldest-key reentry", async () => {
    const stalledRetirementCount = RUNTIME_BINDING_CACHE_MAX_ENTRIES + 1;
    expect(stalledRetirementCount).toBeGreaterThan(32);
    expect(stalledRetirementCount).toBeLessThan(
      RUNTIME_BINDING_MAX_PENDING_RETIREMENTS,
    );
    const operations: string[] = [];
    const registrationCounts = new Map<string, number>();
    const deleteGates = new Map<string, Deferred<Response>>();
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const projectKey = url.searchParams.get("projectKey") ?? "unknown";
        if (init?.method === "DELETE") {
          operations.push(`DELETE:${projectKey}`);
          let gate = deleteGates.get(projectKey);
          if (!gate) {
            gate = deferred<Response>();
            deleteGates.set(projectKey, gate);
          }
          return gate.promise;
        }

        const count = (registrationCounts.get(projectKey) ?? 0) + 1;
        registrationCounts.set(projectKey, count);
        operations.push(`POST:${projectKey}`);
        return response(
          binding(NOW + 2 * 86_400_000, `${projectKey}-${count}`),
          201,
        );
      },
    );
    vi.stubGlobal("fetch", fetcher);

    for (
      let index = 0;
      index < RUNTIME_BINDING_CACHE_MAX_ENTRIES + stalledRetirementCount;
      index += 1
    ) {
      const client = getCachedRuntimeBindingClient({
        endpoint: ENDPOINT,
        projectKey: `project-${index}`,
      });
      await client.getBinding();
    }

    expect(deleteGates.size).toBe(stalledRetirementCount);
    const reentry = getCachedRuntimeBindingClient({
      endpoint: ENDPOINT,
      projectKey: "project-0",
    });
    const reentryBinding = reentry.getBinding();
    await Promise.resolve();
    expect(registrationCounts.get("project-0")).toBe(1);
    expect(
      operations.filter((operation) => operation === "POST:project-0"),
    ).toHaveLength(1);

    deleteGates.get("project-0")!.resolve(response({ ok: true }));
    await expect(reentryBinding).resolves.toBeTruthy();
    const oldestDeleteIndex = operations.indexOf("DELETE:project-0");
    const reentryPostIndex = operations.lastIndexOf("POST:project-0");
    expect(reentryPostIndex).toBeGreaterThan(oldestDeleteIndex);
    expect(registrationCounts.get("project-0")).toBe(2);

    for (const gate of deleteGates.values())
      gate.resolve(response({ ok: true }));
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

  it("settles browser session start before revoking its runtime binding", async () => {
    const runtime = binding(NOW + 86_400_000, "browser-stop");
    const pendingStart = deferred<Response>();
    const operations: string[] = [];
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/runtime/register")) {
          if (init?.method === "DELETE") {
            operations.push("DELETE");
            return response({ ok: true });
          }
          operations.push("register");
          return response(runtime, 201);
        }
        if (url.endsWith("/api/session/start")) {
          operations.push("session-start");
          const result = await pendingStart.promise;
          operations.push("session-start-settled");
          return result;
        }
        if (url.endsWith("/api/session/end")) {
          operations.push("session-end");
          return response({ ok: true });
        }
        return response({ ok: true });
      },
    );
    vi.stubGlobal("fetch", fetcher);

    const logger = Crumbtrail.init({
      httpEndpoint: ENDPOINT,
      httpAuthToken: "project-key",
      remoteConfig: false,
      widget: false,
      environment: false,
      domSnapshot: false,
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
      heartbeat: false,
      uiNumbers: false,
      listeners: false,
      eventSource: false,
      webSocket: false,
      workers: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
      sessionPersistence: "memory",
    });

    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    expect(operations).toContain("session-start");

    const stopping = logger.stop();
    await Promise.resolve();
    expect(operations).not.toContain("DELETE");

    pendingStart.resolve(response({ ok: true }));
    await stopping;
    expect(operations.indexOf("session-start-settled")).toBeGreaterThanOrEqual(
      0,
    );
    expect(operations.indexOf("DELETE")).toBeGreaterThan(
      operations.indexOf("session-start-settled"),
    );
  });

  it("bounds stop while session start is still pending and retires afterward", async () => {
    vi.useFakeTimers();
    const runtime = binding(NOW + 86_400_000, "browser-stop-timeout");
    const pendingStart = deferred<Response>();
    const operations: string[] = [];
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/runtime/register")) {
          if (init?.method === "DELETE") {
            operations.push("DELETE");
            return response({ ok: true });
          }
          operations.push("register");
          return response(runtime, 201);
        }
        if (url.endsWith("/api/session/start")) {
          operations.push("session-start");
          const result = await pendingStart.promise;
          operations.push("session-start-settled");
          return result;
        }
        return response({ ok: true });
      },
    );
    vi.stubGlobal("fetch", fetcher);

    const logger = Crumbtrail.init({
      httpEndpoint: ENDPOINT,
      httpAuthToken: "project-key",
      remoteConfig: false,
      widget: false,
      environment: false,
      domSnapshot: false,
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
      heartbeat: false,
      uiNumbers: false,
      listeners: false,
      eventSource: false,
      webSocket: false,
      workers: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
      sessionPersistence: "memory",
    });

    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    expect(operations).toContain("session-start");

    const stopping = logger.stop();
    await vi.advanceTimersByTimeAsync(REMOTE_POLICY_TIMEOUT_MS);
    await expect(stopping).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
    expect(operations).not.toContain("DELETE");

    pendingStart.resolve(response({ ok: true }));
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    expect(operations.indexOf("DELETE")).toBeGreaterThan(
      operations.indexOf("session-start-settled"),
    );
  });
});

describe("serverless runtime binding forwarding", () => {
  it("forwards an explicit binding instead of replacing it with the default cache", async () => {
    const runtime = binding(NOW + 86_400_000, "explicit");
    const runtimeFetch = vi.fn().mockResolvedValue(response(runtime, 201));
    const intakeFetch = vi.fn().mockResolvedValue(response({ ok: true }));
    const client = createRuntimeBindingHandle({
      endpoint: ENDPOINT,
      projectKey: "project-key",
      fetchImpl: runtimeFetch,
      now: () => NOW,
    });

    await runServerlessInvocation(
      {
        endpoint: ENDPOINT,
        authToken: "project-key",
        fetchImpl: intakeFetch,
        runtimeBinding: client,
      },
      () => "done",
    );

    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    expect(intakeFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/runtime/register"),
      expect.anything(),
    );
    const start = intakeFetch.mock.calls.find((call) =>
      String(call[0]).endsWith("/api/session/start"),
    );
    expect(JSON.parse(String(start?.[1]?.body))).toMatchObject({
      instanceId: runtime.instanceId,
      instanceProof: runtime.instanceProof,
    });
  });
});
