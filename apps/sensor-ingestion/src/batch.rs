//! Batch aggregator — time + size triggered flush.
//!
//! WHY:
//!   tokio-postgres `CopyInSink` performs best when fed chunks of
//!   ~5K-10K rows per copy session (plan § Faz 2 — flush_at_size:
//!   10_000 rows / flush_at_interval: 100ms). One row at a time
//!   demolishes throughput; one giant batch demolishes latency.
//!   This module sits between [`crate::payload`] (per-message validate)
//!   and [`crate::persistence`] (per-batch COPY) and turns a stream
//!   of single readings into right-sized chunks.
//!
//! ARCHITECTURE:
//!   - [`BatchAggregator`] owns an `mpsc::Receiver<SensorReading>`
//!     (input from the drain loop) and an `mpsc::Sender<Vec<SensorReading>>`
//!     (output to the persistence layer).
//!   - [`BatchAggregator::run`] loops on `select!`-of-three: input
//!     channel, flush timer tick, shutdown signal. Either path that
//!     produces a non-empty batch sends it downstream.
//!   - The output channel is bounded; if the persistence layer is
//!     blocked, `send().await` blocks the aggregator, which blocks
//!     the drain loop, which exerts MQTT QoS-1 backpressure on the
//!     broker. That is the explicit intent — never grow heap.

use std::time::Duration;

use thiserror::Error;
use tokio::sync::mpsc;
use tokio::time::{Instant, interval_at};
use tokio_util::sync::CancellationToken;

use crate::payload::SensorReading;

/// Default flush interval per plan.
pub const DEFAULT_FLUSH_INTERVAL: Duration = Duration::from_millis(100);

/// Default max batch size per plan.
pub const DEFAULT_MAX_BATCH_SIZE: usize = 10_000;

/// Default output channel capacity. Bounded so a stalled persistence
/// layer surfaces as backpressure on the input rather than as
/// unbounded heap growth.
pub const DEFAULT_OUTPUT_CHANNEL_CAPACITY: usize = 8;

/// Default input channel capacity. Sized to absorb a single MQTT
/// burst (~1024 messages) without backpressuring the broker
/// reactively.
pub const DEFAULT_INPUT_CHANNEL_CAPACITY: usize = 1024;

/// Result of [`BatchAggregator::new`]: the aggregator itself, the
/// sender for upstream callers, and the receiver for the persistence
/// sink. Aliased so callers can name the type without bumping into
/// `clippy::type_complexity`.
pub type AggregatorParts = (
    BatchAggregator,
    mpsc::Sender<SensorReading>,
    mpsc::Receiver<Vec<SensorReading>>,
);

/// Errors raised by [`BatchAggregator`].
#[derive(Debug, Error)]
pub enum BatchError {
    /// Output channel closed while a non-empty batch was being sent —
    /// persistence layer dropped its receiver.
    #[error("batch output channel closed unexpectedly")]
    OutputClosed,

    /// Configuration value out of range.
    #[error("max_batch_size must be > 0")]
    InvalidBatchSize,
}

/// Tunable parameters for [`BatchAggregator::new`].
#[derive(Debug, Clone, Copy)]
pub struct BatchOpts {
    /// Maximum batch size before a forced flush. Defaults to
    /// [`DEFAULT_MAX_BATCH_SIZE`].
    pub max_batch_size: usize,
    /// Maximum time a non-empty batch sits before a forced flush.
    /// Defaults to [`DEFAULT_FLUSH_INTERVAL`].
    pub flush_interval: Duration,
}

impl Default for BatchOpts {
    fn default() -> Self {
        Self {
            max_batch_size: DEFAULT_MAX_BATCH_SIZE,
            flush_interval: DEFAULT_FLUSH_INTERVAL,
        }
    }
}

/// Time + size triggered batch aggregator.
///
/// Construction returns the aggregator together with its input
/// `Sender` (caller pushes [`SensorReading`] values into it) and the
/// downstream `Receiver` for already-batched chunks. Spawn
/// [`BatchAggregator::run`] on a tokio task and supply a
/// [`CancellationToken`] for graceful shutdown.
#[derive(Debug)]
pub struct BatchAggregator {
    rx: mpsc::Receiver<SensorReading>,
    out: mpsc::Sender<Vec<SensorReading>>,
    opts: BatchOpts,
}

impl BatchAggregator {
    /// Build the aggregator. The `input_capacity` bounds the inbound
    /// channel from the drain loop; `output_capacity` bounds the
    /// outbound channel to the persistence layer.
    ///
    /// # Errors
    /// Returns [`BatchError::InvalidBatchSize`] if `opts.max_batch_size`
    /// is zero.
    pub fn new(
        opts: BatchOpts,
        input_capacity: usize,
        output_capacity: usize,
    ) -> Result<AggregatorParts, BatchError> {
        if opts.max_batch_size == 0 {
            return Err(BatchError::InvalidBatchSize);
        }
        let (in_tx, in_rx) = mpsc::channel::<SensorReading>(input_capacity);
        let (out_tx, out_rx) = mpsc::channel::<Vec<SensorReading>>(output_capacity);
        Ok((
            Self {
                rx: in_rx,
                out: out_tx,
                opts,
            },
            in_tx,
            out_rx,
        ))
    }

    /// Run the aggregator until either the input channel closes or
    /// the cancellation token fires. Returns the final
    /// flushed-batches count for observability.
    ///
    /// # Errors
    /// Returns [`BatchError::OutputClosed`] if the persistence layer
    /// dropped its receiver mid-run.
    pub async fn run(mut self, cancel: CancellationToken) -> Result<u64, BatchError> {
        let mut buf: Vec<SensorReading> = Vec::with_capacity(self.opts.max_batch_size);
        let mut ticker = interval_at(
            Instant::now() + self.opts.flush_interval,
            self.opts.flush_interval,
        );
        let mut flushed_batches: u64 = 0;

        loop {
            tokio::select! {
                biased; // shutdown takes precedence over more work
                () = cancel.cancelled() => {
                    // Drain any in-flight readings the upstream
                    // already accepted into the channel before the
                    // cancel signal fired. Without this drain the
                    // shutdown is racy — `tx.send().await` returning
                    // does not mean the receiver has consumed the
                    // value, only that it is queued. If we flushed
                    // here without draining, those queued readings
                    // would be lost on shutdown.
                    while let Ok(reading) = self.rx.try_recv() {
                        buf.push(reading);
                    }
                    if !buf.is_empty() {
                        let final_batch = std::mem::take(&mut buf);
                        if self.out.send(final_batch).await.is_err() {
                            return Err(BatchError::OutputClosed);
                        }
                        flushed_batches = flushed_batches.saturating_add(1);
                    }
                    return Ok(flushed_batches);
                }
                msg = self.rx.recv() => {
                    let Some(reading) = msg else {
                        // Input closed cleanly — final flush + exit.
                        if !buf.is_empty() {
                            let final_batch = std::mem::take(&mut buf);
                            if self.out.send(final_batch).await.is_err() {
                                return Err(BatchError::OutputClosed);
                            }
                            flushed_batches = flushed_batches.saturating_add(1);
                        }
                        return Ok(flushed_batches);
                    };
                    buf.push(reading);
                    if buf.len() >= self.opts.max_batch_size {
                        let full = std::mem::replace(
                            &mut buf,
                            Vec::with_capacity(self.opts.max_batch_size),
                        );
                        if self.out.send(full).await.is_err() {
                            return Err(BatchError::OutputClosed);
                        }
                        flushed_batches = flushed_batches.saturating_add(1);
                    }
                }
                _ = ticker.tick() => {
                    if !buf.is_empty() {
                        let timed = std::mem::replace(
                            &mut buf,
                            Vec::with_capacity(self.opts.max_batch_size),
                        );
                        if self.out.send(timed).await.is_err() {
                            return Err(BatchError::OutputClosed);
                        }
                        flushed_batches = flushed_batches.saturating_add(1);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use chrono::Utc;
    use tokio_util::sync::CancellationToken;
    use uuid::Uuid;

    use super::{BatchAggregator, BatchError, BatchOpts};
    use crate::payload::{QUALITY_GOOD_MIN, QualityCode, SensorReading};
    use tenant_context::TenantId;

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
            // V1 upcast semantics in the test fixture — batch tests
            // don't exercise the V1/V2 distinction (that lives in
            // payload.rs tests), so the legacy default is the
            // semantically-correct shape here.
            raw_value: 24.5,
            quality: QualityCode::try_new(QUALITY_GOOD_MIN).expect("192 is the GOOD band"),
            producer_ts: Utc::now().timestamp_millis(),
            source_event_id: "edge-test:1".to_owned(),
            source_sequence: Some(1),
            source: crate::payload::PayloadSource::UpcastedFromV1,
        }
    }

    #[tokio::test]
    async fn invalid_batch_size_rejected() {
        let opts = BatchOpts {
            max_batch_size: 0,
            flush_interval: Duration::from_millis(50),
        };
        let result = BatchAggregator::new(opts, 16, 8);
        assert!(matches!(result, Err(BatchError::InvalidBatchSize)));
    }

    #[tokio::test]
    async fn size_triggered_flush_emits_full_batch() {
        let opts = BatchOpts {
            max_batch_size: 3,
            flush_interval: Duration::from_secs(60),
        };
        let (agg, in_tx, mut out_rx) = BatchAggregator::new(opts, 16, 8).unwrap();
        let cancel = CancellationToken::new();
        let cancel2 = cancel.clone();
        let handle = tokio::spawn(async move { agg.run(cancel2).await });

        for _ in 0..3 {
            in_tx.send(reading()).await.unwrap();
        }
        let batch = tokio::time::timeout(Duration::from_secs(1), out_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(batch.len(), 3);

        cancel.cancel();
        let count = handle.await.unwrap().unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn time_triggered_flush_emits_partial_batch() {
        let opts = BatchOpts {
            max_batch_size: 1000,
            flush_interval: Duration::from_millis(50),
        };
        let (agg, in_tx, mut out_rx) = BatchAggregator::new(opts, 16, 8).unwrap();
        let cancel = CancellationToken::new();
        let cancel2 = cancel.clone();
        let handle = tokio::spawn(async move { agg.run(cancel2).await });

        // Push 2 readings that won't fill the size threshold, then
        // wait long enough for the timer to flush.
        in_tx.send(reading()).await.unwrap();
        in_tx.send(reading()).await.unwrap();
        let batch = tokio::time::timeout(Duration::from_millis(500), out_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(batch.len(), 2);

        cancel.cancel();
        let _ = handle.await.unwrap();
    }

    #[tokio::test]
    async fn shutdown_flushes_remaining_buffer() {
        let opts = BatchOpts {
            max_batch_size: 1000,
            flush_interval: Duration::from_secs(60),
        };
        let (agg, in_tx, mut out_rx) = BatchAggregator::new(opts, 16, 8).unwrap();
        let cancel = CancellationToken::new();
        let cancel2 = cancel.clone();
        let handle = tokio::spawn(async move { agg.run(cancel2).await });

        in_tx.send(reading()).await.unwrap();
        in_tx.send(reading()).await.unwrap();
        // Trigger graceful shutdown; the buffered 2 readings must be
        // flushed before the run loop returns.
        cancel.cancel();
        let batch = tokio::time::timeout(Duration::from_secs(1), out_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(batch.len(), 2);
        let count = handle.await.unwrap().unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn input_close_flushes_remaining_buffer() {
        let opts = BatchOpts {
            max_batch_size: 1000,
            flush_interval: Duration::from_secs(60),
        };
        let (agg, in_tx, mut out_rx) = BatchAggregator::new(opts, 16, 8).unwrap();
        let cancel = CancellationToken::new();
        let handle = tokio::spawn(async move { agg.run(cancel).await });

        in_tx.send(reading()).await.unwrap();
        drop(in_tx); // closes the input channel
        let batch = tokio::time::timeout(Duration::from_secs(1), out_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(batch.len(), 1);
        let count = handle.await.unwrap().unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn empty_buffer_not_flushed_on_tick() {
        let opts = BatchOpts {
            max_batch_size: 1000,
            flush_interval: Duration::from_millis(20),
        };
        let (agg, in_tx, mut out_rx) = BatchAggregator::new(opts, 16, 8).unwrap();
        let cancel = CancellationToken::new();
        let cancel2 = cancel.clone();
        let handle = tokio::spawn(async move { agg.run(cancel2).await });

        // No input, just ticks. No batch should arrive.
        let polled = tokio::time::timeout(Duration::from_millis(100), out_rx.recv()).await;
        assert!(polled.is_err(), "empty buffer must not flush a batch");

        drop(in_tx);
        cancel.cancel();
        let count = handle.await.unwrap().unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn output_closed_returns_error() {
        let opts = BatchOpts {
            max_batch_size: 1,
            flush_interval: Duration::from_secs(60),
        };
        let (agg, in_tx, out_rx) = BatchAggregator::new(opts, 16, 8).unwrap();
        let cancel = CancellationToken::new();
        let handle = tokio::spawn(async move { agg.run(cancel).await });

        // Drop the receiver immediately, then push a reading. The
        // aggregator's send().await fails and the run loop returns
        // OutputClosed.
        drop(out_rx);
        in_tx.send(reading()).await.unwrap();
        let result = tokio::time::timeout(Duration::from_secs(1), handle)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(result, Err(BatchError::OutputClosed)));
    }
}
