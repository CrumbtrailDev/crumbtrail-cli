import fs from "node:fs";
import path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import type { ServerConfig } from "./server";

export type HealthStatus = "ready" | "degraded";

export interface HealthDirectoryState {
  path: string;
  exists: boolean;
  writable: boolean;
  error?: {
    code: string;
    message: string;
  };
}

export interface HealthStaticState {
  configured: boolean;
  path?: string;
  exists?: boolean;
}

export interface HealthPayload {
  ok: boolean;
  status: HealthStatus;
  service: "crumbtrail-node";
  version: string;
  timestamp: string;
  uptimeMs: number;
  config: {
    host?: string;
    port: number;
    outputDir: string;
    staticDir?: string;
    authEnabled: boolean;
    allowedOriginCount: number;
    aiEnabled: boolean;
    mcpMode: boolean;
  };
  checks: {
    outputDir: HealthDirectoryState;
    staticDir: HealthStaticState;
  };
}

export type PublicHealthPayload = Pick<
  HealthPayload,
  "ok" | "status" | "service" | "version" | "timestamp" | "uptimeMs"
>;

export interface HealthBuildOptions {
  startedAt: number;
  now?: Date;
  host?: string;
  mcpMode?: boolean;
}

export function buildPublicHealthPayload(
  config: ServerConfig,
  options: HealthBuildOptions,
): PublicHealthPayload {
  const detailed = buildHealthPayload(config, options);
  return {
    ok: detailed.ok,
    status: detailed.status,
    service: detailed.service,
    version: detailed.version,
    timestamp: detailed.timestamp,
    uptimeMs: detailed.uptimeMs,
  };
}

export function buildHealthPayload(
  config: ServerConfig,
  options: HealthBuildOptions,
): HealthPayload {
  const now = options.now ?? new Date();
  const outputDir = checkDirectoryWritable(config.outputDir);
  const staticDir = checkStaticDirectory(config.staticDir);
  const status: HealthStatus = outputDir.writable ? "ready" : "degraded";

  return {
    ok: status === "ready",
    status,
    service: "crumbtrail-node",
    version: packageJson.version,
    timestamp: now.toISOString(),
    uptimeMs: Math.max(0, now.getTime() - options.startedAt),
    config: {
      host: options.host,
      port: config.port,
      outputDir: config.outputDir,
      staticDir: config.staticDir,
      authEnabled: Boolean(config.authToken),
      allowedOriginCount: config.allowedOrigins?.length ?? 0,
      aiEnabled: config.ai?.enabled === true,
      mcpMode: options.mcpMode === true,
    },
    checks: {
      outputDir,
      staticDir,
    },
  };
}

function checkDirectoryWritable(dir: string): HealthDirectoryState {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return { path: dir, exists: true, writable: true };
  } catch (err) {
    return {
      path: dir,
      exists: fs.existsSync(dir),
      writable: false,
      error: serializeFsError(err),
    };
  }
}

function checkStaticDirectory(
  staticDir: string | undefined,
): HealthStaticState {
  if (!staticDir) return { configured: false };
  return {
    configured: true,
    path: staticDir,
    exists: fs.existsSync(staticDir) && fs.statSync(staticDir).isDirectory(),
  };
}

function serializeFsError(err: unknown): { code: string; message: string } {
  if (err && typeof err === "object") {
    const maybe = err as { code?: unknown; message?: unknown };
    return {
      code: typeof maybe.code === "string" ? maybe.code : "fs_error",
      message:
        typeof maybe.message === "string"
          ? maybe.message
          : "Filesystem check failed",
    };
  }
  return { code: "fs_error", message: "Filesystem check failed" };
}
