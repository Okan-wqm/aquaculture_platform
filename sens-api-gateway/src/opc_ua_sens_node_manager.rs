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
use opcua::nodes::DefaultTypeTree;
#[cfg(feature = "opc-ua-server")]
use opcua::server::diagnostics::NamespaceMetadata;
#[cfg(feature = "opc-ua-server")]
use opcua::server::node_manager::{
    DynNodeManager, NodeManager, NodeManagerBuilder, RequestContext, ServerContext,
};
#[cfg(feature = "opc-ua-server")]
use opcua::types::NodeId;
// Batch #288 step 5b — browse() trait method implementation requires:
// - BrowseNode (the request/response shape for a single browse target)
// - AddReferenceResult (Added vs Full vs Rejected discriminator)
// - ReferenceDescription (the response payload added per reference)
// - ReferenceTypeId (HasComponent + HasTypeDefinition reference types)
// - ObjectId / VariableTypeId / ObjectTypeId (well-known node identifiers)
// - QualifiedName / LocalizedText / ExpandedNodeId (reference description fields)
// - StatusCode / NodeClass / BrowseDirection (response status + direction filter)
// - VecDeque (continuation-point buffer when a browse exceeds max_references_per_node)
#[cfg(feature = "opc-ua-server")]
use opcua::server::node_manager::{AddReferenceResult, BrowseNode};
#[cfg(feature = "opc-ua-server")]
use opcua::types::{
    BrowseDirection, ExpandedNodeId, LocalizedText, NodeClass, ObjectId, ObjectTypeId,
    QualifiedName, ReferenceDescription, ReferenceTypeId, StatusCode, VariableTypeId,
};
#[cfg(feature = "opc-ua-server")]
use std::collections::VecDeque;

// Project deps — Gap A-3 chain primitives this module is
// designed to consume in subsequent batches. They're imported
// (not used) at skeleton stage so the field signatures compile
// + so a `cargo check` regression on any of these primitive
// definitions surfaces here at the same time as in their
// original modules.
#[cfg(feature = "opc-ua-server")]
use crate::authz::permission::TenantId;
#[cfg(feature = "opc-ua-server")]
use crate::opc_ua_server::{
    OpcUaAuditPort, OpcUaForceRegistryPort, OpcUaProcessImagePort, OpcUaTagRegistry,
    OpcUaWriteOutcome, OpcUaWriteRequest, execute_opcua_write_post_typed_authz,
};
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

    /// **Batch #291 5f-wire field.** Force-registry port. Used
    /// by `write()` Allow-path delegate to reject writes
    /// against currently-forced tags (operator-held actuator
    /// state). Trait object, not concrete `ForceRegistry`,
    /// because (a) test mocks substitute against the trait,
    /// (b) the production adapter
    /// `ForceRegistryOpcUaAdapter` already wraps the concrete
    /// type — same Arc that the legacy
    /// `wire_write_callbacks` path consumed (Batch #292
    /// runtime-swap reuses the same construction).
    write_force: Arc<dyn OpcUaForceRegistryPort>,

    /// **Batch #291 5f-wire field.** Process-image port for
    /// the write-commit step. Distinct from `process_image:
    /// Arc<ProcessImage>` (above) because the read path uses
    /// the concrete API (`get_tag(...)`) which is not on the
    /// `OpcUaProcessImagePort` trait, while the write path
    /// uses the trait method `write_tag(tag, value, actor)`
    /// which carries actor-string for audit. Both fields
    /// reference the same in-memory store via Arc — no state
    /// duplication, just two abstraction layers (concrete for
    /// read, trait for write).
    write_process_image: Arc<dyn OpcUaProcessImagePort>,

    /// **Batch #291 5f-wire field.** Audit port. Every write
    /// outcome (Allow + commit; Allow + rejected by
    /// pre-commit gate; Allow + commit failed) fires
    /// `audit.record_write_attempt(...)` via the delegate.
    /// The Deny path (typed-authz refused) is currently
    /// audited only via the typed-authz adapter — the Deny
    /// branch in `write()` does NOT call this audit port to
    /// avoid double-emission against `OpcUaAuditPort`. A
    /// future Batch may unify the audit shapes; today the
    /// split matches the typed-authz vs legacy-write boundary.
    write_audit: Arc<dyn OpcUaAuditPort>,

    /// **Batch #325 D-9 migration field.** Clock authority
    /// for the per-write `received_at` timestamp threaded
    /// to TypedAuthzPort::authorize_write. The pre-#325
    /// implementation read SystemTime::now() directly,
    /// vulnerable to operator clock-rollback against
    /// downstream policy-version freshness checks. Reading
    /// received_at via clock.trustworthy_wall_clock()
    /// fails-closed on stale-NTS via ClockAuthority's
    /// gate; OPC UA writes are denied with
    /// BadUserAccessDenied on clock-side error rather
    /// than risking silent policy bypass.
    clock: Arc<dyn crate::runtime_safety::ClockAuthority>,

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
        write_force: Arc<dyn OpcUaForceRegistryPort>,
        write_process_image: Arc<dyn OpcUaProcessImagePort>,
        write_audit: Arc<dyn OpcUaAuditPort>,
        // Batch #325 D-9 migration: 9th param threads the
        // clock through. Production wire passes
        // AppState::clock_authority; tests pass a fresh
        // SystemClockAuthority via the test fixture.
        clock: Arc<dyn crate::runtime_safety::ClockAuthority>,
    ) -> Self {
        Self {
            namespace_uri: Self::NAMESPACE_URI.to_string(),
            namespace_index: tokio::sync::RwLock::new(None),
            tenant_id,
            authz,
            validator,
            process_image,
            tag_registry,
            write_force,
            write_process_image,
            write_audit,
            clock,
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
    fn namespaces_for_user(&self, _context: &RequestContext) -> Vec<NamespaceMetadata> {
        vec![NamespaceMetadata {
            namespace_uri: self.namespace_uri.clone(),
            ..Default::default()
        }]
    }

    /// **Wire status:** namespace registration WIRED (Batch
    /// #287); address-space population pending (Batch #288 step
    /// 5b — VariableNode per-tag dispatch).
    ///
    /// Batch #287 step 5a (ULTRA-HIGH-039 RESOLVED) registers
    /// the Suderra namespace URI into the async-opcua server's
    /// shared type-tree namespace map + stores the assigned u16
    /// index in `self.namespace_index` so subsequent
    /// `owns_node()` + `read()` + `write()` trait methods can
    /// match incoming NodeIds.
    ///
    /// The pattern was discovered in async-opcua's own
    /// `DiagnosticsNodeManager::new(context)` (registry source
    /// `async-opcua-server-0.18.0/src/diagnostics/node_manager.rs`):
    ///
    /// ```ignore
    /// let namespace_index = {
    ///     let mut type_tree = context.type_tree.write();
    ///     type_tree.namespaces_mut().add_namespace(<uri>)
    /// };
    /// ```
    ///
    /// Init signature gives us `&mut DefaultTypeTree` directly
    /// (DiagnosticsNodeManager goes through `context.type_tree`
    /// because it constructs at `NodeManagerBuilder::build` time
    /// not at trait-method `init` time — different hook). We use
    /// the trait-method's pre-locked `type_tree` parameter.
    ///
    /// **Idempotency note:** `add_namespace(uri)` returns the
    /// existing index if the URI is already registered — calling
    /// `init` more than once on the same NodeManager instance is
    /// safe + returns the same index. The async-opcua runtime
    /// does not re-call init in normal operation; this is
    /// defense-in-depth against future runtime changes.
    ///
    /// **Linked finding:** ULTRA-HIGH-039 (RESOLVED — namespace
    /// registration). ULTRA-HIGH-035 PARTIAL_FIX (overall A-2b
    /// part 5 still has sub-steps 5b-5f pending). Address space
    /// population (per-tag VariableNode dispatch) lands in
    /// Batch #288 step 5b.
    async fn init(&self, type_tree: &mut DefaultTypeTree, _context: ServerContext) {
        // Step 5a — namespace registration. The async-opcua
        // runtime trait-method gives us `&mut DefaultTypeTree`
        // directly; no inner lock needed here.
        let assigned_index = type_tree
            .namespaces_mut()
            .add_namespace(&self.namespace_uri);

        // Atomically store the assigned index. The trait method
        // is `async`; using `tokio::RwLock` matches the
        // service-method readers (`owns_node` uses `try_read`
        // for sync-trait-method compatibility; `read` /
        // `write` use `read().await`).
        {
            let mut guard = self.namespace_index.write().await;
            *guard = Some(assigned_index);
        }

        tracing::info!(
            "SensNodeManager::init() namespace registered: \
             uri='{}' assigned_index={} — Batch #287 step 5a \
             complete; address-space population (step 5b) \
             pending Batch #288",
            self.namespace_uri,
            assigned_index
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
                    n.set_error(opcua::types::StatusCode::BadNoCommunication);
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
                node.set_error(opcua::types::StatusCode::BadAttributeIdInvalid);
                continue;
            }

            // Step 3: extract browse_name from the NodeId
            // identifier. async-opcua represents string-keyed
            // node identifiers as Identifier::String(UAString).
            let browse_name = match &read_id.identifier {
                opcua::types::Identifier::String(s) => s.to_string(),
                _ => {
                    node.set_error(opcua::types::StatusCode::BadNodeIdInvalid);
                    continue;
                }
            };

            // Step 4: reverse-lookup canonical tag_name.
            let tag_node = match self.tag_registry.find_by_browse_name(&browse_name) {
                Some(t) => t,
                None => {
                    node.set_error(opcua::types::StatusCode::BadNodeIdUnknown);
                    continue;
                }
            };

            // Step 5: snapshot current tag value.
            let tag_value = self.process_image.get_tag(&tag_node.tag_name).await;
            let tag_value = match tag_value {
                Some(v) => v,
                None => {
                    // Tag is in the catalog but not yet in the
                    // process image — first-boot before the I/O
                    // poll has populated it.
                    node.set_error(opcua::types::StatusCode::BadDataUnavailable);
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
                source_timestamp: Some(opcua::types::DateTime::from(tag_value.timestamp)),
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
    /// **Linked finding:** ORPHAN-CRITICAL-021 — the legacy
    /// anonymous-actor hardcode (string-literal banned by
    /// the Batch #354 audit_actor_label_no_legacy invariant)
    /// lived in the `add_write_callback` body that this
    /// `write` method REPLACES. Once Batch #265 wires the
    /// real authz, that callback is unwired + the legacy
    /// hardcode is deleted in the same commit (no parallel
    /// paths — divergent authz would defeat the gate).
    /// **Wire status:** real implementation (Batch #265 A-2b part 3).
    ///
    /// This is the architectural fix for ORPHAN-CRITICAL-021. The
    /// pre-Batch-265 SimpleNodeManager `add_write_callback` API
    /// hardcoded the legacy anonymous-actor wire-string because
    /// callback signatures carried no session context — every
    /// write was authz-checked under the anonymous identity,
    /// which the policy engine rejects unconditionally. Net
    /// effect: Gap A-3's typed-authz chain (Batches #239-#250)
    /// had zero observable production value because no HMI
    /// write could reach it.
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
    /// method's wire (the legacy anonymous-actor hardcode in
    /// `simple_node_manager` is REPLACED in Batch #267 runtime
    /// swap when that path is removed in favor of
    /// `with_node_manager(SensNodeManager)`).
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
                    n.set_status(opcua::types::StatusCode::BadNoCommunication);
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
                        n.set_status(opcua::types::StatusCode::BadUserAccessDenied);
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
                    n.set_status(opcua::types::StatusCode::BadUserAccessDenied);
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
                    node.set_status(opcua::types::StatusCode::BadNodeIdInvalid);
                    continue;
                }
            };

            // Step 6: reverse-lookup canonical tag_name.
            let tag_node = match self.tag_registry.find_by_browse_name(&browse_name) {
                Some(t) => t,
                None => {
                    node.set_status(opcua::types::StatusCode::BadNodeIdUnknown);
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
            let authn =
                crate::opc_ua_server_session::AuthenticatedUser::user_pass(operator_id.clone());
            // Batch #325 D-9 migration: read received_at via
            // the trustworthy wallclock gate. NTS-stale
            // clock → fail-closed (BadUserAccessDenied),
            // matching the architectural pattern from
            // PolicyEngineOpcUaAdapter (Batch #325). The
            // policy-version freshness check downstream
            // depends on a trusted received_at; an
            // operator-rolled wallclock could either pass
            // an expired policy as fresh or fail a valid
            // policy as stale.
            let received_at = match self.clock.trustworthy_wall_clock().await {
                Ok(reading) => reading.system_time,
                Err(e) => {
                    tracing::warn!(
                        "SensNodeManager::write: clock unhealthy ({}) — \
                         REJECTING write for tag={} operator_id_hex={:?} \
                         (fail-closed per Batch #325 D-9)",
                        e,
                        tag_node.tag_name,
                        operator_id.as_bytes(),
                    );
                    node.set_status(opcua::types::StatusCode::BadUserAccessDenied);
                    continue;
                }
            };
            let authz_outcome = self
                .authz
                .authorize_write(&authn, &tag_node.tag_name, received_at)
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
                    node.set_status(opcua::types::StatusCode::BadUserAccessDenied);
                    continue;
                }
            };

            // Step 8 (Batch #291 5f-wire): forward to
            // `execute_opcua_write_post_typed_authz` (Batch
            // #290 primitive). The delegate runs the
            // post-authz half of the legacy write chain:
            // pre-commit gates (registry / writable / force /
            // range) + ProcessImage commit + audit on every
            // outcome. The Tier-1 architectural shape: the
            // delegate's signature has NO authz port — there
            // is no way to accidentally re-run authz here +
            // produce a double-decision drift hazard.
            //
            // The actor string is the canonical
            // `"sens:operator:<32-hex>"` from
            // `format_operator_token` — same shape that
            // `parse_operator_token` round-trips, so the audit
            // log identifier matches the session-establish
            // identifier end-to-end (no string churn between
            // typed-authz allow + audit-record actor field).
            //
            // **f64 extraction.** OPC UA Variants carry many
            // numeric types; SensNodeManager today maps every
            // tag to f64 (Batch #264 Step 6 read body emits
            // `Variant::Double` regardless of the declared
            // tag DataType). The write side reverses this:
            // every incoming Variant is coerced to f64 via
            // `cast_variant_to_f64`. Loss-precision shapes
            // (Variant::Int64 above 2^53, Variant::String) are
            // rejected with BadTypeMismatch — a future Batch
            // routes Boolean DOs through a dedicated DI/DO
            // value path, but today the f64-canonical
            // ProcessImage is the SSoT.
            // node.value() returns &ParsedWriteValue;
            // its .value field is a DataValue whose .value is
            // Option<Variant>. None means the HMI sent a
            // DataValue without a payload — fail-closed with
            // BadNothingToDo per spec.
            let write_value = match node.value().value.value.as_ref() {
                Some(variant) => match cast_variant_to_f64(variant) {
                    Some(v) => v,
                    None => {
                        tracing::warn!(
                            "SensNodeManager::write rejected: tag={} \
                             value type cannot coerce to f64",
                            tag_node.tag_name
                        );
                        node.set_status(opcua::types::StatusCode::BadTypeMismatch);
                        continue;
                    }
                },
                None => {
                    tracing::warn!(
                        "SensNodeManager::write rejected: tag={} \
                         DataValue carried no Variant payload",
                        tag_node.tag_name
                    );
                    node.set_status(opcua::types::StatusCode::BadNothingToDo);
                    continue;
                }
            };

            let actor_token = format_operator_token(&operator_id);
            let request = OpcUaWriteRequest {
                tag_name: &tag_node.tag_name,
                value: write_value,
                actor: &actor_token,
            };

            let outcome = execute_opcua_write_post_typed_authz(
                &self.tag_registry,
                &request,
                self.write_force.as_ref(),
                self.write_process_image.as_ref(),
                self.write_audit.as_ref(),
            )
            .await;

            // Map the OpcUaWriteOutcome to the OPC UA
            // StatusCode the HMI sees. The mapping mirrors
            // the legacy `wire_write_callbacks` shape so
            // existing HMI dashboards (which check for these
            // specific status codes) remain compatible.
            let status = match outcome {
                OpcUaWriteOutcome::Success { .. } => opcua::types::StatusCode::Good,
                OpcUaWriteOutcome::RejectedUnknownTag { .. } => {
                    opcua::types::StatusCode::BadNodeIdUnknown
                }
                OpcUaWriteOutcome::RejectedNotWritable { .. } => {
                    opcua::types::StatusCode::BadNotWritable
                }
                OpcUaWriteOutcome::RejectedForced { .. } => {
                    // Distinct audit reason already emitted
                    // by the delegate; HMI sees BadNotWritable
                    // (the OPC UA spec doesn't carry "blocked
                    // by force" in StatusCode taxonomy).
                    opcua::types::StatusCode::BadNotWritable
                }
                OpcUaWriteOutcome::RejectedOutOfRange { .. } => {
                    opcua::types::StatusCode::BadOutOfRange
                }
                OpcUaWriteOutcome::RejectedNoPermission { .. } => {
                    // Tier-1 invariant: the delegate's
                    // signature precludes this variant. We
                    // map it defensively in case a future
                    // refactor adds it back.
                    opcua::types::StatusCode::BadUserAccessDenied
                }
                OpcUaWriteOutcome::RejectedProcessImage { .. } => {
                    opcua::types::StatusCode::BadInternalError
                }
            };
            node.set_status(status);
        }

        Ok(())
    }

    // ===========================================================
    // browse() — Batch #288 A-2b part 5 step 5b (re-specified)
    // ===========================================================
    //
    // Architectural shape (per ORPHAN-HIGH-027 correction note):
    //
    // The Suderra OPC UA address space is a 4-level hierarchy
    // resolved virtually via tag_registry — NO AddressSpace storage
    // (canonical pattern 2 per `async-opcua-server-0.18.0/src/
    // diagnostics/node_manager.rs:DiagnosticsNodeManager.browse`):
    //
    //   Objects (NodeId(0, 85))           ← owned by core node manager
    //     └─[HasComponent]─→ Suderra (Object, NodeId(ns_idx, "Suderra"))
    //                            ↓ owns
    //                          Suderra (NodeId(ns_idx, "Suderra"))
    //                            └─[HasComponent]─→ Tags (Object,
    //                                                NodeId(ns_idx, "Tags"))
    //                            └─[HasTypeDefinition]─→ FolderType
    //                                                ↓ owns
    //                                              Tags (NodeId(ns_idx, "Tags"))
    //                                                └─[HasComponent]─→ tag_a (Variable)
    //                                                └─[HasComponent]─→ tag_b (Variable)
    //                                                ...
    //                                                └─[HasTypeDefinition]─→ FolderType
    //                                                                  ↓ owns
    //                                                                tag_n (Variable, NodeId(ns_idx, browse_name))
    //                                                                  └─[HasTypeDefinition]─→ BaseDataVariableType
    //                                                                  └─[HasComponent inverse]─→ Tags
    //
    // Cross-namespace contribution: SensNodeManager browse() is
    // also invoked when the runtime fans out a Browse request
    // against `ObjectId::ObjectsFolder` (namespace 0). The core
    // node manager owns ObjectsFolder, but every registered
    // NodeManager gets a chance to ADD references to a BrowseNode
    // (canonical async-opcua dispatch — confirmed via
    // `async-opcua-server-0.18.0/src/diagnostics/node_manager.rs:619-667`).
    //
    // Continuation points: when a single browse exceeds the
    // session's `max_references_per_node` cap, the trait API
    // requires us to (a) stop adding refs when `BrowseNode.add()`
    // returns `Full(reference)`, (b) stash the unfinished refs
    // in a `Box<dyn ContinuationPoint>` via
    // `BrowseNode.set_next_continuation_point(...)`, (c) on
    // BrowseNext resume by `BrowseNode.take_continuation_point()`.
    // The DiagnosticsNodeManager pattern uses a private struct
    // `BrowseContinuationPoint { nodes: VecDeque<ReferenceDescription> }`
    // — we mirror that shape via `SuderraBrowseCp` below.
    //
    // **Linked finding:** ULTRA-HIGH-040 (RESOLVED — browse impl).
    // Closes ORPHAN-HIGH-027 architectural-correction finding.

    /// **Wire status:** real implementation (Batch #288 step 5b
    /// re-specified per ORPHAN-HIGH-027). Replaces the trait
    /// default's `BadServiceUnsupported`.
    ///
    /// Per `nodes_to_browse[i]` the body dispatches by NodeId:
    ///
    /// 1. **Continuation-point resume** — if the BrowseNode
    ///    carries a stashed `SuderraBrowseCp`, drain it (drain
    ///    until either `node.remaining() == 0` or the queue is
    ///    empty; on overflow a fresh continuation point is
    ///    re-stashed).
    /// 2. **Browse from `ObjectsFolder` (ns=0)** — add
    ///    HasComponent forward ref to NodeId(ns_idx, "Suderra").
    ///    No inverse handling (the core manager owns the inverse
    ///    side from Suderra→Objects).
    /// 3. **Browse from `Suderra` root (ns=ns_idx, "Suderra")** —
    ///    add HasComponent forward ref to NodeId(ns_idx, "Tags") +
    ///    HasTypeDefinition forward ref to ObjectTypeId::FolderType.
    ///    Inverse: HasComponent inverse ref to ObjectsFolder.
    /// 4. **Browse from `Tags` folder (ns=ns_idx, "Tags")** — add
    ///    HasComponent forward ref per tag in the registry +
    ///    HasTypeDefinition forward ref to FolderType. Inverse:
    ///    HasComponent inverse ref to Suderra root.
    /// 5. **Browse from a tag node (ns=ns_idx, browse_name)** —
    ///    add HasTypeDefinition forward ref to
    ///    VariableTypeId::BaseDataVariableType. Inverse:
    ///    HasComponent inverse ref to Tags.
    /// 6. **Browse from any unknown ns_idx node** — set status
    ///    `BadNodeIdUnknown` so HMIs see a stable rejection
    ///    rather than empty.
    ///
    /// The `node.set_status(...)` calls are intentionally
    /// scoped: we only set status on nodes WE own (ns=ns_idx).
    /// Nodes in namespace 0 that we don't claim are silently
    /// skipped — async-opcua's runtime fans out to every
    /// manager; setting status here would clobber the core
    /// manager's response.
    async fn browse(
        &self,
        context: &RequestContext,
        nodes_to_browse: &mut [BrowseNode],
    ) -> Result<(), StatusCode> {
        let my_namespace = match self.current_namespace_index().await {
            Some(idx) => idx,
            None => {
                // init() not run yet — every browse request
                // returns the same shape DiagnosticsNodeManager
                // returns when its namespace is unmapped: the
                // browse request is silently skipped (no refs
                // added). HMIs see an empty browse response,
                // which is the correct UX for a transient boot
                // state (the runtime calls init before opening
                // the listener, so this branch is defense-in-
                // depth against future runtime changes).
                return Ok(());
            }
        };

        // Acquire a single read guard on the type tree for the
        // duration of the browse loop — `BrowseNode.add()` calls
        // `matches_filter` which queries the type tree for
        // reference-type subtype validation. Holding one guard
        // amortizes the lock cost across N browse nodes.
        let type_tree_lock = context.type_tree.read();
        let type_tree: &DefaultTypeTree = &*type_tree_lock;

        for node in nodes_to_browse.iter_mut() {
            // Step 1: continuation point resume.
            if let Some(mut cp) = node.take_continuation_point::<SuderraBrowseCp>() {
                while node.remaining() > 0 {
                    let Some(ref_desc) = cp.refs.pop_front() else {
                        break;
                    };
                    // Already-filtered references — call
                    // `add_unchecked` to bypass the filter
                    // re-validation (we filtered them at
                    // initial-add time).
                    node.add_unchecked(ref_desc);
                }
                if !cp.refs.is_empty() {
                    node.set_next_continuation_point(Box::new(cp));
                }
                continue;
            }

            // Steps 2-6: dispatch by NodeId.
            let target_id = node.node_id().clone();

            // Step 2: ObjectsFolder (ns=0, opaque ObjectsFolder).
            if target_id == NodeId::from(ObjectId::ObjectsFolder) {
                self.browse_objects_folder_attach(node, type_tree, my_namespace);
                continue;
            }

            // Steps 3-5: nodes in our namespace.
            if target_id.namespace == my_namespace {
                let identifier_str = match &target_id.identifier {
                    opcua::types::Identifier::String(s) => s.to_string(),
                    _ => {
                        node.set_status(StatusCode::BadNodeIdInvalid);
                        continue;
                    }
                };
                match identifier_str.as_str() {
                    SUDERRA_ROOT_BROWSE_NAME => {
                        self.browse_suderra_root(node, type_tree, my_namespace);
                    }
                    TAGS_FOLDER_BROWSE_NAME => {
                        self.browse_tags_folder(node, type_tree, my_namespace);
                    }
                    other => {
                        // Per-tag node — registry lookup. None
                        // means the NodeId carries an unknown
                        // browse name (HMI cached a stale
                        // address-space + the tag was removed
                        // by config reload); fail closed.
                        if let Some(tag) = self.tag_registry.find_by_browse_name(other) {
                            self.browse_tag_node(node, type_tree, my_namespace, tag);
                        } else {
                            node.set_status(StatusCode::BadNodeIdUnknown);
                        }
                    }
                }
                continue;
            }

            // Step 6 fallthrough: not our namespace + not
            // ObjectsFolder — silently skip (other managers
            // handle it).
        }

        // Drop the type-tree read guard; the explicit `drop`
        // is unnecessary (RAII) but documents the lifetime.
        drop(type_tree_lock);
        Ok(())
    }
}

// =============================================================
// browse() helpers — Batch #288
// =============================================================

/// Stable browse-name string for the Suderra root Object node.
/// Single source of truth — used by both the browse() trait body
/// (target lookup) AND the per-tag inverse HasComponent reference
/// builder (parent identifier).
#[cfg(feature = "opc-ua-server")]
pub(crate) const SUDERRA_ROOT_BROWSE_NAME: &str = "Suderra";

/// Stable browse-name string for the Tags container Object node.
/// Same SSoT discipline as `SUDERRA_ROOT_BROWSE_NAME`.
#[cfg(feature = "opc-ua-server")]
pub(crate) const TAGS_FOLDER_BROWSE_NAME: &str = "Tags";

/// Continuation-point payload for Suderra browse responses. The
/// async-opcua trait API allows a NodeManager to stash unfinished
/// references when `BrowseNode.add()` returns `Full(reference)`;
/// on the next BrowseNext call the runtime re-invokes browse()
/// with the same BrowseNode, where `take_continuation_point::<T>()`
/// returns the previously-stashed `Box<T>` cast back to T.
///
/// Mirrors `BrowseContinuationPoint` from DiagnosticsNodeManager
/// (`async-opcua-server-0.18.0/src/diagnostics/node_manager.rs:78-82`)
/// for cross-pattern consistency.
#[cfg(feature = "opc-ua-server")]
#[derive(Default)]
struct SuderraBrowseCp {
    /// Pending references that didn't fit in the previous
    /// browse response. Drained FIFO on resume.
    refs: VecDeque<ReferenceDescription>,
}

#[cfg(feature = "opc-ua-server")]
impl SensNodeManager {
    /// Build the canonical `Suderra` root Object node's metadata.
    /// Reused by browse() (when constructing the inverse
    /// HasComponent ref from Tags → Suderra) AND
    /// `resolve_external_references()` (Batch #289+ extension —
    /// the core manager may ask us for metadata of nodes WE own).
    fn suderra_root_metadata(&self, ns_idx: u16) -> opcua::server::node_manager::NodeMetadata {
        opcua::server::node_manager::NodeMetadata {
            node_id: ExpandedNodeId::new(NodeId::new(ns_idx, SUDERRA_ROOT_BROWSE_NAME)),
            type_definition: ExpandedNodeId::new(ObjectTypeId::FolderType),
            browse_name: QualifiedName::new(ns_idx, SUDERRA_ROOT_BROWSE_NAME),
            display_name: LocalizedText::new("", "Suderra Edge Agent"),
            node_class: NodeClass::Object,
        }
    }

    /// Build the canonical `Tags` container Object node's
    /// metadata. Reused by browse() (parent inverse-HasComponent
    /// ref construction) AND future external-reference resolution.
    fn tags_folder_metadata(&self, ns_idx: u16) -> opcua::server::node_manager::NodeMetadata {
        opcua::server::node_manager::NodeMetadata {
            node_id: ExpandedNodeId::new(NodeId::new(ns_idx, TAGS_FOLDER_BROWSE_NAME)),
            type_definition: ExpandedNodeId::new(ObjectTypeId::FolderType),
            browse_name: QualifiedName::new(ns_idx, TAGS_FOLDER_BROWSE_NAME),
            display_name: LocalizedText::new("", "Tags"),
            node_class: NodeClass::Object,
        }
    }

    /// Build a tag-node's metadata from its registry entry.
    fn tag_node_metadata(
        &self,
        ns_idx: u16,
        tag: &crate::opc_ua_server::OpcUaTagNode,
    ) -> opcua::server::node_manager::NodeMetadata {
        opcua::server::node_manager::NodeMetadata {
            node_id: ExpandedNodeId::new(NodeId::new(ns_idx, tag.browse_name.as_str())),
            type_definition: ExpandedNodeId::new(VariableTypeId::BaseDataVariableType),
            browse_name: QualifiedName::new(ns_idx, tag.browse_name.as_str()),
            display_name: LocalizedText::new("", &tag.tag_name),
            node_class: NodeClass::Variable,
        }
    }

    /// Step 2 — ObjectsFolder browse: contribute a forward
    /// HasComponent reference to the Suderra root. Only forward
    /// references; the core manager owns ObjectsFolder + handles
    /// any inverse direction.
    fn browse_objects_folder_attach(
        &self,
        node: &mut BrowseNode,
        type_tree: &DefaultTypeTree,
        ns_idx: u16,
    ) {
        if !matches!(
            node.browse_direction(),
            BrowseDirection::Forward | BrowseDirection::Both
        ) {
            return;
        }
        if !node.allows_reference_type(&ReferenceTypeId::HasComponent.into(), type_tree) {
            return;
        }

        let metadata = self.suderra_root_metadata(ns_idx);
        let ref_desc = metadata.into_ref_desc(true, ReferenceTypeId::HasComponent);
        // ObjectsFolder browse is one ref — no continuation
        // point handling needed (max_references_per_node is
        // bounded but always >= 1 in practice; if it's 0 the
        // ref drops + the runtime treats that as the BrowseNode
        // already-full case).
        if let AddReferenceResult::Full(_) = node.add(type_tree, ref_desc) {
            // Defense-in-depth: stash even a single reference
            // if the node is full from prior managers' adds.
            let mut cp = SuderraBrowseCp::default();
            cp.refs.push_back(
                self.suderra_root_metadata(ns_idx)
                    .into_ref_desc(true, ReferenceTypeId::HasComponent),
            );
            node.set_next_continuation_point(Box::new(cp));
        }
    }

    /// Step 3 — Suderra root browse: forward = HasComponent →
    /// Tags + HasTypeDefinition → FolderType. Inverse =
    /// HasComponent inverse → ObjectsFolder.
    fn browse_suderra_root(&self, node: &mut BrowseNode, type_tree: &DefaultTypeTree, ns_idx: u16) {
        let mut cp = SuderraBrowseCp::default();

        if matches!(
            node.browse_direction(),
            BrowseDirection::Forward | BrowseDirection::Both
        ) {
            // HasComponent → Tags
            if node.allows_reference_type(&ReferenceTypeId::HasComponent.into(), type_tree)
                && node.allows_node_class(NodeClass::Object)
            {
                let ref_desc = self
                    .tags_folder_metadata(ns_idx)
                    .into_ref_desc(true, ReferenceTypeId::HasComponent);
                if let AddReferenceResult::Full(c) = node.add(type_tree, ref_desc) {
                    cp.refs.push_back(c);
                }
            }

            // HasTypeDefinition → FolderType
            if node.allows_reference_type(&ReferenceTypeId::HasTypeDefinition.into(), type_tree) {
                let ref_desc = ReferenceDescription {
                    reference_type_id: ReferenceTypeId::HasTypeDefinition.into(),
                    is_forward: true,
                    node_id: ExpandedNodeId::new(ObjectTypeId::FolderType),
                    browse_name: QualifiedName::new(0, "FolderType"),
                    display_name: LocalizedText::new("", "FolderType"),
                    node_class: NodeClass::ObjectType,
                    type_definition: ExpandedNodeId::null(),
                };
                if let AddReferenceResult::Full(c) = node.add(type_tree, ref_desc) {
                    cp.refs.push_back(c);
                }
            }
        }

        if matches!(
            node.browse_direction(),
            BrowseDirection::Inverse | BrowseDirection::Both
        ) {
            // HasComponent inverse → ObjectsFolder
            if node.allows_reference_type(&ReferenceTypeId::HasComponent.into(), type_tree) {
                let ref_desc = ReferenceDescription {
                    reference_type_id: ReferenceTypeId::HasComponent.into(),
                    is_forward: false,
                    node_id: ExpandedNodeId::new(ObjectId::ObjectsFolder),
                    browse_name: QualifiedName::new(0, "Objects"),
                    display_name: LocalizedText::new("", "Objects"),
                    node_class: NodeClass::Object,
                    type_definition: ExpandedNodeId::new(ObjectTypeId::FolderType),
                };
                if let AddReferenceResult::Full(c) = node.add(type_tree, ref_desc) {
                    cp.refs.push_back(c);
                }
            }
        }

        if !cp.refs.is_empty() {
            node.set_next_continuation_point(Box::new(cp));
        }
    }

    /// Step 4 — Tags folder browse: forward = HasComponent → each
    /// tag in registry + HasTypeDefinition → FolderType. Inverse
    /// = HasComponent inverse → Suderra root.
    fn browse_tags_folder(&self, node: &mut BrowseNode, type_tree: &DefaultTypeTree, ns_idx: u16) {
        let mut cp = SuderraBrowseCp::default();

        if matches!(
            node.browse_direction(),
            BrowseDirection::Forward | BrowseDirection::Both
        ) {
            // HasComponent → each tag — iteration order is
            // OpcUaTagRegistry's BTreeMap order (lexicographic
            // by tag_name); this gives HMIs a deterministic
            // browse response across reconnects.
            if node.allows_reference_type(&ReferenceTypeId::HasComponent.into(), type_tree)
                && node.allows_node_class(NodeClass::Variable)
            {
                for tag in self.tag_registry.iter() {
                    let ref_desc = self
                        .tag_node_metadata(ns_idx, tag)
                        .into_ref_desc(true, ReferenceTypeId::HasComponent);
                    match node.add(type_tree, ref_desc) {
                        AddReferenceResult::Added => {}
                        AddReferenceResult::Full(c) => {
                            cp.refs.push_back(c);
                        }
                        AddReferenceResult::Rejected => {}
                    }
                }
            }

            // HasTypeDefinition → FolderType
            if node.allows_reference_type(&ReferenceTypeId::HasTypeDefinition.into(), type_tree) {
                let ref_desc = ReferenceDescription {
                    reference_type_id: ReferenceTypeId::HasTypeDefinition.into(),
                    is_forward: true,
                    node_id: ExpandedNodeId::new(ObjectTypeId::FolderType),
                    browse_name: QualifiedName::new(0, "FolderType"),
                    display_name: LocalizedText::new("", "FolderType"),
                    node_class: NodeClass::ObjectType,
                    type_definition: ExpandedNodeId::null(),
                };
                if let AddReferenceResult::Full(c) = node.add(type_tree, ref_desc) {
                    cp.refs.push_back(c);
                }
            }
        }

        if matches!(
            node.browse_direction(),
            BrowseDirection::Inverse | BrowseDirection::Both
        ) {
            if node.allows_reference_type(&ReferenceTypeId::HasComponent.into(), type_tree) {
                let ref_desc = self
                    .suderra_root_metadata(ns_idx)
                    .into_ref_desc(false, ReferenceTypeId::HasComponent);
                if let AddReferenceResult::Full(c) = node.add(type_tree, ref_desc) {
                    cp.refs.push_back(c);
                }
            }
        }

        if !cp.refs.is_empty() {
            node.set_next_continuation_point(Box::new(cp));
        }
    }

    /// Step 5 — per-tag node browse: forward = HasTypeDefinition
    /// → BaseDataVariableType. Inverse = HasComponent inverse →
    /// Tags. The tag's ATTRIBUTE values (Value, DataType,
    /// AccessLevel, etc.) are reachable via Read service — NOT
    /// via Browse — and live in `read()` (Batch #264) +
    /// Batch #289b extension.
    fn browse_tag_node(
        &self,
        node: &mut BrowseNode,
        type_tree: &DefaultTypeTree,
        ns_idx: u16,
        _tag: &crate::opc_ua_server::OpcUaTagNode,
    ) {
        let mut cp = SuderraBrowseCp::default();

        if matches!(
            node.browse_direction(),
            BrowseDirection::Forward | BrowseDirection::Both
        ) {
            if node.allows_reference_type(&ReferenceTypeId::HasTypeDefinition.into(), type_tree) {
                let ref_desc = ReferenceDescription {
                    reference_type_id: ReferenceTypeId::HasTypeDefinition.into(),
                    is_forward: true,
                    node_id: ExpandedNodeId::new(VariableTypeId::BaseDataVariableType),
                    browse_name: QualifiedName::new(0, "BaseDataVariableType"),
                    display_name: LocalizedText::new("", "BaseDataVariableType"),
                    node_class: NodeClass::VariableType,
                    type_definition: ExpandedNodeId::null(),
                };
                if let AddReferenceResult::Full(c) = node.add(type_tree, ref_desc) {
                    cp.refs.push_back(c);
                }
            }
        }

        if matches!(
            node.browse_direction(),
            BrowseDirection::Inverse | BrowseDirection::Both
        ) {
            if node.allows_reference_type(&ReferenceTypeId::HasComponent.into(), type_tree) {
                let ref_desc = self
                    .tags_folder_metadata(ns_idx)
                    .into_ref_desc(false, ReferenceTypeId::HasComponent);
                if let AddReferenceResult::Full(c) = node.add(type_tree, ref_desc) {
                    cp.refs.push_back(c);
                }
            }
        }

        if !cp.refs.is_empty() {
            node.set_next_continuation_point(Box::new(cp));
        }
    }
}

// =============================================================
// SensNodeManagerBuilder — Batch #289 A-2b part 5 step 5c prep
// =============================================================
//
// ## Why a named builder type
//
// async-opcua's `ServerBuilder.with_node_manager(...)` accepts
// `impl NodeManagerBuilder + 'static`. The trait's blanket impl
// (`async-opcua-server-0.18.0/src/node_manager/build.rs:17-24`)
// covers `FnOnce(ServerContext) -> R: NodeManager`, so a closure
// would compile — but a closure carries an opaque type
// signature that:
//
// 1. Hides the dependency surface from operators reading
//    `opc_ua_server_runtime.rs` (the boot site that lands the
//    swap in Batch #290).
// 2. Cannot be unit-tested in isolation — closures synthesize
//    a fresh anonymous type per definition site, so the
//    "builder constructs SensNodeManager with the correct deps"
//    invariant has no testable surface without going through
//    the full ServerBuilder lifecycle.
// 3. Cannot be stored in `Box<dyn NodeManagerBuilder>` for
//    runtime composition (e.g., feature-flag-gated builder
//    selection in Batch #290+ when SensAuthManager wires).
//
// `SensNodeManagerBuilder` is the named primitive that:
// - Carries the dependency Arcs as struct fields (visible at
//   construction site).
// - Implements `NodeManagerBuilder` via the explicit trait impl
//   (not the closure blanket) — discoverable + testable.
// - Constructs `SensNodeManager` in `build()`, which is invoked
//   by async-opcua's runtime AFTER the server's
//   `ServerContext` is ready (i.e., after the type-tree +
//   namespace registry are wired). This timing is load-bearing
//   for the Batch #290 swap because `SensNodeManager.init()`
//   needs a `&mut DefaultTypeTree` from the trait method
//   parameter — registering the namespace EARLIER (e.g., from
//   the builder constructor) would diverge from the canonical
//   pattern.
//
// ## Wire status (Batch #289)
//
// **Primitive only.** This batch lands the named-type +
// trait-impl + smoke tests; it does NOT replace the
// `simple_node_manager(...)` call in
// `opc_ua_server_runtime.rs:280`. That swap is Batch #290.
// The reason for the split: replacing simple_node_manager
// requires also gutting `populate_tag_nodes` (which depends
// on `SimpleNodeManager.address_space()`) + threading the
// dependency Arcs through `build_server` / `start_opcua_server`
// — a 7-file refactor that benefits from having the builder
// primitive ALREADY tested + landed before the call-site
// migration begins.
//
// ## Linked findings
//
// - **ULTRA-HIGH-039 RESOLVED** (Batch #287, step 5a) —
//   namespace registration. SensNodeManagerBuilder.build()
//   eventually triggers SensNodeManager.init() which performs
//   that registration.
// - **ULTRA-HIGH-040 RESOLVED** (Batch #288, step 5b) —
//   browse() implementation. Builder constructs the manager
//   that holds the browse() body.
// - **ULTRA-HIGH-035 PARTIAL_FIX** — overall A-2b part 5;
//   sub-steps 5c-5f remain. 5c (this batch) lands the builder
//   primitive; 5d-5f remain unchanged.

/// Named builder type for `SensNodeManager`. Implements
/// `async_opcua::server::node_manager::NodeManagerBuilder` so
/// `ServerBuilder.with_node_manager(...)` accepts it directly.
///
/// **Construction model.** All dependency Arcs are passed at
/// builder-construction time (i.e., at boot, in
/// `start_opcua_server`). The builder is then handed off to
/// async-opcua's `ServerBuilder`, which calls `build()` exactly
/// once during server-construction — the consumed `Box<Self>`
/// (per `NodeManagerBuilder` trait signature) means duplicate
/// builder reuse fails at compile time (Tier-1
/// "make-it-impossible" against accidental double-registration).
///
/// **Invariant: the dependency Arcs survive the move.** Cargo's
/// `Arc::clone` is cheap (atomic refcount bump) but here we
/// MOVE the original Arcs into the builder; the manager
/// constructed from them inherits ownership. No clones happen
/// in the build path itself — the caller has already cloned
/// when threading from `AppState` to the builder constructor.
#[cfg(feature = "opc-ua-server")]
pub struct SensNodeManagerBuilder {
    /// Tenant binding — load-bearing for cross-tenant authz
    /// rejection. SensNodeManager.write() consumes this via
    /// `TypedAuthzPort::authorize_write`'s implicit tenant
    /// gate.
    tenant_id: TenantId,

    /// Typed authz port. Composes the policy engine + the
    /// session-actor resolver into one trait object. Held as
    /// `Arc<dyn ...>` so the production composition (e.g.,
    /// `ManifestBackedTypedAuthz`) and test mocks satisfy the
    /// same construction signature.
    authz: Arc<dyn TypedAuthzPort>,

    /// User-token validator (Batch #245). Bridges the
    /// AuthManager (Batch #266) session-establish path to the
    /// per-write defense-in-depth re-validation path.
    validator: Arc<UserTokenValidator>,

    /// In-memory tag-value store. SensNodeManager.read() takes
    /// snapshots from here; SensNodeManager.write() commits to
    /// here (Batch #292 wire pending — currently sets Good
    /// without commit).
    process_image: Arc<ProcessImage>,

    /// OPC UA address-space tag catalog. SensNodeManager.read()
    /// + SensNodeManager.write() + SensNodeManager.browse() all
    /// resolve incoming NodeIds against this catalog.
    tag_registry: Arc<OpcUaTagRegistry>,

    /// **Batch #291 5f-wire field.** Force-registry port for
    /// the SensNodeManager.write() Allow-path delegate. The
    /// production adapter is `ForceRegistryOpcUaAdapter`;
    /// tests substitute mocks.
    write_force: Arc<dyn OpcUaForceRegistryPort>,

    /// **Batch #291 5f-wire field.** Process-image port for
    /// write-commit. Distinct from `process_image` above
    /// because the read path uses concrete ProcessImage
    /// (get_tag) while write path uses trait
    /// (write_tag with actor for audit).
    write_process_image: Arc<dyn OpcUaProcessImagePort>,

    /// **Batch #291 5f-wire field.** Audit port. Every Allow
    /// outcome (commit success or pre-commit reject or
    /// commit error) fires `record_write_attempt` via the
    /// delegate.
    write_audit: Arc<dyn OpcUaAuditPort>,

    /// **Batch #325 D-9 migration field.** Clock authority
    /// threaded through the builder so SensNodeManager
    /// constructed via build() inherits the same clock
    /// the rest of the agent uses (AppState's
    /// clock_authority).
    clock: Arc<dyn crate::runtime_safety::ClockAuthority>,
}

#[cfg(feature = "opc-ua-server")]
impl SensNodeManagerBuilder {
    /// Construct a new builder with all dependency Arcs.
    ///
    /// **Caller contract.** The Arcs supplied here are
    /// long-lived (clone count >= 2 — the caller's copy + the
    /// builder's copy). The builder consumes its copy when
    /// `build()` is called, transferring ownership to the
    /// `SensNodeManager` instance.
    ///
    /// **Why a constructor (vs. struct-literal access).**
    /// The struct's fields are `pub(crate)` (NOT `pub`) so
    /// downstream crates cannot construct an
    /// `SensNodeManagerBuilder` without going through this
    /// function. Tier-1 "make-it-impossible" against
    /// half-initialized builders that omit a load-bearing
    /// dependency.
    pub fn new(
        tenant_id: TenantId,
        authz: Arc<dyn TypedAuthzPort>,
        validator: Arc<UserTokenValidator>,
        process_image: Arc<ProcessImage>,
        tag_registry: Arc<OpcUaTagRegistry>,
        write_force: Arc<dyn OpcUaForceRegistryPort>,
        write_process_image: Arc<dyn OpcUaProcessImagePort>,
        write_audit: Arc<dyn OpcUaAuditPort>,
        // Batch #325 D-9 migration: 9th param threads the
        // clock through the builder.
        clock: Arc<dyn crate::runtime_safety::ClockAuthority>,
    ) -> Self {
        Self {
            tenant_id,
            authz,
            validator,
            process_image,
            tag_registry,
            write_force,
            write_process_image,
            write_audit,
            clock,
        }
    }
}

// =============================================================
// SensRuntimeBundle — Batch #293 A-2b 5d (auth manager wire) prep
// =============================================================
//
// ## Why a bundle struct
//
// async-opcua's ServerBuilder has TWO production-relevant
// extension points for the typed-authz path:
//
//   1. `with_node_manager(...)` — registers the
//      SensNodeManagerBuilder so SensNodeManager owns the
//      Suderra namespace's read/write/browse trait methods
//      (Batches #263-#291).
//   2. `with_authenticator(...)` — registers the
//      SensAuthManager (Batch #266 primitive) so the
//      session-establish path produces a UserToken in the
//      Suderra format (sens:operator:<32-hex>) that
//      SensNodeManager.write() (Batch #265) can parse via
//      `parse_operator_token` to extract the typed
//      AuthenticatedUser principal.
//
// The two extension points are LINKED by the UserToken
// format contract: SensAuthManager produces the token
// shape SensNodeManager.write() consumes. Wiring one
// without the other creates a half-built typed-authz path
// (HMI sessions establish but writes can't extract the
// typed principal, OR writes find a typed principal but
// the session-establish path produces a non-Suderra
// format → parse fails → fail-closed). Either half-build
// is invisible at compile time but observable as runtime
// regressions.
//
// `SensRuntimeBundle` makes the link structural: callers
// construct ONE bundle that carries both halves; they
// can't accidentally wire one without the other. The
// build_server + start_opcua_server signatures consume
// the bundle as a single unit.
//
// ## Tier-1 architectural shape
//
// - **Make it impossible.** The bundle's fields are `pub`
//   only on the named-construction path
//   (`SensRuntimeBundle::new(...)` not exposed; struct
//   literal construction at the boot site). A future
//   typed-authz consumer cannot accidentally consume one
//   half — the two extension points are now atomic.
// - **Make it automatic.** `build_server` consumes the
//   bundle in one match arm, calling
//   `with_node_manager(bundle.node_manager_builder)` AND
//   `with_authenticator(bundle.auth_manager)` in the same
//   branch. Forgetting one would compile, but the
//   docstring + the field naming make the omission
//   visible in code review.
//
// ## Wire status (Batch #293)
//
// The bundle TYPE lands here as a primitive. The actual
// production-callsite construction (in
// `init_opc_ua_server`) lives in `opc_ua_server_runtime.rs`
// — that's where the dependency Arcs are available + where
// the bundle is built + passed to start_opcua_server.

/// Production runtime bundle for the SensNodeManager + SensAuthManager
/// extension points on async-opcua's ServerBuilder. Constructed once
/// at boot in `init_opc_ua_server` when all dependencies are present
/// (tenant + audit + user_token_manifest_store + RBAC manifest).
///
/// **Linked findings.** ULTRA-HIGH-035 PARTIAL_FIX (overall A-2b
/// part 5). Batch #293 wires this into init_opc_ua_server +
/// passes Some(bundle) to start_opcua_server, completing the
/// runtime-level swap (5c + 5d combined).
#[cfg(feature = "opc-ua-server")]
pub struct SensRuntimeBundle {
    /// SensNodeManagerBuilder primitive (Batch #289).
    /// async-opcua's `ServerBuilder.with_node_manager(...)`
    /// consumes this via `Box<dyn NodeManagerBuilder>` (the
    /// blanket impl handles boxing automatically).
    pub node_manager_builder: SensNodeManagerBuilder,

    /// SensAuthManager (Batch #266 primitive). async-opcua's
    /// `ServerBuilder.with_authenticator(...)` consumes
    /// `Arc<dyn AuthManager>` — Arc-wrap at construction
    /// time so the type system records the trait-object
    /// promotion explicitly.
    pub auth_manager: Arc<crate::opc_ua_sens_auth_manager::SensAuthManager>,
}

#[cfg(feature = "opc-ua-server")]
impl SensRuntimeBundle {
    /// Construct a new bundle. Both halves of the typed-authz
    /// runtime contract enter the type system as ONE value —
    /// the bundle cannot be partially constructed.
    pub fn new(
        node_manager_builder: SensNodeManagerBuilder,
        auth_manager: Arc<crate::opc_ua_sens_auth_manager::SensAuthManager>,
    ) -> Self {
        Self {
            node_manager_builder,
            auth_manager,
        }
    }
}

#[cfg(feature = "opc-ua-server")]
impl NodeManagerBuilder for SensNodeManagerBuilder {
    /// Construct the manager. async-opcua's runtime calls this
    /// once during `ServerBuilder.build()`. The returned
    /// `Arc<DynNodeManager>` is what the runtime stores in its
    /// per-server NodeManager registry.
    ///
    /// **The `_context: ServerContext` is intentionally
    /// ignored.** SensNodeManager owns its own
    /// `Arc<RwLock<Option<u16>>>` for the namespace_index +
    /// receives the type_tree via the trait method `init`
    /// parameter (per the canonical async-opcua pattern). We
    /// don't store anything from `context` here because doing
    /// so would race with `init` for the namespace registration
    /// call — keeping init as the sole writer is load-bearing
    /// for the Tier-1 "make-it-impossible" property of the
    /// `current_namespace_index().await` reader.
    fn build(self: Box<Self>, _context: ServerContext) -> Arc<DynNodeManager> {
        Arc::new(SensNodeManager::new(
            self.tenant_id,
            self.authz,
            self.validator,
            self.process_image,
            self.tag_registry,
            self.write_force,
            self.write_process_image,
            self.write_audit,
            // Batch #325 D-9 migration: thread the
            // clock from builder to manager.
            self.clock,
        ))
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
pub(crate) const OPERATOR_TOKEN_PREFIX: &str = "sens:operator:";

/// Encode an `OperatorId` into the stable UserToken string format.
/// Used by Batch #266 `SensAuthManager::authenticate_username_
/// identity_token` after a successful credential verify.
///
/// **Wire status (Batch #265):** function definition only;
/// production caller is the not-yet-landed SensAuthManager. Held
/// here so the write-path parse + the auth-path encode share one
/// definition (single source of truth — no token format drift).
#[cfg(feature = "opc-ua-server")]
pub(crate) fn format_operator_token(operator_id: &crate::authz::permission::OperatorId) -> String {
    let mut hex = String::with_capacity(OPERATOR_TOKEN_PREFIX.len() + 32);
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
pub(crate) fn parse_operator_token(
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
    Some(crate::authz::permission::OperatorId::new_from_verified(
        bytes,
    ))
}

/// **Batch #291 5f-wire helper.** Coerce an incoming OPC UA
/// `Variant` to the canonical f64 SensNodeManager + ProcessImage
/// store every tag in.
///
/// Suderra's process image stores every tag as f64 (Batch #264
/// architectural decision — single numeric representation for
/// the bytecode VM + audit + SCADA UI). HMIs may write any
/// numeric Variant; we accept the lossless conversions
/// (Boolean/u8/i8/u16/i16/u32/i32/f32 all fit in f64 without
/// rounding) and the lossy-but-bounded conversions (i64/u64
/// outside ±2^53 lose precision; we reject those defensively).
/// String / non-numeric Variants reject with `None` →
/// caller maps to `BadTypeMismatch`.
///
/// **Boolean handling.** OPC UA spec encodes Boolean as a
/// distinct Variant variant (not 0/1 numeric). Suderra's
/// canonical representation: false=0.0, true=1.0. ProcessImage
/// readers (bytecode VM, alarm engine, SCADA polling) interpret
/// f64 with that convention.
///
/// **Wire status (Batch #291):** consumed by SensNodeManager.
/// write() Allow path. Helper kept module-private until a
/// second consumer needs it.
#[cfg(feature = "opc-ua-server")]
fn cast_variant_to_f64(variant: &opcua::types::Variant) -> Option<f64> {
    use opcua::types::Variant;
    match variant {
        Variant::Boolean(b) => Some(if *b { 1.0 } else { 0.0 }),
        Variant::SByte(v) => Some(*v as f64),
        Variant::Byte(v) => Some(*v as f64),
        Variant::Int16(v) => Some(*v as f64),
        Variant::UInt16(v) => Some(*v as f64),
        Variant::Int32(v) => Some(*v as f64),
        Variant::UInt32(v) => Some(*v as f64),
        Variant::Int64(v) => {
            // Reject silently-lossy conversion. f64 can
            // exactly represent integers in ±2^53; outside
            // that the cast loses precision. A future Batch
            // may widen ProcessImage to carry i64 alongside
            // f64; today we fail-closed.
            const MAX_EXACT: i64 = 1i64 << 53;
            if *v >= -MAX_EXACT && *v <= MAX_EXACT {
                Some(*v as f64)
            } else {
                None
            }
        }
        Variant::UInt64(v) => {
            const MAX_EXACT: u64 = 1u64 << 53;
            if *v <= MAX_EXACT {
                Some(*v as f64)
            } else {
                None
            }
        }
        Variant::Float(v) => Some(*v as f64),
        Variant::Double(v) => Some(*v),
        // String / NodeId / DataValue / ExtensionObject /
        // arrays / etc — non-numeric. Reject so HMI clients
        // get an explicit BadTypeMismatch rather than a
        // silent cast to NaN/0.0.
        _ => None,
    }
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
fn quality_to_opcua_status(quality: &crate::process_image::TagQuality) -> opcua::types::StatusCode {
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
        let bad = "sens:operator:0123456789abcdef0123456789abcd";
        assert!(parse_operator_token(bad).is_none());
    }

    #[test]
    fn parse_rejects_long_payload() {
        // Prefix + 34 hex chars — payload too long.
        let bad = "sens:operator:0123456789abcdef0123456789abcdef00";
        assert!(parse_operator_token(bad).is_none());
    }

    #[test]
    fn parse_rejects_non_hex_payload() {
        // Prefix + 32 chars but one is 'g' (not hex).
        let bad = "sens:operator:0123456789abcdef0123456789abcdeg";
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

    // =========================================================
    // browse() helpers — Batch #288 A-2b part 5 step 5b
    // (re-specified per ORPHAN-HIGH-027)
    // =========================================================
    //
    // The canonical async-opcua trait-method `browse()` cannot
    // be unit-tested in isolation — `BrowseNode` requires a full
    // `BrowseDescription` envelope + a session-bound result mask
    // + an active `RequestContext` (DefaultTypeTree must be wired
    // through the server runtime). That's an integration test
    // surface (Batch #289 paired with the runtime-swap landing).
    //
    // What we CAN unit-test is the metadata builders + the
    // browse-name SSoT constants, which are the load-bearing
    // primitives the trait-method body composes. A drift in any
    // of these (e.g., a copy-paste typo `"Suderra"` →
    // `"suderra"`) would fail every Browse roundtrip + every
    // HMI's recursive node discovery — these tests pin the
    // canonical shape so that drift fails at unit-test time
    // instead of at the integration-test boundary.

    use crate::authz::context::{AuthorizationDenyReason, AuthorizedContext};
    use crate::authz::user_token_manifest_runtime::UserTokenManifestStore;
    use crate::opc_ua_server::{
        OpcUaAuditPort, OpcUaForceRegistryPort, OpcUaProcessImagePort, OpcUaTagRegistry,
        OpcUaWriteOutcome,
    };
    use crate::opc_ua_server_session::AuthenticatedUser;
    use crate::opc_ua_server_typed_authz::{TypedAuthzError, TypedAuthzPort};
    use crate::process_image::{IoType, ProcessImage};

    /// Build a SensNodeManager with empty tag_registry — used
    /// by the metadata-builder tests to exercise the helper
    /// methods without real tags. Mock authz/validator is OK
    /// because the metadata builders never invoke them.
    fn test_manager() -> SensNodeManager {
        // Mock TypedAuthzPort that always denies. The metadata
        // builders never call authorize_write, so the impl is
        // unreachable from these tests.
        struct MockAuthz;
        #[async_trait]
        impl TypedAuthzPort for MockAuthz {
            async fn authorize_write(
                &self,
                _user: &AuthenticatedUser,
                _tag_name: &str,
                _received_at: std::time::SystemTime,
            ) -> Result<AuthorizedContext, TypedAuthzError> {
                // Mock returns a deny variant; the metadata
                // helpers never reach this branch — the test
                // only constructs the manager.
                Err(TypedAuthzError::EngineDenied(
                    AuthorizationDenyReason::PermissionNotGranted,
                ))
            }
        }
        let authz: Arc<dyn TypedAuthzPort> = Arc::new(MockAuthz);

        // Build a minimal UserTokenValidator. The metadata
        // helpers never invoke validator.with_enrollment; we
        // just need a valid Arc to satisfy the field type.
        let store = Arc::new(UserTokenManifestStore::new());
        let validator = Arc::new(UserTokenValidator::new(store));

        let process_image = Arc::new(ProcessImage::new());
        let tag_registry = Arc::new(OpcUaTagRegistry::default());
        let tenant = TenantId::new_from_verified([0u8; 16]);

        // Mock 3 write ports — only Send+Sync matters for the
        // metadata-builder tests (they never call write()).
        struct MockForce;
        #[async_trait]
        impl OpcUaForceRegistryPort for MockForce {
            async fn is_forced(&self, _tag_name: &str) -> bool {
                false
            }
        }
        struct MockPi;
        #[async_trait]
        impl OpcUaProcessImagePort for MockPi {
            async fn write_tag(
                &self,
                _tag_name: &str,
                _value: f64,
                _actor: &str,
            ) -> Result<(), String> {
                Ok(())
            }
        }
        struct MockAudit;
        #[async_trait]
        impl OpcUaAuditPort for MockAudit {
            async fn record_write_attempt(
                &self,
                _actor: &str,
                _tag_name: &str,
                _value: f64,
                _outcome: &OpcUaWriteOutcome,
            ) {
            }
        }
        let write_force: Arc<dyn OpcUaForceRegistryPort> = Arc::new(MockForce);
        let write_process_image: Arc<dyn OpcUaProcessImagePort> = Arc::new(MockPi);
        let write_audit: Arc<dyn OpcUaAuditPort> = Arc::new(MockAudit);

        SensNodeManager::new(
            tenant,
            authz,
            validator,
            process_image,
            tag_registry,
            write_force,
            write_process_image,
            write_audit,
            // Batch #325 D-9: test fixture clock — fresh
            // SystemClockAuthority for the trustworthy
            // wallclock gate.
            Arc::new(crate::runtime_safety::SystemClockAuthority::new()),
        )
    }

    #[test]
    fn suderra_root_metadata_uses_canonical_browse_name() {
        let mgr = test_manager();
        let meta = mgr.suderra_root_metadata(7);
        // NodeId.namespace must equal the assigned ns_idx
        // (caller passes the namespace_index from init()).
        assert_eq!(
            meta.node_id.node_id.namespace, 7,
            "Suderra root NodeId namespace must equal init-assigned ns_idx"
        );
        // browse_name canonicalized as "Suderra"
        assert_eq!(meta.browse_name.name.as_ref(), SUDERRA_ROOT_BROWSE_NAME);
        // type_definition is FolderType (Suderra is an Object
        // organizing its children — same shape as ObjectsFolder).
        // PartialEq impl `NodeId == ObjectTypeId` is provided
        // by opcua_types — pass the enum variant directly (no
        // `.into()` to avoid impl ambiguity).
        assert!(meta.type_definition.node_id == ObjectTypeId::FolderType);
        // node_class
        assert_eq!(meta.node_class, NodeClass::Object);
    }

    #[test]
    fn tags_folder_metadata_uses_canonical_browse_name() {
        let mgr = test_manager();
        let meta = mgr.tags_folder_metadata(13);
        assert_eq!(meta.node_id.node_id.namespace, 13);
        assert_eq!(meta.browse_name.name.as_ref(), TAGS_FOLDER_BROWSE_NAME);
        assert!(meta.type_definition.node_id == ObjectTypeId::FolderType);
        assert_eq!(meta.node_class, NodeClass::Object);
    }

    #[test]
    fn tag_node_metadata_uses_browse_name_as_identifier() {
        let mgr = test_manager();
        let tag = crate::opc_ua_server::OpcUaTagNode {
            tag_name: "tank/a:flow".to_string(),
            browse_name: "tank_a_flow".to_string(),
            io_type: IoType::AI,
            data_type: "Real".to_string(),
            eng_unit: Some("L/min".to_string()),
            eng_min: Some(0.0),
            eng_max: Some(100.0),
        };
        let meta = mgr.tag_node_metadata(5, &tag);
        // NodeId.identifier carries browse_name (sanitized) —
        // NOT tag_name (which may have characters HMIs can't
        // round-trip).
        let id_str = match &meta.node_id.node_id.identifier {
            opcua::types::Identifier::String(s) => s.to_string(),
            _ => panic!("tag node id must use String identifier"),
        };
        assert_eq!(id_str, "tank_a_flow");
        // BrowseName carries the same browse_name.
        assert_eq!(meta.browse_name.name.as_ref(), "tank_a_flow");
        // DisplayName uses tag_name (the operator-facing name).
        assert_eq!(meta.display_name.text.as_ref(), "tank/a:flow");
        // type_definition: BaseDataVariableType (the canonical
        // base for Variable instance nodes that don't fit a
        // more specialized AnalogItemType / DataItemType).
        assert!(meta.type_definition.node_id == VariableTypeId::BaseDataVariableType);
        assert_eq!(meta.node_class, NodeClass::Variable);
    }

    #[test]
    fn browse_name_constants_are_immutable_ssot() {
        // Pin the canonical strings — a future refactor that
        // accidentally renames either constant without updating
        // the populate_tag_nodes path in opc_ua_server_runtime.rs
        // (which uses literal "Suderra" / "Tags" too) would
        // diverge the SimpleNodeManager + SensNodeManager browse
        // hierarchies. This test fails before that drift can ship.
        assert_eq!(SUDERRA_ROOT_BROWSE_NAME, "Suderra");
        assert_eq!(TAGS_FOLDER_BROWSE_NAME, "Tags");
    }

    // =========================================================
    // SensNodeManagerBuilder primitive — Batch #289 A-2b 5c prep
    // =========================================================

    /// Compile-time assertion: `SensNodeManagerBuilder` is
    /// `Send + Sync + 'static` — required by async-opcua's
    /// `ServerBuilder.with_node_manager(impl NodeManagerBuilder
    /// + 'static)` bound. A regression here (e.g., adding a
    /// non-Send field to the struct) breaks compilation of
    /// THIS test before it can break the runtime swap in
    /// Batch #290.
    #[test]
    fn sens_node_manager_builder_is_send_sync_static() {
        fn assert_bounds<T: Send + Sync + 'static>() {}
        assert_bounds::<SensNodeManagerBuilder>();
    }

    /// Compile-time assertion: `SensNodeManagerBuilder`
    /// implements `NodeManagerBuilder`. async-opcua's
    /// `with_node_manager(...)` requires this — the assertion
    /// catches a future signature drift in the trait (e.g., an
    /// async-opcua upgrade that adds a mandatory builder
    /// method) at TEST COMPILE TIME instead of at boot time.
    #[test]
    fn sens_node_manager_builder_implements_trait() {
        fn assert_impl<T: NodeManagerBuilder>() {}
        assert_impl::<SensNodeManagerBuilder>();
    }

    /// Smoke test: builder constructor accepts the dependency
    /// Arcs in the documented order + the resulting struct
    /// retains them. We assert the retention via
    /// `Arc::strong_count` — every Arc passed in becomes the
    /// 2nd reference (1st is the caller's copy left in the
    /// test harness; 2nd is the builder's copy).
    #[test]
    fn builder_new_retains_each_dependency_arc() {
        struct MockAuthz;
        #[async_trait]
        impl TypedAuthzPort for MockAuthz {
            async fn authorize_write(
                &self,
                _user: &AuthenticatedUser,
                _tag_name: &str,
                _received_at: std::time::SystemTime,
            ) -> Result<AuthorizedContext, TypedAuthzError> {
                Err(TypedAuthzError::EngineDenied(
                    AuthorizationDenyReason::PermissionNotGranted,
                ))
            }
        }
        let authz: Arc<dyn TypedAuthzPort> = Arc::new(MockAuthz);
        let store = Arc::new(UserTokenManifestStore::new());
        let validator = Arc::new(UserTokenValidator::new(store));
        let process_image = Arc::new(ProcessImage::new());
        let tag_registry = Arc::new(OpcUaTagRegistry::default());
        let tenant = TenantId::new_from_verified([0u8; 16]);

        // 3 new write-port mocks (Batch #291 5f-wire fields).
        struct MockForce2;
        #[async_trait]
        impl OpcUaForceRegistryPort for MockForce2 {
            async fn is_forced(&self, _tag_name: &str) -> bool {
                false
            }
        }
        struct MockPi2;
        #[async_trait]
        impl OpcUaProcessImagePort for MockPi2 {
            async fn write_tag(
                &self,
                _tag_name: &str,
                _value: f64,
                _actor: &str,
            ) -> Result<(), String> {
                Ok(())
            }
        }
        struct MockAudit2;
        #[async_trait]
        impl OpcUaAuditPort for MockAudit2 {
            async fn record_write_attempt(
                &self,
                _actor: &str,
                _tag_name: &str,
                _value: f64,
                _outcome: &OpcUaWriteOutcome,
            ) {
            }
        }
        let write_force: Arc<dyn OpcUaForceRegistryPort> = Arc::new(MockForce2);
        let write_process_image: Arc<dyn OpcUaProcessImagePort> = Arc::new(MockPi2);
        let write_audit: Arc<dyn OpcUaAuditPort> = Arc::new(MockAudit2);

        // Pre-construction strong counts: each Arc has 1 ref
        // (the local binding).
        assert_eq!(Arc::strong_count(&authz), 1);
        assert_eq!(Arc::strong_count(&validator), 1);
        assert_eq!(Arc::strong_count(&process_image), 1);
        assert_eq!(Arc::strong_count(&tag_registry), 1);
        assert_eq!(Arc::strong_count(&write_force), 1);
        assert_eq!(Arc::strong_count(&write_process_image), 1);
        assert_eq!(Arc::strong_count(&write_audit), 1);

        let builder = SensNodeManagerBuilder::new(
            tenant,
            authz.clone(),
            validator.clone(),
            process_image.clone(),
            tag_registry.clone(),
            write_force.clone(),
            write_process_image.clone(),
            write_audit.clone(),
            Arc::new(crate::runtime_safety::SystemClockAuthority::new()),
        );

        // Post-construction strong counts: builder holds a 2nd
        // ref. This proves the constructor stored each of the
        // 7 Arc fields (a missing field assignment would
        // leave the count at 1).
        assert_eq!(Arc::strong_count(&authz), 2);
        assert_eq!(Arc::strong_count(&validator), 2);
        assert_eq!(Arc::strong_count(&process_image), 2);
        assert_eq!(Arc::strong_count(&tag_registry), 2);
        assert_eq!(Arc::strong_count(&write_force), 2);
        assert_eq!(Arc::strong_count(&write_process_image), 2);
        assert_eq!(Arc::strong_count(&write_audit), 2);

        // Drop the builder — strong counts return to 1.
        drop(builder);
        assert_eq!(Arc::strong_count(&authz), 1);
        assert_eq!(Arc::strong_count(&validator), 1);
        assert_eq!(Arc::strong_count(&process_image), 1);
        assert_eq!(Arc::strong_count(&tag_registry), 1);
        assert_eq!(Arc::strong_count(&write_force), 1);
        assert_eq!(Arc::strong_count(&write_process_image), 1);
        assert_eq!(Arc::strong_count(&write_audit), 1);
    }

    // =========================================================
    // cast_variant_to_f64 tests — Batch #291 5f-wire helper
    // =========================================================

    #[test]
    fn cast_variant_boolean_maps_to_zero_one() {
        use opcua::types::Variant;
        assert_eq!(cast_variant_to_f64(&Variant::Boolean(false)), Some(0.0));
        assert_eq!(cast_variant_to_f64(&Variant::Boolean(true)), Some(1.0));
    }

    #[test]
    fn cast_variant_lossless_integers_round_trip() {
        use opcua::types::Variant;
        // SByte/Byte/Int16/UInt16/Int32/UInt32/Float all
        // fit in f64 exactly.
        assert_eq!(cast_variant_to_f64(&Variant::SByte(-42)), Some(-42.0));
        assert_eq!(cast_variant_to_f64(&Variant::Byte(200)), Some(200.0));
        assert_eq!(cast_variant_to_f64(&Variant::Int16(-1000)), Some(-1000.0));
        assert_eq!(cast_variant_to_f64(&Variant::UInt16(60000)), Some(60000.0));
        assert_eq!(
            cast_variant_to_f64(&Variant::Int32(-1_000_000)),
            Some(-1_000_000.0)
        );
        assert_eq!(
            cast_variant_to_f64(&Variant::UInt32(4_000_000_000)),
            Some(4_000_000_000.0)
        );
        assert_eq!(
            cast_variant_to_f64(&Variant::Float(3.14)),
            Some(3.14_f32 as f64)
        );
        assert_eq!(
            cast_variant_to_f64(&Variant::Double(2.71828)),
            Some(2.71828)
        );
    }

    #[test]
    fn cast_variant_rejects_lossy_int64() {
        use opcua::types::Variant;
        // Boundary: 2^53 fits exactly.
        let max_exact = 1i64 << 53;
        assert_eq!(
            cast_variant_to_f64(&Variant::Int64(max_exact)),
            Some(max_exact as f64)
        );
        assert_eq!(
            cast_variant_to_f64(&Variant::Int64(-max_exact)),
            Some(-max_exact as f64)
        );
        // Beyond ±2^53: reject (silent precision loss).
        assert_eq!(cast_variant_to_f64(&Variant::Int64(max_exact + 1)), None);
        assert_eq!(cast_variant_to_f64(&Variant::Int64(i64::MAX)), None);
        assert_eq!(cast_variant_to_f64(&Variant::Int64(i64::MIN)), None);
    }

    #[test]
    fn cast_variant_rejects_lossy_uint64() {
        use opcua::types::Variant;
        let max_exact = 1u64 << 53;
        assert_eq!(
            cast_variant_to_f64(&Variant::UInt64(max_exact)),
            Some(max_exact as f64)
        );
        assert_eq!(cast_variant_to_f64(&Variant::UInt64(max_exact + 1)), None);
        assert_eq!(cast_variant_to_f64(&Variant::UInt64(u64::MAX)), None);
    }

    #[test]
    fn cast_variant_rejects_string_and_non_numeric() {
        use opcua::types::Variant;
        // Strings reject — HMI must not write a string into
        // a numeric tag and have it silently coerce.
        assert_eq!(cast_variant_to_f64(&Variant::String("42".into())), None);
        assert_eq!(cast_variant_to_f64(&Variant::Empty), None);
    }

    #[test]
    fn suderra_browse_continuation_point_is_fifo() {
        // Continuation point drains in FIFO order — important
        // for browse determinism (HMIs see refs in the same
        // order across BrowseNext resumes). Mirror the pattern
        // DiagnosticsNodeManager uses.
        let mut cp = SuderraBrowseCp::default();
        let make = |id: u32| ReferenceDescription {
            reference_type_id: ReferenceTypeId::HasComponent.into(),
            is_forward: true,
            node_id: ExpandedNodeId::new(NodeId::new(0, id)),
            browse_name: QualifiedName::new(0, format!("n{}", id)),
            display_name: LocalizedText::null(),
            node_class: NodeClass::Variable,
            type_definition: ExpandedNodeId::null(),
        };
        cp.refs.push_back(make(1));
        cp.refs.push_back(make(2));
        cp.refs.push_back(make(3));
        // FIFO drain: pop_front yields 1, 2, 3 in order.
        let drained: Vec<u32> = std::iter::from_fn(|| {
            cp.refs
                .pop_front()
                .map(|r| match r.node_id.node_id.identifier {
                    opcua::types::Identifier::Numeric(n) => n,
                    _ => 0,
                })
        })
        .collect();
        assert_eq!(drained, vec![1, 2, 3]);
    }
}
