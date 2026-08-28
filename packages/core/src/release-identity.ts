import packageJson from "../package.json" with { type: "json" };

/** The package version is distinct from the application release it observes. */
export const CRUMBTRAIL_SDK_VERSION = packageJson.version;

export interface ApplicationReleaseIdentity {
  release?: string;
  build?: string;
}

const RELEASE_ENV_KEYS = [
  "VITE_APP_VERSION",
  "NEXT_PUBLIC_APP_VERSION",
  "REACT_APP_VERSION",
  "PUBLIC_APP_VERSION",
  "APP_VERSION",
] as const;

const BUILD_ENV_KEYS = [
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

/**
 * Resolve the application's release identity once, at session creation.
 *
 * Environment variables are only considered when a bundler has made them public
 * or the runtime already exposes them. The page declaration uses the generic
 * `app-build` convention, and the entry script's own file name is the last
 * resort, because it is the one build identity that needs no cooperation at all.
 */
export function readApplicationReleaseIdentity(
  explicitRelease?: string,
): ApplicationReleaseIdentity {
  const release =
    cleanIdentity(explicitRelease) ?? readRuntimeValue(RELEASE_ENV_KEYS);
  const build =
    readRuntimeValue(BUILD_ENV_KEYS) ??
    readMetaAppBuild() ??
    readEntryScriptBuild();

  return {
    ...(release ? { release } : {}),
    ...(build ? { build } : {}),
  };
}

function readRuntimeValue(keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const importMetaValue = readImportMetaEnv(key);
    const cleanImportMetaValue = cleanIdentity(importMetaValue);
    if (cleanImportMetaValue) return cleanImportMetaValue;

    const processValue = readProcessEnv(key);
    const cleanProcessValue = cleanIdentity(processValue);
    if (cleanProcessValue) return cleanProcessValue;
  }
  return undefined;
}

function readImportMetaEnv(key: string): unknown {
  try {
    const meta = import.meta as ImportMeta & {
      env?: Record<string, unknown>;
    };
    return meta.env?.[key];
  } catch {
    return undefined;
  }
}

function readProcessEnv(key: string): unknown {
  try {
    return typeof process === "undefined" ? undefined : process.env?.[key];
  } catch {
    return undefined;
  }
}

function readMetaAppBuild(): string | undefined {
  try {
    if (typeof document === "undefined") return undefined;
    return cleanIdentity(
      document.querySelector('meta[name="app-build"]')?.getAttribute("content"),
    );
  } catch {
    return undefined;
  }
}

/**
 * The build identity every bundler already publishes: the entry script's name.
 *
 * Measured on a deployed application: a returning visitor's tab served its shell
 * and both entry chunks from a service worker cache while the server had moved
 * on, and the captured session held the build the SERVER was serving and nothing
 * at all about the build the BROWSER was running. The comparison that answers
 * "your fix never reached me" — the most ordinary support ticket there is — was
 * one sided, because every declared source above was absent: the application
 * published its build through a bundler `define`, which is neither an
 * environment variable nor a meta tag.
 *
 * A content-hashed entry file name needs no convention and no cooperation. It is
 * emitted by every bundler that hashes its output, it changes exactly when the
 * bundle changes, and it is already in the document. Same-origin only, and only
 * the file name: a full URL would carry query strings and paths that say nothing
 * about identity, and a cross-origin script is somebody else's build.
 *
 * It is the LAST source, so any explicitly declared identity still wins. An
 * unhashed name like `main.js` is admitted as-is: it is a weak identity rather
 * than a wrong one, and a reader comparing two sessions can see it did not move.
 */
function readEntryScriptBuild(): string | undefined {
  try {
    if (typeof document === "undefined") return undefined;
    const scripts = document.querySelectorAll<HTMLScriptElement>("script[src]");
    for (const script of Array.from(scripts)) {
      const src = script.getAttribute("src");
      if (!src) continue;
      let url: URL;
      try {
        url = new URL(src, document.baseURI);
      } catch {
        continue;
      }
      if (typeof location !== "undefined" && url.origin !== location.origin)
        continue;
      const name = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
      const cleaned = cleanIdentity(name);
      if (cleaned) return cleaned;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function cleanIdentity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && /^\S{1,120}$/u.test(trimmed) ? trimmed : undefined;
}
