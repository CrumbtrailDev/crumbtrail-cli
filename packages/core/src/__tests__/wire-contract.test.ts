/**
 * Conformance harness for `test-fixtures/wire-contract/`.
 *
 * `test-fixtures/wire-contract/README.md` says every SDK that is not built on
 * `crumbtrail-core` ships a conformance test, and that `crumbtrail-core` has a
 * matching one so the reference implementation is held to the same file. The
 * Swift, Kotlin and Dart suites already did; this is the `crumbtrail-core` half.
 *
 * What lives here is the foundation: the fixtures are reachable, the canonical
 * writer both sides compare through behaves, and the envelope's two omission
 * rules hold. Per kind payload conformance and the transport envelope are
 * separate suites built on `wire-contract-fixtures.ts`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { BugEvent, TargetDescriptor } from "../types";
import {
  EVENT_FIXTURE_COUNT,
  FIXTURE_CAPABILITIES,
  FIXTURE_SDK,
  FIXTURE_TIMESTAMP,
  canonicalJson,
  encodeWireEvent,
  eventFixtureCanonical,
  listEventFixtureNames,
  readEventFixture,
  readEventFixtureText,
  targetIdentifiesSomething,
  toWireEnvelope,
  wireContractDir,
} from "./wire-contract-fixtures";

describe("wire-contract fixtures", () => {
  it("fixtures are reachable", () => {
    // If the path arithmetic in the loader is wrong, every other assertion in
    // this file and in the suites built on it would compare against an empty
    // string and pass vacuously. Fail loudly here instead. This test is the
    // reason the rest of the suite means anything.
    const netFixture = join(wireContractDir(), "events", "net.json");
    expect(existsSync(netFixture), `expected ${netFixture} to exist`).toBe(
      true,
    );
    expect(readEventFixtureText("net")).toContain('"k"');
    expect(readEventFixture("net").k).toBe("net");
  });

  it("holds exactly the expected number of event fixtures", () => {
    // Adding a fixture without adding a matching crumbtrail-core assertion
    // would otherwise leave the reference implementation quietly exempt from
    // the new kind. Failing here forces the pair to land together.
    const names = listEventFixtureNames();
    expect(
      names.length,
      `events/ holds ${names.length} fixtures (${names.join(", ")}), but ` +
        `EVENT_FIXTURE_COUNT is ${EVENT_FIXTURE_COUNT}. Add the matching ` +
        "crumbtrail-core assertion and update the constant together.",
    ).toBe(EVENT_FIXTURE_COUNT);
  });
});

describe("canonical JSON writer", () => {
  it("emits whole numbers without a trailing decimal", () => {
    // 402.0 and 402 are different tokens. A fixture written by another language
    // would fail a comparison on the difference alone.
    expect(canonicalJson(402.0)).toBe("402");
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson(1_754_000_000_000)).toBe("1754000000000");
  });

  it("keeps fractional numbers intact", () => {
    expect(canonicalJson(0.42)).toBe("0.42");
    expect(canonicalJson(-1.5)).toBe("-1.5");
  });

  it("sorts object keys", () => {
    expect(canonicalJson({ zebra: 1, alpha: 2 })).toBe('{"alpha":2,"zebra":1}');
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: 3 })).toBe(
      '{"a":3,"b":{"c":2,"d":1}}',
    );
  });

  it("preserves array order", () => {
    expect(canonicalJson(["b", "a"])).toBe('["b","a"]');
  });

  it("escapes strings, including control characters", () => {
    expect(canonicalJson("")).toBe('""');
    expect(canonicalJson("\n")).toBe('"\\n"');
    expect(canonicalJson('say "hi"\\')).toBe('"say \\"hi\\"\\\\"');
    expect(canonicalJson("\r\t\b\f")).toBe('"\\r\\t\\b\\f"');
    expect(canonicalJson("\u0001\u001f")).toBe('"\\u0001\\u001f"');
    // Whatever it emits must still parse back to the same string.
    expect(JSON.parse(canonicalJson('a\u0000b\n"c"')) as string).toBe(
      'a\u0000b\n"c"',
    );
  });

  it("drops undefined keys but keeps explicit null", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("refuses values JSON cannot carry rather than emitting null", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson(() => undefined)).toThrow(TypeError);
  });

  it("normalises a fixture to the same bytes as an equivalent object", () => {
    // The point of canonicalising: the fixture on disk is pretty printed, an
    // SDK payload is not, and the two must still compare equal.
    const fixture = readEventFixture("net");
    expect(canonicalJson(fixture)).toBe(
      canonicalJson(JSON.parse(JSON.stringify(fixture))),
    );
    expect(canonicalJson(fixture)).toContain('"status":402');
  });
});

describe("event envelope invariants", () => {
  const baseEvent: BugEvent = {
    t: FIXTURE_TIMESTAMP,
    k: "net",
    d: { url: "https://api.example.com/v1/orders", status: 402 },
    schemaVersion: 1,
    platform: "ios",
    sdk: FIXTURE_SDK,
    capabilities: FIXTURE_CAPABILITIES,
  };

  it("carries schemaVersion and platform when they are set", () => {
    const wire = JSON.parse(encodeWireEvent(baseEvent)) as Record<
      string,
      unknown
    >;
    expect(wire.schemaVersion).toBe(1);
    expect(wire.platform).toBe("ios");
    expect(wire.sdk).toEqual({
      name: "crumbtrail-fixture",
      version: "0.0.0-fixture",
    });
    expect(wire.t).toBe(FIXTURE_TIMESTAMP);
    expect(wire.k).toBe("net");
  });

  it("passes through the absence of schemaVersion and platform", () => {
    // Absent means 1 and web, for backward compatibility with the browser SDKs.
    // The encoder must not invent them, or a browser event would start claiming
    // a platform the emitter never asserted.
    const wire = toWireEnvelope({ t: 1000, k: "nav", d: { to: "/checkout" } });
    expect(wire.schemaVersion).toBeUndefined();
    expect(wire.platform).toBeUndefined();
    expect(canonicalJson(wire)).toBe(
      '{"d":{"to":"/checkout"},"k":"nav","t":1000}',
    );
  });

  it("omits an empty capabilities array rather than sending it empty", () => {
    // An absent field and an empty array are different claims on the ingest
    // side: "this SDK reports no capability list" versus "this SDK actively
    // has zero capabilities".
    const wire = toWireEnvelope({ ...baseEvent, capabilities: [] });
    expect("capabilities" in wire && wire.capabilities !== undefined).toBe(
      false,
    );
    expect(canonicalJson(wire)).not.toContain("capabilities");

    const populated = toWireEnvelope(baseEvent);
    expect(populated.capabilities).toEqual(["app-lifecycle", "device-info"]);
  });

  it("drops a target that identifies nothing", () => {
    // The type already forbids a bounds-only descriptor at compile time (see
    // mobile-contract.test.ts). The cast reaches past that on purpose: events
    // also arrive from untyped JavaScript, and the wire rule has to hold there
    // too. "At least one identifying key must be present, or omit target
    // entirely." — docs/specs/native-sdk-wire-contract.md
    const boundsOnly = {
      bounds: { x: 16, y: 720, width: 361, height: 48 },
    } as unknown as TargetDescriptor;

    expect(targetIdentifiesSomething(boundsOnly)).toBe(false);
    const wire = toWireEnvelope({ ...baseEvent, target: boundsOnly });
    expect(wire.target).toBeUndefined();
    expect(canonicalJson(wire)).not.toContain("bounds");
  });

  it("keeps a target that names an element, bounds included", () => {
    const target: TargetDescriptor = {
      label: "Pay now",
      bounds: { x: 16, y: 720, width: 361, height: 48 },
    };
    expect(targetIdentifiesSomething(target)).toBe(true);

    const wire = JSON.parse(
      encodeWireEvent({ ...baseEvent, k: "err", target }),
    ) as Record<string, unknown>;
    expect(wire.target).toEqual(target);
  });

  it("does not treat a deprecated spelling as identity", () => {
    // The spec says not to send testId / accessibilityLabel / text at all. A
    // descriptor made only of those names nothing conformant, so it is dropped
    // like a bounds-only one.
    const legacyOnly = {
      testId: "checkout-pay",
      text: "Pay now",
    } as unknown as TargetDescriptor;
    expect(targetIdentifiesSomething(legacyOnly)).toBe(false);
    expect(
      toWireEnvelope({ ...baseEvent, target: legacyOnly }).target,
    ).toBeUndefined();
  });

  it("ignores an identity key present but empty", () => {
    const blank = { label: "" } as unknown as TargetDescriptor;
    expect(targetIdentifiesSomething(blank)).toBe(false);
  });

  it("omits sessionId and offsetMs unless the event carries them", () => {
    expect(toWireEnvelope(baseEvent).sessionId).toBeUndefined();
    expect(toWireEnvelope(baseEvent).offsetMs).toBeUndefined();

    const owned = toWireEnvelope({
      ...baseEvent,
      sessionId: "ses_20260812_090000_0123456789ab",
      offsetMs: 1200,
    });
    expect(owned.sessionId).toBe("ses_20260812_090000_0123456789ab");
    expect(owned.offsetMs).toBe(1200);
  });
});

/**
 * Per kind conformance: one `BugEvent` built in `crumbtrail-core`, compared to
 * the fixture the Swift, Kotlin and Dart suites compare against.
 *
 * The shape of this block is deliberately the same as `WireContractTest.kt` and
 * `wire_contract_test.dart`: a single event builder that stamps the fixed
 * envelope, a table of one payload per fixture, and one assertion per entry
 * whose failure message names the fixture path. Substituting the SDK identity
 * is the same move those suites make — they construct with
 * `crumbtrail-fixture / 0.0.0-fixture` rather than their real name and version,
 * so everything else can be asserted verbatim.
 *
 * `schemaVersion` and `platform` are set explicitly on every event rather than
 * defaulted by the encoder. That is the contract `toWireEnvelope` documents: an
 * absent value is passed through absent, because a browser event must not start
 * claiming a platform its emitter never asserted. The fixtures all carry both
 * fields, so the events built here carry them too.
 */
describe("per kind fixture conformance", () => {
  interface FixtureCase {
    /** The `k` short code the fixture carries, which is not always its file name. */
    kind: string;
    data: Record<string, unknown>;
    target?: TargetDescriptor;
  }

  const fixtureEvent = ({ kind, data, target }: FixtureCase): BugEvent => ({
    t: FIXTURE_TIMESTAMP,
    k: kind,
    d: data,
    schemaVersion: 1,
    platform: "ios",
    sdk: FIXTURE_SDK,
    capabilities: FIXTURE_CAPABILITIES,
    ...(target ? { target } : {}),
  });

  /**
   * One entry per file in `test-fixtures/wire-contract/events/`, keyed by file
   * name. The coverage assertion below compares these keys against the
   * directory listing, so a fixture added without an entry here fails rather
   * than leaving the reference implementation quietly exempt from the new kind.
   */
  const CASES: Record<string, FixtureCase> = {
    "app-lifecycle": {
      kind: "app-lifecycle",
      data: { state: "background", source: "app-lifecycle" },
    },
    con: {
      kind: "con",
      data: { lv: "err", args: ["checkout failed", '{"orderId":42}'] },
    },
    env: {
      kind: "env",
      data: {
        kind: "snapshot",
        device: {
          model: "iPhone15,2",
          manufacturer: "Apple",
          os: "iOS",
          osVersion: "18.2",
        },
        app: { id: "ai.crumbtrail.demo", version: "1.4.0", build: "204" },
        battery: { level: 0.42, charging: false },
        locale: "en-GB",
      },
    },
    err: {
      kind: "err",
      data: {
        msg: "Unexpected nil while unwrapping an Optional value",
        stk:
          "CrumbtrailDemo.CheckoutViewController.submit()\n" +
          "CrumbtrailDemo.CheckoutViewController.tap()",
        fatal: true,
        source: "uncaught-exception",
      },
    },
    "native-crash": {
      kind: "native-crash",
      data: {
        msg: "Fatal error: index out of range",
        stk: "CrumbtrailDemo.CartView.item(at:)",
        signal: "SIGABRT",
        source: "previous-launch",
      },
    },
    "native-hang": {
      kind: "native-hang",
      data: {
        source: "main-thread",
        thresholdMs: 5000,
        observedDurationMs: 7420,
        recovered: false,
        previousLaunch: true,
        stk: "CrumbtrailDemo.CheckoutViewController.submit()\nCrumbtrailDemo.CheckoutViewController.tap()",
      },
    },
    "nav-intent": {
      kind: "nav-intent",
      data: { action: "back", source: "hardware-back" },
    },
    navigation: {
      kind: "navigation",
      data: {
        name: "CheckoutViewController",
        path: "/checkout",
        source: "navigation-controller",
      },
    },
    "net-status": {
      kind: "net-status",
      data: { connected: false, type: "none", kind: "change" },
    },
    net: {
      kind: "net",
      data: {
        url: "https://api.example.com/v1/orders",
        method: "POST",
        status: 402,
        ok: false,
        dur: 318,
        source: "urlsession",
      },
    },
    rej: {
      kind: "rej",
      data: {
        msg: "The request timed out.",
        stk: "CrumbtrailDemo.OrderService.load()",
        source: "unhandled-async",
      },
    },
    // Named for what it exercises rather than for its kind: the payload is an
    // ordinary `err`, and the fixture exists for the target descriptor on it.
    target: {
      kind: "err",
      data: { msg: "tap handler threw", fatal: false, source: "caught" },
      target: {
        role: "button",
        label: "Pay now",
        testID: "checkout-pay",
        componentName: "CheckoutButton",
        routePath: "/checkout",
        bounds: { x: 16, y: 720, width: 361, height: 48 },
      },
    },
    "view-snapshot": {
      kind: "view-snapshot",
      data: {
        w: 393,
        h: 852,
        nodes: [
          {
            role: "screen",
            componentName: "CheckoutViewController",
            bounds: { x: 0, y: 0, width: 393, height: 852 },
          },
          {
            role: "button",
            label: "Pay now",
            testID: "checkout-pay",
            bounds: { x: 16, y: 720, width: 361, height: 48 },
          },
        ],
      },
    },
  };

  it.each(Object.keys(CASES).sort())("matches events/%s.json", (name) => {
    const event = fixtureEvent(CASES[name] as FixtureCase);
    const expected = eventFixtureCanonical(name);
    const where = `test-fixtures/wire-contract/events/${name}.json`;

    // First against the `BugEvent` itself, with no encoder in between. Core's
    // transport sends the event object as it stands (`transports/http.ts:72`),
    // so this is the assertion that holds the reference implementation to the
    // fixture rather than holding a test-local encoder to it. It also proves
    // the envelope's two omission rules are inert across the whole corpus:
    // every fixture carries capabilities, and the one target present names an
    // element.
    expect(
      canonicalJson(event),
      `core event does not match ${where}`,
    ).toBe(expected);

    // Then through the shared encoder the other suites' writers mirror, so a
    // future omission rule that changed one of these fixtures fails here too.
    expect(encodeWireEvent(event), `wire form does not match ${where}`).toBe(
      expected,
    );
  });

  it("asserts every fixture on disk, and no fixture that is not", () => {
    // EVENT_FIXTURE_COUNT catches a fixture being added. This catches one being
    // renamed, which keeps the count identical while leaving a kind unasserted.
    expect(Object.keys(CASES).sort()).toEqual(listEventFixtureNames());
  });
});
