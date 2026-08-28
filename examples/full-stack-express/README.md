# Full-stack Express demo

A deliberately broken Express app plus a browser page, used to see Crumbtrail
correlate a client fetch failure with the backend's request and error evidence
under one request id.

Express is used only by this example and the tests as a root devDependency. It
is not a runtime dependency of `crumbtrail-node`.

## Running it

Build the packages, then point the demo at a Crumbtrail endpoint — your cloud
host, or whatever `npx crumbtrail` configured for this project:

```bash
pnpm --filter crumbtrail-core build
pnpm --filter crumbtrail-node build
CRUMBTRAIL_ENDPOINT=https://your-crumbtrail-host node examples/full-stack-express/server.mjs --port 3000
```

Open the page and trigger `/api/demo-bug`. It intentionally returns a safe JSON
500 carrying its `requestId`, which is the id the browser event and the backend
event both hold.

## What to look for

- `net.req` / `net.res` from the browser and `backend.req.start` /
  `backend.req.error` / `backend.req.end` from Express, all under one
  `sessionId` and one `requestId`.
- The linked full-stack request in the session's evidence, with matching
  frontend and backend HTTP 500 status.
- The demo token in the failing URL redacted everywhere it appears.

## Troubleshooting

### Nothing is captured

Check `CRUMBTRAIL_ENDPOINT` is reachable from the demo process, and that the
build step ran — the example imports package `dist` files, so a missing
`packages/core/dist` or `packages/node/dist` means the build was skipped.

### The browser and backend events do not join

The join key is `X-Crumbtrail-Request-Id`. `networkCorrelationHeaders` is on by
default for same-origin requests; a cross-origin backend must be listed in
`networkCorrelationAllowedOrigins` or the header is not sent and there is
nothing to correlate on.
