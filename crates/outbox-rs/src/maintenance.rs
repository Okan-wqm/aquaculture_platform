//! [`OutboxMaintenance`] — retention cleanup + pending-gauge emitter.
//! Lives alongside the dispatcher but runs on a separate, slower
//! cadence: the cleanup fires once a day, the gauge every 30s.
//! Decoupling them from the dispatcher means a stuck dispatcher
//! does not also silence the backlog-observability signal.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;
use tokio::time::interval;

use crate::OutboxRepository;

/// Metric name: gauge, emitted on every [`OutboxMaintenance`] tick.
/// Tracks the current pending-row count (excluding DLQ). Prometheus
/// alert rule `outbox_pending > 100000 for 10m` fires off this
/// gauge to flag a stuck dispatcher or an upstream producer storm.
pub const OUTBOX_PENDING_GAUGE_METRIC: &str = "outbox_pending";

/// Metric name: counter, incremented per cleanup sweep with the
/// number of rows deleted. Operator queries this to reconcile the
/// retention policy (7-day dispatched rows).
pub const OUTBOX_CLEANUP_DELETED_METRIC: &str = "outbox_cleanup_deleted_total";

/// Configuration for [`OutboxMaintenance`].
#[derive(Debug, Clone, Copy)]
pub struct MaintenanceConfig {
    /// How often the pending-count gauge is sampled. Default 30s.
    pub gauge_interval: Duration,
    /// How often retention cleanup runs. Default 24h.
    pub cleanup_interval: Duration,
    /// Age threshold for cleanup — dispatched rows older than this
    /// are deleted. Default 7 days matches ADR-029 retention.
    pub cleanup_max_age: Duration,
}

impl Default for MaintenanceConfig {
    fn default() -> Self {
        Self {
            gauge_interval: Duration::from_secs(30),
            cleanup_interval: Duration::from_secs(24 * 60 * 60),
            cleanup_max_age: Duration::from_secs(7 * 24 * 60 * 60),
        }
    }
}

/// Retention + gauge task. Holds the repository + a shutdown Notify
/// so the binary can stop it cleanly at process exit.
#[derive(Debug, Clone)]
pub struct OutboxMaintenance {
    repository: Arc<dyn OutboxRepository>,
    config: MaintenanceConfig,
    shutdown: Arc<Notify>,
}

impl OutboxMaintenance {
    /// Construct a new maintenance task. No I/O at construction.
    #[must_use]
    pub fn new(repository: Arc<dyn OutboxRepository>, config: MaintenanceConfig) -> Self {
        Self {
            repository,
            config,
            shutdown: Arc::new(Notify::new()),
        }
    }

    /// Signal graceful shutdown.
    pub fn shutdown(&self) {
        self.shutdown.notify_waiters();
    }

    /// Run the two independent timers concurrently. Exits on shutdown.
    pub async fn run(self: Arc<Self>) {
        let mut gauge_ticks = interval(self.config.gauge_interval);
        let mut cleanup_ticks = interval(self.config.cleanup_interval);
        gauge_ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        cleanup_ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                () = self.shutdown.notified() => {
                    tracing::info!("outbox maintenance shutting down");
                    return;
                }
                _ = gauge_ticks.tick() => {
                    self.sample_gauge().await;
                }
                _ = cleanup_ticks.tick() => {
                    self.run_cleanup().await;
                }
            }
        }
    }

    /// One gauge tick — sample pending_count + emit. Exposed for tests.
    pub async fn sample_gauge(&self) {
        match self.repository.pending_count().await {
            Ok(count) => {
                // u64 → f64 precision is lossy at counts > 2^53 (~9e15);
                // the outbox can never legitimately hold that many
                // pending rows (the backpressure alert fires at 1e5).
                // The structural upper bound makes the cast safe.
                #[allow(clippy::cast_precision_loss)]
                let value = count as f64;
                metrics::gauge!(OUTBOX_PENDING_GAUGE_METRIC).set(value);
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "outbox pending_count failed; gauge stale for this tick"
                );
            }
        }
    }

    /// One cleanup tick — delete dispatched rows older than the
    /// configured max_age, emit deletion counter. Exposed for tests.
    pub async fn run_cleanup(&self) {
        match self
            .repository
            .cleanup_published(self.config.cleanup_max_age)
            .await
        {
            Ok(deleted) => {
                metrics::counter!(OUTBOX_CLEANUP_DELETED_METRIC).increment(deleted);
                if deleted > 0 {
                    tracing::info!(
                        deleted,
                        max_age_secs = self.config.cleanup_max_age.as_secs(),
                        "outbox retention cleanup completed"
                    );
                }
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "outbox cleanup_published failed; rows remain in the archive"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        MaintenanceConfig, OUTBOX_CLEANUP_DELETED_METRIC, OUTBOX_PENDING_GAUGE_METRIC,
        OutboxMaintenance,
    };
    use crate::mock::InMemoryOutbox;
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
        assert_eq!(OUTBOX_PENDING_GAUGE_METRIC, "outbox_pending");
        assert_eq!(
            OUTBOX_CLEANUP_DELETED_METRIC,
            "outbox_cleanup_deleted_total"
        );
    }

    #[tokio::test]
    async fn default_config_matches_adr_029_retention() {
        let cfg = MaintenanceConfig::default();
        assert_eq!(cfg.gauge_interval, std::time::Duration::from_secs(30));
        assert_eq!(
            cfg.cleanup_interval,
            std::time::Duration::from_secs(24 * 60 * 60)
        );
        assert_eq!(
            cfg.cleanup_max_age,
            std::time::Duration::from_secs(7 * 24 * 60 * 60)
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn sample_gauge_emits_pending_count() {
        let repo = Arc::new(InMemoryOutbox::new());
        for _ in 0..5 {
            let payload = encode_payload(&serde_json::json!({"x": 1})).unwrap();
            repo.enqueue_direct(tenant(), "SensorMetricIngested", payload)
                .await
                .unwrap();
        }

        let maintenance = OutboxMaintenance::new(
            repo as Arc<dyn OutboxRepository>,
            MaintenanceConfig::default(),
        );

        let recorder = DebuggingRecorder::new();
        let snapshotter = recorder.snapshotter();
        let _guard = set_default_local_recorder(&recorder);

        maintenance.sample_gauge().await;

        let entries = snapshotter.snapshot().into_vec();
        let gauge = entries
            .iter()
            .find(|(k, _, _, _)| k.key().name() == OUTBOX_PENDING_GAUGE_METRIC)
            .expect("gauge emitted");
        match &gauge.3 {
            DebugValue::Gauge(v) => assert!((v.into_inner() - 5.0).abs() < f64::EPSILON),
            other => panic!("expected Gauge, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn run_cleanup_increments_deleted_counter() {
        let repo = Arc::new(InMemoryOutbox::new());
        let payload = encode_payload(&serde_json::json!({"ok": true})).unwrap();
        let id = repo
            .enqueue_direct(tenant(), "SensorMetricIngested", payload)
            .await
            .unwrap();
        repo.mark_dispatched(id).await.unwrap();

        let maintenance = OutboxMaintenance::new(
            repo.clone() as Arc<dyn OutboxRepository>,
            MaintenanceConfig {
                cleanup_max_age: std::time::Duration::from_millis(0),
                ..MaintenanceConfig::default()
            },
        );

        let recorder = DebuggingRecorder::new();
        let snapshotter = recorder.snapshotter();
        let _guard = set_default_local_recorder(&recorder);

        maintenance.run_cleanup().await;

        assert_eq!(repo.pending_count().await.unwrap(), 0);

        let entries = snapshotter.snapshot().into_vec();
        let deleted = entries
            .iter()
            .find(|(k, _, _, _)| k.key().name() == OUTBOX_CLEANUP_DELETED_METRIC)
            .expect("cleanup counter emitted");
        match &deleted.3 {
            DebugValue::Counter(v) => assert_eq!(*v, 1),
            other => panic!("expected Counter, got {other:?}"),
        }
    }
}
