// The React error boundary's payload, read by the analyzer that has to consume it.
//
// The two sides of this contract live in different packages —
// `crumbtrail-core/react` (and `crumbtrail-react-native`) emit the `err` event,
// packages/node indexes it — and they drifted: the boundaries emitted
// `stack`/`componentStack` while the index reads `stk`, so every crash caught by
// the documented React integration reached the agent as a bare message with no
// stack and no code frame. Nothing failed, because the message still arrived.
//
// The emitted key set is pinned on the other side in
// `packages/core/src/react/__tests__/error-boundary.test.ts`. This file pins the
// reader, using the payload exactly as the boundary builds it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { postProcess } from "../post-process";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-boundary-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const STACK =
  "Error: cart is undefined\n    at CartList (https://app.test/src/CartList.tsx:42:9)";
const COMPONENT_STACK =
  "\n    at CartList (src/CartList.tsx:42:9)\n    at CheckoutPage\n    at App";

/** Exactly what `CrumbtrailErrorBoundary.componentDidCatch` hands to addEvent. */
function boundarySession(): string {
  const dir = path.join(tmpDir, "session");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ id: "ses_boundary", start: 1_000 }),
  );
  fs.writeFileSync(
    path.join(dir, "events.ndjson"),
    `${JSON.stringify({
      t: 1_000,
      k: "err",
      d: {
        msg: "cart is undefined",
        stk: STACK,
        componentStk: COMPONENT_STACK,
        source: "react-error-boundary",
      },
    })}\n`,
  );
  return dir;
}

function readJson(dir: string, file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("a boundary-caught React crash reaches the agent with its stack", () => {
  it("indexes the stack and the component path", async () => {
    const dir = boundarySession();
    await postProcess(dir);

    const index = readJson(dir, "index.json");
    const errs = index.errs as Array<Record<string, unknown>>;
    expect(errs).toHaveLength(1);
    expect(errs[0]!.msg).toBe("cart is undefined");
    // Without these two the bundle still looks populated — the message
    // survives — while the file, the line and the component path are gone.
    expect(errs[0]!.stk).toContain("CartList.tsx:42:9");
    expect(errs[0]!.componentStk).toContain("CheckoutPage");
  });

  it("gives the candidate a code frame and the component path", async () => {
    const dir = boundarySession();
    await postProcess(dir);

    const list = fs
      .readFileSync(path.join(dir, "candidates.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const crash = list.find(
      (candidate) => candidate.detector === "uncaught_error",
    );
    expect(crash).toBeDefined();
    const anchor = crash!.anchor as Record<string, unknown>;
    expect(String(anchor.frame)).toContain("CartList.tsx:42");
    expect(String(anchor.componentStack)).toContain("CheckoutPage");
  });
});
