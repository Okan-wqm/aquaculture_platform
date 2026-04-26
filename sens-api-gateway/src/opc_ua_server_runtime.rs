//! OPC UA server runtime — Batch 216 Faz 5 feature-gated.
//!
//! Binds the Batch 207 config + Batch 208 registry + Batch
//! 209-212 write-orchestrator adapter quartet to the
//! `async-opcua 0.18` ServerBuilder. Entire module is scoped
//! to the `opc-ua-server` Cargo feature flag — when the
//! feature is OFF, the sibling stub module `opc_ua_server_
//! runtime_stub` provides `start_opcua_server` returning
//! `Ok(None)` so main.rs has a single unconditional call
//! site.
//!
//! This batch lands the SERVER LIFECYCLE primitive: bind,
//! listen, cancel. Address-space population (via
//! `OpcUaTagRegistry` → OPC UA Variable nodes) is Batch
//! 217's responsibility — the `async-opcua` NodeManager
//! trait is substantial enough to warrant its own primitive
//! + test surface. At Batch 216 the server boots with the
//! default `CoreNodeManager` only; browsing returns the
//! base OPC UA address space, no Suderra tags.
//!
//! Auth: anonymous-only for this batch. Username/password +
//! X509 arrive in a subsequent batch once operator token
//! plumbing lands (tokens must resolve into RBAC manifest
//! actors for the OpcUa authz adapter's ActorResolverFn to
//! pick up the identity).
//!
//! TLS: Basic256Sha256 + SignAndEncrypt per plan §5 Faz 5
//! step 7. `create_sample_keypair(true)` auto-generates a
//! keypair on first boot at `own_pki_dir`; operators can
//! later swap in a factory-issued cert + key via
//! `certificate_path` + `private_key_path` overrides (those
//! config surfaces land with the cert-lifecycle batch).
//!
//! ## Wire status (Batch #278 audit)
//!
//! Production wire confirmed:
//! - `main.rs::init_opcua_runtime` (boot-time) — when
//!   `feature = "opc-ua-server"` + `config.opc_ua_server.enabled
//!   = true`, this module's `start_opcua_server(...)` spawns the
//!   async-opcua server task under `tokio::spawn` + registers
//!   with the ShutdownCoordinator.
//! - SimpleNodeManager wire at line 259 + `add_write_callback`
//!   loop at line 985 wires the legacy actor=`opc-ua-anonymous`
//!   path. ORPHAN-CRITICAL-021 tracks the SensNodeManager
//!   replacement; Batch #267 swap deletes this loop.
//!
//! Per-item dead-code allow audit pending — the blanket allow
//! retains the alarm-server / event-server scaffolding that
//! lands with the OPC UA Alarms & Conditions extension batch
//! (ADR-019 §6 future). WHITELIST-with-reason classification.
//!
//! Linked: ORPHAN-CRITICAL-021 (this module's `simple_node_
//! manager` wire is the legacy path that Batch #267 replaces).

#![cfg(feature = "opc-ua-server")]
#![allow(dead_code)]

use std::sync::Arc;

use opcua::nodes::{AccessLevel, VariableBuilder};
use opcua::server::diagnostics::NamespaceMetadata;
use opcua::server::node_manager::memory::{simple_node_manager, SimpleNodeManager};
use opcua::server::{
    ServerBuilder, ServerEndpoint, ServerHandle, ANONYMOUS_USER_TOKEN_ID,
};
use opcua::types::{
    DataTypeId, LocalizedText, NodeId, ObjectId, QualifiedName, StatusCode, Variant,
};
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::audit::sink::AuditSink;
use crate::authz::context::ActorIdentity;
use crate::authz::in_memory_engine::InMemoryPolicyEngine;
use crate::authz::manifest_runtime::RbacManifestStore;
use crate::authz::permission::{OperatorId, TenantId};
use crate::config::OpcUaServerConfig;
use crate::license::{check_opc_ua_server_gate, EdgeLicenseLimits, OpcUaServerGate};
use crate::opc_ua_server::{
    AuditSinkOpcUaAdapter, ForceRegistryOpcUaAdapter, OpcUaAuditPort,
    OpcUaTagNode, OpcUaTagRegistry, OpcUaWriteOutcome,
    PolicyEngineOpcUaAdapter, PolicyVersionFn, ProcessImageOpcUaAdapter,
};
use crate::process_image::ProcessImage;
use crate::scripting::force_registry::ForceRegistry;

/// The Suderra edge-agent OPC UA namespace URI. Stable
/// across releases — HMIs cache NodeId references keyed on
/// this URI's resolved namespace index. Bumping requires a
/// coordinated client reconfiguration.
pub const SUDERRA_NAMESPACE_URI: &str = "urn:suderra:edge";

/// The async-opcua node-manager name used for the Suderra
/// SimpleNodeManager. Multiple managers can coexist
/// (core + diagnostics + ours); this name is the lookup
/// key used by `get_of_type::<SimpleNodeManager>()` tiebreak
/// logic when there's more than one.
const SUDERRA_NODE_MANAGER_NAME: &str = "suderra-tags";

/// Details of a single failed tag-node insertion. Batch
/// 227 (E-3 closure) structures the previous `warn!`-only
/// drop so callers can emit audit records + operators see
/// the exact rejection reason per tag.
#[derive(Debug, Clone, PartialEq)]
pub struct TagInsertionFailure {
    pub tag_name: String,
    pub browse_name: String,
    pub reason: &'static str,
}

/// Summary of the Suderra address-space population pass
/// (Batch 217, refined by Batch 227). Reported to boot logs
/// + `/metrics` so operators can confirm the tag catalog
/// made it into the OPC UA address space without parsing
/// async-opcua internal state.
#[derive(Debug, Clone, PartialEq)]
pub struct AddressSpacePopulationSummary {
    /// Namespace index assigned to `SUDERRA_NAMESPACE_URI`
    /// by the server at build time. HMIs address Suderra
    /// tag NodeIds as `ns={namespace_index};s={browse_name}`.
    pub namespace_index: u16,
    /// Number of variable nodes actually added to the
    /// address space. Equal to `registry.len()` on the
    /// happy path; short of it if any node collided with
    /// pre-existing entries.
    pub variable_nodes_added: usize,
    /// Subset of `variable_nodes_added` that were marked
    /// writable (DO + AO). Reported to boot log so
    /// operators see at a glance how many actuators an HMI
    /// could reach.
    pub writable_nodes: usize,
    /// Structured list of failed insertions. Batch 227
    /// replaced the previous `usize` count with the Vec so
    /// init_opc_ua_server can route each failure through
    /// the audit port (forensic completeness per plan
    /// §5 Faz 5 step 11 pre+post-exec audit contract).
    pub insertion_failures: Vec<TagInsertionFailure>,
}

/// Owned handle over the running OPC UA server. Wraps the
/// `async-opcua` ServerHandle + the tokio JoinHandle of the
/// spawned run-loop task so the caller can coordinate both
/// cancellation (graceful shutdown via ServerHandle::cancel)
/// and task reap (via the JoinHandle).
pub struct SuderraOpcUaHandle {
    handle: ServerHandle,
    run_task: JoinHandle<()>,
    /// Batch 217: snapshot of the address-space population
    /// pass. Present if `populate_tag_nodes` ran during
    /// startup (Batch 217 wires this in unconditionally);
    /// None if the server was started before the
    /// population step (used by tests for the minimal
    /// start/cancel roundtrip case).
    population_summary: Option<AddressSpacePopulationSummary>,
}

impl SuderraOpcUaHandle {
    /// Signal graceful shutdown. The server drains active
    /// sessions + exits its run loop. Idempotent.
    pub fn cancel(&self) {
        self.handle.cancel();
    }

    /// Await the run-loop task completion. Call AFTER
    /// `cancel()` so the task actually exits. Returns a
    /// `JoinError` if the task panicked — non-panic exits
    /// resolve cleanly.
    pub async fn join(self) -> Result<(), tokio::task::JoinError> {
        self.run_task.await
    }

    /// Diagnostic: count of node managers attached to the
    /// server. Always ≥ 1 with `generated-address-space`
    /// feature (core manager) + 1 for the diagnostics
    /// manager. Batch 217 adds the Suderra tag manager,
    /// bumping this to 3.
    pub fn node_manager_count(&self) -> usize {
        self.handle.node_managers().iter().count()
    }

    /// Batch 217: the Suderra namespace index the server
    /// assigned. None if the population step hasn't run (or
    /// failed to resolve the namespace URI).
    pub fn namespace_index(&self) -> Option<u16> {
        self.population_summary.as_ref().map(|s| s.namespace_index)
    }

    /// Batch 217: read-only view of the population summary.
    pub fn population(&self) -> Option<&AddressSpacePopulationSummary> {
        self.population_summary.as_ref()
    }

    /// Batch 222: borrow the async-opcua `ServerHandle` for
    /// post-start wire operations (write-callback
    /// registration, namespace lookup). Kept crate-private
    /// because leaking the raw handle beyond the runtime
    /// module would invite direct mutation paths that
    /// bypass the SuderraOpcUaHandle contract.
    pub(crate) fn server_handle_ref(&self) -> &ServerHandle {
        &self.handle
    }
}

/// Errors constructing or starting the server.
#[derive(Debug)]
pub enum OpcUaServerStartError {
    /// Config validation failed BEFORE ServerBuilder.build()
    /// ran. Echoes the underlying validator message so
    /// operator sees exactly which field rejected.
    ConfigInvalid(String),
    /// async-opcua ServerBuilder::build() failed. The inner
    /// string is the builder's Err surface (typically
    /// "invalid endpoint" / "missing discovery URL" / TLS
    /// configuration errors).
    BuilderFailed(String),
}

impl std::fmt::Display for OpcUaServerStartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ConfigInvalid(s) => write!(f, "opc_ua_server config invalid: {}", s),
            Self::BuilderFailed(s) => write!(f, "opc_ua_server builder failed: {}", s),
        }
    }
}

impl std::error::Error for OpcUaServerStartError {}

/// Construct the ServerBuilder from an OpcUaServerConfig.
/// Factored out of `start_opcua_server` so builder-shape
/// invariants (endpoint presence, host/port binding,
/// anonymous token registration) can be unit-tested without
/// actually binding to a TCP port.
///
/// Pure fn modulo PKI dir touch — `create_sample_keypair`
/// only reads-through pki_dir at server.build()/run() time,
/// not at builder-construction time.
///
/// **Batch #292 A-2b 5c runtime swap path.** The
/// `sens_builder` parameter selects which NodeManager owns
/// the Suderra namespace:
///
/// - `Some(builder)` → the new SensNodeManagerBuilder is
///   registered (Batches #263-#291). Address-space population
///   is automatic (virtual nodes via tag_registry); no
///   `populate_tag_nodes` work required. Production callers
///   that have all 8 dependency Arcs available
///   (`init_opc_ua_server` in the post-Batch-#293 world)
///   pass Some.
/// - `None` → the legacy `simple_node_manager` path is
///   registered. Tests + transitional callers (the current
///   `init_opc_ua_server` body until Batch #293 wires the
///   SensAuthManager) pass None. `populate_tag_nodes` then
///   runs against the SimpleNodeManager.
///
/// **Why an Option (not two functions).** Both paths emit
/// identical `ServerBuilder` outputs that downstream callers
/// (the `build()` consumer) drive uniformly. The switch is at
/// `with_node_manager(...)` — one line. Splitting into two
/// functions would duplicate the validation + builder
/// configuration body. The Option encodes the migration
/// phase explicitly: Batch #294 deletes the `None` branch
/// once `init_opc_ua_server` always supplies the builder.
///
/// **Linked finding:** ULTRA-HIGH-035 PARTIAL_FIX (overall
/// A-2b part 5). Closes the structural-prerequisite for
/// Batch #293's `init_opc_ua_server` migration.
pub fn build_server(
    config: &OpcUaServerConfig,
    sens_bundle: Option<crate::opc_ua_sens_node_manager::SensRuntimeBundle>,
) -> Result<ServerBuilder, OpcUaServerStartError> {
    config
        .validate()
        .map_err(OpcUaServerStartError::ConfigInvalid)?;

    // Plan §5 Faz 5 step 3 — anonymous-only at Batch 216.
    // Username/password + X509 tokens land with the
    // operator-token plumbing batch.
    let user_tokens = vec![ANONYMOUS_USER_TOKEN_ID.to_string()];

    // Plan §5 Faz 5 step 7 — Basic256Sha256 + SignAndEncrypt
    // is the mandatory floor. OpcUaSecurityPolicy is type-
    // restricted to Basic256Sha256 so operators cannot
    // downgrade here.
    let _policy_uri = config.security_policy.as_uri_suffix();
    let endpoint = ServerEndpoint::new_basic256sha256_sign_encrypt("/", &user_tokens);

    let discovery_url = format!("opc.tcp://{}:{}/", config.bind, config.port);

    let mut builder = ServerBuilder::new()
        .application_name("suderra-edge")
        .application_uri(SUDERRA_NAMESPACE_URI)
        .product_uri(format!("{}:product", SUDERRA_NAMESPACE_URI))
        .host(config.bind.clone())
        .port(config.port)
        .create_sample_keypair(true)
        .trust_client_certs(true)
        .pki_dir(&config.own_pki_dir)
        .add_endpoint("default", endpoint)
        .discovery_urls(vec![discovery_url]);

    // Batch #292 manager-selection switch + Batch #293
    // SensAuthManager wire. The bundle carries BOTH the
    // node-manager builder AND the auth manager so the
    // typed-authz runtime contract is wired atomically (per
    // SensRuntimeBundle docstring: missing the auth manager
    // half would leave session-establish producing
    // non-Suderra UserTokens that SensNodeManager.write()
    // can't parse → silent fail-closed).
    builder = match sens_bundle {
        Some(bundle) => {
            // New typed-authz path — SensNodeManager handles
            // all 6 trait methods (init/owns_node/
            // namespaces_for_user/read/write/browse) per
            // Batches #263-#291. Namespace registration
            // happens inside SensNodeManager.init() via
            // `type_tree.namespaces_mut().add_namespace(...)`.
            //
            // SensAuthManager (Batch #266 primitive) handles
            // the session-establish path — produces UserToken
            // in `sens:operator:<32-hex>` format that
            // SensNodeManager.write() parses via
            // `parse_operator_token` to extract the typed
            // AuthenticatedUser principal.
            builder
                .with_node_manager(bundle.node_manager_builder)
                .with_authenticator(bundle.auth_manager)
        }
        None => {
            // Legacy SimpleNodeManager path — kept for
            // tests + transitional callers. Batch #294
            // deletes this branch once init_opc_ua_server
            // always supplies the SensNodeManagerBuilder.
            //
            // The simple-node-manager registers the Suderra
            // namespace via NamespaceMetadata at
            // construction time (NOT via init()) so
            // populate_tag_nodes can resolve the index
            // immediately after server.build().
            let namespace_meta = NamespaceMetadata {
                namespace_uri: SUDERRA_NAMESPACE_URI.to_owned(),
                ..Default::default()
            };
            builder.with_node_manager(simple_node_manager(
                namespace_meta,
                SUDERRA_NODE_MANAGER_NAME,
            ))
        }
    };

    // Batch 228 B-3 closure (partial): wire
    // config.max_sessions into the server-level Limits. The
    // async-opcua runtime rejects ActivateSession when the
    // count exceeds this cap → HMIs see
    // `BadSessionIdLimitExceeded`. Per-window brute-force
    // throttle (config.max_failed_auth_per_60s, gap B-2)
    // needs session-level auth hooks + lands with the
    // custom NodeManager + auth-port batch.
    {
        let limits = builder.limits_mut();
        limits.max_sessions = config.max_sessions as usize;
    }

    Ok(builder)
}

/// Map a Suderra tag `data_type` string (PLC-vendor
/// vocabulary) to the corresponding OPC UA DataTypeId +
/// default Variant value for first-boot.
///
/// The vocabulary is case-insensitive because PLC configs
/// come from different vendors with different conventions
/// (Beckhoff "REAL", Siemens "Real", user-written "real");
/// canonicalizing at this boundary means every downstream
/// consumer sees a single OPC UA DataType.
///
/// Unknown strings fall through to Double — safest for
/// numeric telemetry (Suderra's dominant shape); the boot
/// log should still audit the fallback so operators see
/// drift between PLC config + license manifest expectations.
pub(crate) fn map_suderra_data_type(
    suderra_data_type: &str,
) -> (DataTypeId, Variant) {
    let lower = suderra_data_type.trim().to_ascii_lowercase();
    match lower.as_str() {
        "bool" | "boolean" => (DataTypeId::Boolean, Variant::Boolean(false)),
        "int" | "int32" | "dint" => (DataTypeId::Int32, Variant::Int32(0)),
        "int64" | "lint" => (DataTypeId::Int64, Variant::Int64(0)),
        "uint" | "uint32" | "udint" => (DataTypeId::UInt32, Variant::UInt32(0)),
        "uint64" | "ulint" => (DataTypeId::UInt64, Variant::UInt64(0)),
        // IEC 61131-3 REAL is 32-bit single precision →
        // OPC UA Float. Plan Suderra StValue::Real is f64
        // though; to keep parity with the bytecode VM we
        // route the canonical "real" to Double and reserve
        // "float" for the explicit 32-bit case. "lreal" /
        // "double" are explicit-double vendor aliases.
        "float" => (DataTypeId::Float, Variant::Float(0.0)),
        "real" | "lreal" | "double" => (DataTypeId::Double, Variant::Double(0.0)),
        // Anything else — including unknown strings — maps
        // to Double as the safest numeric fallback.
        _ => (DataTypeId::Double, Variant::Double(0.0)),
    }
}

/// Populate the Suderra tag nodes into a running server's
/// SimpleNodeManager address space. Called from
/// `start_opcua_server` after `build()` completes.
///
/// Builds the hierarchy:
///   Objects/
///     Suderra/            (folder)
///       Tags/             (folder)
///         {browse_name}   (Variable, one per registry entry)
///
/// Each Variable is:
/// - Typed per `map_suderra_data_type(tag.data_type)`
/// - Assigned `CURRENT_READ` access always
/// - Assigned `CURRENT_WRITE` access for DO/AO (tag.is_writable())
///
/// NOTE: write-access at the address-space level is
/// necessary-but-not-sufficient — the OpcUa write-orchestrator
/// (Batch 209) runs on top to gate authz/EURange/force/etc.
/// The write-callback bridge lands with a subsequent batch
/// once the sync→async escape (block_in_place) is wired; for
/// Batch 217 writes land against the address-space cache but
/// do not propagate to ProcessImage.
pub fn populate_tag_nodes(
    handle: &ServerHandle,
    registry: &OpcUaTagRegistry,
) -> Result<AddressSpacePopulationSummary, String> {
    let namespace_index = handle
        .get_namespace_index(SUDERRA_NAMESPACE_URI)
        .ok_or_else(|| {
            format!(
                "SUDERRA namespace `{}` not registered — check ServerBuilder wire",
                SUDERRA_NAMESPACE_URI
            )
        })?;

    // Batch #292 A-2b 5c runtime swap path: when
    // SensNodeManagerBuilder is the active manager (Batches
    // #263-#291 typed-authz path), there is no
    // SimpleNodeManager + no in-memory AddressSpace to
    // populate. SensNodeManager.browse() resolves tags
    // virtually from tag_registry (Batch #288), so
    // populate_tag_nodes has nothing to do. We detect this
    // by querying the NodeManagers registry for a
    // SimpleNodeManager + return an empty summary with the
    // assigned namespace_index when none is present.
    //
    // The "0 variable_nodes_added" reported here does NOT
    // mean tags are missing from HMI browse responses — it
    // means SensNodeManager exposes them virtually instead.
    // The boot-log message in init_opc_ua_server documents
    // this.
    let node_manager = match handle
        .node_managers()
        .get_of_type::<SimpleNodeManager>()
    {
        Some(nm) => nm,
        None => {
            // SensNodeManager active — virtual nodes path.
            return Ok(AddressSpacePopulationSummary {
                namespace_index,
                variable_nodes_added: 0,
                writable_nodes: 0,
                insertion_failures: Vec::new(),
            });
        }
    };

    let address_space_arc = node_manager.address_space().clone();
    let mut address_space = address_space_arc.write();

    // Top-level Suderra folder under Objects. The OPC UA
    // ObjectsFolder is the well-known root every HMI
    // browses under at session start.
    let suderra_folder_id = NodeId::new(namespace_index, "Suderra");
    let suderra_added = address_space.add_folder(
        &suderra_folder_id,
        QualifiedName::new(namespace_index, "Suderra"),
        LocalizedText::from("Suderra Edge Agent"),
        &ObjectId::ObjectsFolder.into(),
    );
    if !suderra_added {
        return Err("failed to insert Objects/Suderra folder".to_string());
    }

    // Objects/Suderra/Tags subfolder — plan §5 Faz 5 step 2
    // canonical path.
    let tags_folder_id = NodeId::new(namespace_index, "Tags");
    let tags_added = address_space.add_folder(
        &tags_folder_id,
        QualifiedName::new(namespace_index, "Tags"),
        LocalizedText::from("Tags"),
        &suderra_folder_id,
    );
    if !tags_added {
        return Err("failed to insert Objects/Suderra/Tags folder".to_string());
    }

    let mut variable_nodes_added = 0usize;
    let mut writable_nodes = 0usize;
    let mut insertion_failures: Vec<TagInsertionFailure> = Vec::new();

    for node in registry.iter() {
        match insert_tag_variable(
            &mut *address_space,
            namespace_index,
            &tags_folder_id,
            node,
        ) {
            TagInsertOutcome::Inserted { writable } => {
                variable_nodes_added += 1;
                if writable {
                    writable_nodes += 1;
                }
            }
            TagInsertOutcome::Failed => {
                warn!(
                    "opc_ua populate: failed to insert tag `{}` (BrowseName `{}`) — NodeId collision?",
                    node.tag_name, node.browse_name
                );
                insertion_failures.push(TagInsertionFailure {
                    tag_name: node.tag_name.clone(),
                    browse_name: node.browse_name.clone(),
                    reason: "address_space_insert_rejected",
                });
            }
        }
    }

    Ok(AddressSpacePopulationSummary {
        namespace_index,
        variable_nodes_added,
        writable_nodes,
        insertion_failures,
    })
}

// ============================================================
// Batch 218 Faz 5 — AppState boot-path init helper
// ============================================================

/// Parse an OPC UA session-layer actor string into the
/// `authz::ActorIdentity` the PolicyEngine consumes. Batch
/// 224 (partial closure of gap A-2): the session-context
/// threading for SimpleNodeManager callbacks still forces
/// every actor to the literal `"opc-ua-anonymous"` string
/// (plan-specified anonymous-only-first-release). This
/// parser anticipates the Batch 225+ custom NodeManager
/// that will pass through U/P + X509 session identity.
///
/// Conventions:
/// - `"opc-ua-anonymous"` → `None` (unresolvable; fail-
///   closed at adapter boundary → write denied)
/// - `"op:<hex32>"` → `ActorIdentity::Operator(OperatorId)`
///   with the 32-hex-char blob decoded to `[u8; 16]`
/// - `"svc:<cn>"` → `ActorIdentity::MachineIssuer {
///   subject_cn: cn }`. Note: machine issuers are NOT in
///   the RBAC manifest's operator_bindings (they
///   authenticate via mTLS); InMemoryPolicyEngine denies
///   them per plan R-5 (Batch 223 Gate 6) so this branch
///   is documentation-complete but currently yields a
///   silent deny in practice.
/// - anything else → `None`
pub(crate) fn parse_opc_ua_session_actor(
    actor: &str,
) -> Option<ActorIdentity> {
    if actor == "opc-ua-anonymous" {
        return None;
    }
    if let Some(hex) = actor.strip_prefix("op:") {
        if hex.len() != 32 {
            return None;
        }
        let mut out = [0u8; 16];
        for (i, pair) in hex.as_bytes().chunks_exact(2).enumerate() {
            let hi = hex_nibble(pair[0])?;
            let lo = hex_nibble(pair[1])?;
            out[i] = (hi << 4) | lo;
        }
        return Some(ActorIdentity::Operator(OperatorId::new_from_verified(
            out,
        )));
    }
    if let Some(cn) = actor.strip_prefix("svc:") {
        if cn.is_empty() {
            return None;
        }
        return Some(ActorIdentity::MachineIssuer {
            subject_cn: cn.to_string(),
        });
    }
    None
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Tracing-only audit port — test fixture + pre-prod smoke
/// observation ONLY. Batch 226 removed this from the
/// production init path after the plan HC-3 fail-closed
/// contract ruled out tracing-only audit as production
/// shape (HMAC-chained on-disk audit is load-bearing). The
/// type stays in-tree as a drop-in mock for unit tests that
/// exercise the OpcUaAuditPort trait without provisioning
/// a full AuditSink + tempdir.
///
/// Calling this in a production code path is a CRITICAL
/// review finding — the init helper now refuses to wire
/// write callbacks when AuditSink is None instead of
/// falling through to this port.
pub struct TracingLogAuditPort;

#[async_trait::async_trait]
impl OpcUaAuditPort for TracingLogAuditPort {
    async fn record_write_attempt(
        &self,
        actor: &str,
        tag_name: &str,
        value: f64,
        outcome: &OpcUaWriteOutcome,
    ) {
        tracing::info!(
            actor = %actor,
            tag = %tag_name,
            value,
            outcome = ?outcome,
            "opc_ua audit (tracing-only, no sink configured)"
        );
    }
}

/// Bundle of AppState fields the OPC UA init helper needs.
/// Grouped into a struct because the parameter list grew
/// past readability when every field passed positionally.
pub struct OpcUaInitDeps<'a> {
    pub config: &'a OpcUaServerConfig,
    pub process_image: &'a ProcessImage,
    pub force_registry: Arc<ForceRegistry>,
    pub audit_sink: Option<Arc<AuditSink>>,
    pub tenant: Option<TenantId>,
    /// Batch 224 Faz 5+2: shared RbacManifestStore so the
    /// OPC UA authz adapter can bind to the real
    /// InMemoryPolicyEngine (Batch 223) instead of
    /// DenyAllPolicyEngine. When the store has no manifest
    /// loaded, the engine returns ManifestUnavailable +
    /// the adapter treats that as a deny (fail-closed per
    /// plan HC-3). When the store has a verified manifest
    /// loaded, authorized operators with the correct
    /// OpcUaWrite permission get Allow.
    pub rbac_manifest_store: Arc<RbacManifestStore>,
    /// Batch #293 A-2b 5d field. UserTokenManifestStore that
    /// the SensNodeManager typed-authz path needs in two
    /// places: (a) UserTokenValidator wraps it to validate
    /// session principals at every write, (b) SensAuthManager
    /// consumes the validator to populate UserToken at
    /// session-establish time. Held as Arc so the cloned
    /// references stay cheap.
    pub user_token_manifest_store:
        Arc<crate::authz::user_token_manifest_runtime::UserTokenManifestStore>,
    pub license: &'a EdgeLicenseLimits,
}

/// Gate-chained startup: operator config switch → Faz 7
/// license gate → tag-catalog build → server start →
/// write-callback wire. Returns `Ok(None)` when either gate
/// closes; `Ok(Some(handle))` when the server is running;
/// `Err(..)` when the gates pass but the server itself
/// refused to start.
///
/// Batch 222 extended the init to also register per-tag
/// write callbacks immediately after
/// `populate_tag_nodes`. Batch 226 tightened the contract:
/// write callbacks wire ONLY when `audit_sink = Some`
/// (HMAC-chained audit is load-bearing per plan HC-3;
/// tracing-only audit is not production shape).
///
/// Adapters:
/// - ProcessImage → ProcessImageOpcUaAdapter (Batch 210)
/// - ForceRegistry → ForceRegistryOpcUaAdapter (Batch 210)
/// - AuditSink → AuditSinkOpcUaAdapter (Batch 211) —
///   REQUIRED; audit_sink=None skips the write-callback
///   wire entirely, read path stays live
/// - PolicyEngine → PolicyEngineOpcUaAdapter wrapping
///   InMemoryPolicyEngine (Batch 223+224) bound to the
///   shared RbacManifestStore. When the store has a
///   verified manifest with the right operator + role +
///   permission, writes get Allow. Empty store collapses
///   to ManifestUnavailable → adapter denies → fail-closed.
///
/// Tenant binding: the audit + authz adapters need a
/// `TenantId`. `None` tenant (pre-provisioned edge) means
/// the server still boots + populates the address space
/// but write callbacks are NOT registered — writes hit
/// the default SimpleNodeManager handler + land in the
/// address-space cache (safe: ProcessImage untouched,
/// operator sees the write drift in browse responses).
///
/// Error surface is `String` rather than
/// `OpcUaServerStartError` because this is the AppState-
/// facing boundary.
pub async fn init_opc_ua_server(
    deps: OpcUaInitDeps<'_>,
) -> Result<Option<Arc<SuderraOpcUaHandle>>, String> {
    let OpcUaInitDeps {
        config,
        process_image,
        force_registry,
        audit_sink,
        tenant,
        rbac_manifest_store,
        user_token_manifest_store,
        license,
    } = deps;
    // Gate 1: operator off-switch.
    if !config.enabled {
        info!(
            "opc_ua_server NOT started: config.opc_ua_server.enabled=false (operator off-switch)"
        );
        return Ok(None);
    }

    // Gate 2: Faz 7 license enforcement point #5. License
    // cap overrides operator config — an off-tier tenant
    // cannot start OPC UA even with config.enabled=true. The
    // boot log emits a CRITICAL-grade warn so operators see
    // the tier mismatch the moment the agent starts.
    match check_opc_ua_server_gate(license) {
        OpcUaServerGate::LicenseAllowsStart => {}
        OpcUaServerGate::LicenseDisabled => {
            warn!(
                "opc_ua_server NOT started: license tier `{}` does NOT authorize OPC UA (plan Faz 7 enforcement point #5) — upgrade tier or disable config.opc_ua_server.enabled",
                license.tier.as_str(),
            );
            return Ok(None);
        }
    }

    // Build the tag registry from whatever the process image
    // already has wired. `get_configs` is O(n) over the
    // HashMap so it's cheap even on a large tag catalog.
    let tag_configs = process_image.get_configs().await;
    let tag_count = tag_configs.len();
    let registry = OpcUaTagRegistry::build(tag_configs.iter()).map_err(|e| {
        format!(
            "opc_ua_server: tag catalog build failed ({} tag configs): {}",
            tag_count, e
        )
    })?;
    info!(
        "opc_ua_server: tag registry built ({} tags from {} configs)",
        registry.len(),
        tag_count
    );

    // Build the tag registry Arc so it can be shared between
    // the SensNodeManagerBuilder construction (typed-authz
    // path) and the legacy bridge_deps construction (legacy
    // wire_write_callbacks path).
    let registry_arc = Arc::new(registry);

    // Batch #293 A-2b 5d runtime-swap completion: when
    // tenant + audit_sink are both present, construct the
    // production SensRuntimeBundle (SensNodeManagerBuilder +
    // SensAuthManager) + pass Some(bundle) to
    // start_opcua_server. SensNodeManager.write() Allow
    // path (Batch #291) handles writes via typed authz +
    // post-typed-authz delegate; no legacy
    // wire_write_callbacks call needed in this branch.
    //
    // When tenant or audit_sink is missing (degraded boot —
    // pre-provisioning OR audit pipe disabled), pass None
    // → legacy SimpleNodeManager + no-op write callbacks.
    // This preserves the read-only safe-mode behavior the
    // pre-Batch-#293 code provided when production
    // deps were unavailable. Batch #294 deletes the legacy
    // None branch once provisioning is mandatory at boot.
    //
    // Adapter port construction is shared between the two
    // paths: both paths build the same Force / ProcessImage /
    // Audit / Authz adapters (the SensNodeManagerBuilder
    // consumes them; the legacy bridge_deps also consumes
    // them). Construction lives BEFORE start_opcua_server
    // so the bundle build can move the Arcs into the
    // builder; the legacy path's bridge_deps still uses
    // clone() copies after start_opcua_server.
    let sens_bundle_opt: Option<
        crate::opc_ua_sens_node_manager::SensRuntimeBundle,
    > = match (tenant.as_ref(), audit_sink.as_ref()) {
        (Some(tenant_id), Some(audit_arc)) => {
            // Build the trait-port adapters that the typed
            // path needs.
            let pi_arc = Arc::new(process_image.clone());
            let force_port: Arc<dyn crate::opc_ua_server::OpcUaForceRegistryPort> =
                Arc::new(ForceRegistryOpcUaAdapter::new(
                    force_registry.clone(),
                ));
            let pi_port: Arc<dyn crate::opc_ua_server::OpcUaProcessImagePort> =
                Arc::new(ProcessImageOpcUaAdapter::new(
                    pi_arc.clone(),
                ));

            // Audit port — placeholder pv_fn returns 0
            // until a future Batch threads the engine's
            // current_policy_version closure (same shape as
            // the legacy branch below).
            let pv_fn: PolicyVersionFn = Arc::new(|| 0u64);
            let audit_port: Arc<dyn OpcUaAuditPort> =
                Arc::new(AuditSinkOpcUaAdapter::new(
                    audit_arc.clone(),
                    tenant_id.clone(),
                    pv_fn.clone(),
                ));

            // Typed authz: ManifestBackedTypedAuthz composes
            // the resolver + InMemoryPolicyEngine + tenant +
            // policy-version closure. Batch #240/#241
            // primitive lands the type; Batch #293 wires it.
            let resolver = crate::opc_ua_server_session
                ::OpcUaActorResolver::new(rbac_manifest_store.clone());
            let engine: Arc<dyn crate::authz::policy::PolicyEngine> =
                Arc::new(InMemoryPolicyEngine::new(
                    rbac_manifest_store.clone(),
                ));
            let typed_authz: Arc<dyn crate::opc_ua_server_typed_authz::TypedAuthzPort> =
                Arc::new(crate::opc_ua_server_typed_authz
                    ::ManifestBackedTypedAuthz::new(
                        resolver,
                        engine,
                        tenant_id.clone(),
                        pv_fn,
                    ));

            // UserTokenValidator wraps the manifest store —
            // shared between SensNodeManager.write() defense-
            // in-depth re-validation + SensAuthManager
            // session-establish path.
            let validator = Arc::new(
                crate::opc_ua_server_user_token_validator
                    ::UserTokenValidator::new(
                        user_token_manifest_store.clone(),
                    ),
            );

            let node_manager_builder =
                crate::opc_ua_sens_node_manager::SensNodeManagerBuilder::new(
                    tenant_id.clone(),
                    typed_authz,
                    validator.clone(),
                    pi_arc,
                    registry_arc.clone(),
                    force_port,
                    pi_port,
                    audit_port,
                );

            let auth_manager = Arc::new(
                crate::opc_ua_sens_auth_manager
                    ::SensAuthManager::new(validator),
            );

            Some(
                crate::opc_ua_sens_node_manager
                    ::SensRuntimeBundle::new(
                        node_manager_builder,
                        auth_manager,
                    ),
            )
        }
        (None, _) => {
            warn!(
                "opc_ua_server: started without tenant — typed-authz path unavailable; falling back to legacy SimpleNodeManager (read-only safe-mode)"
            );
            None
        }
        (Some(_), None) => {
            warn!(
                "opc_ua_server: started without AuditSink — typed-authz path unavailable (HC-3 fail-closed: audit is load-bearing, writes without HMAC chain are not production shape); falling back to legacy SimpleNodeManager. Configure audit.mode != Disabled + audit_sink to activate typed path."
            );
            None
        }
    };

    let sens_bundle_was_some = sens_bundle_opt.is_some();
    let handle_opt = start_opcua_server(
        config,
        &*registry_arc,
        sens_bundle_opt,
    )
    .await
    .map_err(|e| format!("opc_ua_server start failed: {}", e))?;

    // Batch #293 5d/5e closure (partial): when the typed-authz
    // path is active (sens_bundle_was_some), SensNodeManager.
    // write() handles writes via the post-typed-authz delegate
    // (Batch #291 wire). The legacy wire_write_callbacks block
    // below is for the SimpleNodeManager fallback ONLY — it
    // skips when the typed path is live. Batch #294 will
    // delete this block entirely once the legacy fallback is
    // retired.
    if sens_bundle_was_some {
        info!(
            "opc_ua_server: typed-authz path active (SensNodeManager + SensAuthManager); legacy wire_write_callbacks skipped (Batch #293 5d/5e closure)"
        );
        return Ok(handle_opt);
    }

    // Batch 222 + Batch 226 E-2 closure: wire write callbacks
    // only when BOTH tenant AND AuditSink are present.
    // Missing either means the write chain cannot satisfy the
    // plan's HC-3 fail-closed + audit-load-bearing contract
    // (writes without HMAC-chained forensic records are not
    // production shape). Degraded paths:
    //   - tenant=None  → pre-provisioning boot; writes stay
    //                    on the default SimpleNodeManager
    //                    handler (address-space cache only).
    //   - audit_sink=None → dev/pre-prod without audit pipe;
    //                       writes stay on default handler.
    // Real production has both Some and the wire activates.
    let tenant_and_audit = match (&handle_opt, tenant.as_ref(), audit_sink.as_ref()) {
        (Some(h), Some(t), Some(s)) => {
            Some((h.clone(), t.clone(), s.clone()))
        }
        (Some(_), None, _) => {
            warn!(
                "opc_ua_server: started without tenant — write callbacks NOT wired (authz + audit need tenant binding)"
            );
            None
        }
        (Some(_), Some(_), None) => {
            warn!(
                "opc_ua_server: started without AuditSink — write callbacks NOT wired (HC-3 fail-closed: audit is load-bearing, writes without HMAC chain are not production shape). Configure audit.mode != Disabled + audit_sink to activate write path."
            );
            None
        }
        _ => None,
    };
    if let Some((handle, tenant_id, audit_sink_arc)) = tenant_and_audit {
        let handle = &handle;
        let ns_index = handle.namespace_index().ok_or_else(|| {
            "opc_ua_server: namespace index missing after populate".to_string()
        })?;

        // Port adapters — each one bridges an AppState
        // subsystem into the write-orchestrator's abstract
        // port trait. Arcs are cheap to clone into the
        // closure.
        let pi_adapter: Arc<dyn crate::opc_ua_server::OpcUaProcessImagePort> =
            Arc::new(ProcessImageOpcUaAdapter::new(Arc::new(
                process_image.clone(),
            )));
        let force_adapter: Arc<dyn crate::opc_ua_server::OpcUaForceRegistryPort> =
            Arc::new(ForceRegistryOpcUaAdapter::new(force_registry));

        // Batch 226: AuditSink is REQUIRED for this branch —
        // the tenant_and_audit guard above already ensured it.
        // Placeholder policy_version_fn — Batch 224 routes to
        // InMemoryPolicyEngine whose current_policy_version
        // reflects the manifest store; a future batch threads
        // the engine's closure here so the audit record tags
        // every write with the exact policy version the
        // engine used for the decision.
        let pv_fn: PolicyVersionFn = Arc::new(|| 0u64);
        let audit_adapter: Arc<dyn OpcUaAuditPort> =
            Arc::new(AuditSinkOpcUaAdapter::new(
                audit_sink_arc,
                tenant_id.clone(),
                pv_fn,
            ));

        // Batch 224: swap DenyAll for InMemoryPolicyEngine.
        // When the manifest store has a verified manifest
        // loaded, authorized operators with the correct
        // OpcUaWrite{tag_id} permission now get Allow. When
        // the store is empty, the engine returns
        // ManifestUnavailable → the adapter collapses that
        // to Err → OpcUaAuthzPort::is_write_allowed returns
        // false (fail-closed per plan HC-3). Either way the
        // audit port records the attempt.
        //
        // Actor resolver: parses the session-layer actor
        // string back into an ActorIdentity. For operator
        // sessions (username/password or X509 CN) the
        // string is a hex-encoded OperatorId. For anonymous
        // sessions the literal "anonymous" surfaces →
        // resolver returns None → adapter denies. This is
        // the Batch 222 fail-closed contract extended with
        // a real parse path.
        let engine: Arc<dyn crate::authz::policy::PolicyEngine> =
            Arc::new(InMemoryPolicyEngine::new(rbac_manifest_store));
        let actor_resolver: crate::opc_ua_server::ActorResolverFn =
            Arc::new(parse_opc_ua_session_actor);
        let authz_adapter: Arc<dyn crate::opc_ua_server::OpcUaAuthzPort> =
            Arc::new(PolicyEngineOpcUaAdapter::new(
                engine,
                tenant_id,
                actor_resolver,
            ));

        let bridge_deps = Arc::new(OpcUaWriteBridgeDeps {
            registry: registry_arc,
            authz: authz_adapter,
            force: force_adapter,
            process_image: pi_adapter,
            audit: audit_adapter,
        });

        match wire_write_callbacks(handle.server_handle_ref(), ns_index, bridge_deps) {
            Ok(count) => {
                info!(
                    "opc_ua_server: write callbacks wired for {} writable tag(s)",
                    count
                );
            }
            Err(e) => {
                // Not fatal — the server is already live +
                // read paths still work. Operator sees the
                // reason to fix.
                warn!(
                    "opc_ua_server: write callback wire failed, writes will hit the default SimpleNodeManager handler: {}",
                    e
                );
            }
        }
    }

    Ok(handle_opt)
}

// ============================================================
// Batch 220 Faz 5 — write-callback bridge primitives
// ============================================================
//
// The `async-opcua` SimpleNodeManager callbacks are sync
// (`Fn(DataValue, &NumericRange) -> StatusCode`). The Batch
// 209 OpcUa write-orchestrator is async (port traits use
// `async fn`). The bridge primitives here — value extraction
// + outcome → StatusCode mapping — are pure sync functions
// so they're unit-tested without any tokio runtime + reused
// by the sync→async escape-hatch (`tokio::task::block_in_place
// + Handle::current().block_on(..)`) wire in a future batch.

/// Errors converting an incoming `Variant` into the `f64`
/// the OPC UA write-orchestrator expects.
#[derive(Debug, Clone, PartialEq)]
pub enum VariantToF64Error {
    /// Variant carried a type the orchestrator cannot
    /// represent as `f64` without loss (Array, ByteString,
    /// ExtensionObject, etc). Maps to OPC UA
    /// `BadTypeMismatch`.
    UnsupportedType { got: &'static str },
    /// Variant was Empty / null — operator-visible reject
    /// with OPC UA `BadTypeMismatch` matches the empty-value
    /// rejection semantics in the async-opcua spec.
    EmptyVariant,
}

impl std::fmt::Display for VariantToF64Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedType { got } => {
                write!(f, "unsupported Variant type for f64 write: {}", got)
            }
            Self::EmptyVariant => f.write_str("Variant is Empty / null"),
        }
    }
}

impl std::error::Error for VariantToF64Error {}

/// Extract a numeric value from an incoming Variant for
/// passing to the write-orchestrator. Boolean → 0/1;
/// every integer variant → f64; Float/Double → f64; anything
/// else → `UnsupportedType`.
///
/// Lossy conversion is accepted: int64 values outside f64's
/// 53-bit exact range silently round. This matches Suderra's
/// tag scan-cycle convention (tags carry f64 representations
/// regardless of declared data_type). Operators who care
/// about exact integer fidelity configure the tag as Int32
/// rather than Int64.
pub fn variant_to_f64(value: &Variant) -> Result<f64, VariantToF64Error> {
    match value {
        Variant::Empty => Err(VariantToF64Error::EmptyVariant),
        Variant::Boolean(b) => Ok(if *b { 1.0 } else { 0.0 }),
        Variant::SByte(n) => Ok(*n as f64),
        Variant::Byte(n) => Ok(*n as f64),
        Variant::Int16(n) => Ok(*n as f64),
        Variant::UInt16(n) => Ok(*n as f64),
        Variant::Int32(n) => Ok(*n as f64),
        Variant::UInt32(n) => Ok(*n as f64),
        Variant::Int64(n) => Ok(*n as f64),
        Variant::UInt64(n) => Ok(*n as f64),
        Variant::Float(f) => Ok(*f as f64),
        Variant::Double(f) => Ok(*f),
        Variant::String(_) => Err(VariantToF64Error::UnsupportedType { got: "String" }),
        Variant::DateTime(_) => Err(VariantToF64Error::UnsupportedType { got: "DateTime" }),
        Variant::Guid(_) => Err(VariantToF64Error::UnsupportedType { got: "Guid" }),
        Variant::ByteString(_) => {
            Err(VariantToF64Error::UnsupportedType { got: "ByteString" })
        }
        Variant::XmlElement(_) => {
            Err(VariantToF64Error::UnsupportedType { got: "XmlElement" })
        }
        Variant::NodeId(_) => Err(VariantToF64Error::UnsupportedType { got: "NodeId" }),
        Variant::ExpandedNodeId(_) => {
            Err(VariantToF64Error::UnsupportedType { got: "ExpandedNodeId" })
        }
        Variant::StatusCode(_) => {
            Err(VariantToF64Error::UnsupportedType { got: "StatusCode" })
        }
        Variant::QualifiedName(_) => {
            Err(VariantToF64Error::UnsupportedType { got: "QualifiedName" })
        }
        Variant::LocalizedText(_) => {
            Err(VariantToF64Error::UnsupportedType { got: "LocalizedText" })
        }
        Variant::ExtensionObject(_) => {
            Err(VariantToF64Error::UnsupportedType { got: "ExtensionObject" })
        }
        // Catch-all — `Variant` is marked `#[non_exhaustive]`
        // in newer async-opcua revisions; fall-through stays
        // in lockstep without a breaking match arm list.
        _ => Err(VariantToF64Error::UnsupportedType {
            got: "UnknownOrArray",
        }),
    }
}

/// Map an `OpcUaWriteOutcome` (from the Batch 209 write-
/// orchestrator) to the `opcua::types::StatusCode` that the
/// async-opcua session returns to the HMI.
///
/// Mapping follows plan §5 Faz 5 step 4 sub-step 13: reject
/// reasons surface as distinct OPC UA status codes so HMIs
/// display the correct error in their UI.
pub fn outcome_to_status_code(
    outcome: &crate::opc_ua_server::OpcUaWriteOutcome,
) -> StatusCode {
    use crate::opc_ua_server::OpcUaWriteOutcome as O;
    match outcome {
        O::Success { .. } => StatusCode::Good,
        O::RejectedUnknownTag { .. } => StatusCode::BadNodeIdUnknown,
        O::RejectedNotWritable { .. } => StatusCode::BadNotWritable,
        // Force-blocked writes surface as BadNotWritable too —
        // HMI sees "tag not writable" which matches the
        // operator-facing "tag is currently forced" semantic
        // when combined with the force banner the UI already
        // renders. Audit record carries the distinct reason.
        O::RejectedForced { .. } => StatusCode::BadNotWritable,
        O::RejectedOutOfRange { .. } => StatusCode::BadOutOfRange,
        O::RejectedNoPermission { .. } => StatusCode::BadUserAccessDenied,
        O::RejectedProcessImage { .. } => StatusCode::BadInternalError,
    }
}

/// Convert a Variant-extraction failure directly to the
/// OPC UA status code the session returns. Saves the caller
/// a match when they only care about the status.
pub fn variant_error_to_status_code(err: &VariantToF64Error) -> StatusCode {
    match err {
        VariantToF64Error::UnsupportedType { .. }
        | VariantToF64Error::EmptyVariant => StatusCode::BadTypeMismatch,
    }
}

// ============================================================
// Batch 221 Faz 5 — write-callback bridge
// ============================================================
//
// Composes the Batch 220 primitives (variant_to_f64 +
// outcome_to_status_code) with the Batch 209 write-
// orchestrator + Batches 210-212 adapter quartet to register
// sync write callbacks on the SimpleNodeManager.
//
// Sync→async escape: `tokio::task::block_in_place +
// Handle::current().block_on(async)`. This is the documented
// load-bearing pattern for calling async code from inside a
// sync callback that the tokio multi-thread runtime invokes.
// Panics on a current-thread runtime — the production server
// always runs on the multi-thread flavor, so this is safe.

/// Bundle of the four ports the write-orchestrator needs,
/// captured by the closure in each write callback. Arc-wrapped
/// because the closure needs to be `Fn + Send + Sync +
/// 'static` (multiple writes may fire concurrently across
/// different sessions; each one fires on whichever tokio
/// worker the session is running on).
pub struct OpcUaWriteBridgeDeps {
    pub registry: Arc<crate::opc_ua_server::OpcUaTagRegistry>,
    pub authz: Arc<dyn crate::opc_ua_server::OpcUaAuthzPort>,
    pub force: Arc<dyn crate::opc_ua_server::OpcUaForceRegistryPort>,
    pub process_image: Arc<dyn crate::opc_ua_server::OpcUaProcessImagePort>,
    pub audit: Arc<dyn crate::opc_ua_server::OpcUaAuditPort>,
}

/// Wire a sync write callback for every writable tag in the
/// registry. Called immediately after
/// `populate_tag_nodes` so each Variable node has a
/// callback before the server starts accepting HMI sessions.
///
/// Returns the count of callbacks registered. Non-writable
/// tags are skipped (their address-space entries carry
/// read-only AccessLevel already, so writes hit
/// `BadNotWritable` at the protocol layer before reaching
/// the callback).
///
/// NOTE on actor plumbing: async-opcua's SimpleNodeManager
/// write callback does NOT pass session context. For Batch
/// 221 every write runs with actor = "opc-ua-anonymous"
/// (plan Batch 216 ships anonymous-only auth). Session-actor
/// resolution requires a custom NodeManager impl that gets
/// the ServerContext threaded in; that's a subsequent batch.
/// Consequence: until the actor-resolver lands, EVERY HMI
/// write gets RejectedNoPermission from the DenyAll authz
/// port — which is safe (plan's fail-closed anonymous-only
/// constraint) + the audit record still fires.
pub fn wire_write_callbacks(
    handle: &ServerHandle,
    namespace_index: u16,
    deps: Arc<OpcUaWriteBridgeDeps>,
) -> Result<usize, String> {
    let node_manager = handle
        .node_managers()
        .get_of_type::<SimpleNodeManager>()
        .ok_or_else(|| {
            "SimpleNodeManager not present — populate_tag_nodes must run first".to_string()
        })?;

    let mut registered = 0usize;
    let writable_snapshot: Vec<_> = deps
        .registry
        .iter()
        .filter(|n| n.is_writable())
        .map(|n| (n.tag_name.clone(), n.browse_name.clone()))
        .collect();

    for (tag_name, browse_name) in writable_snapshot {
        let node_id = NodeId::new(namespace_index, browse_name.clone());
        let deps = deps.clone();
        let captured_tag_name = tag_name.clone();
        // SimpleNodeManager wraps SimpleNodeManagerImpl via
        // `InMemoryNodeManager<Impl>`. The callback API lives
        // on the impl — reach it through `.inner()`.
        node_manager
            .inner()
            .add_write_callback(node_id, move |data_value, _range| {
                write_callback_body(data_value, &captured_tag_name, &deps)
            });
        registered += 1;
    }

    Ok(registered)
}

/// Body of the sync write callback. Factored out so it's
/// independently grep-able + easier to unit-test the pieces
/// below that don't need block_in_place (variant extraction
/// + status-code mapping).
fn write_callback_body(
    data_value: opcua::types::DataValue,
    tag_name: &str,
    deps: &Arc<OpcUaWriteBridgeDeps>,
) -> StatusCode {
    let variant = match data_value.value.as_ref() {
        Some(v) => v.clone(),
        None => return variant_error_to_status_code(&VariantToF64Error::EmptyVariant),
    };
    let value = match variant_to_f64(&variant) {
        Ok(v) => v,
        Err(e) => return variant_error_to_status_code(&e),
    };
    let deps_captured = deps.clone();
    let tag_name_owned = tag_name.to_string();
    // Sync→async bridge. block_in_place tells the
    // tokio multi-thread scheduler "this worker is about to
    // block; keep the runtime responsive" and then we
    // block_on the orchestrator future on the current
    // thread. Requires the multi-thread runtime — server's
    // tokio runtime is multi-thread by construction.
    tokio::task::block_in_place(move || {
        tokio::runtime::Handle::current().block_on(async move {
            let outcome = crate::opc_ua_server::execute_opcua_write(
                &*deps_captured.registry,
                &crate::opc_ua_server::OpcUaWriteRequest {
                    tag_name: &tag_name_owned,
                    value,
                    actor: "opc-ua-anonymous",
                },
                &*deps_captured.authz,
                &*deps_captured.force,
                &*deps_captured.process_image,
                &*deps_captured.audit,
            )
            .await;
            outcome_to_status_code(&outcome)
        })
    })
}

enum TagInsertOutcome {
    Inserted { writable: bool },
    Failed,
}

fn insert_tag_variable(
    address_space: &mut opcua::server::address_space::AddressSpace,
    namespace_index: u16,
    tags_folder_id: &NodeId,
    node: &OpcUaTagNode,
) -> TagInsertOutcome {
    let (data_type, initial_value) = map_suderra_data_type(&node.data_type);
    let node_id = NodeId::new(namespace_index, node.browse_name.clone());

    let mut access = AccessLevel::CURRENT_READ;
    let writable = node.is_writable();
    if writable {
        access |= AccessLevel::CURRENT_WRITE;
    }

    let builder = VariableBuilder::new(
        &node_id,
        QualifiedName::new(namespace_index, node.browse_name.clone()),
        LocalizedText::from(node.tag_name.clone()),
    )
    .data_type(data_type)
    .value(initial_value)
    .access_level(access)
    .user_access_level(access)
    .organized_by(tags_folder_id.clone());

    if builder.insert(address_space) {
        TagInsertOutcome::Inserted { writable }
    } else {
        TagInsertOutcome::Failed
    }
}

/// Start the OPC UA server. Returns `Ok(None)` when
/// `config.enabled == false` (operator config off-switch
/// runs regardless of Cargo feature build); returns
/// `Ok(Some(handle))` when the server is running; returns
/// `Err(OpcUaServerStartError)` when config validates fails
/// or the builder rejects the shape.
///
/// The run-loop is spawned onto the current tokio runtime —
/// callers pass the returned `SuderraOpcUaHandle` to the
/// ShutdownCoordinator so graceful shutdown sends `cancel()`
/// + awaits the task join.
pub async fn start_opcua_server(
    config: &OpcUaServerConfig,
    registry: &OpcUaTagRegistry,
    sens_bundle: Option<crate::opc_ua_sens_node_manager::SensRuntimeBundle>,
) -> Result<Option<Arc<SuderraOpcUaHandle>>, OpcUaServerStartError> {
    if !config.enabled {
        info!("opc_ua_server.enabled=false — server NOT started (operator off-switch)");
        return Ok(None);
    }

    // Batch #292 + Batch #293 manager-kind boot-log marker.
    // Some(bundle) means SensNodeManager + SensAuthManager
    // are both wired — typed-authz path with virtual nodes.
    // None means legacy SimpleNodeManager + default
    // anonymous AuthManager. Operators reading boot logs see
    // immediately which production shape is active.
    let manager_kind = if sens_bundle.is_some() {
        "SensNodeManager+SensAuthManager (typed-authz, virtual nodes)"
    } else {
        "SimpleNodeManager+default-auth (legacy populate_tag_nodes)"
    };

    let builder = build_server(config, sens_bundle)?;
    let (server, handle) = builder
        .build()
        .map_err(OpcUaServerStartError::BuilderFailed)?;

    // Batch 217 + Batch #292: populate the Suderra namespace
    // when the legacy SimpleNodeManager is active. With the
    // new SensNodeManager (sens_builder = Some), the
    // populate_tag_nodes call no-ops gracefully (returns an
    // empty summary) because tags surface virtually via
    // SensNodeManager.browse(). Either way the call site
    // shape is uniform so downstream consumers
    // (SuderraOpcUaHandle.population) see the same Option
    // type.
    let population_summary = populate_tag_nodes(&handle, registry)
        .map_err(OpcUaServerStartError::BuilderFailed)?;
    info!(
        "opc_ua address-space populated: ns={} variables_added={} writable={} failures={} manager_kind=\"{}\"",
        population_summary.namespace_index,
        population_summary.variable_nodes_added,
        population_summary.writable_nodes,
        population_summary.insertion_failures.len(),
        manager_kind,
    );
    // Batch 227 E-3 closure: forensic warn per structured
    // failure so an operator-facing audit can inspect the
    // exact rejection reason per tag. A future batch pipes
    // this through the audit_sink when it becomes available
    // at this point in the init flow.
    for failure in &population_summary.insertion_failures {
        warn!(
            target: "opc_ua.populate",
            tag_name = %failure.tag_name,
            browse_name = %failure.browse_name,
            reason = %failure.reason,
            "opc_ua_server: tag-node insertion dropped during populate (forensic marker)"
        );
    }

    // Spawn the run loop. `server.run()` binds TCP internally
    // from the host/port we passed to the builder; errors
    // propagate to the JoinHandle result we surface via
    // `join()`.
    let run_task = tokio::task::spawn(async move {
        if let Err(e) = server.run().await {
            warn!("opc_ua_server run loop exited with error: {}", e);
        }
    });

    info!(
        "opc_ua_server started on {}:{} (policy=Basic256Sha256 auth=Anonymous pki_dir={})",
        config.bind, config.port, config.own_pki_dir
    );

    Ok(Some(Arc::new(SuderraOpcUaHandle {
        handle,
        run_task,
        population_summary: Some(population_summary),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{OpcUaAuthMode, OpcUaSecurityPolicy};

    /// Random port in the 30000-59999 range avoids collision
    /// with common test harnesses (< 30k is widely used) and
    /// stays below the ephemeral-range default on most
    /// Linux distros so `bind` doesn't race with automatic
    /// source-port assignment.
    fn random_test_port() -> u16 {
        30000 + (rand::random::<u16>() % 30000)
    }

    fn minimal_enabled_config() -> OpcUaServerConfig {
        OpcUaServerConfig {
            enabled: true,
            bind: "127.0.0.1".to_string(),
            port: random_test_port(),
            max_sessions: 10,
            max_failed_auth_per_60s: 20,
            auth_mode: OpcUaAuthMode::AnonymousReadOnly,
            security_policy: OpcUaSecurityPolicy::Basic256Sha256,
            own_pki_dir: std::env::temp_dir()
                .join(format!(
                    "suderra-opcua-pki-{}-{}",
                    std::process::id(),
                    rand::random::<u32>()
                ))
                .to_string_lossy()
                .into_owned(),
            trusted_certs_dir: std::env::temp_dir()
                .join(format!(
                    "suderra-opcua-trusted-{}-{}",
                    std::process::id(),
                    rand::random::<u32>()
                ))
                .to_string_lossy()
                .into_owned(),
            subscription_polling_interval_ms: 100,
        }
    }

    #[tokio::test]
    async fn start_returns_none_when_disabled() {
        let mut cfg = minimal_enabled_config();
        cfg.enabled = false;
        let result = start_opcua_server(&cfg, &OpcUaTagRegistry::default(), None).await;
        match result {
            Ok(None) => {}
            Ok(Some(_)) => panic!("disabled config MUST NOT start a server"),
            Err(e) => panic!("unexpected start error: {}", e),
        }
    }

    #[tokio::test]
    async fn start_errors_on_invalid_config() {
        let mut cfg = minimal_enabled_config();
        cfg.bind = "not an ip".to_string();
        let result = start_opcua_server(&cfg, &OpcUaTagRegistry::default(), None).await;
        match result {
            Err(OpcUaServerStartError::ConfigInvalid(_)) => {}
            Err(other) => panic!("expected ConfigInvalid, got {:?}", other),
            Ok(_) => panic!("invalid bind MUST NOT start a server"),
        }
    }

    #[test]
    fn build_server_rejects_invalid_config() {
        // build_server is the pure synchronous shape check —
        // operator-visible validator message surfaces without
        // any network touch.
        let mut cfg = minimal_enabled_config();
        cfg.subscription_polling_interval_ms = 1;
        match build_server(&cfg, None) {
            Err(OpcUaServerStartError::ConfigInvalid(msg)) => {
                assert!(msg.contains("10ms floor"), "msg={}", msg);
            }
            Err(other) => panic!("expected ConfigInvalid, got {:?}", other),
            Ok(_) => panic!("invalid polling floor MUST fail build"),
        }
    }

    #[test]
    fn build_server_accepts_valid_config() {
        let cfg = minimal_enabled_config();
        // ServerBuilder is opaque (no Debug, no PartialEq) so
        // the only assertion available is that Ok arrives.
        if build_server(&cfg, None).is_err() {
            panic!("build_server rejected a valid config");
        }
    }

    /// **Batch #292 A-2b 5c switch test.** build_server
    /// accepts both `None` (legacy SimpleNodeManager) and
    /// `Some(SensNodeManagerBuilder)` (new typed-authz
    /// path) without rejecting valid configs. The switch
    /// itself is structural at the trait-method dispatch
    /// level (no runtime branching beyond the manager
    /// registration) — this test pins that the structural
    /// switch compiles + accepts both shapes against a
    /// known-valid config.
    #[test]
    fn build_server_accepts_sens_builder_path() {
        use crate::opc_ua_sens_node_manager::{
            SensNodeManagerBuilder, SensRuntimeBundle,
        };
        use crate::opc_ua_sens_auth_manager::SensAuthManager;
        use crate::opc_ua_server::{
            OpcUaAuditPort, OpcUaForceRegistryPort,
            OpcUaProcessImagePort, OpcUaTagRegistry,
            OpcUaWriteOutcome,
        };
        use crate::opc_ua_server_typed_authz::{
            TypedAuthzError, TypedAuthzPort,
        };
        use crate::opc_ua_server_session::AuthenticatedUser;
        use crate::authz::context::{
            AuthorizationDenyReason, AuthorizedContext,
        };
        use crate::authz::user_token_manifest_runtime
            ::UserTokenManifestStore;
        use crate::authz::permission::TenantId;
        use crate::opc_ua_server_user_token_validator
            ::UserTokenValidator;
        use crate::process_image::ProcessImage;
        use async_trait::async_trait;

        // Mock implementations — only need to satisfy
        // the trait bounds; bodies are unreachable from
        // build_server (which only registers the builder,
        // never invokes its methods).
        struct DenyAllAuthz;
        #[async_trait]
        impl TypedAuthzPort for DenyAllAuthz {
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
        struct NoForce;
        #[async_trait]
        impl OpcUaForceRegistryPort for NoForce {
            async fn is_forced(&self, _tag_name: &str) -> bool {
                false
            }
        }
        struct NoCommitPi;
        #[async_trait]
        impl OpcUaProcessImagePort for NoCommitPi {
            async fn write_tag(
                &self,
                _tag_name: &str,
                _value: f64,
                _actor: &str,
            ) -> Result<(), String> {
                Err("test mock — write disabled".to_string())
            }
        }
        struct NoAudit;
        #[async_trait]
        impl OpcUaAuditPort for NoAudit {
            async fn record_write_attempt(
                &self,
                _actor: &str,
                _tag_name: &str,
                _value: f64,
                _outcome: &OpcUaWriteOutcome,
            ) {
            }
        }

        let store = Arc::new(UserTokenManifestStore::new());
        let validator = Arc::new(UserTokenValidator::new(store));
        let builder = SensNodeManagerBuilder::new(
            TenantId::new_from_verified([0u8; 16]),
            Arc::new(DenyAllAuthz),
            validator.clone(),
            Arc::new(ProcessImage::new()),
            Arc::new(OpcUaTagRegistry::default()),
            Arc::new(NoForce),
            Arc::new(NoCommitPi),
            Arc::new(NoAudit),
        );
        // Batch #293 5d: bundle the node-manager builder
        // with a SensAuthManager so the typed-authz
        // session-establish + write-extraction halves are
        // wired atomically (per SensRuntimeBundle docstring).
        let auth_manager =
            Arc::new(SensAuthManager::new(validator));
        let bundle = SensRuntimeBundle::new(builder, auth_manager);
        let cfg = minimal_enabled_config();
        if build_server(&cfg, Some(bundle)).is_err() {
            panic!(
                "build_server rejected a valid config + SensRuntimeBundle"
            );
        }
    }

    #[tokio::test]
    async fn start_and_cancel_roundtrip() {
        // End-to-end: start the server, let it bind, cancel
        // it, await clean exit. `port: 0` = OS-assigned so
        // parallel test runs never collide. Keypair creation
        // touches `own_pki_dir` — the temp-dir helper scopes
        // every run to a unique path.
        let cfg = minimal_enabled_config();
        let pki_dir = cfg.own_pki_dir.clone();
        let handle = match start_opcua_server(&cfg, &OpcUaTagRegistry::default(), None).await {
            Ok(Some(h)) => h,
            Ok(None) => panic!("enabled config returned None"),
            Err(e) => panic!("start failed: {}", e),
        };
        // Give the run-loop a moment to bind (actual
        // liveness is not required for this test — we only
        // verify the cancel → join roundtrip).
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(handle.node_manager_count() >= 1, "core node manager present");
        // Batch 217: empty registry + population runs OK
        // so the handle surfaces a 0-count summary.
        let summary = handle.population().expect("population summary present");
        assert_eq!(summary.variable_nodes_added, 0);
        assert_eq!(summary.writable_nodes, 0);
        assert!(summary.insertion_failures.is_empty());
        handle.cancel();
        // Arc makes `.join()` tricky; unwrap the Arc. Tests
        // are the only consumer of `.join()` at Batch 216.
        let inner = match Arc::try_unwrap(handle) {
            Ok(i) => i,
            Err(_) => panic!("handle still has outstanding Arc refs"),
        };
        let join_result =
            tokio::time::timeout(std::time::Duration::from_secs(5), inner.join()).await;
        match join_result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => panic!("run task panicked: {:?}", e),
            Err(_) => panic!("run task did not exit within 5s after cancel"),
        }
        // Best-effort cleanup of the generated PKI dir.
        let _ = std::fs::remove_dir_all(&pki_dir);
    }

    // ============================================================
    // Batch 217 Faz 5 — address-space population tests
    // ============================================================

    use crate::opc_ua_server::OpcUaTagNode;
    use crate::process_image::IoType;

    fn mk_node(name: &str, io_type: IoType, data_type: &str) -> OpcUaTagNode {
        OpcUaTagNode {
            tag_name: name.to_string(),
            browse_name: name.to_string(),
            io_type,
            data_type: data_type.to_string(),
            eng_unit: None,
            eng_min: Some(0.0),
            eng_max: Some(100.0),
        }
    }

    fn registry_from(nodes: Vec<OpcUaTagNode>) -> OpcUaTagRegistry {
        // Round-trip through build() since OpcUaTagNode is
        // derived from TagConfig there; constructing one by
        // hand forces mock TagConfigs.
        use crate::process_image::{ProtocolConfig, TagConfig, TagSource};
        let configs: Vec<TagConfig> = nodes
            .iter()
            .map(|n| TagConfig {
                tag_name: n.tag_name.clone(),
                io_type: n.io_type,
                data_type: n.data_type.clone(),
                source: TagSource::Modbus,
                poll_interval_ms: Some(1000),
                raw_min: None,
                raw_max: None,
                eng_min: n.eng_min,
                eng_max: n.eng_max,
                eng_unit: n.eng_unit.clone(),
                invert: false,
                alarm_hh: None,
                alarm_h: None,
                alarm_l: None,
                alarm_ll: None,
                deadband: None,
                protocol_config: ProtocolConfig::Modbus {
                    slave_id: 1,
                    register: 0,
                    function: 3,
                    register_type: "holding".to_string(),
                },
            })
            .collect();
        OpcUaTagRegistry::build(configs.iter()).expect("registry builds")
    }

    #[test]
    fn map_suderra_data_type_covers_every_plan_vocabulary() {
        use opcua::types::DataTypeId;
        // DataTypeId is `#[repr(u32)]` Copy + PartialEq; use
        // direct equality rather than `matches!` which has
        // ambiguous semantics on multi-variant enums at the
        // edition boundary.
        assert_eq!(map_suderra_data_type("Bool").0, DataTypeId::Boolean);
        assert_eq!(map_suderra_data_type("BOOL").0, DataTypeId::Boolean);
        assert_eq!(map_suderra_data_type("Boolean").0, DataTypeId::Boolean);
        assert_eq!(map_suderra_data_type("Int").0, DataTypeId::Int32);
        assert_eq!(map_suderra_data_type("DINT").0, DataTypeId::Int32);
        assert_eq!(map_suderra_data_type("Int64").0, DataTypeId::Int64);
        assert_eq!(map_suderra_data_type("UInt").0, DataTypeId::UInt32);
        // Float (IEC 61131 32-bit single) vs Real/LReal
        // (Suderra/bytecode f64). Distinct on purpose.
        assert_eq!(map_suderra_data_type("Float").0, DataTypeId::Float);
        assert_eq!(map_suderra_data_type("Real").0, DataTypeId::Double);
        assert_eq!(map_suderra_data_type("LReal").0, DataTypeId::Double);
        assert_eq!(map_suderra_data_type("Double").0, DataTypeId::Double);
        assert_eq!(map_suderra_data_type("unknown_type").0, DataTypeId::Double);
        assert_eq!(map_suderra_data_type("").0, DataTypeId::Double);
    }

    #[test]
    fn map_suderra_data_type_initial_value_matches() {
        use opcua::types::Variant;
        // Variant::Double wraps f64 — f64 patterns with
        // literals are rejected by the modern rustc; extract
        // + equality-check instead.
        match map_suderra_data_type("bool").1 {
            Variant::Boolean(b) => assert_eq!(b, false),
            other => panic!("expected Boolean, got {:?}", other),
        }
        match map_suderra_data_type("int").1 {
            Variant::Int32(n) => assert_eq!(n, 0),
            other => panic!("expected Int32, got {:?}", other),
        }
        match map_suderra_data_type("real").1 {
            Variant::Double(f) => assert_eq!(f, 0.0),
            other => panic!("expected Double, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn start_populates_multi_tag_registry() {
        let cfg = minimal_enabled_config();
        let pki_dir = cfg.own_pki_dir.clone();

        let registry = registry_from(vec![
            mk_node("do_pump", IoType::DO, "Bool"),
            mk_node("ai_temp", IoType::AI, "Real"),
            mk_node("ao_setpoint", IoType::AO, "Real"),
            mk_node("di_limit", IoType::DI, "Bool"),
        ]);

        let handle = match start_opcua_server(&cfg, &registry, None).await {
            Ok(Some(h)) => h,
            Ok(None) => panic!("enabled config returned None"),
            Err(e) => panic!("start failed: {}", e),
        };

        let summary = handle.population().expect("population ran");
        assert_eq!(summary.variable_nodes_added, 4);
        // DO + AO are writable; AI + DI are read-only.
        assert_eq!(summary.writable_nodes, 2);
        assert!(summary.insertion_failures.is_empty());
        assert!(summary.namespace_index > 0, "Suderra NS gets an index > core 0");
        assert_eq!(handle.namespace_index(), Some(summary.namespace_index));

        handle.cancel();
        let inner = match Arc::try_unwrap(handle) {
            Ok(i) => i,
            Err(_) => panic!("handle still Arc-shared"),
        };
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            inner.join(),
        )
        .await;
        let _ = std::fs::remove_dir_all(&pki_dir);
    }

    // ============================================================
    // Batch 218 Faz 5 — init_opc_ua_server gate-chain tests
    // ============================================================

    fn tier_conservative() -> EdgeLicenseLimits {
        EdgeLicenseLimits::conservative()
    }

    fn tier_opc_ua_enabled() -> EdgeLicenseLimits {
        EdgeLicenseLimits {
            opc_ua_server_enabled: true,
            ..EdgeLicenseLimits::conservative()
        }
    }

    async fn pi_with_tags_async(
        configs: Vec<crate::process_image::TagConfig>,
    ) -> ProcessImage {
        let pi = ProcessImage::new();
        pi.set_configs(configs).await;
        pi
    }

    fn test_tenant_id() -> TenantId {
        TenantId::new_from_verified([0x42u8; 16])
    }

    fn init_deps<'a>(
        cfg: &'a OpcUaServerConfig,
        pi: &'a ProcessImage,
        license: &'a EdgeLicenseLimits,
    ) -> OpcUaInitDeps<'a> {
        OpcUaInitDeps {
            config: cfg,
            process_image: pi,
            force_registry: Arc::new(ForceRegistry::new()),
            audit_sink: None,
            tenant: Some(test_tenant_id()),
            // Batch 224: empty store = InMemoryPolicyEngine
            // returns ManifestUnavailable → authz adapter
            // denies every write (fail-closed). Test
            // fixtures don't need a loaded manifest to
            // exercise the boot + cancel contract; Batch
            // 223's in_memory_engine tests cover the
            // manifest-loaded paths.
            rbac_manifest_store: Arc::new(RbacManifestStore::new()),
            // Batch #293 5d: empty UserTokenManifestStore →
            // SensAuthManager rejects every session-establish
            // (fail-closed). Test fixtures use empty stores
            // because the boot + cancel contract this helper
            // exercises does not require a loaded manifest;
            // separate tests in the typed-authz chain cover
            // the loaded-store paths.
            user_token_manifest_store: Arc::new(
                crate::authz::user_token_manifest_runtime
                    ::UserTokenManifestStore::new(),
            ),
            license,
        }
    }

    #[tokio::test]
    async fn init_returns_none_when_config_disabled() {
        let mut cfg = minimal_enabled_config();
        cfg.enabled = false;
        let pi = ProcessImage::new();
        let result = init_opc_ua_server(init_deps(&cfg, &pi, &tier_opc_ua_enabled())).await;
        match result {
            Ok(None) => {}
            Ok(Some(_)) => panic!("disabled config MUST NOT start"),
            Err(e) => panic!("unexpected error: {}", e),
        }
    }

    #[tokio::test]
    async fn init_returns_none_when_license_denies() {
        // Config enabled but license tier lacks the
        // opc_ua_server_enabled flag → Faz 7 gate closes →
        // server stays down.
        let cfg = minimal_enabled_config();
        let pi = ProcessImage::new();
        let result = init_opc_ua_server(init_deps(&cfg, &pi, &tier_conservative())).await;
        match result {
            Ok(None) => {}
            Ok(Some(_)) => panic!("license-denied MUST stay down"),
            Err(e) => panic!("unexpected error: {}", e),
        }
    }

    #[tokio::test]
    async fn init_starts_server_when_both_gates_pass() {
        let cfg = minimal_enabled_config();
        let pki_dir = cfg.own_pki_dir.clone();
        let pi = ProcessImage::new();
        let handle = match init_opc_ua_server(init_deps(&cfg, &pi, &tier_opc_ua_enabled())).await {
            Ok(Some(h)) => h,
            Ok(None) => panic!("both gates open — server MUST start"),
            Err(e) => panic!("start failed: {}", e),
        };
        // Empty process image → empty tag registry → summary
        // shows 0 variable nodes added.
        let summary = handle.population().expect("population ran");
        assert_eq!(summary.variable_nodes_added, 0);
        handle.cancel();
        let inner = Arc::try_unwrap(handle).map_err(|_| "Arc").unwrap();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            inner.join(),
        )
        .await;
        let _ = std::fs::remove_dir_all(&pki_dir);
    }

    #[tokio::test]
    async fn init_forwards_tag_catalog_from_process_image() {
        use crate::process_image::{IoType, ProtocolConfig, TagConfig, TagSource};

        let cfg = minimal_enabled_config();
        let pki_dir = cfg.own_pki_dir.clone();
        let pi = pi_with_tags_async(vec![
            TagConfig {
                tag_name: "pi_tag_a".to_string(),
                io_type: IoType::DO,
                data_type: "Bool".to_string(),
                source: TagSource::Modbus,
                poll_interval_ms: Some(1000),
                raw_min: None,
                raw_max: None,
                eng_min: Some(0.0),
                eng_max: Some(1.0),
                eng_unit: None,
                invert: false,
                alarm_hh: None,
                alarm_h: None,
                alarm_l: None,
                alarm_ll: None,
                deadband: None,
                protocol_config: ProtocolConfig::Modbus {
                    slave_id: 1,
                    register: 0,
                    function: 3,
                    register_type: "holding".to_string(),
                },
            },
            TagConfig {
                tag_name: "pi_tag_b".to_string(),
                io_type: IoType::AI,
                data_type: "Real".to_string(),
                source: TagSource::Modbus,
                poll_interval_ms: Some(1000),
                raw_min: None,
                raw_max: None,
                eng_min: Some(0.0),
                eng_max: Some(100.0),
                eng_unit: Some("mg/L".to_string()),
                invert: false,
                alarm_hh: None,
                alarm_h: None,
                alarm_l: None,
                alarm_ll: None,
                deadband: None,
                protocol_config: ProtocolConfig::Modbus {
                    slave_id: 1,
                    register: 0,
                    function: 3,
                    register_type: "holding".to_string(),
                },
            },
        ])
        .await;

        let handle = init_opc_ua_server(init_deps(&cfg, &pi, &tier_opc_ua_enabled()))
            .await
            .expect("ok")
            .expect("some");
        let summary = handle.population().expect("ran");
        // Both tags reach the address space.
        assert_eq!(summary.variable_nodes_added, 2);
        // Only the DO tag is writable.
        assert_eq!(summary.writable_nodes, 1);
        handle.cancel();
        let inner = Arc::try_unwrap(handle).map_err(|_| "Arc").unwrap();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            inner.join(),
        )
        .await;
        let _ = std::fs::remove_dir_all(&pki_dir);
    }

    // ============================================================
    // Batch 220 Faz 5 — bridge primitive tests
    // ============================================================

    #[test]
    fn variant_to_f64_covers_numeric_variants() {
        use opcua::types::Variant;
        assert_eq!(variant_to_f64(&Variant::Boolean(true)).unwrap(), 1.0);
        assert_eq!(variant_to_f64(&Variant::Boolean(false)).unwrap(), 0.0);
        assert_eq!(variant_to_f64(&Variant::SByte(-5)).unwrap(), -5.0);
        assert_eq!(variant_to_f64(&Variant::Byte(200)).unwrap(), 200.0);
        assert_eq!(variant_to_f64(&Variant::Int16(-12345)).unwrap(), -12345.0);
        assert_eq!(variant_to_f64(&Variant::UInt16(54321)).unwrap(), 54321.0);
        assert_eq!(variant_to_f64(&Variant::Int32(-2_000_000)).unwrap(), -2_000_000.0);
        assert_eq!(variant_to_f64(&Variant::UInt32(4_000_000_000)).unwrap(), 4_000_000_000.0);
        assert_eq!(variant_to_f64(&Variant::Int64(42)).unwrap(), 42.0);
        assert_eq!(variant_to_f64(&Variant::UInt64(100)).unwrap(), 100.0);
        assert_eq!(variant_to_f64(&Variant::Float(1.5)).unwrap(), 1.5);
        assert_eq!(variant_to_f64(&Variant::Double(std::f64::consts::PI)).unwrap(), std::f64::consts::PI);
    }

    #[test]
    fn variant_to_f64_rejects_empty() {
        use opcua::types::Variant;
        match variant_to_f64(&Variant::Empty) {
            Err(VariantToF64Error::EmptyVariant) => {}
            other => panic!("expected EmptyVariant, got {:?}", other),
        }
    }

    #[test]
    fn variant_to_f64_rejects_string() {
        use opcua::types::Variant;
        let err = variant_to_f64(&Variant::String("hello".into())).unwrap_err();
        match err {
            VariantToF64Error::UnsupportedType { got } => {
                assert_eq!(got, "String");
            }
            other => panic!("expected UnsupportedType, got {:?}", other),
        }
    }

    #[test]
    fn outcome_to_status_code_maps_every_variant() {
        use crate::opc_ua_server::OpcUaWriteOutcome as O;
        assert_eq!(
            outcome_to_status_code(&O::Success {
                tag_name: "x".into()
            }),
            StatusCode::Good
        );
        assert_eq!(
            outcome_to_status_code(&O::RejectedUnknownTag {
                tag_name: "ghost".into()
            }),
            StatusCode::BadNodeIdUnknown
        );
        assert_eq!(
            outcome_to_status_code(&O::RejectedNotWritable {
                tag_name: "ai".into()
            }),
            StatusCode::BadNotWritable
        );
        assert_eq!(
            outcome_to_status_code(&O::RejectedForced {
                tag_name: "do".into()
            }),
            StatusCode::BadNotWritable
        );
        assert_eq!(
            outcome_to_status_code(&O::RejectedOutOfRange {
                tag_name: "do".into(),
                value: 200.0,
                eng_min: 0.0,
                eng_max: 100.0
            }),
            StatusCode::BadOutOfRange
        );
        assert_eq!(
            outcome_to_status_code(&O::RejectedNoPermission {
                tag_name: "do".into(),
                actor: "a".into()
            }),
            StatusCode::BadUserAccessDenied
        );
        assert_eq!(
            outcome_to_status_code(&O::RejectedProcessImage {
                tag_name: "do".into(),
                reason: "timeout".into()
            }),
            StatusCode::BadInternalError
        );
    }

    // ============================================================
    // Batch 221 Faz 5 — write-callback body tests
    // ============================================================

    use crate::opc_ua_server::{
        OpcUaAuditPort, OpcUaAuthzPort, OpcUaForceRegistryPort,
        OpcUaProcessImagePort, OpcUaWriteOutcome,
    };

    fn deps_for_body(
        registry: OpcUaTagRegistry,
        authz: impl OpcUaAuthzPort + 'static,
        force: impl OpcUaForceRegistryPort + 'static,
        pi: impl OpcUaProcessImagePort + 'static,
        audit: impl OpcUaAuditPort + 'static,
    ) -> Arc<OpcUaWriteBridgeDeps> {
        Arc::new(OpcUaWriteBridgeDeps {
            registry: Arc::new(registry),
            authz: Arc::new(authz),
            force: Arc::new(force),
            process_image: Arc::new(pi),
            audit: Arc::new(audit),
        })
    }

    struct AlwaysAllow;
    #[async_trait::async_trait]
    impl OpcUaAuthzPort for AlwaysAllow {
        async fn is_write_allowed(&self, _a: &str, _t: &str) -> bool {
            true
        }
    }
    struct AlwaysDeny;
    #[async_trait::async_trait]
    impl OpcUaAuthzPort for AlwaysDeny {
        async fn is_write_allowed(&self, _a: &str, _t: &str) -> bool {
            false
        }
    }

    struct NeverForced;
    #[async_trait::async_trait]
    impl OpcUaForceRegistryPort for NeverForced {
        async fn is_forced(&self, _t: &str) -> bool {
            false
        }
    }

    struct CapturingPi2 {
        captured: tokio::sync::Mutex<Option<(String, f64)>>,
    }
    #[async_trait::async_trait]
    impl OpcUaProcessImagePort for CapturingPi2 {
        async fn write_tag(
            &self,
            tag_name: &str,
            value: f64,
            _actor: &str,
        ) -> Result<(), String> {
            *self.captured.lock().await = Some((tag_name.to_string(), value));
            Ok(())
        }
    }

    struct NoopAudit;
    #[async_trait::async_trait]
    impl OpcUaAuditPort for NoopAudit {
        async fn record_write_attempt(
            &self,
            _actor: &str,
            _tag_name: &str,
            _value: f64,
            _outcome: &OpcUaWriteOutcome,
        ) {
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn write_body_happy_path_allow_returns_good() {
        use opcua::types::{DataValue, Variant};
        let reg = registry_from(vec![mk_node("do_pump", IoType::DO, "Real")]);
        let pi = CapturingPi2 {
            captured: tokio::sync::Mutex::new(None),
        };
        let deps = deps_for_body(reg, AlwaysAllow, NeverForced, pi, NoopAudit);
        let dv = DataValue {
            value: Some(Variant::Double(42.0)),
            ..Default::default()
        };
        let status = write_callback_body(dv, "do_pump", &deps);
        assert_eq!(status, StatusCode::Good);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn write_body_deny_returns_user_access_denied() {
        use opcua::types::{DataValue, Variant};
        let reg = registry_from(vec![mk_node("do_pump", IoType::DO, "Real")]);
        let pi = CapturingPi2 {
            captured: tokio::sync::Mutex::new(None),
        };
        let deps = deps_for_body(reg, AlwaysDeny, NeverForced, pi, NoopAudit);
        let dv = DataValue {
            value: Some(Variant::Double(42.0)),
            ..Default::default()
        };
        let status = write_callback_body(dv, "do_pump", &deps);
        assert_eq!(status, StatusCode::BadUserAccessDenied);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn write_body_empty_variant_returns_type_mismatch() {
        use opcua::types::DataValue;
        let reg = registry_from(vec![mk_node("do_pump", IoType::DO, "Real")]);
        let pi = CapturingPi2 {
            captured: tokio::sync::Mutex::new(None),
        };
        let deps = deps_for_body(reg, AlwaysAllow, NeverForced, pi, NoopAudit);
        let dv = DataValue {
            value: None,
            ..Default::default()
        };
        let status = write_callback_body(dv, "do_pump", &deps);
        assert_eq!(status, StatusCode::BadTypeMismatch);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn write_body_string_variant_returns_type_mismatch() {
        use opcua::types::{DataValue, Variant};
        let reg = registry_from(vec![mk_node("do_pump", IoType::DO, "Real")]);
        let pi = CapturingPi2 {
            captured: tokio::sync::Mutex::new(None),
        };
        let deps = deps_for_body(reg, AlwaysAllow, NeverForced, pi, NoopAudit);
        let dv = DataValue {
            value: Some(Variant::String("hello".into())),
            ..Default::default()
        };
        let status = write_callback_body(dv, "do_pump", &deps);
        assert_eq!(status, StatusCode::BadTypeMismatch);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn write_body_unknown_tag_returns_node_id_unknown() {
        use opcua::types::{DataValue, Variant};
        // Registry empty → orchestrator sees unknown tag.
        let reg = OpcUaTagRegistry::default();
        let pi = CapturingPi2 {
            captured: tokio::sync::Mutex::new(None),
        };
        let deps = deps_for_body(reg, AlwaysAllow, NeverForced, pi, NoopAudit);
        let dv = DataValue {
            value: Some(Variant::Double(1.0)),
            ..Default::default()
        };
        let status = write_callback_body(dv, "ghost", &deps);
        assert_eq!(status, StatusCode::BadNodeIdUnknown);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn write_body_pi_write_reaches_process_image_adapter_on_allow() {
        use opcua::types::{DataValue, Variant};
        let reg = registry_from(vec![mk_node("do_pump", IoType::DO, "Real")]);
        let pi = CapturingPi2 {
            captured: tokio::sync::Mutex::new(None),
        };
        let pi_arc_cell = Arc::new(pi);
        let deps = Arc::new(OpcUaWriteBridgeDeps {
            registry: Arc::new(reg),
            authz: Arc::new(AlwaysAllow),
            force: Arc::new(NeverForced),
            process_image: pi_arc_cell.clone(),
            audit: Arc::new(NoopAudit),
        });
        let dv = DataValue {
            value: Some(Variant::Double(73.5)),
            ..Default::default()
        };
        let status = write_callback_body(dv, "do_pump", &deps);
        assert_eq!(status, StatusCode::Good);
        let captured = pi_arc_cell.captured.lock().await.clone();
        let (t, v) = captured.expect("process-image write captured");
        assert_eq!(t, "do_pump");
        assert_eq!(v, 73.5);
    }

    // ============================================================
    // Batch 224 Faz 5+2 — parse_opc_ua_session_actor tests
    // ============================================================

    #[test]
    fn parse_actor_anonymous_returns_none() {
        assert!(parse_opc_ua_session_actor("opc-ua-anonymous").is_none());
    }

    #[test]
    fn parse_actor_empty_returns_none() {
        assert!(parse_opc_ua_session_actor("").is_none());
    }

    #[test]
    fn parse_actor_operator_hex_roundtrip() {
        // 16 bytes = 32 hex chars; pattern `op:<hex32>`.
        let hex = "0102030405060708090a0b0c0d0e0f10";
        let actor = format!("op:{}", hex);
        match parse_opc_ua_session_actor(&actor) {
            Some(ActorIdentity::Operator(id)) => {
                assert_eq!(
                    id.as_bytes(),
                    &[
                        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A,
                        0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10
                    ]
                );
            }
            other => panic!("expected Operator, got {:?}", other.is_some()),
        }
    }

    #[test]
    fn parse_actor_operator_wrong_length_returns_none() {
        // 30 chars → wrong length.
        assert!(parse_opc_ua_session_actor("op:01020304050607080910111213141")
            .is_none());
        // 34 chars → wrong length.
        assert!(parse_opc_ua_session_actor(
            "op:0102030405060708091011121314151617"
        )
        .is_none());
    }

    #[test]
    fn parse_actor_operator_non_hex_returns_none() {
        // "zz" is not hex.
        assert!(
            parse_opc_ua_session_actor("op:zz02030405060708090a0b0c0d0e0f10").is_none()
        );
    }

    #[test]
    fn parse_actor_machine_issuer_cn() {
        match parse_opc_ua_session_actor("svc:auth-service") {
            Some(ActorIdentity::MachineIssuer { subject_cn }) => {
                assert_eq!(subject_cn, "auth-service");
            }
            other => panic!("expected MachineIssuer, got {:?}", other.is_some()),
        }
    }

    #[test]
    fn parse_actor_machine_issuer_empty_cn_returns_none() {
        assert!(parse_opc_ua_session_actor("svc:").is_none());
    }

    #[test]
    fn parse_actor_unknown_prefix_returns_none() {
        assert!(parse_opc_ua_session_actor("user:alice").is_none());
        assert!(parse_opc_ua_session_actor("random-string").is_none());
    }

    #[test]
    fn variant_error_to_status_code_maps_to_type_mismatch() {
        assert_eq!(
            variant_error_to_status_code(&VariantToF64Error::EmptyVariant),
            StatusCode::BadTypeMismatch
        );
        assert_eq!(
            variant_error_to_status_code(&VariantToF64Error::UnsupportedType {
                got: "String"
            }),
            StatusCode::BadTypeMismatch
        );
    }

    #[tokio::test]
    async fn populate_runs_before_server_spawn_so_no_empty_browse_race() {
        // If an HMI connects in the window BEFORE population
        // ran, it would see an empty address space. Batch 217
        // eliminates that race by calling populate_tag_nodes
        // between `build()` and `tokio::spawn(server.run())`.
        // Proof: the summary is Some on the returned handle.
        let cfg = minimal_enabled_config();
        let pki_dir = cfg.own_pki_dir.clone();
        let registry = registry_from(vec![mk_node("do_x", IoType::DO, "Real")]);
        let handle = start_opcua_server(&cfg, &registry, None)
            .await
            .expect("start ok")
            .expect("some");
        assert!(
            handle.population().is_some(),
            "population summary MUST be Some after start (pre-spawn guarantee)",
        );
        handle.cancel();
        let inner = Arc::try_unwrap(handle).map_err(|_| "Arc").unwrap();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            inner.join(),
        )
        .await;
        let _ = std::fs::remove_dir_all(&pki_dir);
    }
}
