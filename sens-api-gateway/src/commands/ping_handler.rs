//! PingHandler — first migration to the Batch #236 `EnvelopeHandler`
//! trait + Batch #237 `CommandDispatcher` chain.
//!
//! ## Purpose
//!
//! Ultra-plan `ULTRA-HIGH-002` (A-1b) mandates migrating every `cmd_*`
//! inherent method on `crate::commands::CommandHandler` into an
//! `impl EnvelopeHandler` struct so the Tier-1 seal from Batch #236
//! takes effect at runtime. This batch picks `cmd_ping` as the first
//! migration because it has the smallest blast radius: no `params`,
//! no state mutation, zero dependencies on `CommandHandler::state`.
//! That lets the migration shake down the end-to-end dispatcher
//! chain (verify → authorize → dispatch) against
//! `InMemoryPolicyEngine` + a canned RBAC manifest without any
//! domain-specific authz ambiguity.
//!
//! Subsequent ultra-plan batches (part of the C-3 commands.rs split at
//! #238-#240) migrate the remaining handlers — `cmd_get_info`,
//! `cmd_get_config`, `cmd_set_log_level` from this same module, then
//! the higher-blast-radius handlers (`cmd_deploy_bytecode_program`,
//! `cmd_force_value`, `cmd_watch_subscribe`, etc). Each migration
//! deletes the corresponding inherent `CommandHandler::cmd_*` method
//! + registers the new struct with the dispatcher in `main.rs`.
//!
//! ## Permission choice: `Permission::ReadTag`
//!
//! `Permission` enum (`authz/permission.rs`) does not yet carry a
//! `Diagnostic` or `SystemStatus` variant. `ReadTag` is the weakest
//! existing permission + every RBAC role that grants basic read
//! access to the edge also grants `ReadTag`. Using `ReadTag` as the
//! ping-authz proxy is semantically loose but architecturally safe:
//! it does NOT widen any access surface + keeps the seal intact.
//! A future batch (after ADR-017 review of permission vocabulary)
//! may add `Permission::SystemStatus` and this handler would flip to
//! that — the migration would be one-line (`required_permission`
//! body) because the dispatcher already threads the permission through
//! the full chain.
//!
//! Note: the alternative (skip authz for ping by special-casing the
//! dispatcher) was rejected because it reintroduces the "forgot to
//! authorize" runtime-bug class that Batch #236 closed at the type
//! level. Every command goes through the gate; ping is no exception.
//!
//! ## Parallel path coexistence
//!
//! Batch #238 does NOT delete the existing inherent
//! `CommandHandler::cmd_ping` method nor modify the `mod.rs` match
//! arm. Those are Batch #239 scope. During this transition window
//! both paths exist; the old path remains the production dispatch
//! target while the new path is exercised by integration tests.
//! Batch #239 flips the switch + deletes the old path.
//!
//! ## Cross-references
//!
//! - Batch #236 `command_envelope::handler` — trait + HandlerInput
//! - Batch #237 `command_envelope::dispatcher` — registry + run
//! - Finding registry `ULTRA-HIGH-002` / ultra-plan `#Gap-A-1b`
//! - Existing `cmd_ping` at `src/commands/diagnostic.rs:40`

#![allow(dead_code)]

use async_trait::async_trait;
use chrono::Utc;
use serde::Deserialize;
use tracing::info;

use crate::authz::permission::Permission;
use crate::command_envelope::{
    EnvelopeHandler, HandlerError, HandlerInput, HandlerResponse,
};

/// Payload shape for ping. Empty on the wire (`params: {}`); serde
/// deserializes any JSON object into a `PingPayload` as long as no
/// required fields are missing (there are none). Dense-mode JSON
/// with extra fields is tolerated — ping is a probe command.
#[derive(Debug, Deserialize, Default, PartialEq)]
pub struct PingPayload {
    // Intentionally empty. If the wire format ever evolves (e.g., an
    // `echo_nonce` to bind a client-specific replay probe), a field
    // is added here + the response includes it in `pong`.
}

/// Health-check handler. Returns a monotonic-clock-safe timestamp so
/// operators can measure edge→cloud round-trip latency. Does not
/// touch `AppState` — registrable into `CommandDispatcher` without
/// any dependency.
pub struct PingHandler;

#[async_trait]
impl EnvelopeHandler for PingHandler {
    type Payload = PingPayload;

    fn cmd_name(&self) -> &'static str {
        "ping"
    }

    fn required_permission(&self, _payload: &Self::Payload) -> Permission {
        // See module doc — ReadTag is the weakest existing permission
        // and the architectural seal requires a gate even for probes.
        // Flip to Permission::SystemStatus when the enum gains it.
        Permission::ReadTag
    }

    async fn dispatch(
        &self,
        input: HandlerInput<Self::Payload>,
    ) -> Result<HandlerResponse, HandlerError> {
        info!(
            actor = %input.ctx().actor_audit_label(),
            cmd = %input.meta().cmd_name,
            "ping handler dispatch"
        );
        let body = serde_json::json!({
            "pong": true,
            "timestamp": Utc::now().to_rfc3339(),
        });
        Ok(HandlerResponse::mirror(body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::context::{ActorIdentity, AuthorizationDecision};
    use crate::authz::in_memory_engine::InMemoryPolicyEngine;
    use crate::authz::manifest::{
        CustomRole, Ed25519PublicKeyBytes, OperatorBinding, RbacManifest,
    };
    use crate::authz::manifest_runtime::RbacManifestStore;
    use crate::authz::permission::{OperatorId, TenantId};
    use crate::authz::policy::PolicyEngine;
    use crate::command_envelope::{canonical::CmdHash, CommandDispatcher, CommandEnvelope};
    use crate::command_envelope::dispatcher::DispatchError;
    use crate::command_envelope::jti::Jti;
    use std::sync::Arc;
    use std::time::{Duration, UNIX_EPOCH};

    fn canned_tenant() -> TenantId {
        TenantId::new_from_verified([0x42u8; 16])
    }
    fn canned_operator() -> OperatorId {
        OperatorId::new_from_verified([0x07u8; 16])
    }
    fn canned_pubkey() -> Ed25519PublicKeyBytes {
        Ed25519PublicKeyBytes::from_bytes([0xAAu8; 32])
    }

    /// Manifest that grants the canned operator the "diagnostic" role
    /// which holds `ReadTag`. The end-to-end dispatcher test proves
    /// this reaches the handler body.
    fn manifest_with_readtag() -> RbacManifest {
        RbacManifest {
            policy_version: 10,
            tenant_id: canned_tenant(),
            manifest_valid_from_unix_secs: 1_000_000_000,
            manifest_valid_until_unix_secs: 2_000_000_000,
            operator_bindings: vec![OperatorBinding {
                operator_id: canned_operator(),
                pubkey: canned_pubkey(),
                role_names: vec!["diagnostic".into()],
            }],
            roles: vec![CustomRole {
                name: "diagnostic".into(),
                permissions: vec![Permission::ReadTag],
                valid_from_unix_secs: 1_000_000_000,
                valid_until_unix_secs: 2_000_000_000,
                is_emergency_role: false,
            }],
        }
    }

    /// Manifest that grants the operator a role but NOT `ReadTag` —
    /// used to prove the deny path.
    fn manifest_without_readtag() -> RbacManifest {
        RbacManifest {
            policy_version: 10,
            tenant_id: canned_tenant(),
            manifest_valid_from_unix_secs: 1_000_000_000,
            manifest_valid_until_unix_secs: 2_000_000_000,
            operator_bindings: vec![OperatorBinding {
                operator_id: canned_operator(),
                pubkey: canned_pubkey(),
                role_names: vec!["watcher_only".into()],
            }],
            roles: vec![CustomRole {
                name: "watcher_only".into(),
                permissions: vec![Permission::WatchSubscribe],
                valid_from_unix_secs: 1_000_000_000,
                valid_until_unix_secs: 2_000_000_000,
                is_emergency_role: false,
            }],
        }
    }

    fn store_with(m: RbacManifest) -> Arc<RbacManifestStore> {
        let s = Arc::new(RbacManifestStore::new());
        s.test_set_manifest(m);
        s
    }

    fn canned_envelope(cmd: &str, params: serde_json::Value) -> CommandEnvelope {
        CommandEnvelope {
            cmd: cmd.to_string(),
            params,
            actor: [0x07u8; 16],
            tenant_id: [0x42u8; 16],
            iat_unix_secs: 1_500_000_000,
            exp_unix_secs: 1_500_001_000,
            // Batch #295 ORPHAN-MEDIUM-019 closure: tests use the
            // canned engine version (10) so the rollback-defense
            // gate (claimed >= highest_seen) passes. Tests that
            // exercise the StalePolicyVersion deny path override
            // this baseline to a value < highest_seen.
            claimed_policy_version: 10,
            // Batch #305 default — tests don't exercise two-person integrity.
            co_approver_actor: None,
            co_approver_signature: None,
            jti: "01HZAAAAAAAAAAAAAAAAAAAAAA".into(),
            nonce: "ping-test".into(),
            cmd_hash: CmdHash::from_bytes([0u8; 32]),
            signature: None,
        }
    }

    #[test]
    fn cmd_name_is_ping() {
        assert_eq!(EnvelopeHandler::cmd_name(&PingHandler), "ping");
    }

    #[test]
    fn required_permission_is_readtag() {
        let p = PingHandler;
        let payload = PingPayload::default();
        assert_eq!(p.required_permission(&payload), Permission::ReadTag);
    }

    #[tokio::test]
    async fn ping_payload_accepts_empty_object() {
        let v: PingPayload = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(v, PingPayload::default());
    }

    #[tokio::test]
    async fn ping_payload_accepts_extra_fields() {
        // Defensive tolerance — server skew tolerance for clients
        // that speculatively add fields.
        let v: PingPayload =
            serde_json::from_value(serde_json::json!({"extra": 42})).unwrap();
        assert_eq!(v, PingPayload::default());
    }

    #[tokio::test]
    async fn dispatch_produces_pong_payload() {
        use crate::authz::context::AuthorizedContext;
        use crate::command_envelope::{handler::EnvelopeMeta, HandlerInput};
        let ctx = AuthorizedContext::new_from_verified(
            ActorIdentity::Operator(canned_operator()),
            Permission::ReadTag,
            canned_tenant(),
            10,
            false,
            UNIX_EPOCH + Duration::from_secs(1_500_000_000),
        );
        let meta = EnvelopeMeta {
            jti: Jti::try_new("01HZAAAAAAAAAAAAAAAAAAAAAA".to_string()).unwrap(),
            cmd_name: "ping".into(),
            iat_unix_secs: 1_500_000_000,
            exp_unix_secs: 1_500_001_000,
        };
        let input = HandlerInput::for_test(ctx, PingPayload::default(), meta);
        let resp = PingHandler.dispatch(input).await.expect("ok");
        assert_eq!(resp.payload["pong"], true);
        assert!(resp.payload["timestamp"].is_string());
        assert_eq!(resp.payload, resp.audit_detail);
    }

    #[tokio::test]
    async fn end_to_end_dispatcher_allow_reaches_handler() {
        let engine: Arc<dyn PolicyEngine> =
            Arc::new(InMemoryPolicyEngine::new(store_with(manifest_with_readtag())));
        let mut d = CommandDispatcher::new(engine, canned_tenant());
        d.register(PingHandler);
        let env = canned_envelope("ping", serde_json::json!({}));
        let jti = Jti::try_new(env.jti.clone()).unwrap();
        let resp = d
            .run(
                &env,
                jti,
                ActorIdentity::Operator(canned_operator()),
                env.claimed_policy_version,
                UNIX_EPOCH + Duration::from_secs(1_500_000_000),
            )
            .await
            .expect("allow path");
        assert_eq!(resp.payload["pong"], true);
    }

    #[tokio::test]
    async fn end_to_end_dispatcher_deny_blocks_handler() {
        // Operator has role "watcher_only" — no ReadTag. Engine must
        // deny + handler must NOT run.
        let engine: Arc<dyn PolicyEngine> = Arc::new(InMemoryPolicyEngine::new(
            store_with(manifest_without_readtag()),
        ));
        let mut d = CommandDispatcher::new(engine, canned_tenant());
        d.register(PingHandler);
        let env = canned_envelope("ping", serde_json::json!({}));
        let jti = Jti::try_new(env.jti.clone()).unwrap();
        let result = d
            .run(
                &env,
                jti,
                ActorIdentity::Operator(canned_operator()),
                env.claimed_policy_version,
                UNIX_EPOCH + Duration::from_secs(1_500_000_000),
            )
            .await;
        match result {
            Err(DispatchError::Denied(_)) => {}
            other => panic!("expected Denied, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn end_to_end_dispatcher_unknown_operator_denies() {
        // Manifest has canned_operator; we ping as a different
        // operator → engine sees no binding → PermissionNotGranted.
        let engine: Arc<dyn PolicyEngine> =
            Arc::new(InMemoryPolicyEngine::new(store_with(manifest_with_readtag())));
        let mut d = CommandDispatcher::new(engine, canned_tenant());
        d.register(PingHandler);
        let stranger = OperatorId::new_from_verified([0xDEu8; 16]);
        let env = canned_envelope("ping", serde_json::json!({}));
        let jti = Jti::try_new(env.jti.clone()).unwrap();
        let result = d
            .run(
                &env,
                jti,
                ActorIdentity::Operator(stranger),
                env.claimed_policy_version,
                UNIX_EPOCH + Duration::from_secs(1_500_000_000),
            )
            .await;
        match result {
            Err(DispatchError::Denied(
                crate::authz::context::AuthorizationDenyReason::PermissionNotGranted,
            )) => {}
            other => panic!("expected Denied(PermissionNotGranted), got {:?}", other),
        }
    }

    #[tokio::test]
    async fn end_to_end_dispatcher_tenant_mismatch_denies() {
        // Envelope tenant bytes match canned, but the dispatcher's
        // bound tenant differs — proves the dispatcher-bound tenant
        // reaches the engine (independent of envelope tenant). This
        // guards against accidentally reading tenant from the
        // envelope at the dispatcher layer (which would be a
        // trust-boundary hole since the envelope is client input).
        let engine: Arc<dyn PolicyEngine> =
            Arc::new(InMemoryPolicyEngine::new(store_with(manifest_with_readtag())));
        let wrong_tenant = TenantId::new_from_verified([0xFFu8; 16]);
        let mut d = CommandDispatcher::new(engine, wrong_tenant);
        d.register(PingHandler);
        let env = canned_envelope("ping", serde_json::json!({}));
        let jti = Jti::try_new(env.jti.clone()).unwrap();
        let result = d
            .run(
                &env,
                jti,
                ActorIdentity::Operator(canned_operator()),
                env.claimed_policy_version,
                UNIX_EPOCH + Duration::from_secs(1_500_000_000),
            )
            .await;
        match result {
            Err(DispatchError::Denied(
                crate::authz::context::AuthorizationDenyReason::TenantMismatch { .. },
            )) => {}
            other => panic!("expected Denied(TenantMismatch), got {:?}", other),
        }
    }
}
