// BATCH-001-CI-FIX-015: pre-staged types for Sprint 6.1-6.8 runtime wiring.
// Re-exports are intentionally unused until the runtime consumers land.
#![allow(unused_imports)]

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
// Batch 55 Sprint 6.7 partial — concrete SystemClockAuthority
// impl. Baseline production impl using Instant + SystemTime.
pub mod system_clock;
// Batch 89 Sprint 6.7 partial — ChronyNtsClockAuthority with
// real chronyc-tracking subprocess query for NTS sync age.
// Closes the stale-wall-clock replay vector that the pre-
// Sprint-6.7 SystemClockAuthority left open (always-trusting
// 0-age) per plan D-7 + IEC 62443 SL-2 FR4.
pub mod chrony_clock;

pub use chrony_clock::{CHRONY_QUERY_FAILED_AGE_SENTINEL, ChronyNtsClockAuthority};
pub use clock::{ClockAuthority, ClockError, MonotonicAnchor, WallClockReading};
pub use retained_msg::{is_retained_command_rejected, RetainedMsgRejectionReason};
pub use shutdown_phase::{
    DrainState, ShutdownPhase, ShutdownTransition, ShutdownTransitionError,
};
pub use system_clock::{SystemClockAuthority, DEFAULT_NTS_SYNC_MAX_SKEW_SECS};
pub use chrony_clock::{ChronyNtsClockAuthority, CHRONY_QUERY_FAILED_AGE_SENTINEL};
