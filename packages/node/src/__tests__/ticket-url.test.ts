import { describe, expect, it } from "vitest";
import { parseTicketUrl } from "../ticket/url";

describe("parseTicketUrl", () => {
  it("resolves a Jira browse URL to { jira, KEY }", () => {
    expect(parseTicketUrl("https://acme.atlassian.net/browse/ABC-123")).toEqual(
      { provider: "jira", id: "ABC-123" },
    );
  });

  it("ignores query/hash on a Jira browse URL", () => {
    expect(
      parseTicketUrl(
        "https://acme.atlassian.net/browse/ENG-42?focusedCommentId=99#comment",
      ),
    ).toEqual({ provider: "jira", id: "ENG-42" });
  });

  it("resolves a Jira REST issue URL (v3 client form) to the idOrKey", () => {
    expect(
      parseTicketUrl("https://acme.atlassian.net/rest/api/3/issue/ABC-123"),
    ).toEqual({ provider: "jira", id: "ABC-123" });
  });

  it("resolves the Jira REST self form (v2, from the payload) too", () => {
    expect(
      parseTicketUrl("https://acme.atlassian.net/rest/api/2/issue/10001"),
    ).toEqual({ provider: "jira", id: "10001" });
  });

  it("does not treat a Jira comment sub-resource as the issue", () => {
    expect(
      parseTicketUrl(
        "https://acme.atlassian.net/rest/api/3/issue/ABC-1/comment",
      ),
    ).toBeUndefined();
  });

  it("resolves a Zendesk agent ticket URL to { zendesk, id }", () => {
    expect(
      parseTicketUrl("https://acme.zendesk.com/agent/tickets/456"),
    ).toEqual({ provider: "zendesk", id: "456" });
  });

  it("resolves a Zendesk API ticket URL to { zendesk, id }", () => {
    expect(
      parseTicketUrl("https://acme.zendesk.com/api/v2/tickets/456.json"),
    ).toEqual({ provider: "zendesk", id: "456" });
  });

  it("resolves a Trello card URL (with a slug tail) to { trello, shortLink }", () => {
    expect(
      parseTicketUrl("https://trello.com/c/abc12345/17-checkout-bug"),
    ).toEqual({ provider: "trello", id: "abc12345" });
  });

  it("resolves a bare Trello card URL and the REST card form", () => {
    expect(parseTicketUrl("https://trello.com/c/abc12345")).toEqual({
      provider: "trello",
      id: "abc12345",
    });
    expect(parseTicketUrl("https://api.trello.com/1/cards/5f2b1c0e9a")).toEqual(
      { provider: "trello", id: "5f2b1c0e9a" },
    );
  });

  it("returns undefined for a malformed URL (never throws)", () => {
    expect(parseTicketUrl("not a url")).toBeUndefined();
    expect(parseTicketUrl("")).toBeUndefined();
  });

  it("returns undefined for an unrecognized host", () => {
    expect(
      parseTicketUrl("https://example.com/browse/ABC-123"),
    ).toBeUndefined();
  });

  it("returns undefined for a recognized host but unrecognized path", () => {
    expect(
      parseTicketUrl("https://acme.atlassian.net/jira/software/projects"),
    ).toBeUndefined();
  });
});
