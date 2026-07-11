//! Persistent Storage for RETAIN Variables (IEC 61131-3 Compliance)
//!
//! Provides SQLite-based persistence for:
//! - RETAIN variables (survive power cycles)
//! - Function block states (Timer elapsed, Counter values)
//! - Script execution metadata
//!
//! NOTE: Full persistence API is implemented. Some methods are for
//! future batch operations and advanced script state management.
//!
//! ## Wire status (Batch #275 audit)
//!
//! Production wire confirmed across multiple call sites:
//! - `scripting::mod.rs:132` re-exports `SqlitePersistence`,
//!   `PersistenceError`, `VariableScope`, `VariableStore` as
//!   the canonical scripting persistence public surface.
//! - `bytecode_runner.rs:129,151,174` — RETAIN load/save path
//!   for ST bytecode programs.
//! - `bytecode_scan_cycle_task.rs:104` — scan-cycle task holds
//!   `Option<Arc<SqlitePersistence>>` for retain-aware
//!   execution.
//! - `task_scheduler.rs:605,860` — multi-task scheduler
//!   propagates persistence to per-task scan ticks.
//! - `fb_registry.rs:40` — function block instance state load.
//! - `bytecode_e2e_tests.rs:47` — integration test harness.
//!
//! Per-item dead-code allow audit pending — blanket allow
//! retained as WHITELIST-with-reason while a focused F-series
//! cleanup batch surfaces residual unused helpers.

#![allow(dead_code)]
//!
//! Design Principles:
//! - SOLID: Single Responsibility, Dependency Inversion via traits
//! - Thread-safe: Arc<Mutex<>> for concurrent access
//! - Async-safe: All blocking operations wrapped in spawn_blocking
//! - Fail-safe: Graceful degradation on DB errors
//!
//! v2.2.0: Fixed async/sync Mutex deadlock risk by using spawn_blocking

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::sync::{Arc, Mutex};
use thiserror::Error;
use tracing::{debug, info};
// Database encryption key derivation is now handled by crate::offline_queue::derive_db_encryption_key()

// ============================================================================
// Error Types
// ============================================================================

/// Persistence layer errors
#[derive(Debug, Error)]
pub enum PersistenceError {
    #[error("Database connection failed: {0}")]
    ConnectionFailed(String),

    #[error("Migration failed: {0}")]
    MigrationFailed(String),

    #[error("Variable save failed: {script_id}:{var_name} - {reason}")]
    SaveFailed {
        script_id: String,
        var_name: String,
        reason: String,
    },

    #[error("Variable load failed: {script_id}:{var_name} - {reason}")]
    LoadFailed {
        script_id: String,
        var_name: String,
        reason: String,
    },

    #[error("Transaction failed: {0}")]
    TransactionFailed(String),

    #[error("Serialization error: {0}")]
    SerializationError(String),

    #[error("Database locked: {0}")]
    DatabaseLocked(String),
}

impl From<rusqlite::Error> for PersistenceError {
    fn from(e: rusqlite::Error) -> Self {
        match e {
            rusqlite::Error::SqliteFailure(err, msg)
                if err.code == rusqlite::ErrorCode::DatabaseBusy =>
            {
                PersistenceError::DatabaseLocked(msg.unwrap_or_else(|| "Database busy".to_string()))
            }
            _ => PersistenceError::ConnectionFailed(e.to_string()),
        }
    }
}

// ============================================================================
// Trait Definitions (Dependency Inversion)
// ============================================================================

/// Trait for variable persistence operations
/// Enables mocking for tests and alternative implementations
pub trait VariableStore: Send + Sync {
    /// Save a variable value
    fn save(&self, script_id: &str, var_name: &str, value: &Value) -> Result<(), PersistenceError>;

    /// Load a variable value
    fn load(&self, script_id: &str, var_name: &str) -> Result<Option<Value>, PersistenceError>;

    /// Delete a variable
    fn delete(&self, script_id: &str, var_name: &str) -> Result<(), PersistenceError>;

    /// List all variables for a script
    fn list(&self, script_id: &str) -> Result<Vec<(String, Value)>, PersistenceError>;

    /// Bulk save multiple variables (transactional)
    fn save_batch(
        &self,
        script_id: &str,
        variables: &[(String, Value)],
    ) -> Result<(), PersistenceError>;

    /// Clear all variables for a script
    fn clear_script(&self, script_id: &str) -> Result<(), PersistenceError>;
}

/// Trait for function block state persistence
pub trait FunctionBlockStore: Send + Sync {
    /// Save FB state
    fn save_fb_state(&self, fb_id: &str, state: &FBState) -> Result<(), PersistenceError>;

    /// Load FB state
    fn load_fb_state(&self, fb_id: &str) -> Result<Option<FBState>, PersistenceError>;

    /// Clear FB state
    fn clear_fb_state(&self, fb_id: &str) -> Result<(), PersistenceError>;
}

// ============================================================================
// Data Structures
// ============================================================================

/// Variable scope enumeration (IEC 61131-3)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum VariableScope {
    /// Local variable - lost on script restart
    #[default]
    Local,
    /// Global variable - shared across scripts, lost on agent restart
    Global,
    /// Retain variable - persisted across power cycles
    Retain,
    /// Persistent variable - same as Retain (alias)
    Persistent,
}

/// Stored variable with metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredVariable {
    pub script_id: String,
    pub var_name: String,
    pub value: Value,
    pub scope: VariableScope,
    pub updated_at: i64,
}

/// Function block state storage
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FBState {
    /// FB instance ID
    pub fb_id: String,
    /// FB type (TON, TOF, CTU, etc.)
    pub fb_type: String,
    /// Serialized internal state
    pub state_data: Value,
    /// Last execution timestamp
    pub last_executed: i64,
}

// ============================================================================
// SQLite Implementation
// ============================================================================

/// Database schema version for migrations
const SCHEMA_VERSION: i32 = 1;

/// SQLite-based persistent storage
///
/// # Thread Safety
/// Uses std::sync::Mutex internally but all public async methods use
/// tokio::task::spawn_blocking to prevent blocking the async runtime.
///
/// # Usage
/// Prefer async methods (save_async, load_async, etc.) over sync trait methods
/// when calling from async context.
pub struct SqlitePersistence {
    conn: Arc<Mutex<Connection>>,
    db_path: String,
}

// ============================================================================
// Async-Safe Public API (v2.2.0)
// ============================================================================

impl SqlitePersistence {
    /// Async-safe variable save - use this from async contexts
    ///
    /// Wraps the blocking SQLite operation in spawn_blocking to prevent
    /// deadlocks in the tokio runtime.
    pub async fn save_async(
        &self,
        script_id: &str,
        var_name: &str,
        value: &Value,
    ) -> Result<(), PersistenceError> {
        let conn = self.conn.clone();
        let script_id = script_id.to_string();
        let var_name = var_name.to_string();
        let value = value.clone();

        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| {
                PersistenceError::DatabaseLocked(format!("Cannot acquire lock: {}", e))
            })?;

            let value_json = serde_json::to_string(&value).map_err(|e| {
                PersistenceError::SerializationError(e.to_string())
            })?;

            conn.execute(
                "INSERT INTO retain_variables (script_id, var_name, var_value, updated_at)
                 VALUES (?1, ?2, ?3, strftime('%s', 'now'))
                 ON CONFLICT(script_id, var_name)
                 DO UPDATE SET var_value = ?3, updated_at = strftime('%s', 'now')",
                params![script_id, var_name, value_json],
            ).map_err(|e| PersistenceError::SaveFailed {
                script_id: script_id.clone(),
                var_name: var_name.clone(),
                reason: e.to_string(),
            })?;

            debug!(script_id = %script_id, var_name = %var_name, "Variable saved to persistence (async)");
            Ok(())
        })
        .await
        .map_err(|e| PersistenceError::ConnectionFailed(format!("Task join error: {}", e)))?
    }

    /// Async-safe variable load - use this from async contexts
    pub async fn load_async(
        &self,
        script_id: &str,
        var_name: &str,
    ) -> Result<Option<Value>, PersistenceError> {
        let conn = self.conn.clone();
        let script_id = script_id.to_string();
        let var_name = var_name.to_string();

        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| {
                PersistenceError::DatabaseLocked(format!("Cannot acquire lock: {}", e))
            })?;

            let result: Option<String> = conn
                .query_row(
                    "SELECT var_value FROM retain_variables WHERE script_id = ?1 AND var_name = ?2",
                    params![script_id, var_name],
                    |row| row.get(0),
                )
                .ok();

            match result {
                Some(json_str) => {
                    let value: Value = serde_json::from_str(&json_str).map_err(|e| {
                        PersistenceError::SerializationError(e.to_string())
                    })?;
                    debug!(script_id = %script_id, var_name = %var_name, "Variable loaded from persistence (async)");
                    Ok(Some(value))
                }
                None => Ok(None),
            }
        })
        .await
        .map_err(|e| PersistenceError::ConnectionFailed(format!("Task join error: {}", e)))?
    }

    /// Async-safe batch save - use this from async contexts
    pub async fn save_batch_async(
        &self,
        script_id: &str,
        variables: Vec<(String, Value)>,
    ) -> Result<(), PersistenceError> {
        let conn = self.conn.clone();
        let script_id = script_id.to_string();

        tokio::task::spawn_blocking(move || {
            let mut conn = conn.lock().map_err(|e| {
                PersistenceError::DatabaseLocked(format!("Cannot acquire lock: {}", e))
            })?;

            let tx = conn.transaction().map_err(|e| {
                PersistenceError::TransactionFailed(e.to_string())
            })?;

            {
                let mut stmt = tx
                    .prepare(
                        "INSERT INTO retain_variables (script_id, var_name, var_value, updated_at)
                         VALUES (?1, ?2, ?3, strftime('%s', 'now'))
                         ON CONFLICT(script_id, var_name)
                         DO UPDATE SET var_value = ?3, updated_at = strftime('%s', 'now')"
                    )
                    .map_err(|e| PersistenceError::TransactionFailed(e.to_string()))?;

                for (var_name, value) in &variables {
                    let value_json = serde_json::to_string(value).map_err(|e| {
                        PersistenceError::SerializationError(e.to_string())
                    })?;

                    stmt.execute(params![script_id, var_name, value_json]).map_err(|e| {
                        PersistenceError::SaveFailed {
                            script_id: script_id.clone(),
                            var_name: var_name.clone(),
                            reason: e.to_string(),
                        }
                    })?;
                }
            }

            tx.commit().map_err(|e| {
                PersistenceError::TransactionFailed(e.to_string())
            })?;

            debug!(script_id = %script_id, count = variables.len(), "Batch variables saved (async)");
            Ok(())
        })
        .await
        .map_err(|e| PersistenceError::ConnectionFailed(format!("Task join error: {}", e)))?
    }

    /// Async-safe list variables - use this from async contexts
    pub async fn list_async(
        &self,
        script_id: &str,
    ) -> Result<Vec<(String, Value)>, PersistenceError> {
        let conn = self.conn.clone();
        let script_id = script_id.to_string();

        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| {
                PersistenceError::DatabaseLocked(format!("Cannot acquire lock: {}", e))
            })?;

            let mut stmt = conn
                .prepare("SELECT var_name, var_value FROM retain_variables WHERE script_id = ?1")
                .map_err(|e| PersistenceError::LoadFailed {
                    script_id: script_id.clone(),
                    var_name: "*".to_string(),
                    reason: e.to_string(),
                })?;

            let rows = stmt
                .query_map(params![script_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| PersistenceError::LoadFailed {
                    script_id: script_id.clone(),
                    var_name: "*".to_string(),
                    reason: e.to_string(),
                })?;

            let mut variables = Vec::new();
            for (name, value_json) in rows.flatten() {
                if let Ok(value) = serde_json::from_str(&value_json) {
                    variables.push((name, value));
                }
            }

            Ok(variables)
        })
        .await
        .map_err(|e| PersistenceError::ConnectionFailed(format!("Task join error: {}", e)))?
    }

    /// Async-safe FB state save - use this from async contexts
    pub async fn save_fb_state_async(
        &self,
        fb_id: &str,
        state: &FBState,
    ) -> Result<(), PersistenceError> {
        let conn = self.conn.clone();
        let fb_id = fb_id.to_string();
        let state = state.clone();

        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| {
                PersistenceError::DatabaseLocked(format!("Cannot acquire lock: {}", e))
            })?;

            let state_json = serde_json::to_string(&state.state_data).map_err(|e| {
                PersistenceError::SerializationError(e.to_string())
            })?;

            conn.execute(
                "INSERT INTO fb_states (fb_id, fb_type, state_data, last_executed, updated_at)
                 VALUES (?1, ?2, ?3, ?4, strftime('%s', 'now'))
                 ON CONFLICT(fb_id)
                 DO UPDATE SET state_data = ?3, last_executed = ?4, updated_at = strftime('%s', 'now')",
                params![fb_id, state.fb_type, state_json, state.last_executed],
            ).map_err(|e| PersistenceError::SaveFailed {
                script_id: fb_id.clone(),
                var_name: "fb_state".to_string(),
                reason: e.to_string(),
            })?;

            debug!(fb_id = %fb_id, fb_type = %state.fb_type, "Function block state saved (async)");
            Ok(())
        })
        .await
        .map_err(|e| PersistenceError::ConnectionFailed(format!("Task join error: {}", e)))?
    }

    /// Async-safe FB state load - use this from async contexts
    pub async fn load_fb_state_async(
        &self,
        fb_id: &str,
    ) -> Result<Option<FBState>, PersistenceError> {
        let conn = self.conn.clone();
        let fb_id = fb_id.to_string();

        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| {
                PersistenceError::DatabaseLocked(format!("Cannot acquire lock: {}", e))
            })?;

            let result: Option<(String, String, i64)> = conn
                .query_row(
                    "SELECT fb_type, state_data, last_executed FROM fb_states WHERE fb_id = ?1",
                    params![fb_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .ok();

            match result {
                Some((fb_type, state_json, last_executed)) => {
                    let state_data: Value = serde_json::from_str(&state_json)
                        .map_err(|e| PersistenceError::SerializationError(e.to_string()))?;

                    Ok(Some(FBState {
                        fb_id: fb_id.clone(),
                        fb_type,
                        state_data,
                        last_executed,
                    }))
                }
                None => Ok(None),
            }
        })
        .await
        .map_err(|e| PersistenceError::ConnectionFailed(format!("Task join error: {}", e)))?
    }

    /// Async-safe execution history recording
    pub async fn record_execution_async(
        &self,
        script_id: &str,
        trigger_type: Option<&str>,
        success: bool,
        duration_ms: u64,
        error: Option<&str>,
    ) -> Result<(), PersistenceError> {
        let conn = self.conn.clone();
        let script_id = script_id.to_string();
        let trigger_type = trigger_type.map(|s| s.to_string());
        let error = error.map(|s| s.to_string());

        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| {
                PersistenceError::DatabaseLocked(format!("Cannot acquire lock: {}", e))
            })?;

            conn.execute(
                "INSERT INTO execution_history (script_id, trigger_type, success, duration_ms, error_message)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![script_id, trigger_type, success as i32, duration_ms as i64, error],
            ).map_err(|e| PersistenceError::SaveFailed {
                script_id: script_id.clone(),
                var_name: "execution_history".to_string(),
                reason: e.to_string(),
            })?;

            // BUG-013: Cleanup old entries (keep last 1000 per script).
            // Bounds-based deletion using the cutoff timestamp of the 1000th newest
            // entry avoids the O(n²) NOT IN subquery. The composite index on
            // (script_id, executed_at DESC) makes the inner SELECT O(log n + 1000)
            // and the outer DELETE O(rows to delete).
            conn.execute(
                "DELETE FROM execution_history
                 WHERE script_id = ?1 AND executed_at < (
                    SELECT executed_at FROM execution_history
                    WHERE script_id = ?1
                    ORDER BY executed_at DESC
                    LIMIT 1 OFFSET 999
                 )",
                params![script_id],
            ).ok(); // Ignore cleanup errors

            Ok(())
        })
        .await
        .map_err(|e| PersistenceError::ConnectionFailed(format!("Task join error: {}", e)))?
    }

    /// Async-safe stats retrieval
    pub async fn get_stats_async(&self) -> Result<PersistenceStats, PersistenceError> {
        let conn = self.conn.clone();
        let db_path = self.db_path.clone();

        tokio::task::spawn_blocking(move || {
            let conn = conn
                .lock()
                .map_err(|e| PersistenceError::DatabaseLocked(e.to_string()))?;

            let variable_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM retain_variables", [], |row| {
                    row.get(0)
                })
                .unwrap_or(0);

            let fb_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM fb_states", [], |row| row.get(0))
                .unwrap_or(0);

            let exec_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM execution_history", [], |row| {
                    row.get(0)
                })
                .unwrap_or(0);

            // Get database file size
            let db_size = if db_path != ":memory:" {
                std::fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0)
            } else {
                0
            };

            Ok(PersistenceStats {
                variable_count: variable_count as u64,
                fb_state_count: fb_count as u64,
                execution_history_count: exec_count as u64,
                database_size_bytes: db_size,
            })
        })
        .await
        .map_err(|e| PersistenceError::ConnectionFailed(format!("Task join error: {}", e)))?
    }
}

// ============================================================================
// Original Sync Implementation (kept for backwards compatibility)
// ============================================================================

impl SqlitePersistence {
    /// Create new persistence layer with database path
    pub fn new<P: AsRef<Path>>(db_path: P) -> Result<Self, PersistenceError> {
        let path_str = db_path.as_ref().to_string_lossy().to_string();
        info!(db_path = %path_str, "Initializing SQLite persistence");

        // Ensure parent directory exists
        if let Some(parent) = db_path.as_ref().parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    PersistenceError::ConnectionFailed(format!("Cannot create directory: {}", e))
                })?;
            }
        }

        // EDGE-HIGH-026: open + key via the canonical SQLCipher factory
        // (v1 device-secret key). The factory owns the PRAGMA key +
        // WAL/synchronous/busy_timeout/auto_vacuum sequence; finalize_open
        // then applies this store's performance pragmas + schema.
        let conn = crate::db::sqlcipher_factory::open_device_secret(
            db_path.as_ref(),
            "scripting_persistence",
            crate::db::sqlcipher_factory::PragmaProfile::DEFAULT,
        )
        .map_err(|e| PersistenceError::ConnectionFailed(format!("Cannot open database: {}", e)))?;

        Self::finalize_open(conn, path_str)
    }

    /// Manifest-aware constructor (PR-195 Batch #15 —
    /// third per-consumer adoption of
    /// `consumer_key_resolver` SSoT; SqlitePersistence
    /// is consumer 3 of 4 per ADR-031).
    ///
    /// Reads the per-DB sidecar manifest (Batch #329)
    /// and derives the SQLCipher PRAGMA key via
    /// `db_migration::consumer_key_resolver` (Batch #8).
    /// Missing manifest = legacy v1 default per Batch
    /// #330; v1 manifest = HMAC-SHA256 kernel; v2
    /// manifest = keystore-derived key.
    ///
    /// **Why `program_artifact_sha256` is required (not
    /// optional):** SqlitePersistence is a PROGRAM-BOUND
    /// consumer per ADR-031 (covers
    /// `scripting/persistence.rs` SCADA-program runtime
    /// state — distinct programs produce distinct
    /// keystore-derived keys, which is the tenant-
    /// isolation invariant). For the v2 path the
    /// resolver requires the program SHA bytes.
    /// For the v1 fallback path the SHA is unused but
    /// the caller still provides it — empty/dummy bytes
    /// are acceptable for v1-only hosts. main.rs's
    /// `init_retain_persistence` plumbs the SHA from
    /// the bytecode loader.
    ///
    /// **Why `deployment_uuid` is omitted:**
    /// program-bound consumers don't use the
    /// deployment-instance UUID per ADR-031. The
    /// resolver internally constructs a
    /// `ConsumerContext` with empty
    /// `deployment_uuid`; the resolver's branch on
    /// `purpose` ignores it for program-bound purposes.
    ///
    /// **Async:** `Keystore::derive_key` is async;
    /// caller awaits at boot time. Hot-path methods
    /// remain sync.
    pub async fn new_with_keystore_derivation<P: AsRef<Path>>(
        db_path: P,
        keystore: std::sync::Arc<dyn crate::keystore::Keystore>,
        program_artifact_sha256: Vec<u8>,
    ) -> Result<Self, PersistenceError> {
        let path_str = db_path.as_ref().to_string_lossy().to_string();
        info!(
            db_path = %path_str,
            "Initializing SQLite persistence (manifest-aware)"
        );

        if let Some(parent) = db_path.as_ref().parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    PersistenceError::ConnectionFailed(format!("Cannot create directory: {}", e))
                })?;
            }
        }

        // EDGE-HIGH-026: open + key via the canonical SQLCipher factory's
        // resolver path. Program-bound ConsumerContext per ADR-031:
        // deployment_uuid empty; program_artifact_sha256 carries the binding.
        // The factory assembles v1 inputs internally + owns the PRAGMA key
        // sequence; finalize_open applies perf pragmas + schema.
        let ctx = crate::db_migration::consumer_context::ConsumerContext {
            deployment_uuid: Vec::new(),
            program_artifact_sha256: Some(program_artifact_sha256),
        };

        let conn = crate::db::sqlcipher_factory::open_resolved(
            db_path.as_ref(),
            crate::keystore::purpose::KeyPurpose::SqlCipherRetainPersistence,
            &ctx,
            keystore.as_ref(),
            crate::db::sqlcipher_factory::PragmaProfile::DEFAULT,
        )
        .await
        .map_err(|e| PersistenceError::ConnectionFailed(format!("factory open_resolved: {}", e)))?
        .conn;

        Self::finalize_open(conn, path_str)
    }

    /// Shared post-PRAGMA-key initialization — emits
    /// the WAL/synchronous/busy_timeout/cache/temp
    /// PRAGMAs + runs migrations + returns the
    /// constructed `Self`. Extracted so both the
    /// legacy `new` and the manifest-aware
    /// `new_with_keystore_derivation` share the SAME
    /// post-key sequence (no drift in WAL mode or
    /// migration discipline between the two callers).
    fn finalize_open(conn: Connection, path_str: String) -> Result<Self, PersistenceError> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA busy_timeout=5000;
             PRAGMA cache_size=-8000;  -- 8MB cache
             PRAGMA temp_store=MEMORY;",
        )
        .map_err(|e| PersistenceError::ConnectionFailed(e.to_string()))?;

        let persistence = Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path: path_str,
        };

        persistence.run_migrations()?;
        info!("SQLite persistence initialized successfully");

        Ok(persistence)
    }

    /// Create in-memory database (for testing)
    pub fn in_memory() -> Result<Self, PersistenceError> {
        let conn = Connection::open_in_memory()
            .map_err(|e| PersistenceError::ConnectionFailed(e.to_string()))?;

        let persistence = Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path: ":memory:".to_string(),
        };

        persistence.run_migrations()?;
        Ok(persistence)
    }

    /// Run database migrations
    fn run_migrations(&self) -> Result<(), PersistenceError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| PersistenceError::DatabaseLocked(format!("Cannot acquire lock: {}", e)))?;

        // Create migrations table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            )",
            [],
        )
        .map_err(|e| PersistenceError::MigrationFailed(e.to_string()))?;

        // Check current version
        let current_version: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        debug!(
            current_version,
            target_version = SCHEMA_VERSION,
            "Checking migrations"
        );

        // Run migrations
        if current_version < 1 {
            self.migrate_v1(&conn)?;
        }

        Ok(())
    }

    /// Migration v1: Initial schema
    fn migrate_v1(&self, conn: &Connection) -> Result<(), PersistenceError> {
        info!("Running migration v1: Initial schema");

        conn.execute_batch(
            "-- RETAIN variables table
            CREATE TABLE IF NOT EXISTS retain_variables (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                script_id TEXT NOT NULL,
                var_name TEXT NOT NULL,
                var_value TEXT NOT NULL,  -- JSON encoded
                scope TEXT NOT NULL DEFAULT 'retain',
                created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                UNIQUE(script_id, var_name)
            );

            -- Index for fast script-based lookups
            CREATE INDEX IF NOT EXISTS idx_retain_vars_script
                ON retain_variables(script_id);

            -- Function block states table
            CREATE TABLE IF NOT EXISTS fb_states (
                fb_id TEXT PRIMARY KEY,
                fb_type TEXT NOT NULL,
                state_data TEXT NOT NULL,  -- JSON encoded
                last_executed INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );

            -- Script execution history (last 1000 entries per script)
            CREATE TABLE IF NOT EXISTS execution_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                script_id TEXT NOT NULL,
                executed_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                trigger_type TEXT,
                success INTEGER NOT NULL DEFAULT 1,
                duration_ms INTEGER,
                error_message TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_exec_history_script
                ON execution_history(script_id, executed_at DESC);

            -- Record migration
            INSERT INTO schema_migrations (version) VALUES (1);",
        )
        .map_err(|e| PersistenceError::MigrationFailed(e.to_string()))?;

        info!("Migration v1 completed");
        Ok(())
    }

    /// Get database statistics
    pub fn get_stats(&self) -> Result<PersistenceStats, PersistenceError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| PersistenceError::DatabaseLocked(e.to_string()))?;

        let variable_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM retain_variables", [], |row| {
                row.get(0)
            })
            .unwrap_or(0);

        let fb_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM fb_states", [], |row| row.get(0))
            .unwrap_or(0);

        let exec_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM execution_history", [], |row| {
                row.get(0)
            })
            .unwrap_or(0);

        // Get database file size
        let db_size = if self.db_path != ":memory:" {
            std::fs::metadata(&self.db_path)
                .map(|m| m.len())
                .unwrap_or(0)
        } else {
            0
        };

        Ok(PersistenceStats {
            variable_count: variable_count as u64,
            fb_state_count: fb_count as u64,
            execution_history_count: exec_count as u64,
            database_size_bytes: db_size,
        })
    }

    /// Record script execution for history
    pub fn record_execution(
        &self,
        script_id: &str,
        trigger_type: Option<&str>,
        success: bool,
        duration_ms: u64,
        error: Option<&str>,
    ) -> Result<(), PersistenceError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| PersistenceError::DatabaseLocked(e.to_string()))?;

        conn.execute(
            "INSERT INTO execution_history (script_id, trigger_type, success, duration_ms, error_message)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![script_id, trigger_type, success as i32, duration_ms as i64, error],
        ).map_err(|e| PersistenceError::SaveFailed {
            script_id: script_id.to_string(),
            var_name: "execution_history".to_string(),
            reason: e.to_string(),
        })?;

        // BUG-013: Cleanup old entries (keep last 1000 per script).
        // Bounds-based deletion avoids the O(n²) NOT IN subquery.
        conn.execute(
            "DELETE FROM execution_history
             WHERE script_id = ?1 AND executed_at < (
                SELECT executed_at FROM execution_history
                WHERE script_id = ?1
                ORDER BY executed_at DESC
                LIMIT 1 OFFSET 999
             )",
            params![script_id],
        )
        .ok(); // Ignore cleanup errors

        Ok(())
    }
}

/// Persistence statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistenceStats {
    pub variable_count: u64,
    pub fb_state_count: u64,
    pub execution_history_count: u64,
    pub database_size_bytes: u64,
}

// ============================================================================
// VariableStore Implementation
// ============================================================================

impl VariableStore for SqlitePersistence {
    fn save(&self, script_id: &str, var_name: &str, value: &Value) -> Result<(), PersistenceError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| PersistenceError::DatabaseLocked(e.to_string()))?;

        let value_json = serde_json::to_string(value)
            .map_err(|e| PersistenceError::SerializationError(e.to_string()))?;

        conn.execute(
            "INSERT INTO retain_variables (script_id, var_name, var_value, updated_at)
             VALUES (?1, ?2, ?3, strftime('%s', 'now'))
             ON CONFLICT(script_id, var_name)
             DO UPDATE SET var_value = ?3, updated_at = strftime('%s', 'now')",
            params![script_id, var_name, value_json],
        )
        .map_err(|e| PersistenceError::SaveFailed {
            script_id: script_id.to_string(),
            var_name: var_name.to_string(),
            reason: e.to_string(),
        })?;

        debug!(script_id, var_name, "Variable saved to persistence");
        Ok(())
    }

    fn load(&self, script_id: &str, var_name: &str) -> Result<Option<Value>, PersistenceError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| PersistenceError::DatabaseLocked(e.to_string()))?;

        let result: Option<String> = conn
            .query_row(
                "SELECT var_value FROM retain_variables WHERE script_id = ?1 AND var_name = ?2",
                params![script_id, var_name],
                |row| row.get(0),
            )
            .ok();

        match result {
            Some(json_str) => {
                let value: Value = serde_json::from_str(&json_str)
                    .map_err(|e| PersistenceError::SerializationError(e.to_string()))?;
                debug!(script_id, var_name, "Variable loaded from persistence");
                Ok(Some(value))
            }
            None => Ok(None),
        }
    }

    fn delete(&self, script_id: &str, var_name: &str) -> Result<(), PersistenceError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| PersistenceError::DatabaseLocked(e.to_string()))?;

        conn.execute(
            "DELETE FROM retain_variables WHERE script_id = ?1 AND var_name = ?2",
            params![script_id, var_name],
        )
        .map_err(|e| PersistenceError::SaveFailed {
            script_id: script_id.to_string(),
            var_name: var_name.to_string(),
            reason: e.to_string(),
        })?;

        debug!(script_id, var_name, "Variable deleted from persistence");
        Ok(())
    }

    fn list(&self, script_id: &str) -> Result<Vec<(String, Value)>, PersistenceError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| PersistenceError::DatabaseLocked(e.to_string()))?;

        let mut stmt = conn
            .prepare("SELECT var_name, var_value FROM retain_variables WHERE script_id = ?1")
            .map_err(|e| PersistenceError::LoadFailed {
                script_id: script_id.to_string(),
                var_name: "*".to_string(),
                reason: e.to_string(),
            })?;

        let rows = stmt
            .query_map(params![script_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| PersistenceError::LoadFailed {
                script_id: script_id.to_string(),
                var_name: "*".to_string(),
                reason: e.to_string(),
            })?;

        let mut variables = Vec::new();
        for (name, value_json) in rows.flatten() {
            if let Ok(value) = serde_json::from_str(&value_json) {
                variables.push((name, value));
            }
        }

        Ok(variables)
    }

    fn save_batch(
        &self,
        script_id: &str,
        variables: &[(String, Value)],
    ) -> Result<(), PersistenceError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| PersistenceError::DatabaseLocked(e.to_string()))?;

        let tx = conn
            .transaction()
            .map_err(|e| PersistenceError::TransactionFailed(e.to_string()))?;

        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO retain_variables (script_id, var_name, var_value, updated_at)
                     VALUES (?1, ?2, ?3, strftime('%s', 'now'))
                     ON CONFLICT(script_id, var_name)
                     DO UPDATE SET var_value = ?3, updated_at = strftime('%s', 'now')",
                )
                .map_err(|e| PersistenceError::TransactionFailed(e.to_string()))?;

            for (var_name, value) in variables {
                let value_json = serde_json::to_string(value)
                    .map_err(|e| PersistenceError::SerializationError(e.to_string()))?;

                stmt.execute(params![script_id, var_name, value_json])
                    .map_err(|e| PersistenceError::SaveFailed {
                        script_id: script_id.to_string(),
                        var_name: var_name.clone(),
                        reason: e.to_string(),
                    })?;
            }
        }

        tx.commit()
            .map_err(|e| PersistenceError::TransactionFailed(e.to_string()))?;

        debug!(script_id, count = variables.len(), "Batch variables saved");
        Ok(())
    }

    fn clear_script(&self, script_id: &str) -> Result<(), PersistenceError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| PersistenceError::DatabaseLocked(e.to_string()))?;

        conn.execute(
            "DELETE FROM retain_variables WHERE script_id = ?1",
            params![script_id],
        )
        .map_err(|e| PersistenceError::SaveFailed {
            script_id: script_id.to_string(),
            var_name: "*".to_string(),
            reason: e.to_string(),
        })?;

        info!(script_id, "All variables cleared for script");
        Ok(())
    }
}

// ============================================================================
// FunctionBlockStore Implementation
// ============================================================================

impl FunctionBlockStore for SqlitePersistence {
    fn save_fb_state(&self, fb_id: &str, state: &FBState) -> Result<(), PersistenceError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| PersistenceError::DatabaseLocked(e.to_string()))?;

        let state_json = serde_json::to_string(&state.state_data)
            .map_err(|e| PersistenceError::SerializationError(e.to_string()))?;

        conn.execute(
            "INSERT INTO fb_states (fb_id, fb_type, state_data, last_executed, updated_at)
             VALUES (?1, ?2, ?3, ?4, strftime('%s', 'now'))
             ON CONFLICT(fb_id)
             DO UPDATE SET state_data = ?3, last_executed = ?4, updated_at = strftime('%s', 'now')",
            params![fb_id, state.fb_type, state_json, state.last_executed],
        )
        .map_err(|e| PersistenceError::SaveFailed {
            script_id: fb_id.to_string(),
            var_name: "fb_state".to_string(),
            reason: e.to_string(),
        })?;

        debug!(fb_id, fb_type = %state.fb_type, "Function block state saved");
        Ok(())
    }

    fn load_fb_state(&self, fb_id: &str) -> Result<Option<FBState>, PersistenceError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| PersistenceError::DatabaseLocked(e.to_string()))?;

        let result: Option<(String, String, i64)> = conn
            .query_row(
                "SELECT fb_type, state_data, last_executed FROM fb_states WHERE fb_id = ?1",
                params![fb_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .ok();

        match result {
            Some((fb_type, state_json, last_executed)) => {
                let state_data: Value = serde_json::from_str(&state_json)
                    .map_err(|e| PersistenceError::SerializationError(e.to_string()))?;

                Ok(Some(FBState {
                    fb_id: fb_id.to_string(),
                    fb_type,
                    state_data,
                    last_executed,
                }))
            }
            None => Ok(None),
        }
    }

    fn clear_fb_state(&self, fb_id: &str) -> Result<(), PersistenceError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| PersistenceError::DatabaseLocked(e.to_string()))?;

        conn.execute("DELETE FROM fb_states WHERE fb_id = ?1", params![fb_id])
            .map_err(|e| PersistenceError::SaveFailed {
                script_id: fb_id.to_string(),
                var_name: "fb_state".to_string(),
                reason: e.to_string(),
            })?;

        debug!(fb_id, "Function block state cleared");
        Ok(())
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn setup_test_db() -> SqlitePersistence {
        SqlitePersistence::in_memory().expect("Failed to create test database")
    }

    #[test]
    fn test_variable_save_and_load() {
        let db = setup_test_db();

        // Save a variable
        db.save("script-1", "counter", &json!(42)).unwrap();

        // Load it back
        let value = db.load("script-1", "counter").unwrap();
        assert_eq!(value, Some(json!(42)));
    }

    #[test]
    fn test_variable_update() {
        let db = setup_test_db();

        // Save initial value
        db.save("script-1", "temp", &json!(25.5)).unwrap();
        assert_eq!(db.load("script-1", "temp").unwrap(), Some(json!(25.5)));

        // Update value
        db.save("script-1", "temp", &json!(28.0)).unwrap();
        assert_eq!(db.load("script-1", "temp").unwrap(), Some(json!(28.0)));
    }

    #[test]
    fn test_variable_not_found() {
        let db = setup_test_db();
        let value = db.load("nonexistent", "var").unwrap();
        assert_eq!(value, None);
    }

    #[test]
    fn test_variable_delete() {
        let db = setup_test_db();

        db.save("script-1", "temp", &json!(25.5)).unwrap();
        assert!(db.load("script-1", "temp").unwrap().is_some());

        db.delete("script-1", "temp").unwrap();
        assert!(db.load("script-1", "temp").unwrap().is_none());
    }

    #[test]
    fn test_list_variables() {
        let db = setup_test_db();

        db.save("script-1", "var1", &json!(1)).unwrap();
        db.save("script-1", "var2", &json!(2)).unwrap();
        db.save("script-1", "var3", &json!(3)).unwrap();
        db.save("script-2", "other", &json!(99)).unwrap(); // Different script

        let vars = db.list("script-1").unwrap();
        assert_eq!(vars.len(), 3);
    }

    #[test]
    fn test_batch_save() {
        let db = setup_test_db();

        let variables = vec![
            ("a".to_string(), json!(1)),
            ("b".to_string(), json!(2)),
            ("c".to_string(), json!(3)),
        ];

        db.save_batch("script-batch", &variables).unwrap();

        assert_eq!(db.load("script-batch", "a").unwrap(), Some(json!(1)));
        assert_eq!(db.load("script-batch", "b").unwrap(), Some(json!(2)));
        assert_eq!(db.load("script-batch", "c").unwrap(), Some(json!(3)));
    }

    #[test]
    fn test_clear_script() {
        let db = setup_test_db();

        db.save("script-1", "a", &json!(1)).unwrap();
        db.save("script-1", "b", &json!(2)).unwrap();
        db.save("script-2", "c", &json!(3)).unwrap();

        db.clear_script("script-1").unwrap();

        assert!(db.load("script-1", "a").unwrap().is_none());
        assert!(db.load("script-1", "b").unwrap().is_none());
        assert_eq!(db.load("script-2", "c").unwrap(), Some(json!(3))); // Untouched
    }

    #[test]
    fn test_fb_state_save_and_load() {
        let db = setup_test_db();

        let state = FBState {
            fb_id: "ton_1".to_string(),
            fb_type: "TON".to_string(),
            state_data: json!({
                "elapsed_ms": 5000,
                "output": false
            }),
            last_executed: 1704067200,
        };

        db.save_fb_state("ton_1", &state).unwrap();

        let loaded = db.load_fb_state("ton_1").unwrap().unwrap();
        assert_eq!(loaded.fb_type, "TON");
        assert_eq!(loaded.state_data["elapsed_ms"], 5000);
    }

    #[test]
    fn test_complex_json_values() {
        let db = setup_test_db();

        let complex = json!({
            "array": [1, 2, 3],
            "nested": {
                "deep": true
            },
            "null_value": null
        });

        db.save("script-1", "complex", &complex).unwrap();
        let loaded = db.load("script-1", "complex").unwrap().unwrap();

        assert_eq!(loaded["array"][1], 2);
        assert_eq!(loaded["nested"]["deep"], true);
        assert!(loaded["null_value"].is_null());
    }

    #[test]
    fn test_stats() {
        let db = setup_test_db();

        db.save("script-1", "a", &json!(1)).unwrap();
        db.save("script-1", "b", &json!(2)).unwrap();
        db.save_fb_state(
            "fb-1",
            &FBState {
                fb_id: "fb-1".to_string(),
                fb_type: "TON".to_string(),
                state_data: json!({}),
                last_executed: 0,
            },
        )
        .unwrap();

        let stats = db.get_stats().unwrap();
        assert_eq!(stats.variable_count, 2);
        assert_eq!(stats.fb_state_count, 1);
    }

    #[test]
    fn test_execution_history() {
        let db = setup_test_db();

        db.record_execution("script-1", Some("threshold"), true, 15, None)
            .unwrap();
        db.record_execution("script-1", Some("schedule"), false, 5, Some("Timeout"))
            .unwrap();

        let stats = db.get_stats().unwrap();
        assert_eq!(stats.execution_history_count, 2);
    }

    // -------- Batch #15 — manifest-aware constructor tests --------

    use crate::db_migration::manifest::{
        DbKeySourceManifest, manifest_path_for_db, write_manifest as write_db_manifest,
    };
    use crate::db_migration::schema_version::DbKeySchemaVersion;
    use crate::keystore::error::{
        KeyDerivationError as KsKeyDerivationError, KeystoreError, KeystoreErrorKind,
    };
    use crate::keystore::purpose::{DerivedKeyId, KeyPurpose};
    use crate::keystore::secret::KeyMaterial;
    use crate::keystore::{KeyBackend, RotationSource};
    use async_trait::async_trait;
    use std::sync::Mutex as StdMutex;

    static PERSISTENCE_ENV_MUTEX: StdMutex<()> = StdMutex::new(());

    struct PersistenceStubKeystore;

    #[async_trait]
    impl crate::keystore::Keystore for PersistenceStubKeystore {
        fn backend(&self) -> KeyBackend {
            KeyBackend::FileBacked
        }

        async fn derive_key(
            &self,
            purpose: KeyPurpose,
            _context: &[u8],
        ) -> std::result::Result<KeyMaterial, KsKeyDerivationError> {
            let mut bytes = [0u8; 32];
            bytes[0] = match purpose {
                KeyPurpose::SqlCipherRetainPersistence => 0xb2,
                _ => 0xff,
            };
            Ok(KeyMaterial::from_derived_bytes(purpose, bytes))
        }

        fn derived_key_id(&self, _purpose: KeyPurpose, _context: &[u8]) -> DerivedKeyId {
            DerivedKeyId([0u8; 16])
        }

        async fn rotate_master(&self) -> std::result::Result<(), KeystoreError> {
            Err(KeystoreError::new(
                KeystoreErrorKind::NotImplemented,
                String::from("stub"),
            ))
        }

        async fn rotate_master_with_source(
            &self,
            _source: RotationSource<'_>,
        ) -> std::result::Result<(), KeystoreError> {
            Err(KeystoreError::new(
                KeystoreErrorKind::NotImplemented,
                String::from("stub"),
            ))
        }
    }

    fn ensure_persistence_secret(dir: &std::path::Path) {
        let secret = dir.join("db.key");
        if !secret.exists() {
            std::fs::write(&secret, vec![0xCDu8; 32]).expect("seed secret");
        }
    }

    #[tokio::test]
    async fn new_with_keystore_derivation_no_manifest_uses_v1_legacy_default() {
        let _guard = PERSISTENCE_ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        ensure_persistence_secret(dir.path());
        let secret = dir.path().join("db.key");
        let db_path = dir.path().join("retain_persistence.db");

        // SAFETY: env-mutation serialized.
        unsafe {
            std::env::set_var("SUDERRA_DB_KEY_PATH", &secret);
        }
        let result = SqlitePersistence::new_with_keystore_derivation(
            &db_path,
            std::sync::Arc::new(PersistenceStubKeystore),
            vec![0xAB; 32], // dummy program SHA — unused on v1 path
        )
        .await;
        unsafe {
            std::env::remove_var("SUDERRA_DB_KEY_PATH");
        }

        let _store = result.expect("open with v1 fallback");
    }

    #[tokio::test]
    async fn new_with_keystore_derivation_v2_manifest_opens_with_keystore_key() {
        let _guard = PERSISTENCE_ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        ensure_persistence_secret(dir.path());
        let secret = dir.path().join("db.key");
        let db_path = dir.path().join("retain_persistence.db");

        // Compute v2 key: StubKeystore returns 0xb2-prefix
        // for SqlCipherRetainPersistence.
        let mut v2_bytes = [0u8; 32];
        v2_bytes[0] = 0xb2;
        let v2_hex = crate::db_migration::v1_legacy_key::format_sqlcipher_pragma_key_hex(&v2_bytes);

        // Pre-seed DB encrypted under v2.
        {
            let conn = Connection::open(&db_path).expect("seed");
            // INVARIANT-ALLOW: sqlcipher-test-seed — seeds a v2-encrypted fixture.
            conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", v2_hex))
                .expect("apply v2");
            conn.execute_batch(
                "CREATE TABLE seed (id INTEGER PRIMARY KEY); \
                 INSERT INTO seed VALUES (1);",
            )
            .expect("seed table");
        }

        write_db_manifest(
            &manifest_path_for_db(&db_path),
            &DbKeySourceManifest {
                schema_version: DbKeySchemaVersion::V2KeystoreDerived,
                last_updated_at_unix_secs: 1_700_000_000,
            },
        )
        .expect("seed v2 manifest");

        // SAFETY: env-mutation serialized.
        unsafe {
            std::env::set_var("SUDERRA_DB_KEY_PATH", &secret);
        }
        let result = SqlitePersistence::new_with_keystore_derivation(
            &db_path,
            std::sync::Arc::new(PersistenceStubKeystore),
            vec![0xCC; 32], // program SHA used by v2 path
        )
        .await;
        unsafe {
            std::env::remove_var("SUDERRA_DB_KEY_PATH");
        }

        let _store = result.expect("open with v2 keystore key");
    }

    #[tokio::test]
    async fn new_with_keystore_derivation_corrupt_manifest_fails_closed() {
        let _guard = PERSISTENCE_ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        ensure_persistence_secret(dir.path());
        let secret = dir.path().join("db.key");
        let db_path = dir.path().join("retain_persistence.db");

        std::fs::write(manifest_path_for_db(&db_path), b"not valid json").expect("seed corrupt");

        // SAFETY: env-mutation serialized.
        unsafe {
            std::env::set_var("SUDERRA_DB_KEY_PATH", &secret);
        }
        let result = SqlitePersistence::new_with_keystore_derivation(
            &db_path,
            std::sync::Arc::new(PersistenceStubKeystore),
            vec![0xAB; 32],
        )
        .await;
        unsafe {
            std::env::remove_var("SUDERRA_DB_KEY_PATH");
        }

        let err = match result {
            Ok(_) => panic!("expected error"),
            Err(e) => e,
        };
        match err {
            PersistenceError::ConnectionFailed(msg) => {
                assert!(
                    msg.contains("resolver"),
                    "expected resolver-failed message, got: {msg}"
                );
            }
            other => panic!("expected ConnectionFailed, got {other:?}"),
        }
    }
}
