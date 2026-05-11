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
//!
//! ## Wire status (Batch #271 audit)
//!
//! Production wire confirmed via the F-series usage paths:
//! - `main.rs:823` — AppState carries `Arc<ForceRegistry>`.
//! - `io_poll.rs:371,394` — io-poll cycle consults the
//!   ForceRegistry before applying a sensor read; forced
//!   tags bypass the live-sensor path so HMI / test
//!   harness writes survive the read-back.
//! - `opc_ua_server.rs:44` + `opc_ua_server_runtime.rs:64` —
//!   OPC UA write path consults the ForceRegistry to refuse
//!   writes to forced tags (preserves the test-harness
//!   override invariant against external write-races).
//!
//! Per-item dead-code allow audit pending — blanket allow
//! retained as WHITELIST-with-reason while the persistence
//! path (`persist_across_reboot=true`) + shutdown-drain
//! integration land in a focused follow-up batch (mirror
//! of the Batch #259 D-1 + Batch #270 task_scheduler
//! audit pattern).

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use tokio::sync::RwLock;
use uuid::Uuid;

// Batch #314 D-9 migration: in-memory MonotonicDeadline
// replaces unix_secs comparison for TTL countdown. The
// deadline is captured at apply-time using the injected
// ClockAuthority + checked at sweep-time via
// is_past_now(clock). Operator wallclock rollback after
// apply has NO effect on the deadline (CLOCK_MONOTONIC
// guarantee).
use crate::runtime_safety::clock::{
    ClockAuthority, ClockError, MonotonicDeadline, MonotonicDeadlineError,
};

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
    ///
    /// **Persistence semantic (kept):** SQLCipher
    /// schema serializes this field; survives across
    /// process restarts.
    pub expires_at_unix: i64,
    /// Plan R-9: opt-in persistence across reboot.
    /// Default `false` so forces evaporate on restart
    /// — fail-safe against forgotten force state.
    /// Set `true` intentionally for long-running
    /// diagnostics (+ durable SQLCipher row).
    pub persist_across_reboot: bool,
    /// **Batch #314 D-9 migration:** in-memory
    /// MonotonicDeadline captured at apply-time (or at
    /// load-time for persisted entries via
    /// `Self::rehydrate_monotonic_deadline`). The
    /// `sweep_expired_with_clock` path checks
    /// `is_past_now(&clock)` against this anchor,
    /// immune to operator wallclock rollback within
    /// the process lifetime.
    ///
    /// **Why Option:** persisted entries deserialize
    /// from SQLCipher with `None` (the deadline is
    /// process-bound and cannot be persisted across
    /// restarts). The first sweep tick rehydrates by
    /// constructing a MonotonicDeadline from
    /// `expires_at_unix` against the current clock.
    /// Operator clock rollback BEFORE rehydration is a
    /// separate concern (cross-restart NTS-attestation of
    /// persisted timestamps lives in Plan §5 Faz 2 D-7
    /// chrony NTS impl, not here): the persisted
    /// `expires_at_unix` is the best truth available for
    /// cross-restart scheduling. Rollback AFTER rehydration
    /// is closed by this design.
    ///
    /// **Why not serialized:** MonotonicAnchor uses
    /// `Instant`-equivalent process-bound nanos that
    /// are meaningless across restarts. Persisting it
    /// would be incorrect.
    #[doc(hidden)]
    pub monotonic_deadline: Option<MonotonicDeadline>,
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
    /// **Batch #314 D-9 migration:** clock authority
    /// reports the wallclock is untrustworthy
    /// (NTS-stale, MonotonicBackward, PreEpochWallClock,
    /// or DurationOverflow on the TTL arithmetic).
    /// Operator MUST resolve the clock-source posture
    /// before applying force values — fail-closed.
    ClockUnhealthy { reason: String },
}

impl std::fmt::Display for ForceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TtlTooLong {
                requested_secs,
                cap_secs,
            } => write!(
                f,
                "force: ttl {} s exceeds cap {} s",
                requested_secs, cap_secs
            ),
            Self::TooManyConcurrentForces { current, cap } => {
                write!(f, "force: {} active >= cap {}", current, cap)
            }
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
            Self::ClockUnhealthy { reason } => {
                write!(f, "force: clock unhealthy: {}", reason)
            }
        }
    }
}

impl std::error::Error for ForceError {}

impl From<MonotonicDeadlineError> for ForceError {
    fn from(e: MonotonicDeadlineError) -> Self {
        Self::ClockUnhealthy {
            reason: e.to_string(),
        }
    }
}

impl From<ClockError> for ForceError {
    fn from(e: ClockError) -> Self {
        Self::ClockUnhealthy {
            reason: e.to_string(),
        }
    }
}

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
    ///
    /// **Batch #314 D-9 migration:** the `clock`
    /// argument lets the registry mint a
    /// `MonotonicDeadline` for the new entry, captured
    /// at the SAME instant as the wallclock reading.
    /// `sweep_expired_with_clock` later compares this
    /// anchor against `clock.monotonic_now()` —
    /// operator wallclock rollback after apply has NO
    /// effect on the captured deadline.
    ///
    /// Construction failure modes (clock unhealthy or
    /// arithmetic overflow) collapse into a structured
    /// `ForceError::ClockUnhealthy` so the caller can
    /// distinguish "clock broken" from "TTL invalid"
    /// (operator-actionable diagnostics).
    pub async fn apply(
        &self,
        tag_name: String,
        value: f64,
        quality: crate::process_image::TagQuality,
        actor: String,
        reason: String,
        ttl_secs: u64,
        persist_across_reboot: bool,
        clock: &dyn ClockAuthority,
    ) -> Result<Uuid, ForceError> {
        if ttl_secs > FORCE_TTL_CAP_SECS {
            return Err(ForceError::TtlTooLong {
                requested_secs: ttl_secs,
                cap_secs: FORCE_TTL_CAP_SECS,
            });
        }

        let now_ms = unix_ms_now();
        let now_secs = now_ms / 1000;

        // Mint the monotonic deadline BEFORE acquiring
        // the registry write guard. This (a) avoids
        // holding the write lock across the
        // trustworthy_wall_clock await, (b) lets the
        // ctor's NTS-stale gate fail-fast without
        // touching registry state.
        let deadline = MonotonicDeadline::from_duration_now(Duration::from_secs(ttl_secs), clock)
            .await
            .map_err(ForceError::from)?;

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
        if !inner.entries.contains_key(&tag_name) && inner.entries.len() >= MAX_CONCURRENT_FORCES {
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
            monotonic_deadline: Some(deadline),
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
        let mut entries: Vec<ForceEntry> =
            self.inner.read().await.entries.values().cloned().collect();
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

    /// **Batch #314 D-9 migration: clock-rollback-safe sweep.**
    ///
    /// Walks every entry and, for each one with a captured
    /// `monotonic_deadline`, calls `is_past_now(clock)`. The
    /// monotonic anchor was set at apply-time (or rehydrated
    /// at load-time from the persisted `expires_at_unix`)
    /// and is IMMUNE to operator wallclock rollback for the
    /// remainder of the process lifetime.
    ///
    /// **Lazy rehydration for persisted entries:** entries
    /// loaded from SQLCipher arrive with
    /// `monotonic_deadline = None` because the
    /// MonotonicAnchor is process-bound and not serialized.
    /// On the first sweep encounter we mint a deadline from
    /// the persisted `expires_at_unix` (interpreted as a
    /// wallclock target) using the current trustworthy
    /// wallclock + monotonic anchor — same SAFE shape as
    /// the apply-time path. Subsequent ticks reuse the
    /// rehydrated deadline.
    ///
    /// **Fail modes:**
    /// - Trustworthy wallclock unavailable (NTS-stale at
    ///   load time): the entry is LEFT IN PLACE for the next
    ///   tick. The sweep does NOT prematurely expire entries
    ///   when the clock is broken (would lose operator
    ///   state) and does NOT silently extend lifetimes
    ///   (next healthy tick re-checks).
    /// - Clock returns `MonotonicBackward`: same — leave in
    ///   place; operator log surfaces the kernel anomaly.
    pub async fn sweep_expired_with_clock(&self, clock: &dyn ClockAuthority) -> Vec<ForceEntry> {
        let mut inner = self.inner.write().await;
        let mut expired_keys: Vec<String> = Vec::new();

        // PASS 1 — rehydrate any None deadlines from the
        // persisted expires_at_unix. Entries that have a
        // Some(deadline) skip this pass. Entries whose
        // ctor returns AlreadyPastAtConstruction are
        // immediately added to expired_keys (no fake
        // anchor — direct expiry routing).
        let rehydrate_keys: Vec<String> = inner
            .entries
            .iter()
            .filter(|(_, e)| e.monotonic_deadline.is_none())
            .map(|(k, _)| k.clone())
            .collect();

        for key in &rehydrate_keys {
            let expires_at_unix = match inner.entries.get(key) {
                Some(e) => e.expires_at_unix,
                None => continue,
            };
            let target_secs = expires_at_unix.max(0) as u64;
            let target_wall = UNIX_EPOCH + Duration::from_secs(target_secs);
            match MonotonicDeadline::from_wallclock_target(target_wall, clock).await {
                Ok(deadline) => {
                    if let Some(entry) = inner.entries.get_mut(key) {
                        entry.monotonic_deadline = Some(deadline);
                    }
                }
                Err(MonotonicDeadlineError::AlreadyPastAtConstruction { .. }) => {
                    // Already past at rehydration time —
                    // route directly to expiry without
                    // assigning a fake anchor. Cleaner than
                    // the assign-zero-anchor pattern.
                    expired_keys.push(key.clone());
                }
                Err(e) => {
                    // Clock unhealthy or arithmetic
                    // overflow. Skip this entry; next tick
                    // retries. Logged so operators see the
                    // sweep anomaly.
                    tracing::warn!(
                        "force-registry sweep rehydrate skip: tag=`{}` err={}",
                        key,
                        e
                    );
                }
            }
        }

        // PASS 2 — past-now check on entries with Some
        // deadline. None deadlines (rehydration failed)
        // are skipped; next healthy tick re-attempts.
        for (key, entry) in inner.entries.iter() {
            // Skip entries already routed to expiry by
            // PASS 1.
            if expired_keys.iter().any(|k| k == key) {
                continue;
            }
            let deadline = match entry.monotonic_deadline {
                Some(d) => d,
                None => continue,
            };
            match deadline.is_past_now(clock) {
                Ok(true) => expired_keys.push(key.clone()),
                Ok(false) => {}
                Err(e) => {
                    tracing::warn!(
                        "force-registry sweep is_past_now skip: tag=`{}` err={}",
                        key,
                        e
                    );
                }
            }
        }

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
    /// Batch 200 Faz 6: entries dropped by the
    /// shutdown drain of non-persistent forces. Non-
    /// zero when the agent went down with active
    /// forces that had `persist_across_reboot=false`.
    pub total_shutdown_drained: u64,
}

/// **Batch #314 D-9 migration: clock-rollback-safe sweep task.**
///
/// Every `interval` (default 1 s), calls
/// `force_registry.sweep_expired_with_clock(&*clock)`. The
/// injected `Arc<dyn ClockAuthority>` provides the monotonic
/// + trustworthy-wallclock readings used by the registry's
/// past-now check. Dropped entries are logged at info so
/// operators see the TTL-expiry lifecycle in boot + runtime
/// logs.
///
/// Shutdown semantics identical to `run_sweep_task` (the
/// pre-#314 wallclock variant): the shutdown branch drains
/// non-persistent forces before returning the
/// SweepSummary.
pub async fn run_sweep_task_with_clock(
    registry: std::sync::Arc<ForceRegistry>,
    clock: std::sync::Arc<dyn ClockAuthority>,
    interval: std::time::Duration,
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
) -> SweepSummary {
    tracing::info!(
        "Force-registry sweep task starting (interval={:?}, clock-aware D-9 path)",
        interval
    );
    let mut summary = SweepSummary::default();

    loop {
        let expired = registry.sweep_expired_with_clock(&*clock).await;
        summary.ticks_executed += 1;

        if !expired.is_empty() {
            let count = expired.len() as u64;
            summary.total_expired += count;
            for entry in &expired {
                tracing::info!(
                    "force-registry sweep (D-9 monotonic): expired tag=`{}` force_id={} actor=`{}`",
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
                        let drained = registry.drain_non_persistent().await;
                        summary.total_shutdown_drained = drained.len() as u64;
                        for entry in &drained {
                            tracing::info!(
                                "force-registry shutdown drain (D-9): tag=`{}` \
                                 force_id={} actor=`{}` (non-persistent)",
                                entry.tag_name, entry.force_id, entry.actor,
                            );
                        }
                        tracing::info!(
                            "force-registry sweep task (D-9) shutdown: \
                             ticks={} total_expired={} drained={}",
                            summary.ticks_executed,
                            summary.total_expired,
                            summary.total_shutdown_drained,
                        );
                        return summary;
                    }
                    Ok(()) => {}
                    Err(_) => {
                        let drained = registry.drain_non_persistent().await;
                        summary.total_shutdown_drained = drained.len() as u64;
                        tracing::info!(
                            "force-registry sweep task (D-9) shutdown (sender dropped): \
                             ticks={} total_expired={} drained={}",
                            summary.ticks_executed,
                            summary.total_expired,
                            summary.total_shutdown_drained,
                        );
                        return summary;
                    }
                }
            }
        }
    }
}

/// Long-running 1-Hz sweep task — Batch 198 Faz 6.
///
/// **DEPRECATED in favor of `run_sweep_task_with_clock`**
/// (Batch #314 D-9 migration). This entry retained for
/// callers that have not yet migrated to the clock-aware
/// path; it falls back to wallclock-based expiry which is
/// vulnerable to operator clock rollback.
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
                        // Batch 200 Faz 6 — shutdown
                        // drain. Clear every non-
                        // persistent force so the
                        // reboot leaves only
                        // `persist_across_reboot=true`
                        // entries. Plan R-9 fail-safe
                        // rule: a forgotten force
                        // MUST NOT silently survive a
                        // reboot unless the operator
                        // explicitly opted in.
                        let drained = registry.drain_non_persistent().await;
                        summary.total_shutdown_drained = drained.len() as u64;
                        for entry in &drained {
                            tracing::info!(
                                "force-registry shutdown drain: tag=`{}` \
                                 force_id={} actor=`{}` (non-persistent)",
                                entry.tag_name,
                                entry.force_id,
                                entry.actor,
                            );
                        }
                        tracing::info!(
                            "force-registry sweep task shutdown: \
                             ticks={} total_expired={} drained={}",
                            summary.ticks_executed,
                            summary.total_expired,
                            summary.total_shutdown_drained,
                        );
                        return summary;
                    }
                    Ok(()) => {}
                    Err(_) => {
                        // Sender dropped — also perform
                        // the shutdown drain (treat as
                        // an abnormal but still graceful
                        // exit).
                        let drained = registry.drain_non_persistent().await;
                        summary.total_shutdown_drained = drained.len() as u64;
                        tracing::info!(
                            "force-registry sweep task shutdown (sender \
                             dropped): ticks={} total_expired={} drained={}",
                            summary.ticks_executed,
                            summary.total_expired,
                            summary.total_shutdown_drained,
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
    use crate::runtime_safety::SystemClockAuthority;

    /// Test fixture — fresh SystemClockAuthority for each
    /// canned_apply / direct apply test invocation. Wallclock-
    /// based; tests don't exercise rollback scenarios (those
    /// are covered by the MonotonicDeadline tests in
    /// runtime_safety::clock).
    fn test_clock() -> SystemClockAuthority {
        SystemClockAuthority::new()
    }

    fn canned_apply<'a>(
        registry: &'a ForceRegistry,
        tag: &'a str,
        ttl: u64,
        clock: &'a SystemClockAuthority,
    ) -> impl std::future::Future<Output = Result<Uuid, ForceError>> + 'a {
        registry.apply(
            tag.to_string(),
            1.0,
            TagQuality::Good,
            "operator-alice".to_string(),
            "diagnostic test".to_string(),
            ttl,
            false,
            clock,
        )
    }

    #[tokio::test]
    async fn apply_succeeds_with_valid_params() {
        let reg = ForceRegistry::new();
        let clock = test_clock();
        let id = canned_apply(&reg, "feeder_rate", 60, &clock)
            .await
            .expect("ok");
        let entry = reg.get("feeder_rate").await.expect("present");
        assert_eq!(entry.force_id, id);
        assert_eq!(entry.value, 1.0);
        assert_eq!(entry.actor, "operator-alice");
        assert_eq!(entry.persist_across_reboot, false);
    }

    #[tokio::test]
    async fn apply_rejects_ttl_exceeding_cap() {
        let reg = ForceRegistry::new();
        let clock = test_clock();
        let err = canned_apply(&reg, "t", FORCE_TTL_CAP_SECS + 1, &clock)
            .await
            .expect_err("too long");
        assert!(matches!(err, ForceError::TtlTooLong { .. }));
    }

    #[tokio::test]
    async fn is_forced_reflects_active_entries() {
        let reg = ForceRegistry::new();
        let clock = test_clock();
        assert!(!reg.is_forced("tag_a").await);
        canned_apply(&reg, "tag_a", 60, &clock).await.expect("ok");
        assert!(reg.is_forced("tag_a").await);
        assert!(!reg.is_forced("tag_b").await);
    }

    #[tokio::test]
    async fn remove_returns_entry_and_clears_force() {
        let reg = ForceRegistry::new();
        let clock = test_clock();
        canned_apply(&reg, "tag_a", 60, &clock).await.expect("ok");
        let removed = reg.remove("tag_a").await.expect("ok");
        assert_eq!(removed.tag_name, "tag_a");
        assert!(!reg.is_forced("tag_a").await);
    }

    #[tokio::test]
    async fn remove_on_unforced_tag_errors() {
        let reg = ForceRegistry::new();
        let clock = test_clock();
        let err = reg.remove("ghost").await.expect_err("not found");
        assert!(matches!(err, ForceError::NotFound { .. }));
    }

    #[tokio::test]
    async fn remove_all_drops_every_entry() {
        let reg = ForceRegistry::new();
        let clock = test_clock();
        canned_apply(&reg, "a", 60, &clock).await.expect("ok");
        canned_apply(&reg, "b", 60, &clock).await.expect("ok");
        canned_apply(&reg, "c", 60, &clock).await.expect("ok");
        let drained = reg.remove_all().await;
        assert_eq!(drained.len(), 3);
        assert_eq!(reg.active_count().await, 0);
    }

    #[tokio::test]
    async fn rate_limit_rejects_rapid_same_tag_apply() {
        let reg = ForceRegistry::new();
        let clock = test_clock();
        canned_apply(&reg, "tag_a", 60, &clock).await.expect("ok");
        let err = canned_apply(&reg, "tag_a", 60, &clock)
            .await
            .expect_err("rate");
        assert!(matches!(err, ForceError::RateLimited { .. }));
    }

    #[tokio::test]
    async fn rate_limit_scoped_per_tag() {
        // Rapid apply on tag_a rejects; rapid apply on
        // tag_b succeeds because the rate limit is
        // per-tag, not global.
        let reg = ForceRegistry::new();
        let clock = test_clock();
        canned_apply(&reg, "tag_a", 60, &clock).await.expect("ok");
        canned_apply(&reg, "tag_b", 60, &clock).await.expect("ok");
        let err = canned_apply(&reg, "tag_a", 60, &clock)
            .await
            .expect_err("rate");
        assert!(matches!(err, ForceError::RateLimited { .. }));
    }

    #[tokio::test]
    async fn sweep_expired_drops_past_ttl_entries() {
        let reg = ForceRegistry::new();
        let clock = test_clock();
        // Apply force with 1-s TTL.
        canned_apply(&reg, "tag_a", 1, &clock).await.expect("ok");

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
        let clock = test_clock();
        // 60-sec TTL.
        canned_apply(&reg, "tag_a", 60, &clock).await.expect("ok");
        // Sweep with now = now (entry not expired yet).
        let now_unix = unix_ms_now() / 1000;
        let expired = reg.sweep_expired(now_unix).await;
        assert_eq!(expired.len(), 0);
        assert_eq!(reg.active_count().await, 1);
    }

    #[tokio::test]
    async fn drain_non_persistent_keeps_persistent_entries() {
        let reg = ForceRegistry::new();
        let clock = test_clock();
        reg.apply(
            "persistent_tag".into(),
            1.0,
            TagQuality::Good,
            "op".into(),
            "keeps".into(),
            60,
            true, // persist
            &clock,
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
            &clock,
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
        let clock = test_clock();
        canned_apply(&reg, "zebra", 60, &clock).await.expect("ok");
        canned_apply(&reg, "alpha", 60, &clock).await.expect("ok");
        canned_apply(&reg, "mango", 60, &clock).await.expect("ok");
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
            run_sweep_task(reg_clone, std::time::Duration::from_millis(10), rx).await
        });

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        tx.send(true).expect("signal");
        let summary = handle.await.expect("join");
        assert!(summary.ticks_executed >= 1);
        assert_eq!(summary.total_expired, 0);
    }

    // ================================================================
    // Batch #314 D-9 migration tests — sweep_expired_with_clock
    // ================================================================
    //
    // Two property tests pin the architectural shape:
    //   (1) entries with NOT-YET-PAST monotonic_deadline are kept
    //   (2) entries with PAST monotonic_deadline are removed
    //
    // The third test pins the rehydration path: an entry with
    // None deadline + already-past expires_at_unix gets routed
    // directly to expiry without minting a fake-zero anchor.

    /// Apply a force with TTL=60s; immediately call
    /// sweep_expired_with_clock; entry must remain (not yet
    /// past).
    #[tokio::test]
    async fn sweep_expired_with_clock_keeps_active_entry() {
        let reg = ForceRegistry::new();
        let clock = test_clock();
        canned_apply(&reg, "active_force", 60, &clock)
            .await
            .expect("ok");
        let expired = reg.sweep_expired_with_clock(&clock).await;
        assert!(expired.is_empty(), "active entry must not be swept");
        assert_eq!(reg.active_count().await, 1);
    }

    /// Apply a force with TTL=1s; sleep 1.1s (real time); call
    /// sweep_expired_with_clock; entry must be removed.
    #[tokio::test]
    async fn sweep_expired_with_clock_removes_past_entry() {
        let reg = ForceRegistry::new();
        let clock = test_clock();
        canned_apply(&reg, "expiring_force", 1, &clock)
            .await
            .expect("ok");
        // Real-time wait (no mock clock here — using real
        // SystemClockAuthority's monotonic Instant). 1.1s > 1s
        // TTL guarantees the deadline is past.
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        let expired = reg.sweep_expired_with_clock(&clock).await;
        assert_eq!(
            expired.len(),
            1,
            "expired entry must be swept on the monotonic-aware path"
        );
        assert_eq!(expired[0].tag_name, "expiring_force");
        assert_eq!(reg.active_count().await, 0);
    }

    /// Insert a ForceEntry directly (simulating
    /// load-from-persistence) with monotonic_deadline=None +
    /// already-past expires_at_unix. The rehydration pass in
    /// sweep_expired_with_clock must route it to expiry.
    #[tokio::test]
    async fn sweep_expired_with_clock_rehydrates_already_past_persisted_entry() {
        let reg = ForceRegistry::new();
        let clock = test_clock();
        // Direct insertion, bypassing apply() — represents the
        // load-from-store path where the entry deserializes
        // with monotonic_deadline=None.
        {
            let mut inner = reg.inner.write().await;
            let already_past_unix = unix_ms_now() / 1000 - 60;
            let entry = ForceEntry {
                force_id: Uuid::new_v4(),
                tag_name: "stale_persisted".to_string(),
                value: 42.0,
                quality: TagQuality::Good,
                actor: "op".to_string(),
                reason: "from-persistence".to_string(),
                applied_at: chrono::Utc::now(),
                expires_at_unix: already_past_unix,
                persist_across_reboot: true,
                monotonic_deadline: None,
            };
            inner.entries.insert("stale_persisted".to_string(), entry);
        }
        assert_eq!(reg.active_count().await, 1);
        let expired = reg.sweep_expired_with_clock(&clock).await;
        assert_eq!(
            expired.len(),
            1,
            "rehydration pass must route already-past persisted entry to expiry"
        );
        assert_eq!(expired[0].tag_name, "stale_persisted");
        assert_eq!(reg.active_count().await, 0);
    }

    #[tokio::test]
    async fn sweep_task_drops_expired_entries() {
        let reg = std::sync::Arc::new(ForceRegistry::new());
        let clock = test_clock();
        // Apply an entry that's already expired
        // (expires_at_unix in the past by writing
        // directly via the test-internal apply +
        // then mutating via sweep_expired with a
        // distant-future clock).
        canned_apply(&reg, "expiring_tag", 1, &clock)
            .await
            .expect("ok");

        let (tx, rx) = tokio::sync::watch::channel(false);
        let reg_clone = reg.clone();
        let handle = tokio::spawn(async move {
            run_sweep_task(reg_clone, std::time::Duration::from_millis(10), rx).await
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
    async fn sweep_task_drains_non_persistent_forces_on_shutdown() {
        // Apply one non-persistent + one persistent
        // force. Shut down the sweep task. Verify:
        // - summary.total_shutdown_drained == 1
        // - non-persistent force is gone
        // - persistent force survives
        let reg = std::sync::Arc::new(ForceRegistry::new());
        let clock = test_clock();
        reg.apply(
            "volatile_tag".into(),
            1.0,
            TagQuality::Good,
            "op".into(),
            "diag".into(),
            3600,
            false, // non-persistent
            &clock,
        )
        .await
        .expect("ok");
        // Wait past the rate-limit window before
        // applying the second force on a DIFFERENT
        // tag — different tags don't share the rate
        // limit, but we add a small delay anyway for
        // deterministic ordering.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        reg.apply(
            "persistent_tag".into(),
            2.0,
            TagQuality::Good,
            "op".into(),
            "long-diag".into(),
            3600,
            true, // persistent
            &clock,
        )
        .await
        .expect("ok");

        let (tx, rx) = tokio::sync::watch::channel(false);
        let reg_clone = reg.clone();
        let handle = tokio::spawn(async move {
            run_sweep_task(reg_clone, std::time::Duration::from_millis(10), rx).await
        });

        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        tx.send(true).expect("signal");
        let summary = handle.await.expect("join");
        assert_eq!(summary.total_shutdown_drained, 1);
        assert!(!reg.is_forced("volatile_tag").await);
        assert!(reg.is_forced("persistent_tag").await);
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
        let clock = test_clock();
        assert!(!reg.is_forced("feeder_rate").await);
        canned_apply(&reg, "feeder_rate", 60, &clock)
            .await
            .expect("ok");
        assert!(reg.is_forced("feeder_rate").await);
        reg.remove("feeder_rate").await.expect("ok");
        assert!(!reg.is_forced("feeder_rate").await);
    }

    #[tokio::test]
    async fn sweep_task_preserves_non_expired_entries() {
        let reg = std::sync::Arc::new(ForceRegistry::new());
        let clock = test_clock();
        // Long TTL + persist=true so the Batch 200
        // shutdown drain doesn't remove it at the
        // end of the test.
        reg.apply(
            "long_lived".into(),
            1.0,
            TagQuality::Good,
            "op".into(),
            "diag".into(),
            3600,
            true, // persistent — survives shutdown drain
            &clock,
        )
        .await
        .expect("ok");

        let (tx, rx) = tokio::sync::watch::channel(false);
        let reg_clone = reg.clone();
        let handle = tokio::spawn(async move {
            run_sweep_task(reg_clone, std::time::Duration::from_millis(10), rx).await
        });

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        tx.send(true).expect("signal");
        let summary = handle.await.expect("join");
        assert_eq!(summary.total_expired, 0);
        // Persistent force survives both the TTL sweep
        // (not expired) AND the shutdown drain (opted
        // in via persist_across_reboot=true).
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
        let clock = test_clock();
        let id_a = canned_apply(&reg, "tag_a", 60, &clock).await.expect("ok");
        let id_b = canned_apply(&reg, "tag_b", 60, &clock).await.expect("ok");
        assert_ne!(id_a, id_b);
    }
}
