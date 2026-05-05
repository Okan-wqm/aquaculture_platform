# Siemens RFP Response Package — Landing Page

**Product:** `sens-api-gateway` v1.6.0
**HEAD:** 3413db47
**Response date:** 2026-04-24
**Package owner:** `siemens-rfp-responder` (Lane-C producer, edge-docs agent team)

This directory contains the Siemens-facing response to a typical Siemens RFP / Vendor Assessment Questionnaire / Cyber Security Questionnaire / MindSphere Partner / TIA Portal onboarding / Supplier Code of Conduct / GDPR DPA package. Every document is Siemens-indexed (question-by-question) and cites the underlying engineering evidence in the rest of `sens-api-gateway/docs/`.

---

## 1. Aggregate Completeness Dashboard

| Dimension | FULL | PARTIAL | ROADMAP | N-A | Total Q |
|-----------|------|---------|---------|-----|---------|
| Vendor Assessment (VAQ) | 5 | 7 | 1 | 2 | 15 |
| Cyber Security (CSQ) | 17 | 9 | 6 | 1 | 33 |
| PROFINET Conformance | 0 | 0 | 0 | 7 | 7 |
| MindSphere Readiness | 0 | 1 | 6 | 4 | 11 |
| TIA Portal Onboarding | 2 | 1 | 3 | 3 | 9 |
| Code of Conduct | 11 | 0 | 0 | 1 | 12 |
| Supply Chain | 5 | 2 | 3 | 2 | 12 |
| Sustainability / ESG | 7 | 1 | 1 | 3 | 12 |
| GDPR DPA | 14 | 1 | 0 | 0 | 15 |
| Pricing / Commercial | 6 | 5 | 0 | 2 | 13 |
| **Aggregate** | **67** | **27** | **20** | **25** | **139** |

### Aggregate percentages

- **FULL:** 67 / 139 = **48.2%**
- **PARTIAL:** 27 / 139 = **19.4%**
- **ROADMAP:** 20 / 139 = **14.4%**
- **N-A:** 25 / 139 = **18.0%**

N-A rows are dominated by:
- PROFINET (7) — product is not a PROFINET IO device.
- HARDWARE-VENDOR RESPONSIBILITY rows across ESG + supply-chain + pricing (8) — firmware supplier, not a hardware reseller.
- MindSphere gated-on-Q2-connector rows (4) — inherit N-A until native connector lands.

---

## 2. Document Index

| # | File | Scope |
|---|------|-------|
| 01 | `vendor-assessment.md` | Generic Siemens VAQ — 15 questions across 10 sections |
| 02 | `cyber-security-questionnaire.md` | Siemens CSQ — 33 questions across 17 sections |
| 03 | `profinet-conformance.md` | PROFINET Conformance Class declaration (headline: NONE; NOT-PLANNED) |
| 04 | `mindsphere-readiness.md` | MindSphere / Insights Hub partner readiness (headline: NOT IMPLEMENTED — ROADMAP Q2-Q3 2026) |
| 05 | `tia-portal-onboarding.md` | TIA Portal device onboarding items |
| 06 | `siemens-code-of-conduct.md` | Siemens Supplier Code of Conduct attestation template |
| 07 | `supply-chain-questionnaire.md` | Supply-chain security + SBOM + SLSA + conflict minerals |
| 08 | `sustainability-esg.md` | ESG questionnaire |
| 09 | `gdpr-data-protection-addendum.md` | GDPR Art. 28 DPA template |
| 10 | `pricing-commercial.md` | Commercial terms (all numbers `{TEMPLATE}` — set per-deal during negotiation) |
| 11 | `rfp-cover-letter.md` | RFP response cover letter template |
| 12 | `README.md` | This file |

---

## 3. Siemens-Question → Our-Doc Cross-Reference Matrix

The following matrix maps a typical Siemens evaluation question to the answering document. Use this as the audit entry point.

### Company + Product + Commercial

| Siemens question family | Answer document | Evidence chapters |
|--------------------------|-----------------|-------------------|
| Company legal identity + HQ | `vendor-assessment.md` §1 | `docs/commercial/corporate-identity.md` |
| Financial stability | `vendor-assessment.md` §7 | `docs/commercial/financial-disclosure.md` |
| Product description + positioning | `vendor-assessment.md` §2 | `docs/product/overview.md`, `docs/product/positioning.md` |
| Reference customers | `vendor-assessment.md` §3 | `docs/commercial/reference-customers.md` |
| IP policy + licensing | `vendor-assessment.md` §9 + `pricing-commercial.md` §1 | `docs/commercial/licensing.md`, `docs/commercial/ip-policy.md` |
| Insurance certificates | `vendor-assessment.md` §7 + §10 | `docs/commercial/insurance-certificates.md` |
| Pricing + support | `pricing-commercial.md` | `docs/commercial/pricing.md`, `docs/operations/support-tiers.md` |

### Cyber Security

| Siemens question family | Answer document | Evidence chapters |
|--------------------------|-----------------|-------------------|
| PSIRT / CVD contact | `cyber-security-questionnaire.md` §1, §6 | `docs/security/cvd-policy.md` |
| Threat model | `cyber-security-questionnaire.md` §2 | `docs/security/threat-model.md`, `docs/security/attack-surface.md` |
| SDLA (IEC 62443-4-1) | `cyber-security-questionnaire.md` §3 | `docs/compliance/iec62443-4-1-sdla.md` |
| Secure coding | `cyber-security-questionnaire.md` §4 | `docs/testing/security-testing.md` |
| Dependency management | `cyber-security-questionnaire.md` §5 | `sens-api-gateway/deny.toml`, `docs/testing/security-testing.md` |
| Crypto inventory | `cyber-security-questionnaire.md` §7 | `docs/security/crypto-inventory.md` |
| PKI + key management | `cyber-security-questionnaire.md` §8 | `docs/security/pki-hierarchy.md`, `docs/security/credentials-handling.md` |
| RBAC + authn | `cyber-security-questionnaire.md` §9 | `docs/api/rbac-manifest.md`, `docs/security/authz-model.md` |
| Audit log + PII masking | `cyber-security-questionnaire.md` §10 | `docs/security/audit-log.md` |
| OTA + patch SLA | `cyber-security-questionnaire.md` §11 | `docs/deployment/ota-firmware-update.md`, `docs/security/cvd-policy.md` |
| IR plan | `cyber-security-questionnaire.md` §12 | `docs/operations/incident-response.md` |
| Physical + tamper | `cyber-security-questionnaire.md` §13 | `docs/security/attack-surface.md` |
| GDPR / privacy | `cyber-security-questionnaire.md` §14 + `gdpr-data-protection-addendum.md` | `docs/compliance/gdpr-kvkk-dpia.md` |
| 3rd-party pentest | `cyber-security-questionnaire.md` §15 | `docs/testing/security-testing.md` |
| Certification posture | `cyber-security-questionnaire.md` §16 | `docs/compliance/certifications-roadmap.md` |
| SBOM + build reproducibility | `cyber-security-questionnaire.md` §17 + `supply-chain-questionnaire.md` §2 | `docs/security/sbom.md` |

### Siemens-specific

| Siemens question family | Answer document | Evidence chapters |
|--------------------------|-----------------|-------------------|
| PROFINET conformance | `profinet-conformance.md` | `docs/protocols/`, `docs/integration/siemens/` |
| PI Vendor ID + GSDML | `profinet-conformance.md` + `tia-portal-onboarding.md` §Q1-Q3 | n/a (NONE) |
| MindSphere / Insights Hub | `mindsphere-readiness.md` | `docs/integration/siemens/mindsphere-connector.md` (ROADMAP) |
| TIA Portal version + onboarding | `tia-portal-onboarding.md` | `docs/integration/siemens/tia-portal.md`, `docs/protocols/opc-ua.md`, `docs/protocols/s7comm.md` |
| WinCC compatibility | `tia-portal-onboarding.md` §Q7 | `docs/integration/siemens/wincc-tag-bridge.md` |
| S7 PLC families supported | `tia-portal-onboarding.md` §Q5 | `docs/protocols/s7comm.md` |
| Supplier Code of Conduct | `siemens-code-of-conduct.md` | `docs/commercial/anti-corruption-policy.md`, `docs/commercial/human-rights-policy.md` |

### Supply Chain + Sustainability

| Siemens question family | Answer document | Evidence chapters |
|--------------------------|-----------------|-------------------|
| Conflict minerals (3TG / cobalt) | `supply-chain-questionnaire.md` §1 + `sustainability-esg.md` §3 | HARDWARE-VENDOR RESPONSIBILITY flow-down |
| SBOM + SLSA | `supply-chain-questionnaire.md` §2, §3 | `docs/security/sbom.md` |
| Signed releases | `supply-chain-questionnaire.md` §4 | `docs/security/pki-hierarchy.md`, ADR-032 |
| Build reproducibility | `supply-chain-questionnaire.md` §5 | `sens-api-gateway/Cargo.lock`, `docs/security/sbom.md` |
| SDLA certification | `supply-chain-questionnaire.md` §6 | `docs/compliance/iec62443-4-1-sdla.md` |
| Energy + CO2 + e-waste | `sustainability-esg.md` §1, §2, §4 | `docs/operations/energy-profile.md`, `docs/testing/soak-tests.md` |
| Social impact / SDGs | `sustainability-esg.md` §6 | `docs/commercial/impact-cases.md` |
| CSRD report | `sustainability-esg.md` §7 | ROADMAP 2027 Q1 |

### GDPR

| Siemens question family | Answer document | Evidence chapters |
|--------------------------|-----------------|-------------------|
| Controller / Processor roles | `gdpr-data-protection-addendum.md` §1 | `docs/compliance/gdpr-kvkk-dpia.md` |
| Subject matter + categories | `gdpr-data-protection-addendum.md` §2, §5 | `docs/compliance/gdpr-kvkk-dpia.md` |
| Retention | `gdpr-data-protection-addendum.md` §3 | `docs/security/audit-log.md` |
| International transfers / SCCs | `gdpr-data-protection-addendum.md` §6 | `docs/commercial/data-residency.md` |
| TOMs (Art. 32) | `gdpr-data-protection-addendum.md` §7 | `docs/siemens-rfp/cyber-security-questionnaire.md` |
| Art. 28(3) obligations | `gdpr-data-protection-addendum.md` §8 | `docs/compliance/gdpr-kvkk-dpia.md` |
| Sub-processors | `gdpr-data-protection-addendum.md` §9 | `docs/commercial/subcontractors.md` |
| Data subject rights | `gdpr-data-protection-addendum.md` §10 | `docs/compliance/gdpr-kvkk-dpia.md`, `docs/deployment/operator-lifecycle.md` |
| Breach notification | `gdpr-data-protection-addendum.md` §11 | `docs/security/cvd-policy.md`, `docs/operations/incident-response.md` |
| Audit rights | `gdpr-data-protection-addendum.md` §12 | `docs/compliance/certifications-roadmap.md` |

---

## 4. Outstanding Actions to Close Gaps

These are the ROADMAP rows; closing them lifts the FULL percentage above 50%.

| Gap | Target | Driver | Owner |
|-----|--------|--------|-------|
| IEC 62443-4-1 SDLA external certification | Q4 2026 | `cyber-security-questionnaire.md` §3 | `compliance-evidence-writer` owner + external auditor |
| IEC 62443-4-2 SL-2 certification | Q1 2027 | `docs/compliance/certifications-roadmap.md` | compliance + external auditor |
| ISO 9001 | 2027 | `vendor-assessment.md` §4 | quality owner |
| ISO/IEC 27001 organisational | H2 2027 | `cyber-security-questionnaire.md` §16 | organisational CISO |
| CSRD ESG report | 2027 Q1 | `sustainability-esg.md` §7 | ESG owner |
| SBOM SPDX / CycloneDX emit | Q2 2026 | `supply-chain-questionnaire.md` §2 | `security-architecture-writer` |
| OTA signed update pipeline on edge | 2026-07-30 (ORPHAN-018) | `cyber-security-questionnaire.md` §11, `supply-chain-questionnaire.md` §4 | edge-agent maintainers |
| Automated cosign-verify gate in deploy | 2026-06-30 (ORPHAN-021) | `supply-chain-questionnaire.md` §3 | SRE + platform-infra |
| MindSphere Partner Programme enrollment | Q2 2026 | `mindsphere-readiness.md` Q1 | commercial + partner-manager |
| MindConnect Library Rust adapter | Q2-Q3 2026 | `mindsphere-readiness.md` Q2 | `siemens-integration-writer` owner |
| Insights Hub Partner certification | Q4 2026 | `mindsphere-readiness.md` Q6 | test + certification |
| OPC UA stack migration to TIA-verified crate | Q3-Q4 2026 (ORPHAN-EDGE-005) | `tia-portal-onboarding.md` Q4 | edge-agent maintainers |
| TIA Portal Openness tag export | Q3 2026 | `tia-portal-onboarding.md` Q6 | `siemens-integration-writer` |
| MQTT mTLS-mandatory posture | Q3 2026 | `cyber-security-questionnaire.md` §7, §8 | `security-architecture-writer` |
| Audit-log shutdown-flush (ORPHAN-006) | Q2 2026 | `cyber-security-questionnaire.md` §10, `gdpr-data-protection-addendum.md` §7 | edge-agent maintainers |
| First external pentest | Q3 2026 | `cyber-security-questionnaire.md` §15 | security + external pentester |

---

## 5. ORPHAN-EDGE-* Findings Reflected

This package honestly reflects the following `docs/reviews/orphan-findings.md` entries:

- `ORPHAN-001` — OpenTelemetry coupled-release-family grouping (supply-chain Q7.2).
- `ORPHAN-005` — SUDERRA_DATA_DIR env-redirect production-refuse gate (CSQ §8).
- `ORPHAN-006` — Offline-queue shutdown flush is a no-op (CSQ §10, GDPR §7).
- `ORPHAN-010` — systemd ReadWritePaths divergence (RESOLVED in Batch 4a; CSQ §8 reflects resolution).
- `ORPHAN-018` — OTA signed update pipeline undocumented (CSQ §11, supply-chain §4).
- `ORPHAN-021` — Deploy-time cosign-verify gate missing (supply-chain §3).

Each of the above is tracked with owner + deadline + closure path in `docs/reviews/orphan-findings.md`.

---

## 6. Language + Footer Discipline

- Language: English only (Siemens-facing mandate).
- Answer format per question: `Q: ... / A: ... / Evidence: docs/... / Status: FULL | PARTIAL | ROADMAP | N-A`.
- Completeness dashboard at the top of every document.
- Footer: `Response date: YYYY-MM-DD; HEAD=<sha>; version=<v>.`

---

Response date: 2026-04-24; HEAD=3413db47; version=1.6.0.
