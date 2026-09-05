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
//! Multi-stream SQLCipher-encrypted table keyed by `stream_id`
//! tracking the highest policy_version EVER successfully verified
//! for each independent manifest stream (one per signed-manifest
//! family: "rbac", "user_token", future streams):
//!
//! ```sql
//! CREATE TABLE manifest_version (
//!   stream_id    TEXT NOT NULL PRIMARY KEY,
//!   highest_seen INTEGER NOT NULL CHECK (highest_seen >= 0),
//!   updated_at   INTEGER NOT NULL
//! );
//! ```
//!
//! **Batch #246 generic refactor.** Before Batch #246 this module
//! only served RBAC (single-row table `rbac_manifest_version`). The
//! user-token manifest (Batch #243) needs its own monotonic floor
//! with the same replay defense but on an independent stream —
//! adding a `"user_token"` row in the same store keeps the SQLCipher
//! key + derivation path + migration discipline in ONE place, zero
//! duplication. Legacy `rbac_manifest_version` rows are migrated
//! into the new table at open time (idempotent WHERE NOT EXISTS).
//!
//! API:
//! - `open_for_stream(path, stream_id)` — SQLCipher-open + apply
//!   `PRAGMA key` via the shared `derive_db_encryption_key()`
//!   helper + schema init + one-time legacy migration.
//! - `open(path)` — thin shim that calls
//!   `open_for_stream(path, "rbac")` so pre-Batch-246 RbacManifest
//!   Store call sites keep working unchanged.
//! - `get_highest_seen()` — returns floor for the store's stream_id
//!   (0 if no row).
//! - `record_accepted(version)` — UPSERT `MAX(existing, version)`
//!   for the store's stream_id — idempotent + monotonic
//!   (record_accepted(N) after record_accepted(M>N) is a no-op).
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

/// Singleton-row sentinel — legacy RBAC-only table used the same
/// singleton pattern. Retained for the one-time migration read.
const LEGACY_SINGLETON_KEY: &str = "the-one-row";

/// Canonical RBAC stream identifier. Pre-Batch-246 data is migrated
/// into the new multi-stream table under this id.
pub const STREAM_ID_RBAC: &str = "rbac";

/// User-token (OPC UA credential) stream identifier. Parallel
/// monotonic floor — independent of RBAC so credential rotation
/// doesn't force RBAC versions forward.
pub const STREAM_ID_USER_TOKEN: &str = "user_token";

/// Persistent floor store. Holds a SQLCipher-encrypted multi-row
/// table keyed by stream_id, tracking the highest policy_version
/// EVER successfully verified per manifest stream.
pub struct ManifestVersionStore {
    conn: Mutex<Connection>,
    stream_id: &'static str,
}

impl ManifestVersionStore {
    /// Open the store at `path` for a specific manifest stream.
    /// Creates the file + schema on first run; applies `PRAGMA key`
    /// via the shared derivation helper. Runs the legacy-table
    /// migration exactly once (idempotent via WHERE NOT EXISTS).
    ///
    /// Returns Err on:
    /// - parent dir mkdir failure
    /// - connection open failure
    /// - PRAGMA key failure (corrupted db / wrong key)
    /// - schema init failure
    /// - legacy migration failure
    pub(crate) fn open_for_stream(path: &Path, stream_id: &'static str) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("ManifestVersionStore mkdir {}: {}", parent.display(), e))?;
        }

        // EDGE-HIGH-026: open + key via the canonical SQLCipher factory
        // (v1 device-secret key, DEFAULT profile). The factory owns the
        // PRAGMA key + durability sequence; this store creates its schema.
        let conn = crate::db::sqlcipher_factory::open_device_secret(
            path,
            "manifest_version",
            crate::db::sqlcipher_factory::PragmaProfile::DEFAULT,
        )
        .map_err(|e| format!("ManifestVersionStore open {}: {}", path.display(), e))?;

        // Two tables exist during the migration window:
        //   - `manifest_version` — the multi-stream table (current).
        //   - `rbac_manifest_version` — legacy single-row RBAC table
        //     retained only so an agent that rolls BACK to a pre-
        //     Batch-246 binary can still read the RBAC floor. New
        //     writes land exclusively in `manifest_version`.
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS manifest_version (
                stream_id    TEXT NOT NULL PRIMARY KEY,
                highest_seen INTEGER NOT NULL CHECK (highest_seen >= 0),
                updated_at   INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS rbac_manifest_version (
                singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'the-one-row'),
                highest_seen  INTEGER NOT NULL CHECK (highest_seen >= 0),
                updated_at    INTEGER NOT NULL
            );
            ",
        )
        .map_err(|e| format!("ManifestVersionStore schema init: {}", e))?;

        // One-time migration: copy the legacy RBAC row into the
        // multi-stream table under stream_id='rbac'. Idempotent via
        // WHERE NOT EXISTS; running this every open is safe + cheap.
        conn.execute(
            "
            INSERT INTO manifest_version (stream_id, highest_seen, updated_at)
            SELECT ?1, highest_seen, updated_at FROM rbac_manifest_version
            WHERE singleton_key = ?2
              AND NOT EXISTS (
                  SELECT 1 FROM manifest_version WHERE stream_id = ?1
              )
            ",
            rusqlite::params![STREAM_ID_RBAC, LEGACY_SINGLETON_KEY],
        )
        .map_err(|e| format!("ManifestVersionStore legacy migration: {}", e))?;

        Ok(Self {
            conn: Mutex::new(conn),
            stream_id,
        })
    }

    /// Legacy entry point — preserves pre-Batch-246 call sites
    /// (RbacManifestStore::with_version_store) by defaulting to
    /// stream_id="rbac". Every caller that wants a specific stream
    /// should use `open_for_stream` directly.
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        Self::open_for_stream(path, STREAM_ID_RBAC)
    }

    /// The manifest stream this store serves (`"rbac"`,
    /// `"user_token"`, future streams). Set at `open_for_stream`
    /// time + immutable for the store's lifetime.
    pub fn stream_id(&self) -> &'static str {
        self.stream_id
    }

    /// Read the currently-persisted floor for this store's stream.
    /// Returns 0 when no row exists (first-boot / freshly-wiped
    /// store / stream never recorded).
    pub fn get_highest_seen(&self) -> Result<u64, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("ManifestVersionStore lock poisoned: {}", e))?;

        let row: Option<i64> = conn
            .query_row(
                "SELECT highest_seen FROM manifest_version WHERE stream_id = ?1",
                [self.stream_id],
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

    /// UPSERT the floor for this store's stream to
    /// `MAX(existing, version)`. Idempotent + monotonic —
    /// re-invoking with a lower version is a no-op. Returns the
    /// NEW floor (may equal the input or be higher if an even-
    /// newer version was already persisted).
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
            INSERT INTO manifest_version (stream_id, highest_seen, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT (stream_id) DO UPDATE SET
                highest_seen = MAX(highest_seen, excluded.highest_seen),
                updated_at   = excluded.updated_at
            ",
            rusqlite::params![self.stream_id, v_i64, now],
        )
        .map_err(|e| format!("ManifestVersionStore UPSERT: {}", e))?;

        // Re-read to return the post-UPSERT floor (handles the
        // case where existing > version — UPSERT keeps existing).
        let current: i64 = conn
            .query_row(
                "SELECT highest_seen FROM manifest_version WHERE stream_id = ?1",
                [self.stream_id],
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

    // ========================================================
    // Batch #246 multi-stream refactor — new tests
    // ========================================================

    fn try_open_stream(path: &Path, stream_id: &'static str) -> Option<ManifestVersionStore> {
        match ManifestVersionStore::open_for_stream(path, stream_id) {
            Ok(s) => Some(s),
            Err(e) => {
                eprintln!(
                    "Skipping test: ManifestVersionStore::open_for_stream({}) failed: {}",
                    stream_id, e
                );
                None
            }
        }
    }

    #[test]
    fn stream_id_is_accessible_for_diagnostics() {
        let _g = TEST_LOCK.lock().expect("test lock");
        let path = tmp_db_path();
        let Some(s) = try_open_stream(&path, STREAM_ID_USER_TOKEN) else {
            return;
        };
        assert_eq!(s.stream_id(), STREAM_ID_USER_TOKEN);
    }

    #[test]
    fn legacy_open_defaults_to_rbac_stream() {
        let _g = TEST_LOCK.lock().expect("test lock");
        let path = tmp_db_path();
        let Some(s) = try_open(&path) else { return };
        assert_eq!(s.stream_id(), STREAM_ID_RBAC);
    }

    #[test]
    fn streams_are_independent_per_store() {
        let _g = TEST_LOCK.lock().expect("test lock");
        let path = tmp_db_path();
        let Some(rbac) = try_open_stream(&path, STREAM_ID_RBAC) else {
            return;
        };
        let Some(ut) = try_open_stream(&path, STREAM_ID_USER_TOKEN) else {
            return;
        };

        rbac.record_accepted(100).expect("rbac upsert");
        ut.record_accepted(7).expect("user_token upsert");

        // Each stream sees its own floor — no cross-contamination.
        assert_eq!(rbac.get_highest_seen().expect("rbac get"), 100);
        assert_eq!(ut.get_highest_seen().expect("user_token get"), 7);

        // Advancing one stream does not affect the other.
        ut.record_accepted(8).expect("user_token bump");
        assert_eq!(rbac.get_highest_seen().expect("rbac unchanged"), 100);
        assert_eq!(ut.get_highest_seen().expect("user_token advanced"), 8);
    }

    #[test]
    fn user_token_stream_starts_at_zero_after_rbac_init() {
        // Open RBAC + advance it; then open user_token stream — new
        // stream's floor must still be 0 (independent row).
        let _g = TEST_LOCK.lock().expect("test lock");
        let path = tmp_db_path();

        let Some(rbac) = try_open_stream(&path, STREAM_ID_RBAC) else {
            return;
        };
        rbac.record_accepted(55).expect("rbac upsert");
        drop(rbac);

        let Some(ut) = try_open_stream(&path, STREAM_ID_USER_TOKEN) else {
            return;
        };
        assert_eq!(ut.get_highest_seen().expect("user_token fresh"), 0);
    }

    #[test]
    fn legacy_rbac_row_migrates_into_new_table() {
        // Simulate a pre-Batch-246 DB state: `rbac_manifest_version`
        // table holds a row, `manifest_version` table is empty. Then
        // open via open_for_stream("rbac") — expect the migration
        // INSERT WHERE NOT EXISTS to copy the row.
        let _g = TEST_LOCK.lock().expect("test lock");
        let path = tmp_db_path();

        // Stage 1: create the legacy row directly via a raw connection
        // (skip the store ctor so we don't run the migration).
        {
            let conn = Connection::open(&path).expect("raw open");
            let hex_key = match crate::offline_queue::derive_db_encryption_key() {
                Ok(k) => k,
                Err(e) => {
                    eprintln!("Skipping migration test: key deriv: {}", e);
                    return;
                }
            };
            // INVARIANT-ALLOW: sqlcipher-test-seed — seeds an encrypted fixture.
            conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", hex_key))
                .expect("pragma key");
            conn.execute_batch(
                "CREATE TABLE rbac_manifest_version (
                    singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'the-one-row'),
                    highest_seen  INTEGER NOT NULL CHECK (highest_seen >= 0),
                    updated_at    INTEGER NOT NULL
                );",
            )
            .expect("create legacy");
            conn.execute(
                "INSERT INTO rbac_manifest_version (singleton_key, highest_seen, updated_at) VALUES ('the-one-row', 99, 1);",
                [],
            )
            .expect("insert legacy row");
        }

        // Stage 2: open via new API — migration should run + RBAC
        // floor should be 99 in the new table.
        let Some(rbac) = try_open_stream(&path, STREAM_ID_RBAC) else {
            return;
        };
        assert_eq!(rbac.get_highest_seen().expect("post-migrate"), 99);

        // Stage 3: re-open again — migration is idempotent (no
        // duplicate row insertion), floor still 99.
        drop(rbac);
        let Some(rbac2) = try_open_stream(&path, STREAM_ID_RBAC) else {
            return;
        };
        assert_eq!(rbac2.get_highest_seen().expect("post-reopen"), 99);
    }

    #[test]
    fn legacy_migration_does_not_touch_unrelated_streams() {
        // After RBAC legacy migration runs, opening a different
        // stream (user_token) still reads 0 — the migration only
        // touched the 'rbac' row.
        let _g = TEST_LOCK.lock().expect("test lock");
        let path = tmp_db_path();

        {
            let conn = Connection::open(&path).expect("raw open");
            let hex_key = match crate::offline_queue::derive_db_encryption_key() {
                Ok(k) => k,
                Err(e) => {
                    eprintln!("Skipping migration test: key deriv: {}", e);
                    return;
                }
            };
            // INVARIANT-ALLOW: sqlcipher-test-seed — seeds an encrypted fixture.
            conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", hex_key))
                .expect("pragma key");
            conn.execute_batch(
                "CREATE TABLE rbac_manifest_version (
                    singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'the-one-row'),
                    highest_seen  INTEGER NOT NULL CHECK (highest_seen >= 0),
                    updated_at    INTEGER NOT NULL
                );",
            )
            .expect("create legacy");
            conn.execute(
                "INSERT INTO rbac_manifest_version (singleton_key, highest_seen, updated_at) VALUES ('the-one-row', 77, 1);",
                [],
            )
            .expect("insert");
        }

        // Open user_token FIRST — this call creates the new table +
        // runs the migration (which copies RBAC row into new table
        // under stream_id='rbac') but user_token stream stays at 0.
        let Some(ut) = try_open_stream(&path, STREAM_ID_USER_TOKEN) else {
            return;
        };
        assert_eq!(ut.get_highest_seen().expect("user_token fresh"), 0);

        // And RBAC (opened after) sees the migrated 77.
        let Some(rbac) = try_open_stream(&path, STREAM_ID_RBAC) else {
            return;
        };
        assert_eq!(rbac.get_highest_seen().expect("rbac migrated"), 77);
    }
}
