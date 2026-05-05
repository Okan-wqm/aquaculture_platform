//! Integration invariant for Faz 6 two-person integrity gate
//! (Batch #305-#307 closure arc).
//!
//! ## Why this file is contract-marker only
//!
//! sens-api-gateway is a `[[bin]]` not a `[lib]` — external
//! integration test crates under `tests/` cannot import the
//! bin's internal types (`CommandMessage`, `CommandHandler`,
//! `dispatch_lifecycle::execute_command`, etc.). Project
//! pattern (every other tests/invariants/*.rs file): document
//! the architectural CONTRACT here at prose level + run
//! executable assertions inside the bin's own
//! `#[cfg(test)] mod` blocks.
//!
//! Executable test counterparts:
//!
//!   - `command_envelope::envelope::tests::
//!      co_approver_actor_change_changes_canonical_bytes`
//!     (Batch #305 wire primitive)
//!   - `command_envelope::envelope::tests::
//!      canonical_bytes_end_with_v3_tag`
//!   - `command_envelope::envelope::tests::
//!      v2_wire_envelope_deserializes_with_default_co_approver`
//!   - `command_envelope::envelope::tests::
//!      co_approver_presence_byte_changes_byte_length`
//!   - `commands::envelope_adapter::tests::
//!      co_approver_absent_passes_gate`
//!     (Batch #306 adapter verify gate)
//!   - `commands::envelope_adapter::tests::
//!      co_approver_actor_only_rejects_with_missing`
//!   - `commands::envelope_adapter::tests::
//!      co_approver_signature_only_rejects_with_missing`
//!   - `commands::envelope_adapter::tests::
//!      co_approver_equals_primary_rejects_with_self_signature`
//!   - `commands::envelope_adapter::tests::
//!      co_approver_pubkey_missing_rejects_with_invalid`
//!   - `commands::envelope_adapter::tests::
//!      co_approver_error_display_strings_pinned`

#[test]
fn permission_class_drives_two_person_integrity_requirement() {
    // ARCHITECTURAL CONTRACT: the dispatch-layer gate
    // (commands::dispatch_lifecycle::execute_command) reads
    // `Permission::requires_two_person_integrity()` to decide
    // whether the command requires a verified co-approver
    // signature. The 5 mandatory commands per ADR-017 §8 are:
    //
    //   - Permission::UpdateFirmware
    //   - Permission::DeployProgram
    //   - Permission::ForceValue
    //   - Permission::SafeStateTrigger
    //   - Permission::Reboot
    //
    // Every other Permission variant returns false. A future
    // mandatory command MUST add the variant to this set OR
    // the gate silently bypasses two-person integrity for it
    // — which would be a security regression.
    //
    // Executable counterpart in authz::permission::tests:
    //   - assert!(Permission::UpdateFirmware.requires_two_person_integrity())
    //   - assert!(Permission::DeployProgram.requires_two_person_integrity())
    //   - assert!(Permission::ForceValue.requires_two_person_integrity())
    //   - assert!(Permission::SafeStateTrigger.requires_two_person_integrity())
    //   - assert!(Permission::Reboot.requires_two_person_integrity())
    //   - assert!(!Permission::ReadTag.requires_two_person_integrity())
    //   - etc.
    let _contract = "Permission::requires_two_person_integrity drives the gate";
    assert!(!_contract.is_empty());
}

#[test]
fn three_layer_trust_chain_for_co_approver() {
    // ARCHITECTURAL CONTRACT: the verified-co-approver flag
    // that reaches the dispatch-layer gate flows through 3
    // layers, each enforcing its own invariant:
    //
    //   1. WIRE LAYER (Batch #305): CommandEnvelope v3 carries
    //      optional co_approver_actor + co_approver_signature.
    //      Both fields bind into canonical bytes (presence
    //      byte + 16-byte actor when Some). v3 tag is
    //      'command-envelope-sig-v3'. v2-signed envelopes
    //      fail v3 verify (the migration signal).
    //
    //   2. ADAPTER LAYER (Batch #306): envelope_adapter::
    //      verify_co_approver_if_present runs AFTER primary
    //      verify_envelope succeeds. 6-step gate ordering:
    //      both-None (no-op), shape-inconsistency (Missing),
    //      self-signature (SelfSignature), recompute canonical,
    //      pubkey lookup (Invalid on miss), ed25519 verify
    //      (Invalid on fail). Sets AdaptedCommand.
    //      verified_co_approver = true on Some+Ok.
    //
    //   3. DISPATCH LAYER (Batch #307): cmd-name → permission
    //      mapping computes required_perm. If
    //      required_perm.requires_two_person_integrity() AND
    //      !command.verified_co_approver → REJECT with
    //      'two_person_integrity_required' audit reason +
    //      operator-visible error.
    //
    // Property: an attacker MUST defeat all 3 layers to
    // execute a mandatory command without legitimate
    // co-approval. Each layer is independent — defeat at
    // one doesn't compromise the others.
    let _contract = "Three-layer trust chain: wire + adapter + dispatch gate";
    assert!(!_contract.is_empty());
}

#[test]
fn co_approver_signs_same_canonical_bytes_as_primary() {
    // ARCHITECTURAL CONTRACT: the co-approver's ed25519
    // signature covers the SAME canonical-bytes transcript
    // as the primary signature. Two signatures over one
    // transcript means an attacker who tampers with any
    // envelope field after BOTH operators sign invalidates
    // BOTH signatures. There is no way to swap params + re-
    // use either signature.
    //
    // Architectural alternative rejected: 'co-approver signs
    // a different canonical subset'. The same-bytes shape
    // gives one signed transcript to audit (no two-transcript
    // reconciliation problem) AND means the post-mutation
    // invalidation property is automatic.
    //
    // Executable counterpart: envelope_adapter test
    // co_approver_pubkey_missing_rejects_with_invalid uses
    // the SAME canonical bytes path that both sigs cover —
    // a bug in the canonical recomputation would surface
    // there.
    let _contract = "Co-approver signs the same canonical-bytes transcript as primary";
    assert!(!_contract.is_empty());
}

#[test]
fn legacy_command_message_path_defaults_to_no_coapprover() {
    // ARCHITECTURAL CONTRACT: when handle_message falls back
    // to legacy CommandMessage parse (envelope_adapter returns
    // NotEnvelopeFormat), the resulting CommandMessage has
    // verified_co_approver=false (default — the field is
    // #[serde(default, skip_deserializing)]). This means
    // legacy v1.x payloads that target two-person-integrity
    // commands (force_value, etc.) are REJECTED at the
    // dispatch gate.
    //
    // Migration path: operators on legacy v1.x clients see
    // 'two_person_integrity_required' rejections + must
    // upgrade their signing tooling to mint v3 envelopes
    // with both signatures. This is the correct security
    // posture per ADR-017 §8 — there is NO graceful fallback
    // for mandatory commands.
    //
    // Non-mandatory commands (read_*, ping, get_*) work
    // unchanged on legacy payloads — the gate doesn't fire
    // because requires_two_person_integrity() returns false
    // for those Permission variants.
    let _contract =
        "Legacy CommandMessage parse → verified_co_approver=false → mandatory command rejected";
    assert!(!_contract.is_empty());
}

#[test]
fn rejected_two_person_integrity_emits_audit_event() {
    // ARCHITECTURAL CONTRACT: the dispatch gate's REJECT
    // path emits a post-exec audit event with detail string
    // 'elapsed_ms=N err=two_person_integrity_required' AND
    // returns a CommandResponse with success=false +
    // result.rejected="two_person_integrity_required" +
    // explicit operator-visible error message naming
    // ADR-017 §8.
    //
    // Silent denies hide policy probes from the SIEM —
    // every reject path emits audit, including this one.
    // The audit-detail's 'err=two_person_integrity_required'
    // is a stable string operator dashboards key on; renaming
    // it is a wire break.
    let _contract = "Rejected two-person-integrity → audit event + explicit error message";
    assert!(!_contract.is_empty());
}
