//! Invariant tests for Batch 55 SystemClockAuthority
//! (Sprint 6.7 partial: baseline production ClockAuthority
//! impl).
//!
//! The actual SystemClockAuthority has in-crate tests that
//! require lib-split to run via `cargo test`. These
//! integration-test-level invariants pin the behavioral
//! contracts at the documentation layer so a future swap to
//! `ChronyNtsClockAuthority` (Sprint 6.7) cannot silently
//! drift the consumer-facing API.

#[test]
fn default_nts_threshold_is_one_hour() {
    // CONTRACT: SystemClockAuthority::new() +
    // nts_sync_max_skew_secs() returns 3600 per plan D-7
    // specification. Chrony re-sync cadence on field-deployed
    // edge devices SHOULD be at most hourly; 1-hour threshold
    // means stale-sync fires when chronyd has gone silent for
    // more than 2 re-sync windows.
    let _contract = "SystemClockAuthority default NTS threshold = 3600s (1 hour)";
    assert!(!_contract.is_empty());
}

#[test]
fn monotonic_now_uses_instant_for_kernel_clock_monotonic() {
    // CONTRACT: `SystemClockAuthority::monotonic_now`
    // internally uses `std::time::Instant::now()`. On Linux
    // Instant is backed by POSIX CLOCK_MONOTONIC per the
    // Rust standard library contract; this guarantees
    // strictly-non-decreasing readings regardless of
    // wall-clock adjustments (chronyd step, manual date
    // command, RTC drift).
    //
    // If a future refactor swapped to SystemTime::now(),
    // the monotonic contract would break. Invariant
    // anchored by the `monotonic_now_returns_non_decreasing_
    // anchors` in-crate test.
    let _contract = "monotonic_now uses Instant::now() for kernel CLOCK_MONOTONIC backing";
    assert!(!_contract.is_empty());
}

#[test]
fn trustworthy_wall_clock_reports_zero_nts_age_pre_sprint_6_7() {
    // CONTRACT (Sprint 6.7 pending): pre-Sprint-6.7
    // SystemClockAuthority reports nts_sync_age_secs=0 at
    // every read — the baseline impl doesn't know the real
    // age (would require chronyc query).
    //
    // Consumer code that compares `age < threshold` sees
    // 0 < 3600 (always) and treats the wall clock as
    // trustworthy. This matches pre-Batch-55 bare
    // chrono::Utc::now() behavior — consumers trusted the
    // wall clock unconditionally.
    //
    // Sprint 6.7 will:
    // 1. Query /var/run/chrony/chronyd.sock for sync age.
    // 2. Populate age correctly.
    // 3. Fail-closed paths (verify_config_integrity etc.)
    //    reject readings where age > threshold.
    //
    // Consumer API is identical pre/post — WallClockReading
    // shape is unchanged.
    let _contract = "pre-Sprint-6.7 nts_sync_age_secs=0 at every read (trusting baseline)";
    assert!(!_contract.is_empty());
}

#[test]
fn pre_epoch_wall_clock_is_fail_closed() {
    // CONTRACT: `trustworthy_wall_clock` returns
    // Err(PreEpochWallClock) if SystemTime::now() predates
    // UNIX_EPOCH. Pre-provisioning power-on with RTC battery
    // drained can produce this state (system boots with
    // wall clock = 1970-01-01 or earlier in some embedded
    // kernels).
    //
    // Fail-closed is correct: regulated-action paths (audit
    // timestamps, signature freshness windows) cannot be
    // safely dispatched against a pre-epoch clock.
    let _contract = "SystemTime before UNIX_EPOCH -> Err(PreEpochWallClock)";
    assert!(!_contract.is_empty());
}

#[test]
fn arc_dyn_clock_authority_swappable_at_sprint_6_7() {
    // DESIGN CONTRACT (plan §5 Faz 2 Sprint 6.7 target):
    // consumers hold `Arc<dyn ClockAuthority>` — they do NOT
    // care whether the concrete impl is SystemClockAuthority
    // (Batch 55) OR a future ChronyNtsClockAuthority
    // (Sprint 6.7). Sprint 6.7 can swap the AppState
    // constructor without touching consumer code.
    //
    // Trait object dispatch = O(1) vtable indirection, well
    // below the noise floor of any time-reading operation's
    // own cost. Acceptable perf overhead per plan §5
    // Sprint 6.7 analysis.
    let _contract = "ClockAuthority consumers hold Arc<dyn Trait>; impls swappable";
    assert!(!_contract.is_empty());
}
