# Event Payload Schemas

**Scope:** The JSON payload shapes emitted by the edge agent onto MQTT topics (see [`mqtt-topics.md`](./mqtt-topics.md)) and the corresponding cloud-side event contracts (`libs/event-contracts/src/**`).
**Wire format:** JSON (UTF-8) for every topic.
**Serialisation source:** `#[derive(Serialize)]` / `#[derive(Deserialize)]` types in `src/mqtt.rs`, `src/alarms.rs`, `src/hardware_scanner.rs`, `src/io_poll.rs`, `src/lora/`.

## Payload catalogue

| # | Payload | MQTT topic suffix | Rust source | Cloud equivalent |
|---|---|---|---|---|
| 1 | `StatusMessage` | `status` | `src/mqtt.rs:70-88` | (no direct cloud event — sensor-service consumes for heartbeat state) |
| 2 | `TelemetryMessage` | `telemetry` | `src/mqtt.rs:90-139` | `EdgeDeviceHeartbeatEvent` (`libs/event-contracts/src/edge-device-events.ts:11-21`) — partial map |
| 3 | `CommandMessage` | `commands` (inbound) | `src/mqtt.rs:169-179` | (cloud-originated; no reverse event) |
| 4 | `CommandResponse` | `responses` | `src/mqtt.rs:182-192` | `EdgeDeviceResponseEvent` (`libs/event-contracts/src/edge-device-events.ts:27-35`) |
| 5 | ConfigUpdateMessage | `config` (inbound) | see config-schema.md | `IoConfigPushResultEvent` is the ACK response shape, not the input |
| 6 | CapabilitiesReport | `capabilities` | `src/hardware_scanner.rs` (serde_json::Value) | (no direct event; sensor-service persists as device-metadata row) |
| 7 | IoDataMessage | `io_data` | `src/io_poll.rs` + `src/process_image.rs` | `EdgeDeviceIoDataEvent.tagsJson` JSON string (`libs/event-contracts/src/edge-device-events.ts:45-49`) |
| 8 | AlarmEventBatch | `alarms` | `src/alarms.rs` | `EdgeDeviceAlarmEvent.alarmsJson` JSON string + `alarmCount` (`libs/event-contracts/src/edge-device-events.ts:58-63`) |
| 9 | `LoRaEvent` | `lora_events` | `src/lora/` (feature-gated) | `LoRaDeviceEventEvent` (`libs/event-contracts/src/edge-device-events.ts:82-91`) |
| 10 | `AuditEvent` | (roadmap: `audit` sub-topic) | `src/audit/` (`#[allow(dead_code)]`) | (cloud admin-api consumer; Sprint 6.2) |

AsyncAPI machine schemas: [`asyncapi.yaml`](./asyncapi.yaml#components/schemas).

## 1. StatusMessage (`src/mqtt.rs:70-88`)

```json
{
  "device_id": "11111111-1111-1111-1111-111111111111",
  "device_code": "RPI-A1B2C3D4",
  "status": "online",
  "timestamp": "2026-04-24T12:34:56+00:00",
  "agent_version": "1.6.0",
  "uptime_seconds": 3712
}
```

Fields (all required):
- `device_id` — UUID string
- `device_code` — human-readable code
- `status` — one of `online`, `offline`, `maintenance`, `error` (serde `rename_all = "lowercase"` at `src/mqtt.rs:82`)
- `timestamp` — RFC 3339
- `agent_version` — `CARGO_PKG_VERSION`
- `uptime_seconds` — u64

**QoS 1, retained=true** — a new subscriber reads the current device state immediately. Offline status is published as Last Will (`src/mqtt.rs:264-269`).

## 2. TelemetryMessage (`src/mqtt.rs:92-139`)

```json
{
  "device_id": "11111111-1111-1111-1111-111111111111",
  "device_code": "RPI-A1B2C3D4",
  "timestamp": "2026-04-24T12:34:56+00:00",
  "agent_version": "1.6.0",
  "metrics": {
    "cpu_usage_percent": 12.4,
    "memory_usage_percent": 18.2,
    "memory_used_mb": 745,
    "memory_total_mb": 4096,
    "disk_usage_percent": 37.5,
    "disk_used_gb": 12.0,
    "disk_total_gb": 32.0,
    "temperature_celsius": 47.2,
    "network_rx_mb": 104.6,
    "network_tx_mb": 18.2,
    "ip_address": "192.168.1.42",
    "modbus": [
      {
        "device_name": "ph-sensor",
        "registers": [
          { "name": "ph", "address": 0, "value": 7.42, "unit": "pH" }
        ],
        "errors": []
      }
    ],
    "gpio": [
      { "name": "aerator_a", "pin": 17, "direction": "out", "state": "high" }
    ]
  }
}
```

All fields in `metrics` are optional (`skip_serializing_if = "Option::is_none"` at `src/mqtt.rs:104-139`).

**MED-27 invariant:** all `metrics.*` fields share exactly one wall-clock timestamp (`src/mqtt.rs:564-571`) — a single `Utc::now()` call avoids microsecond skew between CPU, memory, and register readings.

**LOW-42 invariant:** network counters are in MB (f64), NOT bytes (u64). Raw byte counters exceed 2^53 after ~9PB of traffic and cause rounding errors in JSON parsers that use 64-bit floats.

### CONTRACT-DRIFT WARNING #1 — edge `TelemetryMessage` vs cloud `SensorReadingEvent`

**Cloud contract** (`libs/event-contracts/src/sensor-events.ts:10-24`):

```ts
export interface SensorReadingEvent extends BaseEvent {
  eventType: 'SensorReading';
  sensorId: string;
  farmId?: string;
  pondId?: string;
  readingTemperature?: number;
  readingPh?: number;
  readingDissolvedOxygen?: number;
  // ... flat readingXxx fields
}
```

**Edge payload** uses `device_id` + `device_code` + **nested `metrics` object**; cloud uses `sensorId` + **flat `readingXxx` fields**.

**Drift category:** CONTRACT-CRITICAL-004 — no shared wire contract exists. The translation layer lives entirely in the cloud's `sensor-service` MQTT listener, which consumes edge payloads and emits the typed cloud events.

**Consequences:**
- An edge-side schema change (adding a new metric) has ZERO compile-time impact on the cloud; cloud code must be updated manually to surface the field.
- The cloud's `SensorMetricIngestedEvent` (`libs/event-contracts/src/sensor-events.ts:54-91`) is published AFTER Rust-sidecar enrichment for a different ingestion path (ADR-022 control/data-plane split) — it is NOT the same event as the edge MQTT payload.
- Fields like `readingPh` / `readingDissolvedOxygen` on the cloud side are mapped from `metrics.modbus[].registers[].value` only when `sensor-service` has per-tenant sensor-metadata to interpret the register; otherwise the reading is discarded.

**Recommended fix (ROADMAP — not assigned an owner or deadline today):** define a shared JSON Schema at `libs/event-contracts/schemas/edge-telemetry.schema.json` that both edge (validated at publish) and cloud (validated at consume) conform to. Edge-side consumer: `src/mqtt.rs:562-593` `publish_telemetry`. Cloud-side consumer: `apps/sensor-service/src/mqtt/mqtt-listener.service.ts`.

### CONTRACT-DRIFT WARNING #2 — edge `TelemetryMessage` vs cloud `EdgeDeviceHeartbeatEvent`

**Cloud contract** (`libs/event-contracts/src/edge-device-events.ts:11-21`):

```ts
export interface EdgeDeviceHeartbeatEvent extends BaseEvent {
  eventType: 'EdgeDeviceHeartbeat';
  deviceId: string;
  deviceCode: string;
  isOnline: boolean;
  cpuUsage?: number;        // camelCase
  memoryUsage?: number;     // camelCase — renamed from memory_usage_percent
  storageUsage?: number;    // camelCase — renamed from disk_usage_percent
  temperatureCelsius?: number;
  uptimeSeconds?: number;
}
```

**Edge payload** is snake_case (`cpu_usage_percent`, `memory_usage_percent`, `disk_usage_percent`); cloud event is camelCase AND renames fields:
- `memory_usage_percent` → `memoryUsage` (semantic drift — cloud hides the "percent" suffix)
- `disk_usage_percent` → `storageUsage` (lexical drift — "disk" renamed to "storage")

The sensor-service MQTT listener absorbs both case and field-name differences.

**Drift category:** CONTRACT-HIGH.

**Recommended fix:** align edge field names with cloud. Edge is the narrower change surface (fewer consumers). Owner + deadline: not assigned today.

## 3. CommandMessage (`src/mqtt.rs:169-179`)

```json
{
  "commandId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "command": "write_modbus",
  "params": { "device": "ph-sensor", "address": 0, "value": 7.00 },
  "timestamp": "2026-04-24T12:34:56+00:00"
}
```

Note `#[serde(rename_all = "camelCase")]` (`src/mqtt.rs:171`) — the wire is camelCase, not snake_case. `commandId` NOT `command_id`.

See [`remote-commands.md`](./remote-commands.md) for the catalogue of valid `command` values and per-command `params` shapes.

## 4. CommandResponse (`src/mqtt.rs:182-192`)

```json
{
  "commandId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "deviceId": "11111111-1111-1111-1111-111111111111",
  "success": true,
  "result": { "written": true },
  "timestamp": "2026-04-24T12:34:57+00:00",
  "error": null
}
```

On failure: `success=false`, `result=null`, `error="<message>"`.

### CONTRACT-DRIFT WARNING #3 — edge `CommandResponse` vs cloud `EdgeDeviceResponseEvent`

**Cloud contract** (`libs/event-contracts/src/edge-device-events.ts:27-35`):

```ts
export interface EdgeDeviceResponseEvent extends BaseEvent {
  eventType: 'EdgeDeviceResponse';
  deviceCode: string;    // cloud uses device_code, not device_id
  commandId?: string;
  command?: string;
  success?: boolean;     // cloud: optional; edge: required
  data?: unknown;        // cloud: data; edge: result
  error?: string;
}
```

**Drifts:**
- Edge emits `deviceId` (UUID); cloud surfaces `deviceCode` (human-readable).
- Edge `success` is required (bool); cloud `success` is optional.
- Edge emits `result` (JSON value); cloud surfaces `data` (renamed).

**Drift category:** CONTRACT-HIGH.

## 5. ConfigUpdateMessage (inbound)

Handler: `src/commands.rs:3199` (`handle_config_update`). The payload on the `config` topic is the SAME YAML-equivalent JSON as `AgentConfig` — see [`config-schema.md`](./config-schema.md).

## 6. CapabilitiesReport

Emitted once at boot via `MqttClient::publish_raw` (`src/mqtt.rs:643-653`). Shape is built in `src/hardware_scanner.rs`; fields are version-dependent (not frozen). The cloud persists this as device-metadata — no typed event interface.

## 7. IoDataMessage

Shape:

```json
{
  "ts": "2026-04-24T12:34:56+00:00",
  "tags": {
    "pond3_aerator_primary": { "value": true, "quality": "good" },
    "pond3_ph": { "value": 7.42, "unit": "pH", "quality": "good" }
  }
}
```

Cloud side surfaces this as `EdgeDeviceIoDataEvent.tagsJson` — the entire `tags` object is serialised as a JSON STRING (not a structured object) because tag names are dynamic per tenant (per the cloud comment at `libs/event-contracts/src/edge-device-events.ts:42-43`).

### CONTRACT-DRIFT WARNING #4 — flat string escape

The cloud wraps the `tags` object in a string field (`tagsJson`) to work around the event-contracts flat-pattern rule (ADR-006 no nested payload wrappers). This is architectural debt called out by comment `ARCH-C01` in the cloud event file. No edge-side change required; the drift is a cloud-internal pattern cost.

## 8. AlarmEventBatch

Shape emitted by `MqttClient::publish_alarms` (`src/mqtt.rs:625-631`); constructed in `src/alarms.rs`:

```json
{
  "alarms": [
    {
      "alarm_id": "alarm-001",
      "tag": "pond3_ph",
      "state": "UNACK_ACTIVE",
      "priority": "high",
      "threshold": { "op": ">", "value": 8.5 },
      "current_value": 8.7,
      "timestamp": "2026-04-24T12:34:56+00:00"
    }
  ]
}
```

Cloud side: `EdgeDeviceAlarmEvent.alarmsJson` (JSON string) + `alarmCount: number` for quick access.

### CONTRACT-DRIFT WARNING #5 — alarm field set

The edge `alarms[]` element shape is defined by the Rust `AlarmManager` and is not pinned to a cloud-side typed interface. The cloud wraps the array as a JSON string (`alarmsJson`) for the same flat-pattern reason as `IoDataMessage`.

## 9. LoRaEvent (feature = `lorawan`)

```json
{
  "event_type": "uplink_summary",
  "dev_eui": "0102030405060708",
  "rssi": -87,
  "snr": 8.5,
  "frame_count_up": 142,
  "dev_addr": "00000001"
}
```

Cloud contract `LoRaDeviceEventEvent` (`libs/event-contracts/src/edge-device-events.ts:82-91`) aligns on field names; case conversion happens at the MQTT listener.

### CONTRACT-DRIFT WARNING #6 — case-only drift

Edge uses `dev_eui` / `frame_count_up` / `dev_addr` (snake_case); cloud event uses `devEui` / `frameCountUp` / `devAddr` (camelCase). Sensor-service MQTT listener handles the conversion. CONTRACT-LOW — purely lexical.

## 10. AuditEvent (ROADMAP — Sprint 6.2)

Source: `src/audit/` (`#[allow(dead_code)]` at `src/main.rs:65-66`). Types staged:
- `AuditEntry` — tenant-scoped, HMAC-chained (ADR-020 §1)
- HMAC chain key derived via HKDF from master (ADR-020 §2)

The roadmap shape (NOT wired today):

```json
{
  "entry_id": "01HXYZ...",
  "tenant_id": "22222222-2222-2222-2222-222222222222",
  "device_id": "11111111-1111-1111-1111-111111111111",
  "timestamp": "2026-04-24T12:34:56+00:00",
  "actor": { "operator_id": "...", "role": "plc_engineer" },
  "permission": { "DeployProgram": null },
  "decision": "Allow",
  "command_id": "...",
  "hmac": "..."
}
```

The audit chain is appended locally (SQLCipher-encrypted per ADR-019 §7), optionally relayed to the cloud via a separate control-plane path (NOT over the `alarms` or `telemetry` topics). Cloud consumer: admin-api-service.

## Regeneration workflow

When a new payload field is added on the edge side:
1. Update the Rust `#[derive(Serialize)]` struct.
2. Update [`asyncapi.yaml`](./asyncapi.yaml) `components/schemas/` entry in the same commit.
3. Update this chapter's payload block + CONTRACT-DRIFT warning if the field does not appear on the cloud side.
4. File an orphan finding if the drift is new.

## Cross-references

- [`mqtt-topics.md`](./mqtt-topics.md) — which topic carries which payload.
- [`remote-commands.md`](./remote-commands.md) — command catalogue + `commandId` round-trip semantics.
- [`asyncapi.yaml`](./asyncapi.yaml) — machine schemas.
- `libs/event-contracts/src/edge-device-events.ts` — cloud-side typed interfaces consumed by WebSocket bridges to the frontend.
- `libs/event-contracts/src/sensor-events.ts` — cloud-side typed interfaces consumed by sensor-service and alert-engine.
- `apps/sensor-service/src/mqtt/` — MQTT listener that absorbs all edge drift.
