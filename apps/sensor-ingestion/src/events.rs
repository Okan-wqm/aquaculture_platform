//! NATS event publisher behind an [`EventPublisher`] trait — Faz 2 stage 12.
//!
//! WHY this module exists:
//!   ADR-025 Faz 2 names the Rust ingestion sidecar as a co-equal
//!   producer of `SensorReading` events alongside the existing NestJS
//!   `sensor-service`. Downstream consumers (alert-engine, AI service,
//!   audit) MUST not be able to tell the producer apart. The wire
//!   format is `event-contracts-rs::SensorReadingEvent` — same
//!   camelCase keys, same flat shape (ADR-006), same branded
//!   `eventId` — and the subject convention mirrors
//!   `platform/libs/event-bus/src/nats/nats-event-bus.ts:310-312`
//!   `deriveSubject` byte-for-byte: `events.{tenantId}.{eventType}`.
//!   The single JetStream stream `events.>` therefore captures both
//!   producers transparently.
//!
//! WHY the [`EventPublisher`] trait:
//!   Mirrors [`crate::persistence::BatchSink`]. The drain pipeline
//!   stays unaware of the concrete publisher, which makes:
//!     * stub-mode boot trivial — `LoggingEventPublisher` accepts every
//!       call and counts it, so the sidecar boots clean without a
//!       broker for local smoke runs;
//!     * unit tests trivial — the [`LoggingEventPublisher`] records the
//!       last event for assertion-based tests, [`FailingPublisher`]
//!       (test-only) lets us pin loop-survives-publish-error semantics.
//!   The two implementations share zero code paths with the production
//!   `NatsEventPublisher`, so no test-only behaviour can leak into the
//!   prod binary.
//!
//! WHY mTLS-only construction:
//!   The constructor [`NatsEventPublisher::connect`] takes a
//!   [`nats_client::MtlsConfig`] and forwards to
//!   [`nats_client::NatsClient::connect`]. There is structurally NO
//!   construction path that omits the client cert: the upstream factory
//!   does not expose `with_user_pass` / `with_token`, and this module
//!   neither shadows nor bypasses it. ADR-014/015 cert-is-identity is
//!   enforced one architectural layer down, and we depend on it.
//!
//! WHY `run_publisher_loop` continues after a publish error:
//!   A single publish failure is a recoverable broker-side hiccup
//!   (transient disconnect, flaky network, momentary backpressure
//!   beyond the connection's pacer). Tearing down the whole publisher
//!   loop on the first failure would take the entire sidecar's event
//!   side offline for the next reconnect window. Errors are logged at
//!   `error` level so an operator alarm fires; the loop iterates to
//!   the next message. The `run_publisher_loop_continues_after_publish_error`
//!   test pins this behaviour so a future refactor cannot regress it.

use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use thiserror::Error;
use tokio::sync::{Mutex, mpsc};
use tracing::instrument;

use event_contracts_rs::{SENSOR_READING_EVENT_TYPE, SensorReadingEvent};

/// Errors raised by [`EventPublisher`] implementations.
#[derive(Debug, Error)]
pub enum EventPublisherError {
    /// Connect-time failure (TLS material missing, handshake failed,
    /// invalid URL scheme). Distinct from [`Self::Publish`] because the
    /// remediation differs — a connect failure is a config / cert
    /// problem; a publish failure is usually transient.
    #[error("NATS event publisher connect failed")]
    Connect(#[source] nats_client::NatsClientError),

    /// Publish-side failure (broker rejected, queue full, TLS
    /// renegotiation in flight, etc.).
    #[error("NATS event publisher publish failed")]
    Publish(#[source] nats_client::NatsClientError),

    /// `serde_json::to_vec(&event)` failed. In practice the only way
    /// this fires is OOM (the `SensorReadingEvent` shape itself cannot
    /// produce an `Error` from serde at runtime), but typing it
    /// distinctly keeps the loop's error log faithful.
    #[error("event serialise failed")]
    Encode(#[source] serde_json::Error),
}

/// Async event-publisher trait. Implementations:
///   - [`NatsEventPublisher`] — production, wraps [`nats_client::NatsClient`].
///   - [`LoggingEventPublisher`] — stub-mode + unit tests.
#[async_trait]
pub trait EventPublisher: Send + Sync {
    /// Publish a single sensor-reading event. Implementations encode
    /// to JSON, derive the `events.{tenantId}.{eventType}` subject,
    /// and send the bytes downstream. Whole-event atomicity — partial
    /// publication is not a thing the upstream broker exposes.
    async fn publish_sensor_reading(
        &self,
        ev: SensorReadingEvent,
    ) -> Result<(), EventPublisherError>;
}

/// Pure helper that derives the NATS subject for a sensor-reading
/// event. Mirrors the TS `deriveSubject` SSoT at
/// `platform/libs/event-bus/src/nats/nats-event-bus.ts:310-312`:
///   `events.{tenantId}.{eventType}`
///
/// The subject format is pinned by the
/// `subject_uses_tenant_uuid_lowercase_hyphenated` test — accidentally
/// reformatting the subject (e.g. swapping `.` for `_`, dropping a
/// segment, using uppercase hex) is detected at build time.
#[must_use]
pub fn subject_for(ev: &SensorReadingEvent) -> String {
    // `Uuid::Display` writes lower-case hyphenated, matching the TS
    // side's `tenantId` UUID `String` representation. `eventType` is the
    // `SENSOR_READING_EVENT_TYPE` const so the literal "SensorReading"
    // is the only possible second segment for this event family.
    format!("events.{}.{}", ev.tenant_id, SENSOR_READING_EVENT_TYPE)
}

// -----------------------------------------------------------------
// NatsEventPublisher — production, mTLS-only via nats-client.
// -----------------------------------------------------------------

/// Production [`EventPublisher`] backed by [`nats_client::NatsClient`].
/// Cheap to clone (the inner `NatsClient` is itself `Clone`), so
/// callers can share one publisher across many tasks.
#[derive(Debug, Clone)]
pub struct NatsEventPublisher {
    client: Arc<nats_client::NatsClient>,
}

impl NatsEventPublisher {
    /// Establish an mTLS connection to the broker and return a wrapper
    /// ready to publish. The constructor probes the connection eagerly
    /// (the underlying `nats-client` factory completes the TLS
    /// handshake before returning), so a misconfiguration surfaces at
    /// startup rather than at the first event.
    ///
    /// # Errors
    /// - [`EventPublisherError::Connect`] — TLS material unreadable,
    ///   broker unreachable, or the URL scheme is not `nats://` /
    ///   `tls://`.
    pub async fn connect(cfg: &nats_client::MtlsConfig) -> Result<Self, EventPublisherError> {
        let client = nats_client::NatsClient::connect(cfg)
            .await
            .map_err(EventPublisherError::Connect)?;
        Ok(Self {
            client: Arc::new(client),
        })
    }
}

#[async_trait]
impl EventPublisher for NatsEventPublisher {
    #[instrument(skip(self, ev), fields(tenant_id = %ev.tenant_id, sensor_id = %ev.sensor_id))]
    async fn publish_sensor_reading(
        &self,
        ev: SensorReadingEvent,
    ) -> Result<(), EventPublisherError> {
        let subject = subject_for(&ev);
        let json = ev.to_json_bytes().map_err(EventPublisherError::Encode)?;
        // Bytes::from copies the Vec<u8> into an Arc-backed buffer so
        // async-nats can ship it without a second allocation; this
        // matches how the upstream `Subject + Bytes` API expects
        // payload ownership.
        self.client
            .publish(subject, Bytes::from(json))
            .await
            .map_err(EventPublisherError::Publish)?;
        Ok(())
    }
}

// -----------------------------------------------------------------
// LoggingEventPublisher — stub-mode boot AND unit tests.
// -----------------------------------------------------------------

/// Test-grade publisher that records every call. Cheap to clone; the
/// inner state is `Arc`-wrapped so concurrent tasks see consistent
/// counters. Used by:
///   * the binary's stub-mode boot when `[nats]` is absent in config,
///   * unit tests that assert publish-call shape and frequency.
#[derive(Debug, Default, Clone)]
pub struct LoggingEventPublisher {
    count: Arc<std::sync::atomic::AtomicU64>,
    last_event: Arc<Mutex<Option<SensorReadingEvent>>>,
}

impl LoggingEventPublisher {
    /// Construct a fresh publisher with zero counters.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of `publish_sensor_reading` calls observed.
    ///
    /// Used by:
    ///   * the boot-time [`self_smoke_check`] to verify that the
    ///     publisher path actually moved the counter,
    ///   * unit tests that pin call frequency.
    ///
    /// Production code observes publish flow primarily through tracing
    /// spans; this counter is the smoke-check-grade signal, not a
    /// metric.
    #[must_use]
    pub fn count(&self) -> u64 {
        self.count.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Last event received, if any. Test-only accessor — production
    /// code never inspects in-flight events outside the tracing span.
    #[cfg(test)]
    pub async fn last_event(&self) -> Option<SensorReadingEvent> {
        self.last_event.lock().await.clone()
    }

    /// Reset the counter and clear the last event. Used by
    /// [`self_smoke_check`] so the steady-state publisher state is
    /// observably zero at the moment the message loop starts.
    pub async fn reset(&self) {
        self.count.store(0, std::sync::atomic::Ordering::Relaxed);
        *self.last_event.lock().await = None;
    }
}

#[async_trait]
impl EventPublisher for LoggingEventPublisher {
    #[instrument(skip(self, ev), fields(tenant_id = %ev.tenant_id, sensor_id = %ev.sensor_id))]
    async fn publish_sensor_reading(
        &self,
        ev: SensorReadingEvent,
    ) -> Result<(), EventPublisherError> {
        self.count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        // Log at debug; the boot-time self_smoke_check + integration
        // tests are the load-bearing observers, not the log line.
        tracing::debug!(
            tenant_id = %ev.tenant_id,
            sensor_id = %ev.sensor_id,
            event_id = %ev.event_id,
            "logging event publisher received event"
        );
        *self.last_event.lock().await = Some(ev);
        Ok(())
    }
}

// -----------------------------------------------------------------
// run_publisher_loop — drain channel into publisher.
// -----------------------------------------------------------------

/// Receive events from a `mpsc::Receiver` and feed each one to the
/// supplied [`EventPublisher`]. Returns when the receiver closes.
/// Mirrors [`crate::persistence::run_sink_loop`] in shape.
///
/// A publish error is logged at `error` level and the loop iterates
/// to the next event — single transient failures must not poison the
/// publisher. The
/// `run_publisher_loop_continues_after_publish_error` test pins this
/// behaviour.
pub async fn run_publisher_loop(
    publisher: Arc<dyn EventPublisher>,
    mut rx: mpsc::Receiver<SensorReadingEvent>,
) {
    while let Some(ev) = rx.recv().await {
        if let Err(e) = publisher.publish_sensor_reading(ev).await {
            tracing::error!(error = %e, "event publisher publish failed");
        }
    }
    tracing::info!("event publisher loop exited (channel closed)");
}

// -----------------------------------------------------------------
// self_smoke_check — process-startup smoke check.
// -----------------------------------------------------------------

/// Process-startup smoke check that exercises the publisher's public
/// surface with a single ephemeral event. Used by `main` to:
///   * fail fast on any publisher-side configuration bug that survived
///     the type system (the call shape is the same regardless of
///     concrete publisher),
///   * keep the binary's dead-code lint honest about the publish path
///     before stage 13 wires the per-message channel→reading_* mapping.
///
/// Behaviour by publisher type:
///   * [`LoggingEventPublisher`]: publishes one synthesised event,
///     asserts the count moved, then [`LoggingEventPublisher::reset`]s
///     so steady-state is observably zero.
///   * [`NatsEventPublisher`]: would round-trip through the real
///     broker. We skip the live publish during boot so a momentarily
///     unreachable broker does not block the sidecar from coming up;
///     the connect probe inside [`NatsEventPublisher::connect`] is
///     sufficient to surface "broker is unreachable RIGHT NOW" at
///     startup.
///
/// Returns `Ok(())` on success; the caller (boot path) treats `Err`
/// as a fatal startup error.
///
/// # Errors
/// Propagates [`EventPublisherError`] from the synthesised publish.
pub async fn self_smoke_check(
    publisher: &Arc<dyn EventPublisher>,
    logging_handle: Option<&LoggingEventPublisher>,
) -> Result<(), EventPublisherError> {
    if let Some(handle) = logging_handle {
        let ev = SensorReadingEvent::new(uuid::Uuid::nil(), uuid::Uuid::nil());
        publisher.publish_sensor_reading(ev).await?;
        debug_assert!(
            handle.count() >= 1,
            "logging publisher must observe the smoke event"
        );
        handle.reset().await;
        tracing::debug!("event publisher self-smoke check complete (logging mode)");
    } else {
        // NatsEventPublisher path: connect probe already happened in
        // ::connect; no live publish during boot to avoid coupling
        // sidecar startup to broker availability beyond the handshake.
        tracing::debug!("event publisher self-smoke check skipped (nats mode)");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    use async_trait::async_trait;
    use tokio::sync::mpsc;
    use uuid::Uuid;

    use super::{
        EventPublisher, EventPublisherError, LoggingEventPublisher, run_publisher_loop,
        self_smoke_check, subject_for,
    };
    use event_contracts_rs::SensorReadingEvent;

    fn fixed_uuid(seed: u8) -> Uuid {
        let mut bytes = [0_u8; 16];
        bytes[0] = seed;
        Uuid::from_bytes(bytes)
    }

    fn synthesise_event() -> SensorReadingEvent {
        let mut ev = SensorReadingEvent::new(fixed_uuid(0xAA), fixed_uuid(0xBB));
        ev.reading_temperature = Some(24.5);
        ev
    }

    // -----------------------------------------------------------
    // Error-variant Display sanity.
    // -----------------------------------------------------------

    #[test]
    fn event_publisher_error_variants_distinct() {
        // Encode is the only variant we can construct without an
        // upstream nats-client error in scope; assert its Display is
        // non-empty AND that the source-chain points back to serde.
        let bad: serde_json::Error = serde_json::from_str::<u8>("not a number").unwrap_err();
        let err = EventPublisherError::Encode(bad);
        let s = err.to_string();
        assert!(!s.is_empty());
        // std::error::Error::source must surface the inner serde error
        // so operators can see the root cause through the chain.
        let src = std::error::Error::source(&err);
        assert!(src.is_some(), "Encode variant must expose serde source");
    }

    // -----------------------------------------------------------
    // LoggingEventPublisher core behaviour.
    // -----------------------------------------------------------

    #[tokio::test]
    async fn logging_publisher_records_event() {
        let pub_ = LoggingEventPublisher::new();
        let ev = synthesise_event();
        let expected = ev.clone();
        pub_.publish_sensor_reading(ev).await.unwrap();
        assert_eq!(pub_.count(), 1);
        assert_eq!(pub_.last_event().await, Some(expected));
    }

    #[tokio::test]
    async fn logging_publisher_concurrent_safe() {
        // 100 tasks each publish exactly one event; the count must
        // settle at 100. Pins that the AtomicU64 + Mutex<Option>
        // combination is race-free under contention.
        let pub_ = Arc::new(LoggingEventPublisher::new());
        let mut handles = Vec::with_capacity(100);
        for _ in 0..100 {
            let p = Arc::clone(&pub_);
            let ev = synthesise_event();
            handles.push(tokio::spawn(async move {
                p.publish_sensor_reading(ev).await.unwrap();
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        assert_eq!(pub_.count(), 100);
        // last_event is whichever task wrote most recently — it must
        // be SOME, but we cannot pin which.
        assert!(pub_.last_event().await.is_some());
    }

    #[tokio::test]
    async fn logging_publisher_reset_clears_state() {
        let pub_ = LoggingEventPublisher::new();
        pub_.publish_sensor_reading(synthesise_event())
            .await
            .unwrap();
        assert_eq!(pub_.count(), 1);
        assert!(pub_.last_event().await.is_some());
        pub_.reset().await;
        assert_eq!(pub_.count(), 0);
        assert!(pub_.last_event().await.is_none());
    }

    // -----------------------------------------------------------
    // Subject derivation — pins the TS-equivalent format.
    // -----------------------------------------------------------

    #[test]
    fn nats_subject_format_matches_ts_contract() {
        let ev = synthesise_event();
        let s = subject_for(&ev);
        // Exactly 3 dot-separated segments: `events`, the tenant UUID
        // (hyphens internal to the UUID are NOT dot separators), and
        // the eventType. The TS deriveSubject SSoT produces the same
        // three segments — the JetStream `events.>` stream and the
        // wildcard subscriber `events.*.SensorReading` both depend on
        // this segment count being exactly 3.
        let parts: Vec<&str> = s.split('.').collect();
        assert_eq!(
            parts.len(),
            3,
            "expected 3 dot-segments (events.<tenant-uuid>.SensorReading), got: {s}"
        );
        // First segment is the `events.>` JetStream prefix.
        assert_eq!(parts.first(), Some(&"events"));
        // Last segment is the eventType discriminator.
        assert_eq!(parts.last(), Some(&"SensorReading"));
        // Middle segment must round-trip through Uuid::parse_str —
        // pins that we did not accidentally strip the hyphens.
        let middle = parts.get(1).expect("3-segment split yields a middle");
        let parsed = Uuid::parse_str(middle).expect("middle segment must be a valid UUID");
        assert_eq!(parsed, ev.tenant_id);
    }

    #[test]
    fn subject_uses_tenant_uuid_lowercase_hyphenated() {
        // Construct an event with a fixed UUID we can pin against.
        let tenant = Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();
        let sensor = Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap();
        let ev = SensorReadingEvent::new(tenant, sensor);
        let s = subject_for(&ev);
        assert_eq!(
            s, "events.11111111-1111-1111-1111-111111111111.SensorReading",
            "subject does not match TS deriveSubject contract; the JetStream events.> stream and downstream consumers depend on this exact format"
        );
    }

    // -----------------------------------------------------------
    // run_publisher_loop — drain semantics.
    // -----------------------------------------------------------

    #[tokio::test]
    async fn run_publisher_loop_consumes_until_close() {
        let pub_ = Arc::new(LoggingEventPublisher::new());
        let counter = Arc::clone(&pub_);
        let pub_dyn: Arc<dyn EventPublisher> = pub_;
        let (tx, rx) = mpsc::channel::<SensorReadingEvent>(8);
        let handle = tokio::spawn(run_publisher_loop(pub_dyn, rx));

        tx.send(synthesise_event()).await.unwrap();
        tx.send(synthesise_event()).await.unwrap();
        tx.send(synthesise_event()).await.unwrap();
        drop(tx);

        handle.await.unwrap();
        assert_eq!(counter.count(), 3);
    }

    /// Publisher fixture that fails on a configurable iteration. Lives
    /// inside the tests module so it cannot accidentally be wired into
    /// the production binary.
    #[derive(Debug)]
    struct FailingPublisher {
        seen: Arc<AtomicU64>,
        fail_on: u64,
    }

    #[async_trait]
    impl EventPublisher for FailingPublisher {
        async fn publish_sensor_reading(
            &self,
            _ev: SensorReadingEvent,
        ) -> Result<(), EventPublisherError> {
            // fetch_add returns the PRE-increment value, so the first
            // call observes 0. We compare to fail_on (1-indexed in the
            // test naming) by incrementing and reading the new value.
            let n = self.seen.fetch_add(1, Ordering::Relaxed) + 1;
            if n == self.fail_on {
                let bad: serde_json::Error =
                    serde_json::from_str::<u8>("not a number").unwrap_err();
                Err(EventPublisherError::Encode(bad))
            } else {
                Ok(())
            }
        }
    }

    #[tokio::test]
    async fn run_publisher_loop_continues_after_publish_error() {
        // Feed 3 events; the publisher returns Err on the 2nd. The
        // loop must attempt all 3 (i.e. seen counter == 3), proving
        // a single publish error does not poison the loop.
        let seen = Arc::new(AtomicU64::new(0));
        let publisher: Arc<dyn EventPublisher> = Arc::new(FailingPublisher {
            seen: Arc::clone(&seen),
            fail_on: 2,
        });
        let (tx, rx) = mpsc::channel::<SensorReadingEvent>(8);
        let handle = tokio::spawn(run_publisher_loop(publisher, rx));

        tx.send(synthesise_event()).await.unwrap();
        tx.send(synthesise_event()).await.unwrap();
        tx.send(synthesise_event()).await.unwrap();
        drop(tx);

        handle.await.unwrap();
        assert_eq!(
            seen.load(Ordering::Relaxed),
            3,
            "loop must attempt every event even when a prior publish errored"
        );
    }

    // -----------------------------------------------------------
    // self_smoke_check — boot-time exerciser.
    // -----------------------------------------------------------

    #[tokio::test]
    async fn self_smoke_check_drains_logging_publisher_to_zero() {
        let logging = LoggingEventPublisher::new();
        let publisher: Arc<dyn EventPublisher> = Arc::new(logging.clone());
        self_smoke_check(&publisher, Some(&logging)).await.unwrap();
        // After self_smoke_check, the publisher MUST observe exactly
        // zero events (counter reset, last_event cleared) so the
        // steady-state visible to the message loop is clean.
        assert_eq!(logging.count(), 0);
        assert!(logging.last_event().await.is_none());
    }

    #[tokio::test]
    async fn self_smoke_check_nats_mode_skips_publish() {
        // No logging handle supplied — self_smoke_check must NOT
        // attempt a publish (the wrapped publisher would still record
        // it, so we use a logging publisher under the hood and assert
        // the count is still 0).
        let logging = LoggingEventPublisher::new();
        let publisher: Arc<dyn EventPublisher> = Arc::new(logging.clone());
        self_smoke_check(&publisher, None).await.unwrap();
        assert_eq!(
            logging.count(),
            0,
            "nats-mode smoke must not publish during boot"
        );
    }

    // -----------------------------------------------------------
    // Wire-format equivalence with event-contracts-rs round-trip.
    // -----------------------------------------------------------

    #[test]
    fn event_serialised_then_published_is_byte_equivalent_to_event_contracts_rs() {
        // The subject_for helper + ev.to_json_bytes() are the two
        // outputs of the publish path; assert the bytes round-trip
        // through SensorReadingEvent::from_json_bytes losslessly so a
        // downstream Rust subscriber sees the same event the publisher
        // shipped.
        let mut ev = SensorReadingEvent::new(fixed_uuid(0xAA), fixed_uuid(0xBB));
        ev.reading_temperature = Some(24.5);
        ev.reading_ph = Some(7.2);
        ev.reading_dissolved_oxygen = Some(8.1);
        ev.farm_id = Some(fixed_uuid(0xCC));

        let bytes = ev.to_json_bytes().unwrap();
        let back = SensorReadingEvent::from_json_bytes(&bytes).unwrap();
        assert_eq!(back, ev, "publish-side encode must round-trip");

        // The subject is derived from the same event; assert it carries
        // the lower-case hyphenated tenant uuid for downstream wildcard
        // routing (`events.<tenant>.SensorReading`).
        let subject = subject_for(&ev);
        assert!(subject.contains(&ev.tenant_id.to_string()));
        assert!(subject.ends_with(".SensorReading"));
    }

    /// Live-NATS integration test. Skipped by default; set
    /// `SENSOR_INGESTION_NATS_INTEGRATION=1` and ensure a NATS broker
    /// configured for mTLS-only auth (per ADR-014/015) is reachable to
    /// run it. The docker-compose service that brings up the broker
    /// for this test ships in stage 14 of the Faz 2 plan; until then
    /// the gate is the env var alone, mirroring the postgres
    /// `#[ignore]`d test in persistence.rs.
    #[tokio::test]
    #[ignore = "requires SENSOR_INGESTION_NATS_INTEGRATION=1 + reachable mTLS NATS broker; docker-compose service ships in stage 14"]
    async fn nats_event_publisher_live_smoke_publishes_to_real_broker() {
        if std::env::var("SENSOR_INGESTION_NATS_INTEGRATION").is_err() {
            return;
        }
        // Body intentionally minimal — the gate is the env var. A real
        // run wires up an MtlsConfig pointing at the test broker, calls
        // NatsEventPublisher::connect, publishes a synthesised event,
        // and a sibling subscriber in the same test asserts the bytes
        // match. Lands together with the docker-compose service in
        // stage 14.
    }
}
