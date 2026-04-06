# S2 Audit — HIGH Findings: Enterprise Recommendations
**Date:** 2026-04-05
**Reviewer:** edge-expert
**Review ref:** `docs/reviews/edge-expert/2026-04-05-s2-high-findings.md`

---

## H-01 — MQTT TLS `verify_hostname` silently ignored

**Root Cause:** `MqttTlsConfig.verify_hostname` is parsed but never read by `configure_tls()`.

**Blocking action (before next release):**

Add a startup validation that fails fast when an operator sets a config field that has no implementation. In `MqttTlsConfig::validate()` (`config.rs` lines 250-260):

```rust
pub fn validate(&self) -> Result<(), crate::error::AgentError> {
    #[cfg(not(debug_assertions))]
    if self.insecure_skip_verify {
        return Err(crate::error::AgentError::Config(
            "MQTT TLS insecure_skip_verify is not allowed in release builds".into(),
        ));
    }

    // verify_hostname is currently not implemented in configure_tls().
    // Reject false to prevent operators from thinking hostname verification
    // can be disabled — this would be a silent no-op and a security audit trap.
    if !self.verify_hostname {
        return Err(crate::error::AgentError::Config(
            "mqtt.tls.verify_hostname: false is not supported. Hostname \
             verification is always enforced. Remove this field or set it to true.".into(),
        ));
    }

    Ok(())
}
```

**Long-term architectural fix:**

For IEC 62443 SL2 FR-4 compliance, hostname verification must be explicitly enforced and documented. The recommended path is to make `configure_tls()` build `rustls::ClientConfig` manually for both the custom-CA and system-CA code paths, removing the `TlsConfiguration::Simple` branch which delegates config to `rumqttc` internals. This gives full control over the verifier and makes the security boundary explicit:

```rust
// Both branches produce a ClientConfig that can be audited
let root_store = build_root_store(tls_config)?;  // custom CA or system CA
let client_config = if let Some((cert, key)) = client_auth {
    rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_client_auth_cert(cert, key)?
} else {
    rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth()
};
// No dangerous() call — hostname verification is always active
let tls = TlsConfiguration::Rustls(Arc::new(client_config));
```

Remove `verify_hostname` from `MqttTlsConfig` and update the YAML comment in `main.rs` accordingly.

**Effort:** Medium (2-4 hours). No breaking change to deployment configs that have `verify_hostname: true` (the default).

---

## H-02 — Command Replay Attack: Missing idempotency on `command_id`

**Root Cause:** `CommandHandler::execute_command()` has no check that a `command_id` was already executed, and no timestamp window check.

**Blocking action — timestamp window (low effort):**

Add to `CommandHandler::handle_message()` at `commands.rs` line 298, immediately after parsing:

```rust
const MAX_COMMAND_AGE_SECS: i64 = 300;

let command: CommandMessage = match serde_json::from_slice(&message.payload) { ... };

// Reject stale commands to prevent replay attacks (IEC 62443 FR-2)
match chrono::DateTime::parse_from_rfc3339(&command.timestamp) {
    Ok(cmd_time) => {
        let age_secs = (Utc::now() - cmd_time.with_timezone(&Utc)).num_seconds().abs();
        if age_secs > MAX_COMMAND_AGE_SECS {
            warn!(
                "Rejecting stale command '{}' (id: {}): timestamp {} is {}s old (max {}s)",
                command.command, command.command_id,
                command.timestamp, age_secs, MAX_COMMAND_AGE_SECS
            );
            return Ok(());
        }
    }
    Err(e) => {
        warn!("Rejecting command with unparseable timestamp: {}", e);
        return Ok(());
    }
}

// Reject retained MQTT messages — they are configuration snapshots, not commands
if message.retain {
    warn!(
        "Rejecting retained MQTT message on commands topic (command_id: {}). \
         Commands must not be retained.",
        command.command_id
    );
    return Ok(());
}
```

**Blocking action — in-memory deduplication (medium effort):**

Add to `CommandHandler` struct:

```rust
/// Recently executed command IDs for replay protection (IEC 62443 FR-2)
/// Maps command_id -> execution_time. Bounded by MAX_COMMAND_AGE_SECS eviction.
executed_commands: std::collections::HashMap<String, std::time::Instant>,
```

In `handle_message()` after timestamp check:

```rust
// Evict expired entries
let cutoff = Instant::now() - Duration::from_secs(MAX_COMMAND_AGE_SECS as u64);
self.executed_commands.retain(|_, t| *t > cutoff);

// Reject duplicate command_id
if self.executed_commands.contains_key(&command.command_id) {
    warn!(
        "Rejecting duplicate command '{}' (id: {}): already executed in this session",
        command.command, command.command_id
    );
    // Re-publish idempotent success response (or log and drop)
    return Ok(());
}

// Execute and record
let response = self.execute_command(&command).await;
self.executed_commands.insert(command.command_id.clone(), Instant::now());
```

**Long-term — persistent idempotency store:**

For safety-critical commands (`deploy_program`, `write_modbus`, `write_gpio`, `reboot`, `update_firmware`), persist the `command_id` to the existing SQLCipher SQLite database:

```sql
CREATE TABLE IF NOT EXISTS executed_commands (
    command_id TEXT PRIMARY KEY,
    command_type TEXT NOT NULL,
    executed_at INTEGER NOT NULL,  -- unix millis
    success INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_executed_commands_at ON executed_commands (executed_at);
```

On agent start, load all entries from the last `MAX_COMMAND_AGE_SECS` seconds into the in-memory map. On each safety-critical command execution, INSERT with `OR IGNORE` before executing. Prune entries older than the window on startup.

**Effort:** Timestamp window + retain check: 1-2 hours. In-memory dedup: 2-3 hours. Persistent store: 4-6 hours.

---

## H-03 — Modbus Write: No register address whitelist

**Root Cause:** `ModbusSecurityConfig` has no `allowed_write_registers` field. `write_register()` and `write_coil()` do not validate the target address.

**Architectural change required:**

Add to `ModbusSecurityConfig` in `config.rs`:

```rust
/// Permitted writable register address ranges (IEC 62443 FR-2/FR-3)
/// If empty and allow_writes is true, all addresses are permitted (deprecated behavior).
/// Recommended: always specify explicit ranges in production.
#[serde(default)]
pub allowed_write_registers: Vec<ModbusWriteRange>,

/// If true, reject writes to addresses not declared in the device register map.
/// Provides defense-in-depth against writes to undeclared registers.
#[serde(default = "default_true")]
pub restrict_to_declared_registers: bool,
```

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModbusWriteRange {
    pub start_address: u16,
    pub end_address: u16,   // inclusive
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}
```

Add to `ModbusClient` in `modbus.rs`:

```rust
fn validate_write_address(&self, address: u16) -> Result<()> {
    if !self.security.enabled { return Ok(()); }

    // Check configured write ranges (if any)
    if !self.security.allowed_write_registers.is_empty() {
        let allowed = self.security.allowed_write_registers
            .iter()
            .any(|r| address >= r.start_address && address <= r.end_address);
        if !allowed {
            return Err(anyhow::anyhow!(
                "Write to address 0x{:04X} denied for device '{}': \
                 address not in write whitelist. Configured ranges: {:?}",
                address, self.config.name,
                self.security.allowed_write_registers
            ));
        }
    }

    // Optionally restrict to declared register map
    if self.security.restrict_to_declared_registers {
        let in_map = self.registers.iter().any(|r| r.address == address);
        if !in_map {
            return Err(anyhow::anyhow!(
                "Write to address 0x{:04X} denied for device '{}': \
                 address not declared in register map (restrict_to_declared_registers=true)",
                address, self.config.name
            ));
        }
    }

    Ok(())
}
```

Call site in both `write_register()` and `write_coil()`:

```rust
self.validate_write_allowed()?;
self.validate_write_address(address)?;  // add after validate_write_allowed
self.validate_function_code(FC_WRITE_SINGLE_REGISTER)?;
```

Add config validation in `config.rs::AgentConfig::validate()`:

```rust
if device.security.allow_writes && device.security.allowed_write_registers.is_empty() {
    warn!(
        "Modbus device '{}': allow_writes=true but no allowed_write_registers configured. \
         All addresses are writable. Consider specifying write ranges for IEC 62443 FR-2 compliance.",
        device.name
    );
}
```

**Effort:** Medium (4-6 hours including config schema change, validation, and test cases).

---

## H-04 — FFI: `nb_pkt` bound enforcement in `sx1302.rs`

**Root Cause:** Implicit trust in C HAL return value as a safe slice bound; no explicit runtime check.

**Required change in `sx1302.rs` receive() function:**

```rust
let nb_pkt = unsafe {
    ffi::lgw_receive(MAX_RX_PACKETS as u8, pkt_buf.as_mut_ptr())
};

if nb_pkt < 0 {
    anyhow::bail!("SX1302 paket alma hatasi: lgw_receive() = {}", nb_pkt);
}

// Enforce C HAL safety invariant explicitly in safe code
let nb_pkt_usize = nb_pkt as usize;
if nb_pkt_usize > pkt_buf.len() {
    anyhow::bail!(
        "SX1302 HAL invariant violated: lgw_receive() returned {} but buffer \
         capacity is {} — possible HAL bug or memory corruption",
        nb_pkt_usize, pkt_buf.len()
    );
}

// nb_pkt_usize is now guaranteed in-bounds
let packets: Vec<RxPacket> = pkt_buf[..nb_pkt_usize]
    .iter()
    .map(|pkt| { ... })
    .collect();
```

Add compile-time assertion for `MAX_RX_PACKETS` u8 cast safety. Locate where `MAX_RX_PACKETS` is defined and add:

```rust
// Compile-time: lgw_receive() takes uint8_t max count — ensure no truncation
const _: () = assert!(
    MAX_RX_PACKETS <= 255,
    "MAX_RX_PACKETS exceeds u8 range; lgw_receive() call will silently truncate"
);
```

**Effort:** Low (30-60 minutes).

---

## H-05 — `unwrap()` on config-controlled branch in `main.rs`

**Root Cause:** Two separate lock acquisitions with an intervening logical check; second acquisition re-asserts the first via `unwrap()` instead of using `?`.

**Required change in `main.rs` around line 1420-1425:**

Replace:

```rust
if should_init {
    let lora_handle = {
        let state_guard = state.read().await;
        let lora_cfg = state_guard.config.lorawan.as_ref().unwrap();
        crate::lora::LoRaHandle::new(lora_cfg, state.clone())
    };
```

With:

```rust
if should_init {
    let lora_cfg_clone = {
        let state_guard = state.read().await;
        // Use ok_or_else + ? instead of unwrap — handle the race where
        // lorawan config disappeared between the should_init check and this lock
        state_guard
            .config
            .lorawan
            .clone()
            .ok_or_else(|| anyhow::anyhow!(
                "LoRaWAN config unavailable after init check — possible config race"
            ))?
    };
    let lora_handle = crate::lora::LoRaHandle::new(&lora_cfg_clone, state.clone());
```

Note: `LoRaWanConfig` must implement `Clone` (add `#[derive(Clone)]` if not present). The state lock is released before the async `init()` call, which is correct async hygiene.

**Effort:** Low (15-30 minutes).

---

## H-06 — Dependency audit: `h2` version tracking and `deny.toml` CI fix

**Root Cause:** Transitive dependency version not audited in CI; `deny.toml` uses user-home advisory-db path that may not be populated in CI.

**Immediate action — verify h2 0.4.13 advisory status:**

Run locally with populated advisory database:
```bash
cargo install cargo-deny
cargo deny --manifest-path sens-api-gateway/Cargo.toml check advisories
```

If no advisories are flagged for h2 0.4.13, document this in `deny.toml`:
```toml
[advisories]
ignore = [
    "RUSTSEC-2025-0134",  # existing: rustls-pemfile unmaintained
    # H2 RUSTSEC-2024-0336: h2 0.4.x < 0.4.7 RST flood. Our h2 0.4.13 is patched.
    # Verified 2026-04-05. Re-verify on each h2 version bump.
]
```

**Fix `deny.toml` CI path:**

```toml
[advisories]
# Use git-fetch mode so CI does not require a pre-populated local advisory-db
db-urls = ["https://github.com/rustsec/advisory-db"]
# Remove db-path or set to a project-relative path:
# db-path = ".cargo/advisory-db"
```

**Add `cargo deny` to CI pipeline** (`ci-full.yml` or equivalent):

```yaml
- name: Security audit (cargo deny)
  run: |
    cargo install cargo-deny --locked
    cargo deny --manifest-path sens-api-gateway/Cargo.toml check
```

**Reduce h2 attack surface (optional but recommended):**

Evaluate whether `reqwest` needs HTTP/2. The provisioning API uses standard REST JSON calls. If HTTP/1.1 is sufficient, add to `Cargo.toml`:

```toml
reqwest = { version = "0.12", features = ["json", "rustls-tls"], default-features = false }
# Note: default-features = false disables http2 (h2) and multipart by default
# Verify by checking reqwest's feature flags: http2 is opt-in in 0.12
```

This eliminates the h2 dependency entirely, removing the attack surface.

**Effort:** Advisory verification: 30 minutes. CI fix: 1 hour. HTTP/1.1 restriction: 30 minutes verification.

---

## Priority Order for Resolution

| Priority | Finding | Blocking Deploy | Estimated Effort |
|----------|---------|-----------------|-----------------|
| 1 | H-03 — Modbus write address whitelist | Yes | 4-6h |
| 2 | H-02 — Command replay (timestamp + retain check) | Yes | 2-3h |
| 3 | H-01 — `verify_hostname` dead field / validate() guard | Yes | 2h |
| 4 | H-04 — FFI nb_pkt bound check | Yes | 1h |
| 5 | H-05 — `unwrap()` in main.rs | Yes | 30m |
| 6 | H-06 — Dependency audit CI + h2 verification | No (verify first) | 2h |

H-03 and H-02 are the highest-impact findings affecting physical actuator safety and cloud command integrity. Both must be resolved before SL2 certification.
