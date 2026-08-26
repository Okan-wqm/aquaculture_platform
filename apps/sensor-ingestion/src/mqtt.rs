//! MQTT subscriber — wraps `rumqttc` in a channel-based stream so the
//! rest of the binary stays test-friendly and broker-agnostic.
//!
//! WHY a channel boundary:
//!   The actual MQTT client lives on its own task and only emits
//!   structurally-typed [`RawMqttMessage`] values into an
//!   `mpsc::Receiver`. Downstream stages (topic parser, payload
//!   validator, batch aggregator, COPY pipeline) consume the receiver
//!   without knowing rumqttc exists. That keeps unit tests of the
//!   pipeline able to drive synthetic messages directly into the
//!   channel; the rumqttc EventLoop only needs an integration test
//!   against a real broker.
//!
//! WHY rumqttc 0.25:
//!   The edge agent (`sens-api-gateway`) uses the same crate at the
//!   same version. Sharing the MQTT client implementation between
//!   edge and cloud means the QoS-1 inflight semantics match exactly.
//!
//! Security note (RUST-CVE-001, resolved): rumqttc resolves to the
//! vendored fork at `crates/local-rumqttc` via `[patch.crates-io]`.
//! The fork bumps rustls-webpki to 0.103 (clears RUSTSEC-2026-0098/
//! 0099/0049/0104) and drops the unmaintained rustls-pemfile
//! (RUSTSEC-2025-0134) in favour of rustls-pki-types — the same PEM
//! API this module uses below. Provenance + diff policy:
//! `crates/local-rumqttc/UPSTREAM.md`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use rumqttc::{
    AsyncClient, Event, EventLoop, MqttOptions, Packet, Publish, QoS, TlsConfiguration, Transport,
};
// RUST-CVE-001: PemObject trait supplies pem_slice_iter/from_pem_slice on
// the DER newtypes — the first-party replacement for rustls-pemfile.
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use thiserror::Error;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::config::MqttConfig;

/// Channel buffer for the subscriber → pipeline mpsc. Plan §
/// "Mimari (single binary)" — `tokio::mpsc<Bytes> (cap 50K)`.
pub const MQTT_CHANNEL_CAPACITY: usize = 50_000;

/// All ways the MQTT subsystem can fail.
#[derive(Debug, Error)]
pub enum MqttError {
    /// `broker_url` could not be parsed into a `(host, port)` pair, or
    /// its scheme was neither `mqtt://` nor `mqtts://`.
    #[error("invalid broker_url '{got}': {reason}")]
    InvalidBrokerUrl {
        /// The bad URL (truncated to 64 chars to bound log noise).
        got: String,
        /// Why it failed.
        reason: &'static str,
    },

    /// `topic_filters` was empty.
    #[error("topic_filters cannot be empty")]
    NoTopicFilters,

    /// `qos` field was outside `0..=1`. QoS-2 is intentionally not
    /// supported — the plan's baseline is QoS-1 and admitting QoS-2
    /// changes inflight semantics dramatically.
    #[error("qos must be 0 or 1 (QoS-2 not supported); got {0}")]
    UnsupportedQos(u8),

    /// Durable QoS1 sessions require a deployment-stable client id.
    #[error("mqtt client_id must be non-empty for a persistent session")]
    MissingClientId,

    /// A manual acknowledgement could not be queued to rumqttc.
    #[error("mqtt manual acknowledgement failed")]
    Ack(#[source] rumqttc::ClientError),

    /// rumqttc's subscribe call failed.
    #[error("subscribe failed for filter '{filter}'")]
    Subscribe {
        /// Topic filter the subscribe call refused.
        filter: String,
        /// Underlying rumqttc error.
        #[source]
        source: rumqttc::ClientError,
    },

    /// Broker URL uses `mqtts://` but one or more of the required
    /// mTLS material paths is missing from [`MqttConfig`]. Surfaced
    /// at process start by [`validate_config`] so misconfiguration
    /// cannot fall through to a silently-insecure connection.
    #[error("mqtts:// broker requires server_ca_cert_pem, client_cert_pem, and client_key_pem")]
    MtlsMaterialMissing,

    /// One of the cert / key files in [`MqttConfig`] could not be
    /// read. Mirrors `persistence::SinkError::TlsMaterial` so an
    /// operator sees the same shape of error from every TLS-bearing
    /// subsystem in the sidecar.
    #[error("cannot read TLS material at {path}")]
    TlsMaterial {
        /// File path that failed to load.
        path: PathBuf,
        /// Underlying I/O error.
        #[source]
        source: std::io::Error,
    },

    /// rustls / x509 parsing or `with_client_auth_cert` failed on
    /// the supplied PEM material.
    #[error("rustls TLS configuration error: {0}")]
    Tls(String),
}

/// One MQTT message handed to downstream stages.
#[derive(Debug, Clone)]
pub struct RawMqttMessage {
    /// Topic the broker delivered the message on.
    pub topic: String,
    /// Payload bytes (`Bytes` is cheap-clone, Arc-backed).
    pub payload: Bytes,
    /// Wall-clock instant the rumqttc task observed the message.
    pub received_at: Instant,
    ack: MqttAckToken,
}

/// Capability token for exactly one broker delivery. Keeping the original
/// `Publish` packet (including its packet id) prevents callers from confusing
/// MQTT packet identity with the durable source event identity.
#[derive(Debug, Clone)]
struct MqttAckToken {
    client: AsyncClient,
    publish: Publish,
}

impl RawMqttMessage {
    /// Send PUBACK only after the caller has completed its durable commit and
    /// every required JetStream publish acknowledgement.
    pub async fn acknowledge(&self) -> Result<(), MqttError> {
        self.ack
            .client
            .ack(&self.ack.publish)
            .await
            .map_err(MqttError::Ack)
    }

    /// Close the persistent session without acknowledging this delivery. The
    /// broker retains it and redelivers when the deployment-stable client id
    /// reconnects.
    pub async fn retry_without_ack(&self) -> Result<(), MqttError> {
        self.ack.client.disconnect().await.map_err(MqttError::Ack)
    }
}

/// Receiver + EventLoop join handle handed to the caller.
#[derive(Debug)]
pub struct MqttMessageStream {
    rx: mpsc::Receiver<RawMqttMessage>,
    handle: JoinHandle<()>,
}

impl MqttMessageStream {
    /// Pull the next message; `None` means the EventLoop task exited.
    pub async fn recv(&mut self) -> Option<RawMqttMessage> {
        self.rx.recv().await
    }

    /// Stop the EventLoop task and wait for it to finish. The caller
    /// drops the receiver half (causing the event-loop task to return)
    /// and then awaits the task's `JoinHandle` so the runtime can
    /// shut down cleanly.
    pub async fn shutdown(self) {
        let Self { rx, handle } = self;
        drop(rx);
        let _ = handle.await;
    }
}

/// Validate the [`MqttConfig`] without touching the network.
///
/// WHY also enforce mTLS material here:
///   The same rule has to hold at every entrypoint that constructs the
///   subscriber. Asserting it inside [`start`] only would let a future
///   call site that bypasses [`start`] (e.g. a unit test that builds
///   the EventLoop directly) silently fall back to system-roots TLS.
///   Centralising the rule in `validate_config` makes the gate a
///   total function over `MqttConfig`.
pub fn validate_config(cfg: &MqttConfig) -> Result<(), MqttError> {
    if cfg.topic_filters.is_empty() {
        return Err(MqttError::NoTopicFilters);
    }
    if cfg.qos != 1 {
        return Err(MqttError::UnsupportedQos(cfg.qos));
    }
    if cfg.client_id.trim().is_empty() {
        return Err(MqttError::MissingClientId);
    }
    parse_broker_url(&cfg.broker_url)?;
    if cfg.tls_required()
        && (cfg.server_ca_cert_pem.is_none()
            || cfg.client_cert_pem.is_none()
            || cfg.client_key_pem.is_none())
    {
        return Err(MqttError::MtlsMaterialMissing);
    }
    Ok(())
}

/// Spawn the rumqttc EventLoop task and return a stream of incoming
/// messages.
pub async fn start(cfg: MqttConfig) -> Result<MqttMessageStream, MqttError> {
    validate_config(&cfg)?;
    let parsed_url = parse_broker_url(&cfg.broker_url)?;
    let mut opts = build_mqtt_options(&cfg)?;

    if parsed_url.tls {
        // Build a rustls ClientConfig with the platform CA pinned and
        // the client cert wired in. WHY no system roots: the platform
        // PKI is the single trust anchor (ADR-014/015 cert-is-identity);
        // a Web-PKI CA must not be able to MITM the broker connection.
        // WHY mTLS: the broker's ACL pivots on the client cert CN, so
        // omitting the cert means the sidecar would authenticate as
        // "anonymous" and fail every authorisation check at first
        // publish — better to fail loudly here at boot.
        let tls = build_rustls_client_config(&cfg).await?;
        opts.set_transport(Transport::tls_with_config(TlsConfiguration::Rustls(tls)));
    }

    let (client, event_loop) = AsyncClient::new(opts, 1024);
    let (tx, rx) = mpsc::channel::<RawMqttMessage>(MQTT_CHANNEL_CAPACITY);

    let qos = qos_from_u8(cfg.qos);
    for filter in &cfg.topic_filters {
        client
            .subscribe(filter.clone(), qos)
            .await
            .map_err(|source| MqttError::Subscribe {
                filter: filter.clone(),
                source,
            })?;
    }

    let handle = tokio::spawn(run_event_loop(event_loop, tx, client));
    Ok(MqttMessageStream { rx, handle })
}

fn build_mqtt_options(cfg: &MqttConfig) -> Result<MqttOptions, MqttError> {
    validate_config(cfg)?;
    let parsed_url = parse_broker_url(&cfg.broker_url)?;
    let mut opts = MqttOptions::new(&cfg.client_id, parsed_url.host, parsed_url.port);
    if let (Some(username), Some(password)) = (&cfg.username, &cfg.password) {
        opts.set_credentials(username, password);
    }
    opts.set_keep_alive(Duration::from_secs(30));
    opts.set_clean_session(false);
    opts.set_manual_acks(true);
    Ok(opts)
}

/// Build the `rustls::ClientConfig` that backs `Transport::Rustls`.
/// Platform CA pinned; system roots intentionally NOT consulted (same
/// posture as `crate::persistence::PostgresSink::connect`).
///
/// # Errors
/// - [`MqttError::MtlsMaterialMissing`] — defence in depth; the public
///   [`validate_config`] already gates this path, but we re-check so a
///   future internal call site that skipped the validator still fails
///   safely.
/// - [`MqttError::TlsMaterial`] — one of the cert/key files cannot be
///   read.
/// - [`MqttError::Tls`] — PEM parsing failed, the CA file contained
///   zero certificates, or rustls refused the cert/key pair.
async fn build_rustls_client_config(
    cfg: &MqttConfig,
) -> Result<Arc<rustls::ClientConfig>, MqttError> {
    // Defence in depth: validate_config already enforces this, but a
    // direct caller of build_rustls_client_config would otherwise
    // silently dereference None.
    let (Some(ca_path), Some(cert_path), Some(key_path)) = (
        cfg.server_ca_cert_pem.as_ref(),
        cfg.client_cert_pem.as_ref(),
        cfg.client_key_pem.as_ref(),
    ) else {
        return Err(MqttError::MtlsMaterialMissing);
    };

    // 1. Server CA — only this CA is trusted; system roots are
    //    deliberately omitted. Mirrors persistence.rs:220-230.
    let ca_bytes = tokio::fs::read(ca_path)
        .await
        .map_err(|source| MqttError::TlsMaterial {
            path: ca_path.clone(),
            source,
        })?;
    let mut roots = rustls::RootCertStore::empty();
    for cert in CertificateDer::pem_slice_iter(&ca_bytes) {
        let cert = cert.map_err(|e| MqttError::Tls(e.to_string()))?;
        roots.add(cert).map_err(|e| MqttError::Tls(e.to_string()))?;
    }
    if roots.is_empty() {
        return Err(MqttError::Tls(
            "server_ca_cert_pem contained zero certificates".to_owned(),
        ));
    }

    // 2. Client cert chain.
    let cert_bytes = tokio::fs::read(cert_path)
        .await
        .map_err(|source| MqttError::TlsMaterial {
            path: cert_path.clone(),
            source,
        })?;
    let cert_chain: Vec<_> = CertificateDer::pem_slice_iter(&cert_bytes)
        .collect::<Result<_, _>>()
        .map_err(|e| MqttError::Tls(e.to_string()))?;
    if cert_chain.is_empty() {
        return Err(MqttError::Tls(
            "client_cert_pem contained zero certificates".to_owned(),
        ));
    }

    // 3. Client private key. PrivateKeyDer::from_pem_slice accepts
    //    PKCS#1 / PKCS#8 / SEC-1 transparently (parity with the old
    //    rustls_pemfile::private_key); NoItemsFound keeps the explicit
    //    "no private key" error message.
    let key_bytes = tokio::fs::read(key_path)
        .await
        .map_err(|source| MqttError::TlsMaterial {
            path: key_path.clone(),
            source,
        })?;
    let key = match PrivateKeyDer::from_pem_slice(&key_bytes) {
        Ok(key) => key,
        Err(rustls_pki_types::pem::Error::NoItemsFound) => {
            return Err(MqttError::Tls(
                "client_key_pem contained no private key".to_owned(),
            ));
        }
        Err(e) => return Err(MqttError::Tls(e.to_string())),
    };

    // 4. Final ClientConfig — the rumqttc TLS layer wraps this in
    //    Arc<ClientConfig> per its TlsConfiguration::Rustls signature.
    let client_config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_client_auth_cert(cert_chain, key)
        .map_err(|e| MqttError::Tls(e.to_string()))?;
    Ok(Arc::new(client_config))
}

/// rumqttc EventLoop driver.
async fn run_event_loop(
    mut event_loop: EventLoop,
    tx: mpsc::Sender<RawMqttMessage>,
    client: AsyncClient,
) {
    loop {
        match event_loop.poll().await {
            Ok(Event::Incoming(Packet::Publish(p))) => {
                let msg = RawMqttMessage {
                    topic: p.topic.clone(),
                    payload: p.payload.clone(),
                    received_at: Instant::now(),
                    ack: MqttAckToken {
                        client: client.clone(),
                        publish: p,
                    },
                };
                if tx.send(msg).await.is_err() {
                    tracing::info!("mqtt receiver dropped; shutting down event loop");
                    return;
                }
            }
            Ok(other) => {
                tracing::trace!(?other, "mqtt non-publish event");
            }
            Err(e) => {
                tracing::warn!(error = %e, "mqtt event loop error; will retry");
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
}

const fn qos_from_u8(q: u8) -> QoS {
    match q {
        0 => QoS::AtMostOnce,
        _ => QoS::AtLeastOnce,
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedBrokerUrl {
    host: String,
    port: u16,
    tls: bool,
}

fn parse_broker_url(raw: &str) -> Result<ParsedBrokerUrl, MqttError> {
    let truncated = || {
        let mut s = raw.to_owned();
        s.truncate(64);
        s
    };
    let (scheme, rest) = raw
        .split_once("://")
        .ok_or_else(|| MqttError::InvalidBrokerUrl {
            got: truncated(),
            reason: "missing '://'",
        })?;
    let tls = match scheme {
        "mqtt" => false,
        "mqtts" => true,
        _ => {
            return Err(MqttError::InvalidBrokerUrl {
                got: truncated(),
                reason: "scheme must be mqtt:// or mqtts://",
            });
        }
    };
    let authority = rest.split('/').next().unwrap_or("");
    let Some((host_str, port_str)) = authority.rsplit_once(':') else {
        return Err(MqttError::InvalidBrokerUrl {
            got: truncated(),
            reason: "missing :port",
        });
    };
    if host_str.is_empty() {
        return Err(MqttError::InvalidBrokerUrl {
            got: truncated(),
            reason: "empty host",
        });
    }
    let port = port_str
        .parse::<u16>()
        .map_err(|_| MqttError::InvalidBrokerUrl {
            got: truncated(),
            reason: "port is not a u16",
        })?;
    Ok(ParsedBrokerUrl {
        host: host_str.to_owned(),
        port,
        tls,
    })
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::path::PathBuf;

    use tempfile::NamedTempFile;

    use super::{
        MqttError, ParsedBrokerUrl, parse_broker_url, qos_from_u8, start, validate_config,
    };
    use crate::config::MqttConfig;

    fn cfg(broker: &str, filters: Vec<&str>, qos: u8) -> MqttConfig {
        MqttConfig {
            broker_url: broker.to_owned(),
            client_id: "test".to_owned(),
            topic_filters: filters.into_iter().map(String::from).collect(),
            qos,
            username: None,
            password: None,
            server_ca_cert_pem: None,
            client_cert_pem: None,
            client_key_pem: None,
        }
    }

    /// Write a minimal PEM stub to a NamedTempFile and return both —
    /// the caller keeps the handle alive so the file is not deleted
    /// before the test reads it. The contents are intentionally NOT
    /// a valid cert: tests that just assert "all three paths supplied"
    /// pass before any TLS parse runs (validate_config), and tests
    /// that DO parse use this same stub to drive the rustls error
    /// path deterministically.
    fn pem_stub(label: &str) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        // Empty body — pem_slice_iter yields no items (CA branch maps
        // that to MqttError::Tls("...zero certificates...")) and
        // PrivateKeyDer::from_pem_slice returns NoItemsFound (key
        // branch maps it to MqttError::Tls("...no private key...")).
        writeln!(f, "-----BEGIN {label}-----").unwrap();
        writeln!(f, "-----END {label}-----").unwrap();
        f
    }

    fn pem_path(f: &NamedTempFile) -> PathBuf {
        f.path().to_path_buf()
    }

    #[test]
    fn parses_plain_mqtt() {
        let p = parse_broker_url("mqtt://broker.internal:1883").unwrap();
        assert_eq!(
            p,
            ParsedBrokerUrl {
                host: "broker.internal".to_owned(),
                port: 1883,
                tls: false,
            }
        );
    }

    #[test]
    fn parses_mqtts() {
        let p = parse_broker_url("mqtts://nats:8883").unwrap();
        assert!(p.tls);
        assert_eq!(p.port, 8883);
    }

    #[test]
    fn parses_with_trailing_path() {
        let p = parse_broker_url("mqtt://b:1883/health").unwrap();
        assert_eq!(p.host, "b");
        assert_eq!(p.port, 1883);
    }

    #[test]
    fn rejects_missing_scheme() {
        match parse_broker_url("broker:1883") {
            Err(MqttError::InvalidBrokerUrl { reason, .. }) => assert!(reason.contains("'://'")),
            other => panic!("expected InvalidBrokerUrl, got {other:?}"),
        }
    }

    #[test]
    fn rejects_wrong_scheme() {
        match parse_broker_url("ws://broker:1883") {
            Err(MqttError::InvalidBrokerUrl { reason, .. }) => assert!(reason.contains("scheme")),
            other => panic!("expected InvalidBrokerUrl, got {other:?}"),
        }
    }

    #[test]
    fn rejects_missing_port() {
        match parse_broker_url("mqtt://broker") {
            Err(MqttError::InvalidBrokerUrl { reason, .. }) => assert!(reason.contains(":port")),
            other => panic!("expected InvalidBrokerUrl, got {other:?}"),
        }
    }

    #[test]
    fn rejects_non_u16_port() {
        match parse_broker_url("mqtt://broker:abc") {
            Err(MqttError::InvalidBrokerUrl { reason, .. }) => assert!(reason.contains("u16")),
            other => panic!("expected InvalidBrokerUrl, got {other:?}"),
        }
    }

    #[test]
    fn rejects_empty_host() {
        match parse_broker_url("mqtt://:1883") {
            Err(MqttError::InvalidBrokerUrl { reason, .. }) => {
                assert!(reason.contains("empty host"));
            }
            other => panic!("expected InvalidBrokerUrl, got {other:?}"),
        }
    }

    #[test]
    fn truncates_long_url_in_error() {
        let bad: String = std::iter::repeat_n('x', 200).collect();
        match parse_broker_url(&bad) {
            Err(MqttError::InvalidBrokerUrl { got, .. }) => {
                assert_eq!(got.len(), 64, "log echo should be truncated");
            }
            other => panic!("expected InvalidBrokerUrl, got {other:?}"),
        }
    }

    #[test]
    fn validate_config_happy() {
        let c = cfg("mqtt://b:1883", vec!["sensors/#"], 1);
        assert!(validate_config(&c).is_ok());
    }

    #[test]
    fn validate_config_rejects_empty_filters() {
        let c = cfg("mqtt://b:1883", vec![], 1);
        match validate_config(&c) {
            Err(MqttError::NoTopicFilters) => {}
            other => panic!("expected NoTopicFilters, got {other:?}"),
        }
    }

    #[test]
    fn validate_config_rejects_qos2() {
        let c = cfg("mqtt://b:1883", vec!["sensors/#"], 2);
        match validate_config(&c) {
            Err(MqttError::UnsupportedQos(q)) => assert_eq!(q, 2),
            other => panic!("expected UnsupportedQos, got {other:?}"),
        }
    }

    #[test]
    fn validate_config_rejects_qos0_for_durable_ingress() {
        let c = cfg("mqtt://b:1883", vec!["sensors/#"], 0);
        match validate_config(&c) {
            Err(MqttError::UnsupportedQos(q)) => assert_eq!(q, 0),
            other => panic!("expected UnsupportedQos, got {other:?}"),
        }
    }

    #[test]
    fn validate_config_rejects_empty_persistent_client_id() {
        let mut c = cfg("mqtt://b:1883", vec!["sensors/#"], 1);
        c.client_id.clear();
        assert!(matches!(
            validate_config(&c),
            Err(MqttError::MissingClientId)
        ));
    }

    #[test]
    fn durable_session_options_are_manual_ack_and_persistent() {
        let options =
            super::build_mqtt_options(&cfg("mqtt://b:1883", vec!["sensors/#"], 1)).unwrap();
        assert!(options.manual_acks());
        assert!(!options.clean_session());
        assert_eq!(options.client_id(), "test");
    }

    #[test]
    fn validate_config_propagates_url_error() {
        let c = cfg("ws://broker", vec!["sensors/#"], 1);
        assert!(validate_config(&c).is_err());
    }

    #[test]
    fn qos_mapping() {
        use rumqttc::QoS;
        assert!(matches!(qos_from_u8(0), QoS::AtMostOnce));
        assert!(matches!(qos_from_u8(1), QoS::AtLeastOnce));
    }

    #[test]
    fn validate_config_rejects_mqtts_without_certs() {
        // mqtts:// implies the broker expects mTLS — and the platform
        // CA must be pinned. validate_config must refuse to start
        // before any socket opens, so a misconfiguration cannot fall
        // through to system-roots TLS.
        let c = cfg("mqtts://broker:8883", vec!["sensors/#"], 1);
        match validate_config(&c) {
            Err(MqttError::MtlsMaterialMissing) => {}
            other => panic!("expected MtlsMaterialMissing, got {other:?}"),
        }
    }

    #[test]
    fn validate_config_accepts_mqtts_with_all_certs() {
        // Validator only checks "all three paths supplied"; it does
        // not read the files yet. Real PEM parsing happens inside
        // start() / build_rustls_client_config and is covered by the
        // start_returns_* async tests below.
        let ca = pem_stub("CERTIFICATE");
        let cert = pem_stub("CERTIFICATE");
        let key = pem_stub("PRIVATE KEY");
        let mut c = cfg("mqtts://broker:8883", vec!["sensors/#"], 1);
        c.server_ca_cert_pem = Some(pem_path(&ca));
        c.client_cert_pem = Some(pem_path(&cert));
        c.client_key_pem = Some(pem_path(&key));
        assert!(validate_config(&c).is_ok());
    }

    #[tokio::test]
    async fn start_returns_tls_material_error_when_ca_missing() {
        // CA path points to a file that does not exist; the cert+key
        // can be present (they are read AFTER the CA in the helper).
        // The expectation: TlsMaterial error before any socket opens.
        let cert = pem_stub("CERTIFICATE");
        let key = pem_stub("PRIVATE KEY");
        let mut c = cfg("mqtts://broker:8883", vec!["sensors/#"], 1);
        c.server_ca_cert_pem = Some(PathBuf::from("/nonexistent/ca.pem"));
        c.client_cert_pem = Some(pem_path(&cert));
        c.client_key_pem = Some(pem_path(&key));
        match start(c).await {
            Err(MqttError::TlsMaterial { path, .. }) => {
                assert_eq!(path.to_str().unwrap(), "/nonexistent/ca.pem");
            }
            other => panic!("expected TlsMaterial, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn start_returns_tls_error_on_invalid_pem() {
        // Empty PEM stubs: CertificateDer::pem_slice_iter reads zero
        // items from the CA file → build_rustls_client_config maps
        // that to MqttError::Tls("...zero certificates..."). The point
        // is to pin the rustls error path; the exact message is not
        // part of the contract.
        let ca = pem_stub("CERTIFICATE");
        let cert = pem_stub("CERTIFICATE");
        let key = pem_stub("PRIVATE KEY");
        let mut c = cfg("mqtts://broker:8883", vec!["sensors/#"], 1);
        c.server_ca_cert_pem = Some(pem_path(&ca));
        c.client_cert_pem = Some(pem_path(&cert));
        c.client_key_pem = Some(pem_path(&key));
        match start(c).await {
            Err(MqttError::Tls(_)) => {}
            other => panic!("expected Tls error, got {other:?}"),
        }
    }
}
