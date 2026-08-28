// Running a package manager without handing it the wizard's screen.
//
// The installer is the loudest thing the wizard does. A two app monorepo run
// emitted around two hundred lines of pnpm progress repaints, deprecation
// notices and ERR_PNPM_IGNORED_BUILDS between the "Next:" lines naming what the
// reader still has to do and the end of the run, so those steps scrolled away.
//
// So the output is captured rather than inherited, and replayed only when the
// command exits nonzero. A swallowed installer error is far worse than a noisy
// one, and the wizard's own explanation of a nonzero pnpm exit says "the
// message pnpm printed above", so every nonzero exit still prints in full,
// including the ignored builds case where the packages did land.

import { spawnSync } from "node:child_process";

/** What one package manager run produced. `status` is null when it was signalled. */
export interface PackageManagerRun {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command could not be started at all. */
  error?: Error;
}

export type PackageManagerSpawn = (
  cmd: string,
  args: string[],
  cwd: string,
) => PackageManagerRun;

/** Where replayed output goes. Real runs write to the process streams. */
export interface OutputSink {
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}

export interface RunPackageManagerOptions {
  spawn?: PackageManagerSpawn;
  sink?: OutputSink;
}

const defaultSpawn: PackageManagerSpawn = (cmd, args, cwd) => {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // Package managers colourise on a TTY and repaint progress bars. Neither
    // survives a capture usefully, and the capture is not a TTY anyway, so they
    // already fall back to line output here.
  });
  return {
    status: res.status,
    stdout: typeof res.stdout === "string" ? res.stdout : "",
    stderr: typeof res.stderr === "string" ? res.stderr : "",
    ...(res.error ? { error: res.error } : {}),
  };
};

const defaultSink: OutputSink = {
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

/**
 * Run a package manager, keeping its output off screen unless it failed.
 *
 * Returns the exit code, so callers keep the existing contract: zero means the
 * command succeeded, and anything else means the caller decides what to say
 * next after the real output has already been printed.
 */
export function runPackageManager(
  cmd: string,
  args: string[],
  cwd: string,
  options: RunPackageManagerOptions = {},
): number {
  const spawn = options.spawn ?? defaultSpawn;
  const sink = options.sink ?? defaultSink;
  const res = spawn(cmd, args, cwd);
  if (res.error) {
    // Previously this printed nothing at all, so a missing package manager
    // looked like an install that simply did not happen.
    sink.writeStderr(`${cmd}: ${res.error.message}\n`);
    return 1;
  }
  const code = res.status ?? 1;
  if (code !== 0) {
    if (res.stdout) sink.writeStdout(res.stdout);
    if (res.stderr) sink.writeStderr(res.stderr);
  }
  return code;
}
