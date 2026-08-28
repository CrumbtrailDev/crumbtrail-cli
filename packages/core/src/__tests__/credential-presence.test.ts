import { describe, expect, it } from "vitest";
import { redactHeaders } from "../redaction";

describe("credential presence", () => {
  it("records that an authorization header existed, and nothing about its value", () => {
    // Redaction removes the header and its value, which is right, and it also
    // removed the only evidence the header existed. Downstream a 401 the client
    // asked for and a 401 that means auth is broken became the same record.
    const result = redactHeaders({ authorization: "Bearer sk_live_abcdef123" });
    expect(result.credentials).toEqual({
      authorization: true,
      sessionCookie: false,
    });
    expect(JSON.stringify(result)).not.toContain("sk_live_abcdef123");
  });

  it("matches a session cookie by NAME and never reads its value", () => {
    const result = redactHeaders({
      cookie: "theme=dark; connect.sid=s%3AsecretValue123; locale=en",
    });
    expect(result.credentials?.sessionCookie).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secretValue123");
  });

  it("reports absence for a request that carried no credentials", () => {
    // This is the case the signal exists for: both false beside a 401 is the
    // signed-out handshake, not a defect.
    const result = redactHeaders({ accept: "application/json" });
    expect(result.credentials).toEqual({
      authorization: false,
      sessionCookie: false,
    });
  });

  it("does not call an ordinary cookie a session", () => {
    const result = redactHeaders({ cookie: "theme=dark; locale=en" });
    expect(result.credentials?.sessionCookie).toBe(false);
  });

  it("treats an empty header as absent rather than present", () => {
    expect(
      redactHeaders({ authorization: "  ", cookie: "" }).credentials,
    ).toEqual({ authorization: false, sessionCookie: false });
  });
});
