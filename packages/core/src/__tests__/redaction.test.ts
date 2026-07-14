import { describe, expect, it } from "vitest";
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
  redactStorageKey,
  redactStoredValue,
  redactTokenLikeString,
  redactUrl,
  redactUrlsInText,
  redactValue,
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
      `https://example.com/reset/${encodeURIComponent(REDACTED_VALUE)}?token=%5BREDACTED%5D&page=%5BREDACTED%5D`,
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

    expect(result.value).toBe("  //example.com/reset?token=%5BREDACTED%5D");
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
      "  https://example.com/reset?token=%5BREDACTED%5D",
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
      "x-request-id": "7f".repeat(20),
      sk_fake_abcdefghijklmnopqrstuvwxyz: "header-name-secret",
      sk_demo_abcdefghijklmnopqrstuvwxyz: "second-header-name-secret",
    });

    expect(result.value.Authorization).toBe(REDACTED_VALUE);
    expect(result.value["content-type"]).toBe("application/json");
    expect(result.value["x-request-id"]).toBe(REDACTED_VALUE);
    expect(result.value[REDACTED_STORAGE_KEY]).toBe(REDACTED_VALUE);
    expect(result.value[`${REDACTED_STORAGE_KEY}_2`]).toBe(REDACTED_VALUE);
    expect(result.metadata?.fields.map((field) => field.reason)).toEqual(
      expect.arrayContaining(["sensitive_header_name", "long_hex_token"]),
    );
    expect(JSON.stringify(result)).not.toContain("sk_live");
    expect(JSON.stringify(result)).not.toContain("sk_test");
    expect(JSON.stringify(result)).not.toContain("header-name-secret");
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

  it("redacts form and input values regardless of field type", () => {
    const text = redactInputValue("hello world", {
      name: "comment",
      type: "text",
    });
    const password = redactInputValue("secret", {
      name: "password",
      type: "password",
    });

    expect(text.value).toBe(REDACTED_VALUE);
    expect(text.summary).toMatchObject({ reason: "input_value" });
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
