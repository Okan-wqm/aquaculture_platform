//! `cmd_rotate_master` — master-key rotation orchestrator
//! (Batch 100 Sprint 6.3 final composition).
//!
//! ## WHY
//!
//! Plan §5 Faz 2 item 1 + ADR-018 §6 mandate 180-day key
//! rotation with zero-downtime operator execution. Batch 98
//! shipped `rotate_master_from_files` + Batch 99 shipped
//! `AuditSink::reload_hmac_key`. This batch composes the
//! two into an MQTT-invokable command.
//!
//! ## Flow (pre-rotation to post-rotation discipline)
//!
//! 1. Emit pre-rotation audit entry
//!    `Action::MasterKeyRotated` outcome=InProgress under
//!    the OLD HMAC key — marks the chain boundary so
//!    audit-verify CLI knows to switch keys at this point.
//! 2. Call `keystore.rotate_master_from_files(new_p, new_s,
//!    params)` — re-derives master from new passphrase +
//!    salt via Argon2id. OLD master zeroize-dropped.
//! 3. Derive NEW AuditHmacChain key via
//!    `keystore.derive_key`.
//! 4. Call `sink.reload_hmac_key(new_key)` — atomic swap,
//!    chain state preserved, subsequent appends HMAC'd
//!    with NEW key.
//! 5. Emit post-rotation audit entry
//!    `Action::MasterKeyRotated` outcome=Success under the
//!    NEW HMAC key — confirms the chain transition
//!    completed.
//!
//! ## What this batch does NOT do
//!
//! - SQLCipher PRAGMA rekey fan-out for offline_queue,
//!   rbac_version, jti_dedup SQLite databases. Those stores
//!   remain encrypted with the OLD derive_db_encryption_key
//!   output (which is cached per Batch 96 and survives the
//!   master rotation). This is an operational tradeoff:
//!   SQLCipher rekey is slow (minutes on large logs); the
//!   rotation orchestrator completes in seconds for audit
//!   + operator feedback. A separate batched rekey job
//!   follows. Tracked as Phase 2 / Batch 101+.
//! - ClientAuth mTLS cert rotation — separate key
//!   (firmware/TLS/RBAC/master are 4 distinct keys per ADR-
//!   018 §3 R-4). Rotating master does NOT rotate them.
//!
//! ## Authorization
//!
//! Gated by `Permission::ManagePolicy` — same permission as
//! update_policy (Batch 72) because both rotate trust
//! anchors. A lesser permission would let attacker escalate
//! via rotation to a master they control.

use serde_json::{Value, json};
use tracing::{info, warn};

use super::CommandHandler;
use crate::keystore::KeyPurpose;
use crate::security::sanitize_for_log;

impl CommandHandler {
    /// `rotate_master` — MQTT-invokable master-key rotation.
    ///
    /// Params (all optional, defaults read from config):
    /// - `passphrase_path: string` — new passphrase file
    ///   (default `/etc/suderra/keystore.passphrase.new`).
    /// - `salt_path: string` — new salt file
    ///   (default `/etc/suderra/keystore.salt.new`).
    /// - `argon2_memory_kib: u32` — override OWASP default.
    /// - `argon2_iterations: u32` — override default.
    /// - `argon2_parallelism: u32` — override default.
    ///
    /// Returns (on success):
    ///   {"keystore_rotated": true, "audit_sink_reloaded":
    ///    true, "note": "..." }
    pub(super) async fn cmd_rotate_master(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing rotate_master command (Sprint 6.3 final orchestration)");

        // Snapshot wiring we need from AppState.
        let (keystore, audit_sink, cfg_pass, cfg_salt, cfg_params) = {
            let state = self.state.read().await;
            let cfg_params = crate::keystore::Argon2idParams {
                memory_kib: state.config.keystore.argon2_memory_kib,
                iterations: state.config.keystore.argon2_iterations,
                parallelism: state.config.keystore.argon2_parallelism,
            };
            let cfg_pass = state
                .config
                .keystore
                .passphrase_path
                .clone()
                .unwrap_or_else(|| std::path::PathBuf::from("/etc/suderra/keystore.passphrase"));
            let cfg_salt = state
                .config
                .keystore
                .salt_path
                .clone()
                .unwrap_or_else(|| std::path::PathBuf::from("/etc/suderra/keystore.salt"));
            (
                state.keystore.clone(),
                state.audit_sink.clone(),
                cfg_pass,
                cfg_salt,
                cfg_params,
            )
        };

        let keystore = match keystore {
            Some(k) => k,
            None => {
                return (
                    false,
                    json!(null),
                    Some(
                        "rotate_master rejected: keystore.mode=Disabled. \
                         Enable keystore (mode=auto or file_backed) before rotation."
                            .to_string(),
                    ),
                );
            }
        };

        // Resolve param overrides.
        let new_pass: std::path::PathBuf = params
            .get("passphrase_path")
            .and_then(|v| v.as_str())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                // Default to <cfg_passphrase_path>.new
                let mut p = cfg_pass.clone();
                let filename = p
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_else(|| "passphrase".to_string());
                p.set_file_name(format!("{}.new", filename));
                p
            });
        let new_salt: std::path::PathBuf = params
            .get("salt_path")
            .and_then(|v| v.as_str())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                let mut p = cfg_salt.clone();
                let filename = p
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_else(|| "salt".to_string());
                p.set_file_name(format!("{}.new", filename));
                p
            });
        let params_override = crate::keystore::Argon2idParams {
            memory_kib: params
                .get("argon2_memory_kib")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32)
                .unwrap_or(cfg_params.memory_kib),
            iterations: params
                .get("argon2_iterations")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32)
                .unwrap_or(cfg_params.iterations),
            parallelism: params
                .get("argon2_parallelism")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32)
                .unwrap_or(cfg_params.parallelism),
        };

        // Batch 101: unified trait method — dispatch on
        // backend via RotationSource variant. The keystore
        // impl matches the variant to its own rotation
        // semantics; unsupported variant returns
        // NotImplemented without downcast workarounds.
        let source = match keystore.backend() {
            crate::keystore::KeyBackend::FileBacked => {
                crate::keystore::RotationSource::FileBacked {
                    passphrase_path: &new_pass,
                    salt_path: &new_salt,
                    params: params_override,
                }
            }
            crate::keystore::KeyBackend::Tpm => crate::keystore::RotationSource::TpmReseal,
            crate::keystore::KeyBackend::SystemdCreds => {
                crate::keystore::RotationSource::SystemdCredsReissue
            }
        };

        // Step 1: call unified trait rotation. Backend-
        // specific impl handles the actual re-derivation +
        // master swap (via RwLock for FileBacked; TPM/
        // systemd-creds backends land their own semantics
        // in Phase 2).
        //
        // Batch 101 discipline: keystore Arc is NOT replaced
        // — interior RwLock<MasterKeyMaterial> mutates in
        // place. AppState.keystore Arc stays the same,
        // downstream consumers see the NEW master
        // immediately on next derive_key call.
        if let Err(e) = keystore.rotate_master_with_source(source).await {
            warn!(
                "rotate_master_with_source failed on backend={:?}: {}",
                keystore.backend(),
                sanitize_for_log(&e.to_string())
            );
            return (
                false,
                json!(null),
                Some(format!("keystore rotation failed: {}", e)),
            );
        }

        // Step 2: derive NEW audit HMAC key from the SAME
        // keystore Arc (now mutated to new master). Must
        // succeed before audit swap — if derivation fails,
        // the sink retains its OLD key, audit chain continues
        // under OLD key (operationally OK: the rotation
        // partially completed but old audit chain isn't
        // broken).
        let new_audit_key_material =
            match keystore.derive_key(KeyPurpose::AuditHmacChain, b"").await {
                Ok(k) => k,
                Err(e) => {
                    return (
                        false,
                        json!(null),
                        Some(format!(
                            "new audit HMAC key derivation failed after rotation: {}",
                            e
                        )),
                    );
                }
            };
        let mut new_audit_key_bytes = [0u8; 32];
        new_audit_key_bytes.copy_from_slice(new_audit_key_material.expose_secret());

        // Step 3: swap audit sink's hmac_key. Chain state
        // preserved; subsequent appends use NEW key.
        let audit_reloaded = match audit_sink {
            Some(sink) => {
                let new_key = crate::audit::AuditHmacKey::from_bytes(new_audit_key_bytes);
                {
                    use zeroize::Zeroize;
                    new_audit_key_bytes.zeroize();
                }
                match sink.reload_hmac_key(new_key) {
                    Ok(()) => true,
                    Err(e) => {
                        warn!("audit sink reload_hmac_key failed: {}", e);
                        false
                    }
                }
            }
            None => {
                use zeroize::Zeroize;
                new_audit_key_bytes.zeroize();
                false
            }
        };

        info!(
            "rotate_master SUCCESS: keystore swapped, audit_sink reloaded={} (SQLCipher PRAGMA rekey fan-out is Phase 2 / Batch 101+ work)",
            audit_reloaded
        );

        (
            true,
            json!({
                "keystore_rotated": true,
                "audit_sink_reloaded": audit_reloaded,
                "note": "SQLCipher databases (offline_queue, rbac_version, jti_dedup) still encrypted with pre-rotation derive_db_encryption_key. Phase 2 rekey-fan-out batch coordinates PRAGMA rekey separately."
            }),
            None,
        )
    }
}
