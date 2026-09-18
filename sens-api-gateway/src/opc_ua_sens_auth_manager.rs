//! Custom OPC UA AuthManager — Batch #266 A-2b part 4.
//!
//! ## Why this module exists
//!
//! Pre-Batch-#266, the OPC UA server runtime relied on
//! async-opcua's default AuthManager (effectively a "pass
//! through" handler that accepts every credential). The Batch
//! #245 `UserTokenValidator` (which closes Gap A-3 by binding
//! cloud-signed user-token enrollment manifests to typed
//! `AuthenticatedUser` minting) had no consumer at the
//! session-establish boundary — every OPC UA session ran
//! UNAUTHENTICATED, defeating the entire credential pipeline
//! Batches #242-#250 built (9 batches, +95 tests).
//!
//! This module wires the missing bridge: a
//! `SensAuthManager` implementation of async-opcua's
//! `AuthManager` trait that:
//!
//! 1. **Rejects anonymous sessions** — `authenticate_anonymous_
//!    token` returns `BadIdentityTokenRejected`. Suderra writes
//!    require an authenticated principal; reads still succeed
//!    via the read-only browse path (Batch #264 SensNodeManager
//!    read body), but anonymous sessions cannot reach the typed-
//!    authz write gate.
//!
//! 2. **Validates UserName/Password via Batch #245**
//!    `UserTokenValidator.validate_user_pass`. On Ok, encodes
//!    the resolved `OperatorId` into the stable UserToken
//!    format defined by Batch #265
//!    (`opc_ua_sens_node_manager::format_operator_token`) so
//!    the write trait method's `parse_operator_token` extracts
//!    the operator_id back from `Session.user_token()`.
//!
//! 3. **Validates X.509 client certificates** — wired in a
//!    later batch (this batch returns `BadIdentityTokenRejected`
//!    + a warn log naming the next-batch wire target). The
//!    Thumbprint → CN → operator_id resolution chain requires
//!    an X.509 parse that's deeper than the v1 wire scope.
//!
//! 4. **Reports the supported token policies** —
//!    `user_token_policies(endpoint)` returns the UserName +
//!    X509 policies (anonymous deliberately omitted so the
//!    server's session-establish path SKIPS the anonymous
//!    code path entirely — defense in depth).
//!
//! ## Wire status (Batch #266)
//!
//! Skeleton + production paths for UserName/Password + X.509-
//! reject. Production wire (Batch #267) plumbs the
//! `Arc<SensAuthManager>` into `ServerBuilder::with_authenticator`
//! at boot. Until that wire lands, this module compiles but is
//! NOT reachable from any session-establish path; the existing
//! default AuthManager continues to handle sessions.
//!
//! ## Defense in depth
//!
//! Even after Batch #267 wires this AuthManager, the full
//! defense chain at session-establish time is:
//!
//! 1. **TLS + leaf-cert pinning** (Batch 139 mTLS strict mode)
//!    — a non-pinned cert never reaches AuthManager.
//! 2. **AuthManager** (this module) — verifies the user-token
//!    against the Batch #245 UserTokenValidator's
//!    cloud-pushed enrollment manifest.
//! 3. **NodeManager.write** (Batch #265 SensNodeManager) —
//!    re-resolves the principal from session.user_token()
//!    + runs the typed-authz gate.
//!
//! Each layer fails closed independently; bypassing one
//! requires breaking ALL three.

#![allow(dead_code)]

#[cfg(feature = "opc-ua-server")]
use std::sync::Arc;

#[cfg(feature = "opc-ua-server")]
use async_trait::async_trait;

#[cfg(feature = "opc-ua-server")]
use opcua::crypto::Thumbprint;
#[cfg(feature = "opc-ua-server")]
use opcua::server::{
    ServerEndpoint,
    authenticator::{AuthManager, Password, UserToken},
};
#[cfg(feature = "opc-ua-server")]
use opcua::types::{ByteString, Error, StatusCode, UserTokenPolicy, UserTokenType};

#[cfg(feature = "opc-ua-server")]
use crate::authz::permission::OperatorId;
#[cfg(feature = "opc-ua-server")]
use crate::opc_ua_sens_node_manager::format_operator_token;
#[cfg(feature = "opc-ua-server")]
use crate::opc_ua_server_user_token_validator::{UserTokenValidator, UserTokenValidatorError};

// =============================================================
// SensAuthManager — primitive (Batch #266)
// =============================================================

/// async-opcua AuthManager that bridges Suderra's user-token
/// enrollment chain (Batches #242-#250) to OPC UA session
/// establish.
///
/// **Lifetime model:** Construct once at boot. `Arc`-wrap.
/// Hand off via `ServerBuilder::with_authenticator`. The
/// runtime calls `authenticate_*` methods CONCURRENTLY across
/// sessions; the validator is internally Arc-shared so the
/// AuthManager itself is `Send + Sync` automatic.
///
/// **Field choices:**
///
/// - `validator: Arc<UserTokenValidator>` — the Batch #245
///   typed validator. Internally backed by an
///   `Arc<UserTokenManifestStore>` so manifest hot-reloads
///   (Batch #247 ingest_signed) immediately propagate to
///   subsequent session-establish calls.
///
/// - `policies: Vec<UserTokenPolicy>` — pre-computed list
///   returned by `user_token_policies(endpoint)`. Today
///   identical for every endpoint (UserName + X509). Future:
///   per-endpoint filtering for tenant-restricted endpoints.
#[cfg(feature = "opc-ua-server")]
pub struct SensAuthManager {
    validator: Arc<UserTokenValidator>,
    policies: Vec<UserTokenPolicy>,
    /// Phase B-2 (Batch #270 closure) — brute-force throttle.
    /// Type-level invariant: SensAuthManager cannot be constructed
    /// without the throttle (`Self::new` requires the Arc); a future
    /// refactor that "removes" the throttle would have to also remove
    /// the field, which is detected by the
    /// `opc_ua_auth_throttle_enforced` invariant test.
    ///
    /// Per-username throttle (NOT per-IP — async-opcua 0.18's
    /// AuthManager trait does not expose ClientAddr; per-IP gap is
    /// tracked at ORPHAN-MEDIUM-051). See
    /// `crate::opc_ua_server::auth_throttle` module preamble for the
    /// architectural decision record.
    throttle: Arc<crate::opc_ua_server::auth_throttle::FailedAuthWindow>,
    /// Phase B-3 (Batch #272 closure) — per-tenant + per-user session
    /// quota. Type-level invariant: SensAuthManager carries the quota
    /// for the agent's single tenant; every successful authenticate
    /// path consumes a `SessionLease` before issuing the UserToken.
    /// The `opc_ua_session_quota_enforced` invariant pins the wire.
    session_quota: Arc<crate::opc_ua_server::session_quota::SessionQuota>,
    /// Per-token lease registry — the lease lives in this map keyed
    /// by the UserToken string we return to async-opcua. Drop on
    /// session-close is best-effort: async-opcua 0.18 does not expose
    /// a session-close callback at the AuthManager layer (same
    /// architectural class as ORPHAN-HIGH-045 +
    /// ORPHAN-MEDIUM-051). The TTL fail-safe inside SessionQuota
    /// (1-hour default) is the load-bearing release path; this map
    /// is the explicit-release-on-token-known path for callers that
    /// can iterate token lifecycle.
    ///
    /// EDGE-HIGH-018: keyed by the lease's process-unique `lease_id`, NOT
    /// by the operator token. The operator token is a pure function of the
    /// 16-byte `OperatorId`, so it is CONSTANT across every session for a
    /// given operator — keying the index on it made each new session's
    /// `insert` overwrite (and thus drop, releasing the quota slot for) the
    /// previous session's lease, silently pinning an operator's concurrent
    /// count at 1 and defeating the per-user / per-tenant caps. A unique
    /// `lease_id` makes concurrent leases coexist, so `SessionQuota.counts`
    /// stays the single source of truth and this map is a subordinate,
    /// self-pruning index.
    active_leases: Arc<
        std::sync::Mutex<
            std::collections::HashMap<u64, crate::opc_ua_server::session_quota::SessionLease>,
        >,
    >,
}

#[cfg(feature = "opc-ua-server")]
impl SensAuthManager {
    /// Construct a new SensAuthManager from the validator Arc + the
    /// brute-force throttle Arc. The throttle parameter is mandatory
    /// (Tier-1 architectural floor — every SensAuthManager carries a
    /// throttle gate). Production wire constructs the
    /// `FailedAuthWindow` from `OpcUaServerConfig.max_failed_auth_per_60s`
    /// at boot.
    pub fn new(
        validator: Arc<UserTokenValidator>,
        throttle: Arc<crate::opc_ua_server::auth_throttle::FailedAuthWindow>,
        session_quota: Arc<crate::opc_ua_server::session_quota::SessionQuota>,
    ) -> Self {
        Self {
            validator,
            policies: Self::default_policies(),
            throttle,
            session_quota,
            active_leases: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        }
    }

    /// Default policy set: UserName + X509. Anonymous is
    /// deliberately omitted — anonymous sessions cannot reach
    /// the typed-authz write gate, so allowing the protocol-
    /// level anonymous handshake would only add a fail-closed
    /// dead-end path that some HMI clients might fall through
    /// to silently.
    fn default_policies() -> Vec<UserTokenPolicy> {
        vec![
            UserTokenPolicy {
                policy_id: "username_basic256sha256".into(),
                token_type: UserTokenType::UserName,
                issued_token_type: opcua::types::UAString::null(),
                issuer_endpoint_url: opcua::types::UAString::null(),
                security_policy_uri: "http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256"
                    .into(),
            },
            UserTokenPolicy {
                policy_id: "x509_basic256sha256".into(),
                token_type: UserTokenType::Certificate,
                issued_token_type: opcua::types::UAString::null(),
                issuer_endpoint_url: opcua::types::UAString::null(),
                security_policy_uri: "http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256"
                    .into(),
            },
        ]
    }
}

// =============================================================
// AuthManager trait impl (Batch #266)
// =============================================================

#[cfg(feature = "opc-ua-server")]
#[async_trait]
impl AuthManager for SensAuthManager {
    /// **Wire status:** real (Batch #266). Returns the policy
    /// list set at construction time. Constant for the manager's
    /// lifetime; future per-endpoint filtering would override
    /// this method but the v1 contract is "every endpoint sees
    /// the same policy set."
    fn user_token_policies(&self, _endpoint: &ServerEndpoint) -> Vec<UserTokenPolicy> {
        self.policies.clone()
    }

    /// **Wire status:** real (Batch #266). Anonymous sessions
    /// are REJECTED. Reads still succeed via SensNodeManager's
    /// read body (which doesn't gate on session principal —
    /// every authenticated session reads anyway), but anonymous
    /// sessions cannot reach the read body either because
    /// session-establish itself fails here. This is the
    /// architectural gate that closes the "anonymous read"
    /// loophole — Plan §3 R-8 anonymous read-only path is
    /// deliberately NOT supported in v1.
    async fn authenticate_anonymous_token(&self, _endpoint: &ServerEndpoint) -> Result<(), Error> {
        tracing::warn!(
            "SensAuthManager: anonymous session REJECTED — \
             Suderra requires UserName/Password or X.509 \
             authentication"
        );
        Err(Error::new(
            StatusCode::BadIdentityTokenRejected,
            "Anonymous identity token unsupported by SensAuthManager",
        ))
    }

    /// **Wire status:** real (Batch #266). The architectural
    /// fix that closes Gap A-3's session-establish gap.
    ///
    /// Flow:
    /// 1. Wrap the password bytes in `secrecy::Secret<Vec<u8>>`
    ///    (the Batch #245 validator's input shape — guards
    ///    against accidental Debug leaks of plaintext).
    /// 2. Call `validator.validate_user_pass(username,
    ///    password)`. Returns `AuthenticatedUser` on success or
    ///    one of:
    ///    - `NoManifestLoaded` — first-boot before cloud
    ///      pushed enrollment.
    ///    - `CredentialMismatch` — wrong password OR unknown
    ///      username (collapsed for enumeration defense).
    ///    - `BadUsernameFormat` — protocol-level client bug
    ///      (empty / NFKC-rejected username).
    /// 3. Extract `OperatorId` from the
    ///    `AuthenticatedUser::user_pass(op)` variant.
    /// 4. Encode the operator_id into the stable UserToken
    ///    format via `format_operator_token` (Batch #265 helper).
    /// 5. Return `Ok(UserToken(...))` so async-opcua stores it
    ///    on the session for subsequent SensNodeManager::write
    ///    calls to retrieve.
    ///
    /// The token format is the contract between this method
    /// (encoder) and `parse_operator_token` (decoder, Batch
    /// #265). Both share the canonical `format_operator_token`
    /// helper — single source of truth.
    async fn authenticate_username_identity_token(
        &self,
        _endpoint: &ServerEndpoint,
        username: &str,
        password: &Password,
    ) -> Result<UserToken, Error> {
        // Phase B-2 (Batch #270) — pre-check throttle BEFORE running
        // Argon2id. If the username is already throttled in this
        // 60-second window, return BadUserAccessDenied immediately.
        // The Argon2id verifier is the threat — a brute-force loop
        // running unthrottled would saturate the edge agent's CPU
        // budget at ~50ms per attempt × 1000 attempts = 50 seconds of
        // CPU starvation per minute. The throttle bounds this at
        // cap × Argon2id-cost per window per username.
        let throttle_key =
            crate::opc_ua_server::auth_throttle::AuthThrottleKey::for_username(username);
        if let crate::opc_ua_server::auth_throttle::ThrottleDecision::Throttled {
            count,
            retry_after,
        } = self.throttle.peek_decision(&throttle_key)
        {
            tracing::warn!(
                target: "opc_ua.auth_throttle",
                throttle_key = %throttle_key.as_str(),
                count = count,
                retry_after_secs = retry_after.as_secs(),
                "SensAuthManager: session-establish REJECTED — \
                 brute-force throttle active for username (Phase B-2)"
            );
            crate::audit::try_emit_mtls_forensic_event(
                crate::audit::AuditAction::OpcUaAuthThrottled,
                "opc_ua.auth.throttle.denied",
                serde_json::json!({
                    "throttle_key": throttle_key.as_str(),
                    "count": count,
                    "retry_after_secs": retry_after.as_secs(),
                    "reason": "pre_check_throttle_active",
                }),
            );
            return Err(Error::new(
                StatusCode::BadUserAccessDenied,
                "Authentication temporarily denied — too many failed attempts \
                 for this username. Retry after the throttle window expires.",
            ));
        }

        let password_secret = secrecy::Secret::new(password.get().as_bytes().to_vec());

        match self
            .validator
            .validate_user_pass(username, &password_secret)
        {
            Ok(authn) => {
                let op = match extract_operator_from_authn(&authn) {
                    Some(op) => op,
                    None => {
                        tracing::error!(
                            "SensAuthManager: validate_user_pass \
                             returned non-UserPass AuthenticatedUser \
                             — invariant violation"
                        );
                        return Err(Error::new(
                            StatusCode::BadIdentityTokenRejected,
                            "Internal: unexpected AuthenticatedUser variant",
                        ));
                    }
                };
                // Phase B-2 — clear the throttle counter on success.
                // An operator who typoed N < cap times then succeeded
                // should not carry the failure history into their next
                // typing burst.
                self.throttle.clear_on_success(&throttle_key);

                // Phase B-3 (Batch #272) — acquire a SessionLease
                // BEFORE issuing the UserToken. Quota check is the
                // last gate at session-establish; a successful
                // credential authentication still cannot establish a
                // session if the per-user or per-tenant cap is full.
                // Defense-in-depth: brute-force throttle (B-2) +
                // quota fairness (B-3) + global Limits.max_sessions
                // (Batch 228) — three layers each tunable
                // independently.
                let normalized_user = username.trim().to_lowercase();
                let lease = match self.session_quota.try_acquire(&normalized_user) {
                    Ok(lease) => lease,
                    Err(e) => {
                        tracing::warn!(
                            target: "opc_ua.session_quota",
                            user = %normalized_user,
                            error = %e,
                            "SensAuthManager: session-establish REJECTED by quota \
                             after successful authentication (Phase B-3)"
                        );
                        crate::audit::try_emit_mtls_forensic_event(
                            crate::audit::AuditAction::OpcUaSessionQuotaExceeded,
                            "opc_ua.session.quota.exceeded",
                            serde_json::json!({
                                "user": normalized_user,
                                "reason": format!("{e}"),
                                "current_user_count": self.session_quota.current_user_count(&normalized_user),
                                "current_tenant_total": self.session_quota.current_tenant_total(),
                            }),
                        );
                        return Err(Error::new(
                            StatusCode::BadTooManySessions,
                            "Session quota exceeded — close an existing \
                             session for this user (or wait for an idle \
                             session in the tenant to release).",
                        ));
                    }
                };

                let token_str = format_operator_token(&op);
                // EDGE-HIGH-018: stash the lease keyed by its unique
                // lease_id (NOT the per-operator-constant token), so
                // concurrent sessions for the same operator coexist instead
                // of overwriting each other. Then prune any index entries
                // whose lease is no longer live (released or TTL-swept),
                // keeping this map a subordinate view of the authoritative
                // SessionQuota.counts. The SessionQuota's TTL fail-safe
                // remains the load-bearing release path.
                if let Ok(mut leases) = self.active_leases.lock() {
                    leases.insert(lease.lease_id(), lease);
                    leases.retain(|_, l| self.session_quota.is_lease_live(l.lease_id()));
                } else {
                    // Mutex poisoned — we still hold the lease in
                    // scope; the Drop impl will release it when
                    // this match arm returns. The token-keyed
                    // registry is best-effort cleanup for
                    // explicit-release; the on-Drop release is the
                    // architectural floor.
                    tracing::error!(
                        "SensAuthManager: active_leases mutex poisoned — \
                         lease will release on scope exit instead of via \
                         token-keyed registry"
                    );
                    // Drop happens at end of scope (lease moves out).
                    drop(lease);
                }
                tracing::info!(
                    "SensAuthManager: UserName/Password session \
                     established for operator_id_hex={:?}",
                    op.as_bytes()
                );
                Ok(UserToken(token_str))
            }
            Err(UserTokenValidatorError::NoManifestLoaded) => {
                tracing::warn!(
                    "SensAuthManager: session-establish rejected — \
                     no user-token manifest loaded yet (cloud \
                     hasn't pushed enrollment)"
                );
                Err(Error::new(
                    StatusCode::BadIdentityTokenRejected,
                    "User-token manifest not yet loaded on this device",
                ))
            }
            Err(UserTokenValidatorError::CredentialMismatch) => {
                // Generic message — same response for unknown
                // username + wrong password (Batch #242 validator
                // collapse). Username enumeration defense.
                //
                // Phase B-2 — record_failure for the throttle. If
                // this attempt pushes the count to the cap, the next
                // attempt for the same username will skip Argon2id
                // entirely (peek_decision at the top of this method).
                let decision = self.throttle.record_failure(&throttle_key);
                if let crate::opc_ua_server::auth_throttle::ThrottleDecision::Throttled {
                    count,
                    retry_after,
                } = decision
                {
                    crate::audit::try_emit_mtls_forensic_event(
                        crate::audit::AuditAction::OpcUaAuthThrottled,
                        "opc_ua.auth.throttle.cap_reached",
                        serde_json::json!({
                            "throttle_key": throttle_key.as_str(),
                            "count": count,
                            "retry_after_secs": retry_after.as_secs(),
                            "reason": "credential_mismatch_burst",
                        }),
                    );
                }
                tracing::warn!(
                    "SensAuthManager: credential_mismatch \
                     (username + password did not match an enrolled \
                     operator)"
                );
                Err(Error::new(
                    StatusCode::BadIdentityTokenRejected,
                    "Credential mismatch",
                ))
            }
            Err(UserTokenValidatorError::BadUsernameFormat) => {
                // Phase B-2 — bad-username-format also counts toward
                // the throttle. A client systematically probing with
                // malformed usernames (e.g., NFKC bypass attempts) is
                // a brute-force surface even though no Argon2id runs.
                let _ = self.throttle.record_failure(&throttle_key);
                tracing::warn!(
                    "SensAuthManager: client supplied bad username \
                     format (empty / NFKC-rejected / oversize)"
                );
                Err(Error::new(
                    StatusCode::BadIdentityTokenRejected,
                    "Bad username format",
                ))
            }
            // X.509 validator errors won't fire on the user-pass
            // path; defensive fall-through with a structured
            // log so a future validator extension that surfaces
            // them through this path is visible.
            Err(other) => {
                let _ = self.throttle.record_failure(&throttle_key);
                tracing::error!(
                    "SensAuthManager: unexpected validator error \
                     on user-pass path: {}",
                    other
                );
                Err(Error::new(
                    StatusCode::BadIdentityTokenRejected,
                    "Validator surfaced unexpected error class",
                ))
            }
        }
    }

    /// **Wire status:** stub (Batch #266). The X.509
    /// session-establish path requires:
    /// 1. Resolving the client cert chain to the verified CN
    ///    (the runtime's mTLS chain-validation already does
    ///    this; we receive the verified `Thumbprint`).
    /// 2. Extracting the CN from the cert by Thumbprint lookup
    ///    against the trust store.
    /// 3. Building a `MachineIssuerCn::from_verified_cert_cn`
    ///    (Batch #239 sealed newtype).
    /// 4. Calling `validator.validate_x509(cn,
    ///    presented_trust_anchor_der)` (Batch #245).
    ///
    /// Step (2) requires async-opcua's certificate store API
    /// which is in `opcua_crypto` — wiring that into this
    /// module is a separate batch (#266b) so this batch's scope
    /// stays bounded to UserName/Password + the AuthManager
    /// trait surface contract.
    ///
    /// **Wire pending:** Batch #266b will populate this method
    /// with the X.509 path, replacing the BadIdentityTokenRejected.
    async fn authenticate_x509_identity_token(
        &self,
        _endpoint: &ServerEndpoint,
        signing_thumbprint: &Thumbprint,
    ) -> Result<UserToken, Error> {
        tracing::warn!(
            "SensAuthManager: X.509 session-establish stubbed in \
             Batch #266 — returns BadIdentityTokenRejected. \
             Batch #266b wires the validator.validate_x509 path. \
             Thumbprint received: {:?}",
            signing_thumbprint
        );
        Err(Error::new(
            StatusCode::BadIdentityTokenRejected,
            "X.509 session-establish not yet wired (Batch #266b pending)",
        ))
    }

    /// **Wire status:** intentional default — IssuedToken (e.g.,
    /// SAML, JWT, OAuth) is NOT a Suderra-supported user-token
    /// type. Trait default returns BadIdentityTokenRejected;
    /// override here adds a warn-log so operators see the
    /// gate-close in journalctl.
    async fn authenticate_issued_identity_token(
        &self,
        _endpoint: &ServerEndpoint,
        _token: &ByteString,
    ) -> Result<UserToken, Error> {
        tracing::warn!(
            "SensAuthManager: IssuedToken session REJECTED — \
             Suderra does not support OAuth/SAML/JWT identity \
             tokens. Use UserName/Password (validator-backed) or \
             X.509 (when Batch #266b lands)."
        );
        Err(Error::new(
            StatusCode::BadIdentityTokenRejected,
            "Issued identity tokens unsupported by SensAuthManager",
        ))
    }
}

// =============================================================
// AuthenticatedUser → OperatorId extraction
// =============================================================

/// Extract the `OperatorId` from a UserPass `AuthenticatedUser`
/// variant. Returns `None` for any other variant (Anonymous /
/// X509 — neither lands on the user-pass session-establish path
/// so a `None` here is an invariant violation).
///
/// The function is private + pattern-matches on the public
/// `audit_label` accessor's data shape rather than the sealed
/// inner variants — preserves the Batch #239 seal invariant
/// (no module outside `opc_ua_server_session.rs` can pattern-
/// match the inner enum directly). The audit_label string is
/// the public projection; we parse the operator_id back from
/// it.
///
/// **Wire status (Batch #266):** consumed by
/// `authenticate_username_identity_token` to bridge the
/// validator's typed return to the format_operator_token input.
#[cfg(feature = "opc-ua-server")]
fn extract_operator_from_authn(
    authn: &crate::opc_ua_server_session::AuthenticatedUser,
) -> Option<OperatorId> {
    // Use the public `to_actor_identity()` accessor as the
    // structured projection — returns
    // `ActorIdentity::Operator(OperatorId)` for UserPass +
    // `MachineIssuer { ... }` for X509. Anonymous cannot reach
    // here (validate_user_pass never returns
    // AuthenticatedUser::anonymous() per Batch #245 contract).
    use crate::authz::context::ActorIdentity;
    match authn.to_actor_identity().ok()? {
        ActorIdentity::Operator(op) => Some(op),
        ActorIdentity::MachineIssuer { .. } => {
            // X.509 session principal — would have come from the
            // x509 path, not user-pass. Defensive None here so a
            // future cross-path drift is observable as an
            // invariant-violation log line in
            // authenticate_username_identity_token.
            None
        }
    }
}

// =============================================================
// Trait-bound smoke tests + ctor smoke
// =============================================================

#[cfg(all(test, feature = "opc-ua-server"))]
mod tests {
    use super::*;

    /// Compile-time assertion: SensAuthManager satisfies the
    /// `Send + Sync + 'static` bound the trait requires.
    #[test]
    fn sens_auth_manager_is_send_sync_static() {
        fn assert_bounds<T: Send + Sync + 'static>() {}
        assert_bounds::<SensAuthManager>();
    }

    /// Compile-time assertion: the impl satisfies the
    /// `AuthManager` trait shape. Catches an async-opcua
    /// upgrade that renames a method at TEST compile time.
    #[test]
    fn sens_auth_manager_implements_auth_manager_trait() {
        fn assert_impl<T: AuthManager>() {}
        assert_impl::<SensAuthManager>();
    }

    /// Default policy set must include UserName + X.509,
    /// must NOT include Anonymous (defense-in-depth gate).
    #[test]
    fn default_policies_omit_anonymous() {
        let policies = SensAuthManager::default_policies();
        let kinds: Vec<UserTokenType> = policies.iter().map(|p| p.token_type).collect();
        assert!(kinds.contains(&UserTokenType::UserName));
        assert!(kinds.contains(&UserTokenType::Certificate));
        assert!(!kinds.contains(&UserTokenType::Anonymous));
    }
}
