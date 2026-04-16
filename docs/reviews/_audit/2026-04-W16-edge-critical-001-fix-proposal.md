# EDGE-CRITICAL-001 — Fix Proposal (W2 Day 1 Stop-the-Line)

**Status:** Investigation complete 2026-04-16; implementation scheduled W2 Day 1.
**Severity:** CRITICAL — Rust edge gateway does not compile on default features; deploy from HEAD is blocked.
**Investigator:** W1.5C scoping pass during agent+skill+gate initiative.

## What breaks

Two compile errors in `/var/aqua-saas/sens-api-gateway/src/commands.rs`:

### Error 1 — missing struct field (`commands.rs:3334, 3398`)

```rust
match state.failover_manager.as_ref() {   // ← `failover_manager` not declared on AppState
    Some(fm) => { ... }
    None => { ... }
}
```

`AppState` is defined at `main.rs:240-282`. The struct has fields for `mqtt_client`, `modbus_handle`, `gpio_handle`, `i2c_handle`, `process_image`, `alarm_manager`, `script_storage`, feature-gated `lora_handle` / `scada_state` / `scada_db`, plus activation/tenant state — but **no `failover_manager` field**. The reference at commands.rs:3334 and 3398 cannot resolve.

### Error 2 — return-type mismatch (`commands.rs:3336, 3400`)

```rust
match fm.force_failover().await {
    Ok(()) => { ... }              // ← force_failover returns (), not Result<()>
    Err(e) => { ... }
}
```

`FailoverManager::force_failover` at `mqtt_failover.rs:347` is declared `pub async fn force_failover(&self)` — returns `()`. Same for `force_recovery` at line 361. The caller's `Ok(())` / `Err(e)` match arms do not compile.

## Root cause (why it shipped broken)

The commit that wired `force_failover` / `force_recovery` into `commands.rs` was a partial fix closing the prior HIGH-003 "failover is a no-op" finding. The author wrote caller code assuming:

1. `AppState` would grow a `failover_manager` field.
2. `FailoverManager::force_failover` / `force_recovery` would return `Result<(), E>` with runtime failure propagation.

Neither assumption was landed in the same commit. The `None` arm in commands.rs at line 3360 carries a telling error message: *"FailoverManager not initialized. MQTT failover wiring incomplete."* — the author knew the wiring was incomplete and left a breadcrumb. The commit passed review because CI did not run `cargo build` on the `sens-api-gateway` crate (Rust is not in the Nx affected graph — tracked separately).

This is exactly the CLAUDE.md-forbidden pattern **SYS-4 "partial migrations shipped as complete"** that the agent+skill+gate initiative exists to structurally prevent.

## Architectural fix (landed in W2 Day 1)

### Part 1 — Grow `AppState` with the manager handle (`main.rs:240-282`)

```rust
// New field after mqtt_client:
pub failover_manager: Option<Arc<mqtt_failover::FailoverManager>>,
```

Initialize in `AppState::new` (`main.rs:289`) as `None`, same as the other handles.

### Part 2 — Add an explicit initialization method

```rust
impl AppState {
    /// Initialize FailoverManager if MQTT failover is enabled in config.
    /// Called after the MQTT client is constructed at main.rs:1029-1038.
    pub fn init_failover_manager(&mut self) -> anyhow::Result<()> {
        if !self.config.mqtt.failover.enabled {
            // explicitly leave as None; cmd_failover_* path handles this cleanly
            return Ok(());
        }

        let broker = self.config.mqtt.broker.as_ref()
            .ok_or_else(|| anyhow!("MQTT failover enabled but no primary broker configured"))?;

        let (manager, state_rx) = mqtt_failover::FailoverManager::new(
            broker.clone(),
            self.config.mqtt.port,
            self.config.mqtt.failover.clone(),
        );

        // NOTE: state_rx is the watch receiver that the MQTT client should
        // consume for state transitions. Wiring it into the MQTT client
        // reconnect path is a separate change, scheduled after this compile
        // fix. For now, the receiver is dropped with a warning so the
        // manager remains functional for manual cmd_failover_force /
        // cmd_failover_recover calls.
        drop(state_rx);
        warn!("FailoverManager initialized but state-change watcher is not \
               yet wired to MQTT client — manual failover works, automatic \
               broker health-driven transitions do not yet");

        self.failover_manager = Some(Arc::new(manager));
        Ok(())
    }
}
```

Invoke at `main.rs:1038` (immediately after `state_guard.mqtt_client = Some(mqtt_client);`):

```rust
state_guard.mqtt_client = Some(mqtt_client);
state_guard.init_failover_manager()?;  // <-- NEW
```

### Part 3 — Change `force_failover` / `force_recovery` return types

```rust
// mqtt_failover.rs:347
pub async fn force_failover(&self) -> anyhow::Result<()> {
    if !self.is_enabled() {
        bail!("Cannot force failover: backup broker not configured");
    }

    let state = *self.state.read().await;
    if state == FailoverState::PrimaryActive {
        info!("🔧 Manual failover triggered");
        self.transition_to(FailoverState::ConnectingToBackup).await;
        Ok(())
    } else {
        bail!("Cannot force failover: current state is {:?} (expected PrimaryActive)", state)
    }
}
```

Equivalent change for `force_recovery` at line 361. The existing internal test at `mqtt_failover.rs:580` becomes `manager.force_failover().await.unwrap();` (tests may legitimately unwrap).

### Part 4 — CI gating

Add `sens-api-gateway/` to the Nx project graph as an Nx-wrapped target, OR add a dedicated `cargo-build-gateway` CI job to `.github/workflows/ci-affected.yml` triggered by path filter `sens-api-gateway/**`. Without this, the same class of drift recurs next time.

This is the longer-running sub-task. The compile-fix in Parts 1-3 lands as a single commit; the CI gate lands as a second commit (since it touches `.github/workflows/` which requires CODEOWNERS review per BLOCKER-9).

## Verification (W2 Day 1 exit criterion)

1. `cd sens-api-gateway && cargo build` (default features) — exits 0.
2. `cd sens-api-gateway && cargo build --all-features` — exits 0.
3. `cd sens-api-gateway && cargo test` — all tests green.
4. Manual smoke: start the gateway with `mqtt.failover.enabled: false` — `cmd_failover_force` returns "Failover is not enabled" as expected (reproduces current intended behaviour).
5. Manual smoke: start the gateway with `mqtt.failover.enabled: true` + backup broker configured — `cmd_failover_force` transitions state; `get_status_report()` reflects `BackupActive` afterwards.
6. CI: next PR touching `sens-api-gateway/**` triggers the new cargo-build job.

## Not in scope for W2 Day 1 (deferred)

- Wiring `state_rx` receiver into the MQTT client's reconnect path so health-check-driven automatic failover actually transitions the live broker connection. Tracked as new finding `EDGE-HIGH-NEW-001` — manual failover works; automatic does not.
- IEC 62443 failover-drill test harness (dockerized mosquitto primary + backup, kill primary, assert backup active within health-check window). Tracked as `EDGE-MEDIUM-NEW-002`.

## Why this is an architectural fix, not a patch

- **Tier-1 move**: `AppState.failover_manager: Option<Arc<FailoverManager>>` — the field either exists (Some) with a functional manager, or is None with the call-site's `None` arm returning a structured error. No intermediate invalid state is representable.
- **Tier-1 move**: `force_failover` / `force_recovery` returning `Result<(), anyhow::Error>` — failure cases that were previously silent (e.g., "wrong state to trigger") now propagate to the caller with a message. The caller's existing match-on-Result pattern is the intended consumer.
- **Tier-3 move**: CI gate on `sens-api-gateway/**` path ensures this class of drift is caught at commit time, not at integration test time.

No "for now", no "temporary", no fallback to the broken shape. The call sites at commands.rs:3336/3400 drive the implementation shape; the manager + AppState follow.

## References

- `/var/aqua-saas/sens-api-gateway/src/main.rs` (AppState struct, bootstrap sequence)
- `/var/aqua-saas/sens-api-gateway/src/commands.rs` (failover_force + failover_recover command handlers)
- `/var/aqua-saas/sens-api-gateway/src/mqtt_failover.rs` (FailoverManager implementation)
- `/var/aqua-saas/docs/reviews/_audit/2026-04-W16-edge-rust.md` — EDGE-CRITICAL-001 finding source
- `/root/.claude/plans/declarative-riding-shamir.md` BLOCKER-17 — W1.5 stop-the-line entry
- `/var/aqua-saas/docs/adr/003-sensor-service-separation.md` — edge gateway boundary + CI-gating gap
