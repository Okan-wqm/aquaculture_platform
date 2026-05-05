# WinCC Tag Bridge

**Scope:** How WinCC Unified and WinCC V7 can consume data from `sens-api-gateway` as tag values. Three paths are documented; operators pick one per plant.

---

## Siemens version compatibility matrix

| WinCC | Preferred path | Status |
|---|---|---|
| WinCC V7.4 SP1 | Path 1 (OPC UA client) | Reachable today on SecurityPolicy None; production requires Basic256Sha256 migration |
| WinCC V7.5 | Path 1 (OPC UA client) | Same posture |
| WinCC Unified V17 | Path 1 (OPC UA client) | Same posture |
| WinCC Unified V18 | Path 1 (OPC UA client) | Same posture |
| WinCC Unified V19 | Path 1 (OPC UA client) | Same posture |
| WinCC (TIA Portal) Advanced V16-V19 | Path 2 (S7 partner) | PRESENT — requires PUT/GET enabled |
| WinCC OA (PVSS) | Path 1 (OPC UA) | Same posture as WinCC Unified |

---

## Path 1 — WinCC as OPC UA client (preferred)

```
┌─────────────────┐  OPC UA Binary 4840    ┌──────────────────┐
│ WinCC Unified   │  ───────────────────>  │ sens-api-gateway │
│ (OPC UA client) │  Browse / Read / Write │ (OPC UA server)  │
└─────────────────┘                        └──────────────────┘
```

### Today posture

The gateway's `OpcUaConfig::default()` ships with `security_policy: OpcUaSecurityPolicy::None` and `security_mode: OpcUaSecurityMode::None` (`src/plc_programming/opcua.rs:437-438`). WinCC Unified V18/V19 accepts None-policy endpoints only if the engineer explicitly adds an "Unsecured" OPC UA connection to the project. This is **not acceptable for production plants** — Siemens engineering guidance requires Basic256Sha256 + SignAndEncrypt.

### Configuration on the gateway

```yaml
# agent-config.yaml
opcua_server:
  endpoint_url: "opc.tcp://gateway.plant.local:4840"
  security_policy: basic256_sha256   # ROADMAP Q2-Q3 2026 (ORPHAN-EDGE-005)
  security_mode: sign_and_encrypt    # ROADMAP Q2-Q3 2026
  client_cert_path: /etc/suderra/opcua/pki/own/certs/gateway.der
  client_key_path:  /etc/suderra/opcua/pki/own/private/gateway.pem
  session_timeout_ms: 60000
  program_namespace: "urn:suderra:gateway:v1"
```

### Configuration in WinCC Unified (TIA Portal)

1. **Devices & Networks → Add New Device → OPC UA connection.**
2. Server URL: `opc.tcp://gateway.plant.local:4840`.
3. Security policy: `Basic256Sha256` (post-migration). For test labs on SecurityPolicy None, explicitly select `None` and acknowledge the warning.
4. User identity: Username/Password OR X.509 certificate (post-migration).
5. **Import tags via Browse.** Navigate the gateway's address space; select leaves under the agreed node layout (`ns=2;s=Gateway/Device/{device_id}/Telemetry/*` — see `opcua-for-siemens.md`).
6. Save; WinCC generates HMI tags with quality and timestamp propagation.

### Node-ID layout the WinCC engineer sees (post-migration target)

```
Root
└── Objects (ns=0;i=85)
    └── Gateway (ns=2;s=Gateway)
        └── Device (ns=2;s=Gateway/Device/<device_id>)
            ├── Telemetry
            │   ├── cpu_usage_percent    (Variable, DOUBLE)
            │   ├── memory_usage_percent (Variable, DOUBLE)
            │   ├── temperature_celsius  (Variable, DOUBLE)
            │   └── ...
            ├── Sensors
            │   └── <sensor_id>
            │       └── Value             (Variable, DOUBLE)
            └── Commands
                ├── Reboot               (Method)
                ├── FlushCache           (Method)
                └── ...
```

---

## Path 2 — Gateway as S7 partner (Open User Communication)

Used when the plant's WinCC already connects to S7 PLCs and extending another PLC-like endpoint is simpler than adding OPC UA.

```
┌─────────────┐  ISO-on-TCP 102          ┌──────────────────┐
│ WinCC       │  ──────────────────────> │ sens-api-gateway │
│ (S7 driver) │  S7 Read DBn.DBWn        │ (S7 partner /    │
└─────────────┘                          │  S7 server role) │
                                         └──────────────────┘
```

Today-state: the gateway's S7 code is a **client only** (`src/plc_programming/s7comm.rs:474` — `S7Client`). It does NOT expose an S7 **server** role. A WinCC driver cannot therefore point at the gateway as an S7 partner today. This is tracked as a roadmap item (ORPHAN-EDGE-009, target Q4 2026).

### What works instead (until the S7 server role lands)

WinCC can read from the ACTUAL S7 PLC(s) the gateway talks to — i.e. WinCC and the gateway are peers, both clients of the same PLC. The gateway's role is then to write derived values back into a shared DB inside the PLC, which WinCC then reads. This topology requires coordination on DB ownership and is NOT recommended as a primary integration — use Path 1 for new projects.

---

## Path 3 — WinCC consumes MQTT via a gateway broker

Used when the WinCC server cannot reach the gateway directly (segmented networks, DMZ rules).

```
┌──────────────────┐  MQTT TLS    ┌─────────────┐  OPC UA    ┌─────────┐
│ sens-api-gateway │ ───────────> │ MQTT broker │ ─────────> │ WinCC   │
│ (MQTT publisher) │              │ + OPC UA    │            │         │
└──────────────────┘              │ adapter     │            └─────────┘
                                  └─────────────┘
```

The MQTT-to-OPC-UA adapter is NOT part of the gateway — it is a separate Siemens or third-party component (examples: HiveMQ Edge, Matrikon MQTT Agent). The gateway's side of the contract is its MQTT topic tree (see `sparkplug-b.md`, which documents non-Sparkplug format).

---

## Known gaps

| Gap | Finding ID | Target |
|---|---|---|
| OPC UA server default is SecurityPolicy None — unacceptable for WinCC production | ORPHAN-EDGE-005 | Q2-Q3 2026 |
| No S7 server role (cannot act as S7 partner for WinCC) | ORPHAN-EDGE-009 | Q4 2026 |
| No OPC UA Subscription / MonitoredItems (WinCC must poll via Read until migration) | — | Q3 2026 with crate migration |

---

## Cross-reference

- OPC UA security posture: `opcua-for-siemens.md`
- TIA Portal project setup: `tia-portal.md`
- S7 addressing for Path 2 PLCs: `s7-area-mapping.md`
