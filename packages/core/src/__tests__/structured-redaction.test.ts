import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus } from "../event-bus";
import type { BugEvent, CrumbtrailConfig } from "../types";
import { DEFAULT_CONFIG } from "../types";
import { networkCollector } from "../collectors/network";
import {
  BROWSER_REDACTION_POLICY,
  BROWSER_REDACTION_POLICY_V2,
  classifyStructuredValue,
  computeRedactedShape,
  isValidRedactedShapeExample,
  redactedShapeDetailAllowed,
  redactedShapeExample,
  redactedShapeExampleAllowed,
  REDACTED_SHAPE_EXAMPLE_MAX_LENGTH,
  DIAGNOSTIC_FIELD_MAX_PATHS,
  DIAGNOSTIC_INDEX_MAX,
  redactDiagnosticFields,
  redactNetworkTextBody,
  resetStructuredShapeSaltForTests,
  redactUrl,
  setRedactionKeepFields,
  unescapeRedactionMarker,
} from "../redaction";

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";

describe("redactDiagnosticFields", () => {
  const pick = (
    value: unknown,
    diagnosticFields: readonly string[],
    options: { denyFields?: readonly string[] } = {},
  ) => redactDiagnosticFields(value, { diagnosticFields, ...options }).value;

  it("keeps only exact nested scalar paths and selected array entries", () => {
    expect(
      pick(
        {
          checkout: {
            status: "failed",
            message: "upstream failed",
            ignored: "not selected",
          },
          attempts: [
            { code: "E_TIMEOUT", label: "first" },
            { code: "E_OTHER", label: "second" },
          ],
        },
        ["checkout.status", "checkout.message", "attempts[0].code"],
      ),
    ).toEqual({
      checkout: { message: "upstream failed", status: "failed" },
      attempts: [{ code: "E_TIMEOUT" }],
    });
  });

  it("rejects wildcards, inherited properties, accessors, and prototype paths", () => {
    const value = Object.create({ inherited: "must not be read" }) as Record<
      string,
      unknown
    >;
    Object.defineProperty(value, "safe", {
      enumerable: true,
      value: "ok",
    });
    Object.defineProperty(value, "__proto__", {
      enumerable: true,
      value: { polluted: "must not survive" },
    });
    Object.assign(value, {
      bodyText: "must not survive",
      httpHeaders: { contentType: "must not survive" },
      localState: { value: "must not survive" },
      rawData: "must not survive",
      stackTrace: "must not survive",
    });
    let getterReads = 0;
    Object.defineProperty(value, "getter", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return "must not execute";
      },
    });

    const result = redactDiagnosticFields(value, {
      diagnosticFields: [
        "safe",
        "inherited",
        "getter",
        "safe.*",
        "__proto__.polluted",
        "constructor.prototype.polluted",
        "bodyText",
        "httpHeaders.contentType",
        "localState.value",
        "rawData",
        "stackTrace",
      ],
    });

    expect(result.value).toEqual({ safe: "ok" });
    expect(getterReads).toBe(0);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("stops safely at circular objects", () => {
    const value: Record<string, unknown> = { status: "ok" };
    value.self = value;

    const result = redactDiagnosticFields(value, {
      diagnosticFields: ["status", "self.status"],
    });

    expect(result.value).toEqual({ status: "ok" });
    expect(result.metadata?.fields).toContainEqual({
      path: "diagnosticFields.self",
      reason: "diagnostic_circular",
      action: "redacted",
    });
  });

  it("keeps explicit plain strings but sensitive names and value patterns still win", () => {
    const result = redactDiagnosticFields(
      {
        safe: "upstream failed",
        url: "https://example.test/callback?token=short-secret",
        email: "person@example.com",
        neutral: `Bearer ${JWT}`,
        cardish: "4111111111111111",
        password: "hunter2",
      },
      {
        diagnosticFields: [
          "safe",
          "url",
          "email",
          "neutral",
          "cardish",
          "password",
        ],
      },
    );

    expect(result.value).toMatchObject({ safe: "upstream failed" });
    expect(JSON.stringify(result.value)).not.toContain("short-secret");
    expect(result.metadata?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "diagnosticFields.neutral" }),
        expect.objectContaining({ path: "diagnosticFields.cardish" }),
      ]),
    );
  });

  it("redacts numeric verification fields without closing containers or operational codes", () => {
    const result = redactDiagnosticFields(
      {
        code: 1234,
        invite: "5678",
        magic: 901234,
        reset: "345678",
        verify: 789012,
        checkout: { code: 2468, state: "pending" },
        operation: { code: "E_TIMEOUT" },
        statusCode: 503,
        operationCode: 200,
      },
      {
        diagnosticFields: [
          "code",
          "invite",
          "magic",
          "reset",
          "verify",
          "checkout.code",
          "checkout.state",
          "operation.code",
          "statusCode",
          "operationCode",
        ],
      },
    );

    expect(result.value).toEqual({
      checkout: { state: "pending" },
      operation: { code: "E_TIMEOUT" },
      operationCode: 200,
      statusCode: 503,
    });
    expect(JSON.stringify(result.value)).not.toContain("1234");
    expect(JSON.stringify(result.value)).not.toContain("5678");
    expect(JSON.stringify(result.value)).not.toContain("901234");
    expect(JSON.stringify(result.value)).not.toContain("345678");
    expect(JSON.stringify(result.value)).not.toContain("789012");
    expect(JSON.stringify(result.value)).not.toContain("2468");
  });

  it("drops oversized and non-finite values, enforces the entry bound, and honors denyFields", () => {
    const value: Record<string, unknown> = {
      short: "support detail",
      oversized: "x".repeat(257),
      infinity: Number.POSITIVE_INFINITY,
      denied: "do not retain",
    };

    const result = redactDiagnosticFields(value, {
      diagnosticFields: ["short", "oversized", "infinity", "denied"],
      denyFields: ["denied"],
    });

    expect(result.value).toMatchObject({ short: "support detail" });
    expect(result.value).not.toHaveProperty("oversized");
    expect(result.value).not.toHaveProperty("infinity");
    expect(result.value).not.toHaveProperty("denied");

    const bounded = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [
        `field${String(index).padStart(2, "0")}`,
        index,
      ]),
    );
    const boundedResult = redactDiagnosticFields(bounded, {
      diagnosticFields: Object.keys(bounded),
    });
    expect(
      Object.keys(boundedResult.value as Record<string, unknown>),
    ).toHaveLength(16);
  });

  it("applies structured parent denies while preserving card and account containers", () => {
    const result = redactDiagnosticFields(
      {
        ibanDetails: { reference: "GB29NWBK60161331926819" },
        birthDetails: { date: "1984-01-01" },
        card: { balanceCents: 1250, number: "4111111111111111" },
        account: { status: "active", token: "must not retain" },
      },
      {
        diagnosticFields: [
          "ibanDetails.reference",
          "birthDetails.date",
          "card.balanceCents",
          "card.number",
          "account.status",
          "account.token",
        ],
      },
    );

    expect(result.value).toEqual({
      account: { status: "active" },
      card: { balanceCents: 1250 },
    });
    expect(JSON.stringify(result.value)).not.toContain(
      "GB29NWBK60161331926819",
    );
    expect(JSON.stringify(result.value)).not.toContain("4111111111111111");
    expect(JSON.stringify(result.value)).not.toContain("must not retain");
  });

  it("opens ordinary card and account containers but closes value containers", () => {
    const result = redactDiagnosticFields(
      {
        cardNumber: { label: "must not retain" },
        creditCardNumber: { label: "must not retain" },
        accountNumber: { status: "must not retain" },
        cardToken: { label: "must not retain" },
        giftCard: { label: "SAFE_GIFT_CARD", number: "4111111111111111" },
        customerAccount: { status: "SAFE_CUSTOMER_ACCOUNT", number: "1234" },
        accountingPeriod: { status: "SAFE_ACCOUNTING_PERIOD" },
        accountDetails: { status: "must not retain" },
        card: { label: "SAFE_CARD" },
        account: { status: "SAFE_ACCOUNT" },
      },
      {
        diagnosticFields: [
          "cardNumber.label",
          "creditCardNumber.label",
          "accountNumber.status",
          "cardToken.label",
          "giftCard.label",
          "giftCard.number",
          "customerAccount.status",
          "customerAccount.number",
          "accountingPeriod.status",
          "accountDetails.status",
          "card.label",
          "account.status",
        ],
      },
    );

    expect(result.value).toEqual({
      accountingPeriod: { status: "SAFE_ACCOUNTING_PERIOD" },
      account: { status: "SAFE_ACCOUNT" },
      card: { label: "SAFE_CARD" },
      customerAccount: { status: "SAFE_CUSTOMER_ACCOUNT" },
      giftCard: { label: "SAFE_GIFT_CARD" },
    });
    expect(JSON.stringify(result.value)).not.toContain("must not retain");
    expect(JSON.stringify(result.value)).not.toContain("4111111111111111");
    expect(JSON.stringify(result.value)).not.toContain('"number":"1234"');
  });

  it("closes sensitive card and account credential containers before traversal", () => {
    const result = redactDiagnosticFields(
      {
        cardSecurityCode: { label: "must not retain" },
        cardApiKey: { label: "must not retain" },
        cardPrivateKey: { label: "must not retain" },
        cardVerificationCode: { label: "must not retain" },
        accountSecurityCode: { label: "must not retain" },
        accountPassphrase: { label: "must not retain" },
      },
      {
        diagnosticFields: [
          "cardSecurityCode.label",
          "cardApiKey.label",
          "cardPrivateKey.label",
          "cardVerificationCode.label",
          "accountSecurityCode.label",
          "accountPassphrase.label",
        ],
      },
    );

    expect(result.value).toEqual({});
    expect(JSON.stringify(result.value)).not.toContain("must not retain");
    expect(result.metadata?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "deny_field" }),
      ]),
    );
  });

  it("ignores process-wide keepFields while redacting diagnostic URL queries", () => {
    setRedactionKeepFields(["q"]);
    try {
      const result = redactDiagnosticFields(
        { url: "https://example.test/search?q=widget&token=abc123def456" },
        { diagnosticFields: ["url"] },
      );

      expect(result.value).toEqual({});
      expect(JSON.stringify(result.value)).not.toContain("widget");
      expect(JSON.stringify(result.value)).not.toContain("abc123def456");
      expect(result.metadata?.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "diagnosticFields.url.query.q",
            reason: "url_query_value",
          }),
        ]),
      );
    } finally {
      setRedactionKeepFields([]);
    }
  });

  it("redacts unsafe whole and embedded URL schemes in diagnostic strings", () => {
    const secrets = [
      "ftp-pass",
      "opaque-secret",
      "ssh-pass",
      "custom-pass",
      "raw-data-secret",
      "js-secret",
      "private-secret",
    ];
    const result = redactDiagnosticFields(
      {
        ftp: "ftp://alice:ftp-pass@files.example/private",
        opaque: "ftp:opaque-secret/file",
        opaqueBare: "ftp:opaque-secret",
        ssh: "ssh://alice:ssh-pass@host.example/private",
        sshBare: "ssh:opaque-secret",
        custom: "custom://alice:custom-pass@host.example/private",
        data: "data:text/plain,raw-data-secret",
        javascript: 'javascript:alert("js-secret")',
        file: "file:///Users/alice/private-secret.txt",
        embedded: "see ssh://alice:ssh-pass@host.example/private now",
      },
      {
        diagnosticFields: [
          "ftp",
          "opaque",
          "opaqueBare",
          "ssh",
          "sshBare",
          "custom",
          "data",
          "javascript",
          "file",
          "embedded",
        ],
      },
    );

    const serialized = JSON.stringify(result.value);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(result.metadata?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "unsafe_url_scheme" }),
      ]),
    );
    for (const value of Object.values(result.value as Record<string, unknown>))
      expect(value).toMatch(/\[REDACTED\]/);
  });

  it("normalizes compatibility forms before checks and omits residual Unicode", () => {
    const toFullWidth = (value: string) =>
      value.replace(/[!-~]/g, (character) =>
        String.fromCharCode(character.charCodeAt(0) + 0xfee0),
      );
    const result = redactDiagnosticFields(
      {
        contact: toFullWidth("omar@example.com"),
        reference: toFullWidth("4111111111111111"),
        compatibilityStatus: toFullWidth("SAFE_OK"),
        unicodeStatus: "ошибка",
      },
      {
        diagnosticFields: [
          "contact",
          "reference",
          "compatibilityStatus",
          "unicodeStatus",
        ],
      },
    );

    expect(result.value).toEqual({ compatibilityStatus: "SAFE_OK" });
    expect(JSON.stringify(result.value)).not.toContain("omar@example.com");
    expect(JSON.stringify(result.value)).not.toContain("4111111111111111");
    expect(JSON.stringify(result.value)).not.toContain("ошибка");
  });

  it("normalizes compatibility keys for diagnostic classification", () => {
    const fullWidth = (value: string) =>
      value.replace(/[!-~]/g, (character) =>
        String.fromCharCode(character.charCodeAt(0) + 0xfee0),
      );
    const password = fullWidth("password");
    const status = fullWidth("status");
    const result = redactDiagnosticFields(
      { [password]: "must not retain", [status]: "SAFE_OK" },
      { diagnosticFields: [password, status] },
    );

    expect(result.value).toEqual({ [status]: "SAFE_OK" });
    expect(JSON.stringify(result.value)).not.toContain("must not retain");
  });

  it("folds Unicode confusables in sensitive diagnostic keys", () => {
    const password = "\u0440\u0430ssword";
    const cardNumber = "\u0441ardNumber";
    const accountNumber = "\u0430ccountNumber";
    const result = redactDiagnosticFields(
      {
        [password]: "hunter2",
        [cardNumber]: "1234567890123456",
        [accountNumber]: "1234",
        status: "SAFE_OK",
      },
      { diagnosticFields: [password, cardNumber, accountNumber, "status"] },
    );

    expect(result.value).toEqual({ status: "SAFE_OK" });
    expect(JSON.stringify(result.value)).not.toContain("hunter2");
    expect(JSON.stringify(result.value)).not.toContain("1234567890123456");
    expect(JSON.stringify(result.value)).not.toContain("1234");
  });

  it("redacts short numbers inside confusable card and account containers", () => {
    const result = redactDiagnosticFields(
      {
        сard: { brand: "visa", number: "4242", num: "5678" },
        аccount: { status: "active", number: "1234", num: "9012" },
      },
      {
        diagnosticFields: [
          "сard.brand",
          "сard.number",
          "сard.num",
          "аccount.status",
          "аccount.number",
          "аccount.num",
        ],
      },
    );

    expect(result.value).toEqual({
      сard: { brand: "visa" },
      аccount: { status: "active" },
    });
    expect(JSON.stringify(result.value)).not.toContain("4242");
    expect(JSON.stringify(result.value)).not.toContain("1234");
    expect(JSON.stringify(result.value)).not.toContain("5678");
    expect(JSON.stringify(result.value)).not.toContain("9012");
  });

  it("keeps ordinary colon labels instead of treating them as URI schemes", () => {
    const result = redactDiagnosticFields(
      {
        message: "Error: failed. Version:1.2.3. State:ready.",
        status: "Status: pending. Build:2.4.0.",
      },
      { diagnosticFields: ["message", "status"] },
    );

    expect(result.value).toEqual({
      message: "Error: failed. Version:1.2.3. State:ready.",
      status: "Status: pending. Build:2.4.0.",
    });
  });

  it("rejects unknown opaque schemes even when punctuation makes them sentence shaped", () => {
    const result = redactDiagnosticFields(
      {
        status: "custom:secret.",
        message: "failed at myapp:abc-def,",
        safe: "Status: pending.",
      },
      { diagnosticFields: ["status", "message", "safe"] },
    );

    expect(result.value).toEqual({
      message: "[REDACTED]",
      safe: "Status: pending.",
    });
    expect(JSON.stringify(result.value)).not.toContain("secret");
    expect(JSON.stringify(result.value)).not.toContain("abc-def");
    expect(result.metadata?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "unsafe_url_scheme" }),
      ]),
    );
  });

  it("rejects selected token shaped property names before traversal", () => {
    const tokenKey = "sk_live_4eC39HqLyjWDarjt";
    const result = redactDiagnosticFields(
      {
        [tokenKey]: "must not retain",
        safe: "SAFE_OK",
      },
      { diagnosticFields: [tokenKey, "safe"] },
    );

    expect(result.value).toEqual({ safe: "SAFE_OK" });
    expect(JSON.stringify(result.value)).not.toContain(tokenKey);
    expect(JSON.stringify(result.value)).not.toContain("must not retain");
  });

  it("redacts relative URL query secrets in diagnostic prose", () => {
    const secret = "abc123def456";
    const result = redactDiagnosticFields(
      {
        rootRelative: `failed at /callback?token=${secret}`,
        schemeRelative: `failed at //example.test/callback?token=${secret}`,
        currentRelative: `failed at ./callback?token=${secret}`,
        parentRelative: `failed at ../callback?token=${secret}`,
        ordinarySlashText: "literal /usr/local/bin and path/to/file",
        querylessSlashText: "literal /not/a?maybe",
      },
      {
        diagnosticFields: [
          "rootRelative",
          "schemeRelative",
          "currentRelative",
          "parentRelative",
          "ordinarySlashText",
          "querylessSlashText",
        ],
      },
    );

    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain(secret);
    expect(result.value).toMatchObject({
      ordinarySlashText: "literal /usr/local/bin and path/to/file",
      querylessSlashText: "literal /not/a?maybe",
    });
    for (const key of [
      "rootRelative",
      "schemeRelative",
      "currentRelative",
      "parentRelative",
    ]) {
      expect((result.value as Record<string, unknown>)[key]).toContain(
        "[REDACTED",
      );
    }
  });

  it("rejects Unicode URL components before URL serialization", () => {
    const secret = "abc123def456";
    const result = redactDiagnosticFields(
      {
        idn: `https://例え.テスト/callback?token=${secret}`,
        path: `https://example.test/こんにちは?token=${secret}`,
        encodedPath: `https://example.test/%E3%81%93%E3%82%93?token=${secret}`,
        normalizedPath: `https://example.test/ｐａｙｍｅｎｔ?token=${secret}`,
        ascii: "https://a.io/x",
      },
      {
        diagnosticFields: [
          "idn",
          "path",
          "encodedPath",
          "normalizedPath",
          "ascii",
        ],
      },
    );

    const values = result.value as Record<string, unknown>;
    expect(values).not.toHaveProperty("idn");
    expect(values).not.toHaveProperty("path");
    expect(values).not.toHaveProperty("encodedPath");
    expect(values).not.toHaveProperty("normalizedPath");
    expect(values.ascii).toBe("https://a.io/x");
    expect(JSON.stringify(result.value)).not.toContain(secret);
    expect(result.metadata?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "diagnostic_non_ascii_url_component",
          action: "dropped",
        }),
      ]),
    );
  });

  it("caps configured paths before parsing and bounds sparse array indexes", () => {
    let numericPathReads = 0;
    const paths = new Proxy(
      [
        ...Array.from(
          { length: DIAGNOSTIC_FIELD_MAX_PATHS },
          (_, index) => `z${String(index).padStart(2, "0")}`,
        ),
        "aLate",
      ],
      {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property))
            numericPathReads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const values = Object.fromEntries([
      ...Array.from({ length: DIAGNOSTIC_FIELD_MAX_PATHS }, (_, index) => [
        `z${String(index).padStart(2, "0")}`,
        index,
      ]),
      ["aLate", 999],
    ]);
    const bounded = redactDiagnosticFields(values, {
      diagnosticFields: paths,
    });

    expect(bounded.value).not.toHaveProperty("aLate");
    expect(numericPathReads).toBeLessThanOrEqual(DIAGNOSTIC_FIELD_MAX_PATHS);
    expect(Object.keys(bounded.value as Record<string, unknown>)).toHaveLength(
      16,
    );

    const attempts: unknown[] = [];
    attempts[DIAGNOSTIC_INDEX_MAX - 1] = { code: "E_LAST" };
    attempts[DIAGNOSTIC_INDEX_MAX] = { code: "must not retain" };
    const sparse = redactDiagnosticFields(
      { attempts },
      {
        diagnosticFields: [
          `attempts[${DIAGNOSTIC_INDEX_MAX - 1}].code`,
          `attempts[${DIAGNOSTIC_INDEX_MAX}].code`,
        ],
      },
    );

    const sparseAttempts = (sparse.value as { attempts: unknown[] }).attempts;
    expect(sparseAttempts[DIAGNOSTIC_INDEX_MAX - 1]).toEqual({
      code: "E_LAST",
    });
    expect(sparseAttempts.length).toBe(DIAGNOSTIC_INDEX_MAX);
    expect(Object.keys(sparseAttempts)).toEqual([
      String(DIAGNOSTIC_INDEX_MAX - 1),
    ]);
    expect(JSON.stringify(sparse.value)).not.toContain("must not retain");
  });

  it("contains revoked proxy failures without reading accessors or breaking sibling fields", () => {
    const revoked = Proxy.revocable({ status: "must not retain" }, {});
    revoked.revoke();

    expect(() =>
      redactDiagnosticFields(
        { good: "ok", revoked: revoked.proxy },
        { diagnosticFields: ["good", "revoked.status"] },
      ),
    ).not.toThrow();

    const result = redactDiagnosticFields(
      { good: "ok", revoked: revoked.proxy },
      { diagnosticFields: ["good", "revoked.status"] },
    );
    expect(result.value).toEqual({ good: "ok" });
    expect(result.metadata?.fields).toContainEqual({
      path: "diagnosticFields.revoked",
      reason: "diagnostic_unreadable_value",
      action: "dropped",
    });
  });
});

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

  // The entropy floor used to sit at 24 characters and the enum-keep took
  // anything up to 24, so nothing covered the 16-23 window: an AWS access key
  // id under a neutral name classified as "keep" and was stored in full.
  it.each([
    ["AKIAIOSFODNN7EXAMPLE", "accessKeyId"],
    ["ASIAY34FZKBOKMUTVV7A", "principalRef"],
    ["AIzaSyD3aBcDeFgHiJkLm", "mapsRef"],
    ["s3cr3tV4lue9xQzTop", "deviceHandle"],
    ["1a2b3c4d5e6f7g8h", "nodeRef"],
  ])("redacts the 16-23 character secret %s", (value, name) => {
    expect(classifyStructuredValue(value, name)).toMatchObject({
      action: "redact",
      reason: "high_entropy_value",
    });
  });

  // Over-redaction is its own bug: an application's own state names are the
  // most diagnostically useful strings in a body, and they live in the same
  // length band.
  it.each([
    "PAYMENT_DECLINED",
    "INTERNAL_ERROR_500",
    "subscription_active",
    "AWAITING_SHIPMENT",
    "order_status_new",
    "credit_card_type",
    "in_progress_stage",
    "en-US-california",
  ])("keeps the enum-shaped name %s", (value) => {
    expect(classifyStructuredValue(value, "status")).toEqual({
      action: "keep",
    });
  });

  /**
   * `{"msg":"Invalid login credentials"}` was stored as a shape placeholder, so
   * a session could report that a sign-in failed but never why.
   */
  describe("server messages under a message-shaped name", () => {
    it.each([
      ["msg", "Invalid login credentials"],
      ["message", "Invalid login credentials"],
      ["error", "Email or password is incorrect"],
      ["detail", "Not enough stock to fulfil this order"],
      ["reason", "The upstream service did not respond in time"],
      ["errorMessage", "Something went wrong, please try again"],
    ])("keeps %s", (name, value) => {
      expect(classifyStructuredValue(value, name)).toEqual({ action: "keep" });
    });

    it("keeps a small number inside the sentence", () => {
      expect(
        classifyStructuredValue("Request failed with status 400", "message"),
      ).toEqual({ action: "keep" });
    });

    it("still redacts personal data in the same position", () => {
      expect(
        classifyStructuredValue("No account for omar@example.com", "message"),
      ).toMatchObject({ action: "redact", reason: "email_value" });
      expect(
        classifyStructuredValue("Card 4242 4242 4242 4242 declined", "message"),
      ).toMatchObject({ action: "redact", reason: "luhn_value" });
      expect(
        classifyStructuredValue("Call us on 415 555 0134", "message"),
      ).toMatchObject({ action: "redact", reason: "free_text_value" });
      expect(
        classifyStructuredValue("Born 1984 in Lisbon", "message"),
      ).toMatchObject({ action: "redact", reason: "free_text_value" });
    });

    it("does not extend the carve-out past message-shaped names", () => {
      for (const name of ["customerName", "note", "comment", "bio", "street"]) {
        expect(
          classifyStructuredValue("Invalid login credentials", name),
        ).toMatchObject({ action: "redact", reason: "free_text_value" });
      }
      expect(
        classifyStructuredValue("Invalid login credentials"),
      ).toMatchObject({ action: "redact", reason: "free_text_value" });
    });

    it("redacts long free text even under a message name", () => {
      expect(
        classifyStructuredValue("word ".repeat(40).trim(), "message"),
      ).toMatchObject({ action: "redact", reason: "free_text_value" });
    });

    it("redacts a value that is not a plain sentence", () => {
      for (const value of [
        "user=omar; session=abc",
        "at Object.<anonymous> (/srv/app/index.js:12:5)",
        "https://api.test/callback?code=abc",
      ]) {
        expect(classifyStructuredValue(value, "message")).toMatchObject({
          action: "redact",
        });
      }
    });
  });

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

  it("keeps canonical operational timestamps but still denies sensitive date fields", () => {
    const timestamp = "2026-07-28T20:38:55.123Z";
    expect(classifyStructuredValue(timestamp, "created_at")).toEqual({
      action: "keep",
    });
    expect(classifyStructuredValue(timestamp, "birthdate")).toMatchObject({
      action: "redact",
      reason: "deny_field",
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

  it("reports a salted case-fold fingerprint without exposing the value", () => {
    const uppercase = computeRedactedShape("Omar@Example.com");
    const lowercase = computeRedactedShape("omar@example.com");

    expect(uppercase.hash8).not.toBe(lowercase.hash8);
    expect(uppercase.casefoldHash8).toBe(lowercase.hash8);
    expect(lowercase.casefoldHash8).toBeUndefined();
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

  it("reports numeric separator positions without carrying numeric content", () => {
    expect(computeRedactedShape("0,29")).toMatchObject({
      len: 4,
      charset: "mixed",
      separators: [{ index: 1, char: "," }],
    });
    expect(JSON.stringify(computeRedactedShape("0,29"))).not.toContain("029");
  });
});

/* ------------------------------------------------------------------ */
/* Richer shape fields                                                 */
/* ------------------------------------------------------------------ */

describe("computeRedactedShape structural fields", () => {
  // The richer shape is opt in by reason, so every case here states one.
  const shapeOf = (value: string) =>
    computeRedactedShape(value, "free_text_value");

  it("counts whitespace separated runs, only above one", () => {
    expect(shapeOf("the quick brown fox").words).toBe(4);
    // `words=1` is on the great majority of markers and adds nothing to `len`.
    expect(shapeOf("singleword").words).toBeUndefined();
  });

  it("counts lines only above one", () => {
    expect(shapeOf("one line only here").lines).toBeUndefined();
    expect(shapeOf("first line\nsecond line").lines).toBe(2);
    expect(shapeOf("a line\r\nb line\rc line").lines).toBe(3);
  });

  it("reports which end carried whitespace", () => {
    expect(shapeOf("no edges here").edges).toBeUndefined();
    expect(shapeOf("  leading space").edges).toBe("leading");
    expect(shapeOf("trailing space  ").edges).toBe("trailing");
    expect(shapeOf("  both ends  ").edges).toBe("both");
  });

  it("flags non-ASCII and emoji separately", () => {
    expect(shapeOf("plain ascii text").nonAscii).toBeUndefined();
    expect(shapeOf("plain ascii text").emoji).toBeUndefined();
    expect(shapeOf("café au lait").nonAscii).toBe(true);
    expect(shapeOf("café au lait").emoji).toBeUndefined();
    const emoji = shapeOf("thanks 🙂 lots");
    expect(emoji.emoji).toBe(true);
    expect(emoji.nonAscii).toBe(true);
  });

  it.each([
    ["2026-09-04T10:15:00Z", "datetime"],
    ["2026-09-04 10:15", "datetime"],
    ["2026-09-04", "date"],
    ["04/09/2026", "date"],
    ["10:15:30", "time"],
    ["9:05 pm", "time"],
    ["https://example.com/orders/42", "url"],
    ["3f2504e0-4f89-11d3-9a0c-0305e82c3301", "uuid"],
    ["1234.56", "decimal"],
    ["1,234,567.89", "grouped_number"],
  ])("reports the structural pattern of %s as %s", (value, pattern) => {
    expect(shapeOf(value).pattern).toBe(pattern);
  });

  it("names no sensitive class as a pattern", () => {
    for (const value of [
      "person@example.com",
      "+1 415 555 0132",
      "4242 4242 4242 4242",
      "GB29NWBK60161331926819",
      JWT,
    ]) {
      expect(shapeOf(value).pattern).not.toBe("email");
      expect(shapeOf(value).pattern).not.toBe("phone");
      expect(shapeOf(value).pattern).not.toBe("card");
      expect(shapeOf(value).pattern).not.toBe("iban");
      expect(shapeOf(value).pattern).not.toBe("token");
    }
  });

  it("keeps the short-value floor: no words, lines or example without hash8", () => {
    // Numeric under 12, and anything under 6, withhold the hash today.
    for (const value of ["123", "078051120", "5551234567", "ab1", "a b"]) {
      const shape = computeRedactedShape(value, "free_text_value");
      expect(shape.hash8).toBeUndefined();
      expect(shape.words).toBeUndefined();
      expect(shape.lines).toBeUndefined();
      expect(shape.example).toBeUndefined();
    }
    // The one-bit fields still describe a short value.
    expect(shapeOf(" a b ").edges).toBe("both");
  });
});

/* ------------------------------------------------------------------ */
/* Fake example                                                        */
/* ------------------------------------------------------------------ */

describe("redactedShapeExample", () => {
  it("maps each class of code point to its fixed stand-in", () => {
    expect(redactedShapeExample("Hello World 42!")).toBe("Xxxxx Xxxxx 00!");
    expect(redactedShapeExample("café")).toBe("xxxé");
    expect(redactedShapeExample("Москва")).toBe("дддддд");
    expect(redactedShapeExample("東京")).toBe("漢漢");
    expect(redactedShapeExample("αβγ")).toBe("ααα");
    expect(redactedShapeExample("nice 😍")).toBe("xxxx 🙂");
    // Whitespace and ASCII punctuation are kept verbatim; a control character
    // and a non-ASCII non-letter are not.
    expect(redactedShapeExample("a-b_c.d\te")).toBe("x-x_x.x\tx");
    expect(redactedShapeExample("5 €")).toBe("0 ¤");
  });

  it("carries no letter of the original value", () => {
    const secret = "my landlord rejected the deposit refund";
    const example = redactedShapeExample(secret);
    for (const word of secret.split(" ")) {
      expect(example).not.toContain(word);
    }
  });

  it("preserves code unit length so len stays comparable", () => {
    for (const value of [
      "Hello World",
      "café au lait",
      "東京の天気",
      "nice 😍😍",
      "5 € and — a dash",
    ]) {
      expect(redactedShapeExample(value).length).toBe(value.length);
    }
  });

  it("caps at 120 code units and marks the cut", () => {
    const long = "a".repeat(400);
    const example = redactedShapeExample(long);
    expect(example.endsWith("…")).toBe(true);
    expect(example.length - 1).toBe(REDACTED_SHAPE_EXAMPLE_MAX_LENGTH);
    // len still reports the true length.
    expect(computeRedactedShape(long, "free_text_value").len).toBe(400);
  });
});

describe("redactedShapeExampleAllowed", () => {
  const withHash = computeRedactedShape(
    "a long enough free text value",
    "free_text_value",
  );

  it("allows only the free prose reason", () => {
    expect(redactedShapeExampleAllowed("free_text_value", withHash)).toBe(true);
  });

  it.each([
    "email_value",
    "jwt_value",
    "luhn_value",
    "iban_value",
    "token_like_value",
    "high_entropy_value",
    "masked_input_type",
    "sensitive_input_value",
    "deny_field",
    "sensitive_container_number",
    "sensitive_short_numeric_field",
    "input_value",
    "url_query_value",
    "unknown_value",
  ])("withholds an example for %s", (reason) => {
    expect(redactedShapeExampleAllowed(reason, withHash)).toBe(false);
    expect(
      computeRedactedShape("a long free text value", reason).example,
    ).toBeUndefined();
  });

  it("withholds an example when hash8 is omitted", () => {
    expect(
      redactedShapeExampleAllowed(
        "free_text_value",
        computeRedactedShape("abc"),
      ),
    ).toBe(false);
  });
});

describe("isValidRedactedShapeExample", () => {
  const shapeOf = (value: string) =>
    computeRedactedShape(value, "free_text_value");

  it("accepts every example this module produces", () => {
    for (const value of [
      "the quick brown fox jumped",
      "café au lait, please",
      "Москва и другие",
      "thanks 🙂 so much",
      "a".repeat(400),
      "line one\nline two here",
    ]) {
      const shape = shapeOf(value);
      expect(shape.example).toBeDefined();
      expect(isValidRedactedShapeExample(shape.example, shape)).toBe(true);
    }
  });

  it("rejects a character outside the alphabet", () => {
    const shape = shapeOf("the quick brown fox");
    expect(isValidRedactedShapeExample("the quick brown fox", shape)).toBe(
      false,
    );
    expect(isValidRedactedShapeExample("Xxxгxxxx brown fox", shape)).toBe(
      false,
    );
  });

  it("rejects a length that disagrees with len", () => {
    const shape = shapeOf("the quick brown fox");
    expect(isValidRedactedShapeExample("xxx", shape)).toBe(false);
    expect(isValidRedactedShapeExample(shape.example + "x", shape)).toBe(false);
  });

  it("rejects an example that disagrees with charset", () => {
    const alpha = shapeOf("abcdefghij");
    expect(alpha.charset).toBe("alpha");
    expect(isValidRedactedShapeExample("Xxxxx-xxxx", alpha)).toBe(false);
    const num = shapeOf("123456789012");
    expect(num.charset).toBe("num");
    expect(isValidRedactedShapeExample("00000000000x", num)).toBe(false);
  });

  it("rejects an example that disagrees with nonAscii or emoji", () => {
    const ascii = shapeOf("the quick brown fox");
    expect(ascii.nonAscii).toBeUndefined();
    expect(isValidRedactedShapeExample("xxx éxxxx xxxxx xxx", ascii)).toBe(
      false,
    );
    const emoji = shapeOf("thanks 🙂 so much");
    expect(emoji.emoji).toBe(true);
    // Same length, no emoji stand-in: the flag says one was there.
    expect(isValidRedactedShapeExample("xxxxxx éé xx xxxx", emoji)).toBe(false);
  });

  it("rejects a non-string and an empty string", () => {
    const shape = shapeOf("the quick brown fox");
    expect(isValidRedactedShapeExample(undefined, shape)).toBe(false);
    expect(isValidRedactedShapeExample(42, shape)).toBe(false);
    expect(isValidRedactedShapeExample("", shape)).toBe(false);
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

  it("includes numeric separator positions in body placeholders", () => {
    const result = redactNetworkTextBody(
      JSON.stringify({ raw: "1.234,56" }),
      jsonOpts,
    );
    const parsed = JSON.parse(result.body!) as {
      raw: Record<string, unknown>;
    };

    expect(parsed.raw).toMatchObject({
      $redacted: "[REDACTED]",
      len: 8,
      charset: "mixed",
      separators: [
        { index: 1, char: "." },
        { index: 5, char: "," },
      ],
    });
    expect(result.body).not.toContain("1.234,56");
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

  it("opens ordinary card and account containers but closes value containers", () => {
    const result = redactNetworkTextBody(
      JSON.stringify({
        cardNumber: { label: "must not retain" },
        creditCardNumber: { label: "must not retain" },
        accountNumber: { status: "must not retain" },
        cardToken: { label: "must not retain" },
        cardSecurityCode: { label: "must not retain" },
        cardApiKey: { label: "must not retain" },
        cardPrivateKey: { label: "must not retain" },
        cardVerificationCode: { label: "must not retain" },
        accountSecurityCode: { label: "must not retain" },
        accountPassphrase: { label: "must not retain" },
        giftCard: { label: "SAFE_GIFT_CARD", number: "4111111111111111" },
        customerAccount: {
          status: "SAFE_CUSTOMER_ACCOUNT",
          number: "1234",
          num: "5678",
        },
        accountingPeriod: { status: "SAFE_ACCOUNTING_PERIOD" },
        accountDetails: { status: "must not retain" },
        card: { label: "SAFE_CARD" },
        account: { status: "SAFE_ACCOUNT" },
      }),
      jsonOpts,
    );
    const parsed = JSON.parse(result.body!) as Record<string, unknown>;

    for (const key of [
      "cardNumber",
      "creditCardNumber",
      "accountNumber",
      "cardToken",
      "cardSecurityCode",
      "cardApiKey",
      "cardPrivateKey",
      "cardVerificationCode",
      "accountSecurityCode",
      "accountPassphrase",
      "accountDetails",
    ]) {
      expect(parsed[key]).toMatchObject({ $redacted: "[REDACTED]" });
    }
    expect(parsed.accountDetails).toMatchObject({
      $redacted: "[REDACTED]",
    });
    expect(parsed.accountingPeriod).toEqual({
      status: "SAFE_ACCOUNTING_PERIOD",
    });
    expect(parsed.card).toEqual({ label: "SAFE_CARD" });
    expect(parsed.account).toEqual({ status: "SAFE_ACCOUNT" });
    expect(parsed.customerAccount).toMatchObject({
      status: "SAFE_CUSTOMER_ACCOUNT",
      number: { $redacted: "[REDACTED]" },
    });
    expect(
      (parsed.customerAccount as Record<string, unknown>).num,
    ).toMatchObject({
      $redacted: "[REDACTED]",
    });
    expect(parsed.giftCard).toMatchObject({
      label: "SAFE_GIFT_CARD",
      number: { $redacted: "[REDACTED]" },
    });
    expect(result.body).not.toContain("must not retain");
    expect(result.body).not.toContain("4111111111111111");
    expect(result.body).not.toContain('"number":"1234"');
  });

  it("normalizes compatibility keys without rewriting safe output keys", () => {
    const fullWidth = (value: string) =>
      value.replace(/[!-~]/g, (character) =>
        String.fromCharCode(character.charCodeAt(0) + 0xfee0),
      );
    const password = fullWidth("password");
    const status = fullWidth("status");
    const result = redactNetworkTextBody(
      JSON.stringify({
        [password]: "must not retain",
        [status]: "SAFE_OK",
      }),
      jsonOpts,
    );
    const parsed = JSON.parse(result.body!) as Record<string, unknown>;

    expect(Object.keys(parsed)).toEqual([password, status]);
    expect(parsed[password]).toMatchObject({ $redacted: "[REDACTED]" });
    expect(parsed[status]).toBe("SAFE_OK");
    expect(result.body).not.toContain("must not retain");
  });

  it("does not let structured output assignment mutate the prototype", () => {
    const result = redactNetworkTextBody(
      '{"__proto__":{"polluted":true},"safe":"SAFE_OK"}',
      jsonOpts,
    );
    const parsed = JSON.parse(result.body!) as Record<string, unknown>;

    expect(parsed).toHaveProperty("__proto__");
    expect((parsed.__proto__ as Record<string, unknown>).polluted).toBe(true);
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(parsed.safe).toBe("SAFE_OK");
  });

  it("redacts numeric verification fields in structured bodies without closing operational codes", () => {
    const result = redactNetworkTextBody(
      JSON.stringify({
        code: 1234,
        invite: "5678",
        checkout: { code: "2468", state: "pending" },
        operation: { code: "E_TIMEOUT" },
        statusCode: 503,
        operationCode: 200,
        ordinary: "1234",
      }),
      jsonOpts,
    );
    const parsed = JSON.parse(result.body!) as Record<string, unknown>;

    expect(parsed.code).toMatchObject({ $redacted: "[REDACTED]" });
    expect(parsed.invite).toMatchObject({ $redacted: "[REDACTED]" });
    expect(parsed.checkout).toMatchObject({
      code: { $redacted: "[REDACTED]" },
      state: "pending",
    });
    expect(parsed.operation).toEqual({ code: "E_TIMEOUT" });
    expect(parsed.statusCode).toBe(503);
    expect(parsed.operationCode).toBe(200);
    expect(parsed.ordinary).toBe("1234");
    expect(result.body).not.toContain('"code":1234');
    expect(result.body).not.toContain('"invite":"5678"');
    expect(result.body).not.toContain('"code":"2468"');
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

  // Redaction strength must not be a function of payload size. A size gate here
  // used to hand every body between 16 KB and the 50 KB capture limit to the v1
  // path, which has no Luhn check, no email-in-value check and no entropy check
  // — so the same payload redacted at 10 KB and leaked in the clear at 17 KB,
  // and the integrator had no way to see which one they were getting.
  it.each([
    ["under the old gate", 10_000],
    ["over the old gate", 17_000],
    ["near the capture limit", 45_000],
  ])("redacts identically %s", (_label, pad) => {
    const pan = "4111111111111111";
    const email = "alice@example.com";
    const body = JSON.stringify({
      pan,
      recipients: [email],
      filler: "x".repeat(pad),
    });
    const result = redactNetworkTextBody(body, {
      ...jsonOpts,
      maxLength: 51_200,
    });

    expect(result.body).toBeDefined();
    expect(result.body).not.toContain(pan);
    expect(result.body).not.toContain(email);
    expect(result.metadata?.policy).toBe(BROWSER_REDACTION_POLICY_V2);
  });

  it("still drops a body past maxLength rather than downgrading its policy", () => {
    const body = JSON.stringify({
      pan: "4111111111111111",
      pad: "x".repeat(60_000),
    });
    const result = redactNetworkTextBody(body, {
      ...jsonOpts,
      maxLength: 51_200,
    });

    expect(result.body).toBeUndefined();
    expect(result.bodySummary).toMatchObject({
      action: "summarized",
      reason: "payload_too_large",
    });
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
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
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

    const reqBody = JSON.parse(req.d.body as string) as Record<string, unknown>;
    expect(reqBody.couponCode).toBe("EXPIRED5");
    expect(reqBody.password).toMatchObject({ $redacted: "[REDACTED]" });
    expect(req.d.body).not.toContain("hunter2!");
    expect((req.d.redaction as { policy: string }).policy).toBe(
      BROWSER_REDACTION_POLICY_V2,
    );

    const resBody = JSON.parse(res.d.body as string) as Record<string, unknown>;
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

/* ------------------------------------------------------------------ */
/* Application-declared keep list                                      */
/* ------------------------------------------------------------------ */

describe("redaction.keepFields", () => {
  const KEEP = ["body", "q", "postalCode"];

  function structured(body: string, keepFields = KEEP) {
    const result = redactNetworkTextBody(body, {
      mode: "structured",
      contentType: "application/json",
      keepFields,
    });
    return JSON.parse(result.body as string) as Record<string, unknown>;
  }

  it("redacts free text under an undeclared name", () => {
    const parsed = structured(
      JSON.stringify({ body: "hello there world" }),
      [],
    );
    expect(parsed.body).toMatchObject({ $redacted: "[REDACTED]" });
  });

  it("keeps free text under a declared name", () => {
    const parsed = structured(
      JSON.stringify({ body: "<img src=x onerror=alert(1)>" }),
    );
    expect(parsed.body).toBe("<img src=x onerror=alert(1)>");
  });

  it("keeps a declared search term so the query that broke is readable", () => {
    const parsed = structured(JSON.stringify({ q: 'O\'Brien "widget"' }));
    expect(parsed.q).toBe('O\'Brien "widget"');
  });

  it("keeps URL names only while redacting URL credentials and query values", () => {
    setRedactionKeepFields(["q"]);
    try {
      const parsed = structured(
        JSON.stringify({
          url: "https://alice:password@example.test/search?q=widget&token=abc123def456",
          note: "see /callback?q=widget&token=abc123def456",
        }),
        ["url", "note"],
      );

      expect(parsed.url).toContain("https://example.test/search");
      expect(parsed.url).toContain("q=[REDACTED");
      expect(parsed.url).toContain("token=[REDACTED");
      expect(parsed.note).toContain("/callback");
      expect(parsed.note).toContain("q=[REDACTED");
      expect(parsed.note).toContain("token=[REDACTED");
      expect(JSON.stringify(parsed)).not.toContain("alice:password");
      expect(JSON.stringify(parsed)).not.toContain("abc123def456");
      expect(JSON.stringify(parsed)).not.toContain("widget");
    } finally {
      setRedactionKeepFields([]);
    }
  });

  it("matches the whole compacted name, never a substring", () => {
    const parsed = structured(JSON.stringify({ shadowBody: "free text here" }));
    expect(parsed.shadowBody).toMatchObject({ $redacted: "[REDACTED]" });
  });

  it("still redacts an email pasted into a kept field", () => {
    const parsed = structured(
      JSON.stringify({ body: "reach me at someone@example.com please" }),
    );
    expect(parsed.body).toMatchObject({ $redacted: "[REDACTED]" });
  });

  it("still redacts a JWT pasted into a kept field", () => {
    const parsed = structured(JSON.stringify({ body: JWT }));
    expect(parsed.body).toMatchObject({ $redacted: "[REDACTED]" });
  });

  it("still redacts a card number pasted into a kept field", () => {
    const parsed = structured(JSON.stringify({ body: "pay 4111111111111111" }));
    expect(parsed.body).toMatchObject({ $redacted: "[REDACTED]" });
  });

  it("lets a denyFields entry win over a keep for the same name", () => {
    const result = redactNetworkTextBody(
      JSON.stringify({ body: "free text" }),
      {
        mode: "structured",
        contentType: "application/json",
        keepFields: ["body"],
        denyFields: ["body"],
      },
    );
    const parsed = JSON.parse(result.body as string) as Record<string, unknown>;
    expect(parsed.body).toMatchObject({ $redacted: "[REDACTED]" });
  });

  it("carries the keep into array entries under the same name", () => {
    const parsed = structured(JSON.stringify({ body: ["free text one"] }));
    expect(parsed.body).toEqual(["free text one"]);
  });

  it("does not extend the keep to nested keys under a kept object", () => {
    const parsed = structured(
      JSON.stringify({ body: { note: "nested free text" } }),
    );
    expect((parsed.body as Record<string, unknown>).note).toMatchObject({
      $redacted: "[REDACTED]",
    });
  });

  it("leaves the default deny-biased behavior intact when unset", () => {
    const result = redactNetworkTextBody(
      JSON.stringify({ body: "free text here", qty: 2 }),
      { mode: "structured", contentType: "application/json" },
    );
    const parsed = JSON.parse(result.body as string) as Record<string, unknown>;
    expect(parsed.body).toMatchObject({ $redacted: "[REDACTED]" });
    expect(parsed.qty).toBe(2);
  });
});

describe("keepFields vs the built-in deny rules", () => {
  function structured(
    body: string,
    keepFields: string[],
    denyFields?: string[],
  ) {
    const result = redactNetworkTextBody(body, {
      mode: "structured",
      contentType: "application/json",
      keepFields,
      ...(denyFields ? { denyFields } : {}),
    });
    return JSON.parse(result.body as string) as Record<string, unknown>;
  }

  it("overrides a built-in substring false positive (auth in author)", () => {
    expect(
      structured(JSON.stringify({ author: "A. Shopper" }), []).author,
    ).toMatchObject({ $redacted: "[REDACTED]" });
    expect(
      structured(JSON.stringify({ author: "A. Shopper" }), ["author"]).author,
    ).toBe("A. Shopper");
  });

  it("does not override a built-in rule for a merely similar name", () => {
    const parsed = structured(JSON.stringify({ authorEmail: "x y z here" }), [
      "author",
    ]);
    expect(parsed.authorEmail).toMatchObject({ $redacted: "[REDACTED]" });
  });

  it("keeps the application's own denyFields winning over its own keep", () => {
    const parsed = structured(
      JSON.stringify({ author: "A. Shopper" }),
      ["author"],
      ["author"],
    );
    expect(parsed.author).toMatchObject({ $redacted: "[REDACTED]" });
  });

  it("still redacts by value inside a name the keep un-denied", () => {
    for (const value of [
      "someone@example.com",
      JWT,
      "4111111111111111",
      "aB3xQ9zL7pR2mN8kT4vY6wS1",
    ]) {
      const parsed = structured(JSON.stringify({ author: value }), ["author"]);
      expect(parsed.author).toMatchObject({ $redacted: "[REDACTED]" });
    }
  });

  it("redacts a password even when its own name is kept, if the value looks secret", () => {
    // The escape hatch un-denies the NAME. Anything the value-based checks
    // catch is still removed, which is what keeps the hatch safe to offer.
    const parsed = structured(
      JSON.stringify({ password: "aB3xQ9zL7pR2mN8kT4vY6wS1" }),
      ["password"],
    );
    expect(parsed.password).toMatchObject({ $redacted: "[REDACTED]" });
  });

  describe("exact object container names remain traversable", () => {
    it("keeps business fields nested under a card object", () => {
      const out = structured(
        JSON.stringify({ card: { balanceCents: 1250, initialCents: 5000 } }),
        [],
      );
      expect(out.card).toMatchObject({
        balanceCents: 1250,
        initialCents: 5000,
      });
    });

    it("still redacts a real card number nested under that same object", () => {
      const out = structured(
        JSON.stringify({
          card: { balanceCents: 1250, number: "4111111111111111" },
        }),
        [],
      );
      const card = out.card as Record<string, unknown>;
      expect(card.balanceCents).toBe(1250);
      expect(card.number).toMatchObject({ $redacted: "[REDACTED]" });
      expect(JSON.stringify(out)).not.toContain("4111111111111111");
    });

    it("redacts number fields without deleting ordinary card and account fields", () => {
      const out = structured(
        JSON.stringify({
          card: {
            brand: "visa",
            balanceCents: 1250,
            number: "1234567890123456",
          },
          account: {
            status: "active",
            id: 12345678,
            number: "1234",
          },
        }),
        [],
      );

      expect(out.card).toMatchObject({ brand: "visa", balanceCents: 1250 });
      expect(out.account).toMatchObject({ status: "active", id: 12345678 });
      expect((out.card as Record<string, unknown>).number).toMatchObject({
        $redacted: "[REDACTED]",
      });
      expect((out.account as Record<string, unknown>).number).toMatchObject({
        $redacted: "[REDACTED]",
      });
      expect(JSON.stringify(out)).not.toContain("1234567890123456");
      expect(JSON.stringify(out)).not.toContain('"number":"1234"');
    });

    it("still redacts a scalar whose own name matches", () => {
      const out = structured(
        JSON.stringify({ cardNumber: "4111111111111111" }),
        [],
      );
      expect(out.cardNumber).toMatchObject({ $redacted: "[REDACTED]" });
      expect(JSON.stringify(out)).not.toContain("4111111111111111");
    });

    // An array carries its own name down to each entry, so a list of card numbers is still a list
    // of denied scalars.
    it("still redacts entries of a denied array", () => {
      const out = structured(
        JSON.stringify({ cards: ["4111111111111111"] }),
        [],
      );
      expect(JSON.stringify(out)).not.toContain("4111111111111111");
    });

    // The application's own denyFields stays absolute: when the app says a subtree is sensitive,
    // no heuristic here outranks it.
    it("keeps an application deny absolute over the whole subtree", () => {
      const out = structured(
        JSON.stringify({ wallet: { balanceCents: 1250 } }),
        [],
        ["wallet"],
      );
      expect(out.wallet).toMatchObject({ $redacted: "[REDACTED]" });
      expect(JSON.stringify(out)).not.toContain("1250");
    });
  });
});

describe("query parameters answer to the same keep list", () => {
  afterEach(() => setRedactionKeepFields([]));

  it("distinguishes absent, empty, and present-but-redacted parameters", () => {
    setRedactionKeepFields([]);

    const absent = new URL(
      redactUrl("/api/search?page=1").value,
      "https://app.test",
    ).searchParams;
    const empty = new URL(redactUrl("/api/search?q=").value, "https://app.test")
      .searchParams;
    const redacted = new URL(
      redactUrl("/api/search?q=widget").value,
      "https://app.test",
    ).searchParams;

    expect(absent.has("q")).toBe(false);
    expect(empty.get("q")).toBe("");
    expect(redacted.get("q")).toBe("[REDACTED;len=6;charset=alpha]");
  });

  it("keeps numeric scale in a redacted query value", () => {
    setRedactionKeepFields([]);

    const value = new URL(
      redactUrl("/api/search?maxPrice=0%2C29").value,
      "https://app.test",
    ).searchParams.get("maxPrice");

    expect(value).toBe("[REDACTED;len=4;charset=mixed;separators=1.comma]");
    expect(value).not.toContain("0,29");
  });

  it("preserves multiple numeric separator positions in a query marker", () => {
    setRedactionKeepFields([]);
    const value = new URL(
      redactUrl("/api/search?amount=1.234%2C56").value,
      "https://app.test",
    ).searchParams.get("amount");

    expect(value).toBe(
      "[REDACTED;len=8;charset=mixed;separators=1.dot,5.comma]",
    );
    expect(
      redactUrl(`/api/search?amount=${encodeURIComponent(value!)}`).value,
    ).toContain("separators=1.dot,5.comma");
  });

  it("preserves query shape markers across a second redaction pass", () => {
    setRedactionKeepFields([]);
    const once = redactUrl("/api/search?q=0.29").value;
    expect(redactUrl(once).value).toBe(once);
  });

  it("redacts every undeclared word value by default", () => {
    setRedactionKeepFields([]);
    expect(redactUrl("/api/search?q=widget&productId=1").value).toBe(
      "/api/search?q=[REDACTED;len=6;charset=alpha]&productId=1",
    );
  });

  it("keeps short plain numbers so pagination survives an empty keep list", () => {
    setRedactionKeepFields([]);
    expect(redactUrl("/api/search?page=1&limit=20&offset=0").value).toBe(
      "/api/search?page=1&limit=20&offset=0",
    );
  });

  it("still redacts a number under a sensitive parameter name", () => {
    setRedactionKeepFields([]);
    expect(redactUrl("/api/search?token=1&page=1").value).toBe(
      "/api/search?token=[REDACTED;len=1;charset=num]&page=1",
    );
  });

  it("redacts short numeric values under credential and verification names", () => {
    setRedactionKeepFields([]);
    const result = redactUrl(
      "/checkout?code=1234&card=4242&account=1234&\u0441ard=5678&page=1",
    );

    const params = new URLSearchParams(result.value.split("?", 2)[1]);
    const redacted = "[REDACTED;len=4;charset=num]";
    expect(result.value).toContain("page=1");
    for (const key of ["code", "card", "account", "\u0441ard"])
      expect(params.get(key)).toBe(redacted);
    expect(result.value).not.toContain("code=1234");
    expect(result.value).not.toContain("card=4242");
    expect(result.value).not.toContain("account=1234");
    expect(result.value).not.toContain("\u0441ard=5678");
  });

  it("keeps a declared parameter so the query that broke is readable", () => {
    setRedactionKeepFields(["q", "productId"]);
    expect(redactUrl("/api/search?q=widget&productId=1").value).toBe(
      "/api/search?q=widget&productId=1",
    );
  });

  it("leaves an undeclared parameter redacted alongside a kept one", () => {
    setRedactionKeepFields(["q"]);
    const value = redactUrl("/api/search?q=widget&sessionKey=abc").value;
    expect(value).toContain("q=widget");
    expect(value).toContain("sessionKey=[REDACTED;len=3;charset=alpha]");
  });

  it("still redacts a sensitive value inside a kept parameter", () => {
    setRedactionKeepFields(["q"]);
    expect(redactUrl("/api/search?q=someone%40example.com").value).toBe(
      "/api/search?q=[REDACTED;len=19;charset=mixed]",
    );
  });

  it("keeps punctuation in a search term, which is the whole point", () => {
    setRedactionKeepFields(["q"]);
    const value = redactUrl(
      `/api/search?q=${encodeURIComponent(`O'Brien "x"`)}`,
    ).value;
    // Read it back the way a query string is actually parsed: toString()
    // form-encodes the space as `+`, which decodeURIComponent does not undo.
    const parsed = new URLSearchParams(value.split("?")[1]);
    expect(parsed.get("q")).toBe(`O'Brien "x"`);
  });
});

/* ------------------------------------------------------------------ */
/* Shape and example on the wire                                       */
/* ------------------------------------------------------------------ */

describe("placeholder shape and example end to end", () => {
  const structured = {
    contentType: "application/json",
    mode: "structured" as const,
  };
  const redactBody = (value: unknown) =>
    redactNetworkTextBody(JSON.stringify(value), structured);

  it("carries the shape and a stand-in for free prose", () => {
    const note = "the landlord rejected my deposit refund 🙂";
    const result = redactBody({ note });
    const parsed = JSON.parse(result.body!) as {
      note: Record<string, unknown>;
    };

    expect(parsed.note).toMatchObject({
      $redacted: "[REDACTED]",
      len: note.length,
      charset: "mixed",
      words: 7,
      nonAscii: true,
      emoji: true,
    });
    expect(parsed.note.example).toBe(
      "xxx xxxxxxxx xxxxxxxx xx xxxxxxx xxxxxx 🙂",
    );
    // The stand-in holds no word of the original.
    for (const word of note.split(" ").filter((w) => /[a-z]/.test(w))) {
      expect(result.body).not.toContain(word);
    }
  });

  it("withholds the stand-in for values caught by a sensitive reason", () => {
    const parsed = JSON.parse(
      redactBody({
        contact: "person@example.com",
        session: JWT,
        card: "4242 4242 4242 4242",
        iban: "GB29 NWBK 6016 1331 9268 19",
        password: "hunter2secret",
        secretNote: "a-".repeat(30),
      }).body!,
    ) as Record<string, Record<string, unknown>>;

    for (const key of Object.keys(parsed)) {
      expect(parsed[key].$redacted).toBe("[REDACTED]");
      expect(parsed[key].example).toBeUndefined();
    }
  });

  it("is idempotent across a second redaction pass", () => {
    const first = redactBody({
      note: "the landlord rejected my deposit refund 🙂",
      amount: "1.234,56",
      when: "2026-09-04T10:15:00Z was the date they replied",
    });
    const second = redactNetworkTextBody(first.body!, structured);

    expect(second.body).toBe(first.body);
  });

  it("drops a forged example and keeps the shape beside it", () => {
    const forged = {
      $redacted: "[REDACTED]",
      len: 19,
      charset: "mixed",
      hash8: "0123abcd",
      words: 4,
      example: "the quick brown fox",
    };
    const parsed = JSON.parse(
      redactNetworkTextBody(JSON.stringify({ note: forged }), structured).body!,
    ) as { note: Record<string, unknown> };

    expect(parsed.note.example).toBeUndefined();
    expect(parsed.note).toMatchObject({
      $redacted: "[REDACTED]",
      len: 19,
      charset: "mixed",
      hash8: "0123abcd",
      words: 4,
    });
    // Not re-wrapped: the shape still describes the original value.
    expect(parsed.note.$redacted).toBe("[REDACTED]");
  });

  it.each([
    // A stand-in whose length disagrees with len.
    { len: 19, example: "xxx" },
    // A stand-in claiming no emoji under an emoji flag.
    { len: 19, emoji: true, example: "xxx xxxxx xxxxx xxx" },
    // A stand-in carrying non-ASCII with no nonAscii flag.
    { len: 19, example: "xxx éxxxx xxxxx xxx" },
  ])("drops a stand-in that disagrees with the shape (%o)", (overrides) => {
    const parsed = JSON.parse(
      redactNetworkTextBody(
        JSON.stringify({
          note: {
            $redacted: "[REDACTED]",
            charset: "mixed",
            hash8: "0123abcd",
            ...overrides,
          },
        }),
        structured,
      ).body!,
    ) as { note: Record<string, unknown> };

    expect(parsed.note.example).toBeUndefined();
    expect(parsed.note.hash8).toBe("0123abcd");
  });

  it("never re-wraps a placeholder that carries separators", () => {
    const first = redactBody({ amount: "1.234,56" });
    const second = redactNetworkTextBody(first.body!, structured);
    const parsed = JSON.parse(second.body!) as {
      amount: Record<string, unknown>;
    };

    expect(parsed.amount.separators).toEqual([
      { index: 1, char: "." },
      { index: 5, char: "," },
    ]);
    expect(parsed.amount.len).toBe(8);
  });
});

describe("shape string form", () => {
  it("writes every field in grammar order", () => {
    setRedactionKeepFields([]);
    expect(
      redactUrl(
        `/s?q=${encodeURIComponent("  hello there\nsecond line 🙂 café  ")}`,
      ).value,
    ).toBe(
      "/s?q=[REDACTED;len=35;charset=mixed;words=6;lines=2;edges=both;nonAscii;emoji]",
    );
    expect(redactUrl("/s?d=2026-09-04").value).toBe(
      "/s?d=[REDACTED;len=10;charset=mixed;pattern=date]",
    );
  });

  it("round trips: a marker is recognised and left alone on a second pass", () => {
    setRedactionKeepFields([]);
    const once = redactUrl(
      `/s?q=${encodeURIComponent("  hello there\nsecond line 🙂 café  ")}&d=2026-09-04`,
    ).value;

    expect(redactUrl(once).value).toBe(once);
  });

  it("round trips through a percent-encoding serializer", () => {
    const marker =
      "[REDACTED;len=30;charset=mixed;words=5;edges=trailing;nonAscii;emoji;pattern=date]";
    const encoded = new URLSearchParams({ q: marker }).toString();

    expect(encoded).not.toContain(marker);
    expect(unescapeRedactionMarker(encoded)).toBe(`q=${marker}`);
  });
});

/* ------------------------------------------------------------------ */
/* The floor is the default: only a classifier prose reason widens it   */
/* ------------------------------------------------------------------ */

const FLOOR_KEYS = [
  "$redacted",
  "len",
  "charset",
  "separators",
  "hash8",
  "casefoldHash8",
];
const DETAIL_KEYS = [
  "words",
  "lines",
  "edges",
  "nonAscii",
  "emoji",
  "pattern",
  "example",
];

describe("richer shape is opt in by reason", () => {
  const structured = {
    contentType: "application/json",
    mode: "structured" as const,
  };
  // Prose that would light up every field if the reason allowed it: multiple
  // words, a trailing space, a non-ASCII letter, an emoji, and a date.
  const LOUD = "2026-09-04 rejected my café refund 🙂 ";

  const expectFloorOnly = (placeholder: Record<string, unknown>) => {
    for (const key of DETAIL_KEYS) expect(placeholder[key]).toBeUndefined();
    for (const key of Object.keys(placeholder))
      expect(FLOOR_KEYS).toContain(key);
    // The floor itself is still there.
    expect(placeholder.$redacted).toBe("[REDACTED]");
    expect(typeof placeholder.len).toBe("number");
    expect(placeholder.charset).toBe("mixed");
  };

  it("gives no reason at all the floor", () => {
    expect(redactedShapeDetailAllowed(undefined)).toBe(false);
    const shape = computeRedactedShape(LOUD);
    for (const key of DETAIL_KEYS)
      expect(shape[key as keyof typeof shape]).toBeUndefined();
    expect(shape.hash8).toMatch(/^[0-9a-f]{8}$/);
  });

  it.each([
    "input_value",
    "sensitive_input_value",
    "masked_input_type",
    "deny_field",
    "sensitive_container_number",
    "sensitive_short_numeric_field",
    "email_value",
    "jwt_value",
    "luhn_value",
    "iban_value",
    "token_like_value",
    "high_entropy_value",
    "unknown_value",
  ])("gives %s the floor and nothing more", (reason) => {
    expect(redactedShapeDetailAllowed(reason)).toBe(false);
    const shape = computeRedactedShape(LOUD, reason);
    for (const key of DETAIL_KEYS)
      expect(shape[key as keyof typeof shape]).toBeUndefined();
  });

  it("a password JSON key gets the floor", () => {
    const parsed = JSON.parse(
      redactNetworkTextBody(
        JSON.stringify({ password: LOUD, ssn: LOUD, dateOfBirth: LOUD }),
        structured,
      ).body!,
    ) as Record<string, Record<string, unknown>>;

    for (const key of Object.keys(parsed)) expectFloorOnly(parsed[key]);
    // The narrowing this rule exists to stop.
    expect(parsed.dateOfBirth.pattern).toBeUndefined();
  });

  it("a sensitive query name gets the floor", () => {
    setRedactionKeepFields([]);
    const value = redactUrl(
      `/api?token=${encodeURIComponent(LOUD)}&ssn=${encodeURIComponent(LOUD)}`,
    ).value;

    expect(value).toContain("token=[REDACTED;len=38;charset=mixed]");
    expect(value).toContain("ssn=[REDACTED;len=38;charset=mixed]");
    for (const marker of [
      ";words=",
      ";lines=",
      ";edges=",
      ";nonAscii",
      ";emoji",
      ";pattern=",
    ])
      expect(value).not.toContain(marker);
  });

  it("a query value under an ordinary name still gets the richer shape", () => {
    setRedactionKeepFields([]);
    const value = redactUrl(`/api?note=${encodeURIComponent(LOUD)}`).value;

    expect(value).toBe(
      "/api?note=[REDACTED;len=38;charset=mixed;words=6;edges=trailing;nonAscii;emoji]",
    );
  });

  it("free text in a body still gets every field", () => {
    const parsed = JSON.parse(
      redactNetworkTextBody(JSON.stringify({ note: LOUD }), structured).body!,
    ) as { note: Record<string, unknown> };

    expect(parsed.note).toMatchObject({
      words: 6,
      edges: "trailing",
      nonAscii: true,
      emoji: true,
    });
    expect(parsed.note.example).toBeDefined();
  });
});
