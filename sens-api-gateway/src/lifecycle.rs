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
    AuditAction, AuditActor, AuditEntry, AuditOutcome, AuditPhase, AuditResource, AuditSink,
};
use crate::authz::permission::TenantId;
use crate::lifecycle_auth::{
    AuthError, HEADER_HMAC, HEADER_TIMESTAMP, LifecycleAuthKey, verify_request,
};
use crate::updater::{
    AbPartition, BootloaderHandle, ConfirmOutcome, ConfirmSlotSelector, PartitionStore,
    perform_confirm_slot,
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
    /// Batch 129 Sprint 6.6: HMAC auth key. None when
    /// `lifecycle_endpoint.auth_mode = Disabled` (HC-1
    /// default); Some when operator enables HmacToken +
    /// systemd-creds load succeeds at boot.
    pub auth_key: Option<Arc<LifecycleAuthKey>>,
    /// Batch 134 Sprint 6.5 wire — closes Batch 132 obs
    /// #2: HealthState reference for Prometheus metric
    /// emission. None when health feature is off or
    /// HealthState wasn't constructed at lifecycle cell
    /// population time.
    pub health_state: Option<crate::health::HealthState>,
    /// **Batch #324 D-9 migration:** clock authority
    /// reference for verify_request's trustworthy_wall_clock
    /// gate. Replaces the pre-#324 SystemTime::now() read
    /// that was vulnerable to operator clock-rollback
    /// DOS. Always Some in production (AppState always
    /// has a clock_authority — defaults to
    /// SystemClockAuthority in init_clock_authority);
    /// Option<> here so legacy LifecycleHandles
    /// constructors that don't have the clock yet can
    /// migrate gradually.
    pub clock_authority: Option<Arc<dyn crate::runtime_safety::ClockAuthority>>,
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

/// Whether the health/lifecycle HTTP server is bound to a loopback address,
/// layered as a request extension by `start_health_server`. Lets the
/// state-mutating `confirm-active` POST apply the SAME fail-closed rule the
/// observability GETs use (PR935-HIGH-005): a keyless request is refused on a
/// non-loopback bind so no network peer can drive the A/B firmware lifecycle.
#[derive(Clone, Copy, Debug)]
pub struct HealthBindIsLoopback(pub bool);

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
    Extension(bind_is_loopback): Extension<HealthBindIsLoopback>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    let Some(handles) = cell.get() else {
        warn!(
            "lifecycle confirm_active: cell not yet populated (partition_store init pending or disabled)"
        );
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "lifecycle_not_ready",
                "reason": "PartitionStore or bootloader not yet initialized at boot",
            })),
        );
    };

    // Batch 129 Sprint 6.6: HMAC auth gate. When auth_key
    // is Some (auth_mode=HmacToken), verify the per-request
    // HMAC before any state work. When None (auth_mode=
    // Disabled or systemd-creds not loaded) the request is
    // only accepted on a loopback bind — see the keyless
    // branch below (PR935-HIGH-005).
    if let Some(auth_key) = handles.auth_key.as_ref() {
        let hmac_header = headers.get(HEADER_HMAC).and_then(|v| v.to_str().ok());
        let ts_header = headers.get(HEADER_TIMESTAMP).and_then(|v| v.to_str().ok());
        // Batch #324 D-9 migration: pull the clock authority
        // from handles. AppState boot wires it post-cell-
        // population; if somehow None at this point (legacy
        // call site), fall back to a fresh SystemClockAuthority
        // for backward-compat — the trusting-0-age default
        // is a STRICTLY WEAKER posture than the migrated path
        // but matches pre-#324 behaviour. Production wiring
        // is expected to populate the field.
        let clock_authority_owned;
        let clock_ref: &dyn crate::runtime_safety::ClockAuthority =
            if let Some(c) = handles.clock_authority.as_ref() {
                &**c
            } else {
                clock_authority_owned = crate::runtime_safety::SystemClockAuthority::new();
                &clock_authority_owned
            };
        if let Err(auth_err) = verify_request(
            auth_key,
            "POST",
            "/lifecycle/confirm-active",
            hmac_header,
            ts_header,
            clock_ref,
        )
        .await
        {
            warn!("lifecycle confirm_active: HMAC auth REJECTED: {}", auth_err);
            let is_invalid_hmac = matches!(auth_err, AuthError::InvalidHmac);
            let gate_label = match auth_err {
                AuthError::MissingHmacHeader => "missing_hmac_header",
                AuthError::MissingTimestampHeader => "missing_timestamp_header",
                AuthError::MalformedHmacHeader => "malformed_hmac_header",
                AuthError::MalformedTimestampHeader => "malformed_timestamp_header",
                AuthError::TimestampOutOfWindow { .. } => "timestamp_out_of_window",
                AuthError::InvalidHmac => "invalid_hmac",
                // Batch #324 D-9 migration: ClockUnhealthy
                // arm — operator-actionable label so
                // dashboards can distinguish "agent's clock
                // broken" from "client sent bad timestamp".
                AuthError::ClockUnhealthy(_) => "clock_unhealthy",
            };
            // Batch 135 Sprint 6.5 — closes Batch 132 obs
            // #3: bump auth rejection counters. invalid_hmac
            // bucket is the operator-security signal
            // (client+server key mismatch); total bucket
            // captures all reject paths for dashboard
            // "is auth misbehaving?" visibility.
            if let Some(hs) = handles.health_state.as_ref() {
                hs.inc_lifecycle_auth_rejected(is_invalid_hmac);
            }
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({
                    "error": "hmac_auth_rejected",
                    "gate": gate_label,
                    "reason": auth_err.to_string(),
                })),
            );
        }
    } else if !bind_is_loopback.0 {
        // PR935-HIGH-005: no HMAC key configured AND the server is bound to a
        // non-loopback address. Refuse the state-mutating confirm anonymously,
        // exactly as the observability GETs do — a network peer must not be
        // able to drive the A/B firmware lifecycle (confirm a bad slot /
        // suppress rollback). Loopback keyless access stays allowed (HC-1
        // backward compat for the systemd post-boot timer on localhost).
        warn!(
            "lifecycle confirm_active: REFUSED — keyless request on a non-loopback bind; \
             configure an HMAC auth key to allow remote confirm-active"
        );
        if let Some(hs) = handles.health_state.as_ref() {
            hs.inc_lifecycle_auth_rejected(false);
        }
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error": "auth_required_for_external_bind",
                "reason": "confirm-active refuses anonymous access on a non-loopback bind \
                           without a configured HMAC auth key",
            })),
        );
    }

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
        // Batch 134: idempotent no-op is NOT counted as
        // a confirm event (the state machine didn't
        // transition). BUT refresh the active_slot gauge
        // so dashboards stay consistent when e.g. the
        // operator cold-boots a device that was already
        // Active; without the refresh, the gauge could
        // stay at the boot-default value despite the
        // endpoint being called.
        if let Some(hs) = handles.health_state.as_ref() {
            hs.set_firmware_active_slot(match active {
                AbPartition::A => 0,
                AbPartition::B => 1,
            });
            hs.set_firmware_active_version(snap.active_firmware_version);
        }
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
            // Batch 134 Sprint 6.5 — closes Batch 132 obs
            // #2: bump firmware_confirm counter + refresh
            // active_slot gauge. Same contract as the
            // cmd_confirm_slot metric-wrapper (Batch 132),
            // just reached from the HTTP path.
            if let Some(hs) = handles.health_state.as_ref() {
                hs.inc_firmware_confirm();
                hs.set_firmware_active_slot(match confirmed_slot {
                    AbPartition::A => 0,
                    AbPartition::B => 1,
                });
                hs.set_firmware_active_version(new_state.active_firmware_version);
            }
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
            error!(
                "lifecycle confirm_active: snapshot failed after idempotency check: {}",
                e
            );
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
        (AuditPhase::Post, AuditOutcome::Success) => AuditAction::FirmwareDeployApplied,
        (AuditPhase::Post, _) => AuditAction::FirmwareDeployRequested,
    };
    let entry = AuditEntry {
        timestamp_unix_secs: now.as_secs() as i64,
        timestamp_nanos: now.subsec_nanos(),
        correlation_id: format!("lifecycle-http-{}", now.as_nanos()),
        phase,
        actor: AuditActor::new(format!("system:lifecycle_http:{}", handles.device_id)),
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
            auth_key: None,
            health_state: None,
            // Batch #324 D-9: tests use legacy None;
            // verify_request falls back to a fresh
            // SystemClockAuthority via the lifecycle.rs
            // call site's owned-fallback path.
            clock_authority: None,
        }
    }

    fn build_handles_with_auth(store: Arc<PartitionStore>, key_bytes: Vec<u8>) -> LifecycleHandles {
        let key = LifecycleAuthKey::from_bytes(key_bytes).expect("valid test key");
        LifecycleHandles {
            partition_store: store,
            bootloader: Arc::new(NoopBootloaderHandle),
            audit_sink: None,
            device_id: "test-dev".to_string(),
            tenant: TenantId::new_from_verified([0u8; 16]),
            auth_key: Some(Arc::new(key)),
            health_state: None,
            clock_authority: None,
        }
    }

    fn build_handles_with_health(
        store: Arc<PartitionStore>,
        health: crate::health::HealthState,
    ) -> LifecycleHandles {
        LifecycleHandles {
            partition_store: store,
            bootloader: Arc::new(NoopBootloaderHandle),
            audit_sink: None,
            device_id: "test-dev".to_string(),
            tenant: TenantId::new_from_verified([0u8; 16]),
            auth_key: None,
            health_state: Some(health),
            clock_authority: None,
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
        let resp = confirm_active_handler(
            Extension(cell),
            Extension(HealthBindIsLoopback(true)),
            axum::http::HeaderMap::new(),
        )
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
                PartitionRoll::InitialInstall {
                    target: AbPartition::A,
                },
                3600,
            )
            .expect("install");
        store
            .apply_roll(
                PartitionRoll::Confirm {
                    slot: AbPartition::A,
                },
                3600,
            )
            .expect("confirm");

        let cell: LifecycleHandlesCell = new_cell();
        cell.set(build_handles(store.clone())).ok();

        let resp = confirm_active_handler(
            Extension(cell),
            Extension(HealthBindIsLoopback(true)),
            axum::http::HeaderMap::new(),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&lock_path);
    }

    #[tokio::test]
    async fn confirm_active_with_auth_rejects_missing_headers() {
        // Batch 129: when auth_key is Some, missing HMAC
        // headers → 401.
        let path = tmp_partition_path();
        let _ = std::fs::remove_file(&path);
        let lock_path = {
            let mut s = path.clone().into_os_string();
            s.push(".lock");
            std::path::PathBuf::from(s)
        };
        let _ = std::fs::remove_file(&lock_path);
        let store = Arc::new(PartitionStore::open(Some(&path)).expect("open"));

        let cell: LifecycleHandlesCell = new_cell();
        cell.set(build_handles_with_auth(store.clone(), vec![0x42u8; 32]))
            .ok();

        let resp = confirm_active_handler(
            Extension(cell),
            Extension(HealthBindIsLoopback(true)),
            axum::http::HeaderMap::new(), // no auth headers
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&lock_path);
    }

    #[tokio::test]
    async fn confirm_active_with_auth_rejects_wrong_hmac() {
        let path = tmp_partition_path();
        let _ = std::fs::remove_file(&path);
        let lock_path = {
            let mut s = path.clone().into_os_string();
            s.push(".lock");
            std::path::PathBuf::from(s)
        };
        let _ = std::fs::remove_file(&lock_path);
        let store = Arc::new(PartitionStore::open(Some(&path)).expect("open"));

        let cell: LifecycleHandlesCell = new_cell();
        cell.set(build_handles_with_auth(store.clone(), vec![0x42u8; 32]))
            .ok();

        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .to_string();
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            HEADER_TIMESTAMP,
            axum::http::HeaderValue::from_str(&ts).unwrap(),
        );
        headers.insert(
            HEADER_HMAC,
            axum::http::HeaderValue::from_str(&"00".repeat(32)).unwrap(),
        );

        let resp = confirm_active_handler(
            Extension(cell),
            Extension(HealthBindIsLoopback(true)),
            headers,
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&lock_path);
    }

    #[tokio::test]
    async fn confirm_active_invalid_hmac_bumps_auth_invalid_hmac_metric() {
        // Batch 135 Sprint 6.5 — closes Batch 132 obs #3:
        // When the HTTP handler rejects a request with
        // InvalidHmac, BOTH lifecycle_auth_rejected_total
        // AND lifecycle_auth_invalid_hmac_total must
        // increment. invalid_hmac = correct format but
        // wrong key → operator-actionable key-mismatch
        // signal.
        let path = tmp_partition_path();
        let _ = std::fs::remove_file(&path);
        let lock_path = {
            let mut s = path.clone().into_os_string();
            s.push(".lock");
            std::path::PathBuf::from(s)
        };
        let _ = std::fs::remove_file(&lock_path);
        let store = Arc::new(PartitionStore::open(Some(&path)).expect("open"));

        let health = crate::health::HealthState::new();
        let key = LifecycleAuthKey::from_bytes(vec![0xAAu8; 32]).unwrap();
        let cell: LifecycleHandlesCell = new_cell();
        cell.set(LifecycleHandles {
            partition_store: store.clone(),
            bootloader: Arc::new(NoopBootloaderHandle),
            audit_sink: None,
            device_id: "test-dev".into(),
            tenant: TenantId::new_from_verified([0u8; 16]),
            auth_key: Some(Arc::new(key)),
            health_state: Some(health.clone()),
            clock_authority: None,
        })
        .ok();

        // Send request with VALID shape but WRONG HMAC.
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .to_string();
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            HEADER_TIMESTAMP,
            axum::http::HeaderValue::from_str(&ts).unwrap(),
        );
        headers.insert(
            HEADER_HMAC,
            axum::http::HeaderValue::from_str(&"11".repeat(32)).unwrap(),
        );

        let resp = confirm_active_handler(
            Extension(cell),
            Extension(HealthBindIsLoopback(true)),
            headers,
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        let metrics = health.metrics_prometheus();
        let total = metrics
            .lines()
            .find(|l| l.starts_with("suderra_lifecycle_auth_rejected_total"))
            .expect("total missing");
        let invalid = metrics
            .lines()
            .find(|l| l.starts_with("suderra_lifecycle_auth_invalid_hmac_total"))
            .expect("invalid missing");
        assert!(total.ends_with(" 1"), "total=1, got: {}", total);
        assert!(invalid.ends_with(" 1"), "invalid_hmac=1, got: {}", invalid);

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&lock_path);
    }

    #[tokio::test]
    async fn confirm_active_missing_headers_bumps_only_total_counter() {
        // Batch 135: MissingHmacHeader is NOT an
        // invalid_hmac scenario. Only the total counter
        // should increment; the invalid_hmac security
        // signal stays at 0.
        let path = tmp_partition_path();
        let _ = std::fs::remove_file(&path);
        let lock_path = {
            let mut s = path.clone().into_os_string();
            s.push(".lock");
            std::path::PathBuf::from(s)
        };
        let _ = std::fs::remove_file(&lock_path);
        let store = Arc::new(PartitionStore::open(Some(&path)).expect("open"));

        let health = crate::health::HealthState::new();
        let key = LifecycleAuthKey::from_bytes(vec![0xAAu8; 32]).unwrap();
        let cell: LifecycleHandlesCell = new_cell();
        cell.set(LifecycleHandles {
            partition_store: store.clone(),
            bootloader: Arc::new(NoopBootloaderHandle),
            audit_sink: None,
            device_id: "test-dev".into(),
            tenant: TenantId::new_from_verified([0u8; 16]),
            auth_key: Some(Arc::new(key)),
            health_state: Some(health.clone()),
            clock_authority: None,
        })
        .ok();

        // Empty headers — auth enabled → MissingHmacHeader.
        let resp = confirm_active_handler(
            Extension(cell),
            Extension(HealthBindIsLoopback(true)),
            axum::http::HeaderMap::new(),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        let metrics = health.metrics_prometheus();
        let total = metrics
            .lines()
            .find(|l| l.starts_with("suderra_lifecycle_auth_rejected_total"))
            .expect("total missing");
        let invalid = metrics
            .lines()
            .find(|l| l.starts_with("suderra_lifecycle_auth_invalid_hmac_total"))
            .expect("invalid missing");
        assert!(total.ends_with(" 1"), "total=1, got: {}", total);
        assert!(
            invalid.ends_with(" 0"),
            "invalid_hmac stays 0 for missing-header, got: {}",
            invalid
        );

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&lock_path);
    }

    #[tokio::test]
    async fn keyless_confirm_active_fails_closed_on_non_loopback_bind() {
        // PR935-HIGH-005: with no HMAC key configured, a non-loopback bind
        // must REFUSE confirm-active (401) — a network peer must not drive the
        // A/B firmware lifecycle. A loopback bind still accepts it (HC-1).
        let path = tmp_partition_path();
        let _ = std::fs::remove_file(&path);
        let store = Arc::new(PartitionStore::open(Some(&path)).expect("open"));
        let health = crate::health::HealthState::new();

        let make_cell = || {
            let cell: LifecycleHandlesCell = new_cell();
            cell.set(LifecycleHandles {
                partition_store: store.clone(),
                bootloader: Arc::new(NoopBootloaderHandle),
                audit_sink: None,
                device_id: "test-dev".into(),
                tenant: TenantId::new_from_verified([0u8; 16]),
                auth_key: None, // keyless (auth_mode=Disabled)
                health_state: Some(health.clone()),
                clock_authority: None,
            })
            .ok();
            cell
        };

        // Non-loopback bind + keyless → fail closed.
        let external = confirm_active_handler(
            Extension(make_cell()),
            Extension(HealthBindIsLoopback(false)),
            axum::http::HeaderMap::new(),
        )
        .await
        .into_response();
        assert_eq!(
            external.status(),
            StatusCode::UNAUTHORIZED,
            "keyless confirm-active on a non-loopback bind must be refused"
        );
        // The rejection must bump the lifecycle-auth-rejected total.
        let total = health
            .metrics_prometheus()
            .lines()
            .find(|l| l.starts_with("suderra_lifecycle_auth_rejected_total"))
            .map(|l| l.ends_with(" 1"))
            .unwrap_or(false);
        assert!(
            total,
            "keyless external refusal must bump the rejected metric"
        );

        // Loopback bind + keyless → NOT a 401 (proceeds; a fresh store yields a
        // 409 idempotent no-op, never UNAUTHORIZED).
        let loopback = confirm_active_handler(
            Extension(make_cell()),
            Extension(HealthBindIsLoopback(true)),
            axum::http::HeaderMap::new(),
        )
        .await
        .into_response();
        assert_ne!(
            loopback.status(),
            StatusCode::UNAUTHORIZED,
            "keyless confirm-active on a loopback bind must still be accepted (HC-1)"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn confirm_active_http_path_bumps_firmware_confirm_metric() {
        // Batch 134 Sprint 6.5 — closes Batch 132 obs #2:
        // when the HTTP lifecycle endpoint transitions a
        // PendingConfirm slot to Active, it must bump the
        // Prometheus firmware_confirm counter + update
        // active_slot + active_version gauges.
        let path = tmp_partition_path();
        let _ = std::fs::remove_file(&path);
        let lock_path = {
            let mut s = path.clone().into_os_string();
            s.push(".lock");
            std::path::PathBuf::from(s)
        };
        let _ = std::fs::remove_file(&lock_path);

        let store = Arc::new(PartitionStore::open(Some(&path)).expect("open"));
        // Install v7 + leave slot A PendingConfirm.
        store
            .apply_roll_with_version_bump(
                crate::updater::PartitionRoll::InitialInstall {
                    target: AbPartition::A,
                },
                3600,
                7,
            )
            .expect("install v7");

        let health = crate::health::HealthState::new();
        let cell: LifecycleHandlesCell = new_cell();
        cell.set(build_handles_with_health(store.clone(), health.clone()))
            .ok();

        let resp = confirm_active_handler(
            Extension(cell),
            Extension(HealthBindIsLoopback(true)),
            axum::http::HeaderMap::new(),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);

        let metrics = health.metrics_prometheus();
        let confirm_line = metrics
            .lines()
            .find(|l| l.starts_with("suderra_firmware_confirm_total"))
            .expect("confirm metric missing");
        assert!(
            confirm_line.ends_with(" 1"),
            "expected 1 confirm after HTTP post, got: {}",
            confirm_line
        );
        let slot_line = metrics
            .lines()
            .find(|l| l.starts_with("suderra_firmware_active_slot"))
            .expect("slot gauge missing");
        assert!(
            slot_line.ends_with(" 0"),
            "expected slot=0 (A), got: {}",
            slot_line
        );
        let version_line = metrics
            .lines()
            .find(|l| l.starts_with("suderra_firmware_active_version"))
            .expect("version gauge missing");
        assert!(
            version_line.ends_with(" 7"),
            "expected version=7, got: {}",
            version_line
        );

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&lock_path);
    }

    #[tokio::test]
    async fn confirm_active_with_auth_accepts_valid_hmac() {
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
                crate::updater::PartitionRoll::InitialInstall {
                    target: AbPartition::A,
                },
                3600,
            )
            .expect("install");
        store
            .apply_roll(
                crate::updater::PartitionRoll::Confirm {
                    slot: AbPartition::A,
                },
                3600,
            )
            .expect("confirm");
        // Slot A already Active → idempotent 200 path.

        let key_bytes = vec![0x55u8; 32];
        let cell: LifecycleHandlesCell = new_cell();
        cell.set(build_handles_with_auth(store.clone(), key_bytes.clone()))
            .ok();

        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        // Compute HMAC as the client would.
        let key = LifecycleAuthKey::from_bytes(key_bytes).unwrap();
        let mac =
            crate::lifecycle_auth::compute_hmac(&key, ts, "POST", "/lifecycle/confirm-active");
        let hmac_hex: String = mac.iter().map(|b| format!("{:02x}", b)).collect();

        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            HEADER_TIMESTAMP,
            axum::http::HeaderValue::from_str(&ts.to_string()).unwrap(),
        );
        headers.insert(
            HEADER_HMAC,
            axum::http::HeaderValue::from_str(&hmac_hex).unwrap(),
        );

        let resp = confirm_active_handler(
            Extension(cell),
            Extension(HealthBindIsLoopback(true)),
            headers,
        )
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
                PartitionRoll::InitialInstall {
                    target: AbPartition::A,
                },
                3600,
            )
            .expect("install");
        // slot A is now PendingConfirm; snap.active = A.

        let cell: LifecycleHandlesCell = new_cell();
        cell.set(build_handles(store.clone())).ok();

        let resp = confirm_active_handler(
            Extension(cell),
            Extension(HealthBindIsLoopback(true)),
            axum::http::HeaderMap::new(),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);

        let snap = store.snapshot().expect("snap");
        assert_eq!(snap.slot_a_state, crate::updater::SlotState::Active);

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&lock_path);
    }
}
