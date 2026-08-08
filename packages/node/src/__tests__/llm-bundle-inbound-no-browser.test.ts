import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import { buildLlmBundle, renderLlmMarkdown } from "../llm-bundle";

/**
 * A request the server received that no browser sent is a webhook, a callback, a cron — traffic,
 * not a shortfall in capture. It arrived as a `backend-only` linkage GAP, and that framing told a
 * reader to discount the one row a webhook defect turns on. Its ABSENCE is evidence too: a charge
 * that succeeds and a settlement callback that never comes are indistinguishable from inside the
 * request that started them.
 */
const scratch: string[] = [];

function bundleFor(fullStackRequests: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-bundle-inbound-"));
  scratch.push(dir);
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ id: "s1", app: "test", env: "local" }),
  );
  return buildLlmBundle({
    sessionDir: dir,
    events: [],
    index: {
      id: "s1",
      start: 1_000,
      end: 6_000,
      dur: 5_000,
      fullStackRequests,
    },
    candidates: [],
  } as never);
}

const CALLBACK_GAP = {
  type: "backend-only",
  requestId: "req-callback",
  backend: {
    requestId: "req-callback",
    method: "POST",
    url: "/api/payments/callback",
    status: 200,
  },
};

const CLIENT_GAP = {
  type: "frontend-only",
  requestId: "req-buildid",
  frontend: { requestId: "req-buildid", method: "GET", url: "/build-id.json" },
};

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

describe("inbound requests with no browser origin", () => {
  it("states a measured absence when nothing called in", () => {
    const markdown = renderLlmMarkdown(
      bundleFor({
        summary: { backendRequests: 11, gapTypes: { "backend-only": 0 } },
        linked: [],
        gaps: [],
      }),
    );
    expect(markdown).toContain("## Inbound Requests With No Browser Origin");
    expect(markdown).toContain("None.");
    expect(markdown).toContain("11 backend request(s) observed");
  });

  it("lists a callback that did arrive, outside the linkage-gap table", () => {
    const markdown = renderLlmMarkdown(
      bundleFor({
        summary: { backendRequests: 12, gapTypes: { "backend-only": 1 } },
        linked: [],
        gaps: [CALLBACK_GAP],
      }),
    );
    expect(markdown).toContain("## Inbound Requests With No Browser Origin");
    expect(markdown).toContain("/api/payments/callback");
    // Not also rendered as a capture shortcoming.
    expect(markdown).not.toContain("### Partial-Linkage Gaps");
  });

  it("keeps genuine linkage gaps in their own table", () => {
    const markdown = renderLlmMarkdown(
      bundleFor({
        summary: {
          backendRequests: 12,
          gapTypes: { "backend-only": 1, "frontend-only": 1 },
        },
        linked: [],
        gaps: [CALLBACK_GAP, CLIENT_GAP],
      }),
    );
    expect(markdown).toContain("### Partial-Linkage Gaps");
    expect(markdown).toContain("/build-id.json");
  });

  it("says nothing when the server was never observed, since absence proves nothing", () => {
    const markdown = renderLlmMarkdown(
      bundleFor({
        summary: { backendRequests: 0, gapTypes: {} },
        linked: [],
        gaps: [],
      }),
    );
    expect(markdown).not.toContain("## Inbound Requests With No Browser Origin");
  });
});
