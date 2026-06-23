//! protocol.rs — serde models for the Apollo Router external coprocessor protocol.
//!
//! WHY: the Apollo Router (configured in `infrastructure/apollo-router/router.yaml`
//! under `coprocessor:`) POSTs a JSON payload to this service once per enabled
//! pipeline stage (RouterRequest, SubgraphRequest, …) and expects a JSON payload
//! back. The Router mutates the in-flight request/response from the fields we echo
//! (headers, body, context, control). These types are the wire contract; they MUST
//! round-trip byte-compatibly with the Router's `coprocessor` codec.
//!
//! WIRE SHAPE (the load-bearing part): the `control` field is the Router's signal
//! for whether to continue the pipeline or short-circuit. Apollo serialises it as
//! EITHER the bare JSON string `"continue"` OR an object `{"break": <status_int>}`.
//! There is no tag key — the two variants are distinguished structurally — so we use
//! `#[serde(untagged)]` with a `Continue` unit-like variant carried as a string and
//! a `Break { status_code }` variant renamed to `break`. See `Control` below.
//!
//! Spec reference: Apollo Router "External coprocessor" protocol — every stage
//! payload carries `version`, `stage`, `control`, `id`, `headers`, and optionally
//! `body`, `context`, `sdl`, `serviceName`, `uri`, `method`, `path`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Protocol version the Router speaks. Apollo currently pins this at `1`; the field
/// is echoed back unchanged. Modelled as `u8` because the protocol is a small
/// integer and a wider type would invite no-op widening.
pub const COPROCESSOR_VERSION: u8 = 1;

/// Header map as Apollo serialises it on the wire: a header name maps to a LIST of
/// values (HTTP permits repeated headers). We preserve the multi-value shape rather
/// than collapsing to a single string so a caller cannot silently drop a duplicate
/// header the Router forwarded.
pub type HeaderMap = HashMap<String, Vec<String>>;

/// The Router's pipeline-control signal.
///
/// # Wire shape (do not "simplify" this — it is the contract)
///
/// * `Continue`  → the bare JSON string `"continue"`.
/// * `Break`     → the JSON object `{"break": <status_code:u16>}`.
///
/// Apollo emits these two shapes untagged (no discriminator key), so `#[serde(untagged)]`
/// is the correct representation: serde tries each variant in declaration order and
/// matches structurally. `Continue` is declared first so a plain `"continue"` string
/// deserialises to it; `Break` matches the `{"break": …}` object form.
///
/// `ContinueMarker` is a zero-cost newtype whose only legal value serialises to the
/// literal string `"continue"`, which is how we encode a stringly-typed unit variant
/// inside an untagged enum without a custom `impl`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Control {
    /// Continue the pipeline. Serialises to the JSON string `"continue"`.
    /// Default so a stage payload that omits `control` is treated as continue, which
    /// is also the Router's own default for a missing control signal.
    #[default]
    Continue,
    /// Short-circuit the pipeline with this HTTP status. Serialises to
    /// `{"break": <status_code>}`.
    Break {
        /// HTTP status code the Router returns to the client (e.g. `401`, `403`).
        status_code: u16,
    },
}

impl Control {
    /// `true` iff this is the [`Control::Continue`] signal.
    #[must_use]
    pub fn is_continue(&self) -> bool {
        matches!(self, Self::Continue)
    }
}

impl Serialize for Control {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            // Bare string "continue".
            Self::Continue => serializer.serialize_str("continue"),
            // Object {"break": <status>}. We hand-roll a one-field map so the key
            // is exactly "break" (a Rust reserved word, hence not expressible as a
            // struct field name without raw-identifier gymnastics).
            Self::Break { status_code } => {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("break", status_code)?;
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for Control {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // We accept either form by first deserialising into an untagged shim, then
        // mapping it. This keeps the public type clean while honouring both wire
        // shapes. A `"continue"` string → Continue; a `{"break": n}` object → Break;
        // anything else is a hard error (fail-closed: an unrecognised control signal
        // must not be silently treated as continue).
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Shim {
            Str(String),
            Break {
                #[serde(rename = "break")]
                status_code: u16,
            },
        }

        match Shim::deserialize(deserializer)? {
            Shim::Str(s) if s == "continue" => Ok(Self::Continue),
            Shim::Str(other) => Err(serde::de::Error::custom(format!(
                "unknown coprocessor control string: {other:?} (expected \"continue\")"
            ))),
            Shim::Break { status_code } => Ok(Self::Break { status_code }),
        }
    }
}

/// One coprocessor stage payload — the SAME shape is used for the Router→coprocessor
/// request and the coprocessor→Router response. The Router reads back exactly the
/// fields we send; unspecified optional fields are omitted from the response so we
/// never overwrite Router state we did not intend to touch.
///
/// `serviceName` is present on the `SubgraphRequest`/`SubgraphResponse` stages and
/// absent on the router-level stages; `uri`/`method`/`path` are forwarded by the
/// Router when the corresponding `headers`/`body` flags request them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoprocessorPayload {
    /// Protocol version. Always [`COPROCESSOR_VERSION`] (`1`).
    pub version: u8,

    /// Pipeline stage: `"RouterRequest"`, `"SubgraphRequest"`, `"RouterResponse"`,
    /// `"SubgraphResponse"`, etc. Echoed back unchanged.
    pub stage: String,

    /// Continue-or-break signal. Defaults to [`Control::Continue`] when absent on the
    /// wire (the Router treats a missing control as continue, but we are explicit).
    #[serde(default)]
    pub control: Control,

    /// Correlation id the Router assigns per request. MUST be echoed verbatim so the
    /// Router can match our response to the in-flight request.
    pub id: String,

    /// Request (or response) headers, multi-valued per name. Defaults to empty so a
    /// stage payload that omits headers still deserialises.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub headers: HeaderMap,

    /// The request/response body, when the stage config enabled body forwarding.
    /// Opaque `serde_json::Value` — the coprocessor signs over it but does not parse
    /// its GraphQL structure here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<Value>,

    /// The Router request context (shared key/value bag across stages). Opaque here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<Value>,

    /// The supergraph SDL, forwarded only when the stage requests it. Rarely needed
    /// by the signing stage; kept for protocol completeness.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sdl: Option<String>,

    /// Target subgraph name — present on `Subgraph*` stages, absent on router stages.
    #[serde(
        rename = "serviceName",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub service_name: Option<String>,

    /// Full request URI as the Router will dispatch it to the subgraph, when
    /// forwarded. Includes scheme/host/path/query.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,

    /// HTTP method the Router will use for the subgraph call (e.g. `"POST"`), when
    /// forwarded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,

    /// Request path without query string, when forwarded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,

    /// Apollo's per-subgraph-request correlation id, present on the
    /// `SubgraphRequest`/`SubgraphResponse` stages when `subgraph_request_id: true`
    /// is enabled in the coprocessor config. Distinct from [`Self::id`] (the
    /// per-coprocessor-call id): a single client request fans out to several
    /// subgraph requests, each with its own `subgraphRequestId`. Echoed back
    /// unchanged so the Router can correlate our response; defaults to `None` and
    /// is omitted from the wire when the flag is off.
    #[serde(
        rename = "subgraphRequestId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub subgraph_request_id: Option<String>,
}

impl CoprocessorPayload {
    /// Build an unchanged "continue" response that echoes the request's `id`,
    /// `version`, and `stage`. The conductor / stage handlers start from this and
    /// add their mutations (e.g. the 14 signing headers) before returning it to the
    /// Router.
    ///
    /// WHY echo `version`/`stage`: the Router validates that the response stage
    /// matches the request stage; a mismatch aborts the request. Echoing keeps the
    /// response structurally valid with zero caller effort (tier-2 "make it
    /// automatic").
    #[must_use]
    pub fn continue_response(id: impl Into<String>, stage: impl Into<String>) -> Self {
        Self {
            version: COPROCESSOR_VERSION,
            stage: stage.into(),
            control: Control::Continue,
            id: id.into(),
            headers: HeaderMap::new(),
            body: None,
            context: None,
            sdl: None,
            service_name: None,
            uri: None,
            method: None,
            path: None,
            subgraph_request_id: None,
        }
    }

    /// Derive a "continue" response from an inbound request payload, carrying over
    /// the `id`, `stage`, `version`, `serviceName`, and `subgraphRequestId`. The
    /// response starts with an EMPTY header map and omits `body`/`uri`/`method`/`path`:
    /// per Apollo's coprocessor contract a property left OUT of the response leaves
    /// the Router's in-flight value untouched, while a property INCLUDED overwrites it.
    /// We therefore include only the headers we want to add/override and the
    /// correlation fields the Router uses to match the response, never re-sending the
    /// inbound request shape (which would risk clobbering Router-side edits).
    #[must_use]
    pub fn continue_from(request: &Self) -> Self {
        Self {
            version: request.version,
            stage: request.stage.clone(),
            control: Control::Continue,
            id: request.id.clone(),
            headers: HeaderMap::new(),
            body: None,
            context: None,
            sdl: None,
            service_name: request.service_name.clone(),
            uri: None,
            method: None,
            path: None,
            subgraph_request_id: request.subgraph_request_id.clone(),
        }
    }

    /// Insert (or append) a single header value under `name`.
    ///
    /// WHAT: appends to the value list for `name`, creating the list if absent. This
    /// preserves the HTTP multi-value semantics of [`HeaderMap`]; the signing stage
    /// always inserts each of its 14 header names exactly once, so in practice each
    /// list holds a single value.
    pub fn insert_header(&mut self, name: impl Into<String>, value: impl Into<String>) {
        self.headers
            .entry(name.into())
            .or_default()
            .push(value.into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_continue_serialises_to_bare_string() -> Result<(), serde_json::Error> {
        let json = serde_json::to_string(&Control::Continue)?;
        assert_eq!(json, "\"continue\"");
        Ok(())
    }

    #[test]
    fn control_break_serialises_to_break_object() -> Result<(), serde_json::Error> {
        let json = serde_json::to_string(&Control::Break { status_code: 401 })?;
        assert_eq!(json, "{\"break\":401}");
        Ok(())
    }

    #[test]
    fn control_continue_round_trips() -> Result<(), serde_json::Error> {
        let parsed: Control = serde_json::from_str("\"continue\"")?;
        assert_eq!(parsed, Control::Continue);
        Ok(())
    }

    #[test]
    fn control_break_round_trips() -> Result<(), serde_json::Error> {
        let parsed: Control = serde_json::from_str("{\"break\":403}")?;
        assert_eq!(parsed, Control::Break { status_code: 403 });
        Ok(())
    }

    #[test]
    fn unknown_control_string_is_rejected() {
        let result: Result<Control, _> = serde_json::from_str("\"halt\"");
        assert!(result.is_err());
    }

    #[test]
    fn subgraph_request_payload_deserialises() -> Result<(), serde_json::Error> {
        // A representative SubgraphRequest envelope as Apollo would POST it.
        let wire = r#"{
            "version": 1,
            "stage": "SubgraphRequest",
            "control": "continue",
            "id": "req-123",
            "serviceName": "auth-service",
            "method": "POST",
            "path": "/graphql",
            "headers": { "content-type": ["application/json"] },
            "body": { "query": "{ me { id } }" }
        }"#;
        let payload: CoprocessorPayload = serde_json::from_str(wire)?;
        assert_eq!(payload.version, 1);
        assert_eq!(payload.stage, "SubgraphRequest");
        assert_eq!(payload.service_name.as_deref(), Some("auth-service"));
        assert!(payload.control.is_continue());
        Ok(())
    }

    #[test]
    fn continue_response_echoes_id_and_stage_and_omits_empty_fields()
    -> Result<(), serde_json::Error> {
        let resp = CoprocessorPayload::continue_response("req-9", "SubgraphRequest");
        let json = serde_json::to_value(&resp)?;
        // `.get(..).and_then(Value::as_str)` — not `json[..]`, whose Index impl the
        // workspace clippy `indexing_slicing` lint denies (applies to test code too).
        assert_eq!(json.get("id").and_then(Value::as_str), Some("req-9"));
        assert_eq!(
            json.get("stage").and_then(Value::as_str),
            Some("SubgraphRequest")
        );
        assert_eq!(
            json.get("control").and_then(Value::as_str),
            Some("continue")
        );
        // Empty header map + None options are skipped from the wire.
        assert!(json.get("headers").is_none());
        assert!(json.get("body").is_none());
        assert!(json.get("serviceName").is_none());
        Ok(())
    }

    #[test]
    fn insert_header_appends_multi_value() {
        let mut resp = CoprocessorPayload::continue_response("req-1", "SubgraphRequest");
        resp.insert_header("X-Service-Identity", "gateway-api");
        resp.insert_header("X-A", "1");
        resp.insert_header("X-A", "2");
        // `.get(..)` — not `headers[..]`, whose HashMap Index impl the workspace
        // clippy `indexing_slicing` lint denies (applies to test code too).
        assert_eq!(
            resp.headers.get("X-Service-Identity"),
            Some(&vec!["gateway-api".to_string()])
        );
        assert_eq!(
            resp.headers.get("X-A"),
            Some(&vec!["1".to_string(), "2".to_string()])
        );
    }

    #[test]
    fn continue_from_carries_service_name_and_clears_headers() {
        let mut req = CoprocessorPayload::continue_response("req-7", "SubgraphRequest");
        req.service_name = Some("farm-service".to_string());
        req.insert_header("authorization", "Bearer x");
        let resp = CoprocessorPayload::continue_from(&req);
        assert_eq!(resp.id, "req-7");
        assert_eq!(resp.service_name.as_deref(), Some("farm-service"));
        assert!(resp.headers.is_empty());
        assert!(resp.control.is_continue());
    }

    #[test]
    fn subgraph_request_id_deserialises_and_is_carried_over() -> Result<(), serde_json::Error> {
        // Apollo sends subgraphRequestId at the SubgraphRequest stage when the
        // subgraph_request_id flag is enabled. It must deserialise, round-trip on
        // the wire, and survive continue_from so the Router can correlate.
        let wire = r#"{
            "version": 1,
            "stage": "SubgraphRequest",
            "control": "continue",
            "id": "req-123",
            "serviceName": "auth-service",
            "subgraphRequestId": "subreq-abc"
        }"#;
        let req: CoprocessorPayload = serde_json::from_str(wire)?;
        assert_eq!(req.subgraph_request_id.as_deref(), Some("subreq-abc"));

        let resp = CoprocessorPayload::continue_from(&req);
        assert_eq!(resp.subgraph_request_id.as_deref(), Some("subreq-abc"));

        let json = serde_json::to_value(&resp)?;
        assert_eq!(
            json.get("subgraphRequestId").and_then(Value::as_str),
            Some("subreq-abc")
        );
        Ok(())
    }

    #[test]
    fn subgraph_request_id_omitted_when_absent() -> Result<(), serde_json::Error> {
        // When the flag is off the field is None and must NOT appear on the wire,
        // so the Router never sees a stray null overwriting its own correlation id.
        let resp = CoprocessorPayload::continue_response("req-9", "SubgraphRequest");
        let json = serde_json::to_value(&resp)?;
        assert!(json.get("subgraphRequestId").is_none());
        Ok(())
    }
}
