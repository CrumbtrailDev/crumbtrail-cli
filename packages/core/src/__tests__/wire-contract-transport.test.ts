/**
 * Transport-envelope conformance for `crumbtrail-core`.
 *
 * `test-fixtures/wire-contract/transport.json` is the other half of the wire
 * contract: `events/*.json` fixes what an event looks like, `transport.json`
 * fixes where it is posted, what identifies the caller, and what counts as
 * delivery. The Swift, Kotlin and Dart suites all read that file. Until this
 * suite existed the reference implementation did not, so the browser SDK was
 * the one participant free to drift away from the contract every native SDK is
 * held to.
 *
 * The load bearing choice here is that **nothing is read out of
 * `transports/http.ts` and compared to itself**. Every path, every header name
 * and every body shape is observed by driving `HttpTransport` against a
 * recording `fetch` and reading what it actually asked for. A test that
 * imported the transport's own constants and compared them to a fixture would
 * still pass on the day someone changed both, which is precisely the day it
 * needs to fail.
 *
 * @see wire-contract.test.ts for the event envelope half.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpTransport, EventDeliveryError } from "../transports/http";
import { readTransportFixture } from "./wire-contract-fixtures";

const ENDPOINT = "http://localhost:9898";
const TOKEN = "ctkey_fixture_token";

/** One observed outbound request, as the transport actually issued it. */
interface RecordedCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string;
}

/**
 * Narrowing helpers.
 *
 * These throw rather than returning a default. The fixture is the thing under
 * test, so a shape it no longer has is a contract failure to report, never a
 * value to substitute — a lenient reader is how a mutated fixture goes green.
 */
function requireObject(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`transport.json: expected an object at ${at}`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`transport.json: expected a non-empty string at ${at}`);
  }
  return value;
}

const fixture = readTransportFixture();

/** The single HTTP method the contract allows for every endpoint. */
const fixtureMethod = requireString(fixture.method, "method");

const fixtureHeaders = requireObject(fixture.headers, "headers");

/**
 * The auth header's NAME, derived from the fixture rather than written out
 * here. `Content-Type` is transport plumbing every request carries; whatever
 * else the contract lists is the credential header, and its spelling is the
 * thing four SDKs have to agree on.
 */
const authHeaderNames = Object.keys(fixtureHeaders).filter(
  (name) => name.toLowerCase() !== "content-type",
);

const fixtureEndpoints = requireObject(fixture.endpoints, "endpoints");

/** `endpoints.<operation>.path` */
function fixturePath(operation: string): string {
  const entry = requireObject(
    fixtureEndpoints[operation],
    `endpoints.${operation}`,
  );
  return requireString(entry.path, `endpoints.${operation}.path`);
}

/** Sorted top level key set of `endpoints.<operation>.body`. */
function fixtureBodyKeys(operation: string): string[] {
  const entry = requireObject(
    fixtureEndpoints[operation],
    `endpoints.${operation}`,
  );
  return Object.keys(
    requireObject(entry.body, `endpoints.${operation}.body`),
  ).sort();
}

/**
 * The operations this suite can drive, mapped to the call that drives them.
 *
 * Deliberately keyed by the fixture's own operation names so that adding an
 * endpoint to `transport.json` without teaching this suite to exercise it
 * fails the coverage assertion below, rather than passing while the reference
 * implementation is quietly exempt from the new endpoint.
 */
const DRIVERS: Record<string, (transport: HttpTransport) => Promise<void>> = {
  sessionStart: (transport) =>
    transport.startSession("ses_20260812_090000_0123456789ab", {
      service: "app",
    }),
  events: (transport) =>
    transport.sendEvents([{ t: 1000, k: "con", d: { lv: "log", args: [] } }]),
  sessionEnd: (transport) =>
    transport.endSession("ses_20260812_090000_0123456789ab"),
};

describe("transport envelope conformance", () => {
  let calls: RecordedCall[];

  function record(): void {
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          url,
          method: init.method,
          headers: { ...((init.headers ?? {}) as Record<string, string>) },
          body: typeof init.body === "string" ? init.body : "",
        });
        return new Response('{"ok":true}');
      }),
    );
  }

  /**
   * Drive one operation end to end and hand back what it put on the wire.
   *
   * `startSession` is replayed first for the non-start operations because the
   * transport carries the session id from it; the recording is reset after, so
   * the returned call is only the operation asked for.
   */
  async function observe(
    operation: string,
    options?: { authToken?: string },
  ): Promise<RecordedCall> {
    const driver = DRIVERS[operation];
    if (!driver) throw new Error(`no driver for endpoint "${operation}"`);

    const transport = new HttpTransport(ENDPOINT, options);
    if (operation !== "sessionStart") {
      await DRIVERS.sessionStart(transport);
      calls = [];
    }
    await driver(transport);

    if (calls.length !== 1) {
      throw new Error(
        `expected ${operation} to issue exactly one request, saw ${calls.length}`,
      );
    }
    return calls[0];
  }

  beforeEach(() => {
    record();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exercises every endpoint the contract declares", () => {
    // If transport.json grows a fourth endpoint, this suite proves nothing
    // about it until a driver exists. Fail rather than under-report coverage.
    expect(Object.keys(DRIVERS).sort()).toEqual(
      Object.keys(fixtureEndpoints).sort(),
    );
  });

  describe("endpoints", () => {
    for (const operation of Object.keys(DRIVERS)) {
      it(`posts ${operation} to the path the contract fixes`, async () => {
        const call = await observe(operation, { authToken: TOKEN });

        expect(new URL(call.url).pathname).toBe(fixturePath(operation));
        expect(call.method).toBe(fixtureMethod);
      });
    }

    it("posts nothing to a path outside the contract", async () => {
      const observed: string[] = [];
      for (const operation of Object.keys(DRIVERS)) {
        observed.push(new URL((await observe(operation)).url).pathname);
      }

      expect(observed.sort()).toEqual(
        Object.keys(fixtureEndpoints).map(fixturePath).sort(),
      );
    });
  });

  describe("auth header", () => {
    it("names exactly one credential header", () => {
      // The derivation below assumes it; state the assumption as an assertion
      // so a second header in the fixture is a visible failure, not a silently
      // ignored entry.
      expect(authHeaderNames).toHaveLength(1);
    });

    for (const operation of Object.keys(DRIVERS)) {
      it(`sends the contract's header name on ${operation} when a token is set`, async () => {
        const call = await observe(operation, { authToken: TOKEN });

        expect(call.headers[authHeaderNames[0]]).toBe(TOKEN);
        expect(call.headers["Content-Type"]).toBe(
          requireString(fixtureHeaders["Content-Type"], "headers.Content-Type"),
        );
      });

      it(`omits the header entirely on ${operation} when the token is unset`, async () => {
        const call = await observe(operation);

        // "omit the header entirely when unset, never send empty" — presence
        // with an empty value is a distinct, non-conformant outcome, so assert
        // on the key set rather than on the value.
        expect(Object.keys(call.headers)).not.toContain(authHeaderNames[0]);
        expect(call.headers).toEqual({
          "Content-Type": requireString(
            fixtureHeaders["Content-Type"],
            "headers.Content-Type",
          ),
        });
      });
    }
  });

  describe("request bodies", () => {
    for (const operation of Object.keys(DRIVERS)) {
      it(`sends the contract's top level keys for ${operation}`, async () => {
        const call = await observe(operation, { authToken: TOKEN });
        const parsed = JSON.parse(call.body) as Record<string, unknown>;

        expect(Object.keys(parsed).sort()).toEqual(fixtureBodyKeys(operation));
      });
    }

    it("carries the session id the contract keys every endpoint by", async () => {
      for (const operation of Object.keys(DRIVERS)) {
        const call = await observe(operation, { authToken: TOKEN });
        const parsed = JSON.parse(call.body) as Record<string, unknown>;

        expect(parsed.sessionId).toBe("ses_20260812_090000_0123456789ab");
      }
    });
  });

  describe("delivery semantics", () => {
    const delivery = requireObject(fixture.delivery, "delivery");

    it("distinguishes the three outcomes the contract names", async () => {
      // Named rather than assumed: if the fixture stops describing one of
      // these, the branch below it is no longer contract backed.
      expect(Object.keys(delivery).sort()).toEqual(
        ["$comment", "2xx", "networkFailure", "non2xx"].sort(),
      );
    });

    it("treats a 2xx as delivered", async () => {
      const transport = new HttpTransport(ENDPOINT, { authToken: TOKEN });
      await DRIVERS.sessionStart(transport);

      await expect(DRIVERS.events(transport)).resolves.toBeUndefined();
    });

    it("treats a non-2xx as a refusal rather than a delivery", async () => {
      const transport = new HttpTransport(ENDPOINT, { authToken: TOKEN });
      await DRIVERS.sessionStart(transport);

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("nope", { status: 413 })),
      );

      // "do not retry the identical batch; record a capture gap" — the caller
      // can only record a gap it is told about.
      await expect(DRIVERS.events(transport)).rejects.toBeInstanceOf(
        EventDeliveryError,
      );
    });

    it("surfaces a network failure instead of reporting a phantom delivery", async () => {
      const transport = new HttpTransport(ENDPOINT, { authToken: TOKEN });
      await DRIVERS.sessionStart(transport);

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
      Object.defineProperty(navigator, "sendBeacon", {
        value: undefined,
        writable: true,
        configurable: true,
      });

      await expect(DRIVERS.events(transport)).rejects.toBeInstanceOf(
        EventDeliveryError,
      );
    });
  });
});
