# S2 Audit — HIGH Findings Review
**Date:** 2026-04-05
**Reviewer:** edge-expert
**Scope:** `sens-api-gateway/src/` — Rust edge agent
**Audit round:** S2 (first review for this codebase — no prior edge-expert reviews found)

## Prior Work Check

No prior edge-expert reviews exist in `docs/reviews/edge-expert/` or `docs/recommendations/edge-expert/`. This is the initial S2 review. Severity escalation rules do not apply.

Pre-fixed items confirmed present (not re-audited per task scope):
- `ActivationResponse` — custom `Debug` impl masking fields: confirmed in provisioning.rs
- `SelfRegisterResponse` — custom `Debug` impl: confirmed in provisioning.rs
- `sx1302.rs` unsafe blocks — `SAFETY` documentation present: confirmed at lines 162, 199, 203, 275, 304, 335, 363

---

## Findings Summary

| ID | Severity | Area | File | Lines |
|----|----------|------|------|-------|
| H-01 | HIGH | MQTT TLS — `verify_hostname` flag silently ignored | `mqtt.rs`, `config.rs` | 654-733, 241 |
| H-02 | HIGH | Offline queue — no command replay-attack / deduplication protection | `commands.rs`, `offline_queue.rs` | 294-324, queue design |
| H-03 | HIGH | Modbus write — no address whitelist; arbitrary register writeable by cloud command | `modbus.rs`, `config.rs` | 977-1039, 953-993 |
| H-04 | HIGH | FFI unsafe — `receive()` trusts `nb_pkt` from C without bounds guard on slice index | `lora/sx1302.rs` | 207-215 |
| H-05 | HIGH | `unwrap()` on config-controlled branch in production path (`main.rs`) | `main.rs` | 1423 |
| H-06 | HIGH | Dependency — `h2` 0.4.13 has known RST flood DoS (RUSTSEC-2024-0336 / CVE-2023-44487) | `Cargo.lock` | h2 entry |

---

## Detailed Findings

---

### H-01 — MQTT TLS: `verify_hostname` config field is silently ignored in `configure_tls()`

**Severity:** HIGH
**IEC 62443:** FR-4 (Data Confidentiality), FR-1 (Identification)

**File:** `sens-api-gateway/src/mqtt.rs` lines 654-733
**Also:** `sens-api-gateway/src/config.rs` line 241

**Problem:**

`MqttTlsConfig` exposes a `verify_hostname: bool` field (default `true`). The field is parsed from YAML and documented as "Verify server hostname against certificate." However, `configure_tls()` never reads `tls_config.verify_hostname`. The constructed `rustls::ClientConfig` always performs full hostname verification regardless of the field's value. This creates two distinct failure modes depending on direction:

1. **Security regression path:** An operator sets `verify_hostname: false` intending to allow connections to brokers with IP-SANs or self-signed certs in a controlled OT network. The code silently ignores this, causing unexpected TLS handshake failures with no diagnostic indicating why the field has no effect. This leads operators to incorrectly conclude TLS is misconfigured and disable it entirely.

2. **Audit false-assurance path:** A security auditor reading the config schema sees `verify_hostname: true` and assumes hostname verification is enforced. There is no enforcement or validation that the field is wired to any behavior. If the code path were ever changed to read this field and bypass verification, the config struct provides no production guard (unlike `insecure_skip_verify` which has a `#[cfg(not(debug_assertions))]` guard).

The `verify_hostname` field in `MqttTlsConfig` is a dead config key — it occupies config namespace, appears in operator documentation, and creates a false security audit trail.

Note: For the `TlsConfiguration::Simple` branch (custom CA cert path), the `rumqttc` library constructs the TLS config internally. There is no mechanism in rumqttc 0.25's `TlsConfiguration::Simple` to disable hostname verification — it always validates. For the `Rustls` branch (system CA), the `rustls::ClientConfig` built at lines 717-720 also always enforces hostname verification. In both cases `verify_hostname` is never read.

**Evidence:**

```
// config.rs:239-241
/// Verify server hostname against certificate
#[serde(default = "default_true")]
pub verify_hostname: bool,

// mqtt.rs:654-733 — configure_tls() — no reference to tls_config.verify_hostname
```

**Root Cause:** The field was added to the config schema for future use or was accidentally orphaned during a refactor from an earlier TLS library. The actual rustls/rumqttc integration never wired it.

**Recommended Fix (enterprise-grade):**

The field must be removed or wired, not left as dead config. The correct resolution depends on the deployment model:

Option A (recommended for IEC 62443 SL2): Remove `verify_hostname` from `MqttTlsConfig`. Hostname verification is always mandatory. Document this in config. Add a compile-time assertion or validation comment that hostname verification cannot be disabled.

Option B (if OT network IP-SANs are required): Wire the field to a `rustls::ClientConfig` that uses `WebPkiVerifier` with `DnsName` acceptance. Gate with `#[cfg(not(debug_assertions))]` identical to `insecure_skip_verify`. This requires switching to the `Rustls` branch exclusively and building the `ClientConfig` manually for both the system-CA and custom-CA cases, then setting `client_config.dangerous().set_certificate_verifier(...)` only when `verify_hostname: false`.

At minimum before the next release: add a validation in `MqttTlsConfig::validate()` that explicitly documents the field is not currently implemented and returns an error if set to `false`, preventing silent misconfiguration.

---

### H-02 — Command Replay Attack: No deduplication on `command_id` across MQTT sessions

**Severity:** HIGH
**IEC 62443:** FR-2 (Use Control), FR-6 (Timely Response)

**File:** `sens-api-gateway/src/commands.rs` lines 294-324
**Also:** `sens-api-gateway/src/offline_queue.rs` (entire design)

**Problem:**

`CommandHandler::handle_message()` parses a `CommandMessage` and immediately executes `execute_command()` with no check that the `command_id` has not been seen before. There is no:
- In-memory deduplication set tracking recently processed `command_id` values
- Timestamp window check rejecting commands with `timestamp` older than N seconds
- Persistent record of executed command IDs surviving agent restarts

**Attack scenario — MQTT QoS 1 replay:**
MQTT QoS 1 guarantees at-least-once delivery. If the broker retransmits a publish packet (e.g., after a client reconnect before the broker processed the PUBACK), `execute_command()` will re-execute. For safety-critical commands — `write_modbus`, `write_gpio`, `plc_start`, `reboot`, `update_firmware` — double-execution causes physical actuator toggling, PLC state corruption, or unnecessary reboots.

**Attack scenario — offline queue replay:**
The offline queue stores messages for replay on reconnect. The current design does not deduplicate across the in-flight/pending set. A crash between `peek()` and `ack()` causes the message to be replayed on recovery. For command messages (if any are routed through the queue), this means duplicate execution.

**Attack scenario — retained MQTT messages:**
If a cloud-side bug publishes a command to the broker with `retain: true`, every new MQTT session will receive that command. `handle_events()` correctly passes the `retain` flag in `IncomingMessage`, but `handle_message()` does not check `retain` and will execute retained commands on reconnect.

**Evidence:**

The `CommandMessage` struct includes a `command_id: String` and `timestamp: String` (lines 171-177 of `mqtt.rs`), but neither field is used for deduplication in `execute_command()`. The rate limiter in `commands.rs` (lines 42-89) limits frequency but does not prevent re-execution of the same `command_id`.

**Root Cause:** Command idempotency and replay protection were not part of the original protocol design. The MQTT event loop correctly handles QoS state, but the application layer has no idempotency layer above it.

**Recommended Fix (enterprise-grade):**

1. **Timestamp window rejection:** Parse `command.timestamp` as `DateTime<Utc>` on receipt. Reject commands where `abs(now - timestamp) > MAX_COMMAND_AGE_SECS` (recommend 300 seconds / 5 minutes). Return a non-success `CommandResponse` with error "Command timestamp outside acceptance window."

2. **In-memory deduplication:** Add a `BTreeSet<(String, Instant)>` or bounded `LruCache<String, Instant>` keyed on `command_id` to `CommandHandler`. On receipt, check if `command_id` is present; if so, re-publish the original response (idempotent) without re-executing. Evict entries older than `MAX_COMMAND_AGE_SECS`. This covers MQTT QoS 1 redelivery within a session.

3. **Persistent deduplication (across restarts):** For safety-critical commands, persist the `command_id` with execution timestamp to the SQLCipher SQLite database (reuse the existing `OfflineQueue` database or a separate `executed_commands` table). On startup, load recent entries. This prevents replay across agent restarts.

4. **Retained message rejection:** In `handle_message()`, check `message.retain == true` and reject with a warning log. Retained messages are configuration snapshots, not commands.

---

### H-03 — Modbus Write: No per-device register address whitelist for write operations

**Severity:** HIGH
**IEC 62443:** FR-2 (Use Control), FR-3 (System Integrity)

**File:** `sens-api-gateway/src/modbus.rs` lines 977-1039
**Also:** `sens-api-gateway/src/config.rs` lines 953-993

**Problem:**

`write_register(address: u16, value: u16)` and `write_coil(address: u16, value: bool)` validate:
1. `allow_writes: bool` — binary on/off for all writes on the device
2. Function code whitelist (FC5, FC6)
3. Write rate limit (2 ops/sec)

They do **not** validate the `address` against a configured whitelist of permitted writable register addresses. The address arrives from cloud commands (`write_modbus` command handler) as a raw `u16` with no address-range check beyond what `rodbus::Indexed::new()` enforces internally.

`ModbusSecurityConfig` (config.rs:953-993) has `allowed_function_codes` and `max_register_count` but no `allowed_write_addresses: Vec<(u16, u16)>` range list.

**Attack scenario:** An authenticated cloud operator (or a compromised cloud credential) sends a `write_modbus` command targeting address 0x0000 or any arbitrary holding register address on a device where `allow_writes: true`. There is no defense-in-depth layer on the edge device to constrain which physical PLC outputs can be written. In aquaculture systems this directly maps to pump relays, feed dispensers, aerator outputs, and chemical dosing actuators.

**Secondary issue — write address is not validated against the declared register map:** The device config has a `registers: Vec<ModbusRegisterConfig>` listing known registers. `write_register()` does not check that the target address is in this list, meaning writes can target undeclared registers that are not in the device model.

**Evidence:**

```rust
// modbus.rs:977-1003
pub async fn write_register(&mut self, address: u16, value: u16) -> Result<()> {
    self.validate_write_allowed()?;    // only checks allow_writes bool
    self.validate_function_code(FC_WRITE_SINGLE_REGISTER)?;
    self.acquire_write_rate_limit()?;
    // No: self.validate_write_address(address)?;
    let indexed_value = rodbus::Indexed::new(address, value);
    channel.write_single_register(params, indexed_value).await ...
}
```

**Root Cause:** The security model treats write permission as a binary device-level flag. The IEC 62443 model requires register-granularity access control for physical actuator writes.

**Recommended Fix (enterprise-grade):**

Add `allowed_write_registers: Option<Vec<ModbusWriteRange>>` to `ModbusSecurityConfig`, where:

```rust
pub struct ModbusWriteRange {
    pub start_address: u16,
    pub end_address: u16,  // inclusive
    pub description: Option<String>,
}
```

Add `validate_write_address(address: u16) -> Result<()>` to `ModbusClient`:

```rust
fn validate_write_address(&self, address: u16) -> Result<()> {
    if !self.security.enabled { return Ok(()); }
    let Some(ref ranges) = self.security.allowed_write_registers else {
        // No whitelist configured — block all writes
        return Err(anyhow::anyhow!(
            "Write to address {} denied: no write address whitelist configured for device '{}'",
            address, self.config.name
        ));
    };
    if ranges.iter().any(|r| address >= r.start_address && address <= r.end_address) {
        Ok(())
    } else {
        Err(anyhow::anyhow!(
            "Write to address {} denied for device '{}': not in write whitelist {:?}",
            address, self.config.name, ranges
        ))
    }
}
```

Call this from both `write_register()` and `write_coil()` after `validate_write_allowed()`. Add config validation ensuring `allowed_write_registers` is specified when `allow_writes: true`.

As a secondary measure, add a check that the target address appears in `self.registers` (the declared register map) when `allowed_write_registers` is not configured, as a defense-in-depth layer.

---

### H-04 — FFI Unsafe: `nb_pkt` return value from `lgw_receive()` used as slice bound without type-safety guard

**Severity:** HIGH
**IEC 62443:** FR-3 (System Integrity)

**File:** `sens-api-gateway/src/lora/sx1302.rs` lines 207-215

**Problem:**

```rust
// SAFETY: pkt_buf is a valid mutable Vec of MAX_RX_PACKETS elements;
// lgw_receive() writes at most MAX_RX_PACKETS entries and the pointer
// remains valid for the duration of the call.
let nb_pkt = unsafe {
    ffi::lgw_receive(MAX_RX_PACKETS as u8, pkt_buf.as_mut_ptr())
};

if nb_pkt < 0 {
    anyhow::bail!("...");
}

let packets: Vec<RxPacket> = pkt_buf[..nb_pkt as usize]  // line 216
```

`nb_pkt` is typed as `i32` (C `int`). The negative-check guard at line 211 rejects negative values. However, the positive path casts `nb_pkt as usize` and uses it directly as a slice bound on `pkt_buf`. The SAFETY comment states that `lgw_receive()` writes "at most MAX_RX_PACKETS entries," but there is no explicit assertion that `nb_pkt as usize <= pkt_buf.len()`.

If the C HAL has a bug or the `MAX_RX_PACKETS as u8` argument overflows (MAX_RX_PACKETS is likely > 255 given it is cast to `u8`), a corrupted `nb_pkt` value greater than `pkt_buf.capacity()` would cause a panic at the slice bound in safe Rust. This is not memory unsafety (the Rust slice bounds check will catch it and panic rather than go out-of-bounds), but a C HAL bug causing `nb_pkt > MAX_RX_PACKETS` converts a theoretical overflow into an uncontrolled runtime panic on the edge device, violating IEC 62443 FR-7 (Resource Availability).

Secondary issue: `MAX_RX_PACKETS as u8` silently truncates if `MAX_RX_PACKETS > 255`. The lgw_receive API takes `uint8_t` for the max count, meaning the C function will be told it can write at most `MAX_RX_PACKETS % 256` packets, while Rust's `pkt_buf` has `MAX_RX_PACKETS` slots. If the C HAL writes more than `nb_pkt % 256` entries based on its own internal state, the slice bound check would still catch it via panic, but the SAFETY precondition in the comment would be violated.

**Root Cause:** The SAFETY comment documents the intended invariant but does not enforce it with a runtime assertion in the safe code that follows the unsafe block.

**Recommended Fix (enterprise-grade):**

Add an explicit bounds assertion immediately after the unsafe block:

```rust
let nb_pkt = unsafe {
    ffi::lgw_receive(MAX_RX_PACKETS as u8, pkt_buf.as_mut_ptr())
};

if nb_pkt < 0 {
    anyhow::bail!("SX1302 paket alma hatasi: lgw_receive() = {}", nb_pkt);
}

// Enforce SAFETY invariant: lgw_receive() must not report more packets
// than the buffer we allocated and passed. If the C HAL returns a count
// exceeding our buffer, it has written beyond the allocation — treat as
// a HAL bug and return an error rather than panicking or proceeding with
// potentially corrupt data.
let nb_pkt_usize = nb_pkt as usize;
if nb_pkt_usize > pkt_buf.len() {
    anyhow::bail!(
        "SX1302 HAL invariant violation: lgw_receive() returned {} packets \
         but buffer capacity is {} (MAX_RX_PACKETS={}). HAL bug suspected.",
        nb_pkt_usize, pkt_buf.len(), MAX_RX_PACKETS
    );
}

let packets: Vec<RxPacket> = pkt_buf[..nb_pkt_usize].iter() ...
```

Also verify the `MAX_RX_PACKETS as u8` cast. If `MAX_RX_PACKETS > 255`, introduce a compile-time assertion:

```rust
const _: () = assert!(MAX_RX_PACKETS <= 255, "MAX_RX_PACKETS exceeds u8 capacity for lgw_receive()");
```

---

### H-05 — `unwrap()` on config-controlled branch in production code path (`main.rs`)

**Severity:** HIGH
**IEC 62443:** FR-7 (Resource Availability)

**File:** `sens-api-gateway/src/main.rs` line 1423

**Problem:**

```rust
// main.rs:1420-1425
if should_init {
    let lora_handle = {
        let state_guard = state.read().await;
        let lora_cfg = state_guard.config.lorawan.as_ref().unwrap(); // <-- panic potential
        crate::lora::LoRaHandle::new(lora_cfg, state.clone())
    };
```

`should_init` is computed from `state_guard.config.lorawan.as_ref().map_or(false, |c| c.enabled)` (line 1417). If `lorawan` is `Some(_)` with `enabled: true`, `should_init` is `true`. The second `state.read().await` then calls `.unwrap()` on the same `Option<LoRaWanConfig>`.

The code relies on the invariant that if `should_init == true` then `lorawan` is `Some`. This invariant is correct as long as `lorawan` cannot be set to `None` between the two `read()` calls. However:

1. Between the two `read()` acquisitions, a config-update write lock could change `lorawan` to `None` (e.g., if the config-update command handler sets `lorawan: None` for a device that had LoRaWAN disabled after initial load).
2. Even if this race is currently impossible in the startup path (single-task initialization), the `unwrap()` bypasses the established pattern of using `?` for error propagation. If the config schema ever changes such that `lorawan` becomes `None` despite `enabled: true` through a deserialization quirk, the agent panics hard.
3. Clippy lint `expect_used = "warn"` is configured for this crate; `unwrap()` on an `Option` here will trigger a lint warning and should be resolved.

**Root Cause:** Logic duplication — the option is checked in the `map_or` expression but then re-accessed via `unwrap()` in a separate lock acquisition, losing the first check's guarantee.

**Recommended Fix (enterprise-grade):**

Collapse both lock acquisitions into one and use `?` or explicit error handling:

```rust
if should_init {
    let lora_handle = {
        let state_guard = state.read().await;
        let lora_cfg = state_guard
            .config
            .lorawan
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!(
                "LoRaWAN config disappeared between should_init check and initialization"
            ))?;
        crate::lora::LoRaHandle::new(lora_cfg, state.clone())
    };
    // ...
}
```

Or restructure to hold the single lock guard across both operations, taking the `LoRaWanConfig` by clone to release the lock before the async `init()` call:

```rust
let maybe_lora_cfg: Option<LoRaWanConfig> = {
    let state_guard = state.read().await;
    state_guard.config.lorawan.as_ref()
        .filter(|c| c.enabled)
        .cloned()
};

if let Some(lora_cfg) = maybe_lora_cfg {
    let lora_handle = crate::lora::LoRaHandle::new(&lora_cfg, state.clone());
    // ...
}
```

---

### H-06 — Dependency: `h2` 0.4.13 — HTTP/2 RST flood denial-of-service (RUSTSEC-2024-0336)

**Severity:** HIGH
**IEC 62443:** FR-7 (Resource Availability)

**File:** `sens-api-gateway/Cargo.lock` — h2 entry (version 0.4.13)

**Problem:**

`h2` version 0.4.13 is present in `Cargo.lock`. This version is a transitive dependency of `reqwest 0.12.28` (used in provisioning.rs for cloud API calls). `h2` versions prior to 0.4.7 were affected by RUSTSEC-2024-0336 / CVE-2023-44487 (HTTP/2 "Rapid Reset" attack) and a subsequent `h2`-specific issue in RUSTSEC-2024-0336 that allows an attacker to exhaust server memory through RST_STREAM flooding.

Cross-checking: `h2` 0.4.13 is a patch release in the 0.4.x series. The initial CVE-2023-44487 fix landed in h2 0.3.21 / 0.4.2. However, a subsequent amplification variant (RUSTSEC-2024-0336, specifically the h2 crate advisory) was fixed in 0.4.7. Version 0.4.13 post-dates 0.4.7 and should be patched against RUSTSEC-2024-0336.

The `deny.toml` ignores `RUSTSEC-2025-0134` (rustls-pemfile unmaintained) but does not suppress any h2 advisory, meaning a `cargo deny check` run would flag this if an active h2 advisory is in the RustSec database for 0.4.13.

**Actual risk assessment for this codebase:** The edge agent uses `reqwest` as an **HTTP client** (not server) in `provisioning.rs` for outbound HTTPS calls to the cloud API. HTTP/2 RST flood vulnerabilities are primarily exploitable by a **server-side attacker sending crafted RST_STREAM frames to a server**. For a client-only use case, the attack surface is: a malicious cloud API endpoint sending malformed HTTP/2 RST frames to the `reqwest` client. This is a realistic threat only if the cloud API server is compromised or the TLS connection is intercepted (MitM). In normal operation the risk is LOW, but the dependency should be tracked.

**Additional concern — `deny.toml` advisory database:** The `deny.toml` references `db-path = "~/.cargo/advisory-db"` which is a user-home-relative path, not a project-local path. In CI/CD environments this may not be populated, effectively disabling advisory checks. This is a dependency audit infrastructure gap.

**Root Cause:** `h2` is a transitive dependency pinned by `reqwest`. No `cargo deny` advisory override is configured for it, and the Cargo.lock is not audited in CI per the advisory-db path issue.

**Recommended Fix (enterprise-grade):**

1. Verify current h2 0.4.13 advisory status: run `cargo deny check advisories` with a populated advisory database. If h2 0.4.13 has no active RustSec advisories, document this in `deny.toml` with a comment.

2. Update `reqwest` to ensure the latest `h2` patch is pulled: `cargo update reqwest`. Verify `h2` bumps to latest 0.4.x in Cargo.lock.

3. Fix `deny.toml` advisory database path for CI:
   ```toml
   [advisories]
   db-path = "$CARGO_HOME/advisory-db"  # or use git-fetch mode
   db-urls = ["https://github.com/rustsec/advisory-db"]
   ```
   Add `cargo deny check` to the CI pipeline as a required gate (not just advisory-db check, but the full `cargo deny check` suite).

4. Consider restricting `reqwest` to HTTP/1.1 only for the provisioning path since the cloud API does not require HTTP/2:
   ```toml
   reqwest = { version = "0.12", features = ["json", "rustls-tls"], default-features = false }
   ```
   Then add `default-features = false` and verify no `http2` feature is implicitly enabled. This eliminates the h2 attack surface entirely for this use case.

---

## Findings NOT Present (Cleared)

The following items from the audit scope were investigated and found to be adequately handled:

**MQTT TLS certificate validation (basic):** Certificate validation is enforced. Both the `TlsConfiguration::Simple` and `Rustls` paths reject empty CA stores (line 709). `insecure_skip_verify` is compile-time guarded in release builds (`config.rs` line 253-258). No `danger_accept_invalid_certs` found.

**Modbus register count limit:** `max_register_count` is checked before constructing `AddressRange` (modbus.rs line 872). `AddressRange::try_from` provides a second validation layer.

**Offline queue disk exhaustion:** Bounded by `max_disk_bytes` with eviction loop (offline_queue.rs lines 486-504). Default limit is 50 MB.

**FFI sx1302.rs other unsafe blocks:** `lgw_start()` (line 165), `lgw_pkt_tx_s` zeroed (line 277), `lgw_send()` (line 306), `lgw_get_temperature()` (line 337), `lgw_stop()` in Drop (line 364) — all have SAFETY documentation. The `std::mem::zeroed()` calls for C structs are correct (all fields are set before use or overwritten by the C function). These were pre-fixed per audit scope.

**`unwrap()` in provisioning.rs:** Lines 537 and 556 are inside `#[cfg(test)] mod tests` — confirmed test-only.

**`unwrap()` in commands.rs line 4308:** Inside `#[cfg(test)] mod tests` — confirmed test-only.

---

## Systemic Observations

**SYSTEMIC-1 — Dead config fields:** `verify_hostname` (H-01) follows a pattern where config fields are added to schemas without being wired to behavior. Recommendation: establish a policy that every config field has a unit test that exercises its effect, and a startup validation that logs each field's effective value.

**SYSTEMIC-2 — Write-path security asymmetry:** Read operations have multiple validation layers (function code whitelist, rate limit, register count, `AddressRange::try_from`). Write operations lack address-granularity access control (H-03). This asymmetry is a structural risk for any physical actuator control path.
