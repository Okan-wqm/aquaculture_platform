#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]
//! ADR-048 DEC-10.1 / DEC-10.6 — the broker connection of the Suderra OS
//! profile is CA-anchored to the trust-anchors bundle.
//!
//! * `MtlsMode::CaAnchored` is the only mode the `suderra-os` profile
//!   compiles (and so its default); `Legacy`, `Warn` and `Strict` (leaf
//!   pinning) exist in the generic profile alone. `src/mtls/mode.rs` depends
//!   on serde only and is compiled into this test crate, so the variant set
//!   is checked, not described.
//! * The Suderra OS broker roots come from the bundle's `mqtt-ca` set
//!   alone: the system CA store (`load_native_certs`) and a configured CA
//!   file exist only in the generic root-store builder, and the TLS
//!   transport is unconditional (no `tls.enabled` switch).
//!
//! The handshake behaviour (pinned-CA leaf accepted without a leaf pin,
//! host name mismatch refused, foreign CA refused, empty CA set refused) is
//! covered by `mtls::rustls_verifier::ca_anchored_handshake_tests` inside
//! the binary crate.

#[allow(dead_code)]
#[path = "../../src/mtls/mode.rs"]
mod mode;

#[path = "source_scan_support/mod.rs"]
mod source_scan_support;

use mode::MtlsMode;

#[test]
fn ca_anchored_is_the_profiles_only_mode_and_pins_no_leaf() {
    let m = MtlsMode::CaAnchored;
    assert!(!m.uses_leaf_pins());
    assert!(m.rejects_policy_violation());
    assert_eq!(
        serde_json::from_str::<MtlsMode>(r#""ca_anchored""#).unwrap(),
        MtlsMode::CaAnchored
    );
    let pin_modes = [r#""legacy""#, r#""warn""#, r#""strict""#];
    if cfg!(feature = "suderra-os") {
        assert_eq!(MtlsMode::default(), MtlsMode::CaAnchored);
        for gone in pin_modes {
            assert!(
                serde_json::from_str::<MtlsMode>(gone).is_err(),
                "{gone} must not exist in the suderra-os profile"
            );
        }
    } else {
        for kept in pin_modes {
            assert!(
                serde_json::from_str::<MtlsMode>(kept).is_ok(),
                "{kept} stays in the generic profile (HC-1, DEC-28)"
            );
        }
    }
}

/// Byte offset of the `fn` item named `name` (found in the scanned code,
/// which blanks comments and string contents but keeps byte offsets), and
/// the original source text of the doc comment and attributes right
/// before it (attribute strings such as `"suderra-os"` are blanked in the
/// scanned code, so they are read from the source).
fn fn_with_attrs<'a>(code: &str, text: &'a str, name: &str) -> (usize, &'a str) {
    let at = code
        .find(&format!("fn {name}("))
        .unwrap_or_else(|| panic!("fn {name} not found"));
    let head = &text[..at];
    let item_start = head.rfind("\n\n").map_or(0, |i| i + 2);
    (at, &text[item_start..at])
}

#[test]
fn suderra_os_broker_roots_are_the_bundle_set_alone() {
    let text =
        std::fs::read_to_string(source_scan_support::crate_root().join("src/mqtt.rs")).unwrap();
    let scanned = source_scan_support::scan("src/mqtt.rs", &text);
    let code = &scanned.code;

    // The system CA store and the configured CA file live only in the
    // generic root-store builder.
    let (generic_at, generic_attrs) = fn_with_attrs(code, &text, "configured_root_store");
    assert!(
        generic_attrs.contains("#[cfg(not(feature = \"suderra-os\"))]"),
        "configured_root_store must be generic-only"
    );
    let generic_end = code[generic_at..]
        .find("\n    }\n")
        .map(|i| generic_at + i)
        .expect("end of configured_root_store");
    for needle in ["load_native_certs", "ca_cert_path"] {
        for line in scanned.code_lines_with(needle) {
            let offset: usize = text
                .split_inclusive('\n')
                .take(line - 1)
                .map(str::len)
                .sum();
            assert!(
                (generic_at..generic_end).contains(&offset),
                "{needle} at src/mqtt.rs:{line} is outside the generic root-store builder"
            );
        }
    }

    // The Suderra OS builder takes the bundle's DER set and nothing else.
    let (_, bundle_attrs) = fn_with_attrs(code, &text, "bundle_root_store");
    assert!(bundle_attrs.contains("#[cfg(feature = \"suderra-os\")]"));
    assert!(code.contains("fn bundle_root_store(\n        broker_ca: &[Vec<u8>],"));

    // TLS is unconditional on Suderra OS: the only `tls.enabled` switch is
    // the generic one.
    for line in scanned.code_lines_with("tls.enabled") {
        let before: String = text.lines().take(line - 1).collect::<Vec<_>>().join("\n");
        let gate = before.rfind("#[cfg(not(feature = \"suderra-os\"))]");
        let last_blank = before.rfind("\n\n");
        assert!(
            gate.is_some() && gate > last_blank,
            "tls.enabled at src/mqtt.rs:{line} must be generic-only"
        );
    }
}

#[test]
fn suderra_os_config_has_no_plaintext_or_ca_path_switch() {
    // DEC-10.1: the MqttTlsConfig fields that could turn TLS off, choose a
    // CA file or skip verification are compiled out of the suderra-os
    // profile.
    let text =
        std::fs::read_to_string(source_scan_support::crate_root().join("src/config.rs")).unwrap();
    let start = text
        .find("pub struct MqttTlsConfig {")
        .expect("MqttTlsConfig");
    let body = &text[start..start + text[start..].find("\n}\n").unwrap()];
    for field in ["pub enabled: bool", "pub ca_cert_path:", "pub insecure_skip_verify: bool"] {
        let at = body.find(field).unwrap_or_else(|| panic!("{field}"));
        let before = &body[..at];
        let gate = before.rfind("#[cfg(not(feature = \"suderra-os\"))]");
        let previous_field = before.rfind(",\n");
        assert!(
            gate.is_some() && gate > previous_field,
            "{field} must be compiled out of the suderra-os profile"
        );
    }
}
