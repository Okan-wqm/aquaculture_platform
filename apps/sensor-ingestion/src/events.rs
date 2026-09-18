//! NATS-backed [`OutboxPublisher`] — the sensor-ingestion side of
//! the ADR-029 Transactional Outbox.
//!
//! # Why this module exists (post-ADR-029 cut-over)
//!
//! Before Part 2d landed, sensor-ingestion emitted
//! `SensorMetricIngestedEvent` through an in-memory `mpsc` channel
//! drained by a dedicated `run_publisher_loop`. That shape could
//! drop events on two failure modes: process crash with events
//! queued in the channel, and NATS transient-unavailability with
//! the publisher logging + discarding. ADR-029 closes both gaps by
//! moving the publish intent into the same postgres transaction
//! that persists the metric row.
//!
//! This module is the "N" in "transport-agnostic outbox publisher":
//! it implements [`outbox_rs::OutboxPublisher`] over
//! [`nats_client::NatsClient`]. Every `OutboxRecord` the dispatcher
//! claims for publish reaches this module, gets its subject derived
//! from `{tenant_id, event_type}`, and lands on NATS. The subject
//! convention mirrors `platform/libs/event-bus/src/nats/nats-event-bus.ts:310-312`
//! `deriveSubject` byte-for-byte: `events.{tenantId}.{eventType}`.
//!
//! # mTLS-only construction
//!
//! The only constructor is [`NatsOutboxPublisher::from_client`], which
//! wraps a pre-connected [`nats_client::NatsClient`] the orchestrator
//! built via [`nats_client::NatsClient::connect`]. There is structurally
//! NO construction path that omits the client cert — the upstream
//! factory does not expose `with_user_pass` / `with_token`, and this
//! module neither shadows nor bypasses it. ADR-014/015
//! cert-is-identity is enforced one architectural layer down.
//!
//! # Stub-mode fallback
//!
//! When the config does not name NATS (the sidecar boots for local
//! smoke runs without a broker), [`LoggingOutboxPublisher`] is used.
//! It records every publish call for unit-test assertions; the
//! production path never compiles away to this surface.

use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use tokio::sync::Mutex;
use tracing::instrument;

use outbox_rs::{OutboxPublisher, OutboxRecord, PublishError};

/// Derive the NATS subject for an outbox record. Pure helper so the
/// subject shape can be unit-tested without a broker. Byte-for-byte
/// equivalent to the TS `deriveSubject` at
/// `platform/libs/event-bus/src/nats/nats-event-bus.ts:310-312`:
/// `events.{tenantId}.{eventType}`.
///
/// Guarantees:
///   * tenant id rendered as lower-case hyphenated UUID (same as the
///     TS side's `String` representation);
///   * event type passed through verbatim (the outbox-rs repository
///     has already validated it against the PascalCase whitelist,
///     so no additional escaping is needed here);
///   * no path-separator / no wildcard characters introduced — any
///     untrusted input would have failed
///     `outbox_rs::validate_event_type` before reaching this call.
///
/// The `subject_for_outbox_record_matches_deriveSubject` test pins
/// the exact format so a future refactor that changed `.` → `_` /
/// dropped a segment / used uppercase hex would fail at build time.
#[must_use]
pub fn subject_for(record: &OutboxRecord) -> String {
    // Task 2 (SENSOR-HIGH-092): SensorMetricIngested is a high-rate
    // telemetry type — it publishes on the telemetry root so it lands on
    // AQUACULTURE_TELEMETRY (Discard New, sized outage buffer), not the
    // shared domain stream.
    let root = if record.event_type == "SensorMetricIngested" {
        "telemetry"
    } else {
        "events"
    };
    format!(
        "{}.{}.{}",
        root,
        record.tenant_id.as_uuid(),
        record.event_type
    )
}

// ---------------------------------------------------------------------
// NatsOutboxPublisher — production, mTLS-only via nats-client.
// ---------------------------------------------------------------------

/// Production [`OutboxPublisher`] backed by [`nats_client::NatsClient`].
/// Cheap to clone (`Arc<NatsClient>` inside), so the same publisher
/// instance can be shared by the dispatcher + any future direct
/// emitter.
#[derive(Debug, Clone)]
pub struct NatsOutboxPublisher {
    client: Arc<nats_client::NatsClient>,
}

impl NatsOutboxPublisher {
    /// Wrap an already-connected [`nats_client::NatsClient`]. The
    /// sidecar builds ONE mTLS connection in `async_main` and every
    /// NATS consumer (outbox publisher, policy subscriber per ADR-031,
    /// sensor-lookup responder) wraps the shared handle through
    /// equivalent constructors so a single TLS handshake covers every
    /// publish/subscribe/request consumer on the same cert CN.
    ///
    /// `const fn` because construction is trivially infallible — all
    /// the connect-time failure modes live upstream in
    /// [`nats_client::NatsClient::connect`] and are already surfaced
    /// there to the orchestrator.
    #[must_use]
    pub const fn from_client(client: Arc<nats_client::NatsClient>) -> Self {
        Self { client }
    }
}

#[async_trait]
impl OutboxPublisher for NatsOutboxPublisher {
    #[instrument(
        skip(self, record),
        fields(tenant_id = %record.tenant_id.as_uuid(), id = %record.id, event_type = %record.event_type)
    )]
    async fn publish(&self, record: &OutboxRecord) -> Result<(), PublishError> {
        let subject = subject_for(record);
        let json = serde_json::to_vec(&record.payload).map_err(PublishError::Encode)?;

        // ADR-032 Kör Nokta 3 — W3C Trace Context propagation.
        // Attach a `traceparent` header so downstream consumers
        // (TS alert-engine, AI service, any OTel collector) can
        // join the span tree across the NATS hop. Every published
        // record starts a fresh trace: MQTT v3 does not carry
        // headers in the delivery path the sidecar uses, so there
        // is no incoming context to propagate; a future MQTT v5
        // user-property code path can thread the incoming id
        // through instead.
        let mut headers = nats_client::HeaderMap::new();
        headers.insert(
            observability::TRACEPARENT_HEADER,
            observability::generate_traceparent().as_str(),
        );

        // `Bytes::from` moves the Vec<u8> into an Arc-backed buffer
        // so async-nats can ship it without a second allocation.
        // Task 3 (SENSOR-CRITICAL-089): JetStream publish with an AWAITED
        // PubAck and the outbox row id as Nats-Msg-Id — the broker's
        // duplicate window collapses dispatcher retries, and a refused
        // ack (full Discard-New telemetry buffer) leaves the row pending.
        let msg_id = record.id.to_string();
        self.client
            .publish_jetstream(subject, headers, Bytes::from(json), Some(&msg_id))
            .await
            .map_err(|e| PublishError::Transport(Box::new(e)))?;
        Ok(())
    }
}

// ---------------------------------------------------------------------
// LoggingOutboxPublisher — stub-mode boot AND unit tests.
// ---------------------------------------------------------------------

/// Test-grade [`OutboxPublisher`] that records every call. Cheap to
/// clone; the inner state is `Arc`-wrapped so concurrent tasks see
/// consistent counters. Used by:
///   * the binary's stub-mode boot when `[nats]` is absent in config,
///   * unit tests that assert publish-call frequency.
#[derive(Debug, Default, Clone)]
pub struct LoggingOutboxPublisher {
    count: Arc<std::sync::atomic::AtomicU64>,
    last_subject: Arc<Mutex<Option<String>>>,
}

impl LoggingOutboxPublisher {
    /// Construct a fresh publisher with zero counters.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of `publish` calls observed. Test-only accessor —
    /// production code observes publish flow through tracing spans +
    /// the dispatcher's `outbox_dispatch_success_total` counter,
    /// never by polling this. `#[cfg(test)]` so the binary's
    /// dead-code lint does not complain that production never reads
    /// it; the surface is intentionally test-only.
    #[cfg(test)]
    #[must_use]
    pub fn count(&self) -> u64 {
        self.count.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Last subject the publisher saw, if any. Test-only accessor.
    #[cfg(test)]
    pub async fn last_subject(&self) -> Option<String> {
        self.last_subject.lock().await.clone()
    }
}

#[async_trait]
impl OutboxPublisher for LoggingOutboxPublisher {
    #[instrument(
        skip(self, record),
        fields(tenant_id = %record.tenant_id.as_uuid(), id = %record.id, event_type = %record.event_type)
    )]
    async fn publish(&self, record: &OutboxRecord) -> Result<(), PublishError> {
        let subject = subject_for(record);
        self.count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        tracing::debug!(
            tenant_id = %record.tenant_id.as_uuid(),
            event_type = %record.event_type,
            subject = %subject,
            "logging outbox publisher received record"
        );
        *self.last_subject.lock().await = Some(subject);
        Ok(())
    }
}

// ---------------------------------------------------------------------
// Tests — subject shape + publisher surface.
// ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::{LoggingOutboxPublisher, subject_for};
    use chrono::Utc;
    use event_contracts_rs::SENSOR_METRIC_INGESTED_EVENT_TYPE;
    use outbox_rs::{OutboxPublisher, OutboxRecord, OutboxStatus};
    use tenant_context::TenantId;
    use uuid::Uuid;

    fn fake_record(tenant: TenantId) -> OutboxRecord {
        OutboxRecord {
            id: Uuid::new_v4(),
            tenant_id: tenant,
            event_type: SENSOR_METRIC_INGESTED_EVENT_TYPE.to_owned(),
            payload: serde_json::json!({
                "eventId": Uuid::new_v4().to_string(),
                "tenantId": tenant.as_uuid().to_string(),
                "sensorId": Uuid::new_v4().to_string(),
                "channelId": Uuid::new_v4().to_string(),
                "value": 7.4,
                "rawValue": 0.532,
                "qualityCode": 1,
                "producerTs": 1_735_689_600_000_i64,
            }),
            created_at: Utc::now(),
            status: OutboxStatus::Pending,
            dispatch_attempts: 0,
            last_attempted_at: None,
            last_error: None,
        }
    }

    #[test]
    fn subject_for_outbox_record_matches_derive_subject() {
        // Pin the subject format — any drift would break the TS
        // consumer's subscription. The format is lower-case hyphenated
        // UUID + PascalCase event type, joined with `.`.
        let tenant_str = "550e8400-e29b-41d4-a716-446655440000";
        let tenant = TenantId::try_parse(tenant_str).unwrap();
        let record = fake_record(tenant);
        let subject = subject_for(&record);
        // Task 2: SensorMetricIngested routes to the telemetry root.
        assert_eq!(
            subject,
            format!("telemetry.{tenant_str}.{SENSOR_METRIC_INGESTED_EVENT_TYPE}")
        );
        // Explicit substring guards — a regression that joined with
        // `_` instead of `.` or dropped a segment surfaces here.
        assert!(subject.starts_with("telemetry."));
        assert!(subject.contains(&tenant.as_uuid().to_string()));
        assert!(subject.ends_with(SENSOR_METRIC_INGESTED_EVENT_TYPE));
        // Shape is `events.{uuid}.{event_type}` — TWO dots, not three
        // (the UUID's own hyphens are not dots). A drift that added
        // a fourth segment (e.g. `events.{tenant}.{sensor}.{event}`)
        // would fail this assertion.
        assert_eq!(subject.matches('.').count(), 2);
    }

    #[test]
    fn subject_for_uses_lowercase_hyphenated_uuid() {
        // Uuid::Display writes lower-case + hyphenated; the TS side
        // consumes the same shape. A refactor that switched to
        // `Uuid::simple` (hex, no hyphens) or uppercase would break
        // cross-language subject equality.
        let tenant = TenantId::try_parse("AABBCCDD-EEFF-0011-2233-445566778899").unwrap();
        let record = fake_record(tenant);
        let subject = subject_for(&record);
        assert!(
            subject.contains("aabbccdd-eeff-0011-2233-445566778899"),
            "subject must embed the lower-case hyphenated UUID; got: {subject}"
        );
    }

    #[tokio::test]
    async fn logging_publisher_records_call_count_and_last_subject() {
        let tenant = TenantId::try_parse("550e8400-e29b-41d4-a716-446655440000").unwrap();
        let publisher = LoggingOutboxPublisher::new();
        assert_eq!(publisher.count(), 0);

        let record = fake_record(tenant);
        let expected_subject = subject_for(&record);
        publisher.publish(&record).await.expect("publish succeeds");
        publisher.publish(&record).await.expect("publish succeeds");

        assert_eq!(publisher.count(), 2);
        assert_eq!(publisher.last_subject().await, Some(expected_subject));
    }

    #[tokio::test]
    async fn logging_publisher_never_fails() {
        // Stub-mode posture: the logging publisher accepts every
        // record and never returns an error. A production-path bug
        // that started failing would surface as
        // `outbox_dispatch_failure_total` climbing in the dispatcher
        // against a stub broker — we want that to be a LOUD signal,
        // not a silent stub-mode flake.
        let publisher = LoggingOutboxPublisher::new();
        let tenant = TenantId::try_parse("550e8400-e29b-41d4-a716-446655440000").unwrap();
        for _ in 0..16 {
            publisher
                .publish(&fake_record(tenant))
                .await
                .expect("stub must accept every record");
        }
        assert_eq!(publisher.count(), 16);
    }
}
