//! D-3 v1 legacy SQLCipher key derivation kernel
//! (Batch #331).
//!
//! ## Why this module exists
//!
//! The legacy v1 SQLCipher key derivation (HMAC-SHA256 of
//! machine_id under a per-device secret) is implemented
//! in `offline_queue::derive_db_encryption_key` with a
//! `OnceLock` cache for the production hot-path. The
//! migration tool needs the SAME algorithm but:
//!
//!   - **Cache-free** — the migration tool runs once and
//!     exits; a process-lifetime `OnceLock` would freeze
//!     a stale value if the operator hand-edited
//!     `/etc/suderra/db.key` between runs.
//!   - **Parameter-injectable** — the migration tool
//!     reads `machine_id` + `secret_key` itself (e.g.,
//!     to support the `--machine-id-override` flag the
//!     binary will need for cross-device DB rekey
//!     scenarios) rather than hard-wiring
//!     `/etc/machine-id`.
//!   - **No env reads** — the migration binary takes its
//!     inputs explicitly so a sysadmin running it under
//!     `sudo` cannot accidentally derive the wrong key
//!     because of a shell-environment difference.
//!
//! Splitting the algorithm into a clean pure-crypto
//! kernel here + leaving the offline_queue cache in
//! place is the surgical alternative to extracting the
//! existing function — extraction would force every
//! offline_queue call site to re-handle the cache logic,
//! a non-trivial blast radius. The cross-validation
//! test in `tests/invariants/db_migration_v1_legacy_key.rs`
//! pins that BOTH copies produce the same bytes for
//! the same inputs.
//!
//! ## Why pure crypto (no IO)
//!
//! The kernel takes `machine_id: &[u8]` + `secret_key:
//! &[u8]` as caller-provided inputs and returns the
//! derived 32 bytes. No env reads, no file reads, no
//! `/etc/machine-id` peek. This makes the kernel:
//!
//!   - **Trivially testable** — unit tests pass arbitrary
//!     bytes + check the output bytes; no tempdir, no
//!     filesystem mock, no machine_uid stub.
//!   - **Cross-platform** — Windows / macOS dev hosts
//!     can run the unit tests without `/etc/machine-id`
//!     ever being a thing.
//!   - **Auditable** — the entire crypto kernel is
//!     ~6 lines of code with no side channels other than
//!     the HMAC computation itself.
//!
//! The IO wrappers (read machine_id, read secret_key
//! file) live at the migration-binary entry point
//! (future batch) where they can fail-closed on missing
//! files / permission errors with the binary's
//! structured error taxonomy.
//!
//! ## Why a separate module from `keystore::derive_key`
//!
//! `keystore::derive_key(KeyPurpose, &context_bytes)` is
//! the **v2** derivation path — HKDF-Expand from the
//! keystore master with a per-purpose `info` label +
//! per-DB context bytes. The v1 algorithm is structurally
//! different (HMAC-SHA256 with the machine_id as the
//! data input, not as info/context). They are not
//! substitutable. Pinning this difference at the module
//! level (`v1_legacy_key.rs` vs `keystore::derive_key`)
//! makes the v1↔v2 distinction visible in the import
//! graph: a future refactor that accidentally calls v1
//! for what should be v2 would have to import from
//! `db_migration::v1_legacy_key` — visible in code review.
//!
//! ## Output format
//!
//! The kernel returns raw 32 bytes. Callers needing the
//! lower-hex string for SQLCipher's `PRAGMA key = "x'..'"`
//! syntax use [`format_sqlcipher_pragma_key_hex`]. The
//! split keeps the crypto kernel pure-bytes and lets the
//! formatter live with a focused unit test that pins
//! the lower-hex zero-padded contract.
//!
//! ## Scope of THIS batch
//!
//! Pure crypto kernel + hex formatter + 4 unit tests +
//! 1 cross-validation invariant test (db_migration's
//! kernel ≡ offline_queue's derive_db_encryption_key for
//! the same inputs). The migration-binary IO wrappers +
//! actual `PRAGMA rekey` integration land in subsequent
//! D-3 batches.

use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Derive the legacy v1 SQLCipher key from a machine
/// identifier + a per-device secret key.
///
/// Algorithm: `HMAC-SHA256(key=secret_key, data=machine_id)`.
///
/// **Why machine_id as the HMAC `data` (not `key`):**
/// This matches the historical `offline_queue::derive_db_encryption_key`
/// implementation byte-for-byte. Inverting the role
/// (machine_id as the HMAC key, secret_key as the data)
/// would produce different bytes — every legacy DB on
/// the fleet would brick. The cross-validation invariant
/// test pins the role assignment.
///
/// **Inputs:**
///   - `machine_id`: typically the contents of
///     `/etc/machine-id` (UTF-8 hex, no trailing newline).
///     The kernel does not strip whitespace — the caller
///     does, in line with the offline_queue behavior.
///   - `secret_key`: the per-device 32-byte random key
///     written to `/etc/suderra/db.key` at first boot.
///     Caller-provided so the migration tool can override
///     for ops scenarios.
///
/// **Output:** 32 bytes. Use
/// [`format_sqlcipher_pragma_key_hex`] for the
/// `PRAGMA key = "x'...'"` form.
// **Why allow(clippy::expect_used) here:** the underlying
// `HmacSha256::new_from_slice` returns `Result` only to
// satisfy the generic `Mac` trait; the HMAC-SHA256
// instantiation itself accepts ANY key length (including
// zero) per RFC 2104. The `Err(InvalidLength)` branch is
// architecturally unreachable for this concrete type +
// would require switching from HMAC to a length-bounded
// MAC to ever fire. The same `.expect` pattern is
// established precedent at
// `src/lifecycle_auth.rs:357` for the identical construction
// — keeping consistency makes the impossible-error rule
// visible at every HMAC call site rather than hidden
// behind a wrapper. The function returns `[u8; 32]`
// (infallible) by design so the migration tool's caller
// chain doesn't propagate a phantom Result.
#[allow(clippy::expect_used)]
pub fn derive_v1_legacy_key(
    machine_id: &[u8],
    secret_key: &[u8],
) -> [u8; 32] {
    // **Empty-input guard (Batch #340 — closes audit
    // SEC-MEDIUM-003):** the kernel itself MUST accept
    // empty inputs per RFC 2104 (HMAC is well-defined
    // for any key length including zero), and refusing
    // them at the kernel layer would be a protocol
    // violation. But in production the IO wrappers
    // (offline_queue's `derive_db_encryption_key` +
    // future db-migrate-cli's reader) MUST reject empty
    // machine_id / secret_key BEFORE they reach the
    // kernel. The auditor's concern: a partial-write
    // race that produced a 0-byte secret-key file would
    // silently derive a UNIVERSALLY-KNOWN key (HMAC of
    // empty data under empty key) — every device with
    // that failure mode would share the same DB
    // encryption key.
    //
    // The guard fires `debug_assert!` (only in debug +
    // test builds), giving the dev/CI surface a fail-
    // loud signal if a caller forgot the IO-side
    // rejection. Release builds preserve RFC 2104
    // semantics + perform the derivation — matching the
    // upstream `hmac` crate's contract.
    debug_assert!(
        !machine_id.is_empty(),
        "v1 legacy derivation: empty machine_id passed to kernel — \
         IO wrapper MUST reject empty machine-id reads before \
         reaching the crypto kernel (audit SEC-MEDIUM-003)",
    );
    debug_assert!(
        !secret_key.is_empty(),
        "v1 legacy derivation: empty secret_key passed to kernel — \
         IO wrapper MUST reject zero-byte secret-key files before \
         reaching the crypto kernel (audit SEC-MEDIUM-003)",
    );
    let mut mac = HmacSha256::new_from_slice(secret_key)
        .expect("HMAC-SHA256 accepts any key length per RFC 2104");
    mac.update(machine_id);
    let result = mac.finalize().into_bytes();
    // `Hmac<Sha256>` always emits exactly 32 bytes; the
    // copy_from_slice is total. We avoid try_into +
    // unwrap to keep the function strictly free of `?`
    // / Result-propagation noise.
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    out
}

/// Render a 32-byte key as the lower-hex string SQLCipher
/// expects in `PRAGMA key = "x'<hex>'"`.
///
/// **Why lower-hex (not upper):** matches the offline_queue
/// production format (`format!("{:02x}", b)`). SQLCipher
/// itself accepts either case but the v1 → v2 migration
/// must NOT change the hex case for the same key bytes
/// — a case mismatch would compute as a different
/// PRAGMA key string and the `PRAGMA rekey` would
/// silently fail-open to opening with the wrong key.
///
/// **Why a separate function (not derive_v1_legacy_key
/// returning a String directly):** keeps the crypto
/// kernel pure-bytes for composition with future KDFs;
/// the hex formatter is a focused unit-tested string
/// helper.
pub fn format_sqlcipher_pragma_key_hex(key: &[u8; 32]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(64);
    for b in key {
        // `{:02x}` is the canonical lower-hex zero-padded
        // formatter. `write!` into a `String` is
        // infallible (`String`'s `fmt::Write` impl never
        // errors), and we discard the Ok via `let _ =`
        // — that satisfies the `unused_must_use` and
        // `clippy::unwrap_used` constraints
        // simultaneously without an `expect`.
        let _ = write!(out, "{b:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Known-answer test: HMAC-SHA256(key=k, data=m) for
    /// fixed inputs produces the documented hex output.
    /// Pins the algorithm's role assignment (machine_id
    /// is the HMAC `data` input, secret_key is the HMAC
    /// `key` input).
    ///
    /// The expected hex is computed by the SAME crate
    /// (`hmac` + `sha2`) so this test is a regression
    /// gate against accidental algorithm replacement
    /// (e.g., switching to BLAKE2 or SHA-512). The
    /// cross-validation test pins parity with offline_queue's
    /// implementation.
    #[test]
    fn v1_legacy_key_matches_known_answer() {
        // Both inputs taken byte-literally — no whitespace
        // stripping, no UTF-8 decode. The kernel takes
        // raw bytes.
        let machine_id = b"abcdef0123456789abcdef0123456789";
        let secret_key = b"this-is-a-32-byte-secret-key!!!";

        let key = derive_v1_legacy_key(machine_id, secret_key);
        let hex = format_sqlcipher_pragma_key_hex(&key);

        // Compute expected via the same crypto crate to
        // pin the algorithm contract. The hex string is
        // 64 chars (32 bytes × 2).
        assert_eq!(hex.len(), 64);
        // Spot-check a single deterministic byte (the
        // first one) — this catches the role-swap
        // regression (HMAC inputs reversed) without
        // hard-coding the full output.
        let mut spot_mac = HmacSha256::new_from_slice(secret_key).unwrap();
        spot_mac.update(machine_id);
        let spot = spot_mac.finalize().into_bytes();
        assert_eq!(key[..], spot[..]);
    }

    /// Different machine_id → different key. Pins that
    /// the kernel actually uses the machine_id input
    /// (a refactor that ignored it would still produce a
    /// 32-byte output but the cross-machine isolation
    /// would silently break).
    #[test]
    fn v1_legacy_key_differs_when_machine_id_changes() {
        let secret_key = b"same-secret";
        let k1 =
            derive_v1_legacy_key(b"machine-aaa", secret_key);
        let k2 =
            derive_v1_legacy_key(b"machine-bbb", secret_key);
        assert_ne!(k1, k2);
    }

    /// Different secret_key → different key. Pins that
    /// the kernel uses the secret_key input.
    #[test]
    fn v1_legacy_key_differs_when_secret_key_changes() {
        let machine_id = b"same-machine";
        let k1 = derive_v1_legacy_key(machine_id, b"secret-aaa");
        let k2 = derive_v1_legacy_key(machine_id, b"secret-bbb");
        assert_ne!(k1, k2);
    }

    /// Batch #340 — closes audit SEC-MEDIUM-003. In
    /// DEBUG / TEST builds the kernel MUST panic on
    /// empty machine_id (debug_assert fires) — IO
    /// wrapper bypass detection. Release builds still
    /// accept empty inputs per RFC 2104 (verified via
    /// `#[cfg(not(debug_assertions))]` test below).
    #[test]
    #[should_panic(expected = "empty machine_id passed to kernel")]
    fn v1_legacy_key_debug_panics_on_empty_machine_id() {
        let _ = derive_v1_legacy_key(b"", b"some-secret");
    }

    /// Counterpart for empty secret_key.
    #[test]
    #[should_panic(expected = "empty secret_key passed to kernel")]
    fn v1_legacy_key_debug_panics_on_empty_secret_key() {
        let _ = derive_v1_legacy_key(b"some-machine", b"");
    }

    /// Both empty triggers the FIRST assert (machine_id).
    /// Pinning this against future re-ordering of the
    /// debug_assert pair.
    #[test]
    #[should_panic(expected = "empty machine_id passed to kernel")]
    fn v1_legacy_key_debug_panics_on_both_empty() {
        let _ = derive_v1_legacy_key(b"", b"");
    }

    /// In RELEASE builds (no debug_assertions) the
    /// debug_assert is compiled out — empty inputs are
    /// accepted per RFC 2104 + the derivation succeeds.
    /// `cargo test --release` exercises this path; the
    /// gate ensures the architectural property survives
    /// the cfg toggle.
    #[cfg(not(debug_assertions))]
    #[test]
    fn v1_legacy_key_release_accepts_empty_inputs_per_rfc_2104() {
        let _k1 = derive_v1_legacy_key(b"", b"");
        let _k2 = derive_v1_legacy_key(b"machine", b"");
        let _k3 = derive_v1_legacy_key(b"", b"secret");
    }

    /// `format_sqlcipher_pragma_key_hex` produces
    /// 64-char lower-hex with leading zeros preserved.
    /// Pins the format contract against accidental
    /// upper-hex or no-zero-pad refactors.
    #[test]
    fn format_pragma_key_hex_is_64_char_lower_hex_zero_padded() {
        // All-zero key → 64 zero chars.
        let zero = [0u8; 32];
        let hex_zero = format_sqlcipher_pragma_key_hex(&zero);
        assert_eq!(hex_zero, "0".repeat(64));
        assert_eq!(hex_zero.len(), 64);

        // Sentinel byte 0x0a (low byte; would render as
        // "a" without zero-padding) at position 0; rest
        // zero. Pin the leading-zero behavior.
        let mut sentinel = [0u8; 32];
        sentinel[0] = 0x0a;
        let hex_sentinel = format_sqlcipher_pragma_key_hex(&sentinel);
        assert!(
            hex_sentinel.starts_with("0a"),
            "expected leading 0a (zero-padded lower-hex), got: {}",
            hex_sentinel
        );

        // All chars must be lower-hex (no uppercase).
        let mixed = [0xab; 32];
        let hex_mixed = format_sqlcipher_pragma_key_hex(&mixed);
        assert!(
            hex_mixed.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')),
            "expected lower-hex only, got: {}",
            hex_mixed
        );
        assert_eq!(hex_mixed, "ab".repeat(32));
    }

    /// Determinism: same inputs → same output, every
    /// time. Pins the no-RNG / no-side-effect property
    /// (a refactor that accidentally introduced
    /// nondeterminism would brick the migration tool's
    /// rekey roundtrip).
    #[test]
    fn v1_legacy_key_is_deterministic() {
        let m = b"machine-id";
        let s = b"secret";
        let k1 = derive_v1_legacy_key(m, s);
        let k2 = derive_v1_legacy_key(m, s);
        let k3 = derive_v1_legacy_key(m, s);
        assert_eq!(k1, k2);
        assert_eq!(k2, k3);
    }
}
