# Sensor-Service → Rust Migration — Implementation Log

> Live status; updated at each commit. The plan itself is in `PLAN.md`.

---

## Faz 0 — Setup + Baseline

### PR-A: Repo Scaffold (in flight on branch `agentic-rust-faz0`)

| Stage | Commit | Status | Notes |
|---|---|---|---|
| 1. Cargo workspace + 5 crate skeletons | `8ba86060` | ✅ done | `Cargo.toml` virtual workspace; protocol-codec, tenant-context, event-contracts-rs, nats-client, observability skeletons; rust-toolchain.toml (1.85.0), rustfmt.toml, deny.toml, .cargo/config.toml; workspace lints (`unsafe_code = forbid`, `unwrap_used = deny`, etc.) pinned. sens-api-gateway excluded. |
| 2. Nx custom Cargo executor | `54bfa9df` | ✅ done | `tools/executors/cargo/` package `@aqua/cargo` registered as workspace member. Single executor `run` with schema.json validating command/package/release/features/args. Zero-dep TS implementation (only `node:child_process` + `node:path`). Each crate's `project.json` invokes `@aqua/cargo:run`. |
| 3. `rust-ci.yml` GitHub Actions | `33f7f41f` | ✅ done | fmt + clippy (-D warnings) + test + cargo-deny + rustsec audit-check + musl cross-build matrix (x86_64, aarch64). All third-party actions pinned to commit SHAs verified via `gh api`. Path filter so non-Rust PRs do not pay toolchain install. |
| 4. ADR drafts 025 + 026 | `3d5efd43` | ✅ done | ADR-025 Rust sidecar architecture; ADR-026 protocol-codec SSoT. Both in `docs/adr/_draft/` (proposed). Numbers shifted from 019/020 → 025/026 because edge-agent ADR series already occupies 019-024. |
| 5. Plan + progress doc in repo | _this commit_ | 🔄 in progress | `docs/plans/sensor-rust-migration/{PLAN,PROGRESS}.md`. Plan synced from `/root/.claude/plans/...` with ADR refs corrected. |

#### Gate Check (Faz 0 PR-A done = all of)
- [x] `cargo metadata` lists 5 crate members + excludes sens-api-gateway
- [ ] `nx show projects --tag=scope:rust` returns 5 crates (requires `npm install` to link `@aqua/cargo` workspace)
- [ ] `cargo clippy --workspace -- -D warnings` green (requires Rust toolchain on the host running CI)
- [ ] `cargo test --workspace` green (empty tests, but compiles)
- [ ] `cargo deny check` passes against the pinned policy
- [ ] CI workflow run on `agentic-rust-faz0` passes all jobs

> The trailing 4 gates run in CI (the development host has no Rust toolchain).

#### Open Questions
None for PR-A. Pending decisions are tracked in `PLAN.md` § Açık Karar.

---

### PR-B: Baseline Ölçüm (BLOCKING for Faz 2)

Not started yet. Will create a separate branch `agentic-rust-faz0-baseline` once PR-A is merged. Output lands at `docs/perf/baseline-2026-04.md`.

---

## Faz 1 — `protocol-codec` Crate
Not started.

## Faz 2 — `sensor-ingestion` Sidecar
Not started.

## Faz 3 — sensor-service küçültme
Not started.

## Faz 4 — Konsolidasyon
Not started.

---

## Decision Log

| Date | Decision | Rationale | Rollback path |
|---|---|---|---|
| 2026-04-20 | Adopted ADR-025 sidecar over NAPI-RS / gRPC | NATS already SSoT (ADR-014/015); NAPI shares crash domain; gRPC adds extra mTLS pipeline | Revert PR; sensor-service unchanged |
| 2026-04-20 | Workspace excludes `sens-api-gateway` | Gateway managed by parallel agent on the same `agentic` branch; coordinated path-dep adoption deferred to Faz 4 | Faz 4 PR adjusts `Cargo.toml` members |
| 2026-04-20 | Used commit-SHA pinning for every GitHub Action in `rust-ci.yml` | Memory: SHA verification is a CRITICAL supply-chain class | Replace SHA reference if action is compromised |
| 2026-04-20 | Workspace lints set `unwrap_used = deny`, `expect_used = deny`, `panic = deny`, `indexing_slicing = deny` (matches `sens-api-gateway`) | Architectural-solution tier 1: "Make it impossible" — defensive panics caught at compile time | None — invariant by design |
| 2026-04-20 | rust-toolchain.toml pins `1.85.0` exactly | Matches `sens-api-gateway` `rust-version = "1.85"`; reproducible CI | Bump in lockstep with gateway via separate ADR amendment |
