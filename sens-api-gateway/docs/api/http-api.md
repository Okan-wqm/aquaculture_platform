# HTTP API Reference

**Transport:** HTTP/1.1 (rumqttc/rustls ALPN handles MQTT over TLS separately; the HTTP endpoints described below use a plain `axum` TCP listener).
**Binding:** configured socket address passed to `health::start_health_server(addr, state)` (`src/health.rs:670-703`) — **NOT bound today**, see Status table.
**Feature flag:** `health` (default; see `Cargo.toml:326-328`). When `health` is disabled, the codepath at `src/health.rs:749-780` binds a simple TCP listener that accepts-and-drops — connection success == alive, no JSON response.

## Status: NOT WIRED TODAY (ORPHAN-EDGE-007)

Evidence:

```
$ grep -n start_health_server src/main.rs
(no results other than `mod health;` at line 30)
```

- `health::start_health_server` is **defined** at `src/health.rs:670-703` (feature=`health`) and `src/health.rs:749-780` (feature=not `health`).
- `HealthState` is defined at `src/health.rs:237-651` with all accessor methods.
- `main.rs:124-136` imports used crates; **`crate::health` is NOT imported** into `async_main`'s body. No call to `start_health_server` exists in the binary's wiring today.

**Consequence:** the endpoints below are implementable and fully specified in code, but the running agent does NOT accept HTTP connections on any port. Orchestrator liveness checks (Docker, systemd, Kubernetes) MUST rely on `sd-notify` (`sd_notify` crate at `Cargo.toml:100-101`) or process-level probes until Sprint 6.7 wires the HTTP server.

**Remediation path:**
1. Add `health::start_health_server(addr, health_state).await` in `async_main` after `HealthState::new()` construction.
2. Thread `HealthState` into `MqttClient`, `ModbusHandle`, script engine, and offline queue so their state updates propagate to `/ready` / `/metrics` / `/diagnostics`.
3. Scope: Faz 2 Sprint 6.7 runtime-safety batch (per `runtime_safety` module's Batch 10 scope).

## Endpoint index

All 4 endpoints are `GET`. No authentication today (FR5 Use Control gap — tracked in `docs/security/`).

| Method | Path | Purpose | Response shape | `src/health.rs:line` |
|---|---|---|---|---|
| GET | `/health` | Liveness probe | `HealthResponse` | `706-716` |
| GET | `/ready` | Readiness probe | `ReadinessResponse` | `719-729` |
| GET | `/metrics` | Counter snapshot (JSON, NOT Prometheus — see ORPHAN-EDGE-008) | `MetricsResponse` | `731-736` |
| GET | `/diagnostics` | Comprehensive diagnostics (sysinfo + component status) | `DiagnosticsResponse` | `738-743` |

Router construction: `src/health.rs:679-685`.

## GET `/health`

**Purpose:** Liveness — returns 200 if the agent process is running and the handler task is scheduled.

**Status code semantics** (`src/health.rs:710-714`):

| Internal status | HTTP code |
|---|---|
| `"healthy"` (config loaded AND device activated) | 200 OK |
| `"degraded"` (config loaded, device NOT activated) | 200 OK (still 2xx — liveness is alive-or-dead, not ready-or-not) |
| `"unhealthy"` (config not loaded) | 503 Service Unavailable |

**Response schema** (`HealthResponse`, `src/health.rs:31-39`):

```json
{
  "status": "healthy",
  "version": "1.6.0",
  "uptime_secs": 3712
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `status` | string enum (`"healthy"` \| `"degraded"` \| `"unhealthy"`) | yes | Aggregated state — see table above |
| `version` | string | yes | Agent binary version from `env!("CARGO_PKG_VERSION")` |
| `uptime_secs` | integer (u64) | yes | Seconds since `HealthState::new()` |

## GET `/ready`

**Purpose:** Kubernetes-style readiness probe — returns 200 only when all critical components are initialised.

**Status code semantics** (`src/health.rs:722-727`):

| Condition | HTTP code |
|---|---|
| `is_ready()` == true (config loaded AND device activated; see `src/health.rs:466-469`) | 200 OK |
| not ready | 503 Service Unavailable |

**Response schema** (`ReadinessResponse` + `ReadinessChecks`, `src/health.rs:42-59`):

```json
{
  "ready": true,
  "checks": {
    "config_loaded": true,
    "mqtt_connected": true,
    "device_activated": true
  }
}
```

Note: `mqtt_connected` is informational — readiness gate uses `config_loaded && device_activated` only. An agent with a broken broker connection but valid provisioning can still report ready=true; the orchestrator should consume `/metrics` for connection-quality signal.

## GET `/metrics`

**Purpose:** Counter snapshot — returns JSON-encoded `MetricsResponse` (NOT Prometheus text-format today, see ORPHAN-EDGE-008).

**Response schema** (`MetricsResponse`, `src/health.rs:62-76`):

```json
{
  "uptime_secs": 3712,
  "mqtt_messages_sent": 1284,
  "mqtt_messages_received": 23,
  "modbus_reads": 18650,
  "script_executions": 742,
  "offline_queue_size": 0
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `uptime_secs` | u64 | yes | See `/health` |
| `mqtt_messages_sent` | u64 | yes | Counter — outbound MQTT PUBLISH count since process start |
| `mqtt_messages_received` | u64 | yes | Counter — inbound MQTT PUBLISH count |
| `modbus_reads` | u64 | yes | Counter — Modbus register reads |
| `script_executions` | u64 | yes | Counter — scripting-engine invocations |
| `offline_queue_size` | u64 | yes | Gauge — current depth of `offline_queue` |

**Prometheus migration path (ORPHAN-EDGE-008):**
- `Cargo.toml:311` imports `metrics-exporter-prometheus = { version = "0.16", optional = true }` with feature gate `metrics` (`Cargo.toml:333`).
- Current `/metrics` route calls `axum::Json(state.metrics())` directly.
- Upgrade: replace handler with `metrics_exporter_prometheus::PrometheusBuilder::new().install_recorder()` emitting text-format. Scope: future observability batch; no owner + deadline assigned today.

## GET `/diagnostics`

**Purpose:** Comprehensive troubleshooting snapshot — system info (via `sysinfo = "0.33"`), process info, component status, sanitised config summary, last 10 errors.

**Response schema** (`DiagnosticsResponse`, `src/health.rs:79-233`; construction logic `src/health.rs:513-651`):

```json
{
  "timestamp": "2026-04-24T12:34:56Z",
  "version": "1.6.0",
  "uptime_secs": 3712,
  "system": {
    "os": "Linux 6.8.0-110-generic",
    "hostname": "edge-pi-a1b2c3d4",
    "cpu_count": 4,
    "cpu_usage_percent": 12.4,
    "memory_total_bytes": 4294967296,
    "memory_used_bytes": 524288000,
    "memory_usage_percent": 12.2,
    "disk": {
      "total_bytes": 32000000000,
      "available_bytes": 20000000000,
      "usage_percent": 37.5
    }
  },
  "process": {
    "pid": 1234,
    "memory_bytes": 18874368,
    "thread_count": 0,
    "start_time": "2026-04-24T11:32:04Z"
  },
  "components": {
    "mqtt": {
      "connected": true,
      "messages_sent": 1284,
      "messages_received": 23,
      "last_connected": "2026-04-24T11:32:08Z"
    },
    "modbus": {
      "client_count": 2,
      "total_reads": 18650,
      "read_errors": 3,
      "circuit_states": [
        ["modbus-dev-1", "Closed"],
        ["modbus-dev-2", "HalfOpen"]
      ]
    },
    "scripts": {
      "loaded_count": 4,
      "active_count": 4,
      "total_executions": 742,
      "execution_errors": 1
    },
    "function_blocks": {
      "instance_count": 6,
      "type_counts": {"CTU": 2, "TON": 3, "R_TRIG": 1}
    },
    "offline_queue": {
      "size": 0,
      "capacity": 1000,
      "total_queued": 42,
      "total_sent": 42
    }
  },
  "config": {
    "device_id": "RPI-****c3d4",
    "mqtt_host": "mqtt.example.com",
    "modbus_device_count": 2,
    "gpio_mapping_count": 8,
    "telemetry_interval_secs": 30
  },
  "recent_errors": [
    "[2026-04-24T12:30:11Z] Modbus read error on device 2: timeout"
  ]
}
```

See the OpenAPI schema in [`openapi.yaml`](./openapi.yaml#components/schemas/DiagnosticsResponse) for the authoritative field-level machine schema.

**PII note:** `config.device_id` is masked server-side (`src/health.rs:220-233` — `ConfigDiagnostics.device_id` is documented as "masked"). Other PII-class fields are not present. An authentication gate in front of `/diagnostics` is required before production exposure (FR5 Use Control — see `docs/security/threat-model.md`).

## Authentication

**Today:** None (the handler invokes `state.{health,readiness,metrics,diagnostics}()` without any `Extension`/middleware extraction).

**Roadmap:** Authentication gate (Basic + mTLS) is a Siemens VAQ requirement; scope assigned to FR5 closure batch — tracked in `docs/security/threat-model.md` §3.5.

## Error response shape

Handlers today never return a JSON error body — only the status code. A 503 for `/health` / `/ready` carries no body; clients must read the status code only. A future error-shape standardisation (RFC 7807 Problem Details) is assigned to the same FR5 batch.

## OpenAPI 3.1 machine schema

See [`openapi.yaml`](./openapi.yaml). The YAML is hand-maintained against this narrative; when the code changes, update both files in the same commit.
