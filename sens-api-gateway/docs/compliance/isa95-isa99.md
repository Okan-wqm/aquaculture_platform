# ISA-95 / ISA-99 — Enterprise & Control Integration + Zone-Conduit

**Standards:**

- **ISA-95** (ANSI/ISA-95.00.01 through .05 — *Enterprise-Control System Integration*) — hierarchical functional model of the manufacturing / industrial enterprise.
- **ISA-99** (now IEC 62443 series) — zone-and-conduit methodology for industrial control system cybersecurity.

**Scope:** Position `suderra-agent` v1.6.0 inside the ISA-95 functional hierarchy and describe the ISA-99 zones + conduits it terminates.

## ISA-95 functional hierarchy placement

| Level | ISA-95 name | Typical system | `suderra-agent` role |
|-------|-------------|----------------|----------------------|
| 4 | Business planning & logistics | ERP (SAP, Dynamics) | Not covered by this doc — handled by customer ERP integration at the SaaS backend tier (`apps/gateway-api/` → `apps/billing-service/`). |
| 3 | Manufacturing operations management | MES / MOM | Not covered by this doc — handled in the SaaS backend (`apps/farm-service/`, `apps/hr-service/`, `apps/admin-api-service/`). |
| 2 | Area supervisory control | SCADA / HMI | **PRIMARY** — `suderra-agent` runs at Level 2. Operator-visible alarm surface (`src/alarms.rs`), SCADA server (`src/scada_server.rs`), deploy orchestrator (`src/deploy_orchestrator.rs`), process image (`src/process_image.rs`), actuator write gate with RBAC + class-binding (`src/commands.rs`, `src/command_envelope/`). |
| 1 | Basic control | PLC / RTU / PAC | **EDGE-ADJACENT** — the agent terminates OT-side protocols to Level-1 devices: Modbus-TCP/RTU (`src/modbus.rs`), OPC UA + S7comm + EtherNet/IP + ADS + Codesys via `sensorprotocols/plc_programming/`, I2C (`src/i2c.rs`), SPI (`src/spi.rs`), PWM (`src/pwm.rs`), GPIO (`src/gpio.rs`), LoRaWAN (`src/lora/`), Atlas EZO analog (`src/atlas_ezo.rs`). |
| 0 | Physical process | Sensors, actuators, I/O modules | Not covered by this doc — customer equipment. The agent's interface is the Level-1 PLC / bus; Level-0 correctness is the hardware vendor's responsibility. |

**SSoT declaration:** The edge gateway is a **Level-2 component** by ISA-95 design intent — operator supervisory control, multi-device orchestration, alarm management. It **terminates** protocols into Level 1 and **exports** data northbound into Level 3 (the SaaS backend via MQTT / NATS). It is not itself a PLC (no hard-real-time IEC 61131-3 runtime today — see [iec61131-3.md](./iec61131-3.md) ST runtime VM ROADMAP Faz 3).

## Level-2 functional coverage (ISA-95 Part 3 functional model)

| Level-2 function | Coverage | Evidence |
|------------------|----------|----------|
| Acquire process data | PASS | `src/io_poll.rs` (bounded scheduler), `src/process_image.rs:1-286` (typed tag system) |
| Supervise equipment operation | PASS | `src/alarms.rs`, `src/alarm_engine.rs`, `src/runtime_safety/` |
| Execute operational sequences | PARTIAL | `src/scripting/triggers.rs` + `src/scripting/parallel.rs` + `src/scripting/conflict.rs` (trigger-based sequence engine); ST bytecode runtime ROADMAP Faz 3 |
| Collect & report operational data | PASS | `src/telemetry.rs`, `src/trend_engine.rs` — both wired into the NATS outbound path via MQTT bridge |
| Maintain operator interface | PASS | `src/scada_server.rs` (OT-LAN HTTP listener), SCADA display feature (`--features scada-display`) |
| Record process history | PASS | `src/scada_db.rs` (SQLCipher-backed), `src/offline_queue.rs` (durable WAL buffer for cloud outage) |
| Control equipment changeover | PASS | `src/deploy_orchestrator.rs` (unified Rust / Codesys / setpoint deploy per v2.2), `src/config_integrity/` (signed config manifest per ADR-026) |
| Control equipment to prevent hazards | PASS | `src/safe_state.rs:1-414` + `src/safe_state_v2.rs` (fail-safe state machine; ADR-023 SL3 upgrade path) |

## ISA-99 / IEC 62443 zone-conduit model

`suderra-agent` sits at the boundary between two security zones and terminates one conduit:

```
+--------------------------------------------------------------+
|  ZONE: Business / IT (Levels 3-4)                            |
|  SaaS backend — apps/gateway-api, apps/*-service             |
|  Trust boundary: JWT + mTLS + cert-CN identity (ADR-015)     |
+---------------------+----------------------------------------+
                      |
                      | CONDUIT C-IT-OT: MQTT/NATS over mTLS 1.3
                      |   - Outbound-only from edge
                      |   - Cert-CN = device identity
                      |   - HMAC-chained audit replay (ADR-020)
                      |   - Signed command envelope (ADR-024)
                      |
+---------------------v----------------------------------------+
|  ZONE: OT supervisory (Level 2)                              |
|  suderra-agent — this component                              |
|  Trust boundary: RBAC + ABAC (ADR-018), sealed identifier    |
|    newtypes, systemd sandbox, SQLCipher at-rest, mTLS only   |
+---------------------+----------------------------------------+
                      |
                      | CONDUIT C-OT-FIELD: Modbus/OPC UA/S7comm/
                      |   EtherNet/IP/ADS/Codesys/I2C/SPI/PWM/GPIO/
                      |   LoRaWAN/Atlas EZO
                      |
+---------------------v----------------------------------------+
|  ZONE: Field (Level 1 PLCs + Level 0 sensors/actuators)      |
|  Customer equipment                                          |
|  Trust boundary: customer-owned — not covered by this doc    |
+--------------------------------------------------------------+
```

The full zone-conduit diagram (including DMZ topology for air-gapped deployments + the SCADA broker interconnect) is maintained by `architecture-writer` in `docs/architecture/deployment-topology.md`. This chapter cross-links; it does not duplicate.

## Conduit security controls

| Conduit | Transport | Authentication | Integrity | Confidentiality | Availability |
|---------|-----------|----------------|-----------|-----------------|--------------|
| C-IT-OT (edge ↔ SaaS) | MQTT 5 over TLS 1.3 (primary), NATS over TLS 1.3 (control plane) | mTLS client cert; cert-CN = identity per ADR-015; no CONNECT-frame user/pass | TLS 1.3 AEAD + signed command envelope (ADR-024) for actuator writes | TLS 1.3 AEAD (ChaCha20-Poly1305 / AES-256-GCM per `docs/security/crypto-inventory.md`) | Dual-broker failover (`src/mqtt_failover.rs`), offline queue (`src/offline_queue.rs`) |
| C-OT-FIELD (edge ↔ PLC / field) | Per-protocol — Modbus/TCP, OPC UA, S7comm, EtherNet/IP, ADS, Codesys, LoRaWAN | Protocol-native: OPC UA x509 certificates + UserIdentityToken; Modbus/TCP mTLS per `src/modbus.rs` (rodbus 1.4 `TlsMode`); LoRaWAN AppSKey + NwkSKey | Protocol-native checksums + at the process-image boundary `BoundedRange` enforcement (`src/bounded.rs`) | Protocol-native: Modbus/TCP TLS 1.2+, OPC UA secure channel, LoRaWAN AES-128 | Circuit breakers + retry budgets in `src/resilience/` |

## ISA-99 conformance posture

- Zone segmentation enforced at the process level via `systemd` sandbox (`CapabilityBoundingSet`, `SystemCallFilter`, `DevicePolicy=closed`, `ProtectSystem=strict`) — ORPHAN-EDGE-010 RESOLVED-IN-BATCH-4A.
- Conduit controls align with IEC 62443-4-2 FR1 (authentication), FR3 (integrity), FR4 (confidentiality), FR5 (restricted data flow), FR7 (availability) — see the paired gap table in [iec62443-4-2-gap.md](./iec62443-4-2-gap.md).
- The conduit between customer equipment (Level 0) and Level 1 is explicitly **not** covered by this doc — that's the hardware vendor's responsibility (signal conditioning, intrinsic safety ratings, etc.).

## Cross-references

- [iec62443-4-2-gap.md](./iec62443-4-2-gap.md) — component-level FR gap table.
- `docs/architecture/deployment-topology.md` (owned by `architecture-writer`) — authoritative zone-conduit diagram.
- `docs/security/pki-hierarchy.md` (owned by `security-architecture-writer`) — conduit authentication PKI.

Compliance snapshot: 2026-04-24, v1.6.0, HEAD=3413db47
