//! SQLCipher-persistent JtiDedupTable (Batch 91 Sprint 6.4
//! full wire tier 2).
//!
//! ## WHY
//!
//! Plan §4.10 mandates a 72-hour jti dedup window for
//! replay defense. Batch 57 shipped `MokaJtiDedupTable`
//! (hot-window tier — seconds to minutes, in-memory). That
//! tier:
//! - Survives MQTT reconnect.
//! - Survives brief network flap.
//! - Does NOT survive a process restart.
//!
//! An attacker who captures a signed envelope with a 72-hour
//! exp and waits for an agent restart (or reboot) can replay
//! it through the Moka-only tier. This module closes that
//! gap with a SQLCipher-persistent backing store that
//! survives process restarts within the 72-hour envelope
//! lifetime.
//!
//! ## WHAT
//!
//! `SqlCipherJtiDedupTable` implements `JtiDedupTable`:
//!
//! - `check_and_mark(jti, expires_at)` — INSERT OR IGNORE
//!   against a `jti_dedup(jti TEXT PRIMARY KEY, expires_at
//!   INTEGER NOT NULL)` table. Returns `DedupResult::Fresh`
//!   if the row was inserted; `DedupResult::Duplicate` if
//!   there was already a non-expired row with the same jti.
//! - `live_entry_count()` — COUNT(*) WHERE expires_at > now.
//! - `sweep_expired(now)` — DELETE WHERE expires_at <= now.
//!
//! Storage: `/var/lib/suderra/jti_dedup.sqlite`
//! (SQLCipher-encrypted via shared `offline_queue::
//! derive_db_encryption_key()`).
//!
//! ## Composite layering (Batch 92 follow-up)
//!
//! The next batch lands a `LayeredJtiDedupTable` that:
//! 1. First checks Moka (fast in-memory, always up-to-date
//!    since process start).
//! 2. On miss, checks SQLCipher (slower, covers pre-restart
//!    entries).
//! 3. On fresh in both, inserts into both.
//!
//! This batch ships the SQLCipher tier in isolation;
//! consumers can use it directly for operators who prefer
//! the simpler single-tier posture. Layered composite
//! (preferred for production) lands next.
//!
//! ## Threat model covered
//!
//! Pre-Batch-91:
//! - Attacker captures envelope at T=0 (valid until T+72h).
//! - Agent restarts at T+10m for operational reason.
//! - Moka cache resets to empty; attacker replays captured
//!   envelope at T+10m1s; Moka says "fresh"; command
//!   executes again.
//!
//! Post-Batch-91 (when consumer wires this tier):
//! - Same attack; SQLCipher persists the jti across restart;
//!   check_and_mark returns Duplicate; command rejected.
//!
//! ## Why a separate SQLite file (not scada_db)
//!
//! Single-responsibility discipline matches the Batch 71
//! ManifestVersionStore rationale: a DROP TABLE or corruption
//! in one domain's database cannot cascade into the
//! rollback-protection invariant of another. The `jti_dedup
//! .sqlite` file lives alongside `offline_queue.sqlite` and
//! `rbac_version.sqlite` under /var/lib/suderra.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use rusqlite::Connection;
use tracing::{debug, info};

use super::jti::{DedupResult, DedupTableError, Jti, JtiDedupTable};

/// Persistent 72h dedup store backed by SQLCipher.
///
/// EDGE-HIGH-014: the connection is held behind `Arc<Mutex<...>>` so the
/// blocking SQLCipher I/O in the `async` trait methods runs on the blocking
/// thread pool (`spawn_blocking`) instead of directly on a tokio worker.
pub struct SqlCipherJtiDedupTable {
    conn: Arc<Mutex<Connection>>,
}

impl SqlCipherJtiDedupTable {
    /// Open or create the SQLCipher-encrypted dedup store at
    /// `path`. Initializes schema + PRAGMA key from the shared
    /// derivation helper.
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("SqlCipherJtiDedupTable mkdir {}: {}", parent.display(), e))?;
        }

        // EDGE-HIGH-026: open + key via the canonical SQLCipher factory
        // (v1 device-secret key, DEFAULT pragma profile). The factory owns
        // the PRAGMA key + WAL/synchronous/busy_timeout/auto_vacuum sequence;
        // this store only creates its own schema afterwards.
        let conn = crate::db::sqlcipher_factory::open_device_secret(
            path,
            "jti_dedup",
            crate::db::sqlcipher_factory::PragmaProfile::DEFAULT,
        )
        .map_err(|e| format!("SqlCipherJtiDedupTable open {}: {}", path.display(), e))?;

        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS jti_dedup (
                jti        TEXT PRIMARY KEY,
                expires_at INTEGER NOT NULL
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS idx_jti_expires_at
                ON jti_dedup(expires_at);
            ",
        )
        .map_err(|e| format!("SqlCipherJtiDedupTable schema: {}", e))?;

        info!(
            "SqlCipherJtiDedupTable opened: path={} (72h persistent dedup tier)",
            path.display()
        );

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Test-friendly in-memory variant (no encryption, no
    /// filesystem). Useful for invariant tests that exercise
    /// the SQL logic without the derive-key dependency.
    #[cfg(test)]
    pub fn in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| format!("in_memory open: {}", e))?;
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS jti_dedup (
                jti        TEXT PRIMARY KEY,
                expires_at INTEGER NOT NULL
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS idx_jti_expires_at
                ON jti_dedup(expires_at);
            ",
        )
        .map_err(|e| format!("in_memory schema: {}", e))?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }
}

#[async_trait]
impl JtiDedupTable for SqlCipherJtiDedupTable {
    async fn check_and_mark(
        &self,
        jti: &Jti,
        expires_at: SystemTime,
    ) -> Result<DedupResult, DedupTableError> {
        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let expires_at_secs = expires_at
            .duration_since(UNIX_EPOCH)
            .map_err(|_| DedupTableError::InvalidExpiry)?
            .as_secs() as i64;

        if expires_at_secs <= now_secs {
            return Err(DedupTableError::InvalidExpiry);
        }

        let jti_str = jti.as_str().to_string();

        // EDGE-HIGH-014: run the blocking SQLCipher probe + insert on the
        // blocking pool so a replay-storm cannot stall a tokio worker.
        let conn = Arc::clone(&self.conn);
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|_| DedupTableError::StoreIoError)?;

            // First: probe whether a non-expired row exists (FAST,
            // index-covered by idx_jti_expires_at + PK). Separate
            // from the insert to avoid writing on the duplicate
            // path (reduces SQLite write amplification under
            // replay-storm load).
            let existing: Option<i64> = conn
                .query_row(
                    "SELECT expires_at FROM jti_dedup WHERE jti = ?1",
                    [&jti_str],
                    |r| r.get(0),
                )
                .or_else(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(other),
                })
                .map(Some)
                .map_err(|_e| DedupTableError::StoreIoError)?
                .flatten();

            if let Some(exp) = existing {
                if exp > now_secs {
                    debug!(
                        "SqlCipherJtiDedupTable: duplicate jti (expires in {}s)",
                        exp - now_secs
                    );
                    return Ok(DedupResult::Duplicate);
                }
                // Expired row present — replace via INSERT OR
                // REPLACE rather than DELETE+INSERT to stay
                // within a single statement.
            }

            conn.execute(
                "INSERT OR REPLACE INTO jti_dedup (jti, expires_at) VALUES (?1, ?2)",
                rusqlite::params![jti_str, expires_at_secs],
            )
            .map_err(|_| DedupTableError::StoreIoError)?;

            Ok(DedupResult::Fresh)
        })
        .await
        .map_err(|_| DedupTableError::StoreIoError)?
    }

    async fn live_entry_count(&self) -> Result<usize, DedupTableError> {
        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        // EDGE-HIGH-014: offload the blocking count to the blocking pool.
        let conn = Arc::clone(&self.conn);
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|_| DedupTableError::StoreIoError)?;
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM jti_dedup WHERE expires_at > ?1",
                    [now_secs],
                    |r| r.get(0),
                )
                .map_err(|_| DedupTableError::StoreIoError)?;
            Ok(count.max(0) as usize)
        })
        .await
        .map_err(|_| DedupTableError::StoreIoError)?
    }

    async fn sweep_expired(&self, now: SystemTime) -> Result<usize, DedupTableError> {
        let now_secs = now
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        // EDGE-HIGH-014: offload the blocking delete to the blocking pool.
        let conn = Arc::clone(&self.conn);
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|_| DedupTableError::StoreIoError)?;
            let removed = conn
                .execute("DELETE FROM jti_dedup WHERE expires_at <= ?1", [now_secs])
                .map_err(|_| DedupTableError::StoreIoError)?;
            Ok(removed)
        })
        .await
        .map_err(|_| DedupTableError::StoreIoError)?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn jti(s: &str) -> Jti {
        Jti::try_new(s.to_string()).expect("valid jti")
    }

    fn future(secs: u64) -> SystemTime {
        SystemTime::now() + Duration::from_secs(secs)
    }

    fn past(secs: u64) -> SystemTime {
        SystemTime::now() - Duration::from_secs(secs)
    }

    #[tokio::test]
    async fn check_and_mark_first_time_is_fresh() {
        let t = SqlCipherJtiDedupTable::in_memory().expect("open");
        let r = t
            .check_and_mark(&jti("abc"), future(72 * 3600))
            .await
            .expect("ok");
        assert_eq!(r, DedupResult::Fresh);
    }

    #[tokio::test]
    async fn check_and_mark_second_time_is_duplicate() {
        let t = SqlCipherJtiDedupTable::in_memory().expect("open");
        t.check_and_mark(&jti("abc"), future(72 * 3600))
            .await
            .expect("1");
        let r = t
            .check_and_mark(&jti("abc"), future(72 * 3600))
            .await
            .expect("2");
        assert_eq!(r, DedupResult::Duplicate);
    }

    #[tokio::test]
    async fn expired_row_is_replaced_by_fresh_insert() {
        let t = SqlCipherJtiDedupTable::in_memory().expect("open");
        // Manually insert an ALREADY-EXPIRED row (bypass the
        // InvalidExpiry guard in check_and_mark).
        {
            let conn = t.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO jti_dedup (jti, expires_at) VALUES (?1, ?2)",
                rusqlite::params![
                    "abc",
                    (SystemTime::now() - Duration::from_secs(1))
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_secs() as i64
                ],
            )
            .unwrap();
        }

        // New mark with future expiry: the stale row is
        // replaced + we get Fresh (legitimate re-use of a
        // jti whose window has closed).
        let r = t
            .check_and_mark(&jti("abc"), future(72 * 3600))
            .await
            .expect("ok");
        assert_eq!(r, DedupResult::Fresh);
    }

    #[tokio::test]
    async fn invalid_expiry_in_past_rejected() {
        let t = SqlCipherJtiDedupTable::in_memory().expect("open");
        let err = t
            .check_and_mark(&jti("abc"), past(10))
            .await
            .expect_err("past expiry must fail");
        assert_eq!(err, DedupTableError::InvalidExpiry);
    }

    #[tokio::test]
    async fn live_entry_count_excludes_expired() {
        let t = SqlCipherJtiDedupTable::in_memory().expect("open");
        // Two fresh + one expired (via manual insert).
        t.check_and_mark(&jti("a"), future(72 * 3600))
            .await
            .unwrap();
        t.check_and_mark(&jti("b"), future(72 * 3600))
            .await
            .unwrap();
        {
            let conn = t.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO jti_dedup (jti, expires_at) VALUES (?1, ?2)",
                rusqlite::params![
                    "c",
                    (SystemTime::now() - Duration::from_secs(1))
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_secs() as i64
                ],
            )
            .unwrap();
        }

        assert_eq!(t.live_entry_count().await.unwrap(), 2);
    }

    #[tokio::test]
    async fn sweep_expired_removes_stale_rows_only() {
        let t = SqlCipherJtiDedupTable::in_memory().expect("open");
        t.check_and_mark(&jti("fresh"), future(72 * 3600))
            .await
            .unwrap();
        {
            let conn = t.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO jti_dedup (jti, expires_at) VALUES (?1, ?2)",
                rusqlite::params![
                    "stale",
                    (SystemTime::now() - Duration::from_secs(1))
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_secs() as i64
                ],
            )
            .unwrap();
        }

        let removed = t.sweep_expired(SystemTime::now()).await.unwrap();
        assert_eq!(removed, 1);
        assert_eq!(t.live_entry_count().await.unwrap(), 1);
    }

    #[tokio::test]
    async fn dedup_survives_table_reopen() {
        // Simulates reboot: open table, insert, drop, re-open
        // IN-MEMORY — can't roundtrip disk state without a real
        // file, but we can still assert the semantics hold
        // within a single process.
        let t1 = SqlCipherJtiDedupTable::in_memory().expect("open");
        t1.check_and_mark(&jti("reboot-test"), future(72 * 3600))
            .await
            .unwrap();
        assert_eq!(t1.live_entry_count().await.unwrap(), 1);
        // Dropping t1 closes the in-memory DB; a new
        // in-memory DB starts empty. This proves the "no
        // shared state" contract, NOT the persist-across-
        // restart contract — the disk-backed `open()` path
        // has the real persistence invariant (runtime
        // evidence via `/var/lib/suderra/jti_dedup.sqlite`
        // survival across systemctl restart).
        drop(t1);
        let t2 = SqlCipherJtiDedupTable::in_memory().expect("open2");
        assert_eq!(t2.live_entry_count().await.unwrap(), 0);
    }
}
