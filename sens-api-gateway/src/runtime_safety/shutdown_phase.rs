//! # ShutdownPhase + DrainState — graceful-shutdown race fix (plan D-15)
//!
//! On SIGTERM / systemd stop, the edge agent MUST:
//!
//! 1. **Stop accepting new commands** — MQTT command-topic subscriber
//!    unsubscribes; HTTP command endpoint returns 503. Inbound envelopes
//!    beyond this point are rejected with `ServiceShuttingDown`.
//! 2. **Drain in-flight commands** — wait up to `drain_timeout_ms` (50ms
//!    default) for already-accepted commands to complete their handler
//!    dispatch. Exceeded → cancel + log per-command audit entry with
//!    `AbortedByShutdownTimeout`.
//! 3. **Apply safe-state** — drive every actuator to its `FailSafe` value
//!    per ADR-024 §3 (Safe-State v2 taxonomy from Batch 3).
//! 4. **Flush offline queue** — SQLite `PRAGMA wal_checkpoint(TRUNCATE)`
//!    + `fsync(datadir)` to ensure audit + telemetry rows survive the
//!    TimeoutStopSec window (plan §3 R-11 SEC-007 HMAC chain durability).
//! 5. **Disconnect MQTT** — clean disconnect with last-will NOT triggered.
//!
//! Plan D-15 identifies a RACE in v1.6.0: step 3 (safe-state apply) ran
//! BEFORE step 2 (drain) completed, so an in-flight `write_tag` command
//! could overwrite the safe-state value AFTER it was applied — actuator
//! left in commanded (possibly unsafe) state. This module's
//! `ShutdownPhase` enum + `DrainState` machine enforce the correct order
//! at the TYPE level: `ApplySafeState` transition requires prior
//! `Drained` state.
//!
//! ## Scope of Batch 10
//!
//! Types + `ShutdownTransition` transition checker. Runtime (signal
//! handler, drain loop, safe-state apply, offline-queue checkpoint,
//! MQTT disconnect) lands in Faz 2 Sprint 6.7.

use serde::{Deserialize, Serialize};

use super::clock::MonotonicAnchor;

/// Phase of the graceful-shutdown state machine. Each phase represents a
/// durable checkpoint — systemd's `TimeoutStopSec=90s` budget is
/// distributed across phase transitions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShutdownPhase {
    /// Normal operation — accepting commands, running scan cycles.
    Running,

    /// SIGTERM received. Unsubscribe from command topics AND HTTP command
    /// endpoints return 503. Scan cycles continue (safe-state not yet
    /// applied).
    StoppingInbound,

    /// Inbound stopped; in-flight commands draining. Any command whose
    /// handler-dispatch has not completed within `drain_timeout_ms` is
    /// force-cancelled with `AbortedByShutdownTimeout` audit.
    Draining,

    /// All in-flight commands settled. Ready to apply safe-state.
    Drained,

    /// Actuator safe-state apply in progress (per ADR-024 §3 FailSafe enum).
    /// Scan cycles stopped; no new tag writes after this phase begins.
    ApplyingSafeState,

    /// Safe-state applied; flushing offline queue + audit log + SQLite WAL
    /// checkpoint + fsync.
    Flushing,

    /// MQTT clean disconnect in progress.
    DisconnectingMqtt,

    /// All steps complete; process exit imminent.
    Shutdown,
}

impl ShutdownPhase {
    pub const fn wire_tag(self) -> u8 {
        match self {
            Self::Running => 0,
            Self::StoppingInbound => 1,
            Self::Draining => 2,
            Self::Drained => 3,
            Self::ApplyingSafeState => 4,
            Self::Flushing => 5,
            Self::DisconnectingMqtt => 6,
            Self::Shutdown => 7,
        }
    }
}

/// Drain loop state — tracks the in-flight command count, the drain
/// start anchor, and the timeout budget. Used by the shutdown coordinator
/// to decide whether to advance to `Drained` (count == 0) or force-cancel
/// (timeout elapsed).
///
/// EDGE-MEDIUM-002 closure: the `drain_started_at: MonotonicAnchor` field
/// keeps the drain-start timestamp co-located with `is_timed_out` decision
/// logic, preventing cross-module state spread during Sprint 6.7 wiring.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DrainState {
    /// In-flight command count. `0` means drain complete — the
    /// coordinator advances to `Drained` phase.
    pub in_flight: u32,
    /// Drain budget in milliseconds. Plan D-15 default 50ms; configurable
    /// via `config.yaml::shutdown.drain_timeout_ms`.
    pub drain_timeout_ms: u32,
    /// Monotonic anchor at the `StoppingInbound → Draining` transition.
    /// Used by `is_timed_out` to decide force-cancel.
    pub drain_started_at: MonotonicAnchor,
}

impl DrainState {
    pub fn is_drained(&self) -> bool {
        self.in_flight == 0
    }

    /// True iff `now - drain_started_at >= drain_timeout_ms`. On monotonic-
    /// clock anomaly (backward / overflow) returns true (fail-closed:
    /// prefer to force-cancel than hang).
    pub fn is_timed_out(&self, now: MonotonicAnchor) -> bool {
        match now.saturating_duration_since(self.drain_started_at) {
            Ok(elapsed) => elapsed.as_millis() as u32 >= self.drain_timeout_ms,
            Err(_) => true,
        }
    }
}

/// A single phase transition. Each variant encodes a VALID move; invalid
/// transitions (e.g., Running → ApplyingSafeState skipping drain) are NOT
/// representable — tier-1 make-it-impossible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownTransition {
    /// Normal operation → inbound-stop on SIGTERM.
    RunningToStoppingInbound,
    /// Inbound stopped → drain loop begins.
    StoppingInboundToDraining,
    /// Drain loop completes (in_flight == 0 OR timeout exceeded).
    DrainingToDrained,
    /// Drained → safe-state apply. This is the transition D-15 identifies
    /// as race-prone without prior Drained phase.
    DrainedToApplyingSafeState,
    /// Safe-state complete → flush.
    ApplyingSafeStateToFlushing,
    /// Flush complete → MQTT disconnect.
    FlushingToDisconnectingMqtt,
    /// MQTT disconnected → process exit.
    DisconnectingMqttToShutdown,
}

impl ShutdownTransition {
    pub const fn from_phase(self) -> ShutdownPhase {
        match self {
            Self::RunningToStoppingInbound => ShutdownPhase::Running,
            Self::StoppingInboundToDraining => ShutdownPhase::StoppingInbound,
            Self::DrainingToDrained => ShutdownPhase::Draining,
            Self::DrainedToApplyingSafeState => ShutdownPhase::Drained,
            Self::ApplyingSafeStateToFlushing => ShutdownPhase::ApplyingSafeState,
            Self::FlushingToDisconnectingMqtt => ShutdownPhase::Flushing,
            Self::DisconnectingMqttToShutdown => ShutdownPhase::DisconnectingMqtt,
        }
    }

    pub const fn to_phase(self) -> ShutdownPhase {
        match self {
            Self::RunningToStoppingInbound => ShutdownPhase::StoppingInbound,
            Self::StoppingInboundToDraining => ShutdownPhase::Draining,
            Self::DrainingToDrained => ShutdownPhase::Drained,
            Self::DrainedToApplyingSafeState => ShutdownPhase::ApplyingSafeState,
            Self::ApplyingSafeStateToFlushing => ShutdownPhase::Flushing,
            Self::FlushingToDisconnectingMqtt => ShutdownPhase::DisconnectingMqtt,
            Self::DisconnectingMqttToShutdown => ShutdownPhase::Shutdown,
        }
    }
}

/// Error when a transition cannot be applied (current phase doesn't match
/// the transition's `from_phase`).
///
/// EDGE-LOW-001 closure: carries the attempted transition value so audit
/// entries can discriminate between multiple transitions sharing a common
/// from_phase (forward-compat when the enum grows).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShutdownTransitionError {
    pub current_phase: ShutdownPhase,
    pub attempted_transition: ShutdownTransition,
}

impl ShutdownTransitionError {
    /// Convenience: the from_phase the transition required (vs current_phase
    /// actually observed).
    pub fn expected_from_phase(&self) -> ShutdownPhase {
        self.attempted_transition.from_phase()
    }
}

impl std::fmt::Display for ShutdownTransitionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "shutdown_transition_invalid:current={:?}:attempted={:?}:expected_from={:?}",
            self.current_phase,
            self.attempted_transition,
            self.attempted_transition.from_phase()
        )
    }
}

impl std::error::Error for ShutdownTransitionError {}

/// Apply a transition to a phase. Returns the new phase or
/// [`ShutdownTransitionError`] if the current phase doesn't match the
/// transition's `from_phase`. This function is the tier-1 enforcement:
/// callers cannot skip a phase (e.g. Running → ApplyingSafeState is
/// structurally impossible — no `ShutdownTransition` variant exists).
pub fn apply_transition(
    current: ShutdownPhase,
    transition: ShutdownTransition,
) -> Result<ShutdownPhase, ShutdownTransitionError> {
    if current != transition.from_phase() {
        return Err(ShutdownTransitionError {
            current_phase: current,
            attempted_transition: transition,
        });
    }
    Ok(transition.to_phase())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// WHY: Wire tags stable 0..=7 contiguous.
    #[test]
    fn shutdown_phase_wire_tags_stable() {
        assert_eq!(ShutdownPhase::Running.wire_tag(), 0);
        assert_eq!(ShutdownPhase::StoppingInbound.wire_tag(), 1);
        assert_eq!(ShutdownPhase::Draining.wire_tag(), 2);
        assert_eq!(ShutdownPhase::Drained.wire_tag(), 3);
        assert_eq!(ShutdownPhase::ApplyingSafeState.wire_tag(), 4);
        assert_eq!(ShutdownPhase::Flushing.wire_tag(), 5);
        assert_eq!(ShutdownPhase::DisconnectingMqtt.wire_tag(), 6);
        assert_eq!(ShutdownPhase::Shutdown.wire_tag(), 7);
    }

    /// WHY: snake_case serde for audit surface.
    #[test]
    fn shutdown_phase_serde_snake_case() {
        assert_eq!(
            serde_json::to_string(&ShutdownPhase::StoppingInbound).expect("ok"),
            r#""stopping_inbound""#
        );
        assert_eq!(
            serde_json::to_string(&ShutdownPhase::ApplyingSafeState).expect("ok"),
            r#""applying_safe_state""#
        );
        assert_eq!(
            serde_json::to_string(&ShutdownPhase::DisconnectingMqtt).expect("ok"),
            r#""disconnecting_mqtt""#
        );
    }

    /// WHY: Full legal transition chain — Running → … → Shutdown.
    #[test]
    fn full_legal_transition_chain() {
        let transitions = [
            ShutdownTransition::RunningToStoppingInbound,
            ShutdownTransition::StoppingInboundToDraining,
            ShutdownTransition::DrainingToDrained,
            ShutdownTransition::DrainedToApplyingSafeState,
            ShutdownTransition::ApplyingSafeStateToFlushing,
            ShutdownTransition::FlushingToDisconnectingMqtt,
            ShutdownTransition::DisconnectingMqttToShutdown,
        ];
        let mut phase = ShutdownPhase::Running;
        for t in transitions {
            phase = apply_transition(phase, t).expect("legal transition");
        }
        assert_eq!(phase, ShutdownPhase::Shutdown);
    }

    /// WHY (D-15 core invariant): Running → ApplyingSafeState skipping
    ///      Drain is STRUCTURALLY IMPOSSIBLE — no ShutdownTransition
    ///      variant exists for it. This test documents the invariant;
    ///      compile-time enforcement comes from the enum's closed set.
    #[test]
    fn drained_to_apply_safe_state_requires_drained_state_first() {
        // From Running, attempt to jump directly to the DrainedToApplying
        // SafeState transition. The current phase (Running) does not match
        // the transition's from_phase (Drained) → error.
        let err = apply_transition(
            ShutdownPhase::Running,
            ShutdownTransition::DrainedToApplyingSafeState,
        )
        .expect_err("skip must fail");
        assert_eq!(err.current_phase, ShutdownPhase::Running);
        assert_eq!(err.expected_from_phase(), ShutdownPhase::Drained);
        assert_eq!(
            err.attempted_transition,
            ShutdownTransition::DrainedToApplyingSafeState
        );
    }

    #[test]
    fn invalid_transition_from_wrong_phase_errors() {
        let err = apply_transition(
            ShutdownPhase::Flushing,
            ShutdownTransition::RunningToStoppingInbound,
        )
        .expect_err("wrong from");
        assert_eq!(err.current_phase, ShutdownPhase::Flushing);
        assert_eq!(err.expected_from_phase(), ShutdownPhase::Running);
        assert_eq!(
            err.attempted_transition,
            ShutdownTransition::RunningToStoppingInbound
        );
    }

    /// WHY: DrainState::is_drained reflects in_flight == 0.
    #[test]
    fn drain_state_is_drained_iff_in_flight_zero() {
        let anchor = MonotonicAnchor::for_test(1_000);
        let d = DrainState {
            in_flight: 0,
            drain_timeout_ms: 50,
            drain_started_at: anchor,
        };
        assert!(d.is_drained());
        let d = DrainState {
            in_flight: 1,
            drain_timeout_ms: 50,
            drain_started_at: anchor,
        };
        assert!(!d.is_drained());
        let d = DrainState {
            in_flight: 100,
            drain_timeout_ms: 50,
            drain_started_at: anchor,
        };
        assert!(!d.is_drained());
    }

    /// WHY (EDGE-MEDIUM-002 regression guard): DrainState::is_timed_out
    ///      computes elapsed from `drain_started_at` to `now`. Returns true
    ///      iff elapsed >= drain_timeout_ms.
    #[test]
    fn drain_state_is_timed_out_forward_elapsed() {
        let start = MonotonicAnchor::for_test(0);
        let d = DrainState {
            in_flight: 5,
            drain_timeout_ms: 50,
            drain_started_at: start,
        };
        // 10ms elapsed — not timed out.
        assert!(!d.is_timed_out(MonotonicAnchor::for_test(10_000_000)));
        // 49ms elapsed — not timed out (strict >=).
        assert!(!d.is_timed_out(MonotonicAnchor::for_test(49_000_000)));
        // 50ms elapsed — timed out (threshold).
        assert!(d.is_timed_out(MonotonicAnchor::for_test(50_000_000)));
        // 100ms elapsed — timed out.
        assert!(d.is_timed_out(MonotonicAnchor::for_test(100_000_000)));
    }

    /// WHY: Monotonic-clock anomaly (now < start) triggers fail-closed
    ///      force-cancel. Prevents the drain loop hanging on clock
    ///      glitches.
    #[test]
    fn drain_state_is_timed_out_fail_closed_on_clock_backward() {
        let start = MonotonicAnchor::for_test(100_000_000);
        let d = DrainState {
            in_flight: 5,
            drain_timeout_ms: 50,
            drain_started_at: start,
        };
        // now < start → MonotonicBackward error → fail-closed true.
        assert!(d.is_timed_out(MonotonicAnchor::for_test(50_000_000)));
    }

    /// WHY: Transition from_phase/to_phase roundtrip accessor integrity.
    #[test]
    fn transition_from_and_to_phase_correct() {
        let t = ShutdownTransition::DrainedToApplyingSafeState;
        assert_eq!(t.from_phase(), ShutdownPhase::Drained);
        assert_eq!(t.to_phase(), ShutdownPhase::ApplyingSafeState);
    }

    /// WHY (EDGE-LOW-001 closure): Error Display includes attempted
    ///      transition AND expected_from phase.
    #[test]
    fn transition_error_display_carries_phases_and_transition() {
        let err = ShutdownTransitionError {
            current_phase: ShutdownPhase::Running,
            attempted_transition: ShutdownTransition::DrainedToApplyingSafeState,
        };
        let s = format!("{}", err);
        assert!(s.contains("shutdown_transition_invalid"));
        assert!(s.contains("Running"));
        assert!(s.contains("Drained"));
        assert!(s.contains("DrainedToApplyingSafeState"));
    }

    #[test]
    fn transition_error_implements_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<ShutdownTransitionError>();
    }
}
