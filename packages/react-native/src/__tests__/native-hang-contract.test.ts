import { describe, expect, it } from "vitest";
import { NATIVE_HANG_EVENT_KIND, type NativeHangEventData } from "../index";

describe("React Native native-hang wire contract", () => {
  it("exposes the shared kind without claiming a collector", () => {
    const data: NativeHangEventData = {
      source: "js",
      thresholdMs: 2000,
      observedDurationMs: 2300,
      recovered: true,
      previousLaunch: false,
    };

    expect(NATIVE_HANG_EVENT_KIND).toBe("native-hang");
    expect(data.source).toBe("js");
  });
});
