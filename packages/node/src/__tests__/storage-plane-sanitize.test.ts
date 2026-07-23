import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { sanitizeEventForStorage } from "../storage-plane";

function netReqEvent(d: Record<string, unknown>): BugEvent {
  return { t: 1, k: "net.req", d } as unknown as BugEvent;
}

const V2_METADATA = {
  policy: "crumbtrail.browser-redaction.v2",
  fields: [],
  summaries: [],
};

describe("sanitizeEventForStorage network bodies", () => {
  it("keeps a structured (v2) JSON body after server-side re-classification", () => {
    const body = JSON.stringify({
      userId: 1,
      couponCode: "EXPIRED5",
      total: 23319,
      items: [{ productId: 1, qty: 1 }],
    });
    const sanitized = sanitizeEventForStorage(
      netReqEvent({ id: 7, url: "/api/checkout", body, redaction: V2_METADATA }),
    );
    const parsed = JSON.parse(
      (sanitized.d as Record<string, unknown>).body as string,
    ) as Record<string, unknown>;
    expect(parsed.couponCode).toBe("EXPIRED5");
    expect(parsed.total).toBe(23319);
    expect((parsed.items as Array<Record<string, unknown>>)[0]).toEqual({
      productId: 1,
      qty: 1,
    });
  });

  it("re-redacts sensitive values even when the client declares v2", () => {
    const body = JSON.stringify({ password: "hunter2-super-secret", qty: 2 });
    const sanitized = sanitizeEventForStorage(
      netReqEvent({ id: 1, url: "/api/login", body, redaction: V2_METADATA }),
    );
    const stored = (sanitized.d as Record<string, unknown>).body as string;
    expect(stored).not.toContain("hunter2-super-secret");
    expect(JSON.parse(stored).qty).toBe(2);
  });

  it("blanket-redacts a body with no v2 declaration", () => {
    const sanitized = sanitizeEventForStorage(
      netReqEvent({ id: 1, url: "/api/checkout", body: '{"qty":1}' }),
    );
    expect((sanitized.d as Record<string, unknown>).body).toBe("[REDACTED]");
  });

  it("blanket-redacts a v2-declared body that fails structured re-processing", () => {
    const sanitized = sanitizeEventForStorage(
      netReqEvent({
        id: 1,
        url: "/api/checkout",
        body: "not json at all {",
        redaction: V2_METADATA,
      }),
    );
    expect((sanitized.d as Record<string, unknown>).body).toBe("[REDACTED]");
  });
});
