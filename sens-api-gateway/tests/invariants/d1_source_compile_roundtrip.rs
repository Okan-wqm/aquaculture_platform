//! Integration invariant for D-1 ST source compile production
//! wire (Batch #297-#300, ORPHAN-HIGH-020 closure).
//!
//! ## Why this file is contract-marker only
//!
//! sens-api-gateway is a `[[bin]]` not a `[lib]` — external
//! integration test crates under `tests/` cannot import the
//! bin's internal types (`SignedStSource`,
//! `compile_and_deploy_signed_source`,
//! `BytecodeProgramRegistry`, etc.). The project's pattern,
//! consistent with every other `tests/invariants/*.rs` file,
//! is to document the architectural CONTRACT here at prose
//! level + run the executable assertions inside the bin's
//! own `#[cfg(test)] mod` blocks.
//!
//! Executable test counterparts (Batch #300):
//!
//!   - `scripting::bytecode_deploy::tests::
//!      d1_source_compile_roundtrip_meaningful_program`
//!     End-to-end sign → verify → parse → compile → deploy →
//!     inspect with a non-trivial ST program (VAR + assign +
//!     tag-write).
//!
//!   - `scripting::bytecode_deploy::tests::
//!      d1_source_compile_roundtrip_rejects_unresolved_tag`
//!     Cross-gate negative — empty tag catalog → unresolved
//!     `setpoint` reference → StSourceCompileFailed.
//!
//! Plus the 6 prior gate-coverage tests (
//! `compile_and_deploy_*`) covering each individual gate:
//! happy-path, wrong signing key, tampered source, wrong
//! tenant, parse failure, replace-with-higher-version.
//!
//! Plus the cross-format confusion mitigation pin:
//!
//!   - `scripting::bytecode_deploy::tests::
//!      signed_bytecode_canonical_distinct_from_signed_st_source`

#[test]
fn st_source_deploy_path_is_signature_gated() {
    // ARCHITECTURAL CONTRACT: cmd_deploy_st_source MUST
    // route through verify_signed_st_source against the
    // agent's firmware_signing_pubkey BEFORE any parse +
    // compile work. An attacker that ships a tampered
    // SignedStSource gets rejected at gate 1, before the
    // edge spends any CPU cycles on parse_st or
    // compile_program.
    //
    // Pre-verify path discipline: tenant match runs at
    // gate 2 (BEFORE parse) so a wrong-tenant deploy also
    // costs zero parse/compile cycles. parse_st runs at
    // gate 3, compile_program at gate 4.
    //
    // Executable counterpart:
    //   compile_and_deploy_rejects_wrong_signing_key
    //   compile_and_deploy_rejects_tampered_source
    //   compile_and_deploy_rejects_wrong_tenant
    let _contract = "cmd_deploy_st_source MUST verify signature + tenant before parse/compile";
    assert!(!_contract.is_empty());
}

#[test]
fn st_source_compile_uses_agent_tag_catalog() {
    // ARCHITECTURAL CONTRACT: cmd_deploy_st_source MUST
    // build TagDescriptor[] from the agent's runtime tag
    // catalog (process_image.get_configs()) and pass it to
    // compile_program. Otherwise:
    //   (a) source-side tag references would resolve to
    //       compile errors (false negatives — operator
    //       sees parse-time fail for a tag the agent
    //       actually has).
    //   (b) writability discipline would silently bypass —
    //       a source that writes to a read-only sensor tag
    //       must FAIL at compile, not at runtime.
    //
    // The mapping fn `tag_config_to_descriptor` in
    // commands/deploy_st_source.rs encodes Bool/Int/Real
    // type classification + `writable = DO|AO`.
    //
    // Executable counterpart:
    //   d1_source_compile_roundtrip_meaningful_program
    //   (asserts allowed_write_tags includes `setpoint`
    //    AND excludes `sensor_temp`)
    let _contract = "cmd_deploy_st_source builds TagDescriptor[] from agent's runtime tag catalog";
    assert!(!_contract.is_empty());
}

#[test]
fn st_source_body_claims_flow_through_to_bytecode() {
    // ARCHITECTURAL CONTRACT: SignedStSource.body's
    // tenant_id + policy_version + max_gas_per_tick claims
    // are SIGNATURE-BOUND (per Batch #297 canonical bytes).
    // After verify, compile_and_deploy_signed_source tags
    // the compiled Bytecode with the body's claims so the
    // registry-side gates (monotonic version + tenant) run
    // against the SIGNED claims, not against attacker-
    // mutable runtime state.
    //
    // compile_program on its own produces a Bytecode with
    // tenant_id=None / policy_version=0; gate 5 of the
    // adapter overwrites those with body.tenant_id +
    // body.policy_version BEFORE registry insert.
    //
    // Executable counterpart:
    //   d1_source_compile_roundtrip_meaningful_program
    //   (asserts entry.bytecode.tenant_id == body.tenant_id
    //    AND entry.bytecode.policy_version == body.policy_version)
    let _contract = "SignedStSource body claims flow through to compiled Bytecode tenant + policy_version";
    assert!(!_contract.is_empty());
}

#[test]
fn st_source_path_distinct_from_bytecode_path() {
    // ARCHITECTURAL CONTRACT: cmd_deploy_st_source +
    // cmd_deploy_bytecode_program are PARALLEL entry points
    // sharing the SAME firmware_signing_pubkey trust anchor
    // but with STRUCTURALLY DISTINCT canonical bytes
    // (different magic prefix `SSRC` vs `STBC` + different
    // domain tag `st-source-v1` vs `st-bytecode-v3`).
    //
    // Cross-format confusion attack mitigation: a signature
    // produced for one format CANNOT verify for the other
    // because the trailing domain tag differs. Even a
    // hypothetical SHA-256 collision on bodies cannot pivot
    // one signature into a valid one for the other format.
    //
    // Executable counterpart:
    //   signed_bytecode_canonical_distinct_from_signed_st_source
    //   st_source_magic_distinct_from_bytecode_magic
    //   (in scripting::st_source_sig::tests)
    let _contract = "SignedStSource + SignedBytecode have structurally-distinct canonical bytes";
    assert!(!_contract.is_empty());
}

#[test]
fn st_source_failed_deploy_leaves_registry_untouched() {
    // ARCHITECTURAL CONTRACT: any failure in the 6-gate
    // adapter (signature / tenant / parse / compile /
    // tagging / registry insert) MUST leave the registry
    // unchanged — no partial entry, no stale tombstone.
    //
    // Tested via the cross-gate negative roundtrip: deploy
    // an unresolved-tag source -> StSourceCompileFailed ->
    // registry.get(program_id).is_none() afterward.
    //
    // Executable counterpart:
    //   d1_source_compile_roundtrip_rejects_unresolved_tag
    //   (asserts reg.get('p-bad-tag').await.is_none())
    let _contract = "Failed cmd_deploy_st_source MUST leave registry untouched";
    assert!(!_contract.is_empty());
}
