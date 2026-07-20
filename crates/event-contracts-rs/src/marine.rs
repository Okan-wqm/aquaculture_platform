//! Marine Explorer worker event contracts.
//!
//! The Farm service publishes [`MarineAnalysisRequestedEvent`] through
//! its transactional outbox on
//! `events.{tenantId}.MarineAnalysisRequested`. This module mirrors the
//! TypeScript trust-boundary contract without carrying AOI geometry or
//! provider credentials; the worker claims those inputs through the
//! separately authorized request-reply channel after accepting a job.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;
use uuid::Uuid;

use crate::EventId;

fn is_canonical_marine_timestamp(value: &str) -> bool {
    if value.len() != 24 {
        return false;
    }
    let shape_is_valid = value.bytes().enumerate().all(|(index, byte)| match index {
        4 | 7 => byte == b'-',
        10 => byte == b'T',
        13 | 16 => byte == b':',
        19 => byte == b'.',
        23 => byte == b'Z',
        _ => byte.is_ascii_digit(),
    });
    shape_is_valid
        && timestamp_component(value, 5, 7).is_some_and(|month| (1..=12).contains(&month))
        && timestamp_component(value, 8, 10).is_some_and(|day| (1..=31).contains(&day))
        && timestamp_component(value, 11, 13).is_some_and(|hour| hour <= 23)
        && timestamp_component(value, 14, 16).is_some_and(|minute| minute <= 59)
        && timestamp_component(value, 17, 19).is_some_and(|second| second <= 59)
}

fn timestamp_component(value: &str, start: usize, end: usize) -> Option<u8> {
    value.get(start..end)?.parse().ok()
}

/// Deserialize the exact UTC-millisecond timestamp used by Marine wires.
pub fn deserialize_marine_timestamp<'de, D>(deserializer: D) -> Result<DateTime<Utc>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if !is_canonical_marine_timestamp(&value) {
        return Err(serde::de::Error::custom(
            "marine timestamp must use YYYY-MM-DDTHH:mm:ss.sssZ",
        ));
    }
    DateTime::parse_from_rfc3339(&value)
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .map_err(serde::de::Error::custom)
}

/// Serialize a Marine timestamp in exact UTC-millisecond wire form.
pub fn serialize_marine_timestamp<S>(
    value: &DateTime<Utc>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    let value = value.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    if !is_canonical_marine_timestamp(&value) {
        return Err(serde::ser::Error::custom(
            "marine timestamp is outside the canonical four-digit UTC year range",
        ));
    }
    serializer.serialize_str(&value)
}

/// Deserialize a required nullable Marine UTC-millisecond timestamp.
pub fn deserialize_optional_marine_timestamp<'de, D>(
    deserializer: D,
) -> Result<Option<DateTime<Utc>>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    value
        .map(|value| {
            if !is_canonical_marine_timestamp(&value) {
                return Err(serde::de::Error::custom(
                    "marine timestamp must use YYYY-MM-DDTHH:mm:ss.sssZ",
                ));
            }
            DateTime::parse_from_rfc3339(&value)
                .map(|timestamp| timestamp.with_timezone(&Utc))
                .map_err(serde::de::Error::custom)
        })
        .transpose()
}

#[allow(clippy::ref_option)]
/// Serialize a required nullable Marine UTC-millisecond timestamp.
pub fn serialize_optional_marine_timestamp<S>(
    value: &Option<DateTime<Utc>>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    match value {
        Some(value) => serialize_marine_timestamp(value, serializer),
        None => serializer.serialize_none(),
    }
}

fn deserialize_canonical_event_id<'de, D>(deserializer: D) -> Result<EventId, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    crate::parse_canonical_uuid(&value).map_err(serde::de::Error::custom)?;
    EventId::try_parse(&value).map_err(serde::de::Error::custom)
}

/// Static `eventType` discriminator for
/// [`MarineAnalysisRequestedEvent`].
pub const MARINE_ANALYSIS_REQUESTED_EVENT_TYPE: &str = "MarineAnalysisRequested";

/// Zero-sized witness that pins the event discriminator on the type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarineAnalysisRequestedEventType;

impl Serialize for MarineAnalysisRequestedEventType {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(MARINE_ANALYSIS_REQUESTED_EVENT_TYPE)
    }
}

/// Zero-sized witness that pins `aggregateType` to
/// `MarineAnalysisJob`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarineAnalysisJobAggregateType;

impl Serialize for MarineAnalysisJobAggregateType {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str("MarineAnalysisJob")
    }
}

impl<'de> Deserialize<'de> for MarineAnalysisJobAggregateType {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value == "MarineAnalysisJob" {
            Ok(Self)
        } else {
            Err(serde::de::Error::invalid_value(
                serde::de::Unexpected::Str(&value),
                &"MarineAnalysisJob",
            ))
        }
    }
}

/// Zero-sized witness that pins the understood wire schema to version
/// one. A later version requires an explicit upcast before this Rust
/// type can deserialize it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarineAnalysisRequestedEventVersion;

impl Serialize for MarineAnalysisRequestedEventVersion {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u32(1)
    }
}

impl<'de> Deserialize<'de> for MarineAnalysisRequestedEventVersion {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = u32::deserialize(deserializer)?;
        if value == 1 {
            Ok(Self)
        } else {
            Err(serde::de::Error::invalid_value(
                serde::de::Unexpected::Unsigned(u64::from(value)),
                &"event schema version 1",
            ))
        }
    }
}

impl<'de> Deserialize<'de> for MarineAnalysisRequestedEventType {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value == MARINE_ANALYSIS_REQUESTED_EVENT_TYPE {
            Ok(Self)
        } else {
            Err(serde::de::Error::invalid_value(
                serde::de::Unexpected::Str(&value),
                &MARINE_ANALYSIS_REQUESTED_EVENT_TYPE,
            ))
        }
    }
}

/// Sole provider dispatched across the Marine worker boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MarineAnalysisProvider {
    /// Copernicus Marine Service accessed through the pinned official
    /// Marine Toolbox execution boundary.
    Cmems,
}

/// Analysis operation represented by the durable job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MarineAnalysisJobKind {
    /// Immutable visual snapshot and its manifest.
    Snapshot,
    /// Authoritative server-side statistics for the approved marine
    /// area.
    AoiStats,
    /// Authoritative point or area time series.
    TimeSeries,
}

/// Positive credential generation bounded by TypeScript's safe integer range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct MarineCredentialGeneration(u64);

impl MarineCredentialGeneration {
    /// Validate and construct a credential generation.
    ///
    /// # Errors
    /// Rejects zero and values above JavaScript's safe integer ceiling.
    pub const fn try_new(value: u64) -> Result<Self, &'static str> {
        if value == 0 || value > 9_007_199_254_740_991 {
            return Err("credential generation is outside the contract range");
        }
        Ok(Self(value))
    }

    /// Return the validated generation.
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for MarineCredentialGeneration {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = u64::deserialize(deserializer)?;
        Self::try_new(value).map_err(serde::de::Error::custom)
    }
}

/// Why a request fingerprint was rejected.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum RequestFingerprintError {
    /// The value is not exactly 64 ASCII characters.
    #[error("request fingerprint must contain exactly 64 lowercase hexadecimal characters")]
    InvalidLength,
    /// The value contains a byte outside lowercase hexadecimal.
    #[error("request fingerprint must contain exactly 64 lowercase hexadecimal characters")]
    InvalidCharacter,
}

/// Lowercase SHA-256 digest of the canonical job request.
///
/// The typed representation prevents retry/idempotency code from
/// accepting uppercase, truncated, or non-hex fingerprints.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RequestFingerprint(String);

impl RequestFingerprint {
    /// Validate and construct a canonical SHA-256 fingerprint.
    ///
    /// # Errors
    /// Returns [`RequestFingerprintError`] unless `value` contains
    /// exactly 64 lowercase hexadecimal characters.
    pub fn try_new(value: impl Into<String>) -> Result<Self, RequestFingerprintError> {
        let value = value.into();
        if value.len() != 64 {
            return Err(RequestFingerprintError::InvalidLength);
        }
        if !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(RequestFingerprintError::InvalidCharacter);
        }
        Ok(Self(value))
    }

    /// Borrow the canonical lowercase digest.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for RequestFingerprint {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Serialize for RequestFingerprint {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for RequestFingerprint {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::try_new(value).map_err(serde::de::Error::custom)
    }
}

/// Durable Farm outbox event that wakes the Marine analysis worker.
///
/// The event contains identifiers and immutable dispatch metadata only.
/// AOI geometry, complete job parameters, access tokens, and credentials
/// are intentionally absent. `deny_unknown_fields` rejects both nested
/// payload envelopes and producer/consumer drift at deserialization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarineAnalysisRequestedEvent {
    /// Branded event id.
    pub event_id: EventId,
    /// Discriminator, always `MarineAnalysisRequested` on the wire.
    pub event_type: MarineAnalysisRequestedEventType,
    /// Event creation timestamp in UTC.
    #[serde(serialize_with = "serialize_marine_timestamp")]
    pub timestamp: DateTime<Utc>,
    /// Tenant id used in the durable NATS subject.
    pub tenant_id: Uuid,
    /// Event schema version, always one.
    pub version: MarineAnalysisRequestedEventVersion,

    /// Aggregate root id; equal to `analysis_job_id` for events created
    /// through [`Self::new`].
    pub aggregate_id: Uuid,
    /// Aggregate type, always `MarineAnalysisJob`.
    pub aggregate_type: MarineAnalysisJobAggregateType,
    /// Distributed tracing correlation id.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub correlation_id: Option<String>,
    /// Parent command/event id.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub causation_id: Option<String>,
    /// Authenticated user that requested the analysis.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub user_id: Option<String>,
    /// Delivery retry count.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub retry_count: Option<u32>,

    /// Authoritative Farm job identifier.
    pub analysis_job_id: Uuid,
    /// Execution attempt identifier. Provider operations and credential
    /// leases are idempotent within this execution.
    pub execution_id: Uuid,
    /// Site whose approved marine area scopes the request.
    pub site_id: Uuid,
    /// Manager-approved marine area identifier.
    pub marine_area_id: Uuid,
    /// Copernicus provider used by the job.
    pub provider: MarineAnalysisProvider,
    /// Requested analysis kind.
    pub job_kind: MarineAnalysisJobKind,
    /// SHA-256 of the canonical request fields.
    pub request_fingerprint: RequestFingerprint,
    /// Credential generation that Farm expects to lease. Zero cannot be
    /// represented.
    pub credential_generation: MarineCredentialGeneration,
    /// User-visible request timestamp in UTC.
    #[serde(serialize_with = "serialize_marine_timestamp")]
    pub requested_at: DateTime<Utc>,
}

impl MarineAnalysisRequestedEvent {
    /// Construct the version-one event with generated base metadata.
    #[must_use]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        tenant_id: Uuid,
        analysis_job_id: Uuid,
        execution_id: Uuid,
        site_id: Uuid,
        marine_area_id: Uuid,
        provider: MarineAnalysisProvider,
        job_kind: MarineAnalysisJobKind,
        request_fingerprint: RequestFingerprint,
        credential_generation: MarineCredentialGeneration,
        requested_at: DateTime<Utc>,
    ) -> Self {
        Self {
            event_id: EventId::generate(),
            event_type: MarineAnalysisRequestedEventType,
            timestamp: Utc::now(),
            tenant_id,
            version: MarineAnalysisRequestedEventVersion,
            aggregate_id: analysis_job_id,
            aggregate_type: MarineAnalysisJobAggregateType,
            correlation_id: None,
            causation_id: None,
            user_id: None,
            retry_count: None,
            analysis_job_id,
            execution_id,
            site_id,
            marine_area_id,
            provider,
            job_kind,
            request_fingerprint,
            credential_generation,
            requested_at,
        }
    }

    /// Serialize the event for a NATS delivery.
    ///
    /// # Errors
    /// Propagates JSON serialization failures.
    pub fn to_json_bytes(&self) -> Result<Vec<u8>, serde_json::Error> {
        serde_json::to_vec(self)
    }

    /// Decode and validate an event received from NATS.
    ///
    /// # Errors
    /// Rejects malformed JSON, unknown fields, incorrect event types,
    /// invalid UUID/timestamp values, zero credential generations, and
    /// non-canonical fingerprints.
    pub fn from_json_bytes(bytes: &[u8]) -> Result<Self, serde_json::Error> {
        serde_json::from_slice(bytes)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarineAnalysisRequestedEventWire {
    #[serde(deserialize_with = "deserialize_canonical_event_id")]
    event_id: EventId,
    event_type: MarineAnalysisRequestedEventType,
    #[serde(deserialize_with = "deserialize_marine_timestamp")]
    timestamp: DateTime<Utc>,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    tenant_id: Uuid,
    version: MarineAnalysisRequestedEventVersion,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    aggregate_id: Uuid,
    aggregate_type: MarineAnalysisJobAggregateType,
    #[serde(default)]
    correlation_id: Option<String>,
    #[serde(default)]
    causation_id: Option<String>,
    #[serde(default)]
    user_id: Option<String>,
    #[serde(default)]
    retry_count: Option<u32>,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    analysis_job_id: Uuid,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    execution_id: Uuid,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    site_id: Uuid,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    marine_area_id: Uuid,
    provider: MarineAnalysisProvider,
    job_kind: MarineAnalysisJobKind,
    request_fingerprint: RequestFingerprint,
    credential_generation: MarineCredentialGeneration,
    #[serde(deserialize_with = "deserialize_marine_timestamp")]
    requested_at: DateTime<Utc>,
}

impl<'de> Deserialize<'de> for MarineAnalysisRequestedEvent {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = MarineAnalysisRequestedEventWire::deserialize(deserializer)?;
        if wire.aggregate_id != wire.analysis_job_id {
            return Err(serde::de::Error::custom(
                "aggregateId must equal analysisJobId",
            ));
        }
        if wire
            .correlation_id
            .iter()
            .chain(wire.causation_id.iter())
            .chain(wire.user_id.iter())
            .any(|value| value.chars().count() > 64)
            || wire.retry_count.is_some_and(|value| value > 1_000)
        {
            return Err(serde::de::Error::custom(
                "optional base-event metadata exceeds its contract bound",
            ));
        }
        Ok(Self {
            event_id: wire.event_id,
            event_type: wire.event_type,
            timestamp: wire.timestamp,
            tenant_id: wire.tenant_id,
            version: wire.version,
            aggregate_id: wire.aggregate_id,
            aggregate_type: wire.aggregate_type,
            correlation_id: wire.correlation_id,
            causation_id: wire.causation_id,
            user_id: wire.user_id,
            retry_count: wire.retry_count,
            analysis_job_id: wire.analysis_job_id,
            execution_id: wire.execution_id,
            site_id: wire.site_id,
            marine_area_id: wire.marine_area_id,
            provider: wire.provider,
            job_kind: wire.job_kind,
            request_fingerprint: wire.request_fingerprint,
            credential_generation: wire.credential_generation,
            requested_at: wire.requested_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};
    use serde_json::{Value, json};
    use uuid::Uuid;

    use super::{
        MarineAnalysisJobKind, MarineAnalysisProvider, MarineAnalysisRequestedEvent,
        MarineCredentialGeneration, RequestFingerprint, RequestFingerprintError,
    };

    const TENANT_ID: &str = "11111111-1111-4111-8111-111111111111";
    const JOB_ID: &str = "22222222-2222-4222-8222-222222222222";
    const EXECUTION_ID: &str = "33333333-3333-4333-8333-333333333333";
    const SITE_ID: &str = "44444444-4444-4444-8444-444444444444";
    const AREA_ID: &str = "55555555-5555-4555-8555-555555555555";
    const FINGERPRINT: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const MARINE_ANALYSIS_REQUESTED_FIXTURE: &str =
        include_str!("../../../libs/event-contracts/fixtures/marine-analysis-requested.json");

    fn uuid(value: &str) -> Uuid {
        Uuid::try_parse(value).unwrap()
    }

    fn valid_wire_event() -> Value {
        json!({
            "eventId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "eventType": "MarineAnalysisRequested",
            "timestamp": "2026-07-19T10:00:00.000Z",
            "tenantId": TENANT_ID,
            "version": 1,
            "aggregateId": JOB_ID,
            "aggregateType": "MarineAnalysisJob",
            "analysisJobId": JOB_ID,
            "executionId": EXECUTION_ID,
            "siteId": SITE_ID,
            "marineAreaId": AREA_ID,
            "provider": "CMEMS",
            "jobKind": "TIME_SERIES",
            "requestFingerprint": FINGERPRINT,
            "credentialGeneration": 3,
            "requestedAt": "2026-07-19T09:59:59.000Z"
        })
    }

    #[test]
    fn event_round_trip_matches_camel_case_wire_contract() {
        let bytes = serde_json::to_vec(&valid_wire_event()).unwrap();
        let event = MarineAnalysisRequestedEvent::from_json_bytes(&bytes).unwrap();

        assert_eq!(event.tenant_id, uuid(TENANT_ID));
        assert_eq!(event.analysis_job_id, uuid(JOB_ID));
        assert_eq!(event.provider, MarineAnalysisProvider::Cmems);
        assert_eq!(event.job_kind, MarineAnalysisJobKind::TimeSeries);
        assert_eq!(event.credential_generation.get(), 3);

        let encoded: Value = serde_json::from_slice(&event.to_json_bytes().unwrap()).unwrap();
        assert_eq!(encoded, valid_wire_event());
        assert!(encoded.get("payload").is_none());
        assert!(encoded.get("credential").is_none());
        assert!(encoded.get("aoi").is_none());
    }

    #[test]
    fn event_decodes_the_typescript_golden_fixture() {
        let event = MarineAnalysisRequestedEvent::from_json_bytes(
            MARINE_ANALYSIS_REQUESTED_FIXTURE.as_bytes(),
        )
        .unwrap();

        assert_eq!(
            event.analysis_job_id,
            uuid("33333333-3333-4333-8333-333333333333")
        );
        assert_eq!(event.provider, MarineAnalysisProvider::Cmems);
        assert_eq!(event.job_kind, MarineAnalysisJobKind::Snapshot);
        assert_eq!(event.credential_generation.get(), 3);
    }

    #[test]
    fn constructor_pins_base_metadata_and_specific_fields() {
        let requested_at = Utc.with_ymd_and_hms(2026, 7, 19, 9, 59, 59).unwrap();
        let event = MarineAnalysisRequestedEvent::new(
            uuid(TENANT_ID),
            uuid(JOB_ID),
            uuid(EXECUTION_ID),
            uuid(SITE_ID),
            uuid(AREA_ID),
            MarineAnalysisProvider::Cmems,
            MarineAnalysisJobKind::Snapshot,
            RequestFingerprint::try_new(FINGERPRINT).unwrap(),
            MarineCredentialGeneration::try_new(1).unwrap(),
            requested_at,
        );

        assert_eq!(event.version, super::MarineAnalysisRequestedEventVersion);
        assert_eq!(event.aggregate_id, uuid(JOB_ID));
        assert_eq!(event.aggregate_type, super::MarineAnalysisJobAggregateType);
        assert_eq!(event.requested_at, requested_at);
    }

    #[test]
    fn decoding_rejects_wrong_literals_unknown_fields_and_zero_generation() {
        for (field, value) in [
            ("eventType", json!("marine.analysis.requested")),
            ("version", json!(2)),
            ("aggregateType", json!("AnalysisJob")),
            ("credentialGeneration", json!(0)),
        ] {
            let mut wire = valid_wire_event();
            wire[field] = value;
            assert!(
                MarineAnalysisRequestedEvent::from_json_bytes(&serde_json::to_vec(&wire).unwrap())
                    .is_err()
            );
        }

        let mut unknown = valid_wire_event();
        unknown["payload"] = json!({ "aoi": "secret-bearing-shape" });
        assert!(
            MarineAnalysisRequestedEvent::from_json_bytes(&serde_json::to_vec(&unknown).unwrap())
                .is_err()
        );

        let mut missing_aggregate = valid_wire_event();
        missing_aggregate
            .as_object_mut()
            .unwrap()
            .remove("aggregateId");
        assert!(
            MarineAnalysisRequestedEvent::from_json_bytes(
                &serde_json::to_vec(&missing_aggregate).unwrap()
            )
            .is_err()
        );

        let mut mismatched_aggregate = valid_wire_event();
        mismatched_aggregate["aggregateId"] = json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        assert!(
            MarineAnalysisRequestedEvent::from_json_bytes(
                &serde_json::to_vec(&mismatched_aggregate).unwrap()
            )
            .is_err()
        );

        for (field, value) in [
            ("eventId", json!("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")),
            ("tenantId", json!("{11111111-1111-4111-8111-111111111111}")),
            ("correlationId", json!("x".repeat(65))),
            ("retryCount", json!(1_001)),
            ("credentialGeneration", json!(9_007_199_254_740_992_u64)),
        ] {
            let mut wire = valid_wire_event();
            wire[field] = value;
            assert!(
                MarineAnalysisRequestedEvent::from_json_bytes(&serde_json::to_vec(&wire).unwrap())
                    .is_err(),
                "accepted invalid {field}"
            );
        }
    }

    #[test]
    fn fingerprint_requires_exact_lowercase_sha256_hex() {
        assert!(RequestFingerprint::try_new(FINGERPRINT).is_ok());
        assert_eq!(
            RequestFingerprint::try_new("abc"),
            Err(RequestFingerprintError::InvalidLength)
        );
        assert_eq!(
            RequestFingerprint::try_new(FINGERPRINT.to_uppercase()),
            Err(RequestFingerprintError::InvalidCharacter)
        );
    }

    #[test]
    fn event_timestamps_require_exact_utc_millisecond_wire_form() {
        for field in ["timestamp", "requestedAt"] {
            for invalid in [
                "2026-07-19T10:00:00Z",
                "2026-07-19T10:00:00.0000Z",
                "2026-07-19T10:00:00.000+00:00",
                "2026-07-19t10:00:00.000z",
                "2026-07-19T10:00:60.000Z",
            ] {
                let mut wire = valid_wire_event();
                wire[field] = json!(invalid);
                assert!(
                    MarineAnalysisRequestedEvent::from_json_bytes(
                        &serde_json::to_vec(&wire).unwrap()
                    )
                    .is_err(),
                    "accepted non-canonical {field} timestamp {invalid}"
                );
            }
        }
    }

    #[test]
    fn provider_and_job_kind_are_closed_enums() {
        for provider in ["CDSE", "SENTINEL"] {
            let mut invalid_provider = valid_wire_event();
            invalid_provider["provider"] = json!(provider);
            assert!(
                MarineAnalysisRequestedEvent::from_json_bytes(
                    &serde_json::to_vec(&invalid_provider).unwrap()
                )
                .is_err()
            );
        }

        let mut invalid_kind = valid_wire_event();
        invalid_kind["jobKind"] = json!("EXPORT");
        assert!(
            MarineAnalysisRequestedEvent::from_json_bytes(
                &serde_json::to_vec(&invalid_kind).unwrap()
            )
            .is_err()
        );
    }
}
