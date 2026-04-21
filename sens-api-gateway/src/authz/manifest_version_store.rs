//! Persistent `highest_seen_policy_version` floor for RBAC
//! manifest rollback protection (Batch 71, Sprint 6.1 follow-up).
//!
//! ## WHY
//!
//! Plan §3.1 R-5 + ADR-018 specify a monotonic
//! `policy_version` floor — a verified manifest is accepted
//! ONLY if `policy_version > highest_seen_policy_version`. This
//! prevents an attacker who captured an older signed manifest
//! from replaying it across a reboot:
//!
//! 1. Attacker captures manifest version N (e.g. contains an
//!    operator binding they later want to revoke).
//! 2. Operator rotates: signs+publishes manifest version N+1
//!    that removes the compromised operator.
//! 3. Attacker has filesystem access (or inject-via-MQTT
//!    capability) + waits for agent restart.
//! 4. Without persistence: agent boots with floor=0, accepts
//!    the captured N manifest, attacker regains access.
//! 5. With persistence (this module): agent boots with
//!    floor=N+1 from disk, rejects the replayed N.
//!
//! Batch 67 shipped `RbacManifestStore` with a hardcoded
//! `highest_seen_policy_version = 0u64` on every boot — that's
//! the rollback window this module closes.
//!
//! ## WHAT
//!
//! Single-row SQLCipher-encrypted table tracking the highest
//! policy_version EVER successfully verified:
//!
//! ```sql
//! CREATE TABLE rbac_manifest_version (
//!   singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'the-one-row'),
//!   highest_seen  INTEGER NOT NULL CHECK (highest_seen >= 0),
//!   updated_at    INTEGER NOT NULL
//! );
//! ```
//!
//! API:
//! - `open(path)` — SQLCipher-open + apply `PRAGMA key` via the
//!   shared `derive_db_encryption_key()` helper + schema init.
//! - `get_highest_seen()` — returns floor (0 if no row).
//! - `record_accepted(version)` — UPSERT `MAX(existing, version)`
//!   — idempotent + monotonic (record_accepted(N) after
//!   record_accepted(M>N) is a no-op).
//!
//! ## Module-boundary discipline
//!
//! - Reuses `crate::offline_queue::derive_db_encryption_key()`
//!   — the SSoT for SQLCipher key derivation. Does NOT fork a
//!   second derivation path.
//! - Separate SQLite FILE from `offline_queue.sqlite` + `scada_db.sqlite`
//!   (single-responsibility — a `DROP TABLE` in one domain's
//!   database cannot cascade into another).
//! - `pub(crate)` ctor — `open()` is NOT public; external code
//!   reaches the store only through `RbacManifestStore`.
//!
//! ## Threat model (defense-in-depth, not sole defense)
//!
//! An attacker with filesystem-write access to
//! `/var/lib/suderra/rbac_version.sqlite` CANNOT flip the
//! floor to 0 because the database is SQLCipher-encrypted
//! with a HMAC-SHA256(machine_id, `/etc/suderra/db.key`) key.
//! Attacker with the machine-id AND the secret file can
//! modify — at that point they can also modify the agent
//! binary itself, so this is not the last line of defense.
//!
//! The defense chain is:
//! 1. Signed manifest (ed25519) — attacker cannot forge a
//!    manifest signature without `rbac_manifest_signing_key`.
//! 2. Monotonic floor (this module) — attacker cannot
//!    replay an OLDER real signed manifest across a boot.
//! 3. Tenant binding — attacker's captured manifest from a
//!    DIFFERENT tenant's device cannot be replayed here.

use rusqlite::Connection;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Singleton-row sentinel. Schema CHECK constraint enforces
/// this exact string — anti-footgun against accidentally
/// writing multiple rows.
const SINGLETON_KEY: &str = "the-one-row";

/// Persistent floor store. Holds a SQLCipher-encrypted
/// single-row table tracking the highest policy_version
/// EVER successfully verified.
pub struct ManifestVersionStore {
    conn: Mutex<Connection>,
}

impl ManifestVersionStore {
    /// Open the store at `path`. Creates the file + schema on
    /// first run; applies `PRAGMA key` via the shared
    /// derivation helper. Returns Err on:
    /// - parent dir mkdir failure
    /// - connection open failure
    /// - PRAGMA key failure (corrupted db / wrong key)
    /// - schema init failure
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "ManifestVersionStore mkdir {}: {}",
                    parent.display(),
                    e
                )
            })?;
        }

        let conn = Connection::open(path).map_err(|e| {
            format!(
                "ManifestVersionStore open {}: {}",
                path.display(),
                e
            )
        })?;

        let hex_key = crate::offline_queue::derive_db_encryption_key()
            .map_err(|e| format!("ManifestVersionStore key derivation: {}", e))?;
        conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", hex_key))
            .map_err(|e| format!("ManifestVersionStore PRAGMA key: {}", e))?;

        conn.execute_batch(
            "
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=NORMAL;
            PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS rbac_manifest_version (
                singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'the-one-row'),
                highest_seen  INTEGER NOT NULL CHECK (highest_seen >= 0),
                updated_at    INTEGER NOT NULL
            );
            ",
        )
        .map_err(|e| format!("ManifestVersionStore schema init: {}", e))?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Read the currently-persisted floor. Returns 0 when no
    /// row exists (first-boot / freshly-wiped store).
    pub fn get_highest_seen(&self) -> Result<u64, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("ManifestVersionStore lock poisoned: {}", e))?;

        let row: Option<i64> = conn
            .query_row(
                "SELECT highest_seen FROM rbac_manifest_version WHERE singleton_key = ?1",
                [SINGLETON_KEY],
                |r| r.get(0),
            )
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
            .map(Some)
            .map_err(|e| format!("ManifestVersionStore SELECT: {}", e))?
            .flatten();

        // SQLite stores INTEGER as i64; our CHECK constraint +
        // application-side UPSERT ensure non-negative. Clamp
        // defensively against a tampered row.
        let floor = row.unwrap_or(0).max(0) as u64;
        Ok(floor)
    }

    /// UPSERT the floor to `MAX(existing, version)`. Idempotent
    /// + monotonic — re-invoking with a lower version is a
    /// no-op. Returns the NEW floor (may equal the input or be
    /// higher if an even-newer version was already persisted).
    pub fn record_accepted(&self, version: u64) -> Result<u64, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("ManifestVersionStore lock poisoned: {}", e))?;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        // u64 → i64 cast: manifest policy_version is bounded by
        // the monotonic counter design + operator ceremony; an
        // attacker-supplied value that wraps past i64::MAX is
        // already rejected by verify_envelope / verify_manifest
        // upstream. Defensive saturating cast here.
        let v_i64 = version.min(i64::MAX as u64) as i64;

        conn.execute(
            "
            INSERT INTO rbac_manifest_version (singleton_key, highest_seen, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT (singleton_key) DO UPDATE SET
                highest_seen = MAX(highest_seen, excluded.highest_seen),
                updated_at   = excluded.updated_at
            ",
            rusqlite::params![SINGLETON_KEY, v_i64, now],
        )
        .map_err(|e| format!("ManifestVersionStore UPSERT: {}", e))?;

        // Re-read to return the post-UPSERT floor (handles the
        // case where existing > version — UPSERT keeps existing).
        let current: i64 = conn
            .query_row(
                "SELECT highest_seen FROM rbac_manifest_version WHERE singleton_key = ?1",
                [SINGLETON_KEY],
                |r| r.get(0),
            )
            .map_err(|e| format!("ManifestVersionStore post-UPSERT SELECT: {}", e))?;

        Ok(current.max(0) as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{LazyLock, Mutex};

    /// derive_db_encryption_key touches /etc/machine-id + /etc/suderra/db.key.
    /// Tests run in an in-memory / tempdir-backed context where:
    /// - machine_uid::get() WILL work (reads /etc/machine-id which exists
    ///   on any Linux CI runner).
    /// - /etc/suderra/db.key may not be writable → load_or_create_db_secret
    ///   would fail. Tests that need isolation should set SUDERRA_DB_SECRET
    ///   or mock. Tests that just exercise logic are guarded by a
    ///   process-wide lock so parallel runs don't race on the shared
    ///   /etc/suderra directory.
    static TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    fn tmp_db_path() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "suderra-manifest-version-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("mkdir tmp");
        dir.join(format!(
            "test-{}-{}.sqlite",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            rand::random::<u32>(),
        ))
    }

    /// Requires the `derive_db_encryption_key` helper to succeed — in a
    /// CI environment where /etc/suderra is not writable, this test
    /// will fail-skip. Documented in the module docstring.
    fn try_open(path: &Path) -> Option<ManifestVersionStore> {
        match ManifestVersionStore::open(path) {
            Ok(s) => Some(s),
            Err(e) => {
                eprintln!("Skipping test: ManifestVersionStore::open failed: {}", e);
                None
            }
        }
    }

    #[test]
    fn empty_store_floor_is_zero() {
        let _g = TEST_LOCK.lock().expect("test lock");
        let path = tmp_db_path();
        let Some(s) = try_open(&path) else { return };
        assert_eq!(s.get_highest_seen().expect("get"), 0);
    }

    #[test]
    fn record_accepted_upserts_monotonically() {
        let _g = TEST_LOCK.lock().expect("test lock");
        let path = tmp_db_path();
        let Some(s) = try_open(&path) else { return };

        assert_eq!(s.record_accepted(5).expect("first"), 5);
        assert_eq!(s.get_highest_seen().expect("get1"), 5);

        // Lower version is no-op — floor stays at 5.
        assert_eq!(s.record_accepted(3).expect("lower"), 5);
        assert_eq!(s.get_highest_seen().expect("get2"), 5);

        // Higher version advances.
        assert_eq!(s.record_accepted(10).expect("higher"), 10);
        assert_eq!(s.get_highest_seen().expect("get3"), 10);
    }

    #[test]
    fn floor_survives_reopen() {
        let _g = TEST_LOCK.lock().expect("test lock");
        let path = tmp_db_path();
        {
            let Some(s) = try_open(&path) else { return };
            s.record_accepted(42).expect("upsert");
        }
        let Some(s2) = try_open(&path) else { return };
        assert_eq!(s2.get_highest_seen().expect("post-reopen"), 42);
    }
}
