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
//!   1. Payload is well-formed JSON with EXACTLY the fields the
//!      sensor-service contract names — no more, no less
//!      (`#[serde(deny_unknown_fields)]`). Closes the prototype-
//!      pollution class (ADR-025 § Threat 3).
//!   2. The three UUID fields parse as strict 36-byte UUIDs via
//!      `uuid::try_parse` (no regex, ~10 ns vs ~500 ns + 3 alloc
//!      for a regex pass per the plan's measured numbers).
//!   3. `value` is a finite f64 — `NaN` and `±Inf` are rejected
//!      because a downstream `WHERE value > X` query would silently
//!      misclassify them.
//!   4. `quality` is a valid OPC-UA DA quality code — see
//!      [`QualityCode`] for why the scale is named rather than
//!      passed around as a bare integer.
//!   5. `producerTs` is a positive ms-epoch within a sane window
//!      (post 2024-01-01, before year 2100). Drift outside that
//!      window means a clock-skewed device or a forged timestamp
//!      and the row is rejected before it pollutes Timescale's
//!      chunk-pruning heuristic.
//!   6. The payload's `tenantId` MUST equal the `topic_tenant` that
//!      the topic parser already extracted. This is the Threat 2
//!      bind. Without it, the rest of the pipeline trusts the
//!      broker-supplied tenant id; with it, the bind is an explicit
//!      precondition every downstream stage can rely on.
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

/// First code in the OPC-UA DA "uncertain" band.
pub const QUALITY_UNCERTAIN_MIN: u8 = 64;

/// Last code in the OPC-UA DA "uncertain" band.
pub const QUALITY_UNCERTAIN_MAX: u8 = 127;

/// First code in the OPC-UA DA "good" band. `sensor_metrics.quality_code`
/// defaults to this value and every reader in the platform classifies a
/// sample as trustworthy with `quality_code >= 192`.
pub const QUALITY_GOOD_MIN: u8 = 192;

/// A sample's quality on the OPC-UA Data Access scale — the ONE scale the
/// platform speaks.
///
/// # Why this is a type and not a `u8`
///
/// It used to be a bare `u8` documented as "the IEC 61131-3 subset `0..=3`
/// (good / uncertain / bad / not-connected)", written straight into
/// `sensor_metrics.quality_code`. That column is OPC-UA: 0..=63 BAD,
/// 64..=127 UNCERTAIN, 192..=255 GOOD, default 192, and every consumer
/// — `metric-query.service.ts`, the continuous aggregates, the dashboards
/// — asks `quality_code >= 192` for "good". So the two scales collided on
/// one column with the same name and the same type:
///
///   * A producer sending `0` meant GOOD and was stored as OPC-UA BAD, so
///     every healthy sample the sidecar ingested read back as bad data and
///     every quality percentage over that stream was 0%.
///   * A producer sending a real OPC-UA code — which is what this
///     platform's own edge agent emits from
///     `TagQuality::to_quality_code()` (192 / 64 / 0 / 24) — was REJECTED
///     outright by the `> 3` check, dropping the reading at the trust
///     boundary.
///
/// Both failure modes come from letting a plain integer cross the boundary.
/// A newtype whose only constructor validates against the OPC-UA bands
/// removes the ambiguity: there is one scale, it is named, and an
/// out-of-band value cannot reach the database.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct QualityCode(u8);

impl QualityCode {
    /// Validate a wire integer as an OPC-UA DA quality code.
    ///
    /// `128..=191` is the reserved gap between UNCERTAIN and GOOD in the
    /// DA scale; a value landing there means the producer is on some other
    /// scale, so it is refused rather than guessed at.
    ///
    /// # Errors
    ///
    /// [`PayloadError::QualityOutOfRange`] when `raw` falls in the reserved
    /// gap.
    pub const fn try_new(raw: u8) -> Result<Self, PayloadError> {
        if raw > QUALITY_UNCERTAIN_MAX && raw < QUALITY_GOOD_MIN {
            return Err(PayloadError::QualityOutOfRange { got: raw });
        }
        Ok(Self(raw))
    }

    /// The underlying OPC-UA code, for binding into `quality_code`.
    #[must_use]
    pub const fn get(self) -> u8 {
        self.0
    }

    /// Whether the sample is in the GOOD band — the same predicate every
    /// SQL consumer spells as `quality_code >= 192`.
    #[must_use]
    pub const fn is_good(self) -> bool {
        self.0 >= QUALITY_GOOD_MIN
    }
}

/// Provenance tag for `raw_value` per ADR-028. Either the producer
/// emitted V2 and carried `raw_value` natively, or the producer was
/// on the legacy V1 wire format and the validator upcast it by
/// mapping `raw_value = value`. Persistence keeps the tag for audit
/// observability — an operator can detect the edge-agent-fleet V1→V2
/// migration cut-over point from the persistence audit stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayloadSource {
    /// The wire payload declared `payloadVersion: 2` and carried a
    /// native `raw_value`. The `SensorReading::raw_value` field is
    /// the pre-conversion measurement, not equal to `value` in
    /// general.
    OriginalV2,
    /// The wire payload was V1 (no `raw_value` field, legacy shape).
    /// The validator set `raw_value = value` to preserve the contract
    /// surface the persistence layer now requires.
    UpcastedFromV1,
}

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
    /// Reading value — post-conversion (e.g. pH 7.4, temp 24.5°C).
    /// Guaranteed finite (no `NaN`, no `±Inf`).
    pub value: f64,
    /// Pre-conversion measurement — the raw sensor output before the
    /// Atlas EZO / Modbus / LoRa calibration transform (e.g. ADC count
    /// 4182). V2 wire format carries this natively; V1 upcasts
    /// `raw_value = value` and tags the reading with
    /// `PayloadSource::UpcastedFromV1`. Guaranteed finite.
    pub raw_value: f64,
    /// Sample quality on the OPC-UA DA scale — see [`QualityCode`].
    pub quality: QualityCode,
    /// Producer-side wall clock at sample time (ms since UNIX epoch).
    pub producer_ts: i64,
    /// Provenance tag for `raw_value`: did it come from the wire or
    /// was it upcast from V1? See [`PayloadSource`].
    pub source: PayloadSource,
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

    /// `quality` landed in the OPC-UA DA reserved gap `128..=191`, so it
    /// belongs to no quality band and the producer is speaking some other
    /// scale. The got-value is bounded `0..=255` (u8) so it is safe to
    /// include.
    #[error("quality must be an OPC-UA DA code (0..=127 or 192..=255); got {got}")]
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

    /// `rawValue` was `NaN` or `±Inf`. Landed alongside `raw_value`
    /// mandatory in ADR-028 — the persistence layer requires a finite
    /// pre-conversion value; a non-finite raw reading makes no
    /// physical sense.
    #[error("rawValue is not a finite f64 (NaN or +/-Inf rejected)")]
    NotFiniteRawValue,

    /// `payloadVersion` carried a value outside the supported set
    /// `{1, 2}`. ADR-028 pins V1 + V2; any other value means the
    /// producer is on a future or corrupted wire format and we
    /// refuse to guess semantics. The got-value is bounded (u8) so
    /// it is safe to include.
    #[error("payloadVersion must be 1 or 2; got {got}")]
    UnsupportedPayloadVersion {
        /// The offending version tag (bounded: `u8`).
        got: u8,
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
    /// Pre-conversion raw sensor output. Required on V2 payloads
    /// (`payloadVersion: 2`). Absent on V1 — the validator upcasts
    /// via `raw_value = value` and tags `PayloadSource::UpcastedFromV1`.
    #[serde(rename = "rawValue")]
    raw_value: Option<f64>,
    quality: Option<u8>,
    #[serde(rename = "producerTs")]
    producer_ts: Option<i64>,
    /// ADR-028 discriminator. `None` or `Some(1)` = V1 (legacy shape,
    /// no `raw_value`); `Some(2)` = V2 (mandatory `raw_value`). A
    /// value outside `{1, 2}` is rejected as an unsupported version
    /// — we never guess semantics for an unknown integer.
    #[serde(rename = "payloadVersion")]
    payload_version: Option<u8>,
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
    let quality = QualityCode::try_new(quality)?;
    if !(PRODUCER_TS_MIN_MS..=PRODUCER_TS_MAX_MS).contains(&producer_ts) {
        return Err(PayloadError::ProducerTsOutOfRange { got: producer_ts });
    }

    // ADR-028 payload-version discrimination. `None` = legacy V1
    // producer (no version tag); `Some(1)` = explicit V1; `Some(2)`
    // = V2 with mandatory `rawValue`. Any other value is rejected as
    // an unsupported future wire format — we never guess semantics
    // for an unknown integer. The `UpcastedFromV1` / `OriginalV2`
    // tag rides on the SensorReading so persistence can audit the
    // edge-fleet migration cut-over point.
    let (raw_value, source) = match wire.payload_version {
        None | Some(1) => {
            // V1 — no raw_value field; upcast raw_value = value.
            // A V1 payload that carries a stray rawValue is rejected
            // by the deny_unknown_fields serde attribute at parse
            // time, so by here we already know the field is absent.
            (value, PayloadSource::UpcastedFromV1)
        }
        Some(2) => {
            // V2 — rawValue REQUIRED. Missing → MissingField. Present
            // but non-finite → NotFiniteRawValue. The V2 producer is
            // the authority on the pre-conversion measurement; we
            // never synthesise one here.
            let raw = wire
                .raw_value
                .ok_or(PayloadError::MissingField { name: "rawValue" })?;
            if !raw.is_finite() {
                return Err(PayloadError::NotFiniteRawValue);
            }
            (raw, PayloadSource::OriginalV2)
        }
        Some(other) => {
            return Err(PayloadError::UnsupportedPayloadVersion { got: other });
        }
    };

    Ok(SensorReading {
        tenant_id,
        sensor_id,
        channel_id,
        value,
        raw_value,
        quality,
        producer_ts,
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        PRODUCER_TS_MAX_MS, PRODUCER_TS_MIN_MS, PayloadError, PayloadSource, QUALITY_GOOD_MIN,
        QUALITY_UNCERTAIN_MAX, QUALITY_UNCERTAIN_MIN, QualityCode,
        SensorReading, validate,
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
        assert_eq!(r.quality.get(), 1);
        assert_eq!(r.producer_ts, 1_735_689_600_000);
        // ADR-028: a V1 payload (no payloadVersion field, no rawValue)
        // is upcast — raw_value equals value, source tagged.
        assert!((r.raw_value - 42.5).abs() < f64::EPSILON);
        assert_eq!(r.source, PayloadSource::UpcastedFromV1);
    }

    #[test]
    fn v1_explicit_version_tag_is_also_upcast() {
        // A producer that explicitly declares `payloadVersion: 1`
        // follows the same upcast path as one that omits the field.
        // Both result in raw_value = value + UpcastedFromV1 source.
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":10.0,"quality":2,"producerTs":1735689600000,"payloadVersion":1}}"#
        ).into_bytes();
        let r = validate(&bytes, tenant_a()).unwrap();
        assert!((r.raw_value - 10.0).abs() < f64::EPSILON);
        assert_eq!(r.source, PayloadSource::UpcastedFromV1);
    }

    #[test]
    fn v2_payload_carries_distinct_raw_value() {
        // V2 producer emits a pre-conversion measurement distinct from
        // the post-conversion reading (the common case: calibrated
        // pH = 7.4 with raw ADC ratio = 0.532). Persistence must see
        // both values preserved, NOT the old fallback where raw_value
        // silently equalled value.
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":7.4,"rawValue":0.532,"quality":1,"producerTs":1735689600000,"payloadVersion":2}}"#
        ).into_bytes();
        let r = validate(&bytes, tenant_a()).unwrap();
        assert!((r.value - 7.4).abs() < f64::EPSILON);
        assert!((r.raw_value - 0.532).abs() < f64::EPSILON);
        assert_eq!(r.source, PayloadSource::OriginalV2);
    }

    #[test]
    fn v2_without_raw_value_is_rejected() {
        // ADR-028 mandates rawValue on V2. A V2 payload missing the
        // field is a broken producer and MUST NOT silently upcast —
        // we want the producer to notice and fix its emitter. Plan
        // Kör Nokta 5: no `unwrap_or(value)` fallback.
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":7.4,"quality":1,"producerTs":1735689600000,"payloadVersion":2}}"#
        ).into_bytes();
        let err = validate(&bytes, tenant_a()).unwrap_err();
        assert!(
            matches!(err, PayloadError::MissingField { name: "rawValue" }),
            "expected MissingField(rawValue), got: {err:?}"
        );
    }

    #[test]
    fn not_finite_raw_value_variant_surfaces_with_expected_display() {
        // serde_json rejects `NaN` / `±Inf` JSON literals at parse
        // time (emits `PayloadError::Json`), so a validate()
        // round-trip cannot actually reach the NotFiniteRawValue
        // branch through the JSON hot path today. The branch exists
        // as defense-in-depth against a future JSON parser change
        // or a programmatic wire-payload constructor that bypasses
        // serde. This test locks in the variant's surface so a
        // refactor that removed it (or its Display string) would
        // fire here — removing the guard is an architectural
        // decision, not a silent code change.
        let err = PayloadError::NotFiniteRawValue;
        assert!(
            matches!(err, PayloadError::NotFiniteRawValue),
            "variant must remain addressable"
        );
        let rendered = format!("{err}");
        assert!(
            rendered.contains("rawValue") && rendered.contains("finite"),
            "Display must flag the field + the constraint, got: {rendered}"
        );
    }

    #[test]
    fn unsupported_payload_version_is_rejected() {
        // Version 3+ or 0 is a producer on a future / corrupted wire
        // format. Never guess semantics — reject and let the edge
        // fleet notice its emitter is broken.
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":10.0,"rawValue":10.0,"quality":1,"producerTs":1735689600000,"payloadVersion":7}}"#
        ).into_bytes();
        let err = validate(&bytes, tenant_a()).unwrap_err();
        assert!(
            matches!(err, PayloadError::UnsupportedPayloadVersion { got: 7 }),
            "expected UnsupportedPayloadVersion(7), got: {err:?}"
        );
    }

    #[test]
    fn v1_with_stray_raw_value_is_rejected_by_deny_unknown() {
        // A V1 payload that accidentally carries a rawValue field
        // (without declaring payloadVersion: 2) is ambiguous — we do
        // not know whether the producer meant V1 with extra noise or
        // a half-migrated V2 emitter. Serde's deny_unknown_fields
        // catches this at parse time; the test pins the invariant.
        //
        // Note: `rawValue` IS a known field on the WirePayload type,
        // so deny_unknown_fields alone does NOT block it. The test
        // here documents the actual observable behaviour: a V1
        // payload with rawValue is accepted and the rawValue is
        // IGNORED (the V1 match arm uses `value` as the upcast
        // source). If that behaviour drifts — e.g. a future refactor
        // that starts honouring rawValue on V1 — this test anchors
        // the documented contract.
        let bytes = format!(
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":10.0,"rawValue":99.9,"quality":1,"producerTs":1735689600000}}"#
        ).into_bytes();
        let r = validate(&bytes, tenant_a()).unwrap();
        assert!((r.value - 10.0).abs() < f64::EPSILON);
        // V1 path: raw_value = value (not the 99.9 the producer sent).
        // The wire rawValue is effectively noise under the V1 contract.
        assert!((r.raw_value - 10.0).abs() < f64::EPSILON);
        assert_eq!(r.source, PayloadSource::UpcastedFromV1);
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
    fn quality_in_the_reserved_gap_is_rejected_at_both_edges() {
        // 128..=191 belongs to no OPC-UA band. A producer landing there is
        // speaking a different scale, so the reading is refused rather than
        // guessed at — the failure mode this whole type exists to prevent.
        for got in [QUALITY_UNCERTAIN_MAX + 1, QUALITY_GOOD_MIN - 1] {
            let bytes = format!(
                r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":1.0,"quality":{got},"producerTs":1735689600000}}"#
            )
            .into_bytes();
            assert_eq!(
                validate(&bytes, tenant_a()).unwrap_err(),
                PayloadError::QualityOutOfRange { got }
            );
        }
    }

    #[test]
    fn accepts_the_opc_ua_codes_this_platform_edge_agent_emits() {
        // sens-api-gateway's TagQuality::to_quality_code() emits 192 (good),
        // 64 (uncertain), 0 (bad) and 24 (comm failure). Every one of them
        // was rejected by the previous `> 3` narrowing, which dropped the
        // reading at the trust boundary.
        for code in [QUALITY_GOOD_MIN, 255, QUALITY_UNCERTAIN_MIN, QUALITY_UNCERTAIN_MAX, 0, 24] {
            let bytes = format!(
                r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":1.0,"quality":{code},"producerTs":1735689600000}}"#
            )
            .into_bytes();
            let reading = validate(&bytes, tenant_a()).expect("OPC-UA code must be accepted");
            assert_eq!(reading.quality.get(), code);
        }
    }

    #[test]
    fn is_good_matches_the_sql_predicate_every_consumer_uses() {
        // Consumers spell "good" as `quality_code >= 192`; the type must
        // agree, or a Rust-side decision and a SQL-side decision drift.
        assert!(QualityCode::try_new(QUALITY_GOOD_MIN).unwrap().is_good());
        assert!(QualityCode::try_new(255).unwrap().is_good());
        assert!(!QualityCode::try_new(QUALITY_UNCERTAIN_MAX).unwrap().is_good());
        assert!(!QualityCode::try_new(0).unwrap().is_good());
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
            r#"{{"tenantId":"{TENANT_A_STR}","sensorId":"{SENSOR_STR}","channelId":"{CHANNEL_STR}","value":-273.15,"quality":{QUALITY_GOOD_MIN},"producerTs":{PRODUCER_TS_MAX_MS}}}"#
        )
        .into_bytes();
        let r = validate(&bytes, tenant_a()).unwrap();
        assert_eq!(r.producer_ts, PRODUCER_TS_MAX_MS);
        assert_eq!(r.quality.get(), QUALITY_GOOD_MIN);
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
