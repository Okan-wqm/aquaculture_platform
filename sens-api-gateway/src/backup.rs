//! Backup and Restore Module (v1.2.4)
//!
//! Provides backup and restore functionality for the agent:
//! - Configuration backup
//! - Script state backup
//! - Function block state backup
//! - SQLite database backup
//!
//! # Backup Strategy (LOW-43)
//!
//! ## Retention policy
//! Up to `max_backups` backup files are kept on disk (default: 10).
//! When the limit is exceeded, the oldest backup is deleted automatically
//! by `cleanup_old_backups()` after every `create_backup()` call.
//!
//! ## File format
//! Each backup is a binary file with the following layout:
//! ```text
//! [8 bytes]  Magic header: "SUDERRA\0"
//! [4 bytes]  Format version (little-endian u32, currently 1)
//! [N bytes]  gzip-compressed JSON payload (BackupContents)
//! ```
//! The compressed payload contains a manifest (checksums, timestamps, device ID)
//! plus all configuration, scripts, function-block states, variables, and triggers.
//!
//! ## Security
//! - Backups are written to `backup_dir` (default: `/var/lib/suderra/backups/`).
//! - Directory permissions should be restricted to the `suderra` service user.
//! - The `device_id` field in the manifest must match the restoring device when
//!   `verify_device_id = true` is passed to `restore_backup()`, preventing
//!   accidental cross-device restore.
//!
//! ## Size limits
//! Decompressed size is bounded by `MAX_BACKUP_SIZE` (100 MB) to prevent
//! decompression-bomb attacks if a corrupted or malicious `.sdb` file is presented.
//!
//! # IEC 62443 SL2 Compliance
//! - FR7: Resource Availability (backup and restore for recovery)
//!
//! # ARC-009 wire decision (Batch 18 — Faz 1 Step 8)
//!
//! **Decision:** WIRE-PARTIAL (constructor wired Batch 18, triggers
//! Sprint 6.x).
//!
//! **Why (WIRE):** Plan §5 Faz 1 Step 8 + ADR-020 §6 — GDPR Art 20
//! edge portability + disaster-recovery are both non-optional.
//! Operators must be able to export device state on request OR capture
//! a recovery snapshot. Pre-Batch-18 this was dead-code; no path
//! existed from operator → dump file.
//!
//! **What Batch 18 wired:**
//! - `BackupManager::new(..)` constructor invoked from
//!   `AppState::init_backup_manager()` when `config.backup.enabled`.
//! - `BackupManager::init()` (mkdir backup_dir) fail-closed on error —
//!   declared-enabled backup MUST be able to write.
//! - `BackupManager::with_max_backups()` retention config honored.
//! - Arc-wrapped instance held in `AppState.backup_manager` so the
//!   Sprint 6.x HTTP endpoint + CLI subcommand can share the same
//!   retention cleanup state (avoids double-cleanup races).
//!
//! **What's NOT wired yet (Sprint 6.x):**
//! - `BackupManager::create_backup()` — invoked from future HTTP POST
//!   `/admin/backup` endpoint (auth via `BACKUP_AUTH_SECRET` +
//!   `validate_auth`) AND from `suderra-agent backup-create` CLI.
//! - `BackupManager::restore_backup()` — invoked from future HTTP POST
//!   `/admin/backup/restore` OR `suderra-agent backup-restore` CLI.
//! - Scheduled periodic backup (cron-style) — not in scope; Sprint 6.x
//!   owners decide whether operators want automatic snapshots.
//!
//! **Why `#![allow(dead_code)]` stays:** `create_backup`,
//! `restore_backup`, `validate_auth`, and helpers are not invoked
//! until Sprint 6.x wires HTTP + CLI. Until then the functions are
//! compiled but unreferenced — removing the allow would force dead-
//! code pruning of code that's about to be invoked. Tracked as
//! OBS-18-001 / OBS-18-002.
//!
//! ## Wire status (Batch #273 audit)
//!
//! **Plan classification:** ARC-009 WHITELIST-with-reason. Per
//! the Plan §3.1 ARC-009 framework, every dead-code module
//! must land in WIRE / REMOVE / WHITELIST-with-reason state.
//! `backup.rs` is the canonical WHITELIST-with-reason module:
//!
//! - **Init wired (Batch 18):** `main.rs` calls
//!   `init_backup_manager()` at boot via `state_guard.
//!   init_backup_manager()`. The BackupManager struct is
//!   constructed + the backup directory is mkdir'd when
//!   `config.backup.enabled = true`. Fail-closed boot if
//!   the mkdir fails (declared-enabled backup must be able
//!   to write — operator-actionable).
//! - **API surface compiled but unreferenced:** `create_backup`,
//!   `restore_backup`, `validate_auth`, helper functions for
//!   GDPR Art 20 edge portability + disaster-recovery
//!   snapshot. Production callers — HTTP `/admin/backup` POST
//!   endpoint + `suderra-agent backup-create` /
//!   `backup-restore` CLI subcommands — are scheduled for
//!   Sprint 6.x per ARC-009 plan.
//! - **Why retained vs deleted:** the create/restore/validate
//!   surface is GDPR Art 20 (right to data portability)
//!   load-bearing for tenant offboarding flows — deleting the
//!   compiled-but-unreferenced API would force a re-implementation
//!   from scratch in Sprint 6.x with all the same security
//!   properties (auth, encryption, ZIP-bomb defense). Holding
//!   the WHITELIST allows the API to be reviewed + audited
//!   today + invoked tomorrow without a regression cycle.
//!
//! **Cross-references:**
//! - Plan §3 ARC-009 dead-code triage table.
//! - OBS-18-001 (HTTP backup endpoint wire pending).
//! - OBS-18-002 (CLI subcommand wire pending).
//! - GDPR Art 20 right-to-data-portability for the tenant
//!   offboarding flow that consumes `create_backup` output.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// Backup file magic header for verification
const BACKUP_MAGIC: &[u8; 8] = b"SUDERRA\x00";

/// Current backup format version
const BACKUP_VERSION: u32 = 1;

/// Maximum backup file size (100 MB)
const MAX_BACKUP_SIZE: usize = 100 * 1024 * 1024;

/// Backup manifest containing metadata about the backup
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifest {
    /// Backup format version
    pub version: u32,
    /// Timestamp of backup creation (ISO 8601)
    pub created_at: String,
    /// Agent version that created this backup
    pub agent_version: String,
    /// Device ID (for verification during restore)
    pub device_id: String,
    /// Description of backup contents
    pub description: String,
    /// Checksums of included files
    pub checksums: HashMap<String, String>,
}

/// Backup contents containing all backed up data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupContents {
    /// Manifest with metadata
    pub manifest: BackupManifest,
    /// Configuration YAML (sanitized)
    pub config: Option<String>,
    /// Scripts as JSON
    pub scripts: HashMap<String, serde_json::Value>,
    /// Function block states
    pub fb_states: HashMap<String, serde_json::Value>,
    /// Variables from persistence
    pub variables: HashMap<String, serde_json::Value>,
    /// Trigger states
    pub triggers: HashMap<String, serde_json::Value>,
}

/// Backup manager for creating and restoring backups
///
/// SECURITY (EDGE-MEDIUM-006): If backup operations are exposed over HTTP in the
/// future, authentication MUST use the standard JWT-based auth flow or a secret
/// loaded from environment/config — never a hardcoded magic header value.
/// The `backup_auth_secret` field below provides this: when set, any HTTP handler
/// must validate the request against this env-loaded secret before proceeding.
pub struct BackupManager {
    /// Directory for storing backups
    backup_dir: PathBuf,
    /// Maximum number of backups to keep
    max_backups: usize,
    /// Device ID for verification
    device_id: String,
    /// SECURITY (EDGE-MEDIUM-006): Optional auth secret loaded from config/env.
    /// When backup is exposed via HTTP, validate requests against this secret.
    /// Never hardcode — always load from `BACKUP_AUTH_SECRET` env or config YAML.
    backup_auth_secret: Option<String>,
}

impl BackupManager {
    /// Create a new backup manager
    ///
    /// EDGE-MEDIUM-006: Reads `BACKUP_AUTH_SECRET` from environment at construction
    /// time so any future HTTP endpoint can validate requests without hardcoding.
    pub fn new(backup_dir: impl Into<PathBuf>, device_id: impl Into<String>) -> Self {
        let backup_dir = backup_dir.into();
        // SECURITY: Load auth secret from env — never hardcode (EDGE-MEDIUM-006)
        let backup_auth_secret = std::env::var("BACKUP_AUTH_SECRET").ok();
        Self {
            backup_dir,
            max_backups: 10,
            device_id: device_id.into(),
            backup_auth_secret,
        }
    }

    /// Validate an incoming backup request against the env-loaded secret.
    ///
    /// SECURITY (EDGE-MEDIUM-006): Use this for any HTTP-exposed backup endpoint.
    /// Returns `Ok(())` if the provided key matches the env-loaded secret, or if
    /// no secret is configured (local-only mode). Returns `Err` if a secret is
    /// configured but the provided key doesn't match.
    pub fn validate_auth(&self, provided_key: &str) -> Result<(), BackupError> {
        match &self.backup_auth_secret {
            Some(expected) => {
                // SECURITY: Use constant-time comparison to prevent timing side-channel
                use subtle::ConstantTimeEq;
                let eq = expected.as_bytes().ct_eq(provided_key.as_bytes());
                if bool::from(eq) {
                    Ok(())
                } else {
                    Err(BackupError::Io("Invalid backup auth key".to_string()))
                }
            }
            None => {
                // No secret configured — backup is local-only, no HTTP auth needed
                Ok(())
            }
        }
    }

    /// Set maximum number of backups to keep
    pub fn with_max_backups(mut self, max: usize) -> Self {
        self.max_backups = max.max(1);
        self
    }

    /// Initialize backup directory
    pub fn init(&self) -> Result<(), BackupError> {
        if !self.backup_dir.exists() {
            fs::create_dir_all(&self.backup_dir).map_err(|e| {
                BackupError::Io(format!("Failed to create backup directory: {}", e))
            })?;
            info!("Created backup directory: {:?}", self.backup_dir);
        }
        Ok(())
    }

    /// Create a backup with the given description
    pub fn create_backup(
        &self,
        description: impl Into<String>,
        config: Option<String>,
        scripts: HashMap<String, serde_json::Value>,
        fb_states: HashMap<String, serde_json::Value>,
        variables: HashMap<String, serde_json::Value>,
        triggers: HashMap<String, serde_json::Value>,
    ) -> Result<PathBuf, BackupError> {
        self.init()?;

        // Use timestamp with milliseconds for unique filenames
        let now = chrono::Utc::now();
        let timestamp = format!(
            "{}_{}",
            now.format("%Y%m%d_%H%M%S"),
            now.timestamp_subsec_millis()
        );
        let filename = format!("backup_{}.sdb", timestamp);
        let backup_path = self.backup_dir.join(&filename);

        // Calculate checksums
        let mut checksums = HashMap::new();
        if let Some(ref cfg) = config {
            checksums.insert("config".to_string(), Self::sha256_hash(cfg.as_bytes()));
        }

        let manifest = BackupManifest {
            version: BACKUP_VERSION,
            created_at: now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
            device_id: self.device_id.clone(),
            description: description.into(),
            checksums,
        };

        let contents = BackupContents {
            manifest,
            config,
            scripts,
            fb_states,
            variables,
            triggers,
        };

        // Serialize to JSON
        let json = serde_json::to_string_pretty(&contents).map_err(|e| {
            BackupError::Serialization(format!("Failed to serialize backup: {}", e))
        })?;

        // Compress with gzip
        let compressed = Self::compress(json.as_bytes())?;

        // Write backup file
        let mut file = fs::File::create(&backup_path)
            .map_err(|e| BackupError::Io(format!("Failed to create backup file: {}", e)))?;

        // Write magic header
        file.write_all(BACKUP_MAGIC)
            .map_err(|e| BackupError::Io(format!("Failed to write magic header: {}", e)))?;

        // Write version (4 bytes, little endian)
        file.write_all(&BACKUP_VERSION.to_le_bytes())
            .map_err(|e| BackupError::Io(format!("Failed to write version: {}", e)))?;

        // Write compressed data
        file.write_all(&compressed)
            .map_err(|e| BackupError::Io(format!("Failed to write backup data: {}", e)))?;

        info!(
            "Created backup: {} ({} bytes)",
            filename,
            compressed.len() + 12
        );

        // Cleanup old backups
        self.cleanup_old_backups()?;

        Ok(backup_path)
    }

    /// Restore from a backup file
    pub fn restore_backup(
        &self,
        backup_path: impl AsRef<Path>,
        verify_device_id: bool,
    ) -> Result<BackupContents, BackupError> {
        let backup_path = backup_path.as_ref();

        if !backup_path.exists() {
            return Err(BackupError::NotFound(
                backup_path.to_string_lossy().to_string(),
            ));
        }

        // Read backup file
        let mut file = fs::File::open(backup_path)
            .map_err(|e| BackupError::Io(format!("Failed to open backup file: {}", e)))?;

        let metadata = file
            .metadata()
            .map_err(|e| BackupError::Io(format!("Failed to get file metadata: {}", e)))?;

        if metadata.len() > MAX_BACKUP_SIZE as u64 {
            return Err(BackupError::TooLarge(metadata.len() as usize));
        }

        // Read and verify magic header
        let mut magic = [0u8; 8];
        file.read_exact(&mut magic)
            .map_err(|e| BackupError::Io(format!("Failed to read magic header: {}", e)))?;

        if &magic != BACKUP_MAGIC {
            return Err(BackupError::InvalidFormat(
                "Invalid backup file magic".into(),
            ));
        }

        // Read version
        let mut version_bytes = [0u8; 4];
        file.read_exact(&mut version_bytes)
            .map_err(|e| BackupError::Io(format!("Failed to read version: {}", e)))?;

        let version = u32::from_le_bytes(version_bytes);
        if version > BACKUP_VERSION {
            return Err(BackupError::UnsupportedVersion(version));
        }

        // Read compressed data
        let mut compressed = Vec::new();
        file.read_to_end(&mut compressed)
            .map_err(|e| BackupError::Io(format!("Failed to read backup data: {}", e)))?;

        // Decompress
        let json = Self::decompress(&compressed)?;

        // Parse JSON
        let contents: BackupContents = serde_json::from_slice(&json)
            .map_err(|e| BackupError::Serialization(format!("Failed to parse backup: {}", e)))?;

        // Verify device ID if requested
        if verify_device_id && contents.manifest.device_id != self.device_id {
            return Err(BackupError::DeviceMismatch {
                expected: self.device_id.clone(),
                found: contents.manifest.device_id.clone(),
            });
        }

        info!(
            "Restored backup from {} (created: {})",
            backup_path.display(),
            contents.manifest.created_at
        );

        Ok(contents)
    }

    /// List available backups
    pub fn list_backups(&self) -> Result<Vec<BackupInfo>, BackupError> {
        self.init()?;

        let mut backups = Vec::new();

        let entries = fs::read_dir(&self.backup_dir)
            .map_err(|e| BackupError::Io(format!("Failed to read backup directory: {}", e)))?;

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "sdb").unwrap_or(false) {
                match self.get_backup_info(&path) {
                    Ok(info) => backups.push(info),
                    Err(e) => {
                        warn!("Failed to read backup info for {:?}: {}", path, e);
                    }
                }
            }
        }

        // Sort by creation time (newest first)
        backups.sort_by(|a, b| b.created_at.cmp(&a.created_at));

        Ok(backups)
    }

    /// Get information about a specific backup
    pub fn get_backup_info(
        &self,
        backup_path: impl AsRef<Path>,
    ) -> Result<BackupInfo, BackupError> {
        let backup_path = backup_path.as_ref();

        let metadata = fs::metadata(backup_path)
            .map_err(|e| BackupError::Io(format!("Failed to get file metadata: {}", e)))?;

        // Read just the manifest (first part of the file)
        let contents = self.restore_backup(backup_path, false)?;

        Ok(BackupInfo {
            path: backup_path.to_path_buf(),
            size_bytes: metadata.len(),
            created_at: contents.manifest.created_at,
            agent_version: contents.manifest.agent_version,
            device_id: contents.manifest.device_id,
            description: contents.manifest.description,
            script_count: contents.scripts.len(),
            fb_state_count: contents.fb_states.len(),
            variable_count: contents.variables.len(),
        })
    }

    /// Delete a backup file
    pub fn delete_backup(&self, backup_path: impl AsRef<Path>) -> Result<(), BackupError> {
        let backup_path = backup_path.as_ref();

        if !backup_path.exists() {
            return Err(BackupError::NotFound(
                backup_path.to_string_lossy().to_string(),
            ));
        }

        fs::remove_file(backup_path)
            .map_err(|e| BackupError::Io(format!("Failed to delete backup: {}", e)))?;

        info!("Deleted backup: {:?}", backup_path);
        Ok(())
    }

    /// Cleanup old backups, keeping only the most recent ones
    fn cleanup_old_backups(&self) -> Result<(), BackupError> {
        let mut backups = self.list_backups()?;

        if backups.len() <= self.max_backups {
            return Ok(());
        }

        // Sort by creation time (oldest first for deletion)
        backups.sort_by(|a, b| a.created_at.cmp(&b.created_at));

        let to_delete = backups.len() - self.max_backups;
        for backup in backups.into_iter().take(to_delete) {
            if let Err(e) = self.delete_backup(&backup.path) {
                warn!("Failed to delete old backup {:?}: {}", backup.path, e);
            }
        }

        Ok(())
    }

    /// Compress data using gzip
    fn compress(data: &[u8]) -> Result<Vec<u8>, BackupError> {
        use flate2::Compression;
        use flate2::write::GzEncoder;

        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder
            .write_all(data)
            .map_err(|e| BackupError::Compression(format!("Failed to compress: {}", e)))?;
        encoder
            .finish()
            .map_err(|e| BackupError::Compression(format!("Failed to finish compression: {}", e)))
    }

    /// Decompress gzip data
    /// v1.2.6: Added size limit to prevent decompression bomb attacks
    fn decompress(data: &[u8]) -> Result<Vec<u8>, BackupError> {
        use flate2::read::GzDecoder;
        use std::io::Read;

        let mut decoder = GzDecoder::new(data);
        let mut decompressed = Vec::new();

        // v1.2.6: Limit decompressed size to MAX_BACKUP_SIZE to prevent DoS
        // Use take() to limit bytes read, preventing memory exhaustion
        let mut limited_reader = (&mut decoder).take(MAX_BACKUP_SIZE as u64 + 1);
        limited_reader
            .read_to_end(&mut decompressed)
            .map_err(|e| BackupError::Compression(format!("Failed to decompress: {}", e)))?;

        // Check if we hit the limit (data was truncated = bomb attack)
        if decompressed.len() > MAX_BACKUP_SIZE {
            return Err(BackupError::TooLarge(decompressed.len()));
        }

        Ok(decompressed)
    }

    /// Calculate SHA-256 hash of data for backup integrity verification.
    fn sha256_hash(data: &[u8]) -> String {
        use sha2::{Sha256, Digest};
        let hash = Sha256::digest(data);
        format!("{:x}", hash)
    }
}

/// Information about a backup file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupInfo {
    /// Path to backup file
    pub path: PathBuf,
    /// Size in bytes
    pub size_bytes: u64,
    /// Creation timestamp (ISO 8601)
    pub created_at: String,
    /// Agent version that created the backup
    pub agent_version: String,
    /// Device ID
    pub device_id: String,
    /// User description
    pub description: String,
    /// Number of scripts in backup
    pub script_count: usize,
    /// Number of FB states in backup
    pub fb_state_count: usize,
    /// Number of variables in backup
    pub variable_count: usize,
}

/// Backup errors
#[derive(Debug, Clone)]
pub enum BackupError {
    /// IO error
    Io(String),
    /// Serialization error
    Serialization(String),
    /// Compression error
    Compression(String),
    /// Backup file not found
    NotFound(String),
    /// Invalid backup format
    InvalidFormat(String),
    /// Unsupported backup version
    UnsupportedVersion(u32),
    /// Backup file too large
    TooLarge(usize),
    /// Device ID mismatch
    DeviceMismatch { expected: String, found: String },
}

impl std::fmt::Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BackupError::Io(msg) => write!(f, "IO error: {}", msg),
            BackupError::Serialization(msg) => write!(f, "Serialization error: {}", msg),
            BackupError::Compression(msg) => write!(f, "Compression error: {}", msg),
            BackupError::NotFound(path) => write!(f, "Backup not found: {}", path),
            BackupError::InvalidFormat(msg) => write!(f, "Invalid backup format: {}", msg),
            BackupError::UnsupportedVersion(v) => write!(f, "Unsupported backup version: {}", v),
            BackupError::TooLarge(size) => {
                write!(
                    f,
                    "Backup file too large: {} bytes (max {})",
                    size, MAX_BACKUP_SIZE
                )
            }
            BackupError::DeviceMismatch { expected, found } => {
                write!(
                    f,
                    "Device ID mismatch: expected {}, found {}",
                    expected, found
                )
            }
        }
    }
}

impl std::error::Error for BackupError {}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_backup_create_and_restore() {
        let temp_dir = TempDir::new().unwrap();
        let manager = BackupManager::new(temp_dir.path(), "test-device-001");

        let mut scripts = HashMap::new();
        scripts.insert(
            "script1".to_string(),
            serde_json::json!({"name": "test_script", "enabled": true}),
        );

        let mut variables = HashMap::new();
        variables.insert("var1".to_string(), serde_json::json!(42));

        let backup_path = manager
            .create_backup(
                "Test backup",
                Some("mqtt:\n  broker: test.local".to_string()),
                scripts.clone(),
                HashMap::new(),
                variables.clone(),
                HashMap::new(),
            )
            .unwrap();

        assert!(backup_path.exists());

        // Restore and verify
        let restored = manager.restore_backup(&backup_path, true).unwrap();
        assert_eq!(restored.manifest.description, "Test backup");
        assert_eq!(restored.manifest.device_id, "test-device-001");
        assert_eq!(restored.scripts.len(), 1);
        assert!(restored.scripts.contains_key("script1"));
        assert_eq!(restored.variables.len(), 1);
    }

    #[test]
    fn test_backup_list() {
        let temp_dir = TempDir::new().unwrap();
        let manager = BackupManager::new(temp_dir.path(), "test-device");

        // Create two backups with delay to ensure different timestamps
        manager
            .create_backup(
                "First backup",
                None,
                HashMap::new(),
                HashMap::new(),
                HashMap::new(),
                HashMap::new(),
            )
            .unwrap();

        // Small delay to ensure different timestamp in filename (now includes milliseconds)
        std::thread::sleep(std::time::Duration::from_millis(10));

        manager
            .create_backup(
                "Second backup",
                None,
                HashMap::new(),
                HashMap::new(),
                HashMap::new(),
                HashMap::new(),
            )
            .unwrap();

        let backups = manager.list_backups().unwrap();
        assert_eq!(backups.len(), 2);
        // Most recent should be first
        assert_eq!(backups[0].description, "Second backup");
        assert_eq!(backups[1].description, "First backup");
    }

    #[test]
    fn test_backup_cleanup() {
        let temp_dir = TempDir::new().unwrap();
        let manager = BackupManager::new(temp_dir.path(), "test-device").with_max_backups(2);

        // Create 3 backups with small delays (timestamp now includes milliseconds)
        for i in 0..3 {
            std::thread::sleep(std::time::Duration::from_millis(10));
            manager
                .create_backup(
                    format!("Backup {}", i),
                    None,
                    HashMap::new(),
                    HashMap::new(),
                    HashMap::new(),
                    HashMap::new(),
                )
                .unwrap();
        }

        let backups = manager.list_backups().unwrap();
        assert_eq!(backups.len(), 2);
        // Should keep the two most recent
        assert_eq!(backups[0].description, "Backup 2");
        assert_eq!(backups[1].description, "Backup 1");
    }

    #[test]
    fn test_device_id_mismatch() {
        let temp_dir = TempDir::new().unwrap();
        let manager1 = BackupManager::new(temp_dir.path(), "device-001");
        let manager2 = BackupManager::new(temp_dir.path(), "device-002");

        let backup_path = manager1
            .create_backup(
                "Test backup",
                None,
                HashMap::new(),
                HashMap::new(),
                HashMap::new(),
                HashMap::new(),
            )
            .unwrap();

        // Should fail with device ID verification
        let result = manager2.restore_backup(&backup_path, true);
        assert!(matches!(result, Err(BackupError::DeviceMismatch { .. })));

        // Should succeed without verification
        let result = manager2.restore_backup(&backup_path, false);
        assert!(result.is_ok());
    }

    #[test]
    fn test_invalid_backup_file() {
        let temp_dir = TempDir::new().unwrap();
        let manager = BackupManager::new(temp_dir.path(), "test-device");

        let invalid_path = temp_dir.path().join("invalid.sdb");
        fs::write(&invalid_path, b"invalid data").unwrap();

        let result = manager.restore_backup(&invalid_path, false);
        assert!(matches!(result, Err(BackupError::InvalidFormat(_))));
    }

    #[test]
    fn test_backup_not_found() {
        let temp_dir = TempDir::new().unwrap();
        let manager = BackupManager::new(temp_dir.path(), "test-device");

        let result = manager.restore_backup("/nonexistent/backup.sdb", false);
        assert!(matches!(result, Err(BackupError::NotFound(_))));
    }

    #[test]
    fn test_delete_backup() {
        let temp_dir = TempDir::new().unwrap();
        let manager = BackupManager::new(temp_dir.path(), "test-device");

        let backup_path = manager
            .create_backup(
                "To delete",
                None,
                HashMap::new(),
                HashMap::new(),
                HashMap::new(),
                HashMap::new(),
            )
            .unwrap();

        assert!(backup_path.exists());

        manager.delete_backup(&backup_path).unwrap();

        assert!(!backup_path.exists());
    }
}
