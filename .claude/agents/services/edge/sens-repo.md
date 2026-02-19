---
name: sens-repo
description: Knowledge base for sens-repo - older/partial Rust edge agent variant, predecessor to sens-api-gateway
---

# Sens-Repo Knowledge Base

## Overview

`sens-repo` is an older, partial Rust variant of the edge agent that predates `sens-api-gateway`. It appears to be a subset of the full agent implementation, retained in the monorepo as a reference or historical artifact. The `sens-api-gateway` directory is the current, actively maintained edge agent.

**Status**: Partially implemented reference / historical. For active development, use `sens-api-gateway/` instead.

## Directory Structure

```
sens-repo/
  src/
    scripting/
      limits.rs          # Execution limits (same concept as sens-api-gateway)
      actions.rs         # Action types (same concept)
      conflict.rs        # Conflict detection
      fb_registry.rs     # Function block registry
      function_blocks/
        mod.rs           # Function block module
    resilience/
      mod.rs             # Resilience patterns
      timeout.rs         # Timeout wrapper
    bounded.rs           # Bounded data structures
    health.rs            # Health check server
    interning.rs         # String interning
    shutdown.rs          # Graceful shutdown
  fuzz/
    Cargo.toml
    fuzz_targets/
      config_parse.rs    # Fuzz config parsing
      modbus_response.rs # Fuzz Modbus responses
      mqtt_payload.rs    # Fuzz MQTT payloads
  systemd/
    suderra-agent.service  # systemd unit (same as sens-api-gateway)
  docs/
    ARCHITECTURE.md
    SECURITY_HARDENING_CHANGELOG.md
  .github/workflows/
    release.yml           # Cross-compilation release workflow
  Cross.toml             # Cross-compilation config (for ARM targets)
  .gitignore
  LICENSE
```

## Key Differences from sens-api-gateway

`sens-repo` is missing several modules that exist in `sens-api-gateway`:
- No `config.rs` (AgentConfig)
- No `modbus.rs` (Modbus client)
- No `mqtt.rs` (MQTT client)
- No `mqtt_failover.rs`
- No `gpio.rs` / `i2c.rs` / `spi.rs` / `pwm.rs`
- No `offline_queue.rs`
- No `provisioning.rs`
- No `security.rs`
- No `telemetry.rs`
- No `alarms.rs`
- No `plc_programming/` directory
- No Cargo.toml at root level visible (may be in git history)

Present modules (shared concepts):
- `scripting/limits.rs`, `scripting/actions.rs`, `scripting/conflict.rs`, `scripting/fb_registry.rs`
- `resilience/mod.rs`, `resilience/timeout.rs`
- `bounded.rs`, `health.rs`, `interning.rs`, `shutdown.rs`
- Fuzzing targets (same 3 targets as sens-api-gateway)

## Cross-Compilation (Cross.toml)

`Cross.toml` indicates cross-compilation targets were set up using the `cross` tool for building ARM binaries (Raspberry Pi targets like `armv7-unknown-linux-gnueabihf`, `aarch64-unknown-linux-gnu`).

The `release.yml` workflow performs cross-compilation and publishes GitHub Releases.

## Relation to sens-api-gateway

Both projects:
- Share the same scripting subsystem concepts (actions, limits, conflict detection, function blocks)
- Use the same fuzzing targets
- Use the same systemd unit file
- Target the same hardware platforms
- Have the same docs (ARCHITECTURE.md, SECURITY_HARDENING_CHANGELOG.md)

`sens-api-gateway` is the more complete, production-ready version with:
- Full protocol support (Modbus, MQTT, GPIO, I2C, SPI, PWM)
- Security hardening changelog (v1.2.0 through v1.3.4)
- IEC 62443 compliance features
- Offline queue with SQLite persistence
- MQTT failover (v1.3.4)
- Provisioning/self-registration (v2.0)
- Cache and circuit breaker (v1.2.0)
- PLC programming support (CodeSys, EtherNet/IP)

## Dependencies / Integrations

Same as `sens-api-gateway`:
- Deploys as `systemd` service on edge hardware
- Connects to cloud MQTT broker via tenant-prefixed topics
- Data consumed by sensor-service in the platform

## Known Gotchas

1. **Do not actively develop in sens-repo** - All new edge agent development should go in `sens-api-gateway/`. The `sens-repo` is a historical reference.

2. **Separate git repository** - `sens-repo/` contains its own `.git/` directory, making it a nested git repository (not a submodule). This can cause issues with the monorepo's git operations (e.g., `git add .` will skip it, `git status` in the parent won't show its changes).

3. **May lack Cargo.toml** - The root `Cargo.toml` may be absent or in an incomplete state. The project may not compile as-is without it.

4. **Cross-compilation config** - `Cross.toml` sets up `cross` for ARM cross-compilation. This requires Docker and the `cross` CLI tool installed locally.

5. **Fuzz targets in both repos** - Both `sens-repo/fuzz/` and `sens-api-gateway/fuzz/` have the same three fuzz targets. Only run fuzzing from `sens-api-gateway/` where the full implementation exists.
