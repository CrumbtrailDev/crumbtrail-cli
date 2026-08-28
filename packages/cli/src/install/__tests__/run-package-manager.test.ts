import { describe, expect, it } from "vitest";
import {
  runPackageManager,
  type OutputSink,
  type PackageManagerRun,
} from "../run-package-manager";

function recordingSink(): OutputSink & { stdout: string; stderr: string } {
  const sink = {
    stdout: "",
    stderr: "",
    writeStdout(text: string) {
      sink.stdout += text;
    },
    writeStderr(text: string) {
      sink.stderr += text;
    },
  };
  return sink;
}

// What a real pnpm add prints on the way through: progress repaints, the
// package.json field warning, deprecation notices. None of it is the reader's
// business when the install worked.
const PNPM_CHATTER = [
  "Progress: resolved 812, reused 780, downloaded 4, added 0",
  '[WARN] The "pnpm" field in package.json is no longer read by pnpm',
  "deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported",
].join("\n");

describe("runPackageManager", () => {
  it("prints nothing when the install succeeds", () => {
    const sink = recordingSink();
    const code = runPackageManager("pnpm", ["add", "crumbtrail-core"], "/app", {
      spawn: () => ({ status: 0, stdout: PNPM_CHATTER, stderr: PNPM_CHATTER }),
      sink,
    });

    expect(code).toBe(0);
    expect(sink.stdout).toBe("");
    expect(sink.stderr).toBe("");
  });

  it("replays the package manager's own output when it exits nonzero", () => {
    const sink = recordingSink();
    const failure: PackageManagerRun = {
      status: 1,
      stdout: PNPM_CHATTER,
      stderr:
        "ERR_PNPM_IGNORED_BUILDS  Ignored build scripts: esbuild, sharp.\n",
    };
    const code = runPackageManager("pnpm", ["add", "crumbtrail-core"], "/app", {
      spawn: () => failure,
      sink,
    });

    expect(code).toBe(1);
    // The wizard's explanation of a nonzero exit says "the message pnpm printed
    // above", so the real message has to be on screen for that to be true.
    expect(sink.stdout).toContain("Progress: resolved 812");
    expect(sink.stderr).toContain("ERR_PNPM_IGNORED_BUILDS");
  });

  it("passes the command through unchanged", () => {
    const seen: Array<[string, string[], string]> = [];
    runPackageManager("npm", ["install", "crumbtrail-core@>=0.41.0"], "/app", {
      spawn: (cmd, args, cwd) => {
        seen.push([cmd, args, cwd]);
        return { status: 0, stdout: "", stderr: "" };
      },
      sink: recordingSink(),
    });

    expect(seen).toEqual([
      ["npm", ["install", "crumbtrail-core@>=0.41.0"], "/app"],
    ]);
  });

  it("reports a package manager that could not be started", () => {
    const sink = recordingSink();
    const code = runPackageManager("pnpm", ["add", "crumbtrail-core"], "/app", {
      spawn: () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: new Error("spawnSync pnpm ENOENT"),
      }),
      sink,
    });

    expect(code).toBe(1);
    expect(sink.stderr).toContain("ENOENT");
  });

  it("treats a signalled run as a failure", () => {
    const sink = recordingSink();
    const code = runPackageManager("pnpm", ["add", "crumbtrail-core"], "/app", {
      spawn: () => ({ status: null, stdout: "", stderr: "killed\n" }),
      sink,
    });

    expect(code).toBe(1);
    expect(sink.stderr).toBe("killed\n");
  });

  it("really captures a child process rather than inheriting the screen", () => {
    const sink = recordingSink();
    const script =
      "process.stdout.write('noisy stdout\\n');" +
      "process.stderr.write('noisy stderr\\n');";

    const quiet = runPackageManager(
      process.execPath,
      ["-e", script],
      process.cwd(),
      { sink },
    );
    expect(quiet).toBe(0);
    expect(sink.stdout).toBe("");
    expect(sink.stderr).toBe("");

    const loud = runPackageManager(
      process.execPath,
      ["-e", `${script}process.exit(1);`],
      process.cwd(),
      { sink },
    );
    expect(loud).toBe(1);
    expect(sink.stdout).toBe("noisy stdout\n");
    expect(sink.stderr).toBe("noisy stderr\n");
  });
});
