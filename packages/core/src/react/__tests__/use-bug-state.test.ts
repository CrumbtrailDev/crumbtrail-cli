import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useBugState } from "../use-bug-state";
import {
  REACT_SNAPSHOT_MAX_ARRAY_ENTRIES,
  REACT_SNAPSHOT_MAX_DEPTH,
  REACT_SNAPSHOT_MAX_OBJECT_KEYS,
  redactReactSnapshotWithMetadata,
} from "../redact-snapshot";
import { BROWSER_REDACTION_POLICY_V2 } from "../../redaction";

/**
 * Length recorded on the engine's shape placeholder, or `undefined` when the
 * value was not redacted. Asserting on the shape rather than on a bare marker
 * is the whole point of routing this plane through the shared engine.
 */
function redactedLength(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.$redacted !== "[REDACTED]") return undefined;
  return record.len as number;
}

function makeLogger() {
  const unregister = vi.fn();
  return {
    registerStateProvider: vi.fn(
      (_name: string, _provider: () => unknown) => unregister,
    ),
    unregister,
  };
}

describe("useBugState", () => {
  it("registers a state provider with the given name on mount", () => {
    const logger = makeLogger();
    renderHook(() => useBugState(logger, "cart", { items: 3 }));

    expect(logger.registerStateProvider).toHaveBeenCalledOnce();
    expect(logger.registerStateProvider).toHaveBeenCalledWith(
      "cart",
      expect.any(Function),
    );
  });

  it("the registered provider returns the latest value without re-registering", () => {
    const logger = makeLogger();
    const { rerender } = renderHook(
      ({ value }) => useBugState(logger, "cart", value),
      {
        initialProps: { value: { items: 1 } },
      },
    );

    const provider = logger.registerStateProvider.mock.calls[0]![1];
    expect(provider()).toEqual({ items: 1 });

    rerender({ value: { items: 5 } });

    expect(logger.registerStateProvider).toHaveBeenCalledOnce();
    expect(provider()).toEqual({ items: 5 });
  });

  // The snapshot path now runs the shared engine, so a substitution is the
  // engine's shape placeholder rather than a bare marker. That is the point of
  // the change: two different secrets under the same key used to compare equal,
  // so every change-detection predicate over a React session answered the
  // opposite of the truth.
  it("redacts sensitive snapshot values by default", () => {
    const logger = makeLogger();
    renderHook(() =>
      useBugState(logger, "session", {
        email: "ada@example.test",
        address: "123 Main St",
        jsessionid: "abc123",
        nested: { token: "sk_fake_abcdefghijklmnopqrstuvwxyz" },
        ok: "visible",
      }),
    );

    const provider = logger.registerStateProvider.mock.calls[0]![1];
    const snapshot = provider() as Record<string, unknown>;
    expect(redactedLength(snapshot.email)).toBe("ada@example.test".length);
    expect(redactedLength(snapshot.address)).toBe("123 Main St".length);
    expect(redactedLength(snapshot.jsessionid)).toBe("abc123".length);
    expect(
      redactedLength((snapshot.nested as Record<string, unknown>).token),
    ).toBe("sk_fake_abcdefghijklmnopqrstuvwxyz".length);
    expect(snapshot.ok).toBe("visible");
    expect(JSON.stringify(snapshot)).not.toContain("ada@example.test");
    expect(JSON.stringify(snapshot)).not.toContain("123 Main St");
  });

  it("classifies on the value, not only on the key name", () => {
    const logger = makeLogger();
    renderHook(() =>
      useBugState(logger, "session", {
        // None of these key names read as sensitive. The forked React rules
        // classified on the name alone and let every one of them through.
        user: "a@b.com",
        payment: "4111 1111 1111 1111",
        account: "GB82WEST12345698765432",
        blob: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlX2hlcmU",
      }),
    );

    const snapshot = logger.registerStateProvider.mock.calls[0]![1]() as Record<
      string,
      unknown
    >;
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("a@b.com");
    expect(serialized).not.toContain("4111");
    expect(serialized).not.toContain("GB82WEST");
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    for (const key of ["user", "payment", "account", "blob"])
      expect(redactedLength(snapshot[key])).toBeGreaterThan(0);
  });

  it("gives two different secrets two different shapes", () => {
    const logger = makeLogger();
    const { rerender } = renderHook(
      ({ value }) => useBugState(logger, "session", value),
      { initialProps: { value: { password: "hunter2" } } },
    );
    const provider = logger.registerStateProvider.mock.calls[0]![1];
    const first = JSON.stringify(provider());
    rerender({ value: { password: "totally-different-password" } });
    expect(JSON.stringify(provider())).not.toBe(first);
  });

  it("redacts malformed JSON-like sensitive strings by default", () => {
    const logger = makeLogger();
    renderHook(() => useBugState(logger, "session", '{"password":"hunter2"'));

    const provider = logger.registerStateProvider.mock.calls[0]![1];
    expect(JSON.stringify(provider())).not.toContain("hunter2");
    expect(redactedLength(provider())).toBe('{"password":"hunter2"'.length);
  });

  it("redacts malformed JSON-like PII and compact sensitive strings by default", () => {
    const logger = makeLogger();
    const raw =
      '{address:"123 Main St", dob:"2000-01-01", zip:"12345", jsessionid:"abc"}';
    renderHook(() => useBugState(logger, "session", raw));

    const provider = logger.registerStateProvider.mock.calls[0]![1];
    const serialized = JSON.stringify(provider());
    expect(serialized).not.toContain("123 Main St");
    expect(serialized).not.toContain("2000-01-01");
    expect(redactedLength(provider())).toBe(raw.length);
  });

  it("survives a cycle instead of throwing out of the state provider", () => {
    const logger = makeLogger();
    const cyclic: Record<string, unknown> = { step: "cart" };
    cyclic.self = cyclic;
    renderHook(() => useBugState(logger, "session", cyclic));

    const provider = logger.registerStateProvider.mock.calls[0]![1];
    const snapshot = provider() as Record<string, unknown>;
    expect(snapshot.step).toBe("cart");
    expect(snapshot.self).toEqual({ $omitted: "cycle" });
  });

  it("bounds depth, array length and object width without discarding siblings", () => {
    const logger = makeLogger();
    let deep: unknown = { bottom: "reached" };
    for (let level = 0; level < REACT_SNAPSHOT_MAX_DEPTH + 5; level += 1)
      deep = { next: deep };
    const wide = Object.fromEntries(
      Array.from({ length: REACT_SNAPSHOT_MAX_OBJECT_KEYS + 3 }, (_, i) => [
        `k${i}`,
        i,
      ]),
    );
    renderHook(() =>
      useBugState(logger, "session", {
        step: "cart",
        deep,
        rows: Array.from(
          { length: REACT_SNAPSHOT_MAX_ARRAY_ENTRIES + 7 },
          (_, i) => i,
        ),
        wide,
      }),
    );

    const snapshot = logger.registerStateProvider.mock.calls[0]![1]() as Record<
      string,
      unknown
    >;
    // Everything outside the offending subtree survives.
    expect(snapshot.step).toBe("cart");
    expect(JSON.stringify(snapshot.deep)).toContain('"$omitted":"depth"');

    const rows = snapshot.rows as unknown[];
    expect(rows).toHaveLength(REACT_SNAPSHOT_MAX_ARRAY_ENTRIES + 1);
    expect(rows[REACT_SNAPSHOT_MAX_ARRAY_ENTRIES]).toEqual({
      $omitted: "array_length",
      limit: REACT_SNAPSHOT_MAX_ARRAY_ENTRIES,
      observed: REACT_SNAPSHOT_MAX_ARRAY_ENTRIES + 7,
    });

    const widened = snapshot.wide as Record<string, unknown>;
    expect(widened.k0).toBe(0);
    expect(widened.$omittedKeys).toEqual({
      $omitted: "object_keys",
      limit: REACT_SNAPSHOT_MAX_OBJECT_KEYS,
      observed: REACT_SNAPSHOT_MAX_OBJECT_KEYS + 3,
    });
  });

  it("serializes dates, sets and maps instead of rendering them as empty objects", () => {
    const logger = makeLogger();
    renderHook(() =>
      useBugState(logger, "session", {
        at: new Date("2024-03-01T10:00:00.000Z"),
        tags: new Set(["a", "b"]),
        counts: new Map([["a", 1]]),
        fn: () => undefined,
      }),
    );

    const snapshot = logger.registerStateProvider.mock.calls[0]![1]() as Record<
      string,
      unknown
    >;
    expect(snapshot.at).toBe("2024-03-01T10:00:00.000Z");
    expect(snapshot.tags).toEqual(["a", "b"]);
    expect(snapshot.counts).toEqual([["a", 1]]);
    expect(snapshot.fn).toEqual({ $omitted: "unsupported", kind: "function" });
  });

  it("reports what it removed as redaction evidence", () => {
    // A neutral key name, so the reason recorded is the value classifier's and
    // not the deny-list's — that is the rule the fork never had.
    const cyclic: Record<string, unknown> = { owner: "ada@example.test" };
    cyclic.self = cyclic;
    const result = redactReactSnapshotWithMetadata(cyclic, "state.session");
    expect(result.metadata?.policy).toBe(BROWSER_REDACTION_POLICY_V2);
    const reasons = (result.metadata?.fields ?? []).map(
      (field) => field.reason,
    );
    expect(reasons).toContain("structure_cycle");
    expect(reasons).toContain("email_value");
  });

  it("returns raw snapshot values only when explicitly opted in", () => {
    const logger = makeLogger();
    renderHook(() =>
      useBugState(
        logger,
        "session",
        { password: "hunter2" },
        { captureRawState: true },
      ),
    );

    const provider = logger.registerStateProvider.mock.calls[0]![1];
    expect(provider()).toEqual({ password: "hunter2" });
  });

  it("unregisters the previous provider and registers a new one when name changes", () => {
    const logger = makeLogger();
    const { rerender } = renderHook(
      ({ name }) => useBugState(logger, name, "v"),
      {
        initialProps: { name: "a" },
      },
    );

    rerender({ name: "b" });

    expect(logger.unregister).toHaveBeenCalledOnce();
    expect(logger.registerStateProvider).toHaveBeenCalledTimes(2);
    expect(logger.registerStateProvider).toHaveBeenNthCalledWith(
      2,
      "b",
      expect.any(Function),
    );
  });

  it("calls the unregister callback on unmount", () => {
    const logger = makeLogger();
    const { unmount } = renderHook(() => useBugState(logger, "cart", 1));

    unmount();

    expect(logger.unregister).toHaveBeenCalledOnce();
  });

  it("does nothing when logger is null", () => {
    const { result } = renderHook(() => useBugState(null, "cart", 1));
    expect(result.current).toBeUndefined();
  });

  it("does nothing when logger is undefined", () => {
    expect(() =>
      renderHook(() => useBugState(undefined, "cart", 1)),
    ).not.toThrow();
  });

  it("does not throw when logger lacks a registerStateProvider function", () => {
    const brokenLogger = {} as never;
    expect(() =>
      renderHook(() => useBugState(brokenLogger, "cart", 1)),
    ).not.toThrow();
  });
});
