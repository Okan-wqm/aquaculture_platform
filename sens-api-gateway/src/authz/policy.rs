//! # PolicyEngine — the one gate to mint [`AuthorizedContext`]
//!
//! Consumers wire `dyn PolicyEngine` through `Arc<_>` and call
//! [`PolicyEngine::authorize`] with an [`AuthorizationRequest`]. A successful
//! call returns the sealed [`AuthorizedContext`] proof; a failure returns a
//! structured [`AuthorizationDenyReason`].
//!
//! **Architectural position:**
//!
//! 1. Command envelope arrives via MQTT (Zero-Trust Command Model, plan §4.10).
//! 2. Envelope signature verified against the operator's pubkey enrolled in
//!    the active signed RBAC manifest (Batch 5b).
//! 3. `PolicyEngine::authorize` matches the envelope's claimed permission
//!    against the actor's role chain in the manifest AND applies
//!    constraint gates (tenant, two-person integrity, license tier,
//!    policy version freshness, expiry).
//! 4. ON ALLOW → command handler invoked with the sealed `AuthorizedContext`.
//! 5. ON DENY → audit event emitted with structured reason; no handler call.
//!
//! **Scope of Batch 5a (this file):** trait signature + request/error types.
//! The `InMemoryPolicyEngine` reference impl lands in Faz 2 Sprint 6.1 with
//! the signed-manifest parser.

use std::time::SystemTime;

use async_trait::async_trait;

use super::context::{
    ActorIdentity, AuthorizationDecision, AuthorizationDenyReason, AuthorizedContext,
};
use super::permission::{Permission, TenantId};

/// A request to authorize one actor to execute one permission. Carries the
/// minimum information the engine needs to decide; does NOT carry the command
/// payload (the payload goes to the handler after authorization succeeds).
///
/// **Why we separate request from payload:** keeping the request narrow means
/// the engine cannot accidentally enforce payload-dependent logic — all
/// payload validation happens in the handler, gated by the handler's own
/// access to the [`AuthorizedContext`]. This keeps the make-it-impossible
/// gate sharp.
#[derive(Debug, Clone)]
pub struct AuthorizationRequest {
    /// Who is asking. If the actor is an operator, their signed ed25519
    /// envelope was already verified upstream; if machine issuer, their
    /// mTLS cert is the trust anchor.
    pub actor: ActorIdentity,

    /// What permission they claim.
    pub requested_permission: Permission,

    /// Tenant binding — MUST match the active manifest's tenant_id OR the
    /// engine rejects with `TenantMismatch`. Upstream sets this to the
    /// tenant bound at provisioning (sealed via `DeviceId` / `TenantId`
    /// newtypes per ADR-019 §4).
    pub tenant: TenantId,

    /// Policy version the actor claims to have seen. Monotonic: the engine
    /// rejects any request with `claimed_policy_version < highest_seen`
    /// to block rollback attacks (plan §2 HC-8 adversarial baseline +
    /// ADR-018 §9 policy-version monotonicity).
    pub claimed_policy_version: u64,

    /// Co-approver envelope for two-person-integrity commands — optional.
    /// If `Some`, the engine verifies the co-approver's signature, confirms
    /// they hold the `ForceValueCoApprove`-class permission, and confirms
    /// the co-approver is NOT the primary actor. Commands that do not
    /// require two-person integrity ignore this field.
    pub co_approver: Option<CoApproverEvidence>,

    /// Wall-clock time at which the command was received. Used for role
    /// expiry checks and audit records. Upstream passes a monotonic-safe
    /// `SystemTime` from the NTS-authenticated clock (plan D-7).
    pub received_at: SystemTime,
}

/// Evidence a second operator has co-approved a high-risk command.
///
/// Two-person-integrity commands per ADR-018 §8 (`ForceValue`, `DeployProgram`,
/// `SafeStateTrigger`, `ManagePolicy`) REQUIRE a signed co-approval from a
/// second operator holding `ForceValueCoApprove` (or equivalent per-permission
/// co-approver role). The co-approver MUST be different from the primary and
/// bound to the same tenant.
#[derive(Debug, Clone)]
pub struct CoApproverEvidence {
    pub actor: ActorIdentity,
    /// ed25519 signature over canonical request bytes (length-prefix framing
    /// per Batch 4b EDGE-LOW-101 closure). Verifier: engine uses the
    /// co-approver's pubkey from the manifest.
    pub signature: Ed25519SignatureBytes,
}

/// Validated ed25519 signature — always exactly 64 bytes. Moves the length
/// check to the parse boundary (MQTT envelope decode) rather than deferring
/// to signature-verify failure, which is a weaker error path (forensic
/// ambiguity: a truncated payload, a wrong key, and a forgery all collapse
/// into a generic "verify failed" without this newtype).
///
/// **EDGE-LOW-002 closure:** matches the Batch 2 validated-newtype pattern
/// (`ModbusRegisterRange::new`). Tier-1 make-it-impossible for the
/// signature-length class of bug.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ed25519SignatureBytes([u8; 64]);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidSignatureLength {
    pub got: usize,
}

impl std::fmt::Display for InvalidSignatureLength {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ed25519 signature length {} != 64", self.got)
    }
}

impl std::error::Error for InvalidSignatureLength {}

impl Ed25519SignatureBytes {
    /// Validate + wrap. On length mismatch returns structured error —
    /// callers surface it as an envelope-parse failure (distinct from
    /// signature-verify failure).
    pub fn from_slice(bytes: &[u8]) -> Result<Self, InvalidSignatureLength> {
        if bytes.len() != 64 {
            return Err(InvalidSignatureLength { got: bytes.len() });
        }
        let mut out = [0u8; 64];
        out.copy_from_slice(bytes);
        Ok(Self(out))
    }

    /// Direct ctor from a known-64-byte array (test + ceremony paths only).
    pub fn from_array(bytes: [u8; 64]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; 64] {
        &self.0
    }
}

/// Engine-side error for flows outside the allow/deny decision — e.g. the
/// manifest is missing, the engine is still booting, or the keystore is
/// unavailable. Distinct from [`AuthorizationDenyReason`] which is the
/// *decision* shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyEngineError {
    /// No active manifest loaded — first boot before provisioning completed,
    /// or post-compromise rotation window. Consumers fail-closed.
    ManifestUnavailable,

    /// Manifest failed signature / tenant / expiry verification at load
    /// time; engine is serving a fallback (usually "deny everything") until
    /// a valid manifest lands.
    ManifestInvalid { reason: &'static str },

    /// Co-approver signature was supplied but could not be verified
    /// (pubkey lookup failed, signature bad, or co-approver not enrolled).
    CoApproverVerifyFailed,

    /// Keystore access failure while the engine tried to perform a derived
    /// signature verification.
    KeystoreUnavailable,

    /// Underlying manifest store I/O error (disk corruption, permission drift
    /// against the Batch 4a systemd sandbox). Trigger for compromise-response.
    ManifestStoreIoError,
}

impl std::fmt::Display for PolicyEngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ManifestUnavailable => f.write_str("manifest_unavailable"),
            Self::ManifestInvalid { reason } => write!(f, "manifest_invalid:{}", reason),
            Self::CoApproverVerifyFailed => f.write_str("co_approver_verify_failed"),
            Self::KeystoreUnavailable => f.write_str("keystore_unavailable"),
            Self::ManifestStoreIoError => f.write_str("manifest_store_io_error"),
        }
    }
}

impl std::error::Error for PolicyEngineError {}

/// The one gate to mint [`AuthorizedContext`]. Implementations enforce every
/// invariant in the module docs:
///
/// - Tenant binding equality with active manifest.
/// - Permission match against actor's role chain in the manifest.
/// - Role chain `valid_from..=valid_until` window containing
///   `request.received_at`.
/// - Two-person integrity verification for the subset of permissions that
///   require it (inspection via `permission.requires_two_person_integrity()`).
/// - Policy version monotonicity against the engine's highest-seen version.
///
/// **Why async:** manifest verify touches the keystore (ed25519 public key
/// lookup + potential TPM-sealed verification key access) which is async in
/// the Faz 2 Sprint 6.1 wiring.
///
/// **Implementations:**
/// - `InMemoryPolicyEngine` (Faz 2 Sprint 6.1) — manifest held in RAM,
///   signature-verified at load, hot-reload on new manifest publish.
/// - `DenyAllPolicyEngine` — tests + fail-closed fallback when
///   `ManifestUnavailable`.
#[async_trait]
pub trait PolicyEngine: Send + Sync + 'static {
    /// Evaluate an authorization request. The success path mints an
    /// [`AuthorizedContext`]; the failure path discriminates the reason so
    /// audit events can record structured discrimination.
    async fn authorize(
        &self,
        request: AuthorizationRequest,
    ) -> Result<AuthorizationDecision, PolicyEngineError>;

    /// Return the current manifest's policy version. Used by:
    /// - Audit events (correlation surface)
    /// - MQTT health publish (cloud side observes staleness)
    /// - Incoming manifest publish (reject lower versions upstream — belt
    ///   and braces with the engine's internal monotonicity check).
    fn current_policy_version(&self) -> u64;

    /// Handle to "try to reload the manifest from the manifest store" —
    /// called when an `update_policy` MQTT command arrives (itself requiring
    /// `Permission::ManagePolicy` + two-person integrity). The reload path
    /// atomically swaps the in-memory manifest if the new one signature-
    /// verifies AND has a strictly greater policy version.
    async fn reload_manifest(&self) -> Result<u64, PolicyEngineError>;
}

/// Syntactic sugar: compose an `AuthorizationRequest` at call sites where the
/// co-approver field is absent. Most commands go through this form; only
/// two-person-integrity commands use the `.with_co_approver()` builder.
impl AuthorizationRequest {
    pub fn new(
        actor: ActorIdentity,
        requested_permission: Permission,
        tenant: TenantId,
        claimed_policy_version: u64,
        received_at: SystemTime,
    ) -> Self {
        Self {
            actor,
            requested_permission,
            tenant,
            claimed_policy_version,
            co_approver: None,
            received_at,
        }
    }

    /// Attach co-approver evidence for two-person-integrity commands.
    pub fn with_co_approver(mut self, co_approver: CoApproverEvidence) -> Self {
        self.co_approver = Some(co_approver);
        self
    }
}

/// Convenience: deny-all engine for tests + fail-closed startup path. The
/// runtime `InMemoryPolicyEngine` uses this as a fallback when manifest
/// verification fails — FAIL-CLOSED per plan HC-3 root-cause discipline.
pub struct DenyAllPolicyEngine {
    /// Reason fed to every denial so audit trail knows why we're deny-all.
    reason: AuthorizationDenyReason,
}

impl DenyAllPolicyEngine {
    pub fn new(reason: AuthorizationDenyReason) -> Self {
        Self { reason }
    }
}

#[async_trait]
impl PolicyEngine for DenyAllPolicyEngine {
    async fn authorize(
        &self,
        _request: AuthorizationRequest,
    ) -> Result<AuthorizationDecision, PolicyEngineError> {
        Ok(AuthorizationDecision::Deny(self.reason.clone()))
    }

    fn current_policy_version(&self) -> u64 {
        0
    }

    async fn reload_manifest(&self) -> Result<u64, PolicyEngineError> {
        Err(PolicyEngineError::ManifestUnavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::permission::{OperatorId, Permission, TagId};

    fn tenant() -> TenantId {
        TenantId::new_from_verified([0x42u8; 16])
    }

    fn operator() -> ActorIdentity {
        ActorIdentity::Operator(OperatorId::new_from_verified([0x07u8; 16]))
    }

    /// WHY: `AuthorizationRequest::new` sets `co_approver = None` by default;
    ///      the builder pattern adds it. Pin both behaviors.
    #[test]
    fn authorization_request_builder_defaults_co_approver_none() {
        let req = AuthorizationRequest::new(
            operator(),
            Permission::ReadTag(TagId::from("t".to_string())),
            tenant(),
            42,
            SystemTime::UNIX_EPOCH,
        );
        assert!(req.co_approver.is_none());

        let with_co = req.with_co_approver(CoApproverEvidence {
            actor: operator(),
            signature: Ed25519SignatureBytes::from_array([0u8; 64]),
        });
        assert!(with_co.co_approver.is_some());
    }

    /// WHY (EDGE-LOW-002 regression guard): Ed25519SignatureBytes rejects
    ///      any byte slice whose length is not exactly 64. Tier-1
    ///      make-it-impossible for signature-length bugs.
    #[test]
    fn ed25519_signature_bytes_rejects_wrong_length() {
        let err = Ed25519SignatureBytes::from_slice(&[0u8; 63]).expect_err("short");
        assert_eq!(err, InvalidSignatureLength { got: 63 });
        let err = Ed25519SignatureBytes::from_slice(&[0u8; 65]).expect_err("long");
        assert_eq!(err, InvalidSignatureLength { got: 65 });
        let err = Ed25519SignatureBytes::from_slice(&[]).expect_err("empty");
        assert_eq!(err, InvalidSignatureLength { got: 0 });
    }

    /// WHY: 64-byte slice round-trips through as_bytes() with exact identity.
    #[test]
    fn ed25519_signature_bytes_roundtrip_64_bytes() {
        let input = [0x42u8; 64];
        let sig = Ed25519SignatureBytes::from_slice(&input).expect("valid length");
        assert_eq!(sig.as_bytes(), &input);
    }

    /// WHY: Display on InvalidSignatureLength is an audit surface; pin format.
    #[test]
    fn invalid_signature_length_display_format() {
        assert_eq!(
            format!("{}", InvalidSignatureLength { got: 63 }),
            "ed25519 signature length 63 != 64"
        );
    }

    /// WHY: DenyAllPolicyEngine must fail-closed — every request returns
    ///      Deny. Sanity-check the full trait surface.
    #[tokio::test]
    async fn deny_all_engine_denies_everything() {
        let engine = DenyAllPolicyEngine::new(AuthorizationDenyReason::PermissionNotGranted);
        let req = AuthorizationRequest::new(
            operator(),
            Permission::ReadTag(TagId::from("t".to_string())),
            tenant(),
            42,
            SystemTime::UNIX_EPOCH,
        );
        let decision = engine.authorize(req).await.expect("deny-all returns Ok(Deny)");
        assert!(matches!(
            decision,
            AuthorizationDecision::Deny(AuthorizationDenyReason::PermissionNotGranted)
        ));

        assert_eq!(engine.current_policy_version(), 0);

        // reload on deny-all always errors with ManifestUnavailable — this is
        // the expected "we have no manifest" signal for the supervisor.
        let err = engine.reload_manifest().await.expect_err("deny-all has no manifest");
        assert_eq!(err, PolicyEngineError::ManifestUnavailable);
    }

    /// WHY: PolicyEngineError Display values are audit strings; pin them.
    #[test]
    fn policy_engine_error_display_snake_case() {
        assert_eq!(
            format!("{}", PolicyEngineError::ManifestUnavailable),
            "manifest_unavailable"
        );
        assert_eq!(
            format!("{}", PolicyEngineError::ManifestInvalid { reason: "tenant_mismatch" }),
            "manifest_invalid:tenant_mismatch"
        );
        assert_eq!(
            format!("{}", PolicyEngineError::CoApproverVerifyFailed),
            "co_approver_verify_failed"
        );
        assert_eq!(
            format!("{}", PolicyEngineError::KeystoreUnavailable),
            "keystore_unavailable"
        );
        assert_eq!(
            format!("{}", PolicyEngineError::ManifestStoreIoError),
            "manifest_store_io_error"
        );
    }

    /// WHY: PolicyEngineError implements std::error::Error for `?` interop.
    #[test]
    fn policy_engine_error_implements_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<PolicyEngineError>();
    }

    /// WHY: PolicyEngine trait object shape compatibility — must be
    ///      storable as `Arc<dyn PolicyEngine>` (Send + Sync + 'static).
    #[test]
    fn policy_engine_is_trait_object_safe() {
        fn assert_object_safe(_: &dyn PolicyEngine) {}
        let engine = DenyAllPolicyEngine::new(AuthorizationDenyReason::PermissionNotGranted);
        assert_object_safe(&engine);
    }
}
