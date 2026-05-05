//! Machine-ID read with env-override sandboxing
//! (Batch #344 — closes ORPHAN-MEDIUM-033).
//!
//! ## Why this module exists
//!
//! The agent's v1 SQLCipher derivation (legacy path,
//! migrating to v2 in PR-195) takes TWO inputs:
//!
//!   - `secret_key` — read from `/etc/suderra/db.key`,
//!     with a `SUDERRA_DB_KEY_PATH` env-override for CI
//!     sandboxing (`offline_queue::load_or_create_db_secret`,
//!     Batch 88).
//!   - `machine_id` — read from `/etc/machine-id` (or
//!     `/var/lib/dbus/machine-id` fallback) via the
//!     `machine_uid::get()` upstream crate. **No
//!     env-override existed pre-Batch-#344.**
//!
//! The asymmetry meant tests + CI sandboxes could
//! inject one input but not the other; sandboxed CI
//! runners (stripped Docker images without
//! `/etc/machine-id`) couldn't exercise the full
//! derivation path; future db-migrate-cli running on a
//! different host than the original device couldn't
//! rekey for that device's DB without forking
//! `machine_uid`.
//!
//! ## Architectural fix
//!
//! `read()` checks `SUDERRA_MACHINE_ID_PATH` env var
//! first. If set, the file at that path is the machine-
//! id source. If not set, falls back to `machine_uid::
//! get()` — the production path is byte-identical to
//! pre-Batch-#344 behavior.
//!
//! The override pattern mirrors `SUDERRA_DB_KEY_PATH`
//! exactly so operators reading the test sandboxing
//! discipline see ONE convention, not two.
//!
//! ## Trim semantics
//!
//! The override file's contents are trimmed (leading +
//! trailing whitespace including newlines stripped).
//! `/etc/machine-id` on Linux is canonically a single
//! 32-char hex line followed by a newline; reading the
//! raw file would produce `"<hex>\n"` and the HMAC
//! kernel's output would differ from production.
//! Trimming makes the env-override path produce
//! byte-identical results to the `machine_uid::get()`
//! crate (which already trims internally).
//!
//! ## NOT a breaking change
//!
//! Production builds with `SUDERRA_MACHINE_ID_PATH`
//! unset have IDENTICAL behavior to pre-#344. The
//! Batch #335 SSoT-extraction discipline (algorithm
//! SSoT lives in `db_migration::v1_legacy_key`) holds:
//! offline_queue + future db-migrate-cli both call this
//! wrapper for the IO read, then feed the bytes into
//! the kernel.

use anyhow::{Context, Result};

/// Env var name. Mirrors `SUDERRA_DB_KEY_PATH` naming
/// convention — both are CI-sandbox + test-isolation
/// inputs, both follow `SUDERRA_<UPPER_SNAKE>_PATH`
/// shape.
const MACHINE_ID_OVERRIDE_ENV: &str = "SUDERRA_MACHINE_ID_PATH";

/// Read the machine identifier with env-override
/// sandboxing.
///
/// **Production path** (env unset): delegates to
/// `machine_uid::get()` — reads `/etc/machine-id` or
/// `/var/lib/dbus/machine-id` per the upstream crate's
/// resolution order.
///
/// **Test/CI path** (env set): reads the file at
/// `SUDERRA_MACHINE_ID_PATH`, trims whitespace,
/// returns the contents.
///
/// **Errors:** maps both paths' failure modes into
/// `anyhow::Error` with operator-readable context. The
/// caller (offline_queue's `derive_db_encryption_key`)
/// turns this into the legacy `Cannot derive database
/// encryption key: machine-id unavailable (...)`
/// message that fleet operators have learned to grep
/// for.
pub(crate) fn read() -> Result<String> {
    if let Some(override_path) = std::env::var_os(MACHINE_ID_OVERRIDE_ENV) {
        let path = std::path::PathBuf::from(override_path);
        let raw = std::fs::read_to_string(&path).with_context(|| {
            format!(
                "machine-id env-override path {} unreadable",
                path.display()
            )
        })?;
        return Ok(raw.trim().to_string());
    }
    machine_uid::get().map_err(|e| {
        anyhow::anyhow!(
            "machine-id unavailable: {}. Ensure /etc/machine-id or \
             /var/lib/dbus/machine-id exists, OR set \
             SUDERRA_MACHINE_ID_PATH to point at a sandboxed \
             machine-id file (CI/test-isolation use).",
            e,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// `std::env::set_var` mutates process-wide global
    /// state that is shared across tests run in
    /// parallel. We serialize the env-mutating tests in
    /// this module behind a per-module mutex.
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    /// Env-override path returns the file's trimmed
    /// contents byte-for-byte.
    #[test]
    fn read_uses_env_override_when_set() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("machine-id");
        std::fs::write(&path, "abcdef0123456789abcdef0123456789\n")
            .expect("seed");
        // SAFETY: env-mutation in tests is serialized
        // via ENV_MUTEX above.
        unsafe {
            std::env::set_var(MACHINE_ID_OVERRIDE_ENV, &path);
        }
        let id = read().expect("read");
        unsafe {
            std::env::remove_var(MACHINE_ID_OVERRIDE_ENV);
        }
        assert_eq!(id, "abcdef0123456789abcdef0123456789");
    }

    /// Trim semantic: trailing newline + leading/trailing
    /// whitespace stripped. Pins parity with
    /// `machine_uid::get()`'s already-trimmed output.
    #[test]
    fn read_trims_override_file_whitespace() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("machine-id");
        std::fs::write(&path, "  trimmed-id-with-spaces  \n\n")
            .expect("seed");
        unsafe {
            std::env::set_var(MACHINE_ID_OVERRIDE_ENV, &path);
        }
        let id = read().expect("read");
        unsafe {
            std::env::remove_var(MACHINE_ID_OVERRIDE_ENV);
        }
        assert_eq!(id, "trimmed-id-with-spaces");
    }

    /// Env-override pointing at a non-existent file
    /// errors with operator-readable context. Pins the
    /// fail-closed semantic.
    #[test]
    fn read_errors_when_override_path_missing() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        unsafe {
            std::env::set_var(
                MACHINE_ID_OVERRIDE_ENV,
                "/nonexistent-path-batch-344",
            );
        }
        let result = read();
        unsafe {
            std::env::remove_var(MACHINE_ID_OVERRIDE_ENV);
        }
        let err = result.expect_err("must error");
        let msg = format!("{err}");
        assert!(
            msg.contains("machine-id env-override path"),
            "expected operator-readable context, got: {msg}"
        );
    }

    /// Env unset → falls back to `machine_uid::get()`.
    /// We can't fully control the host's machine-id
    /// state in a unit test, but we CAN verify that the
    /// fallback path is taken (via the absence of the
    /// override-path-error message). On a system with a
    /// machine-id, `read()` succeeds; on a system
    /// without, it errors with the fallback's message
    /// (NOT the override-path's message). Either way,
    /// the architectural shape is verified.
    #[test]
    fn read_falls_back_when_env_unset() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        unsafe {
            std::env::remove_var(MACHINE_ID_OVERRIDE_ENV);
        }
        match read() {
            Ok(id) => {
                // Production path succeeded; the host
                // has /etc/machine-id. Pin that the
                // result is non-empty + trimmed.
                assert!(!id.is_empty());
                assert_eq!(id, id.trim());
            }
            Err(err) => {
                // Production path failed (no machine-id
                // on this host); pin that the error
                // message is the FALLBACK message, NOT
                // the override-path message.
                let msg = format!("{err}");
                assert!(
                    msg.contains("machine-id unavailable"),
                    "expected fallback error message, got: {msg}"
                );
                assert!(
                    !msg.contains("env-override path"),
                    "fallback error must not mention env-override path"
                );
            }
        }
    }
}
