//! `cmd_deploy_bundle` — two-phase release-bundle apply (enterprise
//! plan Faz 5).
//!
//! ## Why this handler exists
//!
//! The unified SCADA deploy used to arrive as N+1 independent
//! fire-and-forget commands (programs first, then the package). A
//! broker outage or crash between them left the device half-deployed
//! with no record of it, and nothing verified that the artifacts that
//! arrived were the artifacts the operator approved.
//!
//! ## Two-phase discipline
//!
//! ```text
//!   VERIFY (nothing applied):
//!     1. sha256(manifest bytes) == manifestSha256
//!     2. ed25519 over tenant + manifestSha256 (domain tag bundle-v1)
//!        — REQUIRED; unsigned bundles do not exist (greenfield
//!        command, no legacy senders)
//!     3. manifest parses; bundleId matches; every artifact's content
//!        bytes hash to its manifest-pinned sha256; every content
//!        parses into its typed struct
//!   STAGED ack (unsolicited CommandResponse, phase="staged")
//!   APPLY (all under ONE deploy-lock acquisition):
//!     programs (same engine path as cmd_deploy_program), then
//!     processes, then packages
//!   CONFIRMED / FAILED final command response (phase field)
//! ```
//!
//! A verification failure of ANY member rejects the WHOLE bundle with
//! nothing applied — pinned by the unit tests below. Content
//! addressing operates on the exact byte sequences the cloud hashed
//! (`manifest` and each `contents` value are strings), so no
//! cross-language JSON canonicalization exists to drift.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;
#[cfg(feature = "scada-display")]
use serde_json::json;
use sha2::{Digest, Sha256};
#[cfg(feature = "scada-display")]
use tracing::{error, info, warn};

#[cfg(feature = "scada-display")]
use crate::mqtt::{CommandMessage, CommandResponse};
use crate::scripting::deploy_sig::{
    DeployArtifactKind, DeploySigBody, parse_signature_hex, verify_deploy_signature,
};

#[cfg(feature = "scada-display")]
use super::CommandHandler;

/// Wire params of the `deploy_bundle` command (camelCase, mirrors
/// `DEPLOY_BUNDLE_PARAMS_SCHEMA` in @platform/sensor-contracts).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeployBundleParams {
    pub bundle_id: String,
    /// Exact canonical-JSON bytes of the manifest (hashed + signed).
    pub manifest: String,
    pub manifest_sha256: String,
    /// ed25519 hex over tenant + manifestSha256, domain tag bundle-v1.
    pub signature: String,
    /// sha256(hex) → exact canonical-JSON bytes of that artifact.
    pub contents: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleManifest {
    bundle_id: String,
    artifacts: Vec<BundleArtifactRef>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleArtifactRef {
    artifact_id: String,
    kind: String,
    sha256: String,
    /// Source entity version — stamped into applied SCADA package meta.
    #[serde(default)]
    version: Option<u32>,
}

/// One artifact that passed EVERY verification gate, staged for apply.
#[derive(Debug)]
pub(crate) enum StagedArtifact {
    Program {
        params: Value,
    },
    #[cfg(feature = "scada-display")]
    Process {
        process: crate::scada_server::ScadaProcess,
    },
    #[cfg(feature = "scada-display")]
    ScadaPackage {
        package: crate::scada_types::ScadaPackage,
    },
}

#[derive(Debug)]
pub(crate) struct VerifiedBundle {
    pub bundle_id: String,
    pub staged: Vec<StagedArtifact>,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Pure verification stage — NOTHING is applied here, so any `Err`
/// means the device state is untouched (the "broken checksum applies
/// nothing" invariant lives in this function's purity).
pub(crate) fn verify_bundle(
    params: &DeployBundleParams,
    tenant_id: Option<String>,
    verify_signature: impl FnOnce(&[u8], &[u8; 64]) -> bool,
) -> Result<VerifiedBundle, String> {
    // Gate 1: manifest bytes hash to the signed value.
    let actual_manifest_sha = sha256_hex(params.manifest.as_bytes());
    if actual_manifest_sha != params.manifest_sha256 {
        return Err(format!(
            "manifest sha256 mismatch (claimed {}…, actual {}…) — bundle rejected, nothing staged",
            &params.manifest_sha256.get(..12).unwrap_or(""),
            &actual_manifest_sha.get(..12).unwrap_or(""),
        ));
    }

    // Gate 2: signature is REQUIRED and must verify.
    let sig = parse_signature_hex(&params.signature).ok_or_else(|| {
        "bundle signature malformed: expected 128 lowercase hex chars".to_string()
    })?;
    let body = DeploySigBody {
        kind: DeployArtifactKind::Bundle,
        tenant_id,
        artifact_sha256_hex: params.manifest_sha256.clone(),
    };
    verify_deploy_signature(&body, &sig, verify_signature)
        .map_err(|e| format!("bundle signature verification failed: {}", e))?;

    // Gate 3: manifest parses and names this bundle.
    let manifest: BundleManifest = serde_json::from_str(&params.manifest)
        .map_err(|e| format!("manifest does not parse: {}", e))?;
    if manifest.bundle_id != params.bundle_id {
        return Err(format!(
            "manifest bundleId {} does not match params bundleId {}",
            manifest.bundle_id, params.bundle_id
        ));
    }
    if manifest.artifacts.is_empty() {
        return Err("manifest carries no artifacts".to_string());
    }

    // Gate 4: every artifact's bytes hash to the manifest-pinned sha256
    // and parse into the typed struct for its kind.
    let mut staged = Vec::with_capacity(manifest.artifacts.len());
    for artifact in &manifest.artifacts {
        let content = params.contents.get(&artifact.sha256).ok_or_else(|| {
            format!(
                "content for artifact {} (sha {}…) missing from bundle",
                artifact.artifact_id,
                &artifact.sha256.get(..12).unwrap_or(""),
            )
        })?;
        let actual_sha = sha256_hex(content.as_bytes());
        if actual_sha != artifact.sha256 {
            return Err(format!(
                "artifact {} checksum mismatch (manifest {}…, actual {}…) — bundle rejected, nothing staged",
                artifact.artifact_id,
                &artifact.sha256.get(..12).unwrap_or(""),
                &actual_sha.get(..12).unwrap_or(""),
            ));
        }
        let value: Value = serde_json::from_str(content).map_err(|e| {
            format!(
                "artifact {} does not parse as JSON: {}",
                artifact.artifact_id, e
            )
        })?;

        match artifact.kind.as_str() {
            "automation_program" => {
                // Full typed validation now; the apply stage re-parses
                // inside the canonical deploy path.
                let _program: crate::commands::ProgramDefinition =
                    serde_json::from_value(value.clone()).map_err(|e| {
                        format!(
                            "artifact {} is not a valid ProgramDefinition: {}",
                            artifact.artifact_id, e
                        )
                    })?;
                staged.push(StagedArtifact::Program { params: value });
            }
            #[cfg(feature = "scada-display")]
            "process" => {
                let process: crate::scada_server::ScadaProcess = serde_json::from_value(value)
                    .map_err(|e| {
                        format!(
                            "artifact {} is not a valid ScadaProcess: {}",
                            artifact.artifact_id, e
                        )
                    })?;
                staged.push(StagedArtifact::Process { process });
            }
            #[cfg(feature = "scada-display")]
            "scada_package" => {
                let mut package: crate::scada_types::ScadaPackage = serde_json::from_value(value)
                    .map_err(|e| {
                    format!(
                        "artifact {} is not a valid ScadaPackage: {}",
                        artifact.artifact_id, e
                    )
                })?;
                if package.screens.is_empty() {
                    return Err(format!(
                        "artifact {} package must have at least one screen",
                        artifact.artifact_id
                    ));
                }
                // Version truth comes from the SIGNED manifest, not the
                // (content-addressed, version-free) document body.
                if let Some(version) = artifact.version {
                    package.meta.version = version;
                }
                staged.push(StagedArtifact::ScadaPackage { package });
            }
            other => {
                return Err(format!(
                    "artifact {} has unsupported kind \"{}\"",
                    artifact.artifact_id, other
                ));
            }
        }
    }

    Ok(VerifiedBundle {
        bundle_id: manifest.bundle_id,
        staged,
    })
}

/// Pure decision for the apply-phase-failure ack (EDGE-HIGH-008).
///
/// After a mid-apply fault the handler rolls the touched sinks back to
/// their pre-images and collects any restore errors. This function turns
/// that outcome into the final command response:
///
/// * no restore errors → `phase: "rolled_back"` — the device is back at
///   its exact pre-bundle state; the bundle applied NOTHING net.
/// * one or more restore errors → `phase: "failed"` (stage `rollback`) —
///   the rollback itself faulted, so the device is in a mixed state and
///   an operator must intervene; the offending sinks are named.
///
/// Both outcomes are `success = false`. Extracted so the phase/ack
/// semantics are unit-tested without a live device.
#[cfg(feature = "scada-display")]
fn summarize_apply_rollback(
    bundle_id: &str,
    apply_error: &str,
    restore_errors: &[String],
) -> (bool, Value, Option<String>) {
    if restore_errors.is_empty() {
        (
            false,
            serde_json::json!({
                "bundleId": bundle_id,
                "phase": "rolled_back",
                "stage": "apply",
            }),
            Some(format!(
                "apply failed and was rolled back to the pre-bundle state: {}",
                apply_error
            )),
        )
    } else {
        (
            false,
            serde_json::json!({
                "bundleId": bundle_id,
                "phase": "failed",
                "stage": "rollback",
                "restoreErrors": restore_errors,
            }),
            Some(format!(
                "apply failed ({}) AND rollback failed ({}) — manual intervention required",
                apply_error,
                restore_errors.join("; ")
            )),
        )
    }
}

#[cfg(feature = "scada-display")]
impl CommandHandler {
    /// Two-phase bundle apply. Takes the FULL command (not just params)
    /// because the intermediate STAGED ack rides the responses topic
    /// under the bundle's commandId.
    pub(in crate::commands) async fn cmd_deploy_bundle(
        &self,
        command: &CommandMessage,
    ) -> (bool, Value, Option<String>) {
        let _deploy_guard = self.deploy_lock.lock().await;
        info!("Executing deploy_bundle command");

        let params: DeployBundleParams = match serde_json::from_value(command.params.clone()) {
            Ok(p) => p,
            Err(e) => {
                return (
                    false,
                    json!({ "phase": "failed", "stage": "parse" }),
                    Some(format!("Invalid deploy_bundle params: {}", e)),
                );
            }
        };
        let bundle_id = params.bundle_id.clone();

        let (tenant_id, pubkey, scada_state, device_id) = {
            let state = self.state.read().await;
            (
                state.tenant_id.clone(),
                state.firmware_signing_pubkey.clone(),
                state.scada_state.clone(),
                state.config.device_id.clone(),
            )
        };

        // Bundles REQUIRE the verify key — there is no unsigned mode.
        let Some(pubkey) = pubkey else {
            return (
                false,
                json!({ "bundleId": bundle_id, "phase": "failed", "stage": "verify" }),
                Some(
                    "deploy_bundle rejected: firmware_signing_pubkey not wired. \
                     Set firmware_update.mode != Disabled + signing_pubkey_hex."
                        .to_string(),
                ),
            );
        };

        // VERIFY — pure; nothing applied on failure.
        let verified = match verify_bundle(&params, tenant_id, |msg, sig_bytes| {
            use ed25519_dalek::Verifier;
            pubkey
                .verify(msg, &ed25519_dalek::Signature::from_bytes(sig_bytes))
                .is_ok()
        }) {
            Ok(v) => v,
            Err(e) => {
                warn!("deploy_bundle {} verification failed: {}", bundle_id, e);
                return (
                    false,
                    json!({ "bundleId": bundle_id, "phase": "failed", "stage": "verify" }),
                    Some(e),
                );
            }
        };

        // From here on the SIGNED manifest's bundle id is the truth.
        let bundle_id = verified.bundle_id.clone();

        let needs_scada = verified.staged.iter().any(|a| {
            matches!(
                a,
                StagedArtifact::Process { .. } | StagedArtifact::ScadaPackage { .. }
            )
        });
        let scada_state = match (needs_scada, scada_state) {
            (true, None) => {
                return (
                    false,
                    json!({ "bundleId": bundle_id, "phase": "failed", "stage": "verify" }),
                    Some("SCADA display feature not initialized".to_string()),
                );
            }
            (_, s) => s,
        };

        // STAGED ack — everything verified, nothing applied yet.
        let staged_count = verified.staged.len();
        {
            let state = self.state.read().await;
            let staged_response = CommandResponse {
                command_id: command.command_id.clone(),
                device_id: device_id.clone(),
                success: true,
                result: json!({
                    "bundleId": bundle_id,
                    "phase": "staged",
                    "artifacts": staged_count,
                }),
                timestamp: chrono::Utc::now().to_rfc3339(),
                error: None,
            };
            crate::publish_helpers::publish_response(&state, &staged_response).await;
        }
        info!(
            "deploy_bundle {} staged ({} artifact(s)) — applying atomically",
            bundle_id, staged_count
        );

        // Capture a pre-image of EXACTLY the sinks this bundle mutates,
        // so a runtime fault mid-apply can restore the device to its
        // pre-bundle state (true all-or-nothing, not honest-partial-apply
        // — EDGE-HIGH-008). Nothing outside the touched sinks is read or
        // written, so a package-only bundle never disturbs the program
        // sink. deploy_program_locked is already self-atomic on its own
        // failure; these pre-images cover the cross-artifact case where an
        // EARLIER artifact applied and a LATER one faulted.
        let touches_program = verified
            .staged
            .iter()
            .any(|a| matches!(a, StagedArtifact::Program { .. }));
        let touches_process = verified
            .staged
            .iter()
            .any(|a| matches!(a, StagedArtifact::Process { .. }));
        let touches_package = verified
            .staged
            .iter()
            .any(|a| matches!(a, StagedArtifact::ScadaPackage { .. }));
        let program_pre = if touches_program {
            Some(self.load_program_state())
        } else {
            None
        };
        let (process_pre, package_pre) = match scada_state.as_ref() {
            Some(s) => (
                if touches_process {
                    Some(s.get_process().await)
                } else {
                    None
                },
                if touches_package {
                    Some(s.get_package().await)
                } else {
                    None
                },
            ),
            None => (None, None),
        };

        // APPLY — all under the single deploy-lock acquisition above.
        let applied_at = chrono::Utc::now().to_rfc3339();
        let mut applied_programs = 0usize;
        let mut applied_processes = 0usize;
        let mut applied_packages = 0usize;
        for artifact in verified.staged {
            let apply_result: Result<(), String> = match artifact {
                StagedArtifact::Program { params } => {
                    let (ok, _result, error) = self.deploy_program_locked(&params).await;
                    if ok {
                        applied_programs += 1;
                        Ok(())
                    } else {
                        Err(error.unwrap_or_else(|| "program apply failed".to_string()))
                    }
                }
                StagedArtifact::Process { process } => match scada_state.as_ref() {
                    Some(s) => match s.deploy_process(process).await {
                        Ok(()) => {
                            applied_processes += 1;
                            Ok(())
                        }
                        Err(e) => Err(e),
                    },
                    None => Err("SCADA display feature not initialized".to_string()),
                },
                StagedArtifact::ScadaPackage { mut package } => {
                    package.meta.deployed_by = Some(format!("bundle:{}", bundle_id));
                    package.meta.deployed_at = Some(applied_at.clone());
                    match scada_state.as_ref() {
                        Some(s) => match s.deploy_package(package).await {
                            Ok(()) => {
                                applied_packages += 1;
                                Ok(())
                            }
                            Err(e) => Err(e),
                        },
                        None => Err("SCADA display feature not initialized".to_string()),
                    }
                }
            };

            if let Err(apply_err) = apply_result {
                // Verification already passed, so this is a runtime apply
                // fault mid-bundle. Roll the touched sinks back to their
                // pre-images in REVERSE apply order (package, process,
                // program) so the device returns to its exact pre-bundle
                // state. A pre-image of None means the sink was empty
                // before the bundle → clear it.
                warn!(
                    "deploy_bundle {} apply failed mid-bundle: {} — rolling back",
                    bundle_id, apply_err
                );
                let mut restore_errors: Vec<String> = Vec::new();

                if let (Some(pre), Some(s)) = (package_pre, scada_state.as_ref()) {
                    let restored = match pre {
                        Some(prior) => s.deploy_package(prior).await,
                        None => s.clear_package().await,
                    };
                    if let Err(e) = restored {
                        restore_errors.push(format!("package: {}", e));
                    }
                }
                if let (Some(pre), Some(s)) = (process_pre, scada_state.as_ref()) {
                    let restored = match pre {
                        Some(prior) => s.deploy_process(prior).await,
                        None => s.clear_process().await,
                    };
                    if let Err(e) = restored {
                        restore_errors.push(format!("process: {}", e));
                    }
                }
                if let Some(prior) = program_pre.as_ref() {
                    if let Err(e) = self.restore_program_state(prior).await {
                        restore_errors.push(format!("program: {}", e));
                    }
                }

                if restore_errors.is_empty() {
                    info!(
                        "deploy_bundle {} rolled back to pre-bundle state after apply fault",
                        bundle_id
                    );
                } else {
                    error!(
                        "deploy_bundle {} rollback FAILED ({}) — device in mixed state, manual intervention required",
                        bundle_id,
                        restore_errors.join("; ")
                    );
                }
                return summarize_apply_rollback(&bundle_id, &apply_err, &restore_errors);
            }
        }

        info!(
            "deploy_bundle {} confirmed (programs={}, processes={}, packages={})",
            bundle_id, applied_programs, applied_processes, applied_packages
        );
        (
            true,
            json!({
                "bundleId": bundle_id,
                "phase": "confirmed",
                "appliedPrograms": applied_programs,
                "appliedProcesses": applied_processes,
                "appliedPackages": applied_packages,
            }),
            None,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey, Verifier};

    fn sign_manifest(manifest: &str, tenant: &str) -> (String, String) {
        let sha = sha256_hex(manifest.as_bytes());
        let body = DeploySigBody {
            kind: DeployArtifactKind::Bundle,
            tenant_id: Some(tenant.to_string()),
            artifact_sha256_hex: sha.clone(),
        };
        let canonical = crate::scripting::deploy_sig::canonical_bytes(&body).expect("canonical");
        let key = SigningKey::from_bytes(&[1u8; 32]);
        let signature = key.sign(&canonical);
        let sig_hex: String = signature
            .to_bytes()
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        (sha, sig_hex)
    }

    fn verifier() -> impl FnOnce(&[u8], &[u8; 64]) -> bool {
        let key = SigningKey::from_bytes(&[1u8; 32]).verifying_key();
        move |msg: &[u8], sig: &[u8; 64]| {
            key.verify(msg, &ed25519_dalek::Signature::from_bytes(sig))
                .is_ok()
        }
    }

    const TENANT: &str = "tenant-42";

    /// Minimal valid program content (snake_case nested per the Faz 4
    /// contract) as the exact byte string that gets hashed.
    fn program_content() -> String {
        r#"{"executionMode":"scan_cycle","functionBlocks":[],"id":"prog-1","name":"P","scanCycleMs":100,"script":{"actions":[{"type":"noop"}],"conditions":[],"enabled":true,"id":"script-p","name":"P","triggers":[{"type":"startup"}]},"version":1}"#
            .to_string()
    }

    fn make_params(mutate: impl FnOnce(&mut DeployBundleParams)) -> DeployBundleParams {
        let content = program_content();
        let content_sha = sha256_hex(content.as_bytes());
        let manifest = format!(
            r#"{{"artifacts":[{{"artifactId":"11111111-1111-4111-8111-111111111111","kind":"automation_program","sha256":"{}"}}],"bundleId":"22222222-2222-4222-8222-222222222222"}}"#,
            content_sha
        );
        let (manifest_sha, signature) = sign_manifest(&manifest, TENANT);
        let mut contents = HashMap::new();
        contents.insert(content_sha, content);
        let mut params = DeployBundleParams {
            bundle_id: "22222222-2222-4222-8222-222222222222".to_string(),
            manifest,
            manifest_sha256: manifest_sha,
            signature,
            contents,
        };
        mutate(&mut params);
        params
    }

    #[test]
    fn happy_path_stages_every_artifact() {
        let params = make_params(|_| {});
        let verified =
            verify_bundle(&params, Some(TENANT.to_string()), verifier()).expect("verifies");
        assert_eq!(verified.bundle_id, params.bundle_id);
        assert_eq!(verified.staged.len(), 1);
        assert!(matches!(verified.staged[0], StagedArtifact::Program { .. }));
    }

    /// **The Faz 5 invariant:** a broken artifact checksum rejects the
    /// bundle during the PURE verify stage — nothing is applied because
    /// nothing CAN be applied from inside `verify_bundle`.
    #[test]
    fn broken_artifact_checksum_rejects_whole_bundle() {
        let params = make_params(|p| {
            // Tamper one byte of the content — sha no longer matches.
            let (sha, content) = p.contents.drain().next().expect("one artifact");
            p.contents
                .insert(sha, content.replace("scan_cycle", "event_drive"));
        });
        let err =
            verify_bundle(&params, Some(TENANT.to_string()), verifier()).expect_err("must reject");
        assert!(err.contains("checksum mismatch"), "got: {}", err);
        assert!(err.contains("nothing staged"), "got: {}", err);
    }

    #[test]
    fn tampered_manifest_fails_hash_gate_before_signature() {
        let params = make_params(|p| {
            p.manifest = p
                .manifest
                .replace("automation_program", "automation_programX");
        });
        let err =
            verify_bundle(&params, Some(TENANT.to_string()), verifier()).expect_err("must reject");
        assert!(err.contains("manifest sha256 mismatch"), "got: {}", err);
    }

    #[test]
    fn wrong_tenant_fails_signature() {
        let params = make_params(|_| {});
        let err = verify_bundle(&params, Some("tenant-99".to_string()), verifier())
            .expect_err("must reject");
        assert!(
            err.contains("signature verification failed"),
            "got: {}",
            err
        );
    }

    #[test]
    fn missing_signature_material_is_rejected() {
        let params = make_params(|p| {
            p.signature = "zz".to_string();
        });
        let err =
            verify_bundle(&params, Some(TENANT.to_string()), verifier()).expect_err("must reject");
        assert!(err.contains("signature malformed"), "got: {}", err);
    }

    #[test]
    fn missing_content_for_manifest_artifact_is_rejected() {
        let params = make_params(|p| {
            p.contents.clear();
        });
        let err =
            verify_bundle(&params, Some(TENANT.to_string()), verifier()).expect_err("must reject");
        assert!(err.contains("missing from bundle"), "got: {}", err);
    }

    #[test]
    fn unknown_artifact_kind_is_rejected() {
        let content = program_content();
        let content_sha = sha256_hex(content.as_bytes());
        let manifest = format!(
            r#"{{"artifacts":[{{"artifactId":"11111111-1111-4111-8111-111111111111","kind":"mystery_blob","sha256":"{}"}}],"bundleId":"22222222-2222-4222-8222-222222222222"}}"#,
            content_sha
        );
        let (manifest_sha, signature) = sign_manifest(&manifest, TENANT);
        let mut contents = HashMap::new();
        contents.insert(content_sha, content);
        let params = DeployBundleParams {
            bundle_id: "22222222-2222-4222-8222-222222222222".to_string(),
            manifest,
            manifest_sha256: manifest_sha,
            signature,
            contents,
        };
        let err =
            verify_bundle(&params, Some(TENANT.to_string()), verifier()).expect_err("must reject");
        assert!(err.contains("unsupported kind"), "got: {}", err);
    }

    #[test]
    fn bundle_id_mismatch_is_rejected() {
        let params = make_params(|p| {
            p.bundle_id = "33333333-3333-4333-8333-333333333333".to_string();
        });
        let err =
            verify_bundle(&params, Some(TENANT.to_string()), verifier()).expect_err("must reject");
        assert!(
            err.contains("does not match params bundleId"),
            "got: {}",
            err
        );
    }

    /// EDGE-HIGH-008: an apply fault that is fully rolled back reports
    /// `rolled_back` — the device is at its pre-bundle state, so the
    /// bundle applied nothing net (still success=false: it did NOT
    /// deploy). The old code reported `failed` with a partial
    /// `appliedPrograms` count and left the device half-deployed.
    #[cfg(feature = "scada-display")]
    #[test]
    fn rolled_back_apply_reports_rolled_back_and_no_partial_counts() {
        let (success, result, err) =
            summarize_apply_rollback("bundle-1", "package apply: disk full", &[]);
        assert!(!success);
        assert_eq!(result["phase"], "rolled_back");
        assert_eq!(result["stage"], "apply");
        assert_eq!(result["bundleId"], "bundle-1");
        // No appliedPrograms/Processes/Packages leak — the device is at
        // the pre-bundle state, not partially deployed.
        assert!(result.get("appliedPrograms").is_none());
        assert!(result.get("appliedProcesses").is_none());
        assert!(result.get("appliedPackages").is_none());
        assert!(err.expect("message").contains("rolled back"));
    }

    /// When the rollback ITSELF faults the device is in a mixed state;
    /// the ack is honest `failed` (stage `rollback`), names the sinks
    /// that could not be restored, and demands manual intervention.
    #[cfg(feature = "scada-display")]
    #[test]
    fn failed_rollback_reports_failed_with_restore_errors() {
        let restore_errors = vec![
            "package: disk full".to_string(),
            "process: permission denied".to_string(),
        ];
        let (success, result, err) =
            summarize_apply_rollback("bundle-2", "process apply: io error", &restore_errors);
        assert!(!success);
        assert_eq!(result["phase"], "failed");
        assert_eq!(result["stage"], "rollback");
        let reported = result["restoreErrors"]
            .as_array()
            .expect("restoreErrors array");
        assert_eq!(reported.len(), 2);
        let msg = err.expect("message");
        assert!(msg.contains("rollback failed"), "got: {}", msg);
        assert!(msg.contains("manual intervention"), "got: {}", msg);
        // Carries BOTH the original apply error and the restore errors.
        assert!(msg.contains("io error"), "got: {}", msg);
        assert!(msg.contains("disk full"), "got: {}", msg);
    }
}
