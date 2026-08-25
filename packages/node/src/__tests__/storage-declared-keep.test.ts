import { describe, it, expect, afterEach } from "vitest";
import { BROWSER_REDACTION_POLICY_V2 } from "crumbtrail-core";
import {
  sanitizeEventForStorage,
  setStorageKeepFields,
} from "../storage-plane";

/**
 * A body is redacted twice: once by the SDK that captured it, once by this
 * server at rest. The second pass is deliberate — a client that lies about its
 * policy must not be able to store secrets — but it used to run with an empty
 * keep list, so it undid every name the application had declared keepable and
 * re-wrapped values the first pass had already placeholdered.
 */

const v2 = (body: unknown, keep?: string[]) => ({
  t: 1,
  k: "net.res",
  d: {
    requestId: "req-1",
    status: 500,
    body: JSON.stringify(body),
    redaction: {
      policy: BROWSER_REDACTION_POLICY_V2,
      fields: [],
      ...(keep ? { keep } : {}),
    },
  },
});

const storedBody = (event: unknown) =>
  JSON.parse(
    String(
      (sanitizeEventForStorage(event as never) as unknown as {
        d: { body: string };
      }).d.body,
    ),
  ) as Record<string, unknown>;

afterEach(() => setStorageKeepFields([]));

describe("declared keep fields at rest", () => {
  it("keeps a name the application declared", () => {
    const body = storedBody(
      v2({ error: "42P01: relation _result_2 does not exist" }, ["error"]),
    );
    expect(body.error).toBe("42P01: relation _result_2 does not exist");
  });

  it("still redacts that name without the declaration", () => {
    const body = storedBody(
      v2({ error: "42P01: relation _result_2 does not exist" }),
    );
    expect(body.error).not.toBe("42P01: relation _result_2 does not exist");
  });

  it("honors the union of operator list and declaration", () => {
    setStorageKeepFields(["message"]);
    const body = storedBody(
      v2({ error: "handler threw", message: "row not found" }, ["error"]),
    );
    expect(body.error).toBe("handler threw");
    expect(body.message).toBe("row not found");
  });

  /**
   * The declaration exempts a name, never a value. Assembled rather than
   * written literally so the fixture is not itself a credential-shaped string
   * sitting in the repository.
   */
  it("does not let a declared keep smuggle a secret", () => {
    const highEntropy = ["Xk93", "Qm7Lp", "2vZa", "R8dT", "eN4bWq", "1cYh"].join(
      "",
    );
    const body = storedBody(
      v2(
        {
          error: "user@example.com",
          note: "4111111111111111",
          token: highEntropy,
        },
        ["error", "note", "token"],
      ),
    );
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("user@example.com");
    expect(serialized).not.toContain("4111111111111111");
    expect(serialized).not.toContain(highEntropy);
  });

  it("ignores a malformed or oversized declaration", () => {
    const body = storedBody(
      // Not a plain sentence: a value that only a valid declaration could keep,
      // so the assertion tests the declaration rather than the free-text rules.
      v2({ error: "42P01: relation _result_2 does not exist" }, [
        "x".repeat(200),
        "not a field\n",
        ...Array.from({ length: 80 }, (_, i) => `pad${i}`),
      ]),
    );
    expect(body.error).not.toBe("42P01: relation _result_2 does not exist");
  });

  it("does not re-wrap a value an earlier pass already placeholdered", () => {
    const placeholder = {
      $redacted: "[REDACTED]",
      len: 24,
      charset: "mixed",
      hash8: "c77968e8",
    };
    const body = storedBody(v2({ secret: placeholder }));
    // The shape facts still describe the ORIGINAL value, not the placeholder.
    expect(body.secret).toEqual(placeholder);
  });

  it("still redacts an object that only looks like a placeholder", () => {
    const body = storedBody(
      v2({ secret: { $redacted: "[REDACTED]", len: "not-a-number" } }),
    );
    expect(body.secret).not.toEqual({
      $redacted: "[REDACTED]",
      len: "not-a-number",
    });
  });

  it("still redacts a placeholder carrying an extra key", () => {
    const body = storedBody(
      v2({
        secret: {
          $redacted: "[REDACTED]",
          len: 5,
          charset: "digits",
          smuggled: "4111111111111111",
        },
      }),
    );
    expect(JSON.stringify(body)).not.toContain("4111111111111111");
  });
});
