import { describe, expect, it } from "vitest";
import {
  jiraToSymptom,
  zendeskToSymptom,
  trelloToSymptom,
  normalizeTicket,
} from "../ticket/normalize";

describe("jiraToSymptom", () => {
  it("maps summary/description/url/release from a realistic Jira issue payload", () => {
    const payload = {
      key: "ABC-123",
      self: "https://acme.atlassian.net/rest/api/3/issue/10001",
      fields: {
        summary: "Checkout fails with 500",
        description: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Checkout 500s" }],
            },
          ],
        },
        fixVersions: [{ name: "2.4.0" }],
      },
    };

    const symptom = jiraToSymptom(payload);

    expect(symptom.title).toBe("Checkout fails with 500");
    expect(symptom.description).toContain("Checkout 500s");
    expect(symptom.url).toBe(
      "https://acme.atlassian.net/rest/api/3/issue/10001",
    );
    expect(symptom.release).toBe("2.4.0");
    expect(symptom.source).toBe("jira");
  });

  it("builds url from the key when self is absent", () => {
    const payload = { key: "ABC-1", fields: { summary: "x" } };
    const symptom = jiraToSymptom(payload);
    expect(symptom.url).toContain("ABC-1");
  });

  it("never throws on a payload missing optional fields", () => {
    expect(() => jiraToSymptom({})).not.toThrow();
    const symptom = jiraToSymptom({});
    expect(symptom.title).toBe("");
    expect(symptom.source).toBe("jira");
  });

  it("returns the raw string description when description is already a string", () => {
    const payload = { fields: { summary: "x", description: "plain text" } };
    const symptom = jiraToSymptom(payload);
    expect(symptom.description).toBe("plain text");
  });
});

describe("zendeskToSymptom", () => {
  it("maps subject/description/url from a bare ticket payload", () => {
    const payload = {
      subject: "Checkout fails",
      description: "500 on submit",
      url: "https://acme.zendesk.com/api/v2/tickets/42.json",
    };
    const symptom = zendeskToSymptom(payload);
    expect(symptom.title).toBe("Checkout fails");
    expect(symptom.description).toBe("500 on submit");
    expect(symptom.url).toBe("https://acme.zendesk.com/api/v2/tickets/42.json");
    expect(symptom.source).toBe("zendesk");
  });

  it("unwraps a { ticket: {...} } envelope", () => {
    const payload = {
      ticket: { subject: "Checkout fails", description: "500 on submit" },
    };
    const symptom = zendeskToSymptom(payload);
    expect(symptom.title).toBe("Checkout fails");
  });

  it("never throws on a payload missing optional fields", () => {
    expect(() => zendeskToSymptom({})).not.toThrow();
    const symptom = zendeskToSymptom({});
    expect(symptom.title).toBe("");
    expect(symptom.source).toBe("zendesk");
  });
});

describe("trelloToSymptom", () => {
  it("maps name/desc/shortUrl from a realistic Trello card payload", () => {
    const payload = {
      name: "Checkout fails",
      desc: "500 on submit",
      shortUrl: "https://trello.com/c/abc123",
    };
    const symptom = trelloToSymptom(payload);
    expect(symptom.title).toBe("Checkout fails");
    expect(symptom.description).toBe("500 on submit");
    expect(symptom.url).toBe("https://trello.com/c/abc123");
    expect(symptom.source).toBe("trello");
  });

  it("falls back to url when shortUrl is absent", () => {
    const payload = { name: "x", url: "https://trello.com/c/xyz" };
    const symptom = trelloToSymptom(payload);
    expect(symptom.url).toBe("https://trello.com/c/xyz");
  });

  it("never throws on a payload missing optional fields", () => {
    expect(() => trelloToSymptom({})).not.toThrow();
    const symptom = trelloToSymptom({});
    expect(symptom.title).toBe("");
    expect(symptom.source).toBe("trello");
  });
});

describe("normalizeTicket", () => {
  it("dispatches to jiraToSymptom for provider 'jira'", () => {
    const symptom = normalizeTicket({
      provider: "jira",
      payload: { fields: { summary: "Checkout fails" } },
    });
    expect(symptom.title).toBe("Checkout fails");
    expect(symptom.source).toBe("jira");
  });

  it("dispatches to zendeskToSymptom for provider 'zendesk'", () => {
    const symptom = normalizeTicket({
      provider: "zendesk",
      payload: { subject: "Checkout fails" },
    });
    expect(symptom.title).toBe("Checkout fails");
    expect(symptom.source).toBe("zendesk");
  });

  it("dispatches to trelloToSymptom for provider 'trello'", () => {
    const symptom = normalizeTicket({
      provider: "trello",
      payload: { name: "Checkout fails" },
    });
    expect(symptom.title).toBe("Checkout fails");
    expect(symptom.source).toBe("trello");
  });

  it("throws a TypeError for an unknown provider", () => {
    expect(() =>
      normalizeTicket({
        // @ts-expect-error testing runtime guard against a bad provider
        provider: "unknown",
        payload: {},
      }),
    ).toThrow(TypeError);
  });
});
