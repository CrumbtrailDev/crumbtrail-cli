import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildLlmBundle, renderLlmMarkdown } from "../llm-bundle";

/**
 * `fullStackEvidence` pairs a browser request with the server handler that answered it and stops
 * there. The leg beyond that handler — the gateway, the sibling service, the webhook — was captured
 * as `backend.http` and rendered nowhere, so a bundle could hold a successful charge and a service
 * that never answered, and show a reader neither.
 */
const scratch: string[] = [];

const CHARGE = {
  t: 1_500,
  k: "backend.http",
  d: {
    service: "payments",
    operation: "charge",
    method: "POST",
    url: "http://127.0.0.1:4657/charge",
    status: 200,
    durationMs: 5,
    requestId: "req-checkout",
    chargeId: "ch_0001",
    chargeStatus: "succeeded",
  },
} as unknown as BugEvent;

const FAILED_PRICING = {
  t: 1_200,
  k: "backend.http",
  d: {
    service: "pricing",
    method: "POST",
    url: "http://127.0.0.1:4647/price",
    status: 0,
    error: "fetch failed",
    durationMs: 1,
    requestId: "req-checkout",
  },
} as unknown as BugEvent;

function bundleFor(events: BugEvent[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-bundle-outbound-"));
  scratch.push(dir);
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ id: "s1", app: "test", env: "local" }),
  );
  return buildLlmBundle({
    sessionDir: dir,
    events,
    index: { id: "s1", start: 1_000, end: 6_000, dur: 5_000 },
    candidates: [],
  } as never);
}

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

describe("outbound server calls reach the bundle", () => {
  it("collects the transport fields and correlates to the inbound request", () => {
    const [pricing, charge] = bundleFor([FAILED_PRICING, CHARGE]).outboundCalls;
    expect(pricing).toMatchObject({
      service: "pricing",
      status: 0,
      error: "fetch failed",
      requestId: "req-checkout",
      offsetMs: 200,
    });
    expect(charge).toMatchObject({
      service: "payments",
      operation: "charge",
      method: "POST",
      status: 200,
    });
  });

  it("keeps the application's own fields, which are what say the call succeeded", () => {
    const [, charge] = bundleFor([FAILED_PRICING, CHARGE]).outboundCalls;
    expect(charge.detail).toMatchObject({
      chargeId: "ch_0001",
      chargeStatus: "succeeded",
    });
    // Transport fields are columns, not duplicated into detail.
    expect(charge.detail).not.toHaveProperty("status");
    expect(charge.detail).not.toHaveProperty("url");
  });

  it("renders a succeeded call and a transport failure side by side", () => {
    const markdown = renderLlmMarkdown(bundleFor([FAILED_PRICING, CHARGE]));
    expect(markdown).toContain("## Outbound Service Calls");
    expect(markdown).toContain("payments");
    expect(markdown).toContain("ch_0001");
    expect(markdown).toContain("failed: fetch failed");
    // A success must be as legible as a failure — a charge that went through and a callback that
    // never came look identical in the request that started them.
    expect(markdown).toContain("A call that SUCCEEDED is as much evidence as one that failed");
  });

  it("omits the section entirely when the server called nothing outward", () => {
    const markdown = renderLlmMarkdown(bundleFor([]));
    expect(markdown).not.toContain("## Outbound Service Calls");
  });
});
