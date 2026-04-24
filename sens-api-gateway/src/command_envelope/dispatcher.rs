//! CommandDispatcher — Batch #237 Faz 1 (ultra-plan
//! `ULTRA-HIGH-002`, Gap `A-1b` part 1 of the wire).
//!
//! ## Role
//!
//! Owns the per-command registry of [`EnvelopeHandler`] implementations
//! + coordinates the full verify→authorize→dispatch chain such that a
//! handler body cannot run without the authz gate having minted an
//! [`AuthorizedContext`]. Combined with the Batch #236 `HandlerInput<P>`
//! sealed constructor, this closes the ultra-plan A-1 dependency-
//! inversion gap at Tier-1: "forgot to authorize" is a build-time type
//! error + a dispatcher-layer routing invariant, never a runtime review
//! concern.
//!
//! ## Type erasure
//!
//! `EnvelopeHandler::Payload` is an associated type — different
//! handlers have different payload shapes (ForceValuePayload,
//! DeployProgramPayload, ReadTagPayload, …). To store them in a single
//! `HashMap<&'static str, Arc<dyn ...>>` registry we introduce
//! [`BoxedHandler`] with a blanket `impl<H: EnvelopeHandler>`. Inside
//! the blanket impl the concrete `Payload` type is still known — the
//! erasure happens only at the trait-object boundary.
//!
//! ## Authz chain (strict order)
//!
//! Every `run_full` call — invoked exclusively by
//! `CommandDispatcher::run` — executes this sequence:
//!
//! 1. Deserialize `params: Value` → typed `Payload`. Deserialization
//!    error → [`DispatchError::PayloadInvalid`]; no authz call, no
//!    side effects, audit is the caller's concern.
//! 2. `required_permission(&payload)` → `Permission`. Parameterized
//!    permissions (`WriteTag{tag_id}`, `ModbusWrite{device_id,
//!    register_range}`) are materialized from runtime payload data —
//!    this is the core design choice; it also means `required_permission`
//!    MUST be a deterministic pure function of payload (handler-
//!    implementer responsibility).
//! 3. Build `AuthorizationRequest` and call `engine.authorize`.
//!    - `Err(PolicyEngineError)` → [`DispatchError::EngineError`].
//!    - `Ok(Deny(reason))` → [`DispatchError::Denied`].
//!    - `Ok(Allow(ctx))` → continue.
//! 4. Mint `HandlerInput::authorize(ctx, payload, meta)` — this is the
//!    Tier-1 seal; the ctor is `pub(crate)` and called only here.
//! 5. `handler.dispatch(input).await` → positive-path
//!    [`HandlerResponse`] or [`HandlerError`]. The dispatcher wraps
//!    `HandlerError` into [`DispatchError::Handler`] so the caller sees
//!    one unified error taxonomy.
//!
//! Audit emission is the dispatcher CALLER's responsibility (the caller
//! owns the audit sink + knows the envelope jti/nonce for correlation).
//! The dispatcher surfaces enough structured error information that the
//! caller can route each variant into the correct audit outcome:
//! `DispatchError::Denied → AuditOutcome::AuthorizationDenied`,
//! `DispatchError::Handler(SideEffectFailed) → AuditOutcome::Failure`,
//! etc.
//!
//! ## `claimed_policy_version` parameter source
//!
//! The `CommandEnvelope` wire format does NOT carry a
//! `claimed_policy_version` field today (envelope.rs:86 field list).
//! The dispatcher's `run()` therefore takes it as a separate parameter
//! so the caller (boot-path + MQTT subscriber) can source it from:
//! - the signed envelope (preferred, once the envelope schema extends
//!   — see orphan finding below);
//! - a trailing claim attached by the auth-service at signing time;
//! - or, as fallback, `engine.current_policy_version()` which makes the
//!   monotonic check trivially pass (gap in rollback defense; see
//!   orphan finding ORPHAN-MEDIUM-019 — filed in this batch).
//!
//! ## Cross-references
//!
//! - Ultra-plan `#Gap-A-1b` / finding registry `ULTRA-HIGH-002`
//! - Batch #236 `handler.rs` — primitive the dispatcher composes
//! - `authz::policy::PolicyEngine` + `authz::in_memory_engine` (Batch
//!   #223 `InMemoryPolicyEngine`)
//! - `audit::sink::AuditSink` — called by the dispatcher caller, not
//!   the dispatcher itself

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Arc;
use std::time::SystemTime;

use async_trait::async_trait;
use serde_json::Value;

use crate::authz::context::{ActorIdentity, AuthorizationDecision, AuthorizationDenyReason};
use crate::authz::permission::{Permission, TenantId};
use crate::authz::policy::{AuthorizationRequest, PolicyEngine, PolicyEngineError};

use super::envelope::CommandEnvelope;
use super::handler::{EnvelopeHandler, EnvelopeMeta, HandlerError, HandlerInput, HandlerResponse};
use super::jti::Jti;

/// Error taxonomy produced by `CommandDispatcher::run` / `BoxedHandler::
/// run_full`. Each variant maps to a distinct audit outcome at the
/// caller boundary + a distinct MQTT response shape.
#[derive(Debug)]
pub enum DispatchError {
    /// Envelope's `cmd` field did not match any registered handler.
    /// Caller audits under `Permission::ReadTag` (lowest-privilege
    /// probe) and emits `AuditOutcome::Failure`.
    UnknownCommand(String),
    /// Payload failed to deserialize into the handler's `Payload`
    /// type. No authz call was made; no side effects occurred.
    PayloadInvalid(String),
    /// PolicyEngine returned a structured error (ManifestUnavailable,
    /// etc). No handler body ran.
    EngineError(PolicyEngineError),
    /// PolicyEngine returned a Deny with structured reason. No
    /// handler body ran. Caller audits as
    /// `AuditOutcome::AuthorizationDenied`.
    Denied(AuthorizationDenyReason),
    /// Handler body ran and returned `HandlerError`. Side effects may
    /// or may not have occurred depending on the inner variant —
    /// handler contract is to leave state invariant-preserving on
    /// every `Err`.
    Handler(HandlerError),
}

impl std::fmt::Display for DispatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownCommand(cmd) => {
                write!(f, "unknown command: `{}`", cmd)
            }
            Self::PayloadInvalid(reason) => {
                write!(f, "payload invalid: {}", reason)
            }
            Self::EngineError(e) => write!(f, "policy engine error: {:?}", e),
            Self::Denied(reason) => {
                write!(f, "authorization denied: {}", reason)
            }
            Self::Handler(e) => write!(f, "handler: {}", e),
        }
    }
}

impl std::error::Error for DispatchError {}

/// Type-erased wrapper over `EnvelopeHandler`. The blanket impl below
/// provides this automatically for every `H: EnvelopeHandler + 'static`
/// so handler authors implement `EnvelopeHandler` + get `BoxedHandler`
/// for free. The dispatcher stores `Arc<dyn BoxedHandler>` in its
/// registry because `HashMap<_, Arc<dyn EnvelopeHandler<Payload = ???>>>`
/// cannot unify heterogeneous Payload types — the erasure is load-
/// bearing.
#[async_trait]
pub trait BoxedHandler: Send + Sync {
    /// Canonical command name for registry key lookup.
    fn cmd_name(&self) -> &'static str;

    /// Full run: deserialize params + compute permission + authorize +
    /// dispatch. All five steps inside one `async fn` because the
    /// typed `Payload` cannot cross the trait-object boundary — the
    /// generic `H::Payload` stays inside the blanket impl's scope.
    async fn run_full(
        &self,
        params: &Value,
        meta: EnvelopeMeta,
        actor: ActorIdentity,
        tenant: TenantId,
        claimed_policy_version: u64,
        received_at: SystemTime,
        engine: &dyn PolicyEngine,
    ) -> Result<HandlerResponse, DispatchError>;
}

#[async_trait]
impl<H> BoxedHandler for H
where
    H: EnvelopeHandler + 'static,
{
    fn cmd_name(&self) -> &'static str {
        EnvelopeHandler::cmd_name(self)
    }

    async fn run_full(
        &self,
        params: &Value,
        meta: EnvelopeMeta,
        actor: ActorIdentity,
        tenant: TenantId,
        claimed_policy_version: u64,
        received_at: SystemTime,
        engine: &dyn PolicyEngine,
    ) -> Result<HandlerResponse, DispatchError> {
        // Step 1: deserialize.
        let payload: <H as EnvelopeHandler>::Payload =
            serde_json::from_value(params.clone())
                .map_err(|e| DispatchError::PayloadInvalid(e.to_string()))?;

        // Step 2: permission from typed payload.
        let perm = self.required_permission(&payload);

        // Step 3: authorize.
        let req = AuthorizationRequest::new(
            actor,
            perm,
            tenant,
            claimed_policy_version,
            received_at,
        );
        let decision = engine
            .authorize(req)
            .await
            .map_err(DispatchError::EngineError)?;
        let ctx = match decision {
            AuthorizationDecision::Allow(ctx) => ctx,
            AuthorizationDecision::Deny(reason) => {
                return Err(DispatchError::Denied(reason));
            }
        };

        // Step 4: mint HandlerInput (Tier-1 seal point).
        let input = HandlerInput::authorize(ctx, payload, meta);

        // Step 5: handler body.
        self.dispatch(input).await.map_err(DispatchError::Handler)
    }
}

/// Dispatches verified `CommandEnvelope`s to their registered handler
/// after running the authz gate. Owns the handler registry + a shared
/// `PolicyEngine`. Multi-threaded: all fields behind `Arc`, the
/// registry `HashMap` is built once at boot (per device lifetime) and
/// read-only thereafter.
pub struct CommandDispatcher {
    handlers: HashMap<&'static str, Arc<dyn BoxedHandler>>,
    engine: Arc<dyn PolicyEngine>,
    tenant: TenantId,
}

impl CommandDispatcher {
    /// Build an empty dispatcher bound to the given `engine` + tenant.
    /// Handlers are added via `register`.
    pub fn new(engine: Arc<dyn PolicyEngine>, tenant: TenantId) -> Self {
        Self {
            handlers: HashMap::new(),
            engine,
            tenant,
        }
    }

    /// Register one handler. Duplicate `cmd_name` panics at register
    /// time — handler registry is built once at boot, so a duplicate
    /// is always a bug (two handlers claiming the same command). The
    /// panic at boot is the correct failure mode; silent overwrite
    /// would hide the duplicate bug until runtime surprise.
    pub fn register<H: EnvelopeHandler + 'static>(&mut self, handler: H) {
        let name = handler.cmd_name();
        if self.handlers.contains_key(name) {
            panic!(
                "CommandDispatcher::register: duplicate handler for `{}` — two handlers claim the same command",
                name
            );
        }
        self.handlers.insert(name, Arc::new(handler));
    }

    /// Register handler via `Arc` (for callers who already have it
    /// boxed — e.g. test harnesses sharing handler instances).
    pub fn register_arc(&mut self, handler: Arc<dyn BoxedHandler>) {
        let name = handler.cmd_name();
        if self.handlers.contains_key(name) {
            panic!(
                "CommandDispatcher::register_arc: duplicate handler for `{}`",
                name
            );
        }
        self.handlers.insert(name, handler);
    }

    /// Number of registered handlers (diagnostic + boot-log).
    pub fn len(&self) -> usize {
        self.handlers.len()
    }

    /// True when no handlers registered (dev-mode config; boot-time
    /// sanity check — production systems should fail to boot if the
    /// dispatcher is empty).
    pub fn is_empty(&self) -> bool {
        self.handlers.is_empty()
    }

    /// Check whether a command name has a registered handler. Caller-
    /// side early-rejection path; `run` also surfaces this as
    /// `DispatchError::UnknownCommand`.
    pub fn has_handler(&self, cmd: &str) -> bool {
        self.handlers.contains_key(cmd)
    }

    /// Iterate registered command names in insertion-independent
    /// order. Useful for boot-log diagnostics + invariant test that
    /// asserts registry coverage.
    pub fn cmd_names(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.handlers.keys().copied()
    }

    /// Main dispatch entry point. Runs the verify→authorize→dispatch
    /// chain against a verified [`CommandEnvelope`] + resolved
    /// [`ActorIdentity`]. Returns the handler's [`HandlerResponse`]
    /// or a structured [`DispatchError`] the caller maps into audit +
    /// MQTT response.
    ///
    /// Parameters:
    /// - `env` — already passed `verify_envelope` (signature OK, jti
    ///   dedup OK, freshness OK, tenant matches). This function does
    ///   NOT re-run those gates.
    /// - `jti` — validated JTI from envelope.
    /// - `actor` — resolved from `env.actor` (UUID → RBAC manifest
    ///   operator_id lookup); caller owns the resolver.
    /// - `claimed_policy_version` — see module doc. Today the caller
    ///   passes `engine.current_policy_version()` because the wire
    ///   format lacks a claim field; ORPHAN-MEDIUM-019 tracks the
    ///   envelope extension.
    /// - `received_at` — monotonic-safe clock read at envelope
    ///   ingress (pre-dispatch).
    pub async fn run(
        &self,
        env: &CommandEnvelope,
        jti: Jti,
        actor: ActorIdentity,
        claimed_policy_version: u64,
        received_at: SystemTime,
    ) -> Result<HandlerResponse, DispatchError> {
        let handler = self
            .handlers
            .get(env.cmd.as_str())
            .ok_or_else(|| DispatchError::UnknownCommand(env.cmd.clone()))?;
        let meta = EnvelopeMeta::from_verified(env, jti);
        handler
            .run_full(
                &env.params,
                meta,
                actor,
                self.tenant.clone(),
                claimed_policy_version,
                received_at,
                &*self.engine,
            )
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::context::{
        ActorIdentity, AuthorizationDecision, AuthorizationDenyReason, AuthorizedContext,
    };
    use crate::authz::permission::{OperatorId, TagId};
    use std::sync::Mutex;
    use std::time::{Duration, UNIX_EPOCH};

    fn canned_tenant() -> TenantId {
        TenantId::new_from_verified([0x42u8; 16])
    }

    fn canned_actor() -> ActorIdentity {
        ActorIdentity::Operator(OperatorId::new_from_verified([0x07u8; 16]))
    }

    fn canned_envelope(cmd: &str, params: Value) -> CommandEnvelope {
        use crate::command_envelope::canonical::CmdHash;
        CommandEnvelope {
            cmd: cmd.to_string(),
            params,
            actor: [0x07u8; 16],
            tenant_id: [0x42u8; 16],
            iat_unix_secs: 1_700_000_000,
            exp_unix_secs: 1_700_001_000,
            jti: "01HZAAAAAAAAAAAAAAAAAAAAAA".to_string(),
            nonce: "test-nonce".to_string(),
            cmd_hash: CmdHash::from_bytes([0u8; 32]),
            signature: None,
        }
    }

    /// Canned PolicyEngine that returns a scripted decision + counts
    /// how many times it was called. Used to prove the authz chain
    /// order.
    struct ScriptedEngine {
        decision: Mutex<Option<Result<AuthorizationDecision, PolicyEngineError>>>,
        call_count: Mutex<u32>,
        version: u64,
    }

    impl ScriptedEngine {
        fn new(d: Result<AuthorizationDecision, PolicyEngineError>) -> Self {
            Self {
                decision: Mutex::new(Some(d)),
                call_count: Mutex::new(0),
                version: 10,
            }
        }
        fn call_count(&self) -> u32 {
            *self.call_count.lock().unwrap()
        }
    }

    #[async_trait]
    impl PolicyEngine for ScriptedEngine {
        async fn authorize(
            &self,
            _req: AuthorizationRequest,
        ) -> Result<AuthorizationDecision, PolicyEngineError> {
            *self.call_count.lock().unwrap() += 1;
            self.decision
                .lock()
                .unwrap()
                .take()
                .unwrap_or(Ok(AuthorizationDecision::Deny(
                    AuthorizationDenyReason::PermissionNotGranted,
                )))
        }
        fn current_policy_version(&self) -> u64 {
            self.version
        }
        async fn reload_manifest(&self) -> Result<u64, PolicyEngineError> {
            Ok(self.version)
        }
    }

    fn allow_ctx() -> AuthorizationDecision {
        AuthorizationDecision::Allow(AuthorizedContext::new_from_verified(
            canned_actor(),
            Permission::ReadTag,
            canned_tenant(),
            10,
            false,
            UNIX_EPOCH + Duration::from_secs(1_700_000_000),
        ))
    }

    /// Canned handler. `call_count` proves the handler body ran (or
    /// did not) under various authz outcomes.
    struct CountingReadTag {
        call_count: Arc<Mutex<u32>>,
    }
    impl CountingReadTag {
        fn new() -> (Self, Arc<Mutex<u32>>) {
            let c = Arc::new(Mutex::new(0));
            (
                Self {
                    call_count: c.clone(),
                },
                c,
            )
        }
    }
    #[derive(Debug, serde::Deserialize)]
    struct ReadPayload {
        tag: String,
    }
    #[async_trait]
    impl EnvelopeHandler for CountingReadTag {
        type Payload = ReadPayload;
        fn cmd_name(&self) -> &'static str {
            "read_tag"
        }
        fn required_permission(&self, _p: &Self::Payload) -> Permission {
            Permission::ReadTag
        }
        async fn dispatch(
            &self,
            input: HandlerInput<Self::Payload>,
        ) -> Result<HandlerResponse, HandlerError> {
            *self.call_count.lock().unwrap() += 1;
            let tag = input.payload().tag.clone();
            Ok(HandlerResponse::mirror(serde_json::json!({"tag": tag})))
        }
    }

    #[tokio::test]
    async fn register_len_has_handler() {
        let engine = Arc::new(ScriptedEngine::new(Ok(allow_ctx())));
        let mut d = CommandDispatcher::new(engine, canned_tenant());
        let (h, _) = CountingReadTag::new();
        d.register(h);
        assert_eq!(d.len(), 1);
        assert!(d.has_handler("read_tag"));
        assert!(!d.has_handler("no_such_cmd"));
        assert!(!d.is_empty());
        let names: Vec<_> = d.cmd_names().collect();
        assert_eq!(names, vec!["read_tag"]);
    }

    #[tokio::test]
    async fn run_unknown_command_returns_unknown_command() {
        let engine = Arc::new(ScriptedEngine::new(Ok(allow_ctx())));
        let d = CommandDispatcher::new(engine.clone(), canned_tenant());
        let env = canned_envelope("ghost_cmd", serde_json::json!({}));
        let jti = Jti::try_new(env.jti.clone()).unwrap();
        let result = d
            .run(&env, jti, canned_actor(), 10, UNIX_EPOCH)
            .await;
        match result {
            Err(DispatchError::UnknownCommand(cmd)) => {
                assert_eq!(cmd, "ghost_cmd");
            }
            other => panic!("expected UnknownCommand, got {:?}", other),
        }
        assert_eq!(engine.call_count(), 0, "engine MUST NOT be called");
    }

    #[tokio::test]
    async fn run_payload_invalid_skips_engine_and_handler() {
        let engine = Arc::new(ScriptedEngine::new(Ok(allow_ctx())));
        let mut d = CommandDispatcher::new(engine.clone(), canned_tenant());
        let (h, hc) = CountingReadTag::new();
        d.register(h);
        // `tag` field missing — ReadPayload deserialize fails.
        let env = canned_envelope("read_tag", serde_json::json!({"typo": "x"}));
        let jti = Jti::try_new(env.jti.clone()).unwrap();
        let result = d
            .run(&env, jti, canned_actor(), 10, UNIX_EPOCH)
            .await;
        match result {
            Err(DispatchError::PayloadInvalid(_)) => {}
            other => panic!("expected PayloadInvalid, got {:?}", other),
        }
        assert_eq!(engine.call_count(), 0, "engine MUST NOT see invalid payload");
        assert_eq!(*hc.lock().unwrap(), 0, "handler MUST NOT run");
    }

    #[tokio::test]
    async fn run_engine_deny_blocks_handler() {
        let engine = Arc::new(ScriptedEngine::new(Ok(
            AuthorizationDecision::Deny(AuthorizationDenyReason::PermissionNotGranted),
        )));
        let mut d = CommandDispatcher::new(engine.clone(), canned_tenant());
        let (h, hc) = CountingReadTag::new();
        d.register(h);
        let env = canned_envelope("read_tag", serde_json::json!({"tag": "do_pump"}));
        let jti = Jti::try_new(env.jti.clone()).unwrap();
        let result = d
            .run(&env, jti, canned_actor(), 10, UNIX_EPOCH)
            .await;
        match result {
            Err(DispatchError::Denied(AuthorizationDenyReason::PermissionNotGranted)) => {}
            other => panic!("expected Denied(PermissionNotGranted), got {:?}", other),
        }
        assert_eq!(engine.call_count(), 1);
        assert_eq!(*hc.lock().unwrap(), 0, "handler MUST NOT run on deny");
    }

    #[tokio::test]
    async fn run_engine_error_blocks_handler() {
        let engine = Arc::new(ScriptedEngine::new(Err(
            PolicyEngineError::ManifestUnavailable,
        )));
        let mut d = CommandDispatcher::new(engine.clone(), canned_tenant());
        let (h, hc) = CountingReadTag::new();
        d.register(h);
        let env = canned_envelope("read_tag", serde_json::json!({"tag": "do_pump"}));
        let jti = Jti::try_new(env.jti.clone()).unwrap();
        let result = d
            .run(&env, jti, canned_actor(), 10, UNIX_EPOCH)
            .await;
        match result {
            Err(DispatchError::EngineError(PolicyEngineError::ManifestUnavailable)) => {}
            other => panic!("expected EngineError, got {:?}", other),
        }
        assert_eq!(engine.call_count(), 1);
        assert_eq!(*hc.lock().unwrap(), 0, "handler MUST NOT run on engine err");
    }

    #[tokio::test]
    async fn run_allow_reaches_handler_and_returns_response() {
        let engine = Arc::new(ScriptedEngine::new(Ok(allow_ctx())));
        let mut d = CommandDispatcher::new(engine.clone(), canned_tenant());
        let (h, hc) = CountingReadTag::new();
        d.register(h);
        let env = canned_envelope("read_tag", serde_json::json!({"tag": "do_pump"}));
        let jti = Jti::try_new(env.jti.clone()).unwrap();
        let resp = d
            .run(&env, jti, canned_actor(), 10, UNIX_EPOCH)
            .await
            .expect("allow path");
        assert_eq!(resp.payload["tag"], "do_pump");
        assert_eq!(engine.call_count(), 1);
        assert_eq!(*hc.lock().unwrap(), 1, "handler ran exactly once");
    }

    #[tokio::test]
    async fn parameterized_permission_threads_payload_data_to_engine_request() {
        // Handler that returns WriteTag{tag_id} from payload so we can
        // observe the Permission the engine received.
        struct CaptureWriteTag {
            captured: Arc<Mutex<Option<Permission>>>,
        }
        #[derive(Debug, serde::Deserialize)]
        struct WritePayload {
            tag: String,
        }
        #[async_trait]
        impl EnvelopeHandler for CaptureWriteTag {
            type Payload = WritePayload;
            fn cmd_name(&self) -> &'static str {
                "write_tag"
            }
            fn required_permission(&self, p: &Self::Payload) -> Permission {
                let perm = Permission::WriteTag {
                    tag_id: TagId::new(p.tag.clone()),
                };
                *self.captured.lock().unwrap() = Some(perm.clone());
                perm
            }
            async fn dispatch(
                &self,
                _input: HandlerInput<Self::Payload>,
            ) -> Result<HandlerResponse, HandlerError> {
                Ok(HandlerResponse::mirror(serde_json::json!({})))
            }
        }
        let captured: Arc<Mutex<Option<Permission>>> = Arc::new(Mutex::new(None));
        let h = CaptureWriteTag {
            captured: captured.clone(),
        };
        let engine = Arc::new(ScriptedEngine::new(Ok(allow_ctx())));
        let mut d = CommandDispatcher::new(engine, canned_tenant());
        d.register(h);
        let env = canned_envelope("write_tag", serde_json::json!({"tag": "pond3_aerator"}));
        let jti = Jti::try_new(env.jti.clone()).unwrap();
        let _ = d
            .run(&env, jti, canned_actor(), 10, UNIX_EPOCH)
            .await
            .unwrap();
        let perm = captured.lock().unwrap().clone().unwrap();
        assert_eq!(
            perm,
            Permission::WriteTag {
                tag_id: TagId::new("pond3_aerator".into())
            }
        );
    }

    #[tokio::test]
    async fn handler_side_effect_error_surfaces_as_dispatch_error_handler() {
        struct AlwaysFail;
        #[derive(Debug, serde::Deserialize)]
        struct Payload {
            _tag: String,
        }
        #[async_trait]
        impl EnvelopeHandler for AlwaysFail {
            type Payload = Payload;
            fn cmd_name(&self) -> &'static str {
                "always_fail"
            }
            fn required_permission(&self, _: &Self::Payload) -> Permission {
                Permission::ReadTag
            }
            async fn dispatch(
                &self,
                _input: HandlerInput<Self::Payload>,
            ) -> Result<HandlerResponse, HandlerError> {
                Err(HandlerError::SideEffectFailed {
                    reason: "mock modbus timeout".to_string(),
                })
            }
        }
        let engine = Arc::new(ScriptedEngine::new(Ok(allow_ctx())));
        let mut d = CommandDispatcher::new(engine, canned_tenant());
        d.register(AlwaysFail);
        let env = canned_envelope("always_fail", serde_json::json!({"_tag": "x"}));
        let jti = Jti::try_new(env.jti.clone()).unwrap();
        let result = d
            .run(&env, jti, canned_actor(), 10, UNIX_EPOCH)
            .await;
        match result {
            Err(DispatchError::Handler(HandlerError::SideEffectFailed { reason })) => {
                assert_eq!(reason, "mock modbus timeout");
            }
            other => panic!("expected Handler(SideEffectFailed), got {:?}", other),
        }
    }

    #[test]
    #[should_panic(expected = "duplicate handler")]
    fn register_duplicate_cmd_name_panics() {
        let engine = Arc::new(ScriptedEngine::new(Ok(allow_ctx())));
        let mut d = CommandDispatcher::new(engine, canned_tenant());
        let (h1, _) = CountingReadTag::new();
        let (h2, _) = CountingReadTag::new();
        d.register(h1);
        d.register(h2); // panics
    }

    #[tokio::test]
    async fn dispatch_error_display_includes_reason() {
        let err = DispatchError::PayloadInvalid("missing field `tag`".to_string());
        let s = format!("{}", err);
        assert!(s.contains("payload invalid"));
        assert!(s.contains("missing field"));
    }
}
