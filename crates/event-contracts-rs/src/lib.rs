//! `event-contracts-rs` — Rust mirror of `@platform/event-contracts`.
//!
//! WHY this crate exists:
//!   The Rust ingestion sidecar (`apps/sensor-ingestion`) publishes
//!   the same events that NestJS publishers do; downstream consumers
//!   (alert-engine, AI-service, audit) cannot tell the producer apart.
//!   The wire format MUST be byte-equivalent: same camelCase keys,
//!   same flat shape (ADR-006), same branded `eventId`. This crate is
//!   the contract.
//!
//! Architectural invariants (compile-time + serde-time):
//!   - **Branded `EventId`**: opaque newtype; `Default` impl absent.
//!     Producible only via [`EventId::generate`] or
//!     [`EventBuilder`]-style constructors.
//!   - **ADR-006 flat pattern**: every event struct uses
//!     `#[serde(deny_unknown_fields)]` so a consumer that mistakenly
//!     emits `{ "payload": {...} }` instead of flat fields hits a
//!     deserialise error rather than silently corrupting data.
//!   - **camelCase wire**: `#[serde(rename_all = "camelCase")]` so
//!     `tenant_id` Rust field becomes `tenantId` JSON key — matches
//!     the TS SSoT byte-for-byte.
//!   - **`eventType` const-checked**: each concrete event has a
//!     compile-time-known string literal that serde rejects on
//!     deserialise if the wire blob carries a different value.

#![cfg_attr(not(test), forbid(unsafe_code))]
#![cfg_attr(not(test), deny(missing_docs))]
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing,
    )
)]

use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;
use uuid::Uuid;

/// Crate version for diagnostic / drift-detection telemetry.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

// ---------- EventId ------------------------------------------------------

/// Errors raised when constructing or parsing an [`EventId`].
#[derive(Debug, Error, PartialEq, Eq, Clone)]
pub enum EventIdError {
    /// The supplied string is not a valid UUID.
    #[error("event id is not a valid UUID")]
    InvalidUuid,
}

/// Opaque event identifier. Producible only by [`EventId::generate`]
/// (uses `Uuid::new_v4`) or by [`EventId::try_parse`] from a trusted
/// upstream source.
///
/// `Default` is intentionally NOT implemented — every event must be
/// constructed through a path that records its provenance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Ord, PartialOrd)]
pub struct EventId(Uuid);

impl EventId {
    /// Generate a fresh v4 UUID. The only generative constructor.
    #[must_use]
    pub fn generate() -> Self {
        Self(Uuid::new_v4())
    }

    /// Parse a 36-byte UUID string. Used to deserialise off the wire.
    ///
    /// # Errors
    /// Returns [`EventIdError::InvalidUuid`] for any non-UUID input.
    pub fn try_parse(s: &str) -> Result<Self, EventIdError> {
        Uuid::try_parse(s)
            .map(Self)
            .map_err(|_| EventIdError::InvalidUuid)
    }

    /// Borrow the inner UUID. Use sparingly — prefer the typed
    /// `EventId` everywhere internally so accidental crossing of the
    /// brand boundary is conspicuous in code review.
    #[must_use]
    pub const fn as_uuid(&self) -> &Uuid {
        &self.0
    }
}

impl std::fmt::Display for EventId {
    /// Lower-case hyphenated UUID, matching `uuid::Uuid`'s default
    /// `Display`. The TS side serialises the same way, so the JSON
    /// wire format round-trips byte-for-byte.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl Serialize for EventId {
    fn serialize<S: Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.collect_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for EventId {
    fn deserialize<D: Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let s = String::deserialize(de)?;
        Self::try_parse(&s).map_err(serde::de::Error::custom)
    }
}

// ---------- SensorReadingEvent ------------------------------------------

/// Static `eventType` discriminator for [`SensorReadingEvent`].
pub const SENSOR_READING_EVENT_TYPE: &str = "SensorReading";

/// Zero-sized witness whose `Serialize` always emits
/// `"SensorReading"` and whose `Deserialize` rejects any other
/// string. Embedding this in [`SensorReadingEvent`] is what makes
/// the event-type discriminator a compile-time constant rather than
/// a footgun.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SensorReadingEventType;

impl Serialize for SensorReadingEventType {
    fn serialize<S: Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(SENSOR_READING_EVENT_TYPE)
    }
}

impl<'de> Deserialize<'de> for SensorReadingEventType {
    fn deserialize<D: Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let s = String::deserialize(de)?;
        if s == SENSOR_READING_EVENT_TYPE {
            Ok(Self)
        } else {
            Err(serde::de::Error::invalid_value(
                serde::de::Unexpected::Str(&s),
                &SENSOR_READING_EVENT_TYPE,
            ))
        }
    }
}

/// SensorReading event — wire-equivalent to the TS interface in
/// `libs/event-contracts/src/sensor-events.ts`. Flat layout per
/// ADR-006; nested `payload` shapes are rejected by
/// `deny_unknown_fields`.
///
/// `eventType` is the `SensorReading` const — any wire-side value
/// other than the literal `"SensorReading"` fails deserialisation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SensorReadingEvent {
    /// Branded event id; never `Default`.
    pub event_id: EventId,
    /// Discriminator — always `"SensorReading"` on the wire.
    pub event_type: SensorReadingEventType,
    /// ISO 8601 UTC timestamp.
    pub timestamp: DateTime<Utc>,
    /// Tenant id at the top level for NATS subject routing
    /// (matches TS BaseEvent contract).
    pub tenant_id: Uuid,
    /// Schema version. Bump on shape change.
    pub version: u32,

    /// Aggregate root id — usually equal to `sensor_id` for sensor
    /// reading events. Optional per the TS contract.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub aggregate_id: Option<Uuid>,
    /// Aggregate-type discriminator (e.g. `"Sensor"`).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub aggregate_type: Option<String>,
    /// Distributed-tracing correlation id.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub correlation_id: Option<String>,
    /// Causation id (parent event that produced this one).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub causation_id: Option<String>,
    /// User who triggered the event.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub user_id: Option<String>,
    /// Retry count incremented by the redelivery infrastructure.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub retry_count: Option<u32>,

    // ----- Sensor-reading-specific fields per the TS interface -----
    /// Sensor that produced the reading.
    pub sensor_id: Uuid,
    /// Optional farm scope.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub farm_id: Option<Uuid>,
    /// Optional pond scope.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub pond_id: Option<Uuid>,

    /// Temperature in Celsius.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reading_temperature: Option<f64>,
    /// pH.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reading_ph: Option<f64>,
    /// Dissolved oxygen mg/L.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reading_dissolved_oxygen: Option<f64>,
    /// Salinity ppt.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reading_salinity: Option<f64>,
    /// Ammonia mg/L.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reading_ammonia: Option<f64>,
    /// Nitrite mg/L.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reading_nitrite: Option<f64>,
    /// Nitrate mg/L.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reading_nitrate: Option<f64>,
    /// Turbidity NTU.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reading_turbidity: Option<f64>,
    /// Water level cm.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reading_water_level: Option<f64>,
}

impl SensorReadingEvent {
    /// Construct a new sensor-reading event with auto-generated
    /// `eventId`, `timestamp` = now-UTC, and `version` = 1. Optional
    /// fields default to `None`.
    #[must_use]
    pub fn new(tenant_id: Uuid, sensor_id: Uuid) -> Self {
        Self {
            event_id: EventId::generate(),
            event_type: SensorReadingEventType,
            timestamp: Utc::now(),
            tenant_id,
            version: 1,
            aggregate_id: Some(sensor_id),
            aggregate_type: Some("Sensor".to_owned()),
            correlation_id: None,
            causation_id: None,
            user_id: None,
            retry_count: None,
            sensor_id,
            farm_id: None,
            pond_id: None,
            reading_temperature: None,
            reading_ph: None,
            reading_dissolved_oxygen: None,
            reading_salinity: None,
            reading_ammonia: None,
            reading_nitrite: None,
            reading_nitrate: None,
            reading_turbidity: None,
            reading_water_level: None,
        }
    }

    /// Serialize to a JSON byte buffer ready for NATS publish.
    ///
    /// # Errors
    /// Propagates `serde_json::Error` (only fires on a write-side I/O
    /// failure for `Vec<u8>`; in practice the only failure mode is
    /// OOM).
    pub fn to_json_bytes(&self) -> Result<Vec<u8>, serde_json::Error> {
        serde_json::to_vec(self)
    }

    /// Deserialize from a JSON byte buffer (NATS subscriber side).
    ///
    /// # Errors
    /// Propagates `serde_json::Error` for any malformed wire value
    /// (extra fields, missing required fields, wrong `eventType`,
    /// non-UUID `eventId`, etc.).
    pub fn from_json_bytes(bytes: &[u8]) -> Result<Self, serde_json::Error> {
        serde_json::from_slice(bytes)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use uuid::Uuid;

    use super::{EventId, EventIdError, SENSOR_READING_EVENT_TYPE, SensorReadingEvent};

    fn fixed_uuid(seed: u8) -> Uuid {
        let mut bytes = [0_u8; 16];
        bytes[0] = seed;
        Uuid::from_bytes(bytes)
    }

    #[test]
    fn event_id_generate_unique_per_call() {
        assert_ne!(EventId::generate(), EventId::generate());
    }

    #[test]
    fn event_id_try_parse_strict() {
        let s = "550e8400-e29b-41d4-a716-446655440000";
        let id = EventId::try_parse(s).unwrap();
        assert_eq!(id.to_string(), s);
    }

    #[test]
    fn event_id_try_parse_rejects_garbage() {
        assert_eq!(EventId::try_parse("nope"), Err(EventIdError::InvalidUuid));
        assert_eq!(EventId::try_parse(""), Err(EventIdError::InvalidUuid));
    }

    #[test]
    fn event_id_serde_round_trip() {
        let id = EventId::generate();
        let json = serde_json::to_string(&id).unwrap();
        let back: EventId = serde_json::from_str(&json).unwrap();
        assert_eq!(id, back);
    }

    #[test]
    fn sensor_reading_event_new_sets_invariants() {
        let tenant = fixed_uuid(0xAA);
        let sensor = fixed_uuid(0xBB);
        let ev = SensorReadingEvent::new(tenant, sensor);
        assert_eq!(ev.tenant_id, tenant);
        assert_eq!(ev.sensor_id, sensor);
        assert_eq!(ev.version, 1);
        assert_eq!(ev.aggregate_id, Some(sensor));
        assert_eq!(ev.aggregate_type.as_deref(), Some("Sensor"));
        assert!(ev.reading_temperature.is_none());
    }

    #[test]
    fn distinct_instances_have_distinct_event_ids() {
        let t = fixed_uuid(0xAA);
        let s = fixed_uuid(0xBB);
        let a = SensorReadingEvent::new(t, s);
        let b = SensorReadingEvent::new(t, s);
        assert_ne!(a.event_id, b.event_id);
    }

    #[test]
    fn sensor_reading_event_serde_camel_case() {
        let mut ev = SensorReadingEvent::new(fixed_uuid(0xAA), fixed_uuid(0xBB));
        ev.reading_temperature = Some(24.5);
        ev.reading_ph = Some(7.2);

        let json = serde_json::to_string(&ev).unwrap();
        let v: Value = serde_json::from_str(&json).unwrap();
        assert!(v.get("eventId").is_some());
        assert_eq!(
            v.get("eventType"),
            Some(&Value::String("SensorReading".to_owned()))
        );
        assert!(v.get("tenantId").is_some());
        assert!(v.get("sensorId").is_some());
        assert!(v.get("readingTemperature").is_some());
        assert!(v.get("readingPh").is_some());
        assert!(v.get("event_id").is_none());
        assert!(v.get("tenant_id").is_none());
    }

    #[test]
    fn round_trip_preserves_all_fields() {
        let mut ev = SensorReadingEvent::new(fixed_uuid(0xAA), fixed_uuid(0xBB));
        ev.farm_id = Some(fixed_uuid(0xCC));
        ev.pond_id = Some(fixed_uuid(0xDD));
        ev.reading_temperature = Some(24.5);
        ev.reading_ph = Some(7.2);
        ev.reading_dissolved_oxygen = Some(8.1);
        ev.reading_salinity = Some(35.0);
        ev.reading_ammonia = Some(0.05);
        ev.reading_nitrite = Some(0.01);
        ev.reading_nitrate = Some(10.0);
        ev.reading_turbidity = Some(2.5);
        ev.reading_water_level = Some(120.0);
        ev.correlation_id = Some("trace-abc".to_owned());

        let bytes = ev.to_json_bytes().unwrap();
        let back = SensorReadingEvent::from_json_bytes(&bytes).unwrap();
        assert_eq!(back, ev);
    }

    #[test]
    fn optional_fields_omitted_when_none() {
        let ev = SensorReadingEvent::new(fixed_uuid(0xAA), fixed_uuid(0xBB));
        let json = serde_json::to_string(&ev).unwrap();
        assert!(!json.contains("\"farmId\""));
        assert!(!json.contains("\"readingTemperature\""));
        assert!(!json.contains("\"correlationId\""));
        assert!(json.contains("\"eventId\""));
        assert!(json.contains("\"tenantId\""));
        assert!(json.contains("\"sensorId\""));
    }

    #[test]
    fn rejects_wrong_event_type_on_deserialise() {
        let mut ev = SensorReadingEvent::new(fixed_uuid(0xAA), fixed_uuid(0xBB));
        ev.reading_temperature = Some(24.0);
        let s = String::from_utf8(ev.to_json_bytes().unwrap()).unwrap();
        let mut v: Value = serde_json::from_str(&s).unwrap();
        v["eventType"] = Value::String("WrongType".to_owned());
        let bytes = serde_json::to_vec(&v).unwrap();
        assert!(SensorReadingEvent::from_json_bytes(&bytes).is_err());
    }

    #[test]
    fn rejects_extra_unknown_field() {
        let json = serde_json::json!({
            "eventId": Uuid::new_v4().to_string(),
            "eventType": "SensorReading",
            "timestamp": "2026-04-20T12:00:00Z",
            "tenantId": fixed_uuid(0xAA).to_string(),
            "version": 1,
            "sensorId": fixed_uuid(0xBB).to_string(),
            "payload": { "foo": "bar" },
        });
        let bytes = serde_json::to_vec(&json).unwrap();
        let err = SensorReadingEvent::from_json_bytes(&bytes).unwrap_err();
        assert!(
            err.to_string().contains("payload") || err.to_string().contains("unknown field"),
            "expected unknown-field error, got: {err}"
        );
    }

    #[test]
    fn rejects_missing_required_tenant_id() {
        let json = serde_json::json!({
            "eventId": Uuid::new_v4().to_string(),
            "eventType": "SensorReading",
            "timestamp": "2026-04-20T12:00:00Z",
            "version": 1,
            "sensorId": fixed_uuid(0xBB).to_string(),
        });
        let bytes = serde_json::to_vec(&json).unwrap();
        assert!(SensorReadingEvent::from_json_bytes(&bytes).is_err());
    }

    #[test]
    fn rejects_invalid_event_id_uuid() {
        let json = serde_json::json!({
            "eventId": "not-a-uuid",
            "eventType": "SensorReading",
            "timestamp": "2026-04-20T12:00:00Z",
            "tenantId": fixed_uuid(0xAA).to_string(),
            "version": 1,
            "sensorId": fixed_uuid(0xBB).to_string(),
        });
        let bytes = serde_json::to_vec(&json).unwrap();
        assert!(SensorReadingEvent::from_json_bytes(&bytes).is_err());
    }

    #[test]
    fn timestamp_serializes_as_rfc3339() {
        let ev = SensorReadingEvent::new(fixed_uuid(0xAA), fixed_uuid(0xBB));
        let s = String::from_utf8(ev.to_json_bytes().unwrap()).unwrap();
        let v: Value = serde_json::from_str(&s).unwrap();
        let ts = v.get("timestamp").and_then(Value::as_str).unwrap();
        assert!(ts.contains('T'), "timestamp not RFC 3339: {ts}");
        assert!(
            ts.ends_with('Z') || ts.contains('+') || ts[1..].contains('-'),
            "timestamp missing offset: {ts}"
        );
    }

    #[test]
    fn const_event_type_string_matches_witness() {
        assert_eq!(SENSOR_READING_EVENT_TYPE, "SensorReading");
    }

    #[test]
    fn ts_compatible_wire_blob_deserialises() {
        // Hand-crafted blob mimicking what the NestJS publisher
        // would emit. If this round-trips, Rust + TS sides agree on
        // the wire format.
        let blob = r#"{
            "eventId": "550e8400-e29b-41d4-a716-446655440000",
            "eventType": "SensorReading",
            "timestamp": "2026-04-20T12:00:00.000Z",
            "tenantId": "11111111-1111-1111-1111-111111111111",
            "version": 1,
            "aggregateId": "22222222-2222-2222-2222-222222222222",
            "aggregateType": "Sensor",
            "sensorId": "22222222-2222-2222-2222-222222222222",
            "readingTemperature": 24.5,
            "readingPh": 7.2
        }"#;
        let ev = SensorReadingEvent::from_json_bytes(blob.as_bytes()).unwrap();
        assert_eq!(
            ev.tenant_id.to_string(),
            "11111111-1111-1111-1111-111111111111"
        );
        assert_eq!(
            ev.sensor_id.to_string(),
            "22222222-2222-2222-2222-222222222222"
        );
        assert_eq!(ev.aggregate_id, Some(ev.sensor_id));
        assert_eq!(ev.reading_temperature, Some(24.5));
        assert_eq!(ev.version, 1);
    }

    #[test]
    fn version_is_required_not_optional() {
        let json = serde_json::json!({
            "eventId": Uuid::new_v4().to_string(),
            "eventType": "SensorReading",
            "timestamp": "2026-04-20T12:00:00Z",
            "tenantId": fixed_uuid(0xAA).to_string(),
            "sensorId": fixed_uuid(0xBB).to_string(),
        });
        let bytes = serde_json::to_vec(&json).unwrap();
        assert!(SensorReadingEvent::from_json_bytes(&bytes).is_err());
    }
}
