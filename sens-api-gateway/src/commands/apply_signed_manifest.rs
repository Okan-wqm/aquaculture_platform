//! `cmd_apply_signed_manifest` — orchestrator for the
//! SignedFirmwareManifest deploy pipeline (Batch 116 Sprint
//! 6.5 Phase 2).
//!
//! ## WHY
//!
//! Plan §5 Faz 2 item 6 + ADR-019 §2 specify the A/B
//! firmware update lifecycle. Batch 115 landed the verify-
//! preview primitive (`cmd_verify_signed_manifest`); this
//! batch lands the APPLY orchestrator that converts a
//! verified manifest into an actual partition-state
//! transition paired with bootloader coordination.
//!
//! ## Orchestration steps (software-only scope)
//!
//! 1. Pull required AppState slices under a single read-
//!    guard: pubkey, tenant, partition_store, bootloader,
//!    mode, current snapshot.
//! 2. Mode-gate: Disabled mode rejects (no trusted pubkey).
//! 3. Parse `manifest` param → SignedFirmwareManifest.
//! 4. Run the Batch 8 `verify_firmware_manifest` (8-gate
//!    fail-closed) with the cached VerifyingKey.
//! 5. Determine transition + target slot from the current
//!    snapshot:
//!    - Both slots Empty → `InitialInstall { target = active }`.
//!    - Active slot in Active state → `SwapToPending`
//!      (target = active.other()).
//!    - Any other state (PendingConfirm already open,
//!      Empty-active, etc.) → reject with structured error.
//! 6. Apply transition atomically with version bump via
//!    `apply_roll_with_version_bump(roll, budget,
//!    manifest.firmware_version)`. This closes the Batch
//!    115 observation #1 monotonic-floor gap:
//!    `active_firmware_version` now advances in the SAME
//!    disk-persisted operation as the state change.
//! 7. Call `BootloaderHandle::set_next_boot_slot(target)`
//!    — Noop backend is a zero-cost log on non-RPi; Tryboot
//!    backend flips /boot/tryboot.cfg. Same split-brain
//!    discipline as Batch 112: log + surface in response
//!    JSON + do NOT revert software state on bootloader
//!    failure (the apply is committed; operator resync via
//!    --confirm-active or recovery boot).
//!
//! ## Tracked for later batches (plan §5 Faz 2 item 6 continuation)
//!
//! - File streaming / download to standby partition —
//!   needs real A/B mount paths in config + hardware.
//!   Lands with the Tryboot real-RPi impl batch.
//! - TOCTOU re-verify (hash-after-fsync-before-rename):
//!   downstream of file-streaming.
//! - Per-file SHA-256 recompute: Batch 8 doc says this
//!   runs AFTER files land on standby.
//!
//! Until the hardware-layer batch lands, this orchestrator
//! is the software-layer truth for "the new manifest is
//! installed-as-pending + waiting for reboot-into-new-
//! slot". Operator physically reboots via external means
//! (ssh reboot, out-of-band trigger) to exercise the
//! cold-boot watchdog path.
//!
//! ## Authorization
//!
//! Gated by `Permission::UpdateFirmware` via
//! required_permission — same class as cmd_update_firmware
//! (legacy tarball), cmd_confirm_slot (Batch 109),
//! cmd_verify_signed_manifest (Batch 115).

use serde_json::{Value, json};
use std::time::SystemTime;
use tracing::{info, warn};

use super::CommandHandler;
use crate::authz::permission::TenantId;
use crate::security::sanitize_for_log;
use crate::updater::{
    AbPartition, BootloaderHandle, PartitionRoll, PartitionState, PartitionStore,
    SignedFirmwareManifest, SlotState,
};

impl CommandHandler {
    /// `apply_signed_manifest` — verify + apply_roll + bootloader coord.
    ///
    /// Params:
    /// - `manifest`: SignedFirmwareManifest JSON body (required).
    ///
    /// Returns on success:
    ///   {
    ///     "verified": true,
    ///     "applied_transition": "InitialInstall" | "SwapToPending",
    ///     "target_slot": "a" | "b",
    ///     "new_state": { ... PartitionState ... },
    ///     "bootloader_coordination": {
    ///       "backend": "noop" | "tryboot",
    ///       "set_next_boot_slot_ok": bool
    ///     }
    ///   }
    ///
    /// On verify failure: pass-through from
    /// cmd_verify_signed_manifest's structured gate labels.
    /// On apply failure: `apply_error` field with the
    /// PartitionStore error + the new_state is UNCHANGED.
    pub(super) async fn cmd_apply_signed_manifest(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        // Batch 132 Sprint 6.5: metric-emit wrapper around
        // the impl. Post-flight emit based on the
        // (success, result_json) return so we have ONE
        // metric-bump point instead of scattering across
        // the 12 reject paths + 1 success path. Reading
        // new_state from result JSON is cheap + decouples
        // metrics from the impl's internal structure.
        let health_state = {
            let state = self.state.read().await;
            state.health_state.clone()
        };
        let (success, result, error) = self.cmd_apply_signed_manifest_impl(params).await;
        if let Some(hs) = health_state.as_ref() {
            if success {
                hs.inc_firmware_apply_applied();
                if let Some(slot_str) = result.get("target_slot").and_then(|v| v.as_str()) {
                    match slot_str {
                        "a" => hs.set_firmware_active_slot(0),
                        "b" => hs.set_firmware_active_slot(1),
                        _ => {}
                    }
                }
                if let Some(v) = result.get("firmware_version").and_then(|v| v.as_u64()) {
                    hs.set_firmware_active_version(v);
                }
            } else {
                hs.inc_firmware_apply_rejected();
            }
        }
        (success, result, error)
    }

    /// Impl body split out by Batch 132 so the
    /// `cmd_apply_signed_manifest` wrapper can emit
    /// Prometheus metrics post-flight.
    async fn cmd_apply_signed_manifest_impl(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing apply_signed_manifest command (Sprint 6.5 Phase 2)");

        // 1. Snapshot AppState slices under single read-guard.
        let (pubkey, tenant_str, mode, partition_store, bootloader, ab_partitions) = {
            let state = self.state.read().await;
            (
                state.firmware_signing_pubkey.clone(),
                state.tenant_id.clone(),
                state.config.firmware_update.mode,
                state.partition_store.clone(),
                state.bootloader.clone(),
                state.config.firmware_update.ab_partitions.clone(),
            )
        };

        // 2. Mode-gate + partition-store presence.
        let pubkey = match pubkey {
            Some(k) => k,
            None => {
                return (
                    false,
                    json!({
                        "verified": false,
                        "gate": "mode_disabled",
                        "mode": format!("{:?}", mode),
                    }),
                    Some(format!(
                        "apply_signed_manifest rejected: firmware_update.mode={:?} — pubkey not wired. \
                         Set mode=permissive|enforcing + signing_pubkey_hex.",
                        mode
                    )),
                );
            }
        };

        let partition_store = match partition_store {
            Some(s) => s,
            None => {
                return (
                    false,
                    json!({
                        "verified": false,
                        "gate": "partition_store_absent",
                    }),
                    Some(
                        "apply_signed_manifest rejected: partition_store not initialized. \
                         Boot-time init failure — see agent logs."
                            .to_string(),
                    ),
                );
            }
        };

        // 3. Parse + verify the manifest.
        let expected_tenant = match tenant_str {
            Some(t) => match uuid::Uuid::parse_str(&t) {
                Ok(u) => TenantId::new_from_verified(*u.as_bytes()),
                Err(e) => {
                    return (
                        false,
                        json!({
                            "verified": false,
                            "gate": "tenant_parse_failed",
                            "reason": sanitize_for_log(&e.to_string()),
                        }),
                        Some(format!(
                            "apply_signed_manifest: tenant_id on AppState is not a valid UUID: {}",
                            sanitize_for_log(&e.to_string())
                        )),
                    );
                }
            },
            None => {
                return (
                    false,
                    json!({
                        "verified": false,
                        "gate": "device_not_activated",
                    }),
                    Some(
                        "apply_signed_manifest rejected: device not activated (tenant_id is None)"
                            .to_string(),
                    ),
                );
            }
        };

        let manifest_value = match params.get("manifest") {
            Some(v) => v.clone(),
            None => {
                return (
                    false,
                    json!({
                        "verified": false,
                        "gate": "missing_param",
                        "param": "manifest",
                    }),
                    Some(
                        "apply_signed_manifest rejected: missing required 'manifest' parameter"
                            .to_string(),
                    ),
                );
            }
        };

        let signed: SignedFirmwareManifest = match serde_json::from_value(manifest_value) {
            Ok(m) => m,
            Err(e) => {
                warn!(
                    "apply_signed_manifest: manifest parse failed: {}",
                    sanitize_for_log(&e.to_string())
                );
                return (
                    false,
                    json!({
                        "verified": false,
                        "gate": "manifest_parse_failed",
                        "reason": sanitize_for_log(&e.to_string()),
                    }),
                    Some(format!(
                        "apply_signed_manifest rejected: manifest JSON parse failed: {}",
                        sanitize_for_log(&e.to_string())
                    )),
                );
            }
        };

        let snapshot = match partition_store.snapshot() {
            Ok(s) => s,
            Err(e) => {
                return (
                    false,
                    json!({
                        "gate": "snapshot_failed",
                        "reason": e.to_string(),
                    }),
                    Some(format!(
                        "apply_signed_manifest: partition snapshot failed: {}",
                        e
                    )),
                );
            }
        };
        let highest_seen = snapshot.active_firmware_version;

        let now = SystemTime::now();
        let manifest = match crate::updater::verify_firmware_manifest(
            &signed,
            &expected_tenant,
            highest_seen,
            now,
            |canonical, sig_bytes| {
                let sig = ed25519_dalek::Signature::from_bytes(sig_bytes);
                pubkey.verify_strict(canonical, &sig).is_ok()
            },
        ) {
            Ok(m) => m,
            Err(e) => {
                warn!("apply_signed_manifest VERIFY REJECTED: {:?}", e);
                return (
                    false,
                    json!({
                        "verified": false,
                        "gate": gate_label_for_err(&e),
                        "reason": e.to_string(),
                        "highest_seen_firmware_version": highest_seen,
                        "mode": format!("{:?}", mode),
                    }),
                    Some(format!("apply_signed_manifest rejected: {}", e)),
                );
            }
        };

        // 4. Determine transition + target slot from current
        //    snapshot. Pure function (no AppState read) —
        //    tested in unit tests below.
        let (roll, target_slot, transition_label) = match plan_transition(&snapshot) {
            Ok(plan) => plan,
            Err(reason) => {
                return (
                    false,
                    json!({
                        "verified": true,
                        "applied": false,
                        "gate": "invalid_initial_state",
                        "reason": reason,
                        "current_state": snapshot,
                    }),
                    Some(format!(
                        "apply_signed_manifest: current partition state does not permit apply: {}",
                        reason
                    )),
                );
            }
        };

        // 4b. Batch 128 Sprint 6.5: software↔hardware
        // active-slot cross-check (closes Batch 116 obs #2).
        //
        // Ask the bootloader which slot the current boot
        // ACTUALLY came from. If it disagrees with the
        // PartitionStore's snapshot.active, we have a
        // split-brain: PartitionStore says "A is active"
        // but the running binary was loaded from slot B.
        // Reasons this could happen:
        // - Prior RolledBackBootloaderFailed (Batch 112)
        //   left software state saying Active=A while
        //   hardware stayed pointing at B.
        // - Manual operator intervention wrote autoboot.txt
        //   without updating partition.json.
        // - PartitionStore corruption (Batch 121 flock +
        //   re-read normally prevents this).
        //
        // Proceeding with an apply in this state would
        // write firmware to the WRONG slot (we pick
        // target = active.other() = A, but we're running
        // on A right now — overwriting our own running
        // binary). Fail-closed + surface the split-brain
        // for operator resync.
        //
        // Noop backend returns None → check is skipped
        // (no hardware side to cross-check against). Only
        // Tryboot + future backends that can report
        // active_slot_at_boot fire this gate.
        if let Some(hw_active) = bootloader.active_slot_at_boot() {
            if hw_active != snapshot.active {
                warn!(
                    "apply_signed_manifest: software/hardware split-brain detected. PartitionStore.active={:?} but bootloader.active_slot_at_boot={:?} (backend={})",
                    snapshot.active,
                    hw_active,
                    bootloader.backend_name()
                );
                return (
                    false,
                    json!({
                        "verified": true,
                        "applied": false,
                        "gate": "software_hardware_split_brain",
                        "reason": format!(
                            "PartitionStore.active={:?} but bootloader.active_slot_at_boot={:?}",
                            snapshot.active, hw_active
                        ),
                        "software_active": format!("{:?}", snapshot.active),
                        "hardware_active": format!("{:?}", hw_active),
                        "bootloader_backend": bootloader.backend_name(),
                        "remediation": "operator must resync via --confirm-active CLI or manual autoboot.txt edit before re-attempting apply",
                    }),
                    Some(format!(
                        "apply_signed_manifest: split-brain rejected — software_active={:?} hardware_active={:?}",
                        snapshot.active, hw_active
                    )),
                );
            }
        }

        // 5a. Batch 126 Sprint 6.5: file-streaming step.
        //
        // Behavior matrix:
        // - ab_partitions NOT configured (default HC-1):
        //   streaming SKIPPED. Response carries
        //   `streaming.status = "skipped_mounts_not_configured"`.
        //   Partition state + bootloader still advance —
        //   this path exercises the state machine without
        //   hardware-ready A/B mounts (dev / pre-
        //   hardware-provisioning scenarios).
        // - ab_partitions configured + `files` param
        //   supplied: stream bytes from params via
        //   InMemoryFileSource. This is the dev / test
        //   transport; production transports (HTTP / MQTT
        //   file transfer) are added in a future batch.
        // - ab_partitions configured + no `files` param:
        //   REJECT with `gate=no_file_source_configured`.
        //   A/B-ready deployments MUST supply bytes or the
        //   apply would swap to an EMPTY standby partition.
        let streaming_outcome =
            apply_streaming_step(params, &ab_partitions, &manifest, target_slot);
        let streaming_status_json = match &streaming_outcome {
            StreamingStep::Skipped { reason } => {
                info!("apply_signed_manifest: streaming skipped ({})", reason);
                json!({
                    "status": "skipped",
                    "reason": reason,
                })
            }
            StreamingStep::Streamed { verified_count } => {
                info!(
                    "apply_signed_manifest: streamed {} file(s) to slot {:?}",
                    verified_count, target_slot
                );
                json!({
                    "status": "streamed",
                    "verified_count": verified_count,
                })
            }
            StreamingStep::Rejected {
                gate,
                reason,
                verified_count,
                failed,
            } => {
                warn!(
                    "apply_signed_manifest: streaming REJECTED ({}): {}",
                    gate, reason
                );
                return (
                    false,
                    json!({
                        "verified": true,
                        "applied": false,
                        "gate": gate,
                        "reason": reason,
                        "streaming": {
                            "status": "rejected",
                            "verified_count": verified_count,
                            "failed_files": failed,
                        },
                    }),
                    Some(format!(
                        "apply_signed_manifest: streaming rejected ({}): {}",
                        gate, reason
                    )),
                );
            }
        };

        // 5b. Apply transition atomically with version bump.
        let cold_boot_budget_secs = crate::updater::partition::DEFAULT_COLD_BOOT_BUDGET_SECS;

        let new_state = match partition_store.apply_roll_with_version_bump(
            roll,
            cold_boot_budget_secs,
            manifest.firmware_version,
        ) {
            Ok(s) => s,
            Err(e) => {
                warn!(
                    "apply_signed_manifest APPLY REJECTED: {}",
                    sanitize_for_log(&e.to_string())
                );
                return (
                    false,
                    json!({
                        "verified": true,
                        "applied": false,
                        "apply_error": e.to_string(),
                        "transition_attempted": transition_label,
                    }),
                    Some(format!("apply_signed_manifest apply_roll failed: {}", e)),
                );
            }
        };

        info!(
            "apply_signed_manifest APPLIED: transition={} target_slot={:?} version {}->{} new_state={:?}",
            transition_label, target_slot, highest_seen, manifest.firmware_version, new_state
        );

        // 6. Bootloader coordination — set next boot to
        //    target. Noop is zero-cost log; Tryboot flips
        //    /boot/tryboot.cfg. Same split-brain discipline
        //    as Batch 112 cmd_confirm_slot: log + surface;
        //    do NOT revert software state on failure.
        let (bootloader_ok, bootloader_err) =
            call_set_next_boot_slot(bootloader.as_ref(), target_slot);

        let slot_str = match target_slot {
            AbPartition::A => "a",
            AbPartition::B => "b",
        };

        (
            true,
            json!({
                "verified": true,
                "applied": true,
                "applied_transition": transition_label,
                "target_slot": slot_str,
                "firmware_version": manifest.firmware_version,
                "previous_firmware_version": highest_seen,
                "release_tag": manifest.release_tag,
                "file_count": manifest.files.len(),
                "new_state": new_state,
                "streaming": streaming_status_json,
                "bootloader_coordination": {
                    "backend": bootloader.backend_name(),
                    "set_next_boot_slot_ok": bootloader_ok,
                    "error": bootloader_err,
                },
            }),
            None,
        )
    }
}

/// Determine the transition + target slot for the given
/// snapshot. Pure function — no AppState; testable without
/// fixtures.
///
/// Returns (PartitionRoll, target_slot, label_for_response).
/// Err(reason) when the snapshot state is NOT one the
/// orchestrator accepts — e.g. an already-open PendingConfirm
/// window MUST be resolved (via cmd_confirm_slot or the
/// watchdog Rollback) before a new apply runs.
pub(super) fn plan_transition(
    snapshot: &PartitionState,
) -> Result<(PartitionRoll, AbPartition, &'static str), String> {
    match (snapshot.slot_a_state, snapshot.slot_b_state) {
        // Both Empty — first-ever install path. Target the
        // configured initial-active slot (A by convention
        // per PartitionState::initial).
        (SlotState::Empty, SlotState::Empty) => {
            let target = snapshot.active;
            Ok((
                PartitionRoll::InitialInstall { target },
                target,
                "InitialInstall",
            ))
        }

        // One Active + one Empty/Standby — swap to the
        // other slot as new_pending.
        (SlotState::Active, SlotState::Empty) | (SlotState::Active, SlotState::Standby) => {
            if snapshot.active != AbPartition::A {
                return Err(format!(
                    "snapshot inconsistent: slot_a=Active but snapshot.active={:?}",
                    snapshot.active
                ));
            }
            Ok((
                PartitionRoll::SwapToPending {
                    old_active: AbPartition::A,
                    new_pending: AbPartition::B,
                },
                AbPartition::B,
                "SwapToPending",
            ))
        }
        (SlotState::Empty, SlotState::Active) | (SlotState::Standby, SlotState::Active) => {
            if snapshot.active != AbPartition::B {
                return Err(format!(
                    "snapshot inconsistent: slot_b=Active but snapshot.active={:?}",
                    snapshot.active
                ));
            }
            Ok((
                PartitionRoll::SwapToPending {
                    old_active: AbPartition::B,
                    new_pending: AbPartition::A,
                },
                AbPartition::A,
                "SwapToPending",
            ))
        }

        // Any other combination — PendingConfirm is open,
        // both PendingConfirm (bug), both Standby (bug),
        // etc. Operator must close the window first.
        (a, b) => Err(format!(
            "partition state does not permit new apply: slot_a={:?} slot_b={:?} active={:?}. \
             Close any open PendingConfirm window via cmd_confirm_slot or wait for the \
             cold-boot watchdog to fire Rollback.",
            a, b, snapshot.active
        )),
    }
}

/// Call BootloaderHandle::set_next_boot_slot; return (ok,
/// error_string). Separated from the command body so the
/// happy-path flow is readable + the failure-log discipline
/// is centralized.
fn call_set_next_boot_slot(
    bootloader: &dyn BootloaderHandle,
    target: AbPartition,
) -> (bool, Option<String>) {
    match bootloader.set_next_boot_slot(target) {
        Ok(()) => {
            info!(
                "apply_signed_manifest: bootloader set_next_boot_slot({:?}) OK (backend={})",
                target,
                bootloader.backend_name()
            );
            (true, None)
        }
        Err(e) => {
            warn!(
                "apply_signed_manifest: software apply OK, bootloader set_next_boot_slot({:?}) FAILED: {} (backend={}) — SPLIT-BRAIN: operator must resync via --confirm-active or recovery boot",
                target,
                e,
                bootloader.backend_name()
            );
            (false, Some(e.to_string()))
        }
    }
}

/// Streaming-step outcome (Batch 126 Sprint 6.5).
#[derive(Debug)]
pub(super) enum StreamingStep {
    /// ab_partitions not configured — streaming skipped;
    /// apply continues against PartitionStore + bootloader
    /// only.
    Skipped { reason: String },
    /// Bytes streamed + per-file verified; apply proceeds.
    Streamed { verified_count: usize },
    /// Streaming rejected; apply MUST abort. `gate` is a
    /// stable identifier for the reject reason; `reason`
    /// is a human-readable message; `failed` is a vec of
    /// per-file error strings for forensic detail.
    Rejected {
        gate: &'static str,
        reason: String,
        verified_count: usize,
        failed: Vec<serde_json::Value>,
    },
}

/// Apply the file-streaming step for cmd_apply_signed_manifest.
///
/// Behavior matrix (documented in the command body +
/// mirrored here as the implementation contract):
///
/// - ab_partitions.is_fully_configured() == false →
///   Skipped. HC-1 backward-compat; the state-machine
///   path still advances but no files land on the
///   standby slot.
/// - is_fully_configured() == true + params["files"]
///   missing → Rejected(gate=no_file_source_configured).
/// - is_fully_configured() == true + params["files"]
///   present → streams via InMemoryFileSource, runs
///   TOCTOU re-verify at final path.
///
/// The `files` param shape (dev/test transport):
/// ```json
/// {
///   "files": {
///     "bin/suderra-agent": "base64-bytes-here",
///     "etc/suderra/config.yaml": "base64-bytes-here"
///   }
/// }
/// ```
///
/// Production transports (HTTP / MQTT file transfer) add
/// their own FileSource impls + go through the same
/// stream_files_to_standby orchestrator.
pub(super) fn apply_streaming_step(
    params: &Value,
    ab_partitions: &crate::config::AbPartitionMountConfig,
    manifest: &crate::updater::FirmwareManifest,
    target_slot: AbPartition,
) -> StreamingStep {
    if !ab_partitions.is_fully_configured() {
        return StreamingStep::Skipped {
            reason:
                "ab_partitions mount paths not configured (HC-1 backward compat — state-only apply)"
                    .to_string(),
        };
    }

    let target_mount = match target_slot {
        AbPartition::A => ab_partitions.slot_a_mount.as_ref(),
        AbPartition::B => ab_partitions.slot_b_mount.as_ref(),
    };
    let target_mount = match target_mount {
        Some(p) => p,
        None => {
            // Impossible given is_fully_configured() == true;
            // defense-in-depth against future refactor that
            // breaks the invariant.
            return StreamingStep::Rejected {
                gate: "target_mount_missing",
                reason: format!(
                    "target slot {:?} mount path is None despite is_fully_configured() == true",
                    target_slot
                ),
                verified_count: 0,
                failed: vec![],
            };
        }
    };

    let files_param = match params.get("files") {
        Some(v) => v,
        None => {
            return StreamingStep::Rejected {
                gate: "no_file_source_configured",
                reason: "ab_partitions configured but no 'files' param supplied. \
                         Production deployments integrate HTTP/MQTT file transport; \
                         dev/test deployments supply files inline via base64-encoded 'files' map."
                    .to_string(),
                verified_count: 0,
                failed: vec![],
            };
        }
    };

    let files_obj = match files_param.as_object() {
        Some(m) => m,
        None => {
            return StreamingStep::Rejected {
                gate: "files_param_not_object",
                reason: "'files' param must be a JSON object { path: base64_bytes }".to_string(),
                verified_count: 0,
                failed: vec![],
            };
        }
    };

    // Build the InMemoryFileSource from base64-decoded
    // param bytes. Base64 decode failures map to rejection
    // so the command caller sees a clear error shape
    // instead of an opaque IO "file not found" later.
    use base64::Engine;
    let mut source = crate::updater::InMemoryFileSource::new();
    let mut decode_failures: Vec<serde_json::Value> = Vec::new();
    for (path, bytes_value) in files_obj {
        let b64 = match bytes_value.as_str() {
            Some(s) => s,
            None => {
                decode_failures.push(json!({
                    "path": path,
                    "error": "files[path] value must be a base64 string",
                }));
                continue;
            }
        };
        match base64::engine::general_purpose::STANDARD.decode(b64) {
            Ok(bytes) => {
                source.insert(path.clone(), bytes);
            }
            Err(e) => {
                decode_failures.push(json!({
                    "path": path,
                    "error": format!("base64 decode failed: {}", e),
                }));
            }
        }
    }
    if !decode_failures.is_empty() {
        return StreamingStep::Rejected {
            gate: "files_param_decode_failed",
            reason: format!(
                "{} file(s) in 'files' param failed base64 decoding",
                decode_failures.len()
            ),
            verified_count: 0,
            failed: decode_failures,
        };
    }

    let report = crate::updater::stream_files_to_standby(&source, manifest, target_mount);
    if report.all_ok() {
        return StreamingStep::Streamed {
            verified_count: report.verified_count,
        };
    }
    let failed_json: Vec<serde_json::Value> = report
        .failed
        .iter()
        .map(|(path, err)| {
            json!({
                "path": path,
                "error": err.to_string(),
            })
        })
        .collect();
    StreamingStep::Rejected {
        gate: "stream_rejected",
        reason: format!(
            "{} file(s) failed streaming / re-verify out of {}",
            report.failed.len(),
            manifest.files.len()
        ),
        verified_count: report.verified_count,
        failed: failed_json,
    }
}

/// Map ManifestVerifyError variants to stable string labels
/// suitable for the audit detail + response JSON. Kept in
/// sync with the Batch 115 `gate_label_for_err` function —
/// the same stability contract applies to both commands
/// (operator UIs rely on the identifiers being consistent
/// between verify-preview + apply paths).
fn gate_label_for_err(e: &crate::updater::ManifestVerifyError) -> &'static str {
    use crate::updater::ManifestVerifyError as M;
    match e {
        M::TargetArchMismatch => "target_arch_mismatch",
        M::InvalidValidityWindow { .. } => "invalid_validity_window",
        M::InvalidNow => "invalid_now",
        M::TenantMismatch => "tenant_mismatch",
        M::StaleFirmwareVersion { .. } => "stale_firmware_version",
        M::NotYetValid { .. } => "not_yet_valid",
        M::Expired { .. } => "expired",
        M::CanonicalBytesFailure(_) => "canonical_bytes_failure",
        M::InvalidSignature => "invalid_signature",
        M::FileDigestMismatch { .. } => "file_digest_mismatch",
        M::FileSizeMismatch { .. } => "file_size_mismatch",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::updater::{PartitionState, SlotState};

    fn snap(
        active: AbPartition,
        slot_a: SlotState,
        slot_b: SlotState,
        version: u64,
    ) -> PartitionState {
        PartitionState {
            active,
            slot_a_state: slot_a,
            slot_b_state: slot_b,
            pending_confirm_deadline_unix_secs: None,
            active_firmware_version: version,
        }
    }

    #[test]
    fn plan_transition_both_empty_uses_initial_install() {
        let s = snap(AbPartition::A, SlotState::Empty, SlotState::Empty, 0);
        let (roll, target, label) = plan_transition(&s).expect("plan");
        assert!(matches!(
            roll,
            PartitionRoll::InitialInstall {
                target: AbPartition::A
            }
        ));
        assert_eq!(target, AbPartition::A);
        assert_eq!(label, "InitialInstall");
    }

    #[test]
    fn plan_transition_a_active_b_empty_swaps_to_b() {
        let s = snap(AbPartition::A, SlotState::Active, SlotState::Empty, 5);
        let (roll, target, label) = plan_transition(&s).expect("plan");
        assert!(matches!(
            roll,
            PartitionRoll::SwapToPending {
                old_active: AbPartition::A,
                new_pending: AbPartition::B
            }
        ));
        assert_eq!(target, AbPartition::B);
        assert_eq!(label, "SwapToPending");
    }

    #[test]
    fn plan_transition_a_active_b_standby_swaps_to_b() {
        // Post-confirm-rollback-retry scenario: slot A is
        // Active + slot B retains Standby from the prior
        // cycle. Orchestrator reuses B for the new deploy.
        let s = snap(AbPartition::A, SlotState::Active, SlotState::Standby, 5);
        let (roll, target, _label) = plan_transition(&s).expect("plan");
        assert!(matches!(
            roll,
            PartitionRoll::SwapToPending {
                old_active: AbPartition::A,
                new_pending: AbPartition::B
            }
        ));
        assert_eq!(target, AbPartition::B);
    }

    #[test]
    fn plan_transition_b_active_a_empty_swaps_to_a() {
        let s = snap(AbPartition::B, SlotState::Empty, SlotState::Active, 5);
        let (roll, target, _label) = plan_transition(&s).expect("plan");
        assert!(matches!(
            roll,
            PartitionRoll::SwapToPending {
                old_active: AbPartition::B,
                new_pending: AbPartition::A
            }
        ));
        assert_eq!(target, AbPartition::A);
    }

    #[test]
    fn plan_transition_rejects_pending_confirm_open() {
        // Slot B is in PendingConfirm — cannot start a new
        // deploy until that window closes.
        let s = snap(
            AbPartition::B,
            SlotState::Standby,
            SlotState::PendingConfirm,
            5,
        );
        let err = plan_transition(&s).expect_err("reject");
        assert!(err.contains("slot_b=PendingConfirm"));
    }

    #[test]
    fn plan_transition_rejects_both_pending_confirm() {
        // Impossible-in-normal-flow but defensive — reject
        // any non-clean starting state.
        let s = snap(
            AbPartition::A,
            SlotState::PendingConfirm,
            SlotState::PendingConfirm,
            5,
        );
        let err = plan_transition(&s).expect_err("reject");
        assert!(err.contains("PendingConfirm"));
    }

    #[test]
    fn plan_transition_rejects_inconsistent_active_flag() {
        // slot_a says Active but snapshot.active says B —
        // corruption signal; orchestrator refuses.
        let s = snap(AbPartition::B, SlotState::Active, SlotState::Empty, 5);
        let err = plan_transition(&s).expect_err("reject");
        assert!(err.contains("inconsistent"));
    }

    #[test]
    fn gate_label_pins_stable_identifiers() {
        use crate::updater::ManifestVerifyError as M;
        // Mirrors Batch 115's test — if either command's
        // label drifts, both tests drift together +
        // surface the contract break loudly.
        assert_eq!(
            gate_label_for_err(&M::TargetArchMismatch),
            "target_arch_mismatch"
        );
        assert_eq!(
            gate_label_for_err(&M::InvalidSignature),
            "invalid_signature"
        );
        assert_eq!(
            gate_label_for_err(&M::StaleFirmwareVersion {
                claimed: 1,
                highest_seen: 2
            }),
            "stale_firmware_version"
        );
    }

    // ========================================================================
    // End-to-end happy-path integration test (Batch 117 Sprint 6.5)
    // ========================================================================
    //
    // Signs a real SignedFirmwareManifest with a test keypair, runs it
    // through the full verify → plan_transition → apply_roll_with_version_bump
    // → BootloaderHandle.set_next_boot_slot chain, and asserts that the
    // PartitionStore + bootloader end up in the expected post-apply state.
    //
    // Does NOT go through CommandHandler / MQTT dispatch — that layer is
    // thin glue around the orchestration primitives exercised below.
    // Running in-process keeps the test fast + isolated from AppState
    // construction complexity.

    use crate::authz::permission::TenantId as TenantIdFull;
    use crate::updater::{
        FileDigest, FileEntry, FirmwareManifest, Sha256Digest, SignedFirmwareManifest, TargetArch,
    };
    use ed25519_dalek::{Signer, SigningKey};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Bootloader test fixture that records every
    /// set_next_boot_slot call for the integration test to
    /// assert the hardware-coordination side fired.
    struct RecordingBootloader {
        set_next_calls: AtomicUsize,
        last_target: std::sync::Mutex<Option<AbPartition>>,
    }

    impl RecordingBootloader {
        fn new() -> Self {
            Self {
                set_next_calls: AtomicUsize::new(0),
                last_target: std::sync::Mutex::new(None),
            }
        }
    }

    impl BootloaderHandle for RecordingBootloader {
        fn set_next_boot_slot(
            &self,
            slot: AbPartition,
        ) -> Result<(), crate::updater::BootloaderError> {
            self.set_next_calls.fetch_add(1, Ordering::SeqCst);
            *self.last_target.lock().unwrap() = Some(slot);
            Ok(())
        }

        fn clear_pending_boot(
            &self,
            _slot: AbPartition,
        ) -> Result<(), crate::updater::BootloaderError> {
            Ok(())
        }

        fn rollback_next_boot(
            &self,
            _to_slot: AbPartition,
        ) -> Result<(), crate::updater::BootloaderError> {
            Ok(())
        }

        fn active_slot_at_boot(&self) -> Option<AbPartition> {
            None
        }

        fn backend_name(&self) -> &'static str {
            "integration-recording"
        }
    }

    fn tmp_partition_store_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "suderra-apply-e2e-{}-{}.json",
            std::process::id(),
            rand::random::<u32>()
        ))
    }

    fn build_signed_manifest(
        signing_key: &SigningKey,
        tenant: &TenantIdFull,
        firmware_version: u64,
    ) -> SignedFirmwareManifest {
        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_secs() as i64;
        let manifest = FirmwareManifest {
            firmware_version,
            tenant_id: *tenant,
            target_arch: TargetArch::compiled_target(),
            // 1-hour-wide window centered near now so the
            // validity-window + clock gates pass without
            // relying on specific clock value.
            valid_from_unix_secs: now_secs - 1800,
            valid_until_unix_secs: now_secs + 1800,
            release_tag: format!("v{}-integration-test", firmware_version),
            files: vec![FileEntry {
                path: "bin/suderra-agent".to_string(),
                digest: FileDigest {
                    sha256: Sha256Digest::from_bytes([0x11u8; 32]),
                    size_bytes: 1024,
                    mode: 0o755,
                },
            }],
        };
        let canonical = manifest.canonical_bytes().expect("canonical ok");
        let sig = signing_key.sign(&canonical);
        SignedFirmwareManifest::from_body_and_signature_bytes(manifest, &sig.to_bytes())
            .expect("signature bytes ok")
    }

    #[test]
    fn e2e_happy_path_initial_install_then_swap_with_real_ed25519_keypair() {
        // 1. Fresh keypair. Deterministic seed for test
        //    reproducibility (NOT a production key use).
        let seed = [0x5au8; 32];
        let signing_key = SigningKey::from_bytes(&seed);
        let verifying_key = signing_key.verifying_key();
        let pubkey_arc = Arc::new(verifying_key);

        let tenant_bytes = [0xABu8; 16];
        let tenant = TenantIdFull::new_from_verified(tenant_bytes);

        // 2. Open a fresh PartitionStore — both slots Empty.
        let path = tmp_partition_store_path();
        let _ = std::fs::remove_file(&path);
        let partition_store = Arc::new(PartitionStore::open(Some(&path)).expect("store open"));

        // Keep a concrete Arc for atomic-counter asserts +
        // use the SAME Arc for bootloader method calls
        // (Arc<RecordingBootloader> derefs to &T which
        // already implements the trait methods).
        let bootloader = Arc::new(RecordingBootloader::new());

        // 3. Build + sign manifest v1 (InitialInstall path).
        let signed_v1 = build_signed_manifest(&signing_key, &tenant, 1);

        // 4. Run the same primitives the command body runs.
        let snap_before = partition_store.snapshot().expect("snap");
        assert_eq!(snap_before.active_firmware_version, 0);
        assert_eq!(snap_before.slot_a_state, SlotState::Empty);
        assert_eq!(snap_before.slot_b_state, SlotState::Empty);

        let now = SystemTime::now();
        let manifest_v1 = crate::updater::verify_firmware_manifest(
            &signed_v1,
            &tenant,
            snap_before.active_firmware_version,
            now,
            |canonical, sig_bytes| {
                let sig = ed25519_dalek::Signature::from_bytes(sig_bytes);
                pubkey_arc.verify_strict(canonical, &sig).is_ok()
            },
        )
        .expect("v1 verify ok");
        assert_eq!(manifest_v1.firmware_version, 1);

        let (roll, target, label) = plan_transition(&snap_before).expect("plan v1");
        assert_eq!(label, "InitialInstall");

        let new_state = partition_store
            .apply_roll_with_version_bump(roll, 90, manifest_v1.firmware_version)
            .expect("apply v1");
        assert_eq!(new_state.active_firmware_version, 1);
        assert_eq!(new_state.state_of(target), SlotState::PendingConfirm);

        bootloader
            .set_next_boot_slot(target)
            .expect("bootloader v1 set_next_boot_slot");

        // 5. Confirm v1 (simulates post-boot health check).
        partition_store
            .apply_roll(PartitionRoll::Confirm { slot: target }, 90)
            .expect("confirm v1");
        let snap_v1_confirmed = partition_store.snapshot().expect("snap v1");
        assert_eq!(snap_v1_confirmed.state_of(target), SlotState::Active);
        assert!(
            snap_v1_confirmed
                .pending_confirm_deadline_unix_secs
                .is_none()
        );

        // 6. Deploy v2 — exercises SwapToPending + version
        //    bump 1 → 2.
        let signed_v2 = build_signed_manifest(&signing_key, &tenant, 2);

        let manifest_v2 = crate::updater::verify_firmware_manifest(
            &signed_v2,
            &tenant,
            snap_v1_confirmed.active_firmware_version,
            now,
            |canonical, sig_bytes| {
                let sig = ed25519_dalek::Signature::from_bytes(sig_bytes);
                pubkey_arc.verify_strict(canonical, &sig).is_ok()
            },
        )
        .expect("v2 verify ok");
        assert_eq!(manifest_v2.firmware_version, 2);

        let (roll_v2, target_v2, label_v2) = plan_transition(&snap_v1_confirmed).expect("plan v2");
        assert_eq!(label_v2, "SwapToPending");
        // v1 landed on slot A (default); v2 targets slot B.
        assert_eq!(target, AbPartition::A);
        assert_eq!(target_v2, AbPartition::B);

        let new_state_v2 = partition_store
            .apply_roll_with_version_bump(roll_v2, 90, manifest_v2.firmware_version)
            .expect("apply v2");
        assert_eq!(new_state_v2.active_firmware_version, 2);
        assert_eq!(new_state_v2.active, AbPartition::B);
        assert_eq!(new_state_v2.slot_a_state, SlotState::Standby);
        assert_eq!(new_state_v2.slot_b_state, SlotState::PendingConfirm);

        bootloader
            .set_next_boot_slot(target_v2)
            .expect("bootloader v2 set_next_boot_slot");

        // 7. Assert the recording bootloader fired twice +
        //    the last target was slot B.
        assert_eq!(bootloader.set_next_calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            *bootloader.last_target.lock().unwrap(),
            Some(AbPartition::B)
        );

        // 8. Re-open store to prove version + state
        //    persistence across agent restart. The
        //    monotonic floor is permanent until Rollback.
        drop(partition_store);
        let reopened = PartitionStore::open(Some(&path)).expect("reopen");
        let snap_reopened = reopened.snapshot().expect("snap reopened");
        assert_eq!(snap_reopened.active_firmware_version, 2);
        assert_eq!(snap_reopened.active, AbPartition::B);
        assert_eq!(snap_reopened.slot_a_state, SlotState::Standby);
        assert_eq!(snap_reopened.slot_b_state, SlotState::PendingConfirm);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn e2e_verify_rejects_foreign_tenant_manifest() {
        // Prove the tenant-binding Gate 4 fires at the real
        // verify callsite with a real keypair — an attacker
        // with the signing key for tenant X cannot pivot a
        // manifest onto tenant Y.
        let seed = [0x99u8; 32];
        let signing_key = SigningKey::from_bytes(&seed);
        let pubkey_arc = Arc::new(signing_key.verifying_key());

        let device_tenant = TenantIdFull::new_from_verified([0xAAu8; 16]);
        let attacker_tenant = TenantIdFull::new_from_verified([0xBBu8; 16]);

        // Attacker signs manifest for THEIR tenant + sends
        // it at this device which is bound to device_tenant.
        let signed = build_signed_manifest(&signing_key, &attacker_tenant, 1);

        let err = crate::updater::verify_firmware_manifest(
            &signed,
            &device_tenant,
            0,
            SystemTime::now(),
            |canonical, sig_bytes| {
                let sig = ed25519_dalek::Signature::from_bytes(sig_bytes);
                pubkey_arc.verify_strict(canonical, &sig).is_ok()
            },
        )
        .expect_err("tenant mismatch must reject");
        assert!(matches!(
            err,
            crate::updater::ManifestVerifyError::TenantMismatch
        ));
    }

    // ========================================================================
    // Batch 126 Sprint 6.5 — apply_streaming_step integration tests
    // ========================================================================

    use crate::config::AbPartitionMountConfig;
    use base64::Engine;
    use sha2::{Digest as Sha2Digest, Sha256};

    fn tmp_mount_pair() -> (std::path::PathBuf, std::path::PathBuf) {
        let a = std::env::temp_dir().join(format!(
            "suderra-apply-stream-a-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        let b = std::env::temp_dir().join(format!(
            "suderra-apply-stream-b-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        (a, b)
    }

    fn build_entry_with_hash(path: &str, bytes: &[u8]) -> FileEntry {
        let mut h = Sha256::new();
        h.update(bytes);
        let digest: [u8; 32] = h.finalize().into();
        FileEntry {
            path: path.to_string(),
            digest: FileDigest {
                sha256: Sha256Digest::from_bytes(digest),
                size_bytes: bytes.len() as u64,
                mode: 0o755,
            },
        }
    }

    fn build_manifest_for_streaming(files: Vec<(String, Vec<u8>)>) -> FirmwareManifest {
        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let entries: Vec<FileEntry> = files
            .iter()
            .map(|(p, b)| build_entry_with_hash(p, b))
            .collect();
        FirmwareManifest {
            firmware_version: 1,
            tenant_id: TenantIdFull::new_from_verified([0u8; 16]),
            target_arch: TargetArch::compiled_target(),
            valid_from_unix_secs: now_secs - 1800,
            valid_until_unix_secs: now_secs + 1800,
            release_tag: "stream-test".to_string(),
            files: entries,
        }
    }

    #[test]
    fn apply_streaming_step_skipped_when_ab_partitions_not_configured() {
        let manifest = build_manifest_for_streaming(vec![("bin/a".to_string(), b"alpha".to_vec())]);
        let params = json!({});
        let ab = AbPartitionMountConfig::default();

        let out = apply_streaming_step(&params, &ab, &manifest, AbPartition::A);
        assert!(matches!(out, StreamingStep::Skipped { .. }));
    }

    #[test]
    fn apply_streaming_step_rejects_when_mounts_set_but_no_files_param() {
        let (a, b) = tmp_mount_pair();
        let ab = AbPartitionMountConfig {
            slot_a_mount: Some(a.clone()),
            slot_b_mount: Some(b.clone()),
        };
        let manifest = build_manifest_for_streaming(vec![("bin/a".to_string(), b"alpha".to_vec())]);
        let params = json!({}); // no "files"

        let out = apply_streaming_step(&params, &ab, &manifest, AbPartition::B);
        match out {
            StreamingStep::Rejected { gate, .. } => {
                assert_eq!(gate, "no_file_source_configured");
            }
            other => panic!("expected Rejected, got {:?}", other),
        }
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn apply_streaming_step_rejects_non_object_files_param() {
        let (a, b) = tmp_mount_pair();
        let ab = AbPartitionMountConfig {
            slot_a_mount: Some(a.clone()),
            slot_b_mount: Some(b.clone()),
        };
        let manifest = build_manifest_for_streaming(vec![]);
        let params = json!({ "files": "not-an-object" });

        let out = apply_streaming_step(&params, &ab, &manifest, AbPartition::B);
        match out {
            StreamingStep::Rejected { gate, .. } => {
                assert_eq!(gate, "files_param_not_object");
            }
            other => panic!("expected Rejected, got {:?}", other),
        }
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn apply_streaming_step_rejects_bad_base64() {
        let (a, b) = tmp_mount_pair();
        let ab = AbPartitionMountConfig {
            slot_a_mount: Some(a.clone()),
            slot_b_mount: Some(b.clone()),
        };
        let manifest = build_manifest_for_streaming(vec![("bin/a".to_string(), b"alpha".to_vec())]);
        let params = json!({
            "files": {
                "bin/a": "!!!-not-valid-base64-!!!"
            }
        });

        let out = apply_streaming_step(&params, &ab, &manifest, AbPartition::B);
        match out {
            StreamingStep::Rejected { gate, failed, .. } => {
                assert_eq!(gate, "files_param_decode_failed");
                assert_eq!(failed.len(), 1);
            }
            other => panic!("expected Rejected, got {:?}", other),
        }
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn apply_streaming_step_happy_path_streams_to_target_slot_b_mount() {
        let (a, b) = tmp_mount_pair();
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
        let ab = AbPartitionMountConfig {
            slot_a_mount: Some(a.clone()),
            slot_b_mount: Some(b.clone()),
        };

        let bytes_agent = b"fake-new-agent-binary".to_vec();
        let bytes_config = b"new-config-file".to_vec();
        let manifest = build_manifest_for_streaming(vec![
            ("bin/agent".to_string(), bytes_agent.clone()),
            ("etc/suderra/config.yaml".to_string(), bytes_config.clone()),
        ]);

        let files_map = json!({
            "bin/agent": base64::engine::general_purpose::STANDARD.encode(&bytes_agent),
            "etc/suderra/config.yaml": base64::engine::general_purpose::STANDARD.encode(&bytes_config),
        });
        let params = json!({ "files": files_map });

        // Target slot B → files should land under `b` mount.
        let out = apply_streaming_step(&params, &ab, &manifest, AbPartition::B);
        match out {
            StreamingStep::Streamed { verified_count } => {
                assert_eq!(verified_count, 2);
            }
            other => panic!("expected Streamed, got {:?}", other),
        }

        // Files materialized at slot B.
        assert_eq!(std::fs::read(b.join("bin/agent")).unwrap(), bytes_agent);
        assert_eq!(
            std::fs::read(b.join("etc/suderra/config.yaml")).unwrap(),
            bytes_config
        );
        // Slot A is untouched (no file copied to A).
        assert!(!a.join("bin/agent").exists());

        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn apply_streaming_step_target_slot_a_streams_to_slot_a_mount() {
        let (a, b) = tmp_mount_pair();
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
        let ab = AbPartitionMountConfig {
            slot_a_mount: Some(a.clone()),
            slot_b_mount: Some(b.clone()),
        };

        let bytes = b"binary-for-slot-a".to_vec();
        let manifest = build_manifest_for_streaming(vec![("bin/one".to_string(), bytes.clone())]);
        let params = json!({
            "files": {
                "bin/one": base64::engine::general_purpose::STANDARD.encode(&bytes),
            }
        });

        let out = apply_streaming_step(&params, &ab, &manifest, AbPartition::A);
        assert!(matches!(out, StreamingStep::Streamed { verified_count: 1 }));
        assert_eq!(std::fs::read(a.join("bin/one")).unwrap(), bytes);
        assert!(!b.join("bin/one").exists());

        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn apply_streaming_step_rejects_when_manifest_declares_file_not_in_source() {
        let (a, b) = tmp_mount_pair();
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
        let ab = AbPartitionMountConfig {
            slot_a_mount: Some(a.clone()),
            slot_b_mount: Some(b.clone()),
        };
        let manifest = build_manifest_for_streaming(vec![
            ("bin/present".to_string(), b"here".to_vec()),
            ("bin/missing".to_string(), b"unused".to_vec()),
        ]);
        let params = json!({
            "files": {
                "bin/present": base64::engine::general_purpose::STANDARD.encode(b"here"),
                // bin/missing NOT in files map.
            }
        });

        let out = apply_streaming_step(&params, &ab, &manifest, AbPartition::B);
        match out {
            StreamingStep::Rejected {
                gate,
                failed,
                verified_count,
                ..
            } => {
                assert_eq!(gate, "stream_rejected");
                assert_eq!(verified_count, 1);
                assert_eq!(failed.len(), 1);
            }
            other => panic!("expected Rejected, got {:?}", other),
        }
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn e2e_verify_rejects_tampered_manifest_signature() {
        // Prove Gate 8 (ed25519 strict verify) rejects any
        // in-flight body tamper. Sign a v1 manifest, then
        // tamper the release_tag field, then run verify —
        // must reject with InvalidSignature.
        let seed = [0x7bu8; 32];
        let signing_key = SigningKey::from_bytes(&seed);
        let pubkey_arc = Arc::new(signing_key.verifying_key());
        let tenant = TenantIdFull::new_from_verified([0xCCu8; 16]);

        // Build manifest1 + sign.
        let manifest1 = {
            let now_secs = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64;
            FirmwareManifest {
                firmware_version: 1,
                tenant_id: tenant,
                target_arch: TargetArch::compiled_target(),
                valid_from_unix_secs: now_secs - 1800,
                valid_until_unix_secs: now_secs + 1800,
                release_tag: "v1-genuine".to_string(),
                files: vec![FileEntry {
                    path: "bin/suderra-agent".to_string(),
                    digest: FileDigest {
                        sha256: Sha256Digest::from_bytes([0x22u8; 32]),
                        size_bytes: 1024,
                        mode: 0o755,
                    },
                }],
            }
        };
        let sig1 = signing_key.sign(&manifest1.canonical_bytes().unwrap());

        // Build manifest2 with TAMPERED release_tag, paired
        // with the sig1 (which was over the genuine bytes).
        let manifest2 = FirmwareManifest {
            release_tag: "v1-TAMPERED".to_string(),
            ..manifest1
        };
        let signed_tampered =
            SignedFirmwareManifest::from_body_and_signature_bytes(manifest2, &sig1.to_bytes())
                .expect("signature bytes ok");

        let err = crate::updater::verify_firmware_manifest(
            &signed_tampered,
            &tenant,
            0,
            SystemTime::now(),
            |canonical, sig_bytes| {
                let sig = ed25519_dalek::Signature::from_bytes(sig_bytes);
                pubkey_arc.verify_strict(canonical, &sig).is_ok()
            },
        )
        .expect_err("tampered body must reject");
        assert!(matches!(
            err,
            crate::updater::ManifestVerifyError::InvalidSignature
        ));
    }
}

// Suppress unused warning for the imports the test module
// does not need; the `use` statements at module top are
// required by the non-test code paths.
#[cfg(not(test))]
#[allow(dead_code)]
fn _keep_imports_used(store: &PartitionStore) {
    let _ = store;
}
