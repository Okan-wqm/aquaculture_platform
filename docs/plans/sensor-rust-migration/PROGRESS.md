# Sensor-Service → Rust Migration — Implementation Log

> Live status; updated at each commit. The plan itself is in `PLAN.md`.

---

## Faz 0 — Setup + Baseline

### PR-A: Repo Scaffold (in flight on branch `agentic-rust-faz0`)

| Stage | Commit | Status | Notes |
|---|---|---|---|
| 1. Cargo workspace + 5 crate skeletons | `8ba86060` | ✅ done | `Cargo.toml` virtual workspace; protocol-codec, tenant-context, event-contracts-rs, nats-client, observability skeletons; rust-toolchain.toml (initially 1.85.0, bumped to 1.88.0 in stage 6), rustfmt.toml, deny.toml, .cargo/config.toml; workspace lints (`unsafe_code = forbid`, `unwrap_used = deny`, etc.) pinned. sens-api-gateway excluded. |
| 2. Nx custom Cargo executor | `54bfa9df` | ✅ done | `tools/executors/cargo/` package `@aqua/cargo` registered as workspace member. Single executor `run` with schema.json validating command/package/release/features/args. Zero-dep TS implementation (only `node:child_process` + `node:path`). Each crate's `project.json` invokes `@aqua/cargo:run`. |
| 3. `rust-ci.yml` GitHub Actions | `33f7f41f` | ✅ done | fmt + clippy (-D warnings) + test + cargo-deny + rustsec audit-check + musl cross-build matrix (x86_64, aarch64). All third-party actions pinned to commit SHAs verified via `gh api`. Path filter so non-Rust PRs do not pay toolchain install. |
| 4. ADR drafts 025 + 026 | `3d5efd43` | ✅ done | ADR-025 Rust sidecar architecture; ADR-026 protocol-codec SSoT. Both in `docs/adr/_draft/` (proposed). Numbers shifted from 019/020 → 025/026 because edge-agent ADR series already occupies 019-024. |
| 5. Plan + progress doc in repo | `154b53c7` | ✅ done | `docs/plans/sensor-rust-migration/{PLAN,PROGRESS}.md`. Plan synced from `/root/.claude/plans/...` with ADR refs corrected. |
| 6. CI fix-up: toolchain 1.88, deny.toml `[bans]` array | `ec280fc6` | ✅ done | First CI run on PR #13 surfaced 3 issues: (a) transitive deps (`icu_*` 1.86, `time` 1.88) exceed our 1.85 toolchain pin; (b) `[bans.deny]` was a TOML table, cargo-deny expects an inline array `deny = [...]`; (c) cargo-audit install fails on 1.85 (root cause = a). Fix: bumped `rust-toolchain.toml`, `Cargo.toml` workspace.package, all 5 toolchain refs in `rust-ci.yml`, and `rust-version` arg to cargo-deny-action — all to 1.88.0. Replaced `[bans.deny]` table with proper `deny = [...]` inline array, explicitly denying `openssl`, `openssl-sys`, `native-tls`. |
| 7. clippy doc_markdown allow | `ee0ce338` | ✅ done | Second CI run failed clippy (-D warnings) on prose proper nouns (SSoT, NestJS, FPort, TS) flagged by `clippy::doc_markdown`. Allowed the lint workspace-wide in `Cargo.toml` (rest of pedantic + nursery still enabled). |
| 8. Strip unused crate deps + audit/cross-build hardening | `078a5785` | ✅ done | Second CI run failed three more checks. Root causes + fixes: (a) **cargo-deny** flagged `rustls-webpki 0.102.8` (RUSTSEC-2026-0099 + GHSA-965h-392x-2mh5) pulled transitively by `async-nats` from skeleton `nats-client` — fix: stripped all unused `[dependencies]` from every Faz-0 skeleton crate; deps will be added when actual code lands in Faz 1/2. (b) **cargo-audit** failed because `rustsec/audit-check` builds cargo-audit from source, hitting `smol_str@0.3.6 requires rustc 1.89` — fix: switched to `taiki-e/install-action` with precompiled `cargo-audit` binary (no MSRV treadmill). (c) **aarch64 cross-build** failed because messense's GitHub-release tarball returned non-gzip data — fix: removed aarch64 from the matrix until Faz 2 reintroduces it via the `cross` tool (cross-rs/cross). |
| 9. cargo-deny: ignore licenses for workspace-private crates | `4a8e8d7a` | ✅ done | Third CI run reduced the failure surface to one job: `cargo-deny licenses FAILED`. The 5 workspace crates carry `license = "Proprietary"` (legitimately — `publish = false`, first-party only), but "Proprietary" is not a valid SPDX expression and cargo-deny treated them as unlicensed. Fix: added `private = { ignore = true }` to `[licenses]` in `deny.toml`. cargo-deny now skips SPDX enforcement for workspace-private crates (publish = false) while still enforcing the allow-list against every third-party transitive dep. Inline comment in deny.toml explains the why. |
| 10. PROGRESS.md finalize — all gates green | _this commit_ | 🔄 in progress | Mark stage 9 done, flip every Faz 0 PR-A gate to green, freeze the PR-A summary so the next reviewer sees the end-state at a glance. |

#### Gate Check (Faz 0 PR-A done = all of)
- [x] `cargo metadata` lists 5 crate members + excludes sens-api-gateway
- [x] `nx show projects --tag=scope:rust` returns 5 crates (requires `npm install` to link `@aqua/cargo` workspace) — verified on CI runner (workspace member resolved via `tools/executors/cargo`)
- [x] `cargo clippy --workspace -- -D warnings` green — CI run 24663472810 job 72115062380
- [x] `cargo test --workspace` green (empty tests, but compiles) — CI run 24663472810 job 72115062326
- [x] `cargo deny check` passes (advisories + bans + licenses + sources) — CI run 24663472810 job 72115062331
- [x] `cargo-audit` passes (RustSec advisory DB) — CI run 24663472810 job 72115062312
- [x] `cargo build --release --target x86_64-unknown-linux-musl` passes — CI run 24663472810 job 72115062333
- [x] CI workflow run on `agentic-rust-faz0` passes all 7 jobs (clippy / fmt / test / audit / deny / cross-build / summary) — green at SHA `4a8e8d7a`

#### PR-A summary (final)

  Branch:    agentic-rust-faz0  (off origin/agentic, 10 commits)
  PR:        https://github.com/Okan-wqm/aquaculture_platform/pull/13
  CI run:    https://github.com/Okan-wqm/aquaculture_platform/actions/runs/24663472810  (all green)
  Net diff:  +1110 / -90 lines across 31 files
  Touched:   crates/ (new), tools/executors/cargo/ (new), .github/workflows/rust-ci.yml (new),
             docs/adr/_draft/{025,026}-*.md (new), docs/plans/sensor-rust-migration/{PLAN,PROGRESS}.md (new),
             Cargo.toml + rust-toolchain.toml + rustfmt.toml + deny.toml + .cargo/config.toml (new),
             package.json (workspaces array gained tools/executors/cargo)
  Untouched: every existing app, lib, sens-api-gateway, every existing test or workflow.

  Ready for: CODEOWNERS approve -> squash-merge into agentic.

#### Open Questions
None for PR-A. Pending decisions are tracked in `PLAN.md` § Açık Karar.

---

### PR-B: Baseline Ölçüm (BLOCKING for Faz 2)

In flight on branch `agentic-rust-faz0b-baseline` (stacked on `agentic-rust-faz0`).

| Stage | Commit | Status | Notes |
|---|---|---|---|
| 1. `tools/scripts/perf-baseline.ts` load generator | _this commit_ | 🔄 in progress | Single-process Node 22 type-stripping MQTT publisher. Paced via `process.hrtime.bigint()` — no `setInterval` drift. Synthesises 50 tenants × 200 sensors × 10 channels (configurable). Embeds `producerTs` so latency is measurable from the DB. Optional Prometheus snapshot before/after. Outputs JSON report under `docs/perf/runs/` (gitignored — markdown summary is the durable artefact). |
| 2. `docs/perf/baseline-2026-04.md` runbook + result template | _this commit_ | 🔄 in progress | Locks the measurement protocol (rig, knobs, run order, latency SQL, GC capture, container-stats capture). Result table is **TBD** until first execution; karar-gate verdict matrix is wired in so the operator pastes numbers and the doc tells them whether Faz 2 priority changes. |
| 3. `.gitignore` entry for `docs/perf/runs/` | _this commit_ | 🔄 in progress | Per-run JSON reports must not pollute git history. |

#### Gate Check (Faz 0 PR-B done = all of)
- [x] `tools/scripts/perf-baseline.ts` exists and runs end-to-end against a localhost broker (smoke verified at write-time; full integration run is operator-side once the stack is up)
- [x] `docs/perf/baseline-2026-04.md` documents the protocol so any operator can reproduce a run from a clean checkout
- [ ] At least one full run captured for each of 1K / 5K / 10K / 15K msg/s tiers (BLOCKING for Faz 2 — operator-side; PR-B can merge before this row is checked, but Faz 2 cannot start)
- [ ] Karar-gate verdict recorded in `baseline-2026-04.md` § Karar gate verdict (BLOCKING — same reason)

> Stages 1-3 land the **tooling**. The numbered tier runs and the verdict
> are operator deliverables that follow merge — they are tracked here so
> nothing slips.

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
| 2026-04-20 | rust-toolchain.toml initially pinned 1.85.0 — bumped to 1.88.0 same day | First CI run discovered transitive deps (icu_* 1.86, time 1.88) exceed 1.85 MSRV. Bumping is the simplest unblock; gateway stays on 1.85 (independent crate-graph). Faz 4 will need to align gateway's pin or factor MSRV via published-crate boundary. | Pin specific transitive deps to older versions; deferred (whack-a-mole vs single bump) |
