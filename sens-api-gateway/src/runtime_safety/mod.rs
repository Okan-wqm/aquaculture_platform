//! # Runtime safety primitives — clock authority + retained-msg guard +
//! # shutdown race (plan D-7, D-14, D-15)
//!
//! Three small but architecturally-critical runtime contracts that Faz 2
//! Sprint 6.7 wires into the MQTT / command dispatcher / shutdown
//! coordinator. Pure types + function signatures here; runtime impls are
//! closure-injected in the Sprint 6.7 supervisor.
//!
//! ## Contents
//!
//! - [`clock`] — `ClockAuthority` trait + `MonotonicAnchor` + wall-clock
//!   skew guard. Prevents a compromised wall clock from corrupting audit
//!   timestamps or bypassing freshness windows (plan D-7 NTS-authenticated
//!   clock discipline).
//! - [`retained_msg`] — `RetainedMsgRejectionReason` + predicate for MQTT
//!   retained-message guard. Retained mutating commands are a replay vector
//!   (plan D-14 ADR-020 §4 retained-msg poisoning defense).
//! - [`shutdown_phase`] — `ShutdownPhase` enum + `DrainState` machine.
//!   Enforces drain-before-safe-state so in-flight commands complete
//!   cleanly before actuators fall to fail-safe values (plan D-15
//!   shutdown-race fix).
//!
//! ## Cross-module references
//!
//! - ADR-020 §4 MQTT retained-message poisoning defense
//! - Plan D-7 Clock authority (chrony + NTS + CLOCK_MONOTONIC for TTLs)
//! - Plan D-14 Broker ACL rule + edge-side retained rejection
//! - Plan D-15 Drain-before-safe-state shutdown ordering

pub mod clock;
pub mod retained_msg;
pub mod shutdown_phase;

pub use clock::{ClockAuthority, ClockError, MonotonicAnchor, WallClockReading};
pub use retained_msg::{is_retained_command_rejected, RetainedMsgRejectionReason};
pub use shutdown_phase::{
    DrainState, ShutdownPhase, ShutdownTransition, ShutdownTransitionError,
};
