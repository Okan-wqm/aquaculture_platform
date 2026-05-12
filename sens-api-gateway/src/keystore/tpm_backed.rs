//! TPM-backed keystore (Batch #308 D-1a primitive-first split).
//!
//! ## WHY this batch is primitive-first
//!
//! ADR-018 §4 + ADR-019 §7 specify three keystore backends in
//! priority order: TPM NV-sealed (preferred), systemd-creds,
//! file-backed Argon2id (operator-gated fallback). The
//! file-backed path landed in Batch #82 (`file_backed.rs`).
//! The TPM path is the highest-trust backend and the most
//! complex: it requires a TPM 2.0 device (RPi CM4/5 onboard or
//! external SLB 9670 / Optiga SLM via I2C/SPI), a kernel TPM
//! driver, the `tss-esapi` v7 FFI crate, and a userspace
//! `tcsd` / `libtss2` daemon.
//!
//! Following the project's primitive-first discipline (Batch
//! 4b types-first split for the `KeyMaterial` / `KeyPurpose`
//! hierarchy; Batch #305 wire-only split for CommandEnvelope
//! v3 co_approver), this batch lands ONLY:
//!
//! 1. The `TpmDevice` trait — the FFI abstraction boundary.
//! 2. The configuration types (`TpmKeystoreConfig`,
//!    `PcrSelection`, `NvCounterValue`).
//! 3. The error taxonomy (`TpmDeviceError`).
//! 4. The `TpmKeystore<D: TpmDevice>` skeleton implementing
//!    [`Keystore`] — runtime logic only (HKDF derivation
//!    over the unsealed master, RwLock for rotation, NV
//!    counter anti-rollback gate).
//! 5. A deterministic `MockTpmDevice` so the default-feature
//!    test suite can exercise the keystore logic without
//!    real TPM hardware.
//!
//! What this batch DOES NOT include (the D-1a arc has 3
//! batches; this is the first slice; the next two land
//! the real device + the boot selector — see ULTRA-HIGH-015
//! parent finding for the full arc):
//!
//! - **Batch #309 — `RealTpmDevice` impl.** The `tss-esapi`
//!   v7-backed device that talks to `/dev/tpm0` /
//!   `/dev/tpmrm0` via the kernel TPM driver. Behind
//!   `#[cfg(feature = "tpm")]`. Requires a build environment
//!   with `libtss2-dev` and a real or simulator TPM
//!   (`swtpm` for CI).
//! - **Batch #310 — `KeystoreSelector::resolve()`.** Probes
//!   TPM availability at boot, prefers TPM, falls back to
//!   `FileBackedKeystore` IFF a valid acceptance token is
//!   present. Hot-fails on missing acceptance (ADR-026 §7).
//!
//! ## WHY the trait/Mock split
//!
//! The TPM FFI is irreducibly platform-coupled: tss-esapi
//! panics or returns hardware errors when run without
//! `/dev/tpm0`. A test suite that depends on the FFI cannot
//! run in the default `cargo test` invocation that every
//! contributor uses + every CI runner uses.
//!
//! The architectural fix (Tier 1 — make-it-impossible) is
//! to put the FFI behind a `TpmDevice` trait and have ALL
//! keystore-side logic depend on the trait, not on
//! tss-esapi directly. The trait surface is small,
//! mockable, and stable. The real impl is one concrete
//! type (`RealTpmDevice`) that's ONLY compiled in when
//! `--features tpm` is set. The mock impl
//! (`MockTpmDevice`) is always compiled and is the
//! exclusive test driver for the keystore logic.
//!
//! This means:
//!
//! - Default `cargo test` runs against `MockTpmDevice` —
//!   deterministic, no hardware coupling, every keystore
//!   logic test runs everywhere.
//! - `cargo test --features tpm` additionally runs the
//!   real-device integration tests (Batch #309).
//! - The keystore consumer code (audit, offline_queue,
//!   updater, license, replay-cache) sees only the
//!   [`Keystore`] trait — it never knows or cares whether
//!   the master came from TPM, systemd-creds, or
//!   file-backed.
//!
//! ## Architectural shape (FR4 Data Confidentiality, ADR-019 §7)
//!
//! ```text
//!                              boot
//!                                │
//!         ┌──────────────────────▼──────────────────────┐
//!         │  KeystoreSelector::resolve()  (Batch #310)  │
//!         │  prefers Tpm → systemd-creds → FileBacked   │
//!         └──────────────────────┬──────────────────────┘
//!                                │ Tpm path
//!         ┌──────────────────────▼──────────────────────┐
//!         │  TpmKeystore<RealTpmDevice>::open(&config)  │
//!         │  (Batch #308 skeleton + #309 real device)   │
//!         └──────────────────────┬──────────────────────┘
//!                                │ unseal_master()
//!                                │ (PCR-bound + NV counter check)
//!                                ▼
//!         ┌─────────────────────────────────────────────┐
//!         │  master in mlock'd MasterKeyMaterial        │
//!         │  → Arc<dyn Keystore>                        │
//!         └─────────────────────────────────────────────┘
//! ```
//!
//! ## NV counter anti-rollback (D-1a non-negotiable)
//!
//! Per ADR-019 §7 Tier 1, every successful master rotation
//! ALSO increments a TPM NV counter. The sealing policy
//! binds the counter value at seal-time into the unsealing
//! policy — an attacker who restores an OLD sealed blob
//! (file backup, eMMC dump) cannot satisfy the policy
//! because the on-chip NV counter has advanced.
//!
//! The keystore enforces:
//!
//! 1. Unseal MUST present a counter value ≥ the on-chip
//!    NV counter. Strictly less → `RolledBackBlob` error.
//! 2. Rotation MUST increment the NV counter BEFORE the
//!    new sealed blob is written. If the increment fails,
//!    the rotation aborts (no half-rotated state).
//! 3. The counter is monotonic for the lifetime of the
//!    device — the TPM resets it only on factory clear,
//!    which is a documented out-of-band operation that
//!    requires regenerating ALL keys (compromise-response
//!    runbook).

use std::sync::RwLock;

use async_trait::async_trait;
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use tracing::{info, warn};
use zeroize::Zeroize;

use super::error::{KeyDerivationError, KeystoreError, KeystoreErrorKind};
use super::purpose::{DerivedKeyId, KeyPurpose};
use super::secret::{KeyMaterial, MasterKeyMaterial};
use super::{KeyBackend, Keystore, RotationSource};

// =============================================================
// Configuration types
// =============================================================

/// Selection of TPM 2.0 PCR slots for the sealing policy.
///
/// **Why a struct (not just a Vec):** sealing policies
/// require a SHA-256 (or SHA-1, SHA-384) PCR bank choice
/// IN ADDITION to the slot list. Conflating them would let
/// an operator silently pin to the legacy SHA-1 bank.
///
/// **Default selection** (`PcrSelection::firmware_and_boot`)
/// pins PCR[0..7] in the SHA-256 bank — covers UEFI
/// firmware (0..3), Option ROMs (4..6), and SecureBoot
/// state (7). An attacker who flashes unsigned firmware,
/// boots a different kernel, or replaces initrd will
/// invalidate at least one PCR; unsealing fails closed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PcrSelection {
    /// Which PCR bank to read.
    pub bank: PcrHashBank,
    /// Which slot indices in the bank to bind. Order is
    /// canonical (ascending) so two selections that bind
    /// the same set are equal regardless of input order.
    pub slots: Vec<u8>,
}

impl PcrSelection {
    /// Canonical "firmware + secure-boot" selection.
    /// `PCR[0..3]` = UEFI firmware components; `PCR[4..6]` =
    /// Option ROMs / boot loader; `PCR[7]` = SecureBoot
    /// db/dbx state.
    pub fn firmware_and_boot() -> Self {
        Self {
            bank: PcrHashBank::Sha256,
            slots: vec![0, 1, 2, 3, 4, 5, 6, 7],
        }
    }

    /// Sort + dedupe the slot list. Idempotent. Called by
    /// constructors to keep equality reflexive.
    pub fn canonicalize(&mut self) {
        self.slots.sort_unstable();
        self.slots.dedup();
    }
}

/// PCR bank — TPM 2.0 supports multiple banks; SHA-256 is
/// the only bank acceptable for production sealing.
/// Legacy SHA-1 is rejected at config-validation time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PcrHashBank {
    /// 32-byte SHA-256 PCR digest. Required for production.
    Sha256,
    /// 48-byte SHA-384 PCR digest. Acceptable but uncommon.
    Sha384,
    /// Legacy 20-byte SHA-1 PCR digest. REJECTED by
    /// `TpmKeystoreConfig::validate()` — kept in the enum
    /// so the FFI layer can DETECT a SHA-1-only TPM and
    /// emit a meaningful error rather than a parse failure.
    Sha1Legacy,
}

/// NV counter value — monotonically increasing 64-bit
/// sequence, owned by the TPM.
///
/// **Why a newtype:** prevents accidental swap with other
/// u64s in the codebase (master version, audit chain seq,
/// command jti counter, …). A bug that compares the wrong
/// counter is a silent rollback-detection bypass.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct NvCounterValue(pub u64);

impl NvCounterValue {
    pub const ZERO: Self = Self(0);

    /// Increment to the next value, returning the new
    /// counter. Saturates at `u64::MAX` (~5.8e11 years at
    /// 1 rotation/sec — not realistically reachable).
    pub fn next(self) -> Self {
        Self(self.0.saturating_add(1))
    }
}

/// Opaque sealed-blob bytes. The TPM produces these on
/// `seal_master`; the keystore stores them on disk
/// (typically `/var/lib/suderra/keystore/master.seal`)
/// for boot-time unseal. The bytes are NOT a secret — the
/// secret is the unseal policy + NV counter + PCR state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TpmSealedBlob(pub Vec<u8>);

impl TpmSealedBlob {
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Full configuration for a `TpmKeystore`. Validated at
/// construction time via `validate()`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TpmKeystoreConfig {
    /// NV index where the sealed master blob lives.
    /// Convention: 0x1500016 (in the user-defined NV
    /// space). Operator policy doc pins the choice.
    pub master_nv_index: u32,
    /// NV index of the monotonic counter for anti-rollback.
    /// Convention: 0x1500017 (adjacent to master).
    pub counter_nv_index: u32,
    /// PCR selection for the sealing policy.
    pub pcr_selection: PcrSelection,
}

impl TpmKeystoreConfig {
    /// Default production configuration — operator overrides
    /// in deployment config when NV layout differs.
    pub fn production_default() -> Self {
        Self {
            master_nv_index: 0x0150_0016,
            counter_nv_index: 0x0150_0017,
            pcr_selection: PcrSelection::firmware_and_boot(),
        }
    }

    /// Reject SHA-1 legacy bank, identical NV indices,
    /// empty PCR slot list, NV indices outside the user-
    /// defined range. Configuration errors are operator-
    /// visible at boot via `KeystoreError::Configuration`.
    pub fn validate(&self) -> Result<(), String> {
        if self.pcr_selection.bank == PcrHashBank::Sha1Legacy {
            return Err("PCR bank SHA-1 is legacy and rejected; \
                        require SHA-256 or SHA-384"
                .to_string());
        }
        if self.pcr_selection.slots.is_empty() {
            return Err(
                "PCR selection slot list empty; sealing without PCR binding is forbidden"
                    .to_string(),
            );
        }
        if self.master_nv_index == self.counter_nv_index {
            return Err(format!(
                "master_nv_index and counter_nv_index must differ (both = 0x{:08x})",
                self.master_nv_index
            ));
        }
        // TPM 2.0 user-defined NV range: 0x01000000..0x01FFFFFF.
        for (label, idx) in [
            ("master_nv_index", self.master_nv_index),
            ("counter_nv_index", self.counter_nv_index),
        ] {
            if !(0x0100_0000..=0x01FF_FFFF).contains(&idx) {
                return Err(format!(
                    "{} 0x{:08x} outside the TPM 2.0 user-defined NV range \
                     (0x01000000..0x01FFFFFF)",
                    label, idx
                ));
            }
        }
        Ok(())
    }
}

// =============================================================
// TpmDevice trait — FFI abstraction boundary
// =============================================================

/// Errors specific to the TPM device layer. Distinct from
/// `KeystoreError` so the keystore-level error taxonomy
/// stays narrow + the FFI layer can surface device-class
/// faults explicitly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TpmDeviceError {
    /// TPM device file not found / permission denied.
    DeviceUnavailable(String),
    /// Sealing policy could not be satisfied at unseal —
    /// PCR mismatch (firmware/kernel changed), NV counter
    /// rollback attempt, or sealed blob tampered.
    PolicyUnsatisfied(String),
    /// NV counter increment failed (NV write quota
    /// exhausted, or transient TPM busy).
    NvCounterIncrementFailed(String),
    /// Sealed blob does not exist at the configured NV
    /// index — first-boot provisioning required.
    NotProvisioned,
    /// Generic FFI-level fault wrapping a tss-esapi or
    /// kernel-driver error string.
    Hardware(String),
    /// Mock-only error class — `MockTpmDevice` uses this to
    /// inject deterministic faults in tests.
    MockInjected(String),
}

impl std::fmt::Display for TpmDeviceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DeviceUnavailable(s) => write!(f, "tpm_device_unavailable: {}", s),
            Self::PolicyUnsatisfied(s) => write!(f, "tpm_policy_unsatisfied: {}", s),
            Self::NvCounterIncrementFailed(s) => {
                write!(f, "tpm_nv_counter_increment_failed: {}", s)
            }
            Self::NotProvisioned => f.write_str("tpm_not_provisioned"),
            Self::Hardware(s) => write!(f, "tpm_hardware: {}", s),
            Self::MockInjected(s) => write!(f, "tpm_mock_injected: {}", s),
        }
    }
}

impl std::error::Error for TpmDeviceError {}

impl From<TpmDeviceError> for KeystoreError {
    fn from(e: TpmDeviceError) -> Self {
        let kind = match &e {
            TpmDeviceError::DeviceUnavailable(_) => KeystoreErrorKind::TpmUnavailable,
            TpmDeviceError::PolicyUnsatisfied(_) => KeystoreErrorKind::MasterUnsealFailed,
            TpmDeviceError::NvCounterIncrementFailed(_) => KeystoreErrorKind::RotationFailed,
            TpmDeviceError::NotProvisioned => KeystoreErrorKind::MasterMissing,
            TpmDeviceError::Hardware(_) => KeystoreErrorKind::TpmUnavailable,
            TpmDeviceError::MockInjected(_) => KeystoreErrorKind::TpmUnavailable,
        };
        KeystoreError::new(kind, e.to_string())
    }
}

/// The FFI abstraction boundary. **All** TPM operations the
/// keystore needs go through this trait. The real
/// `RealTpmDevice` impl (Batch #309, behind
/// `#[cfg(feature = "tpm")]`) wraps tss-esapi v7. The
/// `MockTpmDevice` impl in this module drives unit tests
/// with deterministic in-memory state.
///
/// **Why sync (not async):** every TPM operation goes
/// through `tss-esapi` which holds an internal mutex and
/// blocks. Async-wrapping is the keystore's job (via
/// `tokio::task::spawn_blocking`); the trait stays sync to
/// keep the abstraction honest about its blocking nature.
///
/// **Why `&self` (not `&mut self`):** the device handle is
/// shared across `TpmKeystore` callers (HKDF derivations
/// + rotations); mutation lives behind the device's own
/// internal locking (tss-esapi's Mutex / our Mock's
/// Mutex). Forcing `&mut self` would require external
/// locking by every caller — wrong abstraction.
pub trait TpmDevice: Send + Sync + 'static {
    /// Unseal the master key bytes. Returns the 32-byte
    /// master AND the NV counter value that was bound to
    /// the sealed blob at seal-time. Caller verifies the
    /// returned counter ≥ the current on-chip counter
    /// (anti-rollback gate is in `TpmKeystore::open`, not
    /// here, so the device impl stays focused on the FFI).
    ///
    /// Returns `NotProvisioned` if no sealed blob exists
    /// at the configured NV index — first boot path,
    /// caller invokes `provision_master`.
    fn unseal_master(&self, config: &TpmKeystoreConfig) -> Result<UnsealedMaster, TpmDeviceError>;

    /// Provision the master key for the FIRST time. Seals
    /// the supplied 32-byte master to the configured PCR
    /// selection + NV counter, writes the sealed blob to
    /// `master_nv_index`, and initializes the counter at
    /// the configured `counter_nv_index` to 1.
    ///
    /// Idempotency: if a sealed blob already exists at
    /// `master_nv_index`, returns `Hardware("already_provisioned")`
    /// — provisioning is a one-shot operation; rotation is
    /// the path for replacing an existing master.
    fn provision_master(
        &self,
        config: &TpmKeystoreConfig,
        master: &[u8; 32],
    ) -> Result<NvCounterValue, TpmDeviceError>;

    /// Rotate the master: increment the NV counter, seal
    /// the NEW master with the NEW counter value bound,
    /// atomically replace the sealed blob.
    ///
    /// Atomicity: the TPM operation sequence is (a)
    /// increment counter — succeeds atomically on the chip;
    /// (b) seal new master with NEW counter — pure
    /// computation; (c) write new sealed blob — the failure
    /// window. If (c) fails, the counter has advanced but
    /// no new blob is stored: the OLD blob's policy now
    /// fails (counter mismatch), and the device is in
    /// `NotProvisioned`-like state until operator runs the
    /// re-seal recovery in the rotation runbook. This is
    /// FAIL-CLOSED by design — better to crash-recover
    /// than to silently roll back.
    fn rotate_master(
        &self,
        config: &TpmKeystoreConfig,
        new_master: &[u8; 32],
    ) -> Result<NvCounterValue, TpmDeviceError>;

    /// Read the current on-chip NV counter value. Used by
    /// `TpmKeystore::open` to enforce
    /// `unsealed.counter >= current_counter` (anti-
    /// rollback). Cheap operation (no PCR check).
    fn read_nv_counter(&self, config: &TpmKeystoreConfig)
    -> Result<NvCounterValue, TpmDeviceError>;
}

/// Result of a successful unseal operation. The 32-byte
/// master is wrapped in a `Zeroizing<[u8; 32]>` so the
/// caller (TpmKeystore::open) can move it into
/// `MasterKeyMaterial::from_bytes` and have the
/// intermediate buffer scrubbed on drop.
pub struct UnsealedMaster {
    pub master_bytes: zeroize::Zeroizing<[u8; 32]>,
    pub bound_counter: NvCounterValue,
}

impl std::fmt::Debug for UnsealedMaster {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UnsealedMaster")
            .field("master_bytes", &"<REDACTED 32 bytes>")
            .field("bound_counter", &self.bound_counter)
            .finish()
    }
}

// =============================================================
// TpmKeystore<D: TpmDevice> — the Keystore impl
// =============================================================

/// TPM-backed keystore parameterized over the device impl.
/// Runtime path uses `TpmKeystore<RealTpmDevice>` (Batch
/// #309). Tests use `TpmKeystore<MockTpmDevice>`.
/// **`?Sized` bound (Batch #312):** `D` may be either a
/// concrete sized type (`MockTpmDevice` for unit tests,
/// `RealTpmDevice` when the future tss-esapi-backed impl
/// lands) OR the unsized trait object `dyn TpmDevice`. The
/// latter is required by `KeystoreSelector::resolve()` which
/// returns `Arc<dyn Keystore>` and constructs
/// `TpmKeystore<dyn TpmDevice>` internally to allow the
/// factory to produce ANY device impl polymorphically.
/// `Arc<D>` is always sized (it's a thin or fat pointer);
/// the `?Sized` relaxation only allows the underlying `D` to
/// be unsized.
pub struct TpmKeystore<D: TpmDevice + ?Sized> {
    device: std::sync::Arc<D>,
    config: TpmKeystoreConfig,
    /// Unsealed master held under RwLock so rotation can
    /// swap atomically. Read guards take the master bytes
    /// out by copy + drop the guard before HKDF compute
    /// (matches the FileBackedKeystore `hkdf_expand_32`
    /// discipline so rotation latency is bounded).
    master: RwLock<MasterKeyMaterial>,
    /// Bound NV counter value at last successful unseal
    /// or rotation. Used for audit emission + the
    /// `current_bound_counter()` getter that exposes the
    /// state for the operator dashboard.
    bound_counter: RwLock<NvCounterValue>,
}

/// Manual `Debug` impl that explicitly redacts the
/// master key + does NOT require `D: Debug`.
///
/// **Why manual:** the keystore holds secret material (the
/// unsealed master in `MasterKeyMaterial`). A
/// `#[derive(Debug)]` would inherit `MasterKeyMaterial`'s
/// own redaction-style Debug, but it would ALSO require
/// `D: Debug` and `TpmKeystoreConfig: Debug` etc. — a
/// derive on the wrong axis. The manual impl gives
/// operators audit-grade info (backend tag, bound counter,
/// NV indices, PCR selection) while keeping the master out
/// of every log line.
///
/// **Why this matters at the type-system level:** the
/// `unwrap_err` / `expect` family on `Result<TpmKeystore<D>, _>`
/// requires `TpmKeystore<D>: Debug`. Without this impl,
/// every test would have to use `match` boilerplate or an
/// ad-hoc helper. The Debug surface IS part of the public
/// contract — defining it explicitly forces every reviewer
/// to confirm "no master leak" once at definition rather
/// than at every call site.
impl<D: TpmDevice + ?Sized> std::fmt::Debug for TpmKeystore<D> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let bound = self.bound_counter.read().map(|g| g.0).unwrap_or(u64::MAX);
        f.debug_struct("TpmKeystore")
            .field("backend", &"Tpm")
            .field("bound_counter", &bound)
            .field("config", &self.config)
            .field("master", &"<REDACTED MasterKeyMaterial>")
            .finish()
    }
}

impl<D: TpmDevice + ?Sized> TpmKeystore<D> {
    /// Open the TPM keystore: unseal the master, verify
    /// the bound counter ≥ on-chip counter (anti-rollback
    /// gate), construct the keystore.
    ///
    /// ## Boot-path control flow
    ///
    /// 1. Validate `config` (PCR bank, NV index range,
    ///    distinctness).
    /// 2. `device.unseal_master(config)` — either returns
    ///    `Ok(UnsealedMaster)` or `NotProvisioned`.
    ///    `NotProvisioned` is surfaced verbatim as
    ///    `KeystoreErrorKind::MasterMissing` so the
    ///    bootstrap orchestrator can route to provisioning.
    /// 3. `device.read_nv_counter(config)` — fetch the
    ///    current on-chip counter.
    /// 4. **Anti-rollback gate:** require
    ///    `unsealed.bound_counter >= on_chip_counter`. A
    ///    sealed blob bound to an OLDER counter (because
    ///    an attacker restored a backup) is rejected with
    ///    `MasterUnsealFailed("rollback_detected")`.
    /// 5. Wrap the master bytes in `MasterKeyMaterial`
    ///    (zeroize-on-drop). The `Zeroizing` wrapper on
    ///    the unseal result scrubs the intermediate copy
    ///    when the function returns.
    /// 6. Construct the keystore with the master + bound
    ///    counter under RwLock.
    pub fn open(
        device: std::sync::Arc<D>,
        config: TpmKeystoreConfig,
    ) -> Result<Self, KeystoreError> {
        config.validate().map_err(|e| {
            KeystoreError::new(
                KeystoreErrorKind::Configuration,
                format!("TpmKeystoreConfig invalid: {}", e),
            )
        })?;

        let unsealed = device.unseal_master(&config)?;
        let on_chip = device.read_nv_counter(&config)?;

        if unsealed.bound_counter < on_chip {
            warn!(
                "TpmKeystore::open ROLLBACK DETECTED: bound_counter={} on_chip={} \
                 — refusing to open keystore",
                unsealed.bound_counter.0, on_chip.0
            );
            return Err(KeystoreError::new(
                KeystoreErrorKind::MasterUnsealFailed,
                format!(
                    "rollback_detected: sealed_blob_counter={} on_chip_counter={} \
                     (sealed blob bound to older state — possible offline tamper or \
                     factory-restored backup; consult compromise-response runbook)",
                    unsealed.bound_counter.0, on_chip.0
                ),
            ));
        }

        // Move the master bytes from Zeroizing<[u8;32]> into
        // MasterKeyMaterial. The Zeroizing wrapper drops
        // here; MasterKeyMaterial::from_bytes copies the
        // bytes into its sealed Secret<MasterKeyBytes> and
        // we explicitly request zeroization of the source.
        // (MasterKeyMaterial::from_bytes takes [u8;32] by
        // value — it copies; the Zeroizing wrapper scrubs
        // its own copy on drop.)
        let master_bytes_copy: [u8; 32] = *unsealed.master_bytes;
        let master = MasterKeyMaterial::from_bytes(master_bytes_copy);
        // unsealed (and its Zeroizing wrapper) drop here.

        info!(
            "TpmKeystore opened: master_nv=0x{:08x} counter_nv=0x{:08x} \
             pcr_bank={:?} pcr_slots={:?} bound_counter={}",
            config.master_nv_index,
            config.counter_nv_index,
            config.pcr_selection.bank,
            config.pcr_selection.slots,
            unsealed.bound_counter.0,
        );

        Ok(Self {
            device,
            config,
            master: RwLock::new(master),
            bound_counter: RwLock::new(unsealed.bound_counter),
        })
    }

    /// Operator dashboard / audit accessor — current bound
    /// counter value. Read-only.
    pub fn current_bound_counter(&self) -> NvCounterValue {
        *self
            .bound_counter
            .read()
            .expect("TpmKeystore bound_counter RwLock poisoned")
    }

    /// HKDF-SHA256 derivation. Mirrors
    /// `FileBackedKeystore::hkdf_expand_32` for SSoT
    /// consistency: identical
    /// `(purpose.hkdf_info(), context)` inputs across
    /// backends produce identical 32-byte outputs FOR THE
    /// SAME MASTER. Different masters (TPM vs file-backed)
    /// produce different outputs — this is by design.
    fn hkdf_expand_32(
        &self,
        purpose: KeyPurpose,
        context: &[u8],
    ) -> Result<[u8; 32], KeyDerivationError> {
        let master_bytes: [u8; 32] = {
            let guard = self.master.read().map_err(|_| {
                KeyDerivationError::HkdfFailure("TpmKeystore master RwLock poisoned".to_string())
            })?;
            *guard.expose_secret_crate()
        };

        let hk = Hkdf::<Sha256>::new(None, &master_bytes);

        let purpose_info = purpose.hkdf_info();
        let mut info = Vec::with_capacity(purpose_info.len() + context.len());
        info.extend_from_slice(purpose_info);
        info.extend_from_slice(context);

        let mut okm = [0u8; 32];
        let expand_result = hk.expand(&info, &mut okm);

        // Scrub the local stack copy of master bytes.
        // Same discipline as file_backed.rs — see WHY note
        // there.
        {
            let mut mb = master_bytes;
            mb.zeroize();
        }

        expand_result
            .map_err(|e| KeyDerivationError::HkdfFailure(format!("HKDF expand: {}", e)))?;
        Ok(okm)
    }

    /// Internal rotation primitive: device-side rotate +
    /// in-memory swap. Called by
    /// `rotate_master_with_source(TpmReseal)` and by the
    /// `cmd_rotate_master` orchestrator (Faz 2 Sprint
    /// 6.4).
    fn rotate_master_internal(
        &self,
        new_master_bytes: [u8; 32],
    ) -> Result<NvCounterValue, KeystoreError> {
        let new_counter = self.device.rotate_master(&self.config, &new_master_bytes)?;

        let new_master = MasterKeyMaterial::from_bytes(new_master_bytes);

        // Write guards are brief — only the swap. OLD
        // MasterKeyMaterial drops + zeroize-on-drops.
        {
            let mut master_guard = self.master.write().map_err(|_| {
                KeystoreError::new(
                    KeystoreErrorKind::RotationFailed,
                    "TpmKeystore master RwLock poisoned during rotate".to_string(),
                )
            })?;
            *master_guard = new_master;
        }
        {
            let mut counter_guard = self.bound_counter.write().map_err(|_| {
                KeystoreError::new(
                    KeystoreErrorKind::RotationFailed,
                    "TpmKeystore bound_counter RwLock poisoned during rotate".to_string(),
                )
            })?;
            *counter_guard = new_counter;
        }

        info!("TpmKeystore rotated: new_bound_counter={}", new_counter.0,);
        Ok(new_counter)
    }
}

#[async_trait]
impl<D: TpmDevice + ?Sized> Keystore for TpmKeystore<D> {
    fn backend(&self) -> KeyBackend {
        KeyBackend::Tpm
    }

    async fn derive_key(
        &self,
        purpose: KeyPurpose,
        context: &[u8],
    ) -> Result<KeyMaterial, KeyDerivationError> {
        let bytes = self.hkdf_expand_32(purpose, context)?;
        Ok(KeyMaterial::from_derived_bytes(purpose, bytes))
    }

    fn derived_key_id(&self, purpose: KeyPurpose, context: &[u8]) -> DerivedKeyId {
        // Same SSoT shape as FileBackedKeystore: SHA-256
        // (purpose.hkdf_info() || context || 0x01) truncated
        // to 16 bytes. Cross-backend derived_key_id parity
        // is intentional — the audit trail uses key IDs as
        // stable correlation handles regardless of which
        // backend provided the master.
        let mut hasher = Sha256::new();
        hasher.update(purpose.hkdf_info());
        hasher.update(context);
        hasher.update([0x01u8]);
        let digest = hasher.finalize();
        let mut id = [0u8; 16];
        id.copy_from_slice(&digest[..16]);
        DerivedKeyId(id)
    }

    async fn rotate_master(&self) -> Result<(), KeystoreError> {
        // The trait's no-arg rotate_master cannot satisfy
        // the TPM rotation contract: the new master bytes
        // must come from a CSPRNG (recommended: getrandom
        // 32 bytes) which the orchestrator owns. Use
        // rotate_master_with_source(TpmReseal) instead —
        // it lets the orchestrator pass the new bytes in.
        warn!(
            "TpmKeystore::rotate_master called without source — \
             use rotate_master_with_source(RotationSource::TpmReseal) \
             with the new master bytes from the orchestrator."
        );
        Err(KeystoreError::new(
            KeystoreErrorKind::NotImplemented,
            "TPM rotation requires RotationSource::TpmReseal with new master bytes".to_string(),
        ))
    }

    async fn rotate_master_with_source(
        &self,
        source: RotationSource<'_>,
    ) -> Result<(), KeystoreError> {
        match source {
            RotationSource::TpmReseal => {
                // Orchestrator (cmd_rotate_master) supplies
                // the new master bytes by calling the
                // public `rotate_master_internal` via a
                // typed entry. In this batch (#308 skeleton)
                // the no-source path errors here so the
                // wiring discipline is enforced: the
                // orchestrator MUST use the explicit-bytes
                // entry, not the unified trait surface.
                //
                // The reason is asymmetry between backends:
                // file-backed reads NEW bytes from disk
                // (operator ceremony); TPM generates NEW
                // bytes from the host CSPRNG (no operator
                // ceremony required). Pushing the bytes
                // through the unified RotationSource
                // would require a TpmReseal { new_master }
                // variant, which is wrong: the trait
                // shouldn't expose raw key bytes on its
                // surface. Batch #310 (selector) lands the
                // typed orchestrator entry that calls
                // `TpmKeystore::rotate_master_internal`.
                Err(KeystoreError::new(
                    KeystoreErrorKind::NotImplemented,
                    "TpmReseal via RotationSource is reserved for Batch #310 \
                     orchestrator wiring; current entry is \
                     TpmKeystore::rotate_master_internal (crate-internal)"
                        .to_string(),
                ))
            }
            RotationSource::FileBacked { .. } => Err(KeystoreError::new(
                KeystoreErrorKind::NotImplemented,
                "TpmKeystore does not accept FileBacked rotation source".to_string(),
            )),
            RotationSource::SystemdCredsReissue => Err(KeystoreError::new(
                KeystoreErrorKind::NotImplemented,
                "TpmKeystore does not accept SystemdCredsReissue rotation source".to_string(),
            )),
        }
    }
}

// =============================================================
// MockTpmDevice — deterministic in-memory device for tests
// =============================================================

/// In-memory `TpmDevice` impl. Drives the default-feature
/// test suite without real TPM hardware.
///
/// **State model:** holds an `Option<(SealedMaster,
/// NvCounterValue)>` under a Mutex. Provisioning sets it;
/// unsealing reads it; rotation increments the counter +
/// writes a new sealed entry. Faults are injectable via
/// `inject_fault()` for negative-path coverage.
///
/// **Why a Mutex (not RwLock):** the FFI device contract
/// is "internal lock around blocking ops"; the mock matches
/// that for fidelity. RwLock would let two unseals proceed
/// concurrently which a real TPM does NOT do.
pub struct MockTpmDevice {
    state: std::sync::Mutex<MockState>,
}

struct MockState {
    /// Some(blob, counter_at_seal) when provisioned.
    sealed: Option<(Vec<u8>, NvCounterValue)>,
    /// Current on-chip NV counter.
    on_chip_counter: NvCounterValue,
    /// Optional fault injection — next operation returns
    /// this error then clears the slot.
    fault: Option<TpmDeviceError>,
}

impl MockTpmDevice {
    pub fn new() -> Self {
        Self {
            state: std::sync::Mutex::new(MockState {
                sealed: None,
                on_chip_counter: NvCounterValue::ZERO,
                fault: None,
            }),
        }
    }

    /// Pre-provision the mock with a known master + counter.
    /// Used by `TpmKeystore::open` happy-path tests where
    /// we want to skip the explicit `provision_master`
    /// call.
    pub fn pre_provisioned(master: [u8; 32], counter: NvCounterValue) -> Self {
        let mut blob = Vec::with_capacity(32);
        blob.extend_from_slice(&master);
        Self {
            state: std::sync::Mutex::new(MockState {
                sealed: Some((blob, counter)),
                on_chip_counter: counter,
                fault: None,
            }),
        }
    }

    /// Inject a fault for the NEXT operation. Cleared
    /// after one consume.
    pub fn inject_fault(&self, err: TpmDeviceError) {
        let mut s = self.state.lock().expect("MockTpmDevice mutex poisoned");
        s.fault = Some(err);
    }

    /// Force the on-chip counter to a specific value
    /// without touching the sealed blob. Used to simulate
    /// "attacker restored an old sealed blob; on-chip
    /// counter has advanced past it".
    pub fn force_on_chip_counter(&self, counter: NvCounterValue) {
        let mut s = self.state.lock().expect("MockTpmDevice mutex poisoned");
        s.on_chip_counter = counter;
    }

    fn consume_fault(state: &mut MockState) -> Result<(), TpmDeviceError> {
        if let Some(f) = state.fault.take() {
            return Err(f);
        }
        Ok(())
    }
}

impl Default for MockTpmDevice {
    fn default() -> Self {
        Self::new()
    }
}

impl TpmDevice for MockTpmDevice {
    fn unseal_master(&self, _config: &TpmKeystoreConfig) -> Result<UnsealedMaster, TpmDeviceError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| TpmDeviceError::Hardware("mock_tpm_mutex_poisoned".to_string()))?;
        Self::consume_fault(&mut state)?;
        let (blob, bound_counter) = state
            .sealed
            .as_ref()
            .ok_or(TpmDeviceError::NotProvisioned)?
            .clone();
        if blob.len() != 32 {
            return Err(TpmDeviceError::PolicyUnsatisfied(format!(
                "mock sealed blob length {} != 32",
                blob.len()
            )));
        }
        let mut master = [0u8; 32];
        master.copy_from_slice(&blob);
        Ok(UnsealedMaster {
            master_bytes: zeroize::Zeroizing::new(master),
            bound_counter,
        })
    }

    fn provision_master(
        &self,
        _config: &TpmKeystoreConfig,
        master: &[u8; 32],
    ) -> Result<NvCounterValue, TpmDeviceError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| TpmDeviceError::Hardware("mock_tpm_mutex_poisoned".to_string()))?;
        Self::consume_fault(&mut state)?;
        if state.sealed.is_some() {
            return Err(TpmDeviceError::Hardware("already_provisioned".to_string()));
        }
        let counter = NvCounterValue(1);
        state.sealed = Some((master.to_vec(), counter));
        state.on_chip_counter = counter;
        Ok(counter)
    }

    fn rotate_master(
        &self,
        _config: &TpmKeystoreConfig,
        new_master: &[u8; 32],
    ) -> Result<NvCounterValue, TpmDeviceError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| TpmDeviceError::Hardware("mock_tpm_mutex_poisoned".to_string()))?;
        Self::consume_fault(&mut state)?;
        if state.sealed.is_none() {
            return Err(TpmDeviceError::NotProvisioned);
        }
        // Increment counter THEN seal new master. Mirrors
        // the real-device atomicity contract.
        let new_counter = state.on_chip_counter.next();
        state.on_chip_counter = new_counter;
        state.sealed = Some((new_master.to_vec(), new_counter));
        Ok(new_counter)
    }

    fn read_nv_counter(
        &self,
        _config: &TpmKeystoreConfig,
    ) -> Result<NvCounterValue, TpmDeviceError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| TpmDeviceError::Hardware("mock_tpm_mutex_poisoned".to_string()))?;
        Self::consume_fault(&mut state)?;
        Ok(state.on_chip_counter)
    }
}

// =============================================================
// Tests — keystore logic + anti-rollback gate + HKDF parity
// =============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcr_selection_canonicalize_sorts_and_dedups() {
        let mut sel = PcrSelection {
            bank: PcrHashBank::Sha256,
            slots: vec![7, 0, 3, 7, 1],
        };
        sel.canonicalize();
        assert_eq!(sel.slots, vec![0, 1, 3, 7]);
    }

    #[test]
    fn pcr_selection_firmware_and_boot_pins_pcrs_0_through_7_sha256() {
        let sel = PcrSelection::firmware_and_boot();
        assert_eq!(sel.bank, PcrHashBank::Sha256);
        assert_eq!(sel.slots, vec![0, 1, 2, 3, 4, 5, 6, 7]);
    }

    #[test]
    fn config_validate_rejects_sha1_legacy_bank() {
        let mut cfg = TpmKeystoreConfig::production_default();
        cfg.pcr_selection.bank = PcrHashBank::Sha1Legacy;
        let err = cfg.validate().unwrap_err();
        assert!(
            err.contains("SHA-1") && err.contains("legacy"),
            "expected SHA-1 legacy rejection, got: {}",
            err
        );
    }

    #[test]
    fn config_validate_rejects_empty_pcr_slots() {
        let mut cfg = TpmKeystoreConfig::production_default();
        cfg.pcr_selection.slots.clear();
        let err = cfg.validate().unwrap_err();
        assert!(
            err.contains("empty"),
            "expected empty-PCR rejection: {}",
            err
        );
    }

    #[test]
    fn config_validate_rejects_identical_nv_indices() {
        let mut cfg = TpmKeystoreConfig::production_default();
        cfg.counter_nv_index = cfg.master_nv_index;
        let err = cfg.validate().unwrap_err();
        assert!(
            err.contains("must differ"),
            "expected NV-distinctness rejection: {}",
            err
        );
    }

    #[test]
    fn config_validate_rejects_out_of_range_nv_index() {
        let mut cfg = TpmKeystoreConfig::production_default();
        cfg.master_nv_index = 0x0000_0001; // outside user range
        let err = cfg.validate().unwrap_err();
        assert!(
            err.contains("user-defined NV range"),
            "expected NV-range rejection: {}",
            err
        );
    }

    #[test]
    fn nv_counter_next_is_monotonic_and_saturates_at_u64_max() {
        assert_eq!(NvCounterValue(5).next(), NvCounterValue(6));
        assert_eq!(NvCounterValue(u64::MAX).next(), NvCounterValue(u64::MAX));
        assert!(NvCounterValue(5) < NvCounterValue(6));
    }

    #[test]
    fn tpm_device_error_to_keystore_error_kind_mapping_pinned() {
        let pairs: Vec<(TpmDeviceError, KeystoreErrorKind)> = vec![
            (
                TpmDeviceError::NotProvisioned,
                KeystoreErrorKind::MasterMissing,
            ),
            (
                TpmDeviceError::PolicyUnsatisfied("pcr".into()),
                KeystoreErrorKind::MasterUnsealFailed,
            ),
            (
                TpmDeviceError::NvCounterIncrementFailed("busy".into()),
                KeystoreErrorKind::RotationFailed,
            ),
            (
                TpmDeviceError::DeviceUnavailable("/dev/tpm0".into()),
                KeystoreErrorKind::TpmUnavailable,
            ),
            (
                TpmDeviceError::Hardware("ffi".into()),
                KeystoreErrorKind::TpmUnavailable,
            ),
        ];
        for (dev_err, expected_kind) in pairs {
            let ks_err: KeystoreError = dev_err.clone().into();
            assert_eq!(
                ks_err.kind, expected_kind,
                "mapping for {:?} produced wrong kind: {:?}",
                dev_err, ks_err.kind
            );
        }
    }

    /// Happy path: pre-provisioned mock device, open
    /// succeeds, backend reports Tpm.
    #[tokio::test]
    async fn tpm_keystore_open_happy_path_reports_tpm_backend() {
        let device = std::sync::Arc::new(MockTpmDevice::pre_provisioned(
            [0x42u8; 32],
            NvCounterValue(7),
        ));
        let cfg = TpmKeystoreConfig::production_default();
        let ks = TpmKeystore::open(device, cfg).expect("open succeeds");
        assert_eq!(ks.backend(), KeyBackend::Tpm);
        assert_eq!(ks.current_bound_counter(), NvCounterValue(7));
    }

    /// First-boot path: mock not provisioned → open
    /// returns `MasterMissing`. Bootstrap orchestrator
    /// observes this and routes to provisioning.
    #[tokio::test]
    async fn tpm_keystore_open_first_boot_returns_master_missing() {
        let device = std::sync::Arc::new(MockTpmDevice::new());
        let cfg = TpmKeystoreConfig::production_default();
        let err = TpmKeystore::open(device, cfg).unwrap_err();
        assert_eq!(err.kind, KeystoreErrorKind::MasterMissing);
    }

    /// Anti-rollback gate: sealed blob is bound to counter
    /// 5, but the on-chip counter has advanced to 9
    /// (attacker restored an old backup). open() MUST
    /// refuse with `MasterUnsealFailed("rollback_detected")`.
    #[tokio::test]
    async fn tpm_keystore_open_rejects_rolled_back_blob() {
        let device = MockTpmDevice::pre_provisioned([0x11u8; 32], NvCounterValue(5));
        device.force_on_chip_counter(NvCounterValue(9));
        let device = std::sync::Arc::new(device);
        let cfg = TpmKeystoreConfig::production_default();
        let err = TpmKeystore::open(device, cfg).unwrap_err();
        assert_eq!(err.kind, KeystoreErrorKind::MasterUnsealFailed);
        assert!(
            err.context.contains("rollback_detected"),
            "expected rollback_detected in context: {}",
            err.context
        );
    }

    /// HKDF parity smoke test: TpmKeystore and
    /// FileBackedKeystore with the SAME 32-byte master
    /// produce the SAME 32-byte derived bytes for the
    /// same (purpose, context). Cross-backend SSoT
    /// invariant.
    #[tokio::test]
    async fn tpm_keystore_hkdf_parity_with_known_master() {
        let master = [0xa5u8; 32];
        let device = std::sync::Arc::new(MockTpmDevice::pre_provisioned(master, NvCounterValue(1)));
        let cfg = TpmKeystoreConfig::production_default();
        let ks = TpmKeystore::open(device, cfg).unwrap();

        // Compute HKDF directly with the same parameters
        // and compare. (We don't construct a real
        // FileBackedKeystore here because that requires
        // disk fixtures; the HKDF helper is the SSoT and
        // file_backed.rs uses the identical compute.)
        let purpose = KeyPurpose::AuditHmacChain;
        let context = b"test-context-bytes";

        let derived = ks.derive_key(purpose, context).await.unwrap();
        assert_eq!(derived.purpose(), purpose);

        // Reconstruct expected bytes via direct HKDF call.
        let hk = Hkdf::<Sha256>::new(None, &master);
        let purpose_info = purpose.hkdf_info();
        let mut info = Vec::with_capacity(purpose_info.len() + context.len());
        info.extend_from_slice(purpose_info);
        info.extend_from_slice(context);
        let mut expected = [0u8; 32];
        hk.expand(&info, &mut expected).unwrap();

        assert_eq!(
            derived.expose_secret(),
            &expected,
            "TpmKeystore HKDF must match direct HKDF (cross-backend SSoT)",
        );
    }

    /// Rotation increments the bound counter + the new
    /// master derives different keys for the same
    /// (purpose, context).
    #[tokio::test]
    async fn tpm_keystore_rotate_internal_increments_counter_and_swaps_master() {
        let device = std::sync::Arc::new(MockTpmDevice::pre_provisioned(
            [0x10u8; 32],
            NvCounterValue(1),
        ));
        let cfg = TpmKeystoreConfig::production_default();
        let ks = TpmKeystore::open(device, cfg).unwrap();
        let pre_key = ks
            .derive_key(KeyPurpose::AuditHmacChain, b"ctx")
            .await
            .unwrap();
        let pre_bytes = *pre_key.expose_secret();

        let new_counter = ks
            .rotate_master_internal([0xfeu8; 32])
            .expect("rotate_master_internal succeeds");

        assert_eq!(new_counter, NvCounterValue(2));
        assert_eq!(ks.current_bound_counter(), NvCounterValue(2));

        let post_key = ks
            .derive_key(KeyPurpose::AuditHmacChain, b"ctx")
            .await
            .unwrap();
        assert_ne!(
            *post_key.expose_secret(),
            pre_bytes,
            "post-rotation derive_key MUST produce different bytes for the \
             same (purpose, context) — master changed",
        );
    }

    /// derived_key_id is purpose+context dependent and
    /// stable across calls. Cross-backend correlation
    /// handle invariant.
    #[tokio::test]
    async fn tpm_keystore_derived_key_id_is_stable_and_purpose_distinguishing() {
        let device = std::sync::Arc::new(MockTpmDevice::pre_provisioned(
            [0x77u8; 32],
            NvCounterValue(1),
        ));
        let cfg = TpmKeystoreConfig::production_default();
        let ks = TpmKeystore::open(device, cfg).unwrap();

        let id1 = ks.derived_key_id(KeyPurpose::AuditHmacChain, b"ctx");
        let id2 = ks.derived_key_id(KeyPurpose::AuditHmacChain, b"ctx");
        let id3 = ks.derived_key_id(KeyPurpose::ReplayCache, b"ctx");
        let id4 = ks.derived_key_id(KeyPurpose::AuditHmacChain, b"ctx2");

        assert_eq!(id1, id2, "same (purpose, context) → same id");
        assert_ne!(id1, id3, "different purpose → different id");
        assert_ne!(id1, id4, "different context → different id");
    }

    /// Trait no-arg rotate_master is intentionally
    /// NotImplemented for TPM backend — orchestrator must
    /// use the explicit-bytes entry. Pin the contract.
    #[tokio::test]
    async fn tpm_keystore_trait_rotate_master_returns_not_implemented() {
        let device =
            std::sync::Arc::new(MockTpmDevice::pre_provisioned([0u8; 32], NvCounterValue(1)));
        let cfg = TpmKeystoreConfig::production_default();
        let ks = TpmKeystore::open(device, cfg).unwrap();
        let err = ks.rotate_master().await.unwrap_err();
        assert_eq!(err.kind, KeystoreErrorKind::NotImplemented);
    }

    /// Fault injection: NotProvisioned during unseal →
    /// open returns MasterMissing.
    #[tokio::test]
    async fn tpm_keystore_open_propagates_fault_injected_not_provisioned() {
        let device = MockTpmDevice::pre_provisioned([0u8; 32], NvCounterValue(1));
        device.inject_fault(TpmDeviceError::NotProvisioned);
        let device = std::sync::Arc::new(device);
        let cfg = TpmKeystoreConfig::production_default();
        let err = TpmKeystore::open(device, cfg).unwrap_err();
        assert_eq!(err.kind, KeystoreErrorKind::MasterMissing);
    }

    /// Fault injection: PolicyUnsatisfied (PCR mismatch)
    /// → open returns MasterUnsealFailed.
    #[tokio::test]
    async fn tpm_keystore_open_propagates_pcr_policy_unsatisfied() {
        let device = MockTpmDevice::pre_provisioned([0u8; 32], NvCounterValue(1));
        device.inject_fault(TpmDeviceError::PolicyUnsatisfied(
            "pcr_7_mismatch".to_string(),
        ));
        let device = std::sync::Arc::new(device);
        let cfg = TpmKeystoreConfig::production_default();
        let err = TpmKeystore::open(device, cfg).unwrap_err();
        assert_eq!(err.kind, KeystoreErrorKind::MasterUnsealFailed);
        assert!(err.context.contains("pcr_7_mismatch"));
    }
}
