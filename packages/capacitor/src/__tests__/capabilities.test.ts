import { describe, expect, it } from "vitest";
import {
  CAPACITOR_CAPABILITY_BITS,
  detectCapacitorCapabilities,
} from "../capabilities";

describe("detectCapacitorCapabilities", () => {
  it("reports every plugin absent when nothing resolves", () => {
    const result = detectCapacitorCapabilities({ resolver: () => undefined });

    expect(result.bitset).toBe(0);
    expect(result.capabilities).toEqual([]);
    expect(result.modules.app).toEqual({
      packageName: "@capacitor/app",
      present: false,
      status: "absent",
    });
  });

  it("sets one bit per installed plugin", () => {
    const installed = new Set(["@capacitor/core", "@capacitor/device"]);
    const result = detectCapacitorCapabilities({
      resolver: (name) => (installed.has(name) ? {} : undefined),
    });

    expect(result.bitset).toBe(
      CAPACITOR_CAPABILITY_BITS.core | CAPACITOR_CAPABILITY_BITS.device,
    );
    expect(result.capabilities).toEqual(["capacitor-core", "device-info"]);
    expect(result.modules.device.present).toBe(true);
    expect(result.modules.network.present).toBe(false);
  });

  it("treats a throwing resolver as absent rather than failing init", () => {
    const result = detectCapacitorCapabilities({
      resolver: (name) => {
        if (name === "@capacitor/network") throw new Error("resolution failed");
        return {};
      },
    });

    expect(result.modules.network.present).toBe(false);
    expect(result.modules.app.present).toBe(true);
  });

  it("keeps every capability bit distinct", () => {
    const bits = Object.values(CAPACITOR_CAPABILITY_BITS);
    expect(new Set(bits).size).toBe(bits.length);
  });
});
