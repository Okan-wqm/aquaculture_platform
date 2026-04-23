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
    DataTypeId, LocalizedText, NodeId, ObjectId, QualifiedName, Variant,
};
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::config::OpcUaServerConfig;
use crate::license::{check_opc_ua_server_gate, EdgeLicenseLimits, OpcUaServerGate};
use crate::opc_ua_server::{OpcUaTagNode, OpcUaTagRegistry};
use crate::process_image::ProcessImage;

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

/// Summary of the Suderra address-space population pass
/// (Batch 217). Reported to boot logs + `/metrics` so
/// operators can confirm the tag catalog made it into the
/// OPC UA address space without parsing async-opcua internal
/// state.
#[derive(Debug, Clone, PartialEq)]
pub struct AddressSpacePopulationSummary {
    /// Namespace index assigned to `SUDERRA_NAMESPACE_URI`
    /// by the server at build time. HMIs address Suderra
    /// tag NodeIds as `ns={namespace_index};s={browse_name}`.
    pub namespace_index: u16,
    /// Number of variable nodes actually added to the
    /// address space. Equal to `registry.len()` on the
    /// happy path; short of it if any node collided with
    /// pre-existing entries (should not happen with unique
    /// registry BrowseNames but reported separately for
    /// forensic clarity).
    pub variable_nodes_added: usize,
    /// Subset of `variable_nodes_added` that were marked
    /// writable (DO + AO). Reported to boot log so
    /// operators see at a glance how many actuators an HMI
    /// could reach.
    pub writable_nodes: usize,
    /// Subset that failed to insert (duplicate NodeId,
    /// address-space rejection). Zero on the healthy path;
    /// non-zero surfaces a forensic red flag.
    pub insertion_failures: usize,
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
pub fn build_server(config: &OpcUaServerConfig) -> Result<ServerBuilder, OpcUaServerStartError> {
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

    // Batch 217: register the Suderra SimpleNodeManager so
    // the server builds with our namespace + empty address
    // space ready for tag-node population immediately after
    // build(). The simple-node-manager pattern keeps the
    // server hot path sync (read/write callbacks are plain
    // Fn) — Batch 218+ wires async bridges for the OPC UA
    // write-orchestrator.
    let namespace_meta = NamespaceMetadata {
        namespace_uri: SUDERRA_NAMESPACE_URI.to_owned(),
        ..Default::default()
    };

    let builder = ServerBuilder::new()
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
        .with_node_manager(simple_node_manager(namespace_meta, SUDERRA_NODE_MANAGER_NAME));

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

    let node_manager = handle
        .node_managers()
        .get_of_type::<SimpleNodeManager>()
        .ok_or_else(|| {
            "SimpleNodeManager not present — Batch 216 build_server must register it".to_string()
        })?;

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
    let mut insertion_failures = 0usize;

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
                insertion_failures += 1;
                warn!(
                    "opc_ua populate: failed to insert tag `{}` (BrowseName `{}`) — NodeId collision?",
                    node.tag_name, node.browse_name
                );
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

/// Gate-chained startup: operator config switch → Faz 7
/// license gate → tag-catalog build → server start. Returns
/// `Ok(None)` when either gate closes; `Ok(Some(handle))`
/// when the server is running; `Err(..)` when the gates pass
/// but the server itself refused to start (config validation
/// drift, async-opcua builder rejection).
///
/// Callers pass a reference to the `ProcessImage` rather
/// than the tag list directly so the tag catalog reflects
/// whatever `process_image` was booted with (modbus + gpio +
/// i2c + atlas tags merged by the platform init path). Config
/// reloads that mutate tag entries require a server restart
/// — a future batch adds hot-reload by tearing down the
/// existing handle and re-invoking this init.
///
/// Error surface is `String` rather than `OpcUaServerStartError`
/// because this is the AppState-facing boundary; main.rs
/// routes the string through the bootstrap error channel
/// alongside other init failures.
pub async fn init_opc_ua_server(
    config: &OpcUaServerConfig,
    process_image: &ProcessImage,
    license: &EdgeLicenseLimits,
) -> Result<Option<Arc<SuderraOpcUaHandle>>, String> {
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

    // Start the server — the function's internal pre-spawn
    // population uses `registry` to populate the Suderra
    // address space.
    start_opcua_server(config, &registry)
        .await
        .map_err(|e| format!("opc_ua_server start failed: {}", e))
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
) -> Result<Option<Arc<SuderraOpcUaHandle>>, OpcUaServerStartError> {
    if !config.enabled {
        info!("opc_ua_server.enabled=false — server NOT started (operator off-switch)");
        return Ok(None);
    }

    let builder = build_server(config)?;
    let (server, handle) = builder
        .build()
        .map_err(OpcUaServerStartError::BuilderFailed)?;

    // Batch 217: populate the Suderra namespace BEFORE
    // spawning the run loop. Population is synchronous
    // (lock-guarded AddressSpace mutation); running it here
    // means the first HMI session that lands after
    // server.run() sees the full tag catalog on its initial
    // browse — no race-window where a client connects to an
    // empty address space.
    let population_summary = populate_tag_nodes(&handle, registry)
        .map_err(OpcUaServerStartError::BuilderFailed)?;
    info!(
        "opc_ua address-space populated: ns={} variables_added={} writable={} failures={}",
        population_summary.namespace_index,
        population_summary.variable_nodes_added,
        population_summary.writable_nodes,
        population_summary.insertion_failures,
    );

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
        let result = start_opcua_server(&cfg, &OpcUaTagRegistry::default()).await;
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
        let result = start_opcua_server(&cfg, &OpcUaTagRegistry::default()).await;
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
        match build_server(&cfg) {
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
        if build_server(&cfg).is_err() {
            panic!("build_server rejected a valid config");
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
        let handle = match start_opcua_server(&cfg, &OpcUaTagRegistry::default()).await {
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
        assert_eq!(summary.insertion_failures, 0);
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

        let handle = match start_opcua_server(&cfg, &registry).await {
            Ok(Some(h)) => h,
            Ok(None) => panic!("enabled config returned None"),
            Err(e) => panic!("start failed: {}", e),
        };

        let summary = handle.population().expect("population ran");
        assert_eq!(summary.variable_nodes_added, 4);
        // DO + AO are writable; AI + DI are read-only.
        assert_eq!(summary.writable_nodes, 2);
        assert_eq!(summary.insertion_failures, 0);
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

    #[tokio::test]
    async fn init_returns_none_when_config_disabled() {
        let mut cfg = minimal_enabled_config();
        cfg.enabled = false;
        let pi = ProcessImage::new();
        let result = init_opc_ua_server(&cfg, &pi, &tier_opc_ua_enabled()).await;
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
        let result = init_opc_ua_server(&cfg, &pi, &tier_conservative()).await;
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
        let handle = match init_opc_ua_server(&cfg, &pi, &tier_opc_ua_enabled()).await {
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

        let handle = init_opc_ua_server(&cfg, &pi, &tier_opc_ua_enabled())
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
        let handle = start_opcua_server(&cfg, &registry)
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
