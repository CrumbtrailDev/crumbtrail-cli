import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus } from "../event-bus";
import type { BugEvent, CrumbtrailConfig } from "../types";
import { DEFAULT_CONFIG } from "../types";
import { networkCollector } from "../collectors/network";
import {
  BROWSER_REDACTION_POLICY,
  BROWSER_REDACTION_POLICY_V2,
  STRUCTURED_BODY_MAX_BYTES,
  classifyStructuredValue,
  computeRedactedShape,
  redactNetworkTextBody,
  resetStructuredShapeSaltForTests,
} from "../redaction";

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";

/* ------------------------------------------------------------------ */
/* Classifier table tests                                              */
/* ------------------------------------------------------------------ */

describe("classifyStructuredValue", () => {
  it.each([
    ["password", "hunter2"],
    ["cardNumber", "anything"],
    ["user_email", "x"],
    ["billingAddress", "1 Main St"],
    ["authToken", "abc"],
    ["ssn", "078-05-1120"],
    ["phoneNumber", "555"],
    ["cvv", "123"],
    ["clientSecret", "s"],
    ["pwd2", "hunter2"],
    ["pin2", "1234"],
    ["userPass", "x"],
    ["otpCode", "123456"],
    ["iban", "GB29NWBK60161331926819"],
    ["account", "12345678"],
    ["panDigits", "x"],
  ])("redacts deny-listed field name %s", (name, value) => {
    expect(classifyStructuredValue(value, name)).toMatchObject({
      action: "redact",
      reason: "deny_field",
    });
  });

  it.each(["shipping", "company", "ping", "spanish", "compass", "pingCount"])(
    "keeps field name %s (short deny tokens are word-matched, not substrings)",
    (name) => {
      expect(classifyStructuredValue("ok", name)).toEqual({ action: "keep" });
    },
  );

  it("redacts custom denyFields names", () => {
    expect(classifyStructuredValue("blue", "favColor", ["fav_color"])).toEqual({
      action: "redact",
      reason: "deny_field",
    });
    expect(classifyStructuredValue("blue", "favColor")).toEqual({
      action: "keep",
    });
  });

  it("redacts IBAN-shaped values under neutral names", () => {
    expect(classifyStructuredValue("GB29NWBK60161331926819", "ref")).toEqual({
      action: "redact",
      reason: "iban_value",
    });
    // Display form: grouped in blocks of four (whitespace-stripped first).
    expect(
      classifyStructuredValue("GB29 NWBK 6016 1331 9268 19", "ref"),
    ).toEqual({ action: "redact", reason: "iban_value" });
  });

  it("keeps bare 9-11 digit strings under neutral names (accepted residual)", () => {
    expect(classifyStructuredValue("123456789", "orderNumber")).toEqual({
      action: "keep",
    });
    expect(classifyStructuredValue("12345678901", "taxRef")).toEqual({
      action: "keep",
    });
  });

  it.each([[42], [0], [3.14], [true], [false], [null]])(
    "keeps scalar %s",
    (value) => {
      expect(classifyStructuredValue(value)).toEqual({ action: "keep" });
    },
  );

  it.each([["EXPIRED5"], ["SAVE10"], ["ok"], ["shipped"], ["item-2_b"]])(
    "keeps short enum-like string %s",
    (value) => {
      expect(classifyStructuredValue(value)).toEqual({ action: "keep" });
    },
  );

  it("redacts email-shaped values", () => {
    expect(classifyStructuredValue("omar@example.com")).toMatchObject({
      action: "redact",
      reason: "email_value",
    });
  });

  it("redacts Luhn-passing digit runs (incl. spaced/dashed)", () => {
    expect(classifyStructuredValue("4242424242424242")).toMatchObject({
      action: "redact",
      reason: "luhn_value",
    });
    expect(classifyStructuredValue("4242 4242 4242 4242")).toMatchObject({
      action: "redact",
      reason: "luhn_value",
    });
  });

  it("keeps a 16-digit run failing Luhn only if enum-like", () => {
    // 13+ digit non-Luhn run: not a card, but >24 rule does not apply; it is
    // enum-like (num, ≤24) so it survives.
    expect(classifyStructuredValue("1234567890123")).toEqual({
      action: "keep",
    });
  });

  it("redacts Luhn-passing 13-19 digit JSON numbers", () => {
    expect(classifyStructuredValue(4111111111111111)).toMatchObject({
      action: "redact",
      reason: "luhn_value",
    });
    expect(classifyStructuredValue(4242424242424242)).toMatchObject({
      action: "redact",
      reason: "luhn_value",
    });
  });

  it("redacts unsafe-integer 13-20 digit numbers even when rounding breaks Luhn", () => {
    // A 19-digit PAN exceeds Number.MAX_SAFE_INTEGER; JSON.parse rounds it,
    // so the rendered digits usually fail Luhn — but the leading ~16 digits
    // are still real card digits and must be redacted.
    // eslint-disable-next-line no-loss-of-precision -- imprecision is the point: JSON.parse rounds 19-digit PANs past Luhn validity
    expect(classifyStructuredValue(6212345678901265399)).toMatchObject({
      action: "redact",
      reason: "luhn_value",
    });
  });

  it("keeps ordinary numbers verbatim", () => {
    expect(classifyStructuredValue(199.0)).toEqual({ action: "keep" });
    expect(classifyStructuredValue(42)).toEqual({ action: "keep" });
    expect(classifyStructuredValue(1753142400000)).toEqual({ action: "keep" });
    expect(classifyStructuredValue(-4111111111111111)).toEqual({
      action: "keep",
    });
  });

  it("redacts JWT-shaped values", () => {
    expect(classifyStructuredValue(JWT)).toMatchObject({
      action: "redact",
      reason: "jwt_value",
    });
  });

  it("redacts high-entropy strings ≥ 24 chars", () => {
    expect(classifyStructuredValue("q9X2mZ7pLk04TvB8wYd1RsE6")).toMatchObject({
      action: "redact",
    });
  });

  it("redacts long free text (unknown class)", () => {
    expect(
      classifyStructuredValue("please ship this to my house after 5pm"),
    ).toMatchObject({ action: "redact", reason: "free_text_value" });
  });
});

describe("computeRedactedShape", () => {
  it("reports len, charset, and a session-stable salted hash8", () => {
    const shape = computeRedactedShape("hunter22");
    expect(shape).toMatchObject({ len: 8, charset: "alnum" });
    expect(shape.hash8).toMatch(/^[0-9a-f]{8}$/);
    // Equality tests work within a session.
    expect(computeRedactedShape("hunter22").hash8).toBe(shape.hash8);
    expect(computeRedactedShape("hunter23").hash8).not.toBe(shape.hash8);
  });

  it("omits hash8 for brute-forceable candidate spaces", () => {
    // Numeric with len < 12: CVV, PIN, SSN, phone.
    expect(computeRedactedShape("123").hash8).toBeUndefined();
    expect(computeRedactedShape("078051120").hash8).toBeUndefined();
    expect(computeRedactedShape("5551234567").hash8).toBeUndefined();
    // Any value with len < 6.
    expect(computeRedactedShape("ab1").hash8).toBeUndefined();
    // Long-enough values still get a hash.
    expect(computeRedactedShape("123456789012").hash8).toMatch(/^[0-9a-f]{8}$/);
    expect(computeRedactedShape("hunter").hash8).toMatch(/^[0-9a-f]{8}$/);
  });

  it("uses a per-session salt: fresh salt yields a different hash8", () => {
    const before = computeRedactedShape("hunter22").hash8;
    resetStructuredShapeSaltForTests();
    const after = computeRedactedShape("hunter22").hash8;
    expect(after).toMatch(/^[0-9a-f]{8}$/);
    expect(after).not.toBe(before);
  });

  it.each([
    ["abcDEF", "alpha"],
    ["123456", "num"],
    ["abc123", "alnum"],
    ["a b-c!", "mixed"],
  ])("classifies charset of %s as %s", (value, charset) => {
    expect(computeRedactedShape(value).charset).toBe(charset);
  });
});

/* ------------------------------------------------------------------ */
/* redactNetworkTextBody — structured mode                             */
/* ------------------------------------------------------------------ */

const jsonOpts = {
  contentType: "application/json",
  mode: "structured" as const,
};

describe("redactNetworkTextBody structured mode", () => {
  it("keeps enum-like values, redacts secrets with shape, tags v2", () => {
    const body = JSON.stringify({
      couponCode: "EXPIRED5",
      qty: 2,
      ok: true,
      note: null,
      password: "hunter2secret",
      card: "4242424242424242",
      session: JWT,
    });
    const result = redactNetworkTextBody(body, jsonOpts);
    const parsed = JSON.parse(result.body!) as Record<string, unknown>;

    expect(parsed.couponCode).toBe("EXPIRED5");
    expect(parsed.qty).toBe(2);
    expect(parsed.ok).toBe(true);
    expect(parsed.note).toBeNull();
    expect(parsed.password).toMatchObject({
      $redacted: "[REDACTED]",
      len: 13,
      charset: "alnum",
    });
    expect(parsed.card).toMatchObject({ $redacted: "[REDACTED]" });
    expect(parsed.session).toMatchObject({ $redacted: "[REDACTED]" });
    expect(result.metadata?.policy).toBe(BROWSER_REDACTION_POLICY_V2);
    expect(result.bodySummary).toMatchObject({
      kind: "json",
      reason: "structured_redaction",
    });
    // Non-recoverable: the raw secrets never appear in the output.
    expect(result.body).not.toContain("hunter2secret");
    expect(result.body).not.toContain("4242424242424242");
  });

  it("preserves structure through nested objects and arrays", () => {
    const body = JSON.stringify({
      items: [
        { sku: "SKU-1", qty: 1, giftMessage: "happy birthday to my friend!" },
        { sku: "SKU-2", qty: 3 },
      ],
    });
    const result = redactNetworkTextBody(body, jsonOpts);
    const parsed = JSON.parse(result.body!) as {
      items: Array<Record<string, unknown>>;
    };
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].sku).toBe("SKU-1");
    expect(parsed.items[0].qty).toBe(1);
    expect(parsed.items[0].giftMessage).toMatchObject({
      $redacted: "[REDACTED]",
    });
    expect(parsed.items[1].qty).toBe(3);
  });

  it("redacts the whole subtree under a deny-listed field name", () => {
    const body = JSON.stringify({ auth: { user: "u", pass: "p" }, qty: 1 });
    const result = redactNetworkTextBody(body, jsonOpts);
    const parsed = JSON.parse(result.body!) as Record<string, unknown>;
    expect(parsed.auth).toMatchObject({ $redacted: "[REDACTED]" });
    expect(parsed.qty).toBe(1);
  });

  it("redacts Luhn-passing numeric card values but keeps ordinary numbers", () => {
    const body = JSON.stringify({
      pan: 4111111111111111,
      price: 199.0,
      qty: 42,
      ts: 1753142400000,
    });
    const result = redactNetworkTextBody(body, jsonOpts);
    const parsed = JSON.parse(result.body!) as Record<string, unknown>;
    expect(parsed.pan).toMatchObject({ $redacted: "[REDACTED]" });
    expect(result.body).not.toContain("4111111111111111");
    expect(parsed.price).toBe(199.0);
    expect(parsed.qty).toBe(42);
    expect(parsed.ts).toBe(1753142400000);
  });

  it("redacts a 19-digit raw JSON number PAN despite parse rounding", () => {
    // Written as a literal JSON string (not via JS stringification) so the
    // JSON.parse rounding path is exercised: the parsed number is rounded,
    // fails Luhn as rendered, but still carries the real leading digits.
    const body = '{"pan":6212345678901265399,"qty":2}';
    const result = redactNetworkTextBody(body, jsonOpts);
    const parsed = JSON.parse(result.body!) as Record<string, unknown>;
    expect(parsed.pan).toMatchObject({ $redacted: "[REDACTED]" });
    expect(parsed.qty).toBe(2);
    expect(result.body).not.toContain("62123456789012");
  });

  it("matches denyFields as substrings of the compacted field name", () => {
    const body = JSON.stringify({ couponCode: "EXPIRED5", qty: 1 });
    const result = redactNetworkTextBody(body, {
      ...jsonOpts,
      denyFields: ["coupon"],
    });
    const parsed = JSON.parse(result.body!) as Record<string, unknown>;
    expect(parsed.couponCode).toMatchObject({ $redacted: "[REDACTED]" });
    expect(parsed.qty).toBe(1);
  });

  it("extends the deny list with denyFields", () => {
    const body = JSON.stringify({ favColor: "blue" });
    const kept = redactNetworkTextBody(body, jsonOpts);
    expect(JSON.parse(kept.body!).favColor).toBe("blue");
    const denied = redactNetworkTextBody(body, {
      ...jsonOpts,
      denyFields: ["favColor"],
    });
    expect(JSON.parse(denied.body!).favColor).toMatchObject({
      $redacted: "[REDACTED]",
    });
  });

  it("falls back to v1 behavior for malformed JSON without throwing", () => {
    const result = redactNetworkTextBody('{"password":"secret", "ok": tru', {
      ...jsonOpts,
    });
    expect(result.body).toBeUndefined();
    expect(result.bodySummary).toMatchObject({
      kind: "json",
      action: "dropped",
      reason: "malformed_json_body",
    });
    expect(result.metadata?.policy).toBe(BROWSER_REDACTION_POLICY);
  });

  it("falls back to v1 behavior for oversize JSON bodies", () => {
    const body = JSON.stringify({
      pad: "x".repeat(STRUCTURED_BODY_MAX_BYTES),
      password: "secret",
    });
    const result = redactNetworkTextBody(body, {
      ...jsonOpts,
      maxLength: STRUCTURED_BODY_MAX_BYTES * 4,
    });
    // v1 JSON path: sensitive key masked as a plain string, no shape objects.
    const parsed = JSON.parse(result.body!) as Record<string, unknown>;
    expect(parsed.password).toBe("[REDACTED]");
    expect(result.metadata?.policy).toBe(BROWSER_REDACTION_POLICY);
  });

  it('mode "full" restores v1 output exactly', () => {
    const body = JSON.stringify({
      couponCode: "EXPIRED5",
      password: "secret",
    });
    const v1 = redactNetworkTextBody(body, {
      contentType: "application/json",
    });
    const full = redactNetworkTextBody(body, {
      contentType: "application/json",
      mode: "full",
    });
    expect(full).toEqual(v1);
    expect(full.metadata?.policy).toBe(BROWSER_REDACTION_POLICY);
  });

  it("leaves non-JSON text bodies on the v1 path", () => {
    const result = redactNetworkTextBody("plain text body", {
      contentType: "text/plain",
      mode: "structured",
    });
    expect(result.body).toBe("plain text body");
    expect(result.metadata).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Network collector integration                                       */
/* ------------------------------------------------------------------ */

function makeConfig(
  overrides: Partial<CrumbtrailConfig> = {},
): CrumbtrailConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function collect(config?: Partial<CrumbtrailConfig>) {
  const events: BugEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((batch) => events.push(...batch));
  const cleanup = networkCollector(bus, makeConfig(config), {
    sessionId: "sess_structured_test",
  });
  return { events, bus, cleanup };
}

describe("networkCollector structured redaction", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("applies structured redaction to JSON request and response bodies by default", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ discount: 0, couponCode: "EXPIRED5", token: "abc" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const { events, bus, cleanup } = collect();

    await globalThis.fetch("https://api.example.com/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ couponCode: "EXPIRED5", password: "hunter2!" }),
    });
    bus.flush();

    const req = events.find((e) => e.k === "net.req")!;
    const res = events.find((e) => e.k === "net.res")!;

    const reqBody = JSON.parse(req.d.body as string) as Record<
      string,
      unknown
    >;
    expect(reqBody.couponCode).toBe("EXPIRED5");
    expect(reqBody.password).toMatchObject({ $redacted: "[REDACTED]" });
    expect(req.d.body).not.toContain("hunter2!");
    expect((req.d.redaction as { policy: string }).policy).toBe(
      BROWSER_REDACTION_POLICY_V2,
    );

    const resBody = JSON.parse(res.d.body as string) as Record<
      string,
      unknown
    >;
    expect(resBody.discount).toBe(0);
    expect(resBody.couponCode).toBe("EXPIRED5");
    expect(resBody.token).toMatchObject({ $redacted: "[REDACTED]" });
    expect((res.d.redaction as { policy: string }).policy).toBe(
      BROWSER_REDACTION_POLICY_V2,
    );

    cleanup();
  });

  it('config redaction.mode "full" restores v1 network behavior', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ couponCode: "EXPIRED5" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { events, bus, cleanup } = collect({ redaction: { mode: "full" } });

    await globalThis.fetch("https://api.example.com/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "hunter2!" }),
    });
    bus.flush();

    const req = events.find((e) => e.k === "net.req")!;
    const res = events.find((e) => e.k === "net.res")!;
    expect(JSON.parse(req.d.body as string).password).toBe("[REDACTED]");
    expect((req.d.redaction as { policy: string }).policy).toBe(
      BROWSER_REDACTION_POLICY,
    );
    // v1 leaves a fully-clean body untouched with no redaction metadata.
    expect(res.d.body).toBe(JSON.stringify({ couponCode: "EXPIRED5" }));
    expect(res.d.redaction).toBeUndefined();

    cleanup();
  });

  it("config redaction.denyFields extends the deny list end to end", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 204 }));
    const { events, bus, cleanup } = collect({
      redaction: { denyFields: ["favColor"] },
    });

    await globalThis.fetch("https://api.example.com/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favColor: "blue" }),
    });
    bus.flush();

    const req = events.find((e) => e.k === "net.req")!;
    expect(JSON.parse(req.d.body as string).favColor).toMatchObject({
      $redacted: "[REDACTED]",
    });

    cleanup();
  });

  it("malformed JSON responses fall back to v1 without throwing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"password":"secret", "ok": tru', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { events, bus, cleanup } = collect();

    await expect(
      globalThis.fetch("https://api.example.com/bad-json"),
    ).resolves.toBeDefined();
    bus.flush();

    const res = events.find((e) => e.k === "net.res")!;
    expect(res.d.body).toBeUndefined();
    expect(res.d.bodySummary).toMatchObject({
      kind: "json",
      action: "dropped",
      reason: "malformed_json_body",
    });
    expect((res.d.redaction as { policy: string }).policy).toBe(
      BROWSER_REDACTION_POLICY,
    );

    cleanup();
  });
});
