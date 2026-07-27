import { describe, expect, it } from "vitest";

import { compareVersions, floorSatisfiedBy } from "../verify-sdk-version-floors.mjs";

describe("compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareVersions("0.16.1", "0.16.1")).toBe(0);
    expect(compareVersions("0.16.0", "0.16.1")).toBeLessThan(0);
    expect(compareVersions("0.16.1", "0.16.0")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0", "0.16.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
  });

  it("rejects anything that is not a plain x.y.z release", () => {
    for (const bad of ["0.16", "^0.16.1", "0.16.1-rc.1", "latest", ""]) {
      expect(() => compareVersions(bad, "0.16.1")).toThrow(/plain x\.y\.z/);
    }
  });
});

describe("floorSatisfiedBy", () => {
  it("accepts a floor that equals the workspace version", () => {
    expect(floorSatisfiedBy("0.16.1", "0.16.1")).toBe(true);
  });

  // The point of the change: a floor is a capability minimum, not a mirror of
  // latest. A patch or minor release must NOT force a floor edit, because that
  // edit cascades into a detect-core release and a CLI release for no user gain.
  it("accepts a floor that lags behind the workspace version", () => {
    expect(floorSatisfiedBy("0.16.0", "0.16.1")).toBe(true);
    expect(floorSatisfiedBy("0.14.0", "0.16.1")).toBe(true);
    expect(floorSatisfiedBy("0.2.1", "0.16.1")).toBe(true);
  });

  // Still load-bearing: a floor above what the workspace can publish would tell
  // users to install a version that does not exist.
  it("rejects a floor ahead of the workspace version", () => {
    expect(floorSatisfiedBy("0.17.0", "0.16.1")).toBe(false);
    expect(floorSatisfiedBy("0.16.2", "0.16.1")).toBe(false);
    expect(floorSatisfiedBy("1.0.0", "0.16.1")).toBe(false);
  });
});
