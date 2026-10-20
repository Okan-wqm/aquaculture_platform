//! The SQLCipher device secret (ADR-048 DEC-4.8) — PR-195 Batch #14 SSoT,
//! reworked for the agent filesystem contract (EDGE-CRITICAL-047,
//! EDGE-CRITICAL-048, EDGE-MEDIUM-080).
//!
//! ## What this module owns
//!
//! * **Where the secret lives** ([`secret_key_path`]) — every reader goes
//!   through it: the read-or-create below, the read-only migration ceremony
//!   (`db_migration::cli_runtime`), the SQLCipher factory. No consumer can
//!   invent a second answer.
//! * **How it is created** ([`read_or_create_v1_secret`]) — 256 random bits
//!   from the OS CSPRNG, written under a temporary name with mode 0400,
//!   fsynced, published with a no-clobber `link(2)` and the directory
//!   fsynced, so a power cut leaves either no secret or a complete one,
//!   never a torn or empty file that would brick every database
//!   (EDGE-MEDIUM-080), and two racing creators agree on one secret.
//! * **The message half of the v1 key derivation** ([`v1_binding`]) — the
//!   bytes HMAC-SHA256(secret, ·) is computed over
//!   (`db_migration::v1_legacy_key`).
//!
//! ## Profiles
//!
//! * **suderra-os** — the secret is `/var/lib/suderra/secrets/db.key`, in the
//!   agent's own 0700 secrets directory that the OS creates before the unit
//!   starts (mutable-state.json, DEC-4.3); the agent creates the file on its
//!   first start and never writes under `/etc` (EDGE-CRITICAL-047). The
//!   derivation does not use `/etc/machine-id`: on the read-only verity root
//!   systemd generates a transient machine-id every boot and per A/B slot,
//!   which would make every database unreadable after a reboot
//!   (EDGE-CRITICAL-048), and machine-id is not secret anyway. The binding is
//!   a fixed domain-separation label; the key's only secret input is the
//!   random device secret on the (LUKS-encrypted) data partition.
//! * **generic** (DEC-28, HC-1) — `SUDERRA_DB_KEY_PATH` when set; else the
//!   agent's `$DATA/secrets/db.key` when it exists; else the v1.6.0 fleet's
//!   `/etc/suderra/db.key` when *that* exists (read, never created — the
//!   contract's generic unit mounts `/etc/suderra` read-only); else a new
//!   secret is created at `$DATA/secrets/db.key`. The binding stays the
//!   machine-id, so existing databases keep opening; their one-time v1→v2
//!   rekey is the `--migrate-db` ceremony (DEC-4.8).
//!
//! A TEST build resolves a per-process temp sandbox instead of the profile
//! default, so no in-crate test can reach `/etc` or `/var/lib` through this
//! resolver whether or not its author remembered to ask (see
//! [`test_sandbox`]).

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// Env var name of the generic profile's override (read through
/// `crate::generic_env`). Kept here for the test modules that set it.
#[cfg(all(test, not(feature = "suderra-os")))]
pub const SECRET_KEY_OVERRIDE_ENV: &str = crate::generic_env::DB_KEY_PATH_VAR;

/// Minimum acceptable secret-key length in bytes. A shorter file is a torn
/// or foreign file, never a secret this module wrote.
pub const MIN_SECRET_KEY_LEN: usize = 16;

/// Length of a secret this module creates: 256 bits (DEC-4.8).
const SECRET_KEY_LEN: usize = 32;

/// The v1 derivation's message input in the Suderra OS profile: a fixed
/// domain-separation label in place of the machine-id (DEC-4.8). Changing it
/// changes every database key of the profile.
#[cfg(feature = "suderra-os")]
pub const SUDERRA_OS_V1_BINDING: &[u8] = b"suderra-os/sqlcipher-device-secret/v1";

/// Resolve the file the v1 secret-key lives in. THE resolver — see the
/// module documentation for the per-profile answer.
#[cfg(not(test))]
pub fn secret_key_path() -> PathBuf {
    resolve_for(crate::paths::AgentPaths::current())
}

/// Test builds: the generic override when a test set it (read fresh, so a
/// test can point one call at its own file), else the per-process sandbox.
#[cfg(test)]
pub fn secret_key_path() -> PathBuf {
    #[cfg(not(feature = "suderra-os"))]
    if let Some(explicit) = crate::generic_env::db_key_path() {
        return explicit;
    }
    test_sandbox::path()
}

/// Where a missing secret is created: the agent's own secrets file (or the
/// generic operator override). Never the legacy `/etc` file — the
/// resolver may *read* that one, but nothing here creates under `/etc`
/// (DEC-4.1), even if the legacy file vanishes between resolution and read.
#[cfg(not(test))]
fn secret_creation_path() -> PathBuf {
    let paths = crate::paths::AgentPaths::current();
    #[cfg(not(feature = "suderra-os"))]
    if let Some(explicit) = paths.db_key_override() {
        return explicit.to_path_buf();
    }
    paths.db_key_file()
}

/// Test builds create where they resolve: the override or the sandbox.
#[cfg(test)]
fn secret_creation_path() -> PathBuf {
    secret_key_path()
}

/// The profile's answer for the given paths.
#[cfg(all(not(test), feature = "suderra-os"))]
fn resolve_for(paths: &crate::paths::AgentPaths) -> PathBuf {
    paths.db_key_file()
}

/// The profile's answer for the given paths.
#[cfg(all(not(test), not(feature = "suderra-os")))]
fn resolve_for(paths: &crate::paths::AgentPaths) -> PathBuf {
    choose_generic_secret_path(
        paths.db_key_override(),
        paths.db_key_file(),
        paths.legacy_db_key_file(),
    )
}

/// The generic profile's precedence over explicit candidates: the operator
/// override; the agent's own secret once it exists; the v1.6.0 fleet's
/// legacy secret when present; else the agent's location, to be created.
/// Once the agent's own secret exists it always wins, so the answer never
/// flips back to the legacy file.
#[cfg(not(feature = "suderra-os"))]
fn choose_generic_secret_path(
    explicit: Option<&Path>,
    current: PathBuf,
    legacy: PathBuf,
) -> PathBuf {
    if let Some(explicit) = explicit {
        return explicit.to_path_buf();
    }
    if current.exists() {
        return current;
    }
    if legacy.exists() {
        return legacy;
    }
    current
}

/// The single sandbox location for the whole test binary. One owner, so no
/// test module can seed a second path that races the process-wide
/// `OnceLock` latch in `offline_queue::derive_db_encryption_key`.
#[cfg(test)]
pub(crate) mod test_sandbox {
    use std::path::PathBuf;
    use std::sync::LazyLock;

    static PATH: LazyLock<PathBuf> = LazyLock::new(|| {
        let dir = std::env::temp_dir().join(format!("suderra-db-key-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir test key sandbox");
        dir.join("db.key")
    });

    /// Path only — the file is created by `read_or_create_v1_secret` on
    /// first use, so the read-only migration path still observes a genuine
    /// missing-file when nothing has seeded it.
    pub(crate) fn path() -> PathBuf {
        PATH.clone()
    }
}

/// The message half of the v1 device-secret key derivation.
///
/// Generic: the machine-id (HC-1 — the v1.6.0 fleet's databases are keyed
/// under it). Suderra OS: [`SUDERRA_OS_V1_BINDING`]; no machine-id is read
/// in that profile (`src/machine_id.rs` is not compiled there).
#[cfg(not(feature = "suderra-os"))]
pub fn v1_binding() -> Result<Vec<u8>> {
    crate::machine_id::read().map(String::into_bytes)
}

/// See the generic variant.
#[cfg(feature = "suderra-os")]
pub fn v1_binding() -> Result<Vec<u8>> {
    Ok(SUDERRA_OS_V1_BINDING.to_vec())
}

/// Read the v1 SQLCipher device secret, creating it on first use.
///
/// An existing file is returned as-is after a length check. A missing file
/// is created as described in the module documentation.
///
/// **Migration ceremony note:** this is the READ-OR-CREATE function. The
/// ceremony uses a separate READ-ONLY reader
/// (`db_migration::cli_runtime::read_secret_key_for_migration`) that
/// fail-closes on a missing file, because the migration tool MUST NOT
/// create a fresh secret (it would silently produce a different key than
/// the one the consumer databases were encrypted under).
pub fn read_or_create_v1_secret() -> Result<Vec<u8>> {
    match read_existing(&secret_key_path())? {
        Some(key) => Ok(key),
        None => create_secret_at(&secret_creation_path()),
    }
}

/// Read-or-create against one explicit file.
#[cfg(test)]
fn read_or_create_secret_at(secret_path: &Path) -> Result<Vec<u8>> {
    match read_existing(secret_path)? {
        Some(key) => Ok(key),
        None => create_secret_at(secret_path),
    }
}

/// Read an existing secret; `None` when the file does not exist.
fn read_existing(secret_path: &Path) -> Result<Option<Vec<u8>>> {
    match std::fs::read(secret_path) {
        Ok(key) => checked(secret_path, key).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| {
            format!(
                "Failed to read database secret key {}",
                secret_path.display()
            )
        }),
    }
}

/// Length-check a secret read from `path`.
fn checked(path: &Path, key: Vec<u8>) -> Result<Vec<u8>> {
    if key.len() < MIN_SECRET_KEY_LEN {
        anyhow::bail!(
            "Database secret key {} is too short ({} bytes), expected >= {}",
            path.display(),
            key.len(),
            MIN_SECRET_KEY_LEN,
        );
    }
    Ok(key)
}

/// Serializes creators inside this process. Several subsystems open their
/// SQLCipher stores concurrently at boot, and the temporary name below is
/// per process; across processes the no-clobber `link(2)` decides.
static CREATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Create a fresh secret at `secret_path`, or return the one a concurrent
/// creator published first.
fn create_secret_at(secret_path: &Path) -> Result<Vec<u8>> {
    // A poisoned lock only means another creator panicked; the filesystem
    // steps below are idempotent, so the guard is still sound to take.
    let _creating = CREATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // Another thread may have published while this one waited.
    if let Some(existing) = read_existing(secret_path)? {
        return Ok(existing);
    }

    // SEC-LOW-122 (2026-08-23 scan №67): key material from the OS CSPRNG
    // (rand's ThreadRng disclaims CSPRNG suitability for key material).
    let mut key = vec![0u8; SECRET_KEY_LEN];
    getrandom::getrandom(&mut key).map_err(|e| anyhow::anyhow!("OS CSPRNG unavailable: {e}"))?;

    let parent = secret_path.parent().ok_or_else(|| {
        anyhow::anyhow!(
            "Database secret key path {} has no parent directory",
            secret_path.display()
        )
    })?;
    ensure_secrets_dir(parent)?;

    let tmp_path = parent.join(format!(
        ".{}.tmp-{}",
        secret_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "db.key".to_string()),
        std::process::id()
    ));
    // Under CREATE_LOCK a temporary with this process's name is never in
    // flight: it is a leftover of an earlier crash under the same pid
    // number, never a published secret; drop it so create_new can proceed.
    match std::fs::remove_file(&tmp_path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(e).with_context(|| {
                format!(
                    "Failed to clear stale secret temporary {}",
                    tmp_path.display()
                )
            });
        }
    }

    write_secret_temp(&tmp_path, &key)?;

    // Publish without clobbering: link(2) fails with EEXIST when another
    // creator won the race, and then its secret is the one every consumer
    // must use.
    let published = std::fs::hard_link(&tmp_path, secret_path);
    let removed = std::fs::remove_file(&tmp_path);
    match published {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let existing = std::fs::read(secret_path).with_context(|| {
                format!(
                    "Failed to read database secret key {} after create race",
                    secret_path.display()
                )
            })?;
            return checked(secret_path, existing);
        }
        Err(e) => {
            return Err(e).with_context(|| {
                format!(
                    "Failed to publish database secret key at {}",
                    secret_path.display()
                )
            });
        }
    }
    removed.with_context(|| {
        format!(
            "Failed to remove secret temporary {} after publishing",
            tmp_path.display()
        )
    })?;
    sync_dir(parent)?;

    tracing::info!(
        "Generated new database secret key at {}",
        secret_path.display()
    );
    Ok(key)
}

/// Write `key` to a fresh `tmp_path` with mode 0400 and fsync it.
#[cfg(unix)]
fn write_secret_temp(tmp_path: &Path, key: &[u8]) -> Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o400)
        .open(tmp_path)
        .with_context(|| format!("Failed to create secret temporary {}", tmp_path.display()))?;
    file.write_all(key)
        .with_context(|| format!("Failed to write secret temporary {}", tmp_path.display()))?;
    file.sync_all()
        .with_context(|| format!("Failed to fsync secret temporary {}", tmp_path.display()))
}

/// Write `key` to a fresh `tmp_path` and fsync it.
#[cfg(not(unix))]
fn write_secret_temp(tmp_path: &Path, key: &[u8]) -> Result<()> {
    use std::io::Write as _;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(tmp_path)
        .with_context(|| format!("Failed to create secret temporary {}", tmp_path.display()))?;
    file.write_all(key)
        .with_context(|| format!("Failed to write secret temporary {}", tmp_path.display()))?;
    file.sync_all()
        .with_context(|| format!("Failed to fsync secret temporary {}", tmp_path.display()))
}

/// Make sure the secrets directory exists.
///
/// Suderra OS: the OS creates `secrets/` (0700) before the unit starts and
/// the agent never creates its contract directories (DEC-4.11); a missing
/// one is reported, not repaired. Generic: created with mode 0700 when
/// absent (the generic unit owns the data root).
#[cfg(feature = "suderra-os")]
fn ensure_secrets_dir(dir: &Path) -> Result<()> {
    if dir.is_dir() {
        Ok(())
    } else {
        anyhow::bail!(
            "secrets directory {} does not exist; the OS creates it before the agent \
             starts (ADR-048 DEC-4.3, DEC-4.11)",
            dir.display()
        )
    }
}

/// See the Suderra OS variant.
#[cfg(not(feature = "suderra-os"))]
fn ensure_secrets_dir(dir: &Path) -> Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    #[cfg(unix)]
    let created = {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
    };
    #[cfg(not(unix))]
    let created = std::fs::create_dir_all(dir);
    created.with_context(|| {
        format!(
            "Failed to create secret-key parent directory {}",
            dir.display()
        )
    })
}

/// fsync a directory so a rename/link inside it survives a power cut.
#[cfg(unix)]
fn sync_dir(dir: &Path) -> Result<()> {
    std::fs::File::open(dir)
        .and_then(|d| d.sync_all())
        .with_context(|| format!("Failed to fsync directory {}", dir.display()))
}

/// Directories cannot be fsynced portably off Unix.
#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_secret_is_returned_unchanged() {
        let dir = tempfile::tempdir().expect("tempdir");
        let secret_path = dir.path().join("db.key");
        let canned = vec![0xAAu8; 32];
        std::fs::write(&secret_path, &canned).expect("seed");
        assert_eq!(
            read_or_create_secret_at(&secret_path).expect("read"),
            canned
        );
    }

    #[test]
    fn missing_secret_is_created_once_and_then_reused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let secret_path = dir.path().join("db.key");
        let created = read_or_create_secret_at(&secret_path).expect("create");
        assert_eq!(created.len(), 32);
        assert_eq!(std::fs::read(&secret_path).expect("re-read"), created);
        assert_eq!(
            read_or_create_secret_at(&secret_path).expect("reuse"),
            created
        );
        // No temporary is left behind next to the published secret.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .expect("ls")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != "db.key")
            .collect();
        assert!(leftovers.is_empty(), "leftover files: {leftovers:?}");
    }

    #[test]
    fn short_secret_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let secret_path = dir.path().join("short.key");
        std::fs::write(&secret_path, b"too-short").expect("seed");
        let err = read_or_create_secret_at(&secret_path).expect_err("reject short");
        assert!(format!("{err:#}").contains("too short"), "{err:#}");
    }

    /// EDGE-MEDIUM-080: an empty file (the torn write the old
    /// create_new + write_all could leave) is refused, not used as a key.
    #[test]
    fn empty_secret_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let secret_path = dir.path().join("db.key");
        std::fs::write(&secret_path, b"").expect("seed");
        assert!(read_or_create_secret_at(&secret_path).is_err());
    }

    /// Concurrent first use inside one process (several stores opening at
    /// boot) agrees on one secret instead of colliding on the temporary.
    #[test]
    fn concurrent_creators_in_one_process_agree_on_one_secret() {
        let dir = tempfile::tempdir().expect("tempdir");
        let secret_path = dir.path().join("db.key");
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let p = secret_path.clone();
                std::thread::spawn(move || read_or_create_secret_at(&p))
            })
            .collect();
        let keys: Vec<Vec<u8>> = handles
            .into_iter()
            .map(|h| h.join().expect("join").expect("create"))
            .collect();
        let first = keys.first().expect("one key").clone();
        assert!(keys.iter().all(|k| *k == first), "creators disagreed");
        assert_eq!(std::fs::read(&secret_path).expect("read"), first);
    }

    #[test]
    fn a_secret_published_by_a_racing_creator_wins() {
        let dir = tempfile::tempdir().expect("tempdir");
        let secret_path = dir.path().join("db.key");
        let winner = vec![0x5Au8; 32];
        std::fs::write(&secret_path, &winner).expect("seed winner");
        // create_secret_at is what a creator that lost the race runs.
        assert_eq!(create_secret_at(&secret_path).expect("race"), winner);
        assert_eq!(std::fs::read(&secret_path).expect("read"), winner);
    }

    #[cfg(unix)]
    #[test]
    fn created_secret_is_mode_0400() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let secret_path = dir.path().join("created.key");
        read_or_create_secret_at(&secret_path).expect("create");
        let mode = std::fs::metadata(&secret_path)
            .expect("stat")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o400);
    }

    /// The hermeticity guarantee itself: with no override, a TEST build
    /// resolves the secret inside the process sandbox, never under `/etc` or
    /// `/var/lib`.
    #[test]
    fn test_builds_resolve_the_secret_key_into_the_sandbox() {
        #[cfg(not(feature = "suderra-os"))]
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        #[cfg(not(feature = "suderra-os"))]
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
    }

    /// EDGE-CRITICAL-048: the Suderra OS derivation never reads the
    /// machine-id; its binding is the fixed label.
    #[cfg(feature = "suderra-os")]
    #[test]
    fn suderra_os_binding_is_the_fixed_label_not_a_machine_id() {
        assert_eq!(
            v1_binding().expect("binding"),
            SUDERRA_OS_V1_BINDING.to_vec()
        );
    }

    /// EDGE-CRITICAL-047: the Suderra OS secret lives in the agent's own
    /// secrets directory of the contract, never under `/etc`.
    #[cfg(feature = "suderra-os")]
    #[test]
    fn suderra_os_secret_lives_in_the_agent_secrets_dir() {
        assert_eq!(
            crate::paths::AgentPaths::suderra_os().db_key_file(),
            Path::new("/var/lib/suderra/secrets/db.key")
        );
    }

    /// Suderra OS never creates its contract directories: a missing
    /// secrets/ is an error, not something to repair.
    #[cfg(feature = "suderra-os")]
    #[test]
    fn suderra_os_does_not_create_a_missing_secrets_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let secret_path = dir.path().join("secrets").join("db.key");
        let err = read_or_create_secret_at(&secret_path).expect_err("must refuse");
        assert!(format!("{err:#}").contains("does not exist"), "{err:#}");
        assert!(!dir.path().join("secrets").exists());
    }

    #[cfg(not(feature = "suderra-os"))]
    static ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[cfg(not(feature = "suderra-os"))]
    #[test]
    fn generic_creates_a_missing_secrets_dir_0700() {
        let dir = tempfile::tempdir().expect("tempdir");
        let secret_path = dir.path().join("secrets").join("db.key");
        read_or_create_secret_at(&secret_path).expect("create");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("secrets"))
                .expect("stat")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o700);
        }
    }

    /// The generic override still wins in a test build.
    #[cfg(not(feature = "suderra-os"))]
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

    /// Generic precedence: override, then the agent's own secret once it
    /// exists, then the v1.6.0 fleet's legacy secret, then the agent's
    /// location to be created — never a new file under `/etc`.
    #[cfg(not(feature = "suderra-os"))]
    #[test]
    fn generic_secret_precedence() {
        let dir = tempfile::tempdir().expect("tempdir");
        let current = dir.path().join("data").join("secrets").join("db.key");
        let legacy = dir.path().join("etc").join("db.key");
        let explicit = dir.path().join("explicit.key");

        // Nothing exists yet: the agent's location, to be created.
        assert_eq!(
            choose_generic_secret_path(None, current.clone(), legacy.clone()),
            current
        );
        // A v1.6.0 device: the legacy secret is read in place.
        std::fs::create_dir_all(legacy.parent().expect("parent")).expect("mkdir");
        std::fs::write(&legacy, [0x11u8; 32]).expect("seed legacy");
        assert_eq!(
            choose_generic_secret_path(None, current.clone(), legacy.clone()),
            legacy
        );
        // Once the agent's own secret exists it wins for good.
        std::fs::create_dir_all(current.parent().expect("parent")).expect("mkdir");
        std::fs::write(&current, [0x22u8; 32]).expect("seed current");
        assert_eq!(
            choose_generic_secret_path(None, current.clone(), legacy.clone()),
            current
        );
        // The operator override beats both.
        assert_eq!(
            choose_generic_secret_path(Some(&explicit), current, legacy),
            explicit
        );
    }
}
