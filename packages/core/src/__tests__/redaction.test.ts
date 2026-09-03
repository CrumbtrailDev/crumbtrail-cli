import { fakeStripeLiveKey } from "./fixtures/fake-secrets";
import { afterEach, describe, expect, it } from "vitest";
import {
  BROWSER_REDACTION_POLICY,
  REDACTED_STORAGE_KEY,
  REDACTED_VALUE,
  attachRedactionMetadata,
  mergeRedactionMetadata,
  redactCookieMap,
  redactCookieValue,
  redactHeaders,
  redactInputValue,
  redactNetworkTextBody,
  redactProbeStorageKey,
  redactStorageKey,
  redactStoredValue,
  redactTokenLikeString,
  redactUrl,
  redactUrlsInText,
  redactValue,
  setCaptureInputValues,
  setRedactionKeepFields,
  summarizeBinaryPayload,
  summarizeOmittedPayload,
} from "../redaction";

describe("browser redaction policy", () => {
  it("redacts URL credentials, query values, fragments, and token-like path content", () => {
    const token = "a".repeat(40);
    const result = redactUrl(
      `https://user:pass@example.com/reset/${token}?token=abc&page=2#secret`,
    );

    expect(result.value).toBe(
      `https://example.com/reset/${REDACTED_VALUE}?token=[REDACTED;len=3;charset=alpha]&page=2`,
    );
    expect(result.metadata?.fields.map((field) => field.reason)).toEqual(
      expect.arrayContaining([
        "url_credentials",
        "url_query_value",
        "url_hash",
        "url_path_secret_segment",
      ]),
    );
  });

  it("redacts credentials in scheme-relative URLs", () => {
    const result = redactUrl(
      "  //alice:shortpass@example.com/reset?token=abc#secret",
    );

    expect(result.value).toBe(
      "  //example.com/reset?token=[REDACTED;len=3;charset=alpha]",
    );
    expect(result.metadata?.fields.map((field) => field.reason)).toEqual(
      expect.arrayContaining([
        "url_credentials",
        "url_query_value",
        "url_hash",
      ]),
    );
  });

  it("redacts credentials in whitespace-prefixed absolute URLs", () => {
    const result = redactUrl(
      "  https://alice:shortpass@example.com/reset?token=abc#secret",
    );

    expect(result.value).toBe(
      "  https://example.com/reset?token=[REDACTED;len=3;charset=alpha]",
    );
    expect(JSON.stringify(result)).not.toContain("alice");
    expect(JSON.stringify(result)).not.toContain("shortpass");
  });

  it("redacts secret-looking URL keys and short path tokens", () => {
    const result = redactUrl(
      "https://example.test/invite/AbCdEfGh1234567890?sk_fake_abcdefghijklmnopqrstuvwxyz=value",
    );

    expect(result.value).not.toContain("AbCdEfGh1234567890");
    expect(result.value).not.toContain("sk_live");
    expect(JSON.stringify(result.metadata)).not.toContain("sk_live");
  });

  it("redacts short sensitive path successors used in verification flows", () => {
    const result = redactUrl(
      "https://app.example.test/reset/123456/verify/654321?next=done",
    );

    expect(result.value).not.toContain("123456");
    expect(result.value).not.toContain("654321");
    expect(
      result.metadata?.fields.some((field) => field.action === "redacted"),
    ).toBe(true);
  });

  it("redacts short URL path values after sensitive field-name labels", () => {
    const passwordPath = redactUrl(
      "https://app.example.test/account/password/hunter2",
    );
    const clientSecretPath = redactUrl("/oauth/client_secret/abc123");
    const ssnPath = redactUrl("/profile/ssn/1234");
    const dottedPath = redactUrl("/reset/abc.def+ghi%3D");
    const tokenPath = redactUrl("/token/short.part");
    const encodedSlashPath = redactUrl("/reset/abc%2Fdef+ghi=");

    expect(passwordPath.value).not.toContain("hunter2");
    expect(clientSecretPath.value).not.toContain("abc123");
    expect(ssnPath.value).not.toContain("1234");
    expect(dottedPath.value).not.toContain("abc.def");
    expect(tokenPath.value).not.toContain("short.part");
    expect(encodedSlashPath.value).not.toContain("abc");
    expect(encodedSlashPath.value).not.toContain("def+ghi");
    expect(
      passwordPath.metadata?.fields.map((field) => field.reason),
    ).toContain("url_path_secret_segment");
  });

  it("keeps word-like product slugs in the URL path", () => {
    // The length band alone used to make any 16+ character hyphenated slug a
    // secret, so a product page URL arrived unreadable. A slug is words and
    // small numbers joined by separators; a key is not.
    for (const path of [
      "/products/aurora-desk-lamp",
      "/products/nimbus-keyboard",
      "/products/winter-sale-2024",
      "/blog/how-to-debug-faster",
      "/docs/getting_started_guide",
    ]) {
      expect(redactUrl(`https://shop.test${path}`).value).toBe(
        `https://shop.test${path}`,
      );
    }
  });

  it("still redacts real keys and tokens in the URL path", () => {
    for (const secret of [
      "sk_live_51H8xKLMnOpQrStUv",
      "AKIAIOSFODNN7EXAMPLE",
      "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6",
    ]) {
      const result = redactUrl(`https://api.test/resource/${secret}`);
      expect(result.value).not.toContain(secret);
      expect(result.metadata?.fields.map((field) => field.reason)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^url_path_(secret_segment|token)$/),
        ]),
      );
    }
  });

  it("redacts double-encoded and structured URL path secrets", () => {
    const doubleEncoded = redactUrl("https://example.test/reset%252F123456");
    const matrix = redactUrl("https://example.test/login;jsessionid=ABC123");

    expect(doubleEncoded.value).not.toContain("123456");
    expect(matrix.value).not.toContain("ABC123");
  });

  it("redacts encoded query delimiters inside URL path components", () => {
    const encoded = redactUrl("/callback%3Fcode=abc123&state=xyz789");
    const doubleEncoded = redactUrl(
      "https://example.test/oauth%253Fclient_secret=abc123%2526otp=123456",
    );

    expect(encoded.value).not.toContain("abc123");
    expect(encoded.value).not.toContain("xyz789");
    expect(doubleEncoded.value).not.toContain("abc123");
    expect(doubleEncoded.value).not.toContain("123456");
    expect(JSON.stringify([encoded, doubleEncoded])).toContain(
      "url_path_decoded_query_value",
    );
  });

  it("redacts sensitive headers and token-like header values while preserving safe headers", () => {
    const result = redactHeaders({
      Authorization: "Bearer secret-token-value",
      "content-type": "application/json",
      "x-content-hash": "7f".repeat(20),
      sk_fake_abcdefghijklmnopqrstuvwxyz: "header-name-secret",
      sk_demo_abcdefghijklmnopqrstuvwxyz: "second-header-name-secret",
    });

    expect(result.value.Authorization).toBe(REDACTED_VALUE);
    expect(result.value["content-type"]).toBe("application/json");
    expect(result.value["x-content-hash"]).toBe(REDACTED_VALUE);
    expect(result.value[REDACTED_STORAGE_KEY]).toBe(REDACTED_VALUE);
    expect(result.value[`${REDACTED_STORAGE_KEY}_2`]).toBe(REDACTED_VALUE);
    expect(result.metadata?.fields.map((field) => field.reason)).toEqual(
      expect.arrayContaining(["sensitive_header_name", "long_hex_token"]),
    );
    expect(JSON.stringify(result)).not.toContain("sk_live");
    expect(JSON.stringify(result)).not.toContain("sk_test");
    expect(JSON.stringify(result)).not.toContain("header-name-secret");
  });

  // A W3C trace id is exactly 32 hex characters, and so is the usual
  // x-request-id, so the generic long-hex token pattern ate both. Those headers
  // are the one field that joins a captured session to the customer's own
  // Splunk / Datadog / CloudWatch record, and destroying them only bites the
  // accounts that already propagate tracing — the ones where the join works.
  it("preserves the correlation headers the product joins on", () => {
    const traceparent =
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const requestId = "9f8c2d3e4b5a6978c0d1e2f3a4b5c6d7";
    const result = redactHeaders({
      traceparent,
      tracestate: "congo=t61rcWkgMzE",
      "x-request-id": requestId,
      "x-correlation-id": "5f2b9a1c-7e0d-4c3a-9b2e-1d8f6a4c0b77",
      "x-amzn-trace-id": "Root=1-5759e988-bd862e3fe1be46a994272793",
      "x-b3-traceid": "80f198ee56343ba864fe8b2a57d3eff7",
      b3: "80f198ee56343ba864fe8b2a57d3eff7-e457b5a2e4d86bd1-1",
    });

    expect(result.value.traceparent).toBe(traceparent);
    expect(result.value["x-request-id"]).toBe(requestId);
    expect(result.value["x-b3-traceid"]).toBe(
      "80f198ee56343ba864fe8b2a57d3eff7",
    );
    expect(result.value["x-amzn-trace-id"]).toBe(
      "Root=1-5759e988-bd862e3fe1be46a994272793",
    );
    expect(JSON.stringify(result.value)).not.toContain(REDACTED_VALUE);
  });

  // The exemption is for shape-only patterns. A credential misfiled into a
  // correlation header is still a credential.
  it("still redacts a real secret misfiled into a correlation header", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
    const stripeKey = fakeStripeLiveKey();
    const result = redactHeaders({
      "x-request-id": jwt,
      "x-correlation-id": stripeKey,
      traceparent: "Bearer abcdefghijklmnopqrstuvwxyz",
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(jwt);
    expect(serialized).not.toContain(stripeKey);
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("redacts URL-bearing headers with URL policy", () => {
    const result = redactHeaders({
      Location:
        " https://alice:shortpass@example.test/reset/123456?token=abc#frag",
      Link: '<https://example.test/magic/654321?token=abc>; rel="next"',
      Refresh: "0; url=https://example.test/reset/789012?token=abc#frag",
      "Refresh-Spaced": '0; URL = "/oauth/callback?code=spaced123"',
      "X-Next": "/oauth/callback?code=123456",
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("shortpass");
    expect(serialized).not.toContain("123456");
    expect(serialized).not.toContain("654321");
    expect(serialized).not.toContain("789012");
    expect(serialized).not.toContain("code=123456");
    expect(serialized).not.toContain("spaced123");
    expect(serialized).not.toContain("frag");
  });

  it("bounds direct header redaction before processing untrusted header maps", () => {
    const longName = `x-${"name".repeat(60)}`;
    const headers: Record<string, string> = {
      [longName]: "a".repeat(3_000),
      "x-long-safe": "safe ".repeat(600),
    };
    for (let index = 0; index < 90; index += 1) {
      headers[`x-extra-${index}`] = `safe-${index}`;
    }

    const result = redactHeaders(headers);
    const keys = Object.keys(result.value);
    const reasons = result.metadata?.fields.map((field) => field.reason) ?? [];

    expect(keys).toHaveLength(80);
    expect(keys[0]).toBe(REDACTED_STORAGE_KEY);
    expect(result.value["x-long-safe"]).toHaveLength(2_000);
    expect(reasons).toEqual(
      expect.arrayContaining([
        "header_name_truncated",
        "header_value_truncated",
        "header_count_limit",
      ]),
    );
    expect(JSON.stringify(result)).not.toContain(longName);
    expect(JSON.stringify(result)).not.toContain("x-extra-89");
  });

  it("always redacts cookie values and records cookie-specific summary metadata", () => {
    const result = redactCookieValue("session", "secret-cookie-value");

    expect(result.value).toBe(REDACTED_VALUE);
    expect(result.summary).toMatchObject({
      kind: "cookie",
      action: "redacted",
      reason: "cookie_value",
    });
    expect(result.metadata?.fields[0]).toMatchObject({
      path: "cookies.session",
      reason: "cookie_value",
    });
  });

  it("redacts secret-bearing cookie names from output keys and metadata paths", () => {
    const secret = "sk_fake_abcdefghijklmnopqrstuvwxyz";
    const result = redactCookieMap({ [secret]: "cookie-value" });

    expect(result.value).toEqual({ [REDACTED_STORAGE_KEY]: REDACTED_VALUE });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("redacts sensitive JSON fields and token-like strings without dropping safe structure", () => {
    const result = redactNetworkTextBody(
      JSON.stringify({
        ok: true,
        password: "correct-horse-battery-staple",
        nested: { apiKey: "sk_demo_1234567890123456", count: 3 },
        bearer: "Bearer abcdefghijklmnop",
      }),
      { contentType: "application/json", maxLength: 500 },
    );

    expect(result.body).toBe(
      JSON.stringify({
        ok: true,
        password: REDACTED_VALUE,
        nested: { apiKey: REDACTED_VALUE, count: 3 },
        bearer: REDACTED_VALUE,
      }),
    );
    expect(result.bodySummary).toMatchObject({
      kind: "json",
      action: "redacted",
      redactedFields: 3,
    });
  });

  it("redacts common credential, payment, and verification JSON fields", () => {
    const result = redactNetworkTextBody(
      JSON.stringify({
        credentials: "alice:hunter2",
        pwd: "hunter2",
        passphrase: "open sesame",
        cardNumber: "4111111111111111",
        cvv: "123",
        verificationCode: "123456",
        tokens: ["abc123"],
        passwords: ["hunter2"],
        apiKeys: ["short-key"],
        accessTokens: ["short-access"],
        refreshTokens: ["short-refresh"],
        idTokens: ["short-id"],
        clientSecrets: ["short-client-secret"],
        apiSecrets: ["short-api-secret"],
      }),
      { contentType: "application/json", maxLength: 500 },
    );

    expect(result.body).toBe(
      JSON.stringify({
        credentials: REDACTED_VALUE,
        pwd: REDACTED_VALUE,
        passphrase: REDACTED_VALUE,
        cardNumber: REDACTED_VALUE,
        cvv: REDACTED_VALUE,
        verificationCode: REDACTED_VALUE,
        tokens: REDACTED_VALUE,
        passwords: REDACTED_VALUE,
        apiKeys: REDACTED_VALUE,
        accessTokens: REDACTED_VALUE,
        refreshTokens: REDACTED_VALUE,
        idTokens: REDACTED_VALUE,
        clientSecrets: REDACTED_VALUE,
        apiSecrets: REDACTED_VALUE,
      }),
    );
    expect(result.bodySummary).toMatchObject({
      kind: "json",
      action: "redacted",
      redactedFields: 14,
    });
  });

  it("redacts every form body value", () => {
    const result = redactNetworkTextBody(
      "username=ada&password=lovelace&empty=",
      {
        contentType: "application/x-www-form-urlencoded",
        maxLength: 500,
      },
    );

    expect(result.body).toBe(
      "username=%5BREDACTED%5D&password=%5BREDACTED%5D&empty=",
    );
    expect(result.bodySummary).toMatchObject({
      kind: "form",
      action: "redacted",
      redactedFields: 2,
    });
  });

  it("redacts token-like strings in text bodies", () => {
    const result = redactNetworkTextBody(
      "failed with Bearer abcdefghijklmnop token",
      {
        contentType: "text/plain",
        maxLength: 500,
      },
    );

    expect(result.body).toBe(`failed with ${REDACTED_VALUE} token`);
    expect(result.bodySummary).toMatchObject({
      kind: "text",
      action: "redacted",
      reason: "token_like_value",
    });
  });

  it("redacts semicolon-separated sensitive text fields", () => {
    const result = redactNetworkTextBody(
      "username=alice;password=hunter2;client_secret=abc123",
      {
        contentType: "text/plain",
        maxLength: 500,
      },
    );

    expect(result.body).toBe(
      `username=alice;password=${REDACTED_VALUE};client_secret=${REDACTED_VALUE}`,
    );
    expect(result.bodySummary).toMatchObject({
      kind: "text",
      action: "redacted",
      reason: "text_key_value_fields",
    });
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain("abc123");
  });

  it("redacts sensitive XML and HTML-style text fields", () => {
    const xml = redactNetworkTextBody(
      "<login><password>hunter2</password><safe>ok</safe></login>",
      {
        contentType: "application/xml",
        maxLength: 500,
      },
    );
    const nestedXml = redactNetworkTextBody(
      "<login><password><![CDATA[hunter2]]></password><token><value>abc123</value></token></login>",
      {
        contentType: "application/xml",
        maxLength: 500,
      },
    );
    const html = redactNetworkTextBody(
      '<input type="hidden" name="csrf" value="abc123"><input name="password" value="hunter2"><div data-token="short-secret"></div><input type=hidden name=csrf value=def456><input name=password value=open-sesame><div data-token=compact-secret></div><input type="text" name="password" value="type-first-secret"><textarea name="api_key">textarea-secret</textarea><meta name="csrf-token" content="meta-secret"><meta name=api-key content=meta-api-secret>',
      {
        contentType: "text/html",
        maxLength: 500,
      },
    );

    expect(JSON.stringify([xml, nestedXml, html])).not.toContain("hunter2");
    expect(JSON.stringify([xml, nestedXml, html])).not.toContain("abc123");
    expect(JSON.stringify([xml, nestedXml, html])).not.toContain("def456");
    expect(JSON.stringify([xml, nestedXml, html])).not.toContain("open-sesame");
    expect(JSON.stringify([xml, nestedXml, html])).not.toContain(
      "short-secret",
    );
    expect(JSON.stringify([xml, nestedXml, html])).not.toContain(
      "compact-secret",
    );
    expect(JSON.stringify([xml, nestedXml, html])).not.toContain(
      "type-first-secret",
    );
    expect(JSON.stringify([xml, nestedXml, html])).not.toContain(
      "textarea-secret",
    );
    expect(JSON.stringify([xml, nestedXml, html])).not.toContain("meta-secret");
    expect(JSON.stringify([xml, nestedXml, html])).not.toContain(
      "meta-api-secret",
    );
  });

  it("redacts unquoted multipart sensitive fields", () => {
    const result = redactNetworkTextBody(
      [
        "--boundary",
        "Content-Disposition: form-data; name=csrf",
        "",
        "abc123",
        "--boundary",
        "Content-Disposition: form-data; name=password",
        "",
        "hunter2",
        "--boundary--",
      ].join("\r\n"),
      {
        contentType: "multipart/form-data; boundary=boundary",
        maxLength: 500,
      },
    );

    expect(JSON.stringify(result)).not.toContain("abc123");
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(result.bodySummary).toMatchObject({
      kind: "text",
      action: "redacted",
      reason: "markup_sensitive_fields",
    });
  });

  it("redacts sensitive fields in text key-value bodies", () => {
    const result = redactNetworkTextBody(
      "username=alice&password=hunter2&api_key=short-secret",
      {
        contentType: "text/plain",
        maxLength: 500,
      },
    );

    expect(result.body).not.toContain("hunter2");
    expect(result.body).not.toContain("short-secret");
    expect(result.bodySummary).toMatchObject({
      kind: "text",
      action: "redacted",
      reason: "text_key_value_fields",
    });
  });

  it("redacts plural sensitive names in text key-value bodies", () => {
    const result = redactNetworkTextBody(
      "refreshTokens=abc123&clientSecrets=short-secret",
      {
        contentType: "text/plain",
        maxLength: 500,
      },
    );

    expect(result.body).not.toContain("abc123");
    expect(result.body).not.toContain("short-secret");
  });

  it("redacts mixed-delimiter text key-value bodies", () => {
    const result = redactNetworkTextBody(
      "note=ok\npassword=hunter2&status=fail",
      {
        contentType: "text/plain",
        maxLength: 500,
      },
    );

    expect(result.body).toBe(`note=ok\npassword=${REDACTED_VALUE}&status=fail`);
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(result.bodySummary).toMatchObject({
      kind: "text",
      action: "redacted",
      reason: "text_key_value_fields",
    });
  });

  it("redacts common credential and payment fields in text key-value bodies", () => {
    const result = redactNetworkTextBody(
      "creds=alice:hunter2&pwd=hunter2&passphrase=open-sesame&cardNumber=4111111111111111&pin=1234",
      {
        contentType: "text/plain",
        maxLength: 500,
      },
    );

    expect(JSON.stringify(result)).not.toContain("alice:hunter2");
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain("open-sesame");
    expect(JSON.stringify(result)).not.toContain("4111111111111111");
    expect(JSON.stringify(result)).not.toContain("1234");
  });

  it("summarizes sensitive opaque URL schemes instead of keeping embedded payloads", () => {
    const dataUrl = redactUrl("data:text/plain,password=hunter2");
    const scriptUrl = redactUrl('javascript:alert("hunter2")');

    expect(dataUrl.value).toBe(`data:${REDACTED_VALUE}`);
    expect(scriptUrl.value).toBe(`javascript:${REDACTED_VALUE}`);
    expect(JSON.stringify([dataUrl, scriptUrl])).not.toContain("hunter2");
  });

  it("drops malformed JSON-like bodies instead of persisting raw sensitive fields", () => {
    const result = redactNetworkTextBody(
      '{"password":"raw-secret", "ok": true',
      {
        contentType: "application/json",
        maxLength: 500,
      },
    );

    expect(result.body).toBeUndefined();
    expect(result.bodySummary).toMatchObject({
      kind: "json",
      action: "dropped",
      reason: "malformed_json_body",
      originalLength: 36,
    });
    expect(result.metadata).toMatchObject({
      policy: "crumbtrail.browser-redaction.v1",
      fields: [
        { path: "body", reason: "malformed_json_body", action: "dropped" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("raw-secret");
  });

  it("drops JSON content-type bodies that fail parsing even when they do not look like objects", () => {
    const result = redactNetworkTextBody("password=raw-secret", {
      contentType: "application/json",
      maxLength: 500,
    });

    expect(result.body).toBeUndefined();
    expect(result.bodySummary).toMatchObject({
      kind: "json",
      action: "dropped",
      reason: "malformed_json_body",
    });
    expect(JSON.stringify(result)).not.toContain("raw-secret");
  });

  it("summarizes oversized bodies instead of persisting a truncated preview", () => {
    const result = redactNetworkTextBody("x".repeat(20), {
      contentType: "text/plain",
      maxLength: 10,
    });

    expect(result.body).toBeUndefined();
    expect(result.bodySummary).toMatchObject({
      kind: "text",
      action: "summarized",
      reason: "payload_too_large",
      originalLength: 20,
      limit: 10,
    });
  });

  it("summarizes binary and unreadable network payloads with explicit metadata reasons", () => {
    const binary = summarizeBinaryPayload("image/png", "42");
    const unreadable = summarizeOmittedPayload("body_read_failed");

    expect(binary.body).toBe("[bin:42]");
    expect(binary.bodySummary).toMatchObject({
      kind: "binary",
      action: "summarized",
      reason: "binary_payload:image/png",
      contentLength: "42",
    });
    expect(binary.metadata?.summaries?.[0]).toMatchObject({
      reason: "binary_payload:image/png",
    });
    expect(binary.metadata?.fields[0]).toMatchObject({
      reason: "binary_payload",
      action: "summarized",
    });
    expect(unreadable.bodySummary).toMatchObject({
      kind: "unknown",
      action: "dropped",
      reason: "body_read_failed",
    });
  });

  it("redacts sensitive storage keys and all stored values", () => {
    const key = redactStorageKey("refreshToken");
    const value = redactStoredValue("dark-mode", {
      key: "theme",
      maxLength: 50,
    });

    expect(key.value).toBe(REDACTED_STORAGE_KEY);
    expect(key.metadata?.fields[0]).toMatchObject({
      reason: "sensitive_storage_key",
    });
    expect(value.value).toBe(REDACTED_VALUE);
    expect(value.summary).toMatchObject({
      kind: "storage",
      action: "redacted",
      reason: "storage_value",
    });
  });

  /**
   * `redactProbeStorageKey` is the storage key treatment for the live probe path, where the browser
   * answering is a bystander's rather than the recorded session's. It keeps a key's shape and drops
   * every span that could name a person. `redactStorageKey`, the consented collector's treatment,
   * is deliberately untouched by all of this.
   */
  describe("redactProbeStorageKey", () => {
    it("replaces only the identifying span and keeps the pattern", () => {
      expect(
        redactProbeStorageKey("session:alice@example.com:cart").value,
      ).toBe("session:*:cart");
      expect(redactProbeStorageKey("user_12345_prefs").value).toBe(
        "user_*_prefs",
      );
      expect(redactProbeStorageKey("phone:+1-555-123-4567").value).toBe(
        "phone:+*-*-*-*",
      );
    });

    it("keeps a key that names nothing but structure exactly as it is", () => {
      for (const key of ["theme", "cart", "featureFlags", "@scope/pkg"]) {
        const result = redactProbeStorageKey(key);
        expect(result.value).toBe(key);
        expect(result.metadata).toBeUndefined();
      }
    });

    it("falls back to the collector's verdict where there is no pattern to preserve", () => {
      // No separators, so structure preservation buys nothing and the stricter rule stands.
      expect(redactProbeStorageKey("refreshToken").value).toBe(
        REDACTED_STORAGE_KEY,
      );
      expect(redactProbeStorageKey("user12345").value).toBe(
        REDACTED_STORAGE_KEY,
      );
    });

    it("redacts a key that is a token rather than a name", () => {
      const result = redactProbeStorageKey(
        "sess_550e8400-e29b-41d4-a716-446655440000",
      );

      expect(result.value).toBe(REDACTED_STORAGE_KEY);
      expect(result.metadata?.fields[0]).toMatchObject({
        reason: "storage_key_token_like",
      });
    });

    it("leaves the collector's own key treatment alone", () => {
      // The same inputs, through the consented capture path, keep answering what they answered.
      expect(redactStorageKey("user_12345_prefs").value).toBe(
        "user_12345_prefs",
      );
      expect(redactStorageKey("cart:alice@example.com:items").value).toBe(
        "cart:alice@example.com:items",
      );
      expect(redactStorageKey("theme").value).toBe("theme");
      expect(redactStorageKey("refreshToken").value).toBe(REDACTED_STORAGE_KEY);
    });
  });

  it("redacts free text and credential inputs whatever the field is called", () => {
    const text = redactInputValue("hello world", {
      name: "comment",
      type: "text",
    });
    const password = redactInputValue("secret", {
      name: "password",
      type: "password",
    });

    expect(text.value).toBe(REDACTED_VALUE);
    expect(text.summary).toMatchObject({ reason: "free_text_value" });
    expect(password.value).toBe(REDACTED_VALUE);
    expect(password.summary).toMatchObject({ reason: "sensitive_input_value" });
  });

  it("redacts standalone token-like strings deterministically", () => {
    const input = `prefix ${"a".repeat(40)} suffix`;
    expect(redactTokenLikeString(input).value).toBe(
      `prefix ${REDACTED_VALUE} suffix`,
    );
  });

  it("redacts prefixed tokens embedded in larger key fragments", () => {
    const secret = "sk_fake_abcdefghijklmnopqrstuvwxyz";

    expect(redactTokenLikeString(`auth_${secret}`).value).toBe(
      `auth_${REDACTED_VALUE}`,
    );
    expect(
      redactTokenLikeString("value glpat-abcdefghijklmnopqrst").value,
    ).toBe(`value ${REDACTED_VALUE}`);
    expect(redactTokenLikeString("value xoxb-abcdefghijklmnopqrst").value).toBe(
      `value ${REDACTED_VALUE}`,
    );
  });

  it("redacts secret-bearing object keys and metadata paths", () => {
    const secret = "sk_fake_abcdefghijklmnopqrstuvwxyz";
    const result = redactNetworkTextBody(
      JSON.stringify({ [secret]: "value" }),
      {
        contentType: "application/json",
        maxLength: 500,
      },
    );

    expect(result.body).toBe(
      JSON.stringify({ [REDACTED_STORAGE_KEY]: REDACTED_VALUE }),
    );
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("redactUrlsInText — URL query secrets inside free text", () => {
  // A ~12-char query value: below the 32-hex / 40-alnum token thresholds and with
  // no Bearer/JWT/prefix shape, so redactTokenLikeString alone would MISS it.
  const SHORT = "abc123def456";

  it("scrubs a short ?token= value while preserving origin + path", () => {
    const result = redactUrlsInText(
      `see https://cb.example.com/callback?token=${SHORT} for details`,
    );

    expect(result.value).not.toContain(SHORT);
    expect(result.value).toContain("cb.example.com/callback");
    expect(result.value).toContain("see ");
    expect(result.value).toContain(" for details");
    expect(result.metadata?.fields.map((f) => f.reason)).toContain(
      "url_query_value",
    );
    // Sanity: the token-shape scrubber on its own would NOT catch this.
    expect(redactTokenLikeString(`?token=${SHORT}`).value).toContain(SHORT);
  });

  it("scrubs embedded relative and query-only URLs", () => {
    const result = redactUrlsInText(
      `href=/callback?token=${SHORT} and callback?code=1234 and ?account=5678`,
      "message",
      { allowOnlyHttpSchemes: true, allowRelativeUrlsInText: true },
    );

    expect(result.value).toContain("href=/callback?token=[REDACTED");
    expect(result.value).toContain("callback?code=[REDACTED");
    expect(result.value).toContain("?account=[REDACTED");
    expect(result.value).not.toContain(SHORT);
    expect(result.value).not.toContain("code=1234");
    expect(result.value).not.toContain("account=5678");
  });

  it("rejects Unicode IDN and path components before URL normalization", () => {
    for (const url of [
      "https://раypal.example/checkout",
      "https://example.test/платеж",
      "https://example.test/%D0%BF%D0%BB%D0%B0%D1%82%D0%B5%D0%B6",
    ]) {
      const result = redactUrl(url);
      expect(result.value).toBe(REDACTED_VALUE);
      expect(result.metadata?.fields).toContainEqual(
        expect.objectContaining({
          reason: "non_ascii_url_component",
          action: "dropped",
        }),
      );
    }
  });

  it("preserves ordinary colon labels when redacting URL-like text", () => {
    const result = redactUrlsInText("Error:failed. Status: pending.");
    expect(result.value).toBe("Error:failed. Status: pending.");
    expect(result.metadata).toBeUndefined();
  });

  it("leaves free text without a URL untouched (no metadata)", () => {
    const result = redactUrlsInText("plain text, nothing to see here");
    expect(result.value).toBe("plain text, nothing to see here");
    expect(result.metadata).toBeUndefined();
  });

  it("does not swallow trailing sentence punctuation", () => {
    const result = redactUrlsInText(
      `redirect https://x.example.com/cb?token=${SHORT}.`,
    );
    expect(result.value).not.toContain(SHORT);
    expect(result.value.endsWith(".")).toBe(true);
  });

  it("scrubs a URL query secret inside a redactValue string field", () => {
    const result = redactValue({
      note: `landed on https://x.example.com/cb?token=${SHORT}`,
    });
    expect(JSON.stringify(result.value)).not.toContain(SHORT);
    expect(JSON.stringify(result.value)).toContain("x.example.com/cb");
  });

  it("scrubs a URL query secret inside a plain text network body", () => {
    const result = redactNetworkTextBody(
      `redirect https://x.example.com/cb?token=${SHORT}`,
      { contentType: "text/plain", maxLength: 500 },
    );
    expect(result.body).not.toContain(SHORT);
    expect(result.body).toContain("x.example.com/cb");
  });
});

describe("redactValue", () => {
  it("redacts sensitive keys in nested objects", () => {
    const result = redactValue({
      user: { name: "Ada", password: "hunter2" },
    });

    expect(result.value).toEqual({
      user: { name: "Ada", password: REDACTED_VALUE },
    });
    expect(result.metadata?.fields.map((f) => f.path)).toEqual(
      expect.arrayContaining(["value.user.password"]),
    );
  });

  it("redacts Unicode-confusable sensitive keys", () => {
    const result = redactValue({
      раssword: "hunter2",
      сardNumber: "4111111111111111",
      safe: "ok",
    });

    expect(result.value).toEqual({
      раssword: REDACTED_VALUE,
      сardNumber: REDACTED_VALUE,
      safe: "ok",
    });
    expect(JSON.stringify(result.value)).not.toContain("hunter2");
    expect(JSON.stringify(result.value)).not.toContain("4111111111111111");
  });

  it("redacts token-like values inside array elements", () => {
    const result = redactValue({
      notes: [`auth: ${"a".repeat(40)}`, "plain text"],
    });

    expect(result.value).toEqual({
      notes: [`auth: ${REDACTED_VALUE}`, "plain text"],
    });
    expect(result.metadata?.fields.map((f) => f.path)).toEqual(
      expect.arrayContaining(["value.notes[0]"]),
    );
  });

  it("returns no metadata when nothing in the value needs redaction", () => {
    const result = redactValue({ a: 1, b: "plain text" });
    expect(result.value).toEqual({ a: 1, b: "plain text" });
    expect(result.metadata).toBeUndefined();
  });

  it("uses the provided path prefix for redacted field paths", () => {
    const result = redactValue({ password: "hunter2" }, "custom.root");
    expect(result.metadata?.fields[0].path).toBe("custom.root.password");
  });

  // A Date has no own enumerable properties, so the generic object walk turns
  // every timestamp column into `{}`. Timestamps are the columns an ordering or
  // timing question is answered with, and rows that differ only by one collapse
  // to a single value, which reads downstream as duplicate work that never
  // happened.
  it("keeps Date values as ISO timestamps rather than empty objects", () => {
    const result = redactValue({
      created_at: new Date("2026-07-28T06:16:57.484Z"),
    });

    expect(result.value).toEqual({ created_at: "2026-07-28T06:16:57.484Z" });
  });

  it("keeps Date values distinct inside nested rows", () => {
    const result = redactValue({
      rows: [
        { id: 1, created_at: new Date("2026-07-28T06:00:00.000Z") },
        { id: 2, created_at: new Date("2026-07-28T06:00:01.000Z") },
      ],
    });

    expect(result.value).toEqual({
      rows: [
        { id: 1, created_at: "2026-07-28T06:00:00.000Z" },
        { id: 2, created_at: "2026-07-28T06:00:01.000Z" },
      ],
    });
  });

  it("represents an invalid Date without throwing", () => {
    const result = redactValue({ created_at: new Date(Number.NaN) });
    expect(result.value).toEqual({ created_at: null });
  });
});

describe("mergeRedactionMetadata", () => {
  it("combines fields and summaries from multiple metadata objects", () => {
    const a = redactValue({ password: "hunter2" }, "a");
    const b = redactValue(
      { apiKey: "sk_fake_abcdefghijklmnopqrstuvwxyz" },
      "b",
    );

    const merged = mergeRedactionMetadata(a.metadata, b.metadata);

    expect(merged?.policy).toBe(BROWSER_REDACTION_POLICY);
    expect(merged?.fields).toHaveLength(2);
    expect(merged?.fields.map((f) => f.path)).toEqual(
      expect.arrayContaining(["a.password", "b.apiKey"]),
    );
  });

  it("skips undefined entries without throwing", () => {
    const a = redactValue({ password: "hunter2" }, "a");
    const merged = mergeRedactionMetadata(undefined, a.metadata, undefined);
    expect(merged?.fields).toHaveLength(1);
  });

  it("returns undefined when every input is undefined or empty", () => {
    expect(mergeRedactionMetadata()).toBeUndefined();
    expect(mergeRedactionMetadata(undefined, undefined)).toBeUndefined();
  });
});

describe("attachRedactionMetadata", () => {
  it("sets target.redaction when there is metadata to attach", () => {
    const target: Record<string, unknown> = { foo: "bar" };
    const result = redactValue({ password: "hunter2" });

    attachRedactionMetadata(target, result.metadata);

    expect(target.redaction).toEqual(result.metadata);
    expect(target.foo).toBe("bar");
  });

  it("does not set target.redaction when there is nothing to redact", () => {
    const target: Record<string, unknown> = { foo: "bar" };
    attachRedactionMetadata(target, undefined);
    expect(target).not.toHaveProperty("redaction");
  });
});

/**
 * Every input is masked by default, which is what Datadog, Sentry and PostHog all do and is not a
 * decision this SDK reopens. What the body and query-string planes already offer and this one did
 * not is a way for an application to name one of its own fields and get it back. Without it, the
 * only opt-in is a DOM attribute, so a filter value that explains a whole class of defect can only
 * be recovered by editing markup.
 */
describe("keepFields on input values", () => {
  afterEach(() => setRedactionKeepFields([]));

  // Free text is what the keep list buys on an input, the same as in a request body: the search term
  // with a quote in it, the address line a validator wrongly rejects.
  it("keeps free text in a field the application named", () => {
    setRedactionKeepFields(["searchTerm"]);

    expect(
      redactInputValue("red shoes size 12", { name: "searchTerm" }).value,
    ).toBe("red shoes size 12");
  });

  it("still masks every field the application did not name", () => {
    setRedactionKeepFields(["maxPrice"]);

    expect(redactInputValue("Ada Lovelace", { name: "fullName" }).value).toBe(
      REDACTED_VALUE,
    );
  });

  // The keep is a statement about the field, not about whatever ends up typed into it.
  it("catches a secret pasted into a kept field on its content", () => {
    setRedactionKeepFields(["note", "reference"]);

    expect(redactInputValue("4111111111111111", { name: "note" }).value).toBe(
      REDACTED_VALUE,
    );
    expect(
      redactInputValue("ada@example.com", { name: "reference" }).value,
    ).toBe(REDACTED_VALUE);
  });

  // `keepFields` is a list of names. An application that happens to use one for a credential input
  // would otherwise publish the credential, so the input type overrules the name.
  it("refuses to keep a credential input whatever it is called", () => {
    setRedactionKeepFields(["token", "contact"]);

    expect(
      redactInputValue("hunter2", { name: "token", type: "password" }).value,
    ).toBe(REDACTED_VALUE);
    expect(
      redactInputValue("555-0100", { name: "contact", type: "tel" }).value,
    ).toBe(REDACTED_VALUE);
  });

  // The keep list is for free-text fields. A number was already evidence under the default policy.
  it("needs no keep for a value the classifier keeps anyway", () => {
    expect(redactInputValue("250", { name: "maxPrice" }).value).toBe("250");
  });

  // A form value is a string even when it is a number, and the enum alphabet has no dot in it. Every
  // price, rate and decimal quantity a user types lands here.
  it("records a decimal the user typed", () => {
    expect(
      redactInputValue("0.29", { name: "maxPrice", type: "number" }).value,
    ).toBe("0.29");
    expect(redactInputValue("-12.5", { name: "adjustment" }).value).toBe(
      "-12.5",
    );
  });

  // The same value in the same declared field, arriving as a query parameter instead of as a typed
  // input. A decimal deleted here and kept in the JSON body one line below is the disagreement a
  // filter or rounding defect lives in.
  it("keeps a decimal in a kept query parameter", () => {
    setRedactionKeepFields(["maxPrice"]);

    expect(
      redactUrl("https://app.test/api/search?maxPrice=0.29", "url").value,
    ).toContain("maxPrice=0.29");
  });

  it("still redacts a decimal in a parameter the application did not name", () => {
    setRedactionKeepFields(["maxPrice"]);

    expect(
      redactUrl("https://app.test/api/search?salary=52000.5", "url").value,
    ).not.toContain("52000.5");
  });

  // Numeric classification must not become a way past the card check.
  it("still catches a card number typed into a plain field", () => {
    expect(
      redactInputValue("4111111111111111", { name: "reference" }).value,
    ).toBe(REDACTED_VALUE);
  });
});

/**
 * The opt-out counsel required. A deployment that would rather hold none of what users type sets one
 * flag and holds none of it, whatever any field is named.
 */
describe("captureInputValues opt-out", () => {
  afterEach(() => {
    setCaptureInputValues(true);
    setRedactionKeepFields([]);
  });

  it("records input values by default", () => {
    expect(redactInputValue("250", { name: "maxPrice" }).value).toBe("250");
  });

  it("records nothing a user typed when the deployment opts out", () => {
    setCaptureInputValues(false);

    expect(redactInputValue("250", { name: "maxPrice" }).value).toBe(
      REDACTED_VALUE,
    );
  });

  // The switch can only remove. An application keep must not be able to undo a deployment decision.
  it("cannot be overridden by keepFields", () => {
    setCaptureInputValues(false);
    setRedactionKeepFields(["searchTerm", "maxPrice"]);

    expect(redactInputValue("red shoes", { name: "searchTerm" }).value).toBe(
      REDACTED_VALUE,
    );
    expect(redactInputValue("250", { name: "maxPrice" }).value).toBe(
      REDACTED_VALUE,
    );
  });

  it("leaves the rest of the redaction policy alone", () => {
    setCaptureInputValues(false);
    setRedactionKeepFields(["maxPrice"]);

    expect(
      redactUrl("https://app.test/api/search?maxPrice=0.29", "url").value,
    ).toContain("maxPrice=0.29");
  });

  // Omitted is not "off": an application that says nothing gets the documented default.
  it("treats an unset value as on", () => {
    setCaptureInputValues(undefined);

    expect(redactInputValue("250", { name: "maxPrice" }).value).toBe("250");
  });
});
