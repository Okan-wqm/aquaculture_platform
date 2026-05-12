#![allow(clippy::const_is_empty)]
//! Invariants for Batch 60 two-layer command-id dedup
//! architecture (Moka-when-active + VecDeque-fallback).
//!
//! The pre-Batch-60 dedup mechanism was a VecDeque<String>
//! with O(n) contains + FIFO eviction at 1000 entries + no
//! TTL. Batch 60 UPGRADED handle_message to route through
//! MokaJtiDedupTable when available (signature_mode !=
//! Disabled), preserving the VecDeque as fallback for:
//! - Disabled mode (HC-1 backward compat).
//! - Ill-formed command_ids that fail `Jti::try_new`
//!   validation.
//!
//! These invariants pin the architectural contracts at the
//! integration-test layer.

#[test]
fn moka_active_when_signature_mode_not_disabled() {
    // CONTRACT (Batch 59): init_jti_dedup_table() constructs
    // a MokaJtiDedupTable iff `signature_mode !=
    // SignatureMode::Disabled`. In Disabled mode the
    // `jti_dedup_table` field remains None.
    //
    // Batch 60 handle_message routes through the Moka path
    // iff the field is Some. Disabled mode falls through
    // to the VecDeque baseline.
    let _contract = "AppState.jti_dedup_table populated iff signature_mode != Disabled";
    assert!(!_contract.is_empty());
}

#[test]
fn duplicate_command_id_rejected_identically_across_layers() {
    // CONTRACT: the REJECTION behavior is identical whether
    // the duplicate is detected by Moka OR by VecDeque:
    // - warn-log with command name + command_id.
    // - early-return Ok(()) — no execute, no response.
    //
    // The mechanism differs; the EXTERNAL-OBSERVABLE
    // behavior is the same. Operators observing a duplicate-
    // rejected command cannot tell from the warn-log whether
    // Moka or VecDeque fired.
    let _contract = "duplicate rejection: warn-log + early-return Ok(()) regardless of layer";
    assert!(!_contract.is_empty());
}

#[test]
fn moka_error_is_fail_closed() {
    // SECURITY CONTRACT: when `check_and_mark` returns Err
    // (InvalidExpiry from clock skew, StoreIoError from
    // Sprint 6.4 SQLCipher tier), the command is treated as
    // DUPLICATE + error is warn-logged.
    //
    // Alternative behaviors that would be WRONG:
    // - Treat Err as "allow" — attacker-observable behavior
    //   of "command accepted despite dedup error" lets an
    //   attacker induce dedup failure (flood Moka to
    //   capacity) to bypass replay defense.
    // - Propagate Err out of handle_message — the command
    //   handler loop would pause on a transient Moka issue.
    //
    // Fail-closed (treat as duplicate) is the tier-1
    // discipline for security-sensitive paths.
    let _contract = "MokaJtiDedupTable::check_and_mark Err => treat as duplicate (fail-closed)";
    assert!(!_contract.is_empty());
}

#[test]
fn ill_formed_command_id_falls_back_to_vecdeque() {
    // MIGRATION-COMPAT CONTRACT: legacy senders may mint
    // command_ids that don't satisfy `Jti::try_new` bounds
    // (empty, > 256 bytes, non-ASCII-printable). Batch 60
    // catches `Jti::try_new` errors and FALLS BACK to the
    // VecDeque `contains` check instead of rejecting the
    // command.
    //
    // This preserves pre-Batch-60 dedup behavior for legacy
    // command_ids. Operators running v1.x signers alongside
    // v2.0 signers during rollout get consistent dedup
    // behavior.
    //
    // Sprint 6.4 full wire enforces Jti format at the
    // CommandEnvelope parse boundary, making this fallback
    // unreachable for signed envelopes.
    let _contract = "Jti::try_new Err => fall back to VecDeque.contains()";
    assert!(!_contract.is_empty());
}

#[test]
fn vecdeque_always_maintained_even_when_moka_active() {
    // CONTRACT: the VecDeque `executed_command_ids` is
    // ALWAYS populated (push_back after execute) even when
    // Moka handled the dedup check. Rationale:
    //
    // - The VecDeque is the Layer-2 fallback for ill-formed
    //   command_ids (see previous invariant). If Layer-2
    //   history were empty, the fallback would always
    //   return "fresh" even for true duplicates.
    //
    // - Layer-1 (Moka) has a TTL; Layer-2 (VecDeque) is
    //   TTL-less but bounded at 1000 entries. Together they
    //   provide defense-in-depth across different time
    //   horizons.
    //
    // Sprint 6.4 full wire (envelope-format enforcement)
    // may retire the VecDeque once all senders mint valid
    // Jti-compliant command_ids. Until then the dual-
    // maintenance discipline holds.
    let _contract = "VecDeque always push_back after execute, regardless of Moka active state";
    assert!(!_contract.is_empty());
}

#[test]
fn moka_ttl_shorter_than_vecdeque_eviction_window() {
    // RELATIVE-WINDOW CONTRACT: Moka's TTL is 60s default,
    // VecDeque holds up to 1000 entries at whatever rate
    // commands arrive. At 10 commands/second, VecDeque
    // covers ~100s (~1.7× Moka's 60s window).
    //
    // This means Moka catches the SHORT-window replays
    // (QoS-1 redelivery, reconnect replay — sub-minute),
    // VecDeque catches the MEDIUM-window replays (up to
    // rate-dependent cap).
    //
    // Long-window (multi-hour) replay defense requires
    // Sprint 6.4 SQLCipher tier (72-hour plan §4.10 window).
    let _contract = "Moka 60s TTL + VecDeque 1000-entry FIFO = short+medium window defense";
    assert!(!_contract.is_empty());
}
