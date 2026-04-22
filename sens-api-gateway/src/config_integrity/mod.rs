//! # Config integrity — factory-signed `config.yaml.sig` (plan D-13, ADR-020 §6)
//!
//! Every edge device boots with `/etc/suderra/config.yaml` AND a sidecar
//! `/etc/suderra/config.yaml.sig`. The sidecar carries a
//! [`manifest::SignedConfigMeta`] whose signature (ed25519) covers the
//! SHA-256 of the raw config bytes + device binding + config version.
//!
//! Startup verification (Sprint 6.6):
//!
//! 1. Read raw `config.yaml` bytes + compute SHA-256.
//! 2. Parse `config.yaml.sig` into `SignedConfigMeta`.
//! 3. Call [`verify::verify_config_integrity`] with: the parsed meta, the
//!    provisioning-bound DeviceId, the computed config SHA-256, and the
//!    factory signing key's public key (loaded from the factory-provisioned
//!    keyring bundled in the firmware image — NOT operator-rotatable).
//! 4. On Err → fail-closed boot (systemd unit goes to failed state; no
//!    fallback config).
//! 5. On Ok → continue normal boot.
//!
//! ## Why device binding (not just tenant binding)
//!
//! A config signed for device A cannot unlock device B. Prevents an
//! attacker who obtains a signed config from pivoting to sibling devices
//! in the same tenant. `DeviceId` is provisioning-bound (ADR-019 §4) so
//! forging a matching identifier is infeasible.
//!
//! ## Operator workflow (Sprint 6.6)
//!
//! - Operator edits config on an admin workstation.
//! - Operator runs `suderra-config-sign` CLI against the factory keyring
//!   (requires the 4-eye HSM ceremony for production keys per ADR-021).
//! - The CLI emits `config.yaml` + `config.yaml.sig` pair.
//! - Operator copies both via the signed-deploy flow (not scp to `/etc/`
//!   directly — systemd-boot ReadOnlyPaths prevents in-place edits per
//!   Batch 4a hardening).
//!
//! ## Scope of Batch 9
//!
//! Types + one pure function (`verify_config_integrity`) with closure-
//! injected ed25519 verify. No actual YAML parsing, no file I/O, no SHA-256
//! compute. Sprint 6.6 wires the real flow.
//!
//! ## Cross-references
//!
//! - Plan D-13 Config integrity (factory-signed `config.yaml.sig`)
//! - Plan D-7 Clock authority (monotonic time for freshness checks)
//! - ADR-020 §6 Startup config verify step
//! - ADR-019 §4 Sealed `DeviceId` binding
//! - Batch 5a `Ed25519SignatureBytes` (reused)
//! - Batch 5b `verify_manifest` closure-injection pattern (mirrored)
//! - Batch 8 `Sha256Digest` (reused for config bytes hash)

pub mod error;
pub mod manifest;
pub mod verify;

pub use error::{ConfigIntegrityError, ConfigMetaCanonicalBytesError};
pub use manifest::{ConfigMeta, SignedConfigMeta};
pub use verify::verify_config_integrity;
