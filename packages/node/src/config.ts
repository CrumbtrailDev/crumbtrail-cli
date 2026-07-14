import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CliConfig {
  port: number;
  host: string;
  output: string;
  whisperModel: string;
  mcp: boolean;
  staticDir?: string;
  authToken?: string;
  allowedOrigins: string[];
  ai: boolean;
  aiModel?: string;
  aiAllowAutoModel: boolean;
}

export class CliConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CliConfigError";
  }
}

export function defaultCliConfig(): CliConfig {
  return {
    port: 9898,
    host: "127.0.0.1",
    output: path.join(os.homedir(), ".crumbtrail", "sessions"),
    whisperModel: "base",
    mcp: false,
    allowedOrigins: [],
    ai: false,
    aiAllowAutoModel: false,
  };
}

export function parseCliConfig(args: string[]): CliConfig {
  const config = defaultCliConfig();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      config.port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--host" && args[i + 1]) {
      config.host = args[i + 1];
      i++;
    } else if (args[i] === "--output" && args[i + 1]) {
      config.output = args[i + 1];
      i++;
    } else if (args[i] === "--whisper-model" && args[i + 1]) {
      config.whisperModel = args[i + 1];
      i++;
    } else if (args[i] === "--static" && args[i + 1]) {
      config.staticDir = args[i + 1];
      i++;
    } else if (args[i] === "--auth-token" && args[i + 1]) {
      config.authToken = args[i + 1];
      i++;
    } else if (args[i] === "--allow-origin" && args[i + 1]) {
      config.allowedOrigins.push(args[i + 1]);
      i++;
    } else if (args[i] === "--ai") {
      config.ai = true;
    } else if (args[i] === "--ai-model" && args[i + 1]) {
      config.aiModel = args[i + 1];
      i++;
    } else if (args[i] === "--ai-allow-auto-model") {
      config.aiAllowAutoModel = true;
    } else if (args[i] === "--mcp") {
      config.mcp = true;
    }
  }

  // Auth token precedence: the explicit --auth-token flag always wins; otherwise fall back
  // to the CRUMBTRAIL_AUTH_TOKEN env var. An unset/blank env var leaves auth disabled.
  if (config.authToken === undefined) {
    const fromEnv = process.env.CRUMBTRAIL_AUTH_TOKEN;
    if (fromEnv !== undefined && fromEnv.trim().length > 0) {
      config.authToken = fromEnv;
    }
  }

  return config;
}

export function resolveCliConfig(args: string[]): CliConfig {
  return validateCliConfig(parseCliConfig(args));
}

export function validateCliConfig(config: CliConfig): CliConfig {
  if (
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65_535
  ) {
    throw new CliConfigError(
      "invalid_port",
      "Invalid --port: expected an integer from 1 to 65535.",
    );
  }

  if (config.host.trim().length === 0) {
    throw new CliConfigError(
      "invalid_host",
      "Invalid --host: expected a non-empty host or IP address.",
    );
  }

  if (config.output.trim().length === 0 || config.output.includes("\0")) {
    throw new CliConfigError(
      "invalid_output",
      "Invalid --output: expected a non-empty local directory path.",
    );
  }

  if (config.staticDir !== undefined) {
    validateStaticDirectory(config.staticDir);
  }

  for (const origin of config.allowedOrigins) {
    validateAllowedOrigin(origin);
  }

  return config;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  )
    return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) {
    return normalized.split(".").every((part) => Number(part) <= 255);
  }
  return false;
}

function validateStaticDirectory(staticDir: string): void {
  if (staticDir.trim().length === 0 || staticDir.includes("\0")) {
    throw new CliConfigError(
      "invalid_static_dir",
      "Invalid --static: expected a non-empty local directory path.",
    );
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(staticDir);
  } catch {
    throw new CliConfigError(
      "static_dir_not_found",
      `Invalid --static: directory does not exist: ${staticDir}`,
    );
  }

  if (!stat.isDirectory()) {
    throw new CliConfigError(
      "static_dir_not_directory",
      `Invalid --static: path is not a directory: ${staticDir}`,
    );
  }
}

function validateAllowedOrigin(origin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new CliConfigError(
      "invalid_origin",
      `Invalid --allow-origin: expected an http(s) origin, got: ${origin}`,
    );
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new CliConfigError(
      "invalid_origin",
      `Invalid --allow-origin: expected only scheme, host, and optional port, got: ${origin}`,
    );
  }
}
