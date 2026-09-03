// Amending an integration the customer already has, instead of refusing it.
//
// `buildPlan` will not put a second `Crumbtrail.init` beside someone's own — that
// is right, and it is also why a project that is one field short of complete used
// to end the run with "wire it yourself". This module closes that gap: it finds
// the options object already in the source and adds ONLY the keys that are
// absent from it, leaving every other byte of the file exactly as it was.
//
// Three rules do not bend:
//   1. The ingest key is never written into a file. The key requirement is met by
//      adding the ENV EXPRESSION the recipe reads (`import.meta.env.VITE_…`), and
//      the value goes to the env file through the normal path. A recipe with no
//      env mechanism is therefore not amendable for the key at all.
//   2. A key the customer already set is never overwritten — not even when its
//      value disagrees with what this run wanted. Present means present.
//   3. Anything this module cannot parse with confidence returns null, and the
//      caller falls back to the existing guidance. A wrong edit to someone's
//      entry file is far worse than a printed snippet.

import type { IntegrationRequirement } from "./integration";
import type { CrumbtrailConfig } from "crumbtrail-core";
import type {
  AutoCaptureOptions,
  CrumbtrailExpressOptions,
} from "crumbtrail-node";

/** How many call sites one amend may touch, so a pathological file can't run away. */
const MAX_CALL_SITES = 4;

/** The init-like calls whose options object this module knows how to extend. */
export const AMENDABLE_CALLEES = [
  "Crumbtrail.init",
  "autoCapture",
  "createCrumbtrailExpressMiddleware",
  "createCrumbtrailExpressErrorMiddleware",
] as const;

export type AmendableCallee = (typeof AMENDABLE_CALLEES)[number];

/**
 * Which option name carries each requirement, per call.
 *
 * `Crumbtrail.init` is the browser/core config shape; every crumbtrail-node entry
 * point takes the shorter server shape. Split by callee rather than by recipe
 * because one Express entry legitimately contains both.
 */
type StringKeyOf<T> = Extract<keyof T, string>;

interface FieldNames {
  "Crumbtrail.init": Partial<
    Record<IntegrationRequirement, StringKeyOf<CrumbtrailConfig>>
  >;
  autoCapture: Partial<
    Record<IntegrationRequirement, StringKeyOf<AutoCaptureOptions>>
  >;
  createCrumbtrailExpressMiddleware: Partial<
    Record<IntegrationRequirement, StringKeyOf<CrumbtrailExpressOptions>>
  >;
  createCrumbtrailExpressErrorMiddleware: Partial<
    Record<IntegrationRequirement, StringKeyOf<CrumbtrailExpressOptions>>
  >;
}

export const FIELD_NAMES: FieldNames = {
  "Crumbtrail.init": {
    endpoint: "httpEndpoint",
    "ingest-key": "httpAuthToken",
    "service-name": "service",
    "remote-config": "remoteConfig",
  },
  autoCapture: {
    endpoint: "endpoint",
    "ingest-key": "authToken",
    "service-name": "service",
  },
  createCrumbtrailExpressMiddleware: {
    endpoint: "endpoint",
    "ingest-key": "authToken",
  },
  createCrumbtrailExpressErrorMiddleware: {
    endpoint: "endpoint",
    "ingest-key": "authToken",
  },
};

/**
 * Spreads whose contents are known and provably carry none of the four options
 * this module adds, so a call that uses one is still safe to extend. Every other
 * spread is opaque: it could already be setting `httpEndpoint`, and appending a
 * second one would silently override the customer's own value.
 */
const TRANSPARENT_SPREAD = /^\.\.\.\s*PRESET_[A-Z][A-Z0-9_]*$/;

export interface CallSite {
  callee: AmendableCallee;
  /** Offset of the options object's `{`. */
  open: number;
  /** Offset of its matching `}`. */
  close: number;
  /**
   * Top-level option names already present, mapped to the exact source of their
   * value. The value matters as much as the name: `service: "asiniq-admin"` and
   * `service: SERVICE` are both "already set", but only the first one can be
   * quoted back to the user as the name their app reports under.
   */
  keys: Map<string, string>;
  /** A spread whose keys cannot be enumerated — nothing may be added here. */
  opaqueSpread: boolean;
  /** True when the whole object sits on one line. */
  singleLine: boolean;
  /** The `"` vs `'` the surrounding object already uses. */
  quote: (value: string) => string;
}

function doubleQuoted(value: string): string {
  return JSON.stringify(value);
}

function singleQuoted(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * A copy of `text` with the CONTENT of every string, template and comment
 * replaced by spaces, and every regex literal blanked too.
 *
 * Structural characters (quotes, braces, commas) keep their positions, so a
 * regex run over the mask reports offsets that are still valid in the original.
 * This is what makes brace matching safe against `"}"` in a string and `// }` in
 * a comment without writing a second, divergent scanner for each question.
 *
 * Returns null when the scan ends inside an unterminated string or comment: a
 * file we cannot tokenize is a file we refuse to edit.
 */
export function maskLiterals(text: string): string | null {
  const out = text.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };
  // Template literals nest: `${ `${x}` }`. Each entry is the brace depth at
  // which the enclosing template's `${` was opened.
  const templateStack: number[] = [];
  let braceDepth = 0;
  let i = 0;
  // The last structurally significant character, which is how a division is told
  // from the start of a regex literal.
  let prevSignificant = "";

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return null;
      blank(i, end + 2);
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // A quoted string cannot span a line. So a quote with no partner before
      // the newline is not a string at all — overwhelmingly it is an apostrophe
      // in JSX text (`<p>don't</p>`), and treating it as an opening quote used
      // to swallow the rest of the file and make every .jsx entry unamendable.
      let j = i + 1;
      let closed = false;
      while (j < text.length && text[j] !== "\n") {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === ch) {
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) {
        prevSignificant = ch;
        i += 1;
        continue;
      }
      blank(i + 1, j);
      i = j + 1;
      prevSignificant = ch;
      continue;
    }
    if (ch === "`") {
      let j = i + 1;
      let closed = false;
      while (j < text.length) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === "$" && text[j + 1] === "{") {
          blank(i + 1, j);
          templateStack.push(braceDepth);
          braceDepth += 1;
          i = j + 2;
          prevSignificant = "{";
          closed = true;
          break;
        }
        if (text[j] === "`") {
          blank(i + 1, j);
          i = j + 1;
          prevSignificant = "`";
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) return null;
      continue;
    }
    if (
      ch === "/" &&
      // `<` and `>` are deliberately NOT regex-start characters here: `</div>`
      // would otherwise open a regex that never closes. A regex literal cannot
      // span a line either, so one that finds no partner on its own line is
      // read as ordinary punctuation (the `/` in `<App />`) rather than as a
      // reason to refuse the file.
      (prevSignificant === "" || "(,=:[!&|?{};+-*%~^".includes(prevSignificant))
    ) {
      // Regex literal. Character classes may contain an unescaped `/`.
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < text.length) {
        const c = text[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "\n") break;
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        blank(i + 1, j);
        i = j + 1;
        prevSignificant = "/";
        continue;
      }
    }
    if (ch === "{") braceDepth += 1;
    if (ch === "}") {
      braceDepth -= 1;
      const resumed = templateStack[templateStack.length - 1];
      if (resumed !== undefined && braceDepth === resumed) {
        // Back out into the template literal this `${` interrupted.
        templateStack.pop();
        let j = i + 1;
        let closed = false;
        while (j < text.length) {
          if (text[j] === "\\") {
            j += 2;
            continue;
          }
          if (text[j] === "$" && text[j + 1] === "{") {
            blank(i + 1, j);
            templateStack.push(braceDepth);
            braceDepth += 1;
            i = j + 2;
            prevSignificant = "{";
            closed = true;
            break;
          }
          if (text[j] === "`") {
            blank(i + 1, j);
            i = j + 1;
            prevSignificant = "`";
            closed = true;
            break;
          }
          j += 1;
        }
        if (!closed) return null;
        continue;
      }
    }
    if (!/\s/.test(ch)) prevSignificant = ch;
    i += 1;
  }
  if (templateStack.length > 0) return null;
  return out.join("");
}

/** Offset of the `}` matching the `{` at `open`, or -1. Runs over the mask. */
function matchBrace(mask: string, open: number): number {
  let depth = 0;
  for (let i = open; i < mask.length; i += 1) {
    const ch = mask[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split the object body into top-level property segments, as [start, end) pairs. */
function topLevelSegments(
  mask: string,
  open: number,
  close: number,
): Array<[number, number]> {
  const segments: Array<[number, number]> = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i += 1) {
    const ch = mask[i];
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) {
      segments.push([start, i]);
      start = i + 1;
    }
  }
  segments.push([start, close]);
  return segments.filter(([a, b]) => mask.slice(a, b).trim().length > 0);
}

const PROPERTY_NAME =
  /^(?:(['"])([A-Za-z_$][\w$]*)\1|([A-Za-z_$][\w$]*))\s*(?::|\(|$)/;

/**
 * Locate every init-like call in `text` whose options object can be reasoned
 * about. A call whose shape is not understood is simply not returned, which is
 * what makes the caller fall back to guidance rather than guess.
 */
export function findCallSites(text: string): CallSite[] {
  const mask = maskLiterals(text);
  if (mask === null) return [];
  const sites: CallSite[] = [];

  for (const callee of AMENDABLE_CALLEES) {
    // Match on the mask so a callee name appearing inside a comment or a string
    // is never mistaken for a call. The optional member prefix is what finds the
    // real crumbtrail-node calls: an app that imports the module as a namespace
    // writes `ct.createCrumbtrailExpressMiddleware({…})`, and requiring a bare
    // identifier missed every one of them.
    const pattern = new RegExp(
      `(?:^|[^\\w$.])(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)*${callee.replaceAll(".", "\\.")}\\s*\\(`,
      "g",
    );
    for (const match of mask.matchAll(pattern)) {
      const parenAt = match.index + match[0].length - 1;
      let cursor = parenAt + 1;
      while (cursor < mask.length && /\s/.test(mask[cursor])) cursor += 1;
      // Only a call whose FIRST argument is an object literal is amendable. A
      // variable (`init(config)`) is a different file's problem and guessing at
      // it is exactly what rule 3 forbids.
      if (mask[cursor] !== "{") continue;
      const open = cursor;
      const close = matchBrace(mask, open);
      if (close === -1) continue;

      const keys = new Map<string, string>();
      let opaqueSpread = false;
      for (const [from, to] of topLevelSegments(mask, open, close)) {
        const segment = mask.slice(from, to).trim();
        if (segment.startsWith("...")) {
          if (!TRANSPARENT_SPREAD.test(segment)) opaqueSpread = true;
          continue;
        }
        const named = PROPERTY_NAME.exec(segment);
        if (!named) {
          // A computed key, a getter, something unparsed: we no longer know what
          // this object sets, so nothing may be appended to it.
          opaqueSpread = true;
          continue;
        }
        // The value is read from the ORIGINAL text, so a quoted literal comes
        // back with its content intact rather than as the blanked mask.
        const raw = text.slice(from, to);
        const colon = raw.indexOf(":", raw.indexOf(named[2] ?? named[3]));
        keys.set(
          named[2] ?? named[3],
          colon === -1 ? "" : raw.slice(colon + 1).trim(),
        );
      }

      const body = text.slice(open, close + 1);
      const singleQuotes = (mask.slice(open, close + 1).match(/'/g) ?? [])
        .length;
      const doubleQuotes = (mask.slice(open, close + 1).match(/"/g) ?? [])
        .length;
      sites.push({
        callee,
        open,
        close,
        keys,
        opaqueSpread,
        singleLine: !body.includes("\n"),
        quote: singleQuotes > doubleQuotes ? singleQuoted : doubleQuoted,
      });
      if (sites.length >= MAX_CALL_SITES) return sites;
    }
  }
  return sites.sort((a, b) => a.open - b.open);
}

/** One option this amend would add. */
export interface AmendField {
  requirement: IntegrationRequirement;
  /** Literal source for the value, or a builder when it depends on the callee. */
  value:
    string | ((callee: AmendableCallee, quote: CallSite["quote"]) => string);
}

export interface AmendBlocked {
  requirement: IntegrationRequirement;
  /** The option name that already exists, when that is the reason. */
  existingKey?: string;
  /** The exact source of that option's value, so guidance can quote it. */
  existingValue?: string;
  reason: "already-set" | "unsupported-here" | "unparsable";
}

export interface AmendOutcome {
  /** The full amended file text. Absent when nothing could be added. */
  text?: string;
  /** Requirements actually satisfied by an added option. */
  added: IntegrationRequirement[];
  /** The option NAMES written, e.g. ["remoteConfig", "service"]. */
  addedFields: string[];
  /** Requirements this file could not satisfy, each with the reason why. */
  blocked: AmendBlocked[];
}

/**
 * Add the requested options to every init-like call in `text` that is missing
 * them, and return the new file bytes.
 *
 * Every byte outside the inserted lines is preserved verbatim — the insertion is
 * a splice before the options object's closing brace, never a reformat, and the
 * existing properties, comments and blank lines are not read back out and
 * re-emitted.
 */
export function amendSource(
  text: string,
  fields: AmendField[],
): AmendOutcome | null {
  const sites = findCallSites(text);
  if (sites.length === 0) return null;
  if (
    sites.some(
      (site) =>
        site.callee === "Crumbtrail.init" && site.keys.has("transportInstance"),
    )
  ) {
    return { added: [], addedFields: [], blocked: [] };
  }

  const added = new Set<IntegrationRequirement>();
  const addedFields = new Set<string>();
  const blocked = new Map<IntegrationRequirement, AmendOutcome["blocked"][0]>();
  // Applied back-to-front so an earlier splice cannot move a later offset.
  const splices: Array<{ at: number; insert: string }> = [];

  for (const site of sites) {
    for (const field of fields) {
      const name = FIELD_NAMES[site.callee][field.requirement];
      if (!name) {
        if (!blocked.has(field.requirement)) {
          blocked.set(field.requirement, {
            requirement: field.requirement,
            reason: "unsupported-here",
          });
        }
        continue;
      }
      if (site.keys.has(name)) {
        const existingValue = site.keys.get(name)?.trim();
        const requestedValue =
          typeof field.value === "string" ? field.value.trim() : undefined;
        if (
          requestedValue !== undefined &&
          existingValue !== undefined &&
          existingValue === requestedValue
        ) {
          continue;
        }
        blocked.set(field.requirement, {
          requirement: field.requirement,
          existingKey: name,
          existingValue: site.keys.get(name),
          reason: "already-set",
        });
        continue;
      }
      if (site.opaqueSpread) {
        blocked.set(field.requirement, {
          requirement: field.requirement,
          reason: "unparsable",
        });
        continue;
      }
      const value =
        typeof field.value === "function"
          ? field.value(site.callee, site.quote)
          : field.value;
      splices.push({
        at: site.close,
        insert: `${name}: ${value}`,
      });
      added.add(field.requirement);
      addedFields.add(name);
    }
  }
  if (splices.length === 0) {
    return { added: [], addedFields: [], blocked: [...blocked.values()] };
  }

  // Group the insertions by call site so one object gets one contiguous block.
  const byClose = new Map<number, string[]>();
  for (const splice of splices) {
    const list = byClose.get(splice.at) ?? [];
    list.push(splice.insert);
    byClose.set(splice.at, list);
  }

  let out = text;
  const closes = [...byClose.keys()].sort((a, b) => b - a);
  for (const close of closes) {
    const site = sites.find((s) => s.close === close)!;
    const props = byClose.get(close)!;
    const rendered = renderInsertion(out, site, props);
    if (rendered === null) {
      // The insertion point could not be described. Refuse the whole edit — a
      // partial amend is a file the user has to inspect anyway.
      return null;
    }
    // Descending, so an earlier splice never moves a later offset.
    for (const splice of [...rendered].sort((a, b) => b.at - a.at)) {
      out = out.slice(0, splice.at) + splice.insert + out.slice(splice.at);
    }
  }

  // A key that some call sites accepted and others already had is satisfied.
  for (const requirement of added) blocked.delete(requirement);
  if (blocked.size > 0) {
    return {
      added: [...added],
      addedFields: [...addedFields],
      blocked: [...blocked.values()],
    };
  }
  return {
    text: out,
    added: [...added],
    addedFields: [...addedFields],
    blocked: [...blocked.values()],
  };
}

/**
 * Where the new properties go, and exactly what text lands there.
 *
 * Returns splices rather than one string because a call whose last property has
 * no trailing comma needs TWO edits: the comma goes after that property, and the
 * new lines go above the closing brace. Emitting them as one blob is what
 * produced `a: 1` followed by an un-separated `service: "…"`.
 */
function renderInsertion(
  text: string,
  site: CallSite,
  props: string[],
): Array<{ at: number; insert: string }> | null {
  const mask = maskLiterals(text);
  if (mask === null) return null;

  // Last thing in the object before its closing brace, ignoring comments and
  // whitespace: it decides whether a separating comma is needed.
  let last = site.close - 1;
  while (last > site.open && /\s/.test(mask[last])) last -= 1;
  const needsComma = mask[last] !== "," && mask[last] !== "{";
  const comma = needsComma ? [{ at: last + 1, insert: "," }] : [];

  const lineStart = text.lastIndexOf("\n", site.close) + 1;
  const closingLineIsBare =
    mask.slice(lineStart, site.close).trim().length === 0;

  if (site.singleLine || !closingLineIsBare) {
    // `autoCapture({ endpoint: x, authToken: y })`, or a closing brace sharing a
    // line with the last property: stay inline rather than reflow the call.
    return [
      {
        at: last + 1,
        insert: `${needsComma ? "," : ""} ${props.join(", ")}`,
      },
    ];
  }

  const braceIndent = /^[ \t]*/.exec(text.slice(lineStart, site.close))![0];
  const indent = braceIndent + inferIndentUnit(text, site);
  const block = props.map((p) => `${indent}${p},`).join("\n");
  return [...comma, { at: lineStart, insert: `${block}\n` }];
}

/** The indentation step this object already uses, defaulting to two spaces. */
function inferIndentUnit(text: string, site: CallSite): string {
  const lineStart = text.lastIndexOf("\n", site.close) + 1;
  const braceIndent = /^[ \t]*/.exec(text.slice(lineStart, site.close))![0];
  for (const line of text.slice(site.open, site.close).split("\n").slice(1)) {
    const lead = /^[ \t]*/.exec(line)![0];
    if (line.trim().length > 0 && lead.length > braceIndent.length) {
      return lead.slice(braceIndent.length);
    }
  }
  return "  ";
}
