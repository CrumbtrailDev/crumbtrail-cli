import { describe, expect, it } from "vitest";
import { NoopReproducer } from "../reproduce/noop";

describe("NoopReproducer", () => {
  it("resolves to an attempted:false result and never throws", async () => {
    const reproducer = new NoopReproducer();

    const result = await reproducer.reproduce({ title: "x" });

    expect(result.attempted).toBe(false);
    expect(result.evidence).toEqual([]);
    expect(result.intent).toEqual([]);
    expect(typeof result.note).toBe("string");
    expect(result.note.length).toBeGreaterThan(0);
  });
});
