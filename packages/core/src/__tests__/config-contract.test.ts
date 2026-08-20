import { describe, expect, it } from "vitest";

import { COLLECTOR_MAP } from "../crumbtrail";
import { DEFAULT_CONFIG } from "../types";

/**
 * Adding a collector is a three place edit: the `COLLECTOR_MAP` entry, the `CrumbtrailConfig`
 * key, and the `DEFAULT_CONFIG` default. Missing the third silently disables the collector at
 * runtime with no type error: the mount loop in `crumbtrail.ts` gates each collector on
 * `config[key]`, and an absent key is falsy.
 *
 * These tests make that failure loud.
 */
describe("collector config contract", () => {
  const collectorNames = Object.keys(COLLECTOR_MAP).sort();

  it("has at least one collector to check", () => {
    expect(collectorNames.length).toBeGreaterThan(0);
  });

  it("gives every collector a boolean default in DEFAULT_CONFIG", () => {
    const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;

    const broken = collectorNames
      .filter((name) => typeof defaults[name] !== "boolean")
      .map((name) => `${name} (DEFAULT_CONFIG.${name} is ${typeof defaults[name]})`);

    expect(
      broken,
      `Collectors in COLLECTOR_MAP without a boolean DEFAULT_CONFIG default. ` +
        `Such a collector is silently disabled at runtime. Add the key to CrumbtrailConfig ` +
        `and a default to DEFAULT_CONFIG in packages/core/src/types.ts.`,
    ).toEqual([]);
  });

  /**
   * Deliberately one directional. Not every boolean in `DEFAULT_CONFIG` is a collector:
   * `campaign` is a sub-behaviour of the environment collector, `video`, `audio` and `widget`
   * are not collectors either. Asserting the reverse direction would fail falsely.
   */
  it("does not require every boolean config key to be a collector", () => {
    expect(COLLECTOR_MAP).not.toHaveProperty("campaign");
    expect(typeof DEFAULT_CONFIG.campaign).toBe("boolean");
  });

  /**
   * Pins the privacy default. `campaign` captures first-party `utm_*` acquisition labels;
   * turning it on by default is a privacy commitment that needs founder sign off, so a flip
   * must show up as a visible edit to this test rather than a quiet default change.
   */
  it("keeps campaign capture off by default", () => {
    expect(DEFAULT_CONFIG.campaign).toBe(false);
  });
});
