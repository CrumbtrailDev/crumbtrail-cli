import { describe, expect, it } from "vitest";
import { redactUrl } from "../redaction";

/**
 * The preceder rule redacts whatever follows `auth`, `token`, `session` and
 * friends. That is right for a value and wrong for a route name: a live capture
 * reported every `/api/auth/*` request as `/api/auth/[REDACTED]`, so a session
 * could not say which endpoint returned a 401.
 */
describe("path segments after a sensitive preceder", () => {
  it("keeps a plain route word", () => {
    expect(redactUrl("http://localhost:7461/api/auth/whoami").value).toContain(
      "/api/auth/whoami",
    );
    expect(redactUrl("http://localhost:7461/api/auth/logout").value).toContain(
      "/api/auth/logout",
    );
    expect(redactUrl("http://localhost:7461/api/session/refresh").value).toContain(
      "/api/session/refresh",
    );
  });

  it("still redacts anything with entropy", () => {
    const cases = [
      "http://localhost:7461/api/auth/nst_9f3c1a2b7d4e",
      "http://localhost:7461/api/token/8f14e45fceea167a5a36dedd4bea2543",
      "http://localhost:7461/api/reset/aB3dEf9",
      "http://localhost:7461/api/auth/1234567890",
      "http://localhost:7461/api/session/3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    ];
    for (const url of cases) {
      expect(redactUrl(url).value).toMatch(/\[REDACTED\]|%5BREDACTED%5D/);
    }
  });

  it("redacts a long word that could be an encoded value", () => {
    expect(
      redactUrl("http://localhost:7461/api/auth/abcdefghijklmnopqrstuvwxyz").value,
    ).toMatch(/\[REDACTED\]|%5BREDACTED%5D/);
  });
});

// The carve-out is namespace-scoped: `/auth/whoami` is an endpoint, `/reset/abcd`
// is a short reset token that happens to look like one.
describe("credential preceders keep redacting plain words", () => {
  it("redacts a plain word after a credential preceder", () => {
    for (const url of [
      "http://localhost:7461/reset/abcd",
      "http://localhost:7461/api/token/plain",
      "http://localhost:7461/api/otp/hello",
      "http://localhost:7461/api/invite/friend",
    ]) {
      expect(redactUrl(url).value).toMatch(/\[REDACTED\]|%5BREDACTED%5D/);
    }
  });
});

// Guard against the rule degrading into a hand-maintained allowlist: the
// carve-out is stated as "not a credential preceder", so a preceder that is
// sensitive only via the name-based rules gets it without being enumerated.
describe("the carve-out is derived, not enumerated", () => {
  it("applies to name-based sensitive preceders nobody listed", () => {
    for (const url of [
      "https://a.test/api/authorization/status",
      "https://a.test/api/authentication/whoami",
      "https://a.test/api/credentials/rotate",
      "https://a.test/api/authtoken/refresh",
    ]) {
      expect(redactUrl(url).value).not.toMatch(/\[REDACTED\]|%5BREDACTED%5D/);
    }
  });

  it("still redacts values after those same preceders", () => {
    for (const url of [
      "https://a.test/api/authorization/eyJhbGciOiJIUzI1NiJ9",
      "https://a.test/api/authentication/8f14e45fceea167a5a36dedd4bea2543",
      "https://a.test/api/credentials/AbC123xyzAbC123xyz",
      "https://a.test/api/authtoken/nst_9f3c1a2b7d4e",
    ]) {
      expect(redactUrl(url).value).toMatch(/\[REDACTED\]|%5BREDACTED%5D/);
    }
  });
});
