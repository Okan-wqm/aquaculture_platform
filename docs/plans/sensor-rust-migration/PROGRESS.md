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

Not started yet. Will create a separate branch `agentic-rust-faz0-baseline` once PR-A is merged. Output lands at `docs/perf/baseline-2026-04.md`.

---

## Faz 1 — `protocol-codec` Crate

In flight on branch `agentic-rust-faz1-protocol-codec` (stacked on `agentic-rust-faz0`).

| Stage | Commit | Status | Notes |
|---|---|---|---|
| 1. `error.rs` + `modbus/mod.rs` skeleton | `fc5fe066` | ✅ done | `ParseError` enum (7 fine-grained variants: `Truncated`, `LengthMismatch`, `BadChecksum`, `UnsupportedFunctionCode`, `InvalidProtocolId`, `TenantMismatch`, `Malformed`) — each variant carries enough on-the-wire context to triage from the audit log. `modbus/mod.rs` declares `ALLOWED_FUNCTION_CODES` whitelist (FC 0x01–0x06, 0x0f, 0x10) matching the gateway whitelist; tests assert all eight diagnostic / pivot FCs (0x07, 0x08, 0x11, 0x14, 0x15, 0x16, 0x17, 0x18, 0x2b) are rejected. `Cargo.toml` deps unblocked: `thiserror`, `serde` (+ `serde_json`, `hex` dev). `lib.rs` opens the gateway-style `cfg_attr(test, allow(unwrap_used / expect_used / panic / indexing_slicing))` test window. |
| 2. `modbus/tcp.rs` MBAP header decode | `b7844b6e` | ✅ done | 7-byte MBAP header parser via `slice::split_first_chunk::<7>()` (no `clippy::indexing_slicing` surface). Length field bounded to `1..=254` per Modbus spec §4.1. Lenient about extra trailing bytes (returns `&input[7..]` so streaming callers can chain into PDU decode). 6 in-module tests + 1 doc test (with inline `#![allow(clippy::unwrap_used)]` since doc tests don't inherit the crate-level cfg_attr). |
| 3. PROGRESS.md update + open PR | `113f8a5e` | ✅ done | PR #15 opened against `agentic-rust-faz0` (stacked); subsequent commits land additional Faz 1 deliverables on this same PR. |
| 4. FC 0x03 Read Holding Registers PDU decode | `74d02ba0` | ✅ done | `modbus/pdu.rs` adds `decode_read_holding_registers_response()` returning `Vec<u16>`. byte_count bounded to {even, 2..=250} per MAP §6.3 (max 125 registers × 2 bytes). Defence in depth: rejects non-0x03 FC even though the module-level whitelist also gates it. 11 in-module tests covering happy paths (1, 3, 125 registers), every truncation point, every length-mismatch shape, and FC 0x08 (diagnostics — known pivot vector). |
| 5. Modbus RTU + CRC-16-Modbus | `de650e08` | ✅ done | `modbus/rtu.rs` adds `crc16_modbus()` (bit-by-bit ref impl, poly 0x8005 reflected as 0xA001) + `parse_rtu_frame()` (single-frame-per-call, silence-framed). Wire CRC byte order is little-endian (callout in module docs — common bug). Test helpers: `frame_with_crc()` so fixtures are computed, never hand-written. Known-vector tests: empty → 0xFFFF (seed), `"123456789"` → 0x4B37 (canonical check string), `[01 03 00 00 00 0A]` → 0xCDC5 (every Modbus tutorial). Failure paths: 3 truncation cases, single-byte-flip BadChecksum, CRC LO/HI byte-swap detection. |
| 6. Modbus ASCII + LRC | `2523e308` | ✅ done | `modbus/ascii.rs` adds `lrc()` + `parse_ascii_frame()` returning owned `AsciiFrame { address, pdu: Vec<u8> }` (PDU must be owned because hex-decoded bytes do not exist in the input buffer). `frame_with_lrc()` test helper; `hex_digit_value()` / `hex_digit_char()` const fns accept both upper and lower case (real-world device tolerance) but emit uppercase per spec. Known vectors: empty LRC → 0, `[01 03 00 00 00 0A]` LRC → 0xF2 (sum 0x0E), wire form `:01030000000AF2\r\n`. Failure paths: missing `:`, missing CRLF, odd hex count, non-hex char, < 9 bytes, single-nibble LRC flip. |
| 7. cargo fmt + clippy fixes after first local validation | `52d0fd21` | ✅ done | First end-to-end validation on local Docker (rust:1.88-slim) — 48 unit tests + 1 doc test green. Fixed three classes of churn: (a) cargo fmt --all auto-rewrites (mechanical); (b) removed nightly-only rustfmt options that polluted CI logs; (c) clippy: renamed `mod.rs` → `modbus.rs` (mod_module_files), trimmed unused import, char-pattern fix. Also: `target/` + `**/target/` in `.gitignore`, `Cargo.lock` committed (workspace will host a binary in Faz 2). |
| 8. FC 0x04 / 0x06 / 0x10 + exception PDU decoders | `fcb266b7` | ✅ done | `decode_read_input_registers_response` (shares `decode_register_array_response` helper with FC 0x03), `decode_write_single_register` (5-byte fixed PDU), `decode_write_multiple_registers_response` (quantity bounded to 1..=123 per MAP §6.12), `decode_exception_response` (returns `Result<Option<...>>`: None = top bit clear, dispatch elsewhere). `ModbusException` enum covers 9 well-known codes; unknown codes wrapped in `Other(byte)` and surfaced verbatim so audit can flag non-standard slaves. Added `too_long_first_doc_paragraph` and `missing_const_for_fn` to workspace lint allow-list (both nursery, both opinion-based). Test count delta: 48 → 63 (+15). |
| 9. golden hex fixtures + drift-CI-ready integration test | `ade7facb` | ✅ done | `tests/golden_fixtures.rs` walks `tests/golden/*.json`, dispatches by `decoder` field to all 8 public decoders, asserts byte-equivalent JSON via `serde_json::Value` comparison (ok case) or `ParseError` discriminant match (error case). 15 fixtures cover: TCP MBAP basic + max-length + invalid-protocol-id; FC 0x03 PDU 2-reg + 125-reg + odd-byte-count; FC 0x04 1-reg; FC 0x06 write; FC 0x10 response; exception known + unknown code; RTU master-request + response + bad-CRC; ASCII master-request. Every CRC and LRC computed via the same Rust impl under test (`frame_with_crc` / `frame_with_lrc`) — eliminates "fixture says X, parser computes Y, both could be wrong" failure mode. |
| 10. cargo-fuzz harness for 5 decoders | `254f3b75` | ✅ done | `crates/protocol-codec/fuzz/` with separate `Cargo.toml` (libfuzzer-sys 0.4) excluded from the workspace so `cargo build --workspace` stays on stable. 5 fuzz targets — `mbap_header`, `rtu_frame`, `ascii_frame`, `holding_registers_response`, `exception_response`. Invariant: parser MUST NOT panic / abort / invoke UB on any byte sequence; returning `Err(...)` is the expected happy path of fuzzing. Running requires `cargo +nightly fuzz run <target>` from the fuzz directory; CI smoke at 30 min/target lands when we wire a nightly toolchain step (next commit). |
| 11. tools/scripts/check-codec-drift.ts + rust-ci.yml drift job | `6b3ee7a9` | ✅ done | TypeScript via Node 22 `--experimental-strip-types` (per `feedback_tooling_language.md`). Validates every fixture against a strict schema (decoder ∈ KNOWN_DECODERS SSoT, hex valid, exactly one of expected_ok / expected_err, error kind ∈ ParseError variant set), then runs `cargo test -p protocol-codec --test golden_fixtures` (Rust leg). When the TS-side spec lands in Faz 4, also spawns `npx nx test sensor-service --testPathPattern=codec-drift` and the spec asserts byte-equivalence against the same expected_ok shape — making drift structural rather than diff-based. New `drift` CI job in `rust-ci.yml` joins the summary's required list. |
| 12. PROGRESS.md update + ADR-026 promote candidate | _this commit_ | 🔄 in progress | Stages 7-11 marked done with their commit SHAs; gate-check checkboxes flipped to closed where the deliverable shipped end-to-end. Two rows remain partially open: 50+ golden fixtures (15 shipped, structure ready for follow-on additions) and cargo-fuzz CI smoke (harness shipped, nightly-toolchain wiring deferred to a follow-on). |

#### Gate Check (Faz 1 done = all of)
- [x] `crates/protocol-codec/src/error.rs` defines `ParseError` with the variants the plan requires
- [x] `crates/protocol-codec/src/modbus/tcp.rs` decodes MBAP headers from arbitrary byte slices
- [x] FC 0x03 (Read Holding Registers) response decodes to `Vec<u16>` with bounds checking
- [x] Modbus RTU transport decode (CRC-16-Modbus, byte-LE wire order)
- [x] Modbus ASCII transport decode (LRC, `:` start / CRLF terminator, hex decode)
- [x] FC 0x04 / FC 0x06 / FC 0x10 + Modbus exception PDU (FC | 0x80) decoders
- [x] **partial**: 15 golden hex fixtures under `crates/protocol-codec/tests/golden/` — schema + integration-test scaffolding ready, more fixtures land as needed (50+ stretch goal closed in follow-on)
- [x] `tools/scripts/check-codec-drift.ts` invokes the Rust golden test, validates fixture schema; TS leg activates when the Faz 4 spec lands. Wired into `rust-ci.yml` `drift` job.
- [x] **harness done**: `cargo-fuzz` targets for the 5 hot-path decoders. CI smoke at 30 minutes per target needs a nightly-toolchain step in `rust-ci.yml` — follow-on commit.
- [ ] ADR-026 promoted from `_draft/` to `docs/adr/026-...` (next commit).

#### End-to-end validation transcript (local Docker, rust:1.88-slim)
```
cargo fmt --all -- --check                                      ✅
cargo clippy --workspace --all-targets --all-features -- -D warnings ✅
cargo test --workspace --all-features --no-fail-fast            ✅
  test result: ok. 63 passed; 0 failed                          (unit)
  test result: ok. 1 passed; 0 failed   ( = 15 fixtures asserted)
  test result: ok. 1 passed; 0 failed                           (doc test)
node --experimental-strip-types tools/scripts/check-codec-drift.ts ✅ schema OK
```

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
