//! `cmd_deploy_st_source` — operator-signed ST source deploy
//! (Batch #299 ORPHAN-HIGH-020 closure).
//!
//! ## WHY
//!
//! Plan §3 R-1 + Plan B Faz 3 specify that operators push ST
//! source code to the edge — the edge compiles in-place to
//! Bytecode and runs the program. Pre-Batch-#299 the only
//! deploy entry was `cmd_deploy_bytecode_program` which
//! accepted PRE-COMPILED `SignedBytecode` artifacts only;
//! operators had to run the AST→bytecode pipeline cloud-side.
//!
//! Batch #297 landed the `SignedStSource` primitive (operator
//! signs the SOURCE bytes via the firmware_signing_pubkey;
//! cross-format confusion mitigated via distinct magic +
//! domain tag). Batch #298 landed the
//! `compile_and_deploy_signed_source` 6-gate orchestrator
//! (verify → tenant → parse_st → compile_program → tag with
//! body claims → registry insert).
//!
//! This batch lands the THIN MQTT command handler:
//!
//! 1. Pulls AppState slices (firmware_signing_pubkey +
//!    tenant_id + bytecode_registry + tag catalog from
//!    process_image + license + scan_cycle_ms) under a single
//!    read-guard.
//! 2. Deserializes the `SignedStSource` from the command
//!    payload.
//! 3. Runs the same Faz 7 license gate
//!    (`check_deploy_program_budget`) the SignedBytecode path
//!    runs — license cap discipline applies regardless of
//!    which signed format the operator chose.
//! 4. Builds `Vec<TagDescriptor>` from the agent's tag
//!    catalog so `compile_program` can resolve in-source tag
//!    references.
//! 5. Delegates to `compile_and_deploy_signed_source` — that
//!    function owns the gate-order discipline; this handler
//!    is structurally a thin adapter.
//! 6. Maps DeployError variants to operator-visible reason
//!    strings (parse error count surfaces; first error
//!    diagnostic surfaces; compile error reason surfaces;
//!    cross-tenant + signature failures get distinct
//!    messages).
//!
//! ## Params
//!
//! ```json
//! {
//!   "signed_st_source": { ...SignedStSource... }
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
//!   "replaced_existing": false,
//!   "compiled_from_source": true,
//!   "persisted": true
//! }
//! ```
//!
//! `compiled_from_source: true` discriminates this path from
//! the SignedBytecode path so operator audit dashboards can
//! flag source-compile deploys distinctly (different audit
//! UX — operators need to see WHICH compile pipeline ran).

use serde_json::{Value, json};
use tracing::{info, warn};

use super::CommandHandler;
use crate::process_image::TagConfig;
use crate::scripting::bytecode::StValueType;
use crate::scripting::bytecode_compiler::TagDescriptor;
use crate::scripting::bytecode_deploy::{DeployError, compile_and_deploy_signed_source};
use crate::scripting::st_source_sig::SignedStSource;
use crate::security::sanitize_for_log;

/// Convert a Suderra `TagConfig` (boot-time io_poll catalog
/// shape) into a `TagDescriptor` (compile-time symbol-table
/// shape consumed by `compile_program`).
///
/// Tag types are coerced to the closest StValueType:
/// - "BOOL" / "Bool" / "boolean" → StValueType::Bool
/// - "INT" / "Int" / "DINT" / "Int32" / "Int16" → StValueType::Int
/// - "REAL" / "Real" / "Float" / "Double" / "LReal" → StValueType::Real
/// - everything else → fall through to Real (lossless for
///   numeric telemetry; matches map_suderra_data_type fallback
///   in opc_ua_server_runtime.rs).
///
/// Writability comes from io_type — DO/AO are writable, DI/AI
/// are read-only (script `WRITE_TAG` to a read-only tag fails
/// the compile gate per `target_kind` in bytecode_compiler).
fn tag_config_to_descriptor(cfg: &TagConfig) -> TagDescriptor {
    use crate::process_image::IoType;
    let st_type = match cfg.data_type.trim().to_ascii_lowercase().as_str() {
        "bool" | "boolean" => StValueType::Bool,
        "int" | "int32" | "int16" | "dint" | "uint" | "uint32" | "udint" | "uint16" | "int64"
        | "lint" | "uint64" | "ulint" => StValueType::Int,
        "real" | "lreal" | "double" | "float" => StValueType::Real,
        // Unknown declared types fall back to Real — matches
        // the canonical map_suderra_data_type fallback used
        // by the OPC UA server when surfacing tags. A future
        // batch may tighten this to reject unknown types so
        // operator typos surface at deploy time rather than
        // post-runtime via type-mismatch on TAG_LOAD.
        _ => StValueType::Real,
    };
    let writable = matches!(cfg.io_type, IoType::DO | IoType::AO);
    TagDescriptor {
        name: cfg.tag_name.clone(),
        data_type: st_type,
        writable,
    }
}

impl CommandHandler {
    pub(super) async fn cmd_deploy_st_source(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing deploy_st_source command (Batch #299 ORPHAN-HIGH-020 closure)");

        // Pull AppState slices under a single read-guard.
        // tag catalog is fetched separately (async call on
        // ProcessImage) AFTER the lock is dropped to keep
        // critical-section short.
        let (pubkey, tenant_str, registry, store, license, scan_cycle_ms, pi) = {
            let state = self.state.read().await;
            (
                state.firmware_signing_pubkey.clone(),
                state.tenant_id.clone(),
                state.bytecode_registry.clone(),
                state.bytecode_registry_store.clone(),
                state.license.clone(),
                state.config.scripting.default_scan_cycle_ms,
                state.process_image.clone(),
            )
        };

        let pubkey = match pubkey {
            Some(k) => k,
            None => {
                return (
                    false,
                    json!(null),
                    Some(
                        "deploy_st_source rejected: firmware_signing_pubkey not wired. \
                         Set firmware_update.mode != Disabled + signing_pubkey_hex."
                            .to_string(),
                    ),
                );
            }
        };

        // Extract `signed_st_source` from params.
        let signed_value = match params.get("signed_st_source") {
            Some(v) => v,
            None => {
                return (
                    false,
                    json!(null),
                    Some("deploy_st_source: missing required param `signed_st_source`".to_string()),
                );
            }
        };

        let signed: SignedStSource = match serde_json::from_value(signed_value.clone()) {
            Ok(s) => s,
            Err(e) => {
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "deploy_st_source: failed to parse SignedStSource: {}",
                        sanitize_for_log(&e.to_string())
                    )),
                );
            }
        };

        // Faz 7 license gate — runs BEFORE the compile pipeline
        // so a license-exceeded deploy costs zero parse/compile
        // cycles. Same shape as cmd_deploy_bytecode_program's
        // gate (Batch 215). Pending counts computed against
        // post-deploy view of the registry.
        let incoming_program_id = signed.body.program_id.clone();
        let existing_entry = registry.get(&incoming_program_id).await;
        let pending_st_programs = if existing_entry.is_some() {
            registry.len().await
        } else {
            registry.len().await + 1
        };
        // FB instances unknown until post-compile; use existing
        // count + replace-aware delta. The compile-time FB
        // count check is enforced by compile_program's symbol
        // table. A future batch may extract FB-instance pre-
        // count from the source AST to gate before compile.
        let pending_fb_instances = registry
            .fb_instance_ids_except(Some(&incoming_program_id))
            .await
            .len();

        match crate::license::check_deploy_program_budget(
            pending_st_programs,
            pending_fb_instances,
            scan_cycle_ms,
            &license,
        ) {
            crate::license::DeployProgramBudget::WithinBudget { .. } => {}
            crate::license::DeployProgramBudget::StProgramCountExceeded { configured, cap } => {
                warn!(
                    "deploy_st_source rejected: ST program cap (pending={} cap={} tier={})",
                    configured,
                    cap,
                    license.tier.as_str(),
                );
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "deploy_st_source: license ST program cap reached (pending={} cap={} tier={}) — delete an existing program or upgrade tier",
                        configured,
                        cap,
                        license.tier.as_str(),
                    )),
                );
            }
            crate::license::DeployProgramBudget::FbInstanceCountExceeded { configured, cap } => {
                warn!(
                    "deploy_st_source rejected: FB instance cap (pending={} cap={} tier={})",
                    configured,
                    cap,
                    license.tier.as_str(),
                );
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "deploy_st_source: license FB instance cap reached (pending={} cap={} tier={}) — reduce FB usage or upgrade tier",
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
                    "deploy_st_source rejected: scan_cycle below tier floor (configured_ms={} min_ms={} tier={})",
                    configured_ms,
                    min_ms,
                    license.tier.as_str(),
                );
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "deploy_st_source: scan_cycle_ms ({}) below license min ({}ms) for tier={} — raise scripting.default_scan_cycle_ms or upgrade tier",
                        configured_ms,
                        min_ms,
                        license.tier.as_str(),
                    )),
                );
            }
        }

        // Build TagDescriptor[] from the agent's tag catalog.
        // compile_program needs these to resolve in-source tag
        // references; an unresolved tag surfaces as a
        // CompileError at gate 4.
        let tag_configs = pi.get_configs().await;
        let tags: Vec<TagDescriptor> = tag_configs.iter().map(tag_config_to_descriptor).collect();

        // Verify closure — same shape as cmd_deploy_bytecode_program.
        let verify_closure = |msg: &[u8], sig_bytes: &[u8; 64]| {
            // verify_strict: reject non-canonical/malleable signatures on the
            // program-integrity boundary (crate-wide SSoT).
            let sig = ed25519_dalek::Signature::from_bytes(sig_bytes);
            pubkey.verify_strict(msg, &sig).is_ok()
        };

        match compile_and_deploy_signed_source(
            &registry,
            &signed,
            tenant_str.as_deref(),
            &tags,
            verify_closure,
        )
        .await
        {
            Ok(report) => {
                info!(
                    "deploy_st_source: program_id={} policy_version={} replaced_existing={} compiled_from_source=true",
                    sanitize_for_log(&report.program_id),
                    report.policy_version,
                    report.replaced_existing
                );

                // Persist to SQLCipher store (best-effort, same
                // shape as cmd_deploy_bytecode_program).
                let persisted = if let Some(store_ref) = store.as_ref() {
                    match registry.get(&report.program_id).await {
                        Some(entry) => match store_ref.save(&entry) {
                            Ok(()) => true,
                            Err(e) => {
                                warn!(
                                    "deploy_st_source: registry insert OK but store save failed for {}: {}. Deploy is live in-memory; operator must investigate SQLCipher.",
                                    sanitize_for_log(&report.program_id),
                                    e
                                );
                                false
                            }
                        },
                        None => {
                            warn!(
                                "deploy_st_source: registry insert OK but entry missing at save-back read for {}",
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
                        "compiled_from_source": true,
                        "persisted": persisted,
                    }),
                    None,
                )
            }
            Err(e) => {
                warn!("deploy_st_source failed: {}", e);
                let reason = match &e {
                    DeployError::StSourceSignatureInvalid => {
                        "ST source signature verification failed".to_string()
                    }
                    DeployError::StSourceCanonicalEncoding { what } => {
                        format!("ST source canonical encoding failed: {}", what)
                    }
                    DeployError::TenantMismatch { expected, got } => {
                        format!("tenant mismatch (expected={:?}, got={:?})", expected, got)
                    }
                    DeployError::StSourceParseFailed {
                        error_count,
                        first_error,
                    } => {
                        format!(
                            "ST source parse failed ({} error(s); first: {})",
                            error_count,
                            sanitize_for_log(first_error)
                        )
                    }
                    DeployError::StSourceCompileFailed { reason } => {
                        format!("ST source compile failed: {}", sanitize_for_log(reason))
                    }
                    DeployError::Registry(inner) => inner.to_string(),
                    // SignedBytecode-side variants — unreachable
                    // from the source-compile path (we never call
                    // verify_signed_bytecode here). Defensive exhaustive
                    // match catches a future variant addition at
                    // compile time.
                    DeployError::SignatureInvalid | DeployError::CanonicalEncoding { .. } => {
                        format!(
                            "unexpected bytecode-path variant in st-source deploy: {}",
                            e
                        )
                    }
                };
                (
                    false,
                    json!(null),
                    Some(format!("deploy_st_source: {}", reason)),
                )
            }
        }
    }
}
