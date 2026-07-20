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
//! - [`request_typed_with_options`] — source-compatible companion for
//!   callers that require a closed [`SanitizedRemoteErrorPolicy`].
//!
//! # Out-of-band guarantees
//!
//! The request side follows ADR-014/015 mTLS cert-is-identity. The
//! broker applies certificate-CN ACLs before delivery; a responder must
//! not treat the message-level `authenticatedIdentity` header as broker
//! identity. Marine responders additionally authorize authoritative
//! Farm job and fencing state before replying. Timeouts are caller-owned
//! so a hung responder never leaks the client's task handle indefinitely.

use std::collections::HashSet;
use std::time::Duration;

use bytes::Bytes;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::time::timeout;

use crate::NatsClient;

/// Maximum UTF-8 byte length accepted for a remote error code.
pub const MAX_REMOTE_ERROR_CODE_BYTES: usize = 64;

/// Maximum UTF-8 byte length accepted for a remote error message.
pub const MAX_REMOTE_ERROR_MESSAGE_BYTES: usize = 2_048;

/// Maximum number of distinct codes in one sanitized remote-error policy.
pub const MAX_ALLOWED_REMOTE_ERROR_CODES: usize = 64;

/// Invalid sanitized remote-error allowlist configuration.
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum RemoteErrorPolicyError {
    /// At least one code is required so the policy is fail-closed.
    #[error("remote error allowed codes must not be empty")]
    Empty,
    /// The policy exceeds [`MAX_ALLOWED_REMOTE_ERROR_CODES`].
    #[error("remote error allowed codes exceed the platform maximum")]
    TooMany,
    /// A code violates `[A-Z][A-Z0-9_]{0,63}`.
    #[error("remote error allowed code violates the platform pattern")]
    InvalidCode,
    /// A code occurs more than once.
    #[error("remote error allowed codes must be unique")]
    DuplicateCode,
}

/// Closed allowlist used to consume sanitized application-error envelopes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SanitizedRemoteErrorPolicy {
    allowed_codes: HashSet<String>,
}

impl SanitizedRemoteErrorPolicy {
    /// Validate and compile a sanitized remote-error code allowlist.
    ///
    /// # Errors
    /// Rejects empty, oversized, duplicate, or syntactically invalid lists.
    pub fn try_new<I, S>(allowed_codes: I) -> Result<Self, RemoteErrorPolicyError>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let allowed_codes = allowed_codes
            .into_iter()
            .map(Into::into)
            .collect::<Vec<_>>();
        if allowed_codes.is_empty() {
            return Err(RemoteErrorPolicyError::Empty);
        }
        if allowed_codes.len() > MAX_ALLOWED_REMOTE_ERROR_CODES {
            return Err(RemoteErrorPolicyError::TooMany);
        }
        let mut compiled = HashSet::with_capacity(allowed_codes.len());
        for code in allowed_codes {
            if !is_valid_remote_error_code(&code) {
                return Err(RemoteErrorPolicyError::InvalidCode);
            }
            if !compiled.insert(code) {
                return Err(RemoteErrorPolicyError::DuplicateCode);
            }
        }
        Ok(Self {
            allowed_codes: compiled,
        })
    }

    fn allows(&self, code: &str) -> bool {
        self.allowed_codes.contains(code)
    }
}

/// Caller-owned typed request settings, including optional sanitized errors.
#[derive(Debug, Clone, Copy)]
pub struct RequestReplyOptions<'a> {
    budget: Duration,
    remote_error_policy: Option<&'a SanitizedRemoteErrorPolicy>,
}

impl RequestReplyOptions<'_> {
    /// Construct settings that preserve the legacy remote-error behavior.
    #[must_use]
    pub const fn new(budget: Duration) -> Self {
        Self {
            budget,
            remote_error_policy: None,
        }
    }
}

impl<'a> RequestReplyOptions<'a> {
    /// Consume only closed remote-error envelopes with allowlisted codes.
    #[must_use]
    pub const fn with_sanitized_remote_errors(
        budget: Duration,
        policy: &'a SanitizedRemoteErrorPolicy,
    ) -> Self {
        Self {
            budget,
            remote_error_policy: Some(policy),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteErrorEnvelope {
    #[serde(rename = "__error")]
    is_error: bool,
    #[serde(deserialize_with = "deserialize_remote_error_code")]
    code: String,
    #[serde(deserialize_with = "deserialize_remote_error_message")]
    message: String,
}

fn deserialize_remote_error_code<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value =
        deserialize_bounded_non_empty_string(deserializer, MAX_REMOTE_ERROR_CODE_BYTES, "code")?;
    if !is_valid_remote_error_code(&value) {
        return Err(serde::de::Error::custom(
            "remote error code must match [A-Z][A-Z0-9_]{0,63}",
        ));
    }
    Ok(value)
}

fn is_valid_remote_error_code(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_REMOTE_ERROR_CODE_BYTES {
        return false;
    }
    let mut bytes = value.bytes();
    bytes.next().is_some_and(|byte| byte.is_ascii_uppercase())
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn deserialize_remote_error_message<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_bounded_non_empty_string(deserializer, MAX_REMOTE_ERROR_MESSAGE_BYTES, "message")
}

fn deserialize_bounded_non_empty_string<'de, D>(
    deserializer: D,
    maximum_bytes: usize,
    field: &'static str,
) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.is_empty() {
        return Err(serde::de::Error::custom(format_args!(
            "remote error {field} must not be empty"
        )));
    }
    if value.len() > maximum_bytes {
        return Err(serde::de::Error::custom(format_args!(
            "remote error {field} exceeds {maximum_bytes} bytes"
        )));
    }
    Ok(value)
}

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

    /// The responder returned the platform application-error envelope.
    /// The code is validated and retained; the bounded message is discarded.
    #[error("NATS request to {subject} returned remote error {code}")]
    Remote {
        /// Subject whose responder returned the error.
        subject: String,
        /// Stable application error code.
        code: String,
    },
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
///   - [`RequestError::Remote`] — responder returned the bounded
///     platform application-error envelope.
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
    request_typed_with_options(client, subject, request, RequestReplyOptions::new(budget)).await
}

/// Fire a typed request with caller-owned timeout and remote-error policy.
///
/// This companion keeps [`request_typed`] source-compatible while letting
/// security-sensitive callers require the same closed, allowlisted error
/// envelope used by the TypeScript transport.
///
/// # Errors
/// Returns the same [`RequestError`] shelves as [`request_typed`]. A marked
/// error envelope that violates the sanitized policy is a contract
/// [`RequestError::Decode`] failure; its remote message is never retained.
pub async fn request_typed_with_options<Req, Res>(
    client: &NatsClient,
    subject: &str,
    request: &Req,
    options: RequestReplyOptions<'_>,
) -> Result<Res, RequestError>
where
    Req: Serialize + Sync + ?Sized,
    Res: DeserializeOwned,
{
    let body = serde_json::to_vec(request).map_err(RequestError::Encode)?;
    let fut = client.request(subject.to_owned(), Bytes::from(body));
    let msg = match timeout(options.budget, fut).await {
        Ok(Ok(msg)) => msg,
        Ok(Err(e)) => return Err(RequestError::Transport(e)),
        Err(_elapsed) => return Err(RequestError::Timeout(options.budget)),
    };
    decode_typed_reply_with_policy(subject, &msg.payload, options.remote_error_policy)
}

#[cfg(test)]
fn decode_typed_reply<Res>(subject: &str, payload: &[u8]) -> Result<Res, RequestError>
where
    Res: DeserializeOwned,
{
    decode_typed_reply_with_policy(subject, payload, None)
}

fn decode_typed_reply_with_policy<Res>(
    subject: &str,
    payload: &[u8],
    remote_error_policy: Option<&SanitizedRemoteErrorPolicy>,
) -> Result<Res, RequestError>
where
    Res: DeserializeOwned,
{
    let parsed_value: serde_json::Value =
        serde_json::from_slice(payload).map_err(RequestError::Decode)?;

    let contains_error_marker = parsed_value
        .as_object()
        .is_some_and(|object| object.contains_key("__error"));
    let must_decode_error = remote_error_policy.is_some() && contains_error_marker
        || parsed_value.get("__error") == Some(&serde_json::Value::Bool(true));
    if must_decode_error {
        let envelope: RemoteErrorEnvelope =
            serde_json::from_value(parsed_value).map_err(|_| sanitized_envelope_decode_error())?;
        let RemoteErrorEnvelope {
            is_error,
            code,
            message,
        } = envelope;
        drop(message);
        if !is_error || remote_error_policy.is_some_and(|policy| !policy.allows(&code)) {
            return Err(sanitized_envelope_decode_error());
        }
        return Err(RequestError::Remote {
            subject: subject.to_owned(),
            code,
        });
    }

    serde_json::from_value(parsed_value).map_err(RequestError::Decode)
}

fn sanitized_envelope_decode_error() -> RequestError {
    RequestError::Decode(<serde_json::Error as serde::de::Error>::custom(
        "response error envelope failed validation",
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_ALLOWED_REMOTE_ERROR_CODES, MAX_REMOTE_ERROR_CODE_BYTES,
        MAX_REMOTE_ERROR_MESSAGE_BYTES, RemoteErrorPolicyError, RequestError, RequestReplyOptions,
        SanitizedRemoteErrorPolicy, decode_typed_reply, decode_typed_reply_with_policy,
        request_typed, request_typed_with_options,
    };
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

    #[derive(Deserialize, Debug, PartialEq, Eq)]
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

        let remote_err = RequestError::Remote {
            subject: "request.farm.example".to_owned(),
            code: "DENIED".to_owned(),
        };
        assert!(format!("{remote_err}").contains("remote error DENIED"));
    }

    #[test]
    fn typed_decoder_returns_normal_success_reply() {
        let reply: ExampleResponse =
            decode_typed_reply("request.farm.example", br#"{"_field":"ok"}"#).unwrap();

        assert_eq!(
            reply,
            ExampleResponse {
                _field: "ok".to_owned()
            }
        );
    }

    #[test]
    fn typed_decoder_raises_platform_remote_error_before_success_decode() {
        let error = decode_typed_reply::<ExampleResponse>(
            "request.farm.marineCredentialLease",
            br#"{"__error":true,"code":"LEASE_DENIED","message":"fixture-secret-must-disappear"}"#,
        )
        .unwrap_err();

        assert!(matches!(
            &error,
            RequestError::Remote {
                subject,
                code,
            } if subject == "request.farm.marineCredentialLease"
                && code == "LEASE_DENIED"
        ));
        assert!(!format!("{error:?}").contains("fixture-secret-must-disappear"));
        assert!(!format!("{error}").contains("fixture-secret-must-disappear"));
    }

    #[test]
    fn sanitized_remote_error_policy_matches_typescript_allowlist_rules() {
        assert_eq!(
            SanitizedRemoteErrorPolicy::try_new(Vec::<String>::new()),
            Err(RemoteErrorPolicyError::Empty)
        );
        assert_eq!(
            SanitizedRemoteErrorPolicy::try_new(
                (0..=MAX_ALLOWED_REMOTE_ERROR_CODES).map(|index| format!("CODE_{index}"))
            ),
            Err(RemoteErrorPolicyError::TooMany)
        );
        assert_eq!(
            SanitizedRemoteErrorPolicy::try_new(["lowercase".to_owned()]),
            Err(RemoteErrorPolicyError::InvalidCode)
        );
        assert_eq!(
            SanitizedRemoteErrorPolicy::try_new([
                "LEASE_FENCED".to_owned(),
                "LEASE_FENCED".to_owned(),
            ]),
            Err(RemoteErrorPolicyError::DuplicateCode)
        );
        assert!(
            SanitizedRemoteErrorPolicy::try_new([
                "LEASE_FENCED".to_owned(),
                "A".repeat(MAX_REMOTE_ERROR_CODE_BYTES),
            ])
            .is_ok()
        );
    }

    #[test]
    fn sanitized_decoder_retains_only_an_allowlisted_code() {
        let secret = "fixture-provider-token-must-disappear";
        let policy = SanitizedRemoteErrorPolicy::try_new(["LEASE_FENCED".to_owned()]).unwrap();
        let payload = serde_json::to_vec(&serde_json::json!({
            "__error": true,
            "code": "LEASE_FENCED",
            "message": secret,
        }))
        .unwrap();

        let error = decode_typed_reply_with_policy::<ExampleResponse>(
            "request.farm.marineExecutionRenew",
            &payload,
            Some(&policy),
        )
        .unwrap_err();

        assert!(matches!(
            &error,
            RequestError::Remote { subject, code }
                if subject == "request.farm.marineExecutionRenew" && code == "LEASE_FENCED"
        ));
        assert!(!format!("{error:?}").contains(secret));
        assert!(!format!("{error}").contains(secret));
    }

    #[test]
    fn sanitized_decoder_treats_unallowlisted_code_as_secret_free_contract_drift() {
        let secret = "fixture-provider-token-must-disappear";
        let policy = SanitizedRemoteErrorPolicy::try_new(["LEASE_FENCED".to_owned()]).unwrap();
        let payload = serde_json::to_vec(&serde_json::json!({
            "__error": true,
            "code": "NOT_ALLOWED",
            "message": secret,
        }))
        .unwrap();

        let error = decode_typed_reply_with_policy::<ExampleResponse>(
            "request.farm.marineExecutionRenew",
            &payload,
            Some(&policy),
        )
        .unwrap_err();

        assert!(matches!(&error, RequestError::Decode(_)));
        assert!(!format!("{error:?}").contains(secret));
        assert!(!format!("{error}").contains(secret));
    }

    #[test]
    fn sanitized_decoder_rejects_every_marked_non_contract_envelope() {
        let policy = SanitizedRemoteErrorPolicy::try_new(["LEASE_FENCED".to_owned()]).unwrap();
        for envelope in [
            serde_json::json!({
                "__error": false,
                "code": "LEASE_FENCED",
                "message": "Request failed"
            }),
            serde_json::json!({
                "__error": true,
                "code": "LEASE_FENCED",
                "message": "Request failed",
                "detail": "closed envelope"
            }),
        ] {
            let payload = serde_json::to_vec(&envelope).unwrap();
            assert!(matches!(
                decode_typed_reply_with_policy::<ExampleResponse>(
                    "request.farm.marineExecutionRenew",
                    &payload,
                    Some(&policy),
                ),
                Err(RequestError::Decode(_))
            ));
        }
    }

    #[test]
    fn typed_decoder_rejects_unbounded_or_malformed_remote_errors() {
        for envelope in [
            serde_json::json!({
                "__error": true,
                "code": "X".repeat(MAX_REMOTE_ERROR_CODE_BYTES + 1),
                "message": "bounded"
            }),
            serde_json::json!({
                "__error": true,
                "code": "DENIED",
                "message": "X".repeat(MAX_REMOTE_ERROR_MESSAGE_BYTES + 1)
            }),
            serde_json::json!({
                "__error": true,
                "code": "",
                "message": "bounded"
            }),
            serde_json::json!({
                "__error": true,
                "code": "lowercase_code",
                "message": "bounded"
            }),
            serde_json::json!({
                "__error": true,
                "code": "DENIED",
                "message": "bounded",
                "unexpected": true
            }),
        ] {
            let bytes = serde_json::to_vec(&envelope).unwrap();
            assert!(matches!(
                decode_typed_reply::<ExampleResponse>("request.farm.example", &bytes),
                Err(RequestError::Decode(_))
            ));
        }
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
            let policy = SanitizedRemoteErrorPolicy::try_new(["DENIED".to_owned()]).unwrap();
            let options =
                RequestReplyOptions::with_sanitized_remote_errors(Duration::from_secs(1), &policy);
            let fut = request_typed_with_options::<ExampleRequest, ExampleResponse>(
                c,
                "test.subject",
                &ExampleRequest { _field: 1 },
                options,
            );
            assert_send(fut);
        }
    }
}
