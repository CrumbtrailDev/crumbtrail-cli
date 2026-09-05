import type { EventBus } from "../event-bus";
import type { CrumbtrailConfig, CollectorCleanup } from "../types";
import { UI_LAYOUT_EVENT_KIND, UI_NUM_EVENT_KIND } from "../types";
import {
  attachRedactionMetadata,
  classifyStructuredValue,
  redactUrl,
} from "../redaction";
import {
  buildCaptureGapEvent,
  type BuildCaptureGapEventInput,
} from "../capture-gap";
import { now } from "../utils";
import { subscribeNavCommit } from "../nav-signal";

/**
 * Display capture: labeled numeric tokens visible on screen, emitted as
 * compact `ui.num` snapshots so backend detectors can check display arithmetic
 * (subtotal + tax vs total) and UI↔API divergence. No raw DOM/HTML is ever
 * captured — only short labels and parsed numbers.
 *
 * Three shapes reach an item: a leaf whose entire text is a numeric token, a
 * leaf whose entire text is a short count phrase ("31 people", "Page 1 of 1"),
 * and a pager control's enabled/disabled state. The last two exist because a
 * list screen states its own pagination in prose and in a disabled button, so
 * a token-only reading saw nothing at all on the page where the count was the
 * whole story. `UI_NUM_EVENT_KIND` in types.ts documents the emitted shapes.
 */

/** DOM settle debounce for mutation-triggered scans. */
export const UI_NUM_SETTLE_MS = 500;
/**
 * Ceiling on settle deferral. A page that mutates faster than the settle
 * window forever — a stock ticker, an SSE feed, an animation loop — would
 * otherwise re-arm the debounce on every mutation and the scan would starve,
 * which blinds this collector on exactly the pages where live numbers are the
 * evidence. Once deferral has lasted this long, the next schedule runs the
 * scan immediately instead of waiting for quiet that never comes.
 */
export const UI_NUM_MAX_WAIT_MS = 1500;
/**
 * Hard cap on labeled tokens per region snapshot. A region carrying more than
 * this is reported as a gap and withheld, never clipped — see `scanUiNumbers`.
 */
export const UI_NUM_MAX_ITEMS = 50;
/**
 * Separate cap on phrase and control items per region. They are budgeted apart
 * from numeric tokens because over-cap tokens withhold a region whole (the
 * arithmetic detector needs every component of a region or none), and a chatty
 * list of count phrases must not be able to trigger that withholding.
 */
export const UI_NUM_MAX_PHRASE_ITEMS = 20;
/** Labels longer than this are ignored (they are prose, not labels). */
const MAX_LABEL_LENGTH = 64;
/**
 * Element budget for a single scan. `scanUiNumbers` walks every element under
 * the root (a leaf check plus ancestor-walking label/hidden resolution per
 * numeric leaf) and re-runs on every 500ms MutationObserver settle. On a huge,
 * continuously mutating DOM that is an unbounded main-thread cost. The checks
 * are cheap and leaf-dominated, so a five-figure ceiling stays well clear of
 * ordinary pages (checkout/dashboard DOMs are hundreds to low thousands of
 * nodes) while still capping pathological pages before they stall the thread.
 */
export const UI_NUM_MAX_SCAN_ELEMENTS = 15_000;

export interface UiNumItem {
  label: string;
  value: number;
  unit?: string;
}

/** A region withheld because it carried more than `UI_NUM_MAX_ITEMS` tokens. */
export interface UiNumTruncatedRegion {
  region: string;
  /** Total labeled tokens the region held, counted past the cap. */
  seen: number;
}

export interface UiNumScanResult {
  /** Regions captured whole. An over-cap region is absent, never clipped. */
  regions: Map<string, UiNumItem[]>;
  truncated: UiNumTruncatedRegion[];
  /**
   * Regions whose phrase and control items were CLIPPED at
   * `UI_NUM_MAX_PHRASE_ITEMS`. Distinct from `truncated`, which withholds a
   * region's tokens whole: phrases carry no completeness assumption, so
   * clipping them is safe — but a silent clip would still let a session read
   * as complete while a chatty region contributed only its first twenty
   * counts, so it is reported with the same shape.
   */
  phrasesCapped: UiNumTruncatedRegion[];
}

/**
 * A numeric display token: optional currency symbol, digits with optional
 * thousands separators and decimals, optional trailing currency/percent unit.
 * The element's entire trimmed text must be the token — free prose containing
 * numbers is not a labeled figure.
 */
// The numeric core is deliberately loose here — digits (Latin or Arabic-Indic)
// plus every separator any supported locale renders — and then normalized and
// validated strictly below. A single US-format regex silently blinded this
// collector for every decimal-comma shopper: de-DE's `$129,00` parsed as
// nothing, so a German session carried zero numeric evidence.
const NUM_TOKEN_RE =
  /^([$€£¥])?\s*(-?[\d٠-٩۰-۹][\d٠-٩۰-۹.,٫٬\u00a0\u202f\u2009 ]*)\s*([$€£¥%])?$/;
const ISO_DAY_TOKEN_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;

/** Containers that delimit a snapshot region. */
const REGION_SELECTOR =
  "dl, table, ul, ol, form, fieldset, section, article, aside, nav, main";

/**
 * Whether `lang` renders decimals with a comma (de-DE, fr-FR, ar-EG, …).
 * Derived from Intl rather than a hardcoded language list; cached because the
 * scan asks once per numeric leaf.
 */
const COMMA_DECIMAL_CACHE = new Map<string, boolean>();
function usesCommaDecimal(lang: string | null): boolean {
  if (!lang) return false;
  const cached = COMMA_DECIMAL_CACHE.get(lang);
  if (cached !== undefined) return cached;
  let comma = false;
  try {
    for (const part of new Intl.NumberFormat(lang).formatToParts(1.1)) {
      if (part.type === "decimal") {
        comma = part.value === "," || part.value === "٫";
        break;
      }
    }
  } catch {
    // Unknown language tag: keep the dot-decimal default.
  }
  COMMA_DECIMAL_CACHE.set(lang, comma);
  return comma;
}

const ARABIC_INDIC_DIGIT_RE = /[٠-٩۰-۹]/g;
const SPACE_GROUP_RE = /[\u00a0\u202f\u2009 ]/g;

/**
 * Reduces a locale-rendered numeric string to canonical `-?\d+(\.\d+)?` form,
 * or null when the separators don't form a coherent number. When dot and comma
 * both appear, the later one is the decimal separator (shape alone decides:
 * `1.234,56` vs `1,234.56`). A single separator followed by exactly three
 * digits is ambiguous (`1,234`), and the page language breaks the tie; any
 * other single-separator shape is a decimal.
 */
function normalizeNumericCore(
  core: string,
  lang: string | null,
): string | null {
  let text = core
    .replace(ARABIC_INDIC_DIGIT_RE, (d) => {
      const code = d.charCodeAt(0);
      return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
    })
    .replace(/٫/g, ",")
    .replace(/٬/g, ".")
    .replace(SPACE_GROUP_RE, "");

  const sign = text.startsWith("-") ? "-" : "";
  if (sign) text = text.slice(1);
  if (!/^[\d.,]+$/.test(text)) return null;

  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");
  let decimalSep: string | null = null;
  if (lastDot !== -1 && lastComma !== -1) {
    decimalSep = lastDot > lastComma ? "." : ",";
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? "." : ",";
    const occurrences = text.split(sep).length - 1;
    const tail = text.slice(text.lastIndexOf(sep) + 1);
    if (occurrences > 1) {
      decimalSep = null; // repeated separator can only be grouping
    } else if (tail.length === 3) {
      // Ambiguous (`1,234` / `1.234`): the page language decides which side
      // of the Atlantic the grouping convention comes from.
      const commaDecimal = usesCommaDecimal(lang);
      decimalSep =
        sep === "," ? (commaDecimal ? "," : null) : commaDecimal ? null : ".";
    } else if (sep === "," && tail.length > 2 && !usesCommaDecimal(lang)) {
      // `12,3456` on a dot-decimal page is neither grouping nor money.
      return null;
    } else {
      decimalSep = sep;
    }
  }

  let integer = text;
  let fraction = "";
  if (decimalSep !== null) {
    const at = text.lastIndexOf(decimalSep);
    integer = text.slice(0, at);
    fraction = text.slice(at + 1);
    if (!/^\d+$/.test(fraction)) return null;
  }
  const groupSep = decimalSep === "," ? "." : decimalSep === "." ? "," : null;
  if (groupSep ? integer.includes(groupSep) : /[.,]/.test(integer)) {
    const sep = groupSep ?? (integer.includes(".") ? "." : ",");
    if (integer.includes(sep === "." ? "," : ".")) return null;
    const grouped = new RegExp(`^\\d{1,3}(?:\\${sep}\\d{3})+$`);
    if (!grouped.test(integer)) return null;
    integer = integer.split(sep).join("");
  }
  if (!/^\d+$/.test(integer)) return null;
  return `${sign}${integer}${fraction ? `.${fraction}` : ""}`;
}

export function parseNumericToken(
  text: string,
  lang: string | null = null,
): { value: number; unit?: string } | null {
  const match = NUM_TOKEN_RE.exec(text.trim());
  if (!match) return null;
  const normalized = normalizeNumericCore(match[2], lang);
  if (normalized === null) return null;
  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value)) return null;
  const unit = match[1] ?? match[3];
  return unit ? { value, unit } : { value };
}

/**
 * Convert one rendered ISO calendar day into an epoch-day number. Only direct
 * text nodes are read, so a container is not credited with dates rendered by
 * arbitrary descendants. The exact day remains numeric correlation evidence;
 * sensitive labels such as DOB are rejected by the existing label gate.
 */
function parseRenderedIsoDay(el: Element): UiNumItem["value"] | null {
  const directText = Array.from(el.childNodes)
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent ?? "")
    .join(" ");
  const match = ISO_DAY_TOKEN_RE.exec(directText);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const at = Date.UTC(year, month - 1, day);
  const parsed = new Date(at);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(at / 86_400_000);
}

/**
 * Labels run through the structured-value classifier in redaction.ts, but only
 * name/PII-grade findings redact: the classifier's `free_text_value` catch-all
 * was tuned for network body *values*, where any multi-word string is suspect.
 * UI labels are visible-by-design short strings ("Tax (8.25%)"), so free text
 * is normal — only deny-listed names (password/card/email/…) and PII-shaped
 * content (emails, card numbers, JWTs, token-like or high-entropy strings)
 * indicate a label that must not leave the page. A deny/PII label drops the
 * whole item (label AND value): under a sensitive label the number itself is
 * the sensitive datum, so a `[REDACTED]`+value pair would still leak it.
 *
 * Accepted residual risk of the free_text_value carve-out: labels that are
 * themselves PII but read as ordinary free text — most notably human names in
 * payroll/CRM-style tables ("Jane Doe  $84,000") — survive capture by design,
 * because a name is indistinguishable from a benign label here. Mitigations:
 * add the label to `redaction.denyFields`, use PRESET_LIGHT, or disable this
 * collector with `collect.uiNumbers: false`.
 */
function isDeniedLabel(label: string, denyFields?: string[]): boolean {
  const classification = classifyStructuredValue(label, label, denyFields);
  return (
    classification.action === "redact" &&
    classification.reason !== "free_text_value"
  );
}

/**
 * Value gate for the numeric token's integer-part digit run: a 13–19 digit
 * Luhn-passing run is a card number rendered on screen, and any run longer
 * than 16 digits is an absurd-length identifier, not a displayed figure.
 * Bare 9–11 digit runs (order numbers, tax refs) intentionally pass.
 */
function isDeniedNumericValue(value: number): boolean {
  const digits = String(Math.trunc(Math.abs(value)));
  if (digits.length > 16) return true;
  if (digits.length >= 13 && luhnPasses(digits)) return true;
  return false;
}

function luhnPasses(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function isHiddenElement(el: Element): boolean {
  if (el.closest('[hidden], [aria-hidden="true"]') !== null) return true;
  for (
    let node: Element | null = el;
    node !== null;
    node = node.parentElement
  ) {
    const style = (node as HTMLElement).style;
    if (style && (style.display === "none" || style.visibility === "hidden")) {
      return true;
    }
  }
  return false;
}

function normalizeLabelText(text: string | null | undefined): string | null {
  const trimmed = text
    ?.replace(/\s+/g, " ")
    .trim()
    .replace(/[:：]$/, "");
  if (!trimmed || trimmed.length > MAX_LABEL_LENGTH) return null;
  // A label that is itself a bare numeric token labels nothing.
  if (NUM_TOKEN_RE.test(trimmed)) return null;
  return trimmed;
}

function precedingSiblingLabel(start: Node): string | null {
  for (
    let sibling = start.previousSibling;
    sibling !== null;
    sibling = sibling.previousSibling
  ) {
    if (sibling.nodeType === 8 /* comment */) continue;
    if (sibling.nodeType === 1 && isHiddenElement(sibling as Element)) {
      continue;
    }
    const label = normalizeLabelText(sibling.textContent);
    if (label) return label;
  }
  return null;
}

/**
 * Resolve the human label for a numeric leaf element, in priority order:
 * dt/dd pairing, explicit aria-label, `label[for]` association, then the
 * nearest preceding text within the same row or list item.
 */
function resolveLabel(el: Element): string | null {
  // 1. dt/dd pairs: a <dd> value is labeled by the closest preceding <dt>.
  const dd = el.closest("dd");
  if (dd) {
    for (
      let sibling = dd.previousElementSibling;
      sibling !== null;
      sibling = sibling.previousElementSibling
    ) {
      if (sibling.tagName === "DT") {
        const label = normalizeLabelText(sibling.textContent);
        if (label) return label;
        break;
      }
    }
  }

  // 2. aria-label on the element itself or a row-level wrapper (cell/row/list
  // item). Deliberately NOT any ancestor: a section-level aria-label would
  // otherwise label every number in the section identically.
  const ariaHost = el.closest("[aria-label]");
  if (
    ariaHost &&
    (ariaHost === el ||
      ariaHost.matches("tr, li, dd, td, th, [role='row'], [role='cell']"))
  ) {
    const label = normalizeLabelText(ariaHost.getAttribute("aria-label"));
    if (label) return label;
  }

  // 3. label[for] association.
  const id = el.getAttribute("id");
  if (id && typeof CSS !== "undefined" && CSS.escape) {
    const labelEl = el.ownerDocument.querySelector(
      `label[for="${CSS.escape(id)}"]`,
    );
    if (labelEl) {
      const label = normalizeLabelText(labelEl.textContent);
      if (label) return label;
    }
  }

  // 4. Preceding text in the same row / list item: nearest preceding sibling
  // of the element itself, then of its ancestors, bounded by the row.
  const row = el.closest("tr, li, dd") ?? el.parentElement;
  for (
    let node: Node | null = el;
    node !== null && node !== row?.parentNode;
    node = node.parentNode
  ) {
    const label = precedingSiblingLabel(node);
    if (label) return label;
    if (node === row) break;
  }
  return null;
}

/**
 * Id/class fragments can carry PII (e.g. an id templated from an email
 * address, or a token-like generated class). Run them through the same
 * classifier gate as labels; a redacted fragment falls back to `null` so the
 * region string degrades to the bare tag name.
 */
function sanitizeRegionFragment(fragment: string): string | null {
  const classification = classifyStructuredValue(fragment, fragment);
  if (
    classification.action === "redact" &&
    classification.reason !== "free_text_value"
  ) {
    return null;
  }
  return fragment;
}

/**
 * Short CSS-path-ish identifier for a region container — tag name plus id or
 * first class when present ("dl.totals"). Never serializes DOM content, and
 * PII-shaped id/class fragments are dropped (bare tag name instead).
 */
function regionIdentifier(container: Element): string {
  const tag = container.tagName.toLowerCase();
  const id = container.getAttribute("id");
  if (id) {
    const safe = sanitizeRegionFragment(id);
    if (safe) return `${tag}#${safe}`;
    return tag;
  }
  const firstClass = container.classList.item(0);
  if (firstClass) {
    const safe = sanitizeRegionFragment(firstClass);
    if (safe) return `${tag}.${safe}`;
  }
  return tag;
}

function regionContainer(el: Element, root: Element): Element {
  return el.closest(REGION_SELECTOR) ?? root;
}

/** True when the element has no element children (a text leaf). */
function isLeaf(el: Element): boolean {
  return el.childElementCount === 0;
}

/**
 * Longest leaf text still considered a rendered count phrase. A list header
 * renders "31 people" or "Page 1 of 1"; anything longer is running prose and
 * is not read at all.
 */
const MAX_PROSE_TEXT_LENGTH = 64;

/**
 * Namespace for a label derived from a count phrase's own noun, and for the
 * pattern's fixed pagination words.
 *
 * These prefixes are not decoration. `ui.num` labels are matched by word
 * downstream — the display-arithmetic detector treats any label containing
 * "total" as a region's total — so minting a bare `total` from a "1-25 of 31"
 * footer would put a page count into a currency sum and manufacture a
 * confident "components sum to 5.00 but total shows 31.00". A phrase label is
 * a different KIND of fact from a rendered figure, and it says so in its name.
 */
export const COUNT_LABEL_PREFIX = "count:";
export const PAGER_LABEL_PREFIX = "pager:";
/** Label prefix that marks a pager control state rather than a count. */
export const PAGER_CONTROL_LABEL_PREFIX = "control:";

/**
 * Function words that turn a trailing phrase into a sentence fragment rather
 * than a noun. Without them "3 items in your cart" would label a count with a
 * slice of running prose ("items in your").
 */
const PROSE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "its",
  "my",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "there",
  "this",
  "to",
  "was",
  "were",
  "with",
  "you",
  "your",
]);

/**
 * The only words allowed in front of a count noun. A noun is otherwise ONE
 * word: an open-ended multi-word noun turns "2 jane doe" into the label
 * "jane doe", which is a person's name lifted off the page under the guise of
 * a label. A short, closed qualifier list keeps "12 open orders" without
 * opening that door.
 */
const COUNT_NOUN_QUALIFIERS = new Set([
  "active",
  "closed",
  "matching",
  "new",
  "open",
  "pending",
  "total",
  "unread",
]);

/**
 * Count nouns that are real but not plural in form. Everything else must LOOK
 * like a plural (end in "s"), which is the only cheap signal that a lowercase
 * word is a counted thing rather than a name or a brand.
 *
 * The honest residual: this is a shape test, not a dictionary. A lowercase
 * word ending in "s" that happens to be a name ("3 williams") still becomes a
 * label. The gate narrows the opening; it does not close it. Use
 * `redaction.denyFields`, `PRESET_LIGHT`, or `uiNumbers: false` when a screen
 * renders counts beside names.
 */
const COUNT_NOUN_ALLOW = new Set([
  "children",
  "data",
  "feedback",
  "people",
  "personnel",
  "staff",
]);

/**
 * Collection nouns that make "Total {n} {noun}" a statement about the SIZE OF
 * THE LIST rather than a count of something on it. Only these mint
 * `pager:total`; "Total 3 errors" is a count and becomes `count:errors`, so a
 * region cannot end up with two different `pager:total` values.
 */
const TOTAL_COLLECTION_NOUNS = new Set([
  "entries",
  "items",
  "matches",
  "records",
  "results",
  "rows",
]);

// Every pattern is anchored to the WHOLE trimmed text. A count phrase is the
// entire content of its leaf; a sentence that merely contains a number ("We
// have 31 people on the team.") is prose and must stay uncaptured.
//
// `NOUN_TAIL` is the optional unit noun a real pager writes after its numbers
// ("Showing 25 of 138 results"). Without it the noun is swallowed into the
// number and the whole phrase parses as nothing, which is how three of the
// four commonest pager renderings were invisible.
const NOUN_TAIL = String.raw`(?:\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*)?))?`;
const PAGE_OF_RE = new RegExp(String.raw`^page\s+(.+?)\s+of\s+(.+?)$`, "i");
const RANGE_DASH_OF_RE = new RegExp(
  String.raw`^(?:showing\s+)?(.+?)\s*[-–—]\s*(.+?)\s+of\s+(.+?)${NOUN_TAIL}$`,
  "i",
);
const RANGE_TO_OF_RE = new RegExp(
  String.raw`^(?:showing\s+)?(.+?)\s+to\s+(.+?)\s+of\s+(.+?)${NOUN_TAIL}$`,
  "i",
);
const SHOWING_OF_RE = new RegExp(
  String.raw`^showing\s+(.+?)\s+of\s+(.+?)${NOUN_TAIL}$`,
  "i",
);
const TOTAL_COUNT_RE = new RegExp(String.raw`^total\s+(.+?)${NOUN_TAIL}$`, "i");
// Deliberately has NO `i` flag: a capitalised trailing word is a name or a
// proper noun ("5 Dr Smith"), not a count noun, and the case is the only
// signal available at this length.
const COUNT_NOUN_RE = /^(.+?)\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*)?)$/;

/**
 * Pager words, matched against a normalized accessible name rather than
 * against the whole string. Real pagers write "Go to next page" (MUI),
 * "Next Page" (Ant) and a bare "»", so an equality test recognised almost
 * none of them.
 */
const PAGER_WORDS = new Set([
  "first",
  "last",
  "newer",
  "next",
  "older",
  "prev",
  "previous",
]);

/**
 * Words a pager puts around its own verb and that carry no meaning here.
 * Stripping them lets "go to next page" reduce to "next" while "next step in
 * setup" keeps words that are not filler and is therefore rejected — the
 * reason this is a reduction and not a substring search.
 */
const PAGER_FILLER_WORDS = new Set([
  "a",
  "button",
  "entries",
  "go",
  "items",
  "page",
  "pages",
  "records",
  "results",
  "rows",
  "the",
  "to",
]);

/** Glyph-only pager controls, which carry no text to reduce. */
const PAGER_SYMBOLS = new Map<string, string>([
  ["«", "first"],
  ["»", "last"],
  ["‹", "previous"],
  ["›", "next"],
]);

/** Class names a component library puts on a wrapper to mean "disabled". */
const DISABLED_CLASS_RE = /(?:^|[\s_-])disabled(?:$|[\s_-])/i;

function labeledNumbers(
  parts: Array<[label: string, raw: string]>,
  lang: string | null,
): UiNumItem[] | null {
  const items: UiNumItem[] = [];
  for (const [label, raw] of parts) {
    const parsed = parseNumericToken(raw, lang);
    if (!parsed) return null;
    const item: UiNumItem = { label, value: parsed.value };
    if (parsed.unit) item.unit = parsed.unit;
    items.push(item);
  }
  return items;
}

/**
 * Whether a trailing phrase is usable as a count label: one word, or a closed
 * qualifier plus one word, and the head word must look like a plural or be a
 * known non-plural count noun. Without the head-word test any lowercase token
 * became a label, so "2 jane" produced `count:jane`.
 */
function isCountNoun(words: string[]): boolean {
  if (words.length === 0 || words.length > 2) return false;
  if (words.some((word) => PROSE_STOP_WORDS.has(word))) return false;
  if (words.length === 2 && !COUNT_NOUN_QUALIFIERS.has(words[0])) return false;
  const head = words[words.length - 1];
  if (COUNT_NOUN_ALLOW.has(head)) return true;
  return head.length > 2 && head.endsWith("s");
}

/** A trailing unit noun is accepted only when it is a noun, not prose. */
function nounTailOk(tail: string | undefined): boolean {
  if (tail === undefined) return true;
  return !tail.split(" ").some((word) => PROSE_STOP_WORDS.has(word));
}

/**
 * Parse a short rendered count phrase into labeled numbers. The labels come
 * only from the phrase's own noun or from the pattern's fixed words, never
 * from surrounding text, so nothing but a number and a short noun leaves the
 * page. Every label is namespaced, so no phrase can mint a bare word that
 * another lane already reads as something else.
 *
 * Recognised, whole-text only (a trailing unit noun is allowed and ignored on
 * the `of` shapes):
 *   `{n} {noun}`            -> `count:<noun>`                  ("31 people")
 *   `Total {n} {noun}`      -> `pager:total` for a collection noun, else
 *                              `count:<noun>`
 *   `Page {a} of {b}`       -> `pager:page`, `pager:pages`
 *   `{a}-{b} of {n}`        -> `pager:range_start`, `pager:range_end`,
 *                              `pager:total` (also – — / "to", with an
 *                              optional "Showing " prefix)
 *   `Showing {a} of {n}`    -> `pager:shown`, `pager:total`
 */
export function parseProseCounts(
  text: string,
  lang: string | null = null,
): UiNumItem[] | null {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed || trimmed.length > MAX_PROSE_TEXT_LENGTH) return null;

  const page = PAGE_OF_RE.exec(trimmed);
  if (page) {
    return labeledNumbers(
      [
        [`${PAGER_LABEL_PREFIX}page`, page[1]],
        [`${PAGER_LABEL_PREFIX}pages`, page[2]],
      ],
      lang,
    );
  }

  const range = RANGE_DASH_OF_RE.exec(trimmed) ?? RANGE_TO_OF_RE.exec(trimmed);
  if (range) {
    if (!nounTailOk(range[4])) return null;
    return labeledNumbers(
      [
        [`${PAGER_LABEL_PREFIX}range_start`, range[1]],
        [`${PAGER_LABEL_PREFIX}range_end`, range[2]],
        [`${PAGER_LABEL_PREFIX}total`, range[3]],
      ],
      lang,
    );
  }

  const showing = SHOWING_OF_RE.exec(trimmed);
  if (showing) {
    if (!nounTailOk(showing[3])) return null;
    return labeledNumbers(
      [
        [`${PAGER_LABEL_PREFIX}shown`, showing[1]],
        [`${PAGER_LABEL_PREFIX}total`, showing[2]],
      ],
      lang,
    );
  }

  // "Total 85 items" is a declared collection size. The trailing noun is
  // REQUIRED and the number may carry no currency unit, so a rendered
  // "Total $84.00" stays out of the pager namespace entirely. Only a
  // collection noun means the list's size; "Total 3 errors" is a count of
  // something ON the list and must not become a second pager:total.
  const total = TOTAL_COUNT_RE.exec(trimmed);
  if (total && total[2] !== undefined && nounTailOk(total[2])) {
    const noun = total[2];
    const collection = TOTAL_COLLECTION_NOUNS.has(noun);
    const label = collection
      ? `${PAGER_LABEL_PREFIX}total`
      : `${COUNT_LABEL_PREFIX}${noun}`;
    if (collection || isCountNoun(noun.split(" "))) {
      const parsed = labeledNumbers([[label, total[1]]], lang);
      if (parsed && parsed[0].unit === undefined) return parsed;
    }
  }

  const count = COUNT_NOUN_RE.exec(trimmed);
  if (count && isCountNoun(count[2].split(" "))) {
    return labeledNumbers(
      [[`${COUNT_LABEL_PREFIX}${count[2]}`, count[1]]],
      lang,
    );
  }
  return null;
}

/**
 * Reduce a control's accessible name to the single pager word it means, or
 * null. Filler words are dropped and what remains must be exactly one pager
 * word, one glyph, or "load more" — so "Go to next page" reduces to `next`
 * while "Next step in setup" reduces to nothing.
 */
function pagerWordFromName(name: string): string | null {
  const lowered = name.replace(/\s+/g, " ").trim().toLowerCase();
  if (!lowered || lowered.length > MAX_PROSE_TEXT_LENGTH) return null;
  const symbols = new Set(
    [...lowered].filter((char) => PAGER_SYMBOLS.has(char)),
  );
  const words = lowered
    .split(/[^\p{Letter}]+/u)
    .filter((word) => word.length > 0 && !PAGER_FILLER_WORDS.has(word));
  if (words.length === 0) {
    if (symbols.size !== 1) return null;
    return PAGER_SYMBOLS.get([...symbols][0]) ?? null;
  }
  if (words.length === 1 && PAGER_WORDS.has(words[0])) return words[0];
  if (
    words.length === 2 &&
    words[1] === "more" &&
    (words[0] === "load" || words[0] === "show")
  ) {
    return "load_more";
  }
  return null;
}

/**
 * Disabled state of a control, or null when it cannot be determined.
 *
 * Libraries express "disabled" four different ways and only one of them is the
 * attribute. A `<button>` always answers (the attribute is present or it is
 * not), while an anchor is only actionable when it has an href — a bare
 * `<a>` with no href and no disabled marker is a control whose state we do not
 * know, and a confident `1` there is worse than no evidence, because a
 * detector would read it as "Next was clickable".
 */
function controlDisabledState(el: Element): boolean | null {
  // Deliberately starts at the PARENT: a Bootstrap `a.page-link` matches a
  // class selector for itself, and the state it needs lives on the `li` above.
  const wrapper =
    el.parentElement?.closest("li, [role='listitem'], [class*='pag']") ??
    el.parentElement;
  const ariaHost = el.hasAttribute("aria-disabled") ? el : wrapper;
  if (
    el.hasAttribute("disabled") ||
    (el as Partial<HTMLButtonElement>).disabled === true ||
    ariaHost?.getAttribute("aria-disabled") === "true" ||
    DISABLED_CLASS_RE.test(el.getAttribute("class") ?? "") ||
    DISABLED_CLASS_RE.test(wrapper?.getAttribute("class") ?? "")
  ) {
    return true;
  }
  if (el.tagName === "A") {
    const href = el.getAttribute("href");
    if (href === null) return null;
    if (el.getAttribute("tabindex") === "-1") return true;
    return false;
  }
  return false;
}

/**
 * Pager control state for a `button`/`a` that means one of the pager words.
 * The item is `{ label: "control:<word>", value: 1 | 0 }`, where 1 means the
 * control is actionable and 0 means it is disabled — a boolean, not a count,
 * distinguished from every other item by the `control:` prefix. "Next is
 * disabled on page one" is what separates a client that knows about page two
 * from one that does not, and it is not a number anywhere on screen.
 *
 * Returns null when the element is not a pager control OR when its state
 * cannot be established; an unknown state is never reported as enabled.
 */
export function parsePagerControl(el: Element): UiNumItem | null {
  const tag = el.tagName;
  if (tag !== "BUTTON" && tag !== "A") return null;
  const word = pagerWordFromName(
    el.getAttribute("aria-label") ?? el.textContent ?? "",
  );
  if (!word) return null;
  const disabled = controlDisabledState(el);
  if (disabled === null) return null;
  return {
    label: `${PAGER_CONTROL_LABEL_PREFIX}${word}`,
    value: disabled ? 0 : 1,
  };
}

/**
 * The numbered-link pager: `<a aria-current="page">2</a>` among sibling page
 * links. That style renders no "Page 2 of 7" sentence anywhere, so without
 * this it stated its current page in a way nothing captured.
 *
 * Only the current page is read. The highest numbered link is NOT read as the
 * page count: an elided pager ("1 2 3 … 12") shows a last link, a truncated
 * one ("1 2 3 …") does not, and the two are indistinguishable here — guessing
 * would feed a false "fewer pages than declared" straight into the detector
 * this evidence exists for.
 */
export function parseCurrentPageLink(
  el: Element,
  lang: string | null = null,
): UiNumItem | null {
  if (el.getAttribute("aria-current") !== "page") return null;
  const tag = el.tagName;
  if (tag !== "A" && tag !== "BUTTON" && tag !== "LI" && tag !== "SPAN") {
    return null;
  }
  if (el.closest("nav, ul, ol, [role='navigation']") === null) return null;
  const parsed = parseNumericToken(el.textContent ?? "", lang);
  if (!parsed || parsed.unit !== undefined) return null;
  if (!Number.isInteger(parsed.value) || parsed.value < 1) return null;
  return { label: `${PAGER_LABEL_PREFIX}page`, value: parsed.value };
}

/**
 * Scan visible text under `root` for labeled numeric tokens, grouped by
 * region. Pure DOM read — no mutation, no HTML capture.
 *
 * Returns `null` (an "over budget" sentinel) rather than a result when the root
 * holds more than `maxElements` elements. `null` is deliberately distinct from
 * an empty map: a partial snapshot would be worse than none, because the
 * ui_arithmetic_mismatch detector assumes every component of a region is
 * present, so a truncated region would manufacture a high-confidence false
 * "subtotal + tax ≠ total". Over budget therefore means "no evidence", not
 * "some evidence". `maxElements` is injectable so callers (and tests) can pin
 * the ceiling; it defaults to `UI_NUM_MAX_SCAN_ELEMENTS`.
 *
 * A single region exceeding `UI_NUM_MAX_ITEMS` is the same hazard at a smaller
 * scale, so it gets the same answer: the region is withheld from `regions` and
 * named in `truncated` instead of being clipped to the first N items. Clipping
 * is the one outcome that must not happen here — it hands the detector a region
 * that looks complete and is not, which is exactly how a false
 * "subtotal + tax ≠ total" is manufactured. The caller turns `truncated` into a
 * `capture_gap` so the withheld region is visible rather than silent.
 */
export function scanUiNumbers(
  root: Element,
  denyFields?: string[],
  maxElements: number = UI_NUM_MAX_SCAN_ELEMENTS,
  lang: string | null = null,
): UiNumScanResult | null {
  const elements = root.querySelectorAll("*");
  if (elements.length > maxElements) return null;
  // Token items and phrase/control items are budgeted separately. They answer
  // different questions and only the token budget guards the arithmetic
  // detector's completeness assumption, so a feed of thirty rows each stating
  // "12 likes" must not push a region's currency tokens over the cap and
  // delete evidence that was captured before phrases existed.
  const perRegion = new Map<
    string,
    Array<{ item: UiNumItem; token: boolean }>
  >();
  // Counted past the cap so the gap can report the magnitude it withheld: a
  // region of 51 and a region of 5,000 are different evidence problems.
  const tokenSeen = new Map<string, number>();
  const tokenKept = new Map<string, number>();
  // Phrases are clipped rather than withheld, but the count past the cap is
  // still recorded: a region that kept twenty of sixty counts must say so.
  const phraseSeen = new Map<string, number>();
  const phraseKept = new Map<string, number>();
  for (const el of elements) {
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") continue;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") continue;
    // Four shapes produce items, in order: a pager control's enabled state, a
    // numbered pager's current-page link, a leaf that IS a numeric token, and
    // a leaf that is a short count phrase ("31 people", "Page 1 of 1"). The
    // last two are mutually exclusive.
    let produced: UiNumItem[] | null = null;
    let token = false;
    const control = parsePagerControl(el) ?? parseCurrentPageLink(el, lang);
    if (control) {
      produced = [control];
    } else {
      const renderedDay = parseRenderedIsoDay(el);
      const leaf = isLeaf(el);
      if (!leaf && renderedDay === null) continue;
      const parsed =
        renderedDay === null
          ? parseNumericToken(el.textContent ?? "", lang)
          : { value: renderedDay, unit: "iso-day" };
      if (parsed) {
        const label = resolveLabel(el);
        if (!label) continue;
        const item: UiNumItem = { label, value: parsed.value };
        if (parsed.unit) item.unit = parsed.unit;
        produced = [item];
        token = true;
      } else if (leaf) {
        produced = parseProseCounts(el.textContent ?? "", lang);
      }
    }
    if (!produced || produced.length === 0) continue;
    if (isHiddenElement(el)) continue;
    // Deny/PII label or PAN-shaped value: drop the item entirely — never a
    // `[REDACTED]`-labeled value.
    const kept = produced.filter(
      (item) =>
        !isDeniedLabel(item.label, denyFields) &&
        !isDeniedNumericValue(item.value),
    );
    if (kept.length === 0) continue;

    const region = regionIdentifier(regionContainer(el, root));
    let entries = perRegion.get(region);
    if (!entries) {
      entries = [];
      perRegion.set(region, entries);
    }
    for (const item of kept) {
      if (token) {
        tokenSeen.set(region, (tokenSeen.get(region) ?? 0) + 1);
        const already = tokenKept.get(region) ?? 0;
        if (already >= UI_NUM_MAX_ITEMS) continue;
        tokenKept.set(region, already + 1);
      } else {
        phraseSeen.set(region, (phraseSeen.get(region) ?? 0) + 1);
        const already = phraseKept.get(region) ?? 0;
        if (already >= UI_NUM_MAX_PHRASE_ITEMS) continue;
        phraseKept.set(region, already + 1);
      }
      entries.push({ item, token });
    }
  }

  // Withhold every over-cap region's TOKENS before returning: what the caller
  // receives is only ever a set of tokens that was captured whole. Phrase and
  // control items are not part of that assumption and survive.
  const regions = new Map<string, UiNumItem[]>();
  const truncated: UiNumTruncatedRegion[] = [];
  const phrasesCapped: UiNumTruncatedRegion[] = [];
  for (const [region, entries] of perRegion) {
    const seen = tokenSeen.get(region) ?? 0;
    const over = seen > UI_NUM_MAX_ITEMS;
    if (over) truncated.push({ region, seen });
    const phrases = phraseSeen.get(region) ?? 0;
    if (phrases > UI_NUM_MAX_PHRASE_ITEMS) {
      phrasesCapped.push({ region, seen: phrases });
    }
    const items = (
      over ? entries.filter((entry) => !entry.token) : entries
    ).map((entry) => entry.item);
    if (items.length > 0) regions.set(region, items);
  }
  return { regions, truncated, phrasesCapped };
}

/**
 * Locale attributes that decide how the numbers above are rendered and read.
 * A page serving `lang="de"` while formatting `1,234.56` is a real defect that
 * neither lane can show alone, so both `ui.num` and `ui.layout` carry them.
 */
function readLocale(): { dir: string; lang: string | null } {
  try {
    const root = document.documentElement;
    return {
      dir: document.dir || root?.dir || "ltr",
      lang: root?.lang || null,
    };
  } catch {
    return { dir: "ltr", lang: null };
  }
}

interface RtlPhysicalRule {
  source?: string;
  properties: string[];
  matched: number;
}

const RTL_PHYSICAL_RULE_LIMIT = 8;
const RTL_PHYSICAL_PROPERTIES = [
  "left",
  "right",
  "margin-left",
  "margin-right",
  "padding-left",
  "padding-right",
  "border-left",
  "border-right",
];

function asymmetricFourValueShorthand(
  style: CSSStyleDeclaration,
  property: "margin" | "padding",
): boolean {
  const tokens = style
    .getPropertyValue(property)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return tokens.length === 4 && tokens[1] !== tokens[3];
}

/**
 * Under RTL, active author rules that use physical left/right properties are
 * the evidence document-level overflow cannot provide. The scan is bounded,
 * same-origin only, and records no selector or page text.
 */
function readRtlPhysicalRules(): RtlPhysicalRule[] {
  const output: RtlPhysicalRule[] = [];
  const visit = (rules: CSSRuleList, source?: string): void => {
    for (const rule of Array.from(rules)) {
      if (output.length >= RTL_PHYSICAL_RULE_LIMIT) return;
      // Modern Chromium exposes `cssRules` on CSSStyleRule for native CSS
      // nesting. A style rule must be inspected before the grouping-rule path,
      // or every ordinary rule is mistaken for an empty container.
      if (!(rule instanceof CSSStyleRule) && "cssRules" in rule) {
        try {
          visit((rule as CSSGroupingRule).cssRules, source);
        } catch {
          // Inaccessible nested rule: skip it.
        }
        continue;
      }
      if (!(rule instanceof CSSStyleRule)) continue;
      let matched = 0;
      try {
        matched = document.querySelectorAll(rule.selectorText).length;
      } catch {
        continue;
      }
      if (matched === 0) continue;
      const cssText = rule.style.cssText.toLowerCase();
      if (/(?:^|;)\s*(?:inset|margin|padding|border)-inline/.test(cssText))
        continue;
      // CSSStyleDeclaration expands `margin: 0` into both margin-left and
      // margin-right. Read the authored declaration text so symmetric
      // shorthands do not fill the bounded result with false physical rules.
      const properties = RTL_PHYSICAL_PROPERTIES.filter((property) =>
        new RegExp(`(?:^|;)\\s*${property}\\s*:`).test(cssText),
      );
      if (asymmetricFourValueShorthand(rule.style, "margin"))
        properties.push("margin");
      if (asymmetricFourValueShorthand(rule.style, "padding"))
        properties.push("padding");
      if (properties.length === 0) continue;
      output.push({
        ...(source ? { source } : {}),
        properties: [...new Set(properties)].sort(),
        matched: Math.min(matched, 100),
      });
    }
  };

  for (const sheet of Array.from(document.styleSheets).slice(0, 20)) {
    if (output.length >= RTL_PHYSICAL_RULE_LIMIT) break;
    try {
      const href = sheet.href
        ? redactUrl(sheet.href, "stylesheet").value
        : undefined;
      visit(sheet.cssRules, href);
    } catch {
      // Cross-origin stylesheets intentionally expose no cssRules.
    }
  }
  return output;
}

/**
 * One small measurement per navigation: document geometry plus locale. It is
 * what turns "the layout is broken on this screen" into evidence — horizontal
 * overflow is invisible to every other lane, and it is the usual outcome of a
 * long translated label or an RTL locale meeting a fixed-width column.
 * Emitted unconditionally; deciding what counts as significant is the
 * detector's job, not the SDK's.
 */
function emitLayout(bus: EventBus): void {
  try {
    const root = document?.documentElement;
    if (!root) return;
    const scrollW = root.scrollWidth ?? 0;
    const clientW = root.clientWidth ?? 0;
    const locale = readLocale();
    const href = typeof window !== "undefined" ? window.location.href : "";
    const urlResult = href ? redactUrl(href, "url") : undefined;
    const d: Record<string, unknown> = {
      dir: locale.dir,
      lang: locale.lang,
      scrollW,
      clientW,
      overflowX: Math.max(0, scrollW - clientW),
    };
    if (urlResult) d.url = urlResult.value;
    if (locale.dir.toLowerCase() === "rtl") {
      const rtlPhysical = readRtlPhysicalRules();
      if (rtlPhysical.length > 0) d.rtlPhysical = rtlPhysical;
    }
    attachRedactionMetadata(d, urlResult?.metadata);
    bus.emit({ t: now(), k: UI_LAYOUT_EVENT_KIND, d });
  } catch {
    // A failed measurement must not take the numeric scan down with it.
  }
}

export function uiNumbersCollector(
  bus: EventBus,
  config: CrumbtrailConfig,
): CollectorCleanup {
  // A getter rather than the array: a remote poll replaces `config.redaction` with a new object,
  // so a snapshot taken here would keep scanning against the deny list the session started with.
  const denyFields = (): string[] | undefined => config.redaction?.denyFields;
  if (
    typeof document === "undefined" ||
    typeof MutationObserver === "undefined"
  ) {
    return () => {};
  }

  // Script may run from <head> before <body> exists: retry once when the DOM
  // is ready instead of permanently no-opping.
  if (!document.body) {
    let started: CollectorCleanup | undefined;
    let cancelled = false;
    const onReady = (): void => {
      if (cancelled || !document.body) return;
      started = startUiNumbersCollector(bus, denyFields);
    };
    document.addEventListener("DOMContentLoaded", onReady, { once: true });
    return () => {
      cancelled = true;
      document.removeEventListener("DOMContentLoaded", onReady);
      started?.();
    };
  }

  return startUiNumbersCollector(bus, denyFields);
}

function startUiNumbersCollector(
  bus: EventBus,
  denyFields: () => string[] | undefined,
): CollectorCleanup {
  let disabled = false;
  let layoutPending = true;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  // When the current run of deferrals began; undefined between bursts.
  let deferredSince: number | undefined;
  // Previous serialized snapshot per region: emit only on change.
  const lastSnapshot = new Map<string, string>();
  // Regions already reported as over-cap. A dashboard that mutates on a timer
  // rescans every 500ms and would otherwise emit the same gap forever; the gap
  // is a statement about the region, so one is the whole truth.
  const reportedTruncated = new Set<string>();
  const reportedPhraseCapped = new Set<string>();
  let observer: MutationObserver | undefined;
  // Assigned after observer setup; `let` so `disable` (defined first, callable
  // from the observer-setup catch) can release it without a TDZ reference.
  // eslint-disable-next-line prefer-const
  let unsubscribeNav: (() => void) | undefined;

  // Failure policy: the collector self-disables inside its own scan path and
  // degrades to a single `capture_gap` event, rather than relying on
  // crumbtrail to wrap collector callbacks — core has no manifest writer for
  // `degradedCollection` (that field is assembled server-side). One broken
  // collector never breaks the page or the session, and placing the guard
  // here covers the MutationObserver/debounce internals too.
  //
  // Both permanent-disable paths — a thrown exception mid-scan and an
  // over-budget DOM — route through `disable` so teardown is identical; they
  // differ only in the gap reason/detail they report.
  const disable = (
    reason: BuildCaptureGapEventInput["reason"],
    detail: string,
  ): void => {
    if (disabled) return;
    disabled = true;
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    try {
      observer?.disconnect();
    } catch {
      // Already broken — nothing to release.
    }
    unsubscribeNav?.();
    bus.emit(buildCaptureGapEvent({ surface: "browser", reason, detail }));
  };

  const disableOnException = (error: unknown): void => {
    const name = error instanceof Error ? error.name : "Error";
    disable("capture_exception", `ui.num collector disabled: ${name}`);
  };

  const runScan = (): void => {
    if (disabled) return;
    deferredSince = undefined;
    // Layout is measured once per navigation, not once per DOM settle: it
    // describes the view, and a mutation-driven rescan would repeat it.
    if (layoutPending) {
      layoutPending = false;
      emitLayout(bus);
    }
    try {
      // Locale first: the page language decides how ambiguous separators in
      // rendered numbers are read (`1,234` is a thousand in en, 1.234 in de).
      const locale = readLocale();
      const scan = scanUiNumbers(
        document.body,
        denyFields(),
        UI_NUM_MAX_SCAN_ELEMENTS,
        locale.lang,
      );
      if (scan === null) {
        // Over budget: the page has too many elements to scan safely on the
        // 500ms cadence. Permanently disable rather than emit a partial (and
        // therefore misleading) snapshot. `scan_budget_exceeded` distinguishes
        // this from a genuine collector fault at triage time.
        disable(
          "scan_budget_exceeded",
          "ui.num scan exceeded element budget; collector disabled",
        );
        return;
      }
      // An over-cap region is withheld rather than clipped, so without this the
      // session would read as complete while a dense region contributed
      // nothing. Reported per region and once each: unlike the element budget
      // this is not a collector fault, so every other region keeps capturing.
      for (const { region, seen } of scan.truncated) {
        // Forget any snapshot emitted while the region was still under the cap.
        // Otherwise a region that grows over, then shrinks back to its earlier
        // contents, is suppressed by the change check and never re-emitted.
        lastSnapshot.delete(region);
        if (reportedTruncated.has(region)) continue;
        reportedTruncated.add(region);
        // `detail` is dropped here by design: the capture-gap sanitizer keeps
        // only SQL and error-class classifications, and a region identifier is
        // page-derived text that has no business being carried as evidence.
        bus.emit(
          buildCaptureGapEvent({
            surface: "browser",
            reason: "scan_budget_exceeded",
            droppedEventCount: seen,
          }),
        );
      }
      // A clipped phrase region keeps its first twenty counts, so unlike a
      // withheld token region it still emits a snapshot. The gap is what says
      // the snapshot is a sample rather than the whole region.
      for (const { region, seen } of scan.phrasesCapped) {
        if (reportedPhraseCapped.has(region)) continue;
        reportedPhraseCapped.add(region);
        bus.emit(
          buildCaptureGapEvent({
            surface: "browser",
            reason: "scan_budget_exceeded",
            droppedEventCount: seen - UI_NUM_MAX_PHRASE_ITEMS,
          }),
        );
      }
      for (const [region, items] of scan.regions) {
        if (items.length === 0) continue;
        const serialized = JSON.stringify(items);
        if (lastSnapshot.get(region) === serialized) continue;
        lastSnapshot.set(region, serialized);
        bus.emit({
          t: now(),
          k: UI_NUM_EVENT_KIND,
          d: { region, items, lang: locale.lang, dir: locale.dir },
        });
      }
    } catch (error) {
      disableOnException(error);
    }
  };

  const scheduleScan = (): void => {
    if (disabled) return;
    const at = now();
    if (deferredSince === undefined) deferredSince = at;
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    // Deferral ceiling: under continuous mutation (a ticker, a stream) the
    // settle window re-arms forever, so once deferral has lasted
    // UI_NUM_MAX_WAIT_MS the scan runs now instead of waiting for quiet.
    const wait =
      at - deferredSince >= UI_NUM_MAX_WAIT_MS ? 0 : UI_NUM_SETTLE_MS;
    settleTimer = setTimeout(runScan, wait);
  };

  try {
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  } catch (error) {
    disableOnException(error);
    return () => {};
  }

  // Navigation commit: SPA route changes (history API) and hash/pop
  // navigations schedule a scan through the same settle debounce so the new
  // view's DOM is read after it renders. Uses the shared nav-commit signal —
  // never a private history.pushState wrap — so multiple collectors can
  // observe navigation without corrupting each other's teardown.
  unsubscribeNav = subscribeNavCommit(() => {
    // A route change is a new view, so the change-suppression state from the
    // old one has to go. Region identifiers are structural ("main", "dl.totals",
    // "table#cart") and repeat across routes, so without this the first
    // snapshot of a new page is silently dropped whenever it happens to match
    // the page before it — /cart and /checkout showing the same total emitted
    // nothing at all for /checkout. Suppression is meant to squash repeats
    // during DOM churn inside one view, never to hide a view.
    lastSnapshot.clear();
    layoutPending = true;
    scheduleScan();
  });

  // Initial navigation commit (page load): scan after the settle window.
  scheduleScan();

  return () => {
    // Defense in depth: a disabled collector ignores any callback that
    // slips through after teardown (queued observer delivery, stray timer).
    disabled = true;
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    try {
      observer?.disconnect();
    } catch {
      // Observer already failed; cleanup must not throw.
    }
    unsubscribeNav?.();
  };
}
