// Tiny terminal helpers — color + prompts over plain stdin/readline, no CLI
// framework dependency (keeps npx cold-start fast, per §1). All output goes
// through `Ui`, an injectable sink so the wizard is testable without a real TTY.

import readline from "node:readline";

const useColor = process.stdout.isTTY === true && process.env.NO_COLOR == null;

function paint(code: string, s: string): string {
  return useColor ? `[${code}m${s}[0m` : s;
}

export const color = {
  bold: (s: string) => paint("1", s),
  dim: (s: string) => paint("2", s),
  green: (s: string) => paint("32", s),
  cyan: (s: string) => paint("36", s),
  yellow: (s: string) => paint("33", s),
  red: (s: string) => paint("31", s),
};

/** Mask the middle of a secret: first 8 + last 4, dots between. */
export function maskKey(key: string): string {
  if (key.length <= 12) return "•".repeat(key.length);
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/** Output sink — swappable in tests to capture lines instead of writing stdout. */
export interface Ui {
  out(line?: string): void;
  err(line?: string): void;
  /**
   * Rewrite a transient single-line status in place (a live "Waiting… 12s"
   * ticker). TTY-only; calling with no argument clears the line. Callers MUST
   * clear before the next out()/err() or the lines collide.
   */
  status?(line?: string): void;
}

export const consoleUi: Ui = {
  out: (line = "") => process.stdout.write(line + "\n"),
  err: (line = "") => process.stderr.write(line + "\n"),
  status: (line = "") => {
    if (process.stdout.isTTY !== true) return;
    // \r + erase-line, then the fresh status text (nothing for a clear).
    process.stdout.write(`\r[2K${line}`);
  },
};

/** One row of a `multiSelect` list. */
export interface MultiSelectItem {
  /** Primary text, e.g. "apps/web". */
  label: string;
  /** Trailing detail, e.g. "next" or "already wired — skipping". */
  hint?: string;
  /** Whether this row starts checked (drives the empty-input default). */
  checked: boolean;
  /**
   * False for rows we can list but cannot wire (no recipe matched). Rendered
   * greyed out and rejected if the user names them explicitly — listing them is
   * how we show the scan wasn't blind to the package.
   */
  selectable: boolean;
}

/** Prompts the wizard needs — injectable so tests answer without a TTY. */
export interface Prompter {
  /** Free-text with a default; empty input returns the default. */
  ask(question: string, def?: string): Promise<string>;
  /** Yes/no; empty input returns `def`. */
  confirm(question: string, def?: boolean): Promise<boolean>;
  /** 1-based numeric choice among labels; empty input returns `def` (0-based). */
  select(question: string, labels: string[], def?: number): Promise<number>;
  /**
   * 1-based multi-choice; returns 0-based indices. Empty input takes the
   * checked defaults. Number-list based (no raw mode / arrow keys anywhere in
   * this CLI).
   */
  multiSelect(question: string, items: MultiSelectItem[]): Promise<number[]>;
}

export type SelectionParse =
  | { ok: true; indices: number[] }
  | { ok: false; error: string };

/**
 * Parse a multi-select answer. Pure and separately exported so the grammar is
 * unit-testable without a TTY.
 *
 * Accepts: "" (the checked defaults), "all", "none", "1,3", "1-3,6", and any
 * mix separated by commas or whitespace. Rejects non-numeric tokens, indices
 * out of range, and indices naming an unselectable row.
 */
export function parseSelection(
  input: string,
  items: MultiSelectItem[],
): SelectionParse {
  const trimmed = input.trim().toLowerCase();
  const selectable = (i: number) => items[i].selectable;

  if (!trimmed) {
    return {
      ok: true,
      indices: items
        .map((it, i) => (it.checked && it.selectable ? i : -1))
        .filter((i) => i >= 0),
    };
  }
  if (trimmed === "none") return { ok: true, indices: [] };
  if (trimmed === "all") {
    return {
      ok: true,
      indices: items.map((_, i) => i).filter(selectable),
    };
  }

  const picked = new Set<number>();
  for (const token of trimmed.split(/[,\s]+/).filter(Boolean)) {
    const range = token.match(/^(\d+)-(\d+)$/);
    const bounds = range
      ? [Number(range[1]), Number(range[2])]
      : /^\d+$/.test(token)
        ? [Number(token), Number(token)]
        : null;
    if (!bounds) {
      return {
        ok: false,
        error: `"${token}" isn't a number, a range like 1-3, "all", or "none".`,
      };
    }
    const [lo, hi] = bounds;
    if (lo < 1 || hi > items.length || lo > hi) {
      return {
        ok: false,
        error: `"${token}" is out of range — pick between 1 and ${items.length}.`,
      };
    }
    for (let n = lo; n <= hi; n += 1) {
      const i = n - 1;
      if (!selectable(i)) {
        return {
          ok: false,
          error: `${n} (${items[i].label}) has no supported framework — it can't be wired.`,
        };
      }
      picked.add(i);
    }
  }
  return { ok: true, indices: [...picked].sort((a, b) => a - b) };
}

/** Render one multiSelect row: "   1. [x] apps/web   next". */
function renderItem(item: MultiSelectItem, index: number): string {
  const hint = item.hint ? `  ${color.dim(item.hint)}` : "";
  if (!item.selectable) {
    return `   ${color.dim("-")}  ${color.dim("·")}  ${color.dim(item.label)}${hint}`;
  }
  const n = color.cyan(String(index + 1).padStart(2));
  return `  ${n}. ${item.checked ? "[x]" : "[ ]"} ${item.label}${hint}`;
}

function rl(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function question(prompt: string): Promise<string> {
  const r = rl();
  return new Promise((resolve) => {
    r.question(prompt, (answer) => {
      r.close();
      resolve(answer);
    });
  });
}

/** The real stdin-backed prompter. */
export const stdinPrompter: Prompter = {
  async ask(q, def) {
    const suffix = def ? ` ${color.dim(`(${def})`)}` : "";
    const answer = (await question(`${q}${suffix} `)).trim();
    return answer || def || "";
  },
  async confirm(q, def = true) {
    const hint = def ? "Y/n" : "y/N";
    const answer = (await question(`${q} ${color.dim(`[${hint}]`)} `))
      .trim()
      .toLowerCase();
    if (!answer) return def;
    return answer === "y" || answer === "yes";
  },
  async select(q, labels, def = 0) {
    const r = rl();
    try {
      while (true) {
        const lines = [
          q,
          ...labels.map((l, i) => `  ${color.cyan(String(i + 1))}. ${l}`),
        ];
        process.stdout.write(lines.join("\n") + "\n");
        const answer = await new Promise<string>((resolve) => {
          r.question(
            `Choose ${color.dim(`(1-${labels.length}, default ${def + 1})`)}: `,
            resolve,
          );
        });
        const trimmed = answer.trim();
        if (!trimmed) return def;
        const n = Number(trimmed);
        if (Number.isInteger(n) && n >= 1 && n <= labels.length) return n - 1;
        process.stdout.write(
          color.yellow(`Enter a number between 1 and ${labels.length}.\n`),
        );
      }
    } finally {
      r.close();
    }
  },
  async multiSelect(q, items) {
    const r = rl();
    try {
      while (true) {
        const lines = [q, ...items.map(renderItem)];
        process.stdout.write(lines.join("\n") + "\n");
        const answer = await new Promise<string>((resolve) => {
          r.question(
            `Enter numbers ${color.dim('(e.g. 1,3 or 1-2), "all", "none", or Enter for the checked defaults')}: `,
            resolve,
          );
        });
        const parsed = parseSelection(answer, items);
        if (parsed.ok) return parsed.indices;
        process.stdout.write(color.yellow(`${parsed.error}\n`));
      }
    } finally {
      r.close();
    }
  },
};

/**
 * Read a single line from stdin, resolving undefined if stdin closes first.
 * Used by the browser-handoff flow to race a pasted code against the localhost
 * callback. The returned `cancel` detaches the listener so the winner of the
 * race doesn't leave stdin half-consumed.
 */
export function readStdinLine(): {
  promise: Promise<string | undefined>;
  cancel: () => void;
} {
  const stdin = process.stdin;
  let settled = false;
  let onData: ((chunk: Buffer) => void) | undefined;
  let onEnd: (() => void) | undefined;
  let buffer = "";

  const promise = new Promise<string | undefined>((resolve) => {
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      if (onData) stdin.off("data", onData);
      if (onEnd) stdin.off("end", onEnd);
      stdin.pause();
      resolve(value);
    };
    onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl >= 0) finish(buffer.slice(0, nl).trim());
    };
    onEnd = () => finish(buffer.trim() || undefined);
    stdin.resume();
    stdin.on("data", onData);
    stdin.on("end", onEnd);
  });

  const cancel = () => {
    if (settled) return;
    settled = true;
    if (onData) stdin.off("data", onData);
    if (onEnd) stdin.off("end", onEnd);
    stdin.pause();
  };

  return { promise, cancel };
}
