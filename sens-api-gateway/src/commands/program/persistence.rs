//! commands::program::persistence
//!
//! ## Why this module exists (Batch #304 ULTRA-HIGH-013 ceiling)
//!
//! Pre-Batch-#304 commands/program.rs was a single 631-line
//! file that violated the ≤500-line ceiling. Batch #304 split
//! the 4 cmd_program_* handlers + 2 program-state-persistence
//! helpers across 3 sibling files keyed by command-class +
//! kept the EffectiveDeployLimits helper alongside its tests
//! in mod.rs. This file:
//!
//! load_program_state / save_program_state —
//! ProgramState file persistence. Atomic tmp+rename on save
//! so a half-written file on power-loss does not break
//! load's parse path on next boot. Backup-on-corruption on
//! load (timestamps the corrupted file + falls back to a
//! default state) so operator forensics can recover the
//! exact pre-corruption bytes.
//!
//! Method visibility: pub(in crate::commands) so the dispatch
//! table in commands/dispatch_lifecycle.rs can call them while
//! external (non-commands) modules cannot.

use std::fs;
use tracing::{debug, error, warn};

use super::super::{CommandHandler, ProgramState};

impl CommandHandler {
    pub(in crate::commands) fn load_program_state(&self) -> ProgramState {
        match fs::read_to_string(&self.program_state_path) {
            Ok(content) => match serde_json::from_str(&content) {
                Ok(state) => state,
                Err(e) => {
                    error!(
                        path = ?self.program_state_path,
                        error = %e,
                        "Failed to parse program state - file may be corrupted"
                    );

                    let backup_path = format!(
                        "{}.corrupted.{}",
                        self.program_state_path.display(),
                        chrono::Utc::now().format("%Y%m%d_%H%M%S")
                    );
                    match fs::copy(&self.program_state_path, &backup_path) {
                        Ok(_) => {
                            warn!(
                                "Corrupted program state backed up to: {}. \
                                Using default state. Manual investigation recommended.",
                                backup_path
                            );
                        }
                        Err(backup_err) => {
                            error!(
                                "Failed to backup corrupted program state: {}. \
                                Original file at: {:?}. DATA MAY BE LOST.",
                                backup_err, self.program_state_path
                            );
                        }
                    }

                    ProgramState::default()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                debug!(
                    path = ?self.program_state_path,
                    "Program state file not found - using default"
                );
                ProgramState::default()
            }
            Err(e) => {
                warn!(
                    path = ?self.program_state_path,
                    error = %e,
                    "Failed to read program state file - using default"
                );
                ProgramState::default()
            }
        }
    }

    /// Save program state to disk.
    ///
    /// v2.3: Atomic write (tmp + rename) to prevent corruption on
    /// power loss. A half-written file on power-loss would break
    /// load_program_state's parse path on next boot; atomic
    /// rename keeps the old file valid until the new file is
    /// fully flushed.
    pub(in crate::commands) fn save_program_state(
        &self,
        state: &ProgramState,
    ) -> anyhow::Result<()> {
        if let Some(parent) = self.program_state_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let content = serde_json::to_string_pretty(state)?;

        let tmp_path = self.program_state_path.with_extension("json.tmp");
        fs::write(&tmp_path, &content)?;
        fs::rename(&tmp_path, &self.program_state_path)?;

        debug!(path = ?self.program_state_path, "Program state saved (atomic)");
        Ok(())
    }
}
