//! Persistence sink behind a [`BatchSink`] trait.
//!
//! WHY a trait:
//!   The hot-path module (`crate::batch`) consumes `Vec<SensorReading>`
//!   batches and hands them off to a sink. The trait makes the sink
//!   replaceable in tests (the [`LoggingSink`]) and at deploy time
//!   (the future `PostgresSink` lands in a follow-on commit on this
//!   PR — together with the deadpool-postgres pool wiring + the
//!   testcontainers integration test). The drain loop never branches
//!   on which implementation is wired.
//!
//! WHY this commit ships only `LoggingSink`:
//!   The architectural rule is "ship only API surface that is
//!   exercised end-to-end now". Adding PostgresSink + SQL builders
//!   here without a postgres integration test in the same commit
//!   would be dead code with a `#[allow(dead_code)]` excuse — exactly
//!   the workaround pattern the project bans. The live postgres
//!   path lands in its own commit with a testcontainers fixture.

use std::sync::Arc;

use async_trait::async_trait;
use thiserror::Error;
use tracing::instrument;

use crate::payload::SensorReading;

/// Errors raised by [`BatchSink`] implementations.
#[derive(Debug, Error)]
pub enum SinkError {
    /// The supplied batch was empty. Sinks treat empty batches as a
    /// caller bug — the batch aggregator never emits empty.
    #[error("batch sink received an empty batch")]
    EmptyBatch,
}

/// Persistence sink. Implementations: [`LoggingSink`] for the
/// stub-mode boot + tests; production `PostgresSink` lands in a
/// follow-on commit.
#[async_trait]
pub trait BatchSink: Send + Sync {
    /// Write the batch to the backend. Whole-batch atomicity — partial
    /// success is not supported.
    async fn write(&self, batch: Vec<SensorReading>) -> Result<(), SinkError>;
}

// -----------------------------------------------------------------
// LoggingSink — used by the binary's stub-mode boot AND by the
// batch / drain unit tests. Counts batches + last-batch-size so unit
// tests can assert delivery without a postgres container.
// -----------------------------------------------------------------

/// Test-grade sink that logs each batch and records counts. Cheap
/// to clone; the inner state is `Arc<AtomicUsize>` so concurrent
/// callers see consistent counters.
#[derive(Debug, Default, Clone)]
pub struct LoggingSink {
    batches: Arc<std::sync::atomic::AtomicU64>,
    last_size: Arc<std::sync::atomic::AtomicUsize>,
}

impl LoggingSink {
    /// Construct a fresh sink with zero counters.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of batches the sink has received. Test-only accessor:
    /// production code observes batch flow through tracing spans
    /// instead of polling a counter.
    #[cfg(test)]
    pub fn batches(&self) -> u64 {
        self.batches.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Size of the most recently received batch. Test-only accessor.
    #[cfg(test)]
    pub fn last_batch_size(&self) -> usize {
        self.last_size.load(std::sync::atomic::Ordering::Relaxed)
    }
}

#[async_trait]
impl BatchSink for LoggingSink {
    #[instrument(skip(self, batch), fields(rows = batch.len()))]
    async fn write(&self, batch: Vec<SensorReading>) -> Result<(), SinkError> {
        if batch.is_empty() {
            return Err(SinkError::EmptyBatch);
        }
        self.batches
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.last_size
            .store(batch.len(), std::sync::atomic::Ordering::Relaxed);
        tracing::debug!(rows = batch.len(), "logging sink received batch");
        Ok(())
    }
}

/// Receive flushed batches from a `mpsc::Receiver` and feed each one
/// to the supplied [`BatchSink`]. Returns when the receiver closes.
/// Used by `main::async_main` to spawn the sink consumer task.
pub async fn run_sink_loop(
    sink: Arc<dyn BatchSink>,
    mut rx: tokio::sync::mpsc::Receiver<Vec<SensorReading>>,
) {
    while let Some(batch) = rx.recv().await {
        if let Err(e) = sink.write(batch).await {
            tracing::error!(error = %e, "batch sink write failed");
        }
    }
    tracing::info!("batch sink loop exited (channel closed)");
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use uuid::Uuid;

    use super::{BatchSink, LoggingSink, SinkError, run_sink_loop};
    use crate::payload::SensorReading;
    use std::sync::Arc;
    use tenant_context::TenantId;
    use tokio::sync::mpsc;

    fn fixed_uuid(seed: u8) -> Uuid {
        let mut bytes = [0_u8; 16];
        bytes[0] = seed;
        Uuid::from_bytes(bytes)
    }

    fn reading() -> SensorReading {
        SensorReading {
            tenant_id: TenantId::from_uuid(fixed_uuid(0xAA)),
            sensor_id: fixed_uuid(0xBB),
            channel_id: fixed_uuid(0xCC),
            value: 24.5,
            quality: 1,
            producer_ts: Utc::now().timestamp_millis(),
        }
    }

    #[tokio::test]
    async fn logging_sink_records_batch_count() {
        let sink = LoggingSink::new();
        sink.write(vec![reading(), reading()]).await.unwrap();
        sink.write(vec![reading()]).await.unwrap();
        assert_eq!(sink.batches(), 2);
        assert_eq!(sink.last_batch_size(), 1);
    }

    #[tokio::test]
    async fn logging_sink_rejects_empty_batch() {
        let sink = LoggingSink::new();
        let err = sink.write(vec![]).await.unwrap_err();
        assert!(matches!(err, SinkError::EmptyBatch));
        assert_eq!(sink.batches(), 0);
    }

    #[tokio::test]
    async fn run_sink_loop_consumes_until_close() {
        let sink = Arc::new(LoggingSink::new());
        let counter = Arc::clone(&sink);
        let (tx, rx) = mpsc::channel::<Vec<SensorReading>>(8);
        let handle = tokio::spawn(run_sink_loop(sink, rx));

        tx.send(vec![reading()]).await.unwrap();
        tx.send(vec![reading(), reading()]).await.unwrap();
        drop(tx);

        handle.await.unwrap();
        assert_eq!(counter.batches(), 2);
        assert_eq!(counter.last_batch_size(), 2);
    }
}
