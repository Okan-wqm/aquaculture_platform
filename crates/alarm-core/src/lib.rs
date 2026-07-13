//! `alarm-core` — the drift-zero alarm DECISION core.
//!
//! WHY this crate exists:
//!   The Rust edge alarm engine (`sens-api-gateway/src/alarm_engine.rs`) and the
//!   TypeScript SCADA alarm engine
//!   (`apps/sensor-service/src/scada-runtime/services/alarm-engine.service.ts`)
//!   independently re-implemented the SAME decision predicates — condition test,
//!   deadband hysteresis, and delay gate — and had silently DRIFTED: the edge
//!   compared `==` with `f64::EPSILON` (effectively exact) while the runtime used
//!   `1e-4`; the edge cleared on INCLUSIVE deadband boundaries while the runtime
//!   used EXCLUSIVE; the edge carried a hidden `.max(0.01)` deadband floor the
//!   runtime never had; the edge truncated the delay to whole seconds while the
//!   runtime used millisecond precision. Two engines, one spec, no shared code =
//!   drift by construction.
//!
//!   This crate is that one spec, as pure functions. Both engines call it (the
//!   edge natively, the backend via a WebAssembly build), so the decision math
//!   is identical by construction — drift becomes a compile/test-time invariant,
//!   not a field bug (the same discipline as `protocol-codec`, ADR-026).
//!
//! WHAT lives here — and what does NOT:
//!   Only the STATELESS decision predicates live here. The alarm STATE MACHINES
//!   legitimately differ (the edge is 2-state; the SCADA runtime is 4-state with
//!   three acknowledgement modes, bitmasking, per-rule actions and persistence)
//!   and are NOT unified — each engine keeps its own orchestration and calls
//!   these predicates for the value/threshold/time math. No I/O, no clock reads,
//!   no state: the caller owns time and state and passes them in.
//!
//! CANONICAL SEMANTICS (the SCADA-runtime semantics are canonical — it is the
//! richer, continuously-running 1 Hz engine — with two deliberate refinements):
//!   * `==` / `!=` tolerance is an explicit, caller-supplied `epsilon`
//!     ([`DEFAULT_EPSILON`] = `1e-4`). `f64::EPSILON` is an exact-equality
//!     comparison and is wrong for scaled/noisy sensor floats.
//!   * Deadband clear boundaries are EXCLUSIVE — the value must be STRICTLY past
//!     `threshold ± deadband` to clear, so an alarm cannot chatter at the band
//!     edge.
//!   * `deadband == 0` means "no hysteresis": clearing is gated only by the
//!     condition already being false (the caller checks that first), so the
//!     predicate returns `true`.
//!   * The hidden `.max(0.01)` deadband floor is REMOVED — the configured
//!     deadband is used exactly as given; no silent minimum.
//!   * The delay gate is millisecond-precision with NO integer-second
//!     truncation; the caller supplies elapsed-ms and delay-ms from its own
//!     (monotonic edge / wall-clock runtime) source.

#![cfg_attr(not(test), forbid(unsafe_code))]
#![cfg_attr(not(test), deny(missing_docs))]
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::float_cmp,
    )
)]

/// Default `==` / `!=` comparison tolerance for sensor floats.
///
/// Callers pass this to [`evaluate_condition`] unless a rule overrides it. It
/// matches the SCADA runtime's long-standing hard-coded `0.0001`.
pub const DEFAULT_EPSILON: f64 = 1e-4;

/// Crate version, for drift-detection telemetry.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Evaluate whether `value` satisfies `operator` against `threshold`.
///
/// `operator` is the wire symbol as stored in a rule (`"<"`, `">"`, `"=="`,
/// `"!="`, `"<="`, `">="`). Equality (`==`) and inequality (`!=`) compare within
/// `epsilon` (see [`DEFAULT_EPSILON`]). An unrecognised operator yields `false`
/// (no alarm) — matching both engines' fail-safe default.
#[must_use]
pub fn evaluate_condition(operator: &str, value: f64, threshold: f64, epsilon: f64) -> bool {
    match operator {
        "<" => value < threshold,
        ">" => value > threshold,
        "<=" => value <= threshold,
        ">=" => value >= threshold,
        "==" => (value - threshold).abs() < epsilon,
        "!=" => (value - threshold).abs() >= epsilon,
        _ => false,
    }
}

/// Return `true` when `value` is far enough past the threshold — by the deadband
/// margin — that an already-active alarm may CLEAR (hysteresis).
///
/// The caller invokes this only after finding the raw condition no longer met;
/// this predicate adds the hysteresis margin so the alarm does not chatter near
/// the threshold. Boundaries are EXCLUSIVE (strictly past `threshold ± deadband`).
/// A `deadband` of `0` means no hysteresis and returns `true`. An unrecognised
/// operator yields `true` (allow clear) — matching both engines' default.
#[must_use]
pub fn is_outside_deadband(operator: &str, value: f64, threshold: f64, deadband: f64) -> bool {
    if deadband == 0.0 {
        return true;
    }
    match operator {
        ">" | ">=" => value < threshold - deadband,
        "<" | "<=" => value > threshold + deadband,
        "==" => (value - threshold).abs() > deadband,
        "!=" => (value - threshold).abs() <= deadband,
        _ => true,
    }
}

/// Return `true` when a met condition has persisted long enough to trigger.
///
/// Millisecond precision, no integer-second truncation: the alarm fires once
/// `elapsed_ms >= delay_ms`. The caller measures `elapsed_ms` from its own clock
/// (monotonic on the edge, wall-clock in the runtime) — the kernel is agnostic
/// to the source because a delay is a relative duration.
#[must_use]
pub fn delay_elapsed(elapsed_ms: u64, delay_ms: u64) -> bool {
    elapsed_ms >= delay_ms
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f64 = DEFAULT_EPSILON;

    #[test]
    fn condition_operators() {
        assert!(evaluate_condition("<", 1.0, 2.0, EPS));
        assert!(!evaluate_condition("<", 2.0, 2.0, EPS));
        assert!(evaluate_condition(">", 3.0, 2.0, EPS));
        assert!(evaluate_condition("<=", 2.0, 2.0, EPS));
        assert!(evaluate_condition(">=", 2.0, 2.0, EPS));
    }

    #[test]
    fn equality_uses_epsilon_not_exact() {
        // Within 1e-4 counts as equal (a scaled sensor float never lands exact).
        assert!(evaluate_condition("==", 5.00005, 5.0, EPS));
        assert!(!evaluate_condition("==", 5.001, 5.0, EPS));
        assert!(evaluate_condition("!=", 5.001, 5.0, EPS));
        assert!(!evaluate_condition("!=", 5.00005, 5.0, EPS));
    }

    #[test]
    fn unknown_operator_is_false_for_condition() {
        assert!(!evaluate_condition("><", 1.0, 2.0, EPS));
    }

    #[test]
    fn deadband_zero_allows_clear() {
        assert!(is_outside_deadband(">", 100.0, 50.0, 0.0));
        assert!(is_outside_deadband("==", 50.0, 50.0, 0.0));
    }

    #[test]
    fn deadband_boundaries_are_exclusive() {
        // '>' alarm clears only strictly below threshold - deadband.
        assert!(!is_outside_deadband(">", 48.0, 50.0, 2.0)); // exactly at edge — stays latched
        assert!(is_outside_deadband(">", 47.9, 50.0, 2.0)); // strictly past — clears
        // '<' alarm clears only strictly above threshold + deadband.
        assert!(!is_outside_deadband("<", 52.0, 50.0, 2.0));
        assert!(is_outside_deadband("<", 52.1, 50.0, 2.0));
    }

    #[test]
    fn deadband_has_no_hidden_floor() {
        // A small deadband (< the old 0.01 floor) is honoured exactly.
        assert!(is_outside_deadband("==", 50.005, 50.0, 0.001));
        assert!(!is_outside_deadband("==", 50.0005, 50.0, 0.001));
    }

    #[test]
    fn delay_gate_is_millisecond_precise() {
        assert!(!delay_elapsed(1_500, 2_000));
        assert!(delay_elapsed(2_000, 2_000));
        assert!(delay_elapsed(2_001, 2_000));
        // No whole-second truncation: 1900 ms does NOT satisfy a 2 s delay.
        assert!(!delay_elapsed(1_900, 2_000));
    }
}
