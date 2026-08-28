import { afterEach, describe, expect, it } from "vitest";
import { readApplicationReleaseIdentity } from "../release-identity";

const ENV_KEYS = [
  "VITE_APP_VERSION",
  "NEXT_PUBLIC_APP_VERSION",
  "REACT_APP_VERSION",
  "PUBLIC_APP_VERSION",
  "APP_VERSION",
  "VITE_APP_BUILD",
  "NEXT_PUBLIC_APP_BUILD",
  "REACT_APP_BUILD",
  "PUBLIC_APP_BUILD",
  "APP_BUILD",
  "VITE_GIT_COMMIT_SHA",
  "NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA",
  "PUBLIC_COMMIT_SHA",
  "COMMIT_SHA",
  "GIT_COMMIT_SHA",
] as const;

const savedEnvironment = new Map<string, string | undefined>();

afterEach(() => {
  document.head.innerHTML = "";
  for (const key of ENV_KEYS) {
    const value = savedEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnvironment.clear();
});

function clearIdentityEnvironment(): void {
  for (const key of ENV_KEYS) {
    savedEnvironment.set(key, process.env[key]);
    delete process.env[key];
  }
}

describe("readApplicationReleaseIdentity", () => {
  it("prefers the explicit release and reads the generic app-build meta tag", () => {
    clearIdentityEnvironment();
    document.head.innerHTML =
      '<meta name="app-build" content="build-2026.08.26">';

    expect(readApplicationReleaseIdentity("release-2026.08.26")).toEqual({
      release: "release-2026.08.26",
      build: "build-2026.08.26",
    });
  });

  it("reads public build-time version and build conventions", () => {
    clearIdentityEnvironment();
    process.env.VITE_APP_VERSION = "release-from-bundler";
    process.env.VITE_APP_BUILD = "build-from-bundler";

    expect(readApplicationReleaseIdentity()).toEqual({
      release: "release-from-bundler",
      build: "build-from-bundler",
    });
  });

  it("omits application identity when no honest source exists", () => {
    clearIdentityEnvironment();

    expect(readApplicationReleaseIdentity()).toEqual({});
  });
});

describe("the entry script as a last-resort build identity", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("names the hashed entry file when nothing else declares a build", () => {
    // Measured on a deployed app: the session held the build the SERVER served
    // and nothing about the build the BROWSER was running, because the app
    // published its build through a bundler define rather than an env var or a
    // meta tag. A hashed file name needs no convention at all.
    document.body.innerHTML =
      '<script src="/assets/index-rtA-Jdei.js"></script>';
    expect(readApplicationReleaseIdentity().build).toBe("index-rtA-Jdei.js");
  });

  it("loses to any declared identity", () => {
    document.head.innerHTML =
      '<meta name="app-build" content="declared-build" />';
    document.body.innerHTML =
      '<script src="/assets/index-rtA-Jdei.js"></script>';
    expect(readApplicationReleaseIdentity().build).toBe("declared-build");
  });

  it("ignores a cross-origin script, which is somebody else's build", () => {
    document.body.innerHTML =
      '<script src="https://cdn.example.test/vendor-abc123.js"></script>';
    expect(readApplicationReleaseIdentity().build).toBeUndefined();
  });

  it("takes the file name only, never the path or the query", () => {
    document.body.innerHTML =
      '<script src="/static/build/17/app-9f2c1b.js?cache=bust"></script>';
    expect(readApplicationReleaseIdentity().build).toBe("app-9f2c1b.js");
  });

  it("reports nothing when the document has no script with a source", () => {
    document.body.innerHTML = "<script>console.log(1)</script>";
    expect(readApplicationReleaseIdentity().build).toBeUndefined();
  });
});
