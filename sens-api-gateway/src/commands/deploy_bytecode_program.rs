//! `cmd_deploy_bytecode_program` — signed bytecode program deploy
//! (Batch 167 Faz 3 / plan R-1).
//!
//! ## WHY
//!
//! Plan §3 R-1 + §5 Faz 3 specify that operators push
//! compiled ST bytecode to the edge via an MQTT command
//! payload carrying the `SignedBytecode` JSON shape. The
//! edge verifies the ed25519 signature (Batch 158 — with
//! tenant + policy_version binding per Batch 165) +
//! inserts the program into the in-memory registry
//! (Batch 163) where the scan-cycle orchestrator
//! (Batch 164) picks it up on the next tick.
//!
//! Batch 167 lands the MQTT command handler — a thin
//! adapter that:
//! 1. Reads AppState slices (firmware_signing_pubkey +
//!    tenant_id + bytecode_registry) under a single
//!    read-guard.
//! 2. Deserializes the `SignedBytecode` from the command
//!    payload.
//! 3. Delegates to `bytecode_deploy::verify_and_deploy`
//!    (Batch 166) which runs signature + tenant +
//!    registry gates in order.
//! 4. Formats the `DeployReport` / `DeployError` as the
//!    standard (success, payload, error_message) tuple.
//!
//! ## Params
//!
//! ```json
//! {
//!   "signed_bytecode": { ...SignedBytecode... }
//! }
//! ```
//!
//! ## Success response
//!
//! ```json
//! {
//!   "deployed": true,
//!   "program_id": "...",
//!   "tenant_id": "...",
//!   "policy_version": 1,
//!   "replaced_existing": false
//! }
//! ```

use serde_json::{json, Value};
use tracing::{info, warn};

use super::CommandHandler;
use crate::scripting::bytecode_deploy::{verify_and_deploy, DeployError};
use crate::scripting::bytecode_sig::SignedBytecode;
use crate::security::sanitize_for_log;

impl CommandHandler {
    pub(super) async fn cmd_deploy_bytecode_program(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing deploy_bytecode_program command (Faz 3 Batch 167)");

        // Pull AppState slices under a single read-guard.
        let (pubkey, tenant_str, registry, store) = {
            let state = self.state.read().await;
            (
                state.firmware_signing_pubkey.clone(),
                state.tenant_id.clone(),
                state.bytecode_registry.clone(),
                state.bytecode_registry_store.clone(),
            )
        };

        let pubkey = match pubkey {
            Some(k) => k,
            None => {
                return (
                    false,
                    json!(null),
                    Some(
                        "deploy_bytecode_program rejected: firmware_signing_pubkey not wired. \
                         Set firmware_update.mode != Disabled + signing_pubkey_hex."
                            .to_string(),
                    ),
                );
            }
        };

        // Extract the `signed_bytecode` sub-object from
        // params. Missing field or malformed JSON →
        // operator-visible error.
        let signed_value = match params.get("signed_bytecode") {
            Some(v) => v,
            None => {
                return (
                    false,
                    json!(null),
                    Some(
                        "deploy_bytecode_program: missing required param `signed_bytecode`"
                            .to_string(),
                    ),
                );
            }
        };

        let signed: SignedBytecode = match serde_json::from_value(signed_value.clone()) {
            Ok(s) => s,
            Err(e) => {
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "deploy_bytecode_program: failed to parse SignedBytecode: {}",
                        sanitize_for_log(&e.to_string())
                    )),
                );
            }
        };

        // Delegate to the Batch 166 pipeline. Closure
        // wraps ed25519_dalek verify against the agent's
        // firmware_signing_pubkey.
        let verify_closure = |msg: &[u8], sig_bytes: &[u8; 64]| {
            use ed25519_dalek::Verifier;
            let sig = ed25519_dalek::Signature::from_bytes(sig_bytes);
            pubkey.verify(msg, &sig).is_ok()
        };

        match verify_and_deploy(
            &registry,
            &signed,
            tenant_str.as_deref(),
            verify_closure,
        )
        .await
        {
            Ok(report) => {
                info!(
                    "deploy_bytecode_program: program_id={} policy_version={} replaced_existing={}",
                    sanitize_for_log(&report.program_id),
                    report.policy_version,
                    report.replaced_existing
                );

                // Batch 169: persist to SQLCipher store so
                // the deploy survives reboot. Pulled-back
                // entry read from the in-memory registry
                // to capture the canonical ProgramEntry
                // shape (deployed_at timestamp + enabled
                // state) that `verify_and_deploy` built.
                //
                // Best-effort: a store-write failure
                // logs at warn + returns success because
                // the in-memory deploy IS live (the
                // scan-cycle orchestrator will pick it up
                // next tick). Operators investigate the
                // persistence failure separately.
                let persisted = if let Some(store_ref) = store.as_ref() {
                    match registry.get(&report.program_id).await {
                        Some(entry) => match store_ref.save(&entry) {
                            Ok(()) => true,
                            Err(e) => {
                                warn!(
                                    "deploy_bytecode_program: registry insert OK but store save failed for {}: {}. Deploy is live in-memory; operator must investigate SQLCipher.",
                                    sanitize_for_log(&report.program_id),
                                    e
                                );
                                false
                            }
                        },
                        None => {
                            // Rare: registry insert
                            // succeeded but the entry
                            // vanished before the save-
                            // back read. Log + treat as
                            // not-persisted.
                            warn!(
                                "deploy_bytecode_program: registry insert OK but entry missing at save-back read for {}",
                                sanitize_for_log(&report.program_id)
                            );
                            false
                        }
                    }
                } else {
                    false
                };

                (
                    true,
                    json!({
                        "deployed": true,
                        "program_id": report.program_id,
                        "tenant_id": report.tenant_id,
                        "policy_version": report.policy_version,
                        "replaced_existing": report.replaced_existing,
                        "persisted": persisted,
                    }),
                    None,
                )
            }
            Err(e) => {
                // Log at warn level — a failed deploy
                // is operator-visible but not fatal.
                // Each gate failure's Display impl
                // produces the operator-facing string.
                warn!("deploy_bytecode_program failed: {}", e);
                let reason = match &e {
                    DeployError::SignatureInvalid => "signature verification failed".to_string(),
                    DeployError::CanonicalEncoding { what } => {
                        format!("canonical encoding failed: {}", what)
                    }
                    DeployError::TenantMismatch { expected, got } => format!(
                        "tenant mismatch (expected={:?}, got={:?})",
                        expected, got
                    ),
                    DeployError::Registry(inner) => inner.to_string(),
                };
                (false, json!(null), Some(format!("deploy_bytecode_program: {}", reason)))
            }
        }
    }
}
