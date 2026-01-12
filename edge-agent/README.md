# Suderra Edge Agent

Industrial IoT agent for aquaculture monitoring and control.

## Features

- **Zero-Touch Provisioning**: Single curl command installation
- **MQTT Communication**: Real-time telemetry and command handling
- **System Telemetry**: CPU, memory, disk, temperature monitoring
- **Modbus TCP/RTU**: PLC and sensor integration
- **GPIO Support**: Raspberry Pi / Revolution Pi I/O (optional)

## Target Platforms

This agent is designed for Linux-based edge devices:

| Platform | Architecture | Binary |
|----------|--------------|--------|
| x86_64 Linux | amd64 | `suderra-agent-amd64` |
| ARM64 Linux | arm64 | `suderra-agent-arm64` |
| ARMv7 Linux | arm | `suderra-agent-arm` |

Supported hardware:
- Revolution Pi Connect 4 / Compact
- Raspberry Pi 4 / 5
- Industrial PCs (x86_64)
- Any Linux system with systemd

## Building

### On Linux (Recommended)

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Build
cd edge-agent
cargo build --release

# Cross-compile for ARM64
rustup target add aarch64-unknown-linux-gnu
cargo build --release --target aarch64-unknown-linux-gnu

# Cross-compile for ARMv7
rustup target add armv7-unknown-linux-gnueabihf
cargo build --release --target armv7-unknown-linux-gnueabihf
```

### On Windows (Development Only)

Windows compilation requires MSYS2 with mingw-w64:

```powershell
# Install MSYS2 from https://www.msys2.org/
# Then in MSYS2 terminal:
pacman -S mingw-w64-x86_64-gcc

# Add to PATH: C:\msys64\mingw64\bin
```

**Note**: The agent is not meant to run on Windows. Use WSL2 or Docker for local development.

## Installation

On target Linux device:

```bash
curl -sSL http://your-api-server/install/DEVICE-CODE | sudo sh
```

## Configuration

Config file: `/etc/suderra/config.yaml`

```yaml
device_id: "uuid-here"
device_code: "RPI-A1B2C3D4"
api_url: "http://your-api-server"

mqtt:
  broker: "mqtt.your-server.com"
  port: 1883
  topics:
    status: "tenants/{tenant_id}/devices/{device_id}/status"
    telemetry: "tenants/{tenant_id}/devices/{device_id}/telemetry"
    commands: "tenants/{tenant_id}/devices/{device_id}/commands"

telemetry:
  interval_seconds: 30
  include_cpu: true
  include_memory: true
  include_disk: true
  include_temperature: true

modbus:
  - name: "PLC-1"
    connection_type: "tcp"
    address: "192.168.1.100:502"
    slave_id: 1
    registers:
      - name: "water_temperature"
        address: 100
        register_type: "input"
        data_type: "i16"
        scale: 0.1
        unit: "°C"
```

## Systemd Service

The installer creates `/etc/systemd/system/suderra-agent.service`:

```bash
# Status
systemctl status suderra-agent

# Logs
journalctl -u suderra-agent -f

# Restart
systemctl restart suderra-agent
```

## MQTT Topics (v1.1)

| Topic | Direction | Description |
|-------|-----------|-------------|
| `tenants/{tid}/devices/{did}/status` | Publish | Device online/offline status |
| `tenants/{tid}/devices/{did}/telemetry` | Publish | System and sensor metrics |
| `tenants/{tid}/devices/{did}/responses` | Publish | Command execution results |
| `tenants/{tid}/devices/{did}/commands` | Subscribe | Remote commands |
| `tenants/{tid}/devices/{did}/config` | Subscribe | Configuration updates |

## Commands

Available remote commands:

| Command | Description | Parameters |
|---------|-------------|------------|
| `ping` | Health check | - |
| `get_info` | Device information | - |
| `get_config` | Current configuration | - |
| `get_hardware` | List all connected hardware | - |
| `read_modbus` | Read Modbus registers | `device` (optional) |
| `write_modbus` | Write Modbus register | `device`, `address`, `value` |
| `read_gpio` | Read all GPIO pins | - |
| `write_gpio` | Write GPIO pin | `pin`, `state` (high/low) |
| `reboot` | Reboot device | `delay_seconds` |
| `restart_agent` | Restart agent service | - |
| `set_log_level` | Change log level | `level` |

### Hardware Commands Examples

**Get Hardware Info:**
```json
{"command": "get_hardware", "command_id": "cmd-001"}
```

Response:
```json
{
  "modbus": {
    "configured": true,
    "connected": true,
    "devices": [{"name": "PLC-1", "address": "192.168.1.100:502", ...}]
  },
  "gpio": {
    "configured": true,
    "available": true,
    "pins": [{"name": "pump_relay", "pin": 17, "direction": "output"}]
  }
}
```

**Read Modbus:**
```json
{"command": "read_modbus", "command_id": "cmd-002", "params": {"device": "PLC-1"}}
```

**Write GPIO:**
```json
{"command": "write_gpio", "command_id": "cmd-003", "params": {"pin": 17, "state": "high"}}
```

### Script Commands

| Command | Description | Parameters |
|---------|-------------|------------|
| `list_scripts` | List all deployed scripts | - |
| `get_script` | Get script details | `id` |
| `deploy_script` | Deploy a new script | Script definition JSON |
| `delete_script` | Delete a script | `id` |
| `enable_script` | Enable a script | `id` |
| `disable_script` | Disable a script | `id` |

**Deploy Script Example:**
```json
{
  "command": "deploy_script",
  "command_id": "cmd-004",
  "params": {
    "id": "high-temp-alert",
    "name": "High Temperature Alert",
    "description": "Alert when water temperature exceeds threshold",
    "triggers": [
      {"type": "threshold", "source": "water_temp", "operator": "gt", "value": 28.0}
    ],
    "actions": [
      {"type": "alert", "level": "warning", "message": "Water temperature high: ${water_temp}°C"},
      {"type": "set_gpio", "target": "17", "value": true}
    ]
  }
}
```

## Script DSL Reference

### Trigger Types

| Type | Description | Fields |
|------|-------------|--------|
| `threshold` | Value crosses threshold | `source`, `operator`, `value` |
| `change` | Value changes | `source` |
| `schedule` | Cron-like schedule | `cron` (minute hour day month weekday) |
| `interval` | Every N seconds | `interval_secs` |
| `gpio_change` | GPIO pin changes | `source` (pin number) |
| `startup` | On agent startup | - |
| `manual` | Manual trigger only | - |

### Action Types

| Type | Description | Fields |
|------|-------------|--------|
| `set_gpio` | Set GPIO pin state | `target` (pin), `value` (true/false) |
| `write_modbus` | Write Modbus register | `device`, `address`, `value` |
| `write_coil` | Write Modbus coil | `device`, `address`, `value` |
| `alert` | Send alert notification | `level`, `message` |
| `set_variable` | Set a variable | `target`, `value` |
| `log` | Log a message | `message` |
| `delay` | Delay execution | `delay_ms` |
| `call_script` | Call another script | `script_id` |

### Comparison Operators

`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `contains`, `between`, `in`

### Variable Interpolation

Use `${source}` syntax in messages:
- `${sensor_name}` - Sensor value
- `${gpio:17}` - GPIO pin state
- `${var:my_var}` - Variable value
- `${time:hour}` - Current hour
- `${system:cpu}` - CPU usage

## Development

```bash
# Run locally (Linux)
RUST_LOG=debug cargo run

# Run tests
cargo test

# Check without building
cargo check
```

## License

Proprietary - Suderra
