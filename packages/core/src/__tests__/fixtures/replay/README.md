# Golden replay fixtures

These files are the contract between the recorder in this package and the
decoder in `crumbtrail-replay-protocol` (`CrumbtrailDev/crumbtrail`). The two
live in different repositories and neither imports the other, so nothing but
these bytes holds them together.

The rule is structural identity: `JSON.parse` of the file here and of the file
in the product repository must be deep equal. The same files exist at
`packages/replay-protocol/src/__tests__/fixtures/`. This package's suite asserts
that encoding the described page produces `chunk-0.json`; the decoder's suite
asserts that decoding it yields the described tree. A change to either side that
is not a change to these files is a change that broke the format.

The contract is structural rather than byte-for-byte on purpose. Both
repositories run Prettier over their own tree, and the two are separately
configured, so whitespace is owned by a formatter in each and is not something
either side can hold stable for the other. Whitespace is also not part of the
format: a chunk is gzipped before it is ever stored, and the decoder reads
parsed JSON. Pinning bytes would mean a reformat in one repository breaking a
suite in the other over a difference that cannot reach a stored session.

Editing a fixture is therefore a format change and needs both suites updated in
the same pair of pull requests. If that feels heavy, it is meant to: a replay
written by one version and unreadable by another is a session a customer
captured and cannot watch, and it fails at read time, months later, with the
evidence already gone.

## String table order

Every fixture's `s` array is in **first-seen order**, walking the chunk exactly
as an encoder does: events in order, and within a node, tag then attributes then
children. This is not cosmetic. An encoder interns strings as it meets them, so
a fixture whose table is in any other order is a fixture no encoder can produce,
and the contract would be unsatisfiable on the writing side while still passing
every decoder test — the decoder only resolves indices and does not care how
they were assigned.

## `chunk-0.json`

One checkout chunk from a small checkout page. Deliberately exercises the parts
of the format that are easy to get wrong rather than the parts that are common:

- a doctype, which is the only node type carrying a name and no children
- a valueless attribute is **not** present here; see `chunk-1.json`
- an attribute value repeated across two elements, which is the string table's
  whole reason for existing
- a text mutation against a node introduced by the snapshot, so node identity
  has to survive across events
- a masked input value, showing what `inputs_masked` actually stores
- a gap, so a decoder cannot quietly treat the recording as continuous

## `chunk-1.json`

A non-checkout continuation chunk: opens on a mutation rather than a snapshot,
carries a valueless boolean attribute (`disabled`), and removes a node the
previous chunk added. Exists so `checkout: false` and cross-chunk node identity
are covered by something other than an assertion about an empty case.

## `manifest.json`

The manifest listing both chunks.
