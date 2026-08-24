import { describe, expect, it } from "vitest";
import {
  APP_URL_ENV_VAR,
  DEFAULT_APP_URL,
  DEFAULT_ENDPOINT,
  dashboardBase,
  normalizeBase,
  resolveEndpoint,
} from "../net";

describe("resolveEndpoint", () => {
  it("prefers the --endpoint flag, then env, then the default", () => {
    expect(resolveEndpoint("https://flag.example/", {})).toBe(
      "https://flag.example",
    );
    expect(
      resolveEndpoint(null, { CRUMBTRAIL_BASE_URL: "https://env.example/" }),
    ).toBe("https://env.example");
    expect(resolveEndpoint(null, {})).toBe(DEFAULT_ENDPOINT);
  });
});

describe("dashboardBase", () => {
  it("rewrites the default API host to the app host that serves the SPA", () => {
    // The CLI talks to api.crumbtrail.ai, but the browser dashboard (mint key,
    // /issues, session deep-links) lives on the app host — never send the user to
    // the API host, which never returns the SPA shell.
    expect(dashboardBase(DEFAULT_ENDPOINT)).toBe(DEFAULT_APP_URL);
    expect(dashboardBase(`${DEFAULT_ENDPOINT}/`)).toBe(DEFAULT_APP_URL);
  });

  it("leaves a custom endpoint untouched (self-host serves both from one origin)", () => {
    expect(dashboardBase("https://cloud.example")).toBe(
      "https://cloud.example",
    );
    expect(dashboardBase(normalizeBase("https://cloud.example/"))).toBe(
      "https://cloud.example",
    );
  });

  it("prefers what the deployment reported over the hosted guess", () => {
    expect(
      dashboardBase("https://cloud.example", "http://127.0.0.1:19892", {}),
    ).toBe("http://127.0.0.1:19892");
  });

  it("lets CRUMBTRAIL_APP_URL outrank a deployment that is wrong about itself", () => {
    // A stack whose PUBLIC_BASE_URL points at its own API host reports an
    // origin that serves no dashboard, and every link built on it 404s. The env
    // var is the only lever the user has, so it wins over everything.
    expect(
      dashboardBase("http://127.0.0.1:19890", "http://127.0.0.1:19890", {
        [APP_URL_ENV_VAR]: "http://localhost:19892/",
      }),
    ).toBe("http://localhost:19892");
    expect(
      dashboardBase(DEFAULT_ENDPOINT, undefined, {
        [APP_URL_ENV_VAR]: "https://app.example",
      }),
    ).toBe("https://app.example");
  });
});
