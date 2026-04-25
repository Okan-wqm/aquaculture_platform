# TIA Portal Integration

**Scope:** How `sens-api-gateway` appears to, is discovered by, and exchanges data with TIA Portal projects. Integration paths the Siemens engineer can actually configure today vs. declared roadmap items.

---

## Siemens version compatibility matrix

| TIA Portal | STEP 7 (TIA) | WinCC (TIA) | Openness API | Integration path status |
|---|---|---|---|---|
| v16 | Professional V16 | Advanced V16 | V16 | OPC UA client + S7 OUC: PRESENT. GSDML import: NOT-PLANNED. |
| v17 | Professional V17 | Advanced V17 / Unified V17 | V17 | OPC UA client + S7 OUC: PRESENT. GSDML import: NOT-PLANNED. |
| v18 | Professional V18 | Advanced V18 / Unified V18 | V18 | OPC UA client + S7 OUC: PRESENT. GSDML import: NOT-PLANNED. |
| v19 | Professional V19 | Advanced V19 / Unified V19 | V19 | OPC UA client + S7 OUC: PRESENT. GSDML import: NOT-PLANNED. |

"PRESENT" means the wire-level integration is in shipped code; it does NOT imply Siemens certification. Certification is a separate workstream tracked by `siemens-rfp-responder`.

---

## Integration paths

The gateway can be wired into a TIA Portal project via three paths. Choose exactly one per project; mixing is supported only for migration scenarios.

### Path A — Gateway is an OPC UA server browsed by TIA Portal

Recommended for new projects.

```
┌─────────────────┐  OPC UA Binary (port 4840)    ┌──────────────────┐
│ TIA Portal v16+ │  ───────────────────────────> │ sens-api-gateway │
│ (Engineer)      │       Browse / Read / Write   │ (OPC UA server)  │
└─────────────────┘                               └──────────────────┘
```

Today-state: the gateway exports `OpcUaSecurityPolicy::None` as the default (`src/plc_programming/opcua.rs:437`). TIA Portal accepts a "None" endpoint only if the project's security policy is relaxed explicitly. For a Siemens production project the gateway MUST be migrated to Basic256Sha256 + SignAndEncrypt first — see `opcua-for-siemens.md` and ORPHAN-EDGE-005.

Configuration (sketch):

```yaml
opcua_server:
  endpoint_url: "opc.tcp://gateway.plant.local:4840"
  security_policy: basic256_sha256   # ROADMAP Q2-Q3 2026
  security_mode: sign_and_encrypt    # ROADMAP Q2-Q3 2026
  client_cert_path: /etc/suderra/opcua/client.crt
```

### Path B — Gateway is an S7 partner via Open User Communication

Used when the plant already has S7-300 / S7-400 / S7-1200 / S7-1500 PLCs that own the process image and the gateway is a read-only observer.

```
┌────────────────┐  ISO-on-TCP (port 102)   ┌──────────────────┐
│ S7-1500 PLC    │  <─────────────────────> │ sens-api-gateway │
│ (TIA Portal)   │  S7comm Read Var / Write │ (S7 client)      │
└────────────────┘                          └──────────────────┘
```

Evidence: `src/plc_programming/s7comm.rs:41` (port 102), `:542-565` (Setup Comm), `:1401` (read_variable), `:1452` (write_variable).

TIA Portal prerequisites:

| PLC series | Required TIA setting | Evidence |
|---|---|---|
| S7-300 / 400 | No extra step; connection resource available on rack 0 slot 2 | `src/plc_programming/s7comm.rs:208` (default slot = 1, S7-300/400) |
| S7-1200 | Device properties → Protection & Security → **"Permit access with PUT/GET"** enabled | module doc comment `s7comm.rs:17` |
| S7-1500 | Same as S7-1200 PLUS "Full access (no protection)" OR password-protected HMI access | module doc comment `s7comm.rs:17-18` |

See `s7-area-mapping.md` for the full area / addressing reference.

### Path C — Gateway publishes MQTT, TIA Portal does NOT see it directly

For projects that do not expose OPC UA or S7 to the gateway network segment, MQTT is the outbound path. TIA Portal does not subscribe; the MQTT flow is consumed by the cloud (or by MindConnect IoT Extension — see `mindsphere-connector.md`, `insights-hub.md`).

Topic tree today (not Sparkplug B — see `sparkplug-b.md`):

```
tenants/{tenant_id}/devices/{device_id}/status
tenants/{tenant_id}/devices/{device_id}/telemetry
tenants/{tenant_id}/devices/{device_id}/commands
tenants/{tenant_id}/devices/{device_id}/config
```

Evidence: `src/config.rs:1294-1312`.

---

## GSDML export — **NOT PROVIDED**

TIA Portal's "Install GSDML" option is the mechanism a third-party vendor ships so their device appears in the hardware catalogue. The gateway does NOT ship a GSDML because **it is not a PROFINET IO device** — see `profinet-readiness.md` for the full declaration.

Status: **NOT-PLANNED unless a PROFINET IO device mode is added.** Adding PROFINET IO support is a 12-month engineering effort plus a PI (PROFIBUS & PROFINET International) vendor-ID registration; roadmap decision is gated on architectural-arbiter review — owner: architectural-arbiter, no committed milestone until an RFP escalates.

---

## Symbol browsing in TIA Portal

Siemens engineers typically expect to browse tag symbols into TIA Portal via one of:

1. **OPC UA address space browse** — works against an OPC UA server with BrowseService. The gateway implements `BrowseRequest` / `BrowseResponse` (`src/plc_programming/opcua.rs:88-90`). Today this requires the TIA Portal project to tolerate SecurityPolicy None; production use requires the Basic256Sha256 migration.
2. **Export / Import CSV from Excel** — supported by WinCC V7; see `wincc-tag-bridge.md`.
3. **TIA Openness script (`.xml` tag import)** — the gateway does NOT generate Openness-compatible XML. This is NOT-PLANNED.

---

## Known gaps (with finding IDs)

| Gap | Finding ID | Target resolution |
|---|---|---|
| OPC UA SecurityPolicy defaults to None — TIA Portal production projects require Basic256Sha256 | ORPHAN-EDGE-005 | Q2-Q3 2026 |
| MC7 compilation is a placeholder (NOP-only block skeleton); full ST compilation is not implemented per `src/plc_programming/s7comm.rs:862-901` | ORPHAN-EDGE-007 | Q4 2026 — requires TIA Portal Openness |
| No GSDML file shipped | — | NOT-PLANNED |
| No Openness-compatible tag-export generator | — | NOT-PLANNED |

---

## Cross-reference

- Wire-level S7comm spec: `sens-api-gateway/docs/protocols/s7comm.md`
- Wire-level OPC UA spec: `sens-api-gateway/docs/protocols/opcua.md`
- S7 addressing reference: `s7-area-mapping.md`
- OPC UA security roadmap: `opcua-for-siemens.md`
- GSDML / PROFINET IO declaration: `profinet-readiness.md`
