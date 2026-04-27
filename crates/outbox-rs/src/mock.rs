//! Test-only in-memory [`OutboxRepository`] + [`OutboxPublisher`]
//! implementations. `#[cfg(test)]`-gated by `crate::mock` at the
//! lib.rs declaration site so the production build never sees them.
//!
//! Clippy allows here apply only to the mock surface — the
//! production impls (`PgOutboxRepository`, the binary-side publisher)
//! stay under the full workspace lint rules.

// unused_async: the async trait impls forward to sync bodies by
// design — the trait signature is async (contract level), mock
// bodies don't need to be.
// cast_precision_loss: counts + row lengths in test assertions; the
// loss is numerically irrelevant at the scales tests exercise.
// significant_drop_tightening: MutexGuard-in-expression patterns in
// mock code; the PG impl is lock-free so the production lint stays
// meaningful elsewhere.
#![allow(
    clippy::unused_async,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::significant_drop_tightening,
    clippy::option_if_let_else
)]

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use tenant_context::TenantId;
use uuid::Uuid;

use crate::{
    ClaimBatch, OutboxError, OutboxRecord, OutboxRepository, OutboxStatus,
    publisher::{OutboxPublisher, PublishError},
    repository::validate_event_type,
};

/// In-memory outbox storage. Used by dispatcher + maintenance unit
/// tests to drive the full pipeline deterministically without a PG
/// instance.
#[derive(Debug)]
pub struct InMemoryOutbox {
    rows: Mutex<HashMap<Uuid, StoredRow>>,
}

#[derive(Debug, Clone)]
struct StoredRow {
    id: Uuid,
    tenant_id: TenantId,
    event_type: String,
    payload: serde_json::Value,
    created_at: DateTime<Utc>,
    dispatched_at: Option<DateTime<Utc>>,
    dispatch_attempts: u32,
    last_attempted_at: Option<DateTime<Utc>>,
    last_error: Option<String>,
}

impl StoredRow {
    fn to_record(&self) -> OutboxRecord {
        OutboxRecord {
            id: self.id,
            tenant_id: self.tenant_id,
            event_type: self.event_type.clone(),
            payload: self.payload.clone(),
            created_at: self.created_at,
            status: OutboxStatus::derive(self.dispatched_at, self.dispatch_attempts),
            dispatch_attempts: self.dispatch_attempts,
            last_attempted_at: self.last_attempted_at,
            last_error: self.last_error.clone(),
        }
    }
}

impl InMemoryOutbox {
    pub fn new() -> Self {
        Self {
            rows: Mutex::new(HashMap::new()),
        }
    }

    /// Direct enqueue used by tests. Mirrors the shape of the real
    /// PG enqueue but does not need a transaction handle.
    pub async fn enqueue_direct(
        &self,
        tenant_id: TenantId,
        event_type: &str,
        payload: serde_json::Value,
    ) -> Result<Uuid, OutboxError> {
        validate_event_type(event_type)?;
        let id = Uuid::new_v4();
        let row = StoredRow {
            id,
            tenant_id,
            event_type: event_type.to_owned(),
            payload,
            created_at: Utc::now(),
            dispatched_at: None,
            dispatch_attempts: 0,
            last_attempted_at: None,
            last_error: None,
        };
        self.rows.lock().unwrap().insert(id, row);
        Ok(id)
    }

    /// Read-only accessor for tests — returns a snapshot of the
    /// record in its current state.
    pub fn get(&self, id: &Uuid) -> Option<OutboxRecord> {
        self.rows.lock().unwrap().get(id).map(StoredRow::to_record)
    }

    /// Force the attempt count + last_attempted_at on a stored row.
    /// Tests use this to stage a record just below the DLQ threshold.
    pub fn force_attempts(&self, id: &Uuid, attempts: u32) {
        if let Some(row) = self.rows.lock().unwrap().get_mut(id) {
            row.dispatch_attempts = attempts;
            row.last_attempted_at = Some(Utc::now() - chrono::Duration::seconds(3600));
        }
    }
}

#[async_trait]
impl OutboxRepository for InMemoryOutbox {
    async fn enqueue(
        &self,
        tenant_id: TenantId,
        event_type: &str,
        payload: serde_json::Value,
    ) -> Result<Uuid, OutboxError> {
        self.enqueue_direct(tenant_id, event_type, payload).await
    }

    async fn claim_pending(&self, req: ClaimBatch) -> Result<Vec<OutboxRecord>, OutboxError> {
        let guard = self.rows.lock().unwrap();
        let mut eligible: Vec<&StoredRow> = guard
            .values()
            .filter(|r| r.dispatched_at.is_none() && r.dispatch_attempts < crate::DLQ_THRESHOLD)
            .filter(|r| match r.last_attempted_at {
                None => true,
                Some(last) => {
                    let backoff_secs = req.backoff_base.as_secs_f64()
                        * 2f64.powi(i32::from(
                            u8::try_from(r.dispatch_attempts.min(10)).unwrap_or(10),
                        ));
                    last + chrono::Duration::from_std(Duration::from_secs_f64(backoff_secs))
                        .unwrap_or_else(|_| chrono::Duration::zero())
                        < req.now
                }
            })
            .collect();
        eligible.sort_by_key(|r| r.created_at);
        let limit = usize::try_from(req.limit).unwrap_or(usize::MAX);
        Ok(eligible
            .into_iter()
            .take(limit)
            .map(StoredRow::to_record)
            .collect())
    }

    async fn mark_dispatched(&self, id: Uuid) -> Result<(), OutboxError> {
        let mut guard = self.rows.lock().unwrap();
        match guard.get_mut(&id) {
            None => Err(OutboxError::RecordNotFound { id }),
            Some(row) => {
                if row.dispatched_at.is_none() {
                    row.dispatched_at = Some(Utc::now());
                }
                Ok(())
            }
        }
    }

    async fn mark_failed(&self, id: Uuid, error: &str) -> Result<(), OutboxError> {
        let mut guard = self.rows.lock().unwrap();
        match guard.get_mut(&id) {
            None => Err(OutboxError::RecordNotFound { id }),
            Some(row) => {
                if row.dispatched_at.is_none() {
                    row.dispatch_attempts += 1;
                    row.last_attempted_at = Some(Utc::now());
                    row.last_error = Some(error.to_owned());
                }
                Ok(())
            }
        }
    }

    async fn cleanup_published(&self, max_age: Duration) -> Result<u64, OutboxError> {
        let cutoff = Utc::now() - chrono::Duration::from_std(max_age).unwrap_or_default();
        let mut guard = self.rows.lock().unwrap();
        let before = guard.len();
        guard.retain(|_, r| r.dispatched_at.is_none_or(|d| d >= cutoff));
        let deleted = before.saturating_sub(guard.len());
        Ok(deleted as u64)
    }

    async fn pending_count(&self) -> Result<u64, OutboxError> {
        let guard = self.rows.lock().unwrap();
        let count = guard
            .values()
            .filter(|r| r.dispatched_at.is_none() && r.dispatch_attempts < crate::DLQ_THRESHOLD)
            .count();
        Ok(count as u64)
    }
}

/// Scripted publisher for tests. Counts calls; either always succeeds
/// or always fails with a canned error.
#[derive(Debug)]
pub struct MockPublisher {
    published: Mutex<u64>,
    error_message: Option<String>,
}

impl MockPublisher {
    pub fn new_always_ok() -> Self {
        Self {
            published: Mutex::new(0),
            error_message: None,
        }
    }

    pub fn new_always_err(msg: &str) -> Self {
        Self {
            published: Mutex::new(0),
            error_message: Some(msg.to_owned()),
        }
    }

    pub fn published_count(&self) -> u64 {
        *self.published.lock().unwrap()
    }
}

#[async_trait]
impl OutboxPublisher for MockPublisher {
    async fn publish(&self, _record: &OutboxRecord) -> Result<(), PublishError> {
        if let Some(_msg) = &self.error_message {
            return Err(PublishError::Transport(Box::new(std::io::Error::other(
                "mock transport failed",
            ))));
        }
        *self.published.lock().unwrap() += 1;
        Ok(())
    }
}
