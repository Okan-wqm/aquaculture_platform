# Edge release build cannot see the workspace root its path dependency inherits from

**Owner agent:** claude · **Cycle:** 2026-10-28-edge-release-cross-workspace-root · **Branch:**
`fix/edge-release-cross-workspace-root`

Tag `agent-v2.0.0-rc.6` (`3a0cce89c`, the first agent version whose release gate passed after the
rodbus removal) failed all three `Build` jobs of `edge-agent-release.yml` in `Build release binary`.
`Create GitHub Release` was skipped, so nothing was built into a release and nothing was published.

## Findings

### PROC-HIGH-067 — the release container has no repository-root manifest for `alarm-core`

- **Where:**
  - `sens-api-gateway/Cargo.toml:23` — `alarm-core = { path = "../crates/alarm-core" }`, added by
    `400fbf234` on 2026-07-13. The crate lives outside the agent project.
  - `crates/alarm-core/Cargo.toml:3-9` — every package field is inherited from the workspace, for
    example `edition.workspace = true`.
  - `Cargo.toml:18-19` — the repository-root workspace excludes `sens-api-gateway`, so the agent is
    its own workspace and the root manifest is not part of its build graph.
  - `.github/workflows/edge-agent-release.yml:244` — the release runs `cross build` from the
    `sens-api-gateway` directory. cross mounts that project and the directories of its path
    dependencies, not the manifest those dependencies inherit from.
- **Effect:** run 40668157738 failed with `failed to load manifest for dependency alarm-core` and
  `error inheriting edition from workspace root manifest's workspace.package.edition`. No agent
  release could build after 2026-07-13: `rc.5` never reached the build step (it stopped at the release
  gate), so `rc.6` was the first tag to try, and no pull-request job builds with cross, so nothing
  showed the break earlier.
- **Reproduction:** with the real `cross 0.2.5` x86_64 container, `cross check -p alarm-core`
  from `sens-api-gateway` exits 101 with the identical error when the repository root is not
  mounted and exits 0 when it is.
- **Rule:** a release path is exercised before a tag exists, and a path dependency that inherits from
  a workspace needs that workspace root inside the container.

## What changed

- `sens-api-gateway/Cross.toml`: `[build.env] volumes = ["CROSS_REPO_ROOT"]`. cross mounts the named
  host directory at the same path, so the root manifest is where `alarm-core` expects it.
- `.github/workflows/edge-agent-release.yml`: the build step exports `CROSS_REPO_ROOT` as the checkout.
- `tests/invariants/edge-release-cross-workspace-root.spec.ts`: while a path dependency of the agent
  inherits from a workspace, the spec fails if the mount or its export is removed. Its helper
  checks are tested on fixture strings, so a removal of either half is detected.
- Version `2.0.0-rc.7` in `sens-api-gateway/Cargo.toml`, both lockfiles and the version pin of
  `sens-api-gateway-ci.yml`: the release workflow requires the tag to equal the Cargo version and
  runs the workflow of the tagged commit, and a pushed tag is never moved, so the fix ships as a new
  tag.

Not changed: the three Cross.toml targets keep their pre-build steps; the `alarm-core` manifest stays
on workspace inheritance (one source for version, edition and lints).

Closes: docs/reviews/claude/2026-10-28-edge-release-cross-workspace-root.md#PROC-HIGH-067
