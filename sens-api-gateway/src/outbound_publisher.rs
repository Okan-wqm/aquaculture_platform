//! OutboundPublisher — broker-aware MQTT publish dispatcher
//! (Batch #251, ARC-002 part 1).
//!
//! ## Role
//!
//! Routes every outbound MQTT publish through one of two paths:
//!
//! - **Broker up** → direct publish via [`MqttPublishSink`]. Hot
//!   path, no disk IO, lowest latency.
//! - **Broker down** → enqueue to [`OfflineQueue`]. Persisted via
//!   SQLCipher; survives agent restarts. Drained back to the
//!   broker on reconnect (Batch #252 drain task — not yet wired).
//!
//! The dispatch decision uses [`BrokerConnectivity::is_connected`]
//! which reads the [`crate::health::HealthState`] atomic flag. The
//! flag is set by the MQTT event-loop in `mqtt.rs` on every
//! `Connected` / `Disconnected` event.
//!
//! ## Why the abstraction (vs. inline `if connected { publish }
//! else { enqueue }` at every call site)
//!
//! Pre-Batch-251, every MQTT publish call site
//! (`publish_telemetry`, `publish_status`, `publish_alarms`,
//! `publish_response`, etc.) called `MqttClient::publish_*`
//! directly. Adding broker-aware branching to each one would have
//! duplicated the connect-check + queue-fallback + race-handling
//! logic across ~10 sites. A single dispatcher with two delegate
//! traits centralizes that logic and makes it testable in
//! isolation:
//!
//! - `MqttPublishSink` mocked → exercise the disconnect-race path
//!   (connectivity flag says "up" but broker drops between check
//!   and write) without spinning up a real MQTT broker.
//! - `BrokerConnectivity` mocked → flip up/down deterministically
//!   in tests; no async-runtime broker reconnect required.
//!
//! ## Race-safe disconnect handling
//!
//! The dispatcher reads `is_connected` and immediately calls
//! `publish_to_broker`; between those two operations the broker
//! can drop. When the sink returns
//! [`PublishSinkError::Disconnected`] (recognized via the inner
//! transport-error pattern match), the dispatcher falls through to
//! enqueue rather than propagating the error. Net effect: a
//! racing disconnect produces a queued message instead of a
//! propagated failure — same as if the connectivity flag had been
//! observed false.
//!
//! ## Cross-references
//!
//! - Batch #251 (this file) — primitive + impl + tests.
//! - Batch #252 — drain task wire.
//! - Batch #253+ — production call site migration starting with
//!   the alarm/alert hot-path (life-safety priority).
//! - `offline_queue.rs` — Batch v1.2.x persistent queue.
//! - `health.rs` — Batch 102 connectivity tracking + Batch #251
//!   `is_mqtt_connected` getter.

#![allow(dead_code)]

use std::sync::Arc;

use async_trait::async_trait;
use thiserror::Error;

use crate::offline_queue::{MessagePriority, OfflineQueue};

/// Transport-layer publish abstraction. The MQTT client implements
/// this; mocks substitute it for unit testing.
#[async_trait]
pub trait MqttPublishSink: Send + Sync {
    /// Publish a payload to the broker at the given QoS + retain
    /// flag. Returns Err on any transport failure;
    /// `PublishSinkError::Disconnected` is the canonical "broker
    /// dropped between connectivity check and write" indicator
    /// that the dispatcher uses to fall through to enqueue.
    async fn publish_to_broker(
        &self,
        topic: &str,
        payload: &[u8],
        qos: u8,
        retain: bool,
    ) -> Result<(), PublishSinkError>;
}

/// Connectivity state read-port. Implementors return the current
/// "is broker reachable" flag; the dispatcher uses this BEFORE
/// attempting `publish_to_broker` to skip the round-trip when the
/// broker is known to be down.
pub trait BrokerConnectivity: Send + Sync {
    fn is_connected(&self) -> bool;
}

/// Production wire: HealthState's MQTT-connected atomic flag IS
/// the canonical connectivity signal for the edge agent. The
/// MQTT event-loop in `mqtt.rs` updates the flag on every
/// `Connected` / `Disconnected` event; every consumer reads
/// through this trait to keep the dispatcher generic in tests.
impl BrokerConnectivity for crate::health::HealthState {
    fn is_connected(&self) -> bool {
        crate::health::HealthState::is_mqtt_connected(self)
    }
}

/// Sink error taxonomy. Distinct variant for the disconnect path
/// so the dispatcher can fall through to enqueue without
/// propagating the error.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum PublishSinkError {
    /// Broker was disconnected at the time of publish — queue the
    /// message and continue.
    #[error("broker disconnected mid-publish")]
    Disconnected,

    /// Other transport-level failure (write timeout, payload too
    /// large, broker rejected with non-disconnect error).
    #[error("transport error: {0}")]
    Transport(String),
}

/// Outbound publish outcome — distinct variants for "broker
/// accepted" and "queued for later" so audit/observability sees
/// the difference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PublishOutcome {
    /// Message was sent to the broker successfully.
    Sent,
    /// Broker was unreachable; message is persisted to disk for
    /// later replay.
    Queued {
        /// Row ID returned by `OfflineQueue::enqueue`.
        message_id: i64,
    },
}

/// Top-level error for [`OutboundPublisher::publish`]. Includes
/// path-specific failures the caller may need to distinguish for
/// audit logging / metrics.
#[derive(Debug, Error)]
pub enum OutboundError {
    /// `OfflineQueue::enqueue` returned an error (DB lock poison,
    /// disk write failure, schema violation). The message was
    /// neither sent nor persisted — caller MUST decide drop vs.
    /// retry policy. For life-safety paths this is a hard failure.
    #[error("offline queue enqueue failed: {0}")]
    QueueError(String),

    /// `MqttPublishSink::publish_to_broker` returned a
    /// non-Disconnected transport failure. The broker accepted
    /// the connection but rejected the payload (e.g., topic ACL,
    /// payload size limit). Distinct from QueueError so
    /// observability can separate transport faults from disk
    /// faults.
    #[error("transport error: {0}")]
    TransportError(String),

    /// Payload bytes were not UTF-8 — the OfflineQueue schema
    /// stores TEXT, not BLOB, so binary MQTT payloads cannot be
    /// queued today. Caller must serialize binary payloads (e.g.,
    /// via base64) before invoking publish.
    #[error("payload is not valid UTF-8 (OfflineQueue schema requires TEXT)")]
    PayloadNotUtf8,
}

/// Broker-aware MQTT publish dispatcher. Holds shared references
/// to the transport sink, connectivity port, and offline queue.
///
/// **Generic over the trait pair** so unit tests can substitute
/// mock impls without weakening any production-code visibility.
/// Production wires `MqttClient` (sink) + `HealthState`
/// (connectivity) + the `Arc<OfflineQueue>` from AppState.
pub struct OutboundPublisher<S: MqttPublishSink, C: BrokerConnectivity> {
    sink: Arc<S>,
    connectivity: Arc<C>,
    queue: Arc<OfflineQueue>,
}

impl<S, C> OutboundPublisher<S, C>
where
    S: MqttPublishSink,
    C: BrokerConnectivity,
{
    /// Construct a dispatcher over a sink + connectivity port +
    /// queue. All three are shared (`Arc`) so multiple publishers
    /// can coexist (e.g., one per service-group with distinct
    /// queue tuning) — though current production wires exactly
    /// one.
    pub fn new(sink: Arc<S>, connectivity: Arc<C>, queue: Arc<OfflineQueue>) -> Self {
        Self {
            sink,
            connectivity,
            queue,
        }
    }

    /// Publish a payload via the broker if connected, otherwise
    /// queue to disk. Race-safe against mid-publish broker drops:
    /// a `PublishSinkError::Disconnected` returned by the sink
    /// after the connectivity check passed falls through to enqueue.
    pub async fn publish(
        &self,
        topic: &str,
        payload: &[u8],
        priority: MessagePriority,
        qos: u8,
        retain: bool,
    ) -> Result<PublishOutcome, OutboundError> {
        if self.connectivity.is_connected() {
            match self
                .sink
                .publish_to_broker(topic, payload, qos, retain)
                .await
            {
                Ok(()) => return Ok(PublishOutcome::Sent),
                Err(PublishSinkError::Disconnected) => {
                    // Connectivity flag said "up" but broker dropped
                    // between check and write. Fall through to
                    // enqueue rather than propagate the error.
                }
                Err(PublishSinkError::Transport(msg)) => {
                    return Err(OutboundError::TransportError(msg));
                }
            }
        }

        // Enqueue path — broker known down OR disconnect race.
        self.enqueue(topic, payload, priority, qos, retain).await
    }

    /// EDGE-HIGH-014: the SQLCipher enqueue is blocking I/O; it runs on the
    /// blocking thread pool (`spawn_blocking`) so a broker outage cannot stall
    /// a tokio worker while telemetry backs up to disk.
    async fn enqueue(
        &self,
        topic: &str,
        payload: &[u8],
        priority: MessagePriority,
        qos: u8,
        retain: bool,
    ) -> Result<PublishOutcome, OutboundError> {
        let payload_str = std::str::from_utf8(payload)
            .map_err(|_| OutboundError::PayloadNotUtf8)?
            .to_string();
        let topic = topic.to_string();
        let queue = Arc::clone(&self.queue);
        let message_id = tokio::task::spawn_blocking(move || {
            queue.enqueue(&topic, &payload_str, priority, qos, retain)
        })
        .await
        .map_err(|e| OutboundError::QueueError(format!("spawn_blocking join: {}", e)))?
        .map_err(|e| OutboundError::QueueError(e.to_string()))?;
        Ok(PublishOutcome::Queued { message_id })
    }
}

// =============================================================================
// DrainTask — Batch #252 ARC-002 part 2
// =============================================================================

use std::time::Duration;

/// Outcome of a single drain pass — used by tests to assert
/// progress, by metrics observers (Batch #253+) to expose drain
/// throughput.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DrainOutcome {
    /// Queue was empty — no work done.
    Empty,
    /// `sent` messages were successfully replayed + acked.
    /// `remaining` messages stayed in the queue (either because
    /// the batch limit was reached or the broker dropped mid-drain).
    Drained { sent: usize, remaining: usize },
    /// `peek_batch` failed (DB lock poison, disk error). Drain
    /// stops; next tick retries.
    QueueError(String),
    /// Connectivity was down at tick time — drain skipped.
    Skipped,
}

/// Background task that replays queued messages back to the
/// broker when the connection is up. Polls `BrokerConnectivity`
/// at a configurable interval; on every tick where the broker is
/// up, peeks a priority-ordered batch from the queue + publishes
/// each via the same `MqttPublishSink` used for direct-path
/// publishes.
///
/// **Stop conditions per drain pass:**
/// - All messages in the batch were sent + acked (queue may have
///   more — next tick continues).
/// - Sink returned `PublishSinkError::Disconnected` mid-batch:
///   stop, leave un-acked messages in the queue for the next
///   reconnect cycle.
/// - Sink returned `PublishSinkError::Transport(...)`: stop, leave
///   un-acked messages in the queue. The error is warn-logged but
///   not propagated — we never want a single broker-side rejection
///   (e.g., topic ACL change) to block ALL future drains.
///
/// **Shutdown:** the `run` method takes a tokio oneshot receiver;
/// when the sender drops or fires, the task exits at the next
/// tick boundary. Production wires this to the existing
/// `ShutdownCoordinator` to drain on graceful stop.
pub struct DrainTask<S: MqttPublishSink, C: BrokerConnectivity> {
    sink: Arc<S>,
    connectivity: Arc<C>,
    queue: Arc<OfflineQueue>,
    /// Interval between drain ticks. 1 second is the production
    /// default — fast enough to clear typical post-outage backlogs
    /// in seconds, slow enough to avoid SQLite WAL contention with
    /// the enqueue path.
    interval: Duration,
    /// Maximum messages to peek per tick. Bounds memory + the
    /// "single-tick drain ack window" (a longer batch means more
    /// messages stay in-flight before the SQLite delete commits).
    /// 32 is the production default — covers typical fleet
    /// telemetry batches without ballooning memory.
    batch_size: usize,
}

impl<S, C> DrainTask<S, C>
where
    S: MqttPublishSink + 'static,
    C: BrokerConnectivity + 'static,
{
    pub fn new(sink: Arc<S>, connectivity: Arc<C>, queue: Arc<OfflineQueue>) -> Self {
        Self {
            sink,
            connectivity,
            queue,
            interval: Duration::from_secs(1),
            batch_size: 32,
        }
    }

    /// Configure the tick interval (test-only / specialized callers).
    pub fn with_interval(mut self, interval: Duration) -> Self {
        self.interval = interval;
        self
    }

    /// Configure the per-tick batch size.
    pub fn with_batch_size(mut self, batch_size: usize) -> Self {
        self.batch_size = batch_size;
        self
    }

    /// One drain pass. Public so tests + the production wire can
    /// invoke a single drain without spinning up the background
    /// loop. Returns the structured outcome.
    pub async fn drain_once(&self) -> DrainOutcome {
        if !self.connectivity.is_connected() {
            return DrainOutcome::Skipped;
        }

        // EDGE-HIGH-014: peek is blocking SQLCipher I/O — run it on the
        // blocking pool so the drain loop never stalls a tokio worker.
        let batch = {
            let queue = Arc::clone(&self.queue);
            let batch_size = self.batch_size;
            match tokio::task::spawn_blocking(move || queue.peek_batch(batch_size)).await {
                Ok(Ok(b)) => b,
                Ok(Err(e)) => return DrainOutcome::QueueError(e.to_string()),
                Err(e) => return DrainOutcome::QueueError(format!("spawn_blocking join: {}", e)),
            }
        };

        if batch.is_empty() {
            return DrainOutcome::Empty;
        }

        let total = batch.len();
        let mut to_ack: Vec<i64> = Vec::with_capacity(total);

        for msg in batch {
            match self
                .sink
                .publish_to_broker(&msg.topic, msg.payload.as_bytes(), msg.qos, msg.retain)
                .await
            {
                Ok(()) => to_ack.push(msg.id),
                Err(PublishSinkError::Disconnected) => {
                    // Broker dropped mid-drain. Stop here — un-acked
                    // messages stay in the queue for the next
                    // reconnect cycle.
                    break;
                }
                Err(PublishSinkError::Transport(e)) => {
                    tracing::warn!(
                        "drain stopped: transport error replaying message {}: {}",
                        msg.id,
                        e
                    );
                    break;
                }
            }
        }

        let sent = to_ack.len();
        if sent > 0 {
            // EDGE-HIGH-014: ack is blocking SQLCipher I/O — offload it.
            let queue = Arc::clone(&self.queue);
            let ack_result = tokio::task::spawn_blocking(move || queue.ack_batch(&to_ack)).await;
            match ack_result {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => {
                    // Ack failure is annoying but safe: messages stay
                    // in the queue and will be re-published next tick.
                    // Idempotent at the broker side (QoS-1 dedup) for
                    // typical brokers; QoS-0 sees a dup but no
                    // correctness issue.
                    tracing::warn!("drain ack_batch failed for {} messages: {}", sent, e);
                }
                Err(e) => {
                    tracing::warn!("drain ack_batch spawn_blocking join failed: {}", e);
                }
            }
        }

        DrainOutcome::Drained {
            sent,
            remaining: total - sent,
        }
    }

    /// Run the drain loop until `shutdown` fires. Spawned by
    /// production boot; tests call `drain_once` directly to avoid
    /// the timing dependency.
    pub async fn run(self, mut shutdown: tokio::sync::oneshot::Receiver<()>) {
        loop {
            tokio::select! {
                _ = &mut shutdown => {
                    tracing::info!("DrainTask received shutdown — exiting");
                    return;
                }
                _ = tokio::time::sleep(self.interval) => {
                    let _ = self.drain_once().await;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    /// Test-only mock sink. Tracks calls + can return injected
    /// errors deterministically.
    struct MockSink {
        publishes: AtomicUsize,
        next_error: std::sync::Mutex<Option<PublishSinkError>>,
    }

    impl MockSink {
        fn new() -> Self {
            Self {
                publishes: AtomicUsize::new(0),
                next_error: std::sync::Mutex::new(None),
            }
        }

        fn arm_error(&self, err: PublishSinkError) {
            *self.next_error.lock().unwrap() = Some(err);
        }

        fn publish_count(&self) -> usize {
            self.publishes.load(Ordering::Acquire)
        }
    }

    #[async_trait]
    impl MqttPublishSink for MockSink {
        async fn publish_to_broker(
            &self,
            _topic: &str,
            _payload: &[u8],
            _qos: u8,
            _retain: bool,
        ) -> Result<(), PublishSinkError> {
            self.publishes.fetch_add(1, Ordering::Release);
            if let Some(e) = self.next_error.lock().unwrap().take() {
                return Err(e);
            }
            Ok(())
        }
    }

    /// Test-only mock connectivity flag. Atomic so we can flip
    /// from another thread / between awaits.
    struct MockConnectivity(AtomicBool);

    impl MockConnectivity {
        fn new(connected: bool) -> Self {
            Self(AtomicBool::new(connected))
        }

        fn set(&self, connected: bool) {
            self.0.store(connected, Ordering::Release);
        }
    }

    impl BrokerConnectivity for MockConnectivity {
        fn is_connected(&self) -> bool {
            self.0.load(Ordering::Acquire)
        }
    }

    fn tmp_queue() -> Arc<OfflineQueue> {
        let path = std::env::temp_dir().join(format!(
            "outbound-pub-test-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        Arc::new(OfflineQueue::new(&path, 1000, 3600).expect("queue open"))
    }

    #[tokio::test]
    async fn broker_up_publishes_directly() {
        let sink = Arc::new(MockSink::new());
        let conn = Arc::new(MockConnectivity::new(true));
        let queue = tmp_queue();
        let pub_ = OutboundPublisher::new(sink.clone(), conn, queue.clone());

        let outcome = pub_
            .publish(
                "tenants/x/devices/y/telemetry",
                br#"{"t":1}"#,
                MessagePriority::Normal,
                1,
                false,
            )
            .await
            .expect("publish");

        assert_eq!(outcome, PublishOutcome::Sent);
        assert_eq!(sink.publish_count(), 1);
        // Queue stays empty — broker accepted the message.
        let stats = queue.stats().expect("stats");
        assert_eq!(stats.total_messages, 0);
    }

    #[tokio::test]
    async fn broker_down_queues_message() {
        let sink = Arc::new(MockSink::new());
        let conn = Arc::new(MockConnectivity::new(false));
        let queue = tmp_queue();
        let pub_ = OutboundPublisher::new(sink.clone(), conn, queue.clone());

        let outcome = pub_
            .publish(
                "tenants/x/devices/y/alarm",
                br#"{"alarm":"o2_low"}"#,
                MessagePriority::Critical,
                1,
                false,
            )
            .await
            .expect("publish");

        match outcome {
            PublishOutcome::Queued { message_id } => assert!(message_id > 0),
            other => panic!("expected Queued, got {:?}", other),
        }
        // Sink was NOT called — broker known down, skipped the round-trip.
        assert_eq!(sink.publish_count(), 0);
        let stats = queue.stats().expect("stats");
        assert_eq!(stats.total_messages, 1);
    }

    #[tokio::test]
    async fn disconnect_race_falls_through_to_queue() {
        // Connectivity says "up" but the sink immediately returns
        // Disconnected (broker dropped between check and write).
        let sink = Arc::new(MockSink::new());
        sink.arm_error(PublishSinkError::Disconnected);
        let conn = Arc::new(MockConnectivity::new(true));
        let queue = tmp_queue();
        let pub_ = OutboundPublisher::new(sink.clone(), conn, queue.clone());

        let outcome = pub_
            .publish(
                "tenants/x/devices/y/status",
                br#"{"status":"online"}"#,
                MessagePriority::High,
                1,
                false,
            )
            .await
            .expect("publish");

        // Sink WAS called once (the broker drop happens during the
        // call) AND the message was queued.
        assert_eq!(sink.publish_count(), 1);
        match outcome {
            PublishOutcome::Queued { .. } => {}
            other => panic!("expected Queued (race fall-through), got {:?}", other),
        }
        let stats = queue.stats().expect("stats");
        assert_eq!(stats.total_messages, 1);
    }

    #[tokio::test]
    async fn non_disconnect_transport_error_propagates() {
        // Connectivity up + sink returns a non-Disconnect error
        // (e.g., topic ACL rejection). This is NOT a queue
        // candidate — payload was rejected by the broker, not
        // dropped by transport.
        let sink = Arc::new(MockSink::new());
        sink.arm_error(PublishSinkError::Transport("topic acl denied".to_string()));
        let conn = Arc::new(MockConnectivity::new(true));
        let queue = tmp_queue();
        let pub_ = OutboundPublisher::new(sink.clone(), conn, queue.clone());

        let err = pub_
            .publish(
                "tenants/x/devices/y/forbidden",
                br#"{}"#,
                MessagePriority::Normal,
                1,
                false,
            )
            .await
            .expect_err("should propagate");

        match err {
            OutboundError::TransportError(msg) => {
                assert!(msg.contains("acl"));
            }
            other => panic!("wrong variant: {:?}", other),
        }
        // Queue stays empty — error path does NOT enqueue.
        let stats = queue.stats().expect("stats");
        assert_eq!(stats.total_messages, 0);
    }

    #[tokio::test]
    async fn priority_passed_through_to_queue() {
        let sink = Arc::new(MockSink::new());
        let conn = Arc::new(MockConnectivity::new(false)); // forces queue path
        let queue = tmp_queue();
        let pub_ = OutboundPublisher::new(sink, conn, queue.clone());

        // Three messages at distinct priorities → each persists
        // with the priority intact.
        for (priority, topic) in [
            (MessagePriority::Low, "low"),
            (MessagePriority::High, "high"),
            (MessagePriority::Critical, "crit"),
        ] {
            pub_.publish(topic, b"x", priority, 1, false)
                .await
                .expect("publish");
        }

        let stats = queue.stats().expect("stats");
        assert_eq!(stats.total_messages, 3);
        // by_priority array indices: Low=0, Normal=1, High=2, Critical=3.
        assert_eq!(stats.by_priority[0], 1); // low
        assert_eq!(stats.by_priority[2], 1); // high
        assert_eq!(stats.by_priority[3], 1); // critical
    }

    #[tokio::test]
    async fn non_utf8_payload_rejected_when_queue_path_taken() {
        let sink = Arc::new(MockSink::new());
        let conn = Arc::new(MockConnectivity::new(false));
        let queue = tmp_queue();
        let pub_ = OutboundPublisher::new(sink, conn, queue);

        // Invalid UTF-8 byte sequence (lone continuation byte 0x80).
        let bad_payload = &[0xFFu8, 0xFE, 0xFD][..];

        let err = pub_
            .publish("topic", bad_payload, MessagePriority::Normal, 1, false)
            .await
            .expect_err("should reject");

        match err {
            OutboundError::PayloadNotUtf8 => {}
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn publisher_is_send_sync() {
        // The dispatcher is shared across the async runtime —
        // must be Send + Sync.
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<OutboundPublisher<MockSink, MockConnectivity>>();
    }

    // ========================================================
    // DrainTask — Batch #252 ARC-002 part 2
    // ========================================================

    /// Mock sink that fails the Nth publish (1-indexed) with
    /// `Disconnected`, succeeding for all earlier publishes. Used
    /// to test mid-drain disconnect handling.
    struct DropAfterNSink {
        publishes: AtomicUsize,
        drop_after: usize,
    }

    #[async_trait]
    impl MqttPublishSink for DropAfterNSink {
        async fn publish_to_broker(
            &self,
            _topic: &str,
            _payload: &[u8],
            _qos: u8,
            _retain: bool,
        ) -> Result<(), PublishSinkError> {
            let n = self.publishes.fetch_add(1, Ordering::Release) + 1;
            if n > self.drop_after {
                return Err(PublishSinkError::Disconnected);
            }
            Ok(())
        }
    }

    fn enqueue_n(queue: &Arc<OfflineQueue>, count: usize, priority: MessagePriority) {
        for i in 0..count {
            queue
                .enqueue(
                    &format!("topic/{}", i),
                    &format!(r#"{{"i":{}}}"#, i),
                    priority,
                    1,
                    false,
                )
                .expect("enqueue");
        }
    }

    #[tokio::test]
    async fn drain_once_empty_queue_returns_empty() {
        let sink = Arc::new(MockSink::new());
        let conn = Arc::new(MockConnectivity::new(true));
        let queue = tmp_queue();
        let task = DrainTask::new(sink, conn, queue);

        match task.drain_once().await {
            DrainOutcome::Empty => {}
            other => panic!("wrong outcome: {:?}", other),
        }
    }

    #[tokio::test]
    async fn drain_once_skips_when_broker_down() {
        let sink = Arc::new(MockSink::new());
        let conn = Arc::new(MockConnectivity::new(false));
        let queue = tmp_queue();
        enqueue_n(&queue, 3, MessagePriority::Normal);

        let task = DrainTask::new(sink.clone(), conn, queue.clone());
        match task.drain_once().await {
            DrainOutcome::Skipped => {}
            other => panic!("wrong outcome: {:?}", other),
        }
        // Sink not called, queue unchanged.
        assert_eq!(sink.publish_count(), 0);
        assert_eq!(queue.stats().unwrap().total_messages, 3);
    }

    #[tokio::test]
    async fn drain_once_replays_and_acks_full_batch() {
        let sink = Arc::new(MockSink::new());
        let conn = Arc::new(MockConnectivity::new(true));
        let queue = tmp_queue();
        enqueue_n(&queue, 5, MessagePriority::Normal);

        let task = DrainTask::new(sink.clone(), conn, queue.clone()).with_batch_size(10);

        match task.drain_once().await {
            DrainOutcome::Drained { sent, remaining } => {
                assert_eq!(sent, 5);
                assert_eq!(remaining, 0);
            }
            other => panic!("wrong outcome: {:?}", other),
        }
        assert_eq!(sink.publish_count(), 5);
        assert_eq!(queue.stats().unwrap().total_messages, 0);
    }

    #[tokio::test]
    async fn drain_once_respects_batch_size_limit() {
        let sink = Arc::new(MockSink::new());
        let conn = Arc::new(MockConnectivity::new(true));
        let queue = tmp_queue();
        enqueue_n(&queue, 10, MessagePriority::Normal);

        // Drain 3 at a time.
        let task = DrainTask::new(sink.clone(), conn, queue.clone()).with_batch_size(3);

        match task.drain_once().await {
            DrainOutcome::Drained { sent, remaining } => {
                assert_eq!(sent, 3);
                assert_eq!(remaining, 0); // remaining IN THIS BATCH
            }
            other => panic!("wrong outcome: {:?}", other),
        }
        // 7 still in queue, will be picked up next tick.
        assert_eq!(queue.stats().unwrap().total_messages, 7);
    }

    #[tokio::test]
    async fn drain_once_preserves_uncacked_on_mid_batch_disconnect() {
        // Sink succeeds for first 2 publishes, then disconnects.
        // Of the 5-message batch, 2 should be acked + removed; 3
        // should remain in the queue for the next reconnect cycle.
        let sink = Arc::new(DropAfterNSink {
            publishes: AtomicUsize::new(0),
            drop_after: 2,
        });
        let conn = Arc::new(MockConnectivity::new(true));
        let queue = tmp_queue();
        enqueue_n(&queue, 5, MessagePriority::Normal);

        let task = DrainTask::new(sink, conn, queue.clone()).with_batch_size(5);

        match task.drain_once().await {
            DrainOutcome::Drained { sent, remaining } => {
                assert_eq!(sent, 2);
                assert_eq!(remaining, 3);
            }
            other => panic!("wrong outcome: {:?}", other),
        }
        // 3 messages remain queued.
        assert_eq!(queue.stats().unwrap().total_messages, 3);
    }

    #[tokio::test]
    async fn drain_once_priority_order_critical_first() {
        // Mix of priorities — drain order should be Critical
        // first, then High, Normal, Low (per `peek_batch` SQL
        // `ORDER BY priority DESC`).
        let sink = Arc::new(MockSink::new());
        let conn = Arc::new(MockConnectivity::new(true));
        let queue = tmp_queue();

        // Insert in NON-priority order to verify the SQL re-orders.
        queue
            .enqueue("low/1", "x", MessagePriority::Low, 1, false)
            .unwrap();
        queue
            .enqueue("crit/1", "x", MessagePriority::Critical, 1, false)
            .unwrap();
        queue
            .enqueue("normal/1", "x", MessagePriority::Normal, 1, false)
            .unwrap();
        queue
            .enqueue("high/1", "x", MessagePriority::High, 1, false)
            .unwrap();

        // Drain only 2 (smallest batch that proves ordering).
        let task = DrainTask::new(sink.clone(), conn, queue.clone()).with_batch_size(2);

        let _ = task.drain_once().await;

        // After draining batch_size=2, the 2 highest-priority
        // messages (Critical + High) should be acked. The Normal
        // + Low ones remain.
        assert_eq!(queue.stats().unwrap().total_messages, 2);
        let remaining = queue.peek_batch(10).unwrap();
        for msg in &remaining {
            assert!(
                matches!(msg.priority, MessagePriority::Normal | MessagePriority::Low),
                "Expected Normal/Low to remain, got {:?}",
                msg.priority
            );
        }
    }

    #[tokio::test]
    async fn drain_run_exits_on_shutdown_signal() {
        let sink = Arc::new(MockSink::new());
        let conn = Arc::new(MockConnectivity::new(true));
        let queue = tmp_queue();
        let task = DrainTask::new(sink, conn, queue).with_interval(Duration::from_millis(50));

        let (tx, rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(task.run(rx));

        // Let the loop tick a couple of times.
        tokio::time::sleep(Duration::from_millis(120)).await;

        // Send shutdown.
        let _ = tx.send(());

        // The task must exit promptly (within one tick interval).
        match tokio::time::timeout(Duration::from_millis(200), handle).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => panic!("task panicked: {:?}", e),
            Err(_) => panic!("task did not exit within shutdown deadline"),
        }
    }

    #[tokio::test]
    async fn drain_run_drops_when_sender_dropped() {
        // Same as the explicit shutdown signal but the channel is
        // CLOSED via Sender drop, not fired. The receiver returns
        // Err(_) which the task treats identically.
        let sink = Arc::new(MockSink::new());
        let conn = Arc::new(MockConnectivity::new(true));
        let queue = tmp_queue();
        let task = DrainTask::new(sink, conn, queue).with_interval(Duration::from_millis(50));

        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let handle = tokio::spawn(task.run(rx));

        tokio::time::sleep(Duration::from_millis(120)).await;
        drop(tx);

        match tokio::time::timeout(Duration::from_millis(200), handle).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => panic!("task panicked: {:?}", e),
            Err(_) => panic!("task did not exit on sender drop"),
        }
    }

    #[tokio::test]
    async fn drain_round_trip_with_outbound_publisher() {
        // Integration-style: simulate broker outage during enqueue,
        // then come back up + drain. End-to-end: queue grows,
        // drains, queue empties.
        let sink = Arc::new(MockSink::new());
        let conn = Arc::new(MockConnectivity::new(false)); // start down
        let queue = tmp_queue();

        let publisher = OutboundPublisher::new(sink.clone(), conn.clone(), queue.clone());

        // Publish 4 messages while broker is down — all queue.
        for i in 0..4 {
            publisher
                .publish(&format!("t/{}", i), b"x", MessagePriority::Normal, 1, false)
                .await
                .unwrap();
        }
        assert_eq!(queue.stats().unwrap().total_messages, 4);
        assert_eq!(sink.publish_count(), 0);

        // Broker comes back up.
        conn.set(true);

        // Drain.
        let drain = DrainTask::new(sink.clone(), conn.clone(), queue.clone()).with_batch_size(10);
        match drain.drain_once().await {
            DrainOutcome::Drained { sent, remaining } => {
                assert_eq!(sent, 4);
                assert_eq!(remaining, 0);
            }
            other => panic!("wrong outcome: {:?}", other),
        }

        // Sink saw all 4, queue is empty.
        assert_eq!(sink.publish_count(), 4);
        assert_eq!(queue.stats().unwrap().total_messages, 0);
    }

    #[tokio::test]
    async fn connectivity_flip_within_one_publisher_changes_path() {
        // Single publisher instance observed across two publishes
        // with connectivity flipped between them — first goes to
        // broker, second goes to queue.
        let sink = Arc::new(MockSink::new());
        let conn = Arc::new(MockConnectivity::new(true));
        let queue = tmp_queue();
        let pub_ = OutboundPublisher::new(sink.clone(), conn.clone(), queue.clone());

        pub_.publish("t1", b"first", MessagePriority::Normal, 1, false)
            .await
            .expect("first publish");
        assert_eq!(sink.publish_count(), 1);

        // Flip connectivity to down.
        conn.set(false);

        pub_.publish("t2", b"second", MessagePriority::Normal, 1, false)
            .await
            .expect("second publish");
        // Sink still at 1 — second publish skipped the broker.
        assert_eq!(sink.publish_count(), 1);

        let stats = queue.stats().expect("stats");
        assert_eq!(stats.total_messages, 1);
    }
}
