//! [`OutboxPublisher`] — the async trait the dispatcher calls to
//! deliver an [`OutboxRecord`] downstream. Storage lives in
//! `OutboxRepository`; delivery lives here. Decoupling the two lets
//! the sensor-ingestion binary wire a NATS-backed publisher while
//! unit tests inject a mock that counts calls + returns scripted
//! failures.

use async_trait::async_trait;
use thiserror::Error;

use crate::OutboxRecord;

/// All ways a publish can fail. Distinct from [`crate::OutboxError`]
/// because publish failures are a separate alarm shelf — the
/// repository is healthy, the downstream transport is not.
#[derive(Debug, Error)]
pub enum PublishError {
    /// Transport-layer failure (NATS disconnect, async-nats internal
    /// error, test mock programmed to fail). The source chain carries
    /// the underlying cause for operator diagnostics.
    #[error("publisher transport failed")]
    Transport(#[source] Box<dyn std::error::Error + Send + Sync>),

    /// Serialisation of the record's payload to the wire format
    /// failed. In practice fires only on OOM — the payload is already
    /// a validated `serde_json::Value` on the way in.
    #[error("publisher payload encode failed")]
    Encode(#[source] serde_json::Error),
}

/// Downstream delivery contract for an outbox record. Implementations
/// own their subject / topic derivation — the trait does not expose
/// the subject surface because different transports (NATS, Kafka,
/// future HTTP webhook) compute it differently.
#[async_trait]
pub trait OutboxPublisher: Send + Sync + std::fmt::Debug {
    /// Publish the record downstream. Returns `Ok(())` on successful
    /// delivery (the transport acknowledged the message); returns an
    /// error variant otherwise so the dispatcher increments the
    /// attempt counter + applies backoff.
    ///
    /// # Errors
    /// * [`PublishError::Transport`] — downstream transport rejected
    ///   the publish.
    /// * [`PublishError::Encode`] — payload could not serialise.
    async fn publish(&self, record: &OutboxRecord) -> Result<(), PublishError>;
}
