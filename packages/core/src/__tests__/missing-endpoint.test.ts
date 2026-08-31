// A default endpoint that cannot work is worse than none: `httpEndpoint` used
// to default to `http://localhost:9898`, the local capture server's port, and
// that server is no longer published. Capture then ran against a closed port
// and the only symptom was a project that never filled up. init now reports the
// missing endpoint at the moment it runs and captures nothing.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Crumbtrail,
  __resetMissingEndpointReportForTests,
} from "../crumbtrail";
import { DEFAULT_CONFIG, PRESET_PASSIVE } from "../types";

afterEach(() => {
  __resetMissingEndpointReportForTests();
  vi.restoreAllMocks();
});

describe("Crumbtrail.init() with no endpoint configured", () => {
  it("ships no default endpoint", () => {
    expect(DEFAULT_CONFIG.httpEndpoint).toBe("");
  });

  it("says what is missing, immediately, on the first init", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    Crumbtrail.init({ ...PRESET_PASSIVE });
    expect(error).toHaveBeenCalledTimes(1);
    const message = String(error.mock.calls[0]?.[0]);
    expect(message).toContain("httpEndpoint");
    expect(message).toContain("httpAuthToken");
    expect(message).toContain("nothing is being captured");
  });

  it("reports once rather than on every init", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    Crumbtrail.init({ ...PRESET_PASSIVE });
    Crumbtrail.init({ ...PRESET_PASSIVE });
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("sends nothing rather than posting into a closed port", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    const logger = Crumbtrail.init({ ...PRESET_PASSIVE });

    // A session id is still available, so isomorphic correlation code that
    // reads it does not have to know capture is off.
    expect(logger.getSessionId()).toMatch(/^ses_/);
    await expect(logger.flagBug({ note: "no endpoint" })).resolves.toMatchObject(
      { bugId: expect.stringMatching(/^bug_/) },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not throw, because init runs at a host app's module scope", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => Crumbtrail.init({ ...PRESET_PASSIVE })).not.toThrow();
  });

  it("stays quiet and live when an endpoint is configured", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    Crumbtrail.init({
      ...PRESET_PASSIVE,
      httpEndpoint: "https://example.crumbtrail.test",
      httpAuthToken: "ctkey_test",
    });
    expect(error).not.toHaveBeenCalled();
  });
});
