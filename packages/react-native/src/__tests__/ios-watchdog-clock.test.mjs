import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const packages = fileURLToPath(new URL("../../../", import.meta.url));

describe.skipIf(process.platform !== "darwin")("iOS watchdog clocks", () => {
  it("clamps a newer Flutter heartbeat after an older timer sample", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "crumbtrail-watchdog-swift-"));
    try {
      const main = path.join(directory, "main.swift");
      writeFileSync(main, `
let sampledNow: UInt64 = 10_000_000_000
var heartbeat: UInt64 = 1_000_000_000
precondition(CrumbtrailWatchdogClock.elapsedMilliseconds(now: sampledNow, heartbeat: heartbeat) == 9000)
heartbeat = sampledNow + 1
precondition(CrumbtrailWatchdogClock.elapsedMilliseconds(now: sampledNow, heartbeat: heartbeat) == 0)
precondition(CrumbtrailWatchdogClock.elapsedMilliseconds(now: heartbeat, heartbeat: heartbeat) == 0)
precondition(CrumbtrailWatchdogClock.elapsedMilliseconds(now: UInt64.max, heartbeat: 0) == 86_400_000)
`);
      const executable = path.join(directory, "clock");
      execFileSync("xcrun", ["swiftc", path.join(packages, "flutter/ios/Classes/CrumbtrailWatchdogClock.swift"), main, "-o", executable]);
      execFileSync(executable);
      execFileSync("xcrun", ["swiftc", "-frontend", "-parse", path.join(packages, "flutter/ios/Classes/CrumbtrailFlutterPlugin.swift")]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("clamps a newer React Native heartbeat and bounds timebase conversion", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "crumbtrail-watchdog-objc-"));
    try {
      const main = path.join(directory, "main.m");
      writeFileSync(main, `
#include <assert.h>
#include "CrumbtrailWatchdogClock.h"
int main(void) {
  uint64_t sampledNow = 10000000000ULL;
  uint64_t heartbeat = 1000000000ULL;
  assert(CTWatchdogElapsedMilliseconds(sampledNow, heartbeat, 1, 1) == 9000);
  heartbeat = sampledNow + 1;
  assert(CTWatchdogElapsedMilliseconds(sampledNow, heartbeat, 1, 1) == 0);
  assert(CTWatchdogElapsedMilliseconds(heartbeat, heartbeat, 1, 1) == 0);
  assert(CTWatchdogElapsedMilliseconds(3000000, 0, 125, 3) == 125);
  assert(CTWatchdogElapsedMilliseconds(UINT64_MAX, 0, UINT32_MAX, 1) == 86400000);
  assert(CTWatchdogElapsedMilliseconds(sampledNow, 0, 1, 0) == 0);
  return 0;
}
`);
      const executable = path.join(directory, "clock");
      execFileSync("xcrun", ["clang", "-Wall", "-Wextra", "-Werror", "-I", path.join(packages, "react-native/ios"), main, "-o", executable]);
      execFileSync(executable);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
