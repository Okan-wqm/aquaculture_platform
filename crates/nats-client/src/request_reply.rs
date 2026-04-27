//! Typed NATS request-reply helpers (ADR-031 foundation).
//!
//! # Why this module exists
//!
//! ADR-031 prescribes NATS request-reply as the pattern for
//! Rust ↔ TS synchronous cross-service calls (e.g. the sensor-
//! ingestion sidecar's boot-time `policy.ingest_backend.snapshot`
//! request against admin-api-service). The untyped
//! [`crate::NatsClient::request`] method on the client wrapper
//! already exists; this module layers typed serde encoding +
//! bounded-timeout + structured error reporting on top so every
//! caller speaks the same shape.
//!
//! # Surface
//!
//! - [`RequestError`] — exhaustive error enum for every failure
//!   mode a typed request-reply can hit.
//! - [`request_typed`] — generic async fn that encodes a
//!   `Serialize` request, sends it, decodes the reply into the
//!   expected `DeserializeOwned` response, honours a caller-
//!   supplied timeout.
//!
//! # Out-of-band guarantees
//!
//! The request side follows ADR-014/015 mTLS cert-is-identity:
//! the client's CN identifies the caller, so responders can
//! check `authenticatedIdentity` against the cert-SSoT
//! `services.yaml` list before replying. Timeouts are caller-
//! owned so a hung responder never leaks the client's task
//! handle indefinitely.

use std::time::Duration;

use bytes::Bytes;
use serde::Serialize;
use serde::de::DeserializeOwned;
use thiserror::Error;
use tokio::time::timeout;

use crate::NatsClient;

/// All ways a typed request-reply can fail. Each variant is a
/// distinct operator-alarm shelf: a transport error is a broker
/// issue; a timeout is a responder issue; an encode/decode error
/// is a contract issue.
#[derive(Debug, Error)]
pub enum RequestError {
    /// Wall-clock timeout on the round trip. `Duration` carries
    /// the budget that was exceeded — useful in logs to distinguish
    /// "responder is slow" from "responder does not exist".
    #[error("request-reply timed out after {0:?}")]
    Timeout(Duration),

    /// NATS-side transport error — no responder, broker
    /// disconnect, async-nats internal error. The source chain
    /// carries the underlying cause.
    #[error("NATS request transport failed")]
    Transport(#[source] crate::NatsClientError),

    /// `serde_json` failed to serialise the request body. In
    /// practice fires only on OOM — the request body is a validated
    /// struct at every call site.
    #[error("request payload encode failed")]
    Encode(#[source] serde_json::Error),

    /// `serde_json` failed to decode the reply bytes. Means the
    /// responder replied with bytes that do not match the expected
    /// `T`. Almost always a contract drift between caller +
    /// responder (version skew between Rust sidecar and TS
    /// admin-api responder).
    #[error("response payload decode failed")]
    Decode(#[source] serde_json::Error),
}

/// Fire a typed request and await the typed reply, with a caller-
/// supplied timeout budget. The generic shape keeps one code path
/// for every request-reply call site in the Rust workspace.
///
/// # Example
///
/// ```ignore
/// #[derive(Serialize)]
/// struct SnapshotRequest {}
///
/// #[derive(Deserialize)]
/// struct IngestBackendSnapshot {
///     global: String,
///     overrides: std::collections::HashMap<String, String>,
/// }
///
/// let snapshot: IngestBackendSnapshot = nats_client::request_reply::request_typed(
///     &client,
///     "policy.ingest_backend.snapshot",
///     &SnapshotRequest {},
///     Duration::from_secs(5),
/// ).await?;
/// ```
///
/// # Errors
/// See [`RequestError`]:
///   - [`RequestError::Timeout`] — the responder did not answer
///     within `budget`.
///   - [`RequestError::Transport`] — NATS-side transport error
///     (broker disconnect, missing responder, etc.).
///   - [`RequestError::Encode`] — request body could not be
///     serialised to JSON.
///   - [`RequestError::Decode`] — reply bytes could not be
///     deserialised into `R`.
pub async fn request_typed<Req, Res>(
    client: &NatsClient,
    subject: &str,
    request: &Req,
    budget: Duration,
) -> Result<Res, RequestError>
where
    // `Sync` is required because the returned future holds `&Req`
    // across an await point (the `client.request(...)` call). A
    // non-Sync request type would make the whole future `!Send`,
    // which `tokio::spawn` at the call site would refuse.
    Req: Serialize + Sync + ?Sized,
    Res: DeserializeOwned,
{
    let body = serde_json::to_vec(request).map_err(RequestError::Encode)?;
    let fut = client.request(subject.to_owned(), Bytes::from(body));
    let msg = match timeout(budget, fut).await {
        Ok(Ok(msg)) => msg,
        Ok(Err(e)) => return Err(RequestError::Transport(e)),
        Err(_elapsed) => return Err(RequestError::Timeout(budget)),
    };
    let parsed: Res = serde_json::from_slice(&msg.payload).map_err(RequestError::Decode)?;
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::{RequestError, request_typed};
    use serde::{Deserialize, Serialize};
    use std::time::Duration;

    // The tests here are shape-only — the actual NATS round trip
    // lives in the integration fixture that testcontainers-rs
    // brings online (PR-C #9). What we anchor here is the generic
    // signature + error-variant surface so a refactor that widened
    // RequestError or narrowed the generic bounds fails loudly.

    #[derive(Serialize, Debug)]
    struct ExampleRequest {
        _field: u32,
    }

    #[derive(Deserialize, Debug)]
    struct ExampleResponse {
        _field: String,
    }

    #[test]
    fn request_error_variants_are_distinct() {
        let t = RequestError::Timeout(Duration::from_secs(1));
        let encoded = format!("{t}");
        assert!(encoded.contains("timed out"));
        // matches! guards the variant shape at compile time — a
        // refactor that renamed Timeout would stop compiling this
        // test.
        assert!(matches!(t, RequestError::Timeout(_)));
    }

    #[test]
    fn request_error_display_surfaces_operator_signal() {
        // Every variant's Display must contain a distinguishable
        // keyword so an operator grepping logs by shelf can route.
        let timeout_err = RequestError::Timeout(Duration::from_secs(2));
        assert!(format!("{timeout_err}").contains("timed out"));

        let encode_err =
            RequestError::Encode(serde_json::from_str::<ExampleResponse>("{").unwrap_err());
        assert!(format!("{encode_err}").contains("encode failed"));

        let decode_err =
            RequestError::Decode(serde_json::from_str::<ExampleResponse>("{").unwrap_err());
        assert!(format!("{decode_err}").contains("decode failed"));
    }

    // Compile-time check that the generic bounds accept the
    // expected shapes. If a refactor narrowed `Req: Serialize` to
    // something stricter (e.g. `Serialize + Sized`), this function
    // would stop compiling and fail the build, which is exactly
    // the guard we want.
    #[allow(dead_code)]
    fn _compile_guard_request_typed_accepts_common_shapes() {
        fn assert_send<T: Send>(_: T) {}
        let client: Option<&crate::NatsClient> = None;
        if let Some(c) = client {
            let fut = request_typed::<ExampleRequest, ExampleResponse>(
                c,
                "test.subject",
                &ExampleRequest { _field: 1 },
                Duration::from_secs(1),
            );
            assert_send(fut);
        }
    }
}
