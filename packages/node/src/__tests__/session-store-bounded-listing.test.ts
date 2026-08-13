// A store listing that cannot see the caller's bound cannot act on it. It has to enumerate every
// session that exists, pay realpath containment and the `meta.json` recognition check on all of
// them, and only then let the caller throw all but the first few away. The cost of the answer is
// then a function of the store's size no matter how little of it the caller wanted.
//
// This file pins the bounded capability that replaces that, and — far more importantly — pins the
// invariants that must survive it. Stopping early is the one change most likely to silently skip a
// security check, because a check that runs on entries you never reach is a check that never runs.
// So every containment guard the unbounded listing performs is asserted HERE, against the BOUNDED
// listing, with the escaping entry placed where the bound would otherwise walk straight past it:
//
//   (a) the bounded listing returns the N most recent by a defined TOTAL order, identically on
//       every call, so two runs over one store select the same sessions;
//   (b) a symlinked directory entry is not returned;
//   (c) a directory whose realpath escapes the output root is not returned — by a symlink to an
//       outside directory, and by a relative `../` escape;
//   (d) a directory with no `meta.json`, and one whose `meta.json` is a symlink, are not sessions;
//   (e) the early stop is REAL: with a bound of N over a store of M >> N, the containment and
//       recognition work is performed on materially fewer than M directories. The assertion is
//       about work NOT DONE, counted, never about elapsed time;
//   (f) the unbounded listing is unchanged.
//
// Every fixture is synthetic and built here. No captured corpus, scenario or ground-truth file is
// consulted, and no name below refers to one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { measureDetectorPrevalence } from "../detector-prevalence";
import {
  FilesystemSessionStore,
  compareSessionDirsByRecencyDescending,
} from "../session-store";

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function newRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "store-bounded-listing-"));
  scratch.push(root);
  return root;
}

/** A session at `{root}/local/an-app/{date}/{id}`, holding only what recognition looks at. */
function writeSession(root: string, date: string, id: string): string {
  const dir = path.join(root, "local", "an-app", date, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id }));
  return fs.realpathSync(dir);
}

/** A directory in the partition tree that is NOT a session. */
function writeNonSession(root: string, date: string, id: string): string {
  const dir = path.join(root, "local", "an-app", date, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const store = new FilesystemSessionStore();

async function bounded(root: string, limit: number): Promise<string[]> {
  return (await store.listSessions(root, { limit })).map(({ dir }) =>
    fs.realpathSync(dir),
  );
}

async function unbounded(root: string): Promise<string[]> {
  return (await store.listSessions(root)).map(({ dir }) =>
    fs.realpathSync(dir),
  );
}

describe("bounded session listing", () => {
  it("returns the N most recent by the defined total order, across date partitions", async () => {
    const root = newRoot();
    // Interleaved on purpose: creation order, and therefore filesystem order, must not be what
    // decides the answer.
    writeSession(root, "2026-01-05", "ses_c");
    const newestB = writeSession(root, "2026-03-09", "ses_b");
    writeSession(root, "2026-01-05", "ses_a");
    const newestA = writeSession(root, "2026-03-09", "ses_z");
    const middle = writeSession(root, "2026-02-01", "ses_m");
    writeSession(root, "2026-01-05", "ses_b");

    expect(await bounded(root, 3)).toEqual([newestA, newestB, middle]);
  });

  it("selects the same sessions on every call, over a store the filesystem may order freely", async () => {
    const root = newRoot();
    for (let i = 0; i < 40; i += 1) {
      const day = `2026-04-${String((i % 20) + 1).padStart(2, "0")}`;
      writeSession(root, day, `ses_${String(i).padStart(3, "0")}`);
    }
    const first = await bounded(root, 7);
    expect(first).toHaveLength(7);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await bounded(root, 7)).toEqual(first);
    }
    // And the selection is genuinely the head of the total order over the whole store, not merely
    // stable: sorting everything and slicing has to agree.
    const all = await unbounded(root);
    expect(first).toEqual(
      [...all].sort(compareSessionDirsByRecencyDescending).slice(0, 7),
    );
  });

  it("returns everything, in the unbounded set, when the bound exceeds the store", async () => {
    const root = newRoot();
    const a = writeSession(root, "2026-05-01", "ses_a");
    const b = writeSession(root, "2026-05-02", "ses_b");
    expect(new Set(await bounded(root, 50))).toEqual(new Set([a, b]));
    expect(new Set(await unbounded(root))).toEqual(new Set([a, b]));
  });

  it("returns nothing for a non-positive bound", async () => {
    const root = newRoot();
    writeSession(root, "2026-05-01", "ses_a");
    expect(await bounded(root, 0)).toEqual([]);
    expect(await bounded(root, -1)).toEqual([]);
  });
});

describe("bounded session listing containment", () => {
  it("does not return a symlinked directory entry", async () => {
    const root = newRoot();
    const real = writeSession(root, "2026-06-01", "ses_real");
    // A symlink to a genuine session INSIDE the store: the target is contained, so only the
    // symlink-entry rejection can keep it out. Named to sort FIRST, so a bound of one has to
    // reach it and refuse it rather than never look.
    const link = path.join(root, "local", "an-app", "2026-06-01", "ses_zzz");
    fs.symlinkSync(real, link, "dir");

    expect(await bounded(root, 1)).toEqual([real]);
    expect(await bounded(root, 10)).toEqual([real]);
    expect(await unbounded(root)).toEqual([real]);
  });

  it("does not return a directory whose realpath escapes the output root via a symlink", async () => {
    const root = newRoot();
    const outside = newRoot();
    const smuggled = path.join(outside, "ses_outside");
    fs.mkdirSync(smuggled, { recursive: true });
    fs.writeFileSync(
      path.join(smuggled, "meta.json"),
      JSON.stringify({ id: "ses_outside" }),
    );
    // The escape hides UNDER a partition directory whose own name sorts newest, and the escaping
    // entry sorts first within it, so a bound of one selects it before any honest session.
    const partition = path.join(root, "local", "an-app", "2099-12-31");
    fs.mkdirSync(partition, { recursive: true });
    fs.symlinkSync(smuggled, path.join(partition, "ses_zzz"), "dir");
    const honest = writeSession(root, "2026-06-02", "ses_honest");

    expect(await bounded(root, 1)).toEqual([honest]);
    expect(await bounded(root, 10)).toEqual([honest]);
    expect(await unbounded(root)).toEqual([honest]);
  });

  it("does not return a directory reached through a relative ../ escape", async () => {
    const root = newRoot();
    const outside = newRoot();
    const smuggled = path.join(outside, "ses_relative");
    fs.mkdirSync(smuggled, { recursive: true });
    fs.writeFileSync(
      path.join(smuggled, "meta.json"),
      JSON.stringify({ id: "ses_relative" }),
    );
    const partition = path.join(root, "local", "an-app", "2099-12-31");
    fs.mkdirSync(partition, { recursive: true });
    // Purely relative: nothing in the link text names a path outside the store, so only resolving
    // it and comparing the REALPATH can reject it.
    fs.symlinkSync(
      path.relative(partition, smuggled),
      path.join(partition, "ses_zzz"),
      "dir",
    );
    const honest = writeSession(root, "2026-06-03", "ses_honest");

    expect(await bounded(root, 1)).toEqual([honest]);
    expect(await unbounded(root)).toEqual([honest]);
  });

  it("does not return a session whose parent partition escapes the output root", async () => {
    // The escaping link is an ANCESTOR, not the candidate: the candidate's own realpath test can
    // pass while the directory it was reached through points anywhere at all. The unbounded walk
    // got this for free by refusing to descend; a listing that does not descend has to check it.
    const root = newRoot();
    const outside = newRoot();
    const smuggled = path.join(outside, "2099-12-31", "ses_zzz");
    fs.mkdirSync(smuggled, { recursive: true });
    fs.writeFileSync(
      path.join(smuggled, "meta.json"),
      JSON.stringify({ id: "ses_zzz" }),
    );
    const app = path.join(root, "local", "an-app");
    fs.mkdirSync(app, { recursive: true });
    fs.symlinkSync(
      path.join(outside, "2099-12-31"),
      path.join(app, "2099-12-31"),
      "dir",
    );
    const honest = writeSession(root, "2026-06-04", "ses_honest");

    expect(await bounded(root, 1)).toEqual([honest]);
    expect(await bounded(root, 10)).toEqual([honest]);
    expect(await unbounded(root)).toEqual([honest]);
  });

  // The dirent symlink bit is the FIRST line of defence and the cheapest, so on an ordinary
  // filesystem it is what rejects every escape above. Realpath containment is the SECOND line, and
  // it exists precisely because that bit is not always available: a filesystem that reports
  // DT_UNKNOWN leaves Node no type to hand back. These two tests take that bit away — the dirent
  // claims a real directory — so that only resolving the path and comparing it can refuse the entry.
  // Without them the boundary the bound is most likely to skip would be asserted by nothing.
  function lieAboutDirentType(names: Set<string>) {
    const realReaddir = fs.readdirSync.bind(fs);
    return vi.spyOn(fs, "readdirSync").mockImplementation(((
      target: fs.PathLike,
      options?: never,
    ) => {
      const entries = realReaddir(target, options) as unknown;
      if (!Array.isArray(entries)) return entries as never;
      return entries.map((raw) => {
        const entry = raw as fs.Dirent;
        if (typeof raw === "string" || !names.has(entry.name)) return entry;
        return Object.create(entry, {
          isSymbolicLink: { value: () => false },
          isDirectory: { value: () => true },
        }) as fs.Dirent;
      }) as never;
    }) as never);
  }

  it("rejects an entry the dirent calls a real directory when its realpath escapes the store", async () => {
    const root = newRoot();
    const outside = newRoot();
    const smuggled = path.join(outside, "ses_outside");
    fs.mkdirSync(smuggled, { recursive: true });
    fs.writeFileSync(
      path.join(smuggled, "meta.json"),
      JSON.stringify({ id: "ses_outside" }),
    );
    const partition = path.join(root, "local", "an-app", "2099-12-31");
    fs.mkdirSync(partition, { recursive: true });
    fs.symlinkSync(smuggled, path.join(partition, "ses_zzz"), "dir");
    const honest = writeSession(root, "2026-06-06", "ses_honest");

    const spy = lieAboutDirentType(new Set(["ses_zzz"]));
    try {
      expect(await bounded(root, 1)).toEqual([honest]);
      expect(await bounded(root, 10)).toEqual([honest]);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects a session reached through an ancestor whose realpath escapes, even when the session's own realpath does not", async () => {
    // The case the candidate's own containment check cannot see: an ancestor that resolves OUTSIDE
    // the store, whose child resolves back INSIDE it. The unbounded walk got this for free by
    // refusing to descend past the ancestor; a listing that stops early never descends at all, so
    // it has to check the chain explicitly or hand back a session through an escaped path.
    const root = newRoot();
    const honest = writeSession(root, "2026-06-07", "ses_honest");
    const partition = path.join(root, "local", "an-app", "2099-12-31");
    fs.mkdirSync(partition, { recursive: true });
    // Resolves to the store's PARENT — outside — but `<hop>/<store name>` resolves to the store.
    fs.symlinkSync(path.dirname(root), path.join(partition, "hop"), "dir");

    const spy = lieAboutDirentType(new Set(["hop"]));
    try {
      expect(await bounded(root, 5)).toEqual([honest]);
      expect(await unbounded(root)).toEqual([honest]);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not return a directory without meta.json, or one whose meta.json is a symlink", async () => {
    const root = newRoot();
    const honest = writeSession(root, "2026-06-05", "ses_honest");
    // Both decoys sort ahead of the honest session, so a bound of one must reject them, not miss
    // them.
    writeNonSession(root, "2099-12-31", "ses_bare");
    const linked = writeNonSession(root, "2099-12-30", "ses_linked_meta");
    fs.symlinkSync(
      path.join(honest, "meta.json"),
      path.join(linked, "meta.json"),
    );

    expect(await bounded(root, 1)).toEqual([honest]);
    expect(await bounded(root, 10)).toEqual([honest]);
    expect(await unbounded(root)).toEqual([honest]);
  });
});

describe("bounded session listing stops early", () => {
  it("performs containment and recognition on materially fewer directories than the store holds", async () => {
    const root = newRoot();
    const total = 400;
    const bound = 20;
    for (let i = 0; i < total; i += 1) {
      const day = `2026-07-${String((i % 28) + 1).padStart(2, "0")}`;
      writeSession(root, day, `ses_${String(i).padStart(4, "0")}`);
    }

    // Containment and recognition are exactly the calls that resolve or stat a path: realpath for
    // the boundary check, lstat/realpath inside the meta.json recognition check. Count the DISTINCT
    // session directories any of them touched — that is the work, and it is what the bound is
    // supposed to not do. Wall-clock is not asserted anywhere: it is not reproducible in CI.
    const touched = new Set<string>();
    const record = (target: unknown): void => {
      if (typeof target !== "string") return;
      const match = /(ses_\d{4})/.exec(target);
      if (match) touched.add(match[1] as string);
    };
    const realRealpath = fs.realpathSync.bind(fs);
    const realLstat = fs.lstatSync.bind(fs);
    const realpathWrapped = vi.spyOn(fs, "realpathSync").mockImplementation(((
      p: fs.PathLike,
      opts?: never,
    ) => {
      record(p);
      return realRealpath(p, opts) as never;
    }) as never);
    const lstatWrapped = vi.spyOn(fs, "lstatSync").mockImplementation(((
      p: fs.PathLike,
      opts?: never,
    ) => {
      record(p);
      return realLstat(p, opts) as never;
    }) as never);

    let boundedTouched: number;
    let boundedResult: Array<{ id: string; dir: string }>;
    let unboundedTouched: number;
    try {
      touched.clear();
      boundedResult = await store.listSessions(root, { limit: bound });
      boundedTouched = touched.size;

      touched.clear();
      await store.listSessions(root);
      unboundedTouched = touched.size;
    } finally {
      realpathWrapped.mockRestore();
      lstatWrapped.mockRestore();
    }

    // The bound was honoured...
    expect(boundedResult.length).toBe(bound);
    // ...the unbounded listing did the work on every session in the store...
    expect(unboundedTouched).toBe(total);
    // ...and the bounded one did it on the sessions it returned, and essentially nothing else.
    expect(boundedTouched).toBeLessThanOrEqual(bound + 2);
    expect(boundedTouched).toBeLessThan(total / 4);
  });
});

describe("a cap pushed into the store still knows when it bit", () => {
  it("reports truncation when the store holds exactly one prior more than the cap and the current session sorts inside the window", async () => {
    // The discriminating case for how large a bounded listing a capped scan has to ask for. The
    // decision is `priors > cap`, so the listing must be able to surface cap+1 PRIORS — and the
    // current session, excluded from its own base rate, can occupy one of the returned slots. Ask
    // for one too few and a store that really did overflow reports that it did not, which is the
    // one failure this disclosure exists to prevent.
    const root = newRoot();
    const cap = 3;
    const dirs: string[] = [];
    for (let i = 1; i <= cap + 2; i += 1) {
      dirs.push(
        writeSession(root, "2026-09-01", `ses_${String(i).padStart(2, "0")}`),
      );
    }
    // Fourth-newest by the total order, i.e. inside the first cap+1 the listing would return.
    const self = dirs[1] as string;

    const measured = await measureDetectorPrevalence({
      sessionDir: self,
      corpusRoot: root,
      minPriorSessions: 1,
      maxScannedSessions: cap,
    });

    expect(measured?.priorSessions).toBe(cap);
    expect(measured?.truncated).toBe(true);
  });

  it("reports no truncation when the store holds exactly the cap in priors", async () => {
    const root = newRoot();
    const cap = 3;
    const dirs: string[] = [];
    for (let i = 1; i <= cap + 1; i += 1) {
      dirs.push(
        writeSession(root, "2026-09-02", `ses_${String(i).padStart(2, "0")}`),
      );
    }
    const measured = await measureDetectorPrevalence({
      sessionDir: dirs[1] as string,
      corpusRoot: root,
      minPriorSessions: 1,
      maxScannedSessions: cap,
    });

    expect(measured?.priorSessions).toBe(cap);
    expect(measured?.truncated).toBe(false);
  });
});

describe("unbounded session listing", () => {
  it("still returns every session in a multi-partition store", async () => {
    const root = newRoot();
    const expected = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      expected.add(
        writeSession(
          root,
          `2026-08-${String(i + 1).padStart(2, "0")}`,
          `ses_${i}`,
        ),
      );
    }
    writeNonSession(root, "2026-08-01", "not_a_session");
    expect(new Set(await unbounded(root))).toEqual(expected);
    expect((await unbounded(root)).length).toBe(12);
  });

  it("returns an empty listing for a store that does not exist", async () => {
    expect(await unbounded(path.join(newRoot(), "nope"))).toEqual([]);
  });
});
