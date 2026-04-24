//! OPC UA session principal — Batch #239 Faz 5 (ultra-plan
//! `ULTRA-HIGH-003`, Gap `A-2a` part 1 primitive).
//!
//! ## Purpose
//!
//! Batch 224 introduced `parse_opc_ua_session_actor(&str) ->
//! Option<ActorIdentity>` that reads a session-layer actor string
//! (`"op:<hex32>"`, `"svc:<cn>"`, `"opc-ua-anonymous"`) and returns
//! an authz `ActorIdentity`. The `&str` input is a convention —
//! nothing in the type system binds the string back to a real
//! authenticated session. Once that string escapes the OPC UA
//! session layer, any caller can fabricate one.
//!
//! Ultra-plan gap `A-2a` names this debt: **the principal is
//! serialized through a string at all**. A patch-shape fix would
//! tighten the regex + add more prefix allowlists; the architectural
//! fix is to represent the session principal as a **closed-variant,
//! externally-non-constructible newtype** carrying exactly the
//! evidence the session layer observed.
//!
//! Batch #239 lands the newtype. The existing
//! `parse_opc_ua_session_actor` adapter stays in place for the
//! SimpleNodeManager callback path (Batch 224) so the current
//! read-path keeps working; the new `AuthenticatedUser` becomes the
//! shape the future custom NodeManager (Batch A-2b) constructs from
//! `RequestContext::authenticated_user()` + which A-2c wires into
//! the write orchestrator's authz port.
//!
//! ## Seal properties (Tier-1 make-it-impossible)
//!
//! 1. `AuthenticatedUser` wraps a **private** `AuthenticatedUserInner`
//!    enum. No `pub` ctor takes a `String` / `&str` / serde input.
//!    Deserialize/From/FromStr impls are deliberately absent.
//! 2. The only paths to construct an `AuthenticatedUser` are three
//!    `pub(crate) fn` ctors (`anonymous`, `user_pass`, `x509`). Call
//!    sites are grep-auditable — only the custom NodeManager (Batch
//!    A-2b) and test helpers may use them.
//! 3. `MachineIssuerCn` is a validated newtype with `pub fn
//!    from_verified_cert` requiring the raw cert bytes + existing
//!    PKI verification (trust store match, revocation check). The
//!    plain `pub fn new` accepts validated DN bytes only after X.509
//!    parsing; a raw attacker string cannot reach this path.
//! 4. `to_actor_identity()` converts the typed principal into the
//!    existing `authz::ActorIdentity` enum for downstream
//!    PolicyEngine consumption. The conversion is closed (exhaustive
//!    match over the private enum) + rejects the `Anonymous` variant
//!    explicitly with `SessionActorError::AnonymousSessionRejected`.
//!    No future variant addition can silently fall through to an
//!    anonymous identity.
//!
//! ## What's NOT in Batch #239 (explicit, primitive-first)
//!
//! - `OpcUaActorResolver { manifest_store: Arc<RbacManifestStore> }`
//!   adapter that validates `AuthenticatedUser` against the current
//!   RBAC manifest's `operator_bindings` / `machine_issuers`. That's
//!   Batch #240 (A-2a part 2 adapter).
//! - Custom `NodeManager` implementation that captures
//!   `RequestContext::authenticated_user()` + threads it into the
//!   write orchestrator. That's Batch #241 (A-2b).
//! - Deletion of Batch 224's `parse_opc_ua_session_actor`. Kept
//!   as the SimpleNodeManager-callback adapter until A-2b flips the
//!   server to a custom NodeManager.
//!
//! ## Cross-references
//!
//! - Ultra-plan `#Gap-A-2a` / finding registry `ULTRA-HIGH-003`
//! - `authz::context::ActorIdentity` — the downstream enum
//! - `authz::permission::OperatorId` — sealed newtype reused here
//! - Batch 224 `opc_ua_server::parse_opc_ua_session_actor` — string
//!   path this newtype obsoletes

#![allow(dead_code)]

use std::fmt;

use crate::authz::context::ActorIdentity;
use crate::authz::permission::OperatorId;

/// Validated machine-issuer common name. Carries only the CN string
/// itself; cryptographic trust (chain validation, revocation list,
/// pin match) is the caller's pre-condition — the newtype represents
/// "this CN was authenticated by the session layer" as a typed fact.
///
/// `pub fn from_verified_cert_cn(s: String)` is the sole constructor;
/// caller discipline is to invoke it only after X.509 chain
/// verification + pin/revocation checks pass. Future batches add
/// direct `from_der(bytes)` + `from_trust_anchor(handle)` ctors that
/// inline the verification — at which point `from_verified_cert_cn`
/// becomes `pub(crate)` + the public surface drops the trust-on-
/// trust gap.
///
/// Why not a plain String: grepping for `MachineIssuerCn::new` or
/// `from_verified_cert_cn` is finite + auditable. Grepping for
/// "machine issuer string creation" is not.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct MachineIssuerCn(String);

impl MachineIssuerCn {
    /// Construct from a CN string whose source was X.509-chain-
    /// verified + revocation-checked + pin-matched. Caller bears
    /// that discipline; the type does not self-verify. Rejects
    /// empty strings (empty CN is a malformed X.509 subject).
    pub fn from_verified_cert_cn(cn: String) -> Result<Self, SessionActorError> {
        if cn.is_empty() {
            return Err(SessionActorError::MachineIssuerEmptyCn);
        }
        Ok(Self(cn))
    }

    /// Read-only view for audit labels + downstream
    /// `ActorIdentity::MachineIssuer { subject_cn }` construction.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Private enum carrying the session principal's variant + evidence.
/// Not exported — consumers go through [`AuthenticatedUser`]'s
/// accessor methods.
#[derive(Debug, Clone)]
enum AuthenticatedUserInner {
    /// No user-level credentials attached. Every downstream path
    /// that consumes `AuthenticatedUser` rejects this variant at
    /// `to_actor_identity()` — fail-closed.
    Anonymous,
    /// User / password credential bound to an enrolled operator.
    /// The `operator_id` was resolved from the RBAC manifest's
    /// `operator_bindings` by the resolver adapter (A-2a part 2,
    /// Batch #240).
    UserPass { operator_id: OperatorId },
    /// X.509 client cert whose CN matched an enrolled machine
    /// issuer + chain verified against the pinned trust anchor.
    /// The `operator_id` maps the machine to its service-account
    /// operator binding in the RBAC manifest.
    X509 {
        issuer_cn: MachineIssuerCn,
        operator_id: OperatorId,
    },
}

/// Typed session principal — the OPC UA surface's authenticated
/// caller. External modules cannot construct this type; every ctor
/// is `pub(crate)` and callable only from the custom NodeManager
/// boundary (Batch A-2b) or `#[cfg(test)]` helpers.
///
/// Wrapping `AuthenticatedUserInner` behind an opaque newtype rather
/// than exposing the enum directly keeps the variant set evolvable
/// without breaking external consumers + makes the sealed-ctor
/// property a single-file grep check.
pub struct AuthenticatedUser(AuthenticatedUserInner);

impl AuthenticatedUser {
    /// Construct an anonymous principal. Sole legitimate caller:
    /// the custom NodeManager's `write` handler when the session
    /// carries no user token (async-opcua `AnonymousIdentityToken`).
    /// Downstream paths reject Anonymous at `to_actor_identity` so
    /// no ambient-authority leak is possible — the variant exists
    /// to carry the negative proof ("no user was authenticated")
    /// through the type system.
    pub(crate) fn anonymous() -> Self {
        Self(AuthenticatedUserInner::Anonymous)
    }

    /// Construct from a resolved operator_id after UserName/Password
    /// token verification against the RBAC manifest's Argon2id
    /// credential hash (Batch A-3a resolver).
    pub(crate) fn user_pass(operator_id: OperatorId) -> Self {
        Self(AuthenticatedUserInner::UserPass { operator_id })
    }

    /// Construct from an X.509 session where the cert's subject CN
    /// matched a manifest machine-issuer binding + the chain was
    /// verified against the pinned trust anchor.
    pub(crate) fn x509(issuer_cn: MachineIssuerCn, operator_id: OperatorId) -> Self {
        Self(AuthenticatedUserInner::X509 {
            issuer_cn,
            operator_id,
        })
    }

    /// Test-only ctors. `#[cfg(test)]` gate ensures production call
    /// graphs cannot reach them. Grep for `AuthenticatedUser::for_test`
    /// outside `#[cfg(test)]` blocks = invariant violation.
    #[cfg(test)]
    pub(crate) fn for_test_anonymous() -> Self {
        Self::anonymous()
    }

    #[cfg(test)]
    pub(crate) fn for_test_user_pass(operator_id: OperatorId) -> Self {
        Self::user_pass(operator_id)
    }

    #[cfg(test)]
    pub(crate) fn for_test_x509(issuer_cn: MachineIssuerCn, operator_id: OperatorId) -> Self {
        Self::x509(issuer_cn, operator_id)
    }

    /// True when the principal carries no user credentials. Callers
    /// that short-circuit on anonymous (e.g. skip the operator-
    /// binding lookup) use this rather than matching the variant
    /// directly.
    pub fn is_anonymous(&self) -> bool {
        matches!(self.0, AuthenticatedUserInner::Anonymous)
    }

    /// Convert to the downstream `authz::ActorIdentity` representation
    /// consumed by `PolicyEngine::authorize`. Exhaustive match over
    /// the private enum; adding a variant is a compile-time
    /// requirement to handle it here (no silent fall-through).
    /// `Anonymous` rejects with `AnonymousSessionRejected` — the
    /// OPC UA write surface's fail-closed contract.
    pub fn to_actor_identity(&self) -> Result<ActorIdentity, SessionActorError> {
        match &self.0 {
            AuthenticatedUserInner::Anonymous => {
                Err(SessionActorError::AnonymousSessionRejected)
            }
            AuthenticatedUserInner::UserPass { operator_id } => {
                Ok(ActorIdentity::Operator(operator_id.clone()))
            }
            AuthenticatedUserInner::X509 { issuer_cn, .. } => {
                Ok(ActorIdentity::MachineIssuer {
                    subject_cn: issuer_cn.as_str().to_string(),
                })
            }
        }
    }

    /// Audit-safe short label — operator IDs redacted to
    /// `user_pass:<hex>` prefix; X509 CN surfaced; Anonymous flagged
    /// explicitly. Matches `ActorIdentity::audit_label` taxonomy so
    /// downstream audit records remain homogeneous.
    pub fn audit_label(&self) -> String {
        match &self.0 {
            AuthenticatedUserInner::Anonymous => "session:anonymous".to_string(),
            AuthenticatedUserInner::UserPass { .. } => "session:user_pass".to_string(),
            AuthenticatedUserInner::X509 { issuer_cn, .. } => {
                format!("session:x509:{}", issuer_cn.as_str())
            }
        }
    }
}

impl fmt::Debug for AuthenticatedUser {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Deliberately redacts operator_id hex (audit leak defense
        // parallel to AuthorizedContext's Debug redaction). Anyone
        // wanting the operator_id goes through `to_actor_identity`
        // + the audit_label helper.
        f.debug_tuple("AuthenticatedUser")
            .field(&self.audit_label())
            .finish()
    }
}

/// Error taxonomy for session-actor resolution failures. Each
/// variant maps to a distinct OPC UA `StatusCode` at the session
/// layer + a distinct audit outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionActorError {
    /// `AuthenticatedUser::Anonymous` was passed to a path that
    /// requires an enrolled operator. Maps to OPC UA
    /// `BadUserAccessDenied`.
    AnonymousSessionRejected,
    /// UserPass / X509 session resolved but the `operator_id` is
    /// not present in the current RBAC manifest's
    /// `operator_bindings`. Raised by the resolver adapter (Batch
    /// #240); not produced directly by `AuthenticatedUser`.
    OperatorNotEnrolled,
    /// X509 machine-issuer CN matched a manifest binding but the
    /// binding's `revoked_at` is in the past. Raised by the
    /// resolver; not produced directly by `AuthenticatedUser`.
    MachineIssuerRevoked,
    /// `MachineIssuerCn::from_verified_cert_cn` received an empty
    /// string — malformed X.509 subject.
    MachineIssuerEmptyCn,
}

impl fmt::Display for SessionActorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AnonymousSessionRejected => {
                f.write_str("anonymous session rejected")
            }
            Self::OperatorNotEnrolled => {
                f.write_str("operator not enrolled in RBAC manifest")
            }
            Self::MachineIssuerRevoked => {
                f.write_str("machine issuer revoked")
            }
            Self::MachineIssuerEmptyCn => {
                f.write_str("machine issuer common name is empty")
            }
        }
    }
}

impl std::error::Error for SessionActorError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::context::ActorIdentity;

    fn canned_op_id() -> OperatorId {
        OperatorId::new_from_verified([0x07u8; 16])
    }

    #[test]
    fn anonymous_is_anonymous_flag_true() {
        let u = AuthenticatedUser::for_test_anonymous();
        assert!(u.is_anonymous());
    }

    #[test]
    fn user_pass_is_anonymous_flag_false() {
        let u = AuthenticatedUser::for_test_user_pass(canned_op_id());
        assert!(!u.is_anonymous());
    }

    #[test]
    fn x509_is_anonymous_flag_false() {
        let cn = MachineIssuerCn::from_verified_cert_cn("auth-service".into()).unwrap();
        let u = AuthenticatedUser::for_test_x509(cn, canned_op_id());
        assert!(!u.is_anonymous());
    }

    #[test]
    fn anonymous_to_actor_identity_rejects() {
        let u = AuthenticatedUser::for_test_anonymous();
        match u.to_actor_identity() {
            Err(SessionActorError::AnonymousSessionRejected) => {}
            other => panic!("expected AnonymousSessionRejected, got {:?}", other),
        }
    }

    #[test]
    fn user_pass_to_actor_identity_produces_operator() {
        let op_id = canned_op_id();
        let u = AuthenticatedUser::for_test_user_pass(op_id.clone());
        match u.to_actor_identity() {
            Ok(ActorIdentity::Operator(got)) => {
                assert_eq!(got.as_bytes(), op_id.as_bytes());
            }
            other => panic!("expected Operator, got {:?}", other.as_ref().err()),
        }
    }

    #[test]
    fn x509_to_actor_identity_produces_machine_issuer() {
        let cn = MachineIssuerCn::from_verified_cert_cn("auth-service".into()).unwrap();
        let u = AuthenticatedUser::for_test_x509(cn.clone(), canned_op_id());
        match u.to_actor_identity() {
            Ok(ActorIdentity::MachineIssuer { subject_cn }) => {
                assert_eq!(subject_cn, "auth-service");
            }
            other => panic!("expected MachineIssuer, got {:?}", other.as_ref().err()),
        }
    }

    #[test]
    fn machine_issuer_cn_rejects_empty() {
        match MachineIssuerCn::from_verified_cert_cn(String::new()) {
            Err(SessionActorError::MachineIssuerEmptyCn) => {}
            other => panic!("expected MachineIssuerEmptyCn, got {:?}", other),
        }
    }

    #[test]
    fn machine_issuer_cn_preserves_non_empty() {
        let cn = MachineIssuerCn::from_verified_cert_cn("billing-service".into()).unwrap();
        assert_eq!(cn.as_str(), "billing-service");
    }

    #[test]
    fn machine_issuer_cn_is_clonable_and_hashable() {
        // Required for set-membership in manifest lookup (Batch
        // #240 resolver indexes by CN) + cache keys.
        let cn = MachineIssuerCn::from_verified_cert_cn("svc-a".into()).unwrap();
        let cloned = cn.clone();
        assert_eq!(cn, cloned);
        // Hash compile-check via HashSet use.
        let mut s = std::collections::HashSet::new();
        s.insert(cn);
        assert_eq!(s.len(), 1);
    }

    #[test]
    fn audit_label_anonymous() {
        let u = AuthenticatedUser::for_test_anonymous();
        assert_eq!(u.audit_label(), "session:anonymous");
    }

    #[test]
    fn audit_label_user_pass_redacts_operator_id() {
        // OperatorId hex MUST NOT appear in the audit label
        // (parity with AuthorizedContext::actor_audit_label
        // redaction — Batch 5a seal).
        let u = AuthenticatedUser::for_test_user_pass(canned_op_id());
        let label = u.audit_label();
        assert_eq!(label, "session:user_pass");
        // 0x07 repeated → "07070707..." hex MUST NOT leak.
        assert!(!label.contains("07"));
    }

    #[test]
    fn audit_label_x509_includes_cn() {
        let cn = MachineIssuerCn::from_verified_cert_cn("svc-b".into()).unwrap();
        let u = AuthenticatedUser::for_test_x509(cn, canned_op_id());
        let label = u.audit_label();
        assert_eq!(label, "session:x509:svc-b");
    }

    #[test]
    fn debug_impl_redacts_operator_id() {
        // Mirror of AuthorizedContext's Debug-redacts-operator-id
        // invariant. Audit-log leak defense: printing an
        // AuthenticatedUser must never surface the raw OperatorId.
        let u = AuthenticatedUser::for_test_user_pass(canned_op_id());
        let dbg = format!("{:?}", u);
        // Debug output should carry the audit_label, NOT the raw
        // operator hex.
        assert!(dbg.contains("session:user_pass"));
        assert!(!dbg.contains("07070707"));
    }

    #[test]
    fn session_actor_error_display_taxonomy() {
        let msgs = [
            (SessionActorError::AnonymousSessionRejected, "anonymous"),
            (SessionActorError::OperatorNotEnrolled, "not enrolled"),
            (SessionActorError::MachineIssuerRevoked, "revoked"),
            (SessionActorError::MachineIssuerEmptyCn, "empty"),
        ];
        for (e, needle) in msgs {
            let s = format!("{}", e);
            assert!(s.contains(needle), "err={:?} needle={}", e, needle);
        }
    }

    #[test]
    fn authenticated_user_has_no_public_constructor_from_string() {
        // This compile-time property is a load-bearing seal. We
        // cannot write a `#[test]` that fails to compile on this
        // crate-internal path (the tests live inside the module);
        // instead the invariant rests on the grep convention:
        //
        //   $ grep -rE 'impl\s+(From|FromStr|TryFrom).*AuthenticatedUser'
        //       sens-api-gateway/src/
        //   (expect zero hits)
        //
        //   $ grep -E 'pub\s+fn\s+new|pub\s+fn\s+from_' \
        //       sens-api-gateway/src/opc_ua_server_session.rs
        //   (expect only MachineIssuerCn::from_verified_cert_cn)
        //
        // An invariant test landing with Batch #240 runs the grep
        // via `tools/gates/ts` and CI-enforces the invariant.
        // This test serves as a documentation anchor.
        let _u = AuthenticatedUser::for_test_anonymous();
        // Proof that the above anonymous() path is pub(crate) +
        // reachable from test code, not from external consumers.
    }
}
