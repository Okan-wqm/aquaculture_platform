// BATCH-001-CI-FIX-015: pre-staged types for Sprint 6.1-6.8 runtime wiring.
// Re-exports are intentionally unused until the runtime consumers land.
#![allow(unused_imports)]

//! # Updater — firmware A/B partition + signed manifest types (ADR-019)
//!
//! Every firmware update arriving on an edge device is wrapped in a
//! [`manifest::SignedFirmwareManifest`]. The update flow (Sprint 6.5):
//!
//! 1. **Download to standby partition** — the inactive slot of the A/B pair.
//! 2. **Verify** — [`verify::verify_firmware_manifest`] runs 8 fail-closed
//!    gates (tenant, monotonic version, signature, file digests, size, arch,
//!    expiry, validity window).
//! 3. **Swap** — set standby = active, active = standby-pending-confirm.
//! 4. **Cold-boot budget** — if the agent fails to mark the new slot
//!    "confirmed" within `cold_boot_budget_secs` (90s default, 120s for
//!    RevPi), bootloader rolls back on next boot.
//! 5. **Confirm** — after systemd Ready notify + N seconds of healthy
//!    operation, `confirm_slot` marks the partition good.
//!
//! ## Why A/B partition (not in-place patch)
//!
//! In-place patching of a running edge agent:
//! - Leaves partial state on power loss during flash.
//! - Requires an always-writable root fs (breaks dm-verity).
//! - Cannot atomically roll back after a deploy regression.
//!
//! A/B pairs with a bootloader flag give atomic update + rollback + readable-
//! only root partitions (plan §4 SL-3 dm-verity upgrade path compatible).
//!
//! ## Scope of Batch 8
//!
//! Types + pure function `verify_firmware_manifest` with closure-injected
//! ed25519 verify + closure-injected per-file SHA-256 recompute. No actual
//! disk I/O, no tryboot overlay write, no bootloader flag flip. Sprint 6.5
//! wires the real flow on top.
//!
//! ## Cross-references
//!
//! - ADR-019 §2 A/B partition model + tryboot bootloader overlay
//! - ADR-019 §3 firmware_signing_key HSM slot 1
//! - ADR-019 §4 Downgrade prevention via monotonic highest_seen_version
//! - ADR-019 §5 TOCTOU re-verify (hash-after-fsync-before-rename)
//! - ADR-019 §6 cold_boot_budget_secs default 90s, RevPi override 120s
//! - ADR-019 §7 Rescue firmware path
//! - Batch 5a `Ed25519SignatureBytes` validated newtype (reused here)
//! - Batch 5b `verify_manifest` closure-injection pattern (mirrored)

pub mod error;
pub mod manifest;
pub mod partition;
// Batch 106 Sprint 6.5 foundation: persistent partition-
// state store + PartitionRoll transition validator. The
// runtime state machine consumed by the Batch 109
// update orchestrator + Batch 108 cold-boot-budget
// watchdog.
pub mod partition_store;
pub mod verify;

pub use error::{FirmwareManifestCanonicalBytesError, ManifestVerifyError};
pub use manifest::{
    FileEntry, FileDigest, FirmwareManifest, SignedFirmwareManifest, Sha256Digest,
    TargetArch,
};
pub use partition::{AbPartition, PartitionRoll, SlotState};
pub use partition_store::{PartitionState, PartitionStore, PartitionStoreError};
pub use verify::verify_firmware_manifest;
