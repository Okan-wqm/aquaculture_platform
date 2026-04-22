//! W3C Trace Context propagation helpers (ADR-032 Kör Nokta 3).
//!
//! # Why this module exists
//!
//! Distributed tracing correlates spans across process boundaries
//! via a standard header — W3C Trace Context, which every Node /
//! Rust / Python OpenTelemetry collector consumes natively. When the
//! Rust sensor-ingestion sidecar publishes a `SensorMetricIngested`
//! event to NATS, the downstream TS consumer (sensor-service's NATS
//! consumer, alert-engine, AI service) should see a continuous trace
//! from the MQTT ingest to the eventual GraphQL response. Without
//! the `traceparent` header the trace tree breaks at the NATS hop.
//!
//! This module produces W3C-spec-compliant traceparent strings
//! without pulling the full OpenTelemetry SDK into the hot path.
//! The exporter wiring (OTLP over gRPC to the collector) stays
//! behind the `observability` crate's `otlp` feature; this helper
//! is always-on so cross-language correlation works even when OTLP
//! is off and the Rust side emits only tracing logs.
//!
//! # W3C Trace Context — version 00
//!
//! Spec: <https://www.w3.org/TR/trace-context-1/>
//!
//! The `traceparent` header is a fixed-shape ASCII string:
//!
//! ```text
//! 00-{32 hex chars trace_id}-{16 hex chars parent_id}-{2 hex chars flags}
//! ```
//!
//! - `00` = version 00 (the only stable version).
//! - `trace_id` = 16 random bytes (128-bit), non-zero, hex-encoded.
//! - `parent_id` = 8 random bytes (64-bit), non-zero, hex-encoded.
//!   This is the span id of the emitter.
//! - `flags` = 8 bits; `01` = sampled, `00` = not sampled. We emit
//!   `01` by default — the collector downstream makes the
//!   head-based sampling decision.
//!
//! # Interaction with OpenTelemetry
//!
//! When the `otlp` feature is enabled, `tracing-opentelemetry`
//! attaches a `SpanContext` with proper parent-child relationships;
//! that layer's propagator supersedes this helper for child spans.
//! This helper is the TOP-OF-STACK primitive: the sidecar's MQTT
//! ingest has no incoming trace context (MQTT v3 does not carry
//! headers in the broker's delivery path we use), so every
//! emitted event is the root of a new trace. Future work that
//! accepts traceparent on the MQTT v5 user-property path can thread
//! the incoming id through instead of generating a fresh one.

use uuid::Uuid;

/// Canonical header name for the W3C `traceparent` field. Matches
/// the TS side's `@opentelemetry/propagator-w3c` constant so the
/// collector joins spans across the language boundary.
pub const TRACEPARENT_HEADER: &str = "traceparent";

/// Render a fresh W3C `traceparent` version-00 string. The trace_id
/// is 16 random bytes (pulled from `Uuid::new_v4` for the entropy
/// source — v4 UUIDs are spec-defined-random), the parent_id is the
/// high 8 bytes of a second random UUID, flags are `01` (sampled).
///
/// Guarantees:
///   1. Length is always 55 characters (spec fixed).
///   2. trace_id and parent_id are both non-zero (spec requires).
///   3. Lower-case hex (the W3C spec mandates lower-case).
///
/// Collisions are cryptographically negligible: 128 bits for trace_id
/// means birthday-paradox collision at 2^64 spans per process, which
/// at 50 K msg/s is ~6 million years. trace_id uniqueness is not a
/// security property — it is a correlation property — so UUID v4
/// entropy is sufficient.
#[must_use]
pub fn generate_traceparent() -> String {
    let trace_id = Uuid::new_v4();
    let parent_id_uuid = Uuid::new_v4();
    // parent_id is 8 bytes, take the high half of the UUID's 128 bits.
    let parent_bytes = &parent_id_uuid.as_bytes()[..8];
    format!(
        "00-{}-{}-01",
        // `Uuid::simple` writes 32 hex chars without hyphens,
        // lower-case, exactly the shape the spec demands.
        trace_id.simple(),
        hex_encode_lower(parent_bytes)
    )
}

/// Hex-encode a byte slice as lower-case ASCII. Avoids pulling
/// `hex = "0.4"` as a first-class crate dep just for this one use —
/// the stdlib only exposes uppercase formatting via
/// `format!("{:X}", ...)`, and the spec mandates lower-case.
fn hex_encode_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        // `b >> 4` and `b & 0x0f` always yield 0..=15; the lookup
        // into the 16-char table is in-bounds by construction, so
        // the indexing cannot panic.
        #[allow(clippy::indexing_slicing)]
        {
            out.push(char::from(HEX[usize::from(b >> 4)]));
            out.push(char::from(HEX[usize::from(b & 0x0f)]));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{TRACEPARENT_HEADER, generate_traceparent, hex_encode_lower};

    #[test]
    fn header_name_is_the_w3c_canonical() {
        // A rename here breaks cross-language trace correlation —
        // the TS collector filters by this literal. Pin it.
        assert_eq!(TRACEPARENT_HEADER, "traceparent");
    }

    #[test]
    fn traceparent_is_exactly_55_chars() {
        // W3C v00 traceparent length is fixed: 2 + 1 + 32 + 1 + 16 + 1 + 2 = 55.
        for _ in 0..64 {
            let tp = generate_traceparent();
            assert_eq!(
                tp.len(),
                55,
                "spec-fixed length violated; got {} chars: {tp}",
                tp.len()
            );
        }
    }

    #[test]
    fn traceparent_shape_is_version_dashed_ids_flags() {
        let tp = generate_traceparent();
        let parts: Vec<&str> = tp.split('-').collect();
        assert_eq!(parts.len(), 4, "must have 4 dash-separated parts: {tp}");
        assert_eq!(parts[0], "00", "version must be 00");
        assert_eq!(parts[1].len(), 32, "trace_id must be 32 hex chars");
        assert_eq!(parts[2].len(), 16, "parent_id must be 16 hex chars");
        assert_eq!(parts[3], "01", "flags must be 01 (sampled)");
    }

    #[test]
    fn traceparent_ids_are_lowercase_hex() {
        for _ in 0..16 {
            let tp = generate_traceparent();
            let parts: Vec<&str> = tp.split('-').collect();
            let body = format!("{}{}", parts[1], parts[2]);
            for c in body.chars() {
                assert!(
                    c.is_ascii_digit() || ('a'..='f').contains(&c),
                    "non-lowercase-hex char in traceparent body: {c} in {tp}"
                );
            }
        }
    }

    #[test]
    fn traceparent_ids_are_not_all_zero() {
        // W3C spec: trace_id and parent_id MUST be non-zero. A
        // regression that seeded the randomness with a constant
        // would produce all-zero ids (spec-invalid). The collector
        // would drop the span.
        for _ in 0..64 {
            let tp = generate_traceparent();
            let parts: Vec<&str> = tp.split('-').collect();
            assert!(
                parts[1].chars().any(|c| c != '0'),
                "trace_id must not be all-zero: {tp}"
            );
            assert!(
                parts[2].chars().any(|c| c != '0'),
                "parent_id must not be all-zero: {tp}"
            );
        }
    }

    #[test]
    fn traceparent_trace_ids_diverge_under_repeated_calls() {
        // Two successive calls must produce different trace_ids.
        // A regression that reused the same trace_id per process
        // would defeat the correlation purpose.
        let first = generate_traceparent();
        let second = generate_traceparent();
        assert_ne!(
            first, second,
            "two traceparents from the same process must differ"
        );
    }

    #[test]
    fn hex_encode_lower_matches_spec() {
        assert_eq!(hex_encode_lower(&[]), "");
        assert_eq!(hex_encode_lower(&[0x00]), "00");
        assert_eq!(hex_encode_lower(&[0xff]), "ff");
        assert_eq!(hex_encode_lower(&[0xab, 0xcd]), "abcd");
        assert_eq!(hex_encode_lower(&[0x01, 0x23, 0x45]), "012345");
    }
}
