---
name: sens-api-gateway
description: Knowledge base for the sens-api-gateway Rust edge agent - Modbus/MQTT/GPIO protocols, scripting engine, offline queue, and IEC 62443 security
---

# Sens-API-Gateway (Suderra Edge Agent) Knowledge Base

## Overview

`sens-api-gateway` is a Rust-based edge agent ("Suderra Agent") that runs on IoT hardware (Raspberry Pi, Revolution Pi, industrial gateways) at fish farm sites. It bridges industrial protocols (Modbus TCP/RTU, GPIO, I2C, SPI, PWM) to the cloud via MQTT. It includes a local scripting engine for on-device automation, an offline queue for connectivity resilience, and IEC 62443 security compliance features.

The binary is deployed as a `systemd` service (`suderra-agent.service`).

## Directory Structure

```
sens-api-gateway/
  src/
    main.rs              # Entry point, initializes all subsystems
    config.rs            # AgentConfig - YAML config loader/saver with validation
    modbus.rs            # Modbus TCP/RTU client (rodbus crate, actor pattern)
    mqtt.rs              # MQTT client (rumqttc), publishes telemetry/reads commands
    mqtt_failover.rs     # MQTT HA failover to backup broker
    gpio.rs              # GPIO control (rppal crate for Raspberry Pi)
    i2c.rs               # I2C sensor reads
    spi.rs               # SPI communication
    pwm.rs               # PWM control (motor speeds, dosing pumps)
    offline_queue.rs     # SQLite-backed priority message queue
    provisioning.rs      # Device registration/activation with cloud API
    security.rs          # Security hardening (rate limiting, command validation)
    health.rs            # HTTP health check server
    telemetry.rs         # Device telemetry (CPU, memory, disk, temperature)
    alarms.rs            # Edge-side alarm evaluation
    backup.rs            # Config backup
    shutdown.rs          # Graceful shutdown coordination
    bounded.rs           # Bounded data structures
    interning.rs         # String interning for sensor names
    error.rs             # Error types
    resilience/
      mod.rs             # Re-exports CircuitBreaker, RateLimiter, with_timeout
      circuit_breaker.rs # Circuit breaker (open/half-open/closed states)
      rate_limiter.rs    # Token bucket rate limiter
      timeout.rs         # Operation timeout wrapper
    scripting/
      mod.rs             # ScriptEngine, ExecutionMode, script priority
      engine.rs          # Core script execution engine
      actions.rs         # Action types (GPIO, Modbus write, alert, log)
      context.rs         # ScriptContext (sensor values, GPIO state)
      triggers.rs        # TriggerManager (threshold, time, event triggers)
      limits.rs          # Execution limits (time, actions, depth, rate)
      persistence.rs     # SQLite variable storage (VariableStore)
      storage.rs         # Script CRUD (ScriptStorage)
      conflict.rs        # ConflictDetector (prevents conflicting GPIO actions)
      parallel.rs        # Parallel script execution
      fb_registry.rs     # Function block registry (IEC 61131-3)
      function_blocks/
        mod.rs           # Re-exports all function blocks
        timers.rs        # TON, TOF, TP timer blocks
        counters.rs      # CTU, CTD counter blocks
        edge_triggers.rs # R_TRIG, F_TRIG rising/falling edge
        flipflops.rs     # RS, SR flip-flops
    plc_programming/
      codesys.rs         # CodeSys PLC integration
      ethernet_ip.rs     # EtherNet/IP protocol
  fuzz/                  # Fuzzing targets (cargo-fuzz)
    fuzz_targets/
      config_parse.rs    # Fuzz config YAML parsing
      modbus_response.rs # Fuzz Modbus response parsing
      mqtt_payload.rs    # Fuzz MQTT payload parsing
  tests/
    resource_benchmark.rs
    stress_test.rs
  systemd/
    suderra-agent.service  # systemd unit file for production deployment
  docs/
    ARCHITECTURE.md
    SCENARIOS_BEYOND_SCADA.md
    SECURITY_HARDENING_CHANGELOG.md
    WEB_API.md
  deny.toml              # cargo-deny: dependency audit policy
  Cargo.toml             # Rust dependencies
  .github/workflows/
    ci.yml               # Rust CI (test, clippy, fmt, audit)
    release.yml          # Cross-compilation + GitHub Release
```

## Key Files & Configurations

### AgentConfig (config.rs)

Config file location: `/etc/suderra/config.yaml` (default).

```rust
pub struct AgentConfig {
    pub device_id: String,          // UUID format
    pub device_code: String,        // e.g., "RPI-A1B2C3D4"
    pub provisioning_token: Option<String>,   // Cleared after activation
    pub tenant_token: Option<String>,         // For self-registration
    pub api_url: String,            // Cloud API URL (https://...)
    pub tenant_id: Option<String>,  // Set after activation
    pub mqtt: MqttConfig,
    pub telemetry: TelemetryConfig,
    pub logging: LoggingConfig,
    pub modbus: Vec<ModbusDeviceConfig>,
    pub gpio: Vec<GpioConfig>,
    pub scripting: ScriptingConfig,
    pub runtime: RuntimeConfig,
    pub cache: CacheConfig,
    pub circuit_breaker: CircuitBreakerConfig,
}
```

On save, sets file permissions to `0600` on Unix (protects credentials).

**MQTT Topics Pattern** (tenant-prefixed v1.1):
```
tenants/{tenant_id}/devices/{device_id}/status
tenants/{tenant_id}/devices/{device_id}/telemetry
tenants/{tenant_id}/devices/{device_id}/commands   (subscribe)
tenants/{tenant_id}/devices/{device_id}/config     (subscribe)
tenants/{tenant_id}/devices/{device_id}/responses
```

### Modbus Module (modbus.rs)

Uses `rodbus` crate (v1.2.0 migration from `tokio-modbus`) for native TLS support.

**Actor pattern**: Non-Send Modbus client isolated in an actor communicating via channels.

Connection types:
- `tcp`: Standard Modbus TCP (port 502)
- `rtu`: Modbus RTU over serial port

Supported function codes (whitelist enforced):
- FC1: Read Coils
- FC2: Read Discrete Inputs
- FC3: Read Holding Registers (most common)
- FC4: Read Input Registers

Write FCs (FC5, FC6) only allowed if `security.allow_writes: true`.

**Parallel reads** (v1.2.0): `read_all_parallel()` uses `join_all()` across devices for better latency. `read_all()` is sequential (backwards compatible).

**Byte order support**: `BigEndian` (default), `LittleEndian`, `BigEndianByteSwap`, `LittleEndianByteSwap` for 32-bit multi-register values.

**Data types**: `u16`, `i16`, `u32`, `i32`, `f32` with scale factor.

**Security** (IEC 62443 SL2):
- Function code whitelist (FCs 1,2,3,4 by default)
- Rate limiting: 10 ops/sec, burst 20
- Max 125 registers per read (protocol max)
- Writes disabled by default

**TLS** (IEC 62443 FR4):
- mTLS supported (`client_cert_path` + `client_key_path`)
- `insecure_skip_verify` blocked in release builds at compile time

### MQTT Module (mqtt.rs + mqtt_failover.rs)

Uses `rumqttc` crate. Connects after provisioning/activation.

**Failover** (v1.3.4): `MqttFailoverConfig` with primary/backup brokers:
- 10s timeout before failover
- 3 consecutive failures trigger failover
- Checks primary every 60s when on backup
- 5s delay before switching back to primary

**MQTT credentials**: Password wrapped in `secrecy::Secret<String>` (zeroize on drop, IEC 62443 FR4).

**TLS**: Optional client cert + key for mTLS. Private key files validated for 0600/0400 permissions on Unix.

**Clean session**: `false` by default (preserves QoS 1/2 messages during reconnect).

**Reconnect**: Exponential backoff, 1s min to 60s max.

### GPIO Module (gpio.rs)

Uses `rppal` crate for Raspberry Pi BCM GPIO.

**Platform detection** (IEC 62443 - validates GPIO range):
- Raspberry Pi: BCM GPIO 0-27
- Revolution Pi: GPIO 0-127 (extended)
- Generic Linux: GPIO 0-255

Configuration per pin: `name`, `pin` (BCM number), `direction` (input/output), `pull` (up/down/none), `invert`, `debounce_ms`.

### Scripting Engine (scripting/)

Two execution modes:
- **EventDriven** (default): Scripts run when triggers fire (threshold, cron, event)
- **ScanCycle**: PLC-like deterministic execution every 10-10000ms

**Function blocks** (IEC 61131-3):
- `TON`, `TOF`, `TP` - On-delay, off-delay, pulse timers
- `CTU`, `CTD` - Up/down counters
- `R_TRIG`, `F_TRIG` - Rising/falling edge detectors
- `RS`, `SR` - Flip-flops

**Script limits** (sandboxed execution):
- Max 100 function blocks per program
- Max depth: 10 nested calls
- Max 100 actions per execution
- Max 30s execution time
- Rate limiting per script

**Actions**: GPIO write, Modbus register write, send alert, log message, MQTT publish.

**Persistence**: SQLite variable store for cross-cycle state (`VariableStore` with `VariableScope::Global/Script/FunctionBlock`).

**Conflict detection**: Prevents two scripts from writing conflicting GPIO outputs simultaneously.

### Offline Queue (offline_queue.rs)

SQLite-backed priority queue for MQTT messages when broker is unreachable.

- Bounded size to prevent OOM (IEC 62443 FR5: Resource availability)
- Priority-based ordering (higher priority first), FIFO within same priority
- SQLite persistence for crash recovery
- Mutex poison recovery (v1.2.3) with connection health check (v1.3.3)

### Resilience (resilience/)

Three patterns:
1. **CircuitBreaker**: 3 failures → Open → 30s recovery → Half-open (1 permit) → 2 successes → Closed
2. **RateLimiter**: Token bucket (configurable max, window)
3. **with_timeout**: Wraps any Future with configurable timeout

Applied to: Modbus ops, GPIO ops, MQTT ops, API calls.

### Security Module (security.rs)

Rate limits command processing: 60 commands/60s window by default.

Validates Modbus function codes against whitelist before execution.

### Provisioning (provisioning.rs)

Two flows:
1. **Standard**: Device pre-registered in cloud, uses `provisioning_token` to activate
2. **Self-registration** (v2.0): Uses `tenant_token` from installer link, auto-registers and activates

After activation: clears token, saves `tenant_id`, updates config.

### Telemetry (telemetry.rs)

Reports every 30s (configurable 5-3600s) via MQTT telemetry topic:
- CPU usage, memory, disk, temperature
- System uptime, load average
- Modbus device readings
- GPIO pin states

Optional OpenTelemetry OTLP export: `telemetry.otlp.endpoint`.

### Health Server (health.rs)

HTTP server for local health checks. Used by systemd watchdog.

## Dependencies / Integrations

- **MQTT Broker**: Cloud-side MQTT broker (or Mosquitto in simulator stack). Topics are tenant-prefixed.
- **Cloud API**: `api_url` + REST for provisioning/activation. Gateway-api exposes provisioning endpoints.
- **Sensor-service**: Receives MQTT telemetry from this agent and stores in TimescaleDB.
- **sens-repo**: Older Rust variant (see sens-repo.md). The `sens-api-gateway` is the current version.
- **simulator stack**: `infrastructure/simulators/` provides Mosquitto + Node-RED to simulate this agent in dev.

## Known Gotchas

1. **`secrecy::Secret<String>` for passwords** - MQTT password uses `secrecy` crate for zero-on-drop. Use `password.expose_secret()` to access the value. Never log or display directly.

2. **`insecure_skip_verify` blocked in release builds** - Setting `insecure_skip_verify: true` in Modbus TLS config will panic on release builds (`#[cfg(not(debug_assertions))]` block). This is intentional IEC 62443 FR4 compliance.

3. **Private key file permissions validated on Unix** - If the key file is world-readable or group-readable (not 0600/0400), config loading fails with a permissions error. This catches insecure deployments.

4. **Device ID must be UUID format** - Validated on config load: 36 chars, 4 hyphens, hex chars. Empty `device_id` is only allowed when `tenant_token` is set (self-registration mode).

5. **GPIO platform detection reads `/proc/device-tree/model`** - On non-Linux hosts (Windows/macOS dev), this returns `Unknown` platform (allows all GPIO pins 0-255). On production Linux hardware, invalid pins for the detected platform fail validation.

6. **Scan cycle minimum is 10ms** - The scripting engine enforces `min_scan_cycle_ms: 10`. Values below this are rejected. 100ms is the default.

7. **SQLite for offline queue AND scripting persistence** - Both use SQLite files. The offline queue SQLite mutex has poison recovery - if a thread panics holding the lock, the next access recovers it but logs a warning.

8. **MQTT failover requires explicit config** - `mqtt.failover.enabled: false` by default. Set `enabled: true` and `backup_broker` to activate HA mode.

9. **Modbus slave_id 0 is broadcast** - Validated to reject `slave_id: 0` (Modbus broadcast address). Valid range: 1-247.

10. **Actor pattern for Modbus** - The `ModbusCommand` enum is sent via channels to an actor task because `tokio-modbus`/`rodbus` clients are `!Send`. Do not try to share the client directly across async tasks.
