//! `nats-client` — opinionated `async-nats` factory.
//!
//! WHY this crate exists:
//!   ADR-014/015 establish that NATS identity comes ONLY from the
//!   mTLS client certificate CN. user/pass and token auth are
//!   forbidden. Every Rust service that talks to NATS must enforce
//!   this invariant; centralising the factory means individual
//!   call-sites cannot drift.
//!
//!   The connection-builder API in this crate intentionally lacks any
//!   `with_user_pass(...)` / `with_token(...)` constructor — there is
//!   no path to construct a [`NatsClient`] without supplying mTLS cert
//!   paths via [`MtlsConfig`]. Adding such a path requires editing
//!   this crate (which surfaces in code review).
//!   Architectural-solution tier 1: "Make it impossible".
//!
//!   Each service is provisioned in `infrastructure/nats/services.yaml`
//!   (single source of truth, ADR-015). Adding a new service = edit
//!   `services.yaml` + mint cert CN + run
//!   `scripts/nats/generate-nats-conf.py` in the same commit. CI
//!   invariant `e2e/tests/integration/nats-invariants.spec.ts`
//!   enforces it.
//!
//! WHAT lives here:
//!   - [`MtlsConfig`]     — required cert paths + server URL.
//!   - [`NatsClient`]     — thin wrapper over `async_nats::Client`.
//!   - [`NatsClientError`] — typed errors at the connect / publish /
//!     subscribe / request boundaries.
//!   - [`HeaderMap`]      — re-export of `async_nats::HeaderMap` so
//!     callers attach headers to `publish_with_headers` without
//!     adding `async-nats` as a direct `Cargo.toml` dep. Keeps the
//!     abstraction barrier around NATS intact.

#![cfg_attr(not(test), forbid(unsafe_code))]
#![cfg_attr(not(test), deny(missing_docs))]
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing,
    )
)]

/// Re-export of `async_nats::HeaderMap`. Callers attach headers
/// (e.g. the ADR-032 W3C `traceparent`) to [`NatsClient::publish_with_headers`]
/// via this type without breaking the abstraction barrier around
/// `async-nats`.
pub use async_nats::HeaderMap;

pub mod request_reply;
pub use request_reply::{RequestError, request_typed};

use std::path::{Path, PathBuf};
use std::time::Duration;

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Crate version for diagnostic / drift-detection telemetry.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// All ways `nats-client` can refuse to do its job.
#[derive(Debug, Error)]
pub enum NatsClientError {
    /// One of the cert / key files in [`MtlsConfig`] does not exist or
    /// the process cannot read it.
    #[error("cannot read TLS material at {path}: {source}")]
    TlsMaterial {
        /// File path that failed to load.
        path: PathBuf,
        /// Underlying I/O error.
        #[source]
        source: std::io::Error,
    },

    /// `server_url` did not start with `nats://` or `tls://`. We refuse
    /// any other scheme (including plain `tcp://`) so that an operator
    /// cannot misconfigure away from TLS by accident.
    #[error("server_url must use the `nats://` or `tls://` scheme (got '{got}')")]
    InvalidServerUrl {
        /// Scheme prefix the operator supplied.
        got: String,
    },

    /// `async-nats` could not establish or maintain the connection.
    #[error("NATS transport error")]
    Transport(#[source] async_nats::ConnectError),

    /// Publish-side errors (broker rejected, queue full, etc.).
    #[error("NATS publish error")]
    Publish(#[source] async_nats::PublishError),

    /// Subscribe-side errors (broker rejected the subject filter,
    /// resource limit hit).
    #[error("NATS subscribe error")]
    Subscribe(#[source] async_nats::SubscribeError),

    /// Request-side errors (no responder, timeout).
    #[error("NATS request error")]
    Request(#[source] async_nats::RequestError),

    /// The client certificate path does not name a NATS identity, so
    /// this client has no reply inbox to own (ORPHAN-CRITICAL-402).
    #[error(
        "NATS client certificate path {path} does not follow the \
         <identity>-cert.pem naming the certificate generator mints, so the \
         per-identity reply-inbox prefix cannot be derived"
    )]
    InboxIdentity {
        /// The offending `client_cert_pem` path.
        path: PathBuf,
    },
}

/// First-token namespace root for per-identity reply inboxes. Mirrors
/// `PLATFORM_INBOX_PREFIX_ROOT` in `libs/event-contracts/src/nats-inbox.ts`;
/// `e2e/tests/integration/nats-invariants.spec.ts` pins both sides against
/// `infrastructure/nats/services.yaml`.
const INBOX_PREFIX_ROOT: &str = "_INBOX_";

/// Suffix `infrastructure/docker/scripts/generate-internal-certs.sh` gives
/// every client certificate it mints.
const CLIENT_CERT_SUFFIX: &str = "-cert.pem";

/// Derive this client's reply-inbox prefix from its mTLS certificate path.
///
/// # Why the path and not the certificate's own CN
///
/// The identity that matters is the certificate CN — that is what
/// `verify_and_map: true` turns into the broker's user entry, and the ACL
/// grants `_INBOX_<CN>.>` to that user alone. Reading the CN back out of the
/// DER would need an ASN.1 parser (a new supply-chain dependency for one
/// string), so this derivation uses the file name instead, which the platform
/// already binds to the CN in two enforced places:
///
///   - `generate-internal-certs.sh` writes `<svc_user>-cert.pem` and then
///     ASSERTS `subject=CN=<svc_user>` on the file it just wrote;
///   - `nats-invariants.spec.ts` asserts every compose service's
///     `NATS_TLS_CERT` ends in `/<identity>-cert.pem` for its services.yaml
///     identity.
///
/// A mismatch therefore cannot reach a deploy, and if one somehow did the
/// failure is loud (the broker refuses the inbox subscription) rather than
/// silent.
///
/// # Errors
/// - [`NatsClientError::InboxIdentity`] — the path does not end in
///   `<identity>-cert.pem`, or the identity is not a single NATS token.
pub fn inbox_prefix_from_cert_path(cert_path: &Path) -> Result<String, NatsClientError> {
    let reject = || NatsClientError::InboxIdentity {
        path: cert_path.to_path_buf(),
    };
    let identity = cert_path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_suffix(CLIENT_CERT_SUFFIX))
        .ok_or_else(reject)?;
    // A dot would split the prefix into two NATS tokens and silently widen the
    // inbox namespace; anything else non-token would be rejected by the broker.
    let is_token = !identity.is_empty()
        && identity.starts_with(|c: char| c.is_ascii_alphabetic())
        && identity
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !is_token {
        return Err(reject());
    }
    Ok(format!("{INBOX_PREFIX_ROOT}{identity}"))
}

/// mTLS configuration for [`NatsClient::connect`]. Constructable only
/// via the public fields — a future "without TLS" constructor would
/// require editing this struct, which is the point.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MtlsConfig {
    /// NATS server URL. MUST start with `nats://` or `tls://`. Plain
    /// `tcp://` is rejected by the connect path.
    pub server_url: String,

    /// PEM-encoded root CA used to verify the NATS server's
    /// certificate. ADR-015 requires that the CA pin to the platform's
    /// internal PKI; system roots are intentionally NOT consulted.
    pub server_ca_cert_pem: PathBuf,

    /// PEM-encoded client certificate. Its Common Name (CN) is the
    /// service identity that NATS consults via `verify_and_map: true`.
    pub client_cert_pem: PathBuf,

    /// PEM-encoded client private key paired with `client_cert_pem`.
    pub client_key_pem: PathBuf,

    /// Connect timeout. Defaults to 10 seconds when missing in config.
    #[serde(default = "default_connect_timeout", with = "duration_secs")]
    pub connect_timeout: Duration,
}

fn default_connect_timeout() -> Duration {
    Duration::from_secs(10)
}

mod duration_secs {
    use std::time::Duration;

    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S>(d: &Duration, ser: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        d.as_secs().serialize(ser)
    }

    pub fn deserialize<'de, D>(de: D) -> Result<Duration, D::Error>
    where
        D: Deserializer<'de>,
    {
        let secs = u64::deserialize(de)?;
        Ok(Duration::from_secs(secs))
    }
}

/// Thin, opinionated wrapper over `async_nats::Client`. Hides the
/// connect-options surface so that mTLS-only auth is the only
/// reachable code path.
#[derive(Debug, Clone)]
pub struct NatsClient {
    inner: async_nats::Client,
}

impl NatsClient {
    /// Establish an mTLS-authenticated connection to the NATS server
    /// described by `cfg`.
    ///
    /// Errors:
    /// - [`NatsClientError::InvalidServerUrl`] — scheme is neither
    ///   `nats://` nor `tls://`.
    /// - [`NatsClientError::TlsMaterial`] — one of the cert / key
    ///   files cannot be read.
    /// - [`NatsClientError::Transport`] — async-nats failed to
    ///   handshake or maintain the connection.
    pub async fn connect(cfg: &MtlsConfig) -> Result<Self, NatsClientError> {
        validate_url_scheme(&cfg.server_url)?;
        ensure_readable(&cfg.server_ca_cert_pem).await?;
        ensure_readable(&cfg.client_cert_pem).await?;
        ensure_readable(&cfg.client_key_pem).await?;

        // Build async-nats ConnectOptions deliberately:
        //   * require_tls(true) so a misconfigured server downgrade is
        //     refused.
        //   * add_root_certificates with the explicit CA path — the
        //     platform PKI is the only acceptable trust root.
        //   * add_client_certificate with the cert+key pair — this is
        //     the identity the broker maps via verify_and_map.
        //   * NO add_user_password / token / nkey calls — the absence
        //     is the architectural enforcement of ADR-014/015.
        //   * connection_timeout from config.
        //   * custom_inbox_prefix so request-reply responses land on THIS
        //     identity's own first subject token. async-nats defaults to the
        //     fleet-shared `_INBOX`, which every certificate could subscribe —
        //     the ORPHAN-CRITICAL-402 confidentiality hole. The broker grants
        //     `_INBOX_<CN>.>` to this CN alone, so a default prefix would now
        //     also be refused outright.
        let opts = async_nats::ConnectOptions::new()
            .require_tls(true)
            .add_root_certificates(cfg.server_ca_cert_pem.clone())
            .add_client_certificate(cfg.client_cert_pem.clone(), cfg.client_key_pem.clone())
            .custom_inbox_prefix(inbox_prefix_from_cert_path(&cfg.client_cert_pem)?)
            .connection_timeout(cfg.connect_timeout);

        let inner = opts
            .connect(&cfg.server_url)
            .await
            .map_err(NatsClientError::Transport)?;
        Ok(Self { inner })
    }

    /// Publish raw bytes to a subject.
    pub async fn publish(
        &self,
        subject: impl Into<async_nats::Subject> + Send,
        payload: Bytes,
    ) -> Result<(), NatsClientError> {
        self.inner
            .publish(subject.into(), payload)
            .await
            .map_err(NatsClientError::Publish)
    }

    //
    // Re-export of `async_nats::HeaderMap` is immediately above
    // [`NatsClient::publish_with_headers`] so callers can hold the
    // header map type without adding `async-nats` as a direct dep to
    // their own `Cargo.toml` — the abstraction barrier around NATS
    // stays intact.
    //
    /// Publish raw bytes to a subject WITH a NATS header map attached.
    /// Every downstream consumer (TS `@platform/event-bus`, the
    /// alert-engine's NATS consumer, OTel collectors) reads these
    /// headers on the delivery path. The sensor-ingestion sidecar
    /// uses this surface to attach the W3C `traceparent` header
    /// (ADR-032 Kör Nokta 3) so cross-language distributed traces
    /// join across the NATS hop.
    ///
    /// Headers follow the async-nats `HeaderMap` shape — a
    /// case-insensitive map of `HeaderName` → `Vec<HeaderValue>` —
    /// which matches the TS side's header model byte-for-byte.
    pub async fn publish_with_headers(
        &self,
        subject: impl Into<async_nats::Subject> + Send,
        headers: async_nats::HeaderMap,
        payload: Bytes,
    ) -> Result<(), NatsClientError> {
        self.inner
            .publish_with_headers(subject.into(), headers, payload)
            .await
            .map_err(NatsClientError::Publish)
    }

    /// Subscribe to a subject (or wildcard). The returned subscriber
    /// is the upstream `async_nats::Subscriber` — callers that need
    /// stricter typing wrap it themselves.
    pub async fn subscribe(
        &self,
        subject: impl Into<async_nats::Subject> + Send,
    ) -> Result<async_nats::Subscriber, NatsClientError> {
        self.inner
            .subscribe(subject.into())
            .await
            .map_err(NatsClientError::Subscribe)
    }

    /// Request-reply. Mostly used by the cache-miss lookup path
    /// (sensor.lookup.by-topic) per ADR-025.
    pub async fn request(
        &self,
        subject: impl Into<async_nats::Subject> + Send,
        payload: Bytes,
    ) -> Result<async_nats::Message, NatsClientError> {
        self.inner
            .request(subject.into(), payload)
            .await
            .map_err(NatsClientError::Request)
    }

    /// Borrow the underlying client for advanced operations not yet
    /// wrapped (JetStream contexts, KV buckets). Kept narrow so that
    /// the wrapper's invariants stay enforceable.
    #[must_use]
    pub const fn inner(&self) -> &async_nats::Client {
        &self.inner
    }

    /// Plaintext (no TLS) constructor available ONLY when the
    /// `test-utils` feature is enabled. Used by integration tests
    /// that spin up a short-lived NATS broker via testcontainers
    /// and cannot reasonably mount a TLS certificate per test run.
    ///
    /// WHY this is feature-gated instead of always-present:
    ///   ADR-014/015 establishes mTLS as the SOLE identity anchor
    ///   for NATS. A plaintext constructor in the production build
    ///   would open a path that bypasses the identity SSoT. Gating
    ///   behind `test-utils` means the plaintext path simply does
    ///   not exist in any `cargo build --release` artifact — the
    ///   "make it impossible" tier-1 invariant holds at the
    ///   compilation boundary, not at a runtime check.
    ///
    /// # Errors
    /// - [`NatsClientError::InvalidServerUrl`] — scheme is neither
    ///   `nats://` nor `tls://`. Even the plaintext constructor
    ///   rejects malformed URLs so tests hit a clear error shape.
    /// - [`NatsClientError::Transport`] — async-nats failed to
    ///   connect.
    #[cfg(feature = "test-utils")]
    pub async fn connect_plaintext(url: &str, identity: &str) -> Result<Self, NatsClientError> {
        validate_url_scheme(url)?;
        // No `require_tls`, no cert/key material — the plaintext
        // path is the OPPOSITE of production's identity posture.
        // The feature-gate above is the only guard against this
        // path shipping outside tests.
        //
        // `identity` is still required: no connection this crate builds may
        // fall back to async-nats' shared `_INBOX` default, so the test path
        // names its inbox the same way production does.
        let opts = async_nats::ConnectOptions::new()
            .custom_inbox_prefix(format!("{INBOX_PREFIX_ROOT}{identity}"));
        let inner = opts
            .connect(url)
            .await
            .map_err(NatsClientError::Transport)?;
        Ok(Self { inner })
    }
}

fn validate_url_scheme(url: &str) -> Result<(), NatsClientError> {
    if url.starts_with("nats://") || url.starts_with("tls://") {
        Ok(())
    } else {
        // Slice up to the first `:` if any so we report the bad scheme
        // without echoing arbitrary bytes from later in the URL.
        let scheme_end = url.find(':').unwrap_or(url.len()).min(32);
        let got = url.get(..scheme_end).unwrap_or("").to_owned();
        Err(NatsClientError::InvalidServerUrl { got })
    }
}

async fn ensure_readable(path: &Path) -> Result<(), NatsClientError> {
    tokio::fs::metadata(path)
        .await
        .map(|_| ())
        .map_err(|source| NatsClientError::TlsMaterial {
            path: path.to_path_buf(),
            source,
        })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tempfile::NamedTempFile;

    use super::{
        MtlsConfig, NatsClient, NatsClientError, inbox_prefix_from_cert_path, validate_url_scheme,
    };

    // ── Per-identity reply inbox (ORPHAN-CRITICAL-402) ──────────────────────

    #[test]
    fn inbox_prefix_names_the_certificate_identity() {
        let prefix =
            inbox_prefix_from_cert_path(std::path::Path::new("/etc/ssl/nats/clients/farm_service-cert.pem"))
                .unwrap();
        assert_eq!(prefix, "_INBOX_farm_service");
    }

    #[test]
    fn inbox_prefix_is_never_the_shared_default() {
        for name in ["sensor-ingestion", "sensor_service", "gateway_service"] {
            let prefix =
                inbox_prefix_from_cert_path(std::path::Path::new(&format!("/c/{name}-cert.pem")))
                    .unwrap();
            // First-token distinctness is the whole cure: `_INBOX.>` matches
            // only subjects whose first token is exactly `_INBOX`.
            assert_ne!(prefix, "_INBOX");
            assert_ne!(prefix.split('.').next().unwrap(), "_INBOX");
            assert!(prefix.starts_with("_INBOX_"));
        }
    }

    #[test]
    fn inbox_prefix_rejects_a_path_that_names_no_identity() {
        for path in [
            "/etc/ssl/nats/clients/farm_service.pem",
            "/etc/ssl/nats/clients/-cert.pem",
            "/etc/ssl/nats/clients/farm.service-cert.pem",
            "/etc/ssl/nats/clients/9farm-cert.pem",
            "/etc/ssl/nats/clients/",
        ] {
            match inbox_prefix_from_cert_path(std::path::Path::new(path)) {
                Err(NatsClientError::InboxIdentity { .. }) => {}
                other => panic!("expected InboxIdentity for {path}, got {other:?}"),
            }
        }
    }

    fn dummy_pem_file() -> NamedTempFile {
        let f = NamedTempFile::new().unwrap();
        std::fs::write(f.path(), b"-----BEGIN FAKE-----\n-----END FAKE-----\n").unwrap();
        f
    }

    #[test]
    fn validate_url_scheme_accepts_nats() {
        assert!(validate_url_scheme("nats://localhost:4222").is_ok());
    }

    #[test]
    fn validate_url_scheme_accepts_tls() {
        assert!(validate_url_scheme("tls://nats.example.com:4222").is_ok());
    }

    #[test]
    fn validate_url_scheme_rejects_tcp() {
        match validate_url_scheme("tcp://localhost:4222") {
            Err(NatsClientError::InvalidServerUrl { got }) => assert_eq!(got, "tcp"),
            other => panic!("expected InvalidServerUrl, got {other:?}"),
        }
    }

    #[test]
    fn validate_url_scheme_rejects_http() {
        match validate_url_scheme("http://nats.example.com") {
            Err(NatsClientError::InvalidServerUrl { got }) => assert_eq!(got, "http"),
            other => panic!("expected InvalidServerUrl, got {other:?}"),
        }
    }

    #[test]
    fn validate_url_scheme_rejects_no_scheme() {
        match validate_url_scheme("nats.example.com:4222") {
            Err(NatsClientError::InvalidServerUrl { .. }) => {}
            other => panic!("expected InvalidServerUrl, got {other:?}"),
        }
    }

    #[test]
    fn mtls_config_serde_round_trip() {
        let cfg = MtlsConfig {
            server_url: "tls://nats:4222".to_owned(),
            server_ca_cert_pem: "/etc/aqua/ca.pem".into(),
            client_cert_pem: "/etc/aqua/client.crt".into(),
            client_key_pem: "/etc/aqua/client.key".into(),
            connect_timeout: Duration::from_secs(15),
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: MtlsConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cfg);
    }

    #[test]
    fn mtls_config_default_timeout_when_missing() {
        let json = r#"{
            "server_url": "tls://n:4222",
            "server_ca_cert_pem": "/x/ca",
            "client_cert_pem": "/x/c",
            "client_key_pem": "/x/k"
        }"#;
        let cfg: MtlsConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.connect_timeout, Duration::from_secs(10));
    }

    #[tokio::test]
    async fn connect_rejects_missing_ca_file() {
        let client = dummy_pem_file();
        let key = dummy_pem_file();
        let cfg = MtlsConfig {
            server_url: "tls://localhost:4222".to_owned(),
            server_ca_cert_pem: "/nonexistent/ca.pem".into(),
            client_cert_pem: client.path().to_path_buf(),
            client_key_pem: key.path().to_path_buf(),
            connect_timeout: Duration::from_secs(1),
        };
        match NatsClient::connect(&cfg).await {
            Err(NatsClientError::TlsMaterial { path, .. }) => {
                assert_eq!(path.to_str().unwrap(), "/nonexistent/ca.pem");
            }
            other => panic!("expected TlsMaterial error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn connect_rejects_missing_client_cert() {
        let ca = dummy_pem_file();
        let key = dummy_pem_file();
        let cfg = MtlsConfig {
            server_url: "tls://localhost:4222".to_owned(),
            server_ca_cert_pem: ca.path().to_path_buf(),
            client_cert_pem: "/nonexistent/client.crt".into(),
            client_key_pem: key.path().to_path_buf(),
            connect_timeout: Duration::from_secs(1),
        };
        match NatsClient::connect(&cfg).await {
            Err(NatsClientError::TlsMaterial { path, .. }) => {
                assert!(path.to_str().unwrap().ends_with("client.crt"));
            }
            other => panic!("expected TlsMaterial error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn connect_rejects_invalid_url() {
        let f = dummy_pem_file();
        let cfg = MtlsConfig {
            server_url: "http://nats:4222".to_owned(),
            server_ca_cert_pem: f.path().to_path_buf(),
            client_cert_pem: f.path().to_path_buf(),
            client_key_pem: f.path().to_path_buf(),
            connect_timeout: Duration::from_secs(1),
        };
        match NatsClient::connect(&cfg).await {
            Err(NatsClientError::InvalidServerUrl { got }) => assert_eq!(got, "http"),
            other => panic!("expected InvalidServerUrl, got {other:?}"),
        }
    }

    // Architectural assertion (compile-time): the public API of
    // NatsClient does NOT expose `with_user_pass`, `with_token`, or
    // `add_user_password`. This test simply tries to call those names
    // on the wrapper and must FAIL TO TYPE-CHECK if anyone ever adds
    // such a path. Lives in tests/auth_surface_compile_fail.rs to use
    // the trybuild harness.
}
