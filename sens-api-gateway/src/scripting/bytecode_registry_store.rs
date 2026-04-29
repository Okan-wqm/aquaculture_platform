//! SQLCipher persistence for the bytecode registry —
//! Batch 168 Faz 3 (plan R-1).
//!
//! ## WHY
//!
//! Batch 163 built the `BytecodeProgramRegistry` as an
//! in-memory primitive. A reboot (power cycle, agent
//! upgrade, kernel panic) would wipe every deployed
//! program + require operators to re-push every bytecode
//! from the cloud — unacceptable for a 24/7 aquaculture
//! edge runtime.
//!
//! Batch 168 adds a SQLCipher-encrypted persistence
//! layer + a boot-time reload helper so deployed programs
//! survive restart. Pattern mirrors the existing
//! `SqlitePersistence` module for RETAIN variables:
//!   - Same master-key derivation via
//!     `offline_queue::derive_db_encryption_key`.
//!   - Same WAL + busy_timeout + cache PRAGMA set.
//!   - Schema-migration discipline.
//!
//! ## Encoding
//!
//! The `Bytecode` struct serializes cleanly via serde_json
//! (already required for the on-wire `SignedBytecode`
//! shape per Batch 158/165). Storing it as a JSON blob
//! in a TEXT column is simple + operator-inspectable
//! via any SQLite client. Binary canonical encoding
//! (Batch 158) lives only at the SIGNATURE boundary —
//! persistence doesn't need re-signing tolerance, only
//! round-trip fidelity.
//!
//! ## Scope boundary
//!
//! - The bootup path that CALLS load_all + feeds entries
//!   into `BytecodeProgramRegistry::insert` lives in
//!   main.rs boot sequence (future batch wires it after
//!   `init_license_cache` precedent). This module only
//!   provides the primitives.

// Batch #259 wire-audit: D-1 ultra-plan compile/registry
// path is partially orphan (Batch 149-167 primitives wired
// for runtime + scan-cycle, but several stdlib/compile/
// debug helpers wait on the D-1 production wire). Blanket
// allow retained + tracked as ULTRA-HIGH-024; remove
// per-item as the D-1 batch consumes each helper.
#![allow(dead_code)]

use std::path::Path;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{Connection, params};

use super::bytecode::Bytecode;
use super::bytecode_registry::ProgramEntry;

/// SQLCipher-backed persistence for deployed bytecode
/// program entries.
#[derive(Debug, Clone)]
pub struct BytecodeRegistryStore {
    conn: Arc<Mutex<Connection>>,
    db_path: String,
}

/// Structured errors from the store. Kept distinct from
/// `RegistryError` (in-memory registry gates) so the
/// consumer knows which layer failed.
#[derive(Debug)]
pub enum StoreError {
    /// Opening the SQLCipher database failed (path,
    /// permissions, key derivation).
    ConnectionFailed(String),
    /// Schema migration failed.
    MigrationFailed(String),
    /// Row serialization / deserialization failed.
    Encoding(String),
    /// SQL execution failed.
    Sql(String),
    /// Mutex lock poisoned (another task panicked while
    /// holding the lock).
    LockPoisoned,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ConnectionFailed(msg) => write!(f, "store connect: {}", msg),
            Self::MigrationFailed(msg) => write!(f, "store migrate: {}", msg),
            Self::Encoding(msg) => write!(f, "store encoding: {}", msg),
            Self::Sql(msg) => write!(f, "store sql: {}", msg),
            Self::LockPoisoned => write!(f, "store lock poisoned"),
        }
    }
}

impl std::error::Error for StoreError {}

impl BytecodeRegistryStore {
    /// Open (or create) the SQLCipher-backed store at
    /// the given path. Applies the shared encryption
    /// key + runs migrations on first use.
    pub fn new<P: AsRef<Path>>(db_path: P) -> Result<Self, StoreError> {
        let path_str = db_path.as_ref().to_string_lossy().to_string();

        if let Some(parent) = db_path.as_ref().parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    StoreError::ConnectionFailed(format!("create parent dir: {}", e))
                })?;
            }
        }

        let conn = Connection::open(&db_path)
            .map_err(|e| StoreError::ConnectionFailed(format!("open: {}", e)))?;

        // Apply SQLCipher master-key derivation — same
        // shared path used by offline_queue +
        // persistence so all agent SQLCipher stores
        // share one key ceremony.
        let hex_key = crate::offline_queue::derive_db_encryption_key()
            .map_err(|e| StoreError::ConnectionFailed(format!("derive encryption key: {}", e)))?;
        conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", hex_key))
            .map_err(|e| StoreError::ConnectionFailed(format!("apply encryption key: {}", e)))?;

        // WAL mode + sane defaults (same as
        // SqlitePersistence).
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA busy_timeout=5000;
             PRAGMA cache_size=-8000;
             PRAGMA temp_store=MEMORY;",
        )
        .map_err(|e| StoreError::ConnectionFailed(e.to_string()))?;

        let store = Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path: path_str,
        };

        store.run_migrations()?;

        Ok(store)
    }

    /// In-memory store for tests (no SQLCipher key
    /// applied; tests don't require encryption).
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
            CREATE TABLE IF NOT EXISTS bytecode_programs (
                program_id       TEXT PRIMARY KEY NOT NULL,
                tenant_id        TEXT,
                policy_version   INTEGER NOT NULL,
                enabled          INTEGER NOT NULL,
                deployed_at_secs INTEGER NOT NULL,
                bytecode_json    TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_bytecode_programs_tenant
                ON bytecode_programs(tenant_id);
            "#,
        )
        .map_err(|e| StoreError::MigrationFailed(e.to_string()))?;

        Ok(())
    }

    /// Upsert one program entry. The registry already
    /// ran its monotonic + tenant gates before calling
    /// this — the store trusts the caller's validation
    /// + simply persists the row.
    pub fn save(&self, entry: &ProgramEntry) -> Result<(), StoreError> {
        let bytecode_json = serde_json::to_string(&entry.bytecode)
            .map_err(|e| StoreError::Encoding(e.to_string()))?;
        let deployed_secs = entry.deployed_at.timestamp();
        let enabled_int = if entry.enabled { 1 } else { 0 };

        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        conn.execute(
            r#"INSERT INTO bytecode_programs
                 (program_id, tenant_id, policy_version, enabled,
                  deployed_at_secs, bytecode_json)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)
               ON CONFLICT(program_id) DO UPDATE SET
                   tenant_id        = excluded.tenant_id,
                   policy_version   = excluded.policy_version,
                   enabled          = excluded.enabled,
                   deployed_at_secs = excluded.deployed_at_secs,
                   bytecode_json    = excluded.bytecode_json"#,
            params![
                entry.program_id,
                entry.tenant_id,
                entry.policy_version as i64,
                enabled_int,
                deployed_secs,
                bytecode_json,
            ],
        )
        .map_err(|e| StoreError::Sql(e.to_string()))?;
        Ok(())
    }

    /// Load every persisted program. Used at boot to
    /// rehydrate the in-memory registry.
    pub fn load_all(&self) -> Result<Vec<ProgramEntry>, StoreError> {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        let mut stmt = conn
            .prepare(
                r#"SELECT program_id, tenant_id, policy_version, enabled,
                          deployed_at_secs, bytecode_json
                   FROM bytecode_programs
                   ORDER BY program_id"#,
            )
            .map_err(|e| StoreError::Sql(e.to_string()))?;

        let rows = stmt
            .query_map([], |row| {
                let program_id: String = row.get(0)?;
                let tenant_id: Option<String> = row.get(1)?;
                let policy_version: i64 = row.get(2)?;
                let enabled_int: i64 = row.get(3)?;
                let deployed_at_secs: i64 = row.get(4)?;
                let bytecode_json: String = row.get(5)?;
                Ok((
                    program_id,
                    tenant_id,
                    policy_version,
                    enabled_int,
                    deployed_at_secs,
                    bytecode_json,
                ))
            })
            .map_err(|e| StoreError::Sql(e.to_string()))?;

        let mut entries: Vec<ProgramEntry> = Vec::new();
        for row in rows {
            let (
                program_id,
                tenant_id,
                policy_version,
                enabled_int,
                deployed_at_secs,
                bytecode_json,
            ) = row.map_err(|e| StoreError::Sql(e.to_string()))?;

            let bytecode: Bytecode = serde_json::from_str(&bytecode_json).map_err(|e| {
                StoreError::Encoding(format!("bytecode_json for `{}`: {}", program_id, e))
            })?;

            let deployed_at: DateTime<Utc> = Utc
                .timestamp_opt(deployed_at_secs, 0)
                .single()
                .unwrap_or_else(Utc::now);

            entries.push(ProgramEntry {
                program_id,
                bytecode,
                tenant_id,
                policy_version: policy_version as u64,
                enabled: enabled_int != 0,
                deployed_at,
            });
        }

        Ok(entries)
    }

    /// Delete a persisted entry by id. Idempotent — missing
    /// id is NOT an error (the caller can always invoke
    /// delete + treat 0-row-affected as benign).
    pub fn delete(&self, program_id: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        conn.execute(
            "DELETE FROM bytecode_programs WHERE program_id = ?1",
            params![program_id],
        )
        .map_err(|e| StoreError::Sql(e.to_string()))?;
        Ok(())
    }

    /// Row count — diagnostic helper for health endpoints.
    pub fn count(&self) -> Result<u64, StoreError> {
        let conn = self.conn.lock().map_err(|_| StoreError::LockPoisoned)?;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM bytecode_programs", [], |row| {
                row.get(0)
            })
            .map_err(|e| StoreError::Sql(e.to_string()))?;
        Ok(count as u64)
    }
}

/// Rehydrate the in-memory registry from the persisted
/// store. Called once at boot after AppState::new +
/// before the scan-cycle orchestrator starts.
///
/// Insert uses `BytecodeProgramRegistry::insert` which
/// runs its own tenant + monotonic-version gates —
/// redundant at boot (the store was populated by the
/// same gated insert path) but defense-in-depth against
/// manual DB edits.
///
/// Errors are log-only; a failed boot rehydrate returns
/// the first error but ALSO continues rehydrating
/// subsequent entries (the caller decides whether a
/// partial rehydrate is acceptable or should abort
/// boot). Batch 168 returns a Vec of per-entry
/// results so the caller can surface the full picture.
pub async fn load_into_registry(
    store: &BytecodeRegistryStore,
    registry: &super::bytecode_registry::BytecodeProgramRegistry,
) -> Vec<Result<String, (String, StoreError)>> {
    let entries = match store.load_all() {
        Ok(e) => e,
        Err(e) => {
            // Surface the load failure as a single
            // error entry; no per-entry results because
            // we never got the list.
            return vec![Err((String::from("<load_all>"), e))];
        }
    };

    let mut results = Vec::with_capacity(entries.len());
    for entry in entries {
        let program_id = entry.program_id.clone();
        match registry.insert(entry).await {
            Ok(()) => results.push(Ok(program_id)),
            Err(reg_err) => {
                results.push(Err((
                    program_id,
                    StoreError::Sql(format!("registry reject: {}", reg_err)),
                )));
            }
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::super::bytecode::Opcode;
    use super::*;

    fn mk_bc(program_id: &str, version: u64) -> Bytecode {
        Bytecode {
            program_id: program_id.to_string(),
            program_name: format!("{}-name", program_id),
            tenant_id: Some("tenant-a".to_string()),
            policy_version: version,
            max_gas_per_tick: 1000,
            local_count: 0,
            retain_vars: vec![],
            allowed_write_tags: vec!["setpoint".to_string()],
            safe_state_pinned_tags: vec![],
            opcodes: vec![Opcode::Return],
        }
    }

    fn mk_entry(program_id: &str, version: u64) -> ProgramEntry {
        ProgramEntry {
            program_id: program_id.to_string(),
            bytecode: mk_bc(program_id, version),
            tenant_id: Some("tenant-a".to_string()),
            policy_version: version,
            enabled: true,
            deployed_at: Utc::now(),
        }
    }

    #[test]
    fn in_memory_roundtrip() {
        let store = BytecodeRegistryStore::in_memory().expect("ok");
        let entry = mk_entry("p1", 1);
        store.save(&entry).expect("save ok");

        let loaded = store.load_all().expect("load ok");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].program_id, "p1");
        assert_eq!(loaded[0].policy_version, 1);
        assert_eq!(loaded[0].tenant_id, Some("tenant-a".to_string()));
        // Bytecode content survives JSON roundtrip.
        assert_eq!(
            loaded[0].bytecode.allowed_write_tags,
            vec!["setpoint".to_string()]
        );
    }

    #[test]
    fn upsert_replaces_existing() {
        let store = BytecodeRegistryStore::in_memory().expect("ok");
        store.save(&mk_entry("p1", 1)).expect("v1");
        store.save(&mk_entry("p1", 2)).expect("v2 upsert");
        let loaded = store.load_all().expect("load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].policy_version, 2);
    }

    #[test]
    fn delete_removes_row() {
        let store = BytecodeRegistryStore::in_memory().expect("ok");
        store.save(&mk_entry("p1", 1)).expect("ok");
        store.save(&mk_entry("p2", 1)).expect("ok");
        store.delete("p1").expect("delete");
        let loaded = store.load_all().expect("load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].program_id, "p2");
    }

    #[test]
    fn delete_missing_is_idempotent() {
        let store = BytecodeRegistryStore::in_memory().expect("ok");
        store.delete("ghost").expect("no-op ok");
    }

    #[test]
    fn count_matches_load_all_length() {
        let store = BytecodeRegistryStore::in_memory().expect("ok");
        assert_eq!(store.count().expect("ok"), 0);
        store.save(&mk_entry("p1", 1)).expect("ok");
        store.save(&mk_entry("p2", 1)).expect("ok");
        store.save(&mk_entry("p3", 1)).expect("ok");
        assert_eq!(store.count().expect("ok"), 3);
    }

    #[test]
    fn load_all_returns_rows_sorted_by_program_id() {
        let store = BytecodeRegistryStore::in_memory().expect("ok");
        store.save(&mk_entry("zebra", 1)).expect("ok");
        store.save(&mk_entry("alpha", 1)).expect("ok");
        store.save(&mk_entry("mango", 1)).expect("ok");
        let loaded = store.load_all().expect("ok");
        assert_eq!(loaded[0].program_id, "alpha");
        assert_eq!(loaded[1].program_id, "mango");
        assert_eq!(loaded[2].program_id, "zebra");
    }

    #[test]
    fn enabled_flag_survives_roundtrip() {
        let store = BytecodeRegistryStore::in_memory().expect("ok");
        let mut entry = mk_entry("p1", 1);
        entry.enabled = false;
        store.save(&entry).expect("ok");
        let loaded = store.load_all().expect("ok");
        assert!(!loaded[0].enabled);
    }

    #[test]
    fn platform_scoped_none_tenant_roundtrip() {
        let store = BytecodeRegistryStore::in_memory().expect("ok");
        let mut entry = mk_entry("factory_default", 1);
        entry.tenant_id = None;
        let mut bc = entry.bytecode.clone();
        bc.tenant_id = None;
        entry.bytecode = bc;
        store.save(&entry).expect("ok");
        let loaded = store.load_all().expect("ok");
        assert!(loaded[0].tenant_id.is_none());
        assert!(loaded[0].bytecode.tenant_id.is_none());
    }

    #[tokio::test]
    async fn load_into_registry_rehydrates_entries() {
        use super::super::bytecode_registry::BytecodeProgramRegistry;

        let store = BytecodeRegistryStore::in_memory().expect("ok");
        store.save(&mk_entry("p1", 1)).expect("ok");
        store.save(&mk_entry("p2", 5)).expect("ok");

        let reg = BytecodeProgramRegistry::new();
        let results = load_into_registry(&store, &reg).await;
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.is_ok()));

        // Both present in the in-memory registry.
        assert!(reg.get("p1").await.is_some());
        assert!(reg.get("p2").await.is_some());
        assert_eq!(reg.len().await, 2);
    }

    #[tokio::test]
    async fn load_into_registry_empty_store_yields_empty_results() {
        use super::super::bytecode_registry::BytecodeProgramRegistry;

        let store = BytecodeRegistryStore::in_memory().expect("ok");
        let reg = BytecodeProgramRegistry::new();
        let results = load_into_registry(&store, &reg).await;
        assert!(results.is_empty());
        assert_eq!(reg.len().await, 0);
    }
}
