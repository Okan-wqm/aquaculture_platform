//! Persistent partition-state store (Batch 106 Sprint 6.5
//! Updater runtime foundation).
//!
//! ## WHY
//!
//! Plan §5 Faz 2 item 6 + ADR-019 §2 mandate an A/B firmware
//! partition lifecycle with persistent state: which slot is
//! active, which is standby, whether PendingConfirm is
//! pending a post-boot health check, when the cold-boot
//! budget deadline fires. Pre-Batch-106 these types existed
//! (`AbPartition`, `SlotState`, `PartitionRoll`) as pure
//! values but the RUNTIME state machine + durable state
//! store were not yet landed.
//!
//! This module:
//! 1. Defines `PartitionState` — the full on-disk state
//!    shape (active slot + per-slot state + pending-confirm
//!    deadline).
//! 2. Provides `PartitionStore` — loads + persists the
//!    state at `/var/lib/suderra/partition.json` via
//!    atomic tempfile + rename. First-boot creates a
//!    zero-state (slot_a=Empty, slot_b=Empty, active=A).
//! 3. Applies `PartitionRoll` transitions with
//!    validate-then-mutate discipline: every roll matches
//!    the current state against the transition's
//!    preconditions; mismatch returns `Error::InvalidTransition`
//!    and no mutation happens.
//!
//! ## WHAT THIS BATCH DOES NOT DO
//!
//! - Actual bootloader flag write (RPi tryboot overlay +
//!   /boot/config.txt edit). That's Batch 107 — coordinates
//!   the disk state HERE with the bootloader flags THERE.
//! - Cold-boot-budget watchdog task. Batch 108.
//! - Update-command orchestrator that calls apply_roll +
//!   download + verify. Batch 109.
//! - systemd service integration to mark slot confirmed
//!   after N seconds of healthy operation. Batch 110.
//!
//! ## Security invariants
//!
//! - Store file at 0640 owner:suderra group:adm —
//!   operators can read via log shipper, only agent + root
//!   can write. Same perms class as audit.log per Batch 74
//!   discipline.
//! - Atomic write via tempfile + same-dir rename. Power
//!   loss mid-write leaves either OLD complete state or NEW
//!   complete state; never partial.
//! - Fail-closed: corrupt JSON on read returns Err; caller
//!   (boot init) should log + refuse to apply updates (the
//!   agent keeps running on the current-booted firmware).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use super::partition::{AbPartition, PartitionRoll, SlotState};

/// Canonical on-disk state-store path.
const DEFAULT_STORE_PATH: &str = "/var/lib/suderra/partition.json";

/// Persistent A/B partition state — the single source of
/// truth for `cmd_update_firmware` handler + the post-boot
/// confirmation task.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PartitionState {
    /// Which slot is currently booted + serving traffic.
    pub active: AbPartition,
    /// Lifecycle state of slot A.
    pub slot_a_state: SlotState,
    /// Lifecycle state of slot B.
    pub slot_b_state: SlotState,
    /// UNIX secs deadline for the PendingConfirm slot (if
    /// any) to transition to Active. None = no pending-
    /// confirm window open. When present + expired, the
    /// post-boot watchdog (Batch 108) applies a Rollback.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub pending_confirm_deadline_unix_secs: Option<i64>,
    /// Firmware version on the active slot (informational).
    /// Downgrade-prevention enforces monotonic version at
    /// apply-time in Batch 109; this field is the LAST
    /// VERIFIED value for operator visibility.
    #[serde(default)]
    pub active_firmware_version: u64,
}

impl PartitionState {
    /// First-boot initial state: both slots Empty, active=A
    /// (arbitrary choice), no pending confirm, version 0.
    pub fn initial() -> Self {
        Self {
            active: AbPartition::A,
            slot_a_state: SlotState::Empty,
            slot_b_state: SlotState::Empty,
            pending_confirm_deadline_unix_secs: None,
            active_firmware_version: 0,
        }
    }

    /// Helper: state of the specified slot.
    pub fn state_of(&self, slot: AbPartition) -> SlotState {
        match slot {
            AbPartition::A => self.slot_a_state,
            AbPartition::B => self.slot_b_state,
        }
    }

    fn set_state_of(&mut self, slot: AbPartition, state: SlotState) {
        match slot {
            AbPartition::A => self.slot_a_state = state,
            AbPartition::B => self.slot_b_state = state,
        }
    }
}

/// Transition / IO error taxonomy.
#[derive(Debug)]
pub enum PartitionStoreError {
    /// Failed to read/write the state file.
    IoError(String),
    /// JSON parse failed.
    ParseError(String),
    /// Attempted transition preconditions don't match current
    /// state. E.g. calling `Confirm { slot: B }` when slot B
    /// is Active (not PendingConfirm). Operator investigation
    /// required — we do NOT silently accept.
    InvalidTransition {
        from_a: SlotState,
        from_b: SlotState,
        roll: &'static str,
    },
    /// Mutex poisoned (prior panic). Recoverable by agent
    /// restart.
    LockPoisoned,
}

impl std::fmt::Display for PartitionStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::IoError(e) => write!(f, "partition store IO: {}", e),
            Self::ParseError(e) => write!(f, "partition store parse: {}", e),
            Self::InvalidTransition { from_a, from_b, roll } => write!(
                f,
                "invalid partition transition: roll={} current: A={:?} B={:?}",
                roll, from_a, from_b
            ),
            Self::LockPoisoned => write!(f, "partition store mutex poisoned"),
        }
    }
}

impl std::error::Error for PartitionStoreError {}

/// Persistent state-store runtime.
pub struct PartitionStore {
    path: PathBuf,
    state: Mutex<PartitionState>,
}

impl PartitionStore {
    /// Open the store at `path` (default
    /// `/var/lib/suderra/partition.json`). Creates with
    /// `PartitionState::initial()` on first boot.
    ///
    /// Fails on: unreadable parent dir, corrupt JSON in
    /// existing file. Does NOT fail on file-not-found (that's
    /// the first-boot path — store writes initial state).
    pub fn open(path: Option<&Path>) -> Result<Self, PartitionStoreError> {
        let path_buf = match path {
            Some(p) => p.to_path_buf(),
            None => PathBuf::from(DEFAULT_STORE_PATH),
        };

        if let Some(parent) = path_buf.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                PartitionStoreError::IoError(format!(
                    "mkdir {}: {}",
                    parent.display(),
                    e
                ))
            })?;
        }

        let state = if path_buf.exists() {
            let bytes = std::fs::read(&path_buf).map_err(|e| {
                PartitionStoreError::IoError(format!(
                    "read {}: {}",
                    path_buf.display(),
                    e
                ))
            })?;
            serde_json::from_slice(&bytes).map_err(|e| {
                PartitionStoreError::ParseError(format!(
                    "parse {}: {}",
                    path_buf.display(),
                    e
                ))
            })?
        } else {
            let initial = PartitionState::initial();
            info!(
                "PartitionStore first-boot: writing initial state at {}",
                path_buf.display()
            );
            let store = Self {
                path: path_buf.clone(),
                state: Mutex::new(initial.clone()),
            };
            store.persist(&initial)?;
            return Ok(store);
        };

        Ok(Self {
            path: path_buf,
            state: Mutex::new(state),
        })
    }

    /// Clone the current state under a brief read guard.
    pub fn snapshot(&self) -> Result<PartitionState, PartitionStoreError> {
        let guard = self.state.lock().map_err(|_| PartitionStoreError::LockPoisoned)?;
        Ok(guard.clone())
    }

    /// Apply a PartitionRoll transition.
    ///
    /// Steps:
    /// 1. Acquire write guard.
    /// 2. Validate preconditions for the roll variant.
    /// 3. Mutate in-memory state.
    /// 4. Persist to disk (tempfile + rename).
    /// 5. On persist failure: rollback in-memory mutation +
    ///    return Err.
    ///
    /// Returns the new state on success.
    pub fn apply_roll(
        &self,
        roll: PartitionRoll,
        cold_boot_budget_secs: u64,
    ) -> Result<PartitionState, PartitionStoreError> {
        let mut guard = self.state.lock().map_err(|_| PartitionStoreError::LockPoisoned)?;
        let prev_state = guard.clone();

        self.apply_roll_to_state(&mut guard, roll, cold_boot_budget_secs)?;

        // Persist under the lock — consumers observing via
        // snapshot() will see either OLD or NEW; never
        // partial.
        match self.persist(&guard) {
            Ok(()) => {
                info!(
                    "PartitionStore applied {:?}: new_state={:?}",
                    roll_label(&roll),
                    *guard
                );
                Ok(guard.clone())
            }
            Err(e) => {
                // Rollback in-memory so consumer snapshots
                // stay consistent with disk.
                warn!(
                    "PartitionStore persist failed: {}. Rolling back in-memory state.",
                    e
                );
                *guard = prev_state;
                Err(e)
            }
        }
    }

    fn apply_roll_to_state(
        &self,
        guard: &mut PartitionState,
        roll: PartitionRoll,
        cold_boot_budget_secs: u64,
    ) -> Result<(), PartitionStoreError> {
        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        match roll {
            PartitionRoll::InitialInstall { target } => {
                // Valid from: the target slot is Empty AND
                // the other slot is also Empty (first-boot
                // path). Post-first-boot we never hit
                // InitialInstall.
                let other = target.other();
                if guard.state_of(target) != SlotState::Empty
                    || guard.state_of(other) != SlotState::Empty
                {
                    return Err(PartitionStoreError::InvalidTransition {
                        from_a: guard.slot_a_state,
                        from_b: guard.slot_b_state,
                        roll: "InitialInstall",
                    });
                }
                guard.set_state_of(target, SlotState::PendingConfirm);
                guard.active = target;
                guard.pending_confirm_deadline_unix_secs = Some(
                    now_secs.saturating_add(cold_boot_budget_secs as i64),
                );
            }
            PartitionRoll::SwapToPending { old_active, new_pending } => {
                if guard.active != old_active {
                    return Err(PartitionStoreError::InvalidTransition {
                        from_a: guard.slot_a_state,
                        from_b: guard.slot_b_state,
                        roll: "SwapToPending",
                    });
                }
                if guard.state_of(old_active) != SlotState::Active {
                    return Err(PartitionStoreError::InvalidTransition {
                        from_a: guard.slot_a_state,
                        from_b: guard.slot_b_state,
                        roll: "SwapToPending",
                    });
                }
                if new_pending == old_active {
                    return Err(PartitionStoreError::InvalidTransition {
                        from_a: guard.slot_a_state,
                        from_b: guard.slot_b_state,
                        roll: "SwapToPending",
                    });
                }
                guard.set_state_of(old_active, SlotState::Standby);
                guard.set_state_of(new_pending, SlotState::PendingConfirm);
                guard.active = new_pending;
                guard.pending_confirm_deadline_unix_secs = Some(
                    now_secs.saturating_add(cold_boot_budget_secs as i64),
                );
            }
            PartitionRoll::Confirm { slot } => {
                if guard.state_of(slot) != SlotState::PendingConfirm {
                    return Err(PartitionStoreError::InvalidTransition {
                        from_a: guard.slot_a_state,
                        from_b: guard.slot_b_state,
                        roll: "Confirm",
                    });
                }
                guard.set_state_of(slot, SlotState::Active);
                guard.active = slot;
                guard.pending_confirm_deadline_unix_secs = None;
            }
            PartitionRoll::Rollback { failed, restored_active } => {
                if guard.state_of(failed) != SlotState::PendingConfirm {
                    return Err(PartitionStoreError::InvalidTransition {
                        from_a: guard.slot_a_state,
                        from_b: guard.slot_b_state,
                        roll: "Rollback",
                    });
                }
                if guard.state_of(restored_active) != SlotState::Standby {
                    return Err(PartitionStoreError::InvalidTransition {
                        from_a: guard.slot_a_state,
                        from_b: guard.slot_b_state,
                        roll: "Rollback",
                    });
                }
                guard.set_state_of(failed, SlotState::Empty);
                guard.set_state_of(restored_active, SlotState::Active);
                guard.active = restored_active;
                guard.pending_confirm_deadline_unix_secs = None;
            }
        }

        Ok(())
    }

    /// Persist state to disk atomically via tempfile + rename.
    fn persist(&self, state: &PartitionState) -> Result<(), PartitionStoreError> {
        let json = serde_json::to_vec_pretty(state).map_err(|e| {
            PartitionStoreError::ParseError(format!("serialize: {}", e))
        })?;

        let tmp_path = self.path.with_extension("json.tmp");

        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o640)
                .open(&tmp_path)
                .map_err(|e| {
                    PartitionStoreError::IoError(format!(
                        "open tempfile {}: {}",
                        tmp_path.display(),
                        e
                    ))
                })?;
            std::io::Write::write_all(&mut file, &json).map_err(|e| {
                PartitionStoreError::IoError(format!("write tempfile: {}", e))
            })?;
            std::io::Write::flush(&mut file).map_err(|e| {
                PartitionStoreError::IoError(format!("flush tempfile: {}", e))
            })?;
            file.sync_all().map_err(|e| {
                PartitionStoreError::IoError(format!("fsync tempfile: {}", e))
            })?;
        }

        #[cfg(not(unix))]
        {
            std::fs::write(&tmp_path, &json).map_err(|e| {
                PartitionStoreError::IoError(format!(
                    "write tempfile {}: {}",
                    tmp_path.display(),
                    e
                ))
            })?;
        }

        std::fs::rename(&tmp_path, &self.path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            PartitionStoreError::IoError(format!(
                "rename {} -> {}: {}",
                tmp_path.display(),
                self.path.display(),
                e
            ))
        })?;

        Ok(())
    }
}

/// Human-readable label for audit + log output.
fn roll_label(roll: &PartitionRoll) -> &'static str {
    match roll {
        PartitionRoll::InitialInstall { .. } => "InitialInstall",
        PartitionRoll::SwapToPending { .. } => "SwapToPending",
        PartitionRoll::Confirm { .. } => "Confirm",
        PartitionRoll::Rollback { .. } => "Rollback",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "suderra-partition-store-test-{}-{}.json",
            std::process::id(),
            rand::random::<u32>()
        ))
    }

    #[test]
    fn first_boot_creates_initial_state() {
        let path = tmp_store_path();
        let _ = std::fs::remove_file(&path);
        let store = PartitionStore::open(Some(&path)).expect("open");
        let snap = store.snapshot().expect("snap");
        assert_eq!(snap, PartitionState::initial());
        assert!(path.exists());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn state_persists_across_reopen() {
        let path = tmp_store_path();
        let _ = std::fs::remove_file(&path);
        {
            let store = PartitionStore::open(Some(&path)).expect("open 1");
            store
                .apply_roll(
                    PartitionRoll::InitialInstall {
                        target: AbPartition::A,
                    },
                    90,
                )
                .expect("roll");
        }
        let store2 = PartitionStore::open(Some(&path)).expect("open 2");
        let snap = store2.snapshot().expect("snap");
        assert_eq!(snap.active, AbPartition::A);
        assert_eq!(snap.slot_a_state, SlotState::PendingConfirm);
        assert!(snap.pending_confirm_deadline_unix_secs.is_some());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn initial_install_then_confirm_reaches_active() {
        let path = tmp_store_path();
        let _ = std::fs::remove_file(&path);
        let store = PartitionStore::open(Some(&path)).expect("open");
        store
            .apply_roll(
                PartitionRoll::InitialInstall {
                    target: AbPartition::A,
                },
                90,
            )
            .expect("install");
        store
            .apply_roll(PartitionRoll::Confirm { slot: AbPartition::A }, 90)
            .expect("confirm");

        let snap = store.snapshot().expect("snap");
        assert_eq!(snap.active, AbPartition::A);
        assert_eq!(snap.slot_a_state, SlotState::Active);
        assert!(snap.pending_confirm_deadline_unix_secs.is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn swap_to_pending_preserves_old_as_standby() {
        let path = tmp_store_path();
        let _ = std::fs::remove_file(&path);
        let store = PartitionStore::open(Some(&path)).expect("open");
        // Set up: slot A = Active.
        store
            .apply_roll(
                PartitionRoll::InitialInstall { target: AbPartition::A },
                90,
            )
            .expect("install");
        store
            .apply_roll(PartitionRoll::Confirm { slot: AbPartition::A }, 90)
            .expect("confirm");

        // Update lands on slot B.
        store
            .apply_roll(
                PartitionRoll::SwapToPending {
                    old_active: AbPartition::A,
                    new_pending: AbPartition::B,
                },
                90,
            )
            .expect("swap");

        let snap = store.snapshot().expect("snap");
        assert_eq!(snap.active, AbPartition::B);
        assert_eq!(snap.slot_a_state, SlotState::Standby);
        assert_eq!(snap.slot_b_state, SlotState::PendingConfirm);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rollback_restores_standby_as_active() {
        let path = tmp_store_path();
        let _ = std::fs::remove_file(&path);
        let store = PartitionStore::open(Some(&path)).expect("open");
        store
            .apply_roll(
                PartitionRoll::InitialInstall { target: AbPartition::A },
                90,
            )
            .expect("install");
        store
            .apply_roll(PartitionRoll::Confirm { slot: AbPartition::A }, 90)
            .expect("confirm");
        store
            .apply_roll(
                PartitionRoll::SwapToPending {
                    old_active: AbPartition::A,
                    new_pending: AbPartition::B,
                },
                90,
            )
            .expect("swap");
        store
            .apply_roll(
                PartitionRoll::Rollback {
                    failed: AbPartition::B,
                    restored_active: AbPartition::A,
                },
                90,
            )
            .expect("rollback");

        let snap = store.snapshot().expect("snap");
        assert_eq!(snap.active, AbPartition::A);
        assert_eq!(snap.slot_a_state, SlotState::Active);
        assert_eq!(snap.slot_b_state, SlotState::Empty);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn invalid_transition_preserves_state() {
        let path = tmp_store_path();
        let _ = std::fs::remove_file(&path);
        let store = PartitionStore::open(Some(&path)).expect("open");

        // Confirming an Empty slot is invalid.
        let err = store
            .apply_roll(PartitionRoll::Confirm { slot: AbPartition::A }, 90)
            .expect_err("must reject");
        assert!(matches!(
            err,
            PartitionStoreError::InvalidTransition { .. }
        ));

        // State unchanged.
        let snap = store.snapshot().expect("snap");
        assert_eq!(snap, PartitionState::initial());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn swap_rejects_non_active_old() {
        let path = tmp_store_path();
        let _ = std::fs::remove_file(&path);
        let store = PartitionStore::open(Some(&path)).expect("open");
        // Attempt swap from Empty A — invalid, A is not Active.
        let err = store
            .apply_roll(
                PartitionRoll::SwapToPending {
                    old_active: AbPartition::A,
                    new_pending: AbPartition::B,
                },
                90,
            )
            .expect_err("must reject");
        assert!(matches!(
            err,
            PartitionStoreError::InvalidTransition { .. }
        ));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn initial_install_sets_cold_boot_deadline() {
        let path = tmp_store_path();
        let _ = std::fs::remove_file(&path);
        let store = PartitionStore::open(Some(&path)).expect("open");
        let before = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        store
            .apply_roll(
                PartitionRoll::InitialInstall { target: AbPartition::A },
                120,
            )
            .expect("install");
        let snap = store.snapshot().expect("snap");
        let deadline = snap.pending_confirm_deadline_unix_secs.unwrap();
        // Deadline is roughly now + 120s (allow 2s clock
        // drift between before/after).
        assert!(deadline >= before + 118 && deadline <= before + 122);
        let _ = std::fs::remove_file(&path);
    }
}
