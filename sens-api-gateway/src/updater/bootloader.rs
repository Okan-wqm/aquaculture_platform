//! Bootloader coordination trait (Batch 111 Sprint 6.5).
//!
//! ## WHY
//!
//! Plan §2 HC-11 + ADR-019 §2 require that a
//! `PartitionRoll` transition reach BOTH layers:
//! 1. PartitionStore (software state — Batches 106-110).
//! 2. The BOOTLOADER's next-boot flag (hardware-layer
//!    state — THIS module).
//!
//! Without layer 2, a watchdog Rollback or a Confirm
//! updates the software state but the next boot still
//! follows the OLD bootloader flag. That's the dangerous
//! gap flagged in the Batch 108 commit body.
//!
//! This module provides the ABSTRACTION. Concrete impls:
//! - `NoopBootloaderHandle` — non-RPi deployments (x86
//!   dev machines, CI test hosts, non-Pi embedded
//!   hardware). Logs the requested operation + returns
//!   Ok; the real boot layer is the OS installer's
//!   responsibility.
//! - `TrybootBootloaderHandle` — RPi with tryboot support
//!   (CM4, CM5, Pi4 with recent bootloader). Reads/writes
//!   `/boot/firmware/autoboot.txt` (or legacy `/boot/
//!   tryboot.cfg`) to point the next boot at the target
//!   slot. Lands in a follow-up batch (requires RPi
//!   hardware for proper testing).
//!
//! ## Trait contract
//!
//! ```text
//!   set_next_boot_slot(slot)     — tell bootloader to boot
//!                                  <slot> on next reboot.
//!                                  Called from cmd_update_
//!                                  firmware after
//!                                  SwapToPending apply_roll.
//!   clear_pending_boot()         — cancel a pending tryboot
//!                                  flag. Called after
//!                                  successful Confirm so
//!                                  the bootloader stops
//!                                  treating the slot as
//!                                  "trial boot".
//!   rollback_next_boot(to_slot)  — emergency rollback path.
//!                                  Called by the watchdog
//!                                  (Batch 107) when the
//!                                  cold-boot deadline
//!                                  expires. Sets next boot
//!                                  to the Standby slot.
//!   active_slot_at_boot()        — query which slot the
//!                                  CURRENT boot came from.
//!                                  Used for post-boot self-
//!                                  confirm semantics.
//! ```
//!
//! All methods return Result so the TPM/sign-overlay
//! failure class (write to read-only /boot mount, signature
//! mismatch on tryboot.cfg) can surface to the caller
//! without panics.

use super::partition::AbPartition;

/// Unified error taxonomy for bootloader operations.
#[derive(Debug, Clone)]
pub enum BootloaderError {
    /// Underlying IO failure — e.g. /boot not mounted rw,
    /// permission denied on autoboot.txt write.
    IoError(String),
    /// Bootloader-specific rejection — e.g. tryboot signature
    /// mismatch, unsupported bootloader version.
    BootloaderRejected(String),
    /// Current-boot-slot probe failed (read of the active
    /// slot from runtime boot state).
    ActiveSlotProbeFailed(String),
    /// Operation not supported on this backend (e.g. calling
    /// RPi-specific rollback on a non-RPi Noop backend may
    /// be a no-op or error depending on deployment
    /// expectations).
    NotSupported(String),
}

impl std::fmt::Display for BootloaderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::IoError(e) => write!(f, "bootloader IO: {}", e),
            Self::BootloaderRejected(e) => write!(f, "bootloader rejected: {}", e),
            Self::ActiveSlotProbeFailed(e) => write!(f, "active-slot probe: {}", e),
            Self::NotSupported(e) => write!(f, "bootloader op not supported: {}", e),
        }
    }
}

impl std::error::Error for BootloaderError {}

/// Bootloader handle — the layer-2 side of partition-state
/// coordination.
///
/// Implementations MUST be thread-safe (`Send + Sync`) +
/// process-wide reusable (`'static`) because the
/// PartitionStore mutations that drive them run from
/// multiple call sites (watchdog task + command handler +
/// CLI --confirm-active).
pub trait BootloaderHandle: Send + Sync + 'static {
    /// Tell the bootloader to boot `slot` on next reboot.
    /// Called by `cmd_update_firmware` after a successful
    /// `apply_roll(SwapToPending)`.
    ///
    /// Contract: this is a SOFT tryboot flag — if the boot
    /// succeeds + the agent calls `clear_pending_boot`, the
    /// flag remains in place and `slot` becomes the new
    /// default active. If the boot fails / times out /
    /// explicitly rolls back, the bootloader REVERTS to the
    /// previous active slot on the subsequent reboot.
    fn set_next_boot_slot(&self, slot: AbPartition) -> Result<(), BootloaderError>;

    /// Commit the pending tryboot flag so `slot` becomes the
    /// new default active (no longer a "trial boot").
    /// Called after `apply_roll(Confirm)` succeeds.
    fn clear_pending_boot(&self, slot: AbPartition) -> Result<(), BootloaderError>;

    /// Emergency rollback path — set next boot to the
    /// Standby slot. Called by the cold-boot watchdog (Batch
    /// 107) when the PendingConfirm deadline expires.
    ///
    /// Distinct from `set_next_boot_slot` semantically: this
    /// is a REVERT to a known-good slot, not a forward trial
    /// boot. Backends may emit different audit / log events
    /// (e.g. TrybootHandle clears the tryboot flag entirely,
    /// forcing the bootloader's stable fallback path).
    fn rollback_next_boot(&self, to_slot: AbPartition) -> Result<(), BootloaderError>;

    /// Query which slot the currently-running boot came from.
    /// Used by post-boot self-confirm + boot-banner info.
    ///
    /// Returns None when the backend cannot determine
    /// (non-RPi Noop backend, legacy bootloader without
    /// runtime boot-source reporting).
    fn active_slot_at_boot(&self) -> Option<AbPartition>;

    /// Backend identifier string for audit + boot banner.
    /// Stable identifier — don't change between releases
    /// once published.
    fn backend_name(&self) -> &'static str;
}

/// No-op bootloader for non-RPi deployments (x86 dev, CI,
/// non-Pi embedded hardware). Logs every operation + returns
/// Ok; the real boot layer is the OS installer's
/// responsibility (usually not A/B partitioned at all).
///
/// Non-RPi devices that opt into A/B semantics can provide
/// their own `BootloaderHandle` impl (custom bootloader, EFI
/// boot-entry editing, etc.). The Noop handle is the SAFE
/// DEFAULT that keeps the PartitionStore state machine
/// functional even when the hardware doesn't enforce it —
/// the state-machine semantics still serve the "intent log"
/// purpose for post-incident forensics.
pub struct NoopBootloaderHandle;

impl BootloaderHandle for NoopBootloaderHandle {
    fn set_next_boot_slot(&self, slot: AbPartition) -> Result<(), BootloaderError> {
        tracing::info!(
            "NoopBootloader: set_next_boot_slot({:?}) — no bootloader flag written (non-RPi deployment; boot layer is OS installer's responsibility)",
            slot
        );
        Ok(())
    }

    fn clear_pending_boot(&self, slot: AbPartition) -> Result<(), BootloaderError> {
        tracing::info!("NoopBootloader: clear_pending_boot({:?}) — no-op", slot);
        Ok(())
    }

    fn rollback_next_boot(&self, to_slot: AbPartition) -> Result<(), BootloaderError> {
        // Rollback on Noop = operator manual intervention
        // required. We WARN-log (vs info) because this is
        // a failure-mode signal (watchdog fired) and the
        // operator needs to manually re-flash + reboot to
        // restore the device if the active partition is
        // broken. Returning Ok so the state-machine
        // Rollback transition still completes in
        // PartitionStore.
        tracing::warn!(
            "NoopBootloader: rollback_next_boot({:?}) requested but NOT applied to bootloader. \
             Operator must manually boot {:?} via alternate means (SSH recovery, SD card swap, etc.) \
             to restore the device. PartitionStore state has been updated to reflect the requested rollback.",
            to_slot,
            to_slot
        );
        Ok(())
    }

    fn active_slot_at_boot(&self) -> Option<AbPartition> {
        // Non-RPi: can't determine which A/B slot booted (no
        // tryboot flag). Return None so callers treat as
        // indeterminate.
        None
    }

    fn backend_name(&self) -> &'static str {
        "noop"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noop_set_next_boot_slot_ok() {
        let h = NoopBootloaderHandle;
        assert!(h.set_next_boot_slot(AbPartition::A).is_ok());
        assert!(h.set_next_boot_slot(AbPartition::B).is_ok());
    }

    #[test]
    fn noop_clear_pending_boot_ok() {
        let h = NoopBootloaderHandle;
        assert!(h.clear_pending_boot(AbPartition::A).is_ok());
    }

    #[test]
    fn noop_rollback_returns_ok_with_warn() {
        // Returns Ok so the partition-state transition
        // still completes; operator sees a WARN log.
        let h = NoopBootloaderHandle;
        assert!(h.rollback_next_boot(AbPartition::A).is_ok());
    }

    #[test]
    fn noop_active_slot_at_boot_is_none() {
        let h = NoopBootloaderHandle;
        assert!(h.active_slot_at_boot().is_none());
    }

    #[test]
    fn noop_backend_name_pinned() {
        let h = NoopBootloaderHandle;
        assert_eq!(h.backend_name(), "noop");
    }

    #[test]
    fn bootloader_error_display_shapes() {
        let cases = [
            (BootloaderError::IoError("x".into()), "bootloader IO: x"),
            (
                BootloaderError::BootloaderRejected("y".into()),
                "bootloader rejected: y",
            ),
            (
                BootloaderError::ActiveSlotProbeFailed("z".into()),
                "active-slot probe: z",
            ),
            (
                BootloaderError::NotSupported("w".into()),
                "bootloader op not supported: w",
            ),
        ];
        for (err, expected) in cases {
            assert_eq!(format!("{}", err), expected);
        }
    }
}
