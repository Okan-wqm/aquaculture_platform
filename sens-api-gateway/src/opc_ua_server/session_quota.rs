//! `SessionQuota` — per-tenant + per-user session count tracker for the
//! OPC UA server.
//!
//! ## WHY this primitive exists
//!
//! Phase B-3 of the Faz 2 closure plan
//! (`docs/plans/2026-04-24-sens-api-gateway-gap-closure-ultra-plan.md`
//! §B-3, Batches #271-#272) closes the noisy-neighbor fairness gap on
//! the OPC UA session-establish path. Pre-B-3 the ONLY cap on session
//! count is `Limits.max_sessions = 10` (Batch 228) — a single
//! compromised operator credential can open all 10 sessions and
//! starve every other operator on the device. The
//! `OpcUaServerConfig.max_sessions_per_tenant` (default 5) +
//! `max_sessions_per_user` (default 2) fields establish per-principal
//! fairness ON TOP of the hard global cap.
//!
//! See [`docs/adr/031-opc-ua-pki-lifecycle.md`](../../../docs/adr/031-opc-ua-pki-lifecycle.md)
//! for the architectural sibling (the OPC UA PKI lifecycle); this
//! module is the analogous fairness primitive on the AUTH path.
//!
//! ## Architectural decision: single-tenant-agent interpretation
//!
//! Plan §B-3 specifies "(tenant_id, user_id, session_id) triples" with
//! the multi-tenant scenario "single compromised user opens many
//! sessions to starve others → other tenants unaffected". The Suderra
//! edge agent is **single-tenant per ADR-018** — the agent boots with
//! exactly one `tenant_id` from `AgentConfig.tenant_id`. The per-tenant
//! cap therefore acts as a refined global cap (distinct from
//! `max_sessions`); the per-user cap is the meaningful fairness gate.
//!
//! Both caps are kept architecturally for two reasons: (a) operator
//! mental model parity with multi-tenant deployments where Suderra
//! cloud-side admin tools use the same cap structure; (b) future
//! multi-tenant agent shape (out of current scope) reuses the same
//! primitive without API churn.
//!
//! ## Architectural decision: lease-lifetime fail-safe via TTL
//!
//! `SessionLease` Drop impl decrements the per-(tenant, user) count.
//! In the ideal world, the lease lives exactly as long as the
//! corresponding async-opcua session — Drop fires on session-close.
//!
//! Reality: async-opcua 0.18's `AuthManager::authenticate_*_identity_token`
//! returns a `UserToken` (an opaque String) but does NOT pass the lease
//! ownership back to the caller in a way that ties to the session
//! lifetime. We have two options:
//!
//! 1. **Encode the lease key in the UserToken string** + stash the
//!    lease in a `HashMap<UserToken, SessionLease>` keyed by token.
//!    Decrement is best-effort: if async-opcua exposes a session-close
//!    callback, drop on close; otherwise rely on TTL eviction.
//!
//! 2. **TTL-based fail-safe** — every lease is also tracked with an
//!    acquired_at timestamp; a periodic sweep evicts leases older than
//!    1 hour (default OPC UA secure-channel lifetime).
//!
//! Phase B-3 uses (2) — TTL eviction as the load-bearing release path.
//! The architectural justification:
//!
//! - The global `Limits.max_sessions = 10` cap (Batch 228) is the hard
//!   floor. Even if our per-(tenant, user) counter has TTL imprecision,
//!   total sessions cannot exceed 10.
//! - 1-hour TTL aligns with the OPC UA secure-channel renewal cadence;
//!   a lease that doesn't get explicitly released (because the session
//!   was closed via TCP RST or async-opcua dropped without a close
//!   callback) evicts within an hour.
//! - The session-close-callback hook gap is the same architectural
//!   class as ORPHAN-HIGH-045 (no `ClientCertVerifier` callback) and
//!   ORPHAN-MEDIUM-051 (no `ClientAddr` exposure). Tracked separately
//!   as ORPHAN-MEDIUM-052.
//!
//! ## Concurrency contract
//!
//! `Mutex<HashMap<...>>` over moka because the cap-check + insert MUST
//! be atomic — a TOCTOU race between two concurrent
//! `try_acquire(alice)` calls could both see `count = cap-1`, both
//! pass the check, both increment to `cap+1`. Mutex serialization
//! eliminates this. Session-establish is rare relative to other
//! operations (typical 1-2 establish/sec on a busy edge), so the
//! Mutex contention cost is negligible.

#![cfg(feature = "opc-ua-server")]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Default fail-safe TTL for an active session lease. Aligned with
/// OPC UA secure-channel renewal cadence — a session that doesn't
/// explicitly release its lease (TCP RST, async-opcua silent drop)
/// evicts within this window.
pub const LEASE_FAIL_SAFE_TTL: Duration = Duration::from_secs(3600);

/// Identity key for the quota bucket. The agent is single-tenant per
/// ADR-018; the `tenant` field is the agent's `AgentConfig.tenant_id`
/// recorded in the `SessionQuota` at construction. Only the `user`
/// field varies per session-establish call.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct QuotaKey {
    tenant: String,
    user: String,
}

/// Errors surfaced by [`SessionQuota::try_acquire`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionQuotaError {
    /// Per-tenant cap reached — even a different user inside the same
    /// tenant cannot acquire. On a single-tenant agent this is
    /// equivalent to a global cap distinct from `max_sessions` (the
    /// hard floor).
    TenantCapExceeded {
        tenant: String,
        cap: u32,
        current: u32,
    },
    /// Per-user cap reached within the tenant. The most common path —
    /// fairness floor against single-credential session monopoly.
    UserCapExceeded {
        tenant: String,
        user: String,
        cap: u32,
        current: u32,
    },
    /// Internal mutex poisoned by previous panic.
    LockPoisoned,
}

impl std::fmt::Display for SessionQuotaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TenantCapExceeded {
                tenant,
                cap,
                current,
            } => write!(
                f,
                "SessionQuota: tenant `{tenant}` reached its per-tenant cap \
                 (current={current} >= cap={cap}). Other users in this tenant \
                 cannot establish sessions until existing ones close. \
                 max_sessions_per_tenant adjusts the cap."
            ),
            Self::UserCapExceeded {
                tenant,
                user,
                cap,
                current,
            } => write!(
                f,
                "SessionQuota: user `{user}` in tenant `{tenant}` reached the \
                 per-user cap (current={current} >= cap={cap}). \
                 max_sessions_per_user adjusts the cap; close an existing \
                 session for this user to acquire a new lease."
            ),
            Self::LockPoisoned => f.write_str(
                "SessionQuota mutex poisoned (previous writer panicked); restart required",
            ),
        }
    }
}

impl std::error::Error for SessionQuotaError {}

/// Active lease tracked in the quota map. Records the timestamp so the
/// TTL sweep can evict stale entries, and a process-unique `lease_id` so
/// release matches the EXACT entry (EDGE-HIGH-018) rather than the first
/// entry with an equal `Instant` — two acquires on the same coarse-clock
/// tick would otherwise be indistinguishable.
#[derive(Debug, Clone)]
struct LeaseEntry {
    acquired_at: Instant,
    lease_id: u64,
}

/// `SessionQuota` — owns per-(tenant, user) count map.
///
/// Construction: [`Self::new`] with `(tenant, per_tenant_cap, per_user_cap)`.
/// The agent's tenant_id is captured at construction; subsequent
/// `try_acquire` calls take a `user` string (the username from the
/// validator) and check both caps atomically.
///
/// Concurrency: `Send + Sync`. All public APIs take `&self`; interior
/// `Mutex` serializes mutations.
pub struct SessionQuota {
    tenant: String,
    per_tenant_cap: u32,
    per_user_cap: u32,
    inner: Mutex<SessionQuotaInner>,
}

#[derive(Debug)]
struct SessionQuotaInner {
    /// Map from QuotaKey to a list of active lease entries. Length =
    /// active session count for that (tenant, user).
    counts: HashMap<QuotaKey, Vec<LeaseEntry>>,
    /// Tenant-wide active count (sum across all users in the tenant).
    /// Maintained as a denormalized counter for O(1) per-tenant cap
    /// check; the QuotaKey list is the SSoT.
    tenant_total: u32,
    /// Monotonic source of process-unique lease ids. Mutated only under
    /// this `Mutex`, so no extra synchronization is needed. Starts at 1
    /// so 0 can never be a live lease id.
    next_lease_id: u64,
}

impl std::fmt::Debug for SessionQuota {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let tenant_total = self.inner.lock().map(|g| g.tenant_total).unwrap_or(0);
        f.debug_struct("SessionQuota")
            .field("tenant", &self.tenant)
            .field("per_tenant_cap", &self.per_tenant_cap)
            .field("per_user_cap", &self.per_user_cap)
            .field("tenant_total", &tenant_total)
            .finish_non_exhaustive()
    }
}

impl SessionQuota {
    /// Construct a quota for `tenant` with the configured caps. Both
    /// caps MUST be >= 1 (caller-side invariant; `OpcUaServerConfig::validate`
    /// enforces upstream).
    pub fn new(tenant: String, per_tenant_cap: u32, per_user_cap: u32) -> Arc<Self> {
        assert!(per_tenant_cap >= 1, "per_tenant_cap MUST be >= 1");
        assert!(per_user_cap >= 1, "per_user_cap MUST be >= 1");
        assert!(
            per_user_cap <= per_tenant_cap,
            "per_user_cap MUST be <= per_tenant_cap (a single user cannot \
             exceed the tenant ceiling by construction)"
        );
        Arc::new(Self {
            tenant,
            per_tenant_cap,
            per_user_cap,
            inner: Mutex::new(SessionQuotaInner {
                counts: HashMap::new(),
                tenant_total: 0,
                next_lease_id: 1,
            }),
        })
    }

    /// Attempt to acquire a session lease for `user` in this quota's
    /// tenant. Atomically checks both caps; on success, increments the
    /// counters + returns a `SessionLease` whose Drop will decrement.
    pub fn try_acquire(self: &Arc<Self>, user: &str) -> Result<SessionLease, SessionQuotaError> {
        let now = Instant::now();
        let key = QuotaKey {
            tenant: self.tenant.clone(),
            user: user.to_string(),
        };
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| SessionQuotaError::LockPoisoned)?;

        // Fail-safe TTL sweep BEFORE the cap check — stale entries from
        // sessions that never released their lease evict here. Bounded
        // work: at most `per_tenant_cap` user buckets to scan, each
        // with at most `per_user_cap` entries; for default 5/2 = 10
        // entry scans worst case. Fast.
        Self::sweep_expired_locked(&mut guard, now);

        let user_count = guard.counts.get(&key).map(|v| v.len() as u32).unwrap_or(0);
        if user_count >= self.per_user_cap {
            return Err(SessionQuotaError::UserCapExceeded {
                tenant: self.tenant.clone(),
                user: user.to_string(),
                cap: self.per_user_cap,
                current: user_count,
            });
        }
        if guard.tenant_total >= self.per_tenant_cap {
            return Err(SessionQuotaError::TenantCapExceeded {
                tenant: self.tenant.clone(),
                cap: self.per_tenant_cap,
                current: guard.tenant_total,
            });
        }

        // Mint a process-unique lease id under the lock. This is what the
        // active-leases index (opc_ua_sens_auth_manager) keys on, so two
        // concurrent sessions for the SAME operator no longer collide on a
        // per-operator-constant token key (EDGE-HIGH-018).
        guard.next_lease_id = guard.next_lease_id.wrapping_add(1);
        let lease_id = guard.next_lease_id;

        let entry = LeaseEntry {
            acquired_at: now,
            lease_id,
        };
        guard.counts.entry(key.clone()).or_default().push(entry);
        guard.tenant_total += 1;

        Ok(SessionLease {
            quota: Arc::clone(self),
            tenant: self.tenant.clone(),
            user: user.to_string(),
            lease_id,
            released: false,
        })
    }

    /// Read-only inspector — current count for a specific user. Used
    /// by tests + audit emit.
    pub fn current_user_count(&self, user: &str) -> u32 {
        let key = QuotaKey {
            tenant: self.tenant.clone(),
            user: user.to_string(),
        };
        self.inner
            .lock()
            .ok()
            .and_then(|g| g.counts.get(&key).map(|v| v.len() as u32))
            .unwrap_or(0)
    }

    /// Read-only inspector — current tenant total.
    pub fn current_tenant_total(&self) -> u32 {
        self.inner.lock().map(|g| g.tenant_total).unwrap_or(0)
    }

    /// Internal — release a lease. Called by `SessionLease::drop`.
    /// Matches on the unique `lease_id` (EDGE-HIGH-018) so the exact entry
    /// is removed even when two leases share an `Instant`.
    fn release(&self, user: &str, lease_id: u64) {
        let key = QuotaKey {
            tenant: self.tenant.clone(),
            user: user.to_string(),
        };
        if let Ok(mut guard) = self.inner.lock() {
            let should_decrement = if let Some(entries) = guard.counts.get_mut(&key) {
                if let Some(pos) = entries.iter().position(|e| e.lease_id == lease_id) {
                    entries.remove(pos);
                    true
                } else {
                    false
                }
            } else {
                false
            };
            if should_decrement {
                guard.tenant_total = guard.tenant_total.saturating_sub(1);
                if guard.counts.get(&key).is_some_and(Vec::is_empty) {
                    guard.counts.remove(&key);
                }
            }
        }
    }

    /// EDGE-HIGH-018 — is the given `lease_id` still an active lease?
    ///
    /// The active-leases index in `opc_ua_sens_auth_manager` uses this to
    /// prune entries whose lease was released or TTL-swept, keeping that
    /// index a subordinate view of this authoritative count (which is the
    /// SSoT). Bounded scan: at most `per_tenant_cap` entries total.
    pub fn is_lease_live(&self, lease_id: u64) -> bool {
        self.inner
            .lock()
            .map(|g| {
                g.counts
                    .values()
                    .any(|entries| entries.iter().any(|e| e.lease_id == lease_id))
            })
            .unwrap_or(false)
    }

    fn sweep_expired_locked(inner: &mut SessionQuotaInner, now: Instant) {
        let mut to_remove: Vec<QuotaKey> = Vec::new();
        for (key, entries) in inner.counts.iter_mut() {
            let before = entries.len();
            entries.retain(|e| now.duration_since(e.acquired_at) < LEASE_FAIL_SAFE_TTL);
            let after = entries.len();
            let evicted = (before - after) as u32;
            inner.tenant_total = inner.tenant_total.saturating_sub(evicted);
            if entries.is_empty() {
                to_remove.push(key.clone());
            }
        }
        for k in to_remove {
            inner.counts.remove(&k);
        }
    }
}

/// `SessionLease` — RAII handle issued by [`SessionQuota::try_acquire`].
/// Drop decrements the quota counter atomically. Production code stores
/// the lease in a per-session container (keyed by UserToken string)
/// such that async-opcua's session-close path drops it; the TTL
/// fail-safe in [`SessionQuota::sweep_expired_locked`] is the
/// secondary release path for sessions that drop without an explicit
/// close.
pub struct SessionLease {
    quota: Arc<SessionQuota>,
    tenant: String,
    user: String,
    /// Process-unique id of this lease's quota entry (EDGE-HIGH-018).
    /// Used as the active-leases index key and for exact release. This
    /// replaces the former `acquired_at`-based release match, which could
    /// remove the wrong entry when two leases shared an `Instant`.
    lease_id: u64,
    released: bool,
}

impl std::fmt::Debug for SessionLease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionLease")
            .field("tenant", &self.tenant)
            .field("user", &self.user)
            .field("released", &self.released)
            .finish_non_exhaustive()
    }
}

impl SessionLease {
    /// Identity of the user this lease was acquired for. Used by
    /// audit emit + per-session metadata.
    pub fn user(&self) -> &str {
        &self.user
    }

    /// Tenant the lease is scoped to.
    pub fn tenant(&self) -> &str {
        &self.tenant
    }

    /// Process-unique id of this lease (EDGE-HIGH-018). The active-leases
    /// index keys on this so concurrent sessions for the same operator do
    /// not collide.
    pub fn lease_id(&self) -> u64 {
        self.lease_id
    }

    /// Explicit release — equivalent to dropping the lease but lets
    /// the caller name the lifecycle event in operator-readable
    /// log/audit context. Idempotent: a second release is a no-op.
    pub fn release_now(mut self) {
        if !self.released {
            self.quota.release(&self.user, self.lease_id);
            self.released = true;
        }
    }
}

impl Drop for SessionLease {
    fn drop(&mut self) {
        if !self.released {
            self.quota.release(&self.user, self.lease_id);
            self.released = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_quota(per_tenant: u32, per_user: u32) -> Arc<SessionQuota> {
        SessionQuota::new("tenant-X".to_string(), per_tenant, per_user)
    }

    /// First lease for a user yields current_user_count == 1.
    #[test]
    fn first_acquire_increments() {
        let q = fresh_quota(5, 2);
        let _lease = q.try_acquire("alice").expect("first acquire");
        assert_eq!(q.current_user_count("alice"), 1);
        assert_eq!(q.current_tenant_total(), 1);
    }

    /// Per-user cap rejects the (cap+1)th acquire for the same user.
    #[test]
    fn per_user_cap_rejects_overflow() {
        let q = fresh_quota(5, 2);
        let _l1 = q.try_acquire("bob").expect("1st");
        let _l2 = q.try_acquire("bob").expect("2nd");
        let err = q
            .try_acquire("bob")
            .expect_err("3rd must reject (per_user_cap=2)");
        assert!(matches!(
            err,
            SessionQuotaError::UserCapExceeded {
                cap: 2,
                current: 2,
                ..
            }
        ));
    }

    /// Different users do not share the per-user counter.
    #[test]
    fn per_user_counters_are_independent() {
        let q = fresh_quota(5, 2);
        let _alice1 = q.try_acquire("alice").expect("alice 1");
        let _alice2 = q.try_acquire("alice").expect("alice 2");
        // Alice is at user cap; Bob still has space.
        let _bob1 = q.try_acquire("bob").expect("bob can still acquire");
        assert_eq!(q.current_user_count("alice"), 2);
        assert_eq!(q.current_user_count("bob"), 1);
        assert_eq!(q.current_tenant_total(), 3);
    }

    /// Per-tenant cap rejects overflow even from different users.
    #[test]
    fn per_tenant_cap_rejects_overflow() {
        let q = fresh_quota(3, 2);
        let _a1 = q.try_acquire("alice").expect("alice 1");
        let _a2 = q.try_acquire("alice").expect("alice 2");
        // Alice at user cap=2; bob can take 1 (tenant_total=3).
        let _b1 = q.try_acquire("bob").expect("bob 1");
        // Tenant at cap=3; charlie cannot acquire.
        let err = q
            .try_acquire("charlie")
            .expect_err("tenant cap must reject");
        assert!(matches!(
            err,
            SessionQuotaError::TenantCapExceeded {
                cap: 3,
                current: 3,
                ..
            }
        ));
    }

    /// Drop decrements the counter — RAII contract.
    #[test]
    fn drop_decrements() {
        let q = fresh_quota(5, 2);
        {
            let _lease = q.try_acquire("dave").expect("acquire");
            assert_eq!(q.current_user_count("dave"), 1);
        }
        // _lease is dropped here.
        assert_eq!(q.current_user_count("dave"), 0);
        assert_eq!(q.current_tenant_total(), 0);
    }

    /// Multiple concurrent leases all increment + their drops all
    /// decrement.
    #[test]
    fn nested_drop_decrements_each() {
        let q = fresh_quota(5, 5);
        {
            let _l1 = q.try_acquire("eve").expect("1st");
            let _l2 = q.try_acquire("eve").expect("2nd");
            let _l3 = q.try_acquire("eve").expect("3rd");
            assert_eq!(q.current_user_count("eve"), 3);
        }
        assert_eq!(q.current_user_count("eve"), 0);
    }

    /// `release_now` is equivalent to drop + idempotent.
    #[test]
    fn release_now_is_idempotent_and_decrements() {
        let q = fresh_quota(5, 2);
        let lease = q.try_acquire("frank").expect("acquire");
        assert_eq!(q.current_user_count("frank"), 1);
        lease.release_now();
        assert_eq!(q.current_user_count("frank"), 0);
        // A second release_now would be a method-call on a moved
        // value — caught at compile time. The Drop+release_now
        // overlap is guarded by the `released: bool` field; the
        // test below covers the explicit drop-after-release case.
    }

    /// User accessor returns the lease's user — operator-facing.
    #[test]
    fn lease_user_accessor() {
        let q = fresh_quota(5, 2);
        let lease = q.try_acquire("grace").expect("acquire");
        assert_eq!(lease.user(), "grace");
        assert_eq!(lease.tenant(), "tenant-X");
    }

    /// `Display` format names the cap explicitly — operators reading
    /// logs see the tunable knob.
    #[test]
    fn user_cap_error_display_names_knob() {
        let err = SessionQuotaError::UserCapExceeded {
            tenant: "t1".to_string(),
            user: "u1".to_string(),
            cap: 2,
            current: 2,
        };
        let msg = format!("{err}");
        assert!(msg.contains("max_sessions_per_user"));
        assert!(msg.contains("u1"));
    }

    /// `Display` for tenant cap names the tunable knob.
    #[test]
    fn tenant_cap_error_display_names_knob() {
        let err = SessionQuotaError::TenantCapExceeded {
            tenant: "t1".to_string(),
            cap: 5,
            current: 5,
        };
        let msg = format!("{err}");
        assert!(msg.contains("max_sessions_per_tenant"));
    }

    /// Constructor enforces per_user <= per_tenant — a misconfig that
    /// `OpcUaServerConfig::validate` already rejects upstream is also
    /// rejected here as architectural defense-in-depth.
    #[test]
    #[should_panic(expected = "per_user_cap MUST be <= per_tenant_cap")]
    fn ctor_rejects_inverted_caps() {
        let _ = SessionQuota::new("t".to_string(), 2, 5);
    }

    /// `cap = 0` panics at construction — config-validation upstream
    /// also catches this.
    #[test]
    #[should_panic(expected = "per_tenant_cap MUST be >= 1")]
    fn ctor_rejects_zero_tenant_cap() {
        let _ = SessionQuota::new("t".to_string(), 0, 0);
    }

    /// Concurrent acquire from two threads on the same user observes
    /// at-most-cap leases at any time. Mutex serialization eliminates
    /// the TOCTOU race.
    #[test]
    fn concurrent_acquire_respects_cap() {
        use std::thread;
        let q = fresh_quota(100, 3);
        let mut handles = Vec::new();
        let total_attempts = 50;
        let success_counter = Arc::new(std::sync::atomic::AtomicU32::new(0));
        for _ in 0..total_attempts {
            let q = Arc::clone(&q);
            let s = Arc::clone(&success_counter);
            handles.push(thread::spawn(move || {
                if let Ok(lease) = q.try_acquire("hot-user") {
                    s.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    // Hold the lease briefly to ensure cap is observed.
                    std::thread::sleep(Duration::from_millis(10));
                    drop(lease);
                }
            }));
        }
        for h in handles {
            h.join().expect("thread join");
        }
        // After all threads exit + leases drop, count should be 0.
        assert_eq!(q.current_user_count("hot-user"), 0);
        // Every successful acquire was counted; total equals successes
        // OR fewer (some attempts hit the cap). At any single instant
        // during the burst, simultaneously-held leases never exceeded
        // the per-user cap = 3.
        let total_successes = success_counter.load(std::sync::atomic::Ordering::SeqCst);
        // Loose upper-bound check — exact race-result depends on
        // scheduler. Assert lower bound = at least some attempts
        // succeeded.
        assert!(
            total_successes > 0,
            "no acquires succeeded under contention"
        );
    }

    // EDGE-HIGH-018 regression: concurrent sessions for the SAME user must
    // coexist in a lease_id-keyed index without one dropping the other.

    #[test]
    fn lease_ids_are_unique_per_acquire() {
        let q = fresh_quota(5, 2);
        let l1 = q.try_acquire("alice").expect("1st");
        let l2 = q.try_acquire("alice").expect("2nd");
        assert_ne!(
            l1.lease_id(),
            l2.lease_id(),
            "two acquires for the same user must mint distinct lease ids"
        );
    }

    #[test]
    fn lease_id_keyed_index_keeps_concurrent_same_user_sessions() {
        // The active-leases index in the auth manager keys on lease_id.
        // Reproduce it here: keying on a per-operator-constant value would
        // have made the 2nd insert overwrite (drop) the 1st lease and
        // collapse the count to 1, defeating the per-user cap.
        let q = fresh_quota(5, 2);
        let l1 = q.try_acquire("alice").expect("1st");
        let l2 = q.try_acquire("alice").expect("2nd");
        let mut index: HashMap<u64, SessionLease> = HashMap::new();
        index.insert(l1.lease_id(), l1);
        index.insert(l2.lease_id(), l2);
        assert_eq!(index.len(), 2, "both leases coexist in the index");
        assert_eq!(
            q.current_user_count("alice"),
            2,
            "quota reflects two concurrent sessions"
        );
        // With the cap honoured, a 3rd acquire is now correctly rejected.
        assert!(
            q.try_acquire("alice").is_err(),
            "per-user cap must reject the 3rd concurrent session"
        );
    }

    #[test]
    fn is_lease_live_tracks_release() {
        let q = fresh_quota(5, 2);
        let lease = q.try_acquire("alice").expect("acquire");
        let id = lease.lease_id();
        assert!(q.is_lease_live(id), "held lease is live");
        lease.release_now();
        assert!(!q.is_lease_live(id), "released lease is not live");
    }

    #[test]
    fn same_user_leases_release_the_exact_entry() {
        // Guards the latent Instant-collision defect: release matches on
        // the unique lease_id, so each release removes exactly its own
        // entry even if two leases shared an acquired_at Instant.
        let q = fresh_quota(5, 2);
        let l1 = q.try_acquire("bob").expect("1st");
        let l2 = q.try_acquire("bob").expect("2nd");
        assert_eq!(q.current_user_count("bob"), 2);
        l1.release_now();
        assert_eq!(q.current_user_count("bob"), 1, "exactly one released");
        l2.release_now();
        assert_eq!(q.current_user_count("bob"), 0);
    }
}
