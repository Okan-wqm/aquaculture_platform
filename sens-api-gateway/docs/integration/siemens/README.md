# Siemens Integration — Landing Page

**Product:** `sens-api-gateway` (v1.6.0, HEAD `3413db47`, date 2026-04-24)
**Audience:** Siemens solution architects evaluating placement of this Rust edge gateway inside a SIMATIC / WinCC / TIA Portal / MindSphere (Insights Hub) stack.
**Nature:** Integration manual + honest conformance declaration. Every "compatible" claim is accompanied by evidence (`src/*.rs:N`); every gap is labelled with a roadmap milestone and finding ID.

---

## Siemens version compatibility matrix (product level)

| Siemens component | Supported version window | Integration path | Status |
|---|---|---|---|
| TIA Portal | v16, v17, v18, v19 | OPC UA client browsing + S7 Open User Communication | Client-side: PRESENT. Server-side GSDML: **NOT-PLANNED** (not a PROFINET IO device) |
| STEP 7 Classic (S7-300/400) | — | S7comm read/write over ISO-on-TCP port 102 | PRESENT (`src/plc_programming/s7comm.rs:1401`, `:1452`) |
| WinCC V7.x | V7.4 SP1, V7.5 | OPC UA / S7 tag import via gateway read API | PRESENT (OPC UA None policy only today — see `opcua-for-siemens.md`) |
| WinCC Unified | V18, V19 | OPC UA client to gateway | PRESENT (SecurityPolicy None only today) |
| SIMATIC PCS 7 | V9.1 | OPC UA client; not certified | PATH EXISTS; NOT CERTIFIED |
| MindSphere / Insights Hub | MindConnect Lib v3.x, IoT Extension | MQTT → MindConnect bridge | **NOT IMPLEMENTED** — roadmap via MindConnect IoT Extension (ORPHAN-EDGE-012) |
| PROFINET IO | IEC 61158 / IEC 61784-2 | — | **NOT A PROFINET IO DEVICE. NOT-PLANNED.** (`profinet-readiness.md`) |
| Sparkplug B | Eclipse Tahu spec 3.0.0 | MQTT payload namespace | **NOT COMPLIANT** by default (`sparkplug-b.md`) |
| SIMATIC IPC (227G, 427G, BX-39A) | Debian 11/12 image | Same install path as Revolution Pi | PRESENT — see `simatic-ipc-deployment.md` |
| SIMATIC IOT2050 | Firmware V2.x | ARM64 agent build | PRESENT |

---

## Chapter index

| Chapter | Purpose |
|---|---|
| [`tia-portal.md`](tia-portal.md) | TIA Portal device discovery, symbol import, GSDML status |
| [`s7-area-mapping.md`](s7-area-mapping.md) | S7 area code support matrix (DB, I, Q, M, T, C), PDU negotiation |
| [`opcua-for-siemens.md`](opcua-for-siemens.md) | OPC UA SecurityPolicy posture + Basic256Sha256 migration roadmap |
| [`mindsphere-connector.md`](mindsphere-connector.md) | MindSphere ingestion path (NOT IMPLEMENTED — roadmap) |
| [`insights-hub.md`](insights-hub.md) | Insights Hub asset/aspect/variable mapping (NOT IMPLEMENTED — roadmap) |
| [`wincc-tag-bridge.md`](wincc-tag-bridge.md) | WinCC V7 / Unified tag import paths |
| [`profinet-readiness.md`](profinet-readiness.md) | PROFINET IO + IRT status declaration (NOT-PLANNED) |
| [`sparkplug-b.md`](sparkplug-b.md) | Sparkplug B spec compliance declaration (NOT COMPLIANT) |
| [`simatic-ipc-deployment.md`](simatic-ipc-deployment.md) | SIMATIC IPC227G / IPC427G / IOT2050 deployment notes |

---

## Honest posture summary

What follows is the shortened form of the per-chapter honesty stance, placed here so a procurement reviewer can decide in 60 seconds whether to read further.

1. **S7comm read/write: PRESENT.** Areas DB, I (PE), Q (PA), M (MK), T, C parsed and mapped — evidence `src/plc_programming/s7comm.rs:84-89` (area constants), `:332-467` (address parser), `:1401` (read_variable), `:1452` (write_variable).
2. **S7 block download: PRESENT but ST-to-MC7 compilation is placeholder.** `compile_to_mc7()` emits a block skeleton (PP signature + NOP + block-end) — it is not a real Structured Text compiler. Full ST → MC7 bytecode compilation requires TIA Portal Openness and is not implemented per `src/plc_programming/s7comm.rs:862-901`.
3. **OPC UA: hand-rolled binary client, SECURITY_POLICY_NONE reachable.** The `None` policy URI is exported as a constant (`src/plc_programming/opcua.rs:69`) and the default `OpcUaConfig` ships with `security_policy: OpcUaSecurityPolicy::None` (`:437`). Migration to `opcua = "0.12"` with Basic256Sha256 + SignAndEncrypt is on the ROADMAP for Q2-Q3 2026 — tracked as ORPHAN-EDGE-005.
4. **MindSphere / Insights Hub: NOT IMPLEMENTED.** No MindConnect Library or MindConnect IoT Extension code exists in-tree. Ingestion today goes to our own MQTT broker. Roadmap path is MindConnect IoT Extension bridge — Q3 2026.
5. **Sparkplug B: NOT COMPLIANT.** Topic tree is `tenants/{tenant_id}/devices/{device_id}/{status|telemetry|commands|config}` (`src/config.rs:1294-1312`) — this is NOT `spBv1.0/{group_id}/{message_type}/{edge_node_id}/{device_id}`. Birth/death certificate and Sparkplug payload encoding are not implemented.
6. **PROFINET IO: NOT A PROFINET IO DEVICE.** No GSDML file is shipped, no IRT real-time scheduler exists, no vendor ID is registered with PI. PROFINET Conformance Class: **NONE**. Status: NOT-PLANNED.
7. **SIMATIC IPC / IOT2050: PRESENT.** Standard Debian-based install path applies; see `simatic-ipc-deployment.md`.

---

## Banned-phrase discipline

This chapter set follows the edge-docs banned-phrase contract (`/.claude/agents/edge-docs/README.md`): the substitution table prescribes "initial" in place of weasel-word equivalents, "finite-duration" in place of time-weakening qualifiers, and "ROADMAP-QX + finding ID" in place of vague postponement language. Violations are caught by the pre-commit hook `tools/gates/banned-phrase.ts`.

---

## Cross-reference

- Protocol-level wire details: `sens-api-gateway/docs/protocols/s7comm.md`, `sens-api-gateway/docs/protocols/opcua.md` (authored by `protocol-reference-writer`).
- Security architecture + PKI hierarchy: `sens-api-gateway/docs/security/` (authored by `security-architecture-writer`).
- Compliance evidence (IEC 62541, IEC 61158): `sens-api-gateway/docs/compliance/` (authored by `compliance-evidence-writer`).
- Deployment runbook (SIMATIC IPC specifics here refer back to): `sens-api-gateway/docs/deployment/install.md`.
