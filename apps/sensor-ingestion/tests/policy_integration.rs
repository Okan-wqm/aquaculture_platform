//! ADR-031 end-to-end integration — live NATS broker round-trip
//! for the policy wire (request-reply snapshot + change subscriber).
//!
//! # Why this test exists
//!
//! The unit tests in `src/policy.rs` prove the logic against fake
//! NATS handles. They cannot catch:
//!   - Byte-level drift between the Rust serde output and the
//!     actual async-nats wire format (e.g. UTF-8 framing, header
//!     case-sensitivity);
//!   - Subscription delivery ordering under concurrent publish;
//!   - The handshake + subscribe + request round-trip timing that
//!     `bootstrap_policy` depends on.
//!
//! This test spins up a plaintext NATS broker via testcontainers
//! and runs the policy module's production code paths against it.
//! ADR-015 requires mTLS in production; the plaintext path is
//! exercised here via the `nats-client` crate's `test-utils`
//! feature, which opens a non-TLS constructor only when explicitly
//! enabled in dev-deps. Production builds never compile that
//! constructor in.
//!
//! # Test responsibility split
//!
//! - `nats_request_reply_round_trip_over_live_broker` — proves the
//!   typed `request_typed` primitive works end-to-end: encode ->
//!   wire -> responder decode -> reply encode -> wire -> decode.
//! - `policy_subscriber_applies_live_change_event` — proves the
//!   subscriber + `apply_change` + disk persistence chain works
//!   when a change event is PUBLISHED to a live broker.
//! - `bootstrap_falls_back_to_disk_on_live_nats_timeout` — proves
//!   the fallback chain engages when NATS is up but no responder
//!   answers within the configured budget.

#![cfg(not(miri))]
// Integration tests are a separate compilation unit from lib/bin,
// so they do NOT inherit the `#[cfg_attr(test, allow(...))]`
// relaxations that unit tests rely on. Relax here explicitly —
// test code is allowed to unwrap/expect/panic because every panic
// is an operator-triggered assertion failure, not a production
// fault path.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    // Items-after-statements: the per-test `#[derive(Serialize)]
    // struct EmptyRequest {}` is co-located with the
    // `request_typed` call site for readability; hoisting it to
    // the top of the file would separate the shape from the
    // caller. Safe under the integration-test file's flat layout.
    clippy::items_after_statements,
    // Manual-assert: the inline `if … panic!(…)` pattern carries
    // more operator context (polling counter + current backend
    // value) than the rewritten `assert!` form clippy suggests.
    clippy::manual_assert,
)]

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures::StreamExt;
use nats_client::{HeaderMap, NatsClient, request_typed};
use sensor_ingestion::ingest_backend::{
    DynamicBackendPolicy, IngestBackendChange, IngestBackendPolicy, IngestBackendSnapshot,
};
use sensor_ingestion::policy;
use tempfile::TempDir;
use tenant_context::TenantId;
use testcontainers::{
    GenericImage, ImageExt,
    core::{IntoContainerPort, WaitFor},
    runners::AsyncRunner,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use sensor_ingestion::config::{IngestBackend, IngestBackendConfig};

// ---------------------------------------------------------------------
// Container fixture
// ---------------------------------------------------------------------

/// Spin up a plaintext NATS broker inside Docker + return a
/// client connected to it. Every test owns its own container so
/// state never leaks between runs; the container stops when the
/// returned guard drops.
///
/// WHY plaintext (no TLS): the integration test's purpose is to
/// validate the byte-level wire shape + the broker delivery
/// semantics, NOT the TLS handshake. Generating a CA + server +
/// client cert trio per test is disproportionate to the value.
/// ADR-015 mTLS compliance is enforced by the production connect
/// path (`NatsClient::connect` REQUIRES `.require_tls(true)`).
/// This test path is ONLY reachable through the `test-utils`
/// feature on `nats-client`, which lives in dev-deps alone.
async fn start_nats_broker() -> (
    testcontainers::ContainerAsync<GenericImage>,
    Arc<NatsClient>,
) {
    // `nats:2.10-alpine` is the image `aqua-nats` runs — pin the
    // minor so a container registry refresh cannot silently upgrade
    // the test broker to a major version with different defaults.
    let container = GenericImage::new("nats", "2.10-alpine")
        .with_exposed_port(4222.tcp())
        .with_wait_for(WaitFor::message_on_stderr("Server is ready"))
        .with_cmd(vec!["-m", "8222", "-DV"])
        .start()
        .await
        .expect("start NATS container");

    let port = container
        .get_host_port_ipv4(4222.tcp())
        .await
        .expect("NATS exposed port");
    let url = format!("nats://127.0.0.1:{port}");

    let client = NatsClient::connect_plaintext(&url)
        .await
        .expect("connect plaintext NATS");
    (container, Arc::new(client))
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

/// Request-reply round-trip: the typed primitive must encode +
/// send + receive + decode symmetrically with a hand-rolled
/// responder on the same broker. Proves the wire-shape contract
/// that ADR-031 rests on.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nats_request_reply_round_trip_over_live_broker() {
    // Keep the container handle alive for the scope of the test
    // (RAII — drops at end of fn kills the broker).
    let (_container, client) = start_nats_broker().await;

    // Spawn a responder that replies with a canonical snapshot on
    // `policy.ingest_backend.snapshot`.
    let responder_client = Arc::clone(&client);
    let mut overrides = std::collections::HashMap::new();
    let tenant_a = TenantId::from_uuid(Uuid::from_bytes([0x11; 16]));
    overrides.insert(tenant_a, IngestBackend::Rust);
    let snapshot_reply = IngestBackendSnapshot {
        default_backend: IngestBackend::Node,
        overrides,
    };
    let snapshot_reply_clone = snapshot_reply.clone();
    let responder_handle = tokio::spawn(async move {
        let mut sub = responder_client
            .subscribe(policy::SNAPSHOT_SUBJECT)
            .await
            .expect("subscribe to snapshot subject");
        // Single-request test — reply once then exit.
        let msg = sub.next().await.expect("receive one request");
        let reply_to = msg.reply.expect("request has reply inbox");
        let body = serde_json::to_vec(&snapshot_reply_clone).unwrap();
        responder_client
            .publish(reply_to.to_string(), Bytes::from(body))
            .await
            .expect("publish reply");
    });

    // Tiny yield so the responder's subscribe lands before we
    // fire the request — async-nats `subscribe` is not
    // synchronous end-to-end without a flush.
    tokio::time::sleep(Duration::from_millis(50)).await;

    #[derive(serde::Serialize)]
    struct EmptyRequest {}
    let received: IngestBackendSnapshot = request_typed(
        &client,
        policy::SNAPSHOT_SUBJECT,
        &EmptyRequest {},
        Duration::from_secs(2),
    )
    .await
    .expect("request-reply succeeds");

    assert_eq!(received, snapshot_reply);
    responder_handle
        .await
        .expect("responder task did not panic");
}

/// Change-event propagation: the policy subscriber consumes a
/// `policy.ingest_backend.changed` event, applies it to the atomic
/// snapshot, and persists the new state to disk. Proves KN 6 +
/// KN 11 end-to-end on a live broker.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn policy_subscriber_applies_live_change_event() {
    let (_container, client) = start_nats_broker().await;

    let dir = TempDir::new().expect("tempdir");
    let disk_path = dir.path().join("policy-live.json");

    // Start the subscriber on the Node-only snapshot, then
    // publish a change + assert the policy mutated.
    let policy = Arc::new(DynamicBackendPolicy::new(
        IngestBackendSnapshot::from_config(&IngestBackendConfig::default()),
    ));
    let cancel = CancellationToken::new();
    let subscriber_handle = policy::spawn_policy_subscriber(
        Arc::clone(&client),
        Arc::clone(&policy),
        disk_path.clone(),
        cancel.clone(),
    );

    // Yield so the subscribe lands.
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Publish a change on the canonical subject.
    let tenant_migrated = TenantId::from_uuid(Uuid::from_bytes([0xA1; 16]));
    let change = IngestBackendChange::SetTenant {
        tenant_id: tenant_migrated,
        backend: IngestBackend::Rust,
    };
    let payload = serde_json::to_vec(&change).unwrap();
    client
        .publish_with_headers(
            "policy.ingest_backend.changed".to_owned(),
            HeaderMap::new(),
            Bytes::from(payload),
        )
        .await
        .expect("publish change");

    // Wait for the subscriber to apply. The apply path is
    // synchronous from the subscriber's POV — 500ms is generous.
    let mut waited = Duration::ZERO;
    let step = Duration::from_millis(20);
    loop {
        if matches!(policy.backend_for(tenant_migrated), IngestBackend::Rust) {
            break;
        }
        if waited >= Duration::from_secs(2) {
            panic!(
                "subscriber did not apply change within 2s; current backend={:?}",
                policy.backend_for(tenant_migrated)
            );
        }
        tokio::time::sleep(step).await;
        waited += step;
    }

    // Disk fallback reflects the new state.
    let on_disk = policy::load_snapshot_from_disk(&disk_path)
        .expect("subscriber persisted snapshot after apply");
    assert_eq!(
        on_disk.overrides.get(&tenant_migrated).copied(),
        Some(IngestBackend::Rust),
    );

    // Clean shutdown — cancel + await so the subscriber exits
    // its select! arm before the container drops (avoids a
    // spurious "stream ended" log at shutdown).
    cancel.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(1), subscriber_handle).await;
}

/// Cold-start fallback: NATS is up but no responder listens on
/// `policy.ingest_backend.snapshot`. `bootstrap_policy` MUST
/// retry, time out, then fall back to the disk file (when
/// present) — proves the fail-closed chain works against a live
/// broker, not just against a `None` client.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bootstrap_falls_back_to_disk_on_live_nats_timeout() {
    let (_container, client) = start_nats_broker().await;

    // Seed a disk-persisted snapshot from a "previous run".
    let dir = TempDir::new().expect("tempdir");
    let disk = dir.path().join("persisted.json");
    let tenant_enrolled = TenantId::from_uuid(Uuid::from_bytes([0xB2; 16]));
    let mut overrides = std::collections::HashMap::new();
    overrides.insert(tenant_enrolled, IngestBackend::Rust);
    let persisted = IngestBackendSnapshot {
        default_backend: IngestBackend::Node,
        overrides,
    };
    policy::persist_snapshot_to_disk(&disk, &persisted).expect("persist");

    // Config with an aggressive timeout so the test doesn't
    // linger on the full 15-second worst-case budget.
    let cfg = IngestBackendConfig {
        disk_fallback_path: disk.clone(),
        snapshot_request_timeout_secs: 1,
        snapshot_request_retries: 1,
        ..IngestBackendConfig::default()
    };

    let (snap, source) = policy::bootstrap_policy(Some(&client), &cfg).await;
    // Broker was reachable but nobody answered the request →
    // Transport / Timeout error exhausts retries → fallback
    // hits the disk path.
    assert_eq!(source, policy::PolicySource::Disk);
    assert_eq!(
        snap.overrides.get(&tenant_enrolled).copied(),
        Some(IngestBackend::Rust),
        "disk snapshot's enrolled tenant must survive the bootstrap",
    );
}
