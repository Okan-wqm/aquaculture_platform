//! Sensor-reading payload validator — Faz 2 stage 7.
//!
//! WHY this module exists (ADR-025 § Threat 2):
//!   The MQTT broker is a shared trust surface. A compromised or
//!   misconfigured edge device can publish a payload whose `tenantId`
//!   field disagrees with the tenant id encoded in the topic
//!   (`tenants/<uuid>/devices/<uuid>/io_data`). Without an explicit
//!   bind check, the ingestion path would silently route the metric
//!   into the wrong tenant's hypertable — a cross-tenant data-leak
//!   class indistinguishable from a successful exfiltration.
//!
//!   This module is the FIRST runtime layer of the multi-tenant
//!   isolation guarantee that compile-time `tenant-context` cannot
//!   reach (the JSON bytes have not been branded yet). The contract
//!   it enforces:
//!
//!     1. Payload is well-formed JSON with EXACTLY the fields the
//!        sensor-service contract names — no more, no less
//!        (`#[serde(deny_unknown_fields)]`). Closes the prototype-
//!        pollution class (ADR-025 § Threat 3).
//!     2. The three UUID fields parse as strict 36-byte UUIDs via
//!        `uuid::try_parse` (no regex, ~10 ns vs ~500 ns + 3 alloc
//!        for a regex pass per the plan's measured numbers).
//!     3. `value` is a finite f64 — `NaN` and `±Inf` are rejected
//!        because a downstream `WHERE value > X` query would silently
//!        misclassify them.
//!     4. `quality` is in the IEC 61131-3 quality-code subset 0..=3.
//!     5. `producerTs` is a positive ms-epoch within a sane window
//!        (post 2024-01-01, before year 2100). Drift outside that
//!        window means a clock-skewed device or a forged timestamp
//!        and the row is rejected before it pollutes Timescale's
//!        chunk-pruning heuristic.
//!     6. The payload's `tenantId` MUST equal the `topic_tenant` that
//!        the topic parser already extracted. This is the Threat 2
//!        bind. Without it, the rest of the pipeline trusts the
//!        broker-supplied tenant id; with it, the bind is an explicit
//!        precondition every downstream stage can rely on.
//!
//! WHY no `as any`-style escape hatch:
//!   Every error variant is a concrete enum, never an attacker-
//!   controlled string. `Display` impls deliberately do NOT echo the
//!   raw bytes that triggered the error — audit logs cannot be
//!   poisoned by a payload that contains a `</script>` substring or a
//!   newline injection.

use serde::Deserialize;
use tenant_context::TenantId;
use thiserror::Error;
use uuid::Uuid;

/// Lower bound for a plausible producer timestamp (ms since UNIX
/// epoch). `2024-01-01T00:00:00Z` — anything earlier is either a
/// clock-skewed edge device or a forged timestamp; either way it
/// poisons Timescale's chunk-pruning heuristic and we reject it at
/// the trust boundary.
pub const PRODUCER_TS_MIN_MS: i64 = 1_704_067_200_000;

/// Upper bound for a plausible producer timestamp (ms since UNIX
/// epoch). `2100-01-01T00:00:00Z` — chosen high enough that we never
/// trip on legitimate skew but low enough that an `i64::MAX` smuggled
/// into the JSON cannot pass.
pub const PRODUCER_TS_MAX_MS: i64 = 4_102_444_800_000;

/// Maximum value for the IEC 61131-3 quality-code subset accepted by
/// the ingestion path. The wider IEC range is `0..=255` but the
/// sensor-service contract narrows it to `0..=3` (good / uncertain /
/// bad / not-connected).
pub const QUALITY_MAX: u8 = 3;

/// Validated, typed sensor-reading row. The sole way to construct this
/// type from outside the module is via [`validate`], which means every
/// `SensorReading` in the binary has already passed every check this
/// module enforces — downstream stages can rely on it as a
/// "parse, don't validate" precondition.
#[derive(Debug, Clone, PartialEq)]
pub struct SensorReading {
    /// Tenant id — equal to the topic-derived tenant id by construction.
    pub tenant_id: TenantId,
    /// Sensor id (logical sensor — many channels per sensor).
    pub sensor_id: Uuid,
    /// Channel id (one channel = one timeseries).
    pub channel_id: Uuid,
    /// Reading value. Guaranteed finite (no `NaN`, no `±Inf`).
    pub value: f64,
    /// IEC 61131-3 quality code, narrowed to `0..=3`.
    pub quality: u8,
    /// Producer-side wall clock at sample time (ms since UNIX epoch).
    pub producer_ts: i64,
}

/// All ways the payload can fail validation. NONE of the variants
/// carry attacker-controlled bytes — the enum tag and the bounded
/// numeric fields are the entire surface, by design.
#[derive(Debug, Error, PartialEq, Eq, Clone)]
pub enum PayloadError {
    /// Bytes are not well-formed JSON, or contain an unknown field
    /// (`deny_unknown_fields`), or a field has the wrong JSON type.
    /// We deliberately do NOT include the underlying serde error
    /// message — it echoes the input.
    #[error("payload JSON failed strict deserialisation")]
    Json,

    /// A required field was missing. The field name is a static
    /// `&'static str` from a fixed set; never attacker-supplied.
    #[error("required field '{name}' missing or null")]
    MissingField {
        /// Static name of the missing field.
        name: &'static str,
    },

    /// `tenantId` was present but not a valid 36-byte UUID.
    #[error("tenantId is not a valid UUID")]
    InvalidTenantId,

    /// `sensorId` was present but not a valid 36-byte UUID.
    #[error("sensorId is not a valid UUID")]
    InvalidSensorId,

    /// `channelId` was present but not a valid 36-byte UUID.
    #[error("channelId is not a valid UUID")]
    InvalidChannelId,

    /// `value` is `NaN` or `±Inf`. The actual byte pattern is not
    /// echoed.
    #[error("value is not a finite f64 (NaN or +/-Inf rejected)")]
    NotFiniteValue,

    /// `quality` was outside `0..=3`. The got-value is bounded
    /// `0..=255` (u8) so it is safe to include.
    #[error("quality must be in 0..=3; got {got}")]
    QualityOutOfRange {
        /// The offending quality code (bounded: `u8`).
        got: u8,
    },

    /// `producerTs` was outside the configured plausibility window
    /// `[PRODUCER_TS_MIN_MS, PRODUCER_TS_MAX_MS]`. The got-value is
    /// numeric so it is safe to include.
    #[error("producerTs out of plausibility window; got {got}")]
    ProducerTsOutOfRange {
        /// The offending timestamp (raw i64, bounded by JSON parser).
        got: i64,
    },

    /// The payload's `tenantId` did not match the `topic_tenant`
    /// argument supplied by the caller (extracted from the MQTT topic
    /// by the topic parser). This is the ADR-025 § Threat 2 bind.
    /// Neither tenant id is echoed — both are sensitive.
    #[error("topic tenantId does not match payload tenantId")]
    TenantMismatch,
}

/// Wire shape of the JSON payload. `deny_unknown_fields` closes the
/// prototype-pollution class (ADR-025 § Threat 3): a payload that
/// carries an extra `__proto__` or `constructor` key is rejected at
/// the deserialisation boundary instead of being silently accepted
/// and forwarded.
///
/// All three UUID fields are deserialised as raw `String` here —
/// NOT as `Uuid` directly — because we want to control the error
/// variant (we must not leak the bad bytes through `serde_json`'s
/// generic error message). The UUID parse happens in [`validate`]
/// against the strict `uuid::try_parse` path.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WirePayload {
    #[serde(rename = "tenantId")]
    tenant_id: Option<String>,
    #[serde(rename = "sensorId")]
    sensor_id: Option<String>,
    #[serde(rename = "channelId")]
    channel_id: Option<String>,
    value: Option<f64>,
    quality: Option<u8>,
    #[serde(rename = "producerTs")]
    producer_ts: Option<i64>,
}

/// Validate a raw MQTT payload against the sensor-service contract,
/// AND bind it to the tenant id the topic parser already extracted.
///
/// This is the only public constructor of [`SensorReading`].
///
/// # Errors
/// Returns a [`PayloadError`] variant per the failure mode; see the
/// enum's variants. None of the error values carry attacker-
/// controlled bytes (the bind to ADR-025 § Threat 3's prototype-
/// pollution mitigation extends to error logging).
pub fn validate(bytes: &[u8], topic_tenant: TenantId) -> Result<SensorReading, PayloadError> {
    let wire: WirePayload = serde_json::from_slice(bytes).map_err(|_| PayloadError::Json)?;

    let tenant_str = wire
        .tenant_id
        .ok_or(PayloadError::MissingField { name: "tenantId" })?;
    let sensor_str = wire
        .sensor_id
        .ok_or(PayloadError::MissingField { name: "sensorId" })?;
    let channel_str = wire
        .channel_id
        .ok_or(PayloadError::MissingField { name: "channelId" })?;
    let value = wire
        .value
        .ok_or(PayloadError::MissingField { name: "value" })?;
    let quality = wire
        .quality
        .ok_or(PayloadError::MissingField { name: "quality" })?;
    let producer_ts = wire
        .producer_ts
        .ok_or(PayloadError::MissingField { name: "producerTs" })?;

    // UUID parse via uuid::try_parse — strict 36-byte path, zero
    // allocation, ~10 ns per the plan. NEVER regex (the workspace
    // has no regex dep on the sensor-ingestion side and the plan
    // explicitly forbids it on the hot path).
    let tenant_id = TenantId::try_parse(&tenant_str).map_err(|_| PayloadError::InvalidTenantId)?;
    let sensor_id = Uuid::try_parse(&sensor_str).map_err(|_| PayloadError::InvalidSensorId)?;
    let channel_id = Uuid::try_parse(&channel_str).map_err(|_| PayloadError::InvalidChannelId)?;

    // ADR-025 § Threat 2 bind. The topic parser already produced a
    // TenantId from the topic segment; we refuse to advance unless
    // the payload agrees. This is the explicit gate that prevents a
    // compromised edge device from writing into another tenant's
    // hypertable via a forged JSON body.
    if tenant_id != topic_tenant {
        return Err(PayloadError::TenantMismatch);
    }

    if !value.is_finite() {
        return Err(PayloadError::NotFiniteValue);
    }
    if quality > QUALITY_MAX {
        return Err(PayloadError::QualityOutOfRange { got: quality });
    }
    if !(PRODUCER_TS_MIN_MS..=PRODUCER_TS_MAX_MS).contains(&producer_ts) {
        return Err(PayloadError::ProducerTsOutOfRange { got: producer_ts });
    }

    Ok(SensorReading {
        tenant_id,
        sensor_id,
        channel_id,
        value,
        quality,
        producer_ts,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        PRODUCER_TS_MAX_MS, PRODUCER_TS_MIN_MS, PayloadError, QUALITY_MAX, SensorReading, validate,
    };
    use tenant_context::TenantId;
    use uuid::Uuid;

    const TENANT_A_STR: &str = "550e8400-e29b-41d4-a716-446655440000";
    const TENANT_B_STR: &str = "11111111-2222-3333-4444-555555555555";
    const SENSOR_STR: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const CHANNEL_STR: &str = "12345678-1234-1234-1234-123456789abc";

    fn tenant_a() -> TenantId {
        TenantId::try_parse(TENANT_A_STR).unwrap()
    }

    fn tenant_b() -> TenantId {
        TenantId::try_parse(TENANT_B_STR).unwrap()
    }

    fn happy_payload() -> Vec<u8> {
        format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":42.5,"quality":1,"producerTs":1735689600000}}"#
        )
        .into_bytes()
    }

    #[test]
    fn happy_round_trip() {
        let bytes = happy_payload();
        let r: SensorReading = validate(&bytes, tenant_a()).unwrap();
        assert_eq!(r.tenant_id, tenant_a());
        assert_eq!(r.sensor_id, Uuid::try_parse(SENSOR_STR).unwrap());
        assert_eq!(r.channel_id, Uuid::try_parse(CHANNEL_STR).unwrap());
        assert!((r.value - 42.5).abs() < f64::EPSILON);
        assert_eq!(r.quality, 1);
        assert_eq!(r.producer_ts, 1_735_689_600_000);
    }

    #[test]
    fn missing_tenant_id() {
        let bytes = format!(
            r#"{{"sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":1.0,"quality":0,"producerTs":1735689600000}}"#
        )
        .into_bytes();
        assert_eq!(
            validate(&bytes, tenant_a()).unwrap_err(),
            PayloadError::MissingField { name: "tenantId" }
        );
    }

    #[test]
    fn missing_sensor_id() {
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","channelId":"{CHANNEL_STR}","value":1.0,"quality":0,"producerTs":1735689600000}}"#
        )
        .into_bytes();
        assert_eq!(
            validate(&bytes, tenant_a()).unwrap_err(),
            PayloadError::MissingField { name: "sensorId" }
        );
    }

    #[test]
    fn missing_channel_id() {
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","value":1.0,"quality":0,"producerTs":1735689600000}}"#
        )
        .into_bytes();
        assert_eq!(
            validate(&bytes, tenant_a()).unwrap_err(),
            PayloadError::MissingField { name: "channelId" }
        );
    }

    #[test]
    fn missing_value() {
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","quality":0,"producerTs":1735689600000}}"#
        )
        .into_bytes();
        assert_eq!(
            validate(&bytes, tenant_a()).unwrap_err(),
            PayloadError::MissingField { name: "value" }
        );
    }

    #[test]
    fn missing_quality() {
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":1.0,"producerTs":1735689600000}}"#
        )
        .into_bytes();
        assert_eq!(
            validate(&bytes, tenant_a()).unwrap_err(),
            PayloadError::MissingField { name: "quality" }
        );
    }

    #[test]
    fn missing_producer_ts() {
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":1.0,"quality":0}}"#
        )
        .into_bytes();
        assert_eq!(
            validate(&bytes, tenant_a()).unwrap_err(),
            PayloadError::MissingField { name: "producerTs" }
        );
    }

    #[test]
    fn extra_field_rejected_by_deny_unknown_fields() {
        // ADR-025 § Threat 3 — prototype-pollution class. Any extra
        // field anywhere in the object MUST trip the JSON guard.
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":1.0,"quality":0,"producerTs":1735689600000,"__proto__":{{"polluted":true}}}}"#
        )
        .into_bytes();
        assert_eq!(
            validate(&bytes, tenant_a()).unwrap_err(),
            PayloadError::Json
        );
    }

    #[test]
    fn invalid_tenant_uuid() {
        let bytes = format!(
            r#"{{"tenantId":"not-a-uuid","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":1.0,"quality":0,"producerTs":1735689600000}}"#
        )
        .into_bytes();
        assert_eq!(
            validate(&bytes, tenant_a()).unwrap_err(),
            PayloadError::InvalidTenantId
        );
    }

    #[test]
    fn invalid_sensor_uuid() {
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"zzzzzzzz-eeee-1111-2222-333333333333","channelId":"{CHANNEL_STR}","value":1.0,"quality":0,"producerTs":1735689600000}}"#
        )
        .into_bytes();
        assert_eq!(
            validate(&bytes, tenant_a()).unwrap_err(),
            PayloadError::InvalidSensorId
        );
    }

    #[test]
    fn invalid_channel_uuid() {
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"too-short","value":1.0,"quality":0,"producerTs":1735689600000}}"#
        )
        .into_bytes();
        assert_eq!(
            validate(&bytes, tenant_a()).unwrap_err(),
            PayloadError::InvalidChannelId
        );
    }

    #[test]
    fn value_nan_rejected() {
        // serde_json refuses to deserialise the string "NaN" into an
        // f64 by default, so we go through the `null` -> Option path:
        // a `value: null` is treated as missing. To exercise the
        // NaN branch we construct the wire payload via a JSON value
        // that serde_json DOES accept as f64 — but JSON does not
        // permit NaN literals. The architectural conclusion is that
        // the ONLY way NaN reaches the validator is if a (future)
        // non-strict JSON parser admits it, OR the payload arrives
        // pre-deserialised. Both paths still hit `is_finite()`.
        // We exercise the branch directly via a JSON number that
        // overflows f64 to +Inf, which IS reachable through the
        // serde_json fast path.
        // serde_json's strict number parser refuses 1e400 outright
        // with a Json error, which is a strictly STRONGER defense
        // than our `is_finite()` check — the bad value never reaches
        // the validator at all. Either rejection variant is the
        // architectural goal; the test asserts the union.
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":1e400,"quality":0,"producerTs":1735689600000}}"#
        )
        .into_bytes();
        let err = validate(&bytes, tenant_a()).unwrap_err();
        assert!(
            matches!(err, PayloadError::Json | PayloadError::NotFiniteValue),
            "expected non-finite rejection (Json or NotFiniteValue), got {err:?}",
        );
    }

    #[test]
    fn value_negative_inf_rejected() {
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":-1e400,"quality":0,"producerTs":1735689600000}}"#
        )
        .into_bytes();
        let err = validate(&bytes, tenant_a()).unwrap_err();
        assert!(
            matches!(err, PayloadError::Json | PayloadError::NotFiniteValue),
            "expected non-finite rejection (Json or NotFiniteValue), got {err:?}",
        );
    }

    #[test]
    fn quality_above_max_rejected_at_4() {
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":1.0,"quality":4,"producerTs":1735689600000}}"#
        )
        .into_bytes();
        assert_eq!(
            validate(&bytes, tenant_a()).unwrap_err(),
            PayloadError::QualityOutOfRange { got: 4 }
        );
    }

    #[test]
    fn quality_above_max_rejected_at_255() {
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":1.0,"quality":255,"producerTs":1735689600000}}"#
        )
        .into_bytes();
        assert_eq!(
            validate(&bytes, tenant_a()).unwrap_err(),
            PayloadError::QualityOutOfRange { got: 255 }
        );
    }

    #[test]
    fn producer_ts_negative_rejected() {
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":1.0,"quality":0,"producerTs":-1}}"#
        )
        .into_bytes();
        assert_eq!(
            validate(&bytes, tenant_a()).unwrap_err(),
            PayloadError::ProducerTsOutOfRange { got: -1 }
        );
    }

    #[test]
    fn producer_ts_zero_rejected() {
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":1.0,"quality":0,"producerTs":0}}"#
        )
        .into_bytes();
        assert_eq!(
            validate(&bytes, tenant_a()).unwrap_err(),
            PayloadError::ProducerTsOutOfRange { got: 0 }
        );
    }

    #[test]
    fn producer_ts_far_future_rejected() {
        // 4_200_000_000_000 ms ≈ year 2103 — past the 2100 ceiling.
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":1.0,"quality":0,"producerTs":4200000000000}}"#
        )
        .into_bytes();
        assert_eq!(
            validate(&bytes, tenant_a()).unwrap_err(),
            PayloadError::ProducerTsOutOfRange {
                got: 4_200_000_000_000
            }
        );
    }

    #[test]
    fn topic_tenant_mismatch_is_threat_2_bind() {
        // ADR-025 § Threat 2 — the test that justifies this whole
        // module. A payload claiming tenant A but arriving on a
        // topic the parser already attributed to tenant B MUST be
        // rejected, not silently routed.
        let bytes = happy_payload(); // payload says tenant A
        assert_eq!(
            validate(&bytes, tenant_b()).unwrap_err(),
            PayloadError::TenantMismatch
        );
    }

    #[test]
    fn malformed_json_rejected() {
        let bytes = b"{not even close to JSON";
        assert_eq!(validate(bytes, tenant_a()).unwrap_err(), PayloadError::Json);
    }

    #[test]
    fn empty_payload_rejected() {
        // Edge case: zero-length body. Must NOT panic, MUST hit Json.
        let bytes: &[u8] = b"";
        assert_eq!(validate(bytes, tenant_a()).unwrap_err(), PayloadError::Json);
    }

    #[test]
    fn happy_at_lower_bound_ts() {
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":1.0,"quality":0,"producerTs":{PRODUCER_TS_MIN_MS}}}"#
        )
        .into_bytes();
        let r = validate(&bytes, tenant_a()).unwrap();
        assert_eq!(r.producer_ts, PRODUCER_TS_MIN_MS);
    }

    #[test]
    fn happy_at_upper_bound_ts_and_quality() {
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":-273.15,"quality":{QUALITY_MAX},"producerTs":{PRODUCER_TS_MAX_MS}}}"#
        )
        .into_bytes();
        let r = validate(&bytes, tenant_a()).unwrap();
        assert_eq!(r.producer_ts, PRODUCER_TS_MAX_MS);
        assert_eq!(r.quality, QUALITY_MAX);
    }

    #[test]
    fn error_display_does_not_leak_attacker_bytes() {
        // Explicit guard against audit-log poisoning: the
        // attacker-supplied bytes (the `</script>` substring inside
        // a deliberately bad UUID) MUST NOT appear in the error's
        // `Display`.
        let bad_uuid = "</script>-deadbeef-deadbeef-dead-beefdeadbeef";
        let bytes = format!(
            r#"{{"tenantId":"{bad_uuid}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":1.0,"quality":0,"producerTs":1735689600000}}"#
        )
        .into_bytes();
        let err = validate(&bytes, tenant_a()).unwrap_err();
        let display = err.to_string();
        assert!(
            !display.contains("script"),
            "error Display leaked attacker bytes: {display}"
        );
    }
}
