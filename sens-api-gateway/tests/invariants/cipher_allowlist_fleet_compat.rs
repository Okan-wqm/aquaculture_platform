//! Phase 0.4 — Cipher allowlist deployment-shape regression test.
//!
//! ## Why this file exists
//!
//! The Suderra cipher allowlist (`CIPHER_SUITE_ALLOWLIST` in
//! `src/mtls/cipher.rs`) is the SL-2 baseline policy that pins handshakes
//! to exactly three TLS 1.3 suites:
//! - `TLS_CHACHA20_POLY1305_SHA256` (IANA `0x1303`)
//! - `TLS_AES_256_GCM_SHA384` (IANA `0x1302`)
//! - `TLS_AES_128_GCM_SHA256` (IANA `0x1301`) — RFC 8446 §9.1 mandatory
//!
//! Two failure modes are operationally lethal:
//!
//! 1. **Allowlist shrinks below RFC 8446 §9.1 mandatory.** A future PR that
//!    drops `TLS_AES_128_GCM_SHA256` to "harden" the allowlist would
//!    break interop with any TLS 1.3 implementation that conforms to
//!    only the mandatory-to-implement set.
//!
//! 2. **Allowlist is bypassed.** A future refactor that switches mqtt.rs
//!    back to `ClientConfig::builder()` without provider would reintroduce
//!    every TLS 1.2 cipher in `rustls::crypto::ring::default_provider()`,
//!    silently undoing Phase 0.2.
//!
//! These invariants are Tier-3 MAKE-IT-DETECTABLE seams: the unit tests
//! in `src/mtls/crypto_provider.rs::tests` exercise the runtime behavior;
//! THIS file pins the *source-level* contract so a refactor that drifts
//! from the discipline fails on the same PR.
//!
//! Pattern mirrors `tests/invariants/faz1_architectural_primitives.rs`
//! and `tests/invariants/d1_source_compile_roundtrip.rs` (Batch #321 +
//! #300 detector convention).

fn read_source(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "BUG: cipher_allowlist_fleet_compat invariant cannot read {path} — \
             this test runs from sens-api-gateway/ working dir per cargo \
             test convention. err={e}"
        )
    })
}

/// **ORPHAN-MTLS-005 (Phase 0 deployment-shape):** the allowlist source
/// must contain *exactly* the three plan-mandated TLS 1.3 IANA codepoints
/// — no more, no fewer. A refactor that drops one (e.g., to "improve
/// security" by removing AES_128_GCM) would break interop with RFC-only
/// peers; a refactor that adds a TLS 1.2 ECDHE suite would defeat the
/// SL-2 downgrade-prevention baseline.
#[test]
fn allowlist_contains_exactly_three_tls13_codepoints() {
    let src = read_source("src/mtls/cipher.rs");
    // SL-2 baseline anchor: each codepoint must appear literally in the
    // allowlist source. Using literal hex tokens (rather than IANA-name
    // matching) catches the case where someone renames a constant but
    // changes the wire codepoint.
    for codepoint in ["0x1301", "0x1302", "0x1303"] {
        assert!(
            src.contains(codepoint),
            "ORPHAN-MEDIUM-033 VIOLATED: cipher.rs missing TLS 1.3 IANA codepoint {codepoint} — \
             allowlist must contain TLS_AES_128_GCM_SHA256 (0x1301), \
             TLS_AES_256_GCM_SHA384 (0x1302), TLS_CHACHA20_POLY1305_SHA256 (0x1303). \
             RFC 8446 §9.1 mandates 0x1301 (AES_128_GCM_SHA256) for interop."
        );
    }
    // Negative anchor: no TLS 1.2 ECDHE codepoint may appear. TLS 1.2
    // suites use 0xCxxx (e.g., 0xC02B = ECDHE-ECDSA-AES128-GCM-SHA256).
    // Phase 0.2 narrows ring's default_provider to TLS 1.3 only; the
    // SOURCE allowlist is the SSoT and must reflect that.
    for forbidden in ["0xC02B", "0xC02C", "0xC02F", "0xC030"] {
        assert!(
            !src.contains(forbidden),
            "ORPHAN-MEDIUM-033 VIOLATED: cipher.rs contains TLS 1.2 ECDHE codepoint {forbidden} — \
             SL-2 baseline rejects TLS 1.2 to prevent cipher-suite downgrade attacks."
        );
    }
}

/// **ORPHAN-MTLS-005 (cont'd):** the allowlist literal must enumerate
/// exactly three `CipherSuite::*` variants. A drift detector — if the
/// `&[ ... ]` slice grows or shrinks, this fails noisily.
#[test]
fn allowlist_slice_has_three_variants() {
    let src = read_source("src/mtls/cipher.rs");
    // Find the CIPHER_SUITE_ALLOWLIST literal block.
    let needle = "pub const CIPHER_SUITE_ALLOWLIST: &[CipherSuite]";
    let start = src.find(needle).unwrap_or_else(|| {
        panic!(
            "ORPHAN-MTLS-005 VIOLATED: cipher.rs missing pub const CIPHER_SUITE_ALLOWLIST \
             declaration — allowlist SSoT was deleted or renamed."
        )
    });
    let end = src[start..].find("];").unwrap_or_else(|| {
        panic!("ORPHAN-MTLS-005 VIOLATED: malformed CIPHER_SUITE_ALLOWLIST literal — missing closing `];`")
    });
    let block = &src[start..start + end];
    // Count `CipherSuite::` (double-colon) variant references. The type
    // annotation `&[CipherSuite]` does NOT contain `CipherSuite::` (no
    // `::` follows), so it does not contribute to the count — every match
    // is a variant in the slice literal.
    let variant_count = block.matches("CipherSuite::").count();
    assert_eq!(
        variant_count, 3,
        "ORPHAN-MEDIUM-033 VIOLATED: CIPHER_SUITE_ALLOWLIST contains {variant_count} CipherSuite::* variants, expected 3. \
         Plan §5 Faz 2 item 7 + ADR-021 §10 specify exactly the 3-suite TLS 1.3 set. \
         Block text:\n{block}"
    );
}

/// **ORPHAN-MTLS-006 (Phase 0.2 wire bypass guard):** mqtt.rs must use
/// `build_suderra_crypto_provider()` AND `builder_with_provider(...)`.
/// A refactor that reverts to bare `ClientConfig::builder()` would silently
/// undo Phase 0.2 — handshakes would once again negotiate TLS 1.2 suites
/// from ring's default provider.
#[test]
fn mqtt_uses_suderra_crypto_provider() {
    let src = read_source("src/mqtt.rs");
    assert!(
        src.contains("build_suderra_crypto_provider"),
        "ORPHAN-MTLS-006 VIOLATED: src/mqtt.rs does not call build_suderra_crypto_provider. \
         The MQTT TLS path must use the cipher-restricted CryptoProvider; reverting to \
         the default ring provider re-admits TLS 1.2 ciphers (cipher-suite downgrade)."
    );
    assert!(
        src.contains("builder_with_provider"),
        "ORPHAN-MTLS-006 VIOLATED: src/mqtt.rs does not call ClientConfig::builder_with_provider. \
         A bare `ClientConfig::builder()` ignores the Suderra cipher allowlist; the explicit \
         provider wire is required for the cipher gate to fire at handshake time."
    );
}

/// **ORPHAN-MTLS-006 (cont'd):** mqtt.rs must pin the protocol version to
/// TLS 1.3 (defense-in-depth alongside the cipher allowlist). `tls12`
/// remains a Cargo feature for transitive compat with reqwest etc., but
/// the MQTT transport must not negotiate it.
#[test]
fn mqtt_pins_protocol_to_tls13() {
    let src = read_source("src/mqtt.rs");
    assert!(
        src.contains("with_protocol_versions") && src.contains("version::TLS13"),
        "ORPHAN-MTLS-006 VIOLATED: src/mqtt.rs does not pin protocol version to TLS 1.3. \
         The MQTT path must call .with_protocol_versions(&[&rustls::version::TLS13]) so \
         any future enabling of TLS 1.2 (via the rustls `tls12` feature) does not \
         silently re-admit it on the MQTT path."
    );
}

/// **ORPHAN-CRITICAL-029 (custom-CA path uses Rustls):** the rumqttc
/// `TlsConfiguration::Simple` shape (which does NOT support custom
/// verifiers) must be unreachable from the unified configure_tls path.
/// Phase 0.1 removed the `Strict + custom-CA = Err` fail-closed branch
/// because both paths now route through `TlsConfiguration::Rustls`.
///
/// We detect *construction* of `TlsConfiguration::Simple { ... }` and
/// `TlsConfiguration::Simple(...)` — mere mentions in doc comments
/// (e.g., the anti-regression rationale block in mqtt.rs Phase 0.1)
/// are explicitly NOT a regression. The discriminator is the syntactic
/// shape of struct/tuple construction.
#[test]
fn mqtt_does_not_use_tlsconfiguration_simple() {
    let src = read_source("src/mqtt.rs");
    let constructed_struct = src.contains("TlsConfiguration::Simple {");
    let constructed_tuple = src.contains("TlsConfiguration::Simple(");
    assert!(
        !constructed_struct && !constructed_tuple,
        "ORPHAN-CRITICAL-029 VIOLATED: src/mqtt.rs constructs TlsConfiguration::Simple. \
         That shape does NOT support custom verifiers — using it on the custom-CA \
         path would silently disable the SuderraServerCertVerifier (pinning, age cap, \
         chain depth gates). Phase 0.1 unified both CA branches on TlsConfiguration::Rustls; \
         do NOT reintroduce Simple."
    );
}

/// **ORPHAN-MTLS-002 (asymmetric client_auth):** Phase 0.1 unified client
/// authentication across system-CA and custom-CA branches. A regression
/// that re-introduces `.with_no_client_auth()` as a hard-coded call (rather
/// than the `if client_auth.is_some() { ... } else { ... }` choice) would
/// silently disable mutual TLS on operator-supplied client certs.
#[test]
fn mqtt_client_auth_is_conditional_not_hardcoded() {
    let src = read_source("src/mqtt.rs");
    let with_client_auth_count = src.matches("with_client_auth_cert").count();
    let with_no_client_auth_count = src.matches("with_no_client_auth").count();
    assert!(
        with_client_auth_count >= 1,
        "ORPHAN-MTLS-002 VIOLATED: src/mqtt.rs does not call with_client_auth_cert. \
         The unified Phase 0.1 path must wire mutual TLS when client cert + key are \
         configured (formerly only the custom-CA TlsConfiguration::Simple path did so)."
    );
    assert!(
        with_no_client_auth_count >= 1,
        "ORPHAN-MTLS-002 VIOLATED: src/mqtt.rs does not have a fall-through \
         with_no_client_auth path. Both branches of the client_auth Option must be \
         wired so the unified pipeline handles configured AND not-configured operators."
    );
}

/// **ORPHAN-MEDIUM-032 (boot-time Warn-mode warning):** AgentConfig::validate
/// must contain a coherence gate that fires when `mtls.mode == Warn` and
/// `pinned_leaf_fingerprints_hex` is empty. Otherwise operators receive a
/// noisy audit-event-per-handshake stream without informed-consent surfacing.
///
/// Anchors on the *code shape* of the gate, not the surrounding doc-comment
/// text — sister sessions sometimes reword comments without touching the
/// actual matches!(...) check, so the comment text is allowed to drift.
#[test]
fn config_validate_warns_on_warn_mode_empty_pins() {
    let src = read_source("src/config.rs");
    let has_match_arm = src.contains("crate::mtls::MtlsMode::Warn")
        && src.contains("self.mtls.pinned_leaf_fingerprints_hex.is_empty()");
    assert!(
        has_match_arm,
        "ORPHAN-MEDIUM-032 VIOLATED: src/config.rs does not contain a coherence gate of \
         the shape `matches!(self.mtls.mode, crate::mtls::MtlsMode::Warn) && \
         self.mtls.pinned_leaf_fingerprints_hex.is_empty()` — the Phase 0.3 boot warning \
         that informs operators about audit-event-per-handshake under Warn-mode + empty pins."
    );
}
