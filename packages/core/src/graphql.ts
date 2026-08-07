/**
 * Which GraphQL operation a request carried.
 *
 * Every GraphQL request in an application goes to the same URL. `POST /graphql` is the route for
 * the checkout mutation, the order list query, the search box and the notification subscription
 * alike, and a capture keyed on method and path therefore reports one endpoint doing everything.
 * The consequences are not cosmetic: two requests that share nothing are deduplicated as repeats,
 * a failure cannot be attributed to the interaction that caused it, and every detector that groups
 * by route groups the whole application into one bucket.
 *
 * The operation name and type restore the identity the URL threw away. Both are code, written by
 * the developers of the application and identical for every user, so reading them adds no class of
 * value the capture did not already hold. Variables are NOT read here - those carry user input, and
 * the body redaction that runs over them is the only thing entitled to decide what survives.
 */

/** GraphQL identity of one request, when the body was recognisably GraphQL. */
export interface GraphqlIdentity {
  /** `query`, `mutation` or `subscription`. */
  op: string;
  /** The operation name, when the document names one. Anonymous documents have none. */
  name?: string;
  /** Operations in the batch, when the request carried an array of them. */
  batch?: number;
}

/** Longest document text inspected. A document past this is identified from its head or not at all. */
const MAX_DOCUMENT_SCAN = 4_096;

/**
 * `mutation UpdateCart(` / `query  Orders {` / bare `mutation {`.
 *
 * Anchored at the start of the scanned text after leading whitespace and comments are dropped, so a
 * `mutation` appearing inside a field name or a string literal cannot be mistaken for the operation
 * keyword.
 */
const OPERATION_RE =
  /^(query|mutation|subscription)\s*([_A-Za-z][_0-9A-Za-z]*)?\s*[({@]/;

/** A document that opens with a bare selection set is an anonymous query. */
const SHORTHAND_RE = /^\{/;

export function graphqlIdentity(body: string): GraphqlIdentity | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }

  if (Array.isArray(parsed)) {
    // A batched request. The first operation identifies it, and the count says it was a batch, so a
    // reader is never told a single name for work that was several.
    for (const entry of parsed) {
      const identity = identityOfEntry(entry);
      if (identity) return { ...identity, batch: parsed.length };
    }
    return undefined;
  }

  return identityOfEntry(parsed);
}

function identityOfEntry(entry: unknown): GraphqlIdentity | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;

  const document =
    typeof record.query === "string"
      ? record.query
      : // Persisted-query requests send no document at all. `extensions` is the only thing left
        // that says this was GraphQL, and the operation name is usually still on the request.
        typeof record.operationName === "string" && record.extensions !== undefined
        ? ""
        : undefined;
  if (document === undefined) return undefined;

  const declaredName =
    typeof record.operationName === "string" && record.operationName.length > 0
      ? record.operationName.slice(0, 120)
      : undefined;

  const stripped = stripLeadingTrivia(document.slice(0, MAX_DOCUMENT_SCAN));
  const match = OPERATION_RE.exec(stripped);
  if (match) {
    const name = declaredName ?? match[2];
    return {
      op: match[1],
      ...(name ? { name: name.slice(0, 120) } : {}),
    };
  }
  if (SHORTHAND_RE.test(stripped)) {
    return { op: "query", ...(declaredName ? { name: declaredName } : {}) };
  }
  // No document to read, but a name and `extensions` said GraphQL. The type is genuinely unknown
  // here and is not guessed: a persisted mutation reported as a query would be worse than silence.
  if (declaredName && document === "") {
    return { op: "unknown", name: declaredName };
  }
  return undefined;
}

/** Drop leading whitespace, `#` comments and BOM so the operation keyword is first. */
function stripLeadingTrivia(document: string): string {
  let rest = document.replace(/^﻿/, "");
  for (;;) {
    const trimmed = rest.replace(/^\s+/, "");
    if (trimmed.startsWith("#")) {
      const newline = trimmed.indexOf("\n");
      if (newline === -1) return "";
      rest = trimmed.slice(newline + 1);
      continue;
    }
    return trimmed;
  }
}

/** Stamp the GraphQL identity of a request onto its event payload, when there is one. */
export function applyGraphqlIdentity(
  target: Record<string, unknown>,
  body: string | undefined,
): void {
  if (body === undefined) return;
  try {
    const identity = graphqlIdentity(body);
    if (identity) target.gql = identity;
  } catch {
    // Identification never breaks a request.
  }
}
