//! Phase B-1 — OPC UA PKI lifecycle closure invariant.
//!
//! ## Why this file exists
//!
//! Phase B-1 (Plan §B-1, Batches #266-#268) replaces async-opcua 0.18's
//! `ServerBuilder::trust_client_certs(true)` Trust-On-First-Use blob with
//! a fingerprint-pinned, rotation-aware, audit-anchored PKI store. The
//! architectural foundation lives across three files:
//!
//! - `src/opc_ua_server/pki_store.rs` — filesystem + signed ledger primitive
//! - `src/opc_ua_server/cert_rotation.rs` — 3-phase rollout state machine
//! - `src/opc_ua_server_runtime.rs::build_server` — `ServerBuilder` wire
//!
//! These three wires are tightly coupled. A future refactor that
//! "simplifies" the PkiStore wrapper, removes the CertRotation downgrade
//! gate, or hardcodes `trust_client_certs(true)` again would compile + pass
//! higher-level tests but silently regress the StrictPinOnly architectural
//! floor.
//!
//! THIS FILE is the Tier-3 MAKE-IT-DETECTABLE seam. It pins the
//! source-level shape of every Phase B-1 wire so a regression surfaces
//! deterministically on the same PR that introduced it.
//!
//! Pattern mirrors `tests/invariants/d4_d6_mtls_unified.rs` (Phase 1.1.5)
//! and `tests/invariants/cipher_allowlist_fleet_compat.rs` (Phase 0.4).
//!
//! See `docs/adr/031-opc-ua-pki-lifecycle.md` for the architectural
//! decision record.

fn read_source(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "BUG: opc_ua_leaf_pin_enforced invariant cannot read {path} — \
             this test runs from sens-api-gateway/ working dir per cargo \
             test convention. err={e}"
        )
    })
}

/// **Phase B-1 / Batch #266 (PkiStore primitive presence):** the
/// `PkiStore` struct + its constructor MUST exist. A regression that
/// removes the primitive collapses every downstream wire — the
/// CertRotation has nothing to read; build_server has no PKI root
/// source.
#[test]
fn b1_pki_store_struct_present() {
    let src = read_source("src/opc_ua_server/pki_store.rs");
    assert!(
        src.contains("pub struct PkiStore"),
        "B-1 / ULTRA-B-1 WIRE INVARIANT VIOLATED: \
         src/opc_ua_server/pki_store.rs does not define `pub struct PkiStore`. \
         The store is the SSoT for trusted/revoked fingerprint state — \
         without it, the OPC UA cert-pinning pipeline has no foundation."
    );
    assert!(
        src.contains("pub fn open_or_initialize("),
        "B-1 / ULTRA-B-1 WIRE INVARIANT VIOLATED: \
         src/opc_ua_server/pki_store.rs does not define `open_or_initialize` \
         constructor. The first-boot init + ledger reload contract has no \
         entry point."
    );
    assert!(
        src.contains("pub fn add_trusted_cert(") && src.contains("pub fn revoke_cert("),
        "B-1 / ULTRA-B-1 WIRE INVARIANT VIOLATED: \
         src/opc_ua_server/pki_store.rs does not expose `add_trusted_cert` + \
         `revoke_cert` mutators. The operator-driven trust-set rotation \
         has no API surface."
    );
}

/// **Phase B-1 / Batch #266 (revoked-fingerprint architectural floor):**
/// the PkiStore must enforce that a previously-revoked fingerprint
/// cannot be re-added. ADR-031 §1 architectural contract — re-adding a
/// known-bad cert is forever-banned.
#[test]
fn b1_revoked_fingerprint_re_add_blocked() {
    let src = read_source("src/opc_ua_server/pki_store.rs");
    assert!(
        src.contains("FingerprintWasRevoked"),
        "B-1 / ULTRA-B-1 ARCHITECTURAL FLOOR INVARIANT VIOLATED: \
         src/opc_ua_server/pki_store.rs does not define the \
         `FingerprintWasRevoked` error variant. Re-adding a revoked \
         fingerprint is the architectural forever-ban floor; without \
         the variant the gate cannot be enforced."
    );
}

/// **Phase B-1 / Batch #267 (3-phase rollout state machine):** the
/// `OpcUaPkiMode` enum MUST declare all three variants. A regression
/// that removes a variant collapses the staged-rollout discipline —
/// operators would have to choose between binary on/off pinning.
#[test]
fn b1_three_phase_mode_variants_present() {
    let src = read_source("src/opc_ua_server/cert_rotation.rs");
    assert!(
        src.contains("LegacyAccept")
            && src.contains("WarnOnMismatch")
            && src.contains("StrictPinOnly"),
        "B-1 / ULTRA-B-1 WIRE INVARIANT VIOLATED: \
         src/opc_ua_server/cert_rotation.rs does not define the \
         3-phase OpcUaPkiMode variants (LegacyAccept / WarnOnMismatch / \
         StrictPinOnly). The rollout state machine is missing one or \
         more phases."
    );
}

/// **Phase B-1 / Batch #267 (Tier-1 downgrade gate):** the
/// `transition_to` method MUST reject downgrades architecturally.
/// Mirrors the `MtlsVerifierState::rebuild` Tier-1 gate (PR #227 commit
/// a2242f36) — even an authenticated operator cannot silently roll the
/// fleet back to a permissive mode.
#[test]
fn b1_downgrade_gate_present() {
    let src = read_source("src/opc_ua_server/cert_rotation.rs");
    assert!(
        src.contains("DowngradeRejected"),
        "B-1 / ULTRA-B-1 TIER-1 DOWNGRADE GATE INVARIANT VIOLATED: \
         src/opc_ua_server/cert_rotation.rs does not define the \
         `DowngradeRejected` error variant. The architectural floor \
         that prevents Strict→Warn / Strict→Legacy / Warn→Legacy is \
         the load-bearing security primitive of the rollout state \
         machine."
    );
    assert!(
        src.contains("strictness()"),
        "B-1 / ULTRA-B-1 TIER-1 DOWNGRADE GATE INVARIANT VIOLATED: \
         src/opc_ua_server/cert_rotation.rs does not expose the \
         `strictness()` rank method. The downgrade comparison \
         (`new.strictness() < cur.strictness()`) is the architectural \
         shape; renaming the method without updating this invariant is \
         a breaking change."
    );
}

/// **Phase B-1 / Batch #267 (Strict + empty pin set gate):** transition
/// to `StrictPinOnly` with zero trusted fingerprints MUST be rejected.
/// A pin-set-emptying Strict transition would lock out every HMI —
/// fleet-stranding misconfig.
#[test]
fn b1_strict_with_empty_pin_set_gate_present() {
    let src = read_source("src/opc_ua_server/cert_rotation.rs");
    assert!(
        src.contains("StrictWithEmptyPinSet"),
        "B-1 / ULTRA-B-1 EMPTY-PIN-SET GATE INVARIANT VIOLATED: \
         src/opc_ua_server/cert_rotation.rs does not define the \
         `StrictWithEmptyPinSet` error variant. The gate that prevents \
         every-HMI-locks-out misconfig is missing."
    );
}

/// **Phase B-1 / Batch #268 (build_server PkiRuntimeRef wire):** the
/// `build_server` function MUST accept a `pki_runtime: Option<PkiRuntimeRef<'_>>`
/// parameter + use the `mode.trust_unpinned_clients()` flag to drive
/// `trust_client_certs(...)`. A regression that hardcodes
/// `trust_client_certs(true)` again would silently restore the pre-B-1
/// TOFU behavior.
#[test]
fn b1_build_server_consumes_pki_runtime_ref() {
    let src = read_source("src/opc_ua_server_runtime.rs");
    assert!(
        src.contains("pub struct PkiRuntimeRef"),
        "B-1 / ULTRA-B-1 SERVER WIRE INVARIANT VIOLATED: \
         src/opc_ua_server_runtime.rs does not define `pub struct \
         PkiRuntimeRef`. The bridge type between PkiStore + CertRotation \
         and the ServerBuilder wire is missing."
    );
    assert!(
        src.contains("pki_runtime: Option<PkiRuntimeRef<'_>>"),
        "B-1 / ULTRA-B-1 SERVER WIRE INVARIANT VIOLATED: \
         src/opc_ua_server_runtime.rs `build_server` does not accept the \
         `pki_runtime: Option<PkiRuntimeRef<'_>>` parameter. The architectural \
         channel from CertRotation to async-opcua's `trust_client_certs` \
         flag has no in-flight handle."
    );
    assert!(
        src.contains("trust_unpinned_clients()"),
        "B-1 / ULTRA-B-1 SERVER WIRE INVARIANT VIOLATED: \
         src/opc_ua_server_runtime.rs does not call \
         `OpcUaPkiMode::trust_unpinned_clients()`. The `trust_client_certs(...)` \
         flag must be derived from the active rollout mode — hardcoding \
         it to `true` re-introduces pre-B-1 TOFU."
    );
    assert!(
        src.contains(".trust_client_certs(trust_unpinned)"),
        "B-1 / ULTRA-B-1 SERVER WIRE INVARIANT VIOLATED: \
         src/opc_ua_server_runtime.rs does not feed the resolved \
         `trust_unpinned` boolean into `ServerBuilder::trust_client_certs(...)`. \
         The wire from PkiRuntimeRef to async-opcua is broken."
    );
}

/// **Phase B-1 / Batch #268 (init_opc_ua_server constructs PkiStore):**
/// the production boot path MUST construct PkiStore + CertRotation +
/// pass them to build_server via PkiRuntimeRef. A regression that
/// passes `None` from production would silently fall back to the
/// legacy wire.
#[test]
fn b1_init_opc_ua_server_wires_pki_runtime() {
    let src = read_source("src/opc_ua_server_runtime.rs");
    assert!(
        src.contains("PkiStore::open_or_initialize"),
        "B-1 / ULTRA-B-1 BOOT WIRE INVARIANT VIOLATED: \
         src/opc_ua_server_runtime.rs init path does not call \
         `PkiStore::open_or_initialize`. The PkiStore primitive is not \
         being constructed at boot; build_server would receive None and \
         fall back to legacy TOFU."
    );
    assert!(
        src.contains("CertRotation::new"),
        "B-1 / ULTRA-B-1 BOOT WIRE INVARIANT VIOLATED: \
         src/opc_ua_server_runtime.rs init path does not call \
         `CertRotation::new`. The 3-phase rollout state has no \
         in-process handle, defaulting the production path back to the \
         legacy wire."
    );
    assert!(
        src.contains("Some(pki_runtime)"),
        "B-1 / ULTRA-B-1 BOOT WIRE INVARIANT VIOLATED: \
         src/opc_ua_server_runtime.rs production callsite does not pass \
         `Some(pki_runtime)` into build_server. The boot path silently \
         falls through to the legacy `None` arm."
    );
}

/// **Phase B-1 / Batch #266-#268 (submodule declaration):** the
/// `pki_store` and `cert_rotation` submodules MUST be declared inside
/// `opc_ua_server.rs` so Rust resolves them to `src/opc_ua_server/<name>.rs`.
/// A regression that removes the declarations orphans the new files
/// (compile-time absent from the binary).
#[test]
fn b1_submodules_declared_in_opc_ua_server() {
    let src = read_source("src/opc_ua_server.rs");
    assert!(
        src.contains("pub mod pki_store;"),
        "B-1 / ULTRA-B-1 SUBMODULE WIRE INVARIANT VIOLATED: \
         src/opc_ua_server.rs does not declare `pub mod pki_store;`. \
         The pki_store.rs file is orphaned — compile-time absent from \
         the binary, never executes."
    );
    assert!(
        src.contains("pub mod cert_rotation;"),
        "B-1 / ULTRA-B-1 SUBMODULE WIRE INVARIANT VIOLATED: \
         src/opc_ua_server.rs does not declare `pub mod cert_rotation;`. \
         The cert_rotation.rs file is orphaned."
    );
}

/// **Phase B-1 / ADR-031 anchor:** the architectural decision record
/// MUST exist + cite the plan-intended ID (ADR-024 is taken twice; we
/// renumbered to 031). An audit reader following the plan reference
/// "ADR-024" must reach this ADR via the cross-reference.
#[test]
fn b1_adr_031_present_with_plan_id_cross_reference() {
    let src = read_source("../docs/adr/031-opc-ua-pki-lifecycle.md");
    assert!(
        src.contains("OPC UA PKI Lifecycle"),
        "B-1 / ULTRA-B-1 ADR INVARIANT VIOLATED: \
         docs/adr/031-opc-ua-pki-lifecycle.md does not carry the \
         expected title. The plan-doc cross-reference relies on the \
         title for human navigation."
    );
    assert!(
        src.contains("Plan-intended ID:"),
        "B-1 / ULTRA-B-1 ADR INVARIANT VIOLATED: \
         docs/adr/031-opc-ua-pki-lifecycle.md does not document the \
         plan-intended ID renumbering (plan said ADR-024, actual is \
         ADR-031 because 024 was already taken twice)."
    );
}
