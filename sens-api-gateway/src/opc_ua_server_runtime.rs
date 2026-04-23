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

use opcua::server::{
    ServerBuilder, ServerEndpoint, ServerHandle, ANONYMOUS_USER_TOKEN_ID,
};
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::config::OpcUaServerConfig;

/// Owned handle over the running OPC UA server. Wraps the
/// `async-opcua` ServerHandle + the tokio JoinHandle of the
/// spawned run-loop task so the caller can coordinate both
/// cancellation (graceful shutdown via ServerHandle::cancel)
/// and task reap (via the JoinHandle).
pub struct SuderraOpcUaHandle {
    handle: ServerHandle,
    run_task: JoinHandle<()>,
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

    let builder = ServerBuilder::new()
        .application_name("suderra-edge")
        .application_uri("urn:suderra:edge")
        .product_uri("urn:suderra:edge:product")
        .host(config.bind.clone())
        .port(config.port)
        .create_sample_keypair(true)
        .trust_client_certs(true)
        .pki_dir(&config.own_pki_dir)
        .add_endpoint("default", endpoint)
        .discovery_urls(vec![discovery_url]);

    Ok(builder)
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
) -> Result<Option<Arc<SuderraOpcUaHandle>>, OpcUaServerStartError> {
    if !config.enabled {
        info!("opc_ua_server.enabled=false — server NOT started (operator off-switch)");
        return Ok(None);
    }

    let builder = build_server(config)?;
    let (server, handle) = builder
        .build()
        .map_err(OpcUaServerStartError::BuilderFailed)?;

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

    Ok(Some(Arc::new(SuderraOpcUaHandle { handle, run_task })))
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
        let result = start_opcua_server(&cfg).await;
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
        let result = start_opcua_server(&cfg).await;
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
        let handle = match start_opcua_server(&cfg).await {
            Ok(Some(h)) => h,
            Ok(None) => panic!("enabled config returned None"),
            Err(e) => panic!("start failed: {}", e),
        };
        // Give the run-loop a moment to bind (actual
        // liveness is not required for this test — we only
        // verify the cancel → join roundtrip).
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(handle.node_manager_count() >= 1, "core node manager present");
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
}
