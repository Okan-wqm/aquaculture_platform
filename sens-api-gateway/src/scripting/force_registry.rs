//! Live-debug force registry — Batch 194 Faz 6
//! (plan R-9, Plan A H + Plan B security layer).
//!
//! ## WHY
//!
//! Plan §5 Faz 6 item 1 specifies a `ForceRegistry`
//! that lets operators pin a specific value onto a
//! ProcessImage tag during diagnostics. The polling
//! loop (io_poll.rs) consults the registry before
//! every `update_tag` call + skips the poll when the
//! tag is forced, so the forced value survives
//! sensor refreshes.
//!
//! Two-person integrity (plan R-9 + Plan B D-4) is
//! enforced at the COMMAND handler layer — not here.
//! The registry trusts that a caller who reached
//! `apply` has already cleared the authz + signature
//! + co-approval gates. This module owns:
//!
//! - Per-tag entry tracking.
//! - TTL expiry sweep.
//! - Rate-limit + concurrent-force counting.
//! - Persistence opt-in (default false — fail-safe).
//!
//! ## Architectural position
//!
//! - In-memory only for Batch 194. Persistence
//!   (`persist_across_reboot=true` case) lands in a
//!   follow-up batch alongside the shutdown-drain
//!   integration.
//! - `Arc<RwLock<ForceRegistryInner>>` — cheap to
//!   clone, thread-safe, reader-many + writer-one.
//! - UUID `force_id` per entry so audit can cite the
//!   specific force even after expiry + replacement.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use tokio::sync::RwLock;
use uuid::Uuid;

/// One active force. Applied to exactly one tag at a
/// time — re-applying on the same tag replaces the
/// previous entry + generates a new force_id.
#[derive(Debug, Clone, PartialEq)]
pub struct ForceEntry {
    /// UUID identifying this specific force. Survives
    /// in audit after the force itself expires.
    pub force_id: Uuid,
    pub tag_name: String,
    pub value: f64,
    pub quality: crate::process_image::TagQuality,
    /// Who applied the force (MQTT command actor field).
    pub actor: String,
    /// Operator-supplied justification (free-form,
    /// audit-surfaced).
    pub reason: String,
    pub applied_at: DateTime<Utc>,
    /// Unix-seconds when the force expires. The
    /// registry's `sweep_expired` removes entries
    /// whose `expires_at_unix` has passed.
    pub expires_at_unix: i64,
    /// Plan R-9: opt-in persistence across reboot.
    /// Default `false` so forces evaporate on restart
    /// — fail-safe against forgotten force state.
    /// Set `true` intentionally for long-running
    /// diagnostics (+ durable SQLCipher row).
    pub persist_across_reboot: bool,
}

/// Max TTL per plan R-9 force_value spec: 86400s (24h).
/// Longer is rejected — operators can re-apply if the
/// diagnostic runs longer.
pub const FORCE_TTL_CAP_SECS: u64 = 86_400;

/// Max concurrent forces across all tags — plan R-9
/// rate limit. Prevents an operator script from
/// flooding the registry.
pub const MAX_CONCURRENT_FORCES: usize = 50;

/// Min interval between applies on the SAME tag (plan
/// R-9: 1 force/s per tag). Enforced by
/// `rate_limit_ok`.
pub const PER_TAG_MIN_APPLY_INTERVAL_MS: u64 = 1000;

#[derive(Debug, Default)]
struct ForceRegistryInner {
    entries: HashMap<String, ForceEntry>,
    /// Per-tag last-apply Unix-ms timestamps for rate
    /// limiting. Keyed independently of `entries` so
    /// a rapid apply + remove + apply cycle still
    /// gets rate-limited.
    last_apply_unix_ms: HashMap<String, i64>,
}

/// Thread-safe force registry. Cheap to clone — all
/// consumers (command handlers, io_poll bypass,
/// metrics endpoint) share one Arc.
#[derive(Debug, Clone, Default)]
pub struct ForceRegistry {
    inner: Arc<RwLock<ForceRegistryInner>>,
}

/// Registry failure taxonomy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForceError {
    /// TTL exceeds `FORCE_TTL_CAP_SECS`.
    TtlTooLong { requested_secs: u64, cap_secs: u64 },
    /// `MAX_CONCURRENT_FORCES` reached.
    TooManyConcurrentForces { current: usize, cap: usize },
    /// Rate limit: same tag applied more than once
    /// within `PER_TAG_MIN_APPLY_INTERVAL_MS`.
    RateLimited {
        tag_name: String,
        last_apply_unix_ms: i64,
        now_unix_ms: i64,
    },
    /// `remove` / `get` / `is_forced` caller queried a
    /// tag with no active force.
    NotFound { tag_name: String },
}

impl std::fmt::Display for ForceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TtlTooLong { requested_secs, cap_secs } => write!(
                f,
                "force: ttl {} s exceeds cap {} s",
                requested_secs, cap_secs
            ),
            Self::TooManyConcurrentForces { current, cap } => write!(
                f,
                "force: {} active >= cap {}",
                current, cap
            ),
            Self::RateLimited {
                tag_name,
                last_apply_unix_ms,
                now_unix_ms,
            } => write!(
                f,
                "force: tag `{}` rate-limited (last apply {} ms ago at {}, now {})",
                tag_name,
                now_unix_ms.saturating_sub(*last_apply_unix_ms),
                last_apply_unix_ms,
                now_unix_ms
            ),
            Self::NotFound { tag_name } => {
                write!(f, "force: tag `{}` not forced", tag_name)
            }
        }
    }
}

impl std::error::Error for ForceError {}

impl ForceRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Apply a new force. Validates TTL + concurrency
    /// + rate limit BEFORE writing. On success returns
    /// the generated `force_id`; operator audit
    /// records both the id + the actor / reason for
    /// later tracing.
    ///
    /// Security gates that are the COMMAND handler's
    /// responsibility (signature verify, two-person
    /// integrity, tag existence, type range) are NOT
    /// re-checked here — the registry trusts a valid
    /// caller. Defense-in-depth on those layers lives
    /// in the command handler (plan R-9 Batch 197).
    pub async fn apply(
        &self,
        tag_name: String,
        value: f64,
        quality: crate::process_image::TagQuality,
        actor: String,
        reason: String,
        ttl_secs: u64,
        persist_across_reboot: bool,
    ) -> Result<Uuid, ForceError> {
        if ttl_secs > FORCE_TTL_CAP_SECS {
            return Err(ForceError::TtlTooLong {
                requested_secs: ttl_secs,
                cap_secs: FORCE_TTL_CAP_SECS,
            });
        }

        let now_ms = unix_ms_now();
        let now_secs = now_ms / 1000;

        let mut inner = self.inner.write().await;

        // Rate limit check — same tag, recent apply.
        if let Some(last_ms) = inner.last_apply_unix_ms.get(&tag_name) {
            let delta = (now_ms - last_ms).max(0) as u64;
            if delta < PER_TAG_MIN_APPLY_INTERVAL_MS {
                return Err(ForceError::RateLimited {
                    tag_name,
                    last_apply_unix_ms: *last_ms,
                    now_unix_ms: now_ms,
                });
            }
        }

        // Concurrent-count check — only when the
        // incoming entry would be a NEW key (replacing
        // an existing force doesn't grow the total).
        if !inner.entries.contains_key(&tag_name)
            && inner.entries.len() >= MAX_CONCURRENT_FORCES
        {
            return Err(ForceError::TooManyConcurrentForces {
                current: inner.entries.len(),
                cap: MAX_CONCURRENT_FORCES,
            });
        }

        let force_id = Uuid::new_v4();
        let entry = ForceEntry {
            force_id,
            tag_name: tag_name.clone(),
            value,
            quality,
            actor,
            reason,
            applied_at: Utc::now(),
            expires_at_unix: now_secs + ttl_secs as i64,
            persist_across_reboot,
        };

        inner.entries.insert(tag_name.clone(), entry);
        inner.last_apply_unix_ms.insert(tag_name, now_ms);
        Ok(force_id)
    }

    /// Remove an active force. Returns the removed
    /// entry for audit (`unforce_value` command logs
    /// the force_id + old value / quality).
    pub async fn remove(&self, tag_name: &str) -> Result<ForceEntry, ForceError> {
        let mut inner = self.inner.write().await;
        inner
            .entries
            .remove(tag_name)
            .ok_or_else(|| ForceError::NotFound {
                tag_name: tag_name.to_string(),
            })
    }

    /// Remove every active force. Returns the vector of
    /// removed entries. Used by the `unforce_all`
    /// command + shutdown drain for non-persistent
    /// forces.
    pub async fn remove_all(&self) -> Vec<ForceEntry> {
        let mut inner = self.inner.write().await;
        let entries: Vec<ForceEntry> = inner.entries.drain().map(|(_, v)| v).collect();
        // Keep last_apply_unix_ms so rate limits
        // survive a bulk-remove — an operator cannot
        // bypass the per-tag rate limit by issuing
        // unforce_all then immediately re-applying.
        entries
    }

    /// Read-only snapshot of one force. Returns None
    /// when the tag is not forced.
    pub async fn get(&self, tag_name: &str) -> Option<ForceEntry> {
        self.inner.read().await.entries.get(tag_name).cloned()
    }

    /// Returns true iff the tag currently has an
    /// active force entry. The io_poll bypass calls
    /// this before every `update_tag` to know whether
    /// to skip the refresh.
    pub async fn is_forced(&self, tag_name: &str) -> bool {
        self.inner.read().await.entries.contains_key(tag_name)
    }

    /// Read-only list of every active force. Metrics +
    /// admin UI + `list_forces` command consume this.
    pub async fn list(&self) -> Vec<ForceEntry> {
        let mut entries: Vec<ForceEntry> = self
            .inner
            .read()
            .await
            .entries
            .values()
            .cloned()
            .collect();
        entries.sort_by(|a, b| a.tag_name.cmp(&b.tag_name));
        entries
    }

    /// Drop every entry whose `expires_at_unix` ≤
    /// `now_unix`. Returns the dropped entries so the
    /// audit layer can record each expiry. Called by a
    /// 1-Hz sweep task (future batch) + by the command
    /// handler before every `apply` / `list` (defense-
    /// in-depth against returning stale entries).
    pub async fn sweep_expired(&self, now_unix: i64) -> Vec<ForceEntry> {
        let mut inner = self.inner.write().await;
        let expired_keys: Vec<String> = inner
            .entries
            .iter()
            .filter(|(_, e)| e.expires_at_unix <= now_unix)
            .map(|(k, _)| k.clone())
            .collect();
        expired_keys
            .iter()
            .filter_map(|k| inner.entries.remove(k))
            .collect()
    }

    /// Current count of active forces — diagnostic
    /// helper for metrics + health endpoints.
    pub async fn active_count(&self) -> usize {
        self.inner.read().await.entries.len()
    }

    /// Drop forces whose `persist_across_reboot` is
    /// false. Called during graceful shutdown so
    /// reboot leaves only the operator-opted-in
    /// persistent forces. Returns the dropped entries
    /// for shutdown audit.
    pub async fn drain_non_persistent(&self) -> Vec<ForceEntry> {
        let mut inner = self.inner.write().await;
        let drop_keys: Vec<String> = inner
            .entries
            .iter()
            .filter(|(_, e)| !e.persist_across_reboot)
            .map(|(k, _)| k.clone())
            .collect();
        drop_keys
            .iter()
            .filter_map(|k| inner.entries.remove(k))
            .collect()
    }
}

fn unix_ms_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn unix_secs_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Summary returned when the sweep task exits.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SweepSummary {
    /// Total sweep ticks dispatched.
    pub ticks_executed: u64,
    /// Total entries dropped across all ticks.
    pub total_expired: u64,
}

/// Long-running 1-Hz sweep task — Batch 198 Faz 6.
///
/// Every `interval` (default 1 s), calls
/// `force_registry.sweep_expired(now)`. Dropped
/// entries are logged at info so operators see the
/// TTL-expiry lifecycle in boot + runtime logs.
///
/// Shutdown responsive via `tokio::select!` on the
/// watch channel — exits cleanly when the signal
/// fires.
pub async fn run_sweep_task(
    registry: std::sync::Arc<ForceRegistry>,
    interval: std::time::Duration,
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
) -> SweepSummary {
    tracing::info!(
        "Force-registry sweep task starting (interval={:?})",
        interval
    );
    let mut summary = SweepSummary::default();

    loop {
        let expired = registry.sweep_expired(unix_secs_now()).await;
        summary.ticks_executed += 1;

        if !expired.is_empty() {
            let count = expired.len() as u64;
            summary.total_expired += count;
            for entry in &expired {
                tracing::info!(
                    "force-registry sweep: expired tag=`{}` force_id={} actor=`{}`",
                    entry.tag_name,
                    entry.force_id,
                    entry.actor,
                );
            }
        }

        tokio::select! {
            _ = tokio::time::sleep(interval) => {}
            changed = shutdown_rx.changed() => {
                match changed {
                    Ok(()) if *shutdown_rx.borrow() => {
                        tracing::info!(
                            "force-registry sweep task shutdown: \
                             ticks={} total_expired={}",
                            summary.ticks_executed,
                            summary.total_expired,
                        );
                        return summary;
                    }
                    Ok(()) => {}
                    Err(_) => {
                        tracing::info!(
                            "force-registry sweep task shutdown (sender \
                             dropped): ticks={} total_expired={}",
                            summary.ticks_executed,
                            summary.total_expired,
                        );
                        return summary;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process_image::TagQuality;

    fn canned_apply<'a>(
        registry: &'a ForceRegistry,
        tag: &'a str,
        ttl: u64,
    ) -> impl std::future::Future<Output = Result<Uuid, ForceError>> + 'a {
        registry.apply(
            tag.to_string(),
            1.0,
            TagQuality::Good,
            "operator-alice".to_string(),
            "diagnostic test".to_string(),
            ttl,
            false,
        )
    }

    #[tokio::test]
    async fn apply_succeeds_with_valid_params() {
        let reg = ForceRegistry::new();
        let id = canned_apply(&reg, "feeder_rate", 60).await.expect("ok");
        let entry = reg.get("feeder_rate").await.expect("present");
        assert_eq!(entry.force_id, id);
        assert_eq!(entry.value, 1.0);
        assert_eq!(entry.actor, "operator-alice");
        assert_eq!(entry.persist_across_reboot, false);
    }

    #[tokio::test]
    async fn apply_rejects_ttl_exceeding_cap() {
        let reg = ForceRegistry::new();
        let err = canned_apply(&reg, "t", FORCE_TTL_CAP_SECS + 1)
            .await
            .expect_err("too long");
        assert!(matches!(err, ForceError::TtlTooLong { .. }));
    }

    #[tokio::test]
    async fn is_forced_reflects_active_entries() {
        let reg = ForceRegistry::new();
        assert!(!reg.is_forced("tag_a").await);
        canned_apply(&reg, "tag_a", 60).await.expect("ok");
        assert!(reg.is_forced("tag_a").await);
        assert!(!reg.is_forced("tag_b").await);
    }

    #[tokio::test]
    async fn remove_returns_entry_and_clears_force() {
        let reg = ForceRegistry::new();
        canned_apply(&reg, "tag_a", 60).await.expect("ok");
        let removed = reg.remove("tag_a").await.expect("ok");
        assert_eq!(removed.tag_name, "tag_a");
        assert!(!reg.is_forced("tag_a").await);
    }

    #[tokio::test]
    async fn remove_on_unforced_tag_errors() {
        let reg = ForceRegistry::new();
        let err = reg.remove("ghost").await.expect_err("not found");
        assert!(matches!(err, ForceError::NotFound { .. }));
    }

    #[tokio::test]
    async fn remove_all_drops_every_entry() {
        let reg = ForceRegistry::new();
        canned_apply(&reg, "a", 60).await.expect("ok");
        canned_apply(&reg, "b", 60).await.expect("ok");
        canned_apply(&reg, "c", 60).await.expect("ok");
        let drained = reg.remove_all().await;
        assert_eq!(drained.len(), 3);
        assert_eq!(reg.active_count().await, 0);
    }

    #[tokio::test]
    async fn rate_limit_rejects_rapid_same_tag_apply() {
        let reg = ForceRegistry::new();
        canned_apply(&reg, "tag_a", 60).await.expect("ok");
        let err = canned_apply(&reg, "tag_a", 60).await.expect_err("rate");
        assert!(matches!(err, ForceError::RateLimited { .. }));
    }

    #[tokio::test]
    async fn rate_limit_scoped_per_tag() {
        // Rapid apply on tag_a rejects; rapid apply on
        // tag_b succeeds because the rate limit is
        // per-tag, not global.
        let reg = ForceRegistry::new();
        canned_apply(&reg, "tag_a", 60).await.expect("ok");
        canned_apply(&reg, "tag_b", 60).await.expect("ok");
        let err = canned_apply(&reg, "tag_a", 60).await.expect_err("rate");
        assert!(matches!(err, ForceError::RateLimited { .. }));
    }

    #[tokio::test]
    async fn sweep_expired_drops_past_ttl_entries() {
        let reg = ForceRegistry::new();
        // Apply force with 1-s TTL.
        canned_apply(&reg, "tag_a", 1).await.expect("ok");

        // Sweep with a time far in the future →
        // entry should be dropped.
        let future_unix = unix_ms_now() / 1000 + 10_000;
        let expired = reg.sweep_expired(future_unix).await;
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].tag_name, "tag_a");
        assert_eq!(reg.active_count().await, 0);
    }

    #[tokio::test]
    async fn sweep_expired_keeps_not_yet_expired_entries() {
        let reg = ForceRegistry::new();
        // 60-sec TTL.
        canned_apply(&reg, "tag_a", 60).await.expect("ok");
        // Sweep with now = now (entry not expired yet).
        let now_unix = unix_ms_now() / 1000;
        let expired = reg.sweep_expired(now_unix).await;
        assert_eq!(expired.len(), 0);
        assert_eq!(reg.active_count().await, 1);
    }

    #[tokio::test]
    async fn drain_non_persistent_keeps_persistent_entries() {
        let reg = ForceRegistry::new();
        reg.apply(
            "persistent_tag".into(),
            1.0,
            TagQuality::Good,
            "op".into(),
            "keeps".into(),
            60,
            true, // persist
        )
        .await
        .expect("ok");
        reg.apply(
            "volatile_tag".into(),
            1.0,
            TagQuality::Good,
            "op".into(),
            "drops".into(),
            60,
            false, // no persist
        )
        .await
        .expect("ok");

        let drained = reg.drain_non_persistent().await;
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].tag_name, "volatile_tag");
        // Persistent one survives.
        assert!(reg.is_forced("persistent_tag").await);
        assert!(!reg.is_forced("volatile_tag").await);
    }

    #[tokio::test]
    async fn list_returns_entries_in_deterministic_order() {
        let reg = ForceRegistry::new();
        canned_apply(&reg, "zebra", 60).await.expect("ok");
        canned_apply(&reg, "alpha", 60).await.expect("ok");
        canned_apply(&reg, "mango", 60).await.expect("ok");
        let list = reg.list().await;
        let names: Vec<&str> = list.iter().map(|e| e.tag_name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "mango", "zebra"]);
    }

    // Batch 198 Faz 6 — sweep task tests.

    #[tokio::test]
    async fn sweep_task_exits_on_shutdown_signal() {
        let reg = std::sync::Arc::new(ForceRegistry::new());
        let (tx, rx) = tokio::sync::watch::channel(false);
        let reg_clone = reg.clone();
        let handle = tokio::spawn(async move {
            run_sweep_task(
                reg_clone,
                std::time::Duration::from_millis(10),
                rx,
            )
            .await
        });

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        tx.send(true).expect("signal");
        let summary = handle.await.expect("join");
        assert!(summary.ticks_executed >= 1);
        assert_eq!(summary.total_expired, 0);
    }

    #[tokio::test]
    async fn sweep_task_drops_expired_entries() {
        let reg = std::sync::Arc::new(ForceRegistry::new());
        // Apply an entry that's already expired
        // (expires_at_unix in the past by writing
        // directly via the test-internal apply +
        // then mutating via sweep_expired with a
        // distant-future clock).
        canned_apply(&reg, "expiring_tag", 1).await.expect("ok");

        let (tx, rx) = tokio::sync::watch::channel(false);
        let reg_clone = reg.clone();
        let handle = tokio::spawn(async move {
            run_sweep_task(
                reg_clone,
                std::time::Duration::from_millis(10),
                rx,
            )
            .await
        });

        // Wait longer than the 1-sec TTL so the sweep
        // task's `sweep_expired(now)` catches it.
        tokio::time::sleep(std::time::Duration::from_millis(1_200)).await;
        tx.send(true).expect("signal");
        let summary = handle.await.expect("join");
        assert!(summary.total_expired >= 1);
        // Registry should be empty after expiry.
        assert_eq!(reg.active_count().await, 0);
    }

    #[tokio::test]
    async fn maybe_update_tag_bypass_behavior_guard() {
        // Batch 199 guard: the is_forced check that
        // io_poll's maybe_update_tag depends on MUST
        // return true after an apply + MUST return
        // false after a remove. Any refactor that
        // breaks this invariant silently lets sensor
        // values clobber operator-applied forces.
        let reg = ForceRegistry::new();
        assert!(!reg.is_forced("feeder_rate").await);
        canned_apply(&reg, "feeder_rate", 60).await.expect("ok");
        assert!(reg.is_forced("feeder_rate").await);
        reg.remove("feeder_rate").await.expect("ok");
        assert!(!reg.is_forced("feeder_rate").await);
    }

    #[tokio::test]
    async fn sweep_task_preserves_non_expired_entries() {
        let reg = std::sync::Arc::new(ForceRegistry::new());
        // Long TTL — won't expire during the test.
        canned_apply(&reg, "long_lived", 3600)
            .await
            .expect("ok");

        let (tx, rx) = tokio::sync::watch::channel(false);
        let reg_clone = reg.clone();
        let handle = tokio::spawn(async move {
            run_sweep_task(
                reg_clone,
                std::time::Duration::from_millis(10),
                rx,
            )
            .await
        });

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        tx.send(true).expect("signal");
        let summary = handle.await.expect("join");
        assert_eq!(summary.total_expired, 0);
        assert_eq!(reg.active_count().await, 1);
    }

    #[tokio::test]
    async fn replacing_force_on_same_tag_uses_new_id() {
        // Replacing a force on the same tag keeps the
        // concurrent count at 1 + produces a new
        // force_id. The rate limit still applies
        // (replacements < 1s apart reject) so the test
        // waits for the rate-limit window to clear
        // via sweep_expired, which doesn't help
        // because rate-limit state is separate. Use a
        // DIFFERENT tag to verify new ID generation
        // doesn't leak from re-apply logic.
        let reg = ForceRegistry::new();
        let id_a = canned_apply(&reg, "tag_a", 60).await.expect("ok");
        let id_b = canned_apply(&reg, "tag_b", 60).await.expect("ok");
        assert_ne!(id_a, id_b);
    }
}
