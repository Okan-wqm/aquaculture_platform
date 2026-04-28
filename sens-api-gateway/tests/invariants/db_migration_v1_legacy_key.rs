//! D-3 v1 legacy SQLCipher key derivation kernel
//! invariants (Batch #331).
//!
//! ## Why this file
//!
//! Batch #331 lands the `derive_v1_legacy_key` pure-crypto
//! kernel + `format_sqlcipher_pragma_key_hex` formatter.
//! These functions are the surgical alternative to
//! extracting `offline_queue::derive_db_encryption_key`
//! (which retains a production-only `OnceLock` cache).
//! The migration tool must produce IDENTICAL bytes to the
//! offline_queue function when given the same inputs;
//! otherwise the v1 → v2 `PRAGMA rekey` round-trip would
//! silently fail-open (rekey "succeeds" with a different
//! key and the DB is bricked from then on).
//!
//! ## What this file pins
//!
//!   1. The 32-byte output is deterministic for fixed inputs.
//!   2. Different machine_id → different key.
//!   3. Different secret_key → different key.
//!   4. Empty inputs do not panic (defensive boundary).
//!   5. The hex formatter produces 64-char zero-padded
//!      lower-hex.
//!   6. The hex formatter is the inverse of byte parsing
//!      (bijection on this input space).
//!   7. **Cross-implementation parity**: a
//!      reference-recomputation of the algorithm using
//!      the same `hmac` + `sha2` crates produces
//!      byte-identical output to
//!      `derive_v1_legacy_key` for the same inputs.
//!      This is the architectural guard against drift
//!      between the kernel and any future reimplementation
//!      (including the existing
//!      `offline_queue::derive_db_encryption_key`, which
//!      uses the SAME algorithm via the SAME crates).

#[path = "db_migration_v1_legacy_key_support/mod.rs"]
mod db_migration;

use db_migration::v1_legacy_key::{
    derive_v1_legacy_key, format_sqlcipher_pragma_key_hex,
};
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Reference reimplementation of the v1 algorithm using
/// the SAME crates `derive_v1_legacy_key` uses
/// internally. This is the cross-validation oracle —
/// any drift between the kernel and the algorithm spec
/// (e.g., role-swap of HMAC `key` and `data`) produces
/// a parity-test failure.
///
/// The reference INTENTIONALLY uses the public hmac API
/// directly (no helper wrappers, no caching) so a
/// silent algorithm change in `derive_v1_legacy_key`
/// shows up here, not the other way around.
#[allow(clippy::expect_used)]
fn reference_v1_key(machine_id: &[u8], secret_key: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(secret_key)
        .expect("HMAC-SHA256 accepts any key length per RFC 2104");
    mac.update(machine_id);
    let bytes = mac.finalize().into_bytes();
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    out
}

/// **D-3 v1-key invariant 1:** determinism — same
/// inputs produce same output, every call. Pins the
/// no-RNG / no-state property.
#[test]
fn d3_v1_key_is_deterministic() {
    let m = b"abcdef0123";
    let s = b"super-secret-32-bytes-of-key-x!";
    let k1 = derive_v1_legacy_key(m, s);
    let k2 = derive_v1_legacy_key(m, s);
    assert_eq!(k1, k2);
}

/// **D-3 v1-key invariant 2:** different machine_id →
/// different key. Pins that the kernel actually USES
/// the machine_id input (a refactor that ignored it
/// would still produce 32-byte output — silent
/// cross-machine isolation break).
#[test]
fn d3_v1_key_differs_when_machine_id_changes() {
    let secret = b"shared-secret";
    let k1 = derive_v1_legacy_key(b"machine-1", secret);
    let k2 = derive_v1_legacy_key(b"machine-2", secret);
    assert_ne!(k1, k2);
}

/// **D-3 v1-key invariant 3:** different secret_key →
/// different key. Pins that the kernel uses the
/// secret_key input.
#[test]
fn d3_v1_key_differs_when_secret_key_changes() {
    let m = b"shared-machine-id";
    let k1 = derive_v1_legacy_key(m, b"secret-aa");
    let k2 = derive_v1_legacy_key(m, b"secret-bb");
    assert_ne!(k1, k2);
}

/// **D-3 v1-key invariant 4:** empty inputs do not
/// panic. The kernel is the BOUNDARY — IO wrappers can
/// reject empty inputs above with structured errors,
/// but the kernel itself must NEVER panic on caller
/// inputs (defensive boundary).
#[test]
fn d3_v1_key_handles_empty_inputs_without_panic() {
    let _ = derive_v1_legacy_key(b"", b"");
    let _ = derive_v1_legacy_key(b"machine", b"");
    let _ = derive_v1_legacy_key(b"", b"secret");
}

/// **D-3 v1-key invariant 5:** the kernel matches the
/// reference reimplementation byte-for-byte across a
/// suite of input pairs. This is the CROSS-VALIDATION
/// gate — any future refactor of `derive_v1_legacy_key`
/// that changes the algorithm shape (role-swap, hash
/// substitution, encoding change) fails here.
///
/// The reference uses the SAME `hmac` + `sha2` crates
/// the kernel uses internally; the test pins the
/// algorithm SPEC, not a specific crate version's
/// output bytes.
#[test]
fn d3_v1_key_matches_reference_reimplementation() {
    let cases: &[(&[u8], &[u8])] = &[
        (b"", b""),
        (b"machine-aaa", b"secret-aaa"),
        (b"abcdef0123456789abcdef0123456789", b"32-byte-secret-key-canonical!!"),
        // Long machine_id (ASCII).
        (
            b"this-is-a-very-long-machine-identifier-that-exceeds-the-typical-32-char-budget",
            b"shorter-secret",
        ),
        // Binary bytes (machine_id can be any UTF-8 hex
        // in production but the kernel takes raw bytes).
        (&[0xff; 32], &[0x00; 32]),
        (&[0xab, 0xcd, 0xef], &[0x12, 0x34, 0x56, 0x78]),
    ];

    for (m, s) in cases {
        let kernel = derive_v1_legacy_key(m, s);
        let reference = reference_v1_key(m, s);
        assert_eq!(
            kernel, reference,
            "kernel ≠ reference for inputs (machine_id={m:?}, secret_key={s:?})"
        );
    }
}

/// **D-3 v1-key invariant 6:** the hex formatter is
/// 64-char lower-hex zero-padded for ALL inputs.
/// Pins the format contract against accidental
/// upper-hex / no-zero-pad refactors.
#[test]
fn d3_pragma_key_hex_is_64_char_lower_hex_zero_padded() {
    // All-zero key → 64 zero chars.
    let zero = [0u8; 32];
    let hex_zero = format_sqlcipher_pragma_key_hex(&zero);
    assert_eq!(hex_zero, "0".repeat(64));

    // Sentinel byte 0x0a at position 0; rest zero.
    // Pin the leading-zero behavior.
    let mut sentinel = [0u8; 32];
    sentinel[0] = 0x0a;
    let hex_sentinel = format_sqlcipher_pragma_key_hex(&sentinel);
    assert!(hex_sentinel.starts_with("0a"));

    // All chars must be lower-hex (no uppercase).
    let ab = [0xab; 32];
    let hex_ab = format_sqlcipher_pragma_key_hex(&ab);
    assert_eq!(hex_ab, "ab".repeat(32));
    assert!(hex_ab.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
}

/// **D-3 v1-key invariant 7:** the hex formatter is the
/// inverse of `hex::decode` (bijection on the 32-byte
/// input space). Pins the round-trip contract — the
/// migration tool serializes/deserializes hex without
/// loss.
#[test]
fn d3_pragma_key_hex_round_trips_via_hex_decode() {
    // Build a deterministic 32-byte key.
    let key = derive_v1_legacy_key(
        b"round-trip-machine-id",
        b"round-trip-secret",
    );
    let hex_str = format_sqlcipher_pragma_key_hex(&key);

    // Manual hex-decode (no hex crate dep needed for
    // the test).
    let mut decoded = [0u8; 32];
    for (i, chunk) in hex_str.as_bytes().chunks(2).enumerate() {
        let s = std::str::from_utf8(chunk).expect("ascii");
        decoded[i] = u8::from_str_radix(s, 16).expect("hex digit");
    }
    assert_eq!(decoded, key);
}

/// **D-3 v1-key invariant 8:** the kernel produces a
/// different output for the role-swapped inputs
/// (machine_id ↔ secret_key). Pins the role assignment
/// — a future refactor that accidentally swapped the
/// arguments would still compile + still produce a
/// 32-byte output, but every legacy DB on the fleet
/// would brick. This test fails-loud on that regression.
#[test]
fn d3_v1_key_role_swap_produces_different_output() {
    let a = b"role-aaa";
    let b = b"role-bbb";
    let proper = derive_v1_legacy_key(a, b); // machine_id=a, secret=b
    let swapped = derive_v1_legacy_key(b, a); // machine_id=b, secret=a
    // HMAC is asymmetric in its key vs data inputs; the
    // role swap MUST produce different bytes.
    assert_ne!(proper, swapped);
}
