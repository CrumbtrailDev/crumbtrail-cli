import { describe, expect, it } from "vitest";
import {
  JiraTicketClient,
  ZendeskTicketClient,
  TrelloTicketClient,
  type CommentingTicketConnector,
  type TicketConnector,
  TicketError,
  ticketClientFromEnv,
} from "../ticket/clients";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("TicketConnector adapter contract", () => {
  it("runs the read and comment contract against Jira and Zendesk", async () => {
    const comments: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (init?.method) {
        comments.push({
          url,
          method: init.method,
          body: JSON.parse(String(init.body)),
        });
        return new Response("{}", { status: 201 });
      }
      if (url.includes("atlassian.net")) {
        return jsonResponse({ fields: { summary: "Jira symptom" } });
      }
      return jsonResponse({ ticket: { subject: "Zendesk symptom" } });
    }) as typeof fetch;
    const connectors: CommentingTicketConnector[] = [
      new JiraTicketClient({
        baseUrl: "https://acme.atlassian.net",
        email: "dev@acme.test",
        apiToken: "jira-token",
        fetchImpl,
      }),
      new ZendeskTicketClient({
        subdomain: "acme",
        email: "dev@acme.test",
        apiToken: "zendesk-token",
        fetchImpl,
      }),
    ];

    expect(connectors.every((connector) => typeof connector.fetchSymptom === "function")).toBe(true);
    await expect(connectors[0].fetchSymptom("CT-1")).resolves.toMatchObject({
      title: "Jira symptom",
    });
    await expect(connectors[1].fetchSymptom("42")).resolves.toMatchObject({
      title: "Zendesk symptom",
    });
    await Promise.all(
      connectors.map((connector, index) =>
        connector.postComment(String(index + 1), {
          paragraphs: ["A first paragraph", "A second paragraph"],
        }),
      ),
    );
    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({
      url: "https://acme.atlassian.net/rest/api/3/issue/1/comment",
      method: "POST",
      body: {
        body: {
          version: 1,
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "A first paragraph" }] },
            { type: "paragraph", content: [{ type: "text", text: "A second paragraph" }] },
          ],
        },
      },
    });
    expect(comments[1]).toMatchObject({
      url: "https://acme.zendesk.com/api/v2/tickets/2.json",
      method: "PUT",
      body: {
        ticket: {
          comment: { body: "A first paragraph\n\nA second paragraph", public: true },
        },
      },
    });
  });

  it("maps provider read failures to TicketError for Jira and Zendesk", async () => {
    const fetchImpl = (async () => jsonResponse({}, 404)) as typeof fetch;
    const connectors: CommentingTicketConnector[] = [
      new JiraTicketClient({
        baseUrl: "https://acme.atlassian.net",
        email: "dev@acme.test",
        apiToken: "jira-token",
        fetchImpl,
      }),
      new ZendeskTicketClient({
        subdomain: "acme",
        email: "dev@acme.test",
        apiToken: "zendesk-token",
        fetchImpl,
      }),
    ];

    for (const connector of connectors) {
      await expect(connector.fetchSymptom("42")).rejects.toMatchObject({
        name: "TicketError",
        status: 404,
      });
    }
  });
});

describe("JiraTicketClient", () => {
  it("fetches the issue and maps it to a Symptom", async () => {
    let capturedUrl = "";
    let capturedHeaders: HeadersInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init?.headers;
      return jsonResponse({ fields: { summary: "Checkout fails" } });
    }) as typeof fetch;

    const client = new JiraTicketClient({
      baseUrl: "https://acme.atlassian.net",
      email: "dev@acme.com",
      apiToken: "tok",
      fetchImpl,
    });

    const symptom = await client.fetchSymptom("ABC-1");

    expect(symptom.title).toBe("Checkout fails");
    expect(capturedUrl).toBe(
      "https://acme.atlassian.net/rest/api/3/issue/ABC-1",
    );
    const auth = (capturedHeaders as Record<string, string>).Authorization;
    expect(auth).toBe(
      `Basic ${Buffer.from("dev@acme.com:tok").toString("base64")}`,
    );
  });

  it("throws TicketError with status on a non-2xx response", async () => {
    const fetchImpl = (async () => jsonResponse({}, 404)) as typeof fetch;
    const client = new JiraTicketClient({
      baseUrl: "https://acme.atlassian.net",
      email: "dev@acme.com",
      apiToken: "tok",
      fetchImpl,
    });

    await expect(client.fetchSymptom("ABC-1")).rejects.toThrow(TicketError);
    await expect(client.fetchSymptom("ABC-1")).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("JiraTicketClient.postComment", () => {
  const comment = { paragraphs: ["A plain text comment"] };

  it("posts an ADF comment with Basic auth and returns on 2xx", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response("{}", { status: 201 });
    }) as typeof fetch;

    const client = new JiraTicketClient({
      baseUrl: "https://acme.atlassian.net",
      email: "dev@acme.com",
      apiToken: "tok",
      fetchImpl,
    });

    await client.postComment("ABC-1", comment, { baseDelayMs: 0 });

    expect(capturedUrl).toBe(
      "https://acme.atlassian.net/rest/api/3/issue/ABC-1/comment",
    );
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("dev@acme.com:tok").toString("base64")}`,
    );
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      body: {
        version: 1,
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "A plain text comment" }] }],
      },
    });
  });

  it("does not retry a non-retryable 4xx and throws TicketError once", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("{}", { status: 400 });
    }) as typeof fetch;
    const client = new JiraTicketClient({
      baseUrl: "https://acme.atlassian.net",
      email: "dev@acme.com",
      apiToken: "tok",
      fetchImpl,
    });

    await expect(
      client.postComment("ABC-1", comment, { baseDelayMs: 0 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toBe(1);
  });

  it("retries a transient 5xx and throws after exhausting the 3 attempts", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("{}", { status: 503 });
    }) as typeof fetch;
    const client = new JiraTicketClient({
      baseUrl: "https://acme.atlassian.net",
      email: "dev@acme.com",
      apiToken: "supersecret-token-do-not-log",
      fetchImpl,
    });

    try {
      await client.postComment("ABC-1", comment, { baseDelayMs: 0 });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TicketError);
      expect((err as TicketError).status).toBe(503);
      // The API token must never appear in the surfaced error message.
      expect((err as TicketError).message).not.toContain(
        "supersecret-token-do-not-log",
      );
    }
    expect(calls).toBe(3);
  });

  it("recovers when a transient failure is followed by success", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("{}", { status: calls < 2 ? 500 : 201 });
    }) as typeof fetch;
    const client = new JiraTicketClient({
      baseUrl: "https://acme.atlassian.net",
      email: "dev@acme.com",
      apiToken: "tok",
      fetchImpl,
    });

    await client.postComment("ABC-1", comment, { baseDelayMs: 0 });
    expect(calls).toBe(2);
  });
});

describe("JiraTicketClient — OAuth bearer mode", () => {
  const comment = { paragraphs: ["A plain text comment"] };
  // The cloud connector boundary hands in a gateway base URL
  // (api.atlassian.com/ex/jira/{cloudId}) plus an already-valid access token.
  const gatewayBase = "https://api.atlassian.com/ex/jira/cloud-abc123";

  it("fetchSymptom uses the gateway base and a Bearer header", async () => {
    let capturedUrl = "";
    let capturedHeaders: HeadersInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init?.headers;
      return jsonResponse({ fields: { summary: "Checkout fails" } });
    }) as typeof fetch;

    const client = new JiraTicketClient({
      baseUrl: gatewayBase,
      auth: { type: "bearer", accessToken: "access-xyz" },
      fetchImpl,
    });

    const symptom = await client.fetchSymptom("ABC-1");

    expect(symptom.title).toBe("Checkout fails");
    expect(capturedUrl).toBe(`${gatewayBase}/rest/api/3/issue/ABC-1`);
    const auth = (capturedHeaders as Record<string, string>).Authorization;
    expect(auth).toBe("Bearer access-xyz");
  });

  it("postComment uses the gateway base and a Bearer header", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response("{}", { status: 201 });
    }) as typeof fetch;

    const client = new JiraTicketClient({
      baseUrl: gatewayBase,
      auth: { type: "bearer", accessToken: "access-xyz" },
      fetchImpl,
    });

    await client.postComment("ABC-1", comment, { baseDelayMs: 0 });

    expect(capturedUrl).toBe(`${gatewayBase}/rest/api/3/issue/ABC-1/comment`);
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access-xyz");
    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
      body: { type: "doc", version: 1 },
    });
  });

  it("never leaks the access token into a TicketError message", async () => {
    const secretAccess = "supersecret-access-token-do-not-log";
    const fetchImpl = (async () => jsonResponse({}, 500)) as typeof fetch;
    const client = new JiraTicketClient({
      baseUrl: gatewayBase,
      auth: { type: "bearer", accessToken: secretAccess },
      fetchImpl,
    });

    try {
      await client.postComment("ABC-1", comment, { baseDelayMs: 0 });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TicketError);
      expect((err as TicketError).message).not.toContain(secretAccess);
    }
  });
});

describe("ZendeskTicketClient", () => {
  it("fetches the ticket and maps it to a Symptom", async () => {
    let capturedUrl = "";
    let capturedHeaders: HeadersInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init?.headers;
      return jsonResponse({ ticket: { subject: "Checkout fails" } });
    }) as typeof fetch;

    const client = new ZendeskTicketClient({
      subdomain: "acme",
      email: "dev@acme.com",
      apiToken: "tok",
      fetchImpl,
    });

    const symptom = await client.fetchSymptom("42");

    expect(symptom.title).toBe("Checkout fails");
    expect(capturedUrl).toBe("https://acme.zendesk.com/api/v2/tickets/42.json");
    const auth = (capturedHeaders as Record<string, string>).Authorization;
    expect(auth).toBe(
      `Basic ${Buffer.from("dev@acme.com/token:tok").toString("base64")}`,
    );
  });

  it("throws TicketError with status on a non-2xx response", async () => {
    const fetchImpl = (async () => jsonResponse({}, 500)) as typeof fetch;
    const client = new ZendeskTicketClient({
      subdomain: "acme",
      email: "dev@acme.com",
      apiToken: "tok",
      fetchImpl,
    });

    await expect(client.fetchSymptom("42")).rejects.toMatchObject({
      status: 500,
    });
  });
});

describe("TrelloTicketClient", () => {
  it("fetches the card and maps it to a Symptom", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: string) => {
      capturedUrl = url;
      return jsonResponse({ name: "Checkout fails" });
    }) as typeof fetch;

    const client = new TrelloTicketClient({
      key: "key123",
      token: "tok456",
      fetchImpl,
    });

    const symptom = await client.fetchSymptom("card1");

    expect(symptom.title).toBe("Checkout fails");
    expect(capturedUrl).toBe(
      "https://api.trello.com/1/cards/card1?key=key123&token=tok456",
    );
  });

  it("throws TicketError with status on a non-2xx response", async () => {
    const fetchImpl = (async () => jsonResponse({}, 403)) as typeof fetch;
    const client = new TrelloTicketClient({
      key: "key123",
      token: "tok456",
      fetchImpl,
    });

    await expect(client.fetchSymptom("card1")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("does not leak the key/token into the TicketError message on failure", async () => {
    const secretKey = "supersecretkey123";
    const secretToken = "supersecrettoken456";
    const fetchImpl = (async () => jsonResponse({}, 404)) as typeof fetch;
    const client = new TrelloTicketClient({
      key: secretKey,
      token: secretToken,
      fetchImpl,
    });

    try {
      await client.fetchSymptom("card1");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TicketError);
      const message = (err as TicketError).message;
      expect(message).not.toContain(secretKey);
      expect(message).not.toContain(secretToken);
      expect(message).not.toMatch(/token=|key=/);
      expect(message).toContain("api.trello.com/1/cards");
    }
  });
});

describe("ticketClientFromEnv", () => {
  it("builds a JiraTicketClient from env vars", () => {
    const client = ticketClientFromEnv("jira", {
      JIRA_BASE_URL: "https://acme.atlassian.net",
      JIRA_EMAIL: "dev@acme.com",
      JIRA_API_TOKEN: "tok",
    });
    expect(client).toBeInstanceOf(JiraTicketClient);
  });

  it("builds a ZendeskTicketClient from env vars", () => {
    const client = ticketClientFromEnv("zendesk", {
      ZENDESK_SUBDOMAIN: "acme",
      ZENDESK_EMAIL: "dev@acme.com",
      ZENDESK_API_TOKEN: "tok",
    });
    expect(client).toBeInstanceOf(ZendeskTicketClient);
  });

  it("builds a TrelloTicketClient from env vars", () => {
    const client = ticketClientFromEnv("trello", {
      TRELLO_KEY: "key123",
      TRELLO_TOKEN: "tok456",
    });
    expect(client).toBeInstanceOf(TrelloTicketClient);
  });

  it("throws TicketError naming the missing var for an empty env", () => {
    expect(() => ticketClientFromEnv("jira", {})).toThrow(TicketError);
    try {
      ticketClientFromEnv("jira", {});
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TicketError);
      expect((err as TicketError).message).toContain("JIRA_BASE_URL");
    }
  });
});
