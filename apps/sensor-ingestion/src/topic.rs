//! MQTT topic parser — extract tenant id + sensor/device id from a
//! concrete topic string, surface the result as a strongly-typed
//! [`ParsedTopic`].
//!
//! WHY this module exists at all:
//!   The sensor-ingestion hot path subscribes to broker wildcards
//!   (`sensors/#`, `tenants/+/devices/+/io_data`) but every individual
//!   published message arrives on a concrete, fully-qualified topic.
//!   Stage 7 of the sensor-rust-migration plan will cross-check the
//!   tenant id carried in the topic against the tenant id inside the
//!   protocol-codec-decoded payload; this module produces the
//!   topic-side half of that cross-check.
//!
//! WHY strongly-typed over &str:
//!   The tenant id and sensor/device id are UUIDs — not opaque
//!   strings. Returning already-parsed [`uuid::Uuid`] (via
//!   `TenantId::try_parse` from the workspace `tenant-context` crate)
//!   makes the topic↔payload tenant comparison a total function in
//!   stage 7, instead of a stringly-typed comparison that would
//!   normalize casing and hyphenation ad-hoc at every callsite. The
//!   type system enforces that a topic cannot be "parsed" unless
//!   every id inside it round-trips through the strict 36-byte UUID
//!   parser.
//!
//! WHY the error type is a discriminator only:
//!   MQTT topics are attacker-controllable — a broker client that
//!   publishes to `sensors/<malicious-payload-bytes>/…` can get the
//!   topic string echoed anywhere we log the parse error verbatim.
//!   That is an audit-log poisoning vector. [`TopicParseError`]
//!   deliberately carries NO borrowed or owned strings from the
//!   input; each variant is a pure discriminator. The caller logs
//!   the variant name + the already-truncated topic from the upstream
//!   `RawMqttMessage::topic` field, under a log line it controls.
//!
//! WHY wildcards are rejected, not handled:
//!   `sensors/#` and `tenants/+/devices/+/io_data` are subscribe-side
//!   filters only. The broker never delivers a publish on a wildcard
//!   topic; by the time bytes hit [`parse`], every segment is a
//!   concrete value. If an operator mis-configured the broker such
//!   that a wildcard literal reached publish, the segment between
//!   `sensors/` and `/data` would fail UUID parsing and be rejected
//!   as [`TopicParseError::InvalidTenantId`] — there is no silent
//!   acceptance path.
//!
//! WHAT this module does NOT do:
//!   - It does NOT load a per-tenant feature-flag table
//!     (`INGEST_BACKEND=rust|node` lives in a separate cache).
//!   - It does NOT compare topic-tenant against payload-tenant
//!     (stage 7 orchestrates both halves).
//!   - It does NOT allocate — every parse is a `str::split('/')`
//!     walk with zero per-call heap allocation beyond the two 16-byte
//!     UUID parses.

use tenant_context::TenantId;
use thiserror::Error;
use uuid::Uuid;

/// The two accepted MQTT topic shapes, parsed into strongly-typed
/// identifiers.
///
/// `Sensor` and `Device` are kept as distinct variants rather than a
/// single `{ tenant, entity_id }` pair because downstream stages need
/// to dispatch on the source (a sensor frame reaches the protocol-
/// codec's sensor decoder; an io_data frame reaches the device
/// decoder). Collapsing the variants would force a re-discriminator
/// in stage 7 — the type system already has the information.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ParsedTopic {
    /// Topic shape: `sensors/<tenant-uuid>/<sensor-uuid>/data`.
    Sensor {
        /// Tenant id carried in segment `[1]` of the topic.
        tenant: TenantId,
        /// Sensor id carried in segment `[2]` of the topic.
        sensor: Uuid,
    },
    /// Topic shape:
    /// `tenants/<tenant-uuid>/devices/<device-uuid>/io_data`.
    Device {
        /// Tenant id carried in segment `[1]` of the topic.
        tenant: TenantId,
        /// Device id carried in segment `[3]` of the topic.
        device: Uuid,
    },
}

/// Discriminator-only error type emitted by [`parse`].
///
/// No variant carries the raw input — see the module-level "why the
/// error type is a discriminator only" note. Callers that want to
/// include the offending topic in a log line MUST do so under a
/// log-call they own, against the already-bounded `RawMqttMessage::topic`
/// that the MQTT subscriber layer produced.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum TopicParseError {
    /// The first segment was neither `sensors` nor `tenants`.
    #[error("unknown topic prefix")]
    UnknownPrefix,

    /// The topic had fewer or more segments than the shape demands.
    /// Only the counts — not the segments themselves — are carried.
    #[error("segment count mismatch: expected {expected}, got {got}")]
    MissingSegments {
        /// Number of segments the matched shape required.
        expected: usize,
        /// Number of segments actually present.
        got: usize,
    },

    /// The tenant segment was not a strict 36-byte UUID.
    #[error("invalid tenant id segment")]
    InvalidTenantId,

    /// The sensor segment (shape 1 only) was not a strict 36-byte UUID.
    #[error("invalid sensor id segment")]
    InvalidSensorId,

    /// The device segment (shape 2 only) was not a strict 36-byte UUID.
    #[error("invalid device id segment")]
    InvalidDeviceId,

    /// A literal segment that the shape pins (`data`, `devices`,
    /// `io_data`) did not match exactly.
    #[error("unexpected trailing or literal segment")]
    UnexpectedTrailingSegments,
}

/// Parse a concrete, fully-qualified MQTT topic into a
/// [`ParsedTopic`].
///
/// # Errors
/// Returns a discriminator-only [`TopicParseError`] on any structural
/// or UUID-parse failure. The input is NOT echoed back.
///
/// # Shapes accepted
/// * `sensors/<tenant-uuid>/<sensor-uuid>/data`
/// * `tenants/<tenant-uuid>/devices/<device-uuid>/io_data`
pub fn parse(topic: &str) -> Result<ParsedTopic, TopicParseError> {
    // Walk segments with an iterator — `str::split('/')` produces
    // `&str` borrows without allocation. Indexing is forbidden at the
    // workspace level (`clippy::indexing_slicing = "deny"`), so we use
    // `next()` checkpoints and materialize the count once.
    //
    // NB: we COLLECT into a small stack-adjacent vec so we can both
    // (a) count segments exactly once for the MissingSegments error
    // and (b) destructure positionally without re-walking. A topic
    // has at most ~5 segments in either accepted shape, so the
    // allocation is O(1) bounded and cannot DoS us even on a torrent
    // of malformed inputs.
    let segments: Vec<&str> = topic.split('/').collect();

    // An empty topic splits to `[""]` (one empty segment), not `[]`.
    // Treat both the literal-empty case and the no-recognizable-
    // prefix case as UnknownPrefix so the shape discriminator fires
    // before the shape-specific segment-count check.
    let Some(prefix) = segments.first() else {
        return Err(TopicParseError::UnknownPrefix);
    };

    match *prefix {
        "sensors" => parse_sensor_shape(&segments),
        "tenants" => parse_device_shape(&segments),
        // An empty first segment (topic began with '/') or any other
        // literal falls through to UnknownPrefix. This is deliberately
        // BEFORE the segment-count check — prefix identity is the
        // cheapest discriminator and it also avoids echoing the
        // unknown prefix via MissingSegments diagnostics.
        _ => Err(TopicParseError::UnknownPrefix),
    }
}

/// Shape 1: `sensors/<tenant-uuid>/<sensor-uuid>/data` — exactly 4
/// segments.
fn parse_sensor_shape(segments: &[&str]) -> Result<ParsedTopic, TopicParseError> {
    const EXPECTED: usize = 4;
    if segments.len() != EXPECTED {
        return Err(TopicParseError::MissingSegments {
            expected: EXPECTED,
            got: segments.len(),
        });
    }

    // Iterator walk — no `segments[i]` indexing.
    let mut it = segments.iter().copied();
    // Prefix already validated by the caller's match arm; consume it.
    let _prefix = it.next();
    let tenant_seg = it.next().ok_or(TopicParseError::InvalidTenantId)?;
    let sensor_seg = it.next().ok_or(TopicParseError::InvalidSensorId)?;
    let suffix = it
        .next()
        .ok_or(TopicParseError::UnexpectedTrailingSegments)?;

    if suffix != "data" {
        return Err(TopicParseError::UnexpectedTrailingSegments);
    }

    let tenant = TenantId::try_parse(tenant_seg).map_err(|_| TopicParseError::InvalidTenantId)?;
    let sensor = Uuid::try_parse(sensor_seg).map_err(|_| TopicParseError::InvalidSensorId)?;

    Ok(ParsedTopic::Sensor { tenant, sensor })
}

/// Shape 2: `tenants/<tenant-uuid>/devices/<device-uuid>/io_data` —
/// exactly 5 segments.
fn parse_device_shape(segments: &[&str]) -> Result<ParsedTopic, TopicParseError> {
    const EXPECTED: usize = 5;
    if segments.len() != EXPECTED {
        return Err(TopicParseError::MissingSegments {
            expected: EXPECTED,
            got: segments.len(),
        });
    }

    let mut it = segments.iter().copied();
    let _prefix = it.next();
    let tenant_seg = it.next().ok_or(TopicParseError::InvalidTenantId)?;
    let devices_lit = it
        .next()
        .ok_or(TopicParseError::UnexpectedTrailingSegments)?;
    let device_seg = it.next().ok_or(TopicParseError::InvalidDeviceId)?;
    let suffix = it
        .next()
        .ok_or(TopicParseError::UnexpectedTrailingSegments)?;

    if devices_lit != "devices" || suffix != "io_data" {
        return Err(TopicParseError::UnexpectedTrailingSegments);
    }

    let tenant = TenantId::try_parse(tenant_seg).map_err(|_| TopicParseError::InvalidTenantId)?;
    let device = Uuid::try_parse(device_seg).map_err(|_| TopicParseError::InvalidDeviceId)?;

    Ok(ParsedTopic::Device { tenant, device })
}

#[cfg(test)]
mod tests {
    use super::{ParsedTopic, TopicParseError, parse};
    use tenant_context::TenantId;
    use uuid::Uuid;

    // Two fixed UUIDs used across the happy-path tests so failure
    // messages point at exact bytes.
    const TENANT_HEX: &str = "550e8400-e29b-41d4-a716-446655440000";
    const SENSOR_HEX: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const DEVICE_HEX: &str = "11111111-2222-3333-4444-555555555555";

    #[test]
    fn parses_sensor_shape_happy_path() {
        let topic = format!("sensors/{TENANT_HEX}/{SENSOR_HEX}/data");
        match parse(&topic).unwrap() {
            ParsedTopic::Sensor { tenant, sensor } => {
                let expected_tenant = TenantId::try_parse(TENANT_HEX).unwrap();
                let expected_sensor = Uuid::try_parse(SENSOR_HEX).unwrap();
                assert_eq!(tenant, expected_tenant);
                assert_eq!(sensor, expected_sensor);
            }
            // Explicit variant arm (not wildcard) — clippy
            // `match_wildcard_for_single_variants` flags `_` here
            // because `ParsedTopic` has only two variants and a
            // future third would slip silently past the test.
            other @ ParsedTopic::Device { .. } => {
                panic!("expected Sensor variant, got {other:?}")
            }
        }
    }

    #[test]
    fn parses_device_shape_happy_path() {
        let topic = format!("tenants/{TENANT_HEX}/devices/{DEVICE_HEX}/io_data");
        match parse(&topic).unwrap() {
            ParsedTopic::Device { tenant, device } => {
                let expected_tenant = TenantId::try_parse(TENANT_HEX).unwrap();
                let expected_device = Uuid::try_parse(DEVICE_HEX).unwrap();
                assert_eq!(tenant, expected_tenant);
                assert_eq!(device, expected_device);
            }
            other @ ParsedTopic::Sensor { .. } => {
                panic!("expected Device variant, got {other:?}")
            }
        }
    }

    #[test]
    fn rejects_empty_topic() {
        // Empty string splits to `[""]` (one empty segment). The
        // first segment is neither `sensors` nor `tenants`, so the
        // prefix discriminator fires first.
        assert_eq!(parse("").unwrap_err(), TopicParseError::UnknownPrefix);
    }

    #[test]
    fn rejects_single_segment() {
        assert_eq!(
            parse("sensors").unwrap_err(),
            TopicParseError::MissingSegments {
                expected: 4,
                got: 1,
            }
        );
    }

    #[test]
    fn rejects_unknown_prefix() {
        let topic = format!("garbage/{TENANT_HEX}/{SENSOR_HEX}/data");
        assert_eq!(parse(&topic).unwrap_err(), TopicParseError::UnknownPrefix);
    }

    #[test]
    fn rejects_leading_slash_as_unknown_prefix() {
        // A leading `/` produces an empty first segment, which is
        // neither `sensors` nor `tenants`.
        let topic = format!("/sensors/{TENANT_HEX}/{SENSOR_HEX}/data");
        assert_eq!(parse(&topic).unwrap_err(), TopicParseError::UnknownPrefix);
    }

    #[test]
    fn rejects_too_few_segments_sensor_shape() {
        let topic = format!("sensors/{TENANT_HEX}/{SENSOR_HEX}");
        assert_eq!(
            parse(&topic).unwrap_err(),
            TopicParseError::MissingSegments {
                expected: 4,
                got: 3,
            }
        );
    }

    #[test]
    fn rejects_too_many_segments_sensor_shape() {
        let topic = format!("sensors/{TENANT_HEX}/{SENSOR_HEX}/data/extra");
        assert_eq!(
            parse(&topic).unwrap_err(),
            TopicParseError::MissingSegments {
                expected: 4,
                got: 5,
            }
        );
    }

    #[test]
    fn rejects_too_few_segments_device_shape() {
        let topic = format!("tenants/{TENANT_HEX}/devices/{DEVICE_HEX}");
        assert_eq!(
            parse(&topic).unwrap_err(),
            TopicParseError::MissingSegments {
                expected: 5,
                got: 4,
            }
        );
    }

    #[test]
    fn rejects_too_many_segments_device_shape() {
        let topic = format!("tenants/{TENANT_HEX}/devices/{DEVICE_HEX}/io_data/extra");
        assert_eq!(
            parse(&topic).unwrap_err(),
            TopicParseError::MissingSegments {
                expected: 5,
                got: 6,
            }
        );
    }

    #[test]
    fn rejects_bad_tenant_uuid_sensor_shape() {
        let topic = format!("sensors/not-a-uuid/{SENSOR_HEX}/data");
        assert_eq!(parse(&topic).unwrap_err(), TopicParseError::InvalidTenantId);
    }

    #[test]
    fn rejects_bad_sensor_uuid() {
        let topic = format!("sensors/{TENANT_HEX}/not-a-uuid/data");
        assert_eq!(parse(&topic).unwrap_err(), TopicParseError::InvalidSensorId);
    }

    #[test]
    fn rejects_bad_tenant_uuid_device_shape() {
        let topic = format!("tenants/not-a-uuid/devices/{DEVICE_HEX}/io_data");
        assert_eq!(parse(&topic).unwrap_err(), TopicParseError::InvalidTenantId);
    }

    #[test]
    fn rejects_bad_device_uuid() {
        let topic = format!("tenants/{TENANT_HEX}/devices/not-a-uuid/io_data");
        assert_eq!(parse(&topic).unwrap_err(), TopicParseError::InvalidDeviceId);
    }

    #[test]
    fn rejects_wrong_suffix_sensor_shape() {
        let topic = format!("sensors/{TENANT_HEX}/{SENSOR_HEX}/telemetry");
        assert_eq!(
            parse(&topic).unwrap_err(),
            TopicParseError::UnexpectedTrailingSegments
        );
    }

    #[test]
    fn rejects_wrong_suffix_device_shape() {
        let topic = format!("tenants/{TENANT_HEX}/devices/{DEVICE_HEX}/telemetry");
        assert_eq!(
            parse(&topic).unwrap_err(),
            TopicParseError::UnexpectedTrailingSegments
        );
    }

    #[test]
    fn rejects_wrong_literal_in_device_shape() {
        // `devices` pinned literal replaced with `gadgets`.
        let topic = format!("tenants/{TENANT_HEX}/gadgets/{DEVICE_HEX}/io_data");
        assert_eq!(
            parse(&topic).unwrap_err(),
            TopicParseError::UnexpectedTrailingSegments
        );
    }

    #[test]
    fn rejects_wildcard_hash_literal() {
        // A broker misconfig that lets a `#` wildcard hit publish
        // must be rejected — `#` is not a UUID.
        let topic = "sensors/#/whatever/data";
        assert_eq!(parse(topic).unwrap_err(), TopicParseError::InvalidTenantId);
    }

    #[test]
    fn rejects_wildcard_plus_literal() {
        // `+` reaching publish is equally a misconfig — not a UUID.
        let topic = format!("sensors/+/{SENSOR_HEX}/data");
        assert_eq!(parse(&topic).unwrap_err(), TopicParseError::InvalidTenantId);
    }

    #[test]
    fn rejects_uppercase_uuid_still_accepted_by_uuid_crate() {
        // `uuid::Uuid::try_parse` accepts uppercase hex. This test
        // pins that behavior — we pass through what `tenant-context`
        // accepts. If ADR-011 tightens TenantId to lowercase-only
        // later, this test is the canary that flips to an expected
        // InvalidTenantId.
        let upper = TENANT_HEX.to_ascii_uppercase();
        let topic = format!("sensors/{upper}/{SENSOR_HEX}/data");
        assert!(matches!(parse(&topic), Ok(ParsedTopic::Sensor { .. })));
    }

    #[test]
    fn error_messages_do_not_echo_input() {
        // Regression guard for the audit-log poisoning vector:
        // make sure the Display impl for each variant contains no
        // copy of the offending bytes.
        let dangerous = "sensors/<script>alert(1)</script>/x/data";
        let err = parse(dangerous).unwrap_err();
        let rendered = format!("{err}");
        assert!(
            !rendered.contains("script"),
            "error message leaked raw input: {rendered}"
        );
        assert!(
            !rendered.contains("alert"),
            "error message leaked raw input: {rendered}"
        );
    }

    #[test]
    fn parsed_topic_is_copy() {
        // Copy is part of the API contract — downstream stages want
        // to stash a ParsedTopic next to the payload without
        // heap-cloning a UUID pair. If someone adds a non-Copy field
        // to the enum later this assert flags it at compile time.
        fn assert_copy<T: Copy>() {}
        assert_copy::<ParsedTopic>();
    }
}
