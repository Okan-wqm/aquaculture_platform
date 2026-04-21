//! Runtime config-integrity verification wrapper (Batch 54,
//! Sprint 6.6 full wire).
//!
//! Wraps the Batch 9 pure `verify_config_integrity` function
//! with runtime I/O: reads config.yaml bytes, computes SHA-256,
//! parses the sidecar JSON, loads highest-seen version from
//! disk, performs ed25519 verify via closure injection, and
//! routes the result according to the operator-configured
//! `ConfigIntegrityMode` (Disabled / Permissive / Enforcing).
//!
//! Pre-Sprint-6.3 the highest_seen_config_version is persisted
//! as a plaintext file under `$SUDERRA_DATA_DIR/
//! config_integrity_highest_version.txt`. An attacker with
//! file-write access could corrupt/reset the file — but that
//! attacker already has file-write access to
//! /etc/suderra/config.yaml directly, so the rollback defense
//! against THIS threat model is not strengthened by keystore
//! persistence. Sprint 6.3 upgrades to SQLCipher for
//! defense-in-depth against post-compromise persistence
//! integrity.
//!
//! ## Error path (Enforcing mode)
//!
//! Each gate's fail state produces an operator-visible error
//! string BEFORE `std::process::exit(1)` — operators diagnosing
//! a fail-closed boot see the specific gate (device mismatch,
//! stale version, SHA mismatch, invalid signature, missing
//! sidecar) with enough context for incident response.
//!
//! ## Permissive mode
//!
//! Same verify path; failures logged as WARN instead of
//! fail-closed. Emits the rejection reason so operators can
//! detect attacker activity OR misconfigured rollout in the
//! post-hoc audit.

use std::path::{Path, PathBuf};

use tracing::{error, info, warn};

use super::manifest::SignedConfigMeta;
use super::verify::verify_config_integrity;
use crate::authz::permission::DeviceId;
use crate::config::ConfigIntegrityMode;
use crate::updater::manifest::Sha256Digest;

/// Canonical sidecar location.
const DEFAULT_SIDECAR_PATH: &str = "/etc/suderra/config.yaml.sig";

/// Highest-seen-version file name inside `$SUDERRA_DATA_DIR`.
const HIGHEST_SEEN_VERSION_FILENAME: &str = "config_integrity_highest_version.txt";

/// Compute SHA-256 of raw bytes.
///
/// WHY: Sprint 6.6 verifies the config bytes' hash matches the
/// signed manifest's `expected_config_sha256`. The `sha2` crate
/// is already declared in Cargo.toml; this wrapper makes the
/// call site single-line + produces a `Sha256Digest` newtype.
fn compute_sha256(bytes: &[u8]) -> Sha256Digest {
    use sha2::{Digest, Sha256};
    let hash: [u8; 32] = Sha256::digest(bytes).into();
    Sha256Digest::from_bytes(hash)
}

/// Parse the operator-supplied `factory_pubkey_hex` into an
/// ed25519 VerifyingKey.
///
/// Pre-Sprint-6.6 this key is operator-supplied via
/// `config.yaml::config_integrity.factory_pubkey_hex`. Sprint
/// 6.6 replaces with a firmware-embedded default key; the
/// operator-override path stays for test-keyring use.
fn parse_factory_pubkey(hex: &str) -> Result<ed25519_dalek::VerifyingKey, String> {
    if hex.len() != 64 {
        return Err(format!(
            "factory_pubkey_hex must be 64 chars, got {}",
            hex.len()
        ));
    }
    let mut bytes = [0u8; 32];
    for (i, b) in bytes.iter_mut().enumerate() {
        let byte_idx = i * 2;
        let hex_byte = hex
            .get(byte_idx..byte_idx + 2)
            .ok_or_else(|| format!("hex slice error at index {}", byte_idx))?;
        *b = u8::from_str_radix(hex_byte, 16)
            .map_err(|e| format!("invalid hex at byte {}: {}", i, e))?;
    }
    ed25519_dalek::VerifyingKey::from_bytes(&bytes)
        .map_err(|e| format!("ed25519 key construction failed: {}", e))
}

/// Parse the `config.device_id` UUID string into DeviceId bytes.
///
/// WHY: verify_config_integrity takes `&DeviceId` (16 bytes).
/// AgentConfig carries `device_id: String` (UUID string form).
/// This converter bridges the two.
fn parse_device_id_from_uuid(uuid_str: &str) -> Result<DeviceId, String> {
    let uuid = uuid::Uuid::parse_str(uuid_str)
        .map_err(|e| format!("device_id is not a valid UUID: {}", e))?;
    Ok(DeviceId::new_from_verified(*uuid.as_bytes()))
}

/// Load the highest-seen config version from disk. Returns 0
/// if the file doesn't exist (first boot).
///
/// WHY: verify_config_integrity's Rule 2 enforces monotonic
/// config_version > highest_seen. First boot has no history;
/// 0 is the lowest acceptable floor.
fn load_highest_seen_version(data_dir: &Path) -> u64 {
    let path = data_dir.join(HIGHEST_SEEN_VERSION_FILENAME);
    match std::fs::read_to_string(&path) {
        Ok(content) => content.trim().parse::<u64>().unwrap_or(0),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => {
            warn!(
                "Failed to read highest-seen-version file {}: {} (treating as 0)",
                path.display(),
                e
            );
            0
        }
    }
}

/// Persist highest-seen config version to disk. Best-effort —
/// failure logs a warn but does not fail the boot (monotonic
/// tracking is defense-in-depth; primary gates are device
/// binding + SHA + signature).
fn save_highest_seen_version(data_dir: &Path, version: u64) {
    if let Err(e) = std::fs::create_dir_all(data_dir) {
        warn!(
            "Failed to create data_dir {} for version-file write: {}",
            data_dir.display(),
            e
        );
        return;
    }
    let path = data_dir.join(HIGHEST_SEEN_VERSION_FILENAME);
    if let Err(e) = std::fs::write(&path, format!("{}\n", version)) {
        warn!(
            "Failed to persist highest-seen-version to {}: {}",
            path.display(),
            e
        );
    }
}

/// Runtime entry point — read config bytes, parse sidecar,
/// verify, route result per mode.
///
/// INPUTS:
/// - `mode` — Disabled / Permissive / Enforcing from
///   `config.config_integrity.mode`.
/// - `factory_pubkey_hex` — operator-supplied ed25519 pubkey
///   hex string (pre-Sprint-6.6). None = fail-closed before
///   reach (Batch 42 Rule 4 already prevents this combo).
/// - `sidecar_path_override` — None = DEFAULT_SIDECAR_PATH.
/// - `config_yaml_path` — the actual config path used at
///   boot (honors SUDERRA_CONFIG env).
/// - `device_id_str` — config.device_id UUID string.
/// - `data_dir` — for highest-seen-version persistence.
///
/// OUTPUT:
/// - `Ok(())` — verify succeeded OR mode = Disabled (no check).
/// - `Err(String)` — verify failed AND mode = Enforcing.
///   Caller exits(1).
///
/// In Permissive mode, failures return `Ok(())` but log the
/// structured rejection reason.
pub fn verify_at_boot(
    mode: ConfigIntegrityMode,
    factory_pubkey_hex: Option<&str>,
    sidecar_path_override: Option<&Path>,
    config_yaml_path: &Path,
    device_id_str: &str,
    data_dir: &Path,
) -> Result<(), String> {
    if matches!(mode, ConfigIntegrityMode::Disabled) {
        info!("Config-integrity sidecar verification: Disabled (no check)");
        return Ok(());
    }

    info!(
        "Config-integrity sidecar verification: {:?} mode — starting",
        mode
    );

    let sidecar_path = sidecar_path_override
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_SIDECAR_PATH));

    let outcome = verify_at_boot_inner(
        factory_pubkey_hex,
        &sidecar_path,
        config_yaml_path,
        device_id_str,
        data_dir,
    );

    match (mode, outcome) {
        (ConfigIntegrityMode::Disabled, _) => Ok(()), // unreachable (early return above)
        (_, Ok(version)) => {
            info!(
                "Config-integrity verified successfully (config_version={})",
                version
            );
            // Advance highest-seen-version. Best-effort write;
            // failure is warn-logged but does not block boot.
            save_highest_seen_version(data_dir, version);
            Ok(())
        }
        (ConfigIntegrityMode::Permissive, Err(reason)) => {
            warn!(
                "Config-integrity verify FAILED in Permissive mode: {}. Boot continuing (Enforcing mode would exit). Audit-sink wires Sprint 6.2.",
                reason
            );
            Ok(())
        }
        (ConfigIntegrityMode::Enforcing, Err(reason)) => {
            error!(
                "Config-integrity verify FAILED in Enforcing mode: {}. Fail-closed boot.",
                reason
            );
            Err(reason)
        }
    }
}

/// Inner verify orchestration — returns `Ok(verified_version)`
/// on success, `Err(reason)` on failure.
fn verify_at_boot_inner(
    factory_pubkey_hex: Option<&str>,
    sidecar_path: &Path,
    config_yaml_path: &Path,
    device_id_str: &str,
    data_dir: &Path,
) -> Result<u64, String> {
    let hex = factory_pubkey_hex.ok_or_else(|| {
        "factory_pubkey_hex is None — Batch 42 coherence rule should have caught this at config load".to_string()
    })?;
    let pubkey = parse_factory_pubkey(hex)?;

    let expected_device = parse_device_id_from_uuid(device_id_str)?;

    let config_bytes = std::fs::read(config_yaml_path).map_err(|e| {
        format!(
            "Failed to read config.yaml at {}: {}",
            config_yaml_path.display(),
            e
        )
    })?;
    let actual_sha = compute_sha256(&config_bytes);

    let sidecar_bytes = std::fs::read(sidecar_path).map_err(|e| {
        format!(
            "Failed to read config-integrity sidecar at {}: {}",
            sidecar_path.display(),
            e
        )
    })?;
    let signed: SignedConfigMeta = serde_json::from_slice(&sidecar_bytes)
        .map_err(|e| format!("Failed to parse sidecar JSON at {}: {}", sidecar_path.display(), e))?;

    let highest_seen = load_highest_seen_version(data_dir);

    // verify_signature closure: plug the ed25519-dalek verify
    // into the Batch 9 closure-injection point. The signature
    // is valid iff the ed25519 primitive says so — no weaker
    // acceptance path.
    let verify_fn = |canonical: &[u8], sig_bytes: &[u8; 64]| -> bool {
        let sig = ed25519_dalek::Signature::from_bytes(sig_bytes);
        pubkey.verify_strict(canonical, &sig).is_ok()
    };

    let verified_meta = verify_config_integrity(
        &signed,
        &expected_device,
        highest_seen,
        &actual_sha,
        verify_fn,
    )
    .map_err(|e| format!("{:?}", e))?;

    Ok(verified_meta.config_version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_factory_pubkey_rejects_short_hex() {
        let result = parse_factory_pubkey("abcd");
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.contains("64 chars"), "msg: {}", msg);
    }

    #[test]
    fn parse_factory_pubkey_rejects_non_hex() {
        let result = parse_factory_pubkey(&"z".repeat(64));
        assert!(result.is_err());
    }

    #[test]
    fn parse_device_id_from_valid_uuid_succeeds() {
        let uuid = "fd23af6b-167f-4afd-a62a-ceace2a4046b";
        let result = parse_device_id_from_uuid(uuid);
        assert!(result.is_ok());
    }

    #[test]
    fn parse_device_id_from_invalid_uuid_fails() {
        let result = parse_device_id_from_uuid("not-a-uuid");
        assert!(result.is_err());
    }

    #[test]
    fn load_highest_seen_version_missing_file_returns_zero() {
        let tmp = std::env::temp_dir().join(format!("batch54-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let v = load_highest_seen_version(&tmp);
        assert_eq!(v, 0);
    }

    #[test]
    fn save_then_load_highest_seen_version_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("batch54-rt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        save_highest_seen_version(&tmp, 42);
        assert_eq!(load_highest_seen_version(&tmp), 42);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
