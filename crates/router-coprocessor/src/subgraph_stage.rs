//! subgraph_stage.rs — the Apollo Router `SubgraphRequest` coprocessor stage.
//!
//! WHY: each subgraph (auth-service, farm-service, …) re-verifies a service-identity
//! HMAC-v2 on every inbound request (the `service-identity.guard`). When Apollo
//! Router dispatches a request to a subgraph it is NOT a NestJS gateway, so nothing
//! signs it — the guard would reject 100% of router→subgraph traffic. This stage
//! signs each subgraph request in-flight, injecting the 14 v2 headers the guard
//! expects, byte-for-byte compatible with the TS `generateServiceIdentityHeadersV2`
//! (`libs/backend-common/src/utils/service-identity.util.ts`).
//!
//! LOAD-BEARING PARITY: the header NAMES, the per-field DEFAULTS (`keyId`←`"local-dev"`,
//! `audience`/`contentType`/`assertionHash`←`""`, `queryHash`←`sha256("")`,
//! `effectiveTenantId`←`tenantId`, `nonce`←fresh uuid v4), the UPPERCASE method, and
//! the canonical layout (via [`crate::build_canonical_v2`]) MUST match the TS
//! generator exactly. The HMAC itself is delegated to [`crate::sign_v2`], which is
//! pinned to a golden vector in `lib.rs` — so this module only has to reproduce the
//! TS DEFAULTS and header MAPPING, not the crypto.
//!
//! PER-REQUEST, NOT GOLDEN-DETERMINISTIC: `timestamp` (ISO-8601 UTC, millisecond
//! precision matching JS `new Date().toISOString()`) and `nonce` (uuid v4) are freshly
//! generated on every call. They are the replay-window + uniqueness controls; pinning
//! them would defeat their purpose. The signing primitives stay deterministic and
//! golden-tested in `lib.rs`.

use chrono::SecondsFormat;
use uuid::Uuid;

use crate::protocol::CoprocessorPayload;
use crate::{CanonicalV2Input, SIG_VERSION_V2, build_canonical_v2, sha256_hex, sign_v2};

/// TS / Node default content-type for a GraphQL POST. The gateway sender signs the
/// ACTUAL wire `content-type` (`authenticated-data-source.ts`), and the subgraph guard
/// compares the signed value against the wire `content-type` header byte-for-byte
/// (`service-identity.util.ts` content-type check). The Router always emits
/// `application/json` for a subgraph GraphQL call, so this is the correct fallback when
/// the forwarded headers omit `content-type` — NOT the empty string, which would make
/// the guard's observed-vs-signed content-type check reject 100% of traffic.
const DEFAULT_CONTENT_TYPE: &str = "application/json";

/// Look up a single header value by case-insensitive name from the Router's multi-value
/// header map, returning the FIRST value if the name has several.
///
/// WHY case-insensitive: HTTP header names are case-insensitive (RFC 9110 §5.1) and
/// Apollo Router lower-cases header names on the wire, but we must not depend on the
/// exact casing the Router happens to use — a casing change must not silently turn the
/// derived content-type into the empty-string fallback and break every signature.
fn first_header_value<'a>(payload: &'a CoprocessorPayload, name: &str) -> Option<&'a str> {
    payload
        .headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .and_then(|(_, values)| values.first())
        .map(String::as_str)
}

/// Extract the raw query string (everything AFTER the first `?`, excluding the `?`) from
/// a full request URI, or `""` when there is no query component. The canonical binds
/// `sha256(query)`; a subgraph GraphQL POST carries the operation in the body and has no
/// query string, so this DERIVES `sha256("")` rather than hard-coding it — meaning a URI
/// that DOES carry a query (e.g. `?op=me`) is bound correctly instead of silently
/// signing the empty hash and being rejected.
fn query_string_from_uri(uri: &str) -> &str {
    match uri.split_once('?') {
        Some((_, query)) => query,
        None => "",
    }
}

/// Extract the path component (no query string) from a request URI. Handles a bare path
/// (`/graphql`), a path-with-query (`/graphql?op=me`), and an absolute URI
/// (`http://farm-service:3000/graphql?op=me`) by stripping the scheme+authority then the
/// query. Mirrors the guard's `originalUrl`-minus-query derivation so the signed path and
/// the observed path agree.
fn path_component_of_uri(uri: &str) -> &str {
    // Strip scheme://authority if present, leaving the path-and-query. We locate the
    // first `/` of the path within the post-`://` remainder and slice from THAT offset
    // via `get(..)` (never bare `[..]`, which the workspace clippy `indexing_slicing`
    // lint denies in non-test code too).
    let after_authority = match uri.split_once("://") {
        Some((_, rest)) => rest
            .find('/')
            .map_or("/", |slash_idx| rest.get(slash_idx..).unwrap_or("/")),
        None => uri,
    };
    // Drop the query component.
    match after_authority.split_once('?') {
        Some((path, _)) => path,
        None => after_authority,
    }
}

/// The 14 service-identity v2 header names, in the order the TS generator emits them.
/// Kept as named constants so a typo is a compile error and the parity with
/// `ServiceIdentityHeadersV2` is auditable at a glance.
const H_IDENTITY: &str = "X-Service-Identity";
const H_TIMESTAMP: &str = "X-Service-Timestamp";
const H_SIGNATURE: &str = "X-Service-Signature";
const H_SIG_VERSION: &str = "X-Service-Sig-Version";
const H_METHOD: &str = "X-Service-Method";
const H_PATH: &str = "X-Service-Path";
const H_BODY_HASH: &str = "X-Service-Body-Hash";
const H_KEY_ID: &str = "X-Service-Key-Id";
const H_AUDIENCE: &str = "X-Service-Audience";
const H_QUERY_HASH: &str = "X-Service-Query-Hash";
const H_CONTENT_TYPE: &str = "X-Service-Content-Type";
const H_ASSERTION_HASH: &str = "X-Service-Assertion-Hash";
const H_NONCE: &str = "X-Service-Nonce";
const H_EFFECTIVE_TENANT_ID: &str = "X-Service-Effective-Tenant-ID";

/// TS default for an unset `keyId` (`args.keyId ?? 'local-dev'`).
const DEFAULT_KEY_ID: &str = "local-dev";

/// Everything the signer needs that is NOT derivable from the request itself.
///
/// These are the coprocessor's identity-as-caller inputs: which service we claim to
/// be to the subgraph, which keyring entry signs us, and the tenant/audience binding.
/// The conductor resolves these (from the selected keyring entry + the in-flight
/// tenant/audience) and hands a `SigningContext` to [`sign_subgraph_request`].
#[derive(Debug, Clone)]
pub struct SigningContext {
    /// Caller service name → `X-Service-Identity` and the canonical `serviceName`
    /// field. For the Router coprocessor this is the gateway's identity (e.g.
    /// `"gateway-api"`), matching what the subgraph guard's caller allowlist expects.
    pub service_name: String,

    /// Keyring key id → `X-Service-Key-Id`. `None` reproduces the TS default
    /// `'local-dev'`; a real deploy always supplies the active keyring `kid`.
    pub key_id: Option<String>,

    /// Shared HMAC secret for the selected keyring entry. Bytes, never logged.
    pub secret: Vec<u8>,

    /// Intended receiver audience → `X-Service-Audience` and the canonical audience
    /// field. `None` reproduces the TS default `''`.
    pub audience: Option<String>,

    /// Tenant UUID → `X-Service-Effective-Tenant-ID` and the canonical tenant field.
    /// Empty string is legitimate for proven non-tenant paths (matches the TS
    /// contract). `effectiveTenantId` defaults to this value (TS:
    /// `effectiveTenantId ?? args.tenantId`).
    pub tenant_id: String,
}

/// The fully-resolved set of 14 header (name, value) pairs the stage injected.
///
/// Returned alongside the mutated [`CoprocessorPayload`] so tests (and the conductor's
/// structured logger) can assert/observe the exact header set without re-reading the
/// payload's internal map. The order matches the TS emission order.
#[derive(Debug, Clone)]
pub struct SignedHeaders {
    /// `(header-name, value)` pairs, in TS emission order. Exactly 14 entries.
    pub pairs: [(&'static str, String); 14],
}

impl SignedHeaders {
    /// Number of headers in the v2 set. A compile-time-fixed `14` — the array length
    /// guarantees it cannot drift from the field count.
    #[must_use]
    pub const fn len(&self) -> usize {
        self.pairs.len()
    }

    /// Always `false` — the v2 header set is never empty. Present to satisfy the
    /// `len_without_is_empty` clippy lint.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        false
    }
}

/// Sign a `SubgraphRequest` coprocessor payload: compute the v2 HMAC and return a
/// `continue` coprocessor response carrying the 14 service-identity headers.
///
/// # Parameters
/// * `request` — the inbound `SubgraphRequest` payload from the Router. Its `method`,
///   `path`, and `body` (when present) feed the canonical input; the response echoes
///   the request `id`/`stage`/`serviceName`.
/// * `ctx` — the [`SigningContext`] (caller identity, keyring entry, tenant/audience).
///
/// # Canonical-field derivation (TS parity)
/// Every wire-bound field is DERIVED from the forwarded request the same way the
/// subgraph guard will OBSERVE it — never hard-coded — so the signed claims and the
/// receiver's observed values agree by construction:
/// * `method`   ← `request.method` (defaults to `"POST"`, the only verb the Router
///   uses for GraphQL subgraph calls; upper-cased inside [`build_canonical_v2`]).
/// * `path`     ← `request.path`, else the path component of `request.uri`, else the
///   `"/graphql"` Router default — the same value the guard derives from `originalUrl`
///   minus query string.
/// * `body_hash`  ← `sha256_hex(compact-json(request.body))`, or `sha256_hex("")` when
///   no body was forwarded. Under Path-alpha the subgraph hashes the RAW wire bytes,
///   which are the Router's compact serde serialization of the SAME body value, so the
///   two hashes match.
/// * `query_hash` ← `sha256_hex(query-string-of-uri)` — derived from the URI, NOT a
///   baked-in `sha256("")`. A subgraph GraphQL POST has no query string, so this
///   resolves to `sha256("")`, but a URI that carries one is bound correctly.
/// * `content_type` ← the forwarded `content-type` header (case-insensitive), defaulting
///   to `"application/json"` only when truly absent. The guard compares this against the
///   wire `content-type` header, so it MUST mirror the real value (an empty-string
///   hard-code would reject 100% of traffic).
/// * `key_id`/`audience`/`assertion_hash`/`effective_tenant_id`/`nonce`
///   ← exactly the TS `??` defaults documented on [`SigningContext`] and above.
///
/// # Errors
/// Propagates the [`crate::sign_v2`] error (an `InvalidLength`, which the HMAC path
/// never actually hits — surfaced as `Result` to honour the workspace no-`unwrap`
/// clippy lint). The body serialisation cannot fail: a `serde_json::Value` always
/// re-serialises, but we still thread the error type so the function stays total.
pub fn sign_subgraph_request(
    request: &CoprocessorPayload,
    ctx: &SigningContext,
) -> Result<(CoprocessorPayload, SignedHeaders), SubgraphSignError> {
    // --- per-request, non-deterministic fields ---
    // ISO-8601 UTC with millisecond precision + trailing 'Z' == JS Date.toISOString().
    // `to_rfc3339_opts(Millis, true)` yields e.g. "2026-06-14T12:00:00.000Z".
    let timestamp = chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let nonce = Uuid::new_v4().to_string();

    // --- request-derived fields (DERIVED to match what the subgraph guard observes) ---
    let method = request.method.clone().unwrap_or_else(|| "POST".to_string());

    // Path: prefer the explicit `path` field; fall back to the path component of the
    // full `uri`; finally the Router's `/graphql` default. The guard derives its
    // observed path from `originalUrl` minus the query string, so this mirrors it.
    let path = request
        .path
        .clone()
        .or_else(|| {
            request
                .uri
                .as_deref()
                .map(|uri| path_component_of_uri(uri).to_string())
        })
        .unwrap_or_else(|| "/graphql".to_string());

    // Body hash: sha256 of the compact JSON the subgraph will actually receive. When
    // the stage config did not forward a body, the canonical binds sha256("") — the
    // same explicit-empty-hash discipline the TS generator uses so an "empty" request
    // cannot later have a body appended without breaking the signature. Path-alpha
    // pins parity: the subgraph hashes the raw wire bytes, which ARE the Router's
    // compact serde serialization of this same value.
    let body_bytes = match &request.body {
        Some(value) => serde_json::to_vec(value).map_err(SubgraphSignError::BodySerialize)?,
        None => Vec::new(),
    };
    let body_hash = sha256_hex(&body_bytes);

    // Query hash: DERIVED from the URI's query component (sha256 of the real query
    // string). A subgraph GraphQL POST carries the op in the body and has no query
    // string, so this resolves to sha256("") — but it is derived, not baked in, so a
    // URI that DOES carry a query is bound correctly instead of being silently rejected.
    let query_string = request.uri.as_deref().map_or("", query_string_from_uri);
    let query_hash = sha256_hex(query_string.as_bytes());

    // Content-type: the forwarded wire header, defaulting to application/json only when
    // truly absent. The guard compares the signed value against the wire content-type
    // header byte-for-byte, so this MUST be the real value (an empty-string hard-code
    // rejected 100% of traffic — CRIT-A).
    let content_type = first_header_value(request, "content-type")
        .unwrap_or(DEFAULT_CONTENT_TYPE)
        .to_string();

    // --- TS `??` defaults ---
    let key_id = ctx
        .key_id
        .clone()
        .unwrap_or_else(|| DEFAULT_KEY_ID.to_string());
    let audience = ctx.audience.clone().unwrap_or_default();
    let assertion_hash = String::new();
    let effective_tenant_id = ctx.tenant_id.clone();

    // --- canonical + HMAC (delegated to the golden-tested lib.rs primitives) ---
    let canonical_input = CanonicalV2Input {
        timestamp: timestamp.clone(),
        service_name: ctx.service_name.clone(),
        method: method.clone(),
        path: path.clone(),
        body_hash: body_hash.clone(),
        tenant_id: ctx.tenant_id.clone(),
        key_id: key_id.clone(),
        audience: audience.clone(),
        query_hash: query_hash.clone(),
        content_type: content_type.clone(),
        effective_tenant_id: effective_tenant_id.clone(),
        assertion_hash: assertion_hash.clone(),
        nonce: nonce.clone(),
    };
    let canonical = build_canonical_v2(&canonical_input);
    let signature = sign_v2(&canonical, &ctx.secret).map_err(SubgraphSignError::Sign)?;

    // The canonical uses the upper-cased method; the X-Service-Method header carries
    // the same upper-cased verb (TS: `args.method.toUpperCase()`).
    let method_upper = method.to_uppercase();

    // 14 headers, in the exact TS emission order.
    let pairs: [(&'static str, String); 14] = [
        (H_IDENTITY, ctx.service_name.clone()),
        (H_TIMESTAMP, timestamp),
        (H_SIGNATURE, signature),
        (H_SIG_VERSION, SIG_VERSION_V2.to_string()),
        (H_METHOD, method_upper),
        (H_PATH, path),
        (H_BODY_HASH, body_hash),
        (H_KEY_ID, key_id),
        (H_AUDIENCE, audience),
        (H_QUERY_HASH, query_hash),
        (H_CONTENT_TYPE, content_type),
        (H_ASSERTION_HASH, assertion_hash),
        (H_NONCE, nonce),
        (H_EFFECTIVE_TENANT_ID, effective_tenant_id),
    ];

    let mut response = CoprocessorPayload::continue_from(request);
    for (name, value) in &pairs {
        response.insert_header(*name, value.clone());
    }

    Ok((response, SignedHeaders { pairs }))
}

/// Failure modes of [`sign_subgraph_request`]. Both are practically unreachable on
/// the HMAC happy path, but are returned as a `Result` (never panicked) because the
/// workspace clippy config denies `unwrap`/`expect`.
#[derive(Debug)]
pub enum SubgraphSignError {
    /// The HMAC key length was rejected by the MAC constructor. `HMAC-SHA256` accepts
    /// any key length, so this is unreachable in practice; surfaced for totality.
    Sign(hmac::digest::InvalidLength),
    /// The request body (`serde_json::Value`) failed to re-serialise to bytes.
    /// A parsed `Value` always re-serialises, so this is unreachable in practice.
    BodySerialize(serde_json::Error),
}

impl std::fmt::Display for SubgraphSignError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sign(e) => write!(f, "service-identity HMAC signing failed: {e}"),
            Self::BodySerialize(e) => {
                write!(f, "subgraph request body serialisation failed: {e}")
            }
        }
    }
}

impl std::error::Error for SubgraphSignError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Sign(e) => Some(e),
            Self::BodySerialize(e) => Some(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx() -> SigningContext {
        SigningContext {
            service_name: "gateway-api".to_string(),
            key_id: Some("kid-1".to_string()),
            secret: b"test-shared-secret".to_vec(),
            audience: Some("auth-service".to_string()),
            tenant_id: "11111111-1111-4111-8111-111111111111".to_string(),
        }
    }

    /// A representative SubgraphRequest envelope as Apollo Router forwards it once
    /// `router.yaml` enables `body: true, uri: true, method: true, headers: true`:
    /// the GraphQL POST body, the wire `content-type` header, the method and path.
    fn subgraph_request() -> CoprocessorPayload {
        let mut req = CoprocessorPayload::continue_response("req-1", "SubgraphRequest");
        req.service_name = Some("auth-service".to_string());
        req.method = Some("post".to_string());
        req.path = Some("/graphql".to_string());
        req.uri = Some("http://auth-service:3000/graphql".to_string());
        req.insert_header("content-type", "application/json");
        req.body = Some(json!({ "query": "{ me { id } }" }));
        req
    }

    #[test]
    fn injects_exactly_the_fourteen_v2_headers() -> Result<(), SubgraphSignError> {
        let (response, signed) = sign_subgraph_request(&subgraph_request(), &ctx())?;
        assert_eq!(signed.len(), 14);
        // Every one of the 14 names is present in the response header map exactly once.
        for (name, _) in &signed.pairs {
            let values = response.headers.get(*name);
            assert!(values.is_some(), "header {name} must be present");
            assert_eq!(
                values.map(Vec::len),
                Some(1),
                "header {name} must appear once"
            );
        }
        assert_eq!(response.headers.len(), 14);
        Ok(())
    }

    #[test]
    fn header_names_and_static_values_match_ts_contract() -> Result<(), SubgraphSignError> {
        let (_response, signed) = sign_subgraph_request(&subgraph_request(), &ctx())?;
        let names: Vec<&str> = signed.pairs.iter().map(|(n, _)| *n).collect();
        assert_eq!(
            names,
            vec![
                "X-Service-Identity",
                "X-Service-Timestamp",
                "X-Service-Signature",
                "X-Service-Sig-Version",
                "X-Service-Method",
                "X-Service-Path",
                "X-Service-Body-Hash",
                "X-Service-Key-Id",
                "X-Service-Audience",
                "X-Service-Query-Hash",
                "X-Service-Content-Type",
                "X-Service-Assertion-Hash",
                "X-Service-Nonce",
                "X-Service-Effective-Tenant-ID",
            ]
        );
        let by_name = |k: &str| -> String {
            signed
                .pairs
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.clone())
                .unwrap_or_default()
        };
        assert_eq!(by_name("X-Service-Identity"), "gateway-api");
        assert_eq!(by_name("X-Service-Sig-Version"), "v2");
        assert_eq!(by_name("X-Service-Method"), "POST"); // upper-cased
        assert_eq!(by_name("X-Service-Path"), "/graphql");
        assert_eq!(by_name("X-Service-Key-Id"), "kid-1");
        assert_eq!(by_name("X-Service-Audience"), "auth-service");
        // content-type is DERIVED from the forwarded wire header, NOT hard-coded "".
        // The guard compares the signed value against the observed wire content-type,
        // so it must mirror what Apollo actually sends (application/json) — CRIT-A.
        assert_eq!(by_name("X-Service-Content-Type"), "application/json");
        assert_eq!(by_name("X-Service-Assertion-Hash"), "");
        // effectiveTenantId defaults to tenantId
        assert_eq!(
            by_name("X-Service-Effective-Tenant-ID"),
            "11111111-1111-4111-8111-111111111111"
        );
        // body-hash is DERIVED over the forwarded body (CRIT-B): it must be the real
        // sha256 of the compact JSON, never sha256("") when a body is present.
        let expected_body_hash = sha256_hex(
            &serde_json::to_vec(&json!({ "query": "{ me { id } }" }))
                .map_err(SubgraphSignError::BodySerialize)?,
        );
        assert_eq!(by_name("X-Service-Body-Hash"), expected_body_hash);
        assert_ne!(by_name("X-Service-Body-Hash"), sha256_hex(b""));
        // queryHash == sha256("") because this URI carries no query string — DERIVED
        // from the URI, not baked in (a URI WITH a query would bind sha256(query)).
        assert_eq!(by_name("X-Service-Query-Hash"), sha256_hex(b""));
        Ok(())
    }

    #[test]
    fn ts_defaults_applied_when_context_fields_absent() -> Result<(), SubgraphSignError> {
        let ctx = SigningContext {
            service_name: "gateway-api".to_string(),
            key_id: None, // → "local-dev"
            secret: b"s".to_vec(),
            audience: None, // → ""
            tenant_id: String::new(),
        };
        let (_response, signed) = sign_subgraph_request(&subgraph_request(), &ctx)?;
        let by_name = |k: &str| -> String {
            signed
                .pairs
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.clone())
                .unwrap_or_default()
        };
        assert_eq!(by_name("X-Service-Key-Id"), "local-dev");
        assert_eq!(by_name("X-Service-Audience"), "");
        assert_eq!(by_name("X-Service-Effective-Tenant-ID"), "");
        Ok(())
    }

    #[test]
    fn signature_verifies_against_recomputed_canonical() -> Result<(), SubgraphSignError> {
        // Reconstruct the canonical from the emitted headers and confirm the emitted
        // signature is exactly sign_v2(canonical). This proves the header set the
        // subgraph guard reads re-derives the SAME canonical we signed.
        let (_response, signed) = sign_subgraph_request(&subgraph_request(), &ctx())?;
        let get = |k: &str| -> String {
            signed
                .pairs
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.clone())
                .unwrap_or_default()
        };
        let body_bytes = serde_json::to_vec(&json!({ "query": "{ me { id } }" }))
            .map_err(SubgraphSignError::BodySerialize)?;
        let input = CanonicalV2Input {
            timestamp: get("X-Service-Timestamp"),
            service_name: get("X-Service-Identity"),
            method: get("X-Service-Method"),
            path: get("X-Service-Path"),
            body_hash: sha256_hex(&body_bytes),
            tenant_id: "11111111-1111-4111-8111-111111111111".to_string(),
            key_id: get("X-Service-Key-Id"),
            audience: get("X-Service-Audience"),
            query_hash: get("X-Service-Query-Hash"),
            content_type: get("X-Service-Content-Type"),
            effective_tenant_id: get("X-Service-Effective-Tenant-ID"),
            assertion_hash: get("X-Service-Assertion-Hash"),
            nonce: get("X-Service-Nonce"),
        };
        let canonical = build_canonical_v2(&input);
        let expected =
            sign_v2(&canonical, b"test-shared-secret").map_err(SubgraphSignError::Sign)?;
        assert_eq!(get("X-Service-Signature"), expected);
        assert_eq!(get("X-Service-Body-Hash"), sha256_hex(&body_bytes));
        Ok(())
    }

    #[test]
    fn timestamp_is_iso8601_millis_z() -> Result<(), SubgraphSignError> {
        let (_response, signed) = sign_subgraph_request(&subgraph_request(), &ctx())?;
        // `.get(1)` (not `pairs[1]`) — the workspace clippy `indexing_slicing` lint
        // denies bare indexing in test code too (lints apply with --all-targets).
        let ts = signed
            .pairs
            .get(1)
            .map(|(_, v)| v.clone())
            .unwrap_or_default();
        // Matches JS Date.toISOString(): YYYY-MM-DDTHH:MM:SS.mmmZ
        assert!(ts.ends_with('Z'), "timestamp must end with Z: {ts}");
        assert_eq!(ts.len(), 24, "ISO-8601 millis-Z is 24 chars: {ts}");
        // `.chars().nth(19)` (not `&ts[19..20]`) — index-safe per the deny lint.
        assert_eq!(
            ts.chars().nth(19),
            Some('.'),
            "millisecond separator at index 19: {ts}"
        );
        Ok(())
    }

    #[test]
    fn nonce_is_unique_per_call() -> Result<(), SubgraphSignError> {
        let (_r1, s1) = sign_subgraph_request(&subgraph_request(), &ctx())?;
        let (_r2, s2) = sign_subgraph_request(&subgraph_request(), &ctx())?;
        let nonce1 = s1
            .pairs
            .iter()
            .find(|(n, _)| *n == "X-Service-Nonce")
            .map(|(_, v)| v.clone());
        let nonce2 = s2
            .pairs
            .iter()
            .find(|(n, _)| *n == "X-Service-Nonce")
            .map(|(_, v)| v.clone());
        assert_ne!(nonce1, nonce2, "nonce must be fresh per request");
        Ok(())
    }

    #[test]
    fn response_is_continue_and_echoes_id() -> Result<(), SubgraphSignError> {
        let (response, _signed) = sign_subgraph_request(&subgraph_request(), &ctx())?;
        assert!(response.control.is_continue());
        assert_eq!(response.id, "req-1");
        assert_eq!(response.stage, "SubgraphRequest");
        Ok(())
    }

    #[test]
    fn content_type_falls_back_to_application_json_when_header_absent()
    -> Result<(), SubgraphSignError> {
        // A forwarded request with NO content-type header must sign the
        // application/json default — never the empty string (CRIT-A regression guard).
        let mut req = subgraph_request();
        req.headers.clear();
        let (_response, signed) = sign_subgraph_request(&req, &ctx())?;
        let by_name = |k: &str| -> String {
            signed
                .pairs
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.clone())
                .unwrap_or_default()
        };
        assert_eq!(by_name("X-Service-Content-Type"), "application/json");
        Ok(())
    }

    #[test]
    fn content_type_is_read_case_insensitively() -> Result<(), SubgraphSignError> {
        // Apollo lower-cases header names; a different casing must still be found so
        // the signed content-type matches the wire value byte-for-byte.
        let mut req = subgraph_request();
        req.headers.clear();
        req.insert_header("Content-Type", "application/json; charset=utf-8");
        let (_response, signed) = sign_subgraph_request(&req, &ctx())?;
        let by_name = |k: &str| -> String {
            signed
                .pairs
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.clone())
                .unwrap_or_default()
        };
        assert_eq!(
            by_name("X-Service-Content-Type"),
            "application/json; charset=utf-8"
        );
        Ok(())
    }

    #[test]
    fn query_hash_is_derived_from_uri_query_string() -> Result<(), SubgraphSignError> {
        // A URI WITH a query string must bind sha256(query) — proving the query hash is
        // DERIVED, not the baked-in sha256("") the old code hard-coded.
        let mut req = subgraph_request();
        req.path = None; // force path/query derivation from the uri
        req.uri = Some("http://auth-service:3000/graphql?op=me".to_string());
        let (_response, signed) = sign_subgraph_request(&req, &ctx())?;
        let by_name = |k: &str| -> String {
            signed
                .pairs
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.clone())
                .unwrap_or_default()
        };
        assert_eq!(by_name("X-Service-Query-Hash"), sha256_hex(b"op=me"));
        assert_eq!(by_name("X-Service-Path"), "/graphql");
        Ok(())
    }

    #[test]
    fn path_component_of_uri_handles_absolute_relative_and_query() {
        assert_eq!(path_component_of_uri("/graphql"), "/graphql");
        assert_eq!(path_component_of_uri("/graphql?op=me"), "/graphql");
        assert_eq!(
            path_component_of_uri("http://auth-service:3000/graphql?op=me"),
            "/graphql"
        );
        assert_eq!(path_component_of_uri("http://auth-service:3000"), "/");
    }

    #[test]
    fn query_string_from_uri_extracts_after_question_mark() {
        assert_eq!(query_string_from_uri("/graphql"), "");
        assert_eq!(query_string_from_uri("/graphql?op=me"), "op=me");
        assert_eq!(query_string_from_uri("/graphql?a=1&b=2"), "a=1&b=2");
    }

    #[test]
    fn body_hash_is_empty_hash_when_no_body_forwarded() -> Result<(), SubgraphSignError> {
        // If router.yaml ever disables body forwarding, the canonical binds sha256("")
        // explicitly — an "empty" request cannot later have a body appended without
        // breaking the signature.
        let mut req = subgraph_request();
        req.body = None;
        let (_response, signed) = sign_subgraph_request(&req, &ctx())?;
        let by_name = |k: &str| -> String {
            signed
                .pairs
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.clone())
                .unwrap_or_default()
        };
        assert_eq!(by_name("X-Service-Body-Hash"), sha256_hex(b""));
        Ok(())
    }
}
