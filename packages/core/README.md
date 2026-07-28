# crumbtrail-core

The capture engine behind [Crumbtrail](https://crumbtrail.ai). It records what
actually happened around a bug — the console, the network calls, the DOM
interactions, the state — and hands it over as evidence a coding agent can act on,
instead of a screenshot and a vague repro.

Framework-agnostic, with **no dependencies**.

## Install

```bash
npm install crumbtrail-core
```

Or let the wizard install and wire it for you:

```bash
npx crumbtrail
```

## Setup

Call `Crumbtrail.init()` once, at your app's entry point:

```ts
import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";

Crumbtrail.init({
  ...PRESET_PASSIVE,
  httpEndpoint: "https://api.crumbtrail.ai",
  httpAuthToken: process.env.CRUMBTRAIL_KEY,
});
```

That's the whole integration — capture runs in the background from there.

### Catching the requests that beat init

`init()` usually runs from an async import, so the fetches that render the
first screen can finish before the network patch exists. Those requests leave
no `net.req` and, more importantly, no correlation header, so their backend and
database events cannot be joined to the session later.

Add one side-effect import above everything else in your entry file:

```ts
import "crumbtrail-core/early";
```

It patches `fetch` and `XMLHttpRequest` synchronously, stamps the same
correlation headers the SDK stamps on same origin requests, and parks bounded
metadata (at most 50 requests, 2 MB of body text) until `init()` drains it
through the normal redaction pipeline. `init()` adopts the session id it minted,
so the early requests, the live session, and the backend events all match. If
`init()` never runs within 60 seconds, the queue is dropped and recording stops.

### Presets

| Preset           | Behaviour                                                              |
| ---------------- | ---------------------------------------------------------------------- |
| `PRESET_PASSIVE` | Capture continuously and auto-flag on errors and signals. The default. |
| `PRESET_LIGHT`   | Leaner capture, less overhead.                                         |
| `PRESET_FULL`    | Everything, for a heavy debugging session.                             |

### Flagging a bug yourself

`init()` returns the instance, so you can mark moments explicitly:

```ts
const crumbtrail = Crumbtrail.init({ ...PRESET_PASSIVE, httpEndpoint });

crumbtrail.mark("checkout: submitted");

await crumbtrail.flagBug({
  note: "Payment failed with no error toast",
  tags: ["checkout"],
});
```

Also on the instance: `addEvent`, `registerStateProvider`, `setEnv`,
`createRequestHeaders`, `pause`, `resume`, `stop`, `getSessionId`.

## Redaction is on by default

Crumbtrail is meant to be pointed at real traffic, so scrubbing is not opt in.
Tokens, cookies, storage values, page text, input values, and database row values
are redacted before an event enters the browser buffer. See
`BROWSER_REDACTION_POLICY` and the `redact*` helpers if you want to inspect or
tighten the policy.

### Keeping a field the classifier would otherwise drop

JSON request bodies go through a deny biased per value classifier: numbers and
short enum like strings are kept, everything else is replaced by a shape
placeholder. That is the right default and it is wrong for one specific case,
which is when the text a user submitted **is** the defect. A stored XSS payload,
a search term with a quote in it, an address line a validator wrongly rejects,
a decimal comma amount: a hash of any of those tells an agent nothing.

`redaction.keepFields` names those fields. It is matched on the whole field
name, never as a substring, and it applies to JSON keys and query string
parameters alike:

```ts
Crumbtrail.init({
  redaction: { keepFields: ["body", "q", "postalCode"] },
});
```

What a keep does and does not do:

- It overrides the **built in name heuristics** only. Those match by substring
  and have real false positives, so without an override an app whose schema
  trips one (`auth` matches `author`, `pan` matches `panel`) cannot capture the
  field at all.
- It never disables **value based detection**. An email, a JWT, a card number,
  a token, or a high entropy secret sitting in a kept field is still redacted.
- Your own `denyFields` entry still wins over your keep for the same name.

The capture server takes the same list, so a name kept in a `db.diff` row is
also kept in the request body and query string that produced it:

```bash
crumbtrail-server serve --keep-field body,q,postalCode
```

`CRUMBTRAIL_KEEP_FIELDS` sets it from the environment; flags add to it rather
than replacing it. The active list is printed at boot, because it is the one
setting that makes the server store more than it did before.

## Production capture

Page text, input values, keystrokes, clipboard content, DOM snapshots, and
database row values are masked before they enter the local ring buffer. Add
`data-crumbtrail-unmask` to one element when its text or value is safe to
capture. Add `data-crumbtrail-block` to exclude an element and its descendants
entirely.

Remote capture policy can only add masking. Clear text or values are captured
only when `data-crumbtrail-unmask` is added to that individual safe element.

For consent managed applications, begin capture only after your consent manager
grants permission:

```ts
const crumbtrail = Crumbtrail.init({
  consentMode: "required",
  configEndpoint: "https://capture.example.com/config",
  projectKey: "project_123",
});

crumbtrail.consent(true);
crumbtrail.identify({ accountId: "account_123", userId: "user_456" });
await crumbtrail.flag();
```

Global Privacy Control is respected by default. Email shaped identifiers are
discarded by `identify`.

Set `flightRecorder: true` to buffer locally until an error, signal, widget
action, or `flag()` triggers capture. The recorder adds the configured tail
before finalizing the report. A cloud config response can disable capture with
`killSwitch: true`; the SDK clears its buffer as soon as that response arrives.

### On-screen numbers (`ui.num`)

The `uiNumbers` collector is **on by default**. It scans the visible DOM for
labeled numeric tokens — a number paired with its nearby text label, e.g.
`Subtotal: $84.00` — and emits compact `ui.num` snapshots of `{label, value,
unit}`. These power the display-arithmetic detector (subtotal + tax vs total)
and the UI-vs-API divergence detector. It never captures raw DOM or HTML, only
the short label and the parsed number.

This means numeric amounts shown on screen are captured together with their
labels. Labels run through the redaction classifier, so PII-shaped labels
(emails, tokens) and card-number-shaped values are dropped entirely. The honest
residual: a label that is itself a human name reads as ordinary free text and
can survive capture, so the case to think about is numbers rendered next to
names — payroll, CRM rows, admin tables (`Jane Doe  $84,000`).

Opting out, narrowest first:

- Add the sensitive label to `redaction.denyFields` to drop just those items.
- Use `PRESET_LIGHT`, which disables the collector.
- Disable it entirely with `uiNumbers: false` in `Crumbtrail.init({...})`.

Hidden elements (`hidden`, `aria-hidden="true"`, `display:none`,
`visibility:hidden`) are already skipped.

## Related packages

| Package                                                                            | Use it for                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [`crumbtrail`](https://www.npmjs.com/package/crumbtrail)                           | The `npx crumbtrail` setup wizard                          |
| [`crumbtrail-node`](https://www.npmjs.com/package/crumbtrail-node)                 | Self-hosted server, Express middleware, MCP evidence tools |
| [`crumbtrail-react`](https://www.npmjs.com/package/crumbtrail-react)               | React error boundary and state-capture hook                |
| [`crumbtrail-react-native`](https://www.npmjs.com/package/crumbtrail-react-native) | React Native bindings                                      |
| [`crumbtrail-tauri`](https://www.npmjs.com/package/crumbtrail-tauri)               | Tauri desktop bindings                                     |

## Links

- **Website** — https://crumbtrail.ai
- **Docs** — https://crumbtrail.ai/docs
- **How it works** — https://crumbtrail.ai/how-it-works
- **Source** — https://github.com/CrumbtrailDev/crumbtrail-cli
- **Issues** — https://github.com/CrumbtrailDev/crumbtrail-cli/issues

## License

MIT
