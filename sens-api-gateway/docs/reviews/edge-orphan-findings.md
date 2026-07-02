# Edge Orphan Findings Ledger (ORPHAN-EDGE-*)

**Provenance:** Finding IDs in the ORPHAN-EDGE-* namespace were minted during
the Lane-C 12-producer documentation run (commits ed8184ead, 2b3a566a8) and
are cross-referenced ~240 times across `sens-api-gateway/docs/**`,
`.claude/agents/edge-docs/*.md`, `CONTRIBUTING.md`, and `SECURITY.md` — but
the defining ledger never landed with the run. Definitions below were
reconstructed 2026-07-02 from every inline usage context
(ORPHAN-MEDIUM-294 remediation). Where usage context is thin, the entry says
so rather than inventing detail. This ledger is the SSoT for ORPHAN-EDGE-*
ids; new edge findings append here.

Severity vocabulary follows the docs' own treatment: HIGH = blocks a
certification/attestation milestone (SOC 2 Type II, IEC 62443 SL2);
MEDIUM = compliance/process/feature gap; LOW = advisory or optional-feature.

---

## ORPHAN-EDGE-001 — OpenTelemetry coupled-release atomicity policy — OPEN

OTEL instrumentation-family dependency updates need a single atomic bump to
prevent exporter↔SDK version skew; Cargo.lock is committed and `cargo update`
is CODEOWNERS-gated, but no formal release-coupling policy exists for OTEL
transitive pins. Blocks IEC 62443 SUM-1 qualification readiness.
Evidence: `sens-api-gateway/docs/compliance/iec62443-4-1-sdla.md` (SUM-1
table), `Cargo.lock`. Severity: MEDIUM. Confidence: thin (1 citation).

## ORPHAN-EDGE-002 — Security-architecture today-vs-roadmap truthfulness gate — OPEN

Meta-control cited by `security-architecture-writer.md:24`: security chapters
must never present type-only or roadmap defenses as live. No discrete closure
criteria found in usage; functions as a standing documentation-fidelity gate
alongside 003/004/005. Severity: HIGH (documentation-accuracy control on
Type-II-facing chapters). Confidence: thin.

## ORPHAN-EDGE-003 — MQTT per-device X.509 client-certificate mTLS — ROADMAP-Q3

Broker-side MQTT auth today is username+password only (`src/config.rs`
carries `broker_password`); target per ADR-015 is per-device X.509 issued at
provisioning with cert-CN-bound identity (`src/mqtt.rs:73` names this id as
the architectural close-out). Blocks SOC 2 Type II observation, IEC 62443 SL2
baseline, and per-device-binding RFPs. CSR flow depends on Faz 2 Sprint 6.4.
Severity: HIGH. Confidence: solid (41 citations incl. protocols/mqtt.md,
architecture/c4-container.md, Siemens integration chapters).

## ORPHAN-EDGE-004 — Command-envelope runtime enforcement + cloud audit sink — ROADMAP-Q3

Two conflated gaps: (1) command-envelope types exist
(`src/command_envelope/`, ADR-024 §2) but runtime enforcement waits on the
`signed-deploy` feature flag (`Cargo.toml:355`, currently off) — inbound
cloud commands run signature-checked/payload-unenforced; (2) the edge's
HMAC-chained SQLCipher audit log (`src/audit/chain.rs`, ADR-020) has no
cloud-side long-retention consumer, so the SOC 2 Type II 6-month observation
window cannot open. Blocks SOC 2 Type II + IEC 62443-4-2 FR6 CR 6.2.
Severity: HIGH. Confidence: solid (66 citations incl. compliance/soc2.md,
certifications-roadmap.md, iec62443-4-2-gap.md).

## ORPHAN-EDGE-005 — OPC UA SecurityPolicy Basic256Sha256 + SignAndEncrypt — ROADMAP-Q2/Q3

The hand-rolled OPC UA client wires only `SecurityPolicy::None`
(`src/plc_programming/opcua.rs:69`, default config at :437) — plaintext wire.
Migration path: `opcua` crate ≥0.12 with full Basic256Sha256 + SignAndEncrypt
and PKI store (Faz 2 Sprint 6.3-6.4). Blocks TIA Portal production
connections (TIA rejects `None`), WinCC v16-v19 integration, Siemens OT
audits, and OPC Foundation CTT conformance. Codesys TLS and Secure ADS extend
under the same id. Severity: HIGH (Siemens production show-stopper).
Confidence: solid (32 citations incl. the dedicated opcua-for-siemens.md
chapter with migration plan).

## ORPHAN-EDGE-006 — CI path-filter excludes sens-api-gateway from audit jobs — OPEN

`.github/workflows/rust-ci.yml` `paths:` filter (lines 5-28) lists
`crates/**` + `apps/sensor-ingestion/**` but not `sens-api-gateway/**`, so
edge-only PRs skip cargo audit/deny/clippy/test. Remediation: add the glob
(and optionally a dedicated edge audit job). Blocks IEC 62443 SUM-1/SUM-3
supply-chain evidence + SOC 2 dependency-scan chain. One GDPR/DPIA citation
also notes the offline-queue flush risk window under this id. Severity:
MEDIUM. Confidence: solid-adjacent (18 citations, mechanism verified).

## ORPHAN-EDGE-007 — HTTP health server defined but never started — ROADMAP-Q3 (v1.7.0)

`src/health.rs:670-703` defines `start_health_server` + handlers, but
`src/main.rs` only declares `mod health;` — `/health`, `/ready`, `/metrics`
never bind. Blocks Kubernetes liveness/readiness probes, Prometheus scrape,
and the 13 designed alert rules (`prometheus.rules.yaml` absent). Faz 2
Sprint 6.7. Severity: MEDIUM (operational). Confidence: solid (15 citations;
docs/api/http-api.md chapter is explicitly "NOT WIRED TODAY").

## ORPHAN-EDGE-008 — Prometheus exposition format + monitoring stack — ROADMAP-Q3 (v1.7.0)

`metrics_handler` returns JSON (`src/health.rs:731-736`);
`metrics-exporter-prometheus` is in Cargo.toml (:311) behind the disabled
`metrics` feature (:333); `infrastructure/monitoring/` (grafana/edge,
alertmanager.yaml) does not exist. Paired with 007. Severity: MEDIUM.
Confidence: solid (11 citations).

## ORPHAN-EDGE-009 — S7 server role + protocol documentation parity — ROADMAP-Q4

`src/plc_programming/s7comm.rs:474` implements `S7Client` only — no S7
server, so WinCC cannot address the gateway as an S7 partner (blocks the
wincc-tag-bridge use-case). Same id tracks sensorprotocols/ parity (2 docs vs
6+ implemented protocols; the customer-facing re-expression lives under
docs/protocols/). Severity: MEDIUM. Confidence: thin-to-solid (4 citations;
code evidence verified).

## ORPHAN-EDGE-010 — Modbus FC15/16/17/22/23/43 not implemented — PARTIALLY RESOLVED / ROADMAP-Q4

`src/modbus.rs:68` documents the write-multiple family as intentionally
absent; single-register FC05/FC06 + the 2 ops/sec rate-limiter (:390-396)
cover most SCADA patterns, but write-only-multiple servers (e.g. Schneider
M241 FC15/16-only) cannot pair, and Modbus MODTEST conformance is blocked.
Usage also marks a Batch-4a systemd-sandbox hardening item under this id as
RESOLVED — the multi-write codes themselves stay ROADMAP-Q4 (demand-driven).
Severity: LOW-MEDIUM (documented design trade-off). Confidence: solid (17
citations).

## ORPHAN-EDGE-011 — TPM-backed key storage — ROADMAP-Q4

Keying material lives in filesystem/SQLCipher (`src/keystore/secret.rs`)
even on TPM-equipped targets (SIMATIC IPC, RevPi+TPM). Scope: TPM-backed
derivation/storage, potentially attestation anchoring. Blocks IEC 62443 SL3
(hardware-backed key protection); not an SL2 blocker. Severity: MEDIUM.
Confidence: thin (2 citations).

## ORPHAN-EDGE-012 — MindSphere/Insights Hub connector + benchmark harness — OPEN / ROADMAP-Q3

Two conflated gaps: (1) no MindConnect integration exists in-tree (preferred
path: Siemens MQTT-to-MindConnect bridge — config+routing, ~12-16 engineer-
weeks, awaiting a customer RFP); (2) `benches/` does not exist and every
number in docs/architecture/performance-envelope.md is labeled NOT MEASURED.
Severity: MEDIUM. Confidence: solid (16 citations).

## ORPHAN-EDGE-013 — Sparkplug-B protocol — OPEN (demand-gated)

MQTT v5 + Sparkplug payload spec not implemented; est. 12-16 engineer-weeks;
tier-3 roadmap until a customer RFP escalates. Evidence: the dedicated
sparkplug-b.md chapter §"Roadmap if required". Severity: LOW. Confidence:
thin (3 citations, all one chapter).

## ORPHAN-EDGE-014 — SPI + PWM wiring + systemd sd_notify liveness — ROADMAP-Q3

Three conflated gaps: `src/spi.rs` and `src/pwm.rs` both compile under
`#![allow(dead_code)]` and are never instantiated from main
(CODE-COMPILED-NOT-WIRED — operator-visible contract is "no SPI/PWM
traffic"); no `sd_notify(WATCHDOG=1)` emission, so systemd `WatchdogSec=`
liveness restarts are unavailable (crash-only `Restart=on-failure` works).
Severity: LOW-MEDIUM (optional hardware features + redundancy). Confidence:
solid (10 citations; both protocol chapters carry the status banner).

## ORPHAN-EDGE-018 — OTA firmware update channel (signed manifest + anti-rollback) — ROADMAP-Q3

A/B-partition OTA with cosign/sigstore-signed manifests and sequence-counter
anti-rollback (designs cited as ADR-019/ADR-032; the ADR files themselves are
not in the current tree — flagged) has no runtime implementation. Blocks
SOC 2 SUM-4 (update delivery), IEC 62443-4-1 SUM-5 (patch SLA — depends on
this channel landing first), and ongoing CE/UL/FCC validity. Severity: HIGH.
Confidence: solid (12 citations).

## ORPHAN-EDGE-DOCS-002 — SECURITY.md contact placeholder — OPEN (administrative)

`SECURITY.md:20` ships `security@suderra.example` marked PLACEHOLDER;
operator must replace before external publication. Severity: administrative.
Confidence: thin.

## ORPHAN-EDGE-DEP-001 — Dependabot remediation SLA policy — ROADMAP-Q3

Dependabot runs but no formal remediation SLA (e.g. critical-72h/high-7d) is
documented; blocks IEC 62443 SUM-5 patch-SLA evidence. Evidence:
`SECURITY.md:59`, `.github/dependabot.yml`. Severity: MEDIUM. Confidence: thin.

## ORPHAN-EDGE-DEP-003 — SBOM generation + binary embedding — ROADMAP-Q3

`cargo-cyclonedx` + `cargo-auditable` are the declared SBOM path
(`SECURITY.md:57`, tracked jointly with main-ledger ORPHAN-021) but release-
pipeline integration is not automated/documented. Blocks CE/UL/FCC
supply-chain-transparency evidence. Severity: MEDIUM. Confidence: thin.

## ORPHAN-EDGE-CONTRACT-002 — Trust-boundary JSON Schema validators (platform-wide) — ROADMAP

`@platform/event-contracts` schema validation for edge trust-boundary
crossings (command envelope, MQTT, SCADA frames) is type-present but not
runtime-wired; `CONTRIBUTING.md:114` requires new trust-boundary events to
add validators under this tracking id. Severity: MEDIUM. Confidence: thin
(2 citations).

## ORPHAN-EDGE-WORKTREE-001 — Worktree lifecycle cleanup tooling — ROADMAP

Long-lived git worktrees outside `/var/aqua-saas/.worktrees/` are to be
flagged by cleanup tooling that does not yet exist (`CONTRIBUTING.md:78`).
Severity: LOW (hygiene). Confidence: thin.

## ORPHAN-EDGE-HYG-002 — Parallel-session git staging hygiene — GUIDANCE

Process rule (`CONTRIBUTING.md:92`): no `git add -A`/`git commit -a`
alongside parallel sessions; stage explicit paths. Severity: LOW (advisory).
Confidence: thin.

## ORPHAN-EDGE-EMC-001 — EMC/environmental testing scope boundary — ROADMAP (hardware vendor)

IEC 60068 / IEC 61000-4 testing is the SBC vendor's responsibility (RevPi /
RPi Foundation / SIMATIC IPC) via certified lab, per customer contract;
firmware contribution is watchdog recovery after EFT/burst. Tracks the scope
boundary for the CE/UL/FCC evidence package. Severity: not a software gap.
Confidence: thin (4 citations).

## ORPHAN-EDGE-HIL-001 — Hardware-in-the-loop test rig — ROADMAP

No HIL rig against live PLCs (Schneider M241, SIMATIC ET 200SP); test
evidence is simulation-based. Tier-1 PLC support claims and MODTEST
conformance require documented HIL coverage
(`docs/protocols/modbus-tcp.md:182`). Severity: MEDIUM. Confidence: thin.

## ORPHAN-EDGE-PENTEST-001 — Third-party penetration test — ROADMAP-Q2/Q3

Independent pentest (attack-surface enumeration, protocol fuzzing, access-
control bypass, RE resistance) planned for IEC 62443 SVV-3/SVV-4; vendor not
selected. Severity: HIGH (certification-blocking third-party validation).
Confidence: thin-to-solid (explicit plan rows in testing/security-testing.md
+ iec62443-4-1-sdla.md).

## ORPHAN-EDGE-SOAK-001 — Soak/endurance testing (72h+) — ROADMAP

No long-duration stability harness (memory leaks, scheduler bugs, tail
latency); needed for SL2 FR7 availability evidence
(`docs/testing/soak-endurance.md:10`). Severity: MEDIUM. Confidence: thin.

## ORPHAN-EDGE-ISA18-RAT — Alarm rationalization metadata — ROADMAP-Q3

`AlarmDefinition` (`src/alarms.rs:139-182`) carries only priority + deadband;
ISA 18.2 rationalization (cause, consequence, corrective action, priority
justification, response-time target) has no store/workflow. Severity: MEDIUM.
Confidence: thin.

## ORPHAN-EDGE-ISA18-FLOOD — Alarm flood-rate detection — ROADMAP-Q3

No flood-condition detector (cascade vs isolated event indistinguishable);
ISA 18.2 requirement (`docs/compliance/isa18-2.md:47`). Severity: MEDIUM.
Confidence: thin.

## ORPHAN-EDGE-ISA18-STANDING — Standing-alarm digest — ROADMAP-Q3

No unacknowledged-past-threshold digest/report (`isa18-2.md:48`). Severity:
LOW-MEDIUM. Confidence: thin.

## ORPHAN-EDGE-ISA18-CHATTER — Alarm chatter counter — ROADMAP-Q3

No rapid on-off-on cycle detection (noisy sensor / tight setpoint signal)
(`isa18-2.md:49`). Severity: LOW. Confidence: thin.

## ORPHAN-EDGE-ISA18-KPI — Operator alarm KPI metrics — ROADMAP-Q3

MTTA/MTTR, alarm/event ratio, chattering ratio, standing count — none
computed or surfaced (`isa18-2.md:50`); cloud analytics unowned. Severity:
MEDIUM. Confidence: thin.

---

## Coverage table

| ID | Citations | Confidence |
|---|---|---|
| ORPHAN-EDGE-001 | 1 | thin |
| ORPHAN-EDGE-002 | 1 | thin |
| ORPHAN-EDGE-003 | 41 | solid |
| ORPHAN-EDGE-004 | 66 | solid |
| ORPHAN-EDGE-005 | 32 | solid |
| ORPHAN-EDGE-006 | 18 | solid |
| ORPHAN-EDGE-007 | 15 | solid |
| ORPHAN-EDGE-008 | 11 | solid |
| ORPHAN-EDGE-009 | 4 | thin |
| ORPHAN-EDGE-010 | 17 | solid |
| ORPHAN-EDGE-011 | 2 | thin |
| ORPHAN-EDGE-012 | 16 | solid |
| ORPHAN-EDGE-013 | 3 | thin |
| ORPHAN-EDGE-014 | 10 | solid |
| ORPHAN-EDGE-018 | 12 | solid |
| ORPHAN-EDGE-DOCS-002 | 1 | thin |
| ORPHAN-EDGE-DEP-001 | 1 | thin |
| ORPHAN-EDGE-DEP-003 | 1 | thin |
| ORPHAN-EDGE-CONTRACT-002 | 2 | thin |
| ORPHAN-EDGE-WORKTREE-001 | 1 | thin |
| ORPHAN-EDGE-HYG-002 | 1 | thin |
| ORPHAN-EDGE-EMC-001 | 4 | thin |
| ORPHAN-EDGE-HIL-001 | 2 | thin |
| ORPHAN-EDGE-PENTEST-001 | 2 | thin |
| ORPHAN-EDGE-SOAK-001 | 1 | thin |
| ORPHAN-EDGE-ISA18-RAT | 1 | thin |
| ORPHAN-EDGE-ISA18-FLOOD | 1 | thin |
| ORPHAN-EDGE-ISA18-STANDING | 1 | thin |
| ORPHAN-EDGE-ISA18-CHATTER | 1 | thin |
| ORPHAN-EDGE-ISA18-KPI | 1 | thin |

Gaps in the numeric sequence (015-017) had zero usage anywhere in the repo;
they were never minted or their mentions were removed before landing — the
sequence resumes at 018 as used.
