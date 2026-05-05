//! Phase B-5 — OPC UA live-reload primitive closure invariant.
//!
//! ## Why this file exists
//!
//! Phase B-5 (Plan §B-5 / Batches #276-#277) introduces the
//! `OpcUaLifecycle` primitive that drains the running OPC UA server
//! + atomically swaps in a new one without restarting the agent
//! process. Pre-B-5 every `opc_ua_server.*` config delta requires an
//! agent restart — a user-visible blip.
//!
//! Three architectural wires:
//!
//! - `src/opc_ua_server/lifecycle.rs` — `OpcUaLifecycle` primitive +
//!   `reload(new_config, builder_fn)` API + `ReloadOutcome` /
//!   `ReloadError` taxonomy + drain-before-swap semantics.
//! - `src/opc_ua_server.rs` — `pub mod lifecycle;` declaration.
//! - `docs/adr/032-opc-ua-live-reload-semantics.md` — architectural
//!   decision record.
//!
//! A regression that drops the drain step (skipping
//! `old.shutdown_full().await` BEFORE the swap) would break the
//! audit chain ordering invariant — old server's final entries would
//! land AFTER new server's first entries, OR be lost entirely if the
//! cancel races with the new install. THIS FILE is the Tier-3
//! MAKE-IT-DETECTABLE seam.
//!
//! Pattern mirrors `tests/invariants/opc_ua_subscription_freshness.rs`
//! (Phase B-4) and earlier B-1/B-2/B-3 invariant files.

fn read_source(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "BUG: opc_ua_reload_drains_writes invariant cannot read {path} — \
             this test runs from sens-api-gateway/ working dir per cargo \
             test convention. err={e}"
        )
    })
}

/// **Phase B-5 / Batch #276 (OpcUaLifecycle primitive presence):** the
/// `OpcUaLifecycle` struct + the `reload`, `install`, `current` API
/// MUST exist. A regression that removes the primitive collapses the
/// entire live-reload architecture.
#[test]
fn b5_lifecycle_struct_present() {
    let src = read_source("src/opc_ua_server/lifecycle.rs");
    assert!(
        src.contains("pub struct OpcUaLifecycle"),
        "B-5 / ULTRA-B-5 WIRE INVARIANT VIOLATED: \
         src/opc_ua_server/lifecycle.rs does not define \
         `pub struct OpcUaLifecycle`. The lifecycle primitive is the \
         single architectural channel for live config reload."
    );
    assert!(
        src.contains("pub async fn reload<"),
        "B-5 WIRE INVARIANT VIOLATED: OpcUaLifecycle has no `reload` \
         async method. The drain + swap primitive has no entry point."
    );
    assert!(
        src.contains("pub async fn install("),
        "B-5 WIRE INVARIANT VIOLATED: OpcUaLifecycle has no `install` \
         async method. The boot path has no entry point to populate \
         the initial handle."
    );
    assert!(
        src.contains("pub async fn current("),
        "B-5 WIRE INVARIANT VIOLATED: OpcUaLifecycle has no `current` \
         read-only accessor. Command handlers cannot read the running \
         handle without acquiring + dropping the read-lock manually."
    );
}

/// **Phase B-5 / Batch #276 (drain semantics enforcement):** the
/// `reload` body MUST call `shutdown_full()` (or document equivalent
/// drain semantics) before the atomic swap. A regression that calls
/// `cancel()` only without awaiting the run_task would break the
/// FR6 continuity contract — old server's audit emits could be cut
/// mid-write.
#[test]
fn b5_drain_before_swap_enforced() {
    let src = read_source("src/opc_ua_server/lifecycle.rs");
    assert!(
        src.contains("shutdown_full"),
        "B-5 DRAIN INVARIANT VIOLATED: src/opc_ua_server/lifecycle.rs \
         does not reference `shutdown_full`. The drain primitive that \
         awaits both the OPC UA run-loop AND the SubscriptionBridge \
         shutdown is the load-bearing contract for FR6 continuity. \
         A cancel-only reload would break audit chain ordering."
    );
    assert!(
        src.contains("drain_old_handle"),
        "B-5 DRAIN INVARIANT VIOLATED: lifecycle.rs does not define a \
         `drain_old_handle` helper. The drain logic should be \
         centralized so the cancel + await sequence is uniform across \
         the four reload paths (None/Some × enabled/disabled)."
    );
}

/// **Phase B-5 / Batch #276 (state-machine taxonomy):** the
/// `ReloadOutcome` enum MUST declare all four state-transition
/// outcomes (InitialInstall / NoopAlreadyDisabled / Reloaded /
/// Disabled). A regression that collapses them into a generic Boolean
/// loses the operator-facing distinction the audit chain relies on.
#[test]
fn b5_reload_outcome_variants_present() {
    let src = read_source("src/opc_ua_server/lifecycle.rs");
    for variant in &[
        "InitialInstall",
        "NoopAlreadyDisabled",
        "Reloaded",
        "Disabled",
    ] {
        assert!(
            src.contains(variant),
            "B-5 STATE MACHINE INVARIANT VIOLATED: \
             src/opc_ua_server/lifecycle.rs does not declare \
             `ReloadOutcome::{variant}`. The four-state taxonomy \
             ((old_state, new_enabled) cross product) is the \
             operator-readable transition record."
        );
    }
}

/// **Phase B-5 / Batch #276 (error taxonomy + fail-closed semantics):**
/// `ReloadError::ConfigInvalid` + `BuildFailed` MUST exist + their
/// Display impls MUST state "old handle UNTOUCHED". This is the
/// architectural fail-closed contract — bad config does NOT poison
/// the running state.
#[test]
fn b5_error_taxonomy_states_fail_closed_contract() {
    let src = read_source("src/opc_ua_server/lifecycle.rs");
    assert!(
        src.contains("ConfigInvalid") && src.contains("BuildFailed"),
        "B-5 ERROR TAXONOMY INVARIANT VIOLATED: \
         lifecycle.rs ReloadError lacks ConfigInvalid + BuildFailed \
         variants. These are the fail-closed paths — without them, \
         operators cannot distinguish 'reload rejected' from 'reload \
         applied' in the audit stream."
    );
    assert!(
        src.contains("UNTOUCHED"),
        "B-5 FAIL-CLOSED CONTRACT INVARIANT VIOLATED: lifecycle.rs \
         Display impls do not contain the operator-facing 'UNTOUCHED' \
         guidance. The contract that bad config preserves the running \
         handle is the architectural floor — Display must name it \
         explicitly so operators reading logs know the running state \
         is unchanged."
    );
}

/// **Phase B-5 (lifecycle submodule declaration):** `opc_ua_server.rs`
/// MUST declare `pub mod lifecycle;`.
#[test]
fn b5_lifecycle_submodule_declared() {
    let src = read_source("src/opc_ua_server.rs");
    assert!(
        src.contains("pub mod lifecycle;"),
        "B-5 SUBMODULE WIRE INVARIANT VIOLATED: src/opc_ua_server.rs \
         does not declare `pub mod lifecycle;`. The lifecycle.rs file \
         is orphaned — compile-time absent from the binary."
    );
}

/// **Phase B-5 / ADR-032 anchor:** the architectural decision record
/// MUST exist + cite the plan-intended ID renumbering (ADR-025 was
/// already taken).
#[test]
fn b5_adr_032_present_with_plan_id_cross_reference() {
    let src = read_source("../docs/adr/032-opc-ua-live-reload-semantics.md");
    assert!(
        src.contains("OPC UA Server Live Reload"),
        "B-5 ADR INVARIANT VIOLATED: \
         docs/adr/032-opc-ua-live-reload-semantics.md does not carry \
         the expected title. Plan-doc cross-reference for live-reload \
         semantics resolves to this ADR."
    );
    assert!(
        src.contains("Plan-intended ID:") && src.contains("ADR-025"),
        "B-5 ADR INVARIANT VIOLATED: \
         docs/adr/032-opc-ua-live-reload-semantics.md does not document \
         the plan-intended ID renumbering (plan said ADR-025, actual is \
         ADR-032 because 025 is already taken)."
    );
}

/// **Phase B-5 / Batch #276 (RwLock<Option<Arc<...>>> shape):** the
/// internal lock MUST be `RwLock<Option<Arc<SuderraOpcUaHandle>>>`.
/// A regression that switches to `Mutex<...>` would block readers on
/// every reload + collapse the read-cheap contract. A regression to
/// `Arc<RwLock<...>>` (without the Option) would force callers to
/// distinguish "disabled" from "uninitialized" via a separate flag.
#[test]
fn b5_internal_lock_shape_pinned() {
    let src = read_source("src/opc_ua_server/lifecycle.rs");
    assert!(
        src.contains("RwLock<Option<Arc<SuderraOpcUaHandle>>>"),
        "B-5 LOCK SHAPE INVARIANT VIOLATED: lifecycle.rs internal \
         field type is not `RwLock<Option<Arc<SuderraOpcUaHandle>>>`. \
         The (RwLock + Option + Arc) triple is the architectural \
         shape: read-cheap concurrent access, four-state machine, \
         shared ownership across command handlers + boot path. \
         Switching to Mutex<...> blocks readers on reload; dropping \
         Option collapses the disabled state into a separate flag."
    );
}
