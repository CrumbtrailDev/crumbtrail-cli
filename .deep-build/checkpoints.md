# Checkpoints

## Checkpoint 1: Changed-package release gate

Select only changed public packages, reject selected versions that already exist
on npm, create inspectable dry-run tarballs, and test the selection contract.

Depends on: none.

## Checkpoint 2: Version and prove PR #17 packages

Bump `crumbtrail-core` to `0.6.0` and `crumbtrail-node` to `0.9.0`. Prove the
packed packages install together and that the installed analyzer emits a PR #17
signal. Regenerate version-stamped artifacts.

Depends on: Checkpoint 1.

## Checkpoint 3: Derive installer floors

Remove silent floor drift, bump `crumbtrail-detect-core` to `0.2.0` and the CLI
to `0.7.2`, then prove a packed CLI requests Core `^0.6.0` and Node `^0.9.0`.

Depends on: Checkpoint 2.

## External gate

The seven prepared versions must be published and verified on npm before the
hosted repository can take its frozen-lockfile dependency update:

- `crumbtrail@0.7.2`
- `crumbtrail-core@0.6.0`
- `crumbtrail-detect-core@0.2.0`
- `crumbtrail-install-shared@0.4.0`
- `crumbtrail-node@0.9.0`
- `crumbtrail-react-native@0.3.0`
- `crumbtrail-tauri@0.3.0`
