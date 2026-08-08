import { describe, expect, it } from "vitest";
import { selectLinkedForRendering } from "../llm-bundle";

/**
 * A session opens with a burst of page-load GETs and the defect happens at the end. Rendering the
 * FIRST ten linked requests therefore rendered the boot sequence every time and cut the request the
 * user's action produced - which is the one every reader asked for.
 */
describe("which linked requests the markdown renders", () => {
  function entry(offsetMs: number, method: string, url: string, status = 200) {
    return {
      requestId: `r${offsetMs}`,
      sessionId: "s1",
      frontend: {
        requestId: `r${offsetMs}`,
        sessionId: "s1",
        method,
        url,
        status,
        ref: { offsetMs },
      },
      backend: {
        requestId: `r${offsetMs}`,
        sessionId: "s1",
        method,
        pathname: url,
        statusCode: status,
        start: { offsetMs },
      },
    } as never;
  }

  const boot = Array.from({ length: 15 }, (_, i) =>
    entry(i * 10, "GET", "/api/products"),
  );

  function urls(entries: ReturnType<typeof entry>[]): string[] {
    return entries.map(
      (item) => (item as { frontend: { url: string } }).frontend.url,
    );
  }

  it("keeps the request that changed something even when it came last", () => {
    const selected = selectLinkedForRendering(
      [...boot, entry(9_000, "POST", "/api/checkout")],
      10,
    );

    expect(urls(selected)).toContain("/api/checkout");
  });

  it("keeps a failure wherever it happened", () => {
    const selected = selectLinkedForRendering(
      [entry(5, "GET", "/api/session", 500), ...boot],
      10,
    );

    expect(urls(selected)).toContain("/api/session");
  });

  // Selection, not reordering: the reader still gets a sequence.
  it("returns what it keeps in chronological order", () => {
    const selected = selectLinkedForRendering(
      [...boot, entry(9_000, "POST", "/api/checkout")],
      10,
    );
    const offsets = selected.map(
      (item) => (item as { frontend: { ref: { offsetMs: number } } }).frontend.ref.offsetMs,
    );

    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it("prefers the most recent of the ordinary reads for the remaining slots", () => {
    const selected = selectLinkedForRendering(boot, 3);

    expect(
      selected.map(
        (item) => (item as { frontend: { ref: { offsetMs: number } } }).frontend.ref.offsetMs,
      ),
    ).toEqual([120, 130, 140]);
  });

  it("returns everything when the session is under the cap", () => {
    expect(selectLinkedForRendering(boot.slice(0, 4), 10)).toHaveLength(4);
  });
});
