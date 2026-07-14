import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { FilesystemSessionStore } from "../session-store";

// Unit tests for the write-plane primitives implemented in checkpoint 2a.
// These lock the behaviour so the (later) R2 adapter can be held to the same contract.
describe("FilesystemSessionStore write plane", () => {
  let tmpDir: string;
  const store = new FilesystemSessionStore();
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-store-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("createSessionDir", () => {
    it("creates the directory with 0700 mode (POSIX)", () => {
      const dir = path.join(tmpDir, "staging", "ses_1");
      const returned = store.createSessionDir(dir);
      expect(returned).toBe(dir);
      const stat = fs.statSync(dir);
      expect(stat.isDirectory()).toBe(true);
      if (process.platform !== "win32") {
        expect(stat.mode & 0o777).toBe(0o700);
      }
    });
  });

  describe("appendEvents / readArtifact", () => {
    it("round-trips appended events through readArtifact", () => {
      const events = [
        { t: 1, k: "a", d: {} },
        { t: 2, k: "b", d: { key: "value" } },
      ];
      const result = store.appendEvents(tmpDir, events);
      expect(result).toMatchObject({
        accepted: 2,
        dropped: 0,
        truncated: false,
      });

      const buf = store.readArtifact(tmpDir, "events.ndjson");
      expect(buf).toBeInstanceOf(Buffer);
      const lines = (buf as Buffer).toString("utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1])).toEqual(events[1]);
    });

    it("appends to an existing file rather than overwriting", () => {
      store.appendEvents(tmpDir, [{ t: 1, k: "a", d: {} }]);
      store.appendEvents(tmpDir, [{ t: 2, k: "b", d: {} }]);
      const lines = (store.readArtifact(tmpDir, "events.ndjson") as Buffer)
        .toString("utf-8")
        .trim()
        .split("\n");
      expect(lines).toHaveLength(2);
    });

    it("stops at the byte cap and writes a truncation marker", () => {
      const first = { t: 1, k: "a", d: { msg: "fits" } };
      const second = {
        t: 2,
        k: "b",
        d: { msg: "dropped once the cap is reached" },
      };
      const firstLineBytes = Buffer.byteLength(
        `${JSON.stringify(first)}\n`,
        "utf-8",
      );

      const result = store.appendEvents(tmpDir, [first, second], {
        maxEventBytes: firstLineBytes + 1,
      });
      expect(result).toMatchObject({
        accepted: 1,
        dropped: 1,
        truncated: true,
      });
      const marker = JSON.parse(
        (
          store.readArtifact(tmpDir, "capture-truncated.json") as Buffer
        ).toString("utf-8"),
      );
      expect(marker).toMatchObject({
        truncated: true,
        reason: "session_event_bytes_cap",
        eventsAccepted: 1,
        eventsDropped: 1,
      });
    });

    it("returns undefined reading a missing artifact", () => {
      expect(store.readArtifact(tmpDir, "nope.json")).toBeUndefined();
    });
  });

  describe("writeArtifact", () => {
    it("writes atomically (no leftover tmp files) and reads back", () => {
      store.writeArtifact(tmpDir, "index.json", '{"ok":true}');
      expect(
        (store.readArtifact(tmpDir, "index.json") as Buffer).toString("utf-8"),
      ).toBe('{"ok":true}');
      const leftover = fs.readdirSync(tmpDir).filter((n) => n.endsWith(".tmp"));
      expect(leftover).toHaveLength(0);
    });

    it("rejects an unsafe artifact name", () => {
      expect(() => store.writeArtifact(tmpDir, "../escape.json", "x")).toThrow(
        /Invalid generated artifact name/,
      );
      expect(() =>
        store.writeArtifact(tmpDir, "nested/name.json", "x"),
      ).toThrow(/Invalid generated artifact name/);
    });

    it("refuses to overwrite a symlinked artifact target", () => {
      const outside = path.join(tmpDir, "outside.txt");
      fs.writeFileSync(outside, "original");
      fs.symlinkSync(outside, path.join(tmpDir, "index.json"));
      expect(() => store.writeArtifact(tmpDir, "index.json", "x")).toThrow();
      expect(fs.readFileSync(outside, "utf-8")).toBe("original");
    });
  });

  describe("writeBlob / statArtifact", () => {
    it("writes binary data and reports its size", () => {
      const data = Buffer.from([0x00, 0x01, 0x02, 0xff]);
      store.writeBlob(tmpDir, "recording.webm", data);
      expect(
        Buffer.compare(
          store.readArtifact(tmpDir, "recording.webm") as Buffer,
          data,
        ),
      ).toBe(0);
      const stat = store.statArtifact(tmpDir, "recording.webm");
      expect(stat).toEqual({ bytes: 4, isDir: false });
    });

    it("refuses to write through a symlinked blob path", () => {
      const outside = path.join(tmpDir, "outside.bin");
      fs.writeFileSync(outside, "original");
      fs.symlinkSync(outside, path.join(tmpDir, "recording.webm"));
      expect(() =>
        store.writeBlob(tmpDir, "recording.webm", Buffer.from("x")),
      ).toThrow();
      expect(fs.readFileSync(outside, "utf-8")).toBe("original");
    });

    it("returns undefined stat for a missing artifact", () => {
      expect(store.statArtifact(tmpDir, "nope")).toBeUndefined();
    });
  });

  describe("listArtifacts", () => {
    it("lists immediate file entries and skips symlinks", () => {
      store.writeArtifact(tmpDir, "meta.json", "{}");
      store.writeArtifact(tmpDir, "index.json", "{}");
      fs.symlinkSync(
        path.join(tmpDir, "meta.json"),
        path.join(tmpDir, "link.json"),
      );
      const names = store.listArtifacts(tmpDir).sort();
      expect(names).toContain("meta.json");
      expect(names).toContain("index.json");
      expect(names).not.toContain("link.json");
    });

    it("returns empty for a missing directory", () => {
      expect(store.listArtifacts(path.join(tmpDir, "nope"))).toEqual([]);
    });
  });

  describe("moveToPartition", () => {
    it("atomically renames staging into the partition target", () => {
      const staging = path.join(tmpDir, ".sessions", "ses_1");
      fs.mkdirSync(staging, { recursive: true });
      fs.writeFileSync(path.join(staging, "meta.json"), '{"id":"ses_1"}');
      const target = path.join(tmpDir, "acme", "shop", "2026-06-30", "ses_1");
      fs.mkdirSync(path.dirname(target), { recursive: true });

      const returned = store.moveToPartition(staging, target);
      expect(returned).toBe(target);
      expect(fs.existsSync(staging)).toBe(false);
      expect(fs.readFileSync(path.join(target, "meta.json"), "utf-8")).toBe(
        '{"id":"ses_1"}',
      );
    });
  });

  describe("resolveSessionDir", () => {
    it("resolves a bare id in the finalized partition layout (whole-tree)", () => {
      const id = "ses_123";
      const partDir = path.join(tmpDir, "acme", "shop", "2026-06-30", id);
      fs.mkdirSync(partDir, { recursive: true });
      fs.writeFileSync(path.join(partDir, "meta.json"), JSON.stringify({ id }));
      expect(store.resolveSessionDir(id, tmpDir)).toBe(partDir);
    });

    it("falls back to the flat path for a missing session", () => {
      expect(store.resolveSessionDir("nope", tmpDir)).toBe(
        path.join(tmpDir, "nope"),
      );
    });

    it("scoped lookup finds only within the tenant/app and never escapes", () => {
      const id = "s-here";
      const dir = path.join(tmpDir, "ten_a", "proj_a", "2026-06-30", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "meta.json"), "{}");

      expect(
        store.resolveSessionDir(id, tmpDir, { tenant: "ten_a", app: "proj_a" }),
      ).toBe(dir);
      // A different tenant must not resolve into ten_a's tree.
      const otherTenant = store.resolveSessionDir(id, tmpDir, {
        tenant: "ten_other",
        app: "proj_a",
      });
      expect(otherTenant).not.toContain("ten_a");
      // Traversal id is rejected by segment validation.
      const escape = store.resolveSessionDir("../../escape", tmpDir, {
        tenant: "ten_a",
        app: "proj_a",
      });
      expect(escape).not.toContain("escape/");
    });
  });

  describe("resolveScopedSessionDir (cloud isolation contract)", () => {
    it("returns the dir within tenant/app, else undefined (never a fallback or cross-tenant)", () => {
      const id = "s-here";
      const dir = path.join(tmpDir, "ten_a", "proj_a", "2026-06-30", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "meta.json"), "{}");

      expect(store.resolveScopedSessionDir(tmpDir, "ten_a", "proj_a", id)).toBe(
        dir,
      );
      // Miss => undefined, not a fallback path.
      expect(
        store.resolveScopedSessionDir(tmpDir, "ten_a", "proj_a", "missing"),
      ).toBeUndefined();
      // Different tenant never reaches ten_a's tree.
      expect(
        store.resolveScopedSessionDir(tmpDir, "ten_other", "proj_a", id),
      ).toBeUndefined();
      // Traversal args rejected.
      expect(
        store.resolveScopedSessionDir(
          tmpDir,
          "ten_a",
          "proj_a",
          "../../escape",
        ),
      ).toBeUndefined();
    });
  });

  describe("deleteSessionDir", () => {
    it("recursively deletes a session directory", () => {
      const dir = path.join(tmpDir, "ses_del");
      fs.mkdirSync(path.join(dir, "frames"), { recursive: true });
      fs.writeFileSync(path.join(dir, "meta.json"), "{}");
      store.deleteSessionDir(dir);
      expect(fs.existsSync(dir)).toBe(false);
    });

    it("is a no-op for a missing directory", () => {
      expect(() =>
        store.deleteSessionDir(path.join(tmpDir, "gone")),
      ).not.toThrow();
    });

    it("refuses to delete through a symlink", () => {
      const real = path.join(tmpDir, "real");
      fs.mkdirSync(real);
      fs.writeFileSync(path.join(real, "keep.txt"), "x");
      const link = path.join(tmpDir, "link");
      fs.symlinkSync(real, link);
      expect(() => store.deleteSessionDir(link)).toThrow(/symlink/);
      expect(fs.existsSync(path.join(real, "keep.txt"))).toBe(true);
    });
  });
});
