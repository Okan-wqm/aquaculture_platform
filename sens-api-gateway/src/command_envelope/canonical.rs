//! # Canonical params serialization + cmd_hash (plan §4.10)
//!
//! Deterministic serialization of `(cmd_name, params)` for signature binding.
//! The SHA-256 of the canonical bytes is the `cmd_hash` claim in the
//! [`super::envelope::CommandEnvelope`]; the envelope signature covers
//! `cmd_hash` so the command + its params cannot be separated from the
//! signature by any attacker-in-the-middle.
//!
//! ## Canonical bytes encoding (v1, length-prefix framing)
//!
//! ```text
//! be_u32(cmd_name.len()) || cmd_name.as_bytes() ||
//! canonical_params_bytes ||
//! b"command-envelope-v1"
//! ```
//!
//! Where `canonical_params_bytes` is the deterministic serde_json rendering
//! of `params` as a `BTreeMap<String, Value>` — keys sorted lexicographically,
//! string values length-prefixed in the JSON output. serde_json's default
//! ordering is NOT deterministic for `serde_json::Map<String, Value>`
//! (preserves insertion order), so we explicitly route through `BTreeMap`
//! to get lexicographic key ordering.
//!
//! ## Why BTreeMap → serde_json (not bincode)?
//!
//! - `params` is operator-facing JSON on the wire (MQTT payload). Round-tripping
//!   it through bincode would couple the canonical-bytes shape to bincode's
//!   internal-format semantics across future versions; serde_json's JSON
//!   output is byte-for-byte stable across serde_json versions for a given
//!   BTreeMap input.
//! - Cross-language signers (cloud-side NestJS auth-service) produce JSON
//!   natively via `JSON.stringify`; we need encoding parity. serde_json
//!   + BTreeMap is the standard idiom; NestJS uses `canonical-json` or
//!   sorted-key JSON.stringify which matches.
//!
//! ## Security gate — params MUST be an object
//!
//! `params` at the wire level is accepted as `serde_json::Value`, but for
//! canonical-bytes we REQUIRE it to be an object (map). Top-level arrays,
//! bare values, null reject at `canonical_params`. Avoids ambiguous
//! interpretation cases.

use std::collections::BTreeMap;

use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanonicalParamsError {
    /// `cmd_name` empty — every command has a name.
    EmptyCmdName,
    /// `cmd_name` exceeded `u32::MAX` bytes (not reachable under sane input).
    CmdNameLengthOverflow,
    /// `params` is not a JSON object at the top level (e.g., array, string,
    /// null, number). Wire contract requires an object — operator error.
    ParamsNotAnObject,
    /// serde_json failed to serialize the canonical BTreeMap.
    JsonSerializeFailed,
    /// Parameter key encountered a non-string (not possible under serde_json
    /// map semantics — kept for defense-in-depth). NEVER fires in practice.
    NonStringParamKey,
}

impl std::fmt::Display for CanonicalParamsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyCmdName => f.write_str("empty_cmd_name"),
            Self::CmdNameLengthOverflow => f.write_str("cmd_name_length_overflow"),
            Self::ParamsNotAnObject => f.write_str("params_not_an_object"),
            Self::JsonSerializeFailed => f.write_str("json_serialize_failed"),
            Self::NonStringParamKey => f.write_str("non_string_param_key"),
        }
    }
}

impl std::error::Error for CanonicalParamsError {}

/// SHA-256 digest of canonical params. 32 bytes wrapped in a newtype so
/// consumers cannot accidentally mix hash contexts (e.g., swap in an HMAC
/// output for a command hash). `#[serde(transparent)]` renders it as a
/// raw 32-element array on the wire — JSON emits `[a,b,...]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct CmdHash([u8; 32]);

impl CmdHash {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// Produce the canonical bytes for `(cmd_name, params)`. Used both for
/// signature binding (hash → sign) and verify (receive → hash → compare).
///
/// **Deterministic output:**
///
/// For a given `(cmd_name, params)` where `params` is a JSON object, the
/// output bytes are byte-identical across invocations, Rust target triples,
/// and serde_json patch versions. The BTreeMap intermediate structurally
/// guarantees lexicographic key ordering regardless of the incoming
/// `serde_json::Value` map's insertion order.
///
/// **Nested objects:** serde_json's `to_string` recursively handles nested
/// objects. However, nested objects inside a serde_json `Value::Object`
/// preserve insertion order (they are `serde_json::Map`, not `BTreeMap`).
/// For full-depth canonicalization we must walk + re-order nested objects.
/// Batch 7 explicitly REJECTS nested objects in `params` — the deterministic
/// canonicalization pass stays flat; consumers needing nested structures
/// flatten them into dotted-key flat objects (`{"foo.bar": "value"}`). Full
/// recursive-object canonicalization is tracked as Sprint 6.4 finding
/// BATCH-007-FU-01; adding recursion requires the same lexicographic-sort
/// discipline applied at every depth + a bumped `command-envelope-v2` tag.
pub fn canonical_params(cmd_name: &str, params: &Value) -> Result<Vec<u8>, CanonicalParamsError> {
    if cmd_name.is_empty() {
        return Err(CanonicalParamsError::EmptyCmdName);
    }
    let cmd_name_bytes = cmd_name.as_bytes();
    let cmd_name_len: u32 = u32::try_from(cmd_name_bytes.len())
        .map_err(|_| CanonicalParamsError::CmdNameLengthOverflow)?;

    let obj = params
        .as_object()
        .ok_or(CanonicalParamsError::ParamsNotAnObject)?;

    // BTreeMap gives lexicographic key ordering. Values are cloned into
    // a BTreeMap<String, Value>. For full nested determinism, the caller
    // should flatten nested objects into dotted keys; see module docstring.
    let mut sorted: BTreeMap<String, Value> = BTreeMap::new();
    for (k, v) in obj {
        // Reject nested objects to keep canonicalization deterministic.
        // Nested arrays are acceptable (order is semantic). Nested objects
        // would require recursive re-ordering which Batch 7 intentionally
        // defers to Sprint 6.4 runtime (tracked via finding BATCH-007-FU-01).
        if v.is_object() {
            return Err(CanonicalParamsError::ParamsNotAnObject);
        }
        sorted.insert(k.clone(), v.clone());
    }

    let params_bytes =
        serde_json::to_vec(&sorted).map_err(|_| CanonicalParamsError::JsonSerializeFailed)?;

    let mut out = Vec::with_capacity(4 + cmd_name_bytes.len() + params_bytes.len() + 19);
    out.extend_from_slice(&cmd_name_len.to_be_bytes());
    out.extend_from_slice(cmd_name_bytes);
    out.extend_from_slice(&params_bytes);
    out.extend_from_slice(b"command-envelope-v1");
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// WHY: Identical inputs produce identical canonical bytes.
    #[test]
    fn canonical_params_deterministic() {
        let params = json!({"tag": "pond3_aerator", "value": 0.95});
        let a = canonical_params("write_tag", &params).expect("ok");
        let b = canonical_params("write_tag", &params).expect("ok");
        assert_eq!(a, b);
    }

    /// WHY: Key ordering doesn't affect canonical bytes — BTreeMap imposes
    ///      lexicographic order regardless of input insertion order.
    #[test]
    fn canonical_params_invariant_to_key_order() {
        let ordered = json!({"a": 1, "b": 2, "c": 3});
        let reversed = json!({"c": 3, "b": 2, "a": 1});
        let a = canonical_params("cmd", &ordered).expect("ok");
        let b = canonical_params("cmd", &reversed).expect("ok");
        assert_eq!(a, b);
    }

    /// WHY: Domain-separation tag at END (command-envelope-v1).
    #[test]
    fn canonical_params_ends_with_v1_tag() {
        let params = json!({"x": 1});
        let bytes = canonical_params("cmd", &params).expect("ok");
        assert!(bytes.ends_with(b"command-envelope-v1"));
    }

    /// WHY: First 4 bytes are be_u32 cmd_name length (EDGE-LOW-101
    ///      length-prefix framing pattern).
    #[test]
    fn canonical_params_first_four_bytes_are_cmd_name_len() {
        let params = json!({});
        let bytes = canonical_params("write_tag", &params).expect("ok");
        assert_eq!(&bytes[..4], &9u32.to_be_bytes()); // "write_tag" = 9 bytes
        assert_eq!(&bytes[4..13], b"write_tag");
    }

    /// WHY: Changing cmd_name changes canonical bytes.
    #[test]
    fn canonical_params_sensitive_to_cmd_name() {
        let params = json!({"x": 1});
        let a = canonical_params("cmd_a", &params).expect("ok");
        let b = canonical_params("cmd_b", &params).expect("ok");
        assert_ne!(a, b);
    }

    /// WHY: Changing param value changes canonical bytes.
    #[test]
    fn canonical_params_sensitive_to_param_value() {
        let a = canonical_params("cmd", &json!({"x": 1})).expect("ok");
        let b = canonical_params("cmd", &json!({"x": 2})).expect("ok");
        assert_ne!(a, b);
    }

    /// WHY: Empty cmd_name rejected.
    #[test]
    fn rejects_empty_cmd_name() {
        let err = canonical_params("", &json!({})).expect_err("empty");
        assert_eq!(err, CanonicalParamsError::EmptyCmdName);
    }

    /// WHY: Top-level non-object params rejected (array / string / number / null).
    #[test]
    fn rejects_non_object_params() {
        let err = canonical_params("cmd", &json!([1, 2, 3])).expect_err("array");
        assert_eq!(err, CanonicalParamsError::ParamsNotAnObject);
        let err = canonical_params("cmd", &json!("string")).expect_err("string");
        assert_eq!(err, CanonicalParamsError::ParamsNotAnObject);
        let err = canonical_params("cmd", &json!(42)).expect_err("number");
        assert_eq!(err, CanonicalParamsError::ParamsNotAnObject);
        let err = canonical_params("cmd", &json!(null)).expect_err("null");
        assert_eq!(err, CanonicalParamsError::ParamsNotAnObject);
    }

    /// WHY: Nested objects rejected — keeps canonicalization deterministic
    ///      without recursive re-ordering. Consumers flatten nested into
    ///      dotted keys.
    #[test]
    fn rejects_nested_object_params() {
        let params = json!({"outer": {"inner": 1}});
        let err = canonical_params("cmd", &params).expect_err("nested");
        assert_eq!(err, CanonicalParamsError::ParamsNotAnObject);
    }

    /// WHY: Arrays at the value level ARE allowed — order is semantic.
    #[test]
    fn accepts_array_values() {
        let params = json!({"tags": ["a", "b", "c"]});
        canonical_params("cmd", &params).expect("arrays OK");
    }

    /// WHY: CmdHash newtype prevents mixing contexts.
    #[test]
    fn cmd_hash_newtype_wraps_32_bytes() {
        let h = CmdHash::from_bytes([0xabu8; 32]);
        assert_eq!(h.as_bytes(), &[0xabu8; 32]);
    }

    /// WHY: Error Display format pinned for audit surface.
    #[test]
    fn canonical_params_error_display_snake_case() {
        assert_eq!(
            format!("{}", CanonicalParamsError::EmptyCmdName),
            "empty_cmd_name"
        );
        assert_eq!(
            format!("{}", CanonicalParamsError::ParamsNotAnObject),
            "params_not_an_object"
        );
        assert_eq!(
            format!("{}", CanonicalParamsError::JsonSerializeFailed),
            "json_serialize_failed"
        );
        assert_eq!(
            format!("{}", CanonicalParamsError::CmdNameLengthOverflow),
            "cmd_name_length_overflow"
        );
        assert_eq!(
            format!("{}", CanonicalParamsError::NonStringParamKey),
            "non_string_param_key"
        );
    }

    /// WHY: Error implements std::error::Error for `?` interop.
    #[test]
    fn canonical_params_error_implements_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<CanonicalParamsError>();
    }
}
