//! Script storage and persistence
//!
//! Handles saving, loading, and managing scripts on the edge device.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tracing::{info, warn, error, debug};
use anyhow::{Result, Context};
use chrono::{DateTime, Utc};

use super::ScriptDefinition;

/// Default scripts directory
const DEFAULT_SCRIPTS_DIR: &str = "/etc/suderra/scripts";

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

/// Script storage manager
pub struct ScriptStorage {
    scripts_dir: PathBuf,
    scripts: HashMap<String, Script>,
}

impl ScriptStorage {
    /// Create a new script storage
    pub fn new(scripts_dir: Option<&str>) -> Self {
        let dir = scripts_dir.unwrap_or(DEFAULT_SCRIPTS_DIR);
        Self {
            scripts_dir: PathBuf::from(dir),
            scripts: HashMap::new(),
        }
    }

    /// Initialize storage and load existing scripts
    pub fn init(&mut self) -> Result<()> {
        // Create scripts directory if it doesn't exist
        if !self.scripts_dir.exists() {
            fs::create_dir_all(&self.scripts_dir)
                .with_context(|| format!("Failed to create scripts directory: {:?}", self.scripts_dir))?;
            info!("Created scripts directory: {:?}", self.scripts_dir);
        }

        // Load existing scripts
        self.load_all()?;

        info!("Script storage initialized with {} scripts", self.scripts.len());
        Ok(())
    }

    /// Load all scripts from disk
    pub fn load_all(&mut self) -> Result<()> {
        self.scripts.clear();

        let entries = fs::read_dir(&self.scripts_dir)
            .with_context(|| format!("Failed to read scripts directory: {:?}", self.scripts_dir))?;

        for entry in entries {
            let entry = entry?;
            let path = entry.path();

            if path.extension().map(|e| e == "json" || e == "yaml").unwrap_or(false) {
                match self.load_script_file(&path) {
                    Ok(script) => {
                        info!("Loaded script: {} ({})", script.definition.name, script.definition.id);
                        self.scripts.insert(script.definition.id.clone(), script);
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
            status: if definition.enabled { ScriptStatus::Active } else { ScriptStatus::Paused },
            last_run: None,
            last_result: None,
            error_count: 0,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            definition,
        })
    }

    /// Save a script
    pub fn save(&mut self, script: Script) -> Result<()> {
        let filename = format!("{}.json", script.definition.id);
        let path = self.scripts_dir.join(&filename);

        let content = serde_json::to_string_pretty(&script.definition)
            .context("Failed to serialize script")?;

        fs::write(&path, content)
            .with_context(|| format!("Failed to write script file: {:?}", path))?;

        info!("Saved script: {} to {:?}", script.definition.id, path);

        self.scripts.insert(script.definition.id.clone(), script);
        Ok(())
    }

    /// Add or update a script from definition
    pub fn add_script(&mut self, definition: ScriptDefinition) -> Result<()> {
        let script = Script {
            status: if definition.enabled { ScriptStatus::Active } else { ScriptStatus::Paused },
            last_run: None,
            last_result: None,
            error_count: 0,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            definition,
        };

        self.save(script)
    }

    /// Get a script by ID
    pub fn get(&self, id: &str) -> Option<&Script> {
        self.scripts.get(id)
    }

    /// Get a mutable script by ID
    pub fn get_mut(&mut self, id: &str) -> Option<&mut Script> {
        self.scripts.get_mut(id)
    }

    /// Get all scripts
    pub fn get_all(&self) -> Vec<&Script> {
        self.scripts.values().collect()
    }

    /// Get active scripts only
    pub fn get_active(&self) -> Vec<&Script> {
        self.scripts.values()
            .filter(|s| s.status == ScriptStatus::Active && s.definition.enabled)
            .collect()
    }

    /// Delete a script
    pub fn delete(&mut self, id: &str) -> Result<bool> {
        if self.scripts.remove(id).is_some() {
            // Delete file
            let filename = format!("{}.json", id);
            let path = self.scripts_dir.join(&filename);

            if path.exists() {
                fs::remove_file(&path)
                    .with_context(|| format!("Failed to delete script file: {:?}", path))?;
            }

            info!("Deleted script: {}", id);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Enable a script
    pub fn enable(&mut self, id: &str) -> Result<bool> {
        if let Some(script) = self.scripts.get_mut(id) {
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
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Disable a script
    pub fn disable(&mut self, id: &str) -> Result<bool> {
        if let Some(script) = self.scripts.get_mut(id) {
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
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Update script execution result
    pub fn update_result(&mut self, id: &str, success: bool, result: &str) {
        if let Some(script) = self.scripts.get_mut(id) {
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
                    warn!("Script {} disabled after {} consecutive errors", id, script.error_count);
                }
            }
        }
    }

    /// Get script count
    pub fn count(&self) -> usize {
        self.scripts.len()
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
}
