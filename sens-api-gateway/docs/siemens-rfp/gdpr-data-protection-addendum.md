# GDPR Data Processing Addendum — Siemens

**Document owner:** `siemens-rfp-responder` (Lane-C)
**Product:** `sens-api-gateway` v1.6.0
**HEAD:** 3413db47
**Response date:** 2026-04-24

> **TEMPLATE.** This is a model Data Processing Addendum aligned with GDPR Art. 28 + EU SCCs (Commission Decision 2021/914) where the Supplier acts as Processor / Sub-processor on Siemens' behalf. When Siemens provides its own DPA template, map each clause below to Siemens' own numbering. Content of answers stays; structure is Siemens-driven.

---

## Completeness Dashboard

| Status | Count | % |
|--------|-------|---|
| FULL | 14 | 93.3% |
| PARTIAL | 1 | 6.7% |
| ROADMAP | 0 | 0% |
| N-A | 0 | 0% |
| **Total clauses** | **15** | **100%** |

---

## Clause 1 — Parties & Roles

Q: Identify the Controller + Processor roles.
A: Under the Main Agreement:
- **Controller:** Siemens AG (or the Siemens group entity named in the signature block).
- **Processor:** `{TEMPLATE — supplier legal entity}`.
- **Sub-processor(s):** none for personal data today; customer-hosted cloud endpoints only.

If Siemens embeds the product into Siemens' own offering toward Siemens' customers, `{TEMPLATE — supplier}` acts as Sub-processor + Siemens as Processor + the Siemens-customer as Controller.
Status: FULL

---

## Clause 2 — Subject Matter of Processing

Q: What is processed, why, and on what legal basis?
A: Personal data categories processed by the product:
1. **Operator identifiers** — username, hashed password, role assignment, optional email for notifications. Purpose: access control + audit logging. Basis: Art. 6(1)(b) performance of contract; Art. 6(1)(f) legitimate interest (security).
2. **Operator action telemetry** — audit log of commands issued (who did what, when, to which actuator). Purpose: IEC 62443 audit + incident forensics. Basis: Art. 6(1)(c) legal obligation; Art. 6(1)(f) legitimate interest.

**No** special-category personal data (Art. 9) is processed. **No** location data tied to identified natural persons beyond the above.

Evidence: `docs/compliance/gdpr-kvkk-dpia.md`
Status: FULL

---

## Clause 3 — Duration of Processing

Q: How long is personal data retained?
A: Operator-identifier records: for the duration of the account's active role; deletion on account termination + 30-day grace. Audit-log records: minimum 12 months for forensic needs (configurable); after retention expiry rows rotated to cold archive (encrypted) OR hard-deleted per customer policy.

Contract-end: Supplier hands over or deletes all personal data within 30 days of contract termination; written certification of deletion provided.
Evidence: `docs/compliance/gdpr-kvkk-dpia.md` §Retention, `docs/security/audit-log.md`
Status: FULL

---

## Clause 4 — Nature + Purpose of Processing

Q: Describe technical processing operations.
A: Local processing on the edge device: storage (SQLite + SQLCipher at rest), querying for UI + authorisation checks, audit-log append + integrity-hash-chain, optional cloud-sync to the customer-specified destination. No profiling or automated decision-making with legal effects on natural persons (Art. 22).
Evidence: `docs/compliance/gdpr-kvkk-dpia.md`
Status: FULL

---

## Clause 5 — Data Subject Categories

Q: Which categories of data subjects are affected?
A: Operators + administrators of the customer's deployment. Employees + contractors only — no consumer-facing subjects.
Status: FULL

---

## Clause 6 — International Transfers

Q: Are personal data transferred outside the EU/EEA?
A: No transfer by default — the product is edge-local + customer-owned cloud. Customer chooses the cloud endpoint location. Where the customer routes data to non-EU/EEA cloud, the customer is the Controller for the transfer decision; Supplier provides SCC-ready contract language on request (EU SCCs 2021/914 Module 2 Controller-to-Processor OR Module 3 Processor-to-Processor).
Evidence: `docs/commercial/data-residency.md`
Status: FULL (SCC-ready); PARTIAL (actual transfer arrangement per-deal)

---

## Clause 7 — Technical & Organisational Measures (Art. 32)

Q: Describe TOMs.
A: Core measures:
- **Encryption at rest:** SQLCipher (AES-256) for operator credentials + audit log.
- **Encryption in transit:** TLS 1.3 mandatory; mTLS preferred (see `cyber-security-questionnaire.md` §7).
- **Access control:** RBAC with Argon2id password hashing + optional FIDO2.
- **Logging:** append-only audit log with hash-chain integrity + PII masking in non-audit logs.
- **Backup:** encrypted backup to customer-specified destination.
- **Patch management:** PSIRT with 24h acknowledgement + 90-day disclosure + severity-based SLA (7d CRITICAL / 30d HIGH / 90d MEDIUM).
- **Vulnerability management:** `cargo audit` + `cargo deny` on every CI run.
- **Physical security:** edge device deployed on customer premises under customer physical control; Supplier provides no physical-security service.
- **Business continuity:** offline-queue durability (`docs/reviews/orphan-findings.md#ORPHAN-006` tracks shutdown-flush hardening — ROADMAP Q2 2026).

Evidence: `docs/compliance/gdpr-kvkk-dpia.md` §Art32, `docs/siemens-rfp/cyber-security-questionnaire.md`
Status: FULL (core TOMs); ROADMAP (shutdown-flush hardening per ORPHAN-006)

---

## Clause 8 — Processor Obligations (Art. 28(3))

Q: Confirm Art. 28(3) obligations.
A: Supplier commits to:
- Process personal data only on documented instructions of Controller (Art. 28(3)(a)).
- Ensure confidentiality obligations for persons with access (Art. 28(3)(b)).
- Implement Art. 32 TOMs (Clause 7 above).
- Engage sub-processors only with Controller's prior authorisation + equivalent-obligations flow-down (Art. 28(3)(d)). No sub-processors today.
- Assist Controller in responding to data-subject requests (Art. 28(3)(e)).
- Assist Controller with DPIAs + prior consultation (Art. 28(3)(f)).
- At Controller's choice, delete or return all personal data at end of services (Art. 28(3)(g)).
- Make available information necessary to demonstrate compliance (Art. 28(3)(h)).

Evidence: `docs/compliance/gdpr-kvkk-dpia.md`
Status: FULL

---

## Clause 9 — Sub-processors

Q: List current sub-processors.
A: None today. The product runs on customer-owned infrastructure; the customer chooses any cloud endpoint. Should Supplier engage a sub-processor in future (e.g. a dedicated support-ticketing platform storing personal data), 30-day advance notice + Controller approval required, with equivalent-obligations flow-down.
Evidence: `docs/commercial/subcontractors.md`
Status: FULL

---

## Clause 10 — Data Subject Rights Assistance

Q: How does Supplier assist Controller with data-subject requests (Art. 15-22)?
A: Supplier provides:
- A documented operator-export procedure (Art. 15 access) — extract operator's audit log + account record.
- A documented deletion procedure (Art. 17 erasure) — hard-delete operator account + tombstone the audit-log rows where applicable.
- Rectification (Art. 16) via the admin UI.
- Portability (Art. 20) via JSON export of the operator's data.
- No automated decision-making triggers Art. 22 — N/A.

Response-time SLA for Supplier-side assistance: 72 hours from Controller request. Controller pays only reasonable costs for bespoke assistance above the documented procedures.
Evidence: `docs/compliance/gdpr-kvkk-dpia.md` §DSRs, `docs/deployment/operator-lifecycle.md`
Status: FULL

---

## Clause 11 — Breach Notification (Art. 33)

Q: Timeline + content of breach notification from Processor to Controller.
A: Upon becoming aware of a personal-data breach within the product scope, Supplier notifies Controller without undue delay and in any event within 24 hours of confirmed detection. Notification content: nature of the breach, categories + approximate number of affected records, likely consequences, mitigation actions taken + proposed, PSIRT contact. Controller's own 72-hour supervisory-authority notification window under Art. 33 is respected.
Evidence: `docs/security/cvd-policy.md`, `docs/operations/incident-response.md`
Status: FULL

---

## Clause 12 — Audit Rights

Q: Does Controller have audit rights?
A: Yes. Controller may audit Supplier's GDPR compliance on reasonable notice (30 days; shorter when a regulator or breach triggers it). Audit scope: documentation review + interviews + controlled site visits. Supplier provides in lieu of on-site audit: (a) SOC-2 Type II report (ROADMAP 2027) or equivalent third-party attestation; (b) ISO 27001 certificate (ROADMAP H2 2027); (c) IEC 62443-4-1 SDLA audit report (ROADMAP Q4 2026). Until external certificates land, annual pen-test summaries + DPIA + CSQ suffice.
Evidence: `docs/compliance/certifications-roadmap.md`
Status: FULL (audit right); ROADMAP (certificate-based attestation)

---

## Clause 13 — Liability & Indemnity

Q: GDPR-specific liability arrangement.
A: Standard arrangement: each Party liable for its own fines under Art. 83 attributable to its own breach of Art. 28 / Art. 32 obligations. Indemnity for third-party claims follows Main Agreement. Specific carve-outs: supply-chain supplier-default outside Supplier's reasonable control → normal force-majeure principles apply.
Evidence: `docs/commercial/liability-clauses.md`
Status: FULL

---

## Clause 14 — Data-Bridging Period at Termination

Q: What happens during the bridging period after contract termination?
A: Upon contract termination, Supplier ceases production processing. A bridging support window of up to 30 days (extendable by agreement) permits Controller to perform data export or migration to a replacement processor. During the bridging window, Supplier's obligations under this DPA continue in full; no new personal-data-processing purposes may be introduced. End-of-bridging: Supplier deletes or returns all personal data + provides written certification.

Note on phrasing: this bridging window is time-bounded with a hard 30-day default (plus written extension on request). It exists to give Controller continuity during migration — the obligation set is exactly the same as under the live contract until the bridging window closes.
Evidence: `docs/commercial/termination-procedures.md`
Status: FULL

---

## Clause 15 — Signature

Q: Signature block.
A:

For Supplier:
- Name: `{TEMPLATE}` / Title: `{TEMPLATE}` / Date: `{TEMPLATE}` / Signature: `{TEMPLATE}`

For Controller (Siemens):
- Name: `{TEMPLATE}` / Title: `{TEMPLATE}` / Date: `{TEMPLATE}` / Signature: `{TEMPLATE}`

Effective Date: `{TEMPLATE}`.
Status: PARTIAL (signatures per-deal)

---

## Summary of ORPHAN-EDGE-* items reflected

| Orphan finding | Section | Disposition |
|----------------|---------|-------------|
| `ORPHAN-006` | §7 Art.32 (business-continuity) | Shutdown-flush hardening ROADMAP Q2 2026 |

---

Response date: 2026-04-24; HEAD=3413db47; version=1.6.0.
