import type { TicketProvider } from "./normalize";

/** A ticket reference resolved from a pasted URL: the provider plus the id/key
 *  that the configured connector (never the pasted origin) fetches by. */
export interface ParsedTicketRef {
  provider: TicketProvider;
  id: string;
}

// Recognized path shapes per provider. Each capture group is the id/key that a
// connector fetches by — the SAME id form the fetch clients and normalizers use
// (Jira issue key/id → clients.ts fetchSymptom; Zendesk numeric ticket id;
// Trello shortLink/card id). The version segment in the Jira REST form is left
// open (\d+) so both the client's `/rest/api/3/issue/…` and the payload `self`
// form (`/rest/api/2/issue/…`, normalize.ts) resolve.
const JIRA_BROWSE = /^\/browse\/([A-Za-z][A-Za-z0-9]*-\d+)$/;
const JIRA_REST = /^\/rest\/api\/\d+\/issue\/([^/]+)$/;
const ZENDESK_AGENT = /^\/agent\/tickets\/(\d+)$/;
const ZENDESK_API = /^\/api\/v2\/tickets\/(\d+)\.json$/;
const TRELLO_CARD = /^\/c\/([^/]+)(?:\/.*)?$/;
const TRELLO_REST = /^\/1\/cards\/([^/]+)$/;

/**
 * Identify the provider + ticket id/key behind a pasted ticket URL, WITHOUT any
 * network call — this is pure recognition. The pasted origin is never fetched;
 * once resolved, the caller fetches (or pulls) through its own configured
 * connector/cloud, so a URL only ever tells us *which* ticket, never *how* to
 * reach it. Anything unrecognized or malformed returns undefined (never throws),
 * so callers can treat a bad paste as an honest miss.
 *
 * Recognized forms:
 *   Jira   (*.atlassian.net):  /browse/<KEY>, /rest/api/<n>/issue/<idOrKey>
 *   Zendesk(*.zendesk.com):    /agent/tickets/<id>, /api/v2/tickets/<id>.json
 *   Trello (trello.com|api.trello.com): /c/<shortLink>[/...], /1/cards/<id>
 */
export function parseTicketUrl(url: string): ParsedTicketRef | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  if (host.endsWith(".atlassian.net")) {
    const key = JIRA_BROWSE.exec(path)?.[1] ?? JIRA_REST.exec(path)?.[1];
    return key ? { provider: "jira", id: key } : undefined;
  }

  if (host.endsWith(".zendesk.com")) {
    const id = ZENDESK_AGENT.exec(path)?.[1] ?? ZENDESK_API.exec(path)?.[1];
    return id ? { provider: "zendesk", id } : undefined;
  }

  if (host === "trello.com" || host === "api.trello.com") {
    const id = TRELLO_CARD.exec(path)?.[1] ?? TRELLO_REST.exec(path)?.[1];
    return id ? { provider: "trello", id } : undefined;
  }

  return undefined;
}
