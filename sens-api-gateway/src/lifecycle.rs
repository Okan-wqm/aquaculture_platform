//! Lifecycle HTTP endpoints (Batch 122 Sprint 6.5).
//!
//! ## WHY
//!
//! Plan §5 Faz 2 item 6 + Batch 113 observation #1:
//! `run_confirm_active` CLI (Batch 110) runs OUT-OF-PROCESS
//! + writes PartitionStore directly + does NOT emit to the
//! HMAC-chained audit sink. Two separate problems:
//!
//! 1. Cross-process write contention against the running
//!    agent (partially closed by Batch 121's flock + disk-
//!    reread discipline).
//! 2. Silent forensic gap — the confirm event is invisible
//!    to the audit chain. SL-2 FR6 audit retention +
//!    forensic reconstruction break.
//!
//! Root-cause fix: the systemd post-boot-confirm timer
//! should POST to an HTTP endpoint on the running agent,
//! which runs the confirm via the SAME in-process
//! orchestrator the MQTT command path uses. That way:
//!
//! - Single-writer discipline for PartitionStore: only the
//!   running agent writes (post-Batch-122 the CLI is an
//!   emergency-debug fallback, not the standard systemd
//!   path).
//! - Full audit emit via the Batch 113 watchdog pattern
//!   (this module emits pre+post events directly, NOT
//!   through the Batch 79 dispatch layer — the endpoint is
//!   not an MQTT command).
//!
//! ## Endpoint
//!
//! - `POST /lifecycle/confirm-active` — no body; confirms
//!   the CURRENT snapshot.active slot (ActiveFromSnapshot
//!   selector). Returns 200 + structured JSON on success
//!   or 409 (conflict) / 500 (error) on failure.
//!
//! Extending with explicit-slot `POST
//! /lifecycle/confirm-slot/{a|b}` is straightforward via a
//! second route; not needed for the systemd-timer use case
//! (self-confirm is the primary pattern).
//!
//! ## Authorization
//!
//! The HealthServer binds to localhost only (per existing
//! HealthServerConfig default). Any process running as the
//! `suderra` user can hit the endpoint. This matches the
//! `--confirm-active` CLI's threat model: same-UID
//! processes already have filesystem-level write access
//! to /var/lib/suderra/partition.json, so an endpoint
//! accessible at the same authorization layer doesn't
//! widen the attack surface. HMAC-token authentication
//! via systemd-creds is tracked as a Sprint 6.6
//! hardening follow-up.
//!
//! ## Not MQTT
//!
//! This endpoint is NOT routed through CommandHandler.
//! Consequence: the Batch 79 dispatch-layer audit emit
//! does not fire. This module emits audit entries
//! directly, matching the Batch 113 watchdog pattern
//! (also an out-of-dispatch-path producer of firmware
//! lifecycle events).

#![cfg(feature = "health")]

use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    extract::Extension,
    http::StatusCode,
    response::{IntoResponse, Json},
};
use serde_json::json;
use tracing::{error, info, warn};

use crate::audit::{
    AuditAction, AuditActor, AuditEntry, AuditOutcome, AuditPhase, AuditResource,
    AuditSink,
};
use crate::authz::permission::TenantId;
use crate::updater::{
    perform_confirm_slot, AbPartition, BootloaderHandle, ConfirmOutcome,
    ConfirmSlotSelector, PartitionStore,
};

/// Shared lifecycle context — the handles the HTTP
/// endpoint needs to serve confirm-active without
/// re-reading AppState per request.
pub struct LifecycleHandles {
    pub partition_store: Arc<PartitionStore>,
    pub bootloader: Arc<dyn BootloaderHandle>,
    pub audit_sink: Option<Arc<AuditSink>>,
    pub device_id: String,
    pub tenant: TenantId,
}

/// Axum-shareable container for `LifecycleHandles`.
/// `OnceLock` is the set-once-read-many primitive matching
/// the boot-time init pattern: health server starts early,
/// partition_store + audit_sink init later; the cell is
/// populated once both prerequisites land.
///
/// Wrapped in `Arc` so `.clone()` produces a cheap shared
/// handle for axum's `Extension` layer.
pub type LifecycleHandlesCell = Arc<OnceLock<LifecycleHandles>>;

/// Construct an empty cell for boot-time pre-allocation.
pub fn new_cell() -> LifecycleHandlesCell {
    Arc::new(OnceLock::new())
}

/// `POST /lifecycle/confirm-active` handler.
///
/// Resolves the CURRENT active slot from PartitionStore,
/// runs `perform_confirm_slot(ActiveFromSnapshot)`, emits
/// pre+post audit entries with `FirmwareDeployApplied` /
/// `FirmwareDeployRequested` actions matching the Batch
/// 120 taxonomy.
///
/// Response codes:
/// - 200 — Confirm succeeded (bootloader coord may still
///   have failed; check `bootloader_coordination.cleared_pending_boot`
///   in response JSON for split-brain signal).
/// - 409 — Conflict: PartitionStore not ready OR no active
///   PendingConfirm slot to confirm (idempotent no-op path).
/// - 500 — Internal error (apply_roll or snapshot failure
///   other than idempotent no-op).
pub async fn confirm_active_handler(
    Extension(cell): Extension<LifecycleHandlesCell>,
) -> impl IntoResponse {
    let Some(handles) = cell.get() else {
        warn!("lifecycle confirm_active: cell not yet populated (partition_store init pending or disabled)");
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "lifecycle_not_ready",
                "reason": "PartitionStore or bootloader not yet initialized at boot",
            })),
        );
    };

    // Pre-exec audit emit — matches the Batch 113 watchdog
    // pattern for out-of-dispatch-path producers.
    emit_audit(
        handles,
        AuditPhase::Pre,
        AuditOutcome::Success,
        "action=confirm_active source=http_endpoint".to_string(),
    );

    // Check idempotency BEFORE calling perform_confirm_slot
    // so the happy "slot already Active" path returns 200
    // instead of ApplyRollRejected 500.
    let snap = match handles.partition_store.snapshot() {
        Ok(s) => s,
        Err(e) => {
            error!("lifecycle confirm_active: snapshot failed: {}", e);
            emit_audit(
                handles,
                AuditPhase::Post,
                AuditOutcome::Failure,
                format!("outcome=snapshot_failed err={}", e),
            );
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "error": "snapshot_failed",
                    "reason": e.to_string(),
                })),
            );
        }
    };

    let active = snap.active;
    if snap.state_of(active) == crate::updater::SlotState::Active {
        info!(
            "lifecycle confirm_active: slot {:?} already Active (idempotent no-op)",
            active
        );
        emit_audit(
            handles,
            AuditPhase::Post,
            AuditOutcome::Success,
            format!(
                "outcome=idempotent_noop slot={:?} state=already_active",
                active
            ),
        );
        let slot_str = slot_to_str(active);
        return (
            StatusCode::OK,
            Json(json!({
                "confirmed_slot": slot_str,
                "idempotent_noop": true,
                "note": "slot was already Active — no state transition applied",
            })),
        );
    }

    let outcome = perform_confirm_slot(
        &handles.partition_store,
        &handles.bootloader,
        ConfirmSlotSelector::ActiveFromSnapshot,
    );

    match outcome {
        ConfirmOutcome::Ok {
            confirmed_slot,
            new_state,
            bootloader_backend,
            bootloader_ok,
            bootloader_err,
        } => {
            info!(
                "lifecycle confirm_active: slot={:?} bootloader_ok={} backend={}",
                confirmed_slot, bootloader_ok, bootloader_backend
            );
            emit_audit(
                handles,
                AuditPhase::Post,
                AuditOutcome::Success,
                format!(
                    "outcome=ok confirmed_slot={:?} bootloader_ok={} backend={}",
                    confirmed_slot, bootloader_ok, bootloader_backend
                ),
            );
            let slot_str = slot_to_str(confirmed_slot);
            (
                StatusCode::OK,
                Json(json!({
                    "confirmed_slot": slot_str,
                    "new_state": new_state,
                    "bootloader_coordination": {
                        "backend": bootloader_backend,
                        "cleared_pending_boot": bootloader_ok,
                        "error": bootloader_err,
                    },
                })),
            )
        }
        ConfirmOutcome::SnapshotFailed(e) => {
            error!("lifecycle confirm_active: snapshot failed after idempotency check: {}", e);
            emit_audit(
                handles,
                AuditPhase::Post,
                AuditOutcome::Failure,
                format!("outcome=snapshot_failed_post_idempotency err={}", e),
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "error": "snapshot_failed",
                    "reason": e,
                })),
            )
        }
        ConfirmOutcome::ApplyRollRejected(e) => {
            warn!("lifecycle confirm_active: apply_roll rejected: {}", e);
            emit_audit(
                handles,
                AuditPhase::Post,
                AuditOutcome::Failure,
                format!("outcome=apply_rejected err={}", e),
            );
            (
                StatusCode::CONFLICT,
                Json(json!({
                    "error": "apply_roll_rejected",
                    "reason": e,
                })),
            )
        }
        ConfirmOutcome::InvalidSlotParam(raw) => {
            // Not reachable via this endpoint (we only use
            // ActiveFromSnapshot) but mapped for
            // exhaustiveness.
            warn!("lifecycle confirm_active: invalid slot param {:?}", raw);
            emit_audit(
                handles,
                AuditPhase::Post,
                AuditOutcome::Failure,
                format!("outcome=invalid_slot_param raw={}", raw),
            );
            (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "invalid_slot_param",
                    "raw": raw,
                })),
            )
        }
    }
}

fn slot_to_str(slot: AbPartition) -> &'static str {
    match slot {
        AbPartition::A => "a",
        AbPartition::B => "b",
    }
}

fn emit_audit(
    handles: &LifecycleHandles,
    phase: AuditPhase,
    outcome: AuditOutcome,
    detail: String,
) {
    let Some(sink) = handles.audit_sink.as_ref() else {
        return;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let action = match (phase, outcome) {
        (AuditPhase::Pre, _) => AuditAction::FirmwareDeployRequested,
        (AuditPhase::Post, AuditOutcome::Success) => {
            AuditAction::FirmwareDeployApplied
        }
        (AuditPhase::Post, _) => AuditAction::FirmwareDeployRequested,
    };
    let entry = AuditEntry {
        timestamp_unix_secs: now.as_secs() as i64,
        timestamp_nanos: now.subsec_nanos(),
        correlation_id: format!("lifecycle-http-{}", now.as_nanos()),
        phase,
        actor: AuditActor::new(format!(
            "system:lifecycle_http:{}",
            handles.device_id
        )),
        tenant: handles.tenant,
        policy_version: 0,
        two_person_integrity_verified: false,
        action,
        resource: AuditResource::Other {
            label: "ab_partition".to_string(),
        },
        outcome,
        detail,
    };
    if let Err(e) = sink.append(entry) {
        warn!(
            "lifecycle confirm_active audit emit failed (phase={:?} outcome={:?}): {}",
            phase, outcome, e
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::updater::{NoopBootloaderHandle, PartitionRoll};

    fn tmp_partition_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "suderra-lifecycle-test-{}-{}.json",
            std::process::id(),
            rand::random::<u32>()
        ))
    }

    fn build_handles(store: Arc<PartitionStore>) -> LifecycleHandles {
        LifecycleHandles {
            partition_store: store,
            bootloader: Arc::new(NoopBootloaderHandle),
            audit_sink: None,
            device_id: "test-dev".to_string(),
            tenant: TenantId::new_from_verified([0u8; 16]),
        }
    }

    #[test]
    fn new_cell_is_empty() {
        let cell = new_cell();
        assert!(cell.get().is_none());
    }

    #[test]
    fn cell_accepts_one_set() {
        let cell = new_cell();
        let path = tmp_partition_path();
        let _ = std::fs::remove_file(&path);
        let lock_path = {
            let mut s = path.clone().into_os_string();
            s.push(".lock");
            std::path::PathBuf::from(s)
        };
        let _ = std::fs::remove_file(&lock_path);
        let store = Arc::new(PartitionStore::open(Some(&path)).expect("open"));
        let handles = build_handles(store);

        assert!(cell.set(handles).is_ok());
        assert!(cell.get().is_some());

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&lock_path);
    }

    #[tokio::test]
    async fn confirm_active_returns_503_when_cell_empty() {
        let cell: LifecycleHandlesCell = new_cell();
        let resp = confirm_active_handler(Extension(cell))
            .await
            .into_response();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn confirm_active_returns_200_idempotent_when_slot_already_active() {
        // Setup: slot A Active, no PendingConfirm. Confirm
        // is an idempotent no-op + returns 200 with
        // `idempotent_noop: true` flag.
        let path = tmp_partition_path();
        let _ = std::fs::remove_file(&path);
        let lock_path = {
            let mut s = path.clone().into_os_string();
            s.push(".lock");
            std::path::PathBuf::from(s)
        };
        let _ = std::fs::remove_file(&lock_path);

        let store = Arc::new(PartitionStore::open(Some(&path)).expect("open"));
        store
            .apply_roll(
                PartitionRoll::InitialInstall { target: AbPartition::A },
                3600,
            )
            .expect("install");
        store
            .apply_roll(PartitionRoll::Confirm { slot: AbPartition::A }, 3600)
            .expect("confirm");

        let cell: LifecycleHandlesCell = new_cell();
        cell.set(build_handles(store.clone())).ok();

        let resp = confirm_active_handler(Extension(cell))
            .await
            .into_response();
        assert_eq!(resp.status(), StatusCode::OK);

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&lock_path);
    }

    #[tokio::test]
    async fn confirm_active_returns_200_on_pending_confirm_transition() {
        // Setup: slot A PendingConfirm (mid-post-boot-
        // confirm window). Handler transitions it to
        // Active + returns 200.
        let path = tmp_partition_path();
        let _ = std::fs::remove_file(&path);
        let lock_path = {
            let mut s = path.clone().into_os_string();
            s.push(".lock");
            std::path::PathBuf::from(s)
        };
        let _ = std::fs::remove_file(&lock_path);

        let store = Arc::new(PartitionStore::open(Some(&path)).expect("open"));
        store
            .apply_roll(
                PartitionRoll::InitialInstall { target: AbPartition::A },
                3600,
            )
            .expect("install");
        // slot A is now PendingConfirm; snap.active = A.

        let cell: LifecycleHandlesCell = new_cell();
        cell.set(build_handles(store.clone())).ok();

        let resp = confirm_active_handler(Extension(cell))
            .await
            .into_response();
        assert_eq!(resp.status(), StatusCode::OK);

        let snap = store.snapshot().expect("snap");
        assert_eq!(snap.slot_a_state, crate::updater::SlotState::Active);

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&lock_path);
    }
}
