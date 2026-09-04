import { describe, expect, it } from "vitest";
import {
  BROWSER_REDACTION_POLICY,
  REDACTED_VALUE,
  redactCampaignParams,
  redactUrl,
} from "../redaction";

/**
 * The five names campaign capture is allowed to read. Named here as well as in
 * the module so a widening of the allowance shows up as an edit to a test, not
 * only as an edit to the implementation it is meant to constrain.
 */
const ALLOWED = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;

/**
 * Cross-site advertising identifiers and one ordinary parameter. None of these
 * may ever appear in the output — not as a value, and not as `[REDACTED]`,
 * which would still confirm the parameter was present.
 */
const NEVER_READ = [
  "gclid",
  "fbclid",
  "msclkid",
  "ttclid",
  "_fbp",
  "li_fat_id",
  "foo",
] as const;

describe("redactCampaignParams", () => {
  it("round trips a plain label for each of the five allowed names", () => {
    for (const name of ALLOWED) {
      const result = redactCampaignParams(`?${name}=newsletter`);
      expect(result.value).toEqual({ [name]: "newsletter" });
      expect(result.metadata).toBeUndefined();
    }
  });

  it("reads all five together, with or without the leading '?'", () => {
    const search = ALLOWED.map((name) => `${name}=${name}_value`).join("&");
    const expected = Object.fromEntries(
      ALLOWED.map((name) => [name, `${name}_value`]),
    );
    expect(redactCampaignParams(`?${search}`).value).toEqual(expected);
    expect(redactCampaignParams(search).value).toEqual(expected);
  });

  it("keeps a multi-word campaign label", () => {
    expect(
      redactCampaignParams("?utm_campaign=Spring%20Sale%202026").value,
    ).toEqual({ utm_campaign: "Spring Sale 2026" });
  });

  it("never reads a cross-site advertising identifier or an unknown name", () => {
    const search = NEVER_READ.map((name) => `${name}=whatever`).join("&");
    const result = redactCampaignParams(`?${search}&utm_source=newsletter`);

    expect(result.value).toEqual({ utm_source: "newsletter" });
    for (const name of NEVER_READ) {
      expect(Object.keys(result.value)).not.toContain(name);
      expect(JSON.stringify(result)).not.toContain(name);
    }
    // Not read means not redacted either: nothing about them enters metadata.
    expect(result.metadata).toBeUndefined();
  });

  it("does not admit a utm-prefixed name that is not one of the five", () => {
    expect(redactCampaignParams("?utm_id=123&utm_creative=abc").value).toEqual(
      {},
    );
  });

  it("redacts an email smuggled into utm_campaign, with metadata", () => {
    const result = redactCampaignParams("?utm_campaign=user@example.com");

    expect(result.value).toEqual({ utm_campaign: REDACTED_VALUE });
    expect(result.metadata?.policy).toBe(BROWSER_REDACTION_POLICY);
    expect(result.metadata?.fields).toEqual([
      {
        path: "campaign.utm_campaign",
        reason: "campaign_email_value",
        action: "redacted",
      },
    ]);
  });

  it("redacts a JWT-shaped utm_term, with metadata", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const result = redactCampaignParams(`?utm_term=${jwt}`);

    expect(result.value).toEqual({ utm_term: REDACTED_VALUE });
    expect(JSON.stringify(result)).not.toContain(jwt);
    expect(result.metadata?.fields).toEqual([
      {
        path: "campaign.utm_term",
        reason: "campaign_token_like_value",
        action: "redacted",
      },
    ]);
  });

  it("drops a 5,000 character value rather than truncating it into the payload", () => {
    const long = "a".repeat(5_000);
    const result = redactCampaignParams(
      `?utm_content=${long}&utm_source=newsletter`,
    );

    expect(result.value).toEqual({ utm_source: "newsletter" });
    expect("utm_content" in result.value).toBe(false);
    expect(JSON.stringify(result)).not.toContain("aaaaaaaaaa");
    expect(result.metadata?.fields).toEqual([
      {
        path: "campaign.utm_content",
        reason: "campaign_value_length_limit",
        action: "dropped",
      },
    ]);
  });

  it("keeps a label exactly at the 200 character bound and drops one past it", () => {
    // A realistic label rather than a repeated character: an unbroken 200-char
    // alphanumeric run is token-shaped and is redacted by value before the
    // length bound is ever the reason, which would not test the bound.
    const atBound = "spring sale ".repeat(20).slice(0, 200);
    const pastBound = `${atBound}x`;
    expect(atBound).toHaveLength(200);

    expect(
      redactCampaignParams(`?utm_source=${encodeURIComponent(atBound)}`).value,
    ).toEqual({ utm_source: atBound });
    expect(
      redactCampaignParams(`?utm_source=${encodeURIComponent(pastBound)}`)
        .value,
    ).toEqual({});
  });

  it("returns nothing for an empty search, an empty value, or a hash-only tail", () => {
    expect(redactCampaignParams("").value).toEqual({});
    expect(redactCampaignParams("?").value).toEqual({});
    expect(redactCampaignParams("?utm_source=").value).toEqual({});
    expect(redactCampaignParams("?#utm_source=newsletter").value).toEqual({});
  });

  it("takes the first occurrence of a repeated parameter", () => {
    expect(
      redactCampaignParams("?utm_source=first&utm_source=second").value,
    ).toEqual({ utm_source: "first" });
  });
});

describe("redactQueryString is unchanged by the campaign allowance", () => {
  it("still redacts utm_source inside a captured URL", () => {
    const result = redactUrl("https://x.test/?utm_source=a");
    const value = new URL(result.value).searchParams.get("utm_source");

    expect(value).toBe("[REDACTED;len=1;charset=alpha]");
    expect(result.metadata?.fields).toEqual([
      {
        path: "url.query.utm_source",
        reason: "url_query_value",
        action: "redacted",
      },
    ]);
  });

  it("still redacts every utm_* value in a captured URL", () => {
    const search = ALLOWED.map((name) => `${name}=newsletter`).join("&");
    const params = new URL(redactUrl(`https://x.test/?${search}`).value)
      .searchParams;

    for (const name of ALLOWED)
      expect(params.get(name)).toBe("[REDACTED;len=10;charset=alpha]");
  });
});
