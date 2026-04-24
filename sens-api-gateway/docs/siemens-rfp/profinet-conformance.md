# PROFINET Conformance Declaration — `sens-api-gateway`

**Document owner:** `siemens-rfp-responder` (Lane-C)
**Product:** `sens-api-gateway` v1.6.0
**HEAD:** 3413db47
**Response date:** 2026-04-24

---

## Declaration Summary

| Item | Value |
|------|-------|
| PROFINET Conformance Class | **NONE — product is not a PROFINET IO device** |
| PI (PROFIBUS & PROFINET International) Vendor ID | NOT REGISTERED |
| GSDML file | NOT APPLICABLE |
| IO Device role (CC-A / CC-B / CC-C) | NONE |
| IO Controller role | NONE |
| IO Supervisor role | NONE |
| IRT / RT / RT-Class-1 / RT-Class-2 / RT-Class-3 support | NONE — NOT-PLANNED within current roadmap |

---

## Completeness Dashboard

| Status | Count | % |
|--------|-------|---|
| FULL | 0 | 0% |
| PARTIAL | 0 | 0% |
| ROADMAP | 0 | 0% |
| N-A | 7 | 100% |
| **Total questions** | **7** | **100%** |

---

## Q-by-Q Declaration

### Q1 — Is the product a PROFINET IO device?

Q: Does `sens-api-gateway` implement the PROFINET IO device stack (IEC 61158 / 61784-2)?
A: No. `sens-api-gateway` is a multi-protocol field-bus gateway + scripting engine. The supported industrial protocols (`docs/protocols/`) include Modbus-TCP/RTU, OPC UA, S7comm, EtherNet/IP, ADS, Codesys, LoRaWAN, MQTT, I2C, SPI, PWM, GPIO, Atlas EZO — but **not PROFINET IO**. The product can coexist on a PROFINET network segment (Ethernet Layer-2) and acquire telemetry from PROFINET-connected devices via the S7comm / OPC UA server exposed by the upstream Siemens PLC, but it does not itself participate in the PROFINET IO exchange.
Evidence: `docs/protocols/` (one file per supported protocol; PROFINET absent by design)
Status: N-A (product scope declaration)

### Q2 — PI Vendor ID

Q: Provide the PROFINET International Vendor ID.
A: NOT REGISTERED. Vendor ID acquisition from PI is a prerequisite for shipping a certified PROFINET IO device; since the product is not a PROFINET IO device, no Vendor ID has been acquired.
Evidence: `docs/siemens-rfp/tia-portal-onboarding.md` §Vendor-ID
Status: N-A

### Q3 — GSDML file

Q: Provide the GSDML device description file.
A: NOT APPLICABLE. The product has no PROFINET IO device-description surface to declare.
Evidence: `docs/siemens-rfp/tia-portal-onboarding.md`
Status: N-A

### Q4 — Conformance Class (CC-A / CC-B / CC-C)

Q: Which PROFINET Conformance Class is supported?
A: NONE. CC-A (basic communication) / CC-B (with SNMP + LLDP) / CC-C (with IRT) all require an IO device stack implementation that `sens-api-gateway` does not provide.
Evidence: N/A
Status: N-A

### Q5 — IRT (Isochronous Real-Time) support

Q: Does the product support PROFINET IRT?
A: NONE. IRT requires time-aware Ethernet hardware (IEEE 802.1AS) + PTP synchronization + a protocol stack with deterministic scheduling. `sens-api-gateway` runs on commodity Linux on ARM SBCs without hardware-assisted time-sync; IRT is not in the current roadmap.
Evidence: N/A
Status: N-A (NOT-PLANNED)

### Q6 — Alternative integration path for Siemens PROFINET devices

Q: If the product is not a PROFINET IO device, how does it integrate with Siemens PROFINET-connected PLCs?
A: Two supported paths:
1. **OPC UA Client** — `sens-api-gateway` acts as OPC UA Client connecting to the OPC UA Server exposed by the Siemens S7-1500 / S7-1200 / S7-400 PLC. The PLC internally aggregates its PROFINET I/O into OPC UA variables. See `docs/integration/siemens/opc-ua-client.md`.
2. **S7comm (ISO-on-TCP)** — `sens-api-gateway` acts as an S7comm client (ISO-on-TCP port 102) to read/write DB/M/I/Q areas on Siemens S7 PLCs. Covers S7-300 / S7-400 / S7-1200 / S7-1500. See `docs/integration/siemens/s7-integration.md` + `docs/protocols/s7comm.md`.
Both paths work with existing Siemens PROFINET infrastructure; the PLC-internal PROFINET exchange is handled by the Siemens PLC itself. The gateway reaches PROFINET-connected signals via PLC data-areas without implementing the PROFINET wire protocol.
Evidence: `docs/integration/siemens/opc-ua-client.md`, `docs/integration/siemens/s7-integration.md`, `docs/protocols/s7comm.md`, `docs/protocols/opc-ua.md`
Status: N-A (delegated to PLC)

### Q7 — Roadmap to PROFINET IO device certification

Q: Is PROFINET IO certification on the roadmap?
A: NOT-PLANNED within the current roadmap horizon (24 months). Rationale: (a) the product's position is at the gateway/aggregator layer, not the field-device layer; (b) the existing OPC UA + S7comm paths reach every Siemens PROFINET-connected signal without introducing the certification + hardware requirements a PROFINET IO device would demand; (c) PROFINET IO device certification requires CC-A minimum with PI-recognised lab testing and ongoing conformance test-suite compliance — a cost + engineering commitment that diverges from the protocol-gateway scope. Should a customer mandate a PROFINET IO device role, this is an explicit custom-engineering engagement with a separate scoping + pricing discussion — not part of the standard product roadmap.
Evidence: `docs/product/feature-matrix.md`, `docs/product/positioning.md`
Status: N-A (NOT-PLANNED; explicit custom-engineering path exists)

---

## Key Message for Siemens Procurement

The product is **not a direct PROFINET IO participant** and makes no claim to PROFINET conformance. It is a complementary **aggregation/gateway layer** positioned between Siemens PLCs (which own the PROFINET exchange) and cloud / MES / operator-facing systems. Customers wanting PROFINET-connected signals in the cloud use the OPC UA or S7comm paths — both are first-class and tested.

If the RFP explicitly requires a PROFINET IO device, `sens-api-gateway` is not the right product for that scope. If the RFP requires access-to-PROFINET-signals via a cloud/MES gateway, the existing OPC UA + S7comm paths satisfy it today.

---

Response date: 2026-04-24; HEAD=3413db47; version=1.6.0.
