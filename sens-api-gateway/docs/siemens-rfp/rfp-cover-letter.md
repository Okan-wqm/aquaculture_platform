# RFP Response — Cover Letter

**Document owner:** `siemens-rfp-responder` (Lane-C)
**Product:** `sens-api-gateway` v1.6.0
**HEAD:** 3413db47
**Response date:** 2026-04-24

> **TEMPLATE.** Replace every `{TEMPLATE}` placeholder before dispatch. Retain the substantive paragraphs — they are the factual scope of the response + the declared gaps.

---

`{TEMPLATE — Supplier letterhead}`

2026-04-24

Siemens `{TEMPLATE — division}`
`{TEMPLATE — street address}`
`{TEMPLATE — postcode + city + country}`

Attention: `{TEMPLATE — Siemens Procurement Lead, by name}`
CC: `{TEMPLATE — Siemens Technical Evaluation Lead, by name}`

---

**Subject: Response to Request for Proposal `{TEMPLATE — RFP ID + title}` — `sens-api-gateway` industrial edge gateway**

Dear `{TEMPLATE — Siemens procurement lead}`,

We acknowledge receipt of Siemens' Request for Proposal `{TEMPLATE — RFP ID}` dated `{TEMPLATE — RFP issue date}`, and we are pleased to submit our response. This cover letter summarises the response package and highlights the commitments + honestly-declared gaps.

## 1. Response Completeness

Our response package is structured as twelve Siemens-indexed documents under `sens-api-gateway/docs/siemens-rfp/`:

| Document | Siemens scope |
|----------|---------------|
| `vendor-assessment.md` | Generic VAQ — company, product, quality |
| `cyber-security-questionnaire.md` | Siemens CSQ — 33 questions across 17 sections |
| `profinet-conformance.md` | PROFINET Conformance Class declaration |
| `mindsphere-readiness.md` | MindSphere / Insights Hub readiness checklist |
| `tia-portal-onboarding.md` | TIA Portal device-vendor onboarding |
| `siemens-code-of-conduct.md` | Supplier Code of Conduct attestation |
| `supply-chain-questionnaire.md` | Supply-chain security + SBOM + SLSA |
| `sustainability-esg.md` | ESG + sustainability |
| `gdpr-data-protection-addendum.md` | GDPR Art. 28 DPA template |
| `pricing-commercial.md` | Commercial structure (`{TEMPLATE}` numbers set per-deal during negotiation) |
| `rfp-cover-letter.md` | This letter |
| `README.md` | Cross-reference matrix Siemens-question → our-doc |

Every answer is machine-countable against the completeness dashboard in `README.md`.

## 2. Product Summary

`sens-api-gateway` is a Rust industrial edge gateway implementing multi-protocol field-bus acquisition (Modbus-TCP/RTU, OPC UA, S7comm, EtherNet/IP, ADS, Codesys, LoRaWAN, MQTT, I2C, SPI, PWM, GPIO, Atlas EZO), ISA-18.2-aware alarm engine, scripting runtime, backup + OTA surface. Primary verticals: aquaculture, greenhouse/hydroponics, water/wastewater, small-scale process industry. Current release is v1.6.0; git HEAD at response time 3413db47.

## 3. Honestly-Declared Gaps

Siemens evaluators correctly penalise false FULL claims. We therefore state the non-FULL positions up front:

- **PROFINET conformance: NONE.** The product is not a PROFINET IO device and PROFINET IO certification is not planned in the current 24-month roadmap. Siemens PROFINET-connected signals are reached via OPC UA Client + S7comm paths.
- **MindSphere / Insights Hub: NOT IMPLEMENTED.** Native connector ROADMAP Q2-Q3 2026; generic MQTT bridge available today.
- **ISO 9001 / IEC 62443-4-1 SDLA certifications: ROADMAP (not held).** Practice evidence is in place; formal external certification Q4 2026.
- **SBOM in SPDX format: ROADMAP Q2 2026** (today: `Cargo.lock` + OSS attribution file).
- **OTA signed update pipeline on edge binary: ROADMAP 2026-07-30** (tracked as `ORPHAN-018`).
- **MQTT mTLS-mandatory posture: ROADMAP Q3 2026** (today: TLS-mandatory, mTLS optional).

Every gap above is tracked in `docs/reviews/orphan-findings.md` with owner + deadline.

## 4. Siemens-Specific Commitments

If Siemens awards the engagement, we commit to:

1. Enrolling in the Siemens Industrial IoT Partner Programme at the "Application Partner — Device Integration" tier within 60 days of contract signature.
2. Delivering the MindConnect Library Rust adapter per the scope + timeline in `mindsphere-readiness.md` §Roadmap.
3. Participating in the TIA Portal Openness integration sprint per `tia-portal-onboarding.md` Q3 2026 target.
4. Aligning the IEC 62443-4-1 external certification schedule with the Siemens audit window.
5. Furnishing the signed Siemens Supplier Code of Conduct attestation + the GDPR DPA + the NDA + insurance certificates within 15 business days of contract drafting.

## 5. Commercial Terms

Commercial scope + terms summarised in `pricing-commercial.md`. All `{TEMPLATE}` numbers set per-deal during negotiation, based on confirmed scope, volume, support tier, and jurisdiction. Initial pricing assumes Siemens as an enterprise-tier customer on a 3-year term with the Silver support tier as baseline, subject to refinement per Siemens' final scope-of-work.

## 6. Point of Contact

Primary contact for this RFP:
- Name: `{TEMPLATE — Supplier commercial lead}`
- Role: `{TEMPLATE — Head of Sales / Chief Commercial Officer}`
- Email: `{TEMPLATE}`
- Phone: `{TEMPLATE}`

Technical contact:
- Name: `{TEMPLATE — Supplier technical lead}`
- Role: `{TEMPLATE — Engineering Lead or CTO}`
- Email: `{TEMPLATE}`
- Phone: `{TEMPLATE}`

PSIRT (for CVD / security-incident coordination): `security@{TEMPLATE}`.

## 7. Next-Step Invitation

We invite Siemens to a Q&A session to walk through the response package, the declared gaps + roadmap, and any clarification Siemens' evaluation team requires. Proposed slot: any time within the next 10 business days; our team is flexible on scheduling.

We look forward to a productive engagement and to supporting Siemens' industrial-automation mission with a transparent, IEC-62443-aligned, Rust-engineered edge gateway.

Yours sincerely,

`{TEMPLATE — Signatory name}`
`{TEMPLATE — Signatory title, e.g. Chief Executive Officer}`
`{TEMPLATE — Supplier legal entity}`

---

Enclosures:
1. `vendor-assessment.md`
2. `cyber-security-questionnaire.md`
3. `profinet-conformance.md`
4. `mindsphere-readiness.md`
5. `tia-portal-onboarding.md`
6. `siemens-code-of-conduct.md`
7. `supply-chain-questionnaire.md`
8. `sustainability-esg.md`
9. `gdpr-data-protection-addendum.md`
10. `pricing-commercial.md`
11. `README.md` (cross-reference matrix)
12. This cover letter

---

Response date: 2026-04-24; HEAD=3413db47; version=1.6.0.
