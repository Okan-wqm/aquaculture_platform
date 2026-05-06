//! Faz 2 D-6 mTLS unified assembly wire-status invariants
//! (Batch #328 — closes UH-020).
//!
//! ## Why this file
//!
//! Plan §5 Faz 2 D-6 mandates that the mTLS construction
//! logic — combining `MtlsMode` + `CertRotationStage` +
//! `LeafCertFingerprint` pins + the rustls
//! `ServerCertVerifier` integration — lives in ONE
//! unified assembly point rather than scattered across
//! consumer modules. The architectural answer is
//! `mtls::build_suderra_verifier`:
//!
//! ```text
//!     build_suderra_verifier(mode, sigalgs, pins_hex, root_store)
//!         → Result<Option<Arc<SuderraServerCertVerifier>>, SuderraVerifierBuildError>
//! ```
//!
//! ### Wiring decision matrix (canonical from doc + impl):
//!
//! | mode    | pins | result                                  |
//! |---------|------|-----------------------------------------|
//! | Legacy  | 0    | Ok(None) — no wire                      |
//! | Legacy  | 1+   | Ok(Some) — log-only pinning             |
//! | Warn    | 0    | Ok(Some) — sentinel "accept-nothing"    |
//! | Warn    | 1+   | Ok(Some) — audit-emit on mismatch       |
//! | Strict  | 0    | Err(StrictModeRequiresPins) — FAIL-CLOSED |
//! | Strict  | 1+   | Ok(Some) — reject on mismatch           |
//!
//! ## What this file pins
//!
//! Tier-3 detection seams that catch refactor regressions:
//!
//!   1. The `build_suderra_verifier` SSoT exists with
//!      the documented signature.
//!   2. The fail-closed gate
//!      `SuderraVerifierBuildError::StrictModeRequiresPins`
//!      variant exists — without this variant the
//!      Strict-mode-with-empty-pins config silently
//!      accepts every cert.
//!   3. mqtt.rs (the production consumer) uses
//!      `build_suderra_verifier` — a refactor that
//!      constructs SuderraServerCertVerifier manually
//!      bypasses the wiring decision matrix.
//!   4. The mtls module re-exports the unified entry
//!      so consumers don't need to know the internal
//!      crate path.
//!
//! ## What this file does NOT pin
//!
//! - The pure-function 8-gate verify logic in
//!   `verify::verify_leaf_cert` (covered by the
//!   in-tree behavioural unit tests in mtls/verify.rs).
//! - The 3-stage rollout state machine in
//!   `mode::MtlsMode` (covered by mode.rs::tests).
//! - The Strict mode + custom-CA-path incompatibility
//!   (mqtt.rs warn-log path; tested behaviourally
//!   elsewhere).

fn read_source(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "BUG: mtls_unified_assembly invariant cannot read {} — \
             this test runs from sens-api-gateway/ working dir per \
             cargo test convention. err={}",
            path, e
        )
    })
}

const MTLS_MOD_RS: &str = "src/mtls/mod.rs";
const RUSTLS_VERIFIER_RS: &str = "src/mtls/rustls_verifier.rs";
const MQTT_RS: &str = "src/mqtt.rs";

/// **D-6 wire-status invariant 1:** `build_suderra_verifier`
/// MUST exist as a `pub fn` in `mtls/rustls_verifier.rs`
/// + take the documented signature shape (mode +
/// signature_algorithms + pins_hex slice + root_store).
///
/// **Why this matters:** the function is the architectural
/// SSoT for verifier assembly. A refactor that splits
/// the assembly into per-mode helper functions OR removes
/// the `Result<Option<...>>` shape (e.g., always-Some)
/// silently changes the wiring decision matrix without
/// updating the documented contract.
#[test]
fn d6_build_suderra_verifier_unified_entry_present() {
    let src = read_source(RUSTLS_VERIFIER_RS);
    assert!(
        src.contains("pub fn build_suderra_verifier"),
        "D-6 WIRE INVARIANT VIOLATED: {} does not define \
         `pub fn build_suderra_verifier`. The unified \
         assembly SSoT for the mTLS verifier construction \
         is missing; consumers (mqtt.rs + future HTTPS \
         outbound paths) would have to roll their own \
         verifier wiring + duplicate the wiring decision \
         matrix. Restore the function or document the \
         rename + update this invariant.",
        RUSTLS_VERIFIER_RS
    );
    // The signature MUST take all 4 architectural inputs.
    // Each one is part of the wiring decision matrix:
    //   - mode (which-tier-of-3-stage-rollout)
    //   - signature_algorithms (which-cipher-allowlist)
    //   - pins_hex (which-fingerprint-set)
    //   - root_store (which-CA-anchor)
    for input in &[
        "mode: MtlsMode",
        "signature_algorithms: WebPkiSupportedAlgorithms",
        "pins_hex: &[String]",
        "root_store: Arc<rustls::RootCertStore>",
    ] {
        assert!(
            src.contains(input),
            "D-6 WIRE INVARIANT VIOLATED: build_suderra_verifier \
             signature lost the `{}` parameter. The 4 inputs \
             are the architectural assembly axes; dropping any \
             of them either bypasses a wiring-matrix arm or \
             forces the caller to inject the missing piece \
             out-of-band (defeating the unified-assembly goal).",
            input
        );
    }
    // The return shape MUST be Result<Option<Arc<...>>, ...>
    // — the Option None is the Legacy+0pins arm; Err is the
    // Strict+0pins fail-closed arm.
    assert!(
        src.contains(
            "Result<Option<Arc<SuderraServerCertVerifier>>, SuderraVerifierBuildError>"
        ),
        "D-6 WIRE INVARIANT VIOLATED: build_suderra_verifier \
         return type changed. The `Option<Arc<_>>` shape \
         encodes the Legacy+0pins=no-wire arm; the `Result` \
         shape encodes the Strict+0pins fail-closed arm. \
         Collapsing to `Arc<_>` always-Some would silently \
         change the wiring decision matrix."
    );
}

/// **D-6 wire-status invariant 2:** the
/// `SuderraVerifierBuildError::StrictModeRequiresPins`
/// variant MUST exist — this is the fail-closed gate
/// that rejects a Strict-mode config with no pins
/// (otherwise the verifier would accept every cert that
/// passes basic chain validation, defeating the strict
/// pinning goal).
#[test]
fn d6_strict_mode_requires_pins_fail_closed_gate_present() {
    let src = read_source(RUSTLS_VERIFIER_RS);
    assert!(
        src.contains("StrictModeRequiresPins"),
        "D-6 WIRE INVARIANT VIOLATED: {} does not define \
         `SuderraVerifierBuildError::StrictModeRequiresPins`. \
         This is the architectural fail-closed gate that \
         catches the `mtls.mode = Strict` + `pins_hex = []` \
         operator-config error. Without this variant the \
         verifier would silently accept every cert that \
         passes basic chain validation — defeating the \
         pinning goal of Strict mode.",
        RUSTLS_VERIFIER_RS
    );
    // The gate MUST fire when (Strict, empty pins).
    assert!(
        src.contains("MtlsMode::Strict")
            && src.contains("pins_hex.is_empty"),
        "D-6 WIRE INVARIANT VIOLATED: build_suderra_verifier \
         no longer branches on `MtlsMode::Strict` + \
         `pins_hex.is_empty()` to fire the fail-closed gate. \
         A refactor that flattened the matrix branches into \
         a single arm would skip the Strict-mode-empty-pins \
         check; the gate fires only when both conditions \
         match."
    );
}

/// **D-6 wire-status invariant 3:** mqtt.rs (the
/// production TLS consumer) MUST call
/// `build_suderra_verifier` rather than constructing
/// SuderraServerCertVerifier manually.
///
/// **Why this matters:** a refactor that bypasses the
/// unified assembly point (e.g., calling
/// `SuderraServerCertVerifier::new(...)` directly with
/// per-callsite-handcrafted args) loses the wiring
/// decision matrix — the call site might assemble the
/// verifier in a way that violates one of the matrix
/// arms (e.g., construct a verifier in Strict mode with
/// no pins).
#[test]
fn d6_mqtt_consumer_uses_unified_build_entry() {
    let src = read_source(MQTT_RS);
    assert!(
        src.contains("crate::mtls::build_suderra_verifier"),
        "D-6 WIRE INVARIANT VIOLATED: {} no longer calls \
         `crate::mtls::build_suderra_verifier`. The mqtt \
         outbound TLS path is the canonical consumer of \
         the unified assembly; bypassing it (e.g., \
         constructing SuderraServerCertVerifier directly) \
         would lose the wiring decision matrix gates.",
        MQTT_RS
    );
}

/// **D-6 wire-status invariant 4:** the unified entry +
/// the error type MUST be re-exported from
/// `mtls::mod.rs` so consumers don't need to know the
/// internal `mtls::rustls_verifier` path. The re-export
/// is the architectural seam that decouples consumers
/// from internal module layout.
#[test]
fn d6_mtls_mod_re_exports_unified_entry() {
    let src = read_source(MTLS_MOD_RS);
    // build_suderra_verifier is re-exported (consumers
    // call mtls::build_suderra_verifier, not
    // mtls::rustls_verifier::build_suderra_verifier).
    assert!(
        src.contains("build_suderra_verifier"),
        "D-6 WIRE INVARIANT VIOLATED: {} does not re-export \
         `build_suderra_verifier`. Consumers would have to \
         depend on `crate::mtls::rustls_verifier::*` — that \
         couples them to the internal module layout. The \
         re-export is the architectural decoupling seam.",
        MTLS_MOD_RS
    );
    // SuderraServerCertVerifier itself is re-exported
    // for the rustls integration path (mqtt.rs needs the
    // type name to wire into ClientConfig::builder).
    assert!(
        src.contains("SuderraServerCertVerifier"),
        "D-6 WIRE INVARIANT VIOLATED: {} does not re-export \
         `SuderraServerCertVerifier`. The type is the \
         consumer-facing handle on the verifier; mqtt.rs \
         needs it to wire into rustls' \
         `with_custom_certificate_verifier`.",
        MTLS_MOD_RS
    );
}

/// **D-6 wire-status invariant 5:** the canonical wiring
/// decision matrix — the SIX arms (Legacy+0/1+, Warn+0/1+,
/// Strict+0/1+) — MUST appear as a documentation table
/// in build_suderra_verifier's doc comments. Operators
/// reading the function source see the matrix WITHOUT
/// having to grep multiple files; refactor that drops
/// the doc table breaks the operator-discoverability of
/// the architectural contract.
#[test]
fn d6_build_suderra_verifier_documents_wiring_matrix() {
    let src = read_source(RUSTLS_VERIFIER_RS);
    // The doc table uses `| mode | pins | result |`
    // markdown header. A refactor that drops the table
    // (e.g., splits into prose) loses the at-a-glance
    // wiring matrix.
    assert!(
        src.contains("| mode | pins | result |") || src.contains("| Legacy | 0 |"),
        "D-6 WIRE INVARIANT VIOLATED: build_suderra_verifier \
         doc comments no longer contain the canonical wiring \
         decision matrix table (markdown `| mode | pins | \
         result |` shape). Operators reading the function \
         source MUST see the 6-arm matrix at a glance; \
         dropping the table forces them to mentally reconstruct \
         it from the if-let arms."
    );
}
