# Insights Hub (rebrand of MindSphere)

**Scope:** Semantic data model used by Insights Hub (asset types, aspect types, variables) and how the gateway's telemetry maps onto it. Insights Hub is the current brand name; MindSphere is the legacy name — see `mindsphere-connector.md` for the ingestion transport layer.

**Honest posture:** Insights Hub ingestion is **NOT IMPLEMENTED** in the gateway today. This chapter defines the target semantic mapping so a customer RFP can align our telemetry with their Insights Hub asset catalogue.

---

## Siemens version compatibility matrix

| Insights Hub surface | Supported for evaluation today | Status |
|---|---|---|
| Asset Manager v4 | Manual asset provisioning per tenant | Manual procedure only; no gateway automation |
| Aspect Type definitions | Published once per tenant by ops team | MANUAL; no gateway side-car |
| Time-series service v3 | Target ingestion endpoint | NOT WIRED — ORPHAN-EDGE-012 |
| Event service v3 | Target for alarm events | NOT WIRED |
| Notification Service | Target for operator alerts | NOT WIRED |
| OpenAPI v3 schemas | Consumed read-only by our tooling | NOT WIRED |

---

## Target semantic model

Insights Hub organises data under three main abstractions. Each is mapped below to the gateway's domain.

### Asset Type

Describes the category of physical asset (e.g. `Suderra/AquaGateway`, `Suderra/HatcheryPond`, `Suderra/GreenhouseZone`). Target catalogue (not yet published):

| Asset Type (target) | Domain scope | Bundled aspect types |
|---|---|---|
| `Suderra.AquaGateway` | The edge gateway itself | `Health`, `Network`, `StorageIO` |
| `Suderra.Pond` | One aquaculture pond | `WaterQuality`, `EnvironmentalControl`, `AlarmState` |
| `Suderra.HydroponicsZone` | One greenhouse / hydroponics zone | `NutrientFeed`, `Climate`, `AlarmState` |
| `Suderra.S7Plc` | A TIA-Portal-programmed PLC proxied by the gateway | `PlcProgramStatus`, `PlcAreaMirror` |

### Aspect Type

A named bundle of variables observed together. One aspect = one JSON payload over MindConnect IoT Extension.

| Aspect Type | Variables | Source in gateway |
|---|---|---|
| `Suderra.Health` | `cpu_usage_percent`, `memory_usage_percent`, `disk_usage_percent`, `temperature_celsius`, `uptime_seconds` | `src/mqtt.rs:104-119` (`TelemetryMetrics`) |
| `Suderra.Network` | `network_rx_mb`, `network_tx_mb`, `ip_address` | `src/mqtt.rs:123-130` |
| `Suderra.WaterQuality` | `ph`, `dissolved_oxygen`, `temperature`, `salinity`, `orp`, `turbidity` | sensor subsystem (not in `mqtt.rs` scope; sourced from aquaculture sensor modules) |
| `Suderra.EnvironmentalControl` | setpoint + process-variable pairs for aeration, heating, feeding | control loop modules |
| `Suderra.AlarmState` | `active_alarms`, `severity`, `ack_state` | alarm engine |
| `Suderra.PlcProgramStatus` | `plc_state` (RUN/STOP), `program_checksum`, `last_download_ts` | `src/plc_programming/*` |
| `Suderra.PlcAreaMirror` | Per-tag mirror of the configured S7 read list | S7 client polling loop |

### Variable

A leaf time-series field. Each variable carries a datatype aligned with Insights Hub's supported types (`DOUBLE`, `INT`, `BOOLEAN`, `STRING`, `TIMESTAMP`).

Mapping rules:

| Rust/Serde type (gateway) | Insights Hub variable type |
|---|---|
| `f32`, `f64` (`Option<f32>`, `Option<f64>`) | `DOUBLE` |
| `u32`, `u64`, `i32`, `i64` | `INT` (or `BIG_STRING` if > 2^31-1 and downstream cannot accept BIGINT) |
| `bool` | `BOOLEAN` |
| `String` | `STRING` |
| `DateTime<Utc>` | `TIMESTAMP` (ISO-8601, UTC) |

---

## Example payload (target, not today)

Once the MindConnect IoT Extension bridge lands (ORPHAN-EDGE-012, Q3 2026), telemetry will be encoded as:

```json
{
  "timestamp": "2026-04-24T12:00:00.000Z",
  "values": [
    { "dataPointId": "cpu_usage_percent", "value": "42.3", "qualityCode": "0" },
    { "dataPointId": "memory_usage_percent", "value": "63.1", "qualityCode": "0" },
    { "dataPointId": "temperature_celsius", "value": "38.5", "qualityCode": "0" }
  ]
}
```

Published on MQTT topic `s/us/{clientId}/m/{aspectId}` as required by MindConnect IoT Extension.

---

## Onboarding and provisioning (target)

1. Customer ops creates the Asset Types and Aspect Types in Insights Hub (manual, via Insights Hub UI or OpenAPI).
2. Per-device onboarding: Insights Hub issues a one-time configuration JSON file containing tenant ID, client ID, and onboarding JWT.
3. File is placed at `/etc/suderra/insights-hub/onboarding.json` on the device.
4. Gateway bootstraps, exchanges the JWT for durable credentials, attaches its serial as Asset `externalId`.
5. Gateway starts emitting aspect payloads.

None of steps 3-5 are implemented today.

---

## Regional endpoints

Insights Hub endpoints are region-scoped. The gateway's configuration must allow selecting the correct region at deployment time.

| Region | MindConnect IoT Extension MQTT endpoint |
|---|---|
| Europe 1 | `mqtt.eu1.mindsphere.io:8883` |
| Europe 2 | `mqtt.eu2.mindsphere.io:8883` |
| China 1 | `mqtt.cn1.mindsphere.io:8883` |

The gateway's `mqtt.brokers[]` list must be extended with a second broker entry for Insights Hub (alongside our own broker) once the bridge lands. Multi-broker fan-out is not implemented today.

---

## Cross-reference

- MindConnect IoT Extension transport: `mindsphere-connector.md`
- Today's MQTT topic tree: `sparkplug-b.md`
- Telemetry metric catalogue: `src/mqtt.rs:102-138` (`TelemetryMetrics`)
- Finding ORPHAN-EDGE-012: `sens-api-gateway/docs/reviews/orphan-findings.md`
