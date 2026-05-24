# Configuration Runbook — `/etc/suderra/config.yaml`

**Audience:** Field engineer or plant IT operator editing the live configuration on a running device.
**Prerequisites:**
- Device is installed (`install.md`) and activated (`provisioning.md`).
- You know which subsystems the device hosts: Modbus TCP/RTU, GPIO, I2C (Atlas EZO), scripting, scada-display, LoRaWAN. Each has its own block in the schema.
- You have a tested config change already validated on a non-production device or in a review workflow.

## RC4 release posture

For `agent-v2.0.0-rc4`, production deployments must keep TLS verification enabled, reject retained command messages, keep unsigned mutating commands out of operational use, and use the signed GitHub Release artifacts documented in `docs/runbooks/edge-gateway-rc4-operator.md`.

**Duration:** 10–30 min per edit.
**Blast radius:** single device.
**Safety:** configuration reloads via SIGHUP do NOT restart the process. Actuator outputs under active control retain their state across the reload. When changing the Modbus/GPIO/I2C topology, coordinate with the plant operator and plan a SafeStateManager pass if the edit removes an actuator tag (see Step 8 below + `src/safe_state.rs:123`).

---

## Step 1 — Take a pre-edit backup

**Do:**
```bash
sudo cp /etc/suderra/config.yaml \
    /etc/suderra/config.yaml.$(date -u +%Y%m%dT%H%M%SZ).bak
sudo chmod 0600 /etc/suderra/config.yaml.*.bak
sudo chown root:suderra /etc/suderra/config.yaml.*.bak
```

**Expect:** a dated `.bak` in the same dir with mode 0600.

**Verify:** `ls -l /etc/suderra/config.yaml.*.bak | tail -1` shows a fresh file.

**On failure:** if `/etc/suderra/` is mounted read-only on your hardened profile, use `/var/lib/suderra/` for the backup staging file (it's writable per `ReadWritePaths=` in `suderra-agent.service:94`).

---

## Step 2 — Schema overview

`AgentConfig` is defined in `src/config.rs:144-221`. Top-level blocks (each maps 1:1 to a named YAML key):

| Key | Type | Populated by | Notes |
|-----|------|--------------|-------|
| `device_id` | String (UUID) | provisioning | immutable post-activation |
| `device_code` | String | provisioning | human-readable, e.g. `RPI-A1B2C3D4` |
| `provisioning_token` | `Secret<String>` | operator | cleared after activation |
| `tenant_token` | `Secret<String>` | operator | cleared after self-register |
| `api_url` | String (URL) | operator | HTTPS only |
| `mqtt` | `MqttConfig` | provisioning + operator | see Step 4 |
| `telemetry` | `TelemetryConfig` | operator | sample rate, batch size |
| `logging` | `LoggingConfig` | operator | log level, format (json vs text) |
| `tenant_id` | String | provisioning | immutable |
| `modbus` | `Vec<ModbusDeviceConfig>` | operator | TCP/RTU device list |
| `gpio` | `Vec<GpioConfig>` | operator | platform-validated pin ranges |
| `i2c` | `Vec<I2cDeviceConfig>` | operator | Atlas EZO mainly |
| `scripting` | `ScriptingConfig` | operator | JSON/ST programs |
| `runtime` | `RuntimeConfig` | operator | resilience knobs |
| `cache` | `CacheConfig` | operator | moka cache sizes |
| `circuit_breaker` | `CircuitBreakerConfig` | operator | thresholds |
| `lorawan` | `Option<LoRaWanConfig>` | operator | SX1302 concentrator (feature-gated) |

Fields marked `Secret<String>` are serialised with a `b64:` prefix to keep accidental cleartext grep/diff/backup events at bay (`src/config.rs:36-73`). Base64 is encoding, not encryption — the 0600 file mode is the access-control enforcement.

---

## Step 3 — `mqtt` block

```yaml
mqtt:
  broker: "mqtt.example.com"
  port: 8883
  username: "tenant_abc-device_xyz"
  password: "b64:BASE64_ENCODED_ACTIVATION_PASSWORD"
  tls:
    enabled: true
    ca_cert_path: /etc/suderra/certs/broker-ca.pem
    client_cert_path: null         # set when mTLS is in effect (ROADMAP ORPHAN-EDGE-003)
    client_key_path: null
    verify_hostname: true
    insecure_skip_verify: false    # rejected at runtime in release builds (FR4)
  topics:
    telemetry: "suderra/{tenant_id}/{device_id}/telemetry"
    commands:  "suderra/{tenant_id}/{device_id}/cmd/+"
    status:    "suderra/{tenant_id}/{device_id}/status"
    alarms:    "suderra/{tenant_id}/{device_id}/alarms"
    io_data:   "suderra/{tenant_id}/{device_id}/io"
    capabilities: "suderra/{tenant_id}/{device_id}/capabilities"
    responses: "suderra/{tenant_id}/{device_id}/cmd-response"
    config:    "suderra/{tenant_id}/{device_id}/cfg"
    lora_events: "suderra/{tenant_id}/{device_id}/lora"
  keepalive_secs: 30
  clean_session: false
  last_will_topic: "suderra/{tenant_id}/{device_id}/status"
  failover:
    enabled: false
    backup_broker: null
    backup_port: null
    timeout_secs: 30
    health_check_interval_secs: 60
    max_failures: 3
    recovery_delay_secs: 90
```

Field-level reference:

- `broker` / `port` — required post-activation. Port 8883 for TLS (IEC 62443 SL-2 FR4 default).
- `password` — `Secret<String>` (`src/config.rs:277-283`); custom `Debug` redacts the value.
- `tls.enabled` — default `true` (`default_true()` in `src/config.rs:227`). Setting `false` is an explicit operator decision and is rejected in release builds when combined with `insecure_skip_verify: true`.
- `tls.insecure_skip_verify` — compile-time blocked in release builds (`src/config.rs:250-260`).
- `topics.*` — `{tenant_id}` / `{device_id}` placeholders are resolved at boot (`src/config.rs:441-486`), with a post-resolve validator that rejects unresolved placeholders.
- `clean_session` — default `false` preserves broker-queued QoS 1/2 messages across reconnect.
- `failover` — activates when `enabled: true`. See `src/mqtt_failover.rs` for the backup-broker state machine.

---

## Step 4 — `modbus` block (TCP + RTU)

```yaml
modbus:
  - id: plc-01
    kind: tcp
    address: "192.168.10.20"
    port: 502
    unit_id: 1
    poll_interval_ms: 1000
    tls:
      enabled: true        # v1.2.2 default; IEC 62443 SL-2 FR4
      ca_cert_path: /etc/suderra/certs/plc-ca.pem
  - id: rtu-01
    kind: rtu
    device: /dev/ttyUSB0
    baud_rate: 19200
    parity: even
    data_bits: 8
    stop_bits: 1
    unit_id: 2
    poll_interval_ms: 500
```

Evidence: `rodbus = "=1.4.0"` pin (`Cargo.toml:65-72`) — do not bump without re-testing server-only TLS. The systemd unit grants `/dev/ttyUSB0` + `/dev/ttyAMA0` via `DeviceAllow=` (`suderra-agent.service:161-162`).

---

## Step 5 — `gpio` block

```yaml
gpio:
  - id: pump-01
    pin: 17          # platform-validated: RPi 0–27, RevPi 0–127, Generic Linux 0–255
    direction: out
    initial: low
    label: "Aeration pump"
  - id: flow-sw-01
    pin: 27
    direction: in
    pull: up
    label: "Flow switch"
```

The platform-aware validator (`src/config.rs:98-133`) reads `/proc/device-tree/model` and enforces the per-platform pin range. Generic Linux uses `/dev/gpiochip0` through the kernel `gpiod` interface.

---

## Step 6 — `i2c` block (Atlas EZO sensors)

```yaml
i2c:
  - id: ph-01
    address: 0x63      # Atlas EZO pH default
    device: /dev/i2c-1
    kind: atlas_ph
    poll_interval_ms: 2000
  - id: do-01
    address: 0x61      # Atlas EZO DO default
    device: /dev/i2c-1
    kind: atlas_do
    poll_interval_ms: 2000
```

The systemd unit grants `/dev/i2c-1` (`suderra-agent.service:158`). Calibration state lives in `src/calibration_engine.rs` and is persisted in the SQLCipher DB, not in `config.yaml`.

---

## Step 7 — `lorawan` block (feature-gated)

```yaml
lorawan:
  enabled: true
  region: EU868
  concentrator: sx1302
  device_path: /dev/spidev0.0
```

Compiled only when the binary was built with `cargo build --features lorawan`.
Native SX1302 hardware access additionally requires
`SUDERRA_REQUIRE_SX1302_VENDOR_HAL=1 cargo build --features sx1302-vendor-hal`
with `vendor/sx1302_hal/libloragw/src/*.c` present. If the binary was not built
with `lorawan`, the block is ignored at parse time — no failure, but an `info`
log entry explains that the LoRa actor is not instantiated.

SIGHUP reload fully restarts the LoRa actor when `lorawan` block changes (`src/main.rs:807-847`).

---

## Step 8 — Apply the change

**Do:**
```bash
# Validate YAML syntax before reload (no bad YAML ever reaches the live agent):
sudo -u suderra python3 -c 'import sys, yaml; yaml.safe_load(sys.stdin.read())' \
    < /etc/suderra/config.yaml

# Signal SIGHUP — agent re-reads, re-validates, atomically swaps state:
sudo systemctl reload suderra-agent
```

**Expect:** journal shows
```
SIGHUP received — reloading configuration from disk...
Configuration reloaded successfully. Security-sensitive fields (MQTT credentials, TLS certificates) take effect on next reconnect.
```

**Verify:**
```bash
journalctl -u suderra-agent --since "30 sec ago" | \
    grep -E 'SIGHUP|reload|reject' | tail -10
```

**On failure:**
- `SIGHUP config reload rejected — new config failed validation, keeping current config: <error>` → the NEW config was rejected. The live agent continues with the OLD config. Fix the YAML and SIGHUP again. No restart needed.
- `SIGHUP config reload failed — could not read config file` → check file permissions (Step 1 backup file may have overwritten ownership). Re-apply `chown root:suderra && chmod 0600`.

**Special case — removing an actuator tag:** if the edit removes a GPIO / Modbus output tag that was under active control, first drive the plant into a safe state externally (operator confirmation), then reload. The SafeStateManager does NOT auto-trigger on a config reload — it is invoked only at shutdown (`src/main.rs`) and when a safe-state command arrives via MQTT (gated by `signed-deploy` feature when enabled).

---

## Step 9 — Persist operator intent (commit the change to version-controlled config store)

**Do:** if your deployment keeps device configs under a central Ansible/GitOps store, commit the edited file + the backup file's retention reference. Never store `config.yaml` with raw cleartext credentials in a Git repo — the `b64:` prefix is encoding, not secrecy.

**Expect:** the central store has the NEW config with credentials wiped (or referenced via a secret manager). The device-local file has the real credentials.

**Verify:** diff the committed file against the device file with credential fields redacted.

**On failure:** if credentials have been committed to Git, treat as a credential compromise: revoke + re-provision (see `disaster-recovery.md` → "Revoked cert").

---

## Post-conditions

- New config is active in the running agent.
- Old config is available as `config.yaml.<timestamp>.bak` for rollback.
- Central config store reflects the operator intent without leaking secrets.

## Rollback

```bash
LATEST_BAK=$(ls -t /etc/suderra/config.yaml.*.bak | head -1)
sudo cp "$LATEST_BAK" /etc/suderra/config.yaml
sudo chown root:suderra /etc/suderra/config.yaml
sudo chmod 0600 /etc/suderra/config.yaml
sudo systemctl reload suderra-agent
```

Verify the journal confirms reload; if the OLD config no longer validates (schema drift after an agent upgrade), the reload is rejected and the live agent continues on the NEW config. In that case the rollback must happen at the binary level — see `ota-firmware-update.md` Rollback.

## Appendix: Evidence

- `sens-api-gateway/src/config.rs:144-221` — `AgentConfig` top-level schema.
- `sens-api-gateway/src/config.rs:223-310` — `MqttTlsConfig` + `MqttConfig` + `Secret<String>` handling.
- `sens-api-gateway/src/config.rs:88-138` — platform-aware GPIO validation.
- `sens-api-gateway/src/main.rs:722-887` — SIGHUP reload handler.
- `sens-api-gateway/systemd/suderra-agent.service:91-167` — ReadOnly/ReadWrite paths + device allowlist.
