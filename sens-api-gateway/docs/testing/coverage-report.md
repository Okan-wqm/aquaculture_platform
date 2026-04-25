# Coverage Report — `sens-api-gateway`

**Source-of-Truth:** HEAD `3413db47`, v1.6.0, 2026-04-24.

## 1. Headline

- **Measured line coverage: NEVER MEASURED.** `cargo tarpaulin` and `cargo llvm-cov` have not been executed against this crate. The 1% figure below is a **volume proxy** (test-file / production-file count ratio), not a line-coverage reading.
- **Test volume / production volume ratio: ≈ 1%.**
  - Production `.rs` files in `src/`: 108.
  - Integration test files in `tests/`: 2 (both `#[ignore]`d).
  - Unit `#[test]` attribute count: 814 (inlined per module under `#[cfg(test)]`).
  - The ratio of integration test files to production files is ~1.8%. The unit-test density per production file is higher (88 of 108 files carry `#[cfg(test)]` blocks) but **none** of this translates to a measured line-coverage number until a coverage tool runs.

## 2. Target coverage

| Code class | Target line coverage | Rationale |
|---|---|---|
| New code (added after 2026-05-01) | **80%** | Industry-standard gate for new Rust code. Enforced via `cargo tarpaulin --fail-under 80` planned for Q3 CI. |
| Legacy code (pre-2026-05-01) | **practical floor 50%** | Raising legacy coverage requires refactoring to testable seams, which is scheduled in the Q3–Q4 roadmap. 50% is the explicit floor; below that a module is an active finding. |
| Safety-critical surfaces (`safe_state_v2`, `alarm_engine`, `command_envelope`, `audit`, `mtls`, `authz`, `updater`) | **90%** | These modules are on the IEC 62443 SL2 certification critical path. |

## 3. Planned measurement cadence

| Phase | Milestone | Action |
|---|---|---|
| Q3 2026 (Week 1) | Wire `cargo tarpaulin` locally | One-shot run, baseline snapshot, published under `docs/testing/coverage-history/2026-Q3.md`. |
| Q3 2026 (Week 2) | CI integration | Add tarpaulin job to `rust-ci.yml`; soft gate (warn only). |
| Q3 2026 (end) | **40% measured line coverage** | Hard gate — overall crate line coverage at least 40%. |
| Q4 2026 | **60% measured line coverage** | Hard gate escalated to 60%. |
| 2027 | **80% for new code, 50% floor for legacy** | Final target posture. |

## 4. Per-module posture (from unit-test inventory)

Consolidated from [unit-tests.md](./unit-tests.md). These are **unit-test counts**, not line coverage. Where the count is low (< 5 `#[test]` per file), the line coverage is expected to be low too; where the count is high (> 15), line coverage is expected to be in the 60–90% band for the module's public surface. All numbers to be verified against tarpaulin once it runs.

| Surface | Module count | Aggregate `#[test]` | Expected line coverage (Q3 prediction) |
|---|---|---|---|
| Security-critical (command envelope + audit + mTLS + authz + updater + keystore + config integrity) | 22 files | 281 | Expected 70–85% once measured |
| PLC programming (Modbus, S7, OPC UA, EtherNet/IP, ADS, CoDeSys) | 7 files | 101 | Expected 50–70% |
| Scripting (function blocks, engine, limits, conflict, triggers, actions, persistence, storage, parallel, context, fb_registry, mod) | 16 files | 142 | Expected 60–75% |
| LoRaWAN stack | 7 files | 60 | Expected 60–75% |
| Runtime safety (clock, shutdown_phase, retained_msg) | 3 files | 27 | Expected 70–85% |
| Resilience (rate limiter, circuit breaker) | 2 files | 12 | Expected 60–70% |
| SCADA (server, db, types, deploy) | 4 files | 9 (mostly orchestrator) | Expected 20–40% — **gap** |
| Ingress / glue (MQTT, MQTT failover, offline queue, alarm engine, calibration engine, process image, trend engine, atlas ezo, io poll, hardware scanner, health, telemetry, shutdown, provisioning, backup, pwm, spi, gpio, i2c, bounded, interning, commands, config, error, security, safe_state v1) | 26 files | ~95 | Expected 30–60% — **gap cluster** |

## 5. Known zero-test files (from unit-test inventory §2)

These files have no `#[cfg(test)]` block and will show 0% line coverage on first tarpaulin run. Each is a tracked test-writing action for Q3:

- `src/alarm_engine.rs` — safety-critical.
- `src/atlas_ezo.rs` — external-input parser.
- `src/calibration_engine.rs` — measurement chain.
- `src/io_poll.rs` — I/O polling loop.
- `src/mqtt_failover.rs` — broker failover.
- `src/mqtt.rs` — primary ingress.
- `src/process_image.rs` — PLC process image.
- `src/scada_db.rs`, `src/scada_server.rs`, `src/scada_types.rs` — SCADA storage + server.
- `src/shutdown.rs` — shutdown coordinator.
- `src/trend_engine.rs` — historian.
- Module-glue `mod.rs` files with no testable logic.

## 6. Tooling choice

- **Primary:** `cargo-tarpaulin`. Reason: mature, Rust-first, Cobertura XML output.
- **Alternative:** `cargo-llvm-cov`. Reason: more accurate branch coverage. Consider for the safety-critical surfaces once the primary tool is wired.
- **Output format:** Cobertura XML + LCOV for CI integrations (Codecov / Coveralls).

## 7. Evidence links

- `Cargo.toml:405–419` — dev-dep block. Note: neither `cargo-tarpaulin` nor `cargo-llvm-cov` is pinned — they run as external binaries under the Q3 plan.
- `.github/workflows/rust-ci.yml` — no coverage job present today. Q3 plan adds one.
- [unit-tests.md](./unit-tests.md) — per-module `#[test]` counts that drive the Q3 prediction column in §4.
