# ADR-032: OPC UA Server Live Reload Semantics — Drain + Atomic Swap

**Status:** Accepted (Phase B-5, 2026-05-05)
**Plan reference:** `docs/plans/2026-04-24-sens-api-gateway-gap-closure-ultra-plan.md` §B-5 (Batches #276-#277)
**Plan-intended ID:** ADR-025 (renumbered to 032 because 025 is already taken by `025-rust-sidecar-architecture.md`. Plan-doc cross-references that read "ADR-025" + that name a Faz B-5 / OPC UA reload concern mean THIS ADR; reading the plan's ADR-025 reference for any other phase resolves to the canonical ADR-025).
**SL-2 FR coverage:** FR3 (System Integrity), FR6 (Timely Response to Events — graceful continuity)
**Sibling ADRs:** ADR-031 (OPC UA PKI Lifecycle), ADR-018 (Edge RBAC/ABAC), ADR-020 (Audit HMAC Chain)

---

## Context

The agent's OPC UA server lifecycle is currently an init-once-and-stay shape:
`init_opc_ua_server` runs at boot, returns an
`Arc<SuderraOpcUaHandle>` stored on AppState, and that handle lives
until process shutdown. Every operator config change that touches
`opc_ua_server.*` requires an agent restart — a user-visible blip:

- Every MQTT session drops + reconnects (drains the offline queue).
- The force-registry state is cleared (operator-held actuator overrides
  release).
- Running ST programs lose their tick state.
- The audit-sink chain restarts at the in-memory level (file recovery
  re-reads but the process-level continuity blinks).

This is the same architectural class as ADR-029 (shared mTLS handshake
pattern) — a one-shot config consumed at boot leaves operators no path
to apply changes without a full agent cycle. Plan §B-5 specifies a
live-reload primitive for the OPC UA subsystem so operators can rotate
bind addr / port / quota caps / phase mode WITHOUT restarting the agent.

---

## Decision

### 1. `OpcUaLifecycle` primitive

A new type at `sens-api-gateway/src/opc_ua_server/lifecycle.rs`:

```rust
pub struct OpcUaLifecycle {
    inner: tokio::sync::RwLock<Option<Arc<SuderraOpcUaHandle>>>,
    last_applied_config: tokio::sync::RwLock<Option<OpcUaServerConfig>>,
}
```

The `RwLock<Option<Arc<Handle>>>` is the architectural shape:
- **Readers** acquire the read-lock + clone the inner Arc + drop the
  read-lock immediately. Per-operation latency is O(1) — Arc clone +
  RwLock read is sub-microsecond. Concurrent OPC UA traffic does NOT
  block on config reload as long as readers don't hold the read-lock
  across awaits.
- **Reload** acquires the write-lock + drains + cancels old + rebuilds
  + swaps. The write-lock ONLY covers the swap operation; the rebuild
  (`build_server` + `ServerBuilder::build()`) runs OUTSIDE the lock so
  pre-validation latency does not block readers. The atomic swap is
  the single state mutation point.

### 2. `OpcUaLifecycle::reload(new_config, builder_fn) -> Result<ReloadOutcome, ReloadError>`

The `builder_fn: impl AsyncFnOnce(&OpcUaServerConfig) -> Result<Arc<SuderraOpcUaHandle>, BuildErr>`
parameter decouples the lifecycle primitive from `init_opc_ua_server`'s
internal dependency graph (audit_sink, tenant, force_registry, etc.).
Callers thread the AppState dependencies into the closure; the
lifecycle primitive owns ONLY the swap discipline.

**Phases of reload:**

1. **Pre-validate** the new config via `OpcUaServerConfig::validate()`.
   On Err → `ReloadError::ConfigInvalid`. Old handle UNTOUCHED.
2. **Read the current handle** via the read-lock (cloned Arc).
   The lock is dropped immediately; the clone keeps the handle alive
   even if a concurrent reload races.
3. **Build the new handle** via `builder_fn(&new_config)`. Runs
   OUTSIDE any lock. On Err → `ReloadError::BuildFailed`. Old handle
   UNTOUCHED.
4. **Drain the old handle** — call `old.cancel()` to signal graceful
   shutdown. The old server's run-loop drains active sessions + flushes
   audit-sink writes; the SubscriptionBridge drains its broadcast
   buffer. We await this drain via `old.shutdown_full().await` BEFORE
   the swap so the audit chain ordering is preserved (the old server's
   final entries land before the new server starts).
5. **Acquire the write-lock + swap** — replace `inner` with
   `Some(new_handle)` + record `last_applied_config = Some(new_config)`.
   The swap is a single pointer mutation under the write-lock.
6. **Return** `ReloadOutcome::Reloaded` (or `Disabled` if the new
   config has `enabled=false`).

### 3. `OpcUaLifecycle::disable() -> Result<(), ReloadError>`

Atomic transition to `enabled=false` — drains the old + swaps None
without rebuilding. Used by SIGHUP-triggered reloads where the new
config sets `opc_ua_server.enabled=false` (operator off-switch),
avoiding the unnecessary `builder_fn` call.

### 4. Lifecycle states + transition table

| Current | New config | Action |
|---------|-----------|--------|
| `None` | enabled=true | Build + insert (boot path) |
| `None` | enabled=false | Noop (already disabled) |
| `Some(h)` | enabled=true | Drain + rebuild + swap |
| `Some(h)` | enabled=false | Drain + swap None |

The state machine is explicit; the `RwLock<Option<...>>` shape encodes
the four states cleanly.

### 5. Cancel-drain semantics (FR6 continuity)

`old.shutdown_full()` is the load-bearing drain primitive (Phase B-4
delivered the `shutdown_full` method on SuderraOpcUaHandle). It:

1. Calls `ServerHandle::cancel()` — async-opcua's run-loop exits.
2. Awaits `SubscriptionBridge::shutdown()` — bridge task exits, final
   audit emits flush.
3. Awaits `run_task: JoinHandle<()>` — the server task fully completes.

The drain takes UP TO the in-flight write timeout + audit fsync
latency (typically < 100ms on a healthy edge). Operators triggering
reload via `cmd_reload_config` see a brief reload window but no lost
audit entries.

### 6. `cmd_reload_config` MQTT command (Phase B-5.5)

**OUT OF SCOPE for Phase B-5 commit.** Phase B-5.5 wires the operator
surface — an MQTT command that:

- Verifies the envelope signature + RBAC permission (`Permission::ReloadConfig`).
- Re-parses the agent's full `AgentConfig` (D-5 integrity verify per
  ADR-019).
- Diffs the OPC UA section against the running config.
- If a delta is detected → `OpcUaLifecycle::reload(new_section, ...)`.
- Audit emit on success/failure (ConfigReloadApplied / ConfigReloadRejected).

Phase B-5 ships the primitive; Phase B-5.5 ships the operator surface
so the integration with AppState's audit/RBAC/envelope-adapter chain
is explicit and testable.

### 7. SIGHUP handler (Phase B-5.5)

`main.rs` adds a `SignalKind::hangup()` listener that re-reads the
config file from disk + drives the same reload path as
`cmd_reload_config`. Out-of-scope for B-5 commit; named here so the
plan's complete shape is recorded.

---

## Consequences

### Positive

- **Operator-visible reload without agent restart.** Bind addr / port
  / quota caps / phase mode rotate live; MQTT sessions + force-registry
  + ST runtime + audit chain process-state continuity preserved.
- **Atomic swap under write-lock.** No torn observation possible —
  callers see either the old handle or the new handle, never a partial
  state.
- **Drain-before-swap preserves audit chain ordering.** Old server's
  final entries land BEFORE new server's first entries.
- **Pre-validate fail-closed.** A malformed new config cannot poison
  the running state; the old handle stays installed.

### Negative

- **Reload latency includes the drain + rebuild.** Operators triggering
  reload see UP TO ~100ms-1s pause before the new server accepts
  sessions. HMI clients may briefly lose sessions during the rebuild;
  rumqttc-style reconnect logic on the HMI side absorbs this.
- **The `builder_fn` closure must thread every AppState dependency.**
  Callers pass `audit_sink`, `tenant`, `force_registry`, etc. through
  to the inner `init_opc_ua_server` call. This is verbose at the
  command-handler layer; the architectural seam keeps the lifecycle
  primitive testable in isolation.
- **Phase B-5 commit ships the primitive only.** The operator-facing
  `cmd_reload_config` + SIGHUP handler are Phase B-5.5 follow-on. Until
  B-5.5 lands, the primitive is unreachable from operator code paths;
  this is documented as ORPHAN-MEDIUM-054.

### Trade-offs considered + rejected

- **Rejected: full agent restart per config change.** Pre-B-5 baseline.
  User-visible blip + audit chain rebuild + force-registry clear is
  exactly what B-5 fixes.
- **Rejected: hot-swap without drain.** Skipping the drain step means
  in-flight writes may be dropped + audit chain may have torn entries.
  Plan §B-5 invariant `opc_ua_reload_drains_writes.rs` pins this
  contract.
- **Rejected: per-field reload (port-only, mode-only, etc.).** Adds
  combinatorial complexity for marginal benefit. The blanket "rebuild
  the server" path is simpler + always correct; the cost of a full
  rebuild is dominated by the drain (which is necessary regardless).

---

## Implementation map (Phase B-5 Batch #276-#277)

| Batch | File | Purpose |
|-------|------|---------|
| #276a | `src/opc_ua_server/lifecycle.rs` | `OpcUaLifecycle` primitive + `reload` + `disable` + state machine tests |
| #276b | `src/opc_ua_server/lifecycle.rs::tests` | reload enabled→disabled, config-error preserves old, drain ordering |
| #277a | `src/opc_ua_server.rs` | `pub mod lifecycle;` declaration |
| #277b | `tests/invariants/opc_ua_reload_drains_writes.rs` | source-grep wire invariant |

## Phase B-5.5 follow-on (NOT in this batch)

| Batch | File | Purpose |
|-------|------|---------|
| #277c | `src/commands/reload_config.rs` | `cmd_reload_config` handler (envelope + RBAC + D-5 integrity verify + drive lifecycle) |
| #277d | `src/main.rs` | `SignalKind::hangup()` listener wiring |
| #277e | `tests/e2e/opc_ua_live_reload.rs` | port change via SIGHUP + malformed config via cmd_reload |

Tracked as ORPHAN-MEDIUM-054.

---

## References

- Plan: `docs/plans/2026-04-24-sens-api-gateway-gap-closure-ultra-plan.md` §B-5 + Batches #276-#277
- ADR-029 (shared mTLS handshake pattern — same one-shot-at-boot anti-pattern resolved by hot-reload)
- ADR-031 (OPC UA PKI Lifecycle — sibling architecture for the same OPC UA subsystem)
- async-opcua 0.18 docs: `ServerHandle::cancel`, `JoinHandle` await semantics
