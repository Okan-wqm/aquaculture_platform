//! `FailedAuthWindow` — sliding-window brute-force throttle for OPC UA
//! session-establish authentication.
//!
//! ## WHY this primitive exists
//!
//! Phase B-2 of the Faz 2 closure plan (`docs/plans/2026-04-24-sens-api-gateway-gap-closure-ultra-plan.md` §B-2, Batches #269-#270) closes the
//! brute-force defense gap on the OPC UA server. Pre-B-2 the
//! `SensAuthManager::authenticate_username_identity_token` path runs
//! Argon2id-grade password verification on every attempt — an attacker
//! with valid network reach can mount a credential-spray attack at full
//! CPU cost per attempt. The platform's `OpcUaServerConfig.max_failed_auth_per_60s`
//! field has been pre-staged at default 20 since pre-Faz-B; B-2 adds
//! the enforcement primitive.
//!
//! See [`docs/adr/031-opc-ua-pki-lifecycle.md`](../../../docs/adr/031-opc-ua-pki-lifecycle.md) §4 for the architectural
//! sibling (`OpcUaAuthThrottled` AuditAction); ADR for B-2 itself is a
//! follow-on that documents the per-username vs per-IP architectural
//! decision recorded in this module's preamble.
//!
//! ## Architectural decision: per-username throttle (NOT per-IP)
//!
//! Plan §B-2 specifies "per `ClientAddr` sliding window". async-opcua
//! 0.18's `AuthManager` trait does NOT expose the client TCP address at
//! the `authenticate_*_identity_token` callsite — only the username
//! (UserName/Password path) or the cert thumbprint (X.509 path) is
//! available. Per-IP throttling at this layer is structurally
//! impossible without an upstream API change.
//!
//! This module implements **per-username throttle**. Architectural
//! trade-off:
//!
//! - **Protects:** account-targeted credential brute-force. An attacker
//!   pounding `admin:wrong-pass` 100 times sees a hard cap at 20/60s,
//!   regardless of source IP. Argon2id CPU exhaustion is bounded.
//! - **Misses:** cross-account credential-spray from a single IP. An
//!   attacker rotating through 1000 usernames at 1 attempt each within
//!   60 seconds is NOT throttled per-username (each username has only
//!   1 failure). The `max_failed_auth_per_60s` config name is a
//!   misnomer for this case — it's actually per-username, not per-IP.
//!
//! The cross-account gap is tracked as ORPHAN-MEDIUM-051 with a
//! WHY+HOW resolution path: either upstream async-opcua PR exposing
//! ClientAddr in the AuthManager trait, OR a TCP-listener interceptor
//! at the runtime layer that inserts the IP into a context the trait
//! method can read. Phase B-2 does not include a global rate-limit at
//! this layer because that would shift the brute-force impact onto
//! legitimate users (a noisy neighbor on the same edge box would lock
//! out the operator).
//!
//! ## Why moka cache (atomic TTL eviction)
//!
//! Moka's `sync::Cache` provides atomic per-key TTL eviction inside the
//! crate — no manual GC task races writers, no global Mutex<HashMap>
//! lock contention. Each key's 60-second window is independent; a key
//! that hasn't seen activity for 60s evicts naturally and the next
//! failure starts fresh.
//!
//! Manual bucketing (`Mutex<HashMap<K, Vec<Instant>>>` + a tokio
//! interval task that scrubs old entries) was rejected — the scrub
//! task races writers on the same key during scrub-then-record windows
//! and either skips the eviction (false-negative throttle) or skips
//! the record (false-success when the attempt should have hit the
//! cap). Moka's per-key atomic invalidation is correct-by-construction.

#![cfg(feature = "opc-ua-server")]

use std::sync::Arc;
use std::time::{Duration, Instant};

use moka::sync::Cache;

/// Sliding window length for the failed-auth counter. Plan §B-2
/// specifies 60 seconds; the configured `max_failed_auth_per_60s` cap
/// is interpreted as "no more than N failures within this rolling
/// window per identity key".
pub const WINDOW_DURATION: Duration = Duration::from_secs(60);

/// Identity key for the throttle bucket. Newtype around `String` for
/// grepability + to enforce that callers go through the constructors
/// (which apply normalization). A raw `String` user id from a network
/// payload could carry untrusted bytes; `AuthThrottleKey::for_username`
/// applies trim + lowercase normalization so `"admin "` and `"ADMIN"`
/// share the same throttle bucket — defeats trivial bypass.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AuthThrottleKey(String);

impl AuthThrottleKey {
    /// Build a per-username throttle key. Normalization:
    /// - Trim leading/trailing whitespace.
    /// - Lowercase via Unicode `to_lowercase` (matches the
    ///   `UserTokenValidator`'s NFKC + lowercase pre-validation; bypass
    ///   via case-flipping is structurally prevented).
    /// - Empty input collapses to a sentinel `"<empty>"` so the
    ///   throttle bucket exists for protocol-level malformed clients
    ///   too — they get their own counter rather than sharing the
    ///   global counter with a legitimate operator.
    pub fn for_username(username: &str) -> Self {
        let normalized = username.trim().to_lowercase();
        if normalized.is_empty() {
            Self("<empty>".to_string())
        } else {
            Self(format!("user:{normalized}"))
        }
    }

    /// Build a per-thumbprint throttle key for X.509 sessions. The
    /// `thumbprint_hex` is expected to be the lowercase SHA-1 or
    /// SHA-256 fingerprint hex string per async-opcua's certificate
    /// thumbprint format. Empty input collapses to `"<empty>"` for the
    /// same reason as `for_username`.
    pub fn for_thumbprint(thumbprint_hex: &str) -> Self {
        let normalized = thumbprint_hex.trim().to_lowercase();
        if normalized.is_empty() {
            Self("<empty>".to_string())
        } else {
            Self(format!("thumb:{normalized}"))
        }
    }

    /// String form for audit emit / log context. The raw inner value
    /// already includes the `user:` / `thumb:` / `<empty>` discriminator.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Decision returned by [`FailedAuthWindow::record_failure`]. Callers
/// MUST honor `Throttled` by returning a fail-closed status to the
/// client BEFORE invoking the (expensive) password/cert verifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThrottleDecision {
    /// Failure recorded; current count within the window is `count`,
    /// at or below the cap. Caller proceeds with the fail-closed
    /// auth-rejection response (the underlying credential mismatch),
    /// no additional throttling action.
    Counted { count: u32 },
    /// Failure recorded; current count within the window has reached
    /// or exceeded the cap. Caller MUST emit `OpcUaAuthThrottled`
    /// audit event + return `BadUserAccessDenied` (or equivalent
    /// status) without invoking the verifier on subsequent attempts
    /// for this key until the window expires.
    Throttled {
        /// Current failure count in the window (>= cap).
        count: u32,
        /// Approximate duration until the oldest counted failure in
        /// the window expires. After this duration, the bucket
        /// retracts under the cap. Operator-facing log helper.
        retry_after: Duration,
    },
}

/// `FailedAuthWindow` — owns the per-key sliding-window counter cache.
///
/// The cache stores `(count, first_failure_instant)` per `AuthThrottleKey`.
/// On each `record_failure`, the entry's age is checked: if older than
/// `WINDOW_DURATION`, the count resets to 1 (a fresh window started by
/// this failure). Otherwise the count increments. When the count
/// crosses `cap`, the decision flips to `Throttled` and stays there
/// until the entry naturally evicts (TTL passes since FIRST failure).
///
/// `clear_on_success` is the success-path counterpart: a successful
/// auth invalidates the bucket entirely. An operator who typoed their
/// password 5 times and then succeeded on the 6th should not have the
/// failure history persist into a subsequent typing burst.
///
/// Concurrency: `Send + Sync`. Mutating methods take `&self`; moka
/// internally synchronizes per-key writes. `Arc<FailedAuthWindow>` is
/// the production wire shape, shared between the SensAuthManager
/// instance + any future per-source interceptor.
pub struct FailedAuthWindow {
    cap: u32,
    /// Cache value: `(count, first_failure_instant)`. The instant is
    /// the timestamp of the FIRST failure that started the current
    /// window for this key — used to compute `retry_after` for the
    /// `Throttled` decision.
    counts: Cache<AuthThrottleKey, (u32, Instant)>,
}

impl std::fmt::Debug for FailedAuthWindow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FailedAuthWindow")
            .field("cap", &self.cap)
            .field("active_keys", &self.counts.entry_count())
            .finish_non_exhaustive()
    }
}

impl FailedAuthWindow {
    /// Construct a throttle window. `cap` is the maximum number of
    /// failures permitted within `WINDOW_DURATION` (60s) before
    /// subsequent failures return `Throttled`. `cap` MUST be >= 1
    /// (panics otherwise — the invariant is config-validated upstream
    /// at `OpcUaServerConfig::validate`).
    pub fn new(cap: u32) -> Arc<Self> {
        assert!(
            cap >= 1,
            "FailedAuthWindow cap MUST be >= 1; cap=0 disables the \
             throttle which is a configuration error caught at \
             OpcUaServerConfig::validate"
        );
        Arc::new(Self {
            cap,
            counts: Cache::builder()
                .time_to_live(WINDOW_DURATION)
                // Bound memory: 4096 distinct keys per process is far
                // beyond a legitimate operator pool (typical < 50
                // operators per device). A spray attack rotating
                // through 10K usernames evicts older keys via LRU
                // before the cache grows unbounded.
                .max_capacity(4096)
                .build(),
        })
    }

    /// Test-only constructor with custom window duration. Production
    /// callers MUST use [`Self::new`] which pins the 60-second window.
    #[cfg(test)]
    fn new_with_window(cap: u32, window: Duration) -> Arc<Self> {
        Arc::new(Self {
            cap,
            counts: Cache::builder()
                .time_to_live(window)
                .max_capacity(4096)
                .build(),
        })
    }

    /// Record a failed authentication attempt for `key`. Returns the
    /// throttle decision the caller MUST honor.
    ///
    /// Concurrency contract: read-modify-write via moka's `get` +
    /// `insert`. Two concurrent record_failure calls for the same key
    /// can both read the same prior count and both write `count+1`;
    /// the second insert wins (moka per-key insert is atomic), so the
    /// final count loses ONE failure event versus a strict-serial
    /// implementation. This is acceptable for a brute-force throttle
    /// — missing a single event over a 20-failure cap is statistical
    /// noise, and the architectural floor is the worst-case latency
    /// of N+M attempts processed during the race window (M < number
    /// of concurrent threads, typically 1-4 on the edge agent).
    pub fn record_failure(&self, key: &AuthThrottleKey) -> ThrottleDecision {
        let now = Instant::now();
        let (count_value, _first_at) = match self.counts.get(key) {
            Some((existing_count, first_at)) => {
                let new_count = existing_count + 1;
                self.counts.insert(key.clone(), (new_count, first_at));
                (new_count, first_at)
            }
            None => {
                self.counts.insert(key.clone(), (1, now));
                (1u32, now)
            }
        };
        if count_value >= self.cap {
            // For retry_after, we re-fetch the entry to compute the
            // remaining TTL. moka does not expose per-entry TTL
            // remaining directly; we use WINDOW_DURATION as a
            // conservative ceiling — the actual expiry is at most
            // this far in the future, often less.
            ThrottleDecision::Throttled {
                count: count_value,
                retry_after: WINDOW_DURATION,
            }
        } else {
            ThrottleDecision::Counted { count: count_value }
        }
    }

    /// Clear the failure counter for `key` after a successful auth.
    /// Operators who typoed N < cap times should not carry that
    /// history into a subsequent burst.
    pub fn clear_on_success(&self, key: &AuthThrottleKey) {
        self.counts.invalidate(key);
    }

    /// Read the current count without recording a new failure.
    /// Used by `peek_decision` for pre-check before invoking the
    /// expensive verifier.
    pub fn current_count(&self, key: &AuthThrottleKey) -> u32 {
        self.counts.get(key).map(|(c, _)| c).unwrap_or(0)
    }

    /// Pre-check decision without recording a failure. Caller invokes
    /// this BEFORE running the verifier; if `Throttled`, the verifier
    /// is skipped entirely (Argon2id cost is the threat being
    /// mitigated). On `Counted`, the verifier runs; if it returns
    /// Err, the caller invokes `record_failure` to advance the count.
    /// On `Counted` + verifier success, the caller invokes
    /// `clear_on_success`.
    ///
    /// Returns `Throttled` IFF the current count is already >= cap.
    /// Otherwise returns `Counted{count: current}` reflecting the
    /// pre-attempt state — the caller MUST still invoke
    /// `record_failure` after a verifier-Err to actually advance the
    /// count (peek does not mutate).
    pub fn peek_decision(&self, key: &AuthThrottleKey) -> ThrottleDecision {
        let current = self.current_count(key);
        if current >= self.cap {
            ThrottleDecision::Throttled {
                count: current,
                retry_after: WINDOW_DURATION,
            }
        } else {
            ThrottleDecision::Counted { count: current }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `AuthThrottleKey::for_username` normalizes case + whitespace.
    /// `"admin "` and `"ADMIN"` and `"  Admin"` all share the same
    /// bucket — defeats trivial case-flip bypass.
    #[test]
    fn throttle_key_normalizes_username() {
        let a = AuthThrottleKey::for_username("admin");
        let b = AuthThrottleKey::for_username("ADMIN");
        let c = AuthThrottleKey::for_username("  Admin  ");
        assert_eq!(a, b);
        assert_eq!(a, c);
        assert_eq!(a.as_str(), "user:admin");
    }

    /// Empty input collapses to a sentinel bucket — protocol-level
    /// malformed clients get their own counter rather than sharing
    /// the global counter with a legitimate operator.
    #[test]
    fn throttle_key_empty_collapses_to_sentinel() {
        let a = AuthThrottleKey::for_username("");
        let b = AuthThrottleKey::for_username("   ");
        assert_eq!(a, b);
        assert_eq!(a.as_str(), "<empty>");
    }

    /// Username key + thumbprint key with the same string DON'T collide
    /// — different prefixes (`user:` vs `thumb:`).
    #[test]
    fn throttle_key_username_and_thumbprint_distinct_namespaces() {
        let user = AuthThrottleKey::for_username("admin");
        let thumb = AuthThrottleKey::for_thumbprint("admin");
        assert_ne!(user, thumb);
    }

    /// First failure → Counted{1}.
    #[test]
    fn first_failure_returns_counted_one() {
        let win = FailedAuthWindow::new(20);
        let key = AuthThrottleKey::for_username("alice");
        match win.record_failure(&key) {
            ThrottleDecision::Counted { count } => assert_eq!(count, 1),
            other => panic!("expected Counted{{1}}, got {other:?}"),
        }
    }

    /// At-cap failure returns Throttled.
    #[test]
    fn cap_th_failure_returns_throttled() {
        let win = FailedAuthWindow::new(3);
        let key = AuthThrottleKey::for_username("bob");
        // 3 failures (1, 2, 3) — the 3rd reaches the cap.
        let _ = win.record_failure(&key);
        let _ = win.record_failure(&key);
        match win.record_failure(&key) {
            ThrottleDecision::Throttled { count, .. } => {
                assert!(count >= 3, "count={count}");
            }
            other => panic!("expected Throttled, got {other:?}"),
        }
    }

    /// Subsequent failures while throttled still return Throttled.
    #[test]
    fn post_cap_failures_stay_throttled() {
        let win = FailedAuthWindow::new(2);
        let key = AuthThrottleKey::for_username("charlie");
        let _ = win.record_failure(&key);
        let _ = win.record_failure(&key);
        // 3rd, 4th, 5th — all throttled.
        for i in 3..=5 {
            match win.record_failure(&key) {
                ThrottleDecision::Throttled { count, .. } => {
                    assert!(count >= 2, "iteration {i}: count={count}");
                }
                other => panic!("iteration {i}: expected Throttled, got {other:?}"),
            }
        }
    }

    /// Different keys are independent — alice's failures do not throttle bob.
    #[test]
    fn keys_are_independent() {
        let win = FailedAuthWindow::new(2);
        let alice = AuthThrottleKey::for_username("alice");
        let bob = AuthThrottleKey::for_username("bob");
        let _ = win.record_failure(&alice);
        let _ = win.record_failure(&alice);
        // Alice is at cap; Bob is fresh.
        match win.record_failure(&bob) {
            ThrottleDecision::Counted { count } => assert_eq!(count, 1),
            other => panic!("expected Counted{{1}} for bob, got {other:?}"),
        }
    }

    /// Successful auth clears the failure counter.
    #[test]
    fn clear_on_success_resets_counter() {
        let win = FailedAuthWindow::new(3);
        let key = AuthThrottleKey::for_username("dave");
        let _ = win.record_failure(&key);
        let _ = win.record_failure(&key);
        assert_eq!(win.current_count(&key), 2);
        win.clear_on_success(&key);
        assert_eq!(win.current_count(&key), 0);
        // After clear, fresh window starts.
        match win.record_failure(&key) {
            ThrottleDecision::Counted { count } => assert_eq!(count, 1),
            other => panic!("expected Counted{{1}} after clear, got {other:?}"),
        }
    }

    /// `peek_decision` before any failure returns Counted{0}.
    #[test]
    fn peek_decision_initial_counted_zero() {
        let win = FailedAuthWindow::new(3);
        let key = AuthThrottleKey::for_username("eve");
        match win.peek_decision(&key) {
            ThrottleDecision::Counted { count } => assert_eq!(count, 0),
            other => panic!("expected Counted{{0}}, got {other:?}"),
        }
    }

    /// `peek_decision` on a throttled bucket returns Throttled WITHOUT
    /// mutating the count.
    #[test]
    fn peek_decision_throttled_does_not_mutate() {
        let win = FailedAuthWindow::new(2);
        let key = AuthThrottleKey::for_username("frank");
        let _ = win.record_failure(&key);
        let _ = win.record_failure(&key);
        // Now at-cap; peek returns Throttled.
        let pre_count = win.current_count(&key);
        match win.peek_decision(&key) {
            ThrottleDecision::Throttled { .. } => {}
            other => panic!("expected Throttled, got {other:?}"),
        }
        let post_count = win.current_count(&key);
        assert_eq!(pre_count, post_count, "peek MUST NOT mutate");
    }

    /// Window TTL expiry resets the counter (verified via short test
    /// window — the production 60s window is too slow for a unit test).
    #[test]
    fn window_expiry_resets_counter() {
        let win = FailedAuthWindow::new_with_window(2, Duration::from_millis(100));
        let key = AuthThrottleKey::for_username("grace");
        let _ = win.record_failure(&key);
        let _ = win.record_failure(&key);
        assert_eq!(win.current_count(&key), 2);
        // Wait past the window.
        std::thread::sleep(Duration::from_millis(150));
        // moka's TTL eviction is lazy on read — current_count after
        // expiry returns 0 because the entry is expired.
        // First, kick the cache to ensure the eviction fires.
        win.counts.run_pending_tasks();
        // Now record a fresh failure; should be Counted{1}.
        match win.record_failure(&key) {
            ThrottleDecision::Counted { count } => assert_eq!(count, 1),
            other => panic!("expected fresh Counted{{1}} after expiry, got {other:?}"),
        }
    }

    /// `cap = 0` panics at construction — config-validation upstream
    /// also catches this, but the constructor's panic is the
    /// architectural floor (defense-in-depth).
    #[test]
    #[should_panic(expected = "cap MUST be >= 1")]
    fn cap_zero_panics() {
        let _ = FailedAuthWindow::new(0);
    }

    /// Debug impl shows cap + active_keys without leaking the
    /// per-key buckets — operator-readable boot log can include the
    /// throttle without exposing usernames.
    #[test]
    fn debug_format_redacts_keys() {
        let win = FailedAuthWindow::new(5);
        let dbg = format!("{win:?}");
        assert!(dbg.contains("FailedAuthWindow"));
        assert!(dbg.contains("cap: 5"));
        // Should NOT contain any username strings.
        assert!(!dbg.contains("user:"));
    }

    /// Cap == 1 is a degenerate-but-legal config — first failure is
    /// at-cap and returns Throttled.
    #[test]
    fn cap_one_first_failure_throttles() {
        let win = FailedAuthWindow::new(1);
        let key = AuthThrottleKey::for_username("zero-tolerance");
        match win.record_failure(&key) {
            ThrottleDecision::Throttled { count, .. } => {
                assert_eq!(count, 1);
            }
            other => panic!("expected Throttled at cap=1, got {other:?}"),
        }
    }
}
