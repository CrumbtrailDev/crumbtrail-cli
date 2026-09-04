import { describe, expect, it } from "vitest";
import { REDACTED_VALUE, redactUrl } from "../redaction";

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

  // A captured 400 read `POST http://127.0.0.1:57421/auth/[REDACTED]/token`.
  // The hidden segment was the literal `v1`, so the issue title named no
  // endpoint at all.
  it("keeps an API version segment", () => {
    expect(redactUrl("http://127.0.0.1:57421/auth/v1/token").value).toBe(
      "http://127.0.0.1:57421/auth/v1/token",
    );
    for (const version of ["v1", "v2", "v10"]) {
      expect(redactUrl(`https://a.test/api/auth/${version}/user`).value).toBe(
        `https://a.test/api/auth/${version}/user`,
      );
    }
    expect(redactUrl("https://a.test/api/auth/oauth2/authorize").value).toBe(
      "https://a.test/api/auth/oauth2/authorize",
    );
  });

  // The version carve-out must not generalise into "a word with digits in it".
  it("still redacts a secret-shaped segment that merely mixes letters and digits", () => {
    for (const url of [
      "https://a.test/account/password/hunter2",
      "https://a.test/oauth/client_secret/abc123",
      "https://a.test/api/auth/v12345",
      "https://a.test/api/auth/a1b2c3d4e5f6a7b8",
      "https://a.test/api/session/3f2504e04f8911d3",
    ]) {
      expect(redactUrl(url).value).toContain(REDACTED_VALUE);
    }
  });
});

/**
 * The marker is written for people to read. Serializers escape its brackets, so
 * a stored URL used to read `…/auth/%5BREDACTED%5D/token` and every consumer
 * rendered that literally, down to "Node runtime warning: %5BREDACTED%5D …".
 */
describe("the redaction marker survives URL serialization unescaped", () => {
  it("writes the marker literally in a path segment", () => {
    const value = redactUrl(
      "https://api.test/reset/9f3c1a2b7d4e8a6b5c4d3e2f1a0b9c8d",
    ).value;
    expect(value).toContain(`/reset/${REDACTED_VALUE}`);
    expect(value).not.toContain("%5B");
  });

  it("writes the marker literally in a query value", () => {
    const value = redactUrl("https://api.test/search?q=widget&token=abc").value;
    expect(value).toContain("q=[REDACTED;len=6;charset=alpha]");
    expect(value).toContain("token=[REDACTED;len=3;charset=alpha]");
    expect(value).not.toContain("%5B");
  });

  it("writes the marker literally in a relative URL", () => {
    const value = redactUrl("/reset/9f3c1a2b7d4e8a6b5c4d3e2f1a0b9c8d?t=abc")
      .value;
    expect(value).toBe(
      `/reset/${REDACTED_VALUE}?t=[REDACTED;len=3;charset=alpha]`,
    );
  });

  it("writes the marker literally in a scheme-relative URL", () => {
    const value = redactUrl("//api.test/search?token=abc").value;
    expect(value).toBe(
      "//api.test/search?token=[REDACTED;len=3;charset=alpha]",
    );
  });

  it("leaves ordinary percent-encoding alone", () => {
    expect(redactUrl("https://api.test/search?q=a%20b&page=2").value).toContain(
      "page=2",
    );
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
