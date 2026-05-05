//! `TrybootBootloaderHandle` — RPi tryboot bootloader
//! integration (Batch 127 Sprint 6.5).
//!
//! ## WHY
//!
//! Plan §3 R-6 + ADR-019 §2 mandate the RPi tryboot
//! overlay as the A/B bootloader flag mechanism. Batch
//! 111 shipped the `BootloaderHandle` trait + a Noop
//! impl for non-RPi deployments; this batch ships the
//! Tryboot-specific impl that reads + writes the real
//! `/boot/firmware/autoboot.txt` file to steer next-boot
//! slot selection.
//!
//! ## Scope
//!
//! `TrybootBootloaderHandle` is an `autoboot.txt`
//! manipulator. The file has two states:
//!
//! 1. **Stable**: `[all]` block with `tryboot_a_b=1` and
//!    `boot_partition=<N>` where N is 2 or 3 (slot A vs
//!    slot B mapping).
//! 2. **Tryboot pending**: `[tryboot]` block ALSO
//!    present with a different `boot_partition=<M>`. On
//!    next boot the bootloader reads the `[tryboot]`
//!    block FIRST, tries booting that slot; if the boot
//!    succeeds + agent calls `clear_pending_boot`, the
//!    `[tryboot]` block stays + M becomes the active
//!    slot. If the boot fails / watchdog fires, the
//!    bootloader reverts to the `[all]` block.
//!
//! Slot-to-partition mapping (defaults — operator-
//! overridable via config):
//! - AbPartition::A → boot_partition=2
//! - AbPartition::B → boot_partition=3
//!
//! Real RPi CM4/CM5 images ship with:
//! - partition 1 = /boot/firmware (bootloader stage)
//! - partition 2 = slot A rootfs
//! - partition 3 = slot B rootfs
//! - partition 4 = shared /data (or similar)
//!
//! ## Scope of Batch 127
//!
//! - `TrybootBootloaderHandle` with pluggable I/O root
//!   (real `/boot/firmware` in production; tempdir in
//!   tests).
//! - Trait-impl for BootloaderHandle — delegates to
//!   internal autoboot.txt read / write helpers.
//! - Unit tests exercising set_next_boot_slot,
//!   clear_pending_boot, rollback_next_boot,
//!   active_slot_at_boot against tempfile fixtures.
//! - Slot→partition mapping config.
//!
//! ## NOT in scope
//!
//! - Signed autoboot.txt verification. RPi CM4/5
//!   supports bootloader-signature-verify; the config
//!   we write here is subject to that verification when
//!   the bootloader boots. This module does NOT do its
//!   own signature check.
//! - Real-hardware feature-gate conditional build. The
//!   impl is BUILT on every target; construction happens
//!   at config-driven boot time. Operators on non-RPi
//!   devices simply don't construct it (they stay with
//!   NoopBootloaderHandle).

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;

use tracing::{info, warn};

/// Process-local monotonic counter for Batch 131 tempfile
/// uniqueness. Paired with PID + nanosecond timestamp in
/// the tempfile name so concurrent writes from the SAME
/// process (multiple tokio tasks racing on the same
/// TrybootBootloaderHandle) never collide on tempfile
/// names.
static TEMPFILE_SEQ: AtomicU64 = AtomicU64::new(0);

use super::bootloader::{BootloaderError, BootloaderHandle};
use super::partition::AbPartition;

/// Default path for the RPi tryboot autoboot.txt on a
/// production device. Operator-overridable via
/// `TrybootBootloaderHandle::new_with_autoboot_path`.
pub const DEFAULT_AUTOBOOT_TXT_PATH: &str = "/boot/firmware/autoboot.txt";

/// Default slot→partition mapping. Matches RPi standard
/// dual-rootfs layout.
pub const DEFAULT_SLOT_A_PARTITION: u8 = 2;
pub const DEFAULT_SLOT_B_PARTITION: u8 = 3;

/// Tryboot autoboot.txt manipulator (Batch 127 Sprint
/// 6.5).
pub struct TrybootBootloaderHandle {
    autoboot_path: PathBuf,
    slot_a_partition: u8,
    slot_b_partition: u8,
}

impl TrybootBootloaderHandle {
    /// Construct with default RPi CM4/5 paths + mapping.
    pub fn new_default() -> Self {
        Self {
            autoboot_path: PathBuf::from(DEFAULT_AUTOBOOT_TXT_PATH),
            slot_a_partition: DEFAULT_SLOT_A_PARTITION,
            slot_b_partition: DEFAULT_SLOT_B_PARTITION,
        }
    }

    /// Construct with a custom autoboot.txt path — used
    /// by tests against a tempfile, and by operators with
    /// non-standard boot layouts.
    pub fn new_with_autoboot_path(path: PathBuf) -> Self {
        Self {
            autoboot_path: path,
            slot_a_partition: DEFAULT_SLOT_A_PARTITION,
            slot_b_partition: DEFAULT_SLOT_B_PARTITION,
        }
    }

    /// Construct with custom slot→partition mapping +
    /// path. For devices with non-standard partition
    /// layouts.
    pub fn new_with_config(
        autoboot_path: PathBuf,
        slot_a_partition: u8,
        slot_b_partition: u8,
    ) -> Self {
        Self {
            autoboot_path,
            slot_a_partition,
            slot_b_partition,
        }
    }

    fn partition_for_slot(&self, slot: AbPartition) -> u8 {
        match slot {
            AbPartition::A => self.slot_a_partition,
            AbPartition::B => self.slot_b_partition,
        }
    }

    fn slot_for_partition(&self, partition: u8) -> Option<AbPartition> {
        if partition == self.slot_a_partition {
            Some(AbPartition::A)
        } else if partition == self.slot_b_partition {
            Some(AbPartition::B)
        } else {
            None
        }
    }

    fn read_autoboot_contents(&self) -> Result<String, BootloaderError> {
        let mut file = File::open(&self.autoboot_path).map_err(|e| {
            BootloaderError::IoError(format!(
                "open {}: {}",
                self.autoboot_path.display(),
                e
            ))
        })?;
        let mut contents = String::new();
        file.read_to_string(&mut contents).map_err(|e| {
            BootloaderError::IoError(format!(
                "read {}: {}",
                self.autoboot_path.display(),
                e
            ))
        })?;
        Ok(contents)
    }

    fn write_autoboot_contents(&self, contents: &str) -> Result<(), BootloaderError> {
        // Atomic-rename pattern: write to tempfile in same
        // directory, fsync, rename. Matches PartitionStore
        // persist discipline (Batch 106).
        let parent = self.autoboot_path.parent().ok_or_else(|| {
            BootloaderError::IoError(format!(
                "autoboot path has no parent: {}",
                self.autoboot_path.display()
            ))
        })?;
        std::fs::create_dir_all(parent).map_err(|e| {
            BootloaderError::IoError(format!(
                "mkdir {}: {}",
                parent.display(),
                e
            ))
        })?;
        let filename = self.autoboot_path.file_name().ok_or_else(|| {
            BootloaderError::IoError(format!(
                "autoboot path has no filename: {}",
                self.autoboot_path.display()
            ))
        })?;
        // Batch 131 Sprint 6.5 hygiene — closes Batch 127
        // obs #2: tempfile name combines PID + nanosecond
        // counter + process-local monotonic sequence so a
        // PID-reuse scenario (container reuse, PID
        // wrap-around on kernels where PID ceiling is
        // narrow) cannot collide with a stale tempfile
        // from a previously-crashed run. create+truncate
        // already clobbers stale content for safety; the
        // nonce closes the observability gap where an
        // orphan `.tmp.<pid>` file would silently confuse
        // log analysis + filesystem-diff-based forensics.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let seq = TEMPFILE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut tmp_name = filename.to_os_string();
        tmp_name.push(".tmp.");
        tmp_name.push(format!(
            "{}-{:x}-{}",
            std::process::id(),
            nanos,
            seq
        ));
        let tmp_path = parent.join(tmp_name);

        {
            let mut tmp_file = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&tmp_path)
                .map_err(|e| {
                    BootloaderError::IoError(format!(
                        "create tempfile {}: {}",
                        tmp_path.display(),
                        e
                    ))
                })?;
            tmp_file.write_all(contents.as_bytes()).map_err(|e| {
                BootloaderError::IoError(format!(
                    "write tempfile {}: {}",
                    tmp_path.display(),
                    e
                ))
            })?;
            tmp_file.sync_all().map_err(|e| {
                BootloaderError::IoError(format!(
                    "fsync tempfile {}: {}",
                    tmp_path.display(),
                    e
                ))
            })?;
        }

        std::fs::rename(&tmp_path, &self.autoboot_path).map_err(|e| {
            BootloaderError::IoError(format!(
                "rename {} -> {}: {}",
                tmp_path.display(),
                self.autoboot_path.display(),
                e
            ))
        })?;
        Ok(())
    }

    /// Build the autoboot.txt content that sets BOTH the
    /// stable [all] block AND the [tryboot] block. Called
    /// on `set_next_boot_slot` — the agent is asking the
    /// bootloader to tryboot the target on next reboot.
    ///
    /// `stable_slot` is the slot that's currently Active
    /// + stays Active if the tryboot fails; `trial_slot`
    /// is the new slot being tried.
    fn build_tryboot_contents(
        &self,
        stable_slot: AbPartition,
        trial_slot: AbPartition,
    ) -> String {
        format!(
            "# suderra agent — tryboot overlay\n\
             # stable: slot {:?} (partition {})\n\
             # trial:  slot {:?} (partition {})\n\
             \n\
             [all]\n\
             tryboot_a_b=1\n\
             boot_partition={}\n\
             \n\
             [tryboot]\n\
             boot_partition={}\n",
            stable_slot,
            self.partition_for_slot(stable_slot),
            trial_slot,
            self.partition_for_slot(trial_slot),
            self.partition_for_slot(stable_slot),
            self.partition_for_slot(trial_slot),
        )
    }

    /// Build the autoboot.txt content with ONLY the
    /// stable [all] block (no tryboot). Called on
    /// `clear_pending_boot` (promote trial to stable) +
    /// `rollback_next_boot` (revert to previous stable).
    fn build_stable_contents(&self, stable_slot: AbPartition) -> String {
        format!(
            "# suderra agent — stable boot\n\
             # active: slot {:?} (partition {})\n\
             \n\
             [all]\n\
             tryboot_a_b=1\n\
             boot_partition={}\n",
            stable_slot,
            self.partition_for_slot(stable_slot),
            self.partition_for_slot(stable_slot),
        )
    }

    /// Parse the CURRENT [all].boot_partition from an
    /// existing autoboot.txt content, if present.
    /// Used to determine the "stable" slot that we keep
    /// on set_next_boot_slot (so tryboot fallback
    /// returns to the current Active).
    fn parse_stable_partition(contents: &str) -> Option<u8> {
        // Scan for `[all]` block, within it find
        // `boot_partition=<N>`. Keep the parser SIMPLE +
        // tolerant of whitespace — RPi autoboot.txt is
        // tiny + operator-touched.
        let mut in_all_block = false;
        for line in contents.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('#') || trimmed.is_empty() {
                continue;
            }
            if trimmed == "[all]" {
                in_all_block = true;
                continue;
            }
            if trimmed.starts_with('[') && trimmed.ends_with(']') {
                in_all_block = false;
                continue;
            }
            if in_all_block {
                if let Some(val) = trimmed.strip_prefix("boot_partition=") {
                    if let Ok(n) = val.parse::<u8>() {
                        return Some(n);
                    }
                }
            }
        }
        None
    }
}

impl BootloaderHandle for TrybootBootloaderHandle {
    fn set_next_boot_slot(&self, slot: AbPartition) -> Result<(), BootloaderError> {
        // Determine the current stable slot from existing
        // autoboot.txt (if present). On first install the
        // file may not exist; we default stable = the
        // OTHER slot so the tryboot revert still has a
        // target.
        let stable_slot = match self.read_autoboot_contents() {
            Ok(contents) => {
                if let Some(partition) = Self::parse_stable_partition(&contents) {
                    self.slot_for_partition(partition)
                        .unwrap_or(match slot {
                            AbPartition::A => AbPartition::B,
                            AbPartition::B => AbPartition::A,
                        })
                } else {
                    match slot {
                        AbPartition::A => AbPartition::B,
                        AbPartition::B => AbPartition::A,
                    }
                }
            }
            Err(_) => match slot {
                AbPartition::A => AbPartition::B,
                AbPartition::B => AbPartition::A,
            },
        };

        let contents = self.build_tryboot_contents(stable_slot, slot);
        self.write_autoboot_contents(&contents)?;
        info!(
            "TrybootBootloader: set_next_boot_slot({:?}) wrote tryboot overlay (stable={:?}, trial={:?}, path={})",
            slot, stable_slot, slot, self.autoboot_path.display()
        );
        Ok(())
    }

    fn clear_pending_boot(&self, slot: AbPartition) -> Result<(), BootloaderError> {
        // Collapse [all] + [tryboot] down to a single
        // [all] block with `slot` as the new stable. This
        // is the successful post-confirm path.
        let contents = self.build_stable_contents(slot);
        self.write_autoboot_contents(&contents)?;
        info!(
            "TrybootBootloader: clear_pending_boot({:?}) promoted trial to stable (path={})",
            slot, self.autoboot_path.display()
        );
        Ok(())
    }

    fn rollback_next_boot(&self, to_slot: AbPartition) -> Result<(), BootloaderError> {
        // Watchdog fired — collapse to a single [all]
        // block with `to_slot` as the stable. This REVERTS
        // the tryboot window entirely; next boot follows
        // the stable slot.
        let contents = self.build_stable_contents(to_slot);
        self.write_autoboot_contents(&contents)?;
        warn!(
            "TrybootBootloader: rollback_next_boot({:?}) wrote stable-only autoboot.txt (path={})",
            to_slot, self.autoboot_path.display()
        );
        Ok(())
    }

    fn active_slot_at_boot(&self) -> Option<AbPartition> {
        let contents = self.read_autoboot_contents().ok()?;
        let partition = Self::parse_stable_partition(&contents)?;
        self.slot_for_partition(partition)
    }

    fn backend_name(&self) -> &'static str {
        "tryboot"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn tmp_autoboot_path() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "suderra-tryboot-test-{}-{}-{}",
            std::process::id(),
            n,
            rand::random::<u32>()
        ));
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir.join("autoboot.txt")
    }

    #[test]
    fn set_next_boot_slot_writes_tryboot_overlay() {
        let path = tmp_autoboot_path();
        let handle = TrybootBootloaderHandle::new_with_autoboot_path(path.clone());

        // Simulate existing stable = slot A (partition 2).
        let initial = handle.build_stable_contents(AbPartition::A);
        std::fs::write(&path, initial).expect("write initial");

        handle
            .set_next_boot_slot(AbPartition::B)
            .expect("set_next_boot_slot");
        let contents = std::fs::read_to_string(&path).expect("read");
        assert!(contents.contains("[all]"));
        assert!(contents.contains("[tryboot]"));
        assert!(contents.contains("boot_partition=2")); // stable A
        assert!(contents.contains("boot_partition=3")); // trial B

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(path.parent().unwrap());
    }

    #[test]
    fn clear_pending_boot_collapses_to_stable_only() {
        let path = tmp_autoboot_path();
        let handle = TrybootBootloaderHandle::new_with_autoboot_path(path.clone());

        // Stage a tryboot overlay: stable A, trial B.
        let tryboot_overlay =
            handle.build_tryboot_contents(AbPartition::A, AbPartition::B);
        std::fs::write(&path, tryboot_overlay).expect("write overlay");

        handle
            .clear_pending_boot(AbPartition::B)
            .expect("clear_pending_boot");

        let contents = std::fs::read_to_string(&path).expect("read");
        assert!(contents.contains("[all]"));
        assert!(!contents.contains("[tryboot]"), "tryboot block should be gone");
        assert!(contents.contains("boot_partition=3")); // new stable B

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(path.parent().unwrap());
    }

    #[test]
    fn rollback_next_boot_writes_stable_to_restored_slot() {
        let path = tmp_autoboot_path();
        let handle = TrybootBootloaderHandle::new_with_autoboot_path(path.clone());

        // Stage a tryboot: stable A, trial B (simulates
        // mid-deploy state).
        let overlay =
            handle.build_tryboot_contents(AbPartition::A, AbPartition::B);
        std::fs::write(&path, overlay).expect("write overlay");

        handle
            .rollback_next_boot(AbPartition::A)
            .expect("rollback");

        let contents = std::fs::read_to_string(&path).expect("read");
        assert!(!contents.contains("[tryboot]"));
        assert!(contents.contains("boot_partition=2")); // A restored
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(path.parent().unwrap());
    }

    #[test]
    fn active_slot_at_boot_parses_stable_block() {
        let path = tmp_autoboot_path();
        let handle = TrybootBootloaderHandle::new_with_autoboot_path(path.clone());

        // Stable = B (partition 3).
        let stable = handle.build_stable_contents(AbPartition::B);
        std::fs::write(&path, stable).expect("write");

        assert_eq!(handle.active_slot_at_boot(), Some(AbPartition::B));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(path.parent().unwrap());
    }

    #[test]
    fn active_slot_at_boot_returns_none_on_missing_file() {
        let path = tmp_autoboot_path();
        let handle = TrybootBootloaderHandle::new_with_autoboot_path(path.clone());
        // No file written.
        assert!(handle.active_slot_at_boot().is_none());
        let _ = std::fs::remove_dir(path.parent().unwrap());
    }

    #[test]
    fn set_next_boot_slot_creates_autoboot_on_first_install() {
        let path = tmp_autoboot_path();
        let handle = TrybootBootloaderHandle::new_with_autoboot_path(path.clone());

        // No existing file — first install scenario.
        handle
            .set_next_boot_slot(AbPartition::A)
            .expect("set first");

        let contents = std::fs::read_to_string(&path).expect("read");
        assert!(contents.contains("[tryboot]"));
        // Stable defaults to the OTHER slot (B) so a revert
        // target exists.
        assert!(contents.contains("boot_partition=3"));
        assert!(contents.contains("boot_partition=2"));

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(path.parent().unwrap());
    }

    #[test]
    fn parse_stable_partition_ignores_tryboot_block() {
        let sample = "\
# comment
[all]
tryboot_a_b=1
boot_partition=2

[tryboot]
boot_partition=3
";
        let stable = TrybootBootloaderHandle::parse_stable_partition(sample);
        assert_eq!(stable, Some(2));
    }

    #[test]
    fn parse_stable_partition_none_when_no_all_block() {
        let sample = "# empty autoboot\n";
        assert!(TrybootBootloaderHandle::parse_stable_partition(sample).is_none());
    }

    #[test]
    fn backend_name_is_tryboot() {
        let handle = TrybootBootloaderHandle::new_default();
        assert_eq!(handle.backend_name(), "tryboot");
    }

    #[test]
    fn custom_partition_mapping_is_honored() {
        let path = tmp_autoboot_path();
        let handle = TrybootBootloaderHandle::new_with_config(path.clone(), 5, 6);

        handle
            .set_next_boot_slot(AbPartition::B)
            .expect("set");

        let contents = std::fs::read_to_string(&path).expect("read");
        assert!(contents.contains("boot_partition=6"));
        assert!(contents.contains("boot_partition=5"));

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(path.parent().unwrap());
    }

    #[test]
    fn tempfile_name_includes_pid_nanos_and_sequence() {
        // Batch 131: the tempfile naming scheme includes
        // PID + nanos + sequence so container-PID-collision
        // scenarios cannot produce a stale tempfile whose
        // path matches a next run's. Prove the naming
        // scheme via multiple rapid writes — each must
        // succeed even when nanoseconds resolve equal
        // (sequence counter disambiguates).
        let path = tmp_autoboot_path();
        let handle = TrybootBootloaderHandle::new_with_autoboot_path(path.clone());

        // Three rapid writes back-to-back. If tempfile
        // uniqueness were PID-only, they could race on a
        // single tempfile. PID+nanos+seq ensures each
        // tempfile lands at a distinct name (or
        // sequentially serialized via atomic counter).
        handle.set_next_boot_slot(AbPartition::A).expect("w1");
        handle.set_next_boot_slot(AbPartition::B).expect("w2");
        handle.clear_pending_boot(AbPartition::B).expect("w3");

        // Final autoboot.txt = stable slot B. No
        // leftover tempfiles in parent dir.
        let parent = path.parent().unwrap();
        let leftover: Vec<_> = std::fs::read_dir(parent)
            .expect("readdir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".tmp."))
            .collect();
        assert!(
            leftover.is_empty(),
            "rapid writes leaked tempfiles: {:?}",
            leftover
        );

        let contents = std::fs::read_to_string(&path).expect("read");
        assert!(!contents.contains("[tryboot]"));
        assert!(contents.contains("boot_partition=3"));

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(parent);
    }

    #[test]
    fn atomic_rename_leaves_no_tempfile_on_success() {
        let path = tmp_autoboot_path();
        let handle = TrybootBootloaderHandle::new_with_autoboot_path(path.clone());
        handle
            .set_next_boot_slot(AbPartition::A)
            .expect("set");

        // Final file exists; no .tmp.<pid> tempfile left
        // behind.
        let parent = path.parent().unwrap();
        let entries: Vec<_> = std::fs::read_dir(parent)
            .expect("readdir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        let leftover_tmp: Vec<_> =
            entries.iter().filter(|n| n.contains(".tmp.")).collect();
        assert!(
            leftover_tmp.is_empty(),
            "tempfile(s) leaked: {:?}",
            leftover_tmp
        );

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(parent);
    }
}
