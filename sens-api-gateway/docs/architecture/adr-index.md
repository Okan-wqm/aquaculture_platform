# ADR Index — Edge-Gateway Cross-Reference

**Document version:** 1.0
**SoT:** HEAD `3413db47`, `suderra-agent` v1.6.0 (`Cargo.toml:3`)
**Date:** 2026-04-24
**Owner:** architecture-writer (Lane-C)

## Purpose

A Siemens OT reviewer reading the edge documentation needs to find the Architectural Decision Records relevant to the gateway without walking the full repo's 27 ADR files. This index does two things:

1. Lists every ADR in the canonical location `docs/adr/` with status, scope, date, one-line summary, and an **Edge-impact** flag (TRUE / FALSE / PARTIAL).
2. Marks the **ADR numbering drift** — the four misfiled `ADR-*` files that live at `docs/architecture/` and collide with canonical IDs. Per the CLAUDE.md project instruction, `docs/adr/` is authoritative; the misfiled files are listed here honestly so a reviewer does not confuse them with canonical decisions.

Conventions used in the tables:

- **Status:** ACCEPTED / PROPOSED / SUPERSEDED, with the exact post-`**Status:**` line from the source ADR.
- **Scope:** `edge` (edge gateway only), `backend` (cloud backend only), `cross` (both).
- **Edge-impact:** `TRUE` if the ADR constrains edge code or runtime; `FALSE` if it is purely cloud-side; `PARTIAL` if only a cited subset binds edge.
- Dates are the `**Date:**` field where present; otherwise the retrodocumented / proposed date in the status line.

Not covered here — the full text of each ADR. For any cited ADR, follow the filename column and read the record.

## Canonical ADR registry — `docs/adr/` (authoritative)

| ADR | Title | Status | Scope | Date | Edge-impact | One-line summary |
|---|---|---|---|---|---|---|
| 001 | Nx Monorepo Over Polyrepo | Accepted (retrodocumented 2026-04-16) | cross | 2026-04-16 | FALSE | Platform-wide decision to keep all services in one Nx monorepo; no edge-specific clause. |
| 002 | Single Gateway-API Edge Service | Accepted (retrodocumented 2026-04-16) | backend | 2026-04-16 | FALSE | Naming collision: this is the **API gateway** service in the cloud, not the edge gateway. No edge binding. |
| 003 | Sensor-Service Separation from Edge Gateway | Accepted (retrodocumented 2026-04-16) | cross | 2026-04-16 | PARTIAL | Draws the boundary between the cloud `sensor-service` and the on-prem edge gateway. Binds on the cloud-facing wire protocols the edge produces. |
| 004 | Temporal Workflow Adoption — SUPERSEDED / REJECTED | Superseded | backend | 2026-04-16 | FALSE | Cloud workflow engine choice; abandoned. |
| 005 | OpenSearch Centralised Logging — SUPERSEDED / ROADMAP | Superseded | backend | 2026-04-16 | FALSE | Cloud log aggregation plan; superseded by the current observability stack. |
| 006 | Event Contracts — Mandated Flat Object Pattern | Accepted | cross | 2026-02-19 | PARTIAL | `BaseEvent` flat-object shape; any MQTT/NATS event the edge publishes to cloud MUST conform. |
| 007 | CQRS Usage Strategy | Accepted | backend | 2026-03-14 | FALSE | Cloud service internal pattern. |
| 008 | Guard Strategy — Defense in Depth | Accepted | backend | 2026-03-14 | FALSE | Cloud gateway-api guard chain. |
| 009 | Frontend Data Fetch Pattern | Accepted | backend | 2026-03-14 | FALSE | Web UI only. |
| 010 | Frontend Styling Strategy | Accepted | backend | 2026-03-14 | FALSE | Web UI only. |
| 011 | Per-Service Schema Ownership Model | Accepted (2026-04-14) | backend | 2026-04-14 | FALSE | Cloud `@Entity()` `schema:` discipline; no edge entities. |
| 012 | Three-Layer Schema Drift Prevention | Accepted (2026-04-14) | backend | 2026-04-14 | FALSE | Cloud CI invariant for TypeORM ↔ Postgres drift. |
| 013 | Messaging Service Isolation Convergence | Accepted | backend | 2026-04-14 | FALSE | Cloud service boundary. |
| 014 | NATS Authentication Model — mTLS-Only Endpoint Reached | Accepted | backend | 2026-04-14 | PARTIAL | Cloud NATS uses mTLS only. Edge analog (MQTT mTLS) is tracked by ORPHAN-EDGE-003 — see ADR-015. |
| 015 | NATS Cert-Is-Identity — Single Source of Truth | Accepted | backend | 2026-04-14 | PARTIAL | Cloud discipline; cited by every edge doc as the identity model the MQTT conduit migrates to. **ROADMAP-Q3** target for the edge side (ORPHAN-EDGE-003). |
| 016 | Deploy Resilience Architecture | Accepted (Phase A landed; B–F roadmap) | cross | 2026-04-14 | PARTIAL | Primarily cloud deploy pipeline; edge deploy orchestrator (`src/deploy_orchestrator.rs`) inherits the "fail-closed deploy" discipline. |
| 017 | ST Execution Runtime — Bytecode Compiler + Stack VM with Gas Metering | Proposed (target Accepted 2026-05-03) | edge | 2026-04-19 | TRUE | Governs `src/st_validator.rs` + the `st-bytecode` feature (`Cargo.toml:367`). |
| 018 | Edge RBAC — ABAC Permission-Set + 5-Key Segregation + Tenant Trust Root + Per-Operator Keys + Break-Glass | Proposed (target Accepted 2026-05-03) | edge | 2026-04-19 | TRUE | Governs `src/authz/` + `src/command_envelope/`. §7 is the zero-trust envelope that runs permissive today (ORPHAN-EDGE-004) and becomes Enforcing on the `signed-deploy` flag. |
| 019 | Edge Firmware Signing + A/B Partition + Dedicated Rescue Slot + Sealed Provisioning + Master Key Hierarchy | Proposed (target Accepted 2026-05-03) | edge | 2026-04-19 | TRUE | Governs `src/updater/` + `src/keystore/` + `src/config_integrity/` + clock/NTS anchoring. Master-key hierarchy drives HKDF derivation of every child key (audit, db, keypair). |
| 020 | Audit Log HMAC Chain + Hybrid Ed25519 Forensic Proof + Cloud Anchor + Tamper-Resistant Storage | Proposed (target Accepted 2026-05-03) | edge | 2026-04-19 | TRUE | Governs `src/audit/` + cloud anchor relay. Runtime wiring ROADMAP Faz 2 Sprint 6.2. |
| 021 | Platform Key Ceremony and Lifecycle — 9-Slot Single-Key HSM + Procedural 4-Eye Quorum | Proposed (target Accepted 2026-05-03) | cross | 2026-04-19 | TRUE | Platform-side key ceremony; edge consumes the public half of slots 6 (license JWT) and 9 (audit anchor). |
| 022a | Edge Feature Schema Placement — Dedicated `edge` Schema with RLS + Partitioning + Canonical Role Names | Proposed (target Accepted 2026-05-03) | backend | 2026-04-19 | PARTIAL | Schema on the cloud side for edge-originated rows (tag history, alarm log, provisioning state). Edge writes the wire messages that populate this schema. |
| 022b | Pseudonymisation Key Management (HMAC Pepper) | Proposed (2026-04-21) | backend | 2026-04-21 | FALSE | Cloud-side pseudonymisation pepper; edge-side MAC pseudonymisation (`src/security.rs` sha2-based) is a separate decision. **Numbering drift with canonical 022 — see §Drift.** |
| 023a | Encrypted-Column Schema Contract | Proposed (2026-04-21) | backend | 2026-04-21 | FALSE | Cloud column-level encryption contract; no edge binding. |
| 023b | SL-3 Upgrade Path — Secure Boot + dm-verity + Remote Attestation + Advanced Hardening | Proposed (Faz 11 optional) | edge | 2026-04-19 | TRUE | Governs the SL-3 ceiling for the edge: secure boot, dm-verity, remote attestation. Opt-in per deployment tier. **Numbering drift with ADR-023 encrypted-columns — see §Drift.** |
| 024a | Compliance Retention Matrix | Proposed (2026-04-21) | cross | 2026-04-21 | PARTIAL | Retention rules for GDPR/KVKK/IEC 62443 data; edge observes the audit-retention leg (ADR-020 §10a). |
| 024b | Edge Hardware Adapter Inventory + Safe-State Schema v2 + Append-Only Signed Class Binding + Effect-Based Permissions | Proposed (target Accepted 2026-06-07) | edge | 2026-04-19 | TRUE | Governs `src/safe_state_v2.rs` + adapter inventory for Modbus/GPIO/I2C/SPI/PWM/Atlas EZO/LoRaWAN. **Numbering drift with ADR-024 retention matrix — see §Drift.** |
| 025 | Rust Sidecar Architecture for sensor-service Ingestion | Accepted (Faz 2 stage 14 — 2026-04-20) | cross | 2026-04-20 | PARTIAL | Places a separate Rust sidecar between cloud MQTT and `sensor-service`. Not part of the edge gateway process tree — the sidecar lives on the cloud side — but shares the `protocol-codec` SSoT (ADR-026). |
| 026 | `protocol-codec` Crate as Single Source of Truth for Industrial Protocol Parsing | Accepted (Faz 1 delivered) | cross | 2026-04-20 | TRUE | Protocol decoding logic lives in a shared Rust crate used by both the edge agent and the cloud sidecar. Guarantees decode parity at the bit-for-bit level. |
| 027 | Per-Tenant `IngestBackend` Toggle for the Rust Sidecar Rollout | Accepted (Faz 2 stage 14 — 2026-04-20) | backend | 2026-04-20 | FALSE | Cloud feature-flag rollout mechanism; no edge binding. |

**Edge-impact count:** 11 ADRs have Edge-impact = TRUE (017, 018, 019, 020, 021, 023b SL-3, 024b hardware adapter inventory, 026 protocol-codec). 9 ADRs are PARTIAL. The remainder are FALSE.

**Count verification:** `docs/adr/` holds 27 distinct `NNN-*.md` records (numbering from 001 to 027) plus `template.md` and a `_draft/` folder; the template and draft folder are excluded from this index.

## Numbering drift — canonical `docs/adr/` vs misfiled `docs/architecture/ADR-*`

Per the CLAUDE.md "Known drift" note, the following four files live at `docs/architecture/` and use ADR numbering that collides with the canonical `docs/adr/` sequence. They are not renumbered here (that is tracked work, not this chapter's remit) — they are **listed** so a Siemens reviewer is not misled by the collision.

| Misfiled file | Canonical collision | Resolution |
|---|---|---|
| `docs/architecture/ADR-010-AI-SELF-LEARNING.md` | Collides with canonical `docs/adr/010-frontend-styling-strategy.md` | The canonical 010 governs. The AI self-learning ADR numbering is drift; the content of the misfiled file is retained as a design note pending renumber. |
| `docs/architecture/ADR-010-AI-REVIEW.md` | Collides with canonical `docs/adr/010-*` | Same disposition as above — content is a design note, canonical 010 governs. |
| `docs/architecture/ADR-011-operations-hub-restructuring.md` | Collides with canonical `docs/adr/011-schema-ownership-model.md` (the load-bearing `@Entity({ schema: ... })` rule) | Canonical 011 governs. |
| `docs/architecture/ADR-012-messaging-service.md` | Collides with canonical `docs/adr/012-schema-drift-prevention.md` | Canonical 012 governs. |
| `docs/architecture/ADR-013-nestjs-v11-upgrade.md` | Collides with canonical `docs/adr/013-messaging-isolation-convergence.md` | Canonical 013 governs. |

**Internal numbering drift within `docs/adr/`** — two separate ADRs share ID 022, two share 023, two share 024. This is a real drift inside the canonical tree and is flagged in the table above (022a/022b, 023a/023b, 024a/024b). A Siemens reviewer who cross-references an edge-facing decision by number needs the filename — the number alone is insufficient. Renumbering is tracked work outside this chapter's remit.

## Cross-reference — which ADRs bind which code paths

| Code path | Primary binding ADRs | Cited in which chapter(s) |
|---|---|---|
| `src/mqtt.rs` + MQTT conduit (C7) | 015 (target), 006 (event shape) | `c4-container.md`, `deployment-topology.md`, `data-flow.md` |
| `src/command_envelope/` + `src/authz/` | 018 §1, §7 | `c4-component.md`, `c4-code.md` §4.5, `data-flow.md` Flow 2 |
| `src/audit/` | 020 | `c4-component.md`, `c4-code.md` §4.5 |
| `src/updater/` + `src/config_integrity/` | 019 §2, §7 | `c4-component.md` |
| `src/keystore/` | 019 §7, 021 | `c4-component.md`, `c4-context.md` |
| `src/mtls/` | 015 (discipline), 019 | `c4-component.md` |
| `src/runtime_safety/` | 019 (clock), 020 (retained-msg guard) | `c4-component.md` |
| `src/safe_state_v2.rs` | 024 (edge hardware adapter, §3) | `c4-component.md`, `c4-code.md` §4.3 |
| `src/st_validator.rs` + `st-bytecode` feature | 017 | `c4-component.md` |
| `src/plc_programming/` | (no ADR — pre-ADR era; HARDWARE-VENDOR RESPONSIBILITY) | `c4-component.md`, `deployment-topology.md` |
| `src/lora/` | (feature-specific; no dedicated ADR) | `c4-container.md`, `deployment-topology.md` |

## ORPHAN-EDGE findings referenced in edge chapters

Edge-documentation chapters reference several ORPHAN-EDGE findings (orphan findings are repo-level tracked findings without a dedicated ADR). The index below lists the ones cited in this chapter set:

| Finding ID | Meaning | Owning chapters | Target milestone |
|---|---|---|---|
| ORPHAN-EDGE-003 | MQTT conduit C7: today user/pass, ADR-015 target mTLS cert-CN | `c4-context.md`, `c4-container.md`, `c4-component.md`, `deployment-topology.md`, `data-flow.md` | ROADMAP-Q3 |
| ORPHAN-EDGE-004 | Command envelope verify is type-present, runtime permissive until `signed-deploy` flag flips | `c4-component.md`, `c4-code.md`, `data-flow.md` | ROADMAP Faz 2 Sprint 6.4 |
| ORPHAN-EDGE-012 (benchmark harness) | Performance envelope numbers are NOT MEASURED until `benches/` lands | `performance-envelope.md` | ROADMAP-Q3 |

The authoritative tracker for ORPHAN-EDGE-NNN finding IDs lives in the repository's orphan-finding register; this index cross-references them but does not own them.

## Evidence

- `docs/adr/` (all 27 records verified present at HEAD `3413db47`)
- `docs/architecture/ADR-010-AI-REVIEW.md`, `docs/architecture/ADR-010-AI-SELF-LEARNING.md`, `docs/architecture/ADR-011-operations-hub-restructuring.md`, `docs/architecture/ADR-012-messaging-service.md`, `docs/architecture/ADR-013-nestjs-v11-upgrade.md` (misfiled ADRs — numbering drift)
- `CLAUDE.md` — "Known drift" paragraph under "ADR References"
- `sens-api-gateway/Cargo.toml:325-397` — feature-flag matrix showing which ADR gates each feature
- `sens-api-gateway/src/audit/`, `src/authz/`, `src/command_envelope/`, `src/config_integrity/`, `src/keystore/`, `src/mtls/`, `src/plc_programming/`, `src/resilience/`, `src/runtime_safety/`, `src/scripting/`, `src/updater/` (the submodule directories each canonical ADR binds)

Not covered here — ORPHAN-EDGE finding authoritative records, which live in the repo's orphan-finding register (maintained by the edge-docs-orchestrator and the ongoing audit track).
