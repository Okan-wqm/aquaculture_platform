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

use serde_json::{Value, json};
use tracing::{info, warn};

use super::CommandHandler;
use crate::scripting::bytecode_deploy::{DeployError, verify_and_deploy};
use crate::scripting::bytecode_sig::SignedBytecode;
use crate::security::sanitize_for_log;

impl CommandHandler {
    pub(super) async fn cmd_deploy_bytecode_program(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing deploy_bytecode_program command (Faz 3 Batch 167)");

        // Pull AppState slices under a single read-guard.
        let (pubkey, tenant_str, registry, store, license, scan_cycle_ms) = {
            let state = self.state.read().await;
            (
                state.firmware_signing_pubkey.clone(),
                state.tenant_id.clone(),
                state.bytecode_registry.clone(),
                state.bytecode_registry_store.clone(),
                state.license.clone(),
                state.config.scripting.default_scan_cycle_ms,
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

        // Batch 215 Faz 7 wire: deploy-program license gate.
        // Runs BEFORE signature verify + registry insert so a
        // license-exceeded deploy costs zero signature-verify
        // cycles + leaves the registry untouched. Pending
        // counts computed against the post-deploy view:
        // - ST programs: existing count + 1 if new id, +0 if
        //   replacing existing (checked via get).
        // - FB instances: union of (existing programs minus
        //   the one being replaced) ∪ (incoming program's FBs).
        // - Scan cycle: configured default_scan_cycle_ms (the
        //   runtime cycle the agent actually uses).
        let incoming_program_id = signed.bytecode.program_id.clone();
        let existing_entry = registry.get(&incoming_program_id).await;
        let pending_st_programs = if existing_entry.is_some() {
            registry.len().await
        } else {
            registry.len().await + 1
        };
        let mut pending_fbs = registry
            .fb_instance_ids_except(Some(&incoming_program_id))
            .await;
        pending_fbs.extend(signed.bytecode.fb_instance_ids());
        let pending_fb_instances = pending_fbs.len();

        match crate::license::check_deploy_program_budget(
            pending_st_programs,
            pending_fb_instances,
            scan_cycle_ms,
            &license,
        ) {
            crate::license::DeployProgramBudget::WithinBudget { .. } => {}
            crate::license::DeployProgramBudget::StProgramCountExceeded { configured, cap } => {
                warn!(
                    "deploy_bytecode_program rejected: ST program cap (pending={} cap={} tier={})",
                    configured,
                    cap,
                    license.tier.as_str(),
                );
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "deploy_bytecode_program: license ST program cap reached (pending={} cap={} tier={}) — delete an existing program or upgrade tier",
                        configured,
                        cap,
                        license.tier.as_str(),
                    )),
                );
            }
            crate::license::DeployProgramBudget::FbInstanceCountExceeded { configured, cap } => {
                warn!(
                    "deploy_bytecode_program rejected: FB instance cap (pending={} cap={} tier={})",
                    configured,
                    cap,
                    license.tier.as_str(),
                );
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "deploy_bytecode_program: license FB instance cap reached (pending={} cap={} tier={}) — reduce FB usage or upgrade tier",
                        configured,
                        cap,
                        license.tier.as_str(),
                    )),
                );
            }
            crate::license::DeployProgramBudget::ScanCycleBelowFloor {
                configured_ms,
                min_ms,
            } => {
                warn!(
                    "deploy_bytecode_program rejected: scan_cycle below tier floor (configured_ms={} min_ms={} tier={})",
                    configured_ms,
                    min_ms,
                    license.tier.as_str(),
                );
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "deploy_bytecode_program: scan_cycle_ms ({}) below license min ({}ms) for tier={} — raise scripting.default_scan_cycle_ms or upgrade tier",
                        configured_ms,
                        min_ms,
                        license.tier.as_str(),
                    )),
                );
            }
        }

        // Delegate to the Batch 166 pipeline. Closure
        // wraps ed25519_dalek verify against the agent's
        // firmware_signing_pubkey.
        let verify_closure = |msg: &[u8], sig_bytes: &[u8; 64]| {
            // verify_strict rejects non-canonical R encodings and small-order
            // public keys (signature malleability) — mandatory on the firmware/
            // program-integrity boundary. Matches the crate-wide verify_strict SSoT.
            let sig = ed25519_dalek::Signature::from_bytes(sig_bytes);
            pubkey.verify_strict(msg, &sig).is_ok()
        };

        match verify_and_deploy(&registry, &signed, tenant_str.as_deref(), verify_closure).await {
            Ok(report) => {
                info!(
                    "deploy_bytecode_program: program_id={} policy_version={} replaced_existing={}",
                    sanitize_for_log(&report.program_id),
                    report.policy_version,
                    report.replaced_existing
                );

                // PR-195 Batch #20 (closes ORPHAN-D3-BOOT-ORDER-002
                // second half) — option-3 first-program-deploy
                // migration discipline: before persisting the
                // deploy to SQLCipher, ensure program-bound
                // consumer handles (bytecode_registry_store +
                // retain_persistence) are opened under the
                // current deploy's program_sha. Boot-time init
                // for v2 manifest hosts left these None
                // (program_sha unavailable at boot per Batch
                // #19); the deploy is the natural moment when
                // the SHA becomes available.
                //
                // The program_artifact_sha256 is the SHA-256
                // of the canonical bytecode bytes — same value
                // the migration ceremony would use, ensuring
                // the keystore yields the same v2 key.
                let store = match registry.get(&report.program_id).await {
                    Some(entry) => {
                        match crate::scripting::bytecode_sig::canonical_bytes(&entry.bytecode) {
                            Ok(canonical) => {
                                use sha2::{Digest, Sha256};
                                let mut h = Sha256::new();
                                h.update(&canonical);
                                let program_sha = h.finalize().to_vec();
                                let mut state_w = self.state.write().await;
                                state_w
                                    .try_open_program_bound_dbs_under_program_sha(program_sha)
                                    .await;
                                // Refresh the store handle —
                                // try_open_program_bound_dbs_*
                                // may have populated it from
                                // None to Some.
                                state_w.bytecode_registry_store.clone()
                            }
                            Err(e) => {
                                warn!(
                                    "deploy_bytecode_program: canonical_bytes failed for {}: {}; skipping option-3 post-deploy-open + falling back to pre-deploy store handle.",
                                    sanitize_for_log(&report.program_id),
                                    e
                                );
                                store
                            }
                        }
                    }
                    None => {
                        // Rare: registry insert succeeded but
                        // entry vanished. Skip post-deploy-open;
                        // save-back below will fail
                        // gracefully on the same lookup.
                        store
                    }
                };

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
                    DeployError::TenantMismatch { expected, got } => {
                        format!("tenant mismatch (expected={:?}, got={:?})", expected, got)
                    }
                    DeployError::Registry(inner) => inner.to_string(),
                    // Batch #298 ORPHAN-HIGH-020 closure variants —
                    // unreachable from cmd_deploy_bytecode_program
                    // (which only delegates to verify_and_deploy,
                    // never compile_and_deploy_signed_source). Keep
                    // an exhaustive match so a future variant addition
                    // surfaces here at compile time rather than
                    // silently routing through a `_` catch-all.
                    DeployError::StSourceSignatureInvalid
                    | DeployError::StSourceCanonicalEncoding { .. }
                    | DeployError::StSourceParseFailed { .. }
                    | DeployError::StSourceCompileFailed { .. } => {
                        format!(
                            "unexpected st-source variant in bytecode deploy path: {}",
                            e
                        )
                    }
                };
                (
                    false,
                    json!(null),
                    Some(format!("deploy_bytecode_program: {}", reason)),
                )
            }
        }
    }
}
