// Pure text transforms for the injection recipes. Zero filesystem I/O — every
// function takes source text and returns source text, so the bulk of the recipe
// tests can assert behavior without touching disk.

const BOM = "﻿";

/** A source-directive prologue line, e.g. `"use client";` or `'use strict'`. */
const DIRECTIVE_RE = /^\s*(['"])use (?:client|strict|server)\1\s*;?\s*$/;

export interface SourceShape {
  /** "" or the UTF-8 BOM if the source started with one. */
  bom: string;
  /** The line terminator the source uses (defaults to LF for empty input). */
  eol: "\n" | "\r\n";
  /** Body lines with the BOM stripped and split on either EOL. */
  lines: string[];
}

/** Split source into BOM + EOL style + lines, preserving what we detect. */
export function analyzeSource(text: string): SourceShape {
  let bom = "";
  let body = text;
  if (body.charCodeAt(0) === 0xfeff) {
    bom = BOM;
    body = body.slice(1);
  }
  const eol: "\n" | "\r\n" = /\r\n/.test(body) ? "\r\n" : "\n";
  return { bom, eol, lines: body.split(/\r?\n/) };
}

/**
 * Number of leading lines that form the un-touchable prologue: an optional
 * shebang followed by any directive-prologue lines ("use client"/"use strict"/
 * "use server"), including blank lines interleaved between them. Injection is
 * inserted immediately after this prologue.
 */
export function prologueEnd(lines: string[]): number {
  let end = 0;
  let idx = 0;
  if (lines[0]?.startsWith("#!")) {
    end = 1;
    idx = 1;
  }
  for (; idx < lines.length; idx++) {
    const line = lines[idx];
    if (line.trim() === "") continue; // blank — keep scanning, don't extend yet
    if (DIRECTIVE_RE.test(line)) {
      end = idx + 1;
      continue;
    }
    break;
  }
  return end;
}

/** True when the source already references either Crumbtrail SDK package. */
export function referencesCrumbtrail(text: string): boolean {
  return /crumbtrail-core|crumbtrail-node/.test(text);
}

/**
 * Strictly prepend `block` into `existing`, after any shebang / directive
 * prologue, preserving the source's BOM and CRLF/LF style. `block` is authored
 * with LF newlines and is re-terminated to match the source.
 */
export function prependIntoSource(existing: string, block: string): string {
  const { bom, eol, lines } = analyzeSource(existing);
  const end = prologueEnd(lines);
  const blockLines = block.replace(/\n+$/, "").split("\n");

  const pre = lines.slice(0, end);
  const post = lines.slice(end);

  const out: string[] = [...pre];
  // Blank line between prologue and injected block.
  if (pre.length && pre[pre.length - 1].trim() !== "") out.push("");
  out.push(...blockLines);
  // Blank line between injected block and the original body (when there is one).
  const postHasContent = post.some((l) => l.trim() !== "");
  if (postHasContent && post[0].trim() !== "") out.push("");
  out.push(...post);

  return bom + out.join(eol);
}

/** Ensure a create-file body ends in exactly one trailing newline. */
export function withTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : text + "\n";
}
