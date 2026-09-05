# Redaction fixtures

The shared corpus behind the URL redaction rules in the SDKs that are not built
on `crumbtrail-core`.

`urls.json` holds one case per line of defence: `name` says what the case is
for, `input` is the raw URL an adapter captured, and `expected` is the exact
string the SDK must produce. Byte comparable on purpose. Two SDKs that both
"redact the token" but disagree about whether the marker is
`[REDACTED]` or `%5BREDACTED%5D` are two SDKs that ingest cannot treat alike.

Read by:

- `packages/kotlin/src/test/kotlin/ai/crumbtrail/sdk/RedactionFixturesTest.kt`
- `packages/flutter/test/redaction_fixtures_test.dart`

Both read this file from the repo root rather than copying it, so changing a
case fails both SDKs at once. That is the point: a redaction rule that drifts in
one language is the failure mode this corpus exists to catch.

`packages/core/src/redaction.ts` is the reference implementation the mobile
rules are ported from. It carries more machinery than a device SDK can, so the
corpus covers the shared subset: path segment redaction, sensitive preceder
detection, and credential shape matching on query values.
