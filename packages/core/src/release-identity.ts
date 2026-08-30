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
 * or the runtime already exposes them. The page declaration is the last build
 * source and uses the generic `app-build` convention.
 */
export function readApplicationReleaseIdentity(
  explicitRelease?: string,
): ApplicationReleaseIdentity {
  const release =
    cleanIdentity(explicitRelease) ?? readRuntimeValue(RELEASE_ENV_KEYS);
  const build = readRuntimeValue(BUILD_ENV_KEYS) ?? readMetaAppBuild();

  return {
    ...(release ? { release } : {}),
    ...(build ? { build } : {}),
  };
}

function readRuntimeValue(keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const processValue = readProcessEnv(key);
    const cleanProcessValue = cleanIdentity(processValue);
    if (cleanProcessValue) return cleanProcessValue;
  }
  return undefined;
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

function cleanIdentity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && /^\S{1,120}$/u.test(trimmed) ? trimmed : undefined;
}
