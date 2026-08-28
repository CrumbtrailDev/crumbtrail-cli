import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRecallStore } from "../recall";
import { normalizePartitionSegment } from "../session-store";

/**
 * `buildRecallStore` is what the inner `/api/solve-context` endpoint and the MCP
 * recall tool both locate against. These tests exercise it over a REAL partition
 * tree on disk — `{outputDir}/{tenant}/{app}/{date}/{sessionId}` — because the
 * narrowing is the root of the walk, and a fake store cannot show that an
 * out-of-scope session was never enumerated rather than merely filtered out.
 */

let outputDir: string;

/** Write one finalized session into its partition. A session directory is
 *  recognised by a plain `meta.json`, which is all `listSessions` requires. */
function writeSession(
  tenant: string,
  app: string,
  sessionId: string,
  meta: Record<string, unknown> = {},
): string {
  const dir = path.join(outputDir, tenant, app, "2026-08-20", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ tenant, app, ...meta }),
  );
  return dir;
}

async function idsFor(scope?: { tenantId: string; projectId?: string }) {
  const store = buildRecallStore(outputDir);
  const sessions = await store.listSessions(scope);
  return sessions.map((s) => s.id).sort();
}

beforeEach(() => {
  outputDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "crumbtrail-recall-scope-"),
  );
});

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true });
});

describe("buildRecallStore — scoped listing", () => {
  beforeEach(() => {
    writeSession("tenant-a", "shop", "sess-a-shop");
    writeSession("tenant-a", "admin", "sess-a-admin");
    writeSession("tenant-b", "shop", "sess-b-shop");
  });

  it("returns every session when no scope is given — the self-hosted model", async () => {
    expect(await idsFor()).toEqual([
      "sess-a-admin",
      "sess-a-shop",
      "sess-b-shop",
    ]);
  });

  it("roots the walk at the tenant so another tenant is never enumerated", async () => {
    expect(await idsFor({ tenantId: "tenant-a" })).toEqual([
      "sess-a-admin",
      "sess-a-shop",
    ]);
  });

  it("roots the walk at one application inside the tenant", async () => {
    expect(await idsFor({ tenantId: "tenant-a", projectId: "shop" })).toEqual([
      "sess-a-shop",
    ]);
  });

  it("derives the partition name the same way the writer did", async () => {
    writeSession("acme-inc", "shop", "sess-norm");
    // The caller holds the raw tenant id; the directory is the normalised form.
    expect(await idsFor({ tenantId: "ACME  Inc" })).toEqual(["sess-norm"]);
  });

  it("answers with nothing, never the whole store, for an unusable tenant id", async () => {
    // Widening on a bad id is the failure that reads like a working request and
    // ranks a ticket over every tenant in the store.
    expect(await idsFor({ tenantId: "   " })).toEqual([]);
    expect(await idsFor({ tenantId: "///" })).toEqual([]);
    expect(await idsFor({ tenantId: "tenant-a", projectId: "!!!" })).toEqual(
      [],
    );
  });

  it("answers with nothing for a tenant that has captured nothing", async () => {
    expect(await idsFor({ tenantId: "tenant-z" })).toEqual([]);
  });

  it("cannot be walked out of its partition with a traversal segment", async () => {
    expect(await idsFor({ tenantId: ".." })).toEqual([]);
    expect(await idsFor({ tenantId: "../tenant-b" })).toEqual([]);
    expect(
      await idsFor({ tenantId: "tenant-a", projectId: "../../tenant-b" }),
    ).toEqual([]);
  });
});

describe("normalizePartitionSegment", () => {
  it("matches the segment the finalizer writes", () => {
    expect(normalizePartitionSegment("Acme Inc")).toBe("acme-inc");
    expect(normalizePartitionSegment("  Tenant_A  ")).toBe("tenant_a");
    expect(normalizePartitionSegment(42)).toBe("42");
    expect(normalizePartitionSegment("a".repeat(120))).toHaveLength(80);
  });

  it("refuses a value that cannot be a segment rather than substituting one", () => {
    // The writer falls back to `local`; a reader NARROWING to a tenant must get
    // nothing, or an unusable id would silently address someone else's data.
    expect(normalizePartitionSegment("")).toBeUndefined();
    expect(normalizePartitionSegment("   ")).toBeUndefined();
    expect(normalizePartitionSegment("..")).toBeUndefined();
    expect(normalizePartitionSegment("/")).toBeUndefined();
    expect(normalizePartitionSegment("/../")).toBeUndefined();
    expect(normalizePartitionSegment(undefined)).toBeUndefined();
    expect(normalizePartitionSegment(null)).toBeUndefined();
    expect(normalizePartitionSegment({ tenantId: "a" })).toBeUndefined();
  });

  it("can only ever produce one inert path segment", () => {
    // The separators are what would make a value traversing; they are collapsed
    // to dashes, so a hostile id becomes a directory name that simply does not
    // exist rather than a way out of the partition.
    for (const hostile of ["../..", "a/../../b", "..\\..", "  ../  "]) {
      const segment = normalizePartitionSegment(hostile);
      if (segment === undefined) continue;
      expect(segment).not.toContain("/");
      expect(segment).not.toContain("\\");
      expect(segment).not.toBe(".");
      expect(segment).not.toBe("..");
    }
  });
});

/**
 * The doctor probe exclusion belongs to the STORE, not to each tool that reads
 * it. `getLatestIssue` filtered probes and recall did not, so the health check
 * Crumbtrail recommends running seeded the issue memory it sells. Pinning it
 * here means a new recall caller inherits the exclusion instead of having to
 * remember it.
 */
describe("buildRecallStore — doctor probe exclusion", () => {
  it("never lists a doctor probe session, scoped or unscoped", async () => {
    writeSession("tenant-a", "shop", "sess-a-shop");
    writeSession("tenant-a", "shop", "ses_probe_http");
    writeSession("tenant-a", "shop", "ses_otlp_probe_traces");

    expect(await idsFor()).toEqual(["sess-a-shop"]);
    expect(await idsFor({ tenantId: "tenant-a" })).toEqual(["sess-a-shop"]);
    expect(await idsFor({ tenantId: "tenant-a", projectId: "shop" })).toEqual([
      "sess-a-shop",
    ]);
  });
});
