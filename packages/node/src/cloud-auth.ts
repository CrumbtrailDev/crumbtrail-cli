// --- Where a cloud call gets its credentials -------------------------------
//
// Every call this package makes to a Crumbtrail cloud deployment authenticates
// the same way: an agent token (`ctagt_`) in an `Authorization: Bearer` header
// against a base URL. Two very different deployments need that pair to come
// from two different places, and this module is the single seam between them.
//
//  - SELF-HOSTED / LOCAL. One engineer, one machine, one tenant. The pair lives
//    in `CRUMBTRAIL_CLOUD_URL` / `CRUMBTRAIL_CLOUD_TOKEN` in the process
//    environment, which is set once and is correct for every call the process
//    makes. This is what the stdio MCP server has always used and it keeps
//    working untouched.
//
//  - HOSTED. One process serves every tenant. There is no single correct token,
//    because the credential must be the CALLING tenant's own agent token, which
//    is known per request and never per process. A hosted dispatcher therefore
//    passes {@link CloudCredentials} explicitly and the environment is not
//    consulted at all.
//
// Explicit credentials WIN over the environment rather than merging with it. A
// hosted process that happens to have `CRUMBTRAIL_CLOUD_TOKEN` set in its own
// environment must never fall back to it for a caller: that would answer one
// tenant's request with another tenant's credential, which is worse than
// failing.

/** A cloud base URL and the agent token to send to it, supplied per call. */
export interface CloudCredentials {
  /** Deployment origin, with or without a trailing slash. */
  baseUrl: string;
  /** The caller's own agent token (`ctagt_`). Never a project key (`ctkey_`),
   *  which is ingest-only and is refused on every read and memory route. */
  token: string;
}

/** Resolved, validated pair the request helpers actually use. */
export interface CloudAuth {
  base: string;
  token: string;
}

/**
 * Bases the agent token may be sent to. The token is a tenant wide secret carried in an
 * `Authorization` header, so a plain `http:` base would put it on the wire in cleartext for
 * anyone on the path. Loopback is exempt because it never leaves the machine and is how the
 * cloud is run locally — and it is also the hop a hosted deployment uses to read its own
 * audited `/api/agent/*` routes.
 */
export function isTransportSecureBase(base: string): boolean {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]")
  );
}

function trimBase(value: string | undefined): string | undefined {
  return value?.replace(/\/+$/, "") || undefined;
}

/**
 * The base URL a call would use, before it is checked. Exists so an
 * "unconfigured" gap can tell an operator that a base IS set but was refused,
 * instead of sending them looking for a variable that is already there.
 */
export function cloudBase(credentials?: CloudCredentials): string | undefined {
  if (credentials) return trimBase(credentials.baseUrl);
  return trimBase(process.env.CRUMBTRAIL_CLOUD_URL);
}

/**
 * The credential pair for one call, or `undefined` when there is not a usable
 * one. Explicit credentials are used alone; the environment is read only when
 * none were passed.
 */
export function resolveCloudAuth(
  credentials?: CloudCredentials,
): CloudAuth | undefined {
  const base = cloudBase(credentials);
  const token = credentials
    ? credentials.token
    : process.env.CRUMBTRAIL_CLOUD_TOKEN;
  if (!base || !token) return undefined;
  if (!isTransportSecureBase(base)) return undefined;
  return { base, token };
}

export const INSECURE_BASE_MESSAGE =
  "The Crumbtrail cloud URL must use https (localhost is the only exception). The agent token is not sent over plain http.";

/**
 * The gap a call reports when it has no usable credentials.
 *
 * `stem` is the sentence up to and including its verb, for example
 * `"Live probes require"`. What follows depends on WHERE the credentials were
 * meant to come from, because sending a hosted operator to look at
 * `CRUMBTRAIL_CLOUD_TOKEN` — a variable that is deliberately not consulted on
 * that path — is a wrong answer that costs an hour. A base that is set but
 * refused is reported as its own reason for the same purpose.
 */
export function cloudAuthGap(
  stem: string,
  credentials?: CloudCredentials,
): string {
  const base = cloudBase(credentials);
  if (base && !isTransportSecureBase(base)) return INSECURE_BASE_MESSAGE;
  return credentials
    ? `${stem} a cloud URL and an agent token for the calling tenant.`
    : `${stem} CRUMBTRAIL_CLOUD_URL and CRUMBTRAIL_CLOUD_TOKEN.`;
}
