# Phase 0 release stabilization

PR #17 merged new browser capture and hosted analysis behavior without advancing
the public package versions. This run makes the release process collision safe,
versions and proves the changed packages from their packed artifacts, and removes
manual installer floor drift.

The run prepares, but does not perform, npm publication. Publishing remains an
explicit operational gate.

