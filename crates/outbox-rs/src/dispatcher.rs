//! [`OutboxDispatcher`] — the async task that drains the outbox and
//! publishes every claimed record downstream. Programs against
//! [`OutboxRepository`] + [`OutboxPublisher`] so the storage + the
//! transport are both swappable.
//!
//! # Lifecycle
//!
//! 1. `OutboxDispatcher::new(repo, publisher, config)` — construct
//!    the dispatcher with its dependencies. No I/O at construction.
//! 2. `tokio::spawn(dispatcher.run())` — start the claim/publish loop.
//! 3. `dispatcher.shutdown().await` — graceful stop: drain the
//!    current tick, then exit. The loop always finishes the tick it
//!    is in so a publish-in-flight is never silently lost.
//!
//! # Concurrency model
//!
//! Every tick, the dispatcher asks the repository for a batch of
//! pending records (up to `limit`, default 500), publishes them via
//! `futures::stream::iter(records).buffer_unordered(publish_parallelism)`
//! (default 20-way), then marks each result via `mark_dispatched` or
//! `mark_failed`. The repository's `FOR UPDATE SKIP LOCKED` keeps a
//! record from being claimed twice concurrently — a second
//! dispatcher instance that starts up sees a subset disjoint from
//! the first. In practice a single dispatcher is the HA posture;
//! `pg_try_advisory_lock` (lands in the sensor-ingestion integration
//! commit) elects exactly one active dispatcher per cluster.
//!
//! # Metrics (observable surface)
//!
//! - [`OUTBOX_DISPATCH_SUCCESS_METRIC`] — per successful publish.
//! - [`OUTBOX_DISPATCH_FAILURE_METRIC`] — per failed publish (pre-DLQ).
//! - [`OUTBOX_DLQ_METRIC`] — fires when a record crosses
//!   [`crate::DLQ_THRESHOLD`] for the first time.
//! - [`OUTBOX_CLAIM_BATCH_SIZE_METRIC`] — histogram of per-tick
//!   claim sizes (0 = idle tick, 500 = saturated tick).

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use futures::StreamExt;
use tokio::sync::Notify;
use tokio::time::interval;

use crate::{
    ClaimBatch, DLQ_THRESHOLD, OutboxRecord, OutboxRepository, publisher::OutboxPublisher,
};

/// Metric name: counter, incremented once per successful publish +
/// mark_dispatched. Exposed as `pub const` so dashboards and tests
/// agree on the contract.
pub const OUTBOX_DISPATCH_SUCCESS_METRIC: &str = "outbox_dispatch_success_total";

/// Metric name: counter, incremented once per failed publish. A
/// record that fails N < DLQ_THRESHOLD times is counted N times
/// here (one per attempt). A record that crosses into DLQ is
/// additionally counted in [`OUTBOX_DLQ_METRIC`].
pub const OUTBOX_DISPATCH_FAILURE_METRIC: &str = "outbox_dispatch_failure_total";

/// Metric name: counter, incremented exactly once per record as it
/// crosses [`DLQ_THRESHOLD`] (from `attempts = THRESHOLD - 1` to
/// `attempts = THRESHOLD`). Operator alarms fire off this metric;
/// a non-zero rate means a record is stuck unrecoverably.
pub const OUTBOX_DLQ_METRIC: &str = "outbox_dlq_total";

/// Metric name: histogram, records every tick's claim size (even 0)
/// so operators can see tick utilisation. The integration commit
/// wires this as a Prometheus histogram; the emission lives here.
pub const OUTBOX_CLAIM_BATCH_SIZE_METRIC: &str = "outbox_claim_batch_size";

/// Configuration parameters for [`OutboxDispatcher`]. Value-type so
/// the dispatcher can be constructed in a builder-like chain at the
/// binary boot site.
#[derive(Debug, Clone, Copy)]
pub struct DispatcherConfig {
    /// How often the dispatcher asks the repository for a new batch.
    /// Default 250ms matches ADR-029.
    pub tick_interval: Duration,
    /// Maximum rows claimed per tick. Default 500 matches ADR-029.
    pub batch_limit: u32,
    /// Base backoff for the retry filter — an attempt N is eligible
    /// for re-claim after `backoff_base * 2^N` seconds. Default 100ms.
    pub backoff_base: Duration,
    /// Publish parallelism inside a single tick. Default 20.
    pub publish_parallelism: usize,
}

impl Default for DispatcherConfig {
    fn default() -> Self {
        Self {
            tick_interval: Duration::from_millis(250),
            batch_limit: 500,
            backoff_base: Duration::from_millis(100),
            publish_parallelism: 20,
        }
    }
}

/// The dispatcher itself. Owns its dependencies via `Arc` so multiple
/// callers can hold a reference (tests + the binary's shutdown
/// handler). A single dispatcher instance drains the outbox; HA is
/// the advisory-lock active/standby pattern the integration commit
/// wires on top.
#[derive(Debug, Clone)]
pub struct OutboxDispatcher {
    repository: Arc<dyn OutboxRepository>,
    publisher: Arc<dyn OutboxPublisher>,
    config: DispatcherConfig,
    shutdown: Arc<Notify>,
}

impl OutboxDispatcher {
    /// Construct a new dispatcher. No I/O runs here.
    #[must_use]
    pub fn new(
        repository: Arc<dyn OutboxRepository>,
        publisher: Arc<dyn OutboxPublisher>,
        config: DispatcherConfig,
    ) -> Self {
        Self {
            repository,
            publisher,
            config,
            shutdown: Arc::new(Notify::new()),
        }
    }

    /// Signal the dispatcher's run loop to exit gracefully after the
    /// current tick completes.
    pub fn shutdown(&self) {
        self.shutdown.notify_waiters();
    }

    /// Drive the claim/publish/mark loop until [`Self::shutdown`] is
    /// called. Each iteration:
    ///
    /// 1. Claim up to `batch_limit` pending records.
    /// 2. Publish them `publish_parallelism`-at-a-time.
    /// 3. Mark the repository with the result (dispatched / failed).
    /// 4. Emit metrics.
    /// 5. Sleep until the next tick (or until shutdown).
    ///
    /// Errors from the repository (claim failure, mark failure) are
    /// logged at warn but do NOT abort the loop — a transient
    /// storage blip should not kill the dispatcher; the next tick
    /// retries the same rows.
    pub async fn run(self: Arc<Self>) {
        let mut ticks = interval(self.config.tick_interval);
        // Fire immediately on start-up so a cold dispatcher does not
        // wait `tick_interval` before draining pending rows.
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                () = self.shutdown.notified() => {
                    tracing::info!("outbox dispatcher shutting down");
                    return;
                }
                _ = ticks.tick() => {
                    self.run_once().await;
                }
            }
        }
    }

    /// One iteration of the claim/publish/mark cycle. Exposed so
    /// tests can drive the loop deterministically without relying
    /// on the real `interval`.
    pub async fn run_once(&self) {
        let req = ClaimBatch {
            limit: self.config.batch_limit,
            backoff_base: self.config.backoff_base,
            now: Utc::now(),
        };
        let claimed = match self.repository.claim_pending(req).await {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!(error = %e, "outbox claim_pending failed; skipping tick");
                return;
            }
        };

        // Emit the histogram even on 0 — idle-tick visibility matters.
        // The usize→f64 cast is numerically fine: claim batch sizes
        // are bounded by `batch_limit` (default 500, never > 2^32)
        // so precision loss is structural zero.
        #[allow(clippy::cast_precision_loss)]
        let batch_size_f = claimed.len() as f64;
        metrics::histogram!(OUTBOX_CLAIM_BATCH_SIZE_METRIC).record(batch_size_f);

        if claimed.is_empty() {
            return;
        }

        let parallelism = self.config.publish_parallelism;
        let publisher = Arc::clone(&self.publisher);
        let repository = Arc::clone(&self.repository);

        futures::stream::iter(claimed)
            .map(|record| {
                let publisher = Arc::clone(&publisher);
                let repository = Arc::clone(&repository);
                async move { dispatch_one(&*publisher, &*repository, record).await }
            })
            .buffer_unordered(parallelism)
            .for_each(|_result| async {})
            .await;
    }
}

/// Publish one record + mark the result. Factored out so tests can
/// drive a single record through the pipeline without a dispatcher
/// instance. Returns () on purpose — the dispatcher logs failures at
/// warn and does not surface them to the caller; the run loop keeps
/// turning.
async fn dispatch_one(
    publisher: &dyn OutboxPublisher,
    repository: &dyn OutboxRepository,
    record: OutboxRecord,
) {
    let id = record.id;
    let tenant = record.tenant_id;
    let event_type = record.event_type.clone();
    let attempts_before = record.dispatch_attempts;

    match publisher.publish(&record).await {
        Ok(()) => {
            metrics::counter!(OUTBOX_DISPATCH_SUCCESS_METRIC).increment(1);
            if let Err(e) = repository.mark_dispatched(id).await {
                tracing::warn!(
                    error = %e,
                    id = %id,
                    tenant = %tenant.as_uuid(),
                    event_type = %event_type,
                    "mark_dispatched failed after successful publish; the record \
                     will re-publish on the next tick (at-least-once semantics)"
                );
            }
        }
        Err(publish_err) => {
            metrics::counter!(OUTBOX_DISPATCH_FAILURE_METRIC).increment(1);
            // DLQ transition: attempts is incremented on the
            // repository side by mark_failed. A record that currently
            // has attempts = THRESHOLD - 1 will become
            // attempts = THRESHOLD after this mark — which crosses
            // into DLQ. Emit the DLQ counter exactly once per
            // crossing (attempts_before + 1 == THRESHOLD).
            if attempts_before + 1 == DLQ_THRESHOLD {
                metrics::counter!(OUTBOX_DLQ_METRIC).increment(1);
                tracing::warn!(
                    id = %id,
                    tenant = %tenant.as_uuid(),
                    event_type = %event_type,
                    attempts = attempts_before + 1,
                    "outbox record crossed DLQ threshold; will not be retried further"
                );
            }
            let err_msg = format!("{publish_err}");
            if let Err(mark_err) = repository.mark_failed(id, &err_msg).await {
                tracing::warn!(
                    error = %mark_err,
                    id = %id,
                    "mark_failed failed after publish failure; row state may be stale \
                     — next claim will see the unchanged attempt count"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        DispatcherConfig, OUTBOX_CLAIM_BATCH_SIZE_METRIC, OUTBOX_DISPATCH_FAILURE_METRIC,
        OUTBOX_DISPATCH_SUCCESS_METRIC, OUTBOX_DLQ_METRIC, OutboxDispatcher,
    };
    use crate::mock::{InMemoryOutbox, MockPublisher};
    use crate::{OutboxRepository, encode_payload};
    use metrics::set_default_local_recorder;
    use metrics_util::debugging::{DebugValue, DebuggingRecorder};
    use std::sync::Arc;
    use tenant_context::TenantId;

    fn tenant() -> TenantId {
        TenantId::try_parse("550e8400-e29b-41d4-a716-446655440000").unwrap()
    }

    #[tokio::test]
    async fn metric_names_are_stable() {
        // Pin the dashboard contract — a rename breaks downstream
        // Prometheus queries authored against these literals.
        assert_eq!(
            OUTBOX_DISPATCH_SUCCESS_METRIC,
            "outbox_dispatch_success_total"
        );
        assert_eq!(
            OUTBOX_DISPATCH_FAILURE_METRIC,
            "outbox_dispatch_failure_total"
        );
        assert_eq!(OUTBOX_DLQ_METRIC, "outbox_dlq_total");
        assert_eq!(OUTBOX_CLAIM_BATCH_SIZE_METRIC, "outbox_claim_batch_size");
    }

    #[tokio::test]
    async fn default_config_matches_adr_029() {
        let cfg = DispatcherConfig::default();
        assert_eq!(cfg.tick_interval, std::time::Duration::from_millis(250));
        assert_eq!(cfg.batch_limit, 500);
        assert_eq!(cfg.backoff_base, std::time::Duration::from_millis(100));
        assert_eq!(cfg.publish_parallelism, 20);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dispatcher_publishes_pending_then_marks_dispatched() {
        // Happy path: enqueue 3 records, run one tick, assert all 3
        // were published + marked dispatched + the success counter
        // incremented 3 times. `current_thread` flavour keeps the
        // recorder's thread-local guard valid across await points.
        let repo = Arc::new(InMemoryOutbox::new());
        let pub_ = Arc::new(MockPublisher::new_always_ok());
        let config = DispatcherConfig {
            batch_limit: 10,
            ..DispatcherConfig::default()
        };
        let dispatcher = Arc::new(OutboxDispatcher::new(
            repo.clone() as Arc<dyn OutboxRepository>,
            pub_.clone(),
            config,
        ));

        for i in 0..3 {
            let payload = encode_payload(&serde_json::json!({ "seq": i })).unwrap();
            repo.enqueue_direct(tenant(), "SensorMetricIngested", payload)
                .await
                .unwrap();
        }
        assert_eq!(repo.pending_count().await.unwrap(), 3);

        let recorder = DebuggingRecorder::new();
        let snapshotter = recorder.snapshotter();
        let _guard = set_default_local_recorder(&recorder);

        dispatcher.run_once().await;

        assert_eq!(pub_.published_count(), 3);
        assert_eq!(repo.pending_count().await.unwrap(), 0);

        let entries = snapshotter.snapshot().into_vec();
        let success = entries
            .iter()
            .find(|(k, _, _, _)| k.key().name() == OUTBOX_DISPATCH_SUCCESS_METRIC)
            .expect("success counter emitted");
        match &success.3 {
            DebugValue::Counter(v) => assert_eq!(*v, 3),
            other => panic!("expected Counter, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dispatcher_marks_failed_on_publish_error() {
        let repo = Arc::new(InMemoryOutbox::new());
        let pub_ = Arc::new(MockPublisher::new_always_err("simulated failure"));
        let dispatcher = Arc::new(OutboxDispatcher::new(
            repo.clone() as Arc<dyn OutboxRepository>,
            pub_.clone(),
            DispatcherConfig {
                batch_limit: 10,
                ..DispatcherConfig::default()
            },
        ));

        let payload = encode_payload(&serde_json::json!({ "ok": false })).unwrap();
        let id = repo
            .enqueue_direct(tenant(), "SensorMetricIngested", payload)
            .await
            .unwrap();

        let recorder = DebuggingRecorder::new();
        let snapshotter = recorder.snapshotter();
        let _guard = set_default_local_recorder(&recorder);

        dispatcher.run_once().await;

        let record = repo.get(&id).unwrap();
        assert_eq!(record.dispatch_attempts, 1);
        assert_eq!(
            record.last_error.as_deref(),
            Some("publisher transport failed")
        );

        let failure = snapshotter
            .snapshot()
            .into_vec()
            .into_iter()
            .find(|(k, _, _, _)| k.key().name() == OUTBOX_DISPATCH_FAILURE_METRIC)
            .expect("failure counter emitted");
        match failure.3 {
            DebugValue::Counter(v) => assert_eq!(v, 1),
            other => panic!("expected Counter, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dispatcher_emits_dlq_counter_when_crossing_threshold() {
        let repo = Arc::new(InMemoryOutbox::new());
        let pub_ = Arc::new(MockPublisher::new_always_err("will fail"));
        let dispatcher = Arc::new(OutboxDispatcher::new(
            repo.clone() as Arc<dyn OutboxRepository>,
            pub_.clone(),
            DispatcherConfig {
                batch_limit: 10,
                ..DispatcherConfig::default()
            },
        ));

        let payload = encode_payload(&serde_json::json!({ "seq": 1 })).unwrap();
        let id = repo
            .enqueue_direct(tenant(), "SensorMetricIngested", payload)
            .await
            .unwrap();
        repo.force_attempts(&id, crate::DLQ_THRESHOLD - 1);

        let recorder = DebuggingRecorder::new();
        let snapshotter = recorder.snapshotter();
        let _guard = set_default_local_recorder(&recorder);

        dispatcher.run_once().await;

        let record = repo.get(&id).unwrap();
        assert_eq!(record.dispatch_attempts, crate::DLQ_THRESHOLD);
        assert_eq!(record.status, crate::OutboxStatus::DeadLettered);

        let entries = snapshotter.snapshot().into_vec();
        let dlq = entries
            .iter()
            .find(|(k, _, _, _)| k.key().name() == OUTBOX_DLQ_METRIC)
            .expect("dlq counter emitted exactly at threshold crossing");
        match &dlq.3 {
            DebugValue::Counter(v) => {
                assert_eq!(*v, 1, "DLQ fires once per crossing, not once per attempt");
            }
            other => panic!("expected Counter, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dispatcher_idle_tick_emits_zero_size_histogram_and_exits_clean() {
        let repo = Arc::new(InMemoryOutbox::new());
        let pub_ = Arc::new(MockPublisher::new_always_ok());
        let dispatcher = Arc::new(OutboxDispatcher::new(
            repo.clone() as Arc<dyn OutboxRepository>,
            pub_.clone(),
            DispatcherConfig::default(),
        ));

        let recorder = DebuggingRecorder::new();
        let snapshotter = recorder.snapshotter();
        let _guard = set_default_local_recorder(&recorder);

        dispatcher.run_once().await;

        let entries = snapshotter.snapshot().into_vec();
        let histogram = entries
            .iter()
            .find(|(k, _, _, _)| k.key().name() == OUTBOX_CLAIM_BATCH_SIZE_METRIC);
        assert!(
            histogram.is_some(),
            "claim-size histogram must record the 0-row tick"
        );
        assert_eq!(pub_.published_count(), 0);
    }
}
