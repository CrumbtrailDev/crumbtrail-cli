// The defect shape no failure list can report: a request that returned 200 and
// carried the wrong value.
//
// A cart endpoint answering `{"items": null}` with a 200 IS the bug, and every
// handoff the product builds read only the failed set — so the response was
// captured perfectly and then reached none of them. The reader's only route to
// it was calling getWindow with two epoch timestamps they worked out by hand.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildLlmBundle, renderLlmMarkdown } from "../llm-bundle";

const scratch: string[] = [];

function bundleFor(events: BugEvent[], index: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preceding-req-"));
  scratch.push(dir);
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ id: "s1", app: "test", env: "local" }),
  );
  return buildLlmBundle({
    sessionDir: dir,
    events,
    index: { id: "s1", start: 1_000, end: 20_000, dur: 19_000, ...index },
    candidates: [],
  } as never);
}

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

const CART = [
  {
    t: 10_000,
    k: "net.req",
    d: { id: 7, m: "GET", url: "http://localhost:3000/api/cart" },
  },
  {
    t: 10_050,
    k: "net.res",
    d: { id: 7, st: 200, body: { cartId: "c_1", items: null, currency: "USD" } },
  },
  {
    t: 10_400,
    k: "err",
    d: { msg: "Cannot read properties of null (reading 'length')" },
  },
] as unknown as BugEvent[];

describe("preceding requests", () => {
  it("carries the successful response that explains the failure", () => {
    const bundle = bundleFor(CART, {
      errs: [{ t: 10_400, msg: "Cannot read properties of null" }],
    });
    const preceding = bundle.browserEvidence.precedingRequests;
    expect(preceding).toHaveLength(1);
    expect(preceding[0]?.status).toBe(200);
    expect(preceding[0]?.url).toContain("/api/cart");
    expect(preceding[0]?.responseBody).toContain("items");
    // The failure list, which is what every handoff used to read, is empty.
    expect(bundle.browserEvidence.failedRequests).toHaveLength(0);
  });

  it("puts it in the markdown an agent is handed", () => {
    const bundle = bundleFor(CART, {
      errs: [{ t: 10_400, msg: "Cannot read properties of null" }],
    });
    const md = renderLlmMarkdown(bundle);
    expect(md).toContain("Requests That Succeeded Just Before The Failure");
    expect(md).toContain("/api/cart");
  });

  it("reports nothing when there is no error to anchor on", () => {
    const bundle = bundleFor(CART.slice(0, 2) as unknown as BugEvent[]);
    expect(bundle.browserEvidence.precedingRequests).toEqual([]);
  });

  it("leaves out a response that arrived after the error", () => {
    const late = [
      ...CART,
      {
        t: 11_000,
        k: "net.req",
        d: { id: 8, m: "GET", url: "http://localhost:3000/api/late" },
      },
      { t: 11_050, k: "net.res", d: { id: 8, st: 200, body: { ok: true } } },
    ] as unknown as BugEvent[];
    const bundle = bundleFor(late, {
      errs: [{ t: 10_400, msg: "Cannot read properties of null" }],
    });
    const urls = bundle.browserEvidence.precedingRequests.map((r) => r.url);
    expect(urls.some((u) => u?.includes("/api/late"))).toBe(false);
  });
});
