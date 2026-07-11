//! SQLCipher persistence for the force registry —
//! Batch 201 Faz 6 (plan R-9 persist opt-in).
//!
//! ## WHY
//!
//! Plan R-9 specifies `persist_across_reboot: bool`
//! on `ForceEntry` with default `false` (fail-safe).
//! Batches 194-200 built the in-memory registry +
//! shutdown drain path but persistent entries lost
//! their state at reboot anyway because no storage
//! layer held them. Batch 201 closes that gap with
//! a SQLCipher-encrypted store following the same
//! pattern as the Batch 168 BytecodeRegistryStore.
//!
//! ## Lifecycle
//!
//! At apply time (Batch 197 cmd_force_value):
//! - Registry primitive's `apply()` writes the
//!   entry to memory.
//! - Command handler consults `persist_across_reboot`
//!   — if true, additionally calls `store.save(&entry)`
//!   so the row persists.
//!
//! At remove / unforce_all / expired sweep:
//! - Command handler or sweep task calls
//!   `store.delete(tag_name)` so a removed entry
//!   doesn't re-appear on next boot.
//!
//! At shutdown drain (Batch 200):
//! - `drain_non_persistent` removes only
//!   persist=false entries from memory; persist=true
//!   entries stay in memory AND in the store.
//! - Agent exit leaves SQLCipher state consistent.
//!
//! At boot:
//! - `load_into_registry` reads every persisted row +
//!   calls `ForceRegistry::apply` with the stored
//!   values. Rows whose `expires_at_unix` has
//!   already passed are silently dropped (a sweep
//!   cycle would have removed them anyway).
//!
//! ## Wire status (Batch #271 audit)
//!
//! Production wire confirmed:
//! - `main.rs:2527` — `ForceRegistryStore::new(&path)` opens
//!   the SQLCipher store at boot.
//! - `main.rs:2542` — `load_into_registry(...)` rehydrates
//!   `persist_across_reboot=true` forces from disk into the
//!   in-memory `ForceRegistry` so a graceful agent restart
//!   preserves operator forcings without HMI re-issuance.
//!
//! Per-item dead-code allow audit pending — blanket allow
//! retained as WHITELIST-with-reason while a focused F-series
//! cleanup batch surfaces helper functions individually
//! (mirror of Batch #259 / #270 / #271 audit pattern).

#![allow(dead_code)]

use std::path::Path;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{Connection, params};
use uuid::Uuid;

use super::force_registry::{ForceEntry, ForceRegistry};

/// SQLCipher-backed persistence for `persist_across_
/// reboot=true` force entries.
#[derive(Debug, Clone)]
pub struct ForceRegistryStore {
    conn: Arc<Mutex<Connection>>,
    db_path: String,
}

#[derive(Debug)]
pub enum StoreError {
    ConnectionFailed(String),
    MigrationFailed(String),
    Sql(String),
    Encoding(String),
    LockPoisoned,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ConnectionFailed(msg) => {
                write!(f, "force-store connect: {}", msg)
            }
            Self::MigrationFailed(msg) => {
                write!(f, "force-store migrate: {}", msg)
            }
            Self::Sql(msg) => write!(f, "force-store sql: {}", msg),
            Self::Encoding(msg) => {
                write!(f, "force-store encoding: {}", msg)
            }
            Self::LockPoisoned => write!(f, "force-store lock poisoned"),
        }
    }
}

impl std::error::Error for StoreError {}

impl ForceRegistryStore {
    /// Open (or create) the SQLCipher-backed store at
    /// the given path. Applies the shared encryption
    /// key + runs migrations.
    pub fn new<P: AsRef<Path>>(db_path: P) -> Result<Self, StoreError> {
        let path_str = db_path.as_ref().to_string_lossy().to_string();

        if let Some(parent) = db_path.as_ref().parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    StoreError::ConnectionFailed(format!("create parent dir: {}", e))
                })?;
            }
        }

        // EDGE-HIGH-026: open + key via the canonical SQLCipher factory
        // (v1 device-secret key, PERF pragma profile) instead of hand-rolling
        // the PRAGMA key + durability sequence.
        let conn = crate::db::sqlcipher_factory::open_device_secret(
            db_path.as_ref(),
            "force_registry",
            crate::db::sqlcipher_factory::PragmaProfile::PERF,
        )
        .map_err(|e| StoreError::ConnectionFailed(e.to_string()))?;

        let store = Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path: path_str,
        };

        store.run_migrations()?;

        Ok(store)
    }

    /// In-memory store for tests.
    pub fn in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()
            .map_err(|e| StoreError::ConnectionFailed(e.to_string()))?;
        let store = Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path: ":memory:".to_string(),
        };
        store.run_migrations()?;
        Ok(store)
    }

    fn run_migrations(&self) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS force_entries (
                tag_name         TEXT PRIMARY KEY NOT NULL,
                force_id         TEXT NOT NULL,
                value            REAL NOT NULL,
                quality          TEXT NOT NULL,
                actor            TEXT NOT NULL,
                reason           TEXT NOT NULL,
                applied_at_secs  INTEGER NOT NULL,
                expires_at_unix  INTEGER NOT NULL,
                persist_across_reboot INTEGER NOT NULL
            );
            "#,
        )
        .map_err(|e| StoreError::MigrationFailed(e.to_string()))?;
        Ok(())
    }

    /// Upsert one force entry. The caller has already
    /// verified `persist_across_reboot=true`; this
    /// function trusts that + blindly persists.
    /// Calling with a persist=false entry is a no-op-
    /// equivalent bug that still writes the row; the
    /// caller's contract is the gate.
    pub fn save(&self, entry: &ForceEntry) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        let quality_json = serde_json::to_string(&entry.quality)
            .map_err(|e| StoreError::Encoding(e.to_string()))?;
        conn.execute(
            r#"INSERT INTO force_entries
                 (tag_name, force_id, value, quality, actor, reason,
                  applied_at_secs, expires_at_unix, persist_across_reboot)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
               ON CONFLICT(tag_name) DO UPDATE SET
                   force_id = excluded.force_id,
                   value = excluded.value,
                   quality = excluded.quality,
                   actor = excluded.actor,
                   reason = excluded.reason,
                   applied_at_secs = excluded.applied_at_secs,
                   expires_at_unix = excluded.expires_at_unix,
                   persist_across_reboot = excluded.persist_across_reboot"#,
            params![
                entry.tag_name,
                entry.force_id.to_string(),
                entry.value,
                quality_json,
                entry.actor,
                entry.reason,
                entry.applied_at.timestamp(),
                entry.expires_at_unix,
                if entry.persist_across_reboot { 1 } else { 0 },
            ],
        )
        .map_err(|e| StoreError::Sql(e.to_string()))?;
        Ok(())
    }

    /// Delete one entry by tag name. Idempotent —
    /// deleting a row that doesn't exist returns Ok.
    pub fn delete(&self, tag_name: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        conn.execute(
            "DELETE FROM force_entries WHERE tag_name = ?1",
            params![tag_name],
        )
        .map_err(|e| StoreError::Sql(e.to_string()))?;
        Ok(())
    }

    /// Load every persisted entry. Used at boot
    /// via `load_into_registry`.
    pub fn load_all(&self) -> Result<Vec<ForceEntry>, StoreError> {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        let mut stmt = conn
            .prepare(
                r#"SELECT tag_name, force_id, value, quality, actor, reason,
                          applied_at_secs, expires_at_unix, persist_across_reboot
                   FROM force_entries
                   ORDER BY tag_name"#,
            )
            .map_err(|e| StoreError::Sql(e.to_string()))?;

        let rows = stmt
            .query_map([], |row| {
                let tag_name: String = row.get(0)?;
                let force_id_str: String = row.get(1)?;
                let value: f64 = row.get(2)?;
                let quality_json: String = row.get(3)?;
                let actor: String = row.get(4)?;
                let reason: String = row.get(5)?;
                let applied_at_secs: i64 = row.get(6)?;
                let expires_at_unix: i64 = row.get(7)?;
                let persist_int: i64 = row.get(8)?;
                Ok((
                    tag_name,
                    force_id_str,
                    value,
                    quality_json,
                    actor,
                    reason,
                    applied_at_secs,
                    expires_at_unix,
                    persist_int,
                ))
            })
            .map_err(|e| StoreError::Sql(e.to_string()))?;

        let mut entries: Vec<ForceEntry> = Vec::new();
        for row in rows {
            let (
                tag_name,
                force_id_str,
                value,
                quality_json,
                actor,
                reason,
                applied_at_secs,
                expires_at_unix,
                persist_int,
            ) = row.map_err(|e| StoreError::Sql(e.to_string()))?;

            let force_id = Uuid::parse_str(&force_id_str)
                .map_err(|e| StoreError::Encoding(format!("force_id for `{}`: {}", tag_name, e)))?;
            let quality: crate::process_image::TagQuality = serde_json::from_str(&quality_json)
                .map_err(|e| StoreError::Encoding(format!("quality for `{}`: {}", tag_name, e)))?;
            let applied_at: DateTime<Utc> = Utc
                .timestamp_opt(applied_at_secs, 0)
                .single()
                .unwrap_or_else(Utc::now);

            entries.push(ForceEntry {
                force_id,
                tag_name,
                value,
                quality,
                actor,
                reason,
                applied_at,
                expires_at_unix,
                persist_across_reboot: persist_int != 0,
                // Batch #314 D-9 migration: persisted entries
                // arrive with None deadline. load_into_registry
                // re-applies them through registry.apply() which
                // mints a fresh MonotonicDeadline using the
                // current clock; sweep_expired_with_clock has a
                // belt-and-braces rehydration pass that also
                // mints the deadline if the entry somehow lands
                // in the registry without one.
                monotonic_deadline: None,
            });
        }
        Ok(entries)
    }

    pub fn count(&self) -> Result<u64, StoreError> {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM force_entries", [], |row| row.get(0))
            .map_err(|e| StoreError::Sql(e.to_string()))?;
        Ok(count as u64)
    }
}

/// Rehydrate the in-memory registry from the persisted
/// store at boot. Plan R-9: only persist=true entries
/// ever reach the store (Batch 197 command handler is
/// the gate), so every loaded row is a valid restore
/// target. Rows whose TTL has already passed get
/// silently dropped (the 1-Hz sweep task would remove
/// them on the next tick anyway — pre-filtering saves
/// the work + keeps the registry clean from tick 1).
///
/// Each restored force applies through the standard
/// registry `apply` path so the rate-limit + cap gates
/// run even on restore. This is defense-in-depth
/// against a tampered SQLCipher file with 100+ entries
/// — the gate rejects entries beyond MAX_CONCURRENT_
/// FORCES.
pub async fn load_into_registry(
    store: &ForceRegistryStore,
    registry: &ForceRegistry,
    // Batch #314 D-9 migration: clock injection so the
    // restored entries pick up MonotonicDeadline anchors
    // through the standard apply() gate. Failing-closed on
    // an unhealthy clock at load time is the conservative
    // posture — operator must resolve the clock before
    // forces can be restored.
    clock: &dyn crate::runtime_safety::ClockAuthority,
) -> Vec<Result<String, (String, String)>> {
    let entries = match store.load_all() {
        Ok(e) => e,
        Err(e) => {
            return vec![Err(("<load_all>".into(), e.to_string()))];
        }
    };

    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let mut results = Vec::with_capacity(entries.len());
    for entry in entries {
        // Drop expired rows at load time.
        if entry.expires_at_unix <= now_unix {
            // Best-effort cleanup: delete the stale
            // row. Failure is non-fatal — the 1-Hz
            // sweep task will catch it later.
            let _ = store.delete(&entry.tag_name);
            continue;
        }

        let remaining_ttl = (entry.expires_at_unix - now_unix).max(1) as u64;
        let tag_clone = entry.tag_name.clone();
        match registry
            .apply(
                entry.tag_name,
                entry.value,
                entry.quality,
                entry.actor,
                entry.reason,
                remaining_ttl,
                entry.persist_across_reboot,
                clock,
            )
            .await
        {
            Ok(_) => results.push(Ok(tag_clone)),
            Err(e) => results.push(Err((tag_clone, e.to_string()))),
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process_image::TagQuality;

    fn mk_entry(tag: &str, persist: bool, ttl_secs_offset: i64) -> ForceEntry {
        ForceEntry {
            force_id: Uuid::new_v4(),
            tag_name: tag.to_string(),
            value: 2.5,
            quality: TagQuality::Good,
            actor: "operator-test".into(),
            reason: "test diagnostic".into(),
            applied_at: Utc::now(),
            expires_at_unix: Utc::now().timestamp() + ttl_secs_offset,
            persist_across_reboot: persist,
            // Batch #314 D-9 migration: persisted entries have
            // None deadline at construction; the load-into-
            // registry path mints the MonotonicDeadline at
            // load time using the injected ClockAuthority.
            monotonic_deadline: None,
        }
    }

    #[test]
    fn store_save_load_roundtrip_preserves_all_fields() {
        let store = ForceRegistryStore::in_memory().expect("ok");
        let entry = mk_entry("feeder_rate", true, 300);
        store.save(&entry).expect("save ok");

        let loaded = store.load_all().expect("load ok");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].tag_name, "feeder_rate");
        assert_eq!(loaded[0].force_id, entry.force_id);
        assert_eq!(loaded[0].value, 2.5);
        assert_eq!(loaded[0].quality, TagQuality::Good);
        assert_eq!(loaded[0].actor, "operator-test");
        assert_eq!(loaded[0].persist_across_reboot, true);
    }

    #[test]
    fn store_save_upserts_on_tag_name() {
        let store = ForceRegistryStore::in_memory().expect("ok");
        let mut e1 = mk_entry("tag_a", true, 300);
        e1.value = 1.0;
        store.save(&e1).expect("ok");

        let mut e2 = mk_entry("tag_a", true, 300);
        e2.value = 9.9;
        e2.force_id = Uuid::new_v4();
        store.save(&e2).expect("ok");

        let loaded = store.load_all().expect("ok");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].value, 9.9);
        assert_eq!(loaded[0].force_id, e2.force_id);
    }

    #[test]
    fn store_delete_removes_row() {
        let store = ForceRegistryStore::in_memory().expect("ok");
        store.save(&mk_entry("tag_a", true, 300)).expect("ok");
        store.save(&mk_entry("tag_b", true, 300)).expect("ok");
        store.delete("tag_a").expect("ok");
        let loaded = store.load_all().expect("ok");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].tag_name, "tag_b");
    }

    #[test]
    fn store_delete_on_missing_is_idempotent() {
        let store = ForceRegistryStore::in_memory().expect("ok");
        store.delete("ghost").expect("idempotent");
    }

    #[test]
    fn store_count_reflects_rows() {
        let store = ForceRegistryStore::in_memory().expect("ok");
        assert_eq!(store.count().expect("ok"), 0);
        store.save(&mk_entry("a", true, 300)).expect("ok");
        store.save(&mk_entry("b", true, 300)).expect("ok");
        assert_eq!(store.count().expect("ok"), 2);
    }

    #[tokio::test]
    async fn load_into_registry_rehydrates_entries() {
        let store = ForceRegistryStore::in_memory().expect("ok");
        store.save(&mk_entry("tag_a", true, 300)).expect("ok");
        store.save(&mk_entry("tag_b", true, 600)).expect("ok");

        let registry = ForceRegistry::new();
        let clock = crate::runtime_safety::SystemClockAuthority::new();
        let results = load_into_registry(&store, &registry, &clock).await;
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.is_ok()));
        assert_eq!(registry.active_count().await, 2);
        assert!(registry.is_forced("tag_a").await);
        assert!(registry.is_forced("tag_b").await);
    }

    #[tokio::test]
    async fn load_into_registry_drops_expired_entries() {
        let store = ForceRegistryStore::in_memory().expect("ok");
        // Already-expired row (10s in the past).
        store.save(&mk_entry("tag_dead", true, -10)).expect("ok");
        // Fresh row.
        store.save(&mk_entry("tag_live", true, 300)).expect("ok");

        let registry = ForceRegistry::new();
        let clock = crate::runtime_safety::SystemClockAuthority::new();
        let results = load_into_registry(&store, &registry, &clock).await;
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].as_ref().unwrap(), "tag_live");
        assert_eq!(registry.active_count().await, 1);
        assert!(!registry.is_forced("tag_dead").await);
        // Stale row also purged from the store.
        let post = store.load_all().expect("ok");
        assert_eq!(post.len(), 1);
        assert_eq!(post[0].tag_name, "tag_live");
    }

    #[tokio::test]
    async fn load_into_registry_empty_store_yields_empty_results() {
        let store = ForceRegistryStore::in_memory().expect("ok");
        let registry = ForceRegistry::new();
        let clock = crate::runtime_safety::SystemClockAuthority::new();
        let results = load_into_registry(&store, &registry, &clock).await;
        assert!(results.is_empty());
    }
}
