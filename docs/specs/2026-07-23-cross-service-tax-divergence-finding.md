# Finding: the tax engine fixture cannot discriminate, so no detector ships

Date: July 23, 2026
Status: closed as investigation. No detector was written. See "What ships instead".

## What this was supposed to be

A detector for cross service value divergence on the `backend.http` plane. The
target was playground regression #17, "tax engine flag divergence", the one gap
from the live harness run whose detection rule was not settled during planning.

The plan required the rule to be resolved against a real N/N1 pair before any
code was written, and carried an escape hatch: if the pair proves the plane
cannot discriminate, record the finding and ship no detector rather than force
one that fires on both sides.

The escape hatch applies. This document is the recorded finding.

## The rule that was expected to work

`BUGS.md` #17 and the patch comment in the pricing service both describe the
bug as: the charge path adds sales tax that the display path never shows, so
the patched build charges more than it displays. Under that description the
detector is obvious and cheap. Compare the charged total against the displayed
total, and fire when they disagree.

## What the source actually does

The flag only ever moves the charge path. The display path adds tax
unconditionally and never reads the flag.

| Path | Source | Total |
| --- | --- | --- |
| Charge | `packages/shared/src/money.js` `computePricing` | `subtotalCents - discount`, tax computed and returned but never added |
| Display, server | `packages/shared/src/money.js` `computeTotals` | `subtotalCents + taxCents`, unconditional |
| Display, client | `client/src/lib/totals.js` `computeTotals` | `subtotalCents + taxCents`, unconditional |
| Flag | `services/pricing/src/index.js` | `newTaxEngine ? pricing.totalCents + pricing.taxCents : pricing.totalCents` |

So on the clean baseline the display shows subtotal plus tax while the charge
is subtotal alone, and they diverge on every checkout. Turning the flag on
makes them agree.

## Confirmed against real captured sessions

Two sessions from the harness run, read out of the `backend.http` plane:

| Session | Flag | subtotalCents | taxCents | totalCents | Sums? |
| --- | --- | --- | --- | --- | --- |
| `ses_20260723_160249_f1cae64d23b6` | off, clean N | 8900 | 734 | 8900 | no, 8900 + 734 = 9634 |
| `ses_20260723_160837_d507608f6f02` | on, patched N1 | 19900 | 1642 | 21542 | yes |

The patched build is the arithmetically consistent one. The clean baseline is
the inconsistent one. Every rule of the form "the components must reconcile
with the total" therefore fires on N and stays silent on N1: inverted, and it
would break N silence across the whole regression suite, not just this pair.

The only field that separates N1 from N is `taxApplied: true`, which is the
flag echoed back in the response. Reading it detects the flag, not a defect.

## What ships instead

Nothing on the `backend.http` plane. In particular no `CausalNodeKind` was
added for it: that decision was contingent on a detector existing, and adding
a node kind for a plane no detector reads would widen the graph for nothing.

The two detectors that did ship in this change, `db_field_divergence` and
`duplicate_write`, both read the `db.diff` plane, where the invariant is a
property of captured rows rather than of a fixture's intent.

## Routed, not fixed here

1. **Playground documentation defect.** `BUGS.md` #17's "Actual (N1)" prose and
   the patch comment at `services/pricing/src/index.js` both state the inverse
   of what the code does. The manifest is not affected: its `expects` assert
   `taxApplied` only, and the "Signal" line is accurate. A reader who trusts
   the prose builds the inverted detector, which is what happened here. This is
   a `crumbtrail-playground` change.

2. **Whether the fixture should be repaired.** Making #17 mean what it claims
   requires the display path to consult the flag, which is a fixture redesign
   rather than a documentation fix, and it changes what N and N1 assert. That
   is an owner call, not a side effect of a detector change.

Broadening `backend.http` capture in `crumbtrail-core` was out of scope for
this work and remains so. Nothing here establishes that the plane is too thin;
it establishes that this particular fixture does not carry the bug its
documentation describes.
