//! `InMemoryPolicyEngine` — Batch 223 Faz 2 Sprint 6.1
//! (closes gap A-1 from the 2026-04-24 ruthless assessment).
//!
//! ## WHY
//!
//! The canonical plan §5 Faz 2 step 4 specifies an
//! `InMemoryPolicyEngine` reference impl that Faz 5 OPC UA
//! write chain + every MQTT command dispatcher depends on.
//! Until this batch, only `DenyAllPolicyEngine` was available;
//! every authz decision denied + the Faz 5 write surface was
//! architecturally correct (fail-closed) but functionally
//! inert (every HMI write → `BadUserAccessDenied`).
//!
//! This batch lands the first cut of the real engine:
//! - Reads the verified manifest via `RbacManifestStore`'s
//!   scoped `with_manifest` API (Batch 223 extension). No
//!   manifest clone — every read runs under the store's
//!   RwLock so a hot-reload is atomic from the engine's view.
//! - Runs the 7-gate authorization chain per plan §3 R-5 +
//!   ADR-018 §8. Gate order fixes the evaluation sequence so
//!   a future audit can reason about which gate fired first.
//! - Produces `AuthorizedContext` via
//!   `AuthorizedContext::new_from_verified` — the sealed
//!   ctor per `context.rs`; grep-auditable single call site
//!   lives here.
//!
//! ## Gate chain (evaluation order)
//!
//! 1. **Manifest-loaded** — `RbacManifestStore` returns None
//!    → `PolicyEngineError::ManifestUnavailable`. Fail-closed
//!    per plan HC-3; DenyAllPolicyEngine is the fallback path
//!    for orchestrator contexts that need an always-deny
//!    engine without store plumbing.
//! 2. **Tenant binding** — `request.tenant !=
//!    manifest.tenant_id` → `Deny(TenantMismatch)`. FR1
//!    cross-tenant-identity defense.
//! 3. **Policy-version monotonicity** —
//!    `claimed_policy_version < manifest.policy_version` →
//!    `Deny(StalePolicyVersion)`. Rollback-replay defense
//!    per ADR-018 §9.
//! 4. **Manifest-validity window** — `received_at` outside
//!    `[valid_from, valid_until]` → `Deny(RoleExpired)`.
//!    Whole-manifest boundary regardless of per-role window.
//! 5. **Two-person-integrity presence** — requested
//!    permission is in the TPI set (ForceValue, DeployProgram,
//!    SafeStateTrigger, ManagePolicy) AND `co_approver =
//!    None` → `Deny(TwoPersonIntegrityMissing)`. Co-approver
//!    SIGNATURE verify is out-of-scope for Batch 223 (Batch
//!    224 primitive); presence-only gate satisfies the
//!    structural contract without claiming positive
//!    co-approval capability.
//! 6. **Operator binding lookup** — `ActorIdentity::Operator(id)`
//!    → match on `manifest.operator_bindings`. Missing
//!    operator → `Deny(PermissionNotGranted)`. Machine
//!    issuers are NOT in the manifest (they authenticate via
//!    mTLS cert, not RBAC manifest binding) → fall-through to
//!    the same `PermissionNotGranted` deny.
//! 7. **Role-set permission match** — iterate the operator's
//!    `role_names`, look up each in `manifest.roles`, skip
//!    roles outside their own validity window, and check
//!    whether any role's `permissions` contains
//!    `requested_permission`. Match → `Allow(context)`; no
//!    match → `Deny(PermissionNotGranted)`.
//!
//! ## What's NOT in Batch 223 (explicit)
//!
//! - **Co-approver signature verify** (Batch 224 primitive +
//!   224 wire). Presence-only gate here.
//! - **Emergency-role escalation** (`is_emergency_role` +
//!   EmergencyOverrideRequired reason). Returns
//!   PermissionNotGranted until Batch 225 lands the
//!   `EmergencyActuator` special-case.
//! - **License-tier insufficient** reason — license gating
//!   lives at the handler boundary (Batch 147+); authz's job
//!   is manifest-side permission match.
//! - **Hot-reload on `reload_manifest`** — delegates to the
//!   store's existing reload path; this method returns the
//!   current policy_version unchanged.

#![allow(dead_code)]

use std::sync::Arc;
use std::time::SystemTime;

use async_trait::async_trait;

use super::context::{
    ActorIdentity, AuthorizationDecision, AuthorizationDenyReason, AuthorizedContext,
};
use super::manifest_runtime::RbacManifestStore;
use super::permission::Permission;
use super::policy::{AuthorizationRequest, PolicyEngine, PolicyEngineError};

/// Permissions that require two-person integrity per
/// ADR-018 §8. Batch 223 implements the PRESENCE gate (is
/// co_approver Some?); Batch 224 implements the positive
/// verify path (co-approver signature over canonical bytes +
/// binding in manifest).
const TPI_PERMISSIONS: &[&str] = &[
    // We match on the variant discriminant via the
    // `Permission::to_audit_tag` style; plan `Permission`
    // enum doesn't yet expose a `tag()` so we pattern-match
    // below. The const is kept as documentation of the
    // authoritative set.
    "ForceValue",
    "DeployProgram",
    "SafeStateTrigger",
    "ManagePolicy",
    "UpdateFirmware",
];

/// True when `perm` is in the two-person-integrity set.
/// Pure fn on the permission variants so it's unit-tested in
/// isolation of manifest plumbing.
pub(crate) fn requires_two_person_integrity(perm: &Permission) -> bool {
    matches!(
        perm,
        Permission::ForceValue
            | Permission::DeployProgram
            | Permission::SafeStateTrigger
            | Permission::ManagePolicy
            | Permission::UpdateFirmware
    )
}

/// PolicyEngine impl backed by a shared `RbacManifestStore`.
///
/// Constructor takes an `Arc<RbacManifestStore>` so production
/// wires this alongside the existing AppState
/// `rbac_manifest_store` field without duplicating storage.
/// Config reloads (hot_reload_from_bytes) propagate to this
/// engine on the next `authorize` call — no explicit
/// subscription, the store's RwLock IS the subscription.
pub struct InMemoryPolicyEngine {
    store: Arc<RbacManifestStore>,
}

impl InMemoryPolicyEngine {
    /// Construct an engine bound to the given manifest store.
    pub fn new(store: Arc<RbacManifestStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl PolicyEngine for InMemoryPolicyEngine {
    async fn authorize(
        &self,
        request: AuthorizationRequest,
    ) -> Result<AuthorizationDecision, PolicyEngineError> {
        // Gate 1: manifest must be loaded.
        let outcome = self.store.with_manifest(|manifest| {
            // Gate 2: tenant.
            if request.tenant != manifest.tenant_id {
                return Ok(AuthorizationDecision::Deny(
                    AuthorizationDenyReason::TenantMismatch {
                        requested: request.tenant.clone(),
                        actor_tenant: manifest.tenant_id.clone(),
                    },
                ));
            }

            // Gate 3: policy version monotonicity.
            if request.claimed_policy_version < manifest.policy_version {
                return Ok(AuthorizationDecision::Deny(
                    AuthorizationDenyReason::StalePolicyVersion {
                        claimed: request.claimed_policy_version,
                        highest_seen: manifest.policy_version,
                    },
                ));
            }

            // Gate 4: manifest-validity window.
            let now_secs = system_time_to_unix_secs(&request.received_at);
            if now_secs < manifest.manifest_valid_from_unix_secs
                || now_secs > manifest.manifest_valid_until_unix_secs
            {
                return Ok(AuthorizationDecision::Deny(
                    AuthorizationDenyReason::RoleExpired,
                ));
            }

            // Gate 5: two-person integrity presence check.
            if requires_two_person_integrity(&request.requested_permission)
                && request.co_approver.is_none()
            {
                return Ok(AuthorizationDecision::Deny(
                    AuthorizationDenyReason::TwoPersonIntegrityMissing,
                ));
            }

            // Gate 6: operator binding lookup.
            let operator_id = match &request.actor {
                ActorIdentity::Operator(id) => id,
                ActorIdentity::MachineIssuer { .. } => {
                    // Machine issuers are NOT in the RBAC
                    // manifest (they use mTLS cert binding,
                    // not operator binding). Until a Batch
                    // 224+ machine-actor table lands, the
                    // fail-closed path is
                    // PermissionNotGranted. This means
                    // machine-path commands (license
                    // refresh, policy push from cloud)
                    // MUST route through a separate engine
                    // OR the manifest must include a
                    // machine operator binding.
                    return Ok(AuthorizationDecision::Deny(
                        AuthorizationDenyReason::PermissionNotGranted,
                    ));
                }
            };

            let binding = manifest
                .operator_bindings
                .iter()
                .find(|b| b.operator_id.as_bytes() == operator_id.as_bytes());
            let binding = match binding {
                Some(b) => b,
                None => {
                    return Ok(AuthorizationDecision::Deny(
                        AuthorizationDenyReason::PermissionNotGranted,
                    ));
                }
            };

            // Gate 7: role-set permission match.
            for role_name in &binding.role_names {
                let role = manifest.roles.iter().find(|r| &r.name == role_name);
                let role = match role {
                    Some(r) => r,
                    None => continue,
                };
                // Role validity window.
                if now_secs < role.valid_from_unix_secs || now_secs > role.valid_until_unix_secs {
                    continue;
                }
                if role
                    .permissions
                    .iter()
                    .any(|p| p == &request.requested_permission)
                {
                    // ALLOW — mint context via sealed ctor.
                    let ctx = AuthorizedContext::new_from_verified(
                        request.actor.clone(),
                        request.requested_permission.clone(),
                        request.tenant.clone(),
                        manifest.policy_version,
                        request.co_approver.is_some(),
                        request.received_at,
                    );
                    return Ok(AuthorizationDecision::Allow(ctx));
                }
            }

            Ok(AuthorizationDecision::Deny(
                AuthorizationDenyReason::PermissionNotGranted,
            ))
        });

        match outcome {
            Some(result) => result,
            None => Err(PolicyEngineError::ManifestUnavailable),
        }
    }

    fn current_policy_version(&self) -> u64 {
        self.store.policy_version().unwrap_or(0)
    }

    async fn reload_manifest(&self) -> Result<u64, PolicyEngineError> {
        // Hot-reload lives on the store (hot_reload_from_bytes
        // accepts a new signed-manifest envelope + swaps
        // atomically). The engine itself has no work to do
        // other than return the current version; the next
        // authorize call will read whatever the store holds.
        Ok(self.current_policy_version())
    }
}

/// Convert a `SystemTime` to UNIX seconds (signed, to match
/// manifest fields' `i64` shape). Before-epoch times clamp
/// to `i64::MIN` so a misconfigured clock cannot slip past
/// the validity check — downstream comparisons correctly
/// reject.
fn system_time_to_unix_secs(t: &SystemTime) -> i64 {
    match t.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        Err(_) => i64::MIN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::manifest::{
        CustomRole, Ed25519PublicKeyBytes, OperatorBinding, RbacManifest,
    };
    use crate::authz::permission::{OperatorId, TagId, TenantId};
    use crate::authz::policy::{AuthorizationRequest, PolicyEngine, PolicyEngineError};
    use std::sync::RwLock;

    fn canned_tenant() -> TenantId {
        TenantId::new_from_verified([0x42u8; 16])
    }

    fn canned_operator() -> OperatorId {
        OperatorId::new_from_verified([0x07u8; 16])
    }

    fn canned_pubkey() -> Ed25519PublicKeyBytes {
        Ed25519PublicKeyBytes::from_bytes([0xAAu8; 32])
    }

    /// Baseline manifest: single operator, single role
    /// with ReadTag permission, wide validity windows.
    fn baseline_manifest(perms: Vec<Permission>) -> RbacManifest {
        RbacManifest {
            policy_version: 10,
            tenant_id: canned_tenant(),
            manifest_valid_from_unix_secs: 1_000_000_000,
            manifest_valid_until_unix_secs: 2_000_000_000,
            operator_bindings: vec![OperatorBinding {
                operator_id: canned_operator(),
                pubkey: canned_pubkey(),
                role_names: vec!["operator".to_string()],
            }],
            roles: vec![CustomRole {
                name: "operator".to_string(),
                permissions: perms,
                valid_from_unix_secs: 1_000_000_000,
                valid_until_unix_secs: 2_000_000_000,
                is_emergency_role: false,
            }],
        }
    }

    /// Helper: build a store + inject a manifest directly
    /// via the crate-private `current` RwLock. Tests only —
    /// production stores manifest via load_from_file /
    /// hot_reload_from_bytes (both signature-verified).
    fn store_with(manifest: RbacManifest) -> Arc<RbacManifestStore> {
        let store = Arc::new(RbacManifestStore::new());
        // Access the private `current` field via the struct's
        // own public API — we don't have direct field access
        // from outside the module. Use hot_reload via a
        // bypass path: since tests compile inside the crate,
        // we can set via the pub(crate) field. The struct's
        // `current: RwLock<Option<RbacManifest>>` is
        // module-private; we reach it by constructing through
        // the existing `with_manifest` read path isn't
        // sufficient for seeding. Workaround: since we can't
        // inject without signature verify, tests use the
        // `test_force_set` helper below.
        test_force_set(&store, manifest);
        store
    }

    /// Reach into the store's private field to seed a test
    /// manifest. ONLY callable from tests in this crate;
    /// production code uses the signature-verified load
    /// paths. Safe because `tests` compile inside the crate
    /// so the pub(crate) → private distinction still
    /// permits this access via a helper that lives inside
    /// the same crate.
    fn test_force_set(store: &RbacManifestStore, manifest: RbacManifest) {
        // We cannot reach private fields from outside the
        // `manifest_runtime` module even inside the crate.
        // Use the sibling test helper that exposes the
        // mutation — add it to manifest_runtime.rs if not
        // present.
        store.test_set_manifest(manifest);
    }

    fn request_read_tag(
        actor: ActorIdentity,
        tenant: TenantId,
        claimed_version: u64,
        received_at_secs: i64,
    ) -> AuthorizationRequest {
        use std::time::{Duration, UNIX_EPOCH};
        let rx_at = if received_at_secs >= 0 {
            UNIX_EPOCH + Duration::from_secs(received_at_secs as u64)
        } else {
            UNIX_EPOCH
        };
        AuthorizationRequest::new(actor, Permission::ReadTag, tenant, claimed_version, rx_at)
    }

    #[tokio::test]
    async fn authorize_errors_when_manifest_not_loaded() {
        let store = Arc::new(RbacManifestStore::new());
        let engine = InMemoryPolicyEngine::new(store);
        let req = request_read_tag(
            ActorIdentity::Operator(canned_operator()),
            canned_tenant(),
            10,
            1_500_000_000,
        );
        match engine.authorize(req).await {
            Err(PolicyEngineError::ManifestUnavailable) => {}
            other => panic!("expected ManifestUnavailable, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn authorize_denies_on_tenant_mismatch() {
        let engine =
            InMemoryPolicyEngine::new(store_with(baseline_manifest(vec![Permission::ReadTag])));
        let wrong_tenant = TenantId::new_from_verified([0x99u8; 16]);
        let req = request_read_tag(
            ActorIdentity::Operator(canned_operator()),
            wrong_tenant,
            10,
            1_500_000_000,
        );
        match engine.authorize(req).await.unwrap() {
            AuthorizationDecision::Deny(AuthorizationDenyReason::TenantMismatch { .. }) => {}
            other => panic!("expected TenantMismatch, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn authorize_denies_on_stale_policy_version() {
        let engine =
            InMemoryPolicyEngine::new(store_with(baseline_manifest(vec![Permission::ReadTag])));
        // claimed < current (10).
        let req = request_read_tag(
            ActorIdentity::Operator(canned_operator()),
            canned_tenant(),
            5,
            1_500_000_000,
        );
        match engine.authorize(req).await.unwrap() {
            AuthorizationDecision::Deny(AuthorizationDenyReason::StalePolicyVersion {
                claimed,
                highest_seen,
            }) => {
                assert_eq!(claimed, 5);
                assert_eq!(highest_seen, 10);
            }
            other => panic!("expected StalePolicyVersion, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn authorize_denies_outside_manifest_validity_window() {
        let engine =
            InMemoryPolicyEngine::new(store_with(baseline_manifest(vec![Permission::ReadTag])));
        // Before valid_from.
        let req = request_read_tag(
            ActorIdentity::Operator(canned_operator()),
            canned_tenant(),
            10,
            500_000_000,
        );
        match engine.authorize(req).await.unwrap() {
            AuthorizationDecision::Deny(AuthorizationDenyReason::RoleExpired) => {}
            other => panic!("expected RoleExpired, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn authorize_denies_tpi_without_co_approver() {
        let engine =
            InMemoryPolicyEngine::new(store_with(baseline_manifest(vec![Permission::ForceValue])));
        use std::time::{Duration, UNIX_EPOCH};
        let req = AuthorizationRequest::new(
            ActorIdentity::Operator(canned_operator()),
            Permission::ForceValue,
            canned_tenant(),
            10,
            UNIX_EPOCH + Duration::from_secs(1_500_000_000),
        );
        match engine.authorize(req).await.unwrap() {
            AuthorizationDecision::Deny(AuthorizationDenyReason::TwoPersonIntegrityMissing) => {}
            other => panic!("expected TwoPersonIntegrityMissing, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn authorize_denies_machine_issuer_no_binding() {
        let engine =
            InMemoryPolicyEngine::new(store_with(baseline_manifest(vec![Permission::ReadTag])));
        let req = request_read_tag(
            ActorIdentity::MachineIssuer {
                subject_cn: "auth-service".into(),
            },
            canned_tenant(),
            10,
            1_500_000_000,
        );
        match engine.authorize(req).await.unwrap() {
            AuthorizationDecision::Deny(AuthorizationDenyReason::PermissionNotGranted) => {}
            other => panic!("expected PermissionNotGranted, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn authorize_denies_unknown_operator() {
        let engine =
            InMemoryPolicyEngine::new(store_with(baseline_manifest(vec![Permission::ReadTag])));
        let stranger = OperatorId::new_from_verified([0xDEu8; 16]);
        let req = request_read_tag(
            ActorIdentity::Operator(stranger),
            canned_tenant(),
            10,
            1_500_000_000,
        );
        match engine.authorize(req).await.unwrap() {
            AuthorizationDecision::Deny(AuthorizationDenyReason::PermissionNotGranted) => {}
            other => panic!("expected PermissionNotGranted, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn authorize_denies_operator_with_no_matching_permission() {
        // Operator has the "operator" role but that role
        // only has ReadTag, requested WriteTag.
        let engine =
            InMemoryPolicyEngine::new(store_with(baseline_manifest(vec![Permission::ReadTag])));
        use std::time::{Duration, UNIX_EPOCH};
        let req = AuthorizationRequest::new(
            ActorIdentity::Operator(canned_operator()),
            Permission::WriteTag {
                tag_id: TagId::new("do_pump".into()),
            },
            canned_tenant(),
            10,
            UNIX_EPOCH + Duration::from_secs(1_500_000_000),
        );
        match engine.authorize(req).await.unwrap() {
            AuthorizationDecision::Deny(AuthorizationDenyReason::PermissionNotGranted) => {}
            other => panic!("expected PermissionNotGranted, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn authorize_allows_when_role_has_requested_permission() {
        let tag = TagId::new("do_pump".into());
        let engine =
            InMemoryPolicyEngine::new(store_with(baseline_manifest(vec![Permission::WriteTag {
                tag_id: tag.clone(),
            }])));
        use std::time::{Duration, UNIX_EPOCH};
        let req = AuthorizationRequest::new(
            ActorIdentity::Operator(canned_operator()),
            Permission::WriteTag {
                tag_id: tag.clone(),
            },
            canned_tenant(),
            10,
            UNIX_EPOCH + Duration::from_secs(1_500_000_000),
        );
        match engine.authorize(req).await.unwrap() {
            AuthorizationDecision::Allow(ctx) => {
                assert_eq!(
                    ctx.granted_permission(),
                    &Permission::WriteTag { tag_id: tag }
                );
                assert_eq!(ctx.policy_version(), 10);
            }
            other => panic!("expected Allow, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn authorize_skips_role_outside_its_validity_window() {
        // Manifest is valid 1_000_000_000 .. 2_000_000_000
        // but the role itself expires at 1_200_000_000.
        // Request at 1_500_000_000 → role skipped → no-perm.
        let tag = TagId::new("do_pump".into());
        let mut manifest = baseline_manifest(vec![Permission::WriteTag {
            tag_id: tag.clone(),
        }]);
        manifest.roles[0].valid_until_unix_secs = 1_200_000_000;
        let engine = InMemoryPolicyEngine::new(store_with(manifest));
        use std::time::{Duration, UNIX_EPOCH};
        let req = AuthorizationRequest::new(
            ActorIdentity::Operator(canned_operator()),
            Permission::WriteTag {
                tag_id: tag.clone(),
            },
            canned_tenant(),
            10,
            UNIX_EPOCH + Duration::from_secs(1_500_000_000),
        );
        match engine.authorize(req).await.unwrap() {
            AuthorizationDecision::Deny(AuthorizationDenyReason::PermissionNotGranted) => {}
            other => panic!(
                "expected PermissionNotGranted for expired role, got {:?}",
                other
            ),
        }
    }

    #[tokio::test]
    async fn current_policy_version_reflects_store() {
        let engine_empty = InMemoryPolicyEngine::new(Arc::new(RbacManifestStore::new()));
        assert_eq!(engine_empty.current_policy_version(), 0);

        let engine_loaded =
            InMemoryPolicyEngine::new(store_with(baseline_manifest(vec![Permission::ReadTag])));
        assert_eq!(engine_loaded.current_policy_version(), 10);
    }

    #[test]
    fn tpi_permissions_set_includes_all_plan_specified() {
        assert!(requires_two_person_integrity(&Permission::ForceValue));
        assert!(requires_two_person_integrity(&Permission::DeployProgram));
        assert!(requires_two_person_integrity(&Permission::SafeStateTrigger));
        assert!(requires_two_person_integrity(&Permission::ManagePolicy));
        assert!(requires_two_person_integrity(&Permission::UpdateFirmware));
        assert!(!requires_two_person_integrity(&Permission::ReadTag));
        assert!(!requires_two_person_integrity(&Permission::WriteTag {
            tag_id: TagId::new("x".into())
        }));
    }
}
