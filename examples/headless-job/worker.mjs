import {
  instrumentPgClient,
  startHeadlessSession,
} from "../../packages/node/dist/index.js";

function fakePgClient() {
  return {
    calls: [],
    async query(text, params) {
      this.calls.push({ text, params });
      if (/^update/i.test(text)) {
        return {
          rows: [
            {
              id: 42,
              tenant_id: "acme",
              digest_status: "sent",
              api_key: "sk_fake_should_be_redacted",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

export async function runInvoiceDigestJob(options = {}) {
  const now = options.now ?? (() => Date.now());
  const sessionId = options.sessionId ?? `invoice-digest-${now()}`;
  const traceId = options.traceId ?? "11111111111111111111111111111111";
  const spanId = options.spanId ?? "2222222222222222";
  const dbEvents = [];

  const session = await startHeadlessSession({
    endpoint: options.endpoint,
    sessionId,
    authToken: options.authToken,
    fetchImpl: options.fetchImpl,
    metadata: {
      app: "billing-worker",
      release: "R182",
      build: "headless-example",
      job: "invoice-digest",
      ...options.metadata,
    },
  });

  await session.record([
    {
      t: now(),
      k: "con",
      d: { lv: "info", msg: "invoice digest job started" },
    },
    {
      t: now(),
      k: "backend.otel.span",
      d: {
        requestId: traceId,
        traceId,
        spanId,
        name: "jobs.invoice-digest",
        statusCode: "OK",
        attributes: {
          "crumbtrail.session.id": sessionId,
          "job.name": "invoice-digest",
        },
      },
    },
  ]);

  const db = instrumentPgClient(fakePgClient(), {
    requestId: traceId,
    sessionId,
    maxRowsPerStatement: 10,
    emit: (event) => dbEvents.push(event),
    now,
  });
  await db.query(
    "UPDATE invoice_digests SET digest_status = $1 WHERE id = $2",
    ["sent", 42],
  );

  await session.record([
    ...dbEvents,
    {
      t: now(),
      k: "backend.otel.log",
      d: {
        requestId: traceId,
        traceId,
        spanId,
        severityText: "INFO",
        body: "invoice digest completed",
        attributes: { tenant: "acme" },
      },
    },
    {
      t: now(),
      k: "con",
      d: { lv: "info", msg: "invoice digest job finished" },
    },
  ]);

  const finalization = await session.end();
  return { sessionId, traceId, dbEvents, finalization };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const endpoint = process.env.CRUMBTRAIL_ENDPOINT;
  if (!endpoint) {
    throw new Error("Set CRUMBTRAIL_ENDPOINT to a running Crumbtrail server.");
  }
  const result = await runInvoiceDigestJob({
    endpoint,
    sessionId: process.env.CRUMBTRAIL_SESSION_ID,
    authToken: process.env.CRUMBTRAIL_AUTH_TOKEN,
    metadata: {
      release: process.env.RELEASE,
      build: process.env.GIT_SHA,
    },
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
