# SOC 2 — Trust Services Criteria Readiness (AICPA TSC 2017)

**Framework:** AICPA Trust Services Criteria (2017, revised 2022) — Security, Availability, Processing Integrity, Confidentiality, Privacy.

**Scope:** This chapter is the **edge-component** contribution to a platform-wide SOC 2 report. The SaaS backend (`apps/*-service/`) owns most TSC evidence; `suderra-agent` v1.6.0 contributes evidence for criteria that touch the edge runtime: authentication (CC6), audit logging (CC4 / CC7), availability (A1), confidentiality (C1), and privacy (P1-P8).

**Target assertion:** SOC 2 Type I (design effectiveness) in 3 months. SOC 2 Type II (operating effectiveness over 6-12 month observation window) is **BLOCKED by ORPHAN-EDGE-004** — the cloud-side audit runtime sink is not wired, so there is no continuous evidence stream to observe.

## Common Criteria (CC) — Security baseline

| TSC | Criterion | Edge contribution | Status |
|-----|-----------|-------------------|--------|
| CC1.x Control environment | Governance | `CLAUDE.md` architectural-approach mandate, `.claude/agents/README.md` agent discipline, CODEOWNERS | PASS |
| CC2.x Communication & information | Internal communication of policy | ADR registry, `docs/reviews/` artefacts, `docs/security/threat-model.md` | PASS |
| CC3.x Risk assessment | Threat identification + risk analysis | STRIDE threat model, orphan-finding severity rubric, [iec62443-4-2-gap.md](./iec62443-4-2-gap.md) SL-target analysis | PASS |
| CC4.1 Monitoring activities — performance | Evaluation of control performance | SDLA Practice 5 (SVV) evidence in [iec62443-4-1-sdla.md](./iec62443-4-1-sdla.md); SVV-3 / SVV-4 PARTIAL | PARTIAL |
| CC4.2 Monitoring activities — deficiency evaluation | Deficiency communication + remediation | `docs/reviews/orphan-findings.md` append-only registry; Finding state machine OPEN → IN-PROGRESS → RESOLVED | PASS (process); **PARTIAL (runtime evidence stream BLOCKED by ORPHAN-EDGE-004)** |
| CC5.x Control activities | Policies + procedures | `docs/SECURITY_HARDENING_CHANGELOG.md`, `CLAUDE.md` coding standards + banned-phrase gate | PASS |
| CC6.1 Logical access — credentials | Access credentials | mTLS cert-CN identity (ADR-015), `src/keystore/` per-device key, RBAC model (ADR-018), `docs/security/pki-hierarchy.md` | PASS |
| CC6.2 Logical access — user registration | User provisioning + deprovisioning | Operator provisioning via `src/provisioning.rs`; deprovisioning cascade is PARTIAL (tenant-termination ORPHAN-EDGE — see [gdpr-kvkk-dpia.md](./gdpr-kvkk-dpia.md)) | PARTIAL |
| CC6.3 Logical access — removal | Timely access removal | Cert revocation via CRL + `docs/runbooks/secret-rotation.md`; edge agent checks revocation on connection | PASS |
| CC6.6 Logical access — perimeter | Boundary protection | Outbound-only MQTT; no inbound WAN listener; systemd sandbox; FR5 row of [iec62443-4-2-gap.md](./iec62443-4-2-gap.md) | PASS |
| CC6.7 Logical access — transmission | Encryption in transit | TLS 1.3 everywhere (cipher inventory in `docs/security/crypto-inventory.md`); OpenSSL banned at `deny.toml` layer | PASS |
| CC6.8 Logical access — malicious software | Protection against malware | Minimum system call surface via systemd `SystemCallFilter`; write-XOR-execute memory (`MemoryDenyWriteExecute`); Cargo deny allowlist; SBOM + cosign signing ROADMAP-Q3 (ADR-032 + ORPHAN-EDGE-018) | PARTIAL |
| CC7.1 System operations — detection | Detection of events that would prevent meeting objectives | `src/alarms.rs`, `src/alarm_engine.rs`, systemd `WatchdogSec`; Prometheus metric surface ROADMAP | PARTIAL |
| CC7.2 System operations — event response | Response to detected events | Coordinated Vulnerability Disclosure `docs/security/cvd-policy.md`; SL severity → remediation SLA ROADMAP-Q3 (SUM-5 in [iec62443-4-1-sdla.md](./iec62443-4-1-sdla.md)) | PARTIAL |
| CC7.3 System operations — recovery | Recovery from events | `src/safe_state.rs`, `src/resilience/`, `src/offline_queue.rs`, `src/backup.rs`; automated restore verification ROADMAP-Q3 (FR7 CR 7.3) | PARTIAL |
| CC7.4 System operations — corrective action | Corrective action per finding | Orphan-finding `Closes:` commit footer; `Closes: docs/reviews/orphan-findings.md#ORPHAN-EDGE-NNN` pattern enforced | PASS |
| CC7.5 System operations — root cause | Root cause analysis | `CLAUDE.md` architectural-root-cause mandate; no-patches discipline | PASS |
| CC8.1 Change management | Changes to infrastructure / data / software are authorized | Signed config manifest (ADR-026), deploy orchestrator (`src/deploy_orchestrator.rs`), CODEOWNERS PR gate | PASS |
| CC9.1 Risk mitigation — business disruption | Identified mitigations for business disruption | A1.x evidence below + IEC 62443 FR7 row | PASS |
| CC9.2 Risk mitigation — vendor / partner | Vendor + business partner risk | `deny.toml` allowlist, `cargo audit`, SBOM attestation per ADR-032 | PASS |

## Availability (A) category

| TSC | Criterion | Edge contribution | Status |
|-----|-----------|-------------------|--------|
| A1.1 | Meets the entity's commitments for availability | `docs/operations/sla.md` (owned by `operations-sla-writer`, ROADMAP-Q2); dual-broker failover, circuit breakers | PARTIAL |
| A1.2 | Capacity management | `src/io_poll.rs` bounded scheduler, resource limits in systemd unit | PASS |
| A1.3 | Backup + recovery | `src/backup.rs` backup generation; automated restore-verification runbook ROADMAP-Q3 | PARTIAL |

## Processing Integrity (PI) category

| TSC | Criterion | Edge contribution | Status |
|-----|-----------|-------------------|--------|
| PI1.1 | Data quality inputs | `src/process_image.rs` typed tag system, `src/bounded.rs` domain-bound numeric types, protocol codec validation in `sensorprotocols/` | PASS |
| PI1.2 | System processing integrity | Signed command envelope (ADR-024), signed config manifest (ADR-026), safe-state transitions (`src/safe_state.rs`) | PASS |
| PI1.3 | Processing completeness | HMAC-chained audit (`src/audit/chain.rs`) with gap-detectable sequence numbers | PASS |
| PI1.4 | Data quality outputs | Actuator write validation + class-binding enforcement (ADR-024 §2); ORPHAN-EDGE-008 (Modbus routing to first device) + ORPHAN-EDGE-009 (silent `as u16` truncation) OPEN until Faz 1 ARC-008 | PARTIAL |
| PI1.5 | Storage completeness + accuracy | SQLCipher WAL + offline queue; graceful-shutdown flush ORPHAN-EDGE-006 OPEN | PARTIAL |

## Confidentiality (C) category

| TSC | Criterion | Edge contribution | Status |
|-----|-----------|-------------------|--------|
| C1.1 | Confidential information is identified | Personal-data inventory in [gdpr-kvkk-dpia.md](./gdpr-kvkk-dpia.md); classification policy inherited from SaaS backend | PASS |
| C1.2 | Confidential information is disposed of | Zeroize primitives in `src/keystore/`; secure-wipe operator runbook ROADMAP-Q3 | PARTIAL |

## Privacy (P) category

| TSC | Criterion | Edge contribution | Status |
|-----|-----------|-------------------|--------|
| P1.x Notice | Data subject notice | SaaS-backend responsibility; edge records no direct data-subject-facing notice surface | N/A (cloud-owned) |
| P2.x Choice & consent | Consent collection + withdrawal | Cloud-owned; edge respects per-tenant feature toggles per ADR-027 | PASS (downstream of cloud) |
| P3.x Collection | Collection limitation | Only telemetry + operator authentication collected at edge; data inventory in [gdpr-kvkk-dpia.md](./gdpr-kvkk-dpia.md) | PASS |
| P4.x Use, retention, disposal | Purpose limitation + retention schedule | ADR-024 retention matrix; tenant-termination erasure ORPHAN-EDGE ROADMAP-Q3 | PARTIAL |
| P5.x Access | Data subject access | Cloud-owned export API; edge audit-log CLI export ROADMAP-Q3 | PARTIAL |
| P6.x Disclosure + notification | Third-party disclosure controls | Outbound-only comms; no third-party processors at edge | PASS |
| P7.x Quality | Personal data quality | Hashed MAC at boundary; operator PIN hashed + salted; data integrity via PI1.x | PASS |
| P8.x Monitoring + enforcement | Compliance monitoring | Orphan-finding registry; quarterly CVD review per `docs/security/cvd-policy.md` | PASS |

## CC4.2 audit evidence strategy — Type II observation window

SOC 2 Type II requires **continuous evidence** across a 6-12 month observation window, which means the auditor must be able to sample audit events and reconstruct control operation over time. The evidence pipeline must be:

1. **Emitted** — every control event reaches a durable sink.
2. **Retained** — sink retention ≥ observation window.
3. **Queryable** — auditor can run period-bounded queries.

**Current state (v1.6.0):**

- Local edge audit: PASS — `src/audit/chain.rs` HMAC-chained log persists locally with tamper-evident integrity.
- Cloud-side runtime sink: **BLOCKED** by ORPHAN-EDGE-004 — events are emitted by the edge but the cloud-side consumer that lands them into a long-retention store is not wired.

**Consequence:** SOC 2 Type I (design) achievable in 3 months — design-time evidence is complete (policies, threat model, ADRs, crypto inventory). SOC 2 Type II cannot start its observation window until ORPHAN-EDGE-004 resolves; planned window start: 2026-Q3 once the sink lands, with a 6-month observation → Type II report attestable 2027-Q1.

## Cross-references

- [iec62443-4-1-sdla.md](./iec62443-4-1-sdla.md) — SDLA practices directly feed CC3-CC5 + CC7-CC9.
- [iec62443-4-2-gap.md](./iec62443-4-2-gap.md) — FR1/FR2/FR4/FR6 feed CC6.x; FR7 feeds A1.x.
- [gdpr-kvkk-dpia.md](./gdpr-kvkk-dpia.md) — personal-data inventory feeds P1-P8.
- `docs/security/audit-log.md` — CC4.2 + CC7.x evidence architecture.
- `docs/reviews/orphan-findings.md#ORPHAN-004` — Type II blocker.

Compliance snapshot: 2026-04-24, v1.6.0, HEAD=3413db47
