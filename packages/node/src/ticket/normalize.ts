import type { Symptom } from "crumbtrail-core";

export type TicketProvider = "jira" | "zendesk" | "trello";

export interface RawTicket {
  provider: TicketProvider;
  payload: unknown;
}

function asRecord(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" ? (x as Record<string, unknown>) : {};
}

function asString(x: unknown): string | undefined {
  return typeof x === "string" ? x : undefined;
}

/**
 * Flatten a Jira ADF (Atlassian Document Format) description node into plain
 * text by walking `content[]` and joining collected `text` fields with
 * spaces. Strings pass through unchanged; absent values become `''`.
 */
function flattenAdf(node: unknown): string {
  if (typeof node === "string") return node;
  const record = asRecord(node);
  const text = asString(record.text);
  if (text !== undefined) return text;
  const content = record.content;
  if (Array.isArray(content)) {
    return content
      .map((child) => flattenAdf(child))
      .filter((part) => part.length > 0)
      .join(" ");
  }
  return "";
}

export function jiraToSymptom(payload: unknown): Symptom {
  const record = asRecord(payload);
  const fields = asRecord(record.fields);
  const key = asString(record.key);
  const self = asString(record.self);
  const fixVersions = Array.isArray(fields.fixVersions)
    ? fields.fixVersions
    : [];
  const release = asString(asRecord(fixVersions[0]).name);

  return {
    title: asString(fields.summary) ?? "",
    description: flattenAdf(fields.description) || undefined,
    url: self ?? (key ? `/browse/${key}` : undefined),
    release,
    source: "jira",
  };
}

export function zendeskToSymptom(payload: unknown): Symptom {
  const record = asRecord(payload);
  const ticket = "ticket" in record ? asRecord(record.ticket) : record;

  return {
    title: asString(ticket.subject) ?? "",
    description: asString(ticket.description),
    url: asString(ticket.url),
    source: "zendesk",
  };
}

export function trelloToSymptom(payload: unknown): Symptom {
  const record = asRecord(payload);

  return {
    title: asString(record.name) ?? "",
    description: asString(record.desc),
    url: asString(record.shortUrl) ?? asString(record.url),
    source: "trello",
  };
}

export function normalizeTicket(raw: RawTicket): Symptom {
  switch (raw.provider) {
    case "jira":
      return jiraToSymptom(raw.payload);
    case "zendesk":
      return zendeskToSymptom(raw.payload);
    case "trello":
      return trelloToSymptom(raw.payload);
    default:
      throw new TypeError(`Unknown ticket provider: ${String(raw.provider)}`);
  }
}
