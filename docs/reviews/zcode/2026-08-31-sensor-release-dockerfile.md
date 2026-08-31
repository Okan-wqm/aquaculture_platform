# Sensor-ingestion release image build — broken since the vendored rumqttc fork

**Date:** 2026-08-31 · **Agent:** zcode · **Cycle:** 2026-08-31 branch-recovery
**Finding:** SENSOR-HIGH-086 · **State:** OPEN → closed by this change

## What broke

Every `Sensor-Ingestion Release` run on `main` since **2026-07-13** (8 consecutive
failures) died at the cargo-chef dependency-cook step:

```
error: failed to load source for dependency `rumqttc`
  failed to read `/build/crates/local-rumqttc/Cargo.toml`
```

## Root cause

`apps/sensor-ingestion/Dockerfile` stage 3 (builder) ran
`cargo chef cook` with **only `recipe.json` on disk**. The workspace's
`[patch.crates-io]` section points `rumqttc` at the vendored fork
(`crates/local-rumqttc`, introduced 2026-07-13 as RUST-CVE-001), and cargo
must read every patch target's manifest while reconstructing the dependency
graph from the recipe. With the manifests absent, cook failed before any
compilation started — the release image has not been buildable from `main`
since the fork landed.

## Fix (verified with a full local build)

1. **Copy `Cargo.toml`, `Cargo.lock`, and `crates/` before `cargo chef cook`**
   so path-patched dependencies resolve at cook time.
2. **Restore the real manifests and sources after cook**: cargo-chef
   skeletonizes every manifest (including the workspace root) and its
   skeleton does not carry `[workspace.lints]`, which made the final
   `cargo build` fail with `` `workspace.lints` was not defined `` once the
   cook step itself was fixed. The real files are copied back before the
   final build.

`docker build --target builder` completes end-to-end on the droplet with this
ordering; `apps/` is still copied only after cook so the dependency cache
layer stays keyed off manifests rather than application source.

## Closes

SENSOR-HIGH-086
