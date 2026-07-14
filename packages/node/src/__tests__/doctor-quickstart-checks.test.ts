import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkBrowserSessions,
  checkClientWiring,
  countBrowserSessions,
} from "../doctor";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const mkTmp = () =>
  (tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-qs-")));

describe("checkClientWiring", () => {
  it("warns when no crumbtrail.client.js exists", () => {
    const dir = mkTmp();
    const check = checkClientWiring(dir);
    expect(check.name).toBe("client-wiring");
    expect(check.status).toBe("warn");
  });

  it("passes on a literal import specifier", () => {
    const dir = mkTmp();
    fs.writeFileSync(
      path.join(dir, "crumbtrail.client.js"),
      "export const crumbtrailReady = import('crumbtrail-core').then(({ Crumbtrail }) => Crumbtrail.init({ httpEndpoint: 'http://127.0.0.1:9898' }));\n",
    );
    expect(checkClientWiring(dir).status).toBe("pass");
  });

  it("fails on a computed import specifier with a literal-specifier remediation", () => {
    const dir = mkTmp();
    fs.writeFileSync(
      path.join(dir, "crumbtrail.client.js"),
      "const pkg = 'crumbtrail' + '-core';\nexport const p = import(pkg).then(({ Crumbtrail }) => Crumbtrail.init({}));\n",
    );
    const check = checkClientWiring(dir);
    expect(check.status).toBe("fail");
    expect(check.remediation).toMatch(/literal import\('crumbtrail-core'\)/);
  });
});

describe("browser-capture", () => {
  const finalize = (root: string, id: string) => {
    const dir = path.join(root, "tenant", "app", "2026-07-02", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), "{}");
  };

  it("counts finalized sessions across the partition layout, excluding doctor probes", () => {
    const out = mkTmp();
    finalize(out, "ses_probe_123");
    finalize(out, "ses_otlp_probe_456");
    expect(countBrowserSessions(out)).toBe(0);
    expect(checkBrowserSessions(out).status).toBe("warn");
    finalize(out, "ses_real_789");
    expect(countBrowserSessions(out)).toBe(1);
    expect(checkBrowserSessions(out).status).toBe("pass");
  });

  it("warn detail names the silent no-op failure mode", () => {
    const out = mkTmp();
    const check = checkBrowserSessions(out);
    expect(check.name).toBe("browser-capture");
    expect(check.remediation).toMatch(/silently no-op/i);
    expect(check.remediation).toMatch(/crumbtrail-core/);
  });
});
