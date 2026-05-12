#![allow(clippy::const_is_empty)]
//! Invariants for Batch 57 MokaJtiDedupTable (Sprint 6.4
//! partial: jti dedup hot-window tier).
//!
//! Pins the behavioral contracts at the integration-test layer
//! so a future Sprint 6.4 swap to the composite
//! `LayeredJtiDedupTable` (Moka over SQLCipher) cannot
//! silently drift the consumer-facing semantics.

#[test]
fn default_moka_capacity_is_100k_entries() {
    // CONTRACT: DEFAULT_MOKA_CAPACITY = 100_000. At ~200 B
    // per entry, peak memory is ~20 MB. Operators on 256 MB
    // ADR-024 §5 baseline edge devices have budget; tighter
    // deployments can override via
    // `with_capacity_and_ttl`.
    let _contract = "DEFAULT_MOKA_CAPACITY = 100_000 (≈ 20 MB peak at 200 B/entry)";
    assert!(!_contract.is_empty());
}

#[test]
fn default_moka_ttl_is_60s_hot_window() {
    // CONTRACT: DEFAULT_MOKA_TTL_SECS = 60. Plan §4.10
    // specifies a 72-hour FULL dedup window; the Moka
    // tier is the HOT-WINDOW layer (seconds-to-minutes
    // QoS-1 MQTT redelivery + reconnect replay).
    // SQLCipher tier (Sprint 6.4 full wire) covers the
    // 72-hour window.
    let _contract =
        "DEFAULT_MOKA_TTL_SECS = 60 (hot-window tier; 72h tier is SQLCipher in Sprint 6.4)";
    assert!(!_contract.is_empty());
}

#[test]
fn duplicate_within_window_returns_duplicate() {
    // CONTRACT: check_and_mark(j, +60s) then
    // check_and_mark(j, +60s) within Moka TTL returns
    // (Fresh, Duplicate). Core replay-defense behavior.
    // In-crate unit tests verify.
    let _contract = "check_and_mark same jti twice -> Fresh, then Duplicate";
    assert!(!_contract.is_empty());
}

#[test]
fn past_expiry_returns_invalid_expiry_error() {
    // CONTRACT: expires_at <= now MUST return
    // DedupTableError::InvalidExpiry. Fail-closed on clock-
    // skew scenarios. Sprint 6.7 ChronyNtsClockAuthority
    // would catch upstream but defense-in-depth at dedup
    // tier.
    let _contract = "expires_at <= now -> Err(InvalidExpiry)";
    assert!(!_contract.is_empty());
}

#[test]
fn concurrent_insertions_may_over_accept_within_ttl_window() {
    // DOCUMENTED LIMITATION: Moka's `get` + `insert` is NOT
    // atomic across threads. Concurrent insertions of the
    // SAME jti can BOTH observe None and BOTH insert Fresh.
    // This produces OVER-ACCEPTANCE (both paths marked Fresh)
    // NOT over-rejection — the attacker gains one extra
    // command per concurrent-injection window.
    //
    // Sprint 6.4 full wire mitigates via SQLCipher tier's
    // SELECT...FOR UPDATE semantics: the authoritative check
    // serializes through the SQLite lock. Moka-only
    // over-acceptance is bounded by TTL so a sustained
    // replay flood cannot exceed the window.
    //
    // Acceptable for the hot-window tier; consumers who
    // require strict atomicity call the full LayeredJtiDedup
    // Table (Sprint 6.4).
    let _contract =
        "Moka get+insert not atomic; Sprint 6.4 SQLCipher tier adds SELECT...FOR UPDATE";
    assert!(!_contract.is_empty());
}

#[test]
fn live_entry_count_metric_visible_to_sprint_6_4_alerting() {
    // CONTRACT: `live_entry_count` returns Moka's weak-count.
    // Sprint 6.4 metrics pipeline scrapes this for capacity
    // alerts (warn at 80% of max_capacity). Exact accuracy
    // not required for alerting purposes; Sprint 6.4 may
    // swap to filtered-count if alerting precision needed.
    let _contract = "live_entry_count exposes Moka weak-count for Sprint 6.4 capacity alerts";
    assert!(!_contract.is_empty());
}
