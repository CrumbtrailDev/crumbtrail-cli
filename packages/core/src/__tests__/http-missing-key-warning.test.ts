import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpTransport } from "../transports/http";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HttpTransport with no ingest key", () => {
  it("says so once, at init, naming the restart that fixes it", () => {
    // The Vite wiring reads `import.meta.env.VITE_CRUMBTRAIL_KEY`, which is
    // `undefined` in a dev server that was already running when the wizard
    // wrote the key. Everything then looks healthy until the 401s start.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new HttpTransport("https://api.crumbtrail.ai");
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0] ?? "");
    expect(line).toMatch(/httpAuthToken is undefined/);
    expect(line).toMatch(/restart the dev server/i);
  });

  it("stays quiet when a key is present", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new HttpTransport("https://api.crumbtrail.ai", { authToken: "ctkey_x" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays quiet for a local receiver, which accepts unauthenticated sessions", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new HttpTransport("http://localhost:4319");
    new HttpTransport("http://127.0.0.1:4319");
    expect(warn).not.toHaveBeenCalled();
  });
});
