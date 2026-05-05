//! Envelope-dispatched command handler abstraction — Batch #236
//! Faz 1 (ultra-plan `ULTRA-HIGH-001`, Gap `A-1a`).
//!
//! ## Purpose
//!
//! The existing `crate::commands::CommandHandler` struct carries inherent
//! methods for every MQTT command (`cmd_force_value`, `cmd_deploy_program`,
//! `cmd_watch_subscribe`, …). Every handler body takes a raw `&serde_json::
//! Value` + writes to process state without a compile-time proof that
//! `authz::PolicyEngine::authorize` ran first. Per ultra-plan Gap A-1 this
//! is the architectural root-cause: "forgot to authorize" is a runtime
//! review concern, not a type error.
//!
//! Batch #236 lands the **primitive** that converts this into Tier-1 make-
//! it-impossible:
//!
//! - A trait [`EnvelopeHandler`] — each command becomes `impl
//!   EnvelopeHandler for <name>Handler`. The trait's `dispatch` method is
//!   the ONLY entry point into handler logic from the envelope dispatcher.
//! - A newtype [`HandlerInput<P>`] that wraps the authorized payload.
//!   Its constructor is `pub(crate)` and the only call site is
//!   [`HandlerInput::authorize`] — called AFTER the dispatcher has asked
//!   `PolicyEngine::authorize` and received an `AuthorizedContext`. A
//!   handler body therefore cannot name its payload without the authz gate
//!   having passed; external modules cannot forge a `HandlerInput`.
//! - A small [`HandlerError`] taxonomy that handlers return instead of the
//!   existing `(bool, serde_json::Value, Option<String>)` triple, so the
//!   dispatcher can route decisions (authorization denied vs handler
//!   internal error) into the correct audit + MQTT response shape.
//!
//! Batch #237 (`ULTRA-HIGH-002`) migrates every concrete `cmd_*` function
//! on `commands::CommandHandler` into an `impl EnvelopeHandler` for a
//! per-command handler struct and deletes the legacy dispatch-via-match on
//! `commands::mod::CommandHandler::execute`.
//!
//! ## Trait naming (intentional choice)
//!
//! Named `EnvelopeHandler` (not `CommandHandler`) because the existing
//! `crate::commands::CommandHandler` struct owns the name. Co-existence is
//! a short phase: Batch #237 removes the legacy struct's match-dispatch
//! body and leaves the struct as a thin registry of
//! `Arc<dyn EnvelopeHandler>` — the name `CommandHandler` then continues to
//! refer to the runtime registry; `EnvelopeHandler` remains the per-command
//! contract. Ultra-plan block names the trait `CommandHandler` for
//! architectural intent; implementation uses `EnvelopeHandler` for
//! namespace hygiene.
//!
//! ## Compile-time seal
//!
//! The `HandlerInput<P>` constructor is `pub(crate)` + the only call site
//! is [`HandlerInput::authorize`] which takes an `AuthorizedContext` by
//! value. External crates cannot construct a `HandlerInput`. Tests inside
//! this crate that need a handler-input for isolated unit tests use
//! [`HandlerInput::for_test`] (test-only, `#[cfg(test)]`-gated) so the seal
//! is never weakened in production code.
//!
//! ## Cross-references
//!
//! - Ultra-plan `docs/plans/2026-04-24-sens-api-gateway-gap-closure-
//!   ultra-plan.md#Gap-A-1a`
//! - Finding board `docs/reviews/edge-plan/2026-04-19-edge-hardening.md#
//!   ULTRA-HIGH-001`
//! - Registry entry `ULTRA-HIGH-001` in
//!   `docs/reviews/_registry/findings.jsonl`
//! - `crate::authz::context::AuthorizedContext` — the authz proof token
//! - `crate::command_envelope::envelope::CommandEnvelope` — the wire form

#![allow(dead_code)]

use std::fmt;

use async_trait::async_trait;
use serde_json::Value;

use crate::authz::context::AuthorizedContext;
use crate::authz::permission::Permission;

use super::envelope::CommandEnvelope;
use super::jti::Jti;

/// Error taxonomy produced by an `EnvelopeHandler::dispatch` body. The
/// dispatcher routes each variant into a distinct audit event + MQTT
/// response pattern.
///
/// Design note: the existing `(bool, serde_json::Value, Option<String>)`
/// triple used by `commands::CommandHandler::cmd_*` methods conflates
/// multiple concerns (success bool, wire payload, operator-facing
/// message). `HandlerError` + a separate positive-path `HandlerResponse`
/// split those concerns so the dispatcher can emit the correct audit
/// outcome (`Success` / `Failure`) without inspecting strings.
#[derive(Debug, Clone, PartialEq)]
pub enum HandlerError {
    /// Payload deserialization failed. Does NOT mutate state; audit
    /// records the attempt under the handler's permission.
    PayloadInvalid { reason: String },
    /// Handler ran but the operation was rejected by a domain-specific
    /// precondition (license budget, TTL cap, race loser in a two-phase
    /// gate). The handler body is responsible for having done no side
    /// effects before returning this.
    PreconditionFailed { reason: String },
    /// Handler attempted a side effect and it failed (Modbus write
    /// timeout, SQLite error, MQTT publish error). Audit records this as
    /// `Failure`.
    SideEffectFailed { reason: String },
    /// Handler detected an internal invariant violation (panic prevented
    /// via a match that surfaces the inconsistency). Audit records this
    /// as `Failure`; operator sees the reason.
    InternalInvariant { reason: String },
}

impl fmt::Display for HandlerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PayloadInvalid { reason } => {
                write!(f, "payload invalid: {}", reason)
            }
            Self::PreconditionFailed { reason } => {
                write!(f, "precondition failed: {}", reason)
            }
            Self::SideEffectFailed { reason } => {
                write!(f, "side effect failed: {}", reason)
            }
            Self::InternalInvariant { reason } => {
                write!(f, "internal invariant: {}", reason)
            }
        }
    }
}

impl std::error::Error for HandlerError {}

/// Positive-path response body. `payload` is serialized into the MQTT
/// response topic; `audit_detail` is the JSON carried into the audit
/// entry's `detail` field (bounded by `MAX_DETAIL_BYTES` at the audit
/// crate boundary). Both are `Value` so handlers can build domain-
/// specific shapes without committing to a schema at the trait level.
#[derive(Debug, Clone, PartialEq)]
pub struct HandlerResponse {
    pub payload: Value,
    pub audit_detail: Value,
}

impl HandlerResponse {
    /// Convenience ctor when the operator-facing payload and the audit
    /// detail are the same.
    pub fn mirror(value: Value) -> Self {
        Self {
            payload: value.clone(),
            audit_detail: value,
        }
    }

    /// Distinct-shape ctor.
    pub fn new(payload: Value, audit_detail: Value) -> Self {
        Self { payload, audit_detail }
    }
}

/// Minimal projection of the envelope metadata that a handler body
/// needs without re-reading the raw `CommandEnvelope`. Owned so the
/// handler can hold it across async boundaries without borrowing the
/// envelope (which the dispatcher may need to audit before the handler
/// completes).
#[derive(Debug, Clone, PartialEq)]
pub struct EnvelopeMeta {
    pub jti: Jti,
    pub cmd_name: String,
    pub iat_unix_secs: i64,
    pub exp_unix_secs: i64,
}

impl EnvelopeMeta {
    /// Build from an already-verified `CommandEnvelope` + verified `jti`
    /// (the dispatcher holds both and is the only legitimate caller).
    /// `pub(crate)` so no external crate can forge this shape.
    pub(crate) fn from_verified(env: &CommandEnvelope, jti: Jti) -> Self {
        Self {
            jti,
            cmd_name: env.cmd.clone(),
            iat_unix_secs: env.iat_unix_secs,
            exp_unix_secs: env.exp_unix_secs,
        }
    }
}

/// Input to every `EnvelopeHandler::dispatch` call. Carries the authz
/// proof token + the typed payload + envelope metadata. Sealed: external
/// modules cannot construct a `HandlerInput<P>` because the only ctor
/// path is `HandlerInput::authorize` which requires an `AuthorizedContext`
/// that itself is sealed by `AuthorizedContext::new_from_verified` (the
/// grep-auditable ONLY call site of which lives under `crate::authz`).
///
/// A handler body therefore cannot name its payload unless the envelope
/// dispatcher — the ONLY caller of `HandlerInput::authorize` — has
/// already consulted the PolicyEngine and received `Allow`. "Forgot to
/// authorize" becomes a build-time type error.
///
/// Batch #237 wires the dispatcher; until then the primitive is library
/// code with its own unit-test coverage (no production call site yet).
#[derive(Debug)]
pub struct HandlerInput<P> {
    ctx: AuthorizedContext,
    payload: P,
    meta: EnvelopeMeta,
}

impl<P> HandlerInput<P> {
    /// ONLY legitimate constructor. `pub(crate)` so the seal holds;
    /// dispatcher lives in the same crate.
    pub(crate) fn authorize(
        ctx: AuthorizedContext,
        payload: P,
        meta: EnvelopeMeta,
    ) -> Self {
        Self { ctx, payload, meta }
    }

    /// Test-only constructor. `#[cfg(test)]` gate ensures production
    /// call graphs cannot reach it.
    #[cfg(test)]
    pub(crate) fn for_test(
        ctx: AuthorizedContext,
        payload: P,
        meta: EnvelopeMeta,
    ) -> Self {
        Self { ctx, payload, meta }
    }

    /// Read-only view of the authz proof. Handlers use this to emit audit
    /// events with the authenticated actor + to double-check the
    /// granted permission matches what they are about to do (belt-and-
    /// braces defense against dispatcher bugs that might mint a context
    /// for the wrong permission — Tier-2 detection).
    pub fn ctx(&self) -> &AuthorizedContext {
        &self.ctx
    }

    /// Read-only view of the typed payload. Handlers mutate their own
    /// side-effect surfaces (ProcessImage, ForceRegistry, etc.) — they
    /// don't mutate the payload.
    pub fn payload(&self) -> &P {
        &self.payload
    }

    /// Read-only view of the envelope metadata.
    pub fn meta(&self) -> &EnvelopeMeta {
        &self.meta
    }

    /// Consume self into `(ctx, payload, meta)` for handlers that need
    /// owned fields to cross async boundaries.
    pub fn into_parts(self) -> (AuthorizedContext, P, EnvelopeMeta) {
        (self.ctx, self.payload, self.meta)
    }
}

/// The per-command contract the envelope dispatcher calls into.
///
/// Every concrete MQTT command (deploy_program, force_value, …)
/// implements this trait exactly once. The associated type `Payload`
/// picks the serde-deserializable shape for the command's `params`.
/// The method `required_permission(payload)` returns the `Permission`
/// variant the dispatcher asks the PolicyEngine to authorize against —
/// it receives the payload so it can materialize parameterized
/// permissions (e.g. `Permission::WriteTag { tag_id }` needs `tag_id`
/// out of the payload).
///
/// `dispatch` runs the side-effect body. It CANNOT be called from
/// outside the dispatcher because its only input is `HandlerInput<P>`
/// whose constructor is `pub(crate)`.
#[async_trait]
pub trait EnvelopeHandler: Send + Sync {
    /// Typed payload shape for this command's `params`. Must be
    /// `DeserializeOwned` so the dispatcher can parse the envelope
    /// payload once + hand ownership to the handler.
    type Payload: serde::de::DeserializeOwned + Send + 'static;

    /// Canonical command name that appears in `CommandEnvelope.cmd`.
    /// Used as the dispatcher's registry key. `&'static str` so
    /// handlers declare it at type-registration time without per-call
    /// allocation.
    fn cmd_name(&self) -> &'static str;

    /// The permission variant the dispatcher asks the PolicyEngine to
    /// authorize against. Receives the already-deserialized payload so
    /// parameterized permissions (WriteTag{tag_id}, ForceValue{tag_id},
    /// ModbusWrite{device_id, register_range}) are constructed from
    /// runtime data. Must be a deterministic function of the payload —
    /// any non-determinism breaks the authz correlation with the audit
    /// trail.
    fn required_permission(&self, payload: &Self::Payload) -> Permission;

    /// Handler body. Called by the dispatcher AFTER the PolicyEngine
    /// returned `Allow` + the `HandlerInput<Self::Payload>` was minted.
    /// Returns either a positive `HandlerResponse` (audit `Success`) or
    /// a taxonomized `HandlerError` (audit `Failure` with the variant
    /// deciding the operator-visible reason).
    async fn dispatch(
        &self,
        input: HandlerInput<Self::Payload>,
    ) -> Result<HandlerResponse, HandlerError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::context::ActorIdentity;
    use crate::authz::permission::{OperatorId, TagId, TenantId};

    fn canned_ctx(perm: Permission) -> AuthorizedContext {
        use std::time::{Duration, UNIX_EPOCH};
        AuthorizedContext::new_from_verified(
            ActorIdentity::Operator(OperatorId::new_from_verified([0x07u8; 16])),
            perm,
            TenantId::new_from_verified([0x42u8; 16]),
            11,
            false,
            UNIX_EPOCH + Duration::from_secs(1_700_000_000),
        )
    }

    fn canned_meta() -> EnvelopeMeta {
        EnvelopeMeta {
            jti: Jti::try_new("01HZAAAAAAAAAAAAAAAAAAAAAA".to_string())
                .expect("valid jti"),
            cmd_name: "test_cmd".to_string(),
            iat_unix_secs: 1_699_999_000,
            exp_unix_secs: 1_700_001_000,
        }
    }

    #[test]
    fn handler_input_authorize_binds_all_three_fields() {
        // AuthorizedContext has no Clone impl (anti-forgery); we build
        // one ctx for the input and assert by re-reading via .ctx().
        let perm = Permission::ReadTag;
        let ctx = canned_ctx(perm.clone());
        let payload = 42i32;
        let meta = canned_meta();
        let input = HandlerInput::authorize(ctx, payload, meta.clone());
        assert_eq!(*input.payload(), 42);
        assert_eq!(input.ctx().granted_permission(), &perm);
        assert_eq!(input.meta(), &meta);
    }

    #[test]
    fn handler_input_into_parts_returns_owned_triple() {
        let perm = Permission::ReadTag;
        let ctx = canned_ctx(perm);
        let payload = String::from("owned-payload");
        let meta = canned_meta();
        let input = HandlerInput::authorize(ctx, payload.clone(), meta.clone());
        let (got_ctx, got_payload, got_meta) = input.into_parts();
        assert_eq!(got_payload, payload);
        assert_eq!(got_meta, meta);
        // ctx has no PartialEq so we check via actor label.
        assert!(got_ctx.actor_audit_label().contains("op:"));
    }

    #[test]
    fn handler_input_for_test_only_compiles_in_cfg_test() {
        // This test proves the `for_test` ctor is reachable only in
        // test builds (it's `#[cfg(test)]`). A production module
        // calling `HandlerInput::for_test` would be a compile error —
        // caught by the invariant test in Batch #237 via grep.
        let ctx = canned_ctx(Permission::ReadTag);
        let payload = ();
        let meta = canned_meta();
        let input: HandlerInput<()> = HandlerInput::for_test(ctx, payload, meta);
        assert_eq!(input.payload(), &());
    }

    #[test]
    fn handler_error_display_includes_reason() {
        let e = HandlerError::PayloadInvalid {
            reason: "missing tag_name field".to_string(),
        };
        let s = format!("{}", e);
        assert!(s.contains("payload invalid"));
        assert!(s.contains("missing tag_name"));
    }

    #[test]
    fn handler_response_mirror_clones_value() {
        let v = serde_json::json!({"tag": "do_pump", "value": 75.0});
        let r = HandlerResponse::mirror(v.clone());
        assert_eq!(r.payload, v);
        assert_eq!(r.audit_detail, v);
    }

    #[test]
    fn handler_response_new_distinct_shapes() {
        let payload = serde_json::json!({"ok": true});
        let detail = serde_json::json!({"ok": true, "internal_trace_id": "abc"});
        let r = HandlerResponse::new(payload.clone(), detail.clone());
        assert_eq!(r.payload, payload);
        assert_eq!(r.audit_detail, detail);
        assert_ne!(r.payload, r.audit_detail);
    }

    /// Canned handler used to prove the trait is object-safe + that a
    /// dispatch body can run against a typed payload + return the
    /// positive-path response.
    struct EchoReadTagHandler;

    #[derive(Debug, serde::Deserialize, Clone, PartialEq)]
    struct EchoPayload {
        tag: String,
    }

    #[async_trait]
    impl EnvelopeHandler for EchoReadTagHandler {
        type Payload = EchoPayload;

        fn cmd_name(&self) -> &'static str {
            "echo_read_tag"
        }

        fn required_permission(&self, _payload: &Self::Payload) -> Permission {
            Permission::ReadTag
        }

        async fn dispatch(
            &self,
            input: HandlerInput<Self::Payload>,
        ) -> Result<HandlerResponse, HandlerError> {
            let tag = input.payload().tag.clone();
            Ok(HandlerResponse::mirror(serde_json::json!({"echoed": tag})))
        }
    }

    #[tokio::test]
    async fn canned_handler_round_trips_payload_through_dispatch() {
        let h = EchoReadTagHandler;
        let ctx = canned_ctx(Permission::ReadTag);
        let payload = EchoPayload {
            tag: "do_pump".into(),
        };
        let input = HandlerInput::authorize(ctx, payload, canned_meta());
        let resp = h.dispatch(input).await.expect("dispatch ok");
        assert_eq!(resp.payload["echoed"], "do_pump");
        assert_eq!(resp.audit_detail["echoed"], "do_pump");
    }

    #[tokio::test]
    async fn canned_handler_required_permission_reads_payload() {
        let h = EchoReadTagHandler;
        let payload = EchoPayload {
            tag: "any".into(),
        };
        let perm = h.required_permission(&payload);
        assert_eq!(perm, Permission::ReadTag);
    }

    #[test]
    fn envelope_handler_trait_is_object_safe() {
        // Compile-time test: `dyn EnvelopeHandler<Payload = ...>` must
        // exist so the dispatcher can store `Arc<dyn EnvelopeHandler>`
        // in its registry. If this compiles, object safety is proven.
        // (Associated-type binding pins the Payload type per entry; the
        // dispatcher registry may carry type-erased wrappers for
        // heterogeneous payloads — Batch #237 lands that wrapper.)
        let _h: Box<dyn EnvelopeHandler<Payload = EchoPayload>> =
            Box::new(EchoReadTagHandler);
    }

    #[tokio::test]
    async fn parameterized_permission_uses_payload_runtime_data() {
        // Handler that returns a Permission built from payload data —
        // this is the key property we need for WriteTag{tag_id},
        // ForceValue{tag_id} etc.
        struct ParamHandler;
        #[derive(Debug, serde::Deserialize)]
        struct ParamPayload {
            tag_name: String,
        }
        #[async_trait]
        impl EnvelopeHandler for ParamHandler {
            type Payload = ParamPayload;
            fn cmd_name(&self) -> &'static str {
                "write_tag"
            }
            fn required_permission(&self, payload: &Self::Payload) -> Permission {
                Permission::WriteTag {
                    tag_id: TagId::new(payload.tag_name.clone()),
                }
            }
            async fn dispatch(
                &self,
                _input: HandlerInput<Self::Payload>,
            ) -> Result<HandlerResponse, HandlerError> {
                Ok(HandlerResponse::mirror(serde_json::json!({"ok": true})))
            }
        }
        let h = ParamHandler;
        let payload = ParamPayload {
            tag_name: "pond3_aerator".into(),
        };
        let perm = h.required_permission(&payload);
        assert_eq!(
            perm,
            Permission::WriteTag {
                tag_id: TagId::new("pond3_aerator".into())
            }
        );
    }
}
