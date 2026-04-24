# Test Evidence — `sens-api-gateway`

**Source-of-Truth:** HEAD `3413db47`, product version `v1.6.0`, snapshot date `2026-04-24`.
**Owner:** `test-evidence-writer` (Lane-C edge-docs producer).
**Audience:** Siemens quality auditor, TÜV SÜD / Exida IEC 62443-4-1 SVV assessor, internal engineering.

This chapter documents **tests that EXIST** in the `sens-api-gateway` Rust crate. It does not author new Rust tests — that is the responsibility of Lane-A `test-runner` and the development team. Every quantitative claim is cross-checked against a file path and line number.

---

## Landing index

| Chapter | Scope | Status |
|---------|-------|--------|
| [strategy.md](./strategy.md) | Test pyramid, tool choices, target coverage per layer | Present |
| [unit-tests.md](./unit-tests.md) | Per-module `#[test]` inventory with gap flags | Present |
| [integration-tests.md](./integration-tests.md) | `tests/*.rs` harnesses, mock broker / mock Modbus server posture | Present |
| [property-fuzz.md](./property-fuzz.md) | `proptest` inventory + `cargo-fuzz` targets | Present |
| [hil-rig.md](./hil-rig.md) | Hardware-in-the-loop rig specification | **NO COVERAGE — plan Q3 2026** |
| [soak-endurance.md](./soak-endurance.md) | 1000h soak protocol | **NO RUN EXECUTED — plan Q3 2026** |
| [emc-environmental.md](./emc-environmental.md) | IEC 60068 / IEC 61000-4 — **HARDWARE-VENDOR RESPONSIBILITY** | Plan only |
| [security-testing.md](./security-testing.md) | Clippy wall, `cargo audit` / `cargo deny`, pentest scope | Partial; pentest plan Q2–Q3 |
| [benchmarks.md](./benchmarks.md) | `criterion` harnesses + `tests/resource_benchmark.rs` | Minimal — plan expansion Q3 |
| [coverage-report.md](./coverage-report.md) | `cargo tarpaulin` / `cargo llvm-cov` snapshot | Never measured — plan 40% Q3 / 60% Q4 |

---

## Headline numbers (evidence-only)

- Unit `#[test]` attributes across `sens-api-gateway/src/**`: **814** (`grep -c "#\[test\]"`, 88 source files with `#[cfg(test)]` blocks).
- Integration test files in `sens-api-gateway/tests/`: **2** (`tests/resource_benchmark.rs`, `tests/stress_test.rs`) — both `#[ignore]`d, opt-in via `--release -- --ignored`.
- Fuzz targets under `sens-api-gateway/fuzz/fuzz_targets/`: **3** (`config_parse.rs`, `modbus_response.rs`, `mqtt_payload.rs`).
- `criterion` bench harnesses declared with `[[bench]]`: **0** (dev-dependency present at `Cargo.toml:418`, no harness wired — plan Q3).
- Test-file to production-file ratio: ≈1% by volume (production files ≈108 `.rs` in `src/`, integration test files 2 — unit tests inlined per module under `#[cfg(test)]`).
- HIL rig, soak-1000h, EMC, pentest: **no execution evidence exists** — see per-chapter plans.

---

## Honest gap register

1. **HIL rig** — NO COVERAGE. Plan Q3 2026. See [hil-rig.md](./hil-rig.md).
2. **Soak 1000h** — NO RUN EXECUTED. Plan Q3 2026. See [soak-endurance.md](./soak-endurance.md).
3. **EMC / environmental** — HARDWARE-VENDOR RESPONSIBILITY (owner: SBC supplier, deadline: per customer contract, `ORPHAN-EDGE-EMC-001 ROADMAP`). See [emc-environmental.md](./emc-environmental.md).
4. **Pentest** — NOT EXECUTED. Plan Q2–Q3 2026 for IEC 62443 SL2 preparation. See [security-testing.md](./security-testing.md).
5. **`cargo audit` / `cargo deny` on the edge crate** — `sens-api-gateway/**` is outside the `rust-ci.yml` path filters (`crates/**`, `apps/sensor-ingestion/**`) — tracked as `ORPHAN-EDGE-006`. See [security-testing.md](./security-testing.md).
6. **Modbus write readback-ACK** — write path has no readback verification loop; write success is ACKed on network return only. Cross-cited in [integration-tests.md](./integration-tests.md).
7. **Coverage measurement** — `cargo tarpaulin` / `cargo llvm-cov` has never been run against this crate. The ≈1% test-to-prod ratio is a volume proxy, not a line-coverage number. See [coverage-report.md](./coverage-report.md).

Each gap is declared with an owner and target quarter. Closure of gaps 1–4 is on the critical path for IEC 62443 SL2 certification (IEC 62443-4-1 SVV clauses). Gap 5 is a CI infrastructure ticket (`ORPHAN-EDGE-006`). Gap 6 links to the architectural review of the command execution pipeline. Gap 7 is remediated by the Q3 tarpaulin plan.

---

## Banned-phrase discipline

All chapters in this tree are written under the substitution table defined in `.claude/agents/edge-docs/README.md` §"Banned-phrase discipline". Replacements used:

- EMC: **HARDWARE-VENDOR RESPONSIBILITY** with named owner + deadline + tracked finding ID.
- Coverage floor on legacy code: **practical floor 50%**.
- Missing test category: **NO COVERAGE — plan QX** with owner.

Pre-commit enforcement: `tools/gates/banned-phrase.ts`.
