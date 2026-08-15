import { describe, expect, it } from "vitest";
import { diffFlags, normalizeFlagValue } from "../flags";

describe("normalizeFlagValue", () => {
  it("unwraps the { value, variant } provider shape", () => {
    expect(normalizeFlagValue({ value: true, variant: "test" })).toEqual({
      value: true,
      variant: "test",
    });
  });

  it("passes scalars through as a value with no variant", () => {
    expect(normalizeFlagValue(true)).toEqual({ value: true });
    expect(normalizeFlagValue(0)).toEqual({ value: 0 });
    expect(normalizeFlagValue(null)).toEqual({ value: null });
    expect(normalizeFlagValue(undefined)).toEqual({ value: undefined });
  });

  it("treats a bare string as a value, never as a variant", () => {
    const result = normalizeFlagValue("blue");
    expect(result).toEqual({ value: "blue" });
    expect("variant" in result).toBe(false);
  });

  it("omits the variant key rather than setting it undefined", () => {
    expect(Object.keys(normalizeFlagValue({ value: 1 }))).toEqual(["value"]);
    expect(Object.keys(normalizeFlagValue({ value: 1, variant: undefined }))).toEqual([
      "value",
    ]);
  });

  it("does not unwrap an object value that merely has a value key", () => {
    // { value, other } is a payload, not a provider wrapper. Unwrapping drops `other`.
    const payload = { value: 1, other: 2 };
    expect(normalizeFlagValue(payload)).toEqual({ value: { value: 1, other: 2 } });
  });

  it("preserves a malformed non-string variant instead of discarding it", () => {
    const payload = { value: 1, variant: 2 };
    expect(normalizeFlagValue(payload)).toEqual({ value: { value: 1, variant: 2 } });
  });

  it("keeps object and array values intact", () => {
    expect(normalizeFlagValue({ region: "eu" })).toEqual({ value: { region: "eu" } });
    expect(normalizeFlagValue([1, 2])).toEqual({ value: [1, 2] });
  });

  // Criterion 3: idempotence, asserted directly.
  it("is stable under double application", () => {
    const inputs: unknown[] = [
      true,
      0,
      "blue",
      null,
      undefined,
      [1, 2, 3],
      { region: "eu" },
      { value: true, variant: "test" },
      { value: 1 },
      { value: 1, variant: undefined },
      { value: 1, other: 2 },
      { value: 1, variant: 2 },
      { variant: "orphan" },
      { value: { value: 1, variant: "nested" } },
    ];
    for (const input of inputs) {
      const once = normalizeFlagValue(input);
      const twice = normalizeFlagValue(once);
      expect(twice).toEqual(once);
      // And a third pass, so idempotence is not an accident of the first unwrap.
      expect(normalizeFlagValue(twice)).toEqual(once);
    }
  });
});

describe("diffFlags", () => {
  // Criterion 1.
  it("reports nothing when a key is re-declared with an equal value", () => {
    const { changed } = diffFlags({ checkout: true }, { checkout: true });
    expect(changed).toEqual({});
  });

  it("treats a bare value and its wrapper form as equal", () => {
    // The app swapping provider shapes is not a flag flip.
    const { changed } = diffFlags({ checkout: true }, { checkout: { value: true } });
    expect(changed).toEqual({});
  });

  it("reports nothing for a wholly unchanged multi key re-declaration", () => {
    const state = { checkout: true, theme: "dark", limits: { max: 5 } };
    expect(diffFlags(state, { ...state, limits: { max: 5 } }).changed).toEqual({});
  });

  // Criterion 2a.
  it("reports exactly one entry for a value flip", () => {
    const { changed } = diffFlags({ checkout: true }, { checkout: false });
    expect(Object.keys(changed)).toEqual(["checkout"]);
    expect(changed.checkout).toEqual({ from: { value: true }, to: { value: false } });
  });

  // Criterion 2b.
  it("reports a variant flip even when the value is unchanged", () => {
    const { changed } = diffFlags(
      { checkout: { value: true, variant: "control" } },
      { checkout: { value: true, variant: "test" } },
    );
    expect(Object.keys(changed)).toEqual(["checkout"]);
    expect(changed.checkout).toEqual({
      from: { value: true, variant: "control" },
      to: { value: true, variant: "test" },
    });
  });

  it("reports a variant appearing on a previously bare value", () => {
    const { changed } = diffFlags(
      { checkout: true },
      { checkout: { value: true, variant: "test" } },
    );
    expect(Object.keys(changed)).toEqual(["checkout"]);
    expect(changed.checkout).toEqual({
      from: { value: true },
      to: { value: true, variant: "test" },
    });
  });

  // Criterion 2c.
  it("reports exactly one entry for a key added", () => {
    const { changed } = diffFlags({ checkout: true }, { checkout: true, banner: "blue" });
    expect(Object.keys(changed)).toEqual(["banner"]);
    expect(changed.banner).toEqual({ from: undefined, to: { value: "blue" } });
    expect("from" in changed.banner).toBe(true);
  });

  // Criterion 2d.
  it("reports exactly one entry for a key removed", () => {
    const { changed } = diffFlags({ checkout: true, banner: "blue" }, { checkout: true });
    expect(Object.keys(changed)).toEqual(["banner"]);
    expect(changed.banner).toEqual({ from: { value: "blue" }, to: undefined });
    expect("to" in changed.banner).toBe(true);
  });

  // Criterion 4: the guard against a naive === comparison.
  it("does not report deep equal object values as a change", () => {
    const { changed } = diffFlags(
      { limits: { max: 5, tiers: ["a", "b"] } },
      { limits: { max: 5, tiers: ["a", "b"] } },
    );
    expect(changed).toEqual({});
  });

  it("does not report deep equal array values as a change", () => {
    expect(diffFlags({ rollout: [1, 2, 3] }, { rollout: [1, 2, 3] }).changed).toEqual({});
  });

  it("does not report a deep equal object nested inside a wrapper as a change", () => {
    const { changed } = diffFlags(
      { limits: { value: { max: 5 }, variant: "test" } },
      { limits: { value: { max: 5 }, variant: "test" } },
    );
    expect(changed).toEqual({});
  });

  // The converse of criterion 4: an always-true comparison must not pass either.
  it("still reports a change nested inside an object value", () => {
    const { changed } = diffFlags({ limits: { max: 5 } }, { limits: { max: 6 } });
    expect(Object.keys(changed)).toEqual(["limits"]);
    expect(changed.limits).toEqual({ from: { value: { max: 5 } }, to: { value: { max: 6 } } });
  });

  it("reports an added key inside an object value", () => {
    expect(diffFlags({ limits: { max: 5 } }, { limits: { max: 5, min: 1 } }).changed).toEqual({
      limits: { from: { value: { max: 5 } }, to: { value: { max: 5, min: 1 } } },
    });
  });

  it("reports array order and length changes", () => {
    expect(Object.keys(diffFlags({ r: [1, 2] }, { r: [2, 1] }).changed)).toEqual(["r"]);
    expect(Object.keys(diffFlags({ r: [1, 2] }, { r: [1, 2, 3] }).changed)).toEqual(["r"]);
  });

  it("does not confuse an array with an object of the same indices", () => {
    expect(Object.keys(diffFlags({ r: [1, 2] }, { r: { 0: 1, 1: 2 } }).changed)).toEqual(["r"]);
  });

  it("does not confuse null with an object value", () => {
    expect(Object.keys(diffFlags({ r: null }, { r: {} }).changed)).toEqual(["r"]);
  });

  it("treats NaN as unchanged against itself", () => {
    expect(diffFlags({ r: Number.NaN }, { r: Number.NaN }).changed).toEqual({});
  });

  it("compares dates by instant, not identity", () => {
    const iso = "2026-08-15T00:00:00.000Z";
    expect(diffFlags({ r: new Date(iso) }, { r: new Date(iso) }).changed).toEqual({});
    expect(
      Object.keys(diffFlags({ r: new Date(iso) }, { r: new Date("2026-08-16T00:00:00.000Z") })
        .changed),
    ).toEqual(["r"]);
  });

  it("reports several independent moves in one diff", () => {
    const { changed } = diffFlags(
      { a: 1, b: 2, c: 3, same: "x" },
      { a: 9, c: 3, d: 4, same: "x" },
    );
    expect(Object.keys(changed).sort()).toEqual(["a", "b", "d"]);
    expect(changed.a).toEqual({ from: { value: 1 }, to: { value: 9 } });
    expect(changed.b).toEqual({ from: { value: 2 }, to: undefined });
    expect(changed.d).toEqual({ from: undefined, to: { value: 4 } });
  });

  describe("nextState", () => {
    it("is the normalized next state, so it can be fed straight back in", () => {
      const { nextState } = diffFlags(
        {},
        { checkout: { value: true, variant: "test" }, banner: "blue" },
      );
      expect(nextState).toEqual({
        checkout: { value: true, variant: "test" },
        banner: { value: "blue" },
      });
      // Feeding it back as `prev` against the same input reports no movement.
      expect(
        diffFlags(nextState, { checkout: { value: true, variant: "test" }, banner: "blue" })
          .changed,
      ).toEqual({});
    });

    it("drops removed keys", () => {
      expect(diffFlags({ a: 1, b: 2 }, { a: 1 }).nextState).toEqual({ a: { value: 1 } });
    });

    it("does not alias the caller's input object", () => {
      const next = { a: 1 };
      const { nextState } = diffFlags(undefined, next);
      expect(nextState).not.toBe(next);
      expect(nextState.a).toEqual({ value: 1 });
    });
  });

  describe("tolerant input", () => {
    it("treats undefined prev as an empty state", () => {
      expect(diffFlags(undefined, { a: 1 }).changed).toEqual({
        a: { from: undefined, to: { value: 1 } },
      });
    });

    it("treats undefined next as every key removed", () => {
      expect(diffFlags({ a: 1 }, undefined).changed).toEqual({
        a: { from: { value: 1 }, to: undefined },
      });
      expect(diffFlags({ a: 1 }, undefined).nextState).toEqual({});
    });

    it("returns an empty diff for two empty states", () => {
      expect(diffFlags(undefined, undefined)).toEqual({ changed: {}, nextState: {} });
    });

    it("does not throw on non-object input", () => {
      expect(diffFlags("nope" as unknown as Record<string, unknown>, { a: 1 }).changed).toEqual({
        a: { from: undefined, to: { value: 1 } },
      });
    });

    it("ignores inherited keys", () => {
      const prev = Object.create({ inherited: 1 }) as Record<string, unknown>;
      prev.own = 2;
      expect(diffFlags(prev, { own: 2 }).changed).toEqual({});
    });

    it("handles a key explicitly declared undefined without calling it absent", () => {
      // `{ a: undefined }` normalizes to `{ value: undefined }`, an object, so it is present.
      expect(diffFlags({ a: undefined }, { a: undefined }).changed).toEqual({});
      expect(diffFlags({ a: undefined }, {}).changed).toEqual({
        a: { from: { value: undefined }, to: undefined },
      });
    });
  });

  it("does not blow the stack on a cyclic flag value", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => diffFlags({ r: cyclic }, { r: cyclic })).not.toThrow();
    // Identical references short-circuit before recursion, so this is genuinely unchanged.
    expect(diffFlags({ r: cyclic }, { r: cyclic }).changed).toEqual({});

    const other: Record<string, unknown> = { name: "loop" };
    other.self = other;
    expect(() => diffFlags({ r: cyclic }, { r: other })).not.toThrow();
  });
});
