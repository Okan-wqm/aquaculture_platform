//! Live-watch session registry — Batch 203 Faz 6
//! (plan R-9 watch_subscribe).
//!
//! ## WHY
//!
//! Plan §5 Faz 6 item 4 specifies:
//! - `watch_subscribe{tags, interval_ms, ttl_secs}` →
//!   publisher task → topic
//!   `tenants/{tid}/devices/{did}/watch/{session_id}`.
//! - `watch_unsubscribe{session_id}`.
//!
//! The use case is live operator debugging: the cloud
//! UI subscribes to N tags + receives their values
//! every `interval_ms` for `ttl_secs` seconds. When
//! the TTL expires or the operator unsubscribes, the
//! publisher stops + the session evaporates.
//!
//! Batch 203 lands the REGISTRY primitive: per-session
//! metadata (tag list, interval, expiry, next-fire
//! timestamp). The publisher task itself lands in
//! Batch 204 + the MQTT command handlers in Batch 205.
//!
//! Design matches the Batch 194 ForceRegistry pattern
//! so operators see consistent shape + both registries
//! drain cleanly at shutdown.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use tokio::sync::RwLock;
use uuid::Uuid;

/// One active watch session. Each represents one
/// operator-side subscription (e.g. the debug UI
/// panel for a specific device).
#[derive(Debug, Clone, PartialEq)]
pub struct WatchSession {
    pub session_id: Uuid,
    /// Tag names the session wants to receive
    /// updates for. Publisher task reads values from
    /// ProcessImage for each + bundles into one
    /// payload per interval.
    pub tags: Vec<String>,
    /// Operator-requested publish cadence. Capped
    /// to `WATCH_MIN_INTERVAL_MS` so a misconfigured
    /// session can't DoS the broker.
    pub interval_ms: u64,
    /// Who created the session (for audit + cloud
    /// UI display).
    pub actor: String,
    pub created_at: DateTime<Utc>,
    /// Unix-seconds when the session expires. The
    /// sweep task removes entries past this; the
    /// publisher task stops publishing for them.
    pub expires_at_unix: i64,
    /// Monotonic timestamp (unix-ms) of the next
    /// publish. Publisher task checks against
    /// `now_unix_ms` to decide whether this session
    /// fires this cycle.
    pub next_publish_unix_ms: i64,
}

/// Min acceptable watch publish interval (plan R-9
/// rate-limit default: 100 ms). Lower values
/// rejected at apply time to prevent DoS.
pub const WATCH_MIN_INTERVAL_MS: u64 = 100;

/// Max acceptable TTL — plan R-9 says "watch sessions
/// SHOULD be short-lived diagnostic windows". 1 h cap
/// matches force-registry TTL rationale (24h allowed
/// for forces; watch sessions are more bandwidth-
/// sensitive so cap is lower).
pub const WATCH_TTL_CAP_SECS: u64 = 3600;

/// Max concurrent watch sessions per device. A single
/// device serving 20+ concurrent live-watch streams
/// would saturate the broker + the MQTT outbound
/// queue.
pub const MAX_CONCURRENT_WATCH_SESSIONS: usize = 20;

#[derive(Debug, Default)]
struct WatchSessionRegistryInner {
    entries: HashMap<Uuid, WatchSession>,
}

/// Thread-safe watch-session registry. Cheap to
/// clone via Arc — publisher task + command
/// handlers + sweep task share one instance.
#[derive(Debug, Clone, Default)]
pub struct WatchSessionRegistry {
    inner: Arc<RwLock<WatchSessionRegistryInner>>,
}

/// Registry failure taxonomy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchError {
    IntervalTooShort { requested_ms: u64, floor_ms: u64 },
    TtlTooLong { requested_secs: u64, cap_secs: u64 },
    TooManyConcurrentSessions { current: usize, cap: usize },
    NotFound { session_id: Uuid },
    EmptyTagList,
}

impl std::fmt::Display for WatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::IntervalTooShort { requested_ms, floor_ms } => write!(
                f,
                "watch: interval {} ms below floor {} ms",
                requested_ms, floor_ms
            ),
            Self::TtlTooLong { requested_secs, cap_secs } => write!(
                f,
                "watch: ttl {} s exceeds cap {} s",
                requested_secs, cap_secs
            ),
            Self::TooManyConcurrentSessions { current, cap } => write!(
                f,
                "watch: {} active >= cap {}",
                current, cap
            ),
            Self::NotFound { session_id } => {
                write!(f, "watch: session {} not found", session_id)
            }
            Self::EmptyTagList => {
                write!(f, "watch: tags list cannot be empty")
            }
        }
    }
}

impl std::error::Error for WatchError {}

impl WatchSessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a new session. Validates all plan R-9
    /// gates before writing; returns the generated
    /// session_id on success.
    pub async fn subscribe(
        &self,
        tags: Vec<String>,
        interval_ms: u64,
        ttl_secs: u64,
        actor: String,
    ) -> Result<Uuid, WatchError> {
        if tags.is_empty() {
            return Err(WatchError::EmptyTagList);
        }
        if interval_ms < WATCH_MIN_INTERVAL_MS {
            return Err(WatchError::IntervalTooShort {
                requested_ms: interval_ms,
                floor_ms: WATCH_MIN_INTERVAL_MS,
            });
        }
        if ttl_secs > WATCH_TTL_CAP_SECS {
            return Err(WatchError::TtlTooLong {
                requested_secs: ttl_secs,
                cap_secs: WATCH_TTL_CAP_SECS,
            });
        }

        let now_ms = unix_ms_now();
        let now_secs = now_ms / 1000;
        let session_id = Uuid::new_v4();

        let mut inner = self.inner.write().await;
        if inner.entries.len() >= MAX_CONCURRENT_WATCH_SESSIONS {
            return Err(WatchError::TooManyConcurrentSessions {
                current: inner.entries.len(),
                cap: MAX_CONCURRENT_WATCH_SESSIONS,
            });
        }

        inner.entries.insert(
            session_id,
            WatchSession {
                session_id,
                tags,
                interval_ms,
                actor,
                created_at: Utc::now(),
                expires_at_unix: now_secs + ttl_secs as i64,
                // Fire immediately on first publisher tick.
                next_publish_unix_ms: now_ms,
            },
        );
        Ok(session_id)
    }

    /// Remove one session. Returns the removed
    /// session for audit.
    pub async fn unsubscribe(
        &self,
        session_id: &Uuid,
    ) -> Result<WatchSession, WatchError> {
        let mut inner = self.inner.write().await;
        inner.entries.remove(session_id).ok_or(WatchError::NotFound {
            session_id: *session_id,
        })
    }

    /// Read-only snapshot of one session.
    pub async fn get(&self, session_id: &Uuid) -> Option<WatchSession> {
        self.inner.read().await.entries.get(session_id).cloned()
    }

    /// Read-only list of every active session.
    pub async fn list(&self) -> Vec<WatchSession> {
        let mut entries: Vec<WatchSession> = self
            .inner
            .read()
            .await
            .entries
            .values()
            .cloned()
            .collect();
        entries.sort_by_key(|s| s.created_at);
        entries
    }

    /// Returns true iff at least one session exists.
    pub async fn has_any(&self) -> bool {
        !self.inner.read().await.entries.is_empty()
    }

    /// Number of active sessions — diagnostic.
    pub async fn active_count(&self) -> usize {
        self.inner.read().await.entries.len()
    }

    /// Return sessions whose `next_publish_unix_ms` is
    /// ≤ `now_ms`. Publisher task calls this each
    /// cycle + advances `next_publish_unix_ms` via
    /// `record_published` after fan-out completes.
    ///
    /// Also silently drops sessions whose TTL has
    /// passed (defense-in-depth — the dedicated
    /// sweep task handles the normal case).
    pub async fn sessions_to_publish(&self, now_ms: i64) -> Vec<WatchSession> {
        let now_secs = now_ms / 1000;
        let mut inner = self.inner.write().await;
        // Drop expired first.
        inner
            .entries
            .retain(|_, s| s.expires_at_unix > now_secs);
        inner
            .entries
            .values()
            .filter(|s| s.next_publish_unix_ms <= now_ms)
            .cloned()
            .collect()
    }

    /// Publisher calls after fan-out completes;
    /// advances `next_publish_unix_ms` by the
    /// session's interval.
    pub async fn record_published(&self, session_id: &Uuid, now_ms: i64) {
        let mut inner = self.inner.write().await;
        if let Some(s) = inner.entries.get_mut(session_id) {
            s.next_publish_unix_ms = now_ms + s.interval_ms as i64;
        }
    }

    /// Drop every entry whose `expires_at_unix <=
    /// now_secs`. Returns the dropped sessions for
    /// audit. Called by the 1-Hz sweep task (shares
    /// the Batch 198 sweep infrastructure).
    pub async fn sweep_expired(&self, now_secs: i64) -> Vec<WatchSession> {
        let mut inner = self.inner.write().await;
        let expired_keys: Vec<Uuid> = inner
            .entries
            .iter()
            .filter(|(_, s)| s.expires_at_unix <= now_secs)
            .map(|(k, _)| *k)
            .collect();
        expired_keys
            .iter()
            .filter_map(|k| inner.entries.remove(k))
            .collect()
    }

    /// Drop every entry. Shutdown drain — watch
    /// sessions are never `persist_across_reboot`
    /// (plan R-9: they're live debug sessions only).
    pub async fn remove_all(&self) -> Vec<WatchSession> {
        let mut inner = self.inner.write().await;
        inner.entries.drain().map(|(_, v)| v).collect()
    }
}

fn unix_ms_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn canned_subscribe(
        reg: &WatchSessionRegistry,
        tags: Vec<&str>,
    ) -> Result<Uuid, WatchError> {
        reg.subscribe(
            tags.iter().map(|s| s.to_string()).collect(),
            500,
            60,
            "operator-alice".to_string(),
        )
        .await
    }

    #[tokio::test]
    async fn subscribe_succeeds_with_valid_params() {
        let reg = WatchSessionRegistry::new();
        let id = canned_subscribe(&reg, vec!["water_temp", "ph"])
            .await
            .expect("ok");
        let s = reg.get(&id).await.expect("present");
        assert_eq!(s.tags, vec!["water_temp", "ph"]);
        assert_eq!(s.interval_ms, 500);
        assert_eq!(s.actor, "operator-alice");
    }

    #[tokio::test]
    async fn subscribe_rejects_empty_tags() {
        let reg = WatchSessionRegistry::new();
        let err = canned_subscribe(&reg, vec![]).await.expect_err("empty");
        assert!(matches!(err, WatchError::EmptyTagList));
    }

    #[tokio::test]
    async fn subscribe_rejects_interval_below_floor() {
        let reg = WatchSessionRegistry::new();
        let err = reg
            .subscribe(
                vec!["tag".to_string()],
                50, // below 100ms floor
                60,
                "op".to_string(),
            )
            .await
            .expect_err("too fast");
        assert!(matches!(err, WatchError::IntervalTooShort { .. }));
    }

    #[tokio::test]
    async fn subscribe_rejects_ttl_exceeding_cap() {
        let reg = WatchSessionRegistry::new();
        let err = reg
            .subscribe(
                vec!["tag".to_string()],
                500,
                WATCH_TTL_CAP_SECS + 1,
                "op".to_string(),
            )
            .await
            .expect_err("ttl too long");
        assert!(matches!(err, WatchError::TtlTooLong { .. }));
    }

    #[tokio::test]
    async fn unsubscribe_returns_session_and_clears() {
        let reg = WatchSessionRegistry::new();
        let id = canned_subscribe(&reg, vec!["t"]).await.expect("ok");
        let removed = reg.unsubscribe(&id).await.expect("ok");
        assert_eq!(removed.session_id, id);
        assert!(reg.get(&id).await.is_none());
    }

    #[tokio::test]
    async fn unsubscribe_unknown_id_errors() {
        let reg = WatchSessionRegistry::new();
        let err = reg
            .unsubscribe(&Uuid::new_v4())
            .await
            .expect_err("not found");
        assert!(matches!(err, WatchError::NotFound { .. }));
    }

    #[tokio::test]
    async fn sessions_to_publish_returns_due_sessions() {
        let reg = WatchSessionRegistry::new();
        let _ = canned_subscribe(&reg, vec!["t"]).await.expect("ok");
        // Session was created at now; next_publish=now
        // so it's immediately due.
        let now_ms = unix_ms_now();
        let due = reg.sessions_to_publish(now_ms).await;
        assert_eq!(due.len(), 1);
    }

    #[tokio::test]
    async fn record_published_advances_next_fire() {
        let reg = WatchSessionRegistry::new();
        let id = canned_subscribe(&reg, vec!["t"]).await.expect("ok");
        let now_ms = unix_ms_now();
        reg.record_published(&id, now_ms).await;
        let session = reg.get(&id).await.expect("present");
        // Interval was 500 ms, so next fire >= now+500.
        assert!(session.next_publish_unix_ms >= now_ms + 500);
    }

    #[tokio::test]
    async fn sweep_expired_drops_past_ttl_sessions() {
        let reg = WatchSessionRegistry::new();
        let id = reg
            .subscribe(
                vec!["t".to_string()],
                500,
                1, // 1-sec TTL
                "op".to_string(),
            )
            .await
            .expect("ok");
        let future_secs = unix_ms_now() / 1000 + 10;
        let expired = reg.sweep_expired(future_secs).await;
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].session_id, id);
        assert!(reg.get(&id).await.is_none());
    }

    #[tokio::test]
    async fn concurrent_session_cap_enforced() {
        let reg = WatchSessionRegistry::new();
        for i in 0..MAX_CONCURRENT_WATCH_SESSIONS {
            canned_subscribe(&reg, vec![format!("tag_{}", i).as_str()])
                .await
                .expect("ok");
        }
        // One more over cap → reject.
        let err = canned_subscribe(&reg, vec!["overflow"])
            .await
            .expect_err("cap");
        assert!(matches!(err, WatchError::TooManyConcurrentSessions { .. }));
    }

    #[tokio::test]
    async fn list_sorts_by_creation_time() {
        let reg = WatchSessionRegistry::new();
        canned_subscribe(&reg, vec!["a"]).await.expect("ok");
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        canned_subscribe(&reg, vec!["b"]).await.expect("ok");
        let list = reg.list().await;
        assert_eq!(list.len(), 2);
        assert!(list[0].created_at <= list[1].created_at);
    }

    #[tokio::test]
    async fn remove_all_clears_every_session() {
        let reg = WatchSessionRegistry::new();
        canned_subscribe(&reg, vec!["a"]).await.expect("ok");
        canned_subscribe(&reg, vec!["b"]).await.expect("ok");
        canned_subscribe(&reg, vec!["c"]).await.expect("ok");
        let drained = reg.remove_all().await;
        assert_eq!(drained.len(), 3);
        assert_eq!(reg.active_count().await, 0);
    }
}
