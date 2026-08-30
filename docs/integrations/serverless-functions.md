# Capture serverless HTTP functions

Use `crumbtrail-core/serverless` for Fetch handlers. Use `crumbtrail-node` for
AWS Lambda, Vercel Node, and Netlify Node handlers.

## Prerequisites

These examples require a package release whose exports include
`crumbtrail-core/serverless` and the Node adapter names shown below. When the
release you consume does not include them yet, install packed tarballs from this
repository in a test project before changing an application.

Node adapters require Node.js 22.15 or later. Fetch adapters require `Request`,
`Response`, and `fetch` globals. `AbortController` enables request deadlines.
Without it, the underlying Fetch behavior applies.

Each function needs:

* A Crumbtrail endpoint. Pass it as `endpoint`. There is no default endpoint.
* An auth token when the endpoint requires one. Pass it as `authToken`.
* An async HTTP handler. Callback Lambda handlers and non HTTP triggers are not
  supported.
* Environment variables or runtime bindings that are available inside the
  function.

The examples use `CRUMBTRAIL_BASE_URL` for the endpoint and `CRUMBTRAIL_KEY`
for the auth token.

## Wrap a Fetch handler

Install the Fetch adapter:

```bash
npm install crumbtrail-core
```

This is the shortest Fetch example. Replace the endpoint with your Crumbtrail
host.

```ts
import { withCrumbtrailFetch } from "crumbtrail-core/serverless";

export const handler = withCrumbtrailFetch(
  async () => new Response("ok"),
  { endpoint: "https://your-crumbtrail-host" },
);
```

Without `waitUntil`, the returned handler waits for Crumbtrail delivery before
it returns the host response.

## Wrap an AWS Lambda handler

Install the Node adapters and Lambda types:

```bash
npm install crumbtrail-core crumbtrail-node
npm install --save-dev @types/aws-lambda
```

Set `CRUMBTRAIL_BASE_URL` and `CRUMBTRAIL_KEY` in the Lambda environment.

```ts
import { withCrumbtrailAwsLambda } from "crumbtrail-node";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
} from "aws-lambda";

const handleRequest = async (
  event: APIGatewayProxyEventV2,
  _context: Context,
): Promise<APIGatewayProxyResultV2> => ({
  statusCode: 200,
  body: JSON.stringify({ path: event.rawPath }),
});

export const handler = withCrumbtrailAwsLambda(handleRequest, {
  endpoint: process.env.CRUMBTRAIL_BASE_URL!,
  authToken: process.env.CRUMBTRAIL_KEY,
});
```

The event must have an API Gateway compatible HTTP method and route. The
wrapper rejects callback handlers and non HTTP events.

## Wrap a Vercel Node handler

Install the Node adapters and Vercel types:

```bash
npm install crumbtrail-core crumbtrail-node @vercel/node
```

Set `CRUMBTRAIL_BASE_URL` and `CRUMBTRAIL_KEY` in the Vercel project
environment variables.

```ts
import { withCrumbtrailVercel } from "crumbtrail-node";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const handleRequest = async (
  request: VercelRequest,
  response: VercelResponse,
) => {
  response.status(200).json({ path: request.url });
};

export default withCrumbtrailVercel(handleRequest, {
  endpoint: process.env.CRUMBTRAIL_BASE_URL!,
  authToken: process.env.CRUMBTRAIL_KEY,
});
```

## Wrap a Netlify Node handler

Install the Node adapters and Netlify types:

```bash
npm install crumbtrail-core crumbtrail-node @netlify/functions
```

Set `CRUMBTRAIL_BASE_URL` and `CRUMBTRAIL_KEY` with the Netlify Functions
scope.

```ts
import { withCrumbtrailNetlify } from "crumbtrail-node";
import type { HandlerContext, HandlerEvent } from "@netlify/functions";

const handleRequest = async (
  event: HandlerEvent,
  _context: HandlerContext,
) => ({
  statusCode: 200,
  body: JSON.stringify({ path: event.path }),
});

export const handler = withCrumbtrailNetlify(handleRequest, {
  endpoint: process.env.CRUMBTRAIL_BASE_URL!,
  authToken: process.env.CRUMBTRAIL_KEY,
});
```

## Wrap a Cloudflare Worker

Install only the Fetch package:

```bash
npm install crumbtrail-core
```

Add `CRUMBTRAIL_BASE_URL` as a Worker variable and `CRUMBTRAIL_KEY` as a
Worker secret. Do not install `crumbtrail-node` in a Worker.

```ts
import { withCrumbtrailFetch } from "crumbtrail-core/serverless";

interface Env {
  CRUMBTRAIL_BASE_URL: string;
  CRUMBTRAIL_KEY: string;
}

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

const handleRequest = async (request: Request) =>
  Response.json({ path: new URL(request.url).pathname });

export default {
  fetch(request: Request, env: Env, context: WorkerContext): Promise<Response> {
    return withCrumbtrailFetch(handleRequest, {
      endpoint: env.CRUMBTRAIL_BASE_URL,
      authToken: env.CRUMBTRAIL_KEY,
      waitUntil: context.waitUntil.bind(context),
    })(request);
  },
};
```

`context.waitUntil` keeps the complete Crumbtrail HTTP sequence alive after the
host response is ready.

Cloudflare native OpenTelemetry traces and logs are an optional complementary
path. Configure separate `/v1/traces` and `/v1/logs` destinations when needed.
That path does not provide metrics.

## Wrap a Vercel Edge handler

Install the Fetch adapter and the Vercel lifecycle helper:

```bash
npm install crumbtrail-core @vercel/functions
```

Set `CRUMBTRAIL_BASE_URL` and `CRUMBTRAIL_KEY` in the Vercel project
environment variables.

```ts
import { waitUntil } from "@vercel/functions";
import { withCrumbtrailFetch } from "crumbtrail-core/serverless";

export const config = { runtime: "edge" };

const handleRequest = async (request: Request) =>
  Response.json({ path: new URL(request.url).pathname });

export default function handler(request: Request): Promise<Response> {
  return withCrumbtrailFetch(handleRequest, {
    endpoint: process.env.CRUMBTRAIL_BASE_URL!,
    authToken: process.env.CRUMBTRAIL_KEY,
    waitUntil,
  })(request);
}
```

## Wrap a Netlify Edge handler

Install the Fetch adapter and Netlify Edge types:

```bash
npm install crumbtrail-core @netlify/edge-functions
```

Set `CRUMBTRAIL_BASE_URL` and `CRUMBTRAIL_KEY` with the Netlify Functions
scope.

```ts
import { withCrumbtrailFetch } from "crumbtrail-core/serverless";
import type { Context } from "@netlify/edge-functions";

const handleRequest = async (request: Request) =>
  Response.json({ path: new URL(request.url).pathname });

export default function handler(
  request: Request,
  context: Context,
): Promise<Response> {
  return withCrumbtrailFetch(handleRequest, {
    endpoint: Netlify.env.get("CRUMBTRAIL_BASE_URL")!,
    authToken: Netlify.env.get("CRUMBTRAIL_KEY"),
    waitUntil: context.waitUntil.bind(context),
  })(request);
}
```

## Wrap a Deno handler

Add the Fetch package with a Deno npm specifier:

```bash
deno add npm:crumbtrail-core
```

Set `CRUMBTRAIL_BASE_URL` and `CRUMBTRAIL_KEY` in Deno Deploy. Local runs need
environment read permission.

```ts
import { withCrumbtrailFetch } from "npm:crumbtrail-core/serverless";

const handleRequest = async (request: Request) =>
  Response.json({ path: new URL(request.url).pathname });

Deno.serve(
  withCrumbtrailFetch(handleRequest, {
    endpoint: Deno.env.get("CRUMBTRAIL_BASE_URL")!,
    authToken: Deno.env.get("CRUMBTRAIL_KEY"),
  }),
);
```

Deno supplies no lifecycle callback in this example, so the wrapper waits for
delivery before returning.

## Configure delivery

The Fetch and Node wrappers share these options.

| Option | Type | Default | Behavior |
|---|---|---|---|
| `endpoint` | `string` | Required unless `transport` is set | Base URL for session start, event capture, and session end requests. There is no default. |
| `authToken` | `string` | Omitted | Sent as `X-Crumbtrail-Auth` when set. Available only with `endpoint`. |
| `service` | `string` | Omitted | Added to metadata when the wrapper creates a fresh session. |
| `metadata` | `Readonly<Record<string, unknown>>` | Omitted | Adds bounded scalar metadata to lifecycle events. |
| `onError` | `(error, context) => void` | `console.error` | Receives configuration and delivery failures with their phase and session ID. |
| `requestTimeoutMs` | `number` | `10000` | Sets the deadline for each Crumbtrail HTTP request. A value less than or equal to zero disables the wrapper deadline. |
| `transport` | `ServerlessInvocationTransport` | Omitted | Replaces HTTP delivery. It must provide `startSession`, `capture`, and `endSession`. `flush` is optional. Do not combine it with `endpoint`. |
| `fetchImpl` | `typeof fetch` | Global `fetch` | Replaces the Fetch implementation for HTTP delivery. |
| `waitUntil` | `(promise: Promise<void>) => void` | Omitted | Fetch wrapper only. Passes cleanup to the runtime lifecycle hook. |
| `now` | `() => number` | `Date.now` | Supplies lifecycle timestamps and the duration clock. |

`endpoint` and `transport` are alternatives. The wrapper reports a
configuration failure when neither is present or when both are present. It
still returns the host response or rethrows the original host error.

## Understand the session lifecycle

An invocation without `X-Crumbtrail-Session-Id` creates a fresh session,
captures start and terminal lifecycle events, and ends that session. An
invocation with an incoming Crumbtrail session ID reuses that session and does
not end it.

The wrapper also reads `X-Crumbtrail-Request-Id` and `traceparent`. Missing
correlation values are generated and the event records which values came from
headers, `traceparent`, or generation.

Node adapters and Fetch adapters without `waitUntil` wait for delivery. A Fetch
adapter with `waitUntil` gives the complete session start, capture, and session
end HTTP sequence to the lifecycle hook. If the hook throws while accepting the
promise, the wrapper reports that failure and waits for delivery itself.

Configuration, capture, timeout, and lifecycle failures go to `onError` or
`console.error`. They never replace the host response or the original host
error.

## Understand the data boundary

The wrappers capture:

* HTTP method, route, response status, and duration
* Session, request, and W3C trace correlation when present
* At most 16 metadata entries with scalar string, number, boolean, or null
  values
* Error name, message, and string or numeric code

`SERVERLESS_LIMITS` caps methods at 24 characters, routes at 256 characters,
session IDs at 128 characters, and request IDs at 64 characters. Metadata is
limited to 16 entries, 64 character keys, and 256 character string values.
Numbers must be finite. Error names are limited to 120 characters, messages to
500 characters, and codes to 120 characters. Duration is capped at 24 hours.

Request and response bodies are excluded by default, including metadata fields
named as bodies.

Routes, metadata strings, and error fields pass through the shared credential
and URL redaction policy before delivery. Correlation headers identify related
capture only. They do not grant access or authorize a request.

These wrappers do not claim full traces, logs, database evidence, or payload
capture. Add those sources separately when the application needs them.

## Use the setup wizard guidance

The generic installer uses a guided, nonmutating setup mode for serverless
functions. It prints a copyable plan, requests no ingest key, installs no
packages, changes no files, and does not wait for traffic.

| Recipe ID | Runtime choice | Adapter | Setup mode |
|---|---|---|---|
| `aws-lambda` | API Gateway compatible Lambda | `withCrumbtrailAwsLambda` | Guided plan only |
| `vercel-functions` | Vercel Node | `withCrumbtrailVercel` | Guided plan only |
| `vercel-edge-functions` | Vercel Edge | `withCrumbtrailFetch` | Guided plan only |
| `vercel-functions-ambiguous` | Inspect config and source, then choose Node or edge | One matching adapter | Guided choice only |
| `netlify-functions` | Netlify Node | `withCrumbtrailNetlify` | Guided plan only |
| `netlify-edge-functions` | Netlify Edge | `withCrumbtrailFetch` | Guided plan only |
| `netlify-functions-ambiguous` | Inspect config and source, then choose Node or edge | One matching adapter | Guided choice only |
| `cloudflare-workers` | Cloudflare Workers Fetch | `withCrumbtrailFetch` | Guided plan only |
| `deno-deploy` | `Deno.serve` | `withCrumbtrailFetch` | Guided plan only |

For an ambiguous Vercel or Netlify project, inspect the function config and
source before choosing. Apply exactly one adapter to one function and preserve
its export shape.

## Confirm one real request

After applying one wrapper in the target environment, send one real HTTP
request to that function. Open Crumbtrail Sessions and confirm that a new
session contains the serverless invocation start and terminal event.

Local package checks can prove package contents, ESM and CommonJS imports,
declarations, and the installer plan lifecycle. They cannot prove your target
environment, endpoint, credentials, or first real session.
