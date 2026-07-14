import { describe, expect, it } from "vitest";
import {
  CRUMBTRAIL_EVENT_KINDS,
  CRUMBTRAIL_SCHEMA_VERSION,
  type BugEvent,
  type TargetDescriptor,
} from "../index";

describe("mobile-compatible event contract", () => {
  it("requires at least one planned target identity field at compile time", () => {
    // @ts-expect-error Empty targets do not identify a web/mobile target.
    const emptyTarget: TargetDescriptor = {};
    // @ts-expect-error Bounds are optional geometry, not a target identity.
    const boundsOnlyTarget: TargetDescriptor = {
      bounds: { x: 0, y: 0, width: 100, height: 44 },
    };
    const labelTarget: TargetDescriptor = { label: "Submit order" };

    expect(labelTarget.label).toBe("Submit order");
    expect(emptyTarget).toEqual({});
    expect(boundsOnlyTarget.bounds?.width).toBe(100);
  });

  it("keeps existing web events valid without platform metadata", () => {
    const event: BugEvent = { t: 1000, k: "nav", d: { to: "/checkout" } };

    expect(event.platform ?? "web").toBe("web");
    expect(event.k).toBe("nav");
  });

  it("types mobile envelope metadata and neutral event kinds", () => {
    const target: TargetDescriptor = {
      role: "button",
      label: "Submit order",
      testID: "checkout-submit",
      accessibilityId: "checkout.submit",
      componentName: "Pressable",
      routePath: "/checkout",
      ancestryHash: "rn:checkout:footer:primary",
      bounds: { x: 12, y: 24, width: 160, height: 44 },
    };

    const event: BugEvent = {
      schemaVersion: CRUMBTRAIL_SCHEMA_VERSION,
      platform: "react-native",
      sdk: { name: "@crumbtrail/react-native", version: "0.1.0" },
      capabilities: ["navigation", "view-snapshot", "native-crash"],
      t: 1100,
      k: CRUMBTRAIL_EVENT_KINDS.viewSnapshot,
      target,
      d: { screen: "Checkout", target },
    };

    expect(event.platform).toBe("react-native");
    expect(event.k).toBe("view-snapshot");
    expect(event.target?.testID).toBe("checkout-submit");
    expect(event.target?.accessibilityId).toBe("checkout.submit");
  });
});
