//! v1 SQLCipher secret-key SSoT (PR-195 Batch #14 —
//! extracted from `offline_queue::load_or_create_db_secret`
//! so multiple SQLCipher consumers can share the SAME
//! IO read path without each one duplicating the
//! env-override + permissions-mode discipline).
//!
//! ## Why this module exists
//!
//! Pre-Batch-#14, `offline_queue.rs` privately owned
//! the `/etc/suderra/db.key` read-or-create logic.
//! Other consumers (license_cache, retain_persistence,
//! bytecode_retain) needed the SAME bytes for their v1
//! legacy key derivation, but the function was private.
//! The choices were:
//!
//!   1. Duplicate the logic in each consumer file.
//!   2. Lift visibility on
//!      `offline_queue::load_or_create_db_secret`.
//!   3. Extract to a dedicated module — this batch.
//!
//! Option 1 violates the no-duplication discipline
//! (Batch #335 SSoT-extraction precedent). Option 2
//! reverses domain ownership (license_cache importing
//! from offline_queue's namespace). Option 3 puts the
//! IO read in a neutral module that all SQLCipher
//! consumers can import without cross-domain coupling.
//!
//! The SSoT is enforced by:
//!
//!   - `offline_queue::load_or_create_db_secret` is now
//!     a thin delegating wrapper over
//!     `db_secret::read_or_create_v1_secret`.
//!   - All future consumer adoptions of
//!     `consumer_key_resolver` import the secret bytes
//!     from THIS module, never duplicate the
//!     `/etc/suderra/db.key` read locally.
//!
//! ## Env-override semantics
//!
//! `SUDERRA_DB_KEY_PATH` env var redirects the read to
//! a sandboxed path (CI + tests). Production deployments
//! leave the env unset + use `/etc/suderra/db.key`.
//! With the env unset a TEST build resolves a per-process
//! temp sandbox instead — see `default_secret_key_path`
//! for why the hermeticity is a default and not an
//! opt-in.
//! Mirrors the `SUDERRA_MACHINE_ID_PATH` override on
//! `crate::machine_id::read` (Batch #344) — both are
//! the SAME convention for the same reason (test +
//! CI cannot write to /etc).
//!
//! ## Permissions discipline
//!
//! On Unix, the create path uses `OpenOptions::mode(0o400)`
//! + `create_new(true)` — no TOCTOU race window where
//! the file is world-readable before chmod. Mirrors the
//! pre-extraction `offline_queue` discipline byte-for-
//! byte; the extraction is a NAME change, not a
//! semantic change.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// Env var name. Mirrors `SUDERRA_MACHINE_ID_PATH` on
/// `crate::machine_id::read` — same convention,
/// `SUDERRA_<UPPER_SNAKE>_PATH` shape.
pub const SECRET_KEY_OVERRIDE_ENV: &str = "SUDERRA_DB_KEY_PATH";

/// Production canonical path for the v1 secret-key
/// file. Used when `SUDERRA_DB_KEY_PATH` is unset.
pub const DEFAULT_SECRET_KEY_PATH: &str = "/etc/suderra/db.key";

/// Minimum acceptable secret-key length in bytes.
/// Pre-extraction value preserved exactly — pre-#14
/// this was inline in `load_or_create_db_secret`.
pub const MIN_SECRET_KEY_LEN: usize = 16;

/// Resolve the file the v1 secret-key lives in: the
/// `SUDERRA_DB_KEY_PATH` override when set, else this
/// build's default. THE resolver — every reader of the
/// v1 secret goes through it (read-or-create below, the
/// read-only migration ceremony in
/// `db_migration::cli_runtime`), so no consumer can
/// invent a second answer to "where does the key live".
pub fn secret_key_path() -> PathBuf {
    match std::env::var_os(SECRET_KEY_OVERRIDE_ENV) {
        Some(v) => PathBuf::from(v),
        None => default_secret_key_path(),
    }
}

/// Production default: the `/etc` path the root-owned
/// agent installs into.
#[cfg(not(test))]
fn default_secret_key_path() -> PathBuf {
    PathBuf::from(DEFAULT_SECRET_KEY_PATH)
}

/// Test-build default: a per-process sandbox under the
/// temp dir.
///
/// **Why the default differs instead of every test
/// opting in.** The sandbox used to be opt-in
/// (`offline_queue::test_support::ensure_key_sandbox`).
/// A test that forgot it still passed for the author —
/// a root shell or container CAN create `/etc/suderra` —
/// and failed only on the unprivileged CI runner, which
/// is exactly how four `db::sqlcipher_factory` tests
/// went red with `Permission denied` on
/// `/etc/suderra`. Making the sandbox the DEFAULT
/// deletes the opt-in: no in-crate test can reach `/etc`
/// through this resolver, whether or not its author
/// remembered to ask.
#[cfg(test)]
fn default_secret_key_path() -> PathBuf {
    test_sandbox::path()
}

/// The single sandbox location for the whole test
/// binary. One owner, so no test module can seed a
/// second path that races the process-wide `OnceLock`
/// latch in `offline_queue::derive_db_encryption_key`.
#[cfg(test)]
pub(crate) mod test_sandbox {
    use std::path::PathBuf;
    use std::sync::LazyLock;

    static PATH: LazyLock<PathBuf> = LazyLock::new(|| {
        let dir = std::env::temp_dir().join(format!("suderra-db-key-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir test key sandbox");
        dir.join("db.key")
    });

    /// Path only — the file is created by
    /// `read_or_create_v1_secret` on first use, so the
    /// read-only migration path still observes a genuine
    /// missing-file when nothing has seeded it.
    pub(crate) fn path() -> PathBuf {
        PATH.clone()
    }
}

/// Read the v1 SQLCipher secret-key file, generating a
/// fresh random key on missing-file. Used by every
/// SQLCipher consumer's legacy v1 derivation path.
///
/// **Production path:** reads
/// `/etc/suderra/db.key` (or
/// `SUDERRA_DB_KEY_PATH` override). Existing file is
/// returned as-is. Missing file: generates a 32-byte
/// random key + writes with `0o400` permissions
/// (Unix) using `create_new(true)` so there is no
/// TOCTOU race window.
///
/// **Migration ceremony note:** this is the
/// READ-OR-CREATE function. The ceremony's bootstrap
/// path uses a separate READ-ONLY function
/// (`db_migration::cli_runtime::read_secret_key_for_migration`)
/// that fail-closes on missing file — because the
/// migration tool MUST NOT create a fresh secret
/// (would silently produce a different v1 key than
/// what the consumer DBs were originally encrypted
/// under).
///
/// **Errors:** `anyhow::Error` with operator-readable
/// context — caller wraps in domain-specific error
/// type if needed.
pub fn read_or_create_v1_secret() -> Result<Vec<u8>> {
    let path_buf: PathBuf = secret_key_path();
    let secret_path: &Path = path_buf.as_path();

    if secret_path.exists() {
        let key = std::fs::read(secret_path).context("Failed to read database secret key")?;
        if key.len() < MIN_SECRET_KEY_LEN {
            anyhow::bail!(
                "Database secret key is too short ({} bytes), expected >= {}",
                key.len(),
                MIN_SECRET_KEY_LEN,
            );
        }
        return Ok(key);
    }

    // Generate a new random key.
    // SEC-LOW-122 (2026-08-23 scan №67): key material from the OS CSPRNG
    // (rand's ThreadRng disclaims CSPRNG suitability for key material).
    let mut key = vec![0u8; 32];
    getrandom::getrandom(&mut key).map_err(|e| anyhow::anyhow!("OS CSPRNG unavailable: {e}"))?;

    if let Some(parent) = secret_path.parent() {
        std::fs::create_dir_all(parent).with_context(|| {
            format!(
                "Failed to create secret-key parent directory {}",
                parent.display()
            )
        })?;
    }

    // Write with restrictive permissions from the start
    // (no TOCTOU race).
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o400)
            .open(secret_path)
        {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                let key = std::fs::read(secret_path)
                    .context("Failed to read database secret key after create race")?;
                if key.len() < MIN_SECRET_KEY_LEN {
                    anyhow::bail!(
                        "Database secret key is too short ({} bytes), expected >= {}",
                        key.len(),
                        MIN_SECRET_KEY_LEN,
                    );
                }
                return Ok(key);
            }
            Err(err) => {
                return Err(err).with_context(|| {
                    format!(
                        "Failed to create database secret key file at {}",
                        secret_path.display()
                    )
                });
            }
        };
        std::io::Write::write_all(&mut file, &key)
            .context("Failed to write database secret key")?;
    }

    #[cfg(not(unix))]
    {
        std::fs::write(secret_path, &key).context("Failed to write database secret key")?;
    }

    tracing::info!(
        "Generated new database secret key at {}",
        secret_path.display()
    );
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Per-module env-mutation serializer (process-wide
    /// global state, parallel tests must not race).
    /// Mirrors `machine_id::tests::ENV_MUTEX`.
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn read_or_create_v1_secret_uses_existing_file_when_present() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        let secret_path = dir.path().join("db.key");
        let canned = vec![0xAAu8; 32];
        std::fs::write(&secret_path, &canned).expect("seed");

        // SAFETY: env-mutation serialized via ENV_MUTEX.
        unsafe {
            std::env::set_var(SECRET_KEY_OVERRIDE_ENV, &secret_path);
        }
        let result = read_or_create_v1_secret();
        unsafe {
            std::env::remove_var(SECRET_KEY_OVERRIDE_ENV);
        }

        let bytes = result.expect("read existing");
        assert_eq!(bytes, canned);
    }

    #[test]
    fn read_or_create_v1_secret_creates_new_random_when_absent() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        let secret_path = dir.path().join("subdir").join("db.key");
        // Note: parent doesn't exist yet — exercise the
        // create_dir_all branch.
        assert!(!secret_path.exists());

        // SAFETY: env-mutation serialized via ENV_MUTEX.
        unsafe {
            std::env::set_var(SECRET_KEY_OVERRIDE_ENV, &secret_path);
        }
        let result = read_or_create_v1_secret();
        unsafe {
            std::env::remove_var(SECRET_KEY_OVERRIDE_ENV);
        }

        let bytes = result.expect("create new");
        assert_eq!(bytes.len(), 32);
        // File now exists on disk.
        assert!(secret_path.exists());
        // Re-reading gets the same bytes.
        let on_disk = std::fs::read(&secret_path).expect("re-read");
        assert_eq!(on_disk, bytes);
    }

    #[test]
    fn read_or_create_v1_secret_rejects_short_existing_file() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        let secret_path = dir.path().join("short.key");
        std::fs::write(&secret_path, b"too-short").expect("seed");

        // SAFETY: env-mutation serialized via ENV_MUTEX.
        unsafe {
            std::env::set_var(SECRET_KEY_OVERRIDE_ENV, &secret_path);
        }
        let result = read_or_create_v1_secret();
        unsafe {
            std::env::remove_var(SECRET_KEY_OVERRIDE_ENV);
        }

        let err = result.expect_err("reject short");
        let msg = format!("{err:#}");
        assert!(
            msg.contains("too short"),
            "expected length error, got: {msg}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn read_or_create_v1_secret_creates_with_0400_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        let secret_path = dir.path().join("created.key");

        // SAFETY: env-mutation serialized via ENV_MUTEX.
        unsafe {
            std::env::set_var(SECRET_KEY_OVERRIDE_ENV, &secret_path);
        }
        let _ = read_or_create_v1_secret().expect("create");
        unsafe {
            std::env::remove_var(SECRET_KEY_OVERRIDE_ENV);
        }

        let metadata = std::fs::metadata(&secret_path).expect("stat");
        let mode = metadata.permissions().mode();
        // 0o400 (read-only owner, no group, no other).
        // Only the lower 9 bits are the perms; mask off
        // the file-type bits.
        assert_eq!(mode & 0o777, 0o400);
    }

    /// The hermeticity guarantee itself: with the
    /// override unset, a TEST build resolves the secret
    /// key inside the process sandbox, never under
    /// `/etc`. This is what makes a test that never
    /// heard of the sandbox pass on an unprivileged CI
    /// runner instead of dying on
    /// `mkdir /etc/suderra: Permission denied`.
    #[test]
    fn test_builds_resolve_the_secret_key_outside_etc() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        // SAFETY: env-mutation serialized via ENV_MUTEX.
        unsafe {
            std::env::remove_var(SECRET_KEY_OVERRIDE_ENV);
        }
        let resolved = secret_key_path();
        assert!(
            resolved.starts_with(std::env::temp_dir()),
            "test-build default must live in the temp sandbox, got {}",
            resolved.display(),
        );
        assert_ne!(resolved, PathBuf::from(DEFAULT_SECRET_KEY_PATH));
    }

    /// The override still wins — production and the
    /// tests that seed their own key file are unchanged.
    #[test]
    fn override_env_still_wins_over_the_default() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        let explicit = dir.path().join("explicit.key");
        // SAFETY: env-mutation serialized via ENV_MUTEX.
        unsafe {
            std::env::set_var(SECRET_KEY_OVERRIDE_ENV, &explicit);
        }
        let resolved = secret_key_path();
        unsafe {
            std::env::remove_var(SECRET_KEY_OVERRIDE_ENV);
        }
        assert_eq!(resolved, explicit);
    }
}
