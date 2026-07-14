# Headless Job Example

This example records a queue/cron/batch run as a Crumbtrail session with no
browser. It starts a real Crumbtrail server, runs a fake invoice digest job, and
verifies the finalized bundle contains:

- session metadata with `source: "headless"`, `app`, `release`, and `build`
- job log events
- a backend span/log pair
- a `db.diff` emitted by the Postgres client shim

Run it from the repository root after building packages:

```bash
pnpm --filter crumbtrail-core build
pnpm --filter crumbtrail-node build
node examples/headless-job/verify.mjs
```

Manual use in a worker looks like this:

```js
import { runInvoiceDigestJob } from "./worker.mjs";

await runInvoiceDigestJob({
  endpoint: "http://127.0.0.1:9898",
  sessionId: `invoice-digest-${Date.now()}`,
  metadata: {
    app: "billing-worker",
    release: process.env.RELEASE,
    build: process.env.GIT_SHA,
  },
});
```

If the worker already exports OpenTelemetry, use the same `crumbtrail.session.id`
for spans/logs so telemetry, job logs, and row diffs land in one session.
