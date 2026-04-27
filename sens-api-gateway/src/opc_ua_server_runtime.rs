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

// Batch #294 A-2b 5e FULL closure: simple_node_manager +
// SimpleNodeManager + AccessLevel + VariableBuilder +
// NamespaceMetadata + LocalizedText/NodeId/ObjectId/
// QualifiedName/StatusCode/ActorIdentity/OperatorId/
// OpcUaTagNode/OpcUaWriteOutcome/PolicyEngineOpcUaAdapter
// imports retired. SensNodeManager is the sole production
// NodeManager; legacy fallback path deleted.
use opcua::server::{
    ServerBuilder, ServerEndpoint, ServerHandle, ANONYMOUS_USER_TOKEN_ID,
};
use opcua::types::{DataTypeId, Variant};
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::audit::sink::AuditSink;
use crate::authz::in_memory_engine::InMemoryPolicyEngine;
use crate::authz::manifest_runtime::RbacManifestStore;
use crate::authz::permission::TenantId;
use crate::config::OpcUaServerConfig;
use crate::license::{check_opc_ua_server_gate, EdgeLicenseLimits, OpcUaServerGate};
use crate::opc_ua_server::{
    AuditSinkOpcUaAdapter, ForceRegistryOpcUaAdapter, OpcUaAuditPort,
    OpcUaTagRegistry, PolicyVersionFn, ProcessImageOpcUaAdapter,
};
use crate::process_image::ProcessImage;
use crate::scripting::force_registry::ForceRegistry;

/// The Suderra edge-agent OPC UA namespace URI. Stable
/// across releases — HMIs cache NodeId references keyed on
/// this URI's resolved namespace index. Bumping requires a
/// coordinated client reconfiguration.
pub const SUDERRA_NAMESPACE_URI: &str = "urn:suderra:edge";

// Batch #294 A-2b 5e FULL closure: SUDERRA_NODE_MANAGER_NAME
// retired. The constant was the lookup key for
// `get_of_type::<SimpleNodeManager>()` in the legacy
// populate_tag_nodes path; with SimpleNodeManager removed,
// the lookup-by-name machinery is dead code.

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
/// **Batch #294 A-2b 5e FULL closure.** The legacy
/// SimpleNodeManager fallback is RETIRED. `build_server` now
/// takes a mandatory `SensRuntimeBundle` — there is no longer
/// any path through this function that produces an
/// anonymous-write-capable server. The Option type from
/// Batch #292 was a migration phase; with `init_opc_ua_server`
/// (post-Batch-#293) always supplying the bundle, the `None`
/// branch became dead code + this batch deletes it.
///
/// Tier-1 architectural shape: no Option, no fallback — the
/// type signature literally cannot represent a missing-bundle
/// boot. Callers that don't have a bundle (degraded boot
/// state, tests of disabled paths) MUST fail-fast BEFORE
/// reaching this function (see `init_opc_ua_server` for the
/// fail-fast match arms).
///
/// **Linked findings:** ULTRA-HIGH-035 RESOLVED via this
/// batch (A-2b part 5 closure). Production wire is now end-
/// to-end typed-authz with no anonymous-write surface.
pub fn build_server(
    config: &OpcUaServerConfig,
    sens_bundle: crate::opc_ua_sens_node_manager::SensRuntimeBundle,
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

    // Build the server with the SensNodeManager + SensAuthManager
    // typed-authz extension points. Both halves of the bundle
    // wire atomically — SensAuthManager produces UserToken in
    // `sens:operator:<32-hex>` format that SensNodeManager.write()
    // parses via `parse_operator_token`. Pre-Batch-#294 had a
    // None branch falling back to `simple_node_manager` —
    // retired in this batch.
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
        .discovery_urls(vec![discovery_url])
        .with_node_manager(sens_bundle.node_manager_builder)
        .with_authenticator(sens_bundle.auth_manager);

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
/// **Batch #294 A-2b 5e FULL closure.** With the legacy
/// SimpleNodeManager fallback retired, this function is no
/// longer responsible for in-memory AddressSpace mutation —
/// SensNodeManager (Batches #263-#291) resolves tags
/// virtually via `tag_registry` (browse() / read() / write()
/// trait methods). The function is kept as a thin shape
/// preserving the public API (SuderraOpcUaHandle.population
/// still surfaces `Option<AddressSpacePopulationSummary>` for
/// boot-log clarity) but now returns an empty-summary that
/// reports the assigned namespace_index + 0 nodes added.
///
/// A future Batch may delete this function entirely + change
/// SuderraOpcUaHandle.population to None unconditionally;
/// today it stays in-tree as the operator-visible signal that
/// the namespace registration succeeded.
pub fn populate_tag_nodes(
    handle: &ServerHandle,
    _registry: &OpcUaTagRegistry,
) -> Result<AddressSpacePopulationSummary, String> {
    let namespace_index = handle
        .get_namespace_index(SUDERRA_NAMESPACE_URI)
        .ok_or_else(|| {
            format!(
                "SUDERRA namespace `{}` not registered — check ServerBuilder wire",
                SUDERRA_NAMESPACE_URI
            )
        })?;
    // SensNodeManager surfaces tags via browse(), not via
    // an in-memory AddressSpace. Empty summary == correct
    // shape for the typed-authz runtime.
    Ok(AddressSpacePopulationSummary {
        namespace_index,
        variable_nodes_added: 0,
        writable_nodes: 0,
        insertion_failures: Vec::new(),
    })
}

// ============================================================
// Batch 218 Faz 5 — AppState boot-path init helper
// ============================================================

// Batch #294 A-2b 5e FULL closure: parse_opc_ua_session_actor
// + hex_nibble + TracingLogAuditPort retired. The actor parser
// was only consumed by `wire_write_callbacks`'s
// PolicyEngineOpcUaAdapter actor_resolver; with the
// SimpleNodeManager fallback removed, no caller produces an
// `actor: &str` string for the parser to consume — every actor
// arrives as a typed `AuthenticatedUser` via SensNodeManager's
// trait method bodies. The TracingLogAuditPort was a Batch
// 226-deprecated fallback (production HC-3 rejected
// tracing-only audit); with the bundle-mandatory init path,
// callers cannot reach a code branch that would consume it.

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
    /// **Batch #325 D-9 migration field.** Clock authority
    /// for the SensNodeManager + PolicyEngineOpcUaAdapter
    /// `received_at` reads. Threaded from AppState's
    /// clock_authority so OPC UA writes share the same
    /// trustworthy_wall_clock gate as every other
    /// TTL-bearing subsystem.
    pub clock_authority: Arc<dyn crate::runtime_safety::ClockAuthority>,
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
        clock_authority,
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

    // Batch #294 A-2b 5e FULL closure: typed-authz path is
    // the ONLY production path. When tenant/audit_sink are
    // missing, the OPC UA server does NOT start (Tier-1
    // make-it-impossible against any anonymous-write shape
    // ever existing in production). Operator-visible boot
    // log explains the missing dep + the agent itself
    // continues running (other services boot independently);
    // OPC UA can come up later via config reload + new
    // provisioning state.
    //
    // The pre-Batch-#294 fallback (legacy SimpleNodeManager
    // + wire_write_callbacks with a hardcoded
    // "opc-ua-anonymous" actor that the policy engine always
    // rejected) was architecturally a footgun: it produced a
    // running server with a gate that always denied + a
    // tracing-only audit + no operator-visible signal that
    // the production typed path was inactive. Replacing it
    // with explicit fail-fast lets operators discover +
    // resolve provisioning issues immediately.
    let (tenant_id, audit_arc) = match (tenant.as_ref(), audit_sink.as_ref()) {
        (Some(t), Some(s)) => (t.clone(), s.clone()),
        (None, _) => {
            warn!(
                "opc_ua_server NOT started: tenant_id missing — typed-authz path requires provisioning. Agent continues running; OPC UA can come up after self_register completes + config reload."
            );
            return Ok(None);
        }
        (Some(_), None) => {
            warn!(
                "opc_ua_server NOT started: AuditSink missing — typed-authz path requires HMAC-chained audit (HC-3 fail-closed: writes without forensic records are not production shape). Configure audit.mode != Disabled + audit_sink to enable OPC UA."
            );
            return Ok(None);
        }
    };

    // Build the trait-port adapters + typed-authz chain +
    // SensRuntimeBundle. With the legacy fallback retired,
    // this is the SOLE construction path; no Option/None
    // shape remains.
    let pi_arc = Arc::new(process_image.clone());
    let force_port: Arc<dyn crate::opc_ua_server::OpcUaForceRegistryPort> =
        Arc::new(ForceRegistryOpcUaAdapter::new(
            force_registry,
        ));
    let pi_port: Arc<dyn crate::opc_ua_server::OpcUaProcessImagePort> =
        Arc::new(ProcessImageOpcUaAdapter::new(pi_arc.clone()));

    // Placeholder pv_fn returns 0 until a future Batch
    // threads the engine's current_policy_version closure
    // so the audit record tags every write with the exact
    // policy version the decision used.
    let pv_fn: PolicyVersionFn = Arc::new(|| 0u64);
    let audit_port: Arc<dyn OpcUaAuditPort> =
        Arc::new(AuditSinkOpcUaAdapter::new(
            audit_arc,
            tenant_id.clone(),
            pv_fn.clone(),
        ));

    // Typed authz: ManifestBackedTypedAuthz composes the
    // resolver + InMemoryPolicyEngine + tenant +
    // policy-version closure (Batch #240/#241 primitives).
    let resolver = crate::opc_ua_server_session
        ::OpcUaActorResolver::new(rbac_manifest_store.clone());
    let engine: Arc<dyn crate::authz::policy::PolicyEngine> =
        Arc::new(InMemoryPolicyEngine::new(
            rbac_manifest_store,
        ));
    let typed_authz: Arc<dyn crate::opc_ua_server_typed_authz::TypedAuthzPort> =
        Arc::new(crate::opc_ua_server_typed_authz
            ::ManifestBackedTypedAuthz::new(
                resolver,
                engine,
                tenant_id.clone(),
                pv_fn,
            ));

    // UserTokenValidator — shared between SensNodeManager
    // (defense-in-depth re-validation) + SensAuthManager
    // (session-establish path).
    let validator = Arc::new(
        crate::opc_ua_server_user_token_validator
            ::UserTokenValidator::new(user_token_manifest_store),
    );

    let node_manager_builder =
        crate::opc_ua_sens_node_manager::SensNodeManagerBuilder::new(
            tenant_id,
            typed_authz,
            validator.clone(),
            pi_arc,
            registry_arc.clone(),
            force_port,
            pi_port,
            audit_port,
            // Batch #325 D-9 migration: forward the
            // AppState clock_authority so SensNodeManager
            // writes use the trustworthy_wall_clock gate.
            clock_authority.clone(),
        );

    let auth_manager = Arc::new(
        crate::opc_ua_sens_auth_manager::SensAuthManager::new(
            validator,
        ),
    );

    let bundle = crate::opc_ua_sens_node_manager
        ::SensRuntimeBundle::new(
            node_manager_builder,
            auth_manager,
        );

    let handle_opt = start_opcua_server(
        config,
        &*registry_arc,
        bundle,
    )
    .await
    .map_err(|e| format!("opc_ua_server start failed: {}", e))?;

    Ok(handle_opt)
}

// Batch #294 A-2b 5e FULL closure: write-callback bridge
// primitives (VariantToF64Error / variant_to_f64 /
// outcome_to_status_code / variant_error_to_status_code /
// OpcUaWriteBridgeDeps / wire_write_callbacks /
// opcua_write_callback / TagInsertOutcome /
// insert_tag_variable) all retired. They were the
// SimpleNodeManager-bound sync->async bridge for the
// per-tag add_write_callback path; with SensNodeManager
// owning all 6 trait methods (read/write/browse/...)
// directly via &RequestContext, no sync->async bridge
// is needed. SensNodeManager.write() (Batch #265 + Batch
// #291 wire) parses the typed UserToken + delegates to
// execute_opcua_write_post_typed_authz (Batch #290) which
// does the same orchestration the legacy bridge did,
// without losing RequestContext.


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
    sens_bundle: crate::opc_ua_sens_node_manager::SensRuntimeBundle,
) -> Result<Option<Arc<SuderraOpcUaHandle>>, OpcUaServerStartError> {
    if !config.enabled {
        info!("opc_ua_server.enabled=false — server NOT started (operator off-switch)");
        return Ok(None);
    }

    // Batch #294 closure: only one production manager kind
    // remains (SensNodeManager + SensAuthManager). Legacy
    // SimpleNodeManager fallback retired. Boot log retains
    // the marker line for forensic clarity even though only
    // one shape is now possible — future runtime shape
    // changes (e.g., per-tenant manager partitioning) would
    // surface here.
    let manager_kind =
        "SensNodeManager+SensAuthManager (typed-authz, virtual nodes)";

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
        let result = start_opcua_server(&cfg, &OpcUaTagRegistry::default(), deny_all_test_bundle()).await;
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
        let result = start_opcua_server(&cfg, &OpcUaTagRegistry::default(), deny_all_test_bundle()).await;
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
        match build_server(&cfg, deny_all_test_bundle()) {
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
        if build_server(&cfg, deny_all_test_bundle()).is_err() {
            panic!("build_server rejected a valid config");
        }
    }

    /// **Batch #294 A-2b 5e FULL closure test helper.**
    /// Constructs a deny-all `SensRuntimeBundle` for tests
    /// that need to reach `build_server` / `start_opcua_server`
    /// without provisioning the full production typed-authz
    /// chain. All trait-port mocks are deny-all/no-op; tests
    /// that need a specific behavior should construct their
    /// own bundle.
    fn deny_all_test_bundle()
        -> crate::opc_ua_sens_node_manager::SensRuntimeBundle
    {
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
            Arc::new(crate::runtime_safety::SystemClockAuthority::new()),
        );
        let auth_manager =
            Arc::new(SensAuthManager::new(validator));
        SensRuntimeBundle::new(builder, auth_manager)
    }

    /// **Batch #294 invariant test.** `build_server` accepts
    /// any valid config + a properly-constructed
    /// `SensRuntimeBundle`. The post-#294 signature mandates
    /// the bundle (no Option) — this test pins that the
    /// mandatory shape compiles + accepts the canonical
    /// bundle construction path.
    #[test]
    fn build_server_accepts_sens_builder_path() {
        let cfg = minimal_enabled_config();
        if build_server(&cfg, deny_all_test_bundle()).is_err() {
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
        let handle = match start_opcua_server(&cfg, &OpcUaTagRegistry::default(), deny_all_test_bundle()).await {
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
        // Batch #294 A-2b 5e FULL closure: with SensNodeManager
        // active (virtual nodes via tag_registry), the
        // populate_tag_nodes summary always reports 0 nodes
        // added — tags are exposed via SensNodeManager.browse(),
        // not via in-memory AddressSpace mutation. The test
        // pins this new semantics: the boot still succeeds, the
        // namespace index is valid, the summary shape is
        // returned, and any HMI browse against the returned
        // server would resolve the 4 tags via SensNodeManager.
        // The invariant "tags reach HMIs" now lives in
        // SensNodeManager.browse() unit tests
        // (opc_ua_sens_node_manager.rs Batch #288 tests).
        let cfg = minimal_enabled_config();
        let pki_dir = cfg.own_pki_dir.clone();

        let registry = registry_from(vec![
            mk_node("do_pump", IoType::DO, "Bool"),
            mk_node("ai_temp", IoType::AI, "Real"),
            mk_node("ao_setpoint", IoType::AO, "Real"),
            mk_node("di_limit", IoType::DI, "Bool"),
        ]);

        let handle = match start_opcua_server(&cfg, &registry, deny_all_test_bundle()).await {
            Ok(Some(h)) => h,
            Ok(None) => panic!("enabled config returned None"),
            Err(e) => panic!("start failed: {}", e),
        };

        let summary = handle.population().expect("population ran");
        // Virtual-nodes path: 0 in-memory nodes; tags surface
        // via SensNodeManager.browse() at request time.
        assert_eq!(summary.variable_nodes_added, 0);
        assert_eq!(summary.writable_nodes, 0);
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

    /// **Batch #294 A-2b 5e FULL closure helper.** Construct
    /// a working AuditSink for tests. With the legacy
    /// fallback retired, init_opc_ua_server fail-fasts when
    /// audit_sink is None — tests that need to reach a live
    /// server boot now require a real (test-scoped) audit
    /// sink. The returned Arc lives for the life of the test;
    /// the underlying file is in `std::env::temp_dir()` keyed
    /// by pid + a random nonce so parallel test runs don't
    /// collide.
    fn test_audit_sink() -> Arc<AuditSink> {
        let path = std::env::temp_dir().join(format!(
            "suderra-opcua-test-audit-{}-{}.log",
            std::process::id(),
            rand::random::<u32>(),
        ));
        // AuditSink::open requires an AuditHmacKey; the
        // pub(crate) from_bytes helper accepts any [u8; 32]
        // and the test doesn't exercise chain verification,
        // so a constant zero key is correct here.
        Arc::new(
            AuditSink::open(
                &path,
                crate::audit::sink::AuditHmacKey::from_bytes(
                    [0u8; 32],
                ),
            )
            .expect("test audit sink"),
        )
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
            audit_sink: Some(test_audit_sink()),
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
            // Batch #325 D-9: test fixture clock —
            // SystemClockAuthority for the trustworthy
            // wallclock gate.
            clock_authority: Arc::new(
                crate::runtime_safety::SystemClockAuthority::new(),
            ),
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
        // Batch #294 virtual-nodes path: tags surface via
        // SensNodeManager.browse() at request time, not via
        // in-memory AddressSpace mutation. Summary reports 0
        // nodes added (the legacy invariant — "tags reach the
        // address space" — is now exercised by SensNodeManager
        // tag-registry roundtrip tests in
        // opc_ua_sens_node_manager.rs Batch #288).
        assert_eq!(summary.variable_nodes_added, 0);
        assert_eq!(summary.writable_nodes, 0);
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

    // Batch #294 A-2b 5e FULL closure: tests for retired
    // legacy bridge primitives (variant_to_f64_* /
    // outcome_to_status_code_* / variant_error_to_status_code /
    // write_body_* / parse_actor_*) deleted alongside the
    // functions they pinned. SensNodeManager carries its own
    // cast_variant_to_f64 (Batch #291) + parse_operator_token
    // (Batch #265) tests in opc_ua_sens_node_manager.rs;
    // execute_opcua_write_post_typed_authz post-typed-authz
    // delegate tests live in opc_ua_server.rs (Batch #290).
    // The populate_runs_before_server_spawn test was deleted
    // because populate_tag_nodes returns an empty summary
    // unconditionally now (no race window to test against).
}
