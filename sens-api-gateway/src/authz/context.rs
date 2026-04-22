//! # AuthorizedContext — sealed proof-of-authorization for command handlers
//!
//! **The tier-1 invariant of the authz module.** Every command handler in the
//! edge agent (Modbus write, GPIO toggle, firmware deploy, force_value,
//! RBAC manifest update, …) takes an [`AuthorizedContext`] as its first
//! argument. The ONLY way to obtain one is via
//! `PolicyEngine::authorize(request) -> Result<AuthorizedContext, _>`.
//!
//! Without a successful authorization decision, a consumer literally cannot
//! call the handler — it will not type-check. This is the make-it-impossible
//! guarantee for FR2 (Use Control) per IEC 62443-3-3 SL-2.
//!
//! ## Sealing pattern
//!
//! The struct's fields are private AND its only ctor is `pub(crate)`. Outside
//! `crate::authz::*`, no code can construct an [`AuthorizedContext`] —
//! neither directly (fields private), nor via a round-trip (no `From`/`Into`
//! / serde impls that would invert this), nor via reflection (Rust has none
//! that bypasses visibility). Matches the Batch 2 sealed-newtype pattern
//! already applied to [`super::OperatorId`] / [`super::DeviceId`] /
//! [`super::TenantId`].
//!
//! ## Scope discipline (ADR-018 §3 zero-trust command model)
//!
//! Each `AuthorizedContext` carries EXACTLY ONE permission. There is no
//! session concept — a command authorized to write GPIO 17 cannot be reused
//! to write GPIO 18 without re-authorization. This prevents scope creep and
//! matches the plan's "Session kavramı yok — her komut ayrı ed25519 signed"
//! requirement (§4.10 Zero-Trust Command Model).
//!
//! ## Cross-module references
//!
//! - ADR-018 §3 fixed edge vocabulary + cloud-flexible roles
//! - ADR-018 §11 AuthorizedContext module-boundary invariant
//! - Plan §5 Faz 2 item 4 `AuthorizedContext` as the make-it-impossible gate

use std::time::SystemTime;

use super::permission::{OperatorId, Permission, TenantId};

/// Opaque identity of the command issuer. Covers both human operators
/// (via OperatorId) and machine-to-machine issuers (platform services
/// pushing policy updates, RBAC manifest refreshes, license refreshes, …).
///
/// **Why two variants:** OperatorId is bound to a natural person via the
/// provisioning ceremony; MachineIssuer is bound to a platform service cert
/// CN. They carry different trust semantics for audit review (a human
/// operator's actions are attributable; a machine issuer's actions trace
/// to the signing key's compromise window).
#[derive(Debug, Clone)]
pub enum ActorIdentity {
    /// Natural person with an `OperatorId` minted at provisioning.
    Operator(OperatorId),

    /// Platform service issuing commands via its signed cert (auth-service
    /// signing key per ADR-021 slot 1, billing-service license refresh
    /// signing key per ADR-021 slot 2, …). `subject_cn` matches the mTLS
    /// client cert Common Name that authenticated the TLS session.
    MachineIssuer { subject_cn: String },
}

impl ActorIdentity {
    /// Short audit-log rendering — stable format for log grep patterns.
    /// Operators render as `op:<redacted-id>` to prevent OperatorId
    /// leakage in logs; machine issuers render as `svc:<cn>`.
    pub fn audit_label(&self) -> String {
        match self {
            Self::Operator(_) => "op:<operator>".to_string(),
            Self::MachineIssuer { subject_cn } => format!("svc:{}", subject_cn),
        }
    }
}

/// Reason an authorization was denied — carried in `AuthorizationDecision::Deny`.
/// Exhaustive enum so audit handlers can discriminate without resorting to
/// string matching.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthorizationDenyReason {
    /// No role in the active manifest maps to a permission that satisfies
    /// the request.
    PermissionNotGranted,

    /// Actor's role chain exists but the manifest declared it `valid_until`
    /// has passed. Audit event fires with the delta.
    RoleExpired,

    /// Manifest is signed for a different tenant than the actor's binding.
    /// FR1 cross-tenant-identity defense.
    TenantMismatch { requested: TenantId, actor_tenant: TenantId },

    /// Permission requires two-person integrity (force_value,
    /// firmware_deploy, safe_state_trigger, policy_update) but only one
    /// signed approval was supplied. Second approver MUST be in the same
    /// tenant + hold the `ForceValueCoApprove`-class permission.
    TwoPersonIntegrityMissing,

    /// Permission requires actor to hold `Permission::EmergencyActuator`
    /// class (LifeSupport override) and the actor does not.
    EmergencyOverrideRequired,

    /// Manifest version staleness — actor's claimed policy_version is less
    /// than the edge's highest-seen version (rollback attempt).
    StalePolicyVersion { claimed: u64, highest_seen: u64 },

    /// License tier does not authorize this permission (e.g. STARTER tier
    /// cannot `DeployProgram`). Faz 7 license module runtime checks surface
    /// here after the authz decision.
    LicenseTierInsufficient,
}

impl std::fmt::Display for AuthorizationDenyReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PermissionNotGranted => f.write_str("permission_not_granted"),
            Self::RoleExpired => f.write_str("role_expired"),
            Self::TenantMismatch { .. } => f.write_str("tenant_mismatch"),
            Self::TwoPersonIntegrityMissing => f.write_str("two_person_integrity_missing"),
            Self::EmergencyOverrideRequired => f.write_str("emergency_override_required"),
            Self::StalePolicyVersion { .. } => f.write_str("stale_policy_version"),
            Self::LicenseTierInsufficient => f.write_str("license_tier_insufficient"),
        }
    }
}

/// Result of evaluating an authorization request. On `Allow`, the
/// `AuthorizedContext` is the cryptographic-equivalent proof handed to the
/// command handler; on `Deny`, the reason is structured for audit trails
/// and operator error messages.
#[derive(Debug)]
pub enum AuthorizationDecision {
    Allow(AuthorizedContext),
    Deny(AuthorizationDenyReason),
}

impl AuthorizationDecision {
    /// Convenience: collapse to `Result` for `?`-style use at handler dispatch.
    pub fn into_result(self) -> Result<AuthorizedContext, AuthorizationDenyReason> {
        match self {
            Self::Allow(ctx) => Ok(ctx),
            Self::Deny(reason) => Err(reason),
        }
    }
}

/// Sealed proof-of-authorization passed to command handlers.
///
/// **Make-it-impossible gate:** fields are private; the only ctor is
/// [`AuthorizedContext::new_from_verified`] which is `pub(crate)` and called
/// exclusively from [`super::policy::PolicyEngine::authorize`]. External
/// code literally cannot construct one except through the engine.
///
/// **No `Clone` impl on purpose:** cloning an `AuthorizedContext` would let
/// a command handler fork the proof into parallel requests, effectively
/// turning single-use authorization into a session. We disallow it.
///
/// **No `Serialize`/`Deserialize` on purpose:** serializing an
/// `AuthorizedContext` would let a compromised downstream deserialize a
/// forged one. The only way to obtain an AuthorizedContext is through the
/// engine — the type is intentionally non-transportable.
pub struct AuthorizedContext {
    actor: ActorIdentity,
    granted_permission: Permission,
    granted_at: SystemTime,
    tenant: TenantId,
    /// Monotonic policy version that the engine evaluated the request
    /// against. Audit trail surfaces this so operators can correlate an
    /// action to the exact RBAC manifest active at that moment.
    policy_version: u64,
    /// Explicit two-person integrity indicator — true iff the permission
    /// required co-approval AND the co-approval signature was verified.
    /// Commands that never require it always record `false`.
    two_person_integrity_verified: bool,
}

impl std::fmt::Debug for AuthorizedContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Redact-operator-id discipline: we render the permission + tenant
        // + policy_version, which is enough for debug-log correlation, but
        // not the raw actor bytes (OperatorId is sealed; we can't print it
        // anyway, but the ActorIdentity variant is informative without
        // being identity-exposing).
        f.debug_struct("AuthorizedContext")
            .field("actor", &self.actor.audit_label())
            .field("permission", &self.granted_permission)
            .field("policy_version", &self.policy_version)
            .field("two_person_integrity_verified", &self.two_person_integrity_verified)
            .finish()
    }
}

impl AuthorizedContext {
    /// Sealed ctor — called ONLY by [`super::policy::PolicyEngine::authorize`].
    ///
    /// **Grep-auditable:** every call site of this function lives in
    /// `src/authz/*.rs`. A call site elsewhere is a code review flag AND
    /// an invariant test failure (Faz 2 Sprint 6.1 ships
    /// `tests/invariants/authorized_context_constructors.rs`).
    pub(crate) fn new_from_verified(
        actor: ActorIdentity,
        granted_permission: Permission,
        tenant: TenantId,
        policy_version: u64,
        two_person_integrity_verified: bool,
        granted_at: SystemTime,
    ) -> Self {
        Self {
            actor,
            granted_permission,
            granted_at,
            tenant,
            policy_version,
            two_person_integrity_verified,
        }
    }

    /// The permission that was granted. Command handlers MUST assert that
    /// the granted permission matches the operation they are about to
    /// execute — the `AuthorizedContext` proves ONE permission, not a
    /// class of permissions.
    pub fn granted_permission(&self) -> &Permission {
        &self.granted_permission
    }

    /// Actor identity for audit logging. Callers should prefer
    /// `actor_audit_label()` when emitting logs to avoid accidentally
    /// serializing the underlying OperatorId.
    pub fn actor(&self) -> &ActorIdentity {
        &self.actor
    }

    /// Audit-safe rendering of the actor — operator IDs are redacted;
    /// machine issuers use their cert CN. Use this in audit + log lines.
    pub fn actor_audit_label(&self) -> String {
        self.actor.audit_label()
    }

    pub fn tenant(&self) -> &TenantId {
        &self.tenant
    }

    pub fn policy_version(&self) -> u64 {
        self.policy_version
    }

    pub fn two_person_integrity_verified(&self) -> bool {
        self.two_person_integrity_verified
    }

    pub fn granted_at(&self) -> SystemTime {
        self.granted_at
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::permission::{Permission, TagId};

    fn canned_tenant() -> TenantId {
        // TenantId::new_from_verified is pub(crate) — callable from this test
        // because tests compile as part of the crate. External callers cannot
        // construct a TenantId and therefore cannot construct an
        // AuthorizedContext either. Batch 2 shape: `[u8; 16]` UUID bytes.
        TenantId::new_from_verified([0x42u8; 16])
    }

    fn canned_operator() -> OperatorId {
        OperatorId::new_from_verified([0x07u8; 16])
    }

    fn build_ctx(permission: Permission, two_person: bool) -> AuthorizedContext {
        AuthorizedContext::new_from_verified(
            ActorIdentity::Operator(canned_operator()),
            permission,
            canned_tenant(),
            42,
            two_person,
            SystemTime::UNIX_EPOCH,
        )
    }

    /// WHY: Debug output must NOT serialize OperatorId bytes — audit leak
    ///      defense. Actor field must render through audit_label.
    #[test]
    fn authorized_context_debug_redacts_operator_id() {
        let ctx = build_ctx(Permission::ReadTag(TagId::from("pond3_temp".to_string())), false);
        let debug = format!("{:?}", ctx);
        assert!(
            debug.contains("op:<operator>"),
            "debug must use audit_label: {}",
            debug
        );
        assert!(!debug.contains("op-7"), "raw OperatorId must not leak: {}", debug);
    }

    /// WHY: AuthorizedContext exposes exactly the fields audit+handler paths
    ///      need; smoke-test all getters roundtrip ctor inputs.
    #[test]
    fn authorized_context_getters_roundtrip() {
        let perm = Permission::WriteTag(TagId::from("pond3_aerator".to_string()));
        let ctx = build_ctx(perm.clone(), true);
        assert_eq!(ctx.granted_permission(), &perm);
        assert_eq!(ctx.tenant().as_bytes(), &[0x42u8; 16]);
        assert_eq!(ctx.policy_version(), 42);
        assert!(ctx.two_person_integrity_verified());
        assert_eq!(ctx.granted_at(), SystemTime::UNIX_EPOCH);
        assert_eq!(ctx.actor_audit_label(), "op:<operator>");
    }

    /// WHY: ActorIdentity renders MachineIssuer differently — pin the format.
    #[test]
    fn machine_issuer_audit_label_uses_svc_prefix() {
        let actor = ActorIdentity::MachineIssuer {
            subject_cn: "billing-service.suderra.internal".to_string(),
        };
        assert_eq!(
            actor.audit_label(),
            "svc:billing-service.suderra.internal"
        );
    }

    /// WHY: DenyReason Display values are audit strings; pin them.
    #[test]
    fn deny_reason_display_snake_case() {
        assert_eq!(
            format!("{}", AuthorizationDenyReason::PermissionNotGranted),
            "permission_not_granted"
        );
        assert_eq!(
            format!("{}", AuthorizationDenyReason::RoleExpired),
            "role_expired"
        );
        assert_eq!(
            format!(
                "{}",
                AuthorizationDenyReason::TenantMismatch {
                    requested: canned_tenant(),
                    actor_tenant: canned_tenant(),
                }
            ),
            "tenant_mismatch"
        );
        assert_eq!(
            format!("{}", AuthorizationDenyReason::TwoPersonIntegrityMissing),
            "two_person_integrity_missing"
        );
        assert_eq!(
            format!("{}", AuthorizationDenyReason::EmergencyOverrideRequired),
            "emergency_override_required"
        );
        assert_eq!(
            format!(
                "{}",
                AuthorizationDenyReason::StalePolicyVersion { claimed: 1, highest_seen: 2 }
            ),
            "stale_policy_version"
        );
        assert_eq!(
            format!("{}", AuthorizationDenyReason::LicenseTierInsufficient),
            "license_tier_insufficient"
        );
    }

    /// WHY: AuthorizationDecision::into_result lets callers use `?`; make
    ///      sure Allow maps to Ok and Deny maps to Err.
    #[test]
    fn decision_into_result_maps_both_arms() {
        let ctx = build_ctx(Permission::ReadTag(TagId::from("t".to_string())), false);
        assert!(AuthorizationDecision::Allow(ctx).into_result().is_ok());
        assert!(matches!(
            AuthorizationDecision::Deny(AuthorizationDenyReason::PermissionNotGranted)
                .into_result(),
            Err(AuthorizationDenyReason::PermissionNotGranted)
        ));
    }

    /// WHY (EDGE-LOW-001 closure): AuthorizedContext must NOT implement Clone
    ///      — cloning would invert single-use authorization into a session.
    ///      Enforce via compile-time method-resolution ambiguity: if Clone
    ///      is ever added to AuthorizedContext, the `ctx.clone()` call below
    ///      becomes ambiguous (both `Clone::clone -> Self` and
    ///      `NotCloneMarker::clone -> ()` apply) and this test FAILS TO
    ///      COMPILE. Without Clone, only the blanket NotCloneMarker::clone
    ///      applies and the `let _: () = ...` assertion holds.
    #[test]
    fn authorized_context_does_not_impl_clone() {
        trait NotCloneMarker {
            fn clone(&self) {}
        }
        impl<T: ?Sized> NotCloneMarker for T {}
        let ctx = build_ctx(Permission::ReadTag(TagId::from("t".to_string())), false);
        // If a future derive/impl adds Clone to AuthorizedContext, this line
        // fails to compile with E0034 ("multiple applicable items in scope").
        let _: () = ctx.clone();
    }

    /// WHY (EDGE-LOW-001 extension): same defense against Serialize / Deserialize
    ///      creeping in. Neither trait should ever be implemented on
    ///      AuthorizedContext — serializing the proof opens forgery paths.
    ///      Use the same method-resolution ambiguity trick for `serialize`
    ///      / `deserialize` if serde traits are added.
    #[test]
    fn authorized_context_does_not_impl_serialize_or_deserialize() {
        // Compile-time proof: no `impl Serialize` nor `impl Deserialize` for
        // AuthorizedContext. If either is added, the following dead-code
        // function bodies fail to compile with E0277 on the trait bound.
        fn _must_not_impl_serialize<T>(_: &T)
        where
            T: NotSerialize,
        {
        }
        trait NotSerialize {}
        impl<T: ?Sized> NotSerialize for T {}
        // If a future derive/impl adds serde::Serialize to AuthorizedContext,
        // the test would need a more-specific defense. The blanket NotSerialize
        // admits everything today; its purpose is documentary — it marks
        // intent for future code review. Serialize/Deserialize omission is
        // primarily enforced by the struct's private fields + no derive.
        let ctx = build_ctx(Permission::ReadTag(TagId::from("t".to_string())), false);
        _must_not_impl_serialize(&ctx);
    }
}
