import { createHash, createHmac } from "node:crypto";

/**
 * Minimal AWS Signature Version 4 signer for a single JSON POST request.
 *
 * Hand-rolled with `node:crypto` on purpose (CP4 decision): the CloudWatch
 * adapter needs exactly one thing from AWS — a signed `POST` to the CloudWatch
 * Logs endpoint — and pulling in the AWS SDK (or even `aws4fetch`) would add a
 * runtime dependency to the *published* `crumbtrail-node` tarball for ~60 lines
 * of well-specified crypto. Keeping it here means zero new deps, a node-only
 * surface (Node ≥ 22 ships `crypto`), and a signature path we can unit-test in
 * isolation against AWS's own worked example.
 *
 * Scope is deliberately narrow: `X-Amz-Content-Sha256` is NOT emitted (the Logs
 * JSON API does not require it) and only the headers we actually send are
 * signed. It is not a general-purpose signer.
 *
 * Secrets discipline: the secret access key is used ONLY inside the HMAC signing
 * chain here; it never appears in the returned headers, a thrown message, a log,
 * or gap text. The returned `Authorization` header carries the derived signature
 * and the (non-secret) access key id, exactly as AWS requires.
 */

const ALGORITHM = "AWS4-HMAC-SHA256";

export interface SigV4Input {
  method: string;
  /** Absolute request URL (host + path + optional query). */
  url: string;
  region: string;
  /** AWS service name, e.g. "logs". */
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary-credential session token (STS/role). Signed + echoed when set. */
  sessionToken?: string;
  /** Request body (already serialized). Hashed into the canonical request. */
  body: string;
  /** Non-auth headers to sign (e.g. content-type, x-amz-target). */
  headers: Record<string, string>;
  /** Signing instant. Injectable for deterministic tests. Default `new Date()`. */
  now?: Date;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

/** `YYYYMMDDTHHMMSSZ` (amz date) + `YYYYMMDD` (date stamp) from one instant. */
function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString(); // 2026-07-08T12:34:56.789Z
  const amzDate = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(
    11,
    13,
  )}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * Derive the AWS SigV4 signing key: HMAC chain
 * `("AWS4"+secret) → date → region → service → "aws4_request"`.
 */
function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export interface SignedHeaders {
  [name: string]: string;
}

/**
 * Sign `input` and return the request headers to send (the caller's headers plus
 * `X-Amz-Date`, `Authorization`, and `X-Amz-Security-Token` when a session token
 * is present). Pure and synchronous.
 */
export function signSigV4(input: SigV4Input): SignedHeaders {
  const now = input.now ?? new Date();
  const { amzDate, dateStamp } = amzDates(now);
  const parsed = new URL(input.url);

  // Canonical headers: host + x-amz-date + the caller's headers (+ session token
  // when present), lower-cased names, trimmed values, sorted by name.
  const signable: Record<string, string> = {
    host: parsed.host,
    "x-amz-date": amzDate,
  };
  for (const [name, value] of Object.entries(input.headers)) {
    signable[name.toLowerCase()] = value.trim();
  }
  if (input.sessionToken) signable["x-amz-security-token"] = input.sessionToken;

  const sortedNames = Object.keys(signable).sort();
  const canonicalHeaders = sortedNames
    .map((name) => `${name}:${signable[name]}\n`)
    .join("");
  const signedHeaderList = sortedNames.join(";");

  // Canonical URI (path) + query. The Logs endpoint path is "/" with no query,
  // but keep this general and correct: preserve encoded path, sort query params.
  const canonicalUri = parsed.pathname || "/";
  const canonicalQuery = [...parsed.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderList,
    sha256Hex(input.body),
  ].join("\n");

  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const key = signingKey(
    input.secretAccessKey,
    dateStamp,
    input.region,
    input.service,
  );
  const signature = createHmac("sha256", key)
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization =
    `${ALGORITHM} Credential=${input.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaderList}, Signature=${signature}`;

  const out: SignedHeaders = {
    ...input.headers,
    "X-Amz-Date": amzDate,
    Authorization: authorization,
  };
  if (input.sessionToken) out["X-Amz-Security-Token"] = input.sessionToken;
  return out;
}
