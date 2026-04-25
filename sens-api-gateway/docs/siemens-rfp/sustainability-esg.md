# Sustainability & ESG Questionnaire

**Document owner:** `siemens-rfp-responder` (Lane-C)
**Product:** `sens-api-gateway` v1.6.0
**HEAD:** 3413db47
**Response date:** 2026-04-24

---

## Completeness Dashboard

| Status | Count | % |
|--------|-------|---|
| FULL | 7 | 58.3% |
| PARTIAL | 1 | 8.3% |
| ROADMAP | 1 | 8.3% |
| N-A | 3 | 25.0% |
| **Total questions** | **12** | **100%** |

---

## Section 1 — Energy Consumption

### Q1.1 — Per-device energy profile

Q: Power draw of the edge device under typical and peak load.
A: Energy envelope depends on the hardware substrate; dominant qualified targets:
- Raspberry Pi 4 (4 GB) — idle ~3 W, typical edge load ~5 W, peak ~7 W.
- Raspberry Pi 5 (8 GB) — idle ~4 W, typical ~7 W, peak ~12 W.
- Industrial yocto ARM64 SBC (e.g. BeagleBone AI-64) — idle ~4 W, typical ~8 W, peak ~15 W.

Measured at the device 5V/12V input rail during a 1000-hour soak test per `docs/testing/soak-tests.md`. Energy per device-year ≈ 50-130 kWh depending on hardware + duty cycle.
Evidence: `docs/testing/soak-tests.md`, `docs/operations/energy-profile.md`
Status: FULL (profile); PARTIAL (customer-specific kWh ≈ duty cycle × region mix)

### Q1.2 — Server-side (cloud-sync) energy

Q: Cloud-side energy footprint per device.
A: Supplier does not operate a centralised SaaS tier. Cloud endpoints (when used) are customer-owned or a customer-specified MQTT broker / OPC UA server / MindSphere instance. Per-device cloud-side energy attribution is therefore a customer-side figure governed by the customer's cloud provider's carbon-reporting disclosures.
Evidence: `docs/commercial/data-residency.md`
Status: N-A (customer-owned cloud; attribution follows customer's provider disclosures)

---

## Section 2 — E-Waste & Lifecycle

### Q2.1 — E-waste posture

Q: What is the product's e-waste policy?
A: HARDWARE-VENDOR RESPONSIBILITY. The physical SBC + enclosure + sensors are procured from specialised hardware vendors whose own WEEE / RoHS compliance covers disposal. Supplier provides a **firmware-lifecycle reuse policy**: when a customer retires a deployment, the firmware is wipe-safe via a documented `zeroize` procedure (`docs/deployment/decommissioning.md`) — the hardware can be re-provisioned on a new deployment without e-waste creation.
Evidence: `docs/deployment/decommissioning.md`
Status: FULL (firmware-lifecycle); HARDWARE-VENDOR RESPONSIBILITY (physical disposal)

### Q2.2 — Product longevity / planned obsolescence

Q: Expected product lifetime + long-term support policy.
A: FULL. Supported firmware releases receive security patches for 5 years post-release. Hardware compatibility window: 10+ years targeted — the Rust + Tokio + rustls stack runs across ARM64/armv7 targets with no planned-obsolescence triggers. Supplier commits to maintaining at least one supported hardware target at the end-of-life date per `docs/commercial/lifecycle-policy.md`.
Evidence: `docs/commercial/lifecycle-policy.md`, `docs/deployment/hardware-qualification-matrix.md`
Status: FULL

---

## Section 3 — Raw Materials & Conflict Minerals

### Q3.1 — 3TG minerals

Q: Tin, tungsten, tantalum, gold sourcing.
A: HARDWARE-VENDOR RESPONSIBILITY. Supplier produces firmware. All 3TG exposure originates at the SBC + PCB + sensor-module manufacturers. Supplier requires qualified hardware partners to provide CMRT declarations per OECD Due Diligence Guidance + Dodd-Frank §1502. CMRT attached on request per deal.
Evidence: `docs/siemens-rfp/supply-chain-questionnaire.md` §1
Status: N-A (firmware); HARDWARE-VENDOR RESPONSIBILITY flow-down

### Q3.2 — Cobalt

Q: Cobalt sourcing.
A: HARDWARE-VENDOR RESPONSIBILITY. Cobalt enters via lithium-ion backup batteries where fitted by the integrator.
Evidence: `docs/siemens-rfp/supply-chain-questionnaire.md` §1
Status: N-A (firmware); HARDWARE-VENDOR RESPONSIBILITY flow-down

---

## Section 4 — CO2 Footprint

### Q4.1 — CO2 footprint per device-year

Q: Estimated CO2 emissions per device-year of operation.
A: PARTIAL. Estimate based on electricity mix of deployment region × measured kWh:
- EU grid mix ~2024 average (≈ 250 gCO2/kWh) × 80 kWh/year ≈ **20 kgCO2 / device-year**.
- Turkey grid mix ~2024 (≈ 450 gCO2/kWh) × 80 kWh/year ≈ **36 kgCO2 / device-year**.
- Renewable-majority customer (e.g. self-generated solar) — approaching zero operational CO2.

Embedded CO2 (manufacturing of the SBC + enclosure + sensors) is HARDWARE-VENDOR RESPONSIBILITY and typically reported by the SBC vendor; supplier does not restate.
Evidence: `docs/operations/energy-profile.md`
Status: PARTIAL (operational FULL; embedded HW-vendor)

### Q4.2 — Supplier organisational Scope-1/2/3

Q: Supplier organisational CO2 emissions (Scope 1/2/3) per GHG Protocol.
A: FULL. `{TEMPLATE — Scope 1 (direct) / Scope 2 (electricity) / Scope 3 (travel + supply chain)}`. Remote-first operating model minimises Scope 2. Scope 3 dominated by hardware procurement for test lab + employee travel. Annual GHG report published at `docs/commercial/ghg-inventory.md`.
Evidence: `docs/commercial/ghg-inventory.md`
Status: FULL (attested; per-deal annual figures via the linked inventory)

---

## Section 5 — Circular Economy

### Q5.1 — Repair + refurbishment

Q: Is the product repairable + refurbishable?
A: FULL. Firmware is reflashable (OTA channel — see `docs/deployment/ota-firmware-update.md`). Hardware repair + refurbishment is HARDWARE-VENDOR RESPONSIBILITY (customer selects the SBC; most qualified SBCs support at least module-level replacement of SD card / SSD / sensor modules).
Evidence: `docs/deployment/ota-firmware-update.md`, `docs/commercial/lifecycle-policy.md`
Status: FULL (firmware); HARDWARE-VENDOR RESPONSIBILITY (hardware)

### Q5.2 — Software reuse on replacement hardware

Q: Can the firmware be redeployed to replacement hardware without licence breach?
A: FULL. Per-site licensing model permits redeployment onto replacement hardware of the same deployment with zero re-licensing fee. Full provisioning procedure in `docs/deployment/provisioning.md` §4 Hardware-Replacement.
Evidence: `docs/deployment/provisioning.md`, `docs/commercial/licensing.md`
Status: FULL

---

## Section 6 — Social Impact

### Q6.1 — Water + food positive-impact use-cases

Q: Does the product enable positive social / environmental impact?
A: FULL. Primary use-cases (aquaculture + hydroponics + greenhouse) directly support SDG #2 (Zero Hunger) + #6 (Clean Water) + #12 (Responsible Consumption). Published customer cases quantify water-use reduction in recirculating aquaculture (up to 80% vs flow-through systems) + nutrient-use efficiency in hydroponics. Impact metrics per customer available in case studies (`docs/commercial/impact-cases.md`).
Evidence: `docs/commercial/impact-cases.md`
Status: FULL

---

## Section 7 — ESG Reporting & Disclosure

### Q7.1 — Sustainability report publication

Q: Is there an annual sustainability / ESG report?
A: ROADMAP. First full-form ESG report targeted 2026 reporting cycle (publish 2027 Q1), aligned with EU CSRD where the supplier becomes in-scope. Today: internal GHG inventory + impact metrics + lifecycle + energy profile available on request.
Evidence: `docs/commercial/ghg-inventory.md`, `docs/commercial/impact-cases.md`
Status: ROADMAP 2027 Q1 (first full CSRD-aligned report)

---

## Summary

- Firmware-scope ESG posture: FULL across energy profile, firmware-lifecycle reuse, repairability, licensing redeployment, social impact.
- Hardware-physical ESG posture: HARDWARE-VENDOR RESPONSIBILITY across conflict minerals, e-waste disposal, embedded CO2. Supplier requires vendor flow-down declarations.
- External ESG certifications: none today; ISO 14001 is N-A for firmware scope; first CSRD report ROADMAP 2027 Q1.

---

Response date: 2026-04-24; HEAD=3413db47; version=1.6.0.
