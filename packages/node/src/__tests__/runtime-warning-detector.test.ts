import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function runtimeWarning(
  t: number,
  name: string,
  message: string,
  stack: string | null = null,
): BugEvent {
  return {
    t,
    k: "backend.warning",
    d: { name, message, stack },
  } as unknown as BugEvent;
}

function candidatesFor(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 }).filter(
    (candidate) => candidate.detector === "runtime_warning",
  );
}

describe("runtime_warning", () => {
  it("surfaces a runtime warning the application never logged", () => {
    const [candidate] = candidatesFor([
      runtimeWarning(10, "DeprecationWarning", "Buffer() is deprecated"),
    ]);
    expect(candidate).toBeDefined();
    expect(candidate.title).toContain("DeprecationWarning");
    expect(candidate.title).toContain("Buffer() is deprecated");
    expect(candidate.anchor.errorCode).toBe("DeprecationWarning");
  });

  it("ranks an ordinary warning at medium severity", () => {
    const [candidate] = candidatesFor([
      runtimeWarning(10, "DeprecationWarning", "Buffer() is deprecated"),
    ]);
    expect(candidate.severity).toBe("medium");
  });

  it("ranks a leaked-listener warning higher, because it names a leak", () => {
    const [candidate] = candidatesFor([
      runtimeWarning(
        10,
        "MaxListenersExceededWarning",
        "Possible EventEmitter memory leak detected. 11 close listeners added.",
      ),
    ]);
    expect(candidate.severity).toBe("high");
    expect(candidate.score).toBeGreaterThan(
      candidatesFor([
        runtimeWarning(10, "DeprecationWarning", "Buffer() is deprecated"),
      ])[0].score,
    );
  });

  it("collapses identical warnings into one candidate carrying the count", () => {
    const candidates = candidatesFor([
      runtimeWarning(10, "MaxListenersExceededWarning", "11 close listeners"),
      runtimeWarning(20, "MaxListenersExceededWarning", "11 close listeners"),
      runtimeWarning(30, "MaxListenersExceededWarning", "11 close listeners"),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].occurrences).toBe(3);
    // The earliest sighting anchors the finding.
    expect(candidates[0].anchor.t).toBe(10);
  });

  it("keeps warnings of different classes apart", () => {
    const candidates = candidatesFor([
      runtimeWarning(10, "MaxListenersExceededWarning", "11 close listeners"),
      runtimeWarning(20, "DeprecationWarning", "Buffer() is deprecated"),
    ]);
    expect(candidates).toHaveLength(2);
  });

  it("resolves a code frame from the warning's stack when there is one", () => {
    const [candidate] = candidatesFor([
      runtimeWarning(
        10,
        "MaxListenersExceededWarning",
        "11 close listeners",
        "MaxListenersExceededWarning: leak\n    at Server.addListener (/app/server.js:12:9)",
      ),
    ]);
    expect(candidate.anchor.frame).toBe("/app/server.js:12:9");
  });

  it("emits nothing for a session with no runtime warnings", () => {
    expect(candidatesFor([{ t: 10, k: "nav", d: { to: "/" } } as BugEvent])).toHaveLength(
      0,
    );
  });
});
