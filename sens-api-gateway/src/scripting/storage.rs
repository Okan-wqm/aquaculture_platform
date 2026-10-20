//! Script storage and persistence
//!
//! Handles saving, loading, and managing scripts on the edge device.
//!
//! ## Memory Safety
//! This module enforces a maximum script count to prevent unbounded memory growth.
//! Scripts exceeding the limit will be rejected with an error.
//!
//! ## Thread Safety (v1.2.0)
//! Uses `tokio::sync::RwLock` for concurrent access from multiple async tasks.
//! All public methods are now async to support lock acquisition.

use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{RwLock, watch};
use tracing::{info, warn};

use super::ScriptDefinition;

/// Marker an import of the legacy scripts directory leaves behind, so the
/// import runs once and a script deleted later is not resurrected from the
/// read-only legacy copy.
#[cfg(not(feature = "suderra-os"))]
const LEGACY_IMPORT_MARKER: &str = ".legacy-scripts-imported";

/// Maximum allowed script ID length
const MAX_SCRIPT_ID_LENGTH: usize = 64;

/// Default maximum number of scripts (memory protection)
const DEFAULT_MAX_SCRIPTS: usize = 100;

/// Validate script ID to prevent path traversal attacks
///
/// # Security
/// This function prevents:
/// - Path traversal attacks (../, /, \)
/// - Overly long IDs that could cause filesystem issues
/// - Special characters that could be problematic
fn validate_script_id(id: &str) -> Result<()> {
    // Check for path traversal attempts
    if id.contains("..") {
        return Err(anyhow!("Invalid script ID: path traversal detected (..)"));
    }
    if id.contains('/') || id.contains('\\') {
        return Err(anyhow!("Invalid script ID: path separators not allowed"));
    }

    // Check length
    if id.is_empty() {
        return Err(anyhow!("Invalid script ID: cannot be empty"));
    }
    if id.len() > MAX_SCRIPT_ID_LENGTH {
        return Err(anyhow!(
            "Invalid script ID: exceeds maximum length of {} characters",
            MAX_SCRIPT_ID_LENGTH
        ));
    }

    // Only allow alphanumeric, hyphen, and underscore
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(anyhow!(
            "Invalid script ID: only alphanumeric, hyphen, and underscore allowed"
        ));
    }

    // Prevent hidden files
    if id.starts_with('.') {
        return Err(anyhow!("Invalid script ID: cannot start with dot"));
    }

    Ok(())
}

/// Script metadata and state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Script {
    /// Script definition
    pub definition: ScriptDefinition,

    /// Current status
    pub status: ScriptStatus,

    /// Last execution time
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run: Option<DateTime<Utc>>,

    /// Last execution result
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_result: Option<String>,

    /// Error count (resets on successful run)
    #[serde(default)]
    pub error_count: u32,

    /// Created timestamp
    pub created_at: DateTime<Utc>,

    /// Updated timestamp
    pub updated_at: DateTime<Utc>,

    /// Revision number (v1.2.1 - issue #28: version tracking)
    /// Increments on each update to the script definition
    #[serde(default)]
    pub revision: u32,

    /// Previous definition (v1.2.1 - simple rollback support)
    /// Stores the last version for potential rollback
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_definition: Option<Box<ScriptDefinition>>,
}

impl Script {
    /// Get the current revision number
    pub fn revision(&self) -> u32 {
        self.revision
    }

    /// Check if rollback is possible
    pub fn can_rollback(&self) -> bool {
        self.previous_definition.is_some()
    }

    /// Rollback to previous version (v1.2.1)
    /// Returns true if rollback was successful
    pub fn rollback(&mut self) -> bool {
        if let Some(prev) = self.previous_definition.take() {
            // Store current as previous for potential re-rollback
            self.previous_definition = Some(Box::new(self.definition.clone()));
            self.definition = *prev;
            // v1.2.3: Warn if revision is about to wrap around
            if self.revision == u32::MAX {
                warn!(
                    "Script '{}' revision counter wrapping from {} to 0. \
                    Version history tracking may be affected.",
                    self.definition.id, self.revision
                );
            }
            self.revision = self.revision.wrapping_add(1);
            self.updated_at = Utc::now();
            true
        } else {
            false
        }
    }
}

/// Script status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScriptStatus {
    /// Script is active and will be triggered
    Active,
    /// Script is paused (won't trigger)
    Paused,
    /// Script has errors and is disabled
    Error,
    /// Script is currently executing
    Running,
}

/// Script storage manager with bounded capacity and thread-safe access
///
/// # Thread Safety (v1.2.0)
/// Uses `tokio::sync::RwLock` to allow multiple readers or one writer.
/// All mutating methods acquire a write lock; read-only methods acquire a read lock.
///
/// # Active-script cache (PERF)
/// `get_active()` is called on every scan cycle (as fast as 10ms).  To avoid cloning
/// the full script map on each call, an `Arc<Vec<Script>>` cache is kept and rebuilt
/// only when `active_dirty` is set by write operations.
pub struct ScriptStorage {
    /// Where scripts persist: `AgentPaths::scripts_dir` (ADR-048 DEC-4.5).
    scripts_dir: PathBuf,
    /// Generic profile: the `/etc/suderra/scripts` directory an older
    /// agent wrote, imported once into `scripts_dir` (ADR-048 DEC-4.1).
    #[cfg(not(feature = "suderra-os"))]
    legacy_import_dir: Option<PathBuf>,
    /// Thread-safe script map protected by RwLock
    scripts: RwLock<HashMap<String, Script>>,
    /// Maximum number of scripts allowed (memory protection)
    max_scripts: usize,
    /// Cached active-script list — rebuilt lazily when dirty
    active_cache: RwLock<Option<Arc<Vec<Script>>>>,
    /// Dirty flag sender — write operations send `true` to invalidate the cache
    dirty_tx: watch::Sender<bool>,
    /// Dirty flag receiver — read by get_active() to detect stale cache
    dirty_rx: watch::Receiver<bool>,
}

impl ScriptStorage {
    /// Create a new script storage with default capacity, persisting into
    /// `scripts_dir` (the caller passes `AgentPaths::scripts_dir`).
    pub fn new(scripts_dir: PathBuf) -> Self {
        Self::with_capacity(scripts_dir, DEFAULT_MAX_SCRIPTS)
    }

    /// Create a new script storage with specified maximum capacity
    pub fn with_capacity(scripts_dir: PathBuf, max_scripts: usize) -> Self {
        let (dirty_tx, dirty_rx) = watch::channel(true); // start dirty so first call rebuilds
        Self {
            scripts_dir,
            #[cfg(not(feature = "suderra-os"))]
            legacy_import_dir: None,
            scripts: RwLock::new(HashMap::with_capacity(max_scripts.min(100))),
            max_scripts,
            active_cache: RwLock::new(None),
            dirty_tx,
            dirty_rx,
        }
    }

    /// Generic profile: import the scripts an older agent kept in
    /// `legacy_dir` (read-only to this agent) on the first `init`.
    #[cfg(not(feature = "suderra-os"))]
    pub fn with_legacy_import_dir(mut self, legacy_dir: PathBuf) -> Self {
        self.legacy_import_dir = Some(legacy_dir);
        self
    }

    /// Invalidate the active-script cache after any write operation.
    fn invalidate_active_cache(&self) {
        // Ignore send error — no receivers is fine
        let _ = self.dirty_tx.send(true);
    }

    /// Get the maximum script capacity
    pub fn capacity(&self) -> usize {
        self.max_scripts
    }

    /// Check if storage is at capacity (async for lock acquisition)
    pub async fn is_full(&self) -> bool {
        let scripts = self.scripts.read().await;
        scripts.len() >= self.max_scripts
    }

    /// Initialize storage and load existing scripts
    pub async fn init(&self) -> Result<()> {
        self.ensure_scripts_dir()?;
        #[cfg(not(feature = "suderra-os"))]
        self.import_legacy_scripts()?;

        // Load existing scripts
        self.load_all().await?;

        let count = {
            let scripts = self.scripts.read().await;
            scripts.len()
        };

        info!("Script storage initialized with {} scripts", count);
        Ok(())
    }

    /// Suderra OS: the OS creates the agent's `scripts/` directory before
    /// the unit starts and the agent never creates a contract directory
    /// (ADR-048 DEC-4.3, DEC-4.11); a missing one is reported.
    #[cfg(feature = "suderra-os")]
    fn ensure_scripts_dir(&self) -> Result<()> {
        if self.scripts_dir.is_dir() {
            Ok(())
        } else {
            Err(anyhow!(
                "scripts directory {:?} does not exist; the OS creates it before the agent \
                 starts (ADR-048 DEC-4.3, DEC-4.11)",
                self.scripts_dir
            ))
        }
    }

    /// Generic: create the scripts directory under the data root.
    #[cfg(not(feature = "suderra-os"))]
    fn ensure_scripts_dir(&self) -> Result<()> {
        if !self.scripts_dir.exists() {
            fs::create_dir_all(&self.scripts_dir).with_context(|| {
                format!("Failed to create scripts directory: {:?}", self.scripts_dir)
            })?;
            info!("Created scripts directory: {:?}", self.scripts_dir);
        }
        Ok(())
    }

    /// Copy the legacy directory's script files that `scripts_dir` does not
    /// already hold, once: the marker file makes a later boot skip it, so a
    /// script deleted afterwards stays deleted. The legacy directory is only
    /// read (the generic unit mounts `/etc/suderra` read-only).
    #[cfg(not(feature = "suderra-os"))]
    fn import_legacy_scripts(&self) -> Result<()> {
        let Some(legacy) = &self.legacy_import_dir else {
            return Ok(());
        };
        let marker = self.scripts_dir.join(LEGACY_IMPORT_MARKER);
        if marker.exists() || !legacy.is_dir() {
            return Ok(());
        }
        let entries = fs::read_dir(legacy)
            .with_context(|| format!("Failed to read legacy scripts directory: {legacy:?}"))?;
        let mut imported = 0usize;
        for entry in entries {
            let path = entry?.path();
            let is_script = path
                .extension()
                .map(|e| e == "json" || e == "yaml")
                .unwrap_or(false);
            let Some(name) = path.file_name() else {
                continue;
            };
            let target = self.scripts_dir.join(name);
            if !is_script || target.exists() {
                continue;
            }
            let content = fs::read(&path)
                .with_context(|| format!("Failed to read legacy script {path:?}"))?;
            fs::write(&target, content)
                .with_context(|| format!("Failed to import legacy script into {target:?}"))?;
            imported += 1;
        }
        fs::write(&marker, b"")
            .with_context(|| format!("Failed to write import marker {marker:?}"))?;
        info!(
            "Imported {} script(s) from the legacy directory {:?} into {:?}",
            imported, legacy, self.scripts_dir
        );
        Ok(())
    }

    /// Load all scripts from disk
    pub async fn load_all(&self) -> Result<()> {
        let mut scripts = self.scripts.write().await;
        scripts.clear();
        self.invalidate_active_cache();

        let entries = fs::read_dir(&self.scripts_dir)
            .with_context(|| format!("Failed to read scripts directory: {:?}", self.scripts_dir))?;

        for entry in entries {
            let entry = entry?;
            let path = entry.path();

            if path
                .extension()
                .map(|e| e == "json" || e == "yaml")
                .unwrap_or(false)
            {
                match self.load_script_file(&path) {
                    Ok(script) => {
                        info!(
                            "Loaded script: {} ({})",
                            script.definition.name, script.definition.id
                        );
                        scripts.insert(script.definition.id.clone(), script);
                    }
                    Err(e) => {
                        warn!("Failed to load script from {:?}: {}", path, e);
                    }
                }
            }
        }

        Ok(())
    }

    /// Load a single script file
    fn load_script_file(&self, path: &PathBuf) -> Result<Script> {
        let content = fs::read_to_string(path)
            .with_context(|| format!("Failed to read script file: {:?}", path))?;

        let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("");

        let definition: ScriptDefinition = match extension {
            "yaml" | "yml" => serde_yaml::from_str(&content)
                .with_context(|| format!("Failed to parse YAML script: {:?}", path))?,
            _ => serde_json::from_str(&content)
                .with_context(|| format!("Failed to parse JSON script: {:?}", path))?,
        };

        Ok(Script {
            status: if definition.enabled {
                ScriptStatus::Active
            } else {
                ScriptStatus::Paused
            },
            last_run: None,
            last_result: None,
            error_count: 0,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            revision: 1,
            previous_definition: None,
            definition,
        })
    }

    /// Save a script
    ///
    /// # Memory Safety
    /// Returns an error if the storage is at capacity and the script is new.
    /// Updates to existing scripts are always allowed.
    ///
    /// # Thread Safety
    /// Acquires a write lock on the scripts map.
    pub async fn save(&self, script: Script) -> Result<()> {
        // Validate script ID to prevent path traversal
        validate_script_id(&script.definition.id)?;

        let mut scripts = self.scripts.write().await;

        // Check capacity for new scripts (updates always allowed)
        let is_new = !scripts.contains_key(&script.definition.id);
        if is_new && scripts.len() >= self.max_scripts {
            return Err(anyhow!(
                "Script storage at capacity ({}/{}). Delete existing scripts first.",
                scripts.len(),
                self.max_scripts
            ));
        }

        let filename = format!("{}.json", script.definition.id);
        let path = self.scripts_dir.join(&filename);

        let content = serde_json::to_string_pretty(&script.definition)
            .context("Failed to serialize script")?;

        fs::write(&path, content)
            .with_context(|| format!("Failed to write script file: {:?}", path))?;

        info!("Saved script: {} to {:?}", script.definition.id, path);

        scripts.insert(script.definition.id.clone(), script);
        self.invalidate_active_cache();
        Ok(())
    }

    /// Add or update a script from definition
    ///
    /// # Versioning (v1.2.1 - issue #28)
    /// If updating an existing script, stores the previous version and increments revision.
    pub async fn add_script(&self, definition: ScriptDefinition) -> Result<()> {
        let scripts = self.scripts.read().await;
        let existing = scripts.get(&definition.id).cloned();
        drop(scripts);

        let script = if let Some(mut old_script) = existing {
            // Update existing script - store previous version (v1.2.1)
            old_script.previous_definition = Some(Box::new(old_script.definition.clone()));
            // v1.2.3: Warn if revision is about to wrap around
            if old_script.revision == u32::MAX {
                warn!(
                    "Script '{}' revision counter wrapping from {} to 0. \
                    Version history tracking may be affected.",
                    definition.id, old_script.revision
                );
            }
            old_script.definition = definition;
            old_script.revision = old_script.revision.wrapping_add(1);
            old_script.updated_at = Utc::now();
            old_script.status = if old_script.definition.enabled {
                ScriptStatus::Active
            } else {
                ScriptStatus::Paused
            };
            old_script.error_count = 0; // Reset on update
            old_script
        } else {
            // New script
            Script {
                status: if definition.enabled {
                    ScriptStatus::Active
                } else {
                    ScriptStatus::Paused
                },
                last_run: None,
                last_result: None,
                error_count: 0,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                revision: 1, // v1.2.1: start at revision 1
                previous_definition: None,
                definition,
            }
        };

        self.save(script).await
    }

    /// Get a script by ID (returns cloned copy for thread safety)
    pub async fn get(&self, id: &str) -> Option<Script> {
        let scripts = self.scripts.read().await;
        scripts.get(id).cloned()
    }

    /// Get all scripts (returns cloned copies for thread safety)
    pub async fn get_all(&self) -> Vec<Script> {
        let scripts = self.scripts.read().await;
        scripts.values().cloned().collect()
    }

    /// Get active scripts — cached, rebuilt only when scripts change.
    ///
    /// On constrained hardware the scan cycle may run at 10ms intervals.
    /// Rather than cloning the full HashMap on every cycle, an `Arc<Vec<Script>>`
    /// is returned from a dirty-flag cache that is invalidated by write operations.
    pub async fn get_active(&self) -> Arc<Vec<Script>> {
        // Fast path: return existing cache if not dirty
        {
            let cache = self.active_cache.read().await;
            if let Some(cached) = cache.as_ref() {
                if !*self.dirty_rx.borrow() {
                    return cached.clone();
                }
            }
        }

        // Slow path: rebuild cache
        let scripts = self.scripts.read().await;
        let active: Vec<Script> = scripts
            .values()
            .filter(|s| s.status == ScriptStatus::Active && s.definition.enabled)
            .cloned()
            .collect();
        let arc = Arc::new(active);

        let mut cache = self.active_cache.write().await;
        *cache = Some(arc.clone());
        // Mark as clean
        let _ = self.dirty_tx.send(false);

        arc
    }

    /// Delete a script
    pub async fn delete(&self, id: &str) -> Result<bool> {
        // Validate script ID to prevent path traversal
        validate_script_id(id)?;

        let mut scripts = self.scripts.write().await;

        if scripts.remove(id).is_some() {
            // Delete file
            let filename = format!("{}.json", id);
            let path = self.scripts_dir.join(&filename);

            if path.exists() {
                fs::remove_file(&path)
                    .with_context(|| format!("Failed to delete script file: {:?}", path))?;
            }

            info!("Deleted script: {}", id);
            self.invalidate_active_cache();
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Enable a script
    pub async fn enable(&self, id: &str) -> Result<bool> {
        // Validate script ID to prevent path traversal
        validate_script_id(id)?;

        let mut scripts = self.scripts.write().await;

        if let Some(script) = scripts.get_mut(id) {
            script.definition.enabled = true;
            script.status = ScriptStatus::Active;
            script.updated_at = Utc::now();

            // Save to disk
            let definition = script.definition.clone();
            let filename = format!("{}.json", id);
            let path = self.scripts_dir.join(&filename);

            let content = serde_json::to_string_pretty(&definition)?;
            fs::write(&path, content)?;

            info!("Enabled script: {}", id);
            self.invalidate_active_cache();
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Disable a script
    pub async fn disable(&self, id: &str) -> Result<bool> {
        // Validate script ID to prevent path traversal
        validate_script_id(id)?;

        let mut scripts = self.scripts.write().await;

        if let Some(script) = scripts.get_mut(id) {
            script.definition.enabled = false;
            script.status = ScriptStatus::Paused;
            script.updated_at = Utc::now();

            // Save to disk
            let definition = script.definition.clone();
            let filename = format!("{}.json", id);
            let path = self.scripts_dir.join(&filename);

            let content = serde_json::to_string_pretty(&definition)?;
            fs::write(&path, content)?;

            info!("Disabled script: {}", id);
            self.invalidate_active_cache();
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Rollback a script to its previous version (v1.2.1 - issue #28)
    ///
    /// Returns true if rollback was successful, false if no previous version exists.
    pub async fn rollback_script(&self, id: &str) -> Result<bool> {
        validate_script_id(id)?;

        let mut scripts = self.scripts.write().await;

        if let Some(script) = scripts.get_mut(id) {
            if script.rollback() {
                // Save to disk
                let definition = script.definition.clone();
                let filename = format!("{}.json", id);
                let path = self.scripts_dir.join(&filename);

                let content = serde_json::to_string_pretty(&definition)?;
                fs::write(&path, content)?;

                info!("Rolled back script: {} to revision {}", id, script.revision);
                Ok(true)
            } else {
                warn!("No previous version available for script: {}", id);
                Ok(false)
            }
        } else {
            Ok(false)
        }
    }

    /// Update script execution result
    pub async fn update_result(&self, id: &str, success: bool, result: &str) {
        let mut scripts = self.scripts.write().await;

        if let Some(script) = scripts.get_mut(id) {
            script.last_run = Some(Utc::now());
            script.last_result = Some(result.to_string());

            if success {
                script.error_count = 0;
                if script.status == ScriptStatus::Running {
                    script.status = ScriptStatus::Active;
                }
            } else {
                script.error_count += 1;

                // Disable after 5 consecutive errors
                if script.error_count >= 5 {
                    script.status = ScriptStatus::Error;
                    warn!(
                        "Script {} disabled after {} consecutive errors",
                        id, script.error_count
                    );
                }
            }
        }
    }

    /// Set script status to Running
    pub async fn set_running(&self, id: &str) -> bool {
        let mut scripts = self.scripts.write().await;
        if let Some(script) = scripts.get_mut(id) {
            script.status = ScriptStatus::Running;
            true
        } else {
            false
        }
    }

    /// Get script count
    pub async fn count(&self) -> usize {
        let scripts = self.scripts.read().await;
        scripts.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_script_status_serialization() {
        assert_eq!(
            serde_json::to_string(&ScriptStatus::Active).unwrap(),
            "\"active\""
        );
        assert_eq!(
            serde_json::to_string(&ScriptStatus::Paused).unwrap(),
            "\"paused\""
        );
    }

    /// ADR-048 DEC-4.1: an older generic agent's scripts are imported once
    /// from the read-only legacy directory, and a script deleted after the
    /// import is not resurrected on the next boot.
    #[cfg(not(feature = "suderra-os"))]
    #[tokio::test]
    async fn legacy_scripts_are_imported_once() {
        let root = tempfile::tempdir().expect("tempdir");
        let legacy = root.path().join("etc-scripts");
        let current = root.path().join("data").join("scripts");
        fs::create_dir_all(&legacy).expect("mkdir legacy");
        fs::write(legacy.join("pump.json"), b"{}").expect("seed legacy");
        fs::write(legacy.join("notes.txt"), b"not a script").expect("seed other");

        let storage = ScriptStorage::new(current.clone()).with_legacy_import_dir(legacy.clone());
        storage.init().await.expect("init");
        assert!(current.join("pump.json").exists(), "script imported");
        assert!(!current.join("notes.txt").exists(), "only script files");
        assert_eq!(
            fs::read(legacy.join("pump.json")).expect("legacy kept"),
            b"{}"
        );

        fs::remove_file(current.join("pump.json")).expect("delete");
        let again = ScriptStorage::new(current.clone()).with_legacy_import_dir(legacy);
        again.init().await.expect("re-init");
        assert!(
            !current.join("pump.json").exists(),
            "a deleted script stays deleted"
        );
    }

    /// Suderra OS: the agent never creates its contract directories.
    #[cfg(feature = "suderra-os")]
    #[tokio::test]
    async fn suderra_os_does_not_create_a_missing_scripts_dir() {
        let root = tempfile::tempdir().expect("tempdir");
        let missing = root.path().join("scripts");
        let err = ScriptStorage::new(missing.clone())
            .init()
            .await
            .expect_err("must refuse");
        assert!(format!("{err:#}").contains("does not exist"), "{err:#}");
        assert!(!missing.exists());
    }

    #[test]
    fn test_validate_script_id_valid() {
        // Valid IDs should pass
        assert!(validate_script_id("my-script").is_ok());
        assert!(validate_script_id("my_script_123").is_ok());
        assert!(validate_script_id("Script01").is_ok());
        assert!(validate_script_id("a").is_ok());
    }

    #[test]
    fn test_validate_script_id_path_traversal() {
        // Path traversal attempts should fail
        assert!(validate_script_id("../etc/passwd").is_err());
        assert!(validate_script_id("..").is_err());
        assert!(validate_script_id("foo/../bar").is_err());
        assert!(validate_script_id("/etc/passwd").is_err());
        assert!(validate_script_id("foo/bar").is_err());
        assert!(validate_script_id("C:\\Windows\\System32").is_err());
        assert!(validate_script_id("foo\\bar").is_err());
    }

    #[test]
    fn test_validate_script_id_special_chars() {
        // Special characters should fail
        assert!(validate_script_id("script;rm -rf /").is_err());
        assert!(validate_script_id("script$HOME").is_err());
        assert!(validate_script_id("script`id`").is_err());
        assert!(validate_script_id("script|cat").is_err());
        assert!(validate_script_id("script name").is_err()); // space
    }

    #[test]
    fn test_validate_script_id_edge_cases() {
        // Empty ID should fail
        assert!(validate_script_id("").is_err());

        // Hidden file should fail
        assert!(validate_script_id(".hidden").is_err());

        // Too long ID should fail
        let long_id = "a".repeat(MAX_SCRIPT_ID_LENGTH + 1);
        assert!(validate_script_id(&long_id).is_err());

        // Max length should pass
        let max_id = "a".repeat(MAX_SCRIPT_ID_LENGTH);
        assert!(validate_script_id(&max_id).is_ok());
    }
}
