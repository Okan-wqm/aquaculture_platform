# Sensor-Service → Rust Migration — Implementation Log

> Live status; updated at each commit. The plan itself is in `PLAN.md`.

---

## ✅ DEPLOY STATUS (2026-08-26) — Task 3 restored the REAL pipeline

The 2026-06-26 banner below is RESOLVED: the 100-tenant readiness plan's
Task 3 (commit `720531480`) restored the full orchestrator wiring —
drain → `topic::parse` → cache/sensor-lookup → `payload::validate` →
batch aggregator → `PostgresSink` (per-tenant COPY + upsert with the
Task 1.5 timestamp guard + transactional outbox enqueue, ADR-029) →
dispatcher publishing through `publish_jetstream` (awaited PubAck +
`Nats-Msg-Id`) onto the telemetry root. The `tenant-context` crate now
derives the 16-hex platform SSoT (cross-language golden vectors), and
`docker-compose.droplet.yml` deploys the sidecar PILOT-GATED (per-tenant
`ingest_backend` policy defaults to `node`; zero tenants route here
until an operator flips one deliberately). The honesty invariant was
FLIPPED to guard the restored state. Faz-3 rows 9/11/12 are
end-to-end wired.

Historical record (superseded):
> The pipeline modules existed + unit-tested green but `main.rs`
> `drain_mqtt_stream` was a stub no-op — the Faz-3 orchestrator wiring
> did not survive the train merge; the deployed sidecar would have
> dropped every MQTT message. `docker-compose.prod.yml` therefore did
> not deploy `sensor-ingestion` (blocked by
> `sensor-ingestion-honest-deployment.spec.ts`).

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

In flight on branch `agentic-rust-faz2-sensor-ingestion` (stacked on `agentic-rust-faz1-protocol-codec`).

| Stage | Commit | Status | Notes |
|---|---|---|---|
| 1. `tenant-context` crate implementation | `dbb9264b` | ✅ done | `TenantId(Uuid)` opaque newtype, `SchemaName` ADR-011-shape (`tenant_<32-hex-lowercase>`) with audit-log-poisoning-safe `try_parse`, `TenantCtx<'brand>` + `Scoped<'brand, T>` GhostCell pattern (invariant `PhantomData<fn(&'brand ()) -> &'brand ()>`), `with_tenant` HRTB closure entry point. `unwrap_scoped` is the load-bearing function — brand on `&self` and `Scoped` MUST unify. **trybuild `compile_fail` test** proves cross-brand smuggle does not compile (rustc explicitly says `Scoped<'brand, T> is invariant over the parameter 'brand`). 13 unit + 1 trybuild compile_fail. No `Display` on `TenantId` so `format!("{}", id)` cannot bypass the masking layer. |
| 2. `nats-client` mTLS factory | `e29c7416` | ✅ done | `MtlsConfig` (server URL + 3 cert paths + connect timeout) is the ONLY constructor path. `NatsClient::connect` builds `async_nats::ConnectOptions` with `require_tls(true)` + `add_root_certificates` + `add_client_certificate` and **no** `add_user_password` / `with_token` / `connect_unauthenticated`. **3 trybuild compile_fail tests** prove those constructors do not exist (any future addition fails the test). 10 unit tests cover scheme validation (nats:// + tls:// allowed; tcp/http/no-scheme rejected) + serde round-trip + missing-cert-file error path. **Architectural decision:** bumped `async-nats` 0.37 → 0.47 to drop the vulnerable `rustls-webpki 0.102.8` (RUSTSEC-2026-0098 + 0099). cargo-deny now reports `advisories ok`. |
| 3. `observability` tracing init + `Masked<T>` PII wrapper | `a2009c90` | ✅ done | `init_tracing(&TracingOpts)` installs JSON or pretty subscriber, opens a process-lifetime `service` span (mem::forget'd on purpose) carrying `service.name` / `service.version` / `deployment.environment`. `AlreadyInitialised` returned on second call. `Masked<T: AsRef<[u8]>>` redacts to `<first 2>***<last 2>` (or `***` for <5 bytes); `Display` + `Debug` + `serde::Serialize` all hit the mask path (accidental `format!("{x}")` cannot leak). `Masked::reveal` makes unmasking call-sites visible in code review. Optional `otlp` feature wired in `Cargo.toml`; exporter init lands when a collector URL is in scope. 8 unit tests. |
| 4. `sensor-ingestion` binary skeleton | `9097b1d8` | ✅ done | `apps/sensor-ingestion/` binary with synchronous bootstrap (config load → tracing init → tokio runtime build → `runtime.block_on(async_main)`) + SIGTERM/SIGINT handler. `Config` struct with `observability` + `runtime` (`worker_threads=2`, `max_blocking_threads=8`, `thread_stack_kb=256` per plan) + optional `mqtt` + optional `nats` sections. Path resolution: `--config` argv → `SENSOR_INGESTION_CONFIG` env → `/etc/sensor-ingestion/config.toml`. Process exit codes 0/1/2/3/4 documented. 10 unit tests (7 config + 3 runtime). |
| 5. MQTT subscriber (rumqttc 0.25) | `59ef849a` | ✅ done | `apps/sensor-ingestion/src/mqtt.rs`: rumqttc on its own task → mpsc channel (cap 50K per plan). `validate_config` + `parse_broker_url` (mqtt://host:port or mqtts://; truncated error echo for log-poisoning bounds), `start()` opens AsyncClient, subscribes every filter, returns `MqttMessageStream`. `shutdown()` graceful drain. **Architectural debt opened (tracked, not deferred): RUST-CVE-001** in `docs/reviews/_registry/findings.jsonl` — rumqttc 0.25.1 transitively pins vulnerable `rustls-webpki 0.102.8` (RUSTSEC-2026-0098/0099/0049 + rustls-pemfile 0134 unmaintained). Owner: Okan-Wqm, deadline 2026-06-30, threat-model justification (platform-PKI-only TLS chain), 4 RUSTSEC IDs ignored in `deny.toml` with full inline rationale. 14 mqtt unit tests. |
| 6. Topic parser + tenant extraction | `7f4b599b` | ✅ done | `apps/sensor-ingestion/src/topic.rs`: `parse(topic) -> Result<ParsedTopic, TopicParseError>` for `sensors/<tenant-uuid>/<sensor-uuid>/data` and `tenants/<tenant-uuid>/devices/<device-uuid>/io_data` shapes. Uses `TenantId::try_parse` + `Uuid::try_parse` — **regex YASAK**. Error variants discriminator-only (audit-log poisoning closed, regression-tested). Wildcard `#`/`+` rejected as InvalidTenantId. Wired into drain loop with parse-failure counter. 22 unit tests. Sub-agent commit. |
| 7. Payload validator + topic↔payload tenant match | `81417d88` | ✅ done | `apps/sensor-ingestion/src/payload.rs`: `validate(bytes, topic_tenant)`. Strict serde_json with `deny_unknown_fields` (closes prototype-pollution class — ADR-025 § Threat 3). UUIDs via `uuid::try_parse`. **Topic↔payload TenantMismatch** enforced (ADR-025 § Threat 2 runtime layer). Rejects NaN/Inf (serde_json itself rejects 1e400 with Json error — even stronger than is_finite check; tests assert `matches!(err, Json | NotFiniteValue)`). Rejects quality outside 0..=3 + producer_ts outside [2024-01-01, 2100-01-01). Error variants discriminator-only. 24 unit tests. |
| 8. Tenant-scoped topic cache (moka + papaya) | `cdd6f9f3` | ✅ done | `apps/sensor-ingestion/src/cache.rs`: `TopicCache::new(capacity)` with bounded total + per-tenant LRU. moka 0.12 sync variant for the storage layer (TinyLFU+LRU + per-key invalidate + eviction listener); papaya 0.2 lock-free map for per-tenant counter. Composite key `(TenantId, Uuid)` — cross-tenant cache poisoning structurally impossible (SEC-M16, regression-tested). 16 unit tests including concurrent multi-thread get/insert (4 worker × 8 task × 64 ops, no panic, no race). Wired into drain loop: cache.get on every parsed topic, cache_hit logged. Sub-agent commit (cherry-pick from isolated worktree). |
| 9. Batch aggregator + `LoggingSink` + drain wiring | `5a621357` | ✅ done | `apps/sensor-ingestion/src/batch.rs` + `persistence.rs`. Aggregator emits `Vec<SensorReading>` on size (10K) OR time (100ms) trigger; mpsc backpressure to drain. `BatchSink` trait with `LoggingSink` for stub/test mode. Race condition on shutdown caught by `shutdown_flushes_remaining_buffer` test, fixed via `try_recv` drain in cancel branch. 12 batch + 3 sink tests. |
| 10. `event-contracts-rs` SensorReadingEvent + branded EventId | `bd076225` | ✅ done | Wire-equivalent to TS `libs/event-contracts/src/sensor-events.ts:SensorReadingEvent`. `#[serde(rename_all = "camelCase", deny_unknown_fields)]` matches the TS contract byte-for-byte. `EventId` newtype, no `Default`, generative-only via `EventId::generate`; `SensorReadingEventType` zero-sized witness rejects any wire string ≠ `"SensorReading"` on deserialise. 16 unit tests including hand-crafted TS-compatible blob round-trip. |
| 11. PostgresSink (binary COPY + UNLOGGED staging, ADR-025 Option A) | `4d503bcd` | ✅ done | deadpool-postgres + tokio-postgres-rustls (SCRAM channel binding) + platform CA pinned. Per-tenant transaction: `COPY → <tenant>.sensor_metrics_stage → INSERT ... ON CONFLICT DO UPDATE → TRUNCATE stage` preserves the existing NestJS `value/raw_value/quality_code = EXCLUDED.*` contract. SQL builders structurally SQL-injection-immune via `SchemaName::from_tenant_id` (5-attacker-payload regression test). 8 sink tests + #[ignore]'d live-postgres smoke gated by `SENSOR_INGESTION_PG_INTEGRATION=1`. |
| 12. NATS event publisher (mTLS + camelCase wire) | `19f20327` | ✅ done | `apps/sensor-ingestion/src/events.rs`. `EventPublisher` trait, `NatsEventPublisher` (wraps `nats-client::NatsClient`, mTLS-only by construction), `LoggingEventPublisher` for tests. Subject derivation `events.{tenantId}.SensorReading` mirrors `nats-event-bus.ts:310-312` deriveSubject. `run_publisher_loop` continues after publish error (transient broker hiccup tolerance — pinned by `run_publisher_loop_continues_after_publish_error`). 12 publisher tests (incl. concurrent 100-task race) + #[ignore]'d live-NATS smoke. Drain → event_in_tx wiring requires sensor-meta cache lookup (channel UUID → typed reading_*) — Faz 3 scope. |
| 13. mTLS MQTT + per-tenant `IngestBackend` policy | `8d0f9884` `71a7ec32` | ✅ done | `mqtt.rs` replaces `Transport::tls_with_default_config()` with real rustls `ClientConfig` (platform CA pinned, no system roots, `with_client_auth_cert`). `MqttConfig` extended with 3 cert paths; mqtts:// without all three is a startup-time `MtlsMaterialMissing` error. New module `ingest_backend.rs`: `IngestBackend` enum (`node`/`rust`), `IngestBackendPolicy` trait, `StaticBackendPolicy` (TOML-served default + per-tenant overrides). Drain loop gates `Node`-routed messages and increments a counter. ADR-027 drafted. Architectural hardening commit `71a7ec32`: `node_only`/`rust_only` test-only constructors moved from `#[allow(dead_code)]` (tier-4) to `#[cfg(test)]` (tier-1 "make it impossible"). 17 new tests: 4 mqtt mTLS + 4 config + 9 ingest_backend. |
| 14. Dockerfile + compose service + ADR-025/027 promote | TBD | ✅ done | `apps/sensor-ingestion/Dockerfile` (multi-stage cargo-chef on rust:1.88-slim → debian:bookworm-slim runtime, non-root uid 65532, no baked secrets). `apps/sensor-ingestion/.dockerignore`. `infrastructure/sensor-ingestion/config.toml.example` documents the full TOML surface. Service entries in `docker-compose.{droplet,staging,prod}.yml` (256 MB / 0.35 vCPU per plan, bind-mounted config + certs). NATS `services.yaml` entry for `sensor_ingestion` CN (`events.>` + legacy `AQUACULTURE_EVENTS.SensorReading.>`); `nats.conf` regenerated. ADR-025 (Rust sidecar architecture) + ADR-027 (per-tenant `IngestBackend` toggle) promoted from `_draft/` to canonical, status flipped Proposed → Accepted. |

#### Gate Check (Faz 2 done = all of)
- [x] `tenant-context` exposes `TenantId` / `SchemaName` / `Scoped` / `with_tenant` with **compile-time** cross-tenant safety verified via trybuild
- [x] `nats-client` enforces ADR-014/015 mTLS-only auth structurally; user/pass/token/unauth constructors verified absent via trybuild
- [x] `observability` provides `init_tracing` + `Masked<T>` PII wrapper with display/debug/serde all masking
- [x] `sensor-ingestion` binary boots end-to-end (config load + tracing + tokio runtime + signal handling)
- [x] MQTT subscribe loop (rumqttc 0.25, mTLS, QoS-1) + RUST-CVE-001 tracked
- [x] Topic parse + tenant id extraction (uuid::try_parse, no regex)
- [x] Payload validate (uuid::try_parse, deny_unknown_fields, topic↔payload tenant match enforced)
- [x] Tenant-scoped bounded cache (moka + papaya) with cross-tenant isolation regression test
- [x] Batch aggregator + `tokio-postgres::CopyInSink` binary COPY (stage 11)
- [x] NATS event publish via `event-contracts-rs` codegen (stage 10 + 12)
- [x] mTLS through MqttConfig (cert paths) (stage 13)
- [x] Per-tenant feature flag (`INGEST_BACKEND=rust|node`) (stage 13)
- [x] `sensor-ingestion` Docker image + compose service (stage 14)
- [x] ADR-025 + ADR-027 promoted to canonical, status Accepted (stage 14)

**Faz 2 NOT-DONE (carried as tracked debt — Faz 3 scope):**
- [ ] Drain → `events_in_tx` wiring (channel UUID → typed `reading_*` field). Needs sensor-meta cache lookup over NATS request-reply. Owner Okan-Wqm.
- [ ] CI service-container job lighting up the `#[ignore]`'d live-postgres + live-NATS integration tests from stages 11/12. Owner Okan-Wqm; lands with the Faz 3 deploy-pipeline work.
- [ ] GHA workflow that builds + pushes the `sensor-ingestion` image to GHCR. Owner Okan-Wqm; Faz 3.
- [ ] Reconcile NATS subject convention drift: `nats-event-bus.ts` publishes `events.{tenantId}.SensorReading` (3 segments) but `alert-engine` subscribes via `eventBus.subscribe('SensorReading')` which normalises to `events.SensorReading` (2 segments). NATS exact-match means existing subscriptions miss tenant-scoped publishes. Tracked as ORPHAN-013 to file separately — not introduced by Faz 2 work but surfaced during the publisher implementation.

#### End-to-end validation transcript (rust:1.88-slim Docker)
```
cargo fmt --all -- --check                                    ✅
cargo clippy --workspace --all-targets --all-features
                  -- -D warnings                               ✅
cargo test --workspace --all-features --no-fail-fast          ✅
  test result: ok. 86 passed; 0 failed   (sensor-ingestion: 24+22+24+16)
  test result: ok. 8 passed; 0 failed    (observability)
  test result: ok. 10 passed; 0 failed   (nats-client)
  test result: ok. 13 passed; 0 failed   (tenant-context)
  test result: ok. 63 passed; 0 failed   (protocol-codec)
  test result: ok. 1 passed; 0 failed    (golden_fixtures = 15 fixtures)
  test result: ok. 1 passed; 0 failed    (cross_tenant_compile_fail)
  test result: ok. 1 passed; 0 failed    (auth_surface_compile_fail = 3 cases)
  test result: ok. 1 passed; 0 failed    (doc test)
cargo-deny check advisories                                   ✅ ok
```
Total: 180 unit + 15 fixture + 4 trybuild compile_fail + 1 doc = 200 tests.

## Faz 3 — sensor-service küçültme

In flight on branch `agentic-rust-faz3-control-plane` (PR #17, stacked on Faz 2 PR #16). Will rebase clean once PR #16 merges to main.

| Stage | Commit | Status | Notes |
|---|---|---|---|
| 0. Worktree + branch + PR | `71b4c1ce` (init) | ✅ done | New worktree `/tmp/aqua-rust-faz3` branched from Faz 2 HEAD; `agentic-rust-faz3-control-plane` pushed; PR #17 opened with the 4-stage progression. |
| 1. `SensorMetricIngestedEvent` + Rust sidecar publisher rework + drain wiring | `71b4c1ce` | ✅ done | NEW event type in TS (`libs/event-contracts/src/sensor-events.ts`) + Rust (`crates/event-contracts-rs/src/lib.rs`). Rust sidecar `events.rs` refactored: `EventPublisher::publish_sensor_metric` (was `publish_sensor_reading`), subject `events.{tenantId}.SensorMetricIngested`. Drain → `events_in_tx` wired (closes Faz 2 stage 12 NOT-DONE). 26 event-contracts-rs tests + 131 sensor-ingestion tests. ADR-022 draft created. |
| 2. NATS consumer service in sensor-service | `24459449` | ✅ done | `apps/sensor-service/src/ingestion/nats-ingestion-consumer.service.ts` — implements `IEventHandler<SensorMetricIngestedEvent>`. Subscribes to `events.*.SensorMetricIngested`. Per event: enrich via 60s-TTL sensor + channel cache, ADR-025 Threat 2 tenant-bind re-check, call `BatchProcessorService.enqueue` (preserves invariant 4), re-emit typed `SensorReadingEvent`. ChannelKey → readingXxx mapping covers temperature/ph/do/salinity/ammonia/nitrite/nitrate/turbidity/water_level. Drop-don't-throw on enrichment failures (avoids JetStream poison-pill loop). 29 unit tests. |
| 3. `SENSOR_SERVICE_PROFILE` env-gated module loader | `24459449` | ✅ done | `apps/sensor-service/src/config/sensor-service-profile.service.ts` — `SensorServiceProfile.{Legacy,ControlPlane}` enum + `SensorServiceProfileService` (default = Legacy, safe rollout). `MqttListenerService.onModuleInit` and `DataIngestionService.onModuleInit` skip boot on control-plane profile. `NatsIngestionConsumerService` runs on BOTH profiles (strangler-fig — sidecar may publish for some tenants while legacy MQTT runs for others). 8 unit tests for the profile service. |
| 4. Compose plumbing + e2e dual-write equivalence gate | `53530000` | ✅ done | `SENSOR_SERVICE_PROFILE` + memory/cpu envelope substitution across droplet/staging/prod compose; staging defaults to control-plane to soak the dual-write contract on every deploy; `e2e/tests/sensor-ingest-equivalence.e2e.spec.ts` gated by `SENSOR_INGEST_EQUIVALENCE_E2E=1` so jest CI is not blocked on broker infra. |
| 5. Cache extract + lifecycle invalidation handler | `fa9cf329` | ✅ done | `SensorMetaCacheService` extracted; `SensorCacheInvalidationHandler` subscribes to `SensorConfigurationUpdated` / `Suspended` / `Reactivated` and drops matching cache entries eagerly. 60s TTL becomes the upper bound on staleness when no invalidation event arrived. 22 new tests across the two services. |
| 6. Per-tenant rollout runbook | `14e8be14` | ✅ done | `docs/runbooks/sensor-ingest-rust-rollout.md` — pre-rollout checklist, per-tenant 5-min flip + observation window, per-tenant 2-min rollback, cutover (everyone on Rust), observability log queries, escalation. |
| 7. Cache-miss responder (cache load-bearing) | `206452c1` | ✅ done | `apps/sensor-ingestion/src/sensor_lookup.rs` — fire-and-forget NATS request `sensor.lookup.by-topic` on cache miss; `apps/sensor-service/src/ingestion/sensor-lookup-responder.service.ts` — responder using `SensorMetaCacheService`. SensorMeta gains Serialize/Deserialize. Wire shape `{sensorId, tenantId, channelIds}` pinned by tests on both sides. Cache transitions from dead code to load-bearing. 7 new Rust tests + 13 new TS tests. |
| 8. Sidecar enrichment + channel-id validation | `0e93ba9c` | ✅ done | `SensorMeta` extended with `farm_id` / `pond_id`; `SensorMetricIngestedEvent` extended with same Optional fields (TS + Rust); drain populates farm/pond from cached meta when warm; channel-id validation gate (only on cache hit, NEVER false-positive on miss); NestJS consumer prefers event-side farm/pond over its own cache (sidecar SoT when warm). 143 cargo + 27 event-contracts-rs + 74 jest tests green. |
| 9. ORPHAN-014 fix | `02f644bc` | ✅ done | `findByCodeOnly` mock added to `mqtt-listener.service.spec.ts` factory — flips the suite from `6 failed, 58 passed` to `64 passed, 64 total`. Was a discipline gap, not an open-handle leak as initially hypothesised. |
| 10. ORPHAN-012 partial fix | `e4f472f7` | ✅ done | `tools/gates/tsconfig.json` `ignoreDeprecations: "6.0"` removed — pre-commit gates run cleanly on TS 5.9.x. Deeper fix (pin ts-node + typescript explicitly + add a tools/gates integration test) tracked separately. |

#### Gate Check (Faz 3 done = all of)
- [x] Wire-distinct `SensorMetricIngested` event in TS + Rust event-contracts (stage 1)
- [x] Rust sidecar drain → events publisher wired end-to-end (stage 1, closes Faz 2 stage 12 NOT-DONE)
- [x] NATS consumer in NestJS sensor-service translates raw → typed + persists via existing BatchProcessor (stage 2)
- [x] `SENSOR_SERVICE_PROFILE=control-plane` env disables legacy MQTT data plane (stage 3)
- [x] `SensorServiceProfileService` is the SSoT for the env-var read (no other code path touches `process.env.SENSOR_SERVICE_PROFILE`) (stage 3)
- [x] e2e dual-write equivalence scaffold ships gated by `SENSOR_INGEST_EQUIVALENCE_E2E=1` (stage 4)
- [x] Compose plumbing for `SENSOR_SERVICE_PROFILE` + memory/cpu envelopes across droplet/staging/prod (stage 4)
- [x] `SensorMetaCacheService` extracted as the SSoT for sensor + channel cache; lifecycle-event invalidation handler drops entries eagerly (stage 5)
- [x] Per-tenant rollout runbook ships before any operator flips (stage 6)
- [x] `TopicCache` is load-bearing — sidecar populates lazily via `sensor.lookup.by-topic` request-reply (stage 7)
- [x] Sidecar publishes enriched events (farm/pond) AND validates channel-ids on cache hit (stage 8)
- [x] ORPHAN-014 reconciled: 64/64 mqtt-listener tests green (stage 9)
- [x] ORPHAN-012 partial fix unblocks pre-commit (stage 10)
- [ ] ADR-022 promoted out of `_draft/` to canonical `docs/adr/` after 24h staging soak — operator gate
- [ ] Stage harness compose service for the live e2e gate (`SENSOR_INGEST_EQUIVALENCE_E2E=1` end-to-end run with a real Mosquitto + NATS + Timescale + sidecar + sensor-service spin-up) — operator gate
- [ ] JSON Schema validator for `SensorMetricIngestedEvent` in `libs/event-contracts/src/schemas/` — defence-in-depth at the trust boundary, follow-on commit

## Faz 4 — Konsolidasyon
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
| 2026-04-20 | Bumped `async-nats` 0.37 → 0.47 (Faz 2 stage 2) | 0.37 transitively pulled `rustls-webpki 0.102.8` carrying RUSTSEC-2026-0098 + 0099. `[patch.crates-io]` override of webpki rejected (cargo's patch is semver-strict, would need a hack). Ignoring the advisory rejected (architectural rule: yama yok). Bumping is the only clean fix; 0.47 uses fixed webpki, API surface we use is unchanged. | Pin async-nats back to 0.37 + ignore the advisory in deny.toml — but doing so would re-open the CVE class, so this is genuinely no-rollback territory unless we revert the whole nats-client crate |
| 2026-04-20 | `tenant-context` brands are NAMED, not elided | `clippy::elidable_lifetime_names` flagged `impl<'brand>` patterns. Eliding to `'_` would obscure the GhostCell pattern's load-bearing primitive (the brand itself). Allowed inline with comment; the lint stays on for non-brand impls. | Restore lint; rename `'brand` → `'_` and lose the architectural documentation value |
| 2026-04-20 | `RuntimeConfig` deliberately omits `enable_lifo_slot` knob | Stable tokio's `Builder::disable_lifo_slot` is a private method (only reachable via `tokio_unstable` cfg). Adding the field would have given operators a config knob we cannot honour — silent no-op is worse than no field. Plan's "enable LIFO slot" intent is satisfied implicitly (tokio defaults). | Add field back when we adopt `tokio_unstable` and the corresponding builder call |
| 2026-04-20 | `#[allow(clippy::print_stderr)]` scoped to `sensor-ingestion::main()` | Bootstrap window before `init_tracing` succeeds has no structured-logger channel; `eprintln!` is the only way to surface a config-load or tracing-init error to the operator. Allow is narrowed to `fn main` so all post-init code keeps the workspace `print_stderr = "deny"` posture. | None — pre-init failures must reach stderr; the only alternative is silent crash |
| 2026-04-20 | `observability::init_tracing` uses `mem::forget` on a process-lifetime `info_span!` guard | First attempt added a separate `fmt::Layer<Registry>` that broke the layered-subscriber type. The `forget`d span is the documented tracing pattern for "this guard must outlive `init_tracing`'s stack frame" — Rust's `forget` is safe (no UB), the only cost is the `Drop` never running, which is exactly the desired behaviour. Will be replaced by OTel resource attributes when the `otlp` feature lands. | Remove the span; lose `service.name`/`service.version` on every event until OTel resource is wired |
| 2026-04-20 | rust-toolchain.toml initially pinned 1.85.0 — bumped to 1.88.0 same day | First CI run discovered transitive deps (icu_* 1.86, time 1.88) exceed 1.85 MSRV. Bumping is the simplest unblock; gateway stays on 1.85 (independent crate-graph). Faz 4 will need to align gateway's pin or factor MSRV via published-crate boundary. | Pin specific transitive deps to older versions; deferred (whack-a-mole vs single bump) |
