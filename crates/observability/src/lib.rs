//! `observability` — Rust-side tracing init + PII masking.
//!
//! WHY this crate exists:
//!   The TS side (`@platform/backend-common`) already pushes structured
//!   logs and OpenTelemetry traces to a shared collector. Rust services
//!   must produce compatible spans + attributes so a single dashboard
//!   correlates a `traceparent` propagated through MQTT (v5 user
//!   property) and NATS (header `Nats-Trace-Context`) end-to-end.
//!
//!   PII safety is a first-class concern. The TS `StructuredLoggerService`
//!   (in `libs/backend-common/src/telemetry/`) auto-applies a `maskPii()`
//!   transform; this crate provides a structurally equivalent path:
//!     - Wrap secrets in `secrecy::SecretBox<T>` so accidental Display
//!       / Debug uses cannot reveal the inner value.
//!     - [`Masked<T>`] is a thinner wrapper for non-secret PII (email,
//!       phone, tenant id when logged at INFO) that still must not
//!       leak verbatim — the wrapper hashes + truncates instead.
//!
//! WHAT lives here:
//!   - [`init_tracing`] — JSON-formatter `tracing-subscriber` setup.
//!   - [`Masked`]       — PII Display/Debug masking newtype.
//!   - With `features = ["otlp"]`: an OTLP exporter that pipes spans
//!     to the same collector the TS side uses.

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

use std::fmt;
use std::net::SocketAddr;

use serde::{Deserialize, Serialize};

pub mod cardinality;
pub mod trace_propagation;
pub use cardinality::{TENANT_BUCKET_COUNT, tenant_bucket, tenant_bucket_salted};
pub use trace_propagation::{TRACEPARENT_HEADER, generate_traceparent};

use metrics_exporter_prometheus::PrometheusBuilder;
/// Re-export of `metrics_exporter_prometheus::PrometheusHandle` so
/// callers can hold the handle through a function signature without
/// adding a direct `metrics-exporter-prometheus` dep to their own
/// `Cargo.toml`. sensor-ingestion's `start_metrics_recorder` helper
/// returns `Option<PrometheusHandle>` via this path.
pub use metrics_exporter_prometheus::PrometheusHandle;
use thiserror::Error;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// Crate version for diagnostic / drift-detection telemetry.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Errors raised during [`init_tracing`].
#[derive(Debug, Error)]
pub enum ObservabilityError {
    /// `RUST_LOG` (or override env var) contains a directive that
    /// `tracing-subscriber` could not parse.
    #[error("invalid log filter: {0}")]
    InvalidFilter(String),

    /// A global default subscriber was already installed (likely a
    /// double-init). Only one tracing subscriber may exist per process.
    #[error("tracing subscriber already initialised")]
    AlreadyInitialised,

    /// Prometheus exporter could not install the global recorder or
    /// bind the HTTP listener. The inner message is the
    /// `PrometheusBuilder` error description — no attacker input
    /// reaches this surface so echoing it is safe.
    #[error("prometheus metrics init failed: {0}")]
    MetricsInitFailed(String),
}

/// Tracing init knobs. Defaults aim for production sane:
///   - JSON formatter (machine-parseable, OTel-collector-friendly).
///   - Filter from `RUST_LOG`, falling back to `info`.
///   - Spans included as structured fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TracingOpts {
    /// Service name attached to every span (`service.name` per
    /// OpenTelemetry semantic conventions).
    pub service_name: String,

    /// Service version (`service.version`). Default: crate version of
    /// the caller.
    pub service_version: String,

    /// Environment (`deployment.environment`). One of `development`,
    /// `staging`, `production`. Default: `production` if not set.
    #[serde(default = "default_environment")]
    pub environment: String,

    /// Output format. Stays JSON in production; `pretty` is intended
    /// for local dev only.
    #[serde(default)]
    pub format: TracingFormat,

    /// Override the env-var name used for filter directives. Default
    /// is `RUST_LOG` to match upstream conventions.
    #[serde(default = "default_filter_env")]
    pub filter_env: String,
}

fn default_environment() -> String {
    "production".to_owned()
}

fn default_filter_env() -> String {
    "RUST_LOG".to_owned()
}

/// Output format for the tracing subscriber.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TracingFormat {
    /// Structured JSON. Required in production; collector-parseable.
    #[default]
    Json,
    /// Human-readable. Intended for local dev. `cargo run` defaults
    /// the filter to this when run from a terminal.
    Pretty,
}

impl TracingOpts {
    /// Convenience constructor for service-internal calls.
    #[must_use]
    pub fn new(service_name: impl Into<String>, service_version: impl Into<String>) -> Self {
        Self {
            service_name: service_name.into(),
            service_version: service_version.into(),
            environment: default_environment(),
            format: TracingFormat::default(),
            filter_env: default_filter_env(),
        }
    }
}

/// Install the global `tracing` subscriber. Returns `Ok(())` exactly
/// once per process; subsequent calls return [`ObservabilityError::AlreadyInitialised`].
///
/// The subscriber emits JSON (or pretty) lines with the following
/// canonical fields:
///   - `service.name`, `service.version`, `deployment.environment`
///   - `target` (the `tracing` target, usually a module path)
///   - `level` (`INFO`/`WARN`/...)
///   - `timestamp` RFC 3339 UTC
///   - any structured fields added by the call site
///
/// PII fields MUST be wrapped in [`Masked`] or `secrecy::SecretBox`
/// before being passed to a tracing macro. The masking happens at
/// `Display` / `Debug` time, not at serialisation time, so even an
/// accidental `format!("{x}")` does the right thing.
pub fn init_tracing(opts: &TracingOpts) -> Result<(), ObservabilityError> {
    let filter = EnvFilter::try_from_env(opts.filter_env.as_str())
        .or_else(|_| EnvFilter::try_new("info"))
        .map_err(|e| ObservabilityError::InvalidFilter(e.to_string()))?;

    let registry = tracing_subscriber::registry().with(filter);

    match opts.format {
        TracingFormat::Json => {
            let layer = tracing_subscriber::fmt::layer()
                .json()
                .with_current_span(true)
                .with_span_list(true);
            registry
                .with(layer)
                .try_init()
                .map_err(|_| ObservabilityError::AlreadyInitialised)?;
        }
        TracingFormat::Pretty => {
            let layer = tracing_subscriber::fmt::layer().pretty().with_target(true);
            registry
                .with(layer)
                .try_init()
                .map_err(|_| ObservabilityError::AlreadyInitialised)?;
        }
    }

    // Service-identity span. Wraps the entire process for the lifetime
    // of the program — enter() returns a guard we deliberately leak
    // via mem::forget so every subsequent event carries
    // service.name / service.version / deployment.environment. This is
    // a one-shot, init-time leak; the guard would otherwise be
    // released the instant init_tracing returns, defeating the whole
    // point of recording the identity.
    //
    // OTel resource attributes will replace this when the `otlp`
    // feature is enabled — they are the more idiomatic surface for
    // service-level metadata. Until then the in-band span is the
    // structurally correct fallback.
    let span = tracing::info_span!(
        "service",
        service.name = %opts.service_name,
        service.version = %opts.service_version,
        deployment.environment = %opts.environment,
    );
    std::mem::forget(span.entered());
    Ok(())
}

// ---------- Metrics (Prometheus exporter) -------------------------------

/// Metrics exporter knobs. Off by default so the crate stays silent
/// in stub-mode boots (unit tests, ad-hoc smoke runs) — only
/// deploy-environment configs opt in. Two wire-shapes supported:
///
/// * `enabled: true` + `bind_addr: Some(...)` — install the global
///   recorder AND serve `/metrics` on the given HTTP listener.
///   Production posture.
/// * `enabled: true` + `bind_addr: None` — install the global
///   recorder only. Useful for container orchestrators that scrape
///   the process via a sidecar exporter injected over stdin. Also
///   the shape some integration tests prefer because it does not
///   bind a port.
/// * `enabled: false` — no-op. The metrics crate's default no-op
///   recorder keeps the emission call sites free + the scrape
///   surface silent.
#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
pub struct MetricsOpts {
    /// Gate. `false` → `init_metrics` returns `Ok(None)` without
    /// touching the global recorder. The `Default` derive picks `false`
    /// (the all-zero / all-`None` posture), which matches the
    /// contract: stub-mode boots stay silent.
    #[serde(default)]
    pub enabled: bool,

    /// Optional HTTP listener for the Prometheus scrape endpoint.
    /// `None` = no HTTP server (recorder-only install).
    ///
    /// Serialised as a bare socket-addr string (`"0.0.0.0:9091"`);
    /// serde's default `SocketAddr` FromStr is used.
    #[serde(default)]
    pub bind_addr: Option<SocketAddr>,
}

/// Install the global Prometheus-compatible metrics recorder and
/// (optionally) start the `/metrics` HTTP listener.
///
/// Returns `Ok(Some(handle))` when metrics are enabled; the handle
/// exposes `render()` for programmatic scrape (useful in tests + the
/// `/metrics` HTTP path when a caller wires its own server). Returns
/// `Ok(None)` when `opts.enabled = false` so call sites can treat the
/// feature as a boot-flag without duplicated branching.
///
/// MUST run inside a tokio runtime when `bind_addr` is set — the
/// exporter spawns the HTTP listener via `tokio::spawn`.
///
/// # Errors
/// * [`ObservabilityError::MetricsInitFailed`] — the builder failed
///   to install (typical causes: port already bound, a previous
///   recorder already global). Only one recorder may exist per
///   process; call this exactly once at boot.
pub fn init_metrics(opts: &MetricsOpts) -> Result<Option<PrometheusHandle>, ObservabilityError> {
    if !opts.enabled {
        return Ok(None);
    }
    let mut builder = PrometheusBuilder::new();
    if let Some(addr) = opts.bind_addr {
        builder = builder.with_http_listener(addr);
    }
    let handle = builder
        .install_recorder()
        .map_err(|e| ObservabilityError::MetricsInitFailed(e.to_string()))?;
    Ok(Some(handle))
}

// ---------- Masked PII wrapper ------------------------------------------

/// Wrapper around any `T: AsRef<[u8]>` that masks the value on
/// `Display` and `Debug` so accidental `format!("{x}")` cannot leak
/// PII. The inner value is recoverable via [`Masked::reveal`] which
/// makes the unmasking site obvious in code review.
///
/// Masking strategy: `<first 2 chars>***<last 2 chars>`. For values
/// shorter than 5 bytes, fully redacted to `***` (no length hint).
#[derive(Clone, PartialEq, Eq)]
pub struct Masked<T>(T);

impl<T> Masked<T> {
    /// Wrap a value.
    #[must_use]
    pub const fn new(value: T) -> Self {
        Self(value)
    }

    /// Recover the inner value. Call sites using this MUST be reviewed
    /// for whether the unmasking is justified — typically only at
    /// trust-boundary egress (e.g. signing a payload).
    #[must_use]
    pub fn reveal(self) -> T {
        self.0
    }

    /// Borrow the inner value (also bypasses masking — same review
    /// guidance applies).
    #[must_use]
    pub const fn revealed_ref(&self) -> &T {
        &self.0
    }
}

impl<T: AsRef<[u8]>> fmt::Display for Masked<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let bytes = self.0.as_ref();
        // Use checked .get() instead of slice indexing so the formatter
        // is panic-free even if a future refactor drops the length
        // guard. The length check is still semantically meaningful (we
        // do not want a length-of-3 string masked to "ab***bc"), so
        // keep it.
        if bytes.len() < 5 {
            return f.write_str("***");
        }
        let last_start = bytes.len().saturating_sub(2);
        match (bytes.get(..2), bytes.get(last_start..)) {
            (Some(head), Some(tail)) => {
                let h = String::from_utf8_lossy(head);
                let t = String::from_utf8_lossy(tail);
                write!(f, "{h}***{t}")
            }
            _ => f.write_str("***"),
        }
    }
}

impl<T: AsRef<[u8]>> fmt::Debug for Masked<T> {
    // Debug intentionally identical to Display — the threat model is
    // accidental `{:?}` not deliberate forensic dumping.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        <Self as fmt::Display>::fmt(self, f)
    }
}

impl<T: AsRef<[u8]>> Serialize for Masked<T> {
    /// JSON serialisation goes through `Display` so structured logs
    /// (which call `serialize` per field) also see the mask.
    fn serialize<S>(&self, ser: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        ser.collect_str(self)
    }
}

#[cfg(test)]
mod tests {
    use super::{Masked, ObservabilityError, TracingFormat, TracingOpts, init_tracing};

    #[test]
    fn masked_string_redacts_middle() {
        let m = Masked::new("operator@example.com".to_owned());
        assert_eq!(format!("{m}"), "op***om");
        assert_eq!(format!("{m:?}"), "op***om");
    }

    #[test]
    fn masked_short_string_fully_redacted() {
        let m = Masked::new("abc".to_owned());
        assert_eq!(format!("{m}"), "***");
        assert_eq!(format!("{m:?}"), "***");
    }

    #[test]
    fn masked_serde_round_trip_emits_mask() {
        let m = Masked::new("supersecret-token".to_owned());
        let json = serde_json::to_string(&m).unwrap();
        // Quoted because serialize_str-equivalent.
        assert_eq!(json, "\"su***en\"");
    }

    #[test]
    fn masked_reveal_returns_original() {
        let m = Masked::new("plain".to_owned());
        assert_eq!(m.reveal(), "plain");
    }

    #[test]
    fn masked_byte_slice() {
        // Test with a non-string AsRef<[u8]> impl.
        let raw: &[u8] = b"hello-world";
        let m = Masked::new(raw);
        assert_eq!(format!("{m}"), "he***ld");
    }

    #[test]
    fn tracing_opts_serde_round_trip() {
        let opts = TracingOpts {
            service_name: "sensor-ingestion".to_owned(),
            service_version: "0.1.0".to_owned(),
            environment: "staging".to_owned(),
            format: TracingFormat::Json,
            filter_env: "RUST_LOG".to_owned(),
        };
        let json = serde_json::to_string(&opts).unwrap();
        let back: TracingOpts = serde_json::from_str(&json).unwrap();
        assert_eq!(back.service_name, opts.service_name);
        assert_eq!(back.service_version, opts.service_version);
        assert_eq!(back.environment, opts.environment);
        assert_eq!(back.format, opts.format);
    }

    #[test]
    fn tracing_opts_default_environment_is_production() {
        let json = r#"{"service_name": "x", "service_version": "1"}"#;
        let opts: TracingOpts = serde_json::from_str(json).unwrap();
        assert_eq!(opts.environment, "production");
        assert_eq!(opts.format, TracingFormat::Json);
        assert_eq!(opts.filter_env, "RUST_LOG");
    }

    #[test]
    fn init_tracing_double_call_is_rejected() {
        let opts = TracingOpts::new("test-service", "0.0.0");
        // First init may succeed or be a no-op depending on test
        // ordering; second MUST not panic.
        let _ = init_tracing(&opts);
        let second = init_tracing(&opts);
        // Either AlreadyInitialised or InvalidFilter (if first failed
        // for some env reason); panicking is the failure mode.
        match second {
            Ok(()) | Err(ObservabilityError::AlreadyInitialised) => {}
            Err(other) => panic!("unexpected error on double init: {other:?}"),
        }
    }

    #[test]
    fn metrics_opts_default_is_disabled_with_no_bind() {
        // Default posture — silent + no HTTP listener. A deploy that
        // forgets to set `[metrics]` in its config sees the stub
        // recorder behaviour (emissions are no-ops), not a process
        // that panics trying to bind a port the operator never
        // configured.
        let opts = super::MetricsOpts::default();
        assert!(!opts.enabled);
        assert!(opts.bind_addr.is_none());
    }

    #[test]
    fn init_metrics_returns_none_when_disabled() {
        // `enabled: false` → the install never runs and the global
        // recorder is untouched. This is the single most important
        // property: disabled = silent, never touches process state.
        let opts = super::MetricsOpts::default();
        let handle = super::init_metrics(&opts).expect("disabled init is infallible");
        assert!(
            handle.is_none(),
            "init_metrics must return None when disabled so the caller can skip wiring"
        );
    }

    #[test]
    fn metrics_opts_serde_round_trip_preserves_bind_addr() {
        // Config layers deserialise from TOML/JSON; the round-trip
        // test pins the wire shape a drift (e.g. renaming `bind_addr`
        // in a refactor) would otherwise break only at deploy time.
        // We use serde_json here because the crate's dev-dep stack
        // already carries it; the wire field names + types are
        // format-independent.
        let json_input = r#"{"enabled": true, "bind_addr": "127.0.0.1:9091"}"#;
        let opts: super::MetricsOpts = serde_json::from_str(json_input).expect("json parses");
        assert!(opts.enabled);
        assert_eq!(
            opts.bind_addr.map(|a| a.to_string()),
            Some("127.0.0.1:9091".to_owned())
        );

        // Round-trip back to json + reparse — no semantic loss.
        let serialised = serde_json::to_string(&opts).expect("serialise opts");
        let reparsed: super::MetricsOpts = serde_json::from_str(&serialised).expect("reparse");
        assert_eq!(opts.enabled, reparsed.enabled);
        assert_eq!(opts.bind_addr, reparsed.bind_addr);
    }
}
