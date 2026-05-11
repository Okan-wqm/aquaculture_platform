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

use nix::fcntl::{Flock, FlockArg};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use super::partition::{AbPartition, PartitionRoll, SlotState};

/// Canonical on-disk state-store path.
const DEFAULT_STORE_PATH: &str = "/var/lib/suderra/partition.json";

/// Cross-process advisory file lock guard (Batch 121
/// Sprint 6.5). Acquired at start of every apply_roll +
/// apply_roll_with_version_bump; released on drop.
///
/// ## WHY
///
/// Pre-Batch-121 PartitionStore used only an in-process
/// `Mutex<PartitionState>` which is worthless for cross-
/// process safety. The `--confirm-active` CLI (Batch 110)
/// and the running agent both open the same partition.json
/// file via separate PartitionStore instances. Without
/// file-level locking:
///
/// 1. Agent: `apply_roll(SwapToPending)` starts — reads in-
///    memory guard at state X.
/// 2. CLI (mid-agent-op): `apply_roll(Confirm)` starts —
///    reads FRESH disk state X via its own `open()`.
/// 3. Both processes validate against state X + compute
///    their own new_states.
/// 4. Both persist via atomic tempfile+rename. The later
///    rename wins; the earlier persist's state is silently
///    lost.
/// 5. The losing process thinks its transition succeeded;
///    its in-memory guard reflects a state the disk no
///    longer has.
///
/// This is a classic lost-update race with DATA-LOSS
/// consequences on a partition state machine — a lost
/// SwapToPending could leave a PendingConfirm with no
/// Standby to roll back to.
///
/// Batch 121 introduces LOCK_EX serialization via a
/// companion `.lock` file + refreshes the in-memory guard
/// from disk INSIDE the lock so cross-process state
/// changes ARE observed before validation.
///
/// ## Lock file vs state file
///
/// The lock is on a COMPANION `.lock` file (not the state
/// JSON itself) because the tempfile+rename persist path
/// destroys the locked inode each write. A stable
/// companion file keeps the lock semantics consistent
/// across persist cycles.
///
/// ## Why advisory (flock) not mandatory (fcntl-lock)
///
/// flock locks are advisory — any process that doesn't
/// call flock can bypass them. This is acceptable because
/// EVERY PartitionStore user in this codebase goes through
/// the same type, and flock is cheaper + simpler than
/// fcntl POSIX locks. External processes that directly
/// write partition.json are outside our threat model
/// (they'd be operator error, not attacker vector).
struct PartitionLockGuard {
    // nix::fcntl::Flock is the new typestate-safe API that
    // owns the File + releases the flock on drop. Wraps
    // the fd so the kernel-level flock is tied to the
    // guard's lifetime.
    _flock: Flock<std::fs::File>,
}

impl PartitionLockGuard {
    fn acquire(lock_path: &Path) -> Result<Self, PartitionStoreError> {
        // create(true) ensures the lock file exists on first
        // acquire; append(true) keeps it zero-size + avoids
        // accidentally truncating if someone wrote content.
        let file = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(lock_path)
            .map_err(|e| {
                PartitionStoreError::IoError(format!(
                    "lock file open {}: {}",
                    lock_path.display(),
                    e
                ))
            })?;

        let flock_guard = Flock::lock(file, FlockArg::LockExclusive).map_err(|(_, e)| {
            PartitionStoreError::IoError(format!("flock LOCK_EX on {}: {}", lock_path.display(), e))
        })?;

        Ok(Self {
            _flock: flock_guard,
        })
    }
}

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
    /// Batch 116 Sprint 6.5: `apply_roll_with_version_bump`
    /// received a `new_version` that is NOT strictly greater
    /// than the current `active_firmware_version`. Mirrors the
    /// Batch 8 verify Gate 5 `StaleFirmwareVersion` semantic
    /// but independent of the caller — closes any cross-caller
    /// race window where two concurrent apply calls could both
    /// observe the same pre-bump floor.
    StaleVersion { claimed: u64, highest_seen: u64 },
}

impl std::fmt::Display for PartitionStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::IoError(e) => write!(f, "partition store IO: {}", e),
            Self::ParseError(e) => write!(f, "partition store parse: {}", e),
            Self::InvalidTransition {
                from_a,
                from_b,
                roll,
            } => write!(
                f,
                "invalid partition transition: roll={} current: A={:?} B={:?}",
                roll, from_a, from_b
            ),
            Self::LockPoisoned => write!(f, "partition store mutex poisoned"),
            Self::StaleVersion {
                claimed,
                highest_seen,
            } => write!(
                f,
                "stale firmware version: claimed={} not > highest_seen={}",
                claimed, highest_seen
            ),
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
    /// Companion lock-file path for the Batch 121 cross-
    /// process flock. Derived from the state file path:
    /// `<path>.lock`. Kept separate from the state file so
    /// the tempfile+rename persist path doesn't destroy the
    /// lock inode on each write.
    fn lock_path(&self) -> PathBuf {
        let mut p = self.path.clone().into_os_string();
        p.push(".lock");
        PathBuf::from(p)
    }

    /// Re-read the state file from disk while holding the
    /// cross-process lock (Batch 121 Sprint 6.5). Called
    /// at the start of every apply_roll to ensure
    /// validation runs against FRESH disk state + not a
    /// stale in-memory cache.
    ///
    /// On file-not-found (first-boot race — another process
    /// hasn't persisted yet): returns the initial state.
    fn reread_disk_state(&self) -> Result<PartitionState, PartitionStoreError> {
        if !self.path.exists() {
            // First-boot path; either our own open() wrote
            // the initial state already or we're about to.
            return Ok(PartitionState::initial());
        }
        let bytes = std::fs::read(&self.path).map_err(|e| {
            PartitionStoreError::IoError(format!("reread {}: {}", self.path.display(), e))
        })?;
        serde_json::from_slice(&bytes).map_err(|e| {
            PartitionStoreError::ParseError(format!("reread parse {}: {}", self.path.display(), e))
        })
    }

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
                PartitionStoreError::IoError(format!("mkdir {}: {}", parent.display(), e))
            })?;
        }

        let state = if path_buf.exists() {
            let bytes = std::fs::read(&path_buf).map_err(|e| {
                PartitionStoreError::IoError(format!("read {}: {}", path_buf.display(), e))
            })?;
            serde_json::from_slice(&bytes).map_err(|e| {
                PartitionStoreError::ParseError(format!("parse {}: {}", path_buf.display(), e))
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
        let guard = self
            .state
            .lock()
            .map_err(|_| PartitionStoreError::LockPoisoned)?;
        Ok(guard.clone())
    }

    /// Apply a PartitionRoll transition.
    ///
    /// Batch 121 Sprint 6.5: cross-process serialization
    /// via flock(2) advisory lock on the companion
    /// `<path>.lock` file. The in-memory state is refreshed
    /// from disk under the lock BEFORE validation so
    /// cross-process state changes observed by the other
    /// writer are reflected here (closes the lost-update
    /// race documented on PartitionLockGuard).
    ///
    /// Steps:
    /// 1. Acquire flock LOCK_EX on the companion lock file.
    /// 2. Acquire in-process write guard.
    /// 3. Re-read state from disk under the lock; replace
    ///    guard contents with fresh disk state.
    /// 4. Validate preconditions for the roll variant.
    /// 5. Mutate in-memory state.
    /// 6. Persist to disk (tempfile + rename).
    /// 7. On persist failure: rollback in-memory mutation +
    ///    return Err.
    /// 8. Release flock (Drop).
    ///
    /// Returns the new state on success.
    pub fn apply_roll(
        &self,
        roll: PartitionRoll,
        cold_boot_budget_secs: u64,
    ) -> Result<PartitionState, PartitionStoreError> {
        let _file_lock = PartitionLockGuard::acquire(&self.lock_path())?;

        let mut guard = self
            .state
            .lock()
            .map_err(|_| PartitionStoreError::LockPoisoned)?;

        // Refresh in-memory state from disk while holding
        // the flock. Picks up any changes made by other
        // processes (e.g. CLI --confirm-active) since this
        // process's last apply.
        let fresh = self.reread_disk_state()?;
        *guard = fresh;
        let prev_state = guard.clone();

        self.apply_roll_to_state(&mut guard, roll, cold_boot_budget_secs)?;

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
                warn!(
                    "PartitionStore persist failed: {}. Rolling back in-memory state.",
                    e
                );
                *guard = prev_state;
                Err(e)
            }
        }
    }

    /// Apply a PartitionRoll transition + atomically bump
    /// `active_firmware_version` to `new_version` (Batch 116
    /// Sprint 6.5 Phase 2).
    ///
    /// ## WHY a separate method
    ///
    /// Not every PartitionRoll comes paired with a known new
    /// firmware version: `Confirm` + `Rollback` restore or
    /// advance state without a version input (the version
    /// was bumped at SwapToPending time). Making the version
    /// an Option on the shared `apply_roll` would invite
    /// inconsistent call sites ("caller forgot to pass the
    /// version, silently left floor at 0"). A distinct
    /// method keeps the monotonic-floor bump EXPLICIT at the
    /// site that owns the verified version (cmd_apply_signed_manifest).
    ///
    /// ## Atomicity
    ///
    /// State mutation + version bump + disk persist happen
    /// under ONE mutex acquisition + ONE persist. Snapshot
    /// consumers observe either the old OR new tuple, never
    /// a split (state updated but version stale, or vice
    /// versa).
    ///
    /// ## Monotonicity gate
    ///
    /// `new_version` MUST be strictly greater than
    /// `active_firmware_version` at the time of the call.
    /// Rejects otherwise with StaleVersion (same semantic as
    /// the Batch 8 verify Gate 5). Defense-in-depth — the
    /// orchestrator already checked via verify_firmware_manifest,
    /// but the store's invariant is independent of the
    /// caller + closes any cross-caller race window.
    pub fn apply_roll_with_version_bump(
        &self,
        roll: PartitionRoll,
        cold_boot_budget_secs: u64,
        new_version: u64,
    ) -> Result<PartitionState, PartitionStoreError> {
        let _file_lock = PartitionLockGuard::acquire(&self.lock_path())?;

        let mut guard = self
            .state
            .lock()
            .map_err(|_| PartitionStoreError::LockPoisoned)?;

        // Batch 121: refresh from disk under the flock so
        // the monotonic-version gate validates against the
        // FRESHEST floor — cross-process deploys that
        // already advanced the floor will be caught here.
        let fresh = self.reread_disk_state()?;
        *guard = fresh;

        if new_version <= guard.active_firmware_version {
            return Err(PartitionStoreError::StaleVersion {
                claimed: new_version,
                highest_seen: guard.active_firmware_version,
            });
        }

        let prev_state = guard.clone();

        self.apply_roll_to_state(&mut guard, roll, cold_boot_budget_secs)?;
        guard.active_firmware_version = new_version;

        match self.persist(&guard) {
            Ok(()) => {
                info!(
                    "PartitionStore applied {:?} + version_bump {}->{}: new_state={:?}",
                    roll_label(&roll),
                    prev_state.active_firmware_version,
                    new_version,
                    *guard
                );
                Ok(guard.clone())
            }
            Err(e) => {
                warn!(
                    "PartitionStore persist failed (version_bump): {}. Rolling back in-memory state + version.",
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
                guard.pending_confirm_deadline_unix_secs =
                    Some(now_secs.saturating_add(cold_boot_budget_secs as i64));
            }
            PartitionRoll::SwapToPending {
                old_active,
                new_pending,
            } => {
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
                guard.pending_confirm_deadline_unix_secs =
                    Some(now_secs.saturating_add(cold_boot_budget_secs as i64));
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
            PartitionRoll::Rollback {
                failed,
                restored_active,
            } => {
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
        let json = serde_json::to_vec_pretty(state)
            .map_err(|e| PartitionStoreError::ParseError(format!("serialize: {}", e)))?;

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
            std::io::Write::write_all(&mut file, &json)
                .map_err(|e| PartitionStoreError::IoError(format!("write tempfile: {}", e)))?;
            std::io::Write::flush(&mut file)
                .map_err(|e| PartitionStoreError::IoError(format!("flush tempfile: {}", e)))?;
            file.sync_all()
                .map_err(|e| PartitionStoreError::IoError(format!("fsync tempfile: {}", e)))?;
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
            .apply_roll(
                PartitionRoll::Confirm {
                    slot: AbPartition::A,
                },
                90,
            )
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
                PartitionRoll::InitialInstall {
                    target: AbPartition::A,
                },
                90,
            )
            .expect("install");
        store
            .apply_roll(
                PartitionRoll::Confirm {
                    slot: AbPartition::A,
                },
                90,
            )
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
                PartitionRoll::InitialInstall {
                    target: AbPartition::A,
                },
                90,
            )
            .expect("install");
        store
            .apply_roll(
                PartitionRoll::Confirm {
                    slot: AbPartition::A,
                },
                90,
            )
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
            .apply_roll(
                PartitionRoll::Confirm {
                    slot: AbPartition::A,
                },
                90,
            )
            .expect_err("must reject");
        assert!(matches!(err, PartitionStoreError::InvalidTransition { .. }));

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
        assert!(matches!(err, PartitionStoreError::InvalidTransition { .. }));
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
                PartitionRoll::InitialInstall {
                    target: AbPartition::A,
                },
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

    // ========================================================================
    // apply_roll_with_version_bump tests (Batch 116 Sprint 6.5)
    // ========================================================================

    #[test]
    fn version_bump_initial_install_persists_version() {
        let path = tmp_store_path();
        let _ = std::fs::remove_file(&path);
        let store = PartitionStore::open(Some(&path)).expect("open");
        let new_state = store
            .apply_roll_with_version_bump(
                PartitionRoll::InitialInstall {
                    target: AbPartition::A,
                },
                90,
                42,
            )
            .expect("install + bump");
        assert_eq!(new_state.active_firmware_version, 42);
        assert_eq!(new_state.active, AbPartition::A);
        assert_eq!(new_state.slot_a_state, SlotState::PendingConfirm);

        // Re-open the store to prove on-disk persistence.
        drop(store);
        let reopen = PartitionStore::open(Some(&path)).expect("reopen");
        let snap = reopen.snapshot().expect("snap");
        assert_eq!(snap.active_firmware_version, 42);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn version_bump_rejects_stale_version() {
        let path = tmp_store_path();
        let _ = std::fs::remove_file(&path);
        let store = PartitionStore::open(Some(&path)).expect("open");
        store
            .apply_roll_with_version_bump(
                PartitionRoll::InitialInstall {
                    target: AbPartition::A,
                },
                90,
                10,
            )
            .expect("install + bump");
        store
            .apply_roll(
                PartitionRoll::Confirm {
                    slot: AbPartition::A,
                },
                90,
            )
            .expect("confirm");

        // Re-attempt with an EQUAL version — must reject
        // (strict > floor, not >=).
        let err = store
            .apply_roll_with_version_bump(
                PartitionRoll::SwapToPending {
                    old_active: AbPartition::A,
                    new_pending: AbPartition::B,
                },
                90,
                10,
            )
            .expect_err("must reject equal version");
        assert!(matches!(
            err,
            PartitionStoreError::StaleVersion {
                claimed: 10,
                highest_seen: 10
            }
        ));

        // Re-attempt with a LOWER version — must reject.
        let err = store
            .apply_roll_with_version_bump(
                PartitionRoll::SwapToPending {
                    old_active: AbPartition::A,
                    new_pending: AbPartition::B,
                },
                90,
                5,
            )
            .expect_err("must reject lower version");
        assert!(matches!(
            err,
            PartitionStoreError::StaleVersion {
                claimed: 5,
                highest_seen: 10
            }
        ));

        // State is UNCHANGED by the rejected bumps —
        // snapshot still shows A Active, version 10, slot
        // B Empty.
        let snap = store.snapshot().expect("snap");
        assert_eq!(snap.active_firmware_version, 10);
        assert_eq!(snap.active, AbPartition::A);
        assert_eq!(snap.slot_b_state, SlotState::Empty);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn version_bump_swap_to_pending_advances_version_and_pending_deadline() {
        let path = tmp_store_path();
        let _ = std::fs::remove_file(&path);
        let store = PartitionStore::open(Some(&path)).expect("open");
        store
            .apply_roll_with_version_bump(
                PartitionRoll::InitialInstall {
                    target: AbPartition::A,
                },
                90,
                100,
            )
            .expect("install v100");
        store
            .apply_roll(
                PartitionRoll::Confirm {
                    slot: AbPartition::A,
                },
                90,
            )
            .expect("confirm v100");

        let before = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let new_state = store
            .apply_roll_with_version_bump(
                PartitionRoll::SwapToPending {
                    old_active: AbPartition::A,
                    new_pending: AbPartition::B,
                },
                90,
                101,
            )
            .expect("swap + bump");

        assert_eq!(new_state.active_firmware_version, 101);
        assert_eq!(new_state.active, AbPartition::B);
        assert_eq!(new_state.slot_a_state, SlotState::Standby);
        assert_eq!(new_state.slot_b_state, SlotState::PendingConfirm);
        let deadline = new_state
            .pending_confirm_deadline_unix_secs
            .expect("deadline set on swap");
        assert!(deadline >= before + 88 && deadline <= before + 92);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn version_bump_invalid_transition_does_not_advance_version() {
        let path = tmp_store_path();
        let _ = std::fs::remove_file(&path);
        let store = PartitionStore::open(Some(&path)).expect("open");
        // Attempt Confirm on Empty slot — invalid transition.
        // Even though version 7 > 0, the version must NOT
        // advance when the transition itself is rejected.
        let err = store
            .apply_roll_with_version_bump(
                PartitionRoll::Confirm {
                    slot: AbPartition::A,
                },
                90,
                7,
            )
            .expect_err("must reject");
        assert!(matches!(err, PartitionStoreError::InvalidTransition { .. }));
        let snap = store.snapshot().expect("snap");
        assert_eq!(snap.active_firmware_version, 0);
        let _ = std::fs::remove_file(&path);
    }

    // ========================================================================
    // Batch 121 Sprint 6.5 — cross-process flock + disk re-read tests
    // ========================================================================

    #[test]
    fn lock_path_is_derived_from_state_path() {
        let path = tmp_store_path();
        let _ = std::fs::remove_file(&path);
        let store = PartitionStore::open(Some(&path)).expect("open");
        let lock_p = store.lock_path();
        let state_p_str = path.to_string_lossy().to_string();
        let lock_p_str = lock_p.to_string_lossy().to_string();
        assert_eq!(lock_p_str, format!("{}.lock", state_p_str));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&lock_p);
    }

    #[test]
    fn apply_roll_creates_lock_file_on_first_acquire() {
        let path = tmp_store_path();
        let _ = std::fs::remove_file(&path);
        let store = PartitionStore::open(Some(&path)).expect("open");
        let lock_p = store.lock_path();
        // Pre-apply the lock file should NOT exist.
        assert!(!lock_p.exists());
        store
            .apply_roll(
                PartitionRoll::InitialInstall {
                    target: AbPartition::A,
                },
                90,
            )
            .expect("install");
        // Post-apply the lock file exists (zero-byte marker).
        assert!(lock_p.exists());
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&lock_p);
    }

    #[test]
    fn apply_roll_picks_up_disk_changes_made_by_other_process() {
        // Simulate the cross-process scenario:
        // 1. Process A opens the store + applies an install.
        // 2. A SECOND process opens the same path + applies
        //    a Confirm (mutating disk state).
        // 3. Process A re-uses its ORIGINAL handle + applies
        //    another transition — MUST observe the Confirm
        //    that the second process persisted, not the stale
        //    in-memory cache.
        let path = tmp_store_path();
        let _ = std::fs::remove_file(&path);
        let lock_p = {
            let p = path.clone().into_os_string();
            let mut s = p;
            s.push(".lock");
            std::path::PathBuf::from(s)
        };
        let _ = std::fs::remove_file(&lock_p);

        let store_a = PartitionStore::open(Some(&path)).expect("A open");
        store_a
            .apply_roll(
                PartitionRoll::InitialInstall {
                    target: AbPartition::A,
                },
                3600,
            )
            .expect("A install");

        // Second "process" uses a fresh PartitionStore
        // instance on the same file path — simulates
        // --confirm-active CLI opening the same file.
        let store_b = PartitionStore::open(Some(&path)).expect("B open");
        store_b
            .apply_roll(
                PartitionRoll::Confirm {
                    slot: AbPartition::A,
                },
                3600,
            )
            .expect("B confirm");

        // Drop B so the flock is released.
        drop(store_b);

        // A's next apply_roll MUST observe B's Confirm. If
        // A were using its stale in-memory cache, it would
        // see slot_a=PendingConfirm + fail a subsequent
        // SwapToPending (which requires slot_a=Active).
        // With the Batch 121 disk-reread, A sees
        // slot_a=Active + the swap succeeds.
        let swap_result = store_a.apply_roll(
            PartitionRoll::SwapToPending {
                old_active: AbPartition::A,
                new_pending: AbPartition::B,
            },
            3600,
        );
        assert!(
            swap_result.is_ok(),
            "expected SwapToPending to succeed after cross-process Confirm disk sync: {:?}",
            swap_result
        );
        let snap = store_a.snapshot().expect("snap");
        assert_eq!(snap.active, AbPartition::B);
        assert_eq!(snap.slot_a_state, SlotState::Standby);
        assert_eq!(snap.slot_b_state, SlotState::PendingConfirm);

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&lock_p);
    }

    #[test]
    fn version_bump_sees_cross_process_version_floor() {
        // Simulate: process A installs v10, process B bumps
        // the floor to v20 out-of-band, process A tries to
        // apply v15 — MUST reject because B's v20 is the
        // FRESH floor after disk re-read.
        let path = tmp_store_path();
        let _ = std::fs::remove_file(&path);
        let lock_p = {
            let p = path.clone().into_os_string();
            let mut s = p;
            s.push(".lock");
            std::path::PathBuf::from(s)
        };
        let _ = std::fs::remove_file(&lock_p);

        let store_a = PartitionStore::open(Some(&path)).expect("A open");
        store_a
            .apply_roll_with_version_bump(
                PartitionRoll::InitialInstall {
                    target: AbPartition::A,
                },
                3600,
                10,
            )
            .expect("A install v10");
        store_a
            .apply_roll(
                PartitionRoll::Confirm {
                    slot: AbPartition::A,
                },
                3600,
            )
            .expect("A confirm v10");

        let store_b = PartitionStore::open(Some(&path)).expect("B open");
        store_b
            .apply_roll_with_version_bump(
                PartitionRoll::SwapToPending {
                    old_active: AbPartition::A,
                    new_pending: AbPartition::B,
                },
                3600,
                20,
            )
            .expect("B swap v20");
        drop(store_b);

        // A's in-memory cache still thinks version=10. If
        // Batch 121 didn't re-read, A would accept v15 >
        // 10. With re-read, A observes v20 > 15 → reject.
        let err = store_a
            .apply_roll_with_version_bump(
                PartitionRoll::Confirm {
                    slot: AbPartition::B,
                },
                3600,
                15,
            )
            .expect_err("must reject — 15 not > 20");
        assert!(matches!(
            err,
            PartitionStoreError::StaleVersion {
                claimed: 15,
                highest_seen: 20
            }
        ));

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&lock_p);
    }
}
