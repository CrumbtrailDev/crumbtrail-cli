# Full-stack Express proof

This example proves Crumbtrail can capture and correlate a no-extension client fetch failure with Express backend lifecycle/error evidence under one request ID. It is intended for agents and humans who need a bounded, repeatable proof that the generated artifacts and MCP context agree.

Express is used only by this example and tests as a root devDependency. It is not a runtime dependency of `crumbtrail-node`.

## Self-host quickstart proof

From the repository root:

```bash
pnpm verify:self-host
```

The command builds `crumbtrail-core` and `crumbtrail-node`, starts the packaged `packages/node/dist/cli.cjs` server as a child process, checks `GET /health`, starts the Express demo, triggers the deliberate `/api/demo-bug` HTTP 500, finalizes the Crumbtrail session, and verifies generated artifacts plus MCP linked request context.

This is the recommended local self-host smoke proof because it uses the built CLI server path rather than the in-process server helper.

Successful output is bounded JSON. IDs, ports, and temp paths vary:

```json
{
  "ok": true,
  "serverUrl": "http://127.0.0.1:51437",
  "healthUrl": "http://127.0.0.1:51437/health",
  "health": {
    "status": "ready",
    "outputWritable": true,
    "staticConfigured": true
  },
  "sessionId": "<bounded session id>",
  "requestId": "<correlated request id>",
  "outputDir": "/tmp/crumbtrail-self-host-...",
  "sessionDir": "/tmp/crumbtrail-self-host-.../<session id>",
  "artifacts": {
    "events.ndjson": ".../events.ndjson",
    "index.json": ".../index.json",
    "llm.json": ".../llm.json",
    "llm.md": ".../llm.md"
  },
  "linkedCounts": {
    "events": {
      "net.req": 1,
      "net.res": 1,
      "backend.req.start": 1,
      "backend.req.error": 1,
      "backend.req.end": 1
    },
    "index": 1,
    "llm": 1
  },
  "statuses": {
    "frontend": 500,
    "backend": 500,
    "mcp": "linked",
    "mcpCorrelation": "linked"
  }
}
```

To retain artifacts in a known directory:

```bash
CRUMBTRAIL_SELF_HOST_OUTPUT_DIR=/tmp/crumbtrail-self-host-proof pnpm verify:self-host
```

Do not point `CRUMBTRAIL_SELF_HOST_OUTPUT_DIR` at repository-local planning or agent state directories such as `.gsd/`, `.planning/`, or `.audits/`.

## In-process verifier

The older verifier remains useful for focused correlation development:

```bash
pnpm verify:full-stack
```

The root script builds `crumbtrail-core` and `crumbtrail-node` first, then runs `examples/full-stack-express/verify.mjs`. Building first is required because the example imports package `dist` files.

By default, verifier output is written to a temporary directory under the OS temp folder. To retain artifacts for later inspection, opt in with:

```bash
CRUMBTRAIL_EXAMPLE_OUTPUT_DIR=/tmp/crumbtrail-full-stack-proof pnpm verify:full-stack
```

Do not point `CRUMBTRAIL_EXAMPLE_OUTPUT_DIR` at repository-local planning or agent state directories such as `.gsd/`, `.planning/`, or `.audits/`.

## What both verifiers prove

The verifiers start a local Crumbtrail intake server, initialize the SDK with fetch network capture and correlation headers, start the Express demo, trigger `/api/demo-bug`, finalize the session, and assert that:

- `events.ndjson` contains correlated `net.req`, `net.res`, `backend.req.start`, `backend.req.error`, and `backend.req.end` events for the same `sessionId` and `requestId`.
- `index.json` contains linked full-stack request evidence with matching frontend and backend HTTP 500 status evidence.
- `llm.json` and `llm.md` expose the linked full-stack context for LLM inspection.
- MCP `getLinkedRequestContext` returns `status: "linked"` and `correlationStatus: "linked"` for the same request.
- The demo token used in the failing URL is redacted from index, LLM, and MCP outputs.

The self-host verifier additionally proves the packaged server's `/health` response is ready before capture.

## Artifact locations

For each retained session directory, inspect:

```text
<outputDir>/<sessionId>/
├── events.ndjson
├── index.json
├── llm.json
└── llm.md
```

Use the verifier's printed `sessionId`, `requestId`, `sessionDir`, and artifact paths to localize failures quickly.

## Running the demo manually

The automated verifiers are the authoritative proofs. For manual exploration after building packages, run Crumbtrail server separately:

```bash
pnpm --filter crumbtrail-core build
pnpm --filter crumbtrail-node build
node packages/node/dist/cli.cjs --host 127.0.0.1 --port 9898 --output /tmp/crumbtrail-manual --static examples/full-stack-express
curl http://127.0.0.1:9898/health
```

Then in another terminal:

```bash
CRUMBTRAIL_ENDPOINT=http://localhost:9898 node examples/full-stack-express/server.mjs --port 3000
```

Open the demo page and trigger `/api/demo-bug`; it intentionally returns a safe JSON 500 response with `requestId`.

## Troubleshooting

### Health is not ready

If `pnpm verify:self-host` fails before capture, inspect the printed `phase`, `serverUrl`, `healthUrl`, stdout, and stderr context. `GET /health` should report `status: "ready"`, `checks.outputDir.writable: true`, and a configured static directory.

### Missing build or `dist` imports

If Node reports missing files under `packages/core/dist` or `packages/node/dist`, run the root verifier instead of invoking scripts directly:

```bash
pnpm verify:self-host
```

### Missing XHR

XHR is no longer required for this proof. The network collector captures fetch-only clients, and the verifier runs in Node with fetch capture enabled.

### Backend intake timeout

A backend intake timeout means the Express middleware did not finish sending lifecycle/error events to the Crumbtrail intake server. Check that the local intake server started, that `/health` was ready, that the verifier did not abort early, and that no local firewall/proxy is blocking loopback HTTP.

### MCP partial or unavailable status

The verifier fails if MCP does not return linked context. Inspect `index.json` first: if `fullStackRequests.summary.linked` is `0`, correlation failed before MCP lookup. If `index.json` is linked but MCP is unavailable or partial, inspect the MCP JSON response and confirm it is reading the same `outputDir` printed by the verifier.
