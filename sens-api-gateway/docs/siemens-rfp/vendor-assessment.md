# Vendor Assessment Questionnaire (VAQ) — Siemens Supplier Onboarding

**Document owner:** `siemens-rfp-responder` (Lane-C)
**Product:** `sens-api-gateway` — Rust industrial edge gateway
**Version:** v1.6.0
**HEAD:** 3413db47
**Response date:** 2026-04-24

> **TEMPLATE NOTICE.** Section numbering in this document follows a typical Siemens VAQ structure. When Siemens provides the actual VAQ PDF/XLSX, the numbering here MUST be replaced verbatim with Siemens' own question IDs. Content answers stay; question-ID keys change.

---

## Completeness Dashboard

| Status | Count | % |
|--------|-------|---|
| FULL | 5 | 33.3% |
| PARTIAL | 7 | 46.7% |
| ROADMAP | 1 | 6.7% |
| N-A | 2 | 13.3% |
| **Total questions** | **15** | **100%** |

---

## Section 1 — Company Overview

### Q1.1 — Legal entity, HQ, form

Q: State the legal entity name, headquarters address, legal form, and country of incorporation.
A: Legal entity name: `{TEMPLATE — sales fills per deal}`. HQ: `{TEMPLATE}`. Legal form: `{TEMPLATE — e.g. Limited liability company}`. Country of incorporation: `{TEMPLATE}`. Product is owned, engineered, and maintained by this entity. No subsidiary or joint-venture ownership of the `sens-api-gateway` codebase.
Evidence: `docs/commercial/corporate-identity.md` (commercial-legal-writer output)
Status: PARTIAL (sales fills template values per deal)

### Q1.2 — Founding date + employee count

Q: Year of founding and current employee count (FTE).
A: Founding: `{TEMPLATE}`. Current FTE: `{TEMPLATE}`. Engineering team dedicated to `sens-api-gateway`: `{TEMPLATE}` FTE (Rust/Embedded).
Evidence: `docs/commercial/corporate-identity.md`
Status: PARTIAL (sales fills template values per deal)

### Q1.3 — Financial stability tier

Q: Provide financial stability indicator (revenue bracket, Dun & Bradstreet rating, or equivalent).
A: Revenue bracket: `{TEMPLATE — e.g. EUR 5M-10M annual}`. D-U-N-S number: `{TEMPLATE}`. Public filings: `{TEMPLATE — private company, no public filings / public filings at <URL>}`. Upon request and under NDA, audited financial statements provided for the most recent 2 fiscal years.
Evidence: `docs/commercial/financial-disclosure.md`
Status: PARTIAL (NDA-gated, sales fills per deal)

---

## Section 2 — Product Overview

### Q2.1 — Product description + positioning

Q: Describe the product offered to Siemens and its intended use.
A: `sens-api-gateway` is a Rust industrial edge gateway running on ARM64/armv7 single-board computers (Raspberry Pi 4 class, industrial-grade yocto targets). It implements multi-protocol field-bus acquisition (Modbus-TCP/RTU, OPC UA, S7comm, EtherNet/IP, ADS, Codesys, LoRaWAN, MQTT, I2C, SPI, PWM, GPIO, Atlas EZO), an alarm engine (ISA-18.2 aware), a scripting engine for edge logic, and a backup/OTA surface. The gateway connects industrial field equipment to cloud or on-premise MES/SCADA via MQTT / OPC UA Client. Positioning comparable to Siemens MindConnect Nano, AWS IoT Greengrass, Red Lion FlexEdge.
Evidence: `docs/product/overview.md`, `docs/product/positioning.md`, `docs/product/feature-matrix.md`
Status: FULL

### Q2.2 — Use-case catalogue

Q: List the top 5 use-cases delivered today.
A: (1) Aquaculture water-quality monitoring with Atlas EZO probes (pH, DO, EC, ORP) + automated dosing actuation; (2) Hydroponics/greenhouse fertigation with PWM-driven pumps; (3) Industrial Modbus-TCP/RTU PLC telemetry aggregation; (4) OPC UA / S7comm cloud bridge for MES integration; (5) LoRaWAN remote telemetry for off-grid sites.
Evidence: `docs/product/use-cases.md`, `docs/SCENARIOS_BEYOND_SCADA.md`
Status: FULL

---

## Section 3 — Target Markets + Reference Customers

### Q3.1 — Reference customers

Q: Name 3 reference customers and the sector they operate in. Describe deployment size.
A: `{TEMPLATE — sales fills reference customer list per deal, typically under NDA}`. Aggregate install-base as of 2026-04-24: `{TEMPLATE — e.g. N sites across aquaculture + greenhouse sectors}`. Siemens-facing reference-customer list provided under mutual NDA.
Evidence: `docs/commercial/reference-customers.md`
Status: PARTIAL (NDA-gated per-deal disclosure)

### Q3.2 — Target market sectors

Q: List target sectors + geographic reach.
A: Primary sectors: aquaculture (recirculating systems, pond farms), greenhouse/hydroponics, small-scale process industry, water/wastewater treatment. Geographic reach: Europe + Middle East + North Africa; export-control compliant per ECCN classification (`docs/commercial/export-control.md`).
Evidence: `docs/commercial/target-markets.md`, `docs/commercial/export-control.md`
Status: FULL

---

## Section 4 — Quality Management (ISO 9001)

### Q4.1 — ISO 9001 certification

Q: Is the supplier certified to ISO 9001? If yes, provide certificate number and certifying body.
A: Not currently held. Quality management practice follows an internal Software Development Life-Cycle Assurance (SDLA) discipline aligned with IEC 62443-4-1; formal ISO 9001 certification is on the compliance roadmap for 2027. In the absence of certification the product quality is demonstrated via: (a) 100% reproducible builds (Cargo.lock committed), (b) tier-gated CI with `cargo clippy -D warnings` wall + `cargo test` + `cargo audit` + `cargo deny` on every PR, (c) IEC 62443-4-1 SDLA evidence file, (d) published test-coverage reports.
Evidence: `docs/compliance/certifications-roadmap.md`, `docs/compliance/iec62443-4-1-sdla.md`, `docs/testing/test-strategy.md`
Status: ROADMAP (ISO 9001 target 2027)

---

## Section 5 — Environmental Management (ISO 14001)

### Q5.1 — ISO 14001 certification

Q: Is the supplier certified to ISO 14001?
A: Not currently held. Environmental posture tracked in `docs/siemens-rfp/sustainability-esg.md` covering per-device energy profile, e-waste posture (HARDWARE-VENDOR RESPONSIBILITY), and firmware-lifecycle reuse policy. ISO 14001 certification not on the near-term roadmap; the product's direct environmental footprint (a Rust binary shipped as a Docker image or a .deb package) is dominated by the hardware substrate which is HARDWARE-VENDOR RESPONSIBILITY.
Evidence: `docs/siemens-rfp/sustainability-esg.md`
Status: N-A (product is firmware; hardware environmental posture is HARDWARE-VENDOR RESPONSIBILITY)

---

## Section 6 — Occupational Health & Safety (ISO 45001)

### Q6.1 — ISO 45001 certification

Q: Is the supplier certified to ISO 45001?
A: Not currently held. The product is a firmware engineering deliverable; occupational health + safety posture for the engineering organisation follows applicable labour law in the country of incorporation (`{TEMPLATE}`). No field-operations workforce; therefore no industrial OHS risk surface owned by this supplier.
Evidence: `docs/commercial/hse-policy.md`
Status: N-A

---

## Section 7 — Financial Disclosure

### Q7.1 — Revenue bracket

Q: Annual revenue bracket.
A: `{TEMPLATE}`. Exact figure provided under NDA on request.
Evidence: `docs/commercial/financial-disclosure.md`
Status: PARTIAL (NDA-gated)

### Q7.2 — Insurance cover

Q: Product liability + professional indemnity insurance coverage amounts.
A: Product liability: `{TEMPLATE — e.g. EUR 2M aggregate}`. Professional indemnity: `{TEMPLATE — e.g. EUR 1M aggregate}`. Cyber-liability rider: `{TEMPLATE — yes/no, limit}`. Insurance certificates provided on request.
Evidence: `docs/commercial/insurance-certificates.md`
Status: PARTIAL (sales fills per-deal)

---

## Section 8 — Subcontractor Management

### Q8.1 — Subcontractor use + governance

Q: Does the supplier use subcontractors for any part of the product? If yes, describe governance.
A: No subcontractors engaged for code authorship of `sens-api-gateway`. Hardware manufacturing for turnkey bundles (when offered) is HARDWARE-VENDOR RESPONSIBILITY — the vendor list is disclosable per deal under NDA. Third-party OSS dependencies are governed by `deny.toml` allowlist + SPDX licence audit (`cargo deny licenses`) — see `docs/commercial/oss-attribution.md`.
Evidence: `docs/commercial/subcontractors.md`, `docs/commercial/oss-attribution.md`
Status: FULL (code authorship); HARDWARE-VENDOR RESPONSIBILITY (HW manufacturing)

---

## Section 9 — Intellectual Property Policy

### Q9.1 — IP ownership + licensing terms

Q: Describe IP ownership of the product and the licensing terms offered to Siemens.
A: 100% of `sens-api-gateway` source code owned by supplier. Licensing model: proprietary binary licence with source-code escrow option (see `docs/commercial/licensing.md` + `docs/commercial/source-escrow.md`). OSS dependencies preserved under their native licences, aggregated in `docs/commercial/oss-attribution.md` (MIT / Apache-2.0 / BSD-3-Clause — permissive only, no copyleft pulls).
Evidence: `docs/commercial/licensing.md`, `docs/commercial/ip-policy.md`, `docs/commercial/oss-attribution.md`
Status: FULL

---

## Section 10 — Insurance Certificates

### Q10.1 — Certificates on file

Q: Attach product liability + professional indemnity certificates.
A: Attached on request per `docs/commercial/insurance-certificates.md`. Certificate numbers + insurer names + renewal dates listed in that document.
Evidence: `docs/commercial/insurance-certificates.md`
Status: PARTIAL (per-deal attachment)

---

## Summary

- **FULL:** 5 questions — product description + use-cases + target markets + IP policy + subcontractor code-authorship governance.
- **PARTIAL:** 7 questions — any answer where sales + legal fill template values per deal (corporate ID tier, founding + FTE, financials, reference customers, revenue bracket, insurance cover, insurance certificates).
- **ROADMAP:** 1 question — ISO 9001 (target 2027); see `docs/compliance/certifications-roadmap.md`.
- **N-A:** 2 questions — ISO 14001 (HARDWARE-VENDOR RESPONSIBILITY) + ISO 45001 (firmware org, no field workforce).

Every `{TEMPLATE}` marker is a known question; the numbers are set per-deal during negotiation.

---

Response date: 2026-04-24; HEAD=3413db47; version=1.6.0.
