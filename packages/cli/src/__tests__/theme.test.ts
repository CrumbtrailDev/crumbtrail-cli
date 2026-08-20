import { afterEach, describe, expect, it } from "vitest";

import {
  banner,
  caps,
  color,
  detectCapabilities,
  glyphs,
  gradient,
  foldForTerminal,
  ok,
  resetCapabilities,
  startSpinner,
  step,
  visibleLength,
  type CapabilityProbe,
  type TerminalCapabilities,
} from "../theme";

const ESC = "\u001B";

function probe(over: Partial<CapabilityProbe> = {}): CapabilityProbe {
  return {
    env: {},
    isTTY: true,
    stdinIsTTY: true,
    columns: 80,
    platform: "linux",
    release: "6.1.0",
    ...over,
  };
}

function pin(over: Partial<TerminalCapabilities> = {}): void {
  resetCapabilities({
    colorLevel: 3,
    unicode: true,
    width: 80,
    interactive: true,
    ...over,
  });
}

afterEach(() => resetCapabilities());

describe("colour depth detection", () => {
  it("gives a pipe no colour at all, whatever the terminal claims", () => {
    // The wizard's output is regularly redirected into a build log. Escape codes
    // there are noise nobody asked for, and they break `grep`.
    const level = detectCapabilities(
      probe({
        isTTY: false,
        env: { COLORTERM: "truecolor", TERM: "xterm-256color" },
      }),
    ).colorLevel;
    expect(level).toBe(0);
  });

  it("honours NO_COLOR and TERM=dumb on a real TTY", () => {
    expect(
      detectCapabilities(probe({ env: { NO_COLOR: "1" } })).colorLevel,
    ).toBe(0);
    expect(
      detectCapabilities(probe({ env: { TERM: "dumb" } })).colorLevel,
    ).toBe(0);
  });

  it("lets FORCE_COLOR override in both directions", () => {
    expect(
      detectCapabilities(probe({ isTTY: false, env: { FORCE_COLOR: "3" } }))
        .colorLevel,
    ).toBe(3);
    expect(
      detectCapabilities(
        probe({ env: { FORCE_COLOR: "0", COLORTERM: "truecolor" } }),
      ).colorLevel,
    ).toBe(0);
  });

  it("reads truecolor, 256 and basic from the usual signals", () => {
    expect(
      detectCapabilities(probe({ env: { COLORTERM: "truecolor" } })).colorLevel,
    ).toBe(3);
    expect(
      detectCapabilities(probe({ env: { TERM_PROGRAM: "Apple_Terminal" } }))
        .colorLevel,
    ).toBe(2);
    expect(
      detectCapabilities(probe({ env: { TERM: "xterm-256color" } })).colorLevel,
    ).toBe(2);
    expect(
      detectCapabilities(probe({ env: { TERM: "xterm" } })).colorLevel,
    ).toBe(1);
  });
});

describe("windows", () => {
  const win = (env: NodeJS.ProcessEnv, release = "10.0.19045") =>
    detectCapabilities(probe({ platform: "win32", env, release }));

  it("stays entirely plain on a legacy console with no VT support", () => {
    // Windows 8.1 conhost: ANSI is printed literally, so anything we emit is
    // garbage on screen. Same for the box-drawing glyphs under code page 437.
    const c = win({}, "6.3.9600");
    expect(c.colorLevel).toBe(0);
    expect(c.unicode).toBe(false);
  });

  it("gives Windows Terminal the full treatment", () => {
    const c = win({ WT_SESSION: "abc" });
    expect(c.colorLevel).toBe(3);
    expect(c.unicode).toBe(true);
  });

  it("gives Git Bash / mintty colour and unicode", () => {
    const c = win({ MSYSTEM: "MINGW64", TERM: "xterm" });
    expect(c.unicode).toBe(true);
    expect(c.colorLevel).toBeGreaterThan(0);
  });

  it("colours modern conhost but keeps its glyphs ASCII", () => {
    // VT is available from build 10586, but the console's code page is still
    // 437/850 unless a real terminal emulator is hosting it.
    const c = win({});
    expect(c.colorLevel).toBe(1);
    expect(c.unicode).toBe(false);
  });
});

describe("unicode detection", () => {
  it("falls back to ASCII under a C/POSIX locale", () => {
    expect(detectCapabilities(probe({ env: { LANG: "C" } })).unicode).toBe(
      false,
    );
    expect(
      detectCapabilities(probe({ env: { LC_ALL: "POSIX" } })).unicode,
    ).toBe(false);
    expect(
      detectCapabilities(probe({ env: { LANG: "C.UTF-8" } })).unicode,
    ).toBe(true);
  });

  it("assumes UTF-8 when a container sets no locale at all", () => {
    expect(detectCapabilities(probe()).unicode).toBe(true);
  });

  it("honours CRUMBTRAIL_ASCII as the manual escape hatch", () => {
    expect(
      detectCapabilities(
        probe({ env: { LANG: "en_GB.UTF-8", CRUMBTRAIL_ASCII: "1" } }),
      ).unicode,
    ).toBe(false);
  });
});

describe("rendering", () => {
  it("emits no escape codes at level 0", () => {
    pin({ colorLevel: 0, unicode: true, interactive: false });
    const line = `${color.brand("a")}${color.bold("b")}${gradient("c")}`;
    expect(line).toBe("abc");
  });

  it("degrades the brand blue to a 256 index, then to basic cyan", () => {
    pin({ colorLevel: 3 });
    expect(color.brand("x")).toContain(`${ESC}[38;2;0;153;255m`);
    pin({ colorLevel: 2 });
    expect(color.brand("x")).toContain(`${ESC}[38;5;39m`);
    pin({ colorLevel: 1 });
    expect(color.brand("x")).toBe(`${ESC}[36mx${ESC}[0m`);
  });

  it("keeps a nested reset from bleeding the rest of the line", () => {
    pin({ colorLevel: 1 });
    const line = color.brand(`a${color.dim("b")}c`);
    // The "c" must still be brand-coloured, not terminal default.
    expect(line.endsWith(`${ESC}[36mc${ESC}[0m`)).toBe(true);
  });

  it("flattens the gradient rather than dithering when truecolor is absent", () => {
    pin({ colorLevel: 2 });
    expect(gradient("abc")).toBe(`${ESC}[38;5;39mabc${ESC}[0m`);
  });

  it("swaps every glyph for an ASCII stand-in", () => {
    pin({ unicode: false, colorLevel: 0 });
    expect(glyphs().tick).toBe("+");
    expect(ok("done")).toContain("+ done");
    expect(step(1, 6, "Detect")).toContain("> ");
    // eslint-disable-next-line no-control-regex
    expect(banner("1.2.3", "tag").join("\n")).not.toMatch(/[^\x00-\x7F]/);
  });

  it("fits the banner to the terminal without wrapping", () => {
    pin({ width: 44 });
    for (const line of banner("0.34.0", "Bug context for coding agents.")) {
      expect(visibleLength(line)).toBeLessThanOrEqual(44);
    }
  });
});

describe("ascii fold", () => {
  it("leaves typographic punctuation alone when the terminal can render it", () => {
    pin({ unicode: true });
    expect(foldForTerminal("wired in — waiting…")).toBe("wired in — waiting…");
  });

  it("folds dashes, ellipses and quotes for a console that cannot", () => {
    // Legacy Windows conhost under code page 437 renders these as mojibake,
    // which reads as a broken program rather than as punctuation.
    pin({ unicode: false, colorLevel: 0 });
    expect(foldForTerminal("wired in — waiting…")).toBe(
      "wired in - waiting...",
    );
    expect(foldForTerminal("don\u2019t \u201Cquote\u201D me")).toBe(
      'don\'t "quote" me',
    );
    expect(foldForTerminal("a \u00B7 b \u2192 c")).toBe("a - b -> c");
  });

  it("emits pure ASCII for a whole rendered transcript", () => {
    pin({ unicode: false, colorLevel: 1 });
    const rendered = [
      ...banner(
        "0.34.0",
        "Bug context for coding agents — set up in one command.",
      ),
      step(1, 6, "Detect your framework"),
      ok("Detected a vite-spa project — waiting…"),
    ]
      .map(foldForTerminal)
      .join("\n");
    // eslint-disable-next-line no-control-regex
    expect(rendered).not.toMatch(/[^\x00-\x7F]/);
  });
});

describe("spinner", () => {
  it("prints once and starts no timer when the sink cannot animate", () => {
    pin({ interactive: false, colorLevel: 0 });
    const lines: string[] = [];
    const spinner = startSpinner(
      { out: (l = "") => lines.push(l) },
      "Waiting…",
    );
    spinner.setLabel("Waiting… 3s");
    spinner.pause();
    spinner.resume();
    spinner.stop();
    // One line total: a log file gets a single "Waiting…", not a frame per tick.
    expect(lines).toEqual(["Waiting…"]);
  });

  it("animates and cleans up its line on a capable sink", async () => {
    pin({ interactive: true });
    const status: (string | undefined)[] = [];
    const spinner = startSpinner(
      { out: () => {}, status: (l) => status.push(l) },
      "Waiting…",
    );
    await new Promise((r) => setTimeout(r, 210));
    spinner.stop();
    const painted = status.filter((l) => l != null && l !== "");
    expect(painted.length).toBeGreaterThan(1);
    // Last write clears the line so the next out() does not collide with it.
    expect(status.at(-1) ?? "").toBe("");
  });
});

describe("caps()", () => {
  it("caches the probe and re-reads it after a reset", () => {
    pin({ colorLevel: 2 });
    expect(caps().colorLevel).toBe(2);
    expect(caps().colorLevel).toBe(2);
    resetCapabilities();
    expect(caps()).toBeDefined();
  });
});
