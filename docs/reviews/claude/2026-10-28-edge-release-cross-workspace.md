# Edge release cross build cannot resolve the root workspace for a path dependency

**Owner agent:** claude · **Cycle:** 2026-10-28-edge-release-cross-workspace · **Branch:**
`claude/edge-release-cross-workspace`

`edge-agent-release.yml` builds the agent with `cross build` for three targets. Tag
`agent-v2.0.0-rc.6` (`3a0cce89c`) passed the release gate and then failed
`Build release binary` on all three targets (run 40668157738); no binary was built and no
release was created.

## Findings

### PROC-HIGH-067 — the release cross build has been unbuildable since alarm-core joined

- **Where:**
  - `sens-api-gateway/Cargo.toml:23` — `alarm-core = { path = "../crates/alarm-core" }`,
    added by `400fbf234` (2026-07-13). The crate declares `edition.workspace = true`,
    `version.workspace = true` and `rust-version.workspace = true`, so it needs the
    repository-root `Cargo.toml` to resolve them. The gateway itself is excluded from the
    root workspace (`exclude = ["sens-api-gateway"]`) and is its own workspace root.
  - `sens-api-gateway/Cross.toml:14` — `[build.env]` only passes environment variables
    through. cross mounts the gateway and each path dependency; the root manifest is not
    mounted, so cargo in the container reports `error inheriting edition from workspace
    root manifest's workspace.package.edition` / `failed to find a workspace root`.
  - `.github/workflows/sens-api-gateway-ci.yml:119` — the release-profile gate is a
    host-native `cargo check`; no pull-request workflow ran `cross build`. The last agent
    release (`agent-v2.0.0-rc4`, 2026-05-24) predates alarm-core, so the break first showed
    on the rc.6 tag.
- **Rule:** a release build path is exercised by a pull-request job before a tag depends
  on it, and every directory a path dependency needs to resolve its workspace is visible
  to the cross container.

## Fix

- **Make it automatic:** `Cross.toml` `[build.env] volumes = ["CROSS_REPO_ROOT"]` mounts
  the checkout at the same path inside the container; the release workflow sets
  `CROSS_REPO_ROOT` to `github.workspace` for the cross invocation.
- **Make it detectable:** the `cross-build-smoke` job in `sens-api-gateway-ci.yml` runs
  the release invocation (`cross build --release --target x86_64-unknown-linux-gnu
  --features scada-display`) on every pull request that touches the gateway, its path
  dependencies (`crates/alarm-core`, `crates/local-rumqttc`) or the root `Cargo.toml`;
  the three targets share the mount logic. The job is part of the gateway CI summary.
- **Release path:** the version moves to `2.0.0-rc.7`. The release workflow builds the
  commit a tag points at; `agent-v2.0.0-rc.5` and `agent-v2.0.0-rc.6` stay where they are.

## Not changed

The aarch64 and armv7 targets are not built in the pull-request job; they run in the
tag-only release workflow. The smoke job covers the mount and workspace resolution they
share, and the first tag build of those targets remains the proof for their own toolchain
steps.
