import { describe, expect, it, vi } from "vitest";
import { diagnoseCors, CORS_REQUIRED_HEADERS } from "../cors-diagnostic";

const origin = "https://app.example.com";
const endpoint = "https://capture.example.com/api/session/start";
const response = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers });
const allowed = () => response(204, {
  "access-control-allow-origin": origin,
  "access-control-allow-credentials": "true",
  "access-control-allow-methods": "POST",
  "access-control-allow-headers": CORS_REQUIRED_HEADERS.join(", "),
});

describe("diagnoseCors", () => {
  it("accepts an explicit credentialed preflight", async () => {
    const fetchImpl = vi.fn(async () => allowed());
    const result = await diagnoseCors({ endpoint, origin, applicable: true, fetchImpl: fetchImpl as typeof fetch });
    expect(result.status).toBe("pass");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "OPTIONS", redirect: "manual" });
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain("ctkey_");
  });

  it("reports a missing application origin as unknown", async () => {
    expect((await diagnoseCors({ endpoint, applicable: true })).status).toBe("unknown");
  });

  it("names every missing correlation and authorization header", async () => {
    const result = await diagnoseCors({ endpoint, origin, applicable: true, fetchImpl: (async () => response(204, { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-methods": "POST" })) as typeof fetch });
    expect(result.missingHeaders).toEqual([...CORS_REQUIRED_HEADERS]);
  });

  it("rejects wildcard responses for credentialed requests", async () => {
    const result = await diagnoseCors({ endpoint, origin, applicable: true, fetchImpl: (async () => response(204, { "access-control-allow-origin": "*", "access-control-allow-credentials": "true", "access-control-allow-methods": "POST", "access-control-allow-headers": CORS_REQUIRED_HEADERS.join(",") })) as typeof fetch });
    expect(result.status).toBe("fail");
    expect(result.reason).toContain(origin);
  });

  it("reports redirects, timeouts, and DNS/TLS/network failures without success", async () => {
    const redirect = await diagnoseCors({ endpoint, origin, applicable: true, fetchImpl: (async () => response(302)) as typeof fetch });
    expect(redirect.category).toBe("redirect");
    const timeout = await diagnoseCors({ endpoint, origin, applicable: true, timeoutMs: 1, fetchImpl: ((_: unknown, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("abort"))))) as typeof fetch });
    expect(timeout.category).toBe("timeout");
    for (const code of ["ENOTFOUND", "CERT_HAS_EXPIRED", "ECONNREFUSED"]) {
      const result = await diagnoseCors({ endpoint, origin, applicable: true, fetchImpl: (async () => { const error = Object.assign(new Error(code), { code }); throw error; }) as typeof fetch });
      expect(result.status).toBe("unknown");
    }
  });

  it("skips non-browser projects and never mutates configuration", async () => {
    const fetchImpl = vi.fn();
    const result = await diagnoseCors({ endpoint, applicable: false, fetchImpl: fetchImpl as typeof fetch });
    expect(result.status).toBe("not-applicable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
