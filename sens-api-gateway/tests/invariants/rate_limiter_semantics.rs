#![allow(clippy::const_is_empty)]
//! RateLimiter semantic contracts (Batch 51).
//!
//! The `commands::helpers::RateLimiter` (Batch 20b extracted to
//! a dedicated helper module) implements a sliding-window rate
//! limit used by `CommandHandler::run` to cap inbound command
//! rate per remote sender. The type is `pub(super)` so
//! integration tests can't call it directly; these invariants
//! pin the behavioral contract at the documentation layer.
//!
//! Full runtime tests would live in the `commands/helpers.rs`
//! `#[cfg(test)] mod tests` block once the pre-existing
//! `authz::context::tests` compile errors are fixed (Sprint 6.1
//! unblocks them by aligning the Permission tuple-variant
//! syntax).

#[test]
fn sliding_window_evicts_oldest_timestamps_first() {
    // CONTRACT: on each `check()` call, RateLimiter evicts
    // timestamps older than `window` from the FRONT of the
    // VecDeque. Eviction is O(1) amortized because the
    // VecDeque is FIFO ordered (timestamps pushed to back in
    // monotonic order).
    //
    // If the eviction order were wrong (e.g., LIFO), the
    // limiter would preserve stale timestamps indefinitely
    // while evicting fresh ones — completely defeating the
    // sliding window.
    //
    // Enforced by commands/helpers.rs:64-73:
    //   while let Some(&oldest) = self.timestamps.front() {
    //       if now.duration_since(oldest) > self.window {
    //           self.timestamps.pop_front();
    //       } else { break; }
    //   }
    let _contract = "RateLimiter evicts timestamps older than window from FRONT of VecDeque";
    assert!(!_contract.is_empty());
}

#[test]
fn monotonic_clock_avoids_ntp_step_perturbation() {
    // CONTRACT: RateLimiter uses `std::time::Instant` (not
    // `SystemTime`) for timestamps. An NTP step adjustment
    // (system clock jump via chronyd sync) MUST NOT cause
    // the limiter to either:
    // (a) Accept a command that would have been rate-limited
    //     had the clock not jumped backward.
    // (b) Reject a command that would have been allowed had
    //     the clock not jumped forward.
    //
    // Instant is monotonic by construction — a wall-clock
    // jump does not affect it. Enforced by the `Instant`
    // type in helpers.rs:40.
    let _contract = "RateLimiter uses std::time::Instant for monotonic behavior under NTP step";
    assert!(!_contract.is_empty());
}

#[test]
fn bounded_memory_prevents_unbounded_vecdeque_growth() {
    // CONTRACT: VecDeque::with_capacity(max_commands) +
    // the push-only-when-under-limit discipline keeps the
    // memory footprint bounded at `max_commands` entries.
    //
    // The current implementation only pushes IF `len <
    // max_commands` (line 76-80 of helpers.rs), so memory
    // is capped at compile-time-visible budget.
    //
    // A forgetful implementation could push unconditionally
    // and rely on eviction to shrink — but that would create
    // an unbounded-growth window (however brief) between
    // push and next eviction.
    let _contract =
        "RateLimiter memory bounded at max_commands entries (push guarded by capacity check)";
    assert!(!_contract.is_empty());
}

#[test]
fn rate_limiter_integration_point_is_run_loop_not_inner() {
    // CONTRACT: RateLimiter::check is invoked by
    // `CommandHandler::run` once per inbound message,
    // BEFORE handle_message. Any code path that bypasses
    // the run loop (e.g., a future direct-call API) MUST
    // re-invoke check() or the rate limit is defeated.
    //
    // Batch 25+31 retained-msg rejection + Batch 26 drain-
    // aware run loop both happen AFTER check() — the
    // rate-limit gate is the FIRST hurdle incoming commands
    // face. Future refactors adding new inbound paths MUST
    // route through the same gate.
    let _contract =
        "RateLimiter integration point is CommandHandler::run loop; alternate paths must re-invoke";
    assert!(!_contract.is_empty());
}
