# TIA Portal Vendor-Device Onboarding Checklist

**Document owner:** `siemens-rfp-responder` (Lane-C)
**Product:** `sens-api-gateway` v1.6.0
**HEAD:** 3413db47
**Response date:** 2026-04-24

---

## Headline Status

The product is a gateway layer, not a PROFINET IO device (see `profinet-conformance.md`). TIA Portal is used by customers to **configure the Siemens PLC** that `sens-api-gateway` talks to via OPC UA / S7comm. The product is **not** itself a TIA Portal-visible device-catalog entry today.

A migration path exists to register as a TIA Portal device-catalog entry — it is ROADMAP material, not present-state.

---

## Completeness Dashboard

| Status | Count | % |
|--------|-------|---|
| FULL | 2 | 22.2% |
| PARTIAL | 1 | 11.1% |
| ROADMAP | 3 | 33.3% |
| N-A | 3 | 33.3% |
| **Total questions** | **9** | **100%** |

---

## Q-by-Q Checklist

### Q1 — PI Vendor ID

Q: Does the supplier hold a registered PROFIBUS/PROFINET International (PI) Vendor ID?
A: NOT REGISTERED. Vendor ID acquisition is gated on a decision to enter the PROFINET IO device market (see `profinet-conformance.md`). Today, the product addresses Siemens PLC integration via OPC UA Client + S7comm and does not need a PI Vendor ID for those paths.
Evidence: `docs/siemens-rfp/profinet-conformance.md`
Status: N-A (not required for OPC UA + S7comm paths)

### Q2 — Device symbol file format

Q: Which device-description file format does the product support (GSDML / GSD / EDS / IODD)?
A: NONE today. Rationale: the product is a gateway that connects **to** Siemens PLCs as an OPC UA Client + S7comm client; the PLC is the TIA-Portal-known entity. The gateway's own device description is expressed as an **OPC UA NodeSet2 XML** file published in `docs/protocols/opc-ua.md` when operating in OPC UA Server mode. ROADMAP: add GSDML export when/if PROFINET IO device role is pursued (not currently planned — see Q1).
Evidence: `docs/protocols/opc-ua.md` NodeSet2 section
Status: ROADMAP (GSDML; OPC UA NodeSet2 FULL today)

### Q3 — TIA Portal version qualification

Q: Against which TIA Portal version has the integration been tested?
A: PARTIAL. OPC UA Client against TIA Portal V17 + V18 S7-1500 PLC with OPC UA Server enabled (tested manually during customer-site integrations). S7comm tested against S7-300 / S7-400 / S7-1200 / S7-1500 via `snap7` compatible libraries. The gateway's OPC UA stack is hand-rolled Rust (`opcua` crate family) and has **not** been submitted for TIA Portal formal-verification testing.
Evidence: `docs/testing/tia-portal-integration-tests.md` (test-evidence-writer output), `docs/integration/siemens/opc-ua-client.md`
Status: PARTIAL (ad-hoc tested; not formally TIA-verified)

### Q4 — Migration path to TIA-verified OPC UA stack

Q: How will the OPC UA stack reach TIA Portal formal verification?
A: ROADMAP. Two candidate paths:
1. **Upstream to a production-grade OPC UA Rust crate** — `open62541`-bindings (FFI to the C reference implementation that is TIA-compatible). This path inherits formal-verification test results from the upstream crate.
2. **Run the OPC UA Foundation compliance test suite** against the hand-rolled stack — ~6-8 engineer-weeks of testing + remediation.

Preferred path: option 1 (FFI to `open62541`) for lower risk and faster certification horizon. Target Q3-Q4 2026.

Cross-reference: `ORPHAN-EDGE-005` (OPC UA crate migration) tracks this in the edge-plan backlog.
Evidence: `docs/integration/siemens/opc-ua-client.md`, `docs/reviews/orphan-findings.md` (OPC UA stack migration entry when authored)
Status: ROADMAP Q3-Q4 2026

### Q5 — S7comm compatibility matrix

Q: S7 PLC families supported + tested.
A: FULL. S7-300 (CP343-1), S7-400, S7-1200 (firmware 4.x+), S7-1500 (firmware 2.x+). PUT/GET enabled on the PLC required for write operations (PLC-side configuration responsibility documented). Full API coverage: DB read/write, M area, I/Q areas, T/C areas.
Evidence: `docs/protocols/s7comm.md`, `docs/integration/siemens/s7-integration.md`
Status: FULL

### Q6 — TIA Portal import path for generated tags

Q: Can the device's tag set be imported into TIA Portal?
A: ROADMAP. Today the gateway **receives** tag definitions from the PLC (via OPC UA browse or manual S7 mapping). Exporting an XML tag-list for TIA Portal import (via TIA Portal Openness API) is ROADMAP Q3 2026. Workaround today: operator manually cross-references the `config.yaml` tag-map with the TIA Portal tag definitions; a CSV export is available.
Evidence: `docs/integration/siemens/tia-portal.md` (integration-writer output)
Status: ROADMAP Q3 2026 (TIA Portal Openness path)

### Q7 — WinCC integration

Q: Does the product integrate with Siemens WinCC (SCADA HMI)?
A: FULL via OPC UA Server role — WinCC connects as OPC UA Client to the gateway-exposed NodeSet. Also supported via direct S7comm-compatible tag mapping. See `docs/integration/siemens/wincc-tag-bridge.md`.
Evidence: `docs/integration/siemens/wincc-tag-bridge.md`, `docs/protocols/opc-ua.md`
Status: FULL

### Q8 — IODD (IO-Link) + EDS (EtherNet/IP)

Q: IODD / EDS file support for non-PROFINET device classes?
A: N-A. The product is not an IO-Link master + is not an EtherNet/IP adapter today. EtherNet/IP explicit-messaging Client is supported via `docs/protocols/ethernet-ip.md`; no EDS file shipped because the product operates as Client, not as Adapter.
Evidence: `docs/protocols/ethernet-ip.md`
Status: N-A

### Q9 — Siemens ecosystem compatibility matrix

Q: List every Siemens-ecosystem product that has been validated in integration tests.
A: See `docs/integration/siemens/compatibility-matrix.md` for the full per-version table. Summary: S7-1200/1500 via OPC UA + S7comm (tested), S7-300/400 via S7comm (tested), WinCC Unified via OPC UA (tested), WinCC Classic via S7comm (tested), MindSphere / Insights Hub — see `mindsphere-readiness.md` (ROADMAP).
Evidence: `docs/integration/siemens/compatibility-matrix.md`
Status: N-A (matrix is the answer; per-row status tracked in that file)

---

## Key Message for Siemens Procurement

- **Today:** the product integrates with Siemens PLCs via OPC UA Client + S7comm client. Both paths are tested in production at customer sites. WinCC via OPC UA Server is FULL.
- **Not today:** TIA Portal device-catalog entry (no GSDML + no PI Vendor ID). Customers do not install the gateway from TIA Portal — they deploy it as a Linux service on an SBC alongside their PLC network.
- **ROADMAP:** (a) OPC UA stack migration to TIA-verified variant (Q3-Q4 2026); (b) TIA Portal Openness tag export (Q3 2026); (c) GSDML + PI Vendor ID gated on PROFINET IO device scope decision — not active roadmap today.

---

Response date: 2026-04-24; HEAD=3413db47; version=1.6.0.
