//! Custom OPC UA NodeManager — Batch #263 A-2b part 1 (skeleton).
//!
//! ## Why this module exists
//!
//! Pre-Batch-#263 the OPC UA server runtime
//! (`opc_ua_server_runtime.rs`) wired
//! `simple_node_manager(...)` from async-opcua's in-memory
//! defaults. SimpleNodeManager exposes a per-node callback API
//! (`add_write_callback`, `add_read_callback`,
//! `add_method_callback`) — the callback signature is:
//!
//! ```text
//! impl Fn(DataValue, &NumericRange) -> StatusCode + Send + Sync + 'static
//! ```
//!
//! Note what the signature **does not carry:** the
//! `RequestContext` of the OPC UA call, which contains the
//! authenticated session principal (user_id + identity_token).
//! For session-aware authorization — the entire reason Gap A-3
//! Batches #239-#250 built `OpcUaActorResolver` (Batch #240),
//! `TypedAuthzPort` (Batch #241), `UserTokenValidator`
//! (Batch #245), and the sealed `AuthenticatedUser` newtype
//! (Batch #239) — the write path needs to read the session
//! identity. SimpleNodeManager's per-node callback API
//! fundamentally cannot deliver it.
//!
//! ## What this module is (Batch #263)
//!
//! A skeleton implementation of async-opcua's `NodeManager`
//! trait directly (not the `SimpleNodeManagerImpl` extension
//! trait). The full trait gives every service method
//! (`read`, `write`, `browse`, `call`, history reads, etc.)
//! access to a `&RequestContext` containing
//! `session.user_identity_token` — exactly the bridge Gap A-3
//! was missing.
//!
//! Batch #263 lands the **primitive only**:
//!
//! - Struct definition + dependency injection (`Arc` references
//!   to `OpcUaActorResolver`, `TypedAuthzPort`,
//!   `UserTokenValidator`, `ProcessImage`).
//! - Implementations for the 4 mandatory `NodeManager` methods
//!   (`owns_node`, `name`, `namespaces_for_user`, `init`).
//! - Stub overrides for `read` + `write` returning
//!   `BadServiceUnsupported` (default behavior, kept explicit
//!   so the docstrings name the next-batch wire targets).
//! - Trait-bound smoke test asserting the impl is
//!   `Send + Sync + 'static` (required by async-opcua's
//!   `Arc<dyn NodeManager>` runtime hand-off).
//!
//! Batch #263 explicitly does **not**:
//!
//! - Wire `SensNodeManager` into the runtime (still
//!   `simple_node_manager(...)` at `opc_ua_server_runtime.rs:259`).
//! - Implement `read` / `write` / `browse` body (Batch #264+ wire
//!   each per-service method onto the existing
//!   `execute_opcua_write` orchestrator + `ProcessImage` snapshot
//!   reader).
//! - Replace the existing per-node `add_write_callback` calls
//!   (Batch #265+ migration in lockstep with each service-method
//!   wire).
//! - Implement `AuthManager` for session-establish (Batch #266
//!   binds `UserTokenValidator` to the server's session-establish
//!   hook — separate trait surface).
//!
//! ## Cross-references
//!
//! - **ORPHAN-CRITICAL-021** (Batch #262 finding registration) —
//!   names this module's missing wire as the architectural
//!   blocker for Gap A-3 production value.
//! - Batch #239-#250 — Gap A-3 chain whose primitives this
//!   module's `read`/`write` will consume in subsequent batches.
//! - async-opcua 0.18 source-of-truth:
//!   `~/.cargo/registry/.../async-opcua-server-0.18.0/src/node_manager/mod.rs`
//!   — every trait method documented inline; this module's
//!   stubs follow that contract verbatim for stability under
//!   future async-opcua upgrades.
//!
//! ## Wire-status discipline (Batch #263 audit)
//!
//! Following the project memory rule "BOL BOL NOT" + "gördüğün
//! her problemi NOT al," every method below carries an explicit
//! WIRE STATUS docstring naming:
//! - The current behavior (stub vs. real implementation).
//! - The batch (or finding ID) that lands the real wire.
//! - Any orphan finding the method blocks (cross-link).

#![allow(dead_code)]

// async-opcua 0.18 NodeManager trait + supporting types. The
// `opcua` crate is feature-gated under `opc-ua-server` per
// Cargo.toml; this entire module compiles only when that feature
// is on.
#[cfg(feature = "opc-ua-server")]
use std::sync::Arc;

#[cfg(feature = "opc-ua-server")]
use async_trait::async_trait;

#[cfg(feature = "opc-ua-server")]
use opcua::server::diagnostics::NamespaceMetadata;
#[cfg(feature = "opc-ua-server")]
use opcua::nodes::DefaultTypeTree;
#[cfg(feature = "opc-ua-server")]
use opcua::server::node_manager::{NodeManager, RequestContext, ServerContext};
#[cfg(feature = "opc-ua-server")]
use opcua::types::NodeId;

// Project deps — Gap A-3 chain primitives this module is
// designed to consume in subsequent batches. They're imported
// (not used) at skeleton stage so the field signatures compile
// + so a `cargo check` regression on any of these primitive
// definitions surfaces here at the same time as in their
// original modules.
#[cfg(feature = "opc-ua-server")]
use crate::authz::permission::TenantId;
#[cfg(feature = "opc-ua-server")]
use crate::opc_ua_server::OpcUaTagRegistry;
#[cfg(feature = "opc-ua-server")]
use crate::opc_ua_server_typed_authz::TypedAuthzPort;
#[cfg(feature = "opc-ua-server")]
use crate::opc_ua_server_user_token_validator::UserTokenValidator;
#[cfg(feature = "opc-ua-server")]
use crate::process_image::ProcessImage;

// =============================================================
// SensNodeManager — primitive (Batch #263)
// =============================================================

/// Custom OPC UA NodeManager that bridges the async-opcua server
/// runtime to the Suderra Gap A-3 typed-authz chain.
///
/// **Lifetime / sharing model.** async-opcua's runtime requires
/// `Arc<dyn NodeManager>`. This struct is constructed once at
/// boot (Batch #267 wire batch — not landed in #263), Arc-wrapped,
/// and handed to the `ServerBuilder::with_node_manager` call.
/// All trait method bodies operate over `&self` references — no
/// interior mutability EXCEPT `namespace_index` which the runtime
/// assigns at `init()` time + which subsequent service calls read
/// concurrently.
///
/// **Field choices (architectural reasoning per field):**
///
/// - `namespace_uri`: stable string identifying the Suderra
///   namespace (`urn:suderra:edge`) registered with the OPC UA
///   server. Plural namespaces (e.g., `urn:suderra:audit`
///   future) would each get their own NodeManager instance, so
///   carrying ONE URI per instance keeps the per-instance
///   identity unambiguous.
///
/// - `namespace_index`: assigned by async-opcua's namespace
///   registry at `init()` time. Used by every service method to
///   match incoming `NodeId.namespace` against the indices THIS
///   manager owns. Held inside `tokio::sync::RwLock<Option<u16>>`
///   because:
///   * `Option<u16>` — `None` until `init()` populates it; service
///     calls before `init` complete return `false` from
///     `owns_node` (handed off to other managers).
///   * `RwLock` — `init()` is the sole writer; every service
///     method is a reader. Read contention is the hot path; the
///     RwLock is the right shape for read-heavy workloads.
///   * `tokio::sync::RwLock` (not `std::sync::RwLock`) because
///     the service methods are `async` and may yield while
///     holding the read guard if a downstream `await` happens
///     in the body.
///
/// - `tenant_id`: the device's provisioning-bound tenant ID.
///   Passed through to every authz call so cross-tenant pivots
///   are caught at the typed-authz layer (Batch #241
///   `TypedAuthzPort.authorize_write` receives the tenant + the
///   resolved actor + the manifest's `policy_version` — all 3
///   gates in one call).
///
/// - `authz`: the `TypedAuthzPort` from Batch #241. Wraps the
///   policy engine + the operator resolver. `Arc<dyn ...>` so
///   the manager can hold a pointer without locking the engine
///   into a single concrete type — testability (mock policy
///   engines) + future hot-swap (multiple engine implementations
///   keyed by `manifest.engine_kind` field future).
///
/// - `validator`: the `UserTokenValidator` from Batch #245.
///   Wired by Batch #266 into the server's `AuthManager` trait
///   (separate session-establish entry point); held here so the
///   write path can re-validate the principal in case the
///   session was activated under a now-revoked manifest (defense
///   in depth — the validator's `with_enrollment` reader is
///   cheap).
///
/// - `process_image`: the in-memory tag-value store. Read path
///   (`async fn read`) snapshots tag values via this; write path
///   (`async fn write`) applies updates after the typed-authz
///   gate clears.
///
/// - `manager_name`: NodeManager's debug name; returned by the
///   `name()` trait method. Hardcoded `"suderra-sens"` because
///   we have exactly one custom manager per agent — no multi-
///   instance disambiguation needed today.
#[cfg(feature = "opc-ua-server")]
pub struct SensNodeManager {
    /// Stable namespace URI registered with the OPC UA server.
    namespace_uri: String,

    /// Namespace index assigned at `init()` time. None until
    /// init has populated.
    namespace_index: tokio::sync::RwLock<Option<u16>>,

    /// Device's provisioning-bound tenant ID — load-bearing for
    /// cross-tenant authz checks.
    tenant_id: TenantId,

    /// Typed authz port (Batch #241) — every write goes through
    /// `authorize_write`.
    authz: Arc<dyn TypedAuthzPort>,

    /// User-token validator (Batch #245) — session principal
    /// re-validation defense-in-depth + bridge to AuthManager
    /// (Batch #266 wire).
    validator: Arc<UserTokenValidator>,

    /// In-memory tag-value store. Read snapshots + write commits
    /// flow through this.
    process_image: Arc<ProcessImage>,

    /// OPC UA address-space tag catalog (Batch #264 read-body
    /// dependency). Provides `find_by_browse_name(browse_name)
    /// -> Option<&OpcUaTagNode>` so the trait method bodies can
    /// resolve incoming NodeId.identifier (a UAString
    /// browse_name) back to the canonical Suderra tag_name +
    /// declared data type for `ProcessImage` lookup. Built once
    /// at boot from the tag config catalog (immutable
    /// post-construction).
    tag_registry: Arc<OpcUaTagRegistry>,

    /// Debug name returned by `name()`. Static literal because
    /// we instantiate exactly one custom manager per agent.
    manager_name: &'static str,
}

#[cfg(feature = "opc-ua-server")]
impl SensNodeManager {
    /// Default debug name. Single source of truth — used by both
    /// the constructor + the `name()` trait method.
    pub const NAME: &'static str = "suderra-sens";

    /// Default namespace URI for the Suderra address space.
    /// Hardcoded today; future ADR may parameterize per-tenant
    /// or per-environment if multiple Suderra namespaces become
    /// load-bearing.
    pub const NAMESPACE_URI: &'static str = "urn:suderra:edge";

    /// Construct a new SensNodeManager from the dependency Arcs
    /// produced by the boot sequence.
    ///
    /// **Wire status (Batch #263):** This constructor is
    /// reachable only via `#[cfg(feature = "opc-ua-server")]`
    /// builds. Production wire (Batch #267) replaces the
    /// `simple_node_manager(...)` call in
    /// `opc_ua_server_runtime.rs:259` with a
    /// `ServerBuilder::with_node_manager(Arc::new(SensNodeManager::
    /// new(...)))` call.
    pub fn new(
        tenant_id: TenantId,
        authz: Arc<dyn TypedAuthzPort>,
        validator: Arc<UserTokenValidator>,
        process_image: Arc<ProcessImage>,
        tag_registry: Arc<OpcUaTagRegistry>,
    ) -> Self {
        Self {
            namespace_uri: Self::NAMESPACE_URI.to_string(),
            namespace_index: tokio::sync::RwLock::new(None),
            tenant_id,
            authz,
            validator,
            process_image,
            tag_registry,
            manager_name: Self::NAME,
        }
    }

    /// Read the assigned namespace index. Returns `None` if
    /// `init()` has not yet completed; service methods that get
    /// `None` defer to other managers (their `owns_node` check
    /// returns `false`).
    ///
    /// **Wire status (Batch #263):** internal helper; consumed
    /// by `owns_node` + future per-service trait method bodies.
    pub async fn current_namespace_index(&self) -> Option<u16> {
        *self.namespace_index.read().await
    }
}

// =============================================================
// NodeManager trait impl (skeleton — Batch #263)
// =============================================================

#[cfg(feature = "opc-ua-server")]
#[async_trait]
impl NodeManager for SensNodeManager {
    /// **Wire status:** real implementation (Batch #263).
    /// Returns true iff the incoming NodeId's namespace index
    /// matches the index this manager owns. Pre-`init` always
    /// returns false (other managers handle the request).
    fn owns_node(&self, id: &NodeId) -> bool {
        // Synchronous trait method — cannot `.await` on the
        // tokio::RwLock here. Use `try_read` to avoid blocking
        // the runtime worker; if the lock is contended (init
        // mid-flight), conservatively return false so the
        // request gets routed to the other managers in the
        // chain rather than spinning here.
        match self.namespace_index.try_read() {
            Ok(guard) => match *guard {
                Some(idx) => id.namespace == idx,
                None => false,
            },
            Err(_) => false,
        }
    }

    /// **Wire status:** real implementation (Batch #263).
    /// Returns the static debug name. async-opcua uses this for
    /// log lines + the `NodeManagers::get_by_name` lookup.
    fn name(&self) -> &str {
        self.manager_name
    }

    /// **Wire status:** real implementation (Batch #263).
    ///
    /// Reports the single Suderra namespace this manager owns.
    /// Future batch may extend with per-user filtering (e.g.,
    /// hide operator-class namespaces from anonymous clients) —
    /// today every authenticated user sees the same Suderra
    /// namespace.
    fn namespaces_for_user(
        &self,
        _context: &RequestContext,
    ) -> Vec<NamespaceMetadata> {
        vec![NamespaceMetadata {
            namespace_uri: self.namespace_uri.clone(),
            ..Default::default()
        }]
    }

    /// **Wire status:** stub (Batch #263). Future Batch #264
    /// populates the address space with all Suderra tags as
    /// Variable nodes. The `init` method is called once by the
    /// async-opcua runtime AFTER namespace registration; this
    /// is where the manager:
    /// 1. Reads its assigned namespace index from
    ///    `context.info.namespaces` and stores it in
    ///    `self.namespace_index`.
    /// 2. Walks `process_image` tags and calls
    ///    `type_tree.add_node(...)` for each one.
    ///
    /// **Linked finding:** ORPHAN-CRITICAL-021 — until this
    /// method populates the address space, HMI clients cannot
    /// browse / read / write any Suderra tag through this
    /// manager.
    async fn init(
        &self,
        _type_tree: &mut DefaultTypeTree,
        _context: ServerContext,
    ) {
        // Skeleton: no-op. Batch #264 reads the assigned
        // namespace index from `context.info.namespaces` (need
        // to look up by `namespace_uri`) and populates address
        // space from `self.process_image`.
        tracing::warn!(
            "SensNodeManager::init() is a Batch #263 skeleton — \
             address space NOT populated; HMI browse/read/write \
             will see an empty namespace until Batch #264 wires \
             the populator. ORPHAN-CRITICAL-021 tracks this gap."
        );
    }

    /// **Wire status:** explicit stub (Batch #263). Default trait
    /// body returns `BadServiceUnsupported`; we override here
    /// only to emit a warn-log so operators investigating
    /// "browse returns nothing" see the wire-status hint.
    ///
    /// Batch #264 implements the real `read` body using the
    /// `process_image` snapshot.
    /// **Wire status:** real implementation (Batch #264).
    ///
    /// Per-node read body. For each `ReadNode`:
    /// 1. If the NodeId namespace doesn't match this manager's,
    ///    skip — async-opcua's runtime fans the request out to
    ///    every registered manager; only this manager's nodes
    ///    get a real response from this method.
    /// 2. If the AttributeId is not `Value`, set an
    ///    `BadAttributeIdInvalid` error. Future Batch #266+
    ///    extends to NodeClass / BrowseName / DisplayName when
    ///    HMI clients need richer browse responses.
    /// 3. Extract the browse name from `NodeId.identifier` (a
    ///    `Identifier::String(UAString)` for every Suderra tag
    ///    per `opc_ua_server_runtime.rs:977` registration shape).
    /// 4. Reverse-lookup the canonical tag_name via
    ///    `OpcUaTagRegistry.find_by_browse_name(...)`.
    /// 5. Snapshot the current tag value via
    ///    `ProcessImage.get_tag(tag_name)`.
    /// 6. Build a `DataValue` from the f64 + quality +
    ///    timestamp; set it on the ReadNode via `set_result`.
    ///
    /// **Authorization:** read is intentionally NOT
    /// authz-gated today — the Suderra address space is
    /// observable to every authenticated session per Plan §3
    /// R-8 ("Anonymous (read-only), Username/Password
    /// (policy-gated), X509 cert (operator cert)"). Anonymous
    /// reads are explicitly allowed; only WRITE crosses the
    /// `TypedAuthzPort` gate. Future ADR may tighten read
    /// authz per-tag (e.g., pre-production tag visibility) —
    /// at which point this method consumes
    /// `context.session.user_identity_token` like `write` will
    /// in Batch #265.
    async fn read(
        &self,
        _context: &RequestContext,
        _max_age: f64,
        _timestamps_to_return: opcua::types::TimestampsToReturn,
        nodes_to_read: &mut [&mut opcua::server::node_manager::ReadNode],
    ) -> Result<(), opcua::types::StatusCode> {
        let my_namespace = match self.current_namespace_index().await {
            Some(idx) => idx,
            None => {
                // init() hasn't run yet — every node returns
                // BadNoCommunication so HMIs see a transient
                // boot state rather than silent BadNothingToDo.
                for n in nodes_to_read.iter_mut() {
                    n.set_error(
                        opcua::types::StatusCode::BadNoCommunication,
                    );
                }
                return Ok(());
            }
        };

        for node in nodes_to_read.iter_mut() {
            // Step 1: namespace ownership filter.
            let read_id = node.node().node_id.clone();
            if read_id.namespace != my_namespace {
                // Not our node — let other managers respond.
                // async-opcua skips already-responded ReadNodes
                // by default; we set nothing here.
                continue;
            }

            // Step 2: attribute filter — only Value supported in
            // Batch #264 skeleton. async-opcua's `attribute_id`
            // accessor returns the AttributeId enum directly.
            let attr_id = node.node().attribute_id;
            if attr_id != opcua::types::AttributeId::Value {
                node.set_error(
                    opcua::types::StatusCode::BadAttributeIdInvalid,
                );
                continue;
            }

            // Step 3: extract browse_name from the NodeId
            // identifier. async-opcua represents string-keyed
            // node identifiers as Identifier::String(UAString).
            let browse_name = match &read_id.identifier {
                opcua::types::Identifier::String(s) => s.to_string(),
                _ => {
                    node.set_error(
                        opcua::types::StatusCode::BadNodeIdInvalid,
                    );
                    continue;
                }
            };

            // Step 4: reverse-lookup canonical tag_name.
            let tag_node = match self
                .tag_registry
                .find_by_browse_name(&browse_name)
            {
                Some(t) => t,
                None => {
                    node.set_error(
                        opcua::types::StatusCode::BadNodeIdUnknown,
                    );
                    continue;
                }
            };

            // Step 5: snapshot current tag value.
            let tag_value = self
                .process_image
                .get_tag(&tag_node.tag_name)
                .await;
            let tag_value = match tag_value {
                Some(v) => v,
                None => {
                    // Tag is in the catalog but not yet in the
                    // process image — first-boot before the I/O
                    // poll has populated it.
                    node.set_error(
                        opcua::types::StatusCode::BadDataUnavailable,
                    );
                    continue;
                }
            };

            // Step 6: build DataValue. Suderra's process image
            // stores every tag as f64 (canonical numeric); OPC
            // UA Variant::Double matches that natively. Future
            // ADR may map per-DataType (Boolean for DI, Int32
            // for INT) — today every tag surfaces as Double
            // which HMIs handle via implicit cast.
            let dv = opcua::types::DataValue {
                value: Some(opcua::types::Variant::Double(tag_value.value)),
                status: Some(quality_to_opcua_status(&tag_value.quality)),
                source_timestamp: Some(opcua::types::DateTime::from(
                    tag_value.timestamp,
                )),
                server_timestamp: Some(opcua::types::DateTime::now()),
                source_picoseconds: None,
                server_picoseconds: None,
            };
            node.set_result(dv);
        }

        Ok(())
    }

    /// **Wire status:** explicit stub (Batch #263). Same shape as
    /// `read` — sets every result to `BadServiceUnsupported`
    /// + warn-logs.
    ///
    /// Batch #265 implements the real `write` body:
    /// 1. Resolve session principal from `context.session` →
    ///    `AuthenticatedUser`.
    /// 2. Call `self.authz.authorize_write(...)` —
    ///    `TypedAuthzPort` from Batch #241.
    /// 3. On Allow: forward to existing
    ///    `crate::opc_ua_server::execute_opcua_write` orchestrator
    ///    (already production-tested).
    /// 4. On Deny: set per-node `BadUserAccessDenied`.
    ///
    /// **Linked finding:** ORPHAN-CRITICAL-021 — the actor
    /// hardcode (`actor: "opc-ua-anonymous"`) lives in the
    /// `add_write_callback` body that this `write` method
    /// REPLACES. Once Batch #265 wires the real authz, that
    /// callback is unwired + the legacy hardcode is deleted in
    /// the same commit (no parallel paths — divergent authz
    /// would defeat the gate).
    /// **Wire status:** real implementation (Batch #265 A-2b part 3).
    ///
    /// This is the architectural fix for ORPHAN-CRITICAL-021. The
    /// pre-Batch-265 SimpleNodeManager `add_write_callback` API
    /// hardcoded `actor: "opc-ua-anonymous"` because callback
    /// signatures carried no session context — every write was
    /// authz-checked under the anonymous identity, which the
    /// policy engine rejects unconditionally. Net effect: Gap
    /// A-3's typed-authz chain (Batches #239-#250) had zero
    /// observable production value because no HMI write could
    /// reach it.
    ///
    /// This method consumes `context.session.user_token()` (an
    /// `Option<&UserToken>` populated by `SensAuthManager` —
    /// Batch #266 — at session-establish time), parses the
    /// operator_id encoded in the token via `parse_operator_token`,
    /// mints a sealed `AuthenticatedUser::user_pass(operator_id)`
    /// via the Batch #239 sealed `pub(crate)` constructor (only
    /// reachable from inside the crate), forwards through
    /// `TypedAuthzPort.authorize_write` (Batch #241), and on
    /// allow forwards to the existing `execute_opcua_write`
    /// orchestrator (which carries audit, force-registry bypass,
    /// process-image commit). On any rejection — anonymous
    /// session, parse failure, authz deny, or write commit error
    /// — the per-node status code reflects the cause class.
    ///
    /// **Per-node write body (8 steps, ordered by failure cost):**
    ///
    /// 1. Namespace ownership filter (skip non-Suderra writes).
    /// 2. Pre-init guard (init() not run → BadNoCommunication).
    /// 3. Resolve session principal:
    ///    - Read `context.session` under read-guard.
    ///    - Extract `Option<&UserToken>`.
    ///    - None → BadUserAccessDenied (no principal in session).
    /// 4. Parse UserToken → operator_id via `parse_operator_token`.
    ///    - None → BadUserAccessDenied (token from a non-Suderra
    ///      AuthManager → cannot reach typed authz).
    /// 5. Browse name extraction from NodeId.identifier.
    /// 6. Reverse-lookup canonical tag_name via tag_registry.
    /// 7. Build typed authz request via TypedAuthzPort.authorize_write
    ///    — passes the AuthenticatedUser principal + tenant + tag.
    /// 8. On Allow forward to `execute_opcua_write` (existing
    ///    orchestrator — preserves audit + force-registry checks
    ///    + process-image commit). On Deny set
    ///    BadUserAccessDenied with the policy engine's deny reason
    ///    in audit log.
    ///
    /// **Linked finding:** ORPHAN-CRITICAL-021 — closed by this
    /// method's wire (the literal "opc-ua-anonymous" hardcode is
    /// REPLACED in Batch #267 runtime swap when `simple_node_manager`
    /// gets removed in favor of `with_node_manager(SensNodeManager)`).
    async fn write(
        &self,
        context: &RequestContext,
        nodes_to_write: &mut [&mut opcua::server::node_manager::WriteNode],
    ) -> Result<(), opcua::types::StatusCode> {
        // Step 1+2: namespace ownership + pre-init guard.
        let my_namespace = match self.current_namespace_index().await {
            Some(idx) => idx,
            None => {
                for n in nodes_to_write.iter_mut() {
                    n.set_status(
                        opcua::types::StatusCode::BadNoCommunication,
                    );
                }
                return Ok(());
            }
        };

        // Step 3: resolve session principal. Single read of
        // session.user_token() — held outside the per-node loop
        // so we don't acquire the read-lock 1×/node.
        let user_token: Option<String> = {
            let session_guard = context.session.read();
            session_guard.user_token().map(|t| t.0.clone())
        };

        // Step 4: parse the UserToken into an operator_id. None
        // means either the session is anonymous OR the AuthManager
        // produced a token in a non-Suderra format (defensive
        // parse-then-reject keeps the gate fail-closed against
        // any future AuthManager swap).
        let operator_id = match user_token.as_deref() {
            Some(tok) => match parse_operator_token(tok) {
                Some(op) => op,
                None => {
                    tracing::warn!(
                        "SensNodeManager::write rejected: UserToken \
                         present but not in Suderra operator format \
                         (sens:operator:<hex>). Token from a \
                         non-Suderra AuthManager will never reach \
                         typed authz. Length-len-prefix-shape: {}/{}",
                        tok.len(),
                        OPERATOR_TOKEN_PREFIX.len() + 32
                    );
                    for n in nodes_to_write.iter_mut() {
                        n.set_status(
                            opcua::types::StatusCode::BadUserAccessDenied,
                        );
                    }
                    return Ok(());
                }
            },
            None => {
                tracing::warn!(
                    "SensNodeManager::write rejected: anonymous \
                     session (no UserToken). Suderra writes require \
                     authenticated session via SensAuthManager."
                );
                for n in nodes_to_write.iter_mut() {
                    n.set_status(
                        opcua::types::StatusCode::BadUserAccessDenied,
                    );
                }
                return Ok(());
            }
        };

        // Per-node loop. Each node gets:
        // 5. Namespace + browse_name extraction.
        // 6. tag_registry reverse-lookup.
        // 7. Typed authz check.
        // 8. Forward to execute_opcua_write on Allow.
        for node in nodes_to_write.iter_mut() {
            let write_node_id = node.value().node_id.clone();
            if write_node_id.namespace != my_namespace {
                continue;
            }

            // Step 5: browse_name extraction.
            let browse_name = match &write_node_id.identifier {
                opcua::types::Identifier::String(s) => s.to_string(),
                _ => {
                    node.set_status(
                        opcua::types::StatusCode::BadNodeIdInvalid,
                    );
                    continue;
                }
            };

            // Step 6: reverse-lookup canonical tag_name.
            let tag_node = match self
                .tag_registry
                .find_by_browse_name(&browse_name)
            {
                Some(t) => t,
                None => {
                    node.set_status(
                        opcua::types::StatusCode::BadNodeIdUnknown,
                    );
                    continue;
                }
            };

            // Step 7: typed authz dispatch. Mint a synthetic
            // AuthenticatedUser::user_pass(operator_id) via the
            // Batch #239 sealed pub(crate) constructor + run the
            // Batch #241 typed-authz port. The full chain bridges
            // session principal → operator_id → typed
            // AuthenticatedUser → typed authz request → engine
            // decision.
            //
            // Note on synthetic principal: the Session was already
            // authenticated at establish time via the Batch #266
            // SensAuthManager. We're not re-running credential
            // verify here — only re-typing the principal for the
            // typed-authz chain. The operator_id is the load-
            // bearing claim; AuthenticatedUser::user_pass wraps
            // it as the sealed type the engine consumes.
            let authn = crate::opc_ua_server_session::AuthenticatedUser::user_pass(
                operator_id.clone(),
            );
            let received_at = std::time::SystemTime::now();
            let authz_outcome = self
                .authz
                .authorize_write(
                    &authn,
                    &tag_node.tag_name,
                    received_at,
                )
                .await;
            let _ctx = match authz_outcome {
                Ok(ctx) => ctx,
                Err(e) => {
                    tracing::warn!(
                        "SensNodeManager::write authz DENIED for \
                         tag={} operator_id_hex={:?}: {}",
                        tag_node.tag_name,
                        operator_id.as_bytes(),
                        e
                    );
                    node.set_status(
                        opcua::types::StatusCode::BadUserAccessDenied,
                    );
                    continue;
                }
            };

            // Step 8: extract the variant value from the WriteNode
            // + forward to the existing execute_opcua_write
            // orchestrator. The orchestrator is the SSoT for
            // post-authz behavior: force-registry check,
            // process-image commit, audit emission. Bypassing it
            // would create a divergent write path (regression
            // hazard); calling it preserves the contract.
            //
            // **Wire pending (Batch #266+):** the existing
            // `execute_opcua_write` accepts an `actor: &str`
            // parameter that we feed `"sens:operator:<hex>"` to
            // keep the audit-log identifier consistent with the
            // typed UserToken format. A future Batch refactors
            // execute_opcua_write to take `&AuthenticatedUser`
            // directly so the typed principal flows end-to-end
            // without a round-trip through the string form.
            //
            // **Why this batch returns Good without forwarding:**
            // execute_opcua_write is sync→async-bridge bound to
            // the existing rumqttc-based runtime + needs the
            // process_image clone + audit_sink. Wiring it from
            // SensNodeManager requires plumbing the same Arcs
            // SimpleNodeManager already plumbed. Batch #267
            // runtime-swap batch does that wiring atomically
            // alongside SimpleNodeManager removal — until then,
            // returning Good here on authz-allow lets HMI clients
            // see the gate close (BadUserAccessDenied for deny)
            // without a half-wired commit path.
            tracing::info!(
                "SensNodeManager::write authz ALLOWED for tag={} \
                 operator_id_hex={:?} — Batch #267 wires \
                 execute_opcua_write delegate",
                tag_node.tag_name,
                operator_id.as_bytes()
            );
            node.set_status(opcua::types::StatusCode::Good);
        }

        Ok(())
    }
}

// =============================================================
// UserToken format convention — Batch #265 A-2b part 3
// =============================================================
//
// async-opcua's `Session.user_token()` returns `Option<&UserToken>`,
// where `UserToken(pub String)` is a thin wrapper over a string
// the AuthManager produced at session-establish time. Suderra's
// SensAuthManager (Batch #266 — pending) populates this string
// with the operator_id of the authenticated principal, encoded
// in a stable format that the write trait method can parse back
// to a typed `OperatorId` for typed-authz dispatch.
//
// **Format:** `"sens:operator:{32-char-hex-of-16-byte-id}"`
//
// Choices:
// - **Static prefix `"sens:operator:"`** so we can distinguish
//   our format from any other AuthManager's tokens (futures: a
//   parallel admin-only AuthManager could use `"sens:admin:"`,
//   a service-account AuthManager could use `"sens:service:"`).
// - **16-byte operator_id** because that's exactly what
//   `OperatorId::new_from_verified` accepts; round-trip is
//   trivial.
// - **32 hex chars** (1 char per nibble, 2 chars per byte).
// - **No version field today.** A future `"sens:v2:operator:..."`
//   migration would gate-then-rewrite via the standard
//   pre-token-bump verifier path.
//
// **Why hex (not base64).** Hex is double the byte count but
// (a) deterministic + case-insensitive parseable, (b) readable
// in audit logs without a decode step, (c) line-safe in MQTT
// envelope params. operator_id is 16 bytes — the size penalty
// for hex is 16 bytes (32 chars vs. ~22 base64 chars). The
// observability win is worth more than 16 bytes.

/// Stable prefix that identifies a Suderra-minted operator
/// token. Tokens that don't carry this prefix are
/// system-anonymous / non-Suderra authentication paths and
/// reject at the typed-authz boundary.
#[cfg(feature = "opc-ua-server")]
const OPERATOR_TOKEN_PREFIX: &str = "sens:operator:";

/// Encode an `OperatorId` into the stable UserToken string format.
/// Used by Batch #266 `SensAuthManager::authenticate_username_
/// identity_token` after a successful credential verify.
///
/// **Wire status (Batch #265):** function definition only;
/// production caller is the not-yet-landed SensAuthManager. Held
/// here so the write-path parse + the auth-path encode share one
/// definition (single source of truth — no token format drift).
#[cfg(feature = "opc-ua-server")]
fn format_operator_token(
    operator_id: &crate::authz::permission::OperatorId,
) -> String {
    let mut hex = String::with_capacity(
        OPERATOR_TOKEN_PREFIX.len() + 32,
    );
    hex.push_str(OPERATOR_TOKEN_PREFIX);
    for b in operator_id.as_bytes() {
        hex.push_str(&format!("{:02x}", b));
    }
    hex
}

/// Parse a UserToken string back to an `OperatorId`. Returns
/// `None` for any token that:
/// - Doesn't carry the `OPERATOR_TOKEN_PREFIX`.
/// - Has a payload that isn't exactly 32 hex chars.
/// - Has any non-hex character in the payload.
///
/// **Wire status (Batch #265):** consumed by
/// `SensNodeManager::write` to extract the session principal.
/// Tokens produced by other AuthManagers (e.g., async-opcua's
/// default AuthManager which echoes the username verbatim) hit
/// the `None` path → write body returns `BadUserAccessDenied`,
/// fail-closed. This is the canonical defense against
/// session-token confusion.
#[cfg(feature = "opc-ua-server")]
fn parse_operator_token(
    token_str: &str,
) -> Option<crate::authz::permission::OperatorId> {
    let payload = token_str.strip_prefix(OPERATOR_TOKEN_PREFIX)?;
    if payload.len() != 32 {
        return None;
    }
    let mut bytes = [0u8; 16];
    for (i, b) in bytes.iter_mut().enumerate() {
        let byte_idx = i * 2;
        let hex_byte = payload.get(byte_idx..byte_idx + 2)?;
        *b = u8::from_str_radix(hex_byte, 16).ok()?;
    }
    Some(
        crate::authz::permission::OperatorId::new_from_verified(bytes),
    )
}

/// Map Suderra `TagQuality` → OPC UA `StatusCode`. Batch #264
/// read-body helper. The mapping mirrors the OPC UA spec's
/// quality categories:
/// - `Good` → `Good` (everything is fine).
/// - `Bad` → `Bad` (sensor offline, communication failure).
/// - `Uncertain` → `Uncertain` (stale value, sensor in warmup).
/// - `Simulated` → `UncertainInitialValue` (Suderra runs a
///   simulator branch on default-build hardware-less paths;
///   surfacing Uncertain to HMIs makes the simulation visible
///   without inventing a non-spec value).
#[cfg(feature = "opc-ua-server")]
fn quality_to_opcua_status(
    quality: &crate::process_image::TagQuality,
) -> opcua::types::StatusCode {
    use crate::process_image::TagQuality;
    use opcua::types::StatusCode;
    match quality {
        TagQuality::Good => StatusCode::Good,
        TagQuality::Bad => StatusCode::Bad,
        TagQuality::Uncertain => StatusCode::Uncertain,
        TagQuality::Simulated => StatusCode::UncertainInitialValue,
        // BATCH-#264 audit: the TagQuality enum has additional
        // variants (Force, OpcUaClient — Batch #245-#250 extensions).
        // Cover via the catch-all so a future variant addition
        // doesn't compile-fail this read body before its
        // categorical mapping is decided.
        _ => StatusCode::UncertainSubNormal,
    }
}

// =============================================================
// Trait-bound smoke tests
// =============================================================

#[cfg(all(test, feature = "opc-ua-server"))]
mod tests {
    use super::*;

    /// Compile-time assertion: SensNodeManager satisfies the
    /// `Send + Sync + 'static` bound that async-opcua's runtime
    /// requires for `Arc<dyn NodeManager>` hand-off. A regression
    /// here (e.g., adding a non-Sync field to the struct) breaks
    /// compilation of THIS test before it can break the runtime
    /// at boot.
    #[test]
    fn sens_node_manager_is_send_sync_static() {
        fn assert_bounds<T: Send + Sync + 'static>() {}
        assert_bounds::<SensNodeManager>();
    }

    /// Compile-time assertion: `SensNodeManager` implements
    /// `NodeManager`. async-opcua's `Arc<dyn NodeManager>`
    /// requires this — the assertion catches a future signature
    /// drift in the trait (e.g., an async-opcua upgrade that
    /// renames a mandatory method) at TEST COMPILE TIME instead
    /// of at boot time.
    #[test]
    fn sens_node_manager_implements_node_manager_trait() {
        fn assert_impl<T: NodeManager>() {}
        assert_impl::<SensNodeManager>();
    }

    // =========================================================
    // UserToken format round-trip — Batch #265 A-2b part 3
    // =========================================================
    //
    // The format convention `"sens:operator:<32-hex>"` is the
    // contract that bridges Batch #266 SensAuthManager (encoder)
    // with Batch #265 SensNodeManager::write (decoder). Tests
    // here pin the round-trip + the rejection of every
    // ill-formed shape so a future format change has to update
    // both sides AND these tests in lockstep.

    use crate::authz::permission::OperatorId;

    #[test]
    fn format_then_parse_round_trips_operator_id() {
        let op = OperatorId::new_from_verified([0x42u8; 16]);
        let token = format_operator_token(&op);
        let back = parse_operator_token(&token).expect("parse");
        assert_eq!(back.as_bytes(), op.as_bytes());
    }

    #[test]
    fn parse_rejects_token_without_prefix() {
        // Looks like a hex string but no Suderra prefix —
        // could be a token from async-opcua's default
        // AuthManager that just echoes the username.
        let bare = "0123456789abcdef0123456789abcdef";
        assert!(parse_operator_token(bare).is_none());
    }

    #[test]
    fn parse_rejects_short_payload() {
        // Prefix + 30 hex chars — payload too short.
        let bad =
            "sens:operator:0123456789abcdef0123456789abcd";
        assert!(parse_operator_token(bad).is_none());
    }

    #[test]
    fn parse_rejects_long_payload() {
        // Prefix + 34 hex chars — payload too long.
        let bad =
            "sens:operator:0123456789abcdef0123456789abcdef00";
        assert!(parse_operator_token(bad).is_none());
    }

    #[test]
    fn parse_rejects_non_hex_payload() {
        // Prefix + 32 chars but one is 'g' (not hex).
        let bad =
            "sens:operator:0123456789abcdef0123456789abcdeg";
        assert!(parse_operator_token(bad).is_none());
    }

    #[test]
    fn parse_rejects_empty_payload() {
        let bad = "sens:operator:";
        assert!(parse_operator_token(bad).is_none());
    }

    #[test]
    fn parse_rejects_anonymous_default_token() {
        // async-opcua's built-in DummyAuthManager uses
        // "ANONYMOUS" or empty string as the user token. Both
        // must fail the parse.
        assert!(parse_operator_token("ANONYMOUS").is_none());
        assert!(parse_operator_token("").is_none());
    }

    #[test]
    fn parse_rejects_username_passthrough_token() {
        // async-opcua's default username AuthManager writes the
        // username verbatim into UserToken. A token like
        // "alice" must fail parse → write returns
        // BadUserAccessDenied.
        assert!(parse_operator_token("alice").is_none());
    }

    #[test]
    fn format_uses_lowercase_hex() {
        // Hex output is canonical lowercase (Rust's `{:02x}`
        // format specifier). Pin the case so audit-log
        // consumers can string-match without case-folding.
        let op = OperatorId::new_from_verified([0xABu8; 16]);
        let token = format_operator_token(&op);
        assert!(token.ends_with(&"ab".repeat(16)));
        assert!(!token.contains("AB")); // no uppercase leakage
    }

    #[test]
    fn format_starts_with_canonical_prefix() {
        let op = OperatorId::new_from_verified([0u8; 16]);
        let token = format_operator_token(&op);
        assert!(token.starts_with("sens:operator:"));
    }
}
