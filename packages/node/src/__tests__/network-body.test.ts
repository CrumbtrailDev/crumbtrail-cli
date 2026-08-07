import { describe, expect, it } from "vitest";
import { redactedNetworkBodySnippet } from "../network-body";

describe("redactedNetworkBodySnippet", () => {
  it("does not emit arbitrary legacy body-summary enum text", () => {
    const poisonedReason = "hunter2-secret-should-not-appear";
    const snippet = redactedNetworkBodySnippet(undefined, {
      kind: "legacy-kind",
      action: "legacy-action",
      reason: poisonedReason,
    });

    expect(snippet).toBe("body unavailable; (unknown); unknown; unknown");
    expect(snippet).not.toContain(poisonedReason);
  });
  // The value alternation stops at the first `}` or `]`, so firing on a container does not redact
  // it, it shreds it: a real capture rendered as `{[REDACTED_KEY]:[REDACTED]]","len":124,...`, an
  // object turned into noise that no reader could use. Containers belong to the structured policy.
  it("leaves an object value intact rather than corrupting it", () => {
    const snippet = redactedNetworkBodySnippet(
      JSON.stringify({ card: { balanceCents: 1250 }, usable: true }),
    );

    expect(snippet).toBe('{"card":{"balanceCents":1250},"usable":true}');
    expect(() => JSON.parse(snippet!)).not.toThrow();
  });

  it("still hides a scalar secret and its key name", () => {
    const snippet = redactedNetworkBodySnippet("cardNumber=4111111111111111");

    expect(snippet).toBe("[REDACTED_KEY]=[REDACTED]");
  });

  // Core has already replaced the value; the key name still has to go.
  it("hides a key whose value core already redacted", () => {
    const snippet = redactedNetworkBodySnippet("apiKey=[REDACTED]&amount=42");

    expect(snippet).toBe("[REDACTED_KEY]=[REDACTED]&amount=42");
  });

});
