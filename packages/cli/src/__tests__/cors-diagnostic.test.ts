import { describe, expect, it, vi } from "vitest";
import { diagnoseCors } from "../cors-diagnostic";

const origin = "https://app.example.com";
const endpoint = "https://capture.example.com/api/session/start";
const browserIngestRequestHeaders = ["content-type", "x-crumbtrail-auth"];
const response = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers });
const allowed = () =>
  response(204, {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST",
    "access-control-allow-headers": browserIngestRequestHeaders.join(", "),
  });

describe("diagnoseCors", () => {
  it("checks the exact non-credentialed browser ingest contract", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => allowed(),
    );
    const result = await diagnoseCors({
      endpoint,
      origin,
      applicable: true,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.status).toBe("pass");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: "OPTIONS",
      redirect: "manual",
      credentials: "same-origin",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          browserIngestRequestHeaders.join(", "),
      },
    });
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain("ctkey_");
  });

  it("reports a missing application origin as unknown", async () => {
    expect((await diagnoseCors({ endpoint, applicable: true })).status).toBe(
      "unknown",
    );
  });

  it("names every missing browser ingest header", async () => {
    const result = await diagnoseCors({
      endpoint,
      origin,
      applicable: true,
      fetchImpl: (async () =>
        response(204, {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "POST",
        })) as typeof fetch,
    });
    expect(result.missingHeaders).toEqual(browserIngestRequestHeaders);
  });

  it("accepts wildcard origins for the non-credentialed browser ingest request", async () => {
    const result = await diagnoseCors({
      endpoint,
      origin,
      applicable: true,
      fetchImpl: (async () =>
        response(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST",
          "access-control-allow-headers": browserIngestRequestHeaders.join(","),
        })) as typeof fetch,
    });
    expect(result.status).toBe("pass");
  });

  it("accepts wildcard methods and headers for the browser ingest request", async () => {
    const result = await diagnoseCors({
      endpoint,
      origin,
      applicable: true,
      fetchImpl: (async () =>
        response(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "*",
          "access-control-allow-headers": "*",
        })) as typeof fetch,
    });
    expect(result.status).toBe("pass");
  });

  it("keeps wildcard method and header checks strict for credentialed requests", async () => {
    const result = await diagnoseCors({
      endpoint,
      origin,
      applicable: true,
      credentials: "include",
      fetchImpl: (async () =>
        response(204, {
          "access-control-allow-origin": origin,
          "access-control-allow-credentials": "true",
          "access-control-allow-methods": "*",
          "access-control-allow-headers": "*",
        })) as typeof fetch,
    });
    expect(result.status).toBe("fail");
    expect(result.missingMethod).toBe("POST");
    expect(result.missingHeaders).toEqual(browserIngestRequestHeaders);
  });

  it("reports redirects, timeouts, and DNS/TLS/network failures without success", async () => {
    const redirect = await diagnoseCors({
      endpoint,
      origin,
      applicable: true,
      fetchImpl: (async () => response(302)) as typeof fetch,
    });
    expect(redirect.category).toBe("redirect");
    const timeout = await diagnoseCors({
      endpoint,
      origin,
      applicable: true,
      timeoutMs: 1,
      fetchImpl: ((_: unknown, init: RequestInit) =>
        new Promise((_, reject) =>
          init.signal?.addEventListener("abort", () =>
            reject(new Error("abort")),
          ),
        )) as typeof fetch,
    });
    expect(timeout.category).toBe("timeout");
    for (const code of ["ENOTFOUND", "CERT_HAS_EXPIRED", "ECONNREFUSED"]) {
      const result = await diagnoseCors({
        endpoint,
        origin,
        applicable: true,
        fetchImpl: (async () => {
          const error = Object.assign(new Error(code), { code });
          throw error;
        }) as typeof fetch,
      });
      expect(result.status).toBe("unknown");
    }
  });

  it("skips non-browser projects and never mutates configuration", async () => {
    const fetchImpl = vi.fn();
    const result = await diagnoseCors({
      endpoint,
      applicable: false,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.status).toBe("not-applicable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
