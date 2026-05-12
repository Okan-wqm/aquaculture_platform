//! `SubscriptionBridge` — pushes ProcessImage tag changes into the OPC UA
//! address space at sub-poll latency.
//!
//! ## WHY this primitive exists
//!
//! Phase B-4 of the Faz 2 closure plan
//! (`docs/plans/2026-04-24-sens-api-gateway-gap-closure-ultra-plan.md`
//! §B-4, Batches #273-#275) closes the HMI-staleness gap on the OPC UA
//! subscription path.
//!
//! Pre-B-4 the subscription latency budget was bounded by
//! `OpcUaServerConfig.subscription_polling_interval_ms` (default 100ms)
//! plus async-opcua's internal subscription sampling. SL-2 FR4 + FR7
//! (safety-critical tier) imposes a 500ms p99 propagation SLO from
//! sensor-tap to HMI render; the polling-bound shape burns ~40% of
//! that on a single hop. ProcessImage emits `broadcast::Sender<TagChange>`
//! at every commit (Faz 4); this bridge consumes the receiver + drives
//! a `NodeChangeNotifier` so async-opcua's subscription state can
//! short-circuit the next sampling cycle.
//!
//! ## Architectural shape
//!
//! Three primitives compose:
//!
//! 1. **`broadcast::Receiver<TagChange>`** — supplied by
//!    `ProcessImage::subscribe_changes`. Multi-subscriber by design
//!    (alarm engine + scripting + bridge can coexist); the broadcast
//!    capacity (1024 entries) absorbs a typical scan-cycle's worth of
//!    bursts before the slowest subscriber drops events.
//!
//! 2. **`NodeChangeNotifier` trait** — abstraction the bridge calls
//!    when a TagChange arrives. Production impl is wired to the
//!    SensNodeManager (or async-opcua's subscription API once the
//!    upstream surface is verified — see ORPHAN-MEDIUM-053). Test
//!    impls record changes for assertion without requiring a live
//!    OPC UA server.
//!
//! 3. **`SubscriptionBridge` task** — `tokio::spawn` consumer that
//!    drains the broadcast receiver in a loop. On each TagChange:
//!    - Resolve `tag_name` → OPC UA browse_name via `OpcUaTagRegistry`.
//!    - Skip if tag is not part of the published address space (the
//!      registry's missing-entry case — silent drop is correct: tags
//!      operators chose not to expose to OPC UA SHOULD NOT propagate).
//!    - Call `notifier.notify(...)` with the resolved tag identity +
//!      change payload.
//!    - On receiver lag (`RecvError::Lagged`), log warn + continue —
//!      a slow notifier MUST NOT deadlock the producer.
//!    - On receiver close (`RecvError::Closed`), log info + exit
//!      task cleanly. The graceful shutdown path drops the sender,
//!      which closes the receiver naturally.
//!
//! ## Why NOT spawn-per-tag
//!
//! Plan §B-4 was originally drafted around InMemoryNodeManager's
//! per-tag write-callback shape; the codebase has since moved to
//! SensNodeManager with virtual-node reads (zero per-tag state to
//! update on the read side). The bridge therefore consumes a SINGLE
//! broadcast::Receiver and dispatches to the notifier per change — no
//! per-tag spawn needed. The architectural surface is
//! `notifier.notify(tag_browse_name, tag_change)` — the notifier
//! decides whether to record per-tag state.
//!
//! ## Integration status (Phase B-4 commit)
//!
//! - **Primitive (this batch):** SubscriptionBridge + NodeChangeNotifier
//!   trait + LoggingNotifier (test/observability default impl).
//! - **Production wire (Phase B-4.5):** SensNodeManager impl
//!   NodeChangeNotifier — calls async-opcua 0.18's subscription
//!   notification API. Documented as ORPHAN-MEDIUM-053; deferred until
//!   the upstream API surface is verified by an opc-ua-server feature
//!   compile (locally blocked by RAM ceiling).
//!
//! Until B-4.5 lands, the bridge runs in production with the
//! LoggingNotifier — every TagChange is logged via `tracing::trace!`
//! at `target = "opc_ua.subscription"`. This:
//! - Drains the broadcast receiver (prevents the producer's Lagged
//!   error class from accumulating).
//! - Establishes the wire shape end-to-end (registry lookup, change
//!   dispatch).
//! - Provides operator-readable observability into the change firehose.
//!
//! Once B-4.5 swaps in the SensNodeManager-backed notifier, the
//! production path lights up sub-poll subscription latency without
//! re-architecting the bridge.

#![cfg(feature = "opc-ua-server")]

use std::sync::Arc;

use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;

use crate::opc_ua_server::OpcUaTagRegistry;
use crate::process_image::TagChange;

/// Cooperative shutdown signal for the bridge task. Implemented as a
/// `watch::Sender<bool>` rather than a `tokio_util::CancellationToken`
/// (which is not currently in the agent's dependency tree). Setting
/// `true` is the cancel signal — idempotent, observed via the paired
/// `Receiver::changed()` await.
#[derive(Debug, Clone)]
pub struct BridgeCancelToken {
    tx: watch::Sender<bool>,
}

impl Default for BridgeCancelToken {
    fn default() -> Self {
        Self::new()
    }
}

impl BridgeCancelToken {
    /// Construct a fresh cancel token. The internal channel starts in
    /// the not-cancelled state (`false`).
    pub fn new() -> Self {
        let (tx, _rx) = watch::channel(false);
        Self { tx }
    }

    /// Subscribe a fresh receiver. Each spawned task uses its own
    /// receiver; the sender is shared via clone.
    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.tx.subscribe()
    }

    /// Trigger cancel. Idempotent — re-cancelling is a no-op.
    pub fn cancel(&self) {
        self.tx.send_replace(true);
    }

    /// Read the current cancel state without awaiting.
    pub fn is_cancelled(&self) -> bool {
        *self.tx.borrow()
    }
}

/// Abstraction over "tell the OPC UA address space that a tag changed".
///
/// Phase B-4 ships the trait + a logging default impl. Phase B-4.5
/// adds the SensNodeManager-backed impl that calls async-opcua's
/// subscription notification API.
///
/// Trait methods are sync (not async) because the underlying
/// async-opcua hook is expected to be a fast in-memory state mutation
/// + a wakeup of any pending subscription. The bridge task is async
/// only because the broadcast::Receiver is async; the dispatch step
/// completes synchronously within the awaited task.
pub trait NodeChangeNotifier: Send + Sync {
    /// Notify that the OPC UA node for `browse_name` has a new value.
    /// `change.timestamp` carries the source-of-truth wall clock; the
    /// notifier impl is responsible for forwarding this to async-opcua
    /// so subscription DataChangeNotifications carry an accurate
    /// `SourceTimestamp`.
    ///
    /// Returns `Ok(())` on successful notification dispatch (does not
    /// imply the HMI has rendered the change). `Err` is logged at
    /// warn-level by the bridge but does NOT abort the task — a
    /// transient notifier failure on one tag does not stop other
    /// tags from propagating.
    fn notify(&self, browse_name: &str, change: &TagChange) -> Result<(), NodeChangeNotifyError>;
}

/// Errors returned by [`NodeChangeNotifier::notify`]. The bridge does
/// not abort on these — every variant is logged + the next change
/// processed.
#[derive(Debug)]
pub enum NodeChangeNotifyError {
    /// Notifier internal state is unavailable (e.g., NodeManager
    /// hasn't registered yet on a fresh boot, or the namespace_index
    /// is None). The bridge logs + continues; the next TagChange has
    /// a chance to find the notifier in a populated state.
    NodeManagerNotReady,
    /// Notifier knows about the namespace but not this specific
    /// browse_name — operator added a tag to ProcessImage but not to
    /// the OPC UA tag registry. The bridge does NOT log every miss
    /// (that would flood at high tag-change rates); the registry
    /// pre-filter is the architectural floor against this case.
    UnknownNode(String),
    /// async-opcua subscription state mutation failed (returned an
    /// error code from the inner API). Logged with the underlying
    /// error string.
    NotificationDispatchFailed(String),
}

impl std::fmt::Display for NodeChangeNotifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NodeManagerNotReady => f.write_str("node_manager_not_ready"),
            Self::UnknownNode(name) => write!(f, "unknown_node:{name}"),
            Self::NotificationDispatchFailed(e) => write!(f, "dispatch_failed:{e}"),
        }
    }
}

impl std::error::Error for NodeChangeNotifyError {}

/// Default observability-only notifier — logs every change at
/// `tracing::trace!` `target = "opc_ua.subscription"` without
/// touching the OPC UA address space. Used when the bridge runs
/// before the production SensNodeManager-backed notifier is wired
/// (Phase B-4 commit ships this as the default; Phase B-4.5 swaps
/// in the production impl).
#[derive(Debug, Default)]
pub struct LoggingNotifier;

impl NodeChangeNotifier for LoggingNotifier {
    fn notify(&self, browse_name: &str, change: &TagChange) -> Result<(), NodeChangeNotifyError> {
        tracing::trace!(
            target: "opc_ua.subscription",
            browse_name = browse_name,
            tag_name = %change.tag_name,
            value = change.new_value,
            quality = ?change.quality,
            source = ?change.source,
            ts_unix_secs = change.timestamp.timestamp(),
            "SubscriptionBridge: TagChange dispatched (LoggingNotifier — \
             Phase B-4.5 swap in SensNodeManager-backed notifier for \
             real subscription propagation)"
        );
        Ok(())
    }
}

/// `SubscriptionBridge` — owns the spawn handle of the bridge task.
///
/// Production wire: constructed in `init_opc_ua_server` after the
/// ServerHandle is returned by `build_server().build()`. The
/// `JoinHandle` is registered with `ShutdownCoordinator` so graceful
/// shutdown (SIGTERM, SIGINT) cancels the task cleanly.
///
/// Cancellation contract: the `CancellationToken` is the public
/// shutdown signal; cancelling it causes the task's `select!` to
/// resolve on the cancel branch + the task exits. The
/// `broadcast::Receiver` is dropped on task exit, which decrements
/// the sender's subscriber count.
pub struct SubscriptionBridge {
    handle: Option<JoinHandle<()>>,
    cancel: BridgeCancelToken,
}

impl SubscriptionBridge {
    /// Spawn the bridge task. The task takes ownership of the
    /// receiver + a clone of the registry + the notifier Arc. The
    /// returned `SubscriptionBridge` owns the JoinHandle so the
    /// caller can register it with the shutdown coordinator.
    ///
    /// `cancel` is the cooperative shutdown signal — cancelling it
    /// causes the task to exit on the next `select!` resolution.
    /// Production wires this to the agent's global cancellation
    /// token via `ShutdownCoordinator`.
    pub fn spawn(
        mut receiver: broadcast::Receiver<TagChange>,
        registry: Arc<OpcUaTagRegistry>,
        notifier: Arc<dyn NodeChangeNotifier>,
        cancel: BridgeCancelToken,
    ) -> Self {
        let task_cancel = cancel.clone();
        let handle = tokio::spawn(async move {
            let mut cancel_rx = task_cancel.subscribe();
            tracing::info!(
                target: "opc_ua.subscription",
                "SubscriptionBridge task spawned (Phase B-4)"
            );
            if *cancel_rx.borrow_and_update() {
                tracing::info!(
                    target: "opc_ua.subscription",
                    "SubscriptionBridge: cancel signal already set, exiting task"
                );
                return;
            }
            loop {
                tokio::select! {
                    biased;
                    // Cancel branch first — graceful-shutdown priority
                    // over draining the receiver. Pending changes in
                    // the broadcast buffer are discarded; that is
                    // correct semantics for shutdown (in-flight HMI
                    // subscriptions are torn down by async-opcua
                    // independently).
                    cancel_changed = cancel_rx.changed() => {
                        match cancel_changed {
                            Ok(()) if *cancel_rx.borrow() => {
                                tracing::info!(
                                    target: "opc_ua.subscription",
                                    "SubscriptionBridge: cancel signal received, exiting task"
                                );
                                break;
                            }
                            Ok(()) => {
                                // Spurious wakeup — value still false.
                                continue;
                            }
                            Err(_) => {
                                // Sender dropped; treat as cancel.
                                tracing::info!(
                                    target: "opc_ua.subscription",
                                    "SubscriptionBridge: cancel sender dropped, exiting task"
                                );
                                break;
                            }
                        }
                    }
                    recv_result = receiver.recv() => {
                        match recv_result {
                            Ok(change) => {
                                Self::dispatch_change(&registry, &*notifier, &change);
                            }
                            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                                // A slow notifier let the broadcast
                                // ringbuffer wrap; we missed `skipped`
                                // changes. Log + continue — better to
                                // miss a few than to deadlock the
                                // producer.
                                tracing::warn!(
                                    target: "opc_ua.subscription",
                                    skipped = skipped,
                                    "SubscriptionBridge: broadcast lagged \
                                     (skipped {skipped} TagChange events). \
                                     Slow notifier OR high producer rate. \
                                     Investigate notifier latency."
                                );
                            }
                            Err(broadcast::error::RecvError::Closed) => {
                                tracing::info!(
                                    target: "opc_ua.subscription",
                                    "SubscriptionBridge: broadcast sender closed, exiting task"
                                );
                                break;
                            }
                        }
                    }
                }
            }
            tracing::info!(
                target: "opc_ua.subscription",
                "SubscriptionBridge task exited"
            );
        });
        Self {
            handle: Some(handle),
            cancel,
        }
    }

    /// Synchronous dispatch — extracted so the unit test can drive
    /// the same logic without spawning a task. Resolves the tag's
    /// browse_name via the registry; on miss, drops silently
    /// (operators may have tags in ProcessImage that are NOT
    /// exposed to OPC UA — their changes do not propagate).
    fn dispatch_change(
        registry: &OpcUaTagRegistry,
        notifier: &dyn NodeChangeNotifier,
        change: &TagChange,
    ) {
        let node = match registry.get(&change.tag_name) {
            Some(n) => n,
            None => {
                // Silent drop — see fn-docs above for rationale.
                tracing::trace!(
                    target: "opc_ua.subscription",
                    tag_name = %change.tag_name,
                    "SubscriptionBridge: TagChange skipped (not in OPC UA registry)"
                );
                return;
            }
        };
        if let Err(e) = notifier.notify(&node.browse_name, change) {
            tracing::warn!(
                target: "opc_ua.subscription",
                tag_name = %change.tag_name,
                browse_name = %node.browse_name,
                error = %e,
                "SubscriptionBridge: notifier returned error (continuing)"
            );
        }
    }

    /// Cancel + await the task. Idempotent — calling twice is safe.
    /// Used by the agent's ShutdownCoordinator.
    pub async fn shutdown(&mut self) {
        self.cancel.cancel();
        if let Some(handle) = self.handle.take() {
            match handle.await {
                Ok(()) => {
                    tracing::info!(
                        target: "opc_ua.subscription",
                        "SubscriptionBridge shutdown complete"
                    );
                }
                Err(e) => {
                    tracing::error!(
                        target: "opc_ua.subscription",
                        error = ?e,
                        "SubscriptionBridge task panicked during shutdown"
                    );
                }
            }
        }
    }
}

impl Drop for SubscriptionBridge {
    fn drop(&mut self) {
        // Defense-in-depth: if the owner forgot to call shutdown(),
        // dropping the bridge cancels the task. The JoinHandle is
        // detached on drop (tokio::JoinHandle has no abort-on-drop)
        // — production code MUST call shutdown() to await clean exit;
        // this Drop is the test-context cleanup path.
        self.cancel.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::opc_ua_server::{OpcUaTagNode, OpcUaTagRegistry};
    use crate::process_image::{TagQuality, TagSource};
    use chrono::Utc;
    use std::sync::Mutex;

    /// Test notifier that records every change it sees — assertions
    /// run against the captured log.
    #[derive(Default)]
    struct CapturingNotifier {
        captured: Mutex<Vec<(String, TagChange)>>,
        force_error: Mutex<Option<NodeChangeNotifyError>>,
    }

    impl NodeChangeNotifier for CapturingNotifier {
        fn notify(
            &self,
            browse_name: &str,
            change: &TagChange,
        ) -> Result<(), NodeChangeNotifyError> {
            // If a forced error is queued, return it.
            if let Some(err) = self.force_error.lock().unwrap().take() {
                return Err(err);
            }
            self.captured
                .lock()
                .unwrap()
                .push((browse_name.to_string(), change.clone()));
            Ok(())
        }
    }

    fn registry_with_tag(tag_name: &str, browse_name: &str) -> Arc<OpcUaTagRegistry> {
        // Build a registry with one entry. The actual TagConfig
        // construction is non-trivial; we use the test helper that
        // exists in opc_ua_server.rs::tests if available, else
        // build via the public API.
        let cfg = crate::process_image::TagConfig {
            tag_name: tag_name.to_string(),
            io_type: crate::process_image::IoType::AI,
            data_type: "real".to_string(),
            source: TagSource::Gpio,
            poll_interval_ms: None,
            raw_min: None,
            raw_max: None,
            eng_min: None,
            eng_max: None,
            eng_unit: None,
            invert: false,
            alarm_hh: None,
            alarm_h: None,
            alarm_l: None,
            alarm_ll: None,
            deadband: None,
            protocol_config: crate::process_image::ProtocolConfig::Gpio {
                pin: 0,
                direction: "input".to_string(),
            },
        };
        let _ = browse_name; // OpcUaTagRegistry derives browse_name from tag_name
        Arc::new(OpcUaTagRegistry::build([&cfg].into_iter()).expect("registry build"))
    }

    fn synth_change(tag_name: &str, value: f64) -> TagChange {
        TagChange {
            tag_name: tag_name.to_string(),
            new_value: value,
            quality: TagQuality::Good,
            source: TagSource::Gpio,
            timestamp: Utc::now(),
        }
    }

    /// Dispatch resolves a known tag's browse_name + calls the notifier.
    #[test]
    fn dispatch_notifies_on_known_tag() {
        let registry = registry_with_tag("tank_a", "tank_a");
        let notifier = Arc::new(CapturingNotifier::default());
        let change = synth_change("tank_a", 42.0);
        SubscriptionBridge::dispatch_change(&registry, &*notifier, &change);
        let captured = notifier.captured.lock().unwrap();
        assert_eq!(captured.len(), 1, "expected 1 capture");
        assert_eq!(captured[0].1.new_value, 42.0);
    }

    /// Unknown tag is silently dropped (does NOT error, does NOT log warn).
    #[test]
    fn dispatch_silently_drops_unknown_tag() {
        let registry = registry_with_tag("tank_a", "tank_a");
        let notifier = Arc::new(CapturingNotifier::default());
        let change = synth_change("nonexistent_tag", 99.0);
        SubscriptionBridge::dispatch_change(&registry, &*notifier, &change);
        assert!(
            notifier.captured.lock().unwrap().is_empty(),
            "unknown tag must not reach the notifier"
        );
    }

    /// Notifier error does NOT abort dispatch — logged + next change
    /// proceeds normally.
    #[test]
    fn dispatch_continues_after_notifier_error() {
        let registry = registry_with_tag("tank_a", "tank_a");
        let notifier = Arc::new(CapturingNotifier::default());
        // Queue an error for the next call.
        *notifier.force_error.lock().unwrap() = Some(NodeChangeNotifyError::NodeManagerNotReady);
        let change1 = synth_change("tank_a", 1.0);
        SubscriptionBridge::dispatch_change(&registry, &*notifier, &change1);
        // Error consumed; second call should succeed.
        let change2 = synth_change("tank_a", 2.0);
        SubscriptionBridge::dispatch_change(&registry, &*notifier, &change2);
        let captured = notifier.captured.lock().unwrap();
        assert_eq!(captured.len(), 1, "first errored, second succeeded");
        assert_eq!(captured[0].1.new_value, 2.0);
    }

    /// LoggingNotifier accepts every call without error.
    #[test]
    fn logging_notifier_accepts_changes() {
        let n = LoggingNotifier;
        let change = synth_change("tank_a", 42.0);
        n.notify("tank_a", &change)
            .expect("LoggingNotifier never fails");
    }

    /// Spawn + cancel triggers a clean exit within bounded time.
    #[tokio::test]
    async fn spawn_then_cancel_exits_cleanly() {
        let (tx, rx) = broadcast::channel::<TagChange>(16);
        let registry = registry_with_tag("tank_a", "tank_a");
        let notifier: Arc<dyn NodeChangeNotifier> = Arc::new(LoggingNotifier);
        let cancel = BridgeCancelToken::new();
        let mut bridge = SubscriptionBridge::spawn(rx, registry, notifier, cancel);
        // Send one change so the task has activity.
        let _ = tx.send(synth_change("tank_a", 1.0));
        // Trigger cancel + await shutdown.
        tokio::time::timeout(std::time::Duration::from_secs(2), bridge.shutdown())
            .await
            .expect("bridge shutdown must not hang after cancel");
        // Subsequent shutdown is idempotent.
        bridge.shutdown().await;
    }

    /// Spawn + sender drop exits cleanly when the broadcast channel
    /// closes (Closed receiver error).
    #[tokio::test]
    async fn spawn_exits_when_sender_drops() {
        let (tx, rx) = broadcast::channel::<TagChange>(16);
        let registry = registry_with_tag("tank_a", "tank_a");
        let notifier: Arc<dyn NodeChangeNotifier> = Arc::new(LoggingNotifier);
        let cancel = BridgeCancelToken::new();
        let mut bridge = SubscriptionBridge::spawn(rx, registry, notifier, cancel);
        // Drop the sender — the task should exit on RecvError::Closed.
        drop(tx);
        // Give the task a moment to observe the closed channel.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        bridge.shutdown().await;
    }

    /// Capturing notifier impl + spawned task end-to-end: a TagChange
    /// sent through the broadcast channel reaches the notifier within
    /// reasonable time.
    #[tokio::test]
    async fn end_to_end_change_reaches_notifier() {
        let (tx, rx) = broadcast::channel::<TagChange>(16);
        let registry = registry_with_tag("tank_a", "tank_a");
        let notifier = Arc::new(CapturingNotifier::default());
        let cancel = BridgeCancelToken::new();
        let mut bridge = SubscriptionBridge::spawn(rx, registry, notifier.clone(), cancel);
        // Send 3 changes.
        for i in 1..=3 {
            let _ = tx.send(synth_change("tank_a", i as f64));
        }
        // Wait briefly for the task to drain.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let captured = notifier.captured.lock().unwrap().clone();
        assert_eq!(captured.len(), 3, "3 sends should yield 3 notifier calls");
        drop(captured);
        bridge.shutdown().await;
    }
}
