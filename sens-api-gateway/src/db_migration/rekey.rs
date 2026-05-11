//! D-3 SQLCipher v1→v2 rekey orchestration kernel
//! (PR-195 Batch #1 — first installment of the D-3
//! closure arc; builds on PR-194's primitives).
//!
//! ## Why this module exists
//!
//! PR-194 landed every D-3 primitive needed to compute
//! the (v1, v2) key pair for a SQLCipher migration:
//!
//!   - `db_migration::v1_legacy_key::derive_v1_legacy_key`
//!     (Batch #331 + #335) — pure HMAC-SHA256 kernel.
//!   - `db_migration::v2_keystore_key::derive_v2_sqlcipher_key`
//!     (Batch #332 + #336 + #337) — Zeroize-wrapped async
//!     shim around `Keystore::derive_key`.
//!   - `db_migration::manifest::write_manifest` (Batch
//!     #329 + #338) — atomic 6-step JSON sidecar write
//!     via `shared_io::atomic_json_sidecar`.
//!   - `db_migration::boot_detector::detect_db_migration_backlog`
//!     (Batch #330) — operator-visible WARN signal.
//!
//! The remaining architectural work is ORCHESTRATION:
//! given an existing SQLCipher DB opened under the v1
//! key, atomically transition it to be opened under the
//! v2 key. This module owns that orchestration via
//! SQLCipher's native `PRAGMA rekey` — the canonical
//! key-rotation primitive on a SQLCipher database.
//!
//! ## SQLCipher PRAGMA rekey semantic
//!
//! Per the SQLCipher documentation:
//!
//!   1. Open the DB with the CURRENT key
//!      (`PRAGMA key = "x'<current_hex>'"`).
//!   2. Issue `PRAGMA rekey = "x'<new_hex>'"`. SQLCipher
//!      transactionally re-encrypts every page with the
//!      new key.
//!   3. Subsequent connections MUST open with the new
//!      key. Old key opens with `database is encrypted
//!      or is not a database`.
//!
//! The rekey is atomic at the SQLCipher page-cache level:
//! a crash mid-rekey leaves the DB recoverable in either
//! the OLD-key state (rekey hadn't committed) OR the
//! NEW-key state (rekey committed before crash). No
//! partial-rekey state is observable. SQLCipher's
//! WAL/journal handles the atomicity internally.
//!
//! ## What this module owns
//!
//! - `pragma_rekey(conn, new_hex_key) -> Result<(),
//!   RekeyError>` — issue the PRAGMA + verify post-rekey
//!   readability via a `SELECT count(*) FROM
//!   sqlite_master` round-trip. The verify is the
//!   architectural fail-closed: if the rekey somehow
//!   doesn't take (operator error, SQLCipher bug, etc.)
//!   the verify fails immediately rather than silently
//!   producing a DB that opens under neither old nor new
//!   key.
//! - `RekeyError` taxonomy: HexFormat, RekeyExecute,
//!   PostRekeyVerify — each carries operator-readable
//!   context.
//!
//! ## What this module does NOT own
//!
//! - Manifest sidecar update (post-rekey atomic write of
//!   the new schema_version). That's the
//!   `db_migration::manifest::write_manifest` SSoT;
//!   future PR-195 batches wire the rekey + manifest
//!   swap into a single transactional unit.
//! - Key derivation (v1 + v2 kernels are the SSoT —
//!   this module takes hex strings as inputs, not
//!   keys-derived-from-anything).
//! - PRAGMA `key` issuance for the initial open. The
//!   caller is responsible for opening the connection
//!   with the CURRENT key BEFORE invoking pragma_rekey.
//!
//! ## Why hex inputs (not raw bytes)
//!
//! SQLCipher's PRAGMA key/rekey syntax requires the
//! `"x'<hex>'"` string form. The caller has already
//! converted the raw 32 bytes to lower-hex via
//! `format_sqlcipher_pragma_key_hex` (Batch #331).
//! Taking hex directly here lets the caller chain:
//!
//!   let hex = format_sqlcipher_pragma_key_hex(&v2_bytes);
//!   pragma_rekey(&conn, &hex)?;
//!
//! without re-formatting. The hex format is also the
//! pre-validated form (64 lower-hex chars zero-padded);
//! validating again here is belt-and-suspenders.
//!
//! ## Why post-rekey verify
//!
//! `PRAGMA rekey` returns an OK status from SQLCipher
//! when the SQL parser accepts the statement, but the
//! actual page-cache re-encryption is a downstream
//! operation that can in principle fail (disk full,
//! cipher mismatch, internal SQLCipher bug). The
//! `SELECT count(*) FROM sqlite_master` round-trip
//! AFTER the rekey forces SQLCipher to read encrypted
//! pages with the new key. If the rekey didn't
//! actually take, the SELECT fails immediately with
//! `database is encrypted or is not a database`. This
//! turns a silent half-rekey into an
//! immediately-actionable error.

use rusqlite::Connection;

/// Length of a SQLCipher PRAGMA-key hex string. 64 chars
/// = 32 bytes × 2 hex digits per byte. The
/// `format_sqlcipher_pragma_key_hex` helper produces
/// strings of this length; this module's input
/// validation pins the contract.
const PRAGMA_KEY_HEX_LEN: usize = 64;

/// Errors returned by `pragma_rekey`.
#[derive(Debug)]
pub enum RekeyError {
    /// The supplied hex key is not 64 lower-hex chars.
    /// Caller MUST pre-validate via
    /// `format_sqlcipher_pragma_key_hex`; this arm is
    /// fail-fast belt-and-suspenders.
    HexFormat { reason: String },
    /// SQLCipher rejected the `PRAGMA rekey` statement
    /// itself (parser error, internal cipher mismatch,
    /// disk error). The original rusqlite error message
    /// is preserved.
    RekeyExecute { reason: String },
    /// `PRAGMA rekey` returned OK but the post-rekey
    /// `SELECT count(*) FROM sqlite_master` round-trip
    /// failed. The DB is in an indeterminate state from
    /// the caller's POV — neither the old nor the new
    /// key may open it cleanly. Operator escalation:
    /// restore from backup; do NOT retry rekey.
    PostRekeyVerify { reason: String },
}

impl std::fmt::Display for RekeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::HexFormat { reason } => {
                write!(f, "rekey_hex_format_invalid: {reason}")
            }
            Self::RekeyExecute { reason } => {
                write!(f, "rekey_execute_failed: {reason}")
            }
            Self::PostRekeyVerify { reason } => {
                write!(f, "rekey_post_verify_failed: {reason}")
            }
        }
    }
}

impl std::error::Error for RekeyError {}

/// Validate the input hex string shape. SQLCipher
/// itself would reject malformed hex with a parser
/// error, but pre-validation gives a precise, named
/// error class instead of a generic SQL-error string.
fn validate_pragma_hex(hex: &str) -> Result<(), RekeyError> {
    if hex.len() != PRAGMA_KEY_HEX_LEN {
        return Err(RekeyError::HexFormat {
            reason: format!("expected {PRAGMA_KEY_HEX_LEN} chars, got {}", hex.len()),
        });
    }
    if !hex.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
        return Err(RekeyError::HexFormat {
            reason: "non-lower-hex character present".to_string(),
        });
    }
    Ok(())
}

/// Atomically rekey an open SQLCipher connection from
/// its current key (already applied via
/// `PRAGMA key = "x'..."` at open time) to a new key.
///
/// **Caller contract:**
///
///   - `conn` MUST already be opened with the CURRENT
///     key applied. The caller is responsible for
///     issuing `PRAGMA key = "x'<current_hex>'"` BEFORE
///     calling this function. Connections opened
///     without a key OR with a wrong key will fail at
///     the `PRAGMA rekey` parse step (or SQLCipher will
///     reject as "encrypted or not a database" depending
///     on the wrong-key cipher path).
///   - `new_hex_key` MUST be 64 lower-hex chars (32
///     bytes × 2). Use
///     `db_migration::v1_legacy_key::format_sqlcipher_pragma_key_hex`
///     to derive the canonical form from raw key bytes.
///
/// **Effects:**
///
///   1. Validate `new_hex_key` shape (fail-fast on
///      malformed input).
///   2. Execute `PRAGMA rekey = "x'<new_hex>'"`. After
///      success the DB is atomically re-encrypted under
///      the new key.
///   3. Execute `SELECT count(*) FROM sqlite_master` —
///      forces a read with the new key; surfaces any
///      half-rekey state as
///      `RekeyError::PostRekeyVerify`.
///
/// **Returns:** `Ok(())` iff the rekey took + the
/// post-rekey verify succeeded. Any failure = the
/// caller MUST treat the DB as in-doubt (do not retry;
/// escalate to operator backup-restore).
pub fn pragma_rekey(conn: &Connection, new_hex_key: &str) -> Result<(), RekeyError> {
    validate_pragma_hex(new_hex_key)?;

    // The hex is pre-validated; SQL injection is
    // structurally impossible (no quote characters can
    // appear in a 64-char lower-hex string). The
    // `PRAGMA rekey = "x'<hex>'"` form is SQLCipher's
    // documented re-key syntax.
    let stmt = format!("PRAGMA rekey = \"x'{new_hex_key}'\";");
    conn.execute_batch(&stmt)
        .map_err(|e| RekeyError::RekeyExecute {
            reason: format!("PRAGMA rekey failed: {e}"),
        })?;

    // Post-rekey verify: round-trip a small SELECT
    // against the encrypted page cache to force SQLCipher
    // to read with the new key. A half-rekey or
    // wrong-cipher-state surfaces immediately rather
    // than at next-DB-open.
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| {
        row.get::<_, i64>(0)
    })
    .map_err(|e| RekeyError::PostRekeyVerify {
        reason: format!("post-rekey sqlite_master read failed: {e}"),
    })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db_migration::v1_legacy_key::{
        derive_v1_legacy_key, format_sqlcipher_pragma_key_hex,
    };

    /// Per-test SQLCipher DB opened under a deterministic
    /// initial key. Returns the (TempDir, Connection,
    /// initial_hex_key) so the test can rekey then
    /// verify post-rekey openability.
    fn open_keyed_db(
        machine_id: &[u8],
        secret_key: &[u8],
    ) -> (tempfile::TempDir, std::path::PathBuf, String, Connection) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("rekey_test.db");
        let initial_bytes = derive_v1_legacy_key(machine_id, secret_key);
        let initial_hex = format_sqlcipher_pragma_key_hex(&initial_bytes);
        let conn = Connection::open(&path).expect("open db");
        conn.execute_batch(&format!("PRAGMA key = \"x'{initial_hex}'\";"))
            .expect("apply initial key");
        // Seed a small table so post-rekey verification
        // has rows to count + the test asserts data
        // survives the rekey.
        conn.execute_batch(
            "CREATE TABLE rekey_test (id INTEGER PRIMARY KEY, val TEXT); \
             INSERT INTO rekey_test (val) VALUES ('seeded');",
        )
        .expect("seed table");
        (dir, path, initial_hex, conn)
    }

    #[test]
    fn pragma_rekey_with_malformed_hex_returns_hex_format_error() {
        let (_dir, _path, _initial, conn) =
            open_keyed_db(b"machine-test", b"secret-test-32-bytes-of-key-aa!");
        let err = pragma_rekey(&conn, "too-short").expect_err("must reject malformed hex");
        match err {
            RekeyError::HexFormat { reason } => {
                assert!(
                    reason.contains("expected 64 chars"),
                    "expected length-mismatch reason, got: {reason}"
                );
            }
            other => panic!("expected HexFormat, got {other:?}"),
        }
    }

    #[test]
    fn pragma_rekey_with_uppercase_hex_returns_hex_format_error() {
        let (_dir, _path, _initial, conn) =
            open_keyed_db(b"machine-test", b"secret-test-32-bytes-of-key-bb!");
        // 64 chars but contains uppercase — fails the
        // lower-hex contract.
        let bad = "AB".repeat(32);
        let err = pragma_rekey(&conn, &bad).expect_err("uppercase hex must error");
        assert!(matches!(err, RekeyError::HexFormat { .. }));
    }

    #[test]
    fn pragma_rekey_round_trips_db_under_new_key() {
        let (dir, path, _initial_hex, conn) =
            open_keyed_db(b"machine-rekey", b"secret-rekey-32-bytes-of-key-c!");

        // Compute a NEW key (different inputs = different
        // bytes).
        let new_bytes =
            derive_v1_legacy_key(b"machine-rekey-NEW", b"secret-rekey-NEW-32-bytes-of-k!");
        let new_hex = format_sqlcipher_pragma_key_hex(&new_bytes);

        pragma_rekey(&conn, &new_hex).expect("rekey ok");

        // Drop the connection so the rekey commits to disk.
        drop(conn);

        // Reopen with the NEW key — must succeed +
        // produce the seeded row.
        let conn2 = Connection::open(&path).expect("reopen");
        conn2
            .execute_batch(&format!("PRAGMA key = \"x'{new_hex}'\";"))
            .expect("apply new key");
        let count: i64 = conn2
            .query_row("SELECT count(*) FROM rekey_test", [], |r| r.get(0))
            .expect("read after reopen");
        assert_eq!(count, 1, "seeded row must survive rekey");

        drop(dir);
    }

    #[test]
    fn pragma_rekey_old_key_no_longer_opens_after_rekey() {
        let (dir, path, initial_hex, conn) =
            open_keyed_db(b"machine-oldkey-fail", b"secret-oldkey-fail-32-bytes-of!");

        let new_bytes = derive_v1_legacy_key(
            b"machine-oldkey-fail-NEW",
            b"secret-oldkey-fail-NEW-32bytes!",
        );
        let new_hex = format_sqlcipher_pragma_key_hex(&new_bytes);

        pragma_rekey(&conn, &new_hex).expect("rekey ok");
        drop(conn);

        // Reopen with the OLD key — must fail. SQLCipher
        // returns SqliteFailure on the first SELECT
        // attempt because the page cipher state is
        // inconsistent with the OLD key.
        let conn_old = Connection::open(&path).expect("file open");
        conn_old
            .execute_batch(&format!("PRAGMA key = \"x'{initial_hex}'\";"))
            .expect("apply old key (parser allows; runtime fails on read)");
        let result = conn_old.query_row("SELECT count(*) FROM rekey_test", [], |r| {
            r.get::<_, i64>(0)
        });
        assert!(
            result.is_err(),
            "old key must NOT successfully read post-rekey"
        );
        drop(dir);
    }

    /// `RekeyError` Display strings carry the canonical
    /// `rekey_*` prefix for log aggregator search.
    #[test]
    fn rekey_error_display_strings_pinned() {
        for (err, expected_prefix) in [
            (
                RekeyError::HexFormat { reason: "x".into() },
                "rekey_hex_format_invalid",
            ),
            (
                RekeyError::RekeyExecute { reason: "y".into() },
                "rekey_execute_failed",
            ),
            (
                RekeyError::PostRekeyVerify { reason: "z".into() },
                "rekey_post_verify_failed",
            ),
        ] {
            let s = format!("{err}");
            assert!(
                s.contains(expected_prefix),
                "missing canonical prefix `{expected_prefix}` in: {s}"
            );
        }
    }

    #[test]
    fn rekey_error_implements_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<RekeyError>();
    }
}
