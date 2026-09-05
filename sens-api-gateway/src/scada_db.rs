// SCADA runtime SQLite database module
// Provides encrypted local storage for trend data, alarms, calibration, audit logs, and packages.

use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

// ---------------------------------------------------------------------------
// Data structs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrendPoint {
    pub timestamp: i64,
    pub value: f64,
    pub quality: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlarmRecord {
    pub id: String,
    pub tag_name: String,
    pub rule_id: String,
    pub severity: String,
    pub message: String,
    pub triggered_at: i64,
    pub acked_at: Option<i64>,
    pub acked_by: Option<String>,
    pub cleared_at: Option<i64>,
    pub value_at_trigger: f64,
    pub synced: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalibrationRecord {
    pub id: String,
    pub tag_name: String,
    pub sensor_type: String,
    pub method: String,
    pub points_json: String,
    pub slope: Option<f64>,
    pub offset_val: Option<f64>,
    pub r_squared: Option<f64>,
    pub prev_slope: Option<f64>,
    pub prev_offset: Option<f64>,
    pub calibrated_at: i64,
    pub calibrated_by: Option<String>,
    pub next_due_at: Option<i64>,
    pub synced: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: String,
    pub timestamp: i64,
    pub source_ip: Option<String>,
    pub action: String,
    pub tag_name: Option<String>,
    pub old_value: Option<f64>,
    pub new_value: Option<f64>,
    pub pin_used: bool,
    pub success: bool,
    pub error_msg: Option<String>,
    pub synced: bool,
}

// ---------------------------------------------------------------------------
// Encryption key derivation (EDGE-CRITICAL-002)
// ---------------------------------------------------------------------------
//
// The prior `derive_db_key` used `SHA256("suderra-scada-" + machine_uid)`
// with a universal `"default-machine-id"` fallback — a key readable off a
// stolen SD card, and (on machine-id failure) an offline-computable key
// identical on every device. It protected the entire SCADA store including
// the `audit_log` tamper-evidence record. It is replaced by the same
// keystore/TPM-aware consumer-key resolver the offline queue uses.

/// DEPRECATED, migration-only: the pre-EDGE-CRITICAL-002 machine-id
/// SQLCipher passphrase. Retained SOLELY to open an existing `scada.db`
/// so it can be rekeyed to the hardened key — never used to create or
/// protect a database going forward.
fn legacy_machine_id_passphrase() -> String {
    let machine_id = machine_uid::get().unwrap_or_else(|_| "default-machine-id".to_string());
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"suderra-scada-");
    hasher.update(machine_id.as_bytes());
    format!("{:x}", hasher.finalize())
}

// ---------------------------------------------------------------------------
// ScadaDb
// ---------------------------------------------------------------------------

pub struct ScadaDb {
    conn: std::sync::Mutex<rusqlite::Connection>,
}

impl ScadaDb {
    /// Open the SCADA-display store with a keystore/TPM-aware SQLCipher
    /// key (EDGE-CRITICAL-002).
    ///
    /// - `keystore: Some` → the consumer-key resolver derives the key via
    ///   the keystore (TPM-sealed where available), matching
    ///   `OfflineQueue::with_keystore_derivation`.
    /// - `keystore: None` (keystore disabled) → the device-secret legacy
    ///   derivation `HMAC-SHA256(machine_id, /etc/suderra/db.key)` — the
    ///   same fallback the offline queue uses: device-bound, fail-closed
    ///   on machine-id read error, and with NO universal constant.
    ///
    /// An existing `scada.db` still under the deprecated machine-id key is
    /// transparently rekeyed to the hardened key (data preserved); a file
    /// that opens with neither key fails closed without deletion.
    pub async fn new(
        path: &str,
        keystore: Option<std::sync::Arc<dyn crate::keystore::Keystore>>,
        deployment_uuid: Vec<u8>,
    ) -> Result<Self, String> {
        if let Some(parent) = std::path::Path::new(path).parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
        }

        let new_key: zeroize::Zeroizing<String> = match keystore {
            Some(ks) => {
                let machine_id = crate::machine_id::read()
                    .map_err(|e| format!("ScadaDb: machine_id read failed (fail-closed): {e}"))?;
                let secret_key = crate::db_secret::read_or_create_v1_secret()
                    .map_err(|e| format!("ScadaDb: db_secret load failed: {e}"))?;
                let v1_inputs = crate::db_migration::consumer_key_resolver::V1Inputs {
                    machine_id: machine_id.into_bytes(),
                    secret_key,
                };
                let ctx = crate::db_migration::consumer_context::ConsumerContext {
                    deployment_uuid,
                    program_artifact_sha256: None,
                };
                crate::db_migration::consumer_key_resolver::resolve_consumer_pragma_key(
                    std::path::Path::new(path),
                    crate::keystore::purpose::KeyPurpose::SqlCipherScadaDisplay,
                    &ctx,
                    ks.as_ref(),
                    &v1_inputs,
                )
                .await
                .map_err(|e| format!("ScadaDb key resolver failed (fail-closed): {e}"))?
                .pragma_key_hex
            }
            None => {
                warn!(
                    "SECURITY: SCADA store opening on a non-keystore-sealed device-secret key \
                     (keystore disabled) — provision a keystore/TPM to seal the SCADA at-rest key"
                );
                zeroize::Zeroizing::new(
                    crate::offline_queue::derive_db_encryption_key()
                        .map_err(|e| format!("ScadaDb device-secret key derivation failed: {e}"))?,
                )
            }
        };

        let conn = Self::open_with_key_or_migrate(path, new_key.as_str())?;

        conn.execute_batch(
            "
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=NORMAL;
            PRAGMA busy_timeout=5000;
        ",
        )
        .map_err(|e| format!("DB pragma: {}", e))?;

        let db = Self {
            conn: std::sync::Mutex::new(conn),
        };
        db.init_schema()?;
        debug!("SCADA database initialized at {}", path);
        Ok(db)
    }

    /// Open `path` under `new_key_hex` (SQLCipher raw-key form). A fresh
    /// or already-hardened DB opens directly; an existing DB still under
    /// the deprecated machine-id passphrase is rekeyed in place to the
    /// hardened key (EDGE-CRITICAL-002 one-shot migration). A file that
    /// opens with neither key fails closed — it is never deleted.
    fn open_with_key_or_migrate(
        path: &str,
        new_key_hex: &str,
    ) -> Result<rusqlite::Connection, String> {
        let conn = rusqlite::Connection::open(path).map_err(|e| format!("DB open: {}", e))?;
        conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", new_key_hex))
            .map_err(|e| format!("DB key: {}", e))?;
        // Probe: does the hardened key decrypt this file?
        if conn
            .query_row("SELECT count(*) FROM sqlite_master", [], |r| {
                r.get::<_, i64>(0)
            })
            .is_ok()
        {
            return Ok(conn);
        }

        // Existing DB under the deprecated machine-id key — open with it
        // and rekey to the hardened key, preserving trends/alarms/audit.
        drop(conn);
        let conn = rusqlite::Connection::open(path).map_err(|e| format!("DB reopen: {}", e))?;
        let legacy = legacy_machine_id_passphrase();
        conn.pragma_update(None, "key", &legacy)
            .map_err(|e| format!("DB legacy key: {}", e))?;
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(|e| {
            format!(
                "ScadaDb: existing database opens with neither the hardened key nor the \
                 deprecated machine-id key (corrupt or foreign) — failing closed without \
                 deletion: {e}"
            )
        })?;
        conn.execute_batch(&format!("PRAGMA rekey = \"x'{}'\";", new_key_hex))
            .map_err(|e| format!("ScadaDb: rekey to hardened key failed: {}", e))?;
        warn!(
            "SCADA store migrated from the deprecated machine-id key to the hardened \
             keystore/device key (EDGE-CRITICAL-002)"
        );
        Ok(conn)
    }

    fn init_schema(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock: {}", e))?;
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS trend_data (
                tag_name TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                value REAL NOT NULL,
                quality INTEGER DEFAULT 192,
                PRIMARY KEY (tag_name, timestamp)
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS idx_trend_time ON trend_data(timestamp);

            CREATE TABLE IF NOT EXISTS alarm_history (
                id TEXT PRIMARY KEY,
                tag_name TEXT NOT NULL,
                rule_id TEXT NOT NULL,
                severity TEXT NOT NULL,
                message TEXT NOT NULL,
                triggered_at INTEGER NOT NULL,
                acked_at INTEGER,
                acked_by TEXT,
                cleared_at INTEGER,
                value_at_trigger REAL,
                synced INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS calibration_log (
                id TEXT PRIMARY KEY,
                tag_name TEXT NOT NULL,
                sensor_type TEXT NOT NULL,
                method TEXT NOT NULL,
                points_json TEXT NOT NULL,
                slope REAL,
                offset_val REAL,
                r_squared REAL,
                prev_slope REAL,
                prev_offset REAL,
                calibrated_at INTEGER NOT NULL,
                calibrated_by TEXT,
                next_due_at INTEGER,
                synced INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS audit_log (
                id TEXT PRIMARY KEY,
                timestamp INTEGER NOT NULL,
                source_ip TEXT,
                action TEXT NOT NULL,
                tag_name TEXT,
                old_value REAL,
                new_value REAL,
                pin_used INTEGER DEFAULT 0,
                success INTEGER DEFAULT 1,
                error_msg TEXT,
                synced INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS scada_package (
                version INTEGER PRIMARY KEY,
                package_json TEXT NOT NULL,
                deployed_at INTEGER NOT NULL,
                deployed_by TEXT,
                is_active INTEGER DEFAULT 1
            );
            ",
        )
        .map_err(|e| format!("Schema init: {}", e))?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Trend data
    // -----------------------------------------------------------------------

    pub fn insert_trend(
        &self,
        tag: &str,
        timestamp: i64,
        value: f64,
        quality: u8,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock: {}", e))?;
        conn.execute(
            "INSERT OR REPLACE INTO trend_data (tag_name, timestamp, value, quality) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![tag, timestamp, value, quality],
        )
        .map_err(|e| format!("Insert trend: {}", e))?;
        Ok(())
    }

    pub fn query_trend(&self, tag: &str, from: i64, to: i64) -> Result<Vec<TrendPoint>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT timestamp, value, quality FROM trend_data \
                 WHERE tag_name = ?1 AND timestamp BETWEEN ?2 AND ?3 ORDER BY timestamp",
            )
            .map_err(|e| format!("Prepare: {}", e))?;

        let rows = stmt
            .query_map(rusqlite::params![tag, from, to], |row| {
                Ok(TrendPoint {
                    timestamp: row.get(0)?,
                    value: row.get(1)?,
                    quality: row.get::<_, u8>(2)?,
                })
            })
            .map_err(|e| format!("Query trend: {}", e))?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| format!("Row: {}", e))?);
        }
        Ok(result)
    }

    pub fn insert_trend_batch(&self, records: &[(String, i64, f64, u8)]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock: {}", e))?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Transaction: {}", e))?;

        {
            let mut stmt = tx
                .prepare_cached(
                    "INSERT OR REPLACE INTO trend_data (tag_name, timestamp, value, quality) VALUES (?1, ?2, ?3, ?4)",
                )
                .map_err(|e| format!("Prepare: {}", e))?;

            for (tag, ts, val, quality) in records {
                stmt.execute(rusqlite::params![tag, ts, val, quality])
                    .map_err(|e| format!("Batch insert: {}", e))?;
            }
        }

        tx.commit().map_err(|e| format!("Commit: {}", e))?;
        debug!("Inserted {} trend records", records.len());
        Ok(())
    }

    pub fn cleanup_old_trends(&self, retention_days: u32) -> Result<u64, String> {
        let cutoff = chrono::Utc::now().timestamp_millis() - (retention_days as i64) * 86400 * 1000;
        let conn = self.conn.lock().map_err(|e| format!("Lock: {}", e))?;
        let deleted = conn
            .execute(
                "DELETE FROM trend_data WHERE timestamp < ?1",
                rusqlite::params![cutoff],
            )
            .map_err(|e| format!("Cleanup: {}", e))?;
        debug!(
            "Cleaned up {} trend records older than {} days",
            deleted, retention_days
        );
        Ok(deleted as u64)
    }

    // -----------------------------------------------------------------------
    // Alarms
    // -----------------------------------------------------------------------

    pub fn insert_alarm(
        &self,
        id: &str,
        tag: &str,
        rule_id: &str,
        severity: &str,
        message: &str,
        value: f64,
    ) -> Result<(), String> {
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.conn.lock().map_err(|e| format!("Lock: {}", e))?;
        conn.execute(
            "INSERT INTO alarm_history (id, tag_name, rule_id, severity, message, triggered_at, value_at_trigger) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![id, tag, rule_id, severity, message, now, value],
        )
        .map_err(|e| format!("Insert alarm: {}", e))?;
        Ok(())
    }

    pub fn ack_alarm(&self, id: &str, acked_by: &str) -> Result<(), String> {
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.conn.lock().map_err(|e| format!("Lock: {}", e))?;
        conn.execute(
            "UPDATE alarm_history SET acked_at = ?1, acked_by = ?2 WHERE id = ?3",
            rusqlite::params![now, acked_by, id],
        )
        .map_err(|e| format!("Ack alarm: {}", e))?;
        Ok(())
    }

    pub fn clear_alarm(&self, id: &str) -> Result<(), String> {
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.conn.lock().map_err(|e| format!("Lock: {}", e))?;
        conn.execute(
            "UPDATE alarm_history SET cleared_at = ?1 WHERE id = ?2",
            rusqlite::params![now, id],
        )
        .map_err(|e| format!("Clear alarm: {}", e))?;
        Ok(())
    }

    pub fn get_active_alarms(&self) -> Result<Vec<AlarmRecord>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, tag_name, rule_id, severity, message, triggered_at, \
                 acked_at, acked_by, cleared_at, value_at_trigger, synced \
                 FROM alarm_history WHERE cleared_at IS NULL ORDER BY triggered_at DESC",
            )
            .map_err(|e| format!("Prepare: {}", e))?;

        Self::collect_alarms(&mut stmt, [])
    }

    pub fn get_alarm_history(&self, limit: u32) -> Result<Vec<AlarmRecord>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, tag_name, rule_id, severity, message, triggered_at, \
                 acked_at, acked_by, cleared_at, value_at_trigger, synced \
                 FROM alarm_history ORDER BY triggered_at DESC LIMIT ?1",
            )
            .map_err(|e| format!("Prepare: {}", e))?;

        Self::collect_alarms(&mut stmt, [limit])
    }

    fn collect_alarms<P: rusqlite::Params>(
        stmt: &mut rusqlite::Statement<'_>,
        params: P,
    ) -> Result<Vec<AlarmRecord>, String> {
        let rows = stmt
            .query_map(params, |row| {
                Ok(AlarmRecord {
                    id: row.get(0)?,
                    tag_name: row.get(1)?,
                    rule_id: row.get(2)?,
                    severity: row.get(3)?,
                    message: row.get(4)?,
                    triggered_at: row.get(5)?,
                    acked_at: row.get(6)?,
                    acked_by: row.get(7)?,
                    cleared_at: row.get(8)?,
                    value_at_trigger: row.get(9)?,
                    synced: row.get::<_, i32>(10)? != 0,
                })
            })
            .map_err(|e| format!("Query alarms: {}", e))?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| format!("Row: {}", e))?);
        }
        Ok(result)
    }

    // -----------------------------------------------------------------------
    // Calibration
    // -----------------------------------------------------------------------

    pub fn insert_calibration(&self, record: &CalibrationRecord) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock: {}", e))?;
        conn.execute(
            "INSERT INTO calibration_log \
             (id, tag_name, sensor_type, method, points_json, slope, offset_val, r_squared, \
              prev_slope, prev_offset, calibrated_at, calibrated_by, next_due_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            rusqlite::params![
                record.id,
                record.tag_name,
                record.sensor_type,
                record.method,
                record.points_json,
                record.slope,
                record.offset_val,
                record.r_squared,
                record.prev_slope,
                record.prev_offset,
                record.calibrated_at,
                record.calibrated_by,
                record.next_due_at,
            ],
        )
        .map_err(|e| format!("Insert calibration: {}", e))?;
        Ok(())
    }

    pub fn get_calibration_history(
        &self,
        tag: &str,
        limit: u32,
    ) -> Result<Vec<CalibrationRecord>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, tag_name, sensor_type, method, points_json, slope, offset_val, \
                 r_squared, prev_slope, prev_offset, calibrated_at, calibrated_by, next_due_at, synced \
                 FROM calibration_log WHERE tag_name = ?1 ORDER BY calibrated_at DESC LIMIT ?2",
            )
            .map_err(|e| format!("Prepare: {}", e))?;

        let rows = stmt
            .query_map(rusqlite::params![tag, limit], |row| {
                Self::row_to_calibration(row)
            })
            .map_err(|e| format!("Query calibration: {}", e))?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| format!("Row: {}", e))?);
        }
        Ok(result)
    }

    pub fn get_latest_calibration(&self, tag: &str) -> Result<Option<CalibrationRecord>, String> {
        let mut records = self.get_calibration_history(tag, 1)?;
        Ok(records.pop())
    }

    fn row_to_calibration(row: &rusqlite::Row<'_>) -> rusqlite::Result<CalibrationRecord> {
        Ok(CalibrationRecord {
            id: row.get(0)?,
            tag_name: row.get(1)?,
            sensor_type: row.get(2)?,
            method: row.get(3)?,
            points_json: row.get(4)?,
            slope: row.get(5)?,
            offset_val: row.get(6)?,
            r_squared: row.get(7)?,
            prev_slope: row.get(8)?,
            prev_offset: row.get(9)?,
            calibrated_at: row.get(10)?,
            calibrated_by: row.get(11)?,
            next_due_at: row.get(12)?,
            synced: row.get::<_, i32>(13)? != 0,
        })
    }

    // -----------------------------------------------------------------------
    // Audit
    // -----------------------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn insert_audit(
        &self,
        source_ip: Option<&str>,
        action: &str,
        tag: Option<&str>,
        old_value: Option<f64>,
        new_value: Option<f64>,
        pin_used: bool,
        success: bool,
        error_msg: Option<&str>,
    ) -> Result<(), String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.conn.lock().map_err(|e| format!("Lock: {}", e))?;
        conn.execute(
            "INSERT INTO audit_log \
             (id, timestamp, source_ip, action, tag_name, old_value, new_value, pin_used, success, error_msg) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                id,
                now,
                source_ip,
                action,
                tag,
                old_value,
                new_value,
                pin_used as i32,
                success as i32,
                error_msg,
            ],
        )
        .map_err(|e| format!("Insert audit: {}", e))?;
        Ok(())
    }

    pub fn get_audit_log(&self, limit: u32) -> Result<Vec<AuditEntry>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, timestamp, source_ip, action, tag_name, old_value, new_value, \
                 pin_used, success, error_msg, synced \
                 FROM audit_log ORDER BY timestamp DESC LIMIT ?1",
            )
            .map_err(|e| format!("Prepare: {}", e))?;

        let rows = stmt
            .query_map(rusqlite::params![limit], |row| {
                Ok(AuditEntry {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    source_ip: row.get(2)?,
                    action: row.get(3)?,
                    tag_name: row.get(4)?,
                    old_value: row.get(5)?,
                    new_value: row.get(6)?,
                    pin_used: row.get::<_, i32>(7)? != 0,
                    success: row.get::<_, i32>(8)? != 0,
                    error_msg: row.get(9)?,
                    synced: row.get::<_, i32>(10)? != 0,
                })
            })
            .map_err(|e| format!("Query audit: {}", e))?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| format!("Row: {}", e))?);
        }
        Ok(result)
    }

    // -----------------------------------------------------------------------
    // Package
    // -----------------------------------------------------------------------

    pub fn save_package(
        &self,
        version: u32,
        json: &str,
        deployed_by: Option<&str>,
    ) -> Result<(), String> {
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.conn.lock().map_err(|e| format!("Lock: {}", e))?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Transaction: {}", e))?;

        tx.execute("UPDATE scada_package SET is_active = 0", [])
            .map_err(|e| format!("Deactivate: {}", e))?;

        tx.execute(
            "INSERT INTO scada_package (version, package_json, deployed_at, deployed_by, is_active) \
             VALUES (?1, ?2, ?3, ?4, 1)",
            rusqlite::params![version, json, now, deployed_by],
        )
        .map_err(|e| format!("Insert package: {}", e))?;

        tx.commit().map_err(|e| format!("Commit: {}", e))?;
        debug!("Saved SCADA package version {}", version);
        Ok(())
    }

    /// Deactivate every stored package row (WF-011 undeploy). History rows
    /// stay intact (append-only audit trail) — only the active flag drops,
    /// so the startup reload (`get_active_package`) can no longer resurrect
    /// an undeployed/cleared package after an agent restart.
    pub fn deactivate_package(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock: {}", e))?;
        conn.execute("UPDATE scada_package SET is_active = 0", [])
            .map_err(|e| format!("Deactivate package: {}", e))?;
        debug!("Deactivated all SCADA package rows");
        Ok(())
    }

    pub fn get_active_package(&self) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT package_json FROM scada_package WHERE is_active = 1 ORDER BY version DESC LIMIT 1",
            )
            .map_err(|e| format!("Prepare: {}", e))?;

        let mut rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Query package: {}", e))?;

        match rows.next() {
            Some(row) => Ok(Some(row.map_err(|e| format!("Row: {}", e))?)),
            None => Ok(None),
        }
    }

    // -----------------------------------------------------------------------
    // Sync
    // -----------------------------------------------------------------------

    pub fn get_unsynced(&self, table: &str, limit: u32) -> Result<Vec<serde_json::Value>, String> {
        // Validate table name to prevent SQL injection
        let table = match table {
            "alarm_history" | "calibration_log" | "audit_log" => table,
            other => {
                warn!("Invalid table for unsynced query: {}", other);
                return Err(format!("Invalid table: {}", other));
            }
        };

        let conn = self.conn.lock().map_err(|e| format!("Lock: {}", e))?;
        let sql = format!("SELECT * FROM {} WHERE synced = 0 LIMIT ?1", table);
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("Prepare: {}", e))?;

        let col_count = stmt.column_count();
        let col_names: Vec<String> = (0..col_count)
            .map(|i| stmt.column_name(i).unwrap_or("?").to_string())
            .collect();

        let rows = stmt
            .query_map(rusqlite::params![limit], |row| {
                let mut map = serde_json::Map::new();
                for (i, name) in col_names.iter().enumerate() {
                    let val = match row.get_ref(i) {
                        Ok(rusqlite::types::ValueRef::Null) => serde_json::Value::Null,
                        Ok(rusqlite::types::ValueRef::Integer(n)) => {
                            serde_json::Value::Number(serde_json::Number::from(n))
                        }
                        Ok(rusqlite::types::ValueRef::Real(f)) => {
                            serde_json::json!(f)
                        }
                        Ok(rusqlite::types::ValueRef::Text(t)) => {
                            serde_json::Value::String(String::from_utf8_lossy(t).into_owned())
                        }
                        Ok(rusqlite::types::ValueRef::Blob(b)) => serde_json::Value::String(
                            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b),
                        ),
                        Err(_) => serde_json::Value::Null,
                    };
                    map.insert(name.clone(), val);
                }
                Ok(serde_json::Value::Object(map))
            })
            .map_err(|e| format!("Query unsynced: {}", e))?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| format!("Row: {}", e))?);
        }
        Ok(result)
    }

    pub fn mark_synced(&self, table: &str, id: &str) -> Result<(), String> {
        let table = match table {
            "alarm_history" | "calibration_log" | "audit_log" => table,
            other => {
                warn!("Invalid table for mark_synced: {}", other);
                return Err(format!("Invalid table: {}", other));
            }
        };

        let conn = self.conn.lock().map_err(|e| format!("Lock: {}", e))?;
        let sql = format!("UPDATE {} SET synced = 1 WHERE id = ?1", table);
        conn.execute(&sql, rusqlite::params![id])
            .map_err(|e| format!("Mark synced: {}", e))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(tag: &str) -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("scada_{}_{}", tag, std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("scada.db");
        let s = path.to_string_lossy().to_string();
        (dir, s)
    }

    /// EDGE-CRITICAL-002: an existing scada.db under the deprecated
    /// machine-id passphrase is rekeyed to the hardened key in place,
    /// preserving its rows; afterwards only the hardened key opens it.
    #[test]
    fn migrates_legacy_machine_id_db_to_hardened_key() {
        let (dir, path) = temp_db("mig");

        // Seed a DB under the deprecated machine-id passphrase.
        let legacy = legacy_machine_id_passphrase();
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.pragma_update(None, "key", &legacy).unwrap();
            conn.execute_batch("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (42);")
                .unwrap();
        }

        let new_hex = "aa".repeat(32);
        let conn = ScadaDb::open_with_key_or_migrate(&path, &new_hex).unwrap();
        let v: i64 = conn.query_row("SELECT v FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 42, "row must survive the rekey migration");
        drop(conn);

        // The hardened key now opens it; the legacy passphrase must not.
        let reopen = rusqlite::Connection::open(&path).unwrap();
        reopen
            .execute_batch(&format!("PRAGMA key = \"x'{}'\";", new_hex))
            .unwrap();
        let v2: i64 = reopen
            .query_row("SELECT v FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v2, 42);

        let stale = rusqlite::Connection::open(&path).unwrap();
        stale.pragma_update(None, "key", &legacy).unwrap();
        assert!(
            stale
                .query_row("SELECT v FROM t", [], |r| r.get::<_, i64>(0))
                .is_err(),
            "deprecated machine-id key must no longer open the rekeyed store"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A fresh store opens directly under the hardened key (no migration).
    #[test]
    fn fresh_db_opens_with_hardened_key() {
        let (dir, path) = temp_db("fresh");
        let new_hex = "bb".repeat(32);
        let conn = ScadaDb::open_with_key_or_migrate(&path, &new_hex).unwrap();
        conn.execute_batch("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (7);")
            .unwrap();
        let v: i64 = conn.query_row("SELECT v FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 7);
        std::fs::remove_dir_all(&dir).ok();
    }
}

// ---------------------------------------------------------------------------
// Tests — package activation lifecycle (WF-011)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod package_lifecycle_tests {
    use super::*;

    /// Opens a throw-away store through the keystore-less path of
    /// `ScadaDb::new` (device-secret derivation), which is why the shared
    /// `SUDERRA_DB_KEY_PATH` sandbox must be seeded first — the derivation is
    /// latched process-wide, so this must be the same sandbox the offline
    /// queue tests use.
    async fn temp_db() -> (ScadaDb, std::path::PathBuf) {
        crate::offline_queue::test_support::ensure_key_sandbox();
        let path = std::env::temp_dir().join(format!(
            "scada-db-test-{}-{:?}.sqlite",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&path);
        let db = ScadaDb::new(
            path.to_str().expect("utf8 temp path"),
            None,
            b"scada-db-package-lifecycle-test".to_vec(),
        )
        .await
        .expect("open temp db");
        (db, path)
    }

    #[tokio::test]
    async fn deactivate_package_clears_active_flag_but_keeps_history() {
        let (db, path) = temp_db().await;

        db.save_package(3, r#"{"v":3}"#, Some("user-1"))
            .expect("save package");
        assert_eq!(
            db.get_active_package().expect("query"),
            Some(r#"{"v":3}"#.to_string())
        );

        db.deactivate_package().expect("deactivate");

        // No active package — a restart can no longer resurrect it...
        assert_eq!(db.get_active_package().expect("query"), None);

        // ...but the history row survives (append-only audit trail): a new
        // deploy lands as a fresh active version alongside it.
        db.save_package(4, r#"{"v":4}"#, Some("user-1"))
            .expect("save next version");
        assert_eq!(
            db.get_active_package().expect("query"),
            Some(r#"{"v":4}"#.to_string())
        );

        let _ = std::fs::remove_file(path);
    }
}
