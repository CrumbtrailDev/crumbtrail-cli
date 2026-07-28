import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { sanitizeEventForStorage } from "../storage-plane";

describe("callsite chain at rest", () => {
  it("survives the storage sanitizer intact", () => {
    const ev = {
      t: 1,
      k: "db.diff",
      d: {
        table: "orders",
        op: "insert",
        pk: { id: 1 },
        after: { total_cents: 19900 },
        callsite: {
          file: "server/src/repos/orders-repo.js",
          line: 5,
          column: 20,
          fn: "insertOrder",
          stack: [
            { file: "server/src/services/order-service.js", line: 22, fn: "createOrder" },
            { file: "server/src/routes/checkout.js", line: 9, fn: "handler" },
          ],
        },
      },
    } as unknown as BugEvent;
    const d = sanitizeEventForStorage(ev).d as Record<string, unknown>;
    expect(d.callsite).toEqual((ev.d as Record<string, unknown>).callsite);
  });
});
