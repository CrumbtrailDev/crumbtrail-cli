import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { sanitizeEventForStorage } from "../storage-plane";

function netReqEvent(d: Record<string, unknown>): BugEvent {
  return { t: 1, k: "net.req", d } as unknown as BugEvent;
}

function netResEvent(d: Record<string, unknown>): BugEvent {
  return { t: 2, k: "net.res", d } as unknown as BugEvent;
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

describe("sanitizeEventForStorage response body summaries (d.bodyMeta)", () => {
  it("keeps the parsed data view when the event declares v2", () => {
    const sanitized = sanitizeEventForStorage(
      netResEvent({
        id: 3,
        st: 200,
        bodyMeta: {
          ct: "json",
          bytes: 141,
          truncated: true,
          arrayTotal: { $: 25, "$.items": 57 },
          data: { items: [{ productId: 2, qty: 1 }], total: 12800 },
        },
        redaction: V2_METADATA,
      }),
    );
    const meta = (sanitized.d as Record<string, unknown>)
      .bodyMeta as Record<string, unknown>;
    expect(meta.ct).toBe("json");
    expect(meta.bytes).toBe(141);
    expect(meta.truncated).toBe(true);
    expect(meta.arrayTotal).toEqual({ $: 25, "$.items": 57 });
    const data = meta.data as Record<string, unknown>;
    expect(data.total).toBe(12800);
    expect((data.items as Array<Record<string, unknown>>)[0]).toEqual({
      productId: 2,
      qty: 1,
    });
  });

  it("keeps the envelope but drops data without a v2 declaration", () => {
    const sanitized = sanitizeEventForStorage(
      netResEvent({
        id: 3,
        st: 200,
        bodyMeta: {
          ct: "application/json",
          bytes: 141,
          data: { anything: "raw prose that was never re-classified" },
        },
      }),
    );
    const meta = (sanitized.d as Record<string, unknown>)
      .bodyMeta as Record<string, unknown>;
    expect(meta).toEqual({ ct: "application/json", bytes: 141 });
  });

  it("re-sweeps sensitive names inside a declared data view", () => {
    const sanitized = sanitizeEventForStorage(
      netResEvent({
        id: 3,
        st: 200,
        bodyMeta: {
          ct: "json",
          bytes: 80,
          data: { token: "sk-live-abcdef123456", qty: 2 },
        },
        redaction: V2_METADATA,
      }),
    );
    const meta = (sanitized.d as Record<string, unknown>)
      .bodyMeta as Record<string, unknown>;
    const data = meta.data as Record<string, unknown>;
    expect(data.token).toBe("[REDACTED]");
    expect(data.qty).toBe(2);
  });

  it("collapses a bodyMeta that is not a record, or has no valid media type", () => {
    const notRecord = sanitizeEventForStorage(
      netResEvent({ id: 3, st: 200, bodyMeta: "text/html; secret=x" }),
    );
    expect((notRecord.d as Record<string, unknown>).bodyMeta).toBe(
      "[REDACTED]",
    );

    const badCt = sanitizeEventForStorage(
      netResEvent({
        id: 3,
        st: 200,
        bodyMeta: { ct: "json\nSet-Cookie: sid=1", bytes: 10 },
      }),
    );
    expect((badCt.d as Record<string, unknown>).bodyMeta).toBe("[REDACTED]");
  });

  it("drops malformed arrayTotal entries and keeps valid ones", () => {
    const sanitized = sanitizeEventForStorage(
      netResEvent({
        id: 3,
        st: 200,
        bodyMeta: {
          ct: "json",
          bytes: 10,
          arrayTotal: {
            $: 25,
            "not-a-json-path": 4,
            "$.ok": Number.NaN,
            "$.neg": -1,
          },
        },
        redaction: V2_METADATA,
      }),
    );
    const meta = (sanitized.d as Record<string, unknown>)
      .bodyMeta as Record<string, unknown>;
    expect(meta.arrayTotal).toEqual({ $: 25 });
  });
});
