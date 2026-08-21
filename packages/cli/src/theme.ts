// Terminal theme — the CLI's visual identity, and the one place that decides
// what this particular terminal can actually render.
//
// Two capabilities are negotiated once, at first use, and every helper below
// degrades against them rather than assuming:
//
//   colorLevel  0 none · 1 sixteen · 2 two-fifty-six · 3 truecolor
//   unicode     whether box-drawing/dot glyphs are safe, or we fall back to ASCII
//
// The rules are conservative on purpose. A wrong "yes" here is escape codes
// smeared across someone's build log, or mojibake in a Windows console, which is
// worse than a plain-but-correct render. There is no dependency on chalk or any
// color library: npx cold-start time is a product feature.

import os from "node:os";

const ESC = "\u001B";
const CSI = `${ESC}[`;
const RESET = `${CSI}0m`;

export type ColorLevel = 0 | 1 | 2 | 3;

export interface TerminalCapabilities {
  colorLevel: ColorLevel;
  unicode: boolean;
  /** Usable columns, already clamped to something sane for a redraw. */
  width: number;
  /** Raw-mode interactive widgets (checkbox list, animated spinner) are safe. */
  interactive: boolean;
}

export interface CapabilityProbe {
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  stdinIsTTY: boolean;
  columns?: number;
  platform: NodeJS.Platform;
  release: string;
}

// ── Capability detection ─────────────────────────────────────────────────────

/** Windows enabled ANSI (VT) processing in conhost from build 10586 onward. */
function windowsHasVT(release: string): boolean {
  const parts = release.split(".").map((n) => Number(n));
  const major = parts[0];
  const build = parts[2];
  if (!Number.isFinite(major)) return false;
  if (major > 10) return true;
  if (major < 10) return false;
  return Number.isFinite(build) ? build >= 10586 : false;
}

/**
 * A modern terminal emulator on Windows — Windows Terminal, VS Code's integrated
 * terminal, ConEmu/Cmder, JetBrains, or an msys/mintty shell (Git Bash). These
 * both speak ANSI and run a UTF-8 code page, unlike bare legacy conhost.
 */
function windowsModernTerminal(env: NodeJS.ProcessEnv): boolean {
  return (
    env.WT_SESSION != null ||
    env.TERM_PROGRAM === "vscode" ||
    env.ConEmuANSI === "ON" ||
    env.TERMINAL_EMULATOR === "JetBrains-JediTerm" ||
    env.MSYSTEM != null ||
    env.TERM === "xterm-256color" ||
    env.TERM === "cygwin"
  );
}

function detectColorLevel(probe: CapabilityProbe): ColorLevel {
  const { env } = probe;

  // Explicit intent wins over every heuristic, in both directions.
  const force = env.FORCE_COLOR;
  if (force != null && force !== "") {
    if (force === "0" || force === "false") return 0;
    if (force === "1" || force === "true") return 1;
    if (force === "2") return 2;
    return 3;
  }
  if (env.NO_COLOR != null) return 0;
  if (env.TERM === "dumb") return 0;

  // Deliberately NOT "on" for CI: a piped or redirected stream gets no color
  // unless FORCE_COLOR asked for it. Build logs stay greppable, and the wizard's
  // own test suite (which runs without a TTY) keeps asserting on plain text.
  if (!probe.isTTY) return 0;

  if (probe.platform === "win32") {
    const modern = windowsModernTerminal(env);
    if (!windowsHasVT(probe.release) && !modern) return 0;
    if (env.WT_SESSION != null || env.TERM_PROGRAM === "vscode") return 3;
    if (env.ConEmuANSI === "ON") return 2;
    // Legacy conhost with VT enabled renders the 16 colors faithfully; its
    // 256-color and truecolor handling is not worth betting the output on.
    if (!modern) return 1;
  }

  const colorterm = env.COLORTERM?.toLowerCase() ?? "";
  if (colorterm === "truecolor" || colorterm === "24bit") return 3;

  switch (env.TERM_PROGRAM) {
    case "iTerm.app":
    case "Hyper":
    case "WezTerm":
    case "ghostty":
    case "vscode":
    case "tabby":
      return 3;
    case "Apple_Terminal":
      return 2;
    default:
      break;
  }

  const term = env.TERM ?? "";
  if (/-?(256|direct)color/.test(term)) return 2;
  // A TTY that named no TERM at all (some IDE consoles) still gets basic color:
  // we already know it is neither a pipe nor "dumb".
  return 1;
}

function detectUnicode(probe: CapabilityProbe): boolean {
  const { env } = probe;
  if (env.CRUMBTRAIL_ASCII != null && env.CRUMBTRAIL_ASCII !== "0")
    return false;
  if (env.TERM === "dumb") return false;

  if (probe.platform === "win32") {
    // Legacy conhost defaults to code page 437/850, which turns box-drawing and
    // dot glyphs into garbage. Only trust known-UTF-8 hosts.
    return windowsModernTerminal(env);
  }

  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "";
  // Containers commonly set no locale at all and are UTF-8 regardless; an
  // explicit C/POSIX locale is a real "ASCII only" signal.
  if (locale === "") return true;
  if (/^(C|POSIX)(\.|$)/i.test(locale)) return /utf-?8/i.test(locale);
  return /utf-?8/i.test(locale);
}

function probeNow(): CapabilityProbe {
  return {
    env: process.env,
    isTTY: process.stdout.isTTY === true,
    stdinIsTTY: process.stdin.isTTY === true,
    columns: process.stdout.columns,
    platform: process.platform,
    release: os.release(),
  };
}

export function detectCapabilities(
  probe: CapabilityProbe = probeNow(),
): TerminalCapabilities {
  const colorLevel = detectColorLevel(probe);
  return {
    colorLevel,
    unicode: detectUnicode(probe),
    // Clamped: below 40 the layout is pointless, above 100 a full-width rule
    // reads as a wall rather than a divider.
    width: Math.max(40, Math.min(probe.columns ?? 80, 100)),
    interactive:
      probe.isTTY &&
      probe.stdinIsTTY &&
      probe.env.TERM !== "dumb" &&
      colorLevel > 0,
  };
}

let cached: TerminalCapabilities | undefined;

/** Negotiated once per process; `resetCapabilities()` re-probes (tests). */
export function caps(): TerminalCapabilities {
  cached ??= detectCapabilities();
  return cached;
}

export function resetCapabilities(next?: TerminalCapabilities): void {
  cached = next;
}

// ── Palette ──────────────────────────────────────────────────────────────────
//
// One entry per semantic role. Each carries its truecolor value plus hand-picked
// 256-color and 16-color stand-ins, so the same call site stays deliberate at
// every depth instead of collapsing to white.
//
// Backgrounds are painted only as *fills*: a saturated brand or semantic color
// with its own foreground set on top (`chip`, `bar`). Both halves are explicit,
// so a fill reads the same on a white terminal and a black one. What we never
// paint is a "surface" tint — a soft grey panel behind ordinary text — because
// that silently assumes the terminal's own background and lands as a smear on
// whichever half of the world guessed the other way.

interface Ink {
  rgb: readonly [number, number, number];
  x256: number;
  basic: number;
  /** Which text color stays legible on top of this one used as a fill. */
  on: "dark" | "light";
}

const INK = {
  // Crumbtrail blue #0099FF, plus the two ends of its gradient ramp.
  brand: { rgb: [0, 153, 255], x256: 39, basic: 36, on: "dark" },
  brandLift: { rgb: [92, 204, 255], x256: 81, basic: 96, on: "dark" },
  brandDeep: { rgb: [0, 102, 224], x256: 26, basic: 34, on: "light" },
  success: { rgb: [52, 180, 141], x256: 36, basic: 32, on: "dark" },
  warn: { rgb: [226, 160, 63], x256: 179, basic: 33, on: "dark" },
  danger: { rgb: [242, 85, 90], x256: 203, basic: 31, on: "light" },
  muted: { rgb: [141, 144, 150], x256: 245, basic: 37, on: "dark" },
} as const satisfies Record<string, Ink>;

export type InkName = keyof typeof INK;

function fgCode(name: InkName, level: ColorLevel): string {
  const value = INK[name];
  switch (level) {
    case 3: {
      const [r, g, b] = value.rgb;
      return `${CSI}38;2;${r};${g};${b}m`;
    }
    case 2:
      return `${CSI}38;5;${value.x256}m`;
    case 1:
      return `${CSI}${value.basic}m`;
    default:
      return "";
  }
}

function bgCode(name: InkName, level: ColorLevel): string {
  const value = INK[name];
  switch (level) {
    case 3: {
      const [r, g, b] = value.rgb;
      return `${CSI}48;2;${r};${g};${b}m`;
    }
    case 2:
      return `${CSI}48;5;${value.x256}m`;
    case 1:
      // The 16-color background codes are the foreground codes plus ten.
      return `${CSI}${value.basic + 10}m`;
    default:
      return "";
  }
}

/** The foreground that goes on top of a fill: near-black, or near-white. */
function fillText(on: "dark" | "light", level: ColorLevel): string {
  if (level === 0) return "";
  if (on === "light") {
    if (level === 3) return `${CSI}38;2;255;255;255m`;
    return level === 2 ? `${CSI}38;5;231m` : `${CSI}97m`;
  }
  if (level === 3) return `${CSI}38;2;6;18;28m`;
  return level === 2 ? `${CSI}38;5;232m` : `${CSI}30m`;
}

function wrap(open: string, s: string): string {
  if (!open) return s;
  // Re-open our own code after any nested reset, so a color.dim() in the middle
  // of a colored line does not leave the remainder of it unpainted. A string
  // that already ended in a reset would otherwise pick up a dangling re-open
  // before ours, so trim that back off.
  const body = s.split(RESET).join(RESET + open);
  return (
    open + (body.endsWith(open) ? body.slice(0, -open.length) : body) + RESET
  );
}

function ink(name: InkName, s: string): string {
  return wrap(fgCode(name, caps().colorLevel), s);
}

function style(code: string, s: string): string {
  return caps().colorLevel === 0 ? s : wrap(`${CSI}${code}m`, s);
}

/**
 * The color surface the wizard writes against. `bold`/`dim`/`green`/`cyan`/
 * `yellow`/`red` keep their long-standing names and call sites; the brand
 * entries are the new ones worth reaching for.
 */
export const color = {
  bold: (s: string) => style("1", s),
  dim: (s: string) => style("2", s),
  underline: (s: string) => style("4", s),
  green: (s: string) => ink("success", s),
  cyan: (s: string) => ink("brand", s),
  yellow: (s: string) => ink("warn", s),
  red: (s: string) => ink("danger", s),
  brand: (s: string) => ink("brand", s),
  brandLift: (s: string) => ink("brandLift", s),
  brandDeep: (s: string) => ink("brandDeep", s),
  muted: (s: string) => ink("muted", s),
};

/**
 * Paint `s` along the brand ramp, character by character. Only meaningful at
 * truecolor; at every lower depth it is a flat brand color, which is the right
 * answer rather than a dithered mess.
 */
export function gradient(s: string): string {
  const level = caps().colorLevel;
  if (level < 3) return level === 0 ? s : color.brand(s);
  const from = INK.brandLift.rgb;
  const to = INK.brandDeep.rgb;
  const chars = [...s];
  const span = Math.max(1, chars.length - 1);
  const painted = chars
    .map((ch, i) => {
      if (ch === " ") return ch;
      const t = i / span;
      const r = Math.round(from[0] + (to[0] - from[0]) * t);
      const g = Math.round(from[1] + (to[1] - from[1]) * t);
      const b = Math.round(from[2] + (to[2] - from[2]) * t);
      return `${CSI}38;2;${r};${g};${b}m${ch}`;
    })
    .join("");
  return painted + RESET;
}

/**
 * A filled label — `chip(" 3/6 ")` — carrying its own foreground. Pass the text
 * with the padding you want inside the fill; a colorless terminal gets the text
 * back trimmed, so the same call site reads correctly with no color at all.
 */
export function chip(text: string, name: InkName = "brand"): string {
  const level = caps().colorLevel;
  if (level === 0) return text.trim();
  return `${bgCode(name, level)}${fillText(INK[name].on, level)}${CSI}1m${text}${RESET}`;
}

/**
 * A full-width filled bar. At truecolor the fill is swept along the brand ramp
 * left to right; below that it is a single flat brand fill, which is the honest
 * answer rather than a banded approximation. The text on top is near-black at
 * every depth, because both ends of the ramp are light enough to need it.
 */
export function bar(
  content: string,
  width = caps().width,
  name: InkName = "brand",
): string {
  const level = caps().colorLevel;
  // Marked, never silent. A bare slice ate the last characters of the line, and
  // the end of that line is where the bar carries its payload: the run printed
  // "Setup complete - project kartbu" for a project named kartbug.
  const mark = glyphs().ellipsis;
  const plain =
    content.length > width
      ? `${content.slice(0, Math.max(0, width - mark.length))}${mark}`.slice(
          0,
          width,
        )
      : content;
  const padded = plain.padEnd(width);
  if (level === 0) return padded.trimEnd();
  const text = fillText(INK[name].on, level);
  if (level < 3 || name !== "brand")
    return `${bgCode(name, level)}${text}${CSI}1m${padded}${RESET}`;

  const from = INK.brandLift.rgb;
  const to = INK.brand.rgb;
  const span = Math.max(1, padded.length - 1);
  let out = `${text}${CSI}1m`;
  for (const [i, ch] of [...padded].entries()) {
    const t = i / span;
    const r = Math.round(from[0] + (to[0] - from[0]) * t);
    const g = Math.round(from[1] + (to[1] - from[1]) * t);
    const b = Math.round(from[2] + (to[2] - from[2]) * t);
    out += `${CSI}48;2;${r};${g};${b}m${ch}`;
  }
  return out + RESET;
}

// ── Glyphs ───────────────────────────────────────────────────────────────────

export interface Glyphs {
  tick: string;
  cross: string;
  warn: string;
  bullet: string;
  pointer: string;
  arrow: string;
  crumb: string;
  crumbSmall: string;
  rule: string;
  rail: string;
  /** Marks a line the terminal was too narrow to hold. */
  ellipsis: string;
  spinner: string[];
}

const UNICODE_GLYPHS: Glyphs = {
  tick: "✓",
  cross: "✗",
  warn: "▲",
  bullet: "·",
  pointer: "❯",
  arrow: "→",
  crumb: "●",
  crumbSmall: "·",
  rule: "─",
  rail: "│",
  ellipsis: "…",
  // Braille frames: one cell wide everywhere, unlike the emoji-style spinners
  // that render double-width in some terminals and tear the redraw.
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

const ASCII_GLYPHS: Glyphs = {
  tick: "+",
  cross: "x",
  warn: "!",
  bullet: "-",
  pointer: ">",
  arrow: "->",
  crumb: "o",
  crumbSmall: ".",
  rule: "-",
  rail: "|",
  ellipsis: "...",
  spinner: ["|", "/", "-", "\\"],
};

/**
 * Typographic characters that appear in ordinary copy — em dashes, ellipses,
 * curly quotes — and their ASCII stand-ins. On a console that cannot render
 * UTF-8 (legacy Windows conhost under code page 437/850, or a C-locale
 * terminal) these arrive as mojibake, which reads as a broken program rather
 * than as a punctuation mark. Folding them is cheaper than policing every
 * string in the wizard.
 */
const ASCII_FOLD: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u2014\u2013]/g, "-"],
  [/\u2026/g, "..."],
  [/[\u2018\u2019]/g, "'"],
  [/[\u201C\u201D]/g, '"'],
  [/\u00B7/g, "-"],
  [/\u2022/g, "*"],
  [/\u00A0/g, " "],
  [/[\u2190-\u21FF]/g, "->"],
];

/** Apply the fold above, but only where the terminal needs it. */
export function foldForTerminal(line: string): string {
  if (caps().unicode) return line;
  let out = line;
  for (const [pattern, replacement] of ASCII_FOLD) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function glyphs(): Glyphs {
  return caps().unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;
}

// ── Composition helpers ──────────────────────────────────────────────────────

/** Visible length, ignoring ANSI escapes. */
export function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001B\[[0-9;]*m/g, "").length;
}

// Every status line sits on the same two-space gutter as the banner, the step
// headers and the summary, so a long transcript reads as one column. The state
// lives in a filled square at the head of the line rather than in the wording,
// which is what lets the eye find the one failure in forty lines.
export const ok = (s: string): string =>
  `  ${chip(` ${glyphs().tick} `, "success")} ${s}`;
export const bad = (s: string): string =>
  `  ${chip(` ${glyphs().cross} `, "danger")} ${s}`;
export const alert = (s: string): string =>
  `  ${chip(` ${glyphs().warn} `, "warn")} ${s}`;
export const note = (s: string): string =>
  `  ${color.brandDeep(glyphs().bullet)} ${color.dim(s)}`;

/** A dim brand rule sized to the terminal. */
export function rule(width = caps().width): string {
  return color.brandDeep(glyphs().rule.repeat(Math.max(8, width)));
}

/**
 * A numbered step header: a filled step counter, the title, and a rail running
 * out to the right margin so each step reads as a band rather than a sentence.
 */
export function step(n: number, total: number, title: string): string {
  const head = `  ${chip(` ${n}/${total} `, "brandDeep")}  ${color.bold(title)}`;
  const trail = caps().width - visibleLength(head) - 3;
  const tail =
    trail > 3 ? ` ${color.brandDeep(glyphs().rule.repeat(trail))}` : "";
  return `\n${head}${tail}`;
}

/**
 * A headline for a finished phase — the one line a reader should catch while
 * scrolling past. `chip` carries the state, the title carries the detail.
 */
export function headline(
  label: string,
  title: string,
  name: InkName = "success",
): string {
  return `  ${chip(` ${label} `, name)}  ${color.bold(title)}`;
}

/** The end-cap of a run: one full-width filled line stating how it went. */
export function outcomeBar(label: string, name: InkName = "success"): string {
  const inner = Math.max(24, caps().width - 4);
  return `  ${bar(`  ${label}`, inner, name)}`;
}

/** An aligned "  Label:    value" summary row. */
export function field(label: string, value: string, pad = 11): string {
  return `  ${color.brandDeep(glyphs().rail)} ${color.dim(`${label}:`.padEnd(pad))} ${value}`;
}

/**
 * The wordmark, set in a filled brand bar: the trail of crumbs leading to the
 * name, the version pinned to the right edge. Narrow, ASCII-only and colorless
 * terminals get the same shape with plainer parts, never a broken box.
 */
export function banner(version: string, tagline: string): string[] {
  const g = glyphs();
  const width = caps().width;
  const inner = Math.max(24, width - 4);
  const left = `  ${g.crumbSmall} ${g.crumbSmall} ${g.crumb}  crumbtrail`;
  const stamp = `v${version}  `;
  const gap = inner - left.length - stamp.length;
  const content =
    gap > 1 ? `${left}${" ".repeat(gap)}${stamp}` : `${left}  ${stamp}`;
  return [
    "",
    `  ${bar(content, inner)}`,
    `  ${color.brandDeep(g.rule.repeat(inner))}`,
    `  ${color.dim(tagline)}`,
  ];
}

// ── Spinner ──────────────────────────────────────────────────────────────────

export interface Spinner {
  /** Replace the trailing text without restarting the animation. */
  setLabel(label: string): void;
  /**
   * Clear the live line so a caller can print something permanent, then bring
   * the animation back. On a non-animating sink both are no-ops, so a CI log
   * does not collect a copy of the label per interruption.
   */
  pause(): void;
  resume(): void;
  /** Clear the line and stop the timer. Safe to call twice. */
  stop(): void;
}

export interface SpinnerSink {
  out(line?: string): void;
  status?(line?: string): void;
}

/**
 * An animated single-line status. Only animates on a real TTY that has a
 * `status` sink; anywhere else (pipes, CI, dumb terminals, the test suite) it
 * prints the label once and does nothing further — so no timer is created and no
 * escape codes reach a log file. The interval is unref'd, so a spinner nobody
 * stopped can never hold the process open.
 */
export function startSpinner(sink: SpinnerSink, label: string): Spinner {
  let current = label;

  if (sink.status == null || !caps().interactive) {
    sink.out(color.dim(label));
    return {
      setLabel(l: string) {
        current = l;
      },
      pause() {},
      resume() {},
      stop() {
        void current;
      },
    };
  }

  const frames = glyphs().spinner;
  let i = 0;
  const paint = () => {
    const frame = color.brand(frames[i % frames.length]);
    i += 1;
    sink.status?.(`${frame} ${color.dim(current)}`);
  };
  paint();
  let timer = setInterval(paint, 90);
  timer.unref?.();

  let stopped = false;
  let paused = false;
  return {
    setLabel(l: string) {
      current = l;
    },
    pause() {
      if (stopped || paused) return;
      paused = true;
      clearInterval(timer);
      sink.status?.();
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      paint();
      timer = setInterval(paint, 90);
      timer.unref?.();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      sink.status?.();
    },
  };
}
