//! Typed authz port for OPC UA — Batch #241 Faz 5 (ultra-plan
//! `ULTRA-HIGH-003` continuation; prepares for `ULTRA-HIGH-004`
//! A-2b custom NodeManager).
//!
//! ## Role in the dependency chain
//!
//! Batch #239 introduced `AuthenticatedUser` (typed session
//! principal, no string ctors). Batch #240 introduced
//! `OpcUaActorResolver` (manifest-backed enrollment check).
//! Batch #223 introduced `InMemoryPolicyEngine` (per-command
//! authorize against the signed RBAC manifest). The OPC UA write
//! path needs to compose all three — that composition is what this
//! batch lands.
//!
//! The existing `OpcUaAuthzPort` trait (`opc_ua_server.rs:386`)
//! takes `actor: &str` + `tag_name: &str` and returns a `bool` —
//! shaped for the Batch 224 `SimpleNodeManager` callback path
//! where the session layer hands the callback a string. That shape
//! cannot carry a typed session principal + drops the authz
//! decision's structured reason (everything collapses to bool).
//!
//! `TypedAuthzPort` is the replacement shape: takes a
//! `&AuthenticatedUser` + tag name + received-at timestamp, returns
//! either an `AuthorizedContext` (proof-token downstream handler
//! wiring consumes) or a structured `TypedAuthzError`. No strings
//! crossing the boundary; no bool collapse; the full chain from
//! "session authenticated" through "command authorized" runs in
//! one typed call.
//!
//! ## Production impl: `ManifestBackedTypedAuthz`
//!
//! Composes `OpcUaActorResolver` + `Arc<dyn PolicyEngine>` +
//! `TenantId` + `policy_version_fn` into one object that
//! A-2b's custom NodeManager calls on every OPC UA write. The
//! call sequence:
//!
//! 1. `resolver.resolve(user)` → `Result<ActorIdentity, ..>`.
//!    Anonymous / unenrolled / revoked short-circuits here; the
//!    engine is NEVER consulted for these cases (round-trip
//!    latency defense + keeps `ManifestUnavailable` from masking
//!    a cheap resolver-level reject).
//! 2. Construct `Permission::OpcUaWrite { tag_id: TagId::new(
//!    tag_name) }`. The tag-id-from-string is safe because this
//!    function's only caller is the NodeManager's write path which
//!    owns the tag-name surface; there is no user-input path
//!    reaching this point.
//! 3. Build `AuthorizationRequest { actor, requested_permission,
//!    tenant, claimed_policy_version, received_at }` and call
//!    `engine.authorize`.
//! 4. `Allow(ctx)` → return `Ok(ctx)` (downstream mints
//!    `HandlerInput::authorize` with this as the authz proof —
//!    Tier-1 seal from Batch #236 kicks in here).
//!    `Deny(reason)` → `Err(TypedAuthzError::EngineDenied(reason))`.
//!    Engine error → `Err(TypedAuthzError::EngineError(e))`.
//!
//! ## What's NOT in Batch #241
//!
//! - Custom NodeManager that consumes this trait. That's Batch
//!   A-2b (#242 substantive). The trait is primitive-first;
//!   production call site lands with the NodeManager.
//! - Migration of the string-based `OpcUaAuthzPort::is_write_allowed`
//!   call site in `write_callback_body`. The SimpleNodeManager
//!   callback path stays string-shaped until A-2c wires the custom
//!   NodeManager.
//!
//! ## Cross-references
//!
//! - Batch #239 `opc_ua_server_session::AuthenticatedUser` — the
//!   typed principal
//! - Batch #240 `opc_ua_server_session::OpcUaActorResolver` — the
//!   manifest-backed enrollment check
//! - Batch #223 `authz::in_memory_engine::InMemoryPolicyEngine` —
//!   the RBAC engine
//! - Ultra-plan `#Gap-A-2b` / finding registry `ULTRA-HIGH-004`
//!   (this batch is a preparatory primitive in that gap's path;
//!   the full gap closes with the NodeManager trait impl).

#![allow(dead_code)]

use std::fmt;
use std::sync::Arc;
use std::time::SystemTime;

use async_trait::async_trait;

use crate::authz::context::{AuthorizationDecision, AuthorizationDenyReason, AuthorizedContext};
use crate::authz::permission::{Permission, TagId, TenantId};
use crate::authz::policy::{AuthorizationRequest, PolicyEngine, PolicyEngineError};

use crate::opc_ua_server_session::{AuthenticatedUser, OpcUaActorResolver, SessionActorError};

/// Closure type for per-call policy-version source. Kept as a
/// closure (not a static value) so callers thread the live manifest
/// version without constructing a new adapter instance on every
/// version bump. Matches the `PolicyVersionFn` shape used by the
/// Batch 211 audit adapter for consistency.
pub type PolicyVersionFn = Arc<dyn Fn() -> u64 + Send + Sync>;

/// Error taxonomy produced by `TypedAuthzPort::authorize_write`.
/// Every variant carries structured reason data so the downstream
/// NodeManager can emit audit + map to an OPC UA `StatusCode` with
/// a concrete cause (not a generic "access denied" string).
#[derive(Debug)]
pub enum TypedAuthzError {
    /// Resolver rejected the principal (anonymous, unenrolled,
    /// machine-issuer revoked, empty CN). Maps to OPC UA
    /// `BadUserAccessDenied`.
    SessionRejected(SessionActorError),
    /// Engine returned a structured error (manifest unavailable,
    /// etc). Maps to OPC UA `BadInternalError`.
    EngineError(PolicyEngineError),
    /// Engine returned Deny with structured reason. Maps to OPC UA
    /// `BadUserAccessDenied` (per-reason detail in audit record).
    EngineDenied(AuthorizationDenyReason),
}

impl fmt::Display for TypedAuthzError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SessionRejected(e) => write!(f, "session rejected: {}", e),
            Self::EngineError(e) => write!(f, "policy engine error: {:?}", e),
            Self::EngineDenied(r) => write!(f, "authorization denied: {}", r),
        }
    }
}

impl std::error::Error for TypedAuthzError {}

/// Typed authz port — the composition point between session layer
/// + RBAC manifest + PolicyEngine. Asynchronous because
/// `PolicyEngine::authorize` is async (the in-memory impl is
/// sync-underneath but the trait contract is async for future
/// remote-authz impls).
#[async_trait]
pub trait TypedAuthzPort: Send + Sync {
    /// Return the `AuthorizedContext` proof token if the typed
    /// session principal is authorized to write the named tag,
    /// otherwise the structured error variant. Typed return shape
    /// is load-bearing: the `AuthorizedContext` is the sole input
    /// `HandlerInput::authorize` accepts (Batch #236 Tier-1 seal),
    /// so the NodeManager that calls this method has no way to
    /// bypass the seal even accidentally.
    async fn authorize_write(
        &self,
        user: &AuthenticatedUser,
        tag_name: &str,
        received_at: SystemTime,
    ) -> Result<AuthorizedContext, TypedAuthzError>;
}

/// Production impl — composes `OpcUaActorResolver` +
/// `Arc<dyn PolicyEngine>` + tenant + policy_version_fn into one
/// typed-authz endpoint. A-2b custom NodeManager holds one of these
/// and calls `authorize_write` on every OPC UA write.
pub struct ManifestBackedTypedAuthz {
    resolver: OpcUaActorResolver,
    engine: Arc<dyn PolicyEngine>,
    tenant: TenantId,
    policy_version_fn: PolicyVersionFn,
}

impl ManifestBackedTypedAuthz {
    pub fn new(
        resolver: OpcUaActorResolver,
        engine: Arc<dyn PolicyEngine>,
        tenant: TenantId,
        policy_version_fn: PolicyVersionFn,
    ) -> Self {
        Self {
            resolver,
            engine,
            tenant,
            policy_version_fn,
        }
    }
}

#[async_trait]
impl TypedAuthzPort for ManifestBackedTypedAuthz {
    async fn authorize_write(
        &self,
        user: &AuthenticatedUser,
        tag_name: &str,
        received_at: SystemTime,
    ) -> Result<AuthorizedContext, TypedAuthzError> {
        // Step 1: resolver. Short-circuits anonymous + unenrolled
        // before reaching the engine — keeps the engine cost off
        // the rejected-path + prevents ManifestUnavailable from
        // masking a resolver-level reject.
        let actor = self
            .resolver
            .resolve(user)
            .map_err(TypedAuthzError::SessionRejected)?;

        // Step 2: build the OpcUaWrite permission from tag_name.
        // The NodeManager caller owns the tag-name surface; there
        // is no direct user-input path reaching this string (the
        // NodeManager resolves BrowseName → tag_name via its own
        // registry first).
        let permission = Permission::OpcUaWrite {
            tag_id: TagId::new(tag_name.to_string()),
        };

        // Step 3: build request. claimed_policy_version comes from
        // the closure so manifest hot-reload propagates instantly.
        let request = AuthorizationRequest::new(
            actor,
            permission,
            self.tenant.clone(),
            (self.policy_version_fn)(),
            received_at,
        );

        // Step 4: engine.authorize + map.
        match self.engine.authorize(request).await {
            Ok(AuthorizationDecision::Allow(ctx)) => Ok(ctx),
            Ok(AuthorizationDecision::Deny(reason)) => Err(TypedAuthzError::EngineDenied(reason)),
            Err(e) => Err(TypedAuthzError::EngineError(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::in_memory_engine::InMemoryPolicyEngine;
    use crate::authz::manifest::{
        CustomRole, Ed25519PublicKeyBytes, OperatorBinding, RbacManifest,
    };
    use crate::authz::manifest_runtime::RbacManifestStore;
    use crate::authz::permission::OperatorId;
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

    /// Manifest with the canned operator bound to a role that
    /// grants `OpcUaWrite { tag_id: "do_pump" }` — the happy path.
    fn manifest_with_opcua_write(tag: &str) -> RbacManifest {
        RbacManifest {
            policy_version: 10,
            tenant_id: canned_tenant(),
            manifest_valid_from_unix_secs: 1_000_000_000,
            manifest_valid_until_unix_secs: 2_000_000_000,
            operator_bindings: vec![OperatorBinding {
                operator_id: canned_operator(),
                pubkey: canned_pubkey(),
                role_names: vec!["actuator_operator".into()],
            }],
            roles: vec![CustomRole {
                name: "actuator_operator".into(),
                permissions: vec![Permission::OpcUaWrite {
                    tag_id: TagId::new(tag.into()),
                }],
                valid_from_unix_secs: 1_000_000_000,
                valid_until_unix_secs: 2_000_000_000,
                is_emergency_role: false,
            }],
        }
    }

    /// Manifest with the canned operator bound BUT lacking the
    /// OpcUaWrite permission — proves engine-side deny.
    fn manifest_without_opcua_write() -> RbacManifest {
        RbacManifest {
            policy_version: 10,
            tenant_id: canned_tenant(),
            manifest_valid_from_unix_secs: 1_000_000_000,
            manifest_valid_until_unix_secs: 2_000_000_000,
            operator_bindings: vec![OperatorBinding {
                operator_id: canned_operator(),
                pubkey: canned_pubkey(),
                role_names: vec!["observer".into()],
            }],
            roles: vec![CustomRole {
                name: "observer".into(),
                permissions: vec![Permission::ReadTag],
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

    fn adapter_with(manifest: RbacManifest) -> ManifestBackedTypedAuthz {
        let store = store_with(manifest);
        let resolver = OpcUaActorResolver::new(store.clone());
        let engine: Arc<dyn PolicyEngine> = Arc::new(InMemoryPolicyEngine::new(store));
        ManifestBackedTypedAuthz::new(resolver, engine, canned_tenant(), Arc::new(|| 10u64))
    }

    fn received_at() -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_500_000_000)
    }

    #[tokio::test]
    async fn anonymous_rejects_before_engine() {
        let a = adapter_with(manifest_with_opcua_write("do_pump"));
        let user = AuthenticatedUser::for_test_anonymous();
        match a.authorize_write(&user, "do_pump", received_at()).await {
            Err(TypedAuthzError::SessionRejected(SessionActorError::AnonymousSessionRejected)) => {}
            other => panic!(
                "expected SessionRejected(AnonymousSessionRejected), got {:?}",
                other.is_ok()
            ),
        }
    }

    #[tokio::test]
    async fn unenrolled_rejects_before_engine() {
        let a = adapter_with(manifest_with_opcua_write("do_pump"));
        let stranger = OperatorId::new_from_verified([0xDEu8; 16]);
        let user = AuthenticatedUser::for_test_user_pass(stranger);
        match a.authorize_write(&user, "do_pump", received_at()).await {
            Err(TypedAuthzError::SessionRejected(SessionActorError::OperatorNotEnrolled)) => {}
            other => panic!(
                "expected SessionRejected(OperatorNotEnrolled), got {:?}",
                other.is_ok()
            ),
        }
    }

    #[tokio::test]
    async fn enrolled_with_permission_produces_authorized_context() {
        let a = adapter_with(manifest_with_opcua_write("do_pump"));
        let user = AuthenticatedUser::for_test_user_pass(canned_operator());
        let ctx = a
            .authorize_write(&user, "do_pump", received_at())
            .await
            .expect("allow path");
        assert_eq!(
            ctx.granted_permission(),
            &Permission::OpcUaWrite {
                tag_id: TagId::new("do_pump".into())
            }
        );
        assert_eq!(ctx.tenant().as_bytes(), &[0x42u8; 16]);
        assert_eq!(ctx.policy_version(), 10);
    }

    #[tokio::test]
    async fn enrolled_without_permission_engine_denies() {
        let a = adapter_with(manifest_without_opcua_write());
        let user = AuthenticatedUser::for_test_user_pass(canned_operator());
        match a.authorize_write(&user, "do_pump", received_at()).await {
            Err(TypedAuthzError::EngineDenied(AuthorizationDenyReason::PermissionNotGranted)) => {}
            other => panic!(
                "expected EngineDenied(PermissionNotGranted), got {:?}",
                other.is_ok()
            ),
        }
    }

    #[tokio::test]
    async fn tag_name_in_permission_matches_request() {
        // Prove tag_name threads through to the Permission::OpcUaWrite
        // tag_id — if an attacker submits a write for tag "pond3_aerator"
        // while the manifest only grants "do_pump", it must reject.
        let a = adapter_with(manifest_with_opcua_write("do_pump"));
        let user = AuthenticatedUser::for_test_user_pass(canned_operator());
        match a
            .authorize_write(&user, "pond3_aerator", received_at())
            .await
        {
            Err(TypedAuthzError::EngineDenied(AuthorizationDenyReason::PermissionNotGranted)) => {}
            other => panic!("tag_id mismatch must deny; got {:?}", other.is_ok()),
        }
    }

    #[tokio::test]
    async fn empty_store_surfaces_engine_manifest_unavailable() {
        // Resolver skips anonymous/enrollment for non-anonymous
        // principals against empty store (returns OperatorNotEnrolled).
        // For this test we prove the engine-path error surface: use
        // a resolver that's happy (manifest loaded) but the ENGINE
        // sees a different empty store. Split the two stores.
        let populated = store_with(manifest_with_opcua_write("do_pump"));
        let empty_for_engine = Arc::new(RbacManifestStore::new());
        let resolver = OpcUaActorResolver::new(populated);
        let engine: Arc<dyn PolicyEngine> = Arc::new(InMemoryPolicyEngine::new(empty_for_engine));
        let a =
            ManifestBackedTypedAuthz::new(resolver, engine, canned_tenant(), Arc::new(|| 10u64));
        let user = AuthenticatedUser::for_test_user_pass(canned_operator());
        match a.authorize_write(&user, "do_pump", received_at()).await {
            Err(TypedAuthzError::EngineError(PolicyEngineError::ManifestUnavailable)) => {}
            other => panic!(
                "expected EngineError(ManifestUnavailable), got {:?}",
                other.is_ok()
            ),
        }
    }

    #[tokio::test]
    async fn hot_reload_flips_allow_to_deny_on_next_call() {
        // Manifest hot-reload revokes the operator between two
        // authorize_write calls. The first must allow; the second
        // must deny with OperatorNotEnrolled (resolver short-
        // circuit). Validates the live-manifest contract from
        // Batch #240 composed with the engine path.
        let store = Arc::new(RbacManifestStore::new());
        store.test_set_manifest(manifest_with_opcua_write("do_pump"));
        let resolver = OpcUaActorResolver::new(store.clone());
        let engine: Arc<dyn PolicyEngine> = Arc::new(InMemoryPolicyEngine::new(store.clone()));
        let a =
            ManifestBackedTypedAuthz::new(resolver, engine, canned_tenant(), Arc::new(|| 10u64));
        let user = AuthenticatedUser::for_test_user_pass(canned_operator());

        // Call 1: allow.
        assert!(
            a.authorize_write(&user, "do_pump", received_at())
                .await
                .is_ok()
        );

        // Hot-reload: revoke the operator.
        let revoked = RbacManifest {
            policy_version: 11,
            operator_bindings: vec![],
            ..manifest_with_opcua_write("do_pump")
        };
        store.test_set_manifest(revoked);

        // Call 2: OperatorNotEnrolled (resolver short-circuit).
        match a.authorize_write(&user, "do_pump", received_at()).await {
            Err(TypedAuthzError::SessionRejected(SessionActorError::OperatorNotEnrolled)) => {}
            other => panic!(
                "expected OperatorNotEnrolled after revocation, got {:?}",
                other.is_ok()
            ),
        }
    }

    #[tokio::test]
    async fn x509_session_flows_to_engine_as_machine_issuer() {
        // X509 session surfaces as MachineIssuer at resolver (Batch
        // #240 documented: current manifest schema has no
        // machine_issuers table, so X509 passes through). Engine
        // gate 6 then denies because manifest's operator_bindings
        // lookup keys on OperatorId not cert CN. Proves the typed
        // error path surfaces the engine-side deny for a valid
        // session principal the manifest does not cover yet.
        use crate::opc_ua_server_session::MachineIssuerCn;
        let a = adapter_with(manifest_with_opcua_write("do_pump"));
        let cn = MachineIssuerCn::from_verified_cert_cn("auth-service".into()).unwrap();
        let user = AuthenticatedUser::for_test_x509(cn, canned_operator());
        match a.authorize_write(&user, "do_pump", received_at()).await {
            Err(TypedAuthzError::EngineDenied(AuthorizationDenyReason::PermissionNotGranted)) => {}
            other => panic!(
                "expected EngineDenied(PermissionNotGranted) for x509-no-machine-table, got {:?}",
                other.is_ok()
            ),
        }
    }

    #[tokio::test]
    async fn typed_authz_port_is_object_safe() {
        // Prove the trait is object-safe so A-2b NodeManager can
        // store `Arc<dyn TypedAuthzPort>`. Compile-time property —
        // if this test compiles, the trait is object-safe.
        let a = adapter_with(manifest_with_opcua_write("do_pump"));
        let _boxed: Box<dyn TypedAuthzPort> = Box::new(a);
    }

    #[tokio::test]
    async fn policy_version_fn_is_called_per_request_not_cached() {
        use std::sync::atomic::{AtomicU64, Ordering};
        let counter = Arc::new(AtomicU64::new(10));
        let c = counter.clone();
        let store = store_with(manifest_with_opcua_write("do_pump"));
        let resolver = OpcUaActorResolver::new(store.clone());
        let engine: Arc<dyn PolicyEngine> = Arc::new(InMemoryPolicyEngine::new(store));
        let a = ManifestBackedTypedAuthz::new(
            resolver,
            engine,
            canned_tenant(),
            Arc::new(move || c.load(Ordering::SeqCst)),
        );
        let user = AuthenticatedUser::for_test_user_pass(canned_operator());

        // First call: version 10.
        let ctx = a
            .authorize_write(&user, "do_pump", received_at())
            .await
            .unwrap();
        assert_eq!(ctx.policy_version(), 10);

        // Engine's manifest is still v10; bumping the claimed_fn to
        // 10 (still valid) keeps allow. Proving the fn is called
        // per-request means bumping to a STALE version should
        // trigger the engine's StalePolicyVersion path. We set
        // claimed=9 < manifest's policy_version=10 → engine denies.
        counter.store(9, Ordering::SeqCst);
        match a.authorize_write(&user, "do_pump", received_at()).await {
            Err(TypedAuthzError::EngineDenied(AuthorizationDenyReason::StalePolicyVersion {
                claimed,
                highest_seen,
            })) => {
                assert_eq!(claimed, 9);
                assert_eq!(highest_seen, 10);
            }
            other => panic!(
                "expected StalePolicyVersion after counter flip, got {:?}",
                other.is_ok()
            ),
        }
    }

    #[test]
    fn typed_authz_error_display_taxonomy() {
        let msgs = [
            (
                TypedAuthzError::SessionRejected(SessionActorError::AnonymousSessionRejected),
                "session rejected",
            ),
            (
                TypedAuthzError::EngineError(PolicyEngineError::ManifestUnavailable),
                "policy engine error",
            ),
            (
                TypedAuthzError::EngineDenied(AuthorizationDenyReason::PermissionNotGranted),
                "authorization denied",
            ),
        ];
        for (e, needle) in msgs {
            let s = format!("{}", e);
            assert!(
                s.contains(needle),
                "err display `{}` missing `{}`",
                s,
                needle
            );
        }
    }
}
