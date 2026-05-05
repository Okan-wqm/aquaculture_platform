# Configuration Schema Reference

**File path (default):** `/etc/suderra/config.yaml` (`src/config.rs:141`); override via `$SUDERRA_CONFIG`.
**Format:** YAML (parsed by `serde_yaml = "0.9"`, `Cargo.toml:22-23`).
**Root type:** `AgentConfig` (`src/config.rs:144-221`).
**Validation:** `AgentConfig::validate()` (`src/config.rs:1364-1725`) runs at startup; fails fast on malformed values.
**Machine schema:** [`config-schema.json`](./config-schema.json) — JSON Schema draft 2020-12 for IDE completion + `ajv` validation.

## Top-level fields

Evidence: `src/config.rs:144-221`.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `device_id` | string (UUID) | yes | — | Unique device identifier — stable across reboots |
| `device_code` | string | yes | — | Human-readable code (e.g. `RPI-A1B2C3D4`) |
| `provisioning_token` | string (secret) | no | — | Zeroized on drop (`secrecy::Secret`). Cleared after successful activation. Serialised with `serialize_secret_option` (`src/config.rs:154-160`) |
| `tenant_token` | string (secret) | no | — | Zeroized on drop. For self-registration (v2.0). Cleared after success |
| `api_url` | string (URL) | yes | — | Cloud API base URL (https required for production per IEC 62443 FR4) |
| `mqtt` | `MqttConfig` | yes | — | See [MQTT Configuration](#mqtt-configuration) |
| `telemetry` | `TelemetryConfig` | no | defaults | See [Telemetry Configuration](#telemetry-configuration) |
| `logging` | `LoggingConfig` | no | defaults | See [Logging Configuration](#logging-configuration) |
| `tenant_id` | string (UUID) | no | — | Set automatically after provisioning; do not hand-edit |
| `modbus` | `ModbusDeviceConfig[]` | no | `[]` | See [Modbus Configuration](#modbus-configuration) |
| `gpio` | `GpioConfig[]` | no | `[]` | See [GPIO Configuration](#gpio-configuration) |
| `i2c` | `I2cDeviceConfig[]` | no | `[]` | I2C device list (see `src/i2c.rs`) |
| `scripting` | `ScriptingConfig` | no | defaults | See [Scripting Configuration](#scripting-configuration) |
| `runtime` | `RuntimeConfig` | no | defaults | See [Runtime Configuration](#runtime-configuration) |
| `cache` | `CacheConfig` | no | defaults | See [Cache Configuration](#cache-configuration) |
| `circuit_breaker` | `CircuitBreakerConfig` | no | defaults | See [Circuit Breaker Configuration](#circuit-breaker-configuration) |
| `lorawan` | `LoRaWanConfig` | no | absent | Feature-gated `lorawan` (`Cargo.toml:341`) |

## MQTT Configuration

Evidence: `src/config.rs:264-310`.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `broker` | string | yes after activation | — | Broker hostname |
| `port` | integer (u16) | no | `8883` (`src/config.rs:1140-1142`) | TLS port; use `1883` for plain (dev only) |
| `username` | string | yes after activation | — | Broker username |
| `password` | string (secret) | yes after activation | — | Zeroized on drop |
| `tls` | `MqttTlsConfig` | no | `{enabled: true, ...}` | See [MQTT TLS Configuration](#mqtt-tls-configuration) |
| `topics` | `MqttTopics` | no | tenant-prefixed defaults | See [MQTT Topic Patterns](#mqtt-topic-patterns) |
| `keepalive_secs` | integer (u64) | no | `30` (`src/config.rs:1143-1145`) | MQTT keep-alive interval |
| `clean_session` | boolean | no | `false` | **Leave at false** — preserves QoS 1/2 across reconnects (`src/config.rs:297-301`) |
| `last_will_topic` | string | no | — | Optional override; default LWT writes Offline to the `status` topic |
| `failover` | `MqttFailoverConfig` | no | `{enabled: false, ...}` | See [MQTT Failover](#mqtt-failover-configuration) |

### MQTT TLS Configuration

Evidence: `src/config.rs:224-260`.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `enabled` | boolean | no | `true` | Enable TLS (IEC 62443 FR4) |
| `ca_cert_path` | string | no | system CA store | Path to PEM CA for broker verification |
| `client_cert_path` | string | no | — | Path to client cert for mTLS |
| `client_key_path` | string | no | — | Path to client key for mTLS |
| `verify_hostname` | boolean | no | `true` | **MUST be true** — `src/mqtt.rs:703-709` fails fast on false to surface config intent |
| `insecure_skip_verify` | boolean | no | `false` | **BLOCKED in release builds** (`src/config.rs:250-260`) — compile-time guard |

### MQTT Topic Patterns

Evidence: `src/config.rs:382-485`, defaults `src/config.rs:1294-1324`.

Placeholders: `{tenant_id}` and `{device_id}` are resolved at runtime against the provisioning metadata. See [`mqtt-topics.md`](./mqtt-topics.md) for the full 9-topic tree.

| Field | Default pattern |
|---|---|
| `status` | `tenants/{tenant_id}/devices/{device_id}/status` |
| `telemetry` | `tenants/{tenant_id}/devices/{device_id}/telemetry` |
| `responses` | `tenants/{tenant_id}/devices/{device_id}/responses` |
| `commands` | `tenants/{tenant_id}/devices/{device_id}/commands` |
| `config` | `tenants/{tenant_id}/devices/{device_id}/config` |
| `capabilities` | `tenants/{tenant_id}/devices/{device_id}/capabilities` |
| `io_data` | `tenants/{tenant_id}/devices/{device_id}/io_data` |
| `alarms` | `tenants/{tenant_id}/devices/{device_id}/alarms` |
| `lora_events` | `tenants/{tenant_id}/devices/{device_id}/lora_events` |

### MQTT Failover Configuration

Evidence: `src/config.rs:317-346`.

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Master switch. Failover infrastructure exists; `FailoverMqttClient` runtime wiring is scheduled for a future release per `src/mqtt.rs:16-18`. |
| `backup_broker` | string | — | Backup broker hostname |
| `backup_port` | integer (u16) | same as primary | Backup broker port |
| `timeout_secs` | integer (u64) | `30` | Connection timeout before failover |
| `health_check_interval_secs` | integer (u64) | `60` | Interval to poll primary for recovery |
| `max_failures` | integer (u32) | `3` | Consecutive failures before failover |
| `recovery_delay_secs` | integer (u64) | `5` | Delay before attempting primary reconnect |

## Telemetry Configuration

Evidence: `src/config.rs:558-621`.

| Field | Type | Default | Description |
|---|---|---|---|
| `interval_seconds` | integer (u64) | `30` | Telemetry publish interval |
| `include_cpu` | boolean | `true` | Include CPU metrics |
| `include_memory` | boolean | `true` | Include memory metrics |
| `include_disk` | boolean | `true` | Include disk metrics |
| `include_temperature` | boolean | `true` | Include thermal zones |
| `include_system` | boolean | `true` | Include uptime + load average |
| `include_modbus` | boolean | `true` | Include Modbus register values |
| `include_gpio` | boolean | `true` | Include GPIO pin states |
| `include_i2c` | boolean | `true` | Include I2C device readings |
| `io_data_interval_ms` | integer (u64) | `1000` | Process-image publish interval |
| `otlp` | `OtlpConfig` | defaults | See [OTLP Configuration](#otlp-configuration) |

### OTLP Configuration

Evidence: `src/config.rs:542-555`. Feature-gated `telemetry` (`Cargo.toml:329-330`).

| Field | Type | Default | Description |
|---|---|---|---|
| `endpoint` | string | — | OTLP endpoint (e.g. `http://localhost:4317`). Empty = disabled |
| `service_name` | string | `"suderra-agent"` | Trace service name |
| `sample_ratio` | number | `1.0` | Sampling rate 0.0-1.0 |

## Logging Configuration

Evidence: `src/config.rs:624-633`.

| Field | Type | Default | Description |
|---|---|---|---|
| `level` | string | `"info"` | One of `trace`, `debug`, `info`, `warn`, `error` |
| `file` | string | `"/var/log/suderra-agent.log"` | Log file path |

Override via `RUST_LOG` env var (`tracing_subscriber::EnvFilter`).

## Modbus Configuration

Evidence: `src/config.rs:1036-1113`.

### ModbusDeviceConfig (array element)

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | yes | — | Device identifier |
| `connection_type` | string | yes | — | `"tcp"` or `"rtu"` |
| `address` | string | yes | — | TCP: `host:port`; RTU: serial path (e.g. `/dev/ttyUSB0`) |
| `slave_id` | integer (u8) | no | `1` | Modbus slave ID (1-247) |
| `baud_rate` | integer (u32) | no | — | RTU only |
| `registers` | `ModbusRegisterConfig[]` | no | `[]` | Registers to poll |
| `security` | `ModbusSecurityConfig` | no | defaults | Function-code whitelist, rate limit, burst, max register count |
| `tls` | `ModbusTlsConfig` | no | defaults | TLS for Modbus TCP (v1.2.0 — rodbus-native) |

### ModbusRegisterConfig

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | yes | — | Register tag |
| `address` | integer (u16) | yes | — | Register address |
| `register_type` | string | yes | — | `"holding"`, `"input"`, `"coil"`, `"discrete"` |
| `data_type` | string | no | `"u16"` | `"u16"`, `"i16"`, `"u32"`, `"i32"`, `"f32"` |
| `byte_order` | string | no | `"big_endian"` | `"big_endian"`, `"little_endian"`, `"big_endian_byte_swap"`, `"little_endian_byte_swap"` |
| `scale` | number (f64) | no | `1.0` | Scale factor |
| `unit` | string | no | — | Engineering unit (informational) |
| `poll_interval_ms` | integer (u64) | no | — | Override device default |

## GPIO Configuration

Evidence: `src/config.rs:1116-1137`.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | yes | — | Pin tag |
| `pin` | integer (u8) | yes | — | GPIO pin number (platform-dependent valid range; see `GpioPlatform::valid_range` `src/config.rs:100`) |
| `direction` | string | yes | — | `"input"` or `"output"` |
| `pull` | string | no | `"none"` | `"up"`, `"down"`, `"none"` |
| `invert` | boolean | no | `false` | Invert read/write value |
| `debounce_ms` | integer (u64) | no | — | Debounce window (input only) |

## Scripting Configuration

Evidence: `src/config.rs:700-747`.

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Script execution master switch |
| `default_scan_cycle_ms` | integer | per `default_scan_cycle_ms` | Default scan cycle |
| `min_scan_cycle_ms` | integer | per `default_min_scan_cycle_ms` | Lower bound (prevents CPU starvation) |
| `max_scan_cycle_ms` | integer | per `default_max_scan_cycle_ms` | Upper bound |
| `max_function_blocks` | integer | per `default_max_function_blocks` | Limit per program |
| `max_execution_depth` | integer | per `default_max_execution_depth` | Nested call depth limit |
| `max_actions` | integer | per `default_max_actions` | Actions per execution |
| `max_execution_time_secs` | integer | per `default_max_execution_time_secs` | Wall-clock execution limit |

## Runtime Configuration

Evidence: `src/config.rs:751-808`.

| Field | Type | Description |
|---|---|---|
| `rate_limit_max_commands` | integer | Sliding-window command rate limit |
| `rate_limit_window_secs` | integer | Window size |
| `gpio_timeout_secs` | integer | GPIO op timeout |
| `modbus_timeout_secs` | integer | Modbus op timeout |
| `modbus_connect_timeout_secs` | integer | Modbus connect timeout |
| `circuit_breaker_recovery_secs` | integer | CB recovery window |
| `provisioning_timeout_secs` | integer | Provisioning API timeout |
| `shutdown_timeout_secs` | integer | Graceful shutdown deadline |
| `mqtt_reconnect_min_secs` | integer | Exponential-backoff floor |
| `mqtt_reconnect_max_secs` | integer | Exponential-backoff ceiling |

## Cache Configuration

Evidence: `src/config.rs:639-662`.

| Field | Type | Description |
|---|---|---|
| `max_capacity` | integer | Maximum cache entries |
| `ttl_secs` | integer | Time-to-live (0 = no TTL) |
| `tti_secs` | integer | Time-to-idle (0 = no TTI) |

## Circuit Breaker Configuration

Evidence: `src/config.rs:669-696`.

| Field | Type | Description |
|---|---|---|
| `failure_threshold` | integer | Consecutive failures before opening |
| `success_threshold` | integer | Successes in half-open to close |
| `recovery_secs` | integer | Wait before half-open |
| `half_open_permits` | integer | Max concurrent probes in half-open |

## Deployment size examples

### Small (RPi 4 single farm pond)

```yaml
device_id: "11111111-1111-1111-1111-111111111111"
device_code: "RPI-POND-01"
api_url: "https://api.suderra.com"
mqtt:
  broker: "mqtt.suderra.com"
  port: 8883
  tls:
    enabled: true
telemetry:
  interval_seconds: 60
modbus: []
gpio:
  - name: "aerator_primary"
    pin: 17
    direction: "output"
```

### Medium (RevPi + 2 Modbus + GPIO)

```yaml
device_id: "22222222-2222-2222-2222-222222222222"
device_code: "REVPI-MEDIUM-01"
api_url: "https://api.suderra.com"
mqtt:
  broker: "mqtt.suderra.com"
  port: 8883
  tls:
    enabled: true
    ca_cert_path: /etc/suderra/ca.pem
    client_cert_path: /etc/suderra/client.pem
    client_key_path: /etc/suderra/client.key
modbus:
  - name: "ph-sensor"
    connection_type: "tcp"
    address: "192.168.1.10:502"
    slave_id: 1
    registers:
      - { name: "ph", address: 0, register_type: "holding", data_type: "f32", unit: "pH" }
  - name: "do-sensor"
    connection_type: "rtu"
    address: "/dev/ttyUSB0"
    baud_rate: 9600
    slave_id: 2
    registers:
      - { name: "dissolved_oxygen", address: 0, register_type: "input", data_type: "f32", unit: "mg/L" }
gpio:
  - { name: "aerator_a", pin: 17, direction: "output" }
  - { name: "aerator_b", pin: 27, direction: "output" }
  - { name: "emergency_stop", pin: 22, direction: "input", pull: "up" }
```

### Large (multi-tank RAS facility with LoRaWAN gateway)

```yaml
device_id: "33333333-3333-3333-3333-333333333333"
device_code: "RAS-GATEWAY-01"
api_url: "https://api.suderra.com"
mqtt:
  broker: "mqtt.suderra.com"
  port: 8883
  tls: { enabled: true, ca_cert_path: /etc/suderra/ca.pem }
  failover:
    enabled: true
    backup_broker: "mqtt-backup.suderra.com"
telemetry:
  interval_seconds: 30
  otlp:
    endpoint: "http://otel-collector.local:4317"
    sample_ratio: 0.1
modbus: [ /* 8 devices, 80+ registers */ ]
gpio: [ /* 16 pins */ ]
scripting:
  enabled: true
  max_function_blocks: 128
lorawan:
  enabled: true
  region: "EU868"
  net_id: "000001"
  spi_device: "/dev/spidev0.0"
  reset_gpio_pin: 7
  max_devices: 100
```

## Validation rules (highlights)

All enforced by `AgentConfig::validate()` (`src/config.rs:1364-1725`):
- `MqttTlsConfig::insecure_skip_verify=true` is REJECTED in release builds (`src/config.rs:250-260`).
- `verify_hostname=false` is REJECTED at MQTT client construction (`src/mqtt.rs:703-709`).
- Modbus register count per request is bounded by `ModbusSecurityConfig.max_register_count` (default per `default_max_register_count`).
- Modbus function code must appear in the whitelist (`ModbusSecurityConfig.function_whitelist`).
- Scan-cycle values must satisfy `min_scan_cycle_ms <= default_scan_cycle_ms <= max_scan_cycle_ms`.

## Secret handling

Three fields use `secrecy::Secret<String>` with zeroize-on-drop (`Cargo.toml:47`):
- `provisioning_token` (`src/config.rs:154-160`)
- `tenant_token` (`src/config.rs:164-170`)
- `mqtt.password` (`src/config.rs:278-283`)

Custom `Debug` masks the MQTT password as `[REDACTED]` (`src/config.rs:362-375`). Serialisation of secrets is allowed so the config file can round-trip; the token fields are explicitly cleared after activation (comment at `src/config.rs:152-163`).

## Signed config (D-13, roadmap)

The `config_integrity` module (`src/main.rs:85-86`, `#[allow(dead_code)]`) implements `config.yaml.sig` factory-signed integrity verification. Runtime startup wiring (fail-closed boot if verify fails) lands in Faz 2 Sprint 6.6 — NOT WIRED today.

## JSON Schema

See [`config-schema.json`](./config-schema.json) (draft 2020-12).
