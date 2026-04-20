//! # AbPartition + SlotState (ADR-019 §2)
//!
//! Two-slot firmware layout:
//!
//! ```text
//! boot/   — Raspberry Pi tryboot overlay (signed)
//! slot_a/ — firmware partition A (boot kernel + initramfs + rootfs)
//! slot_b/ — firmware partition B (standby during A active)
//! data/   — /var/lib/suderra (persistent; never overwritten)
//! ```
//!
//! At any moment, exactly ONE slot is `Active` and the other is `Standby`.
//! After an update+swap, the old Active becomes `Standby` AND the new
//! Active enters `PendingConfirm` state. `PendingConfirm` must transition
//! to `Active` within `cold_boot_budget_secs` (90s default), otherwise the
//! bootloader rolls back on next boot.

use serde::{Deserialize, Serialize};

/// Physical partition identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AbPartition {
    A,
    B,
}

impl AbPartition {
    /// The other partition (identity-inverse). `A::other() == B; B::other() == A`.
    pub const fn other(self) -> Self {
        match self {
            Self::A => Self::B,
            Self::B => Self::A,
        }
    }

    /// Stable wire tag byte for canonical bytes discriminator — `A = 0, B = 1`.
    pub const fn wire_tag(self) -> u8 {
        match self {
            Self::A => 0,
            Self::B => 1,
        }
    }
}

/// Lifecycle state of a slot. Tier-1 invariant: at any moment across both
/// slots, at most one is `Active` AND at most one is `PendingConfirm`.
/// The runtime transition function [`PartitionRoll`] enforces this.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SlotState {
    /// Boots into this partition on power-on. Confirmed good.
    Active,
    /// Holds the last-confirmed previous firmware. Bootloader rollback
    /// target if PendingConfirm fails to promote.
    Standby,
    /// Newly updated — next boot will go here. Must be confirmed within
    /// `cold_boot_budget_secs` by a successful agent boot + N-second
    /// health check, else next reboot rolls back.
    PendingConfirm,
    /// Partition is empty or corrupt — never boots. Initial state pre-
    /// first-update; also set by a failed download/verify.
    Empty,
}

impl SlotState {
    pub const fn wire_tag(self) -> u8 {
        match self {
            Self::Active => 0,
            Self::Standby => 1,
            Self::PendingConfirm => 2,
            Self::Empty => 3,
        }
    }
}

/// A transition in the partition state machine. Constructed by the update
/// flow; pattern-matched by the runtime to apply bootloader flags +
/// recorded in the audit log.
///
/// **Tier-1 make-it-impossible:** each transition variant encodes a valid
/// move; no "Active → Empty" arbitrary transition is representable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PartitionRoll {
    /// Promote an Empty slot to PendingConfirm — covers BOTH:
    /// - (i) Fresh install (pre-factory first-ever update, both slots start Empty).
    /// - (ii) Post-rollback recovery (one slot Active, the other Empty after
    ///       a prior Rollback set the failed slot to Empty).
    ///
    /// EDGE-LOW-002 closure: the Empty → PendingConfirm transition has one
    /// shape regardless of origin. Keeping a single variant avoids artificial
    /// semantic split ("Initial" vs "Resume") while the bootloader flag-set
    /// operation is identical. Audit event payload records the prior state
    /// at a higher layer for operator incident forensics.
    InitialInstall { target: AbPartition },

    /// Active-to-Standby swap on successful update verify. Active demoted
    /// to Standby; target promoted to PendingConfirm.
    ///
    /// Post-boot confirmation: when the new agent boots + passes N-second
    /// health check, `PendingConfirm` → `Active` and the other slot's
    /// Standby status is preserved for rollback window.
    SwapToPending {
        old_active: AbPartition,
        new_pending: AbPartition,
    },

    /// Confirm a PendingConfirm slot as Active. Called after post-boot
    /// health check passes. The old Active (now Standby) stays Standby
    /// for the rollback window.
    Confirm { slot: AbPartition },

    /// Rollback triggered — the PendingConfirm slot is marked Empty and
    /// the old Standby is promoted back to Active. Bootloader flag
    /// inversion applied on next boot.
    Rollback {
        failed: AbPartition,
        restored_active: AbPartition,
    },
}

impl PartitionRoll {
    pub const fn wire_tag(self) -> u8 {
        match self {
            Self::InitialInstall { .. } => 0,
            Self::SwapToPending { .. } => 1,
            Self::Confirm { .. } => 2,
            Self::Rollback { .. } => 3,
        }
    }
}

/// Cold-boot budget — PendingConfirm MUST transition to Active within this
/// window or bootloader rolls back. Default 90s (RPi4); RevPi override
/// 120s via runtime config. Plan §2 HC-11 and ADR-019 §6.
pub const DEFAULT_COLD_BOOT_BUDGET_SECS: u64 = 90;

#[cfg(test)]
mod tests {
    use super::*;

    /// WHY: A.other() == B and vice versa — sanity check for the identity.
    #[test]
    fn partition_other_is_identity_inverse() {
        assert_eq!(AbPartition::A.other(), AbPartition::B);
        assert_eq!(AbPartition::B.other(), AbPartition::A);
        assert_eq!(AbPartition::A.other().other(), AbPartition::A);
        assert_eq!(AbPartition::B.other().other(), AbPartition::B);
    }

    /// WHY: Partition wire_tag byte stability.
    #[test]
    fn partition_wire_tag_stable() {
        assert_eq!(AbPartition::A.wire_tag(), 0);
        assert_eq!(AbPartition::B.wire_tag(), 1);
    }

    /// WHY: SlotState wire_tag byte stability — audit log indexes on these.
    #[test]
    fn slot_state_wire_tag_stable() {
        assert_eq!(SlotState::Active.wire_tag(), 0);
        assert_eq!(SlotState::Standby.wire_tag(), 1);
        assert_eq!(SlotState::PendingConfirm.wire_tag(), 2);
        assert_eq!(SlotState::Empty.wire_tag(), 3);
    }

    /// WHY: PartitionRoll variants have stable discriminators.
    #[test]
    fn partition_roll_wire_tag_stable() {
        assert_eq!(
            PartitionRoll::InitialInstall { target: AbPartition::A }.wire_tag(),
            0
        );
        assert_eq!(
            PartitionRoll::SwapToPending {
                old_active: AbPartition::A,
                new_pending: AbPartition::B
            }
            .wire_tag(),
            1
        );
        assert_eq!(PartitionRoll::Confirm { slot: AbPartition::A }.wire_tag(), 2);
        assert_eq!(
            PartitionRoll::Rollback {
                failed: AbPartition::A,
                restored_active: AbPartition::B
            }
            .wire_tag(),
            3
        );
    }

    /// WHY: DEFAULT_COLD_BOOT_BUDGET_SECS = 90. Plan §2 HC-11 pin.
    #[test]
    fn cold_boot_budget_is_ninety_seconds() {
        assert_eq!(DEFAULT_COLD_BOOT_BUDGET_SECS, 90);
    }

    /// WHY: serde snake_case on all enums for wire stability.
    #[test]
    fn partition_serde_snake_case() {
        assert_eq!(serde_json::to_string(&AbPartition::A).expect("ok"), r#""a""#);
        assert_eq!(serde_json::to_string(&AbPartition::B).expect("ok"), r#""b""#);
    }

    #[test]
    fn slot_state_serde_snake_case() {
        assert_eq!(
            serde_json::to_string(&SlotState::Active).expect("ok"),
            r#""active""#
        );
        assert_eq!(
            serde_json::to_string(&SlotState::PendingConfirm).expect("ok"),
            r#""pending_confirm""#
        );
        assert_eq!(
            serde_json::to_string(&SlotState::Empty).expect("ok"),
            r#""empty""#
        );
    }

    #[test]
    fn partition_roll_serde_json_roundtrip() {
        let roll = PartitionRoll::SwapToPending {
            old_active: AbPartition::A,
            new_pending: AbPartition::B,
        };
        let json = serde_json::to_string(&roll).expect("ok");
        let back: PartitionRoll = serde_json::from_str(&json).expect("ok");
        assert_eq!(back, roll);
    }
}
