# Wire contract fixtures

Machine readable form of [`docs/specs/native-sdk-wire-contract.md`](../../docs/specs/native-sdk-wire-contract.md).

Every SDK that is not built on `crumbtrail-core` — Swift, Kotlin, Dart — ships a
conformance test that constructs its own event types, serialises them, and
asserts the result equals the fixture here. `crumbtrail-core` has a matching test
so the reference implementation is held to the same file.

Changing a fixture fails every SDK at once. That is the point: a field rename
that would otherwise drift silently through three languages becomes one
deliberate, reviewable commit.

## Layout

- `transport.json` — endpoint paths, headers, and the request body envelopes
- `events/*.json` — one canonical event per shared kind

Fixtures use fixed values (`t: 1754000000000`, `sdk.version: "0.0.0-fixture"`)
so they are byte comparable. A conformance test substitutes its SDK's real name
and version before comparing, and asserts everything else verbatim.
