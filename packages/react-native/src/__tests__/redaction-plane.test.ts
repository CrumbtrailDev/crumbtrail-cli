/**
 * What this package sends off a device, asserted on the payload it hands the
 * bus rather than on any internal.
 *
 * `Crumbtrail.addEvent` redacts `db.*` and nothing else, so an assertion that a
 * collector "called the engine" would pass while the raw value still shipped.
 * Every test here reads the emitted `data`.
 */
import { describe, expect, it, vi } from "vitest";
import { startReactNativeCollectors } from "../collectors";
import { createReactNativeReplayLite } from "../replay-lite";
import {
  MOBILE_REDACTION_POLICY,
  MOBILE_URL_MAX_LENGTH,
} from "../redaction-plane";
import type { ReactNativeCapabilities } from "../capabilities";

const capabilities: ReactNativeCapabilities = {
  bitset: 0,
  capabilities: ["view-snapshot"],
  modules: {
    asyncStorage: {
      packageName: "@react-native-async-storage/async-storage",
      present: false,
      status: "absent",
    },
    navigation: {
      packageName: "@react-navigation/native",
      present: false,
      status: "absent",
    },
    viewShot: {
      packageName: "react-native-view-shot",
      present: false,
      status: "absent",
    },
  },
};

interface Recorded {
  type: string;
  data: Record<string, unknown>;
}

function recordingLogger() {
  const events: Recorded[] = [];
  return {
    events,
    addEvent: vi.fn((partial: Recorded) => {
      events.push(partial);
    }),
    stop: vi.fn(async () => ({ sessionId: "ses_test" })),
  };
}

function onlyCollector(name: string) {
  const off = {
    console: false,
    errors: false,
    network: false,
    appState: false,
    environment: false,
    navigation: false,
    replayLite: false,
    nativeDiagnostics: false,
    jsWatchdog: false,
  };
  return { ...off, [name]: true };
}

function redaction(event: Recorded | undefined) {
  return event?.data.redaction as
    | { policy: string; fields: Array<{ path: string; reason: string }> }
    | undefined;
}

describe("fetch and XHR URLs", () => {
  it("strips userinfo and fragment and redacts query values", async () => {
    const target = recordingLogger();
    const globalObject = {
      fetch: vi.fn(async () => new Response("ok", { status: 200 })),
    } as unknown as typeof globalThis & Record<string, unknown>;

    const controller = startReactNativeCollectors(target as never, {
      capabilities,
      config: onlyCollector("network"),
      globalObject,
    });
    await globalObject.fetch(
      "https://user:pw@api.example.com/v1/items?api_key=sk_live_abcdef1234567890&q=hi#anchor",
    );
    await controller.cleanup();

    const net = target.events.find((event) => event.type === "net");
    const url = net?.data.url as string;
    expect(url).not.toContain("user:pw");
    expect(url).not.toContain("sk_live_abcdef1234567890");
    expect(url).not.toContain("#anchor");
    expect(url).toContain("api.example.com/v1/items");
    expect(redaction(net)?.fields.map((field) => field.reason)).toEqual(
      expect.arrayContaining([
        "url_credentials",
        "url_query_value",
        "url_hash",
      ]),
    );
  });

  it("drops a URL past the length bound instead of truncating it", async () => {
    const target = recordingLogger();
    const globalObject = {
      fetch: vi.fn(async () => new Response("ok", { status: 200 })),
    } as unknown as typeof globalThis & Record<string, unknown>;

    const controller = startReactNativeCollectors(target as never, {
      capabilities,
      config: onlyCollector("network"),
      globalObject,
    });
    const long = `https://api.example.com/v1/items?blob=${"a".repeat(MOBILE_URL_MAX_LENGTH)}`;
    await globalObject.fetch(long);
    await controller.cleanup();

    const net = target.events.find((event) => event.type === "net");
    // Half a signed URL is still half a signature, so it is replaced whole.
    expect(net?.data.url).toBe("[dropped:url_too_large]");
    expect(redaction(net)?.fields[0]?.reason).toBe("url_too_large");
  });

  it("redacts the XHR URL at open, so the raw one is never held on the request", async () => {
    const target = recordingLogger();
    const opened: string[] = [];
    class FakeXhr {
      readyState = 0;
      status = 0;
      onreadystatechange: (() => void) | null = null;
      open(_method: string, url: string) {
        opened.push(url);
      }
      send() {
        this.readyState = 4;
        this.status = 200;
        this.onreadystatechange?.();
      }
    }
    const globalObject = {
      XMLHttpRequest: FakeXhr,
    } as unknown as typeof globalThis & Record<string, unknown>;

    const controller = startReactNativeCollectors(target as never, {
      capabilities,
      config: onlyCollector("network"),
      globalObject,
    });
    const xhr = new FakeXhr() as FakeXhr & Record<string, unknown>;
    xhr.open(
      "get",
      "https://api.example.com/session?token=sk_live_abcdef1234567890",
    );
    xhr.send();
    await controller.cleanup();

    expect(JSON.stringify(xhr.__crumbtrailNetwork)).not.toContain(
      "sk_live_abcdef1234567890",
    );
    const net = target.events.find((event) => event.type === "net");
    expect(net?.data.url).not.toContain("sk_live_abcdef1234567890");
    expect(net?.data.method).toBe("GET");
    expect(redaction(net)?.policy).toBe(MOBILE_REDACTION_POLICY);
  });
});

describe("ErrorUtils errors and unhandled rejections", () => {
  it("redacts the message and the stack of a global handler error", async () => {
    const target = recordingLogger();
    let handler:
      ((error: unknown, fatal?: boolean) => void) | undefined = () => {};
    const errorUtils = {
      getGlobalHandler: () => handler,
      setGlobalHandler: (next: (error: unknown, fatal?: boolean) => void) => {
        handler = next;
      },
    };
    const controller = startReactNativeCollectors(target as never, {
      capabilities,
      config: onlyCollector("errors"),
      globalObject: {} as typeof globalThis & Record<string, unknown>,
      errorUtils,
    });

    const error = new Error(
      "upload failed for Bearer sk_live_abcdef1234567890",
    );
    error.stack = `Error: token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlX2hlcmU\n    at upload`;
    handler?.(error, true);
    await controller.cleanup();

    const err = target.events.find((event) => event.type === "err");
    expect(err?.data.msg).not.toContain("sk_live_abcdef1234567890");
    expect(err?.data.stk).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(err?.data.fatal).toBe(true);
    expect(redaction(err)?.policy).toBe(MOBILE_REDACTION_POLICY);
  });

  it("redacts an unhandled rejection", async () => {
    const target = recordingLogger();
    let listener: ((event: { reason?: unknown }) => void) | undefined;
    const globalObject = {
      addEventListener: vi.fn(
        (_type: string, next: (event: { reason?: unknown }) => void) => {
          listener = next;
        },
      ),
      removeEventListener: vi.fn(),
    } as unknown as typeof globalThis & Record<string, unknown>;

    const controller = startReactNativeCollectors(target as never, {
      capabilities,
      config: onlyCollector("errors"),
      globalObject,
    });
    listener?.({
      reason: new Error("refused with Bearer sk_live_abcdef1234567890"),
    });
    await controller.cleanup();

    const rej = target.events.find((event) => event.type === "rej");
    expect(rej?.data.msg).not.toContain("sk_live_abcdef1234567890");
    expect(redaction(rej)?.policy).toBe(MOBILE_REDACTION_POLICY);
  });
});

describe("view snapshot", () => {
  function replayLite() {
    const target = recordingLogger();
    return {
      target,
      controller: createReactNativeReplayLite({
        logger: target as never,
        capabilities: ["view-snapshot"],
      }),
    };
  }

  it("redacts the accessibility label, which is on-screen text", () => {
    const { target, controller } = replayLite();
    controller.recordViewSnapshot({
      routePath: "/account",
      root: {
        componentName: "Screen",
        children: [
          {
            componentName: "Text",
            testID: "session-banner",
            label: "Signed in with Bearer sk_live_abcdef1234567890",
          },
        ],
      },
    });

    const snapshot = target.events[0];
    expect(JSON.stringify(snapshot?.data.root)).not.toContain(
      "sk_live_abcdef1234567890",
    );
    // The developer-written identifiers survive: they name a widget, they are
    // not what the user sees.
    expect(JSON.stringify(snapshot?.data.root)).toContain("session-banner");
    expect(redaction(snapshot)?.policy).toBe(MOBILE_REDACTION_POLICY);
  });

  it("bounds the tree depth and the child count", () => {
    const { target, controller } = replayLite();
    let deep: { componentName: string; children: unknown[] } = {
      componentName: "Leaf",
      children: [],
    };
    for (let level = 0; level < 60; level += 1)
      deep = { componentName: "V", children: [deep] };

    controller.recordViewSnapshot({
      root: {
        componentName: "Screen",
        children: [
          deep as never,
          ...Array.from({ length: 400 }, () => ({ componentName: "Row" })),
        ],
      },
    });

    const snapshot = target.events[0];
    const reasons = redaction(snapshot)?.fields.map((field) => field.reason);
    expect(reasons).toEqual(
      expect.arrayContaining([
        "view_tree_depth_exceeded",
        "view_tree_children_exceeded",
      ]),
    );
    const children = (snapshot?.data.root as { children: unknown[] }).children;
    expect(children).toHaveLength(200);
  });
});
