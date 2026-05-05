//! Phase B-4 — OPC UA push-subscription bridge closure invariant.
//!
//! ## Why this file exists
//!
//! Phase B-4 (Plan §B-4 / Batches #273-#275) closes the HMI-staleness
//! gap on the subscription path by introducing a bridge that consumes
//! `ProcessImage::subscribe_changes` broadcast + dispatches each change
//! to a `NodeChangeNotifier`. Pre-B-4 the only path from a tag commit
//! to OPC UA was the configured polling interval (default 100ms),
//! burning ~40% of the SL-2 FR4 500ms p99 propagation budget on a
//! single hop.
//!
//! Three wires are tightly coupled:
//!
//! - `src/opc_ua_server/subscription_bridge.rs` — `SubscriptionBridge` +
//!   `NodeChangeNotifier` trait + `LoggingNotifier` default impl.
//! - `src/opc_ua_server.rs` — `pub mod subscription_bridge;` declaration.
//! - `src/opc_ua_server_runtime.rs` — production boot path spawns the
//!   bridge after the ServerHandle is built + stores it on
//!   SuderraOpcUaHandle so its lifetime matches the OPC UA server's.
//!
//! A regression that drops the bridge spawn would silently regress
//! HMI freshness — the broadcast::Receiver would have no consumer,
//! the producer would accumulate Lagged errors, and HMI subscriptions
//! would still see polling-bound latency. THIS FILE is the Tier-3
//! MAKE-IT-DETECTABLE seam.
//!
//! Pattern mirrors `tests/invariants/opc_ua_session_quota.rs` (Phase B-3),
//! `tests/invariants/opc_ua_auth_throttle_enforced.rs` (Phase B-2),
//! `tests/invariants/opc_ua_leaf_pin_enforced.rs` (Phase B-1).

fn read_source(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "BUG: opc_ua_subscription_freshness invariant cannot read {path} — \
             this test runs from sens-api-gateway/ working dir per cargo \
             test convention. err={e}"
        )
    })
}

/// **Phase B-4 / Batch #273 (SubscriptionBridge primitive presence):**
/// the `SubscriptionBridge` struct + `spawn` constructor MUST exist.
/// A regression that removes the primitive collapses every downstream
/// wire — the broadcast::Receiver has no consumer, the producer
/// accumulates Lagged errors at high tag-change rates.
#[test]
fn b4_subscription_bridge_struct_present() {
    let src = read_source("src/opc_ua_server/subscription_bridge.rs");
    assert!(
        src.contains("pub struct SubscriptionBridge"),
        "B-4 / ULTRA-B-4 WIRE INVARIANT VIOLATED: \
         src/opc_ua_server/subscription_bridge.rs does not define \
         `pub struct SubscriptionBridge`. The bridge primitive is the \
         single architectural channel from ProcessImage TagChange \
         broadcast → OPC UA notification surface."
    );
    assert!(
        src.contains("pub fn spawn("),
        "B-4 WIRE INVARIANT VIOLATED: SubscriptionBridge has no `spawn` \
         constructor — production boot has no entry point to start the \
         bridge task."
    );
    assert!(
        src.contains("pub async fn shutdown("),
        "B-4 WIRE INVARIANT VIOLATED: SubscriptionBridge has no async \
         `shutdown` — graceful shutdown cannot await the bridge task's \
         clean exit. Production code MUST await this before
         `process::exit` for FR6 continuity."
    );
}

/// **Phase B-4 / Batch #273 (NodeChangeNotifier trait + impls):** the
/// trait MUST exist + at least the LoggingNotifier impl MUST be present.
/// The trait abstraction is the architectural seam between the bridge +
/// async-opcua's subscription state. A regression that hardcodes the
/// notifier (e.g., direct call to async-opcua) would lose the test
/// surface + the swap-in path for Phase B-4.5 production-grade
/// notifier.
#[test]
fn b4_node_change_notifier_trait_and_default_impl_present() {
    let src = read_source("src/opc_ua_server/subscription_bridge.rs");
    assert!(
        src.contains("pub trait NodeChangeNotifier"),
        "B-4 WIRE INVARIANT VIOLATED: subscription_bridge.rs does not \
         define `pub trait NodeChangeNotifier`. The abstraction seam \
         is missing — production code cannot test the bridge in \
         isolation, and the Phase B-4.5 swap to a SensNodeManager-\
         backed notifier requires the trait."
    );
    assert!(
        src.contains("pub struct LoggingNotifier"),
        "B-4 WIRE INVARIANT VIOLATED: subscription_bridge.rs does not \
         provide `LoggingNotifier`. The default observability-only \
         impl is the production wire until Phase B-4.5 ships the \
         async-opcua-backed notifier."
    );
    assert!(
        src.contains("impl NodeChangeNotifier for LoggingNotifier"),
        "B-4 WIRE INVARIANT VIOLATED: LoggingNotifier does not impl \
         NodeChangeNotifier. The trait/impl pairing is the bridge's \
         dispatch contract."
    );
}

/// **Phase B-4 / Batch #275 (boot wires bridge from ProcessImage):** the
/// production `init_opc_ua_server` MUST call
/// `process_image.subscribe_changes()` AND construct + spawn the
/// SubscriptionBridge AND store the spawn handle on
/// `SuderraOpcUaHandle`. A regression that drops the spawn would
/// either leave the broadcast unconsumed (Lagged accumulation) OR
/// fire-and-forget (Drop on init_opc_ua_server scope exit cancels
/// the task immediately, which is worse than no spawn at all).
#[test]
fn b4_boot_path_spawns_bridge() {
    let src = read_source("src/opc_ua_server_runtime.rs");
    assert!(
        src.contains("SubscriptionBridge::spawn("),
        "B-4 BOOT WIRE INVARIANT VIOLATED: \
         src/opc_ua_server_runtime.rs does not call \
         `SubscriptionBridge::spawn(...)` in the init path. The \
         production boot has no bridge consumer; the broadcast::Sender \
         on ProcessImage will report Lagged at any non-trivial \
         tag-change rate."
    );
    assert!(
        src.contains("process_image.subscribe_changes()"),
        "B-4 BOOT WIRE INVARIANT VIOLATED: \
         src/opc_ua_server_runtime.rs does not call \
         `process_image.subscribe_changes()`. The bridge has no \
         broadcast::Receiver source."
    );
    assert!(
        src.contains("subscription_bridge: Some(subscription_bridge)"),
        "B-4 LIFECYCLE INVARIANT VIOLATED: SuderraOpcUaHandle does not \
         capture the spawned SubscriptionBridge. Without storing the \
         handle, the bridge drops at scope exit + the task's \
         Drop-induced cancel fires immediately — the bridge runs for \
         microseconds rather than the OPC UA server's lifetime."
    );
}

/// **Phase B-4 / Batch #275 (graceful shutdown drains the bridge):** the
/// `SuderraOpcUaHandle::shutdown_full` (or `cancel + join` chain) MUST
/// invoke the bridge's shutdown so the task exits cleanly before the
/// agent process exits. Without this, ShutdownCoordinator misses the
/// bridge in its drain set + audit/log emit may be cut mid-write on
/// process exit.
#[test]
fn b4_shutdown_drains_bridge() {
    let src = read_source("src/opc_ua_server_runtime.rs");
    assert!(
        src.contains("pub async fn shutdown_full(")
            && src.contains("bridge.shutdown().await"),
        "B-4 SHUTDOWN INVARIANT VIOLATED: \
         src/opc_ua_server_runtime.rs SuderraOpcUaHandle does not \
         provide `shutdown_full` that awaits `bridge.shutdown().await`. \
         The graceful-shutdown contract is incomplete — the bridge \
         task may be killed mid-dispatch on process exit, leaking \
         in-flight TagChange events that should have anchored to the \
         audit chain."
    );
}

/// **Phase B-4 (subscription_bridge submodule declaration):**
/// `opc_ua_server.rs` MUST declare `pub mod subscription_bridge;`.
#[test]
fn b4_submodule_declared() {
    let src = read_source("src/opc_ua_server.rs");
    assert!(
        src.contains("pub mod subscription_bridge;"),
        "B-4 SUBMODULE WIRE INVARIANT VIOLATED: src/opc_ua_server.rs \
         does not declare `pub mod subscription_bridge;`. The \
         subscription_bridge.rs file is orphaned — compile-time \
         absent from the binary."
    );
}

/// **Phase B-4 (cancel-token shape):** the bridge uses
/// `BridgeCancelToken` (watch::Sender<bool>-backed) rather than
/// `tokio_util::CancellationToken` because tokio_util is NOT in the
/// agent's dependency tree. A regression that introduces a
/// tokio_util import would either fail compile (no dep) or pull in a
/// new dependency unnecessarily. This invariant pins the
/// architectural choice.
#[test]
fn b4_bridge_cancel_token_uses_watch_not_tokio_util() {
    let src = read_source("src/opc_ua_server/subscription_bridge.rs");
    assert!(
        !src.contains("use tokio_util::"),
        "B-4 DEPENDENCY INVARIANT VIOLATED: subscription_bridge.rs \
         imports `tokio_util` which is NOT in the agent's Cargo.toml. \
         The architectural choice (BridgeCancelToken via \
         watch::Sender<bool>) avoids adding the dep. Either restore \
         the watch-based shape or extend Cargo.toml + this invariant."
    );
    assert!(
        src.contains("pub struct BridgeCancelToken"),
        "B-4 DEPENDENCY INVARIANT VIOLATED: subscription_bridge.rs \
         does not define `BridgeCancelToken`. The agent-side cancel \
         primitive was renamed/removed."
    );
}
