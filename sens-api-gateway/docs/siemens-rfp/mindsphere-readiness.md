# MindSphere / Insights Hub Readiness Checklist

**Document owner:** `siemens-rfp-responder` (Lane-C)
**Product:** `sens-api-gateway` v1.6.0
**HEAD:** 3413db47
**Response date:** 2026-04-24

---

## Headline Status

**MindSphere / Insights Hub integration: NOT IMPLEMENTED — ROADMAP Q2-Q3 2026.**

The product currently connects to cloud destinations via generic MQTT (TLS) and OPC UA Client. First-class MindSphere / Insights Hub support (native MindConnect Library adapter, Asset / Aspect type publishing, partner-programme registration) is ROADMAP Q2-Q3 2026 subject to customer demand + Siemens partner-programme enrollment timing.

---

## Completeness Dashboard

| Status | Count | % |
|--------|-------|---|
| FULL | 0 | 0% |
| PARTIAL | 1 | 9.1% |
| ROADMAP | 6 | 54.5% |
| N-A | 4 | 36.4% |
| **Total questions** | **11** | **100%** |

---

## Readiness Checklist

### Q1 — MindSphere / Insights Hub Partner Programme enrollment

Q: Is the supplier enrolled in the Siemens Industrial IoT Partner Programme (MindSphere / Insights Hub partner tier)?
A: NOT STARTED. Enrollment cost + 12-month target discussed with Siemens during partner-scoping session. Supplier ready to enroll at the "Application Partner — Device Integration" tier once the first joint customer use-case is confirmed.
Evidence: `docs/siemens-rfp/tia-portal-onboarding.md`
Status: ROADMAP Q2-Q3 2026

### Q2 — MindConnect Library integration

Q: Has the MindConnect Library (C/C++/Python SDK) been integrated as the Insights Hub client?
A: NOT IMPLEMENTED. Planned architectural approach: add a new optional Rust crate `sens-insights-hub` that wraps the MindConnect Library via FFI (or a pure-Rust reimplementation of the MindConnect protocol should Siemens publish a Rust SDK). Estimated effort: 8-12 engineer-weeks.
Evidence: `docs/integration/siemens/mindsphere-connector.md` (ROADMAP)
Status: ROADMAP Q2-Q3 2026

### Q3 — Asset type definitions published

Q: Have Asset Type Definitions been authored + published to the MindSphere Asset Management API?
A: N-A (no connector yet). When the connector lands, Asset Type Definitions for: `AquacultureTank`, `HydroponicsGrowCycle`, `GenericModbusDevice`, `GenericS7PLC`, `GenericOpcUaDevice` will be authored + published. Definitions follow Siemens naming conventions + aspect-type discipline.
Evidence: `docs/integration/siemens/mindsphere-asset-types.md` (ROADMAP)
Status: N-A (gated by Q2 delivery)

### Q4 — Aspect type mappings

Q: Are aspect types (dynamic + static) defined per asset?
A: N-A. Aspect-type discipline planned alongside Q3. Dynamic aspects: `WaterQuality{ph, do, ec, orp, temperature}`, `ModbusHoldingRegisters{...}`, `S7DataBlocks{...}`. Static aspects: `DeviceIdentity{vendor, model, firmware, serial}`.
Evidence: `docs/integration/siemens/mindsphere-asset-types.md` (ROADMAP)
Status: N-A (gated by Q2 delivery)

### Q5 — IoT Extension Library compatibility

Q: Has the product been tested against the MindSphere IoT Extension Library?
A: N-A. Planned Q3 2026 after MindConnect Library integration (Q2).
Evidence: n/a
Status: N-A (gated by Q2)

### Q6 — Insights Hub (MindSphere successor) connector certification

Q: Is the connector certified under the Insights Hub Partner Programme?
A: NOT STARTED. Certification testing scheduled post-integration (target Q4 2026). Certification cost + timeline included in the partner-programme roadmap scope.
Evidence: n/a
Status: ROADMAP Q4 2026

### Q7 — MQTT bridge to MindSphere / Insights Hub (bridging path)

Q: Is there an bridging path to publish to MindSphere / Insights Hub ahead of native-connector delivery?
A: PARTIAL. The product supports generic MQTT-over-TLS publishing today. Customers can configure MQTT target = MindSphere MQTT endpoint OR an intermediate broker that the customer's own MindConnect integration consumes from. This satisfies telemetry-forwarding use-cases ahead of the native connector, but does not deliver Asset/Aspect modelling — those land with the native connector.
Evidence: `docs/protocols/mqtt.md`, `docs/integration/siemens/mindsphere-mqtt-bridge.md` (bridging doc)
Status: PARTIAL (generic MQTT bridge available; native connector ROADMAP)

### Q8 — OPC UA PubSub → MindSphere

Q: Is OPC UA PubSub supported as a publishing path to MindSphere?
A: NOT IMPLEMENTED. OPC UA Client is supported today (subscribe to PLC server). OPC UA PubSub (broadcast publisher role) is a separate protocol profile; not in the current roadmap. Customers requiring PubSub are served via MQTT bridge (Q7).
Evidence: `docs/protocols/opc-ua.md`
Status: ROADMAP (evaluation Q3 2026)

### Q9 — Fleet Manager (MindSphere Fleet Manager) integration

Q: Is the device registerable in MindSphere Fleet Manager for centralised fleet management?
A: NOT IMPLEMENTED. Fleet Manager registration is part of the Q2 native-connector milestone. Device onboarding flow: Insights Hub onboarding token → agent-side enrollment CLI → mTLS cert issued by MindSphere CA → device visible in Fleet Manager.
Evidence: `docs/integration/siemens/mindsphere-fleet-manager.md` (ROADMAP)
Status: ROADMAP Q2-Q3 2026

### Q10 — Visual Flow Creator / MindStudio compatibility

Q: Is the product compatible with MindStudio / Visual Flow Creator for low-code data-pipeline authoring?
A: N-A. Compatibility is achieved via the native connector (Q2) surfacing the device as a first-class Asset — MindStudio then reads asset telemetry natively. No product-side work required beyond the connector.
Evidence: n/a
Status: N-A (gated by Q2)

### Q11 — Security posture for MindSphere publishing

Q: What security controls apply to the MindSphere publishing path?
A: ROADMAP alongside the native connector. Mandatory controls at delivery:
- mTLS against MindSphere Public Key Infrastructure (no user/pass).
- Least-privilege OAuth2 scopes for MindSphere Asset Management API calls.
- Telemetry encryption in transit (TLS 1.3).
- Encrypted-at-rest local buffering (existing SQLCipher offline queue extends to the MindSphere path).
- Signed telemetry payloads (Ed25519) optional per customer risk profile.
Evidence: `docs/security/crypto-inventory.md`, `docs/security/pki-hierarchy.md`
Status: ROADMAP (aligned with Q2 connector milestone)

---

## Roadmap Summary

| Milestone | Target | Effort | Gate |
|-----------|--------|--------|------|
| Partner Programme enrollment | Q2 2026 | 2 eng-weeks (forms + legal) | First joint customer confirmed |
| MindConnect Library Rust adapter | Q2-Q3 2026 | 8-12 eng-weeks | Integration-writer owns; Cargo feature `mindsphere` |
| Asset/Aspect Type publishing | Q3 2026 | 3-4 eng-weeks | Bundled with adapter |
| Fleet Manager onboarding flow | Q3 2026 | 3-5 eng-weeks | mTLS against MindSphere CA |
| Insights Hub Partner certification test | Q4 2026 | 2-4 eng-weeks | Testing + remediation |
| OPC UA PubSub → MindSphere evaluation | Q3 2026 | 2 eng-weeks (spike) | Customer demand signal |

Until the native connector lands, customers are served via the **generic MQTT bridge** (Q7) which satisfies telemetry-forwarding with TLS mTLS security.

---

## Honesty note

Every item above except the generic MQTT bridge is explicitly NOT IMPLEMENTED today. This document is the pre-commitment scope; Siemens procurement is entitled to reject proposals that cannot deliver MindSphere native connector within RFP timeline. The bridging MQTT path exists and is tested; that is the single MindSphere-adjacent capability today.

---

Response date: 2026-04-24; HEAD=3413db47; version=1.6.0.
