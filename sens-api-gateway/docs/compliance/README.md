# Compliance Evidence — `sens-api-gateway` (suderra-agent v1.6.0)

**Scope:** This directory is the Siemens / TÜV SÜD / Exida vendor-assessment evidence package for the Rust industrial edge gateway. Every chapter maps a normative requirement (FR / clause / article) to a verifiable artefact in the repository — `src/*.rs:line`, `Cargo.toml:line`, an ADR under `docs/adr/`, a test file, or a runbook.

No marketing claims. No "IEC 62443 SL2 certified" — only the self-declaration status backed by the gap tables below.

## Traffic-light dashboard

| Standard / framework | Target level | Current status | Chapter |
|----------------------|--------------|----------------|---------|
| IEC 62443-4-2 (Component Security) | SL2 baseline, SL3 for life-safety outputs | SL1 self-declaration; SL2 ROADMAP (6 months) | [iec62443-4-2-gap.md](./iec62443-4-2-gap.md) |
| IEC 62443-4-1 (SDLA) | Practices 1-8 maturity level 2 | PARTIAL (SM/SR/SD/SI PASS; SVV/DM/SUM/SG PARTIAL-to-GAP) | [iec62443-4-1-sdla.md](./iec62443-4-1-sdla.md) |
| IEC 61131-3 Edition 3 | ST + FBD conformance | ST parser PRESENT, ST runtime VM ROADMAP (Faz 3); FBD PRESENT; LD / IL / SFC NOT-PLANNED | [iec61131-3.md](./iec61131-3.md) |
| ISA-18.2 (Alarm management) | Priority / State / Deadband / Shelving / Ack | 7/12 PASS; Rationalization / Flood / Standing / Chattering / Performance FAIL | [isa18-2.md](./isa18-2.md) |
| ISA-95 / ISA-99 | Level 2 edge gateway; zone-conduit | PASS (zone-conduit documented in architecture) | [isa95-isa99.md](./isa95-isa99.md) |
| CE / UL / FCC / RED | CE Machinery 2023/1230 cyber clauses; RED Art 3.3(d)(e)(f) | PARTIAL — CE cyber = FR3 evidence; RED dossier ROADMAP | [ce-ul-fcc-red.md](./ce-ul-fcc-red.md) |
| GDPR / KVKK / DPIA | Article 35 DPIA; VERBIS registration | PARTIAL — DPIA drafted; tenant-termination cascade ROADMAP (ORPHAN-EDGE erasure handler) | [gdpr-kvkk-dpia.md](./gdpr-kvkk-dpia.md) |
| SOC 2 Type II (AICPA TSC 2017) | CC1-CC9 + A1-A2 + PI1 + C1 + P1-P8 | Type I achievable in 3 months; Type II blocked by ORPHAN-EDGE-004 (audit runtime sink) | [soc2.md](./soc2.md) |
| Target certifications roadmap | — | See Gantt | [certifications-roadmap.md](./certifications-roadmap.md) |

## Cross-chapter evidence index

| Artefact type | Location | Consumed by |
|---------------|----------|-------------|
| Cryptographic algorithm inventory | `docs/security/crypto-inventory.md` (authoritative — `security-architecture-writer`) | IEC 62443-4-2 FR4, RED Art 3.3(d) |
| PKI hierarchy (root, intermediate, device) | `docs/security/pki-hierarchy.md` | IEC 62443-4-2 FR1, SOC 2 CC6.1 |
| Audit-log chain + HMAC evidence | `src/audit/chain.rs:38-155`, `src/audit/entry.rs:86-170` | IEC 62443-4-2 FR6, SOC 2 CC4.2, GDPR Art 30 |
| STRIDE threat model | `docs/security/threat-model.md` | IEC 62443-4-1 SD-1, SOC 2 CC3.2 |
| Orphan-findings registry | `docs/reviews/orphan-findings.md` | Every FAIL/PARTIAL row in every chapter |
| ADR registry | `docs/adr/` (platform) + `docs/adr/` (edge-specific: ADR-017…ADR-027) | All chapters |

## Reader conventions

- `PASS` — requirement met, evidence cited.
- `PARTIAL` — requirement partially met; named gap + remediation anchor in roadmap.
- `FAIL` — requirement not met; blocks certification; linked to a ROADMAP phase + owner.
- `ROADMAP` — not-yet-implemented capability with target window; never used for landed code.
- `NOT-PLANNED` — capability that is explicitly not on the roadmap, with reason.

## Source-of-truth stewardship

- `compliance-evidence-writer` (this agent) owns every file under `sens-api-gateway/docs/compliance/`.
- Crypto + PKI facts are consumed from `security-architecture-writer`; conflicts are arbitrated via `architectural-arbiter`.
- Test + KPI evidence is consumed from `test-evidence-writer`.
- Commercial terms + export-control ECCN are consumed from `commercial-legal-writer`.
- Lane-A `compliance-expert` gap analysis is the upstream input for the gap tables; this writer does not diverge.

Compliance snapshot: 2026-04-24, v1.6.0, HEAD=3413db47
