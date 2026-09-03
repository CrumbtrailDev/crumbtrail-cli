import { describe, expect, it, vi } from "vitest";
import {
  PROBE_NAMES,
  isProbeName,
  runProbe,
  type ProbeContext,
  type ProbeStorageArea,
  type ProbeStorageLike,
} from "../probes";
import { REDACTED_STORAGE_KEY, REDACTED_VALUE } from "../redaction";

/** A minimal Web Storage stand-in with deterministic insertion order. */
function fakeStorage(entries: Array<[string, string]>): ProbeStorageLike {
  const keys = entries.map(([key]) => key);
  const map = new Map(entries);
  return {
    get length() {
      return keys.length;
    },
    key: (index: number) => keys[index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
  };
}

function areas(...list: ProbeStorageArea[]) {
  return () => list;
}

/**
 * The host process, reached through `globalThis` because this package targets the browser and
 * carries no Node type definitions.
 */
type RejectionHost = {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): void;
  off(event: "unhandledRejection", listener: (reason: unknown) => void): void;
};

/** Fails the test if any probe leaks a rejection instead of resolving to `ok: false`. */
function trapUnhandledRejections(): { seen: unknown[]; stop: () => void } {
  const host = (globalThis as unknown as { process?: RejectionHost }).process;
  // If this ever goes missing the trap would silently prove nothing, so assert it is real.
  expect(typeof host?.on).toBe("function");
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => {
    seen.push(reason);
  };
  host?.on("unhandledRejection", onRejection);
  return {
    seen,
    stop: () => host?.off("unhandledRejection", onRejection),
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const flushMicrotasks = () => delay(10);

describe("the allowlist", () => {
  it("is frozen and holds exactly the five declared probes", () => {
    expect(Object.isFrozen(PROBE_NAMES)).toBe(true);
    expect([...PROBE_NAMES]).toEqual([
      "runtime.env",
      "runtime.cpu_profile",
      "storage.snapshot",
      "network.inflight",
      "flags.current",
    ]);
  });

  it("refuses an unknown name and runs nothing", async () => {
    const getDeclaredEnv = vi.fn();
    const getState = vi.fn();
    const getStorageAreas = vi.fn();

    const result = await runProbe("heap.dump", {
      getDeclaredEnv,
      getState,
      getStorageAreas,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown probe");
    expect(result.rows).toEqual([]);
    expect(result.columns).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(getDeclaredEnv).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
    expect(getStorageAreas).not.toHaveBeenCalled();
  });

  it.each([
    "../../etc/passwd",
    "rm -rf /",
    "runtime.env; rm -rf /",
    "document.cookie",
    "$(whoami)",
    "http://evil.example/x?token=abc123def456ghi789",
  ])("refuses code shaped name %s and echoes nothing executable", async (name) => {
    const result = await runProbe(name);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown probe");
    // The echoed name is stripped to the probe-name alphabet, so no path separator, whitespace,
    // shell metacharacter or scheme survives into a stored event.
    expect(result.name).toMatch(/^[A-Za-z0-9._-]*$/);
    expect(result.name.length).toBeLessThanOrEqual(64);
  });

  it("does not normalize a near miss into an allowlisted name", async () => {
    for (const near of [
      " runtime.env",
      "runtime.env ",
      "runtime/.env",
      "RUNTIME.ENV",
      "runtime..env",
    ]) {
      expect(isProbeName(near)).toBe(false);
      const result = await runProbe(near);
      expect(result.error).toBe("unknown probe");
    }
  });

  it("refuses non-string input without throwing", async () => {
    for (const bad of [
      undefined,
      null,
      42,
      { name: "runtime.env" },
      ["runtime.env"],
    ]) {
      const result = await runProbe(bad as unknown as string);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("unknown probe");
    }
  });
});

describe("failure discipline", () => {
  it("aborts a hanging probe at the deadline and reports a timeout", async () => {
    const trap = trapUnhandledRejections();
    try {
      const result = await runProbe("flags.current", {
        timeoutMs: 25,
        // A supplier that never settles: without the deadline this call never returns.
        getDeclaredEnv: () => new Promise(() => {}),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("timeout");
      expect(result.rows).toEqual([]);
      expect(result.truncated).toBe(false);

      await flushMicrotasks();
      expect(trap.seen).toEqual([]);
    } finally {
      trap.stop();
    }
  });

  it("fires the abort signal the host supplier was handed", async () => {
    let observed: AbortSignal | undefined;
    let abortedAtDeadline = false;

    const result = await runProbe("network.inflight", {
      timeoutMs: 25,
      getState: (_name, signal) => {
        observed = signal;
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            abortedAtDeadline = true;
            // Resolving late still loses the race; the point is that the host was told.
            resolve([]);
          });
        });
      },
    });

    expect(result.error).toBe("timeout");
    expect(observed?.aborted).toBe(true);
    expect(abortedAtDeadline).toBe(true);
  });

  it("stops a probe mid-iteration once the deadline has fired", async () => {
    // The supplier resolves after the deadline, so the probe body resumes on an already-aborted
    // signal. Without the abort check it would walk the whole storage; with it, it stops at once.
    let itemsRead = 0;
    const watched: ProbeStorageLike = {
      get length() {
        return 500;
      },
      key: (index: number) => {
        itemsRead += 1;
        return `k${index}`;
      },
      getItem: () => "v",
    };

    const result = await runProbe("storage.snapshot", {
      timeoutMs: 20,
      getStorageAreas: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve([{ area: "local", storage: watched }]), 60),
        ),
    });

    // Wait past the supplier's own 60ms so the probe body has genuinely resumed before asserting.
    await delay(150);
    expect(result.error).toBe("timeout");
    expect(itemsRead).toBe(0);
  });

  it("stops walking a storage area the moment the deadline fires mid iteration", async () => {
    // The loop over one area is synchronous, so a real timer can never interleave with it and the
    // per-iteration abort check can only be reached by firing the deadline from inside the loop
    // itself. Fake timers make that possible: `key(0)` advances past the 20ms deadline, which
    // aborts the controller synchronously, and the check at the top of the next iteration refuses
    // the remaining 499 keys.
    vi.useFakeTimers();
    try {
      let itemsRead = 0;
      const watched: ProbeStorageLike = {
        get length() {
          return 500;
        },
        key: (index: number) => {
          itemsRead += 1;
          if (index === 0) vi.advanceTimersByTime(30);
          return `k${index}`;
        },
        getItem: () => "v",
      };

      const result = await runProbe("storage.snapshot", {
        timeoutMs: 20,
        getStorageAreas: () => [{ area: "local", storage: watched }],
      });

      expect(result.ok).toBe(false);
      // Exactly one key was read before the abort was noticed. Without the per-iteration check
      // this walks all 500 and hands the deadline no way to stop it.
      expect(itemsRead).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never rejects because the host's own clock threw", async () => {
    // `ctx.now` is host code, and rule 1 does not have an exception for it. Both the opening
    // reading and the one taken while handling the failure go through it.
    const trap = trapUnhandledRejections();
    try {
      const result = await runProbe("flags.current", {
        now: () => {
          throw new Error("clock exploded");
        },
        getDeclaredEnv: () => {
          throw new Error("provider exploded");
        },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("provider exploded");
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);

      await flushMicrotasks();
      expect(trap.seen).toEqual([]);
    } finally {
      trap.stop();
    }
  });

  it("still answers when the host's clock throws on a probe that succeeds", async () => {
    const result = await runProbe("runtime.env", {
      now: () => {
        throw new Error("clock exploded");
      },
    });

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("turns a throwing probe into ok:false and never propagates", async () => {
    const trap = trapUnhandledRejections();
    try {
      const result = await runProbe("flags.current", {
        getDeclaredEnv: () => {
          throw new Error("provider exploded");
        },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("provider exploded");
      expect(result.rows).toEqual([]);

      await flushMicrotasks();
      expect(trap.seen).toEqual([]);
    } finally {
      trap.stop();
    }
  });

  it("redacts a secret carried inside a thrown message", async () => {
    const result = await runProbe("flags.current", {
      getDeclaredEnv: () => {
        throw new Error(
          "GET https://api.example.com/v1/me?access_token=s3cr3tvalue0987654321 failed",
        );
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).not.toContain("s3cr3tvalue0987654321");
    // `redactUrl` rebuilds the query through URLSearchParams, which escapes the
    // marker's brackets; the write side decodes them back so the stored text is
    // readable rather than `%5BREDACTED%5D`.
    expect(result.error).toContain("[REDACTED;");
    expect(result.error).not.toContain("%5BREDACTED");
  });

  it("reports a source the host did not supply as unavailable, not as an empty table", async () => {
    const missing = await runProbe("network.inflight", {});
    expect(missing.ok).toBe(false);
    expect(missing.error).toBe("unavailable");

    const present = await runProbe("network.inflight", {
      getState: () => [],
    });
    expect(present.ok).toBe(true);
    expect(present.error).toBeUndefined();
    expect(present.rows).toEqual([]);
    expect(present.rowCount).toBe(0);
  });

  it("derives ok from the outcome; a probe cannot declare itself healthy", async () => {
    const good = await runProbe("flags.current", {
      getDeclaredEnv: () => ({ flags: { ok: false, error: "totally fine" } }),
    });
    // The probe's own payload says ok:false, and the framework still reports ok:true because the
    // probe returned a table.
    expect(good.ok).toBe(true);
    expect(good.rows).toContainEqual(["flag", "ok", false]);
    expect(good.rows).toContainEqual(["flag", "error", "totally fine"]);
  });
});

describe("bounds", () => {
  const tenEntries = Array.from(
    { length: 10 },
    (_, index) => [`k${index}`, `value-${index}`] as [string, string],
  );

  it("caps rows, marks truncated, and drops from the tail identically on a repeat run", async () => {
    const ctx: ProbeContext = {
      maxRows: 3,
      getStorageAreas: areas({
        area: "localStorage",
        storage: fakeStorage(tenEntries),
      }),
    };

    const first = await runProbe("storage.snapshot", ctx);
    const second = await runProbe("storage.snapshot", ctx);
    const uncapped = await runProbe("storage.snapshot", {
      ...ctx,
      maxRows: undefined,
    });

    expect(first.ok).toBe(true);
    expect(first.truncated).toBe(true);
    expect(first.rowCount).toBe(3);
    expect(first.rows).toHaveLength(3);
    expect(second.rows).toEqual(first.rows);
    // Dropped from a deterministic end: the kept rows are a prefix of the full table.
    expect(uncapped.rows.slice(0, 3)).toEqual(first.rows);
    expect(uncapped.truncated).toBe(false);
    expect(uncapped.rowCount).toBe(10);
  });

  it("caps serialized bytes, marks truncated, and drops identically on a repeat run", async () => {
    const ctx: ProbeContext = {
      maxBytes: 256,
      getStorageAreas: areas({
        area: "localStorage",
        storage: fakeStorage(
          Array.from(
            { length: 40 },
            (_, index) => [`key-${index}`, "x".repeat(50)] as [string, string],
          ),
        ),
      }),
    };

    const first = await runProbe("storage.snapshot", ctx);
    const second = await runProbe("storage.snapshot", ctx);

    expect(first.ok).toBe(true);
    expect(first.truncated).toBe(true);
    expect(first.rows.length).toBeGreaterThan(0);
    expect(first.rows.length).toBeLessThan(40);
    expect(second.rows).toEqual(first.rows);
    expect(JSON.stringify(first.rows).length).toBeLessThanOrEqual(400);
  });

  it("clamps an out of range limit rather than honouring it", async () => {
    const ctx: ProbeContext = {
      maxRows: -5,
      timeoutMs: Number.NaN,
      maxBytes: 1,
      getStorageAreas: areas({
        area: "localStorage",
        storage: fakeStorage(tenEntries),
      }),
    };

    const result = await runProbe("storage.snapshot", ctx);
    // maxRows -5 clamps to 1, maxBytes 1 clamps to 256, so exactly one row survives the row cap
    // and it fits the clamped byte floor.
    expect(result.ok).toBe(true);
    expect(result.rowCount).toBe(1);
    expect(result.truncated).toBe(true);
  });
});

describe("runtime.cpu_profile", () => {
  it("is unavailable in core without a Node executor and never profiles an untargeted poll", async () => {
    const executor = vi.fn(async () => ({
      durationMs: 1_000,
      sampleCount: 1,
      topFunctions: [{ functionName: "checkout", selfSamples: 1 }],
    }));
    const browser = await runProbe("runtime.cpu_profile", {
      runtimeTargeted: true,
    });
    const targeted = await runProbe("runtime.cpu_profile", {
      runtimeTargeted: true,
      getCpuProfile: executor,
    });
    const untargeted = await runProbe("runtime.cpu_profile", {
      runtimeTargeted: false,
      getCpuProfile: executor,
    });

    expect(browser.ok).toBe(false);
    expect(browser.error).toBe("unavailable");
    expect(targeted.ok).toBe(true);
    expect(browser.durationMs).toBeUndefined();
    expect(untargeted.ok).toBe(false);
    expect(untargeted.error).toBe("unavailable");
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("returns only bounded, redacted CPU profile summary fields", async () => {
    const getCpuProfile = vi.fn(
      async () =>
        ({
          durationMs: 999_999,
          sampleCount: 9_999_999,
          topFunctions: [
            {
              functionName: "",
              url: "https://api.example.test/run?access_token=secret-value-123456789",
              lineNumber: undefined,
              columnNumber: 12,
              selfSamples: 2,
              args: [{ secret: "must not cross the boundary" }],
            },
            ...Array.from({ length: 50 }, (_, index) => ({
              functionName: `function-${index}`,
              selfSamples: 1,
              source: { body: "must not cross the boundary" },
            })),
          ],
        }) as never,
    );

    const result = await runProbe("runtime.cpu_profile", {
      runtimeTargeted: true,
      getCpuProfile,
    });

    expect(result.ok).toBe(true);
    expect(result.durationMs).toBe(2_000);
    expect(result.sampleCount).toBe(1_000_000);
    expect(result.topFunctions).toHaveLength(50);
    expect(result.topFunctions?.[0]).toEqual({
      functionName: "(anonymous)",
      url: expect.stringContaining("api.example.test/run"),
      columnNumber: 12,
      selfSamples: 2,
    });
    expect(JSON.stringify(result)).not.toContain("secret-value-123456789");
    expect(JSON.stringify(result)).not.toContain("must not cross the boundary");
    for (const row of result.topFunctions ?? []) {
      expect(
        Object.keys(row).every((key) =>
          [
            "functionName",
            "url",
            "lineNumber",
            "columnNumber",
            "selfSamples",
          ].includes(key),
        ),
      ).toBe(true);
    }
  });

  it.each([
    ["non-array nodes", { nodes: {}, samples: [1] }],
    ["non-array samples", { nodes: [], samples: {} }],
    ["unknown sample id", {
      nodes: [{ functionName: "checkout", selfSamples: 1 }],
      samples: [1],
    }],
    ["invalid function row", {
      nodes: [{ functionName: "checkout", selfSamples: 0 }],
      samples: [1],
    }],
    ["empty rows", { nodes: [{ functionName: "checkout" }], samples: [1] }],
  ])("rejects %s instead of emitting successful anonymous evidence", async (_label, value) => {
    const getCpuProfile = vi.fn(async () => ({
      durationMs: 1_000,
      sampleCount: 1,
      topFunctions: value,
    }) as never);

    const result = await runProbe("runtime.cpu_profile", {
      runtimeTargeted: true,
      getCpuProfile,
    });

    expect(result.ok).toBe(false);
    expect(result.rows).toEqual([]);
    expect(result.error).toMatch(/malformed|empty/);
  });
});

describe("redaction at the boundary", () => {
  it("masks a secret flag value", async () => {
    const result = await runProbe("flags.current", {
      getDeclaredEnv: () => ({
        flags: { newCheckout: true, apiKey: "sk_live_9f8e7d6c5b4a39281706" },
        config: { region: "eu" },
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.columns).toEqual(["scope", "key", "value"]);
    expect(result.rows).toContainEqual(["flag", "newCheckout", true]);
    expect(result.rows).toContainEqual(["config", "region", "eu"]);
    expect(JSON.stringify(result)).not.toContain("sk_live_9f8e7d6c5b4a39281706");
    const apiKeyRow = result.rows.find((row) => row[1] === "apiKey");
    expect(apiKeyRow?.[2]).toBe(REDACTED_VALUE);
  });

  it("masks a sensitive storage key and every stored value", async () => {
    const secret = "eyJhbGciOiJIUzI1NiJ9.super-secret-payload.sig";
    const result = await runProbe("storage.snapshot", {
      getStorageAreas: areas({
        area: "localStorage",
        storage: fakeStorage([
          ["authToken", secret],
          ["cartCount", "3"],
        ]),
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.columns).toEqual(["area", "key", "value", "bytes"]);
    expect(result.rows[0][1]).toBe(REDACTED_STORAGE_KEY);
    expect(result.rows[0][2]).toBe(REDACTED_VALUE);
    expect(result.rows[1][1]).toBe("cartCount");
    expect(result.rows[1][2]).toBe(REDACTED_VALUE);
    // The size survives redaction, because "this key holds N bytes" is the useful part.
    expect(result.rows[0][3]).toBe(secret.length);
    expect(result.rows[1][3]).toBe(1);
    expect(JSON.stringify(result)).not.toContain("super-secret-payload");
  });

  it("strips a query token from an in-flight request URL", async () => {
    const result = await runProbe("network.inflight", {
      getState: (name) => {
        expect(name).toBe("network.pending");
        return [
          {
            method: "GET",
            url: "https://api.example.com/orders?access_token=abcdef1234567890abcdef",
            ageMs: 1200,
          },
        ];
      },
    });

    expect(result.ok).toBe(true);
    expect(result.columns).toEqual(["method", "url", "ageMs"]);
    expect(result.rows[0][0]).toBe("GET");
    expect(String(result.rows[0][1])).toContain("api.example.com/orders");
    expect(JSON.stringify(result)).not.toContain("abcdef1234567890abcdef");
    expect(result.rows[0][2]).toBe(1200);
  });

  it("survives a malformed pending entry without throwing", async () => {
    const rowsResult = await runProbe("network.inflight", {
      getState: () => [null, { url: 42 }, "nope"],
    });
    expect(rowsResult.ok).toBe(true);
    expect(rowsResult.rows).toEqual([
      ["", "", null],
      ["", "", null],
      ["", "", null],
    ]);

    const shapeResult = await runProbe("network.inflight", {
      getState: () => ({ not: "an array" }),
    });
    expect(shapeResult.ok).toBe(false);
    expect(shapeResult.error).toBe("malformed pending state");
  });
});

describe("runtime.env", () => {
  it("returns a sorted key/value table from the ambient runtime", async () => {
    const result = await runProbe("runtime.env");

    expect(result.ok).toBe(true);
    expect(result.columns).toEqual(["key", "value"]);
    expect(result.rowCount).toBeGreaterThan(0);
    const keys = result.rows.map((row) => String(row[0]));
    expect(keys).toEqual([...keys].sort());
    expect(keys).toContain("locale");
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("reports a latency and never a negative one", async () => {
    let tick = 100;
    const result = await runProbe("runtime.env", {
      now: () => {
        tick += 7;
        return tick;
      },
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

/**
 * A probe is answered by whichever application instance polls next, so the storage it describes
 * belongs to a bystander rather than to the session under investigation. These fix the line between
 * the shape of a key, which is the probe's whole product, and the part of a key that names a
 * person, which was never the question.
 */
describe("storage.snapshot keys from an uninvolved visitor", () => {
  async function keysFor(...keys: string[]): Promise<string[]> {
    const result = await runProbe("storage.snapshot", {
      getStorageAreas: areas({
        area: "localStorage",
        storage: fakeStorage(keys.map((key) => [key, "x"] as [string, string])),
      }),
    });
    expect(result.ok).toBe(true);
    return result.rows.map((row) => String(row[1]));
  }

  it("never emits an email address carried in a key", async () => {
    const [treated] = await keysFor("cart:alice@example.com:items");

    expect(treated).toBe("cart:*:items");
    expect(treated).not.toContain("alice");
    expect(treated).not.toContain("example.com");
  });

  it("never emits a numeric id carried in a key", async () => {
    const [prefs, order] = await keysFor("user_12345_prefs", "order#A1B2C3-4455");

    expect(prefs).toBe("user_*_prefs");
    expect(order).toBe("order#*-*");
    expect(prefs).not.toContain("12345");
    // Judged as one span, so the order code cannot leak a letter at a time either.
    expect(order).not.toMatch(/A|B|C|1|2|3|4455/);
  });

  it("never emits a phone number carried in a key", async () => {
    const [treated] = await keysFor("checkout|4155550123|draft");

    expect(treated).toBe("checkout|*|draft");
    expect(treated).not.toContain("4155550123");
  });

  it("keeps two different key patterns apart, and keeps the count", async () => {
    const treated = await keysFor(
      "session:alice@example.com:cart",
      "session:bob@example.com:cart",
      "profile_9001_avatar",
      "theme",
    );

    expect(treated).toEqual([
      "session:*:cart",
      "session:*:cart",
      "profile_*_avatar",
      "theme",
    ]);
    // One row per key, so "how many keys exist" survives even where two of them share a pattern.
    expect(treated).toHaveLength(4);
    expect(new Set(treated).size).toBe(3);
  });

  it("reports a key with no structural word left as a redacted key, not as punctuation", async () => {
    const [email, digits] = await keysFor("bob.smith@corp.io", "user12345");

    expect(email).toBe(REDACTED_STORAGE_KEY);
    expect(digits).toBe(REDACTED_STORAGE_KEY);
  });

  it("still redacts every stored value unconditionally", async () => {
    const result = await runProbe("storage.snapshot", {
      getStorageAreas: areas({
        area: "localStorage",
        storage: fakeStorage([
          ["theme", "dark"],
          ["cart:items", "[{\"sku\":\"A\"}]"],
        ]),
      }),
    });

    expect(result.rows.map((row) => row[2])).toEqual([
      REDACTED_VALUE,
      REDACTED_VALUE,
    ]);
    expect(JSON.stringify(result)).not.toContain("dark");
  });
});
