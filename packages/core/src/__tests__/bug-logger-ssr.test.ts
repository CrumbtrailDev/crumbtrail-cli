// @vitest-environment node
//
// Reproduces the onboarding footgun: the docs tell users to call
// `Crumbtrail.init()` at module scope (app/layout.tsx, pages/_app.tsx, a Node
// service), which executes during SSR / `next build` where `window` is
// undefined. Before the guard, the collectors' `window.addEventListener` calls
// threw `ReferenceError: window is not defined` and failed the host build.
import { describe, expect, it, vi } from "vitest";
import { Crumbtrail } from "../bug-logger";
import { PRESET_PASSIVE } from "../types";

describe("Crumbtrail.init() outside a browser (SSR / build / Node)", () => {
  it("does not throw when window is undefined", () => {
    expect(typeof window).toBe("undefined");
    expect(() =>
      Crumbtrail.init({
        ...PRESET_PASSIVE,
        httpEndpoint: "https://example.com",
        httpAuthToken: "bgk_ssr",
      }),
    ).not.toThrow();
  });

  it("returns an inert instance: no socket opened, flagBug is a safe no-op", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    const logger = Crumbtrail.init({
      ...PRESET_PASSIVE,
      httpEndpoint: "https://example.com",
      httpAuthToken: "bgk_ssr",
    });

    // A stable session id is still available for isomorphic correlation code.
    expect(logger.getSessionId()).toMatch(/^ses_/);

    // flagBug resolves without touching the network or window/document.
    await expect(logger.flagBug({ note: "ssr" })).resolves.toMatchObject({
      bugId: expect.stringMatching(/^bug_/),
    });

    // init() must not POST /api/session/start, and the inert transport must not
    // POST /api/bug/flag — nothing leaves the process during SSR.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
