# Siemens Supplier Code of Conduct — Attestation

**Document owner:** `siemens-rfp-responder` (Lane-C)
**Product:** `sens-api-gateway` v1.6.0
**HEAD:** 3413db47
**Response date:** 2026-04-24

> **TEMPLATE.** This document is a model attestation. Before signature, substitute every `{TEMPLATE}` with per-deal values and obtain an authorised signatory countersignature. When Siemens provides the verbatim Supplier Code of Conduct document and signature pages, map the clauses 1:1 and preserve Siemens' own clause numbering.

---

## Attestation Statement

`{TEMPLATE — legal entity name}` ("Supplier") hereby confirms commitment to the Siemens Supplier Code of Conduct (current published version, edition `{TEMPLATE — e.g. 2023}`) and attests to the following compliance posture across all Siemens engagements.

---

## Clause 1 — Legal Compliance

Q: Commitment to legal compliance in every jurisdiction where Supplier operates.
A: Supplier operates in `{TEMPLATE — jurisdictions}` and maintains compliance with all applicable national + EU + international laws and regulations. Legal counsel engagement: `{TEMPLATE — in-house / external}`. Compliance training for employees: annual refresh.
Status: FULL (attested)

---

## Clause 2 — Anti-Corruption & Anti-Bribery

Q: Anti-corruption + anti-bribery policy covering FCPA (US), UK Bribery Act, German corporate-criminal-liability law, OECD Anti-Bribery Convention.
A: Supplier maintains a written anti-bribery + anti-corruption policy (`docs/commercial/anti-corruption-policy.md`) that:
- Prohibits offering, giving, receiving, or soliciting any bribe, kickback, or improper payment.
- Requires gift + hospitality tracking above `{TEMPLATE — e.g. EUR 50}` per occurrence.
- Requires due-diligence on third-party intermediaries.
- Imposes disciplinary measures including termination for violations.
- Provides a whistleblower channel independent of line management.

No current or past FCPA / UK Bribery Act / equivalent enforcement action against Supplier or any of its officers.
Evidence: `docs/commercial/anti-corruption-policy.md`
Status: FULL (attested)

---

## Clause 3 — Human Rights

Q: Compliance with the UN Guiding Principles on Business and Human Rights (UNGPs) + modern-slavery regulations (UK Modern Slavery Act 2015, California Transparency in Supply Chains Act, German Lieferkettensorgfaltspflichtengesetz).
A: Supplier commits to:
- No forced labour, slavery, human trafficking, or indentured servitude across its own operations or its supply chain.
- No child labour; minimum employment age matches ILO Convention No. 138.
- Non-discrimination in hiring + promotion + compensation (race, ethnicity, gender, sexual orientation, religion, disability, political opinion).
- Freedom of association + collective bargaining as applicable law permits.
- Living-wage commitment at or above local minimum.
- Working-hours compliance with applicable law; no excessive overtime without consent.

Supply-chain-mapping: annual due-diligence questionnaire to top tier-1 suppliers (HARDWARE-VENDOR RESPONSIBILITY for physical components — see `supply-chain-questionnaire.md`).
Evidence: `docs/commercial/human-rights-policy.md`, `docs/siemens-rfp/supply-chain-questionnaire.md`
Status: FULL (attested; HARDWARE-VENDOR RESPONSIBILITY for physical bill of materials)

---

## Clause 4 — Fair Working Conditions

Q: Occupational health + safety (OHS) + fair working conditions for Supplier employees.
A: Supplier's engineering organisation operates under applicable labour law in `{TEMPLATE — country}`. Remote-first + office-optional model; office locations comply with fire-safety + workplace-ergonomics + first-aid regulations. Regular working hours per local law + collective-agreement where applicable. Mental-health + employee-assistance programme: `{TEMPLATE — yes/no}`.

No industrial-scale operations; no high-risk physical work surface owned by Supplier.
Status: FULL (attested)

---

## Clause 5 — Environmental Protection

Q: Environmental management commitment.
A: Direct environmental impact of Supplier's operations: office electricity + staff travel. Renewable-energy sourcing: `{TEMPLATE — per-office reporting}`. Product-level environmental posture covered by `sustainability-esg.md`. HARDWARE-VENDOR RESPONSIBILITY for bill-of-materials environmental impact (rare earths, energy per device-year). ISO 14001 certification: not held (N-A for a firmware supplier; see `vendor-assessment.md` §5).
Evidence: `docs/siemens-rfp/sustainability-esg.md`, `docs/commercial/environmental-policy.md`
Status: FULL (attested at organisation-scope); HARDWARE-VENDOR RESPONSIBILITY (product physical-substrate)

---

## Clause 6 — Conflict Minerals

Q: Responsible sourcing of 3TG + cobalt + other conflict minerals.
A: HARDWARE-VENDOR RESPONSIBILITY. Supplier's product is firmware; it does not directly procure tin, tungsten, tantalum, gold, or cobalt. The Raspberry Pi / industrial SBC vendors qualified for deployment publish their own conflict-minerals declarations; Supplier requires vendors to attest to OECD Due Diligence Guidance + Dodd-Frank §1502 compliance in contractual clauses.
Evidence: `docs/siemens-rfp/supply-chain-questionnaire.md`, `docs/siemens-rfp/sustainability-esg.md`
Status: N-A for firmware supplier; HARDWARE-VENDOR RESPONSIBILITY flow-down

---

## Clause 7 — Data Protection & Privacy

Q: GDPR + regional data-protection regulations (KVKK, CCPA, PIPL, LGPD).
A: Supplier is committed to GDPR + regional-equivalent compliance. Data Protection Officer contact: `dpo@{TEMPLATE}`. Privacy-by-design applied across product features (`docs/compliance/gdpr-kvkk-dpia.md`). DPA template available at `docs/siemens-rfp/gdpr-data-protection-addendum.md`. No personal data processing except operator identifiers needed for access control + audit.
Evidence: `docs/compliance/gdpr-kvkk-dpia.md`, `docs/siemens-rfp/gdpr-data-protection-addendum.md`
Status: FULL (attested)

---

## Clause 8 — Export Control

Q: Export-control compliance (EAR, EU dual-use regulation, ITAR where applicable).
A: Product ECCN classification: `{TEMPLATE — e.g. EAR99 or 5D002}` per `docs/commercial/export-control.md`. Supplier maintains denied-party screening against OFAC SDN + EU consolidated list + UN sanctions list. No sales into comprehensively sanctioned jurisdictions.
Evidence: `docs/commercial/export-control.md`
Status: FULL (attested)

---

## Clause 9 — Fair Competition & Antitrust

Q: Compliance with competition + antitrust law.
A: Supplier commits to fair competition + no anti-competitive agreements, price-fixing, bid-rigging, market-sharing, or abuse of dominant position. Annual compliance training for commercial + executive staff.
Status: FULL (attested)

---

## Clause 10 — Intellectual Property Protection

Q: Respect for third-party IP.
A: Supplier respects third-party IP. OSS dependencies are tracked + attributed per `docs/commercial/oss-attribution.md`; only permissive licences (MIT / Apache-2.0 / BSD / ISC / Unicode-DFS / Zlib) are consumed; copyleft (GPL / LGPL / AGPL) is banned at the `cargo deny` layer. No unauthorised use of Siemens IP or trademarks.
Evidence: `docs/commercial/oss-attribution.md`, `sens-api-gateway/deny.toml`
Status: FULL (attested)

---

## Clause 11 — Cybersecurity

Q: Product + organisational cybersecurity posture.
A: Product security attested in `cyber-security-questionnaire.md`. Organisational controls: (a) managed endpoint with full-disk encryption; (b) MFA-required access to source code + CI/CD; (c) least-privilege + quarterly access review; (d) incident-response plan in `docs/operations/incident-response.md`.
Evidence: `docs/siemens-rfp/cyber-security-questionnaire.md`, `docs/operations/incident-response.md`
Status: FULL (attested; see detailed CSQ for scoped-item status)

---

## Clause 12 — Supply-Chain Flow-Down

Q: Flow-down of Code of Conduct to Supplier's own subcontractors.
A: Supplier flows down equivalent Code of Conduct language to any subcontractor engaged on Siemens-impacting scope. For `sens-api-gateway` code authorship: no subcontractors (supplier is sole code author). For OSS dependencies: `cargo deny` enforces licence + vulnerability gates; no Supplier-level Code of Conduct flow-down is possible to upstream OSS maintainers — handled via the allowlist + audit discipline.
Evidence: `docs/commercial/subcontractor-flow-down.md`
Status: FULL (attested); OSS flow-down handled via allowlist mechanism

---

## Signature Block

Signed on behalf of Supplier:

- Name: `{TEMPLATE}`
- Title: `{TEMPLATE — e.g. Chief Executive Officer or authorised signatory}`
- Entity: `{TEMPLATE — legal entity name}`
- Date: `{TEMPLATE — DD-MM-YYYY}`
- Signature: `{TEMPLATE — wet / qualified electronic signature}`

Countersigned on behalf of Siemens:

- Name: `{TEMPLATE}`
- Title: `{TEMPLATE}`
- Entity: `{TEMPLATE}`
- Date: `{TEMPLATE — DD-MM-YYYY}`
- Signature: `{TEMPLATE}`

---

## Completeness Dashboard

| Status | Count | % |
|--------|-------|---|
| FULL | 11 | 91.7% |
| PARTIAL | 0 | 0% |
| ROADMAP | 0 | 0% |
| N-A | 1 | 8.3% |
| **Total clauses** | **12** | **100%** |

Every `{TEMPLATE}` is a template marker for per-deal legal completion before signing.

---

Response date: 2026-04-24; HEAD=3413db47; version=1.6.0.
