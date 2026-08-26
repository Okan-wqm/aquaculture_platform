//! Canonical telemetry dispatch for the Rust ingestion owner.
//!
//! The sidecar publishes only `SensorReading` child events on the telemetry
//! stream. A core-NATS write is not success: [`DispatchPublisher::publish`]
//! returns only after JetStream supplies its persistence PubAck. The caller
//! stores those coordinates in the tenant-local dispatch ledger before it may
//! acknowledge the source MQTT delivery.

use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine as _;
use bytes::Bytes;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::Mutex;
use tracing::instrument;
use uuid::Uuid;

use nats_client::JetStreamPubAck;
use tenant_context::TenantId;

use crate::cache::SensorMeta;
use crate::payload::SensorReading;

/// One deterministic child event loaded from a tenant dispatch ledger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableDispatch {
    /// Stable child identity derived from source id + discriminator.
    pub child_event_id: Uuid,
    /// Tenant used both for subject derivation and isolation checks.
    pub tenant_id: TenantId,
    /// Canonical subject persisted alongside the payload.
    pub subject: String,
    /// Flat canonical `SensorReading` payload.
    pub payload: serde_json::Value,
}

/// Failures before a server-confirmed JetStream PubAck exists.
#[derive(Debug, Error)]
pub enum DispatchError {
    /// Resolved metadata belongs to a different tenant or sensor.
    #[error("sensor metadata identity does not match the validated reading")]
    MetadataIdentityMismatch,
    /// The resolved sensor does not name the reading's channel.
    #[error("sensor metadata does not contain a canonical channel key")]
    MissingChannelMetadata,
    /// The channel is not part of the canonical SensorReading vocabulary.
    #[error("sensor channel is outside the canonical SensorReading vocabulary")]
    UnsupportedChannel,
    /// Producer timestamp cannot be represented by chrono.
    #[error("producer timestamp is outside the supported range")]
    InvalidProducerTimestamp,
    /// Stable child event id construction failed.
    #[error("deterministic child event identity failed")]
    EventIdentity(#[source] event_contracts_rs::EventIdError),
    /// Canonical event could not be converted to its durable JSON form.
    #[error("canonical event payload encoding failed")]
    EventPayload(#[source] serde_json::Error),
    /// Persisted subject does not match the tenant's canonical route.
    #[error("dispatch subject does not match canonical tenant telemetry route")]
    SubjectMismatch,
    /// JSON encoding failed.
    #[error("dispatch payload encoding failed")]
    Encode(#[source] serde_json::Error),
    /// JetStream did not confirm persistence.
    #[error("dispatch JetStream publish failed")]
    Publish(#[source] nats_client::NatsClientError),
}

/// Narrow publisher contract used by the durable ingress pipeline.
#[async_trait]
pub trait DispatchPublisher: Send + Sync + std::fmt::Debug {
    /// Publish one ledger row and await the JetStream persistence PubAck.
    async fn publish(&self, dispatch: &DurableDispatch) -> Result<JetStreamPubAck, DispatchError>;
}

/// Canonical route for a sensor reading. This mirrors the TypeScript stream
/// registry and intentionally has no generic event-root fallback.
#[must_use]
pub fn subject_for(tenant: TenantId) -> String {
    format!("telemetry.{}.SensorReading", tenant.as_uuid())
}

/// Build the one canonical child event for a validated single-channel MQTT
/// reading. Metadata is required because the channel key, not the UUID, defines
/// which flat SensorReading field consumers understand.
pub fn build_sensor_reading_dispatch(
    reading: &SensorReading,
    meta: &SensorMeta,
) -> Result<DurableDispatch, DispatchError> {
    if meta.tenant_id != reading.tenant_id || meta.sensor_id != reading.sensor_id {
        return Err(DispatchError::MetadataIdentityMismatch);
    }
    let channel_key = meta
        .channel_keys
        .get(&reading.channel_id)
        .ok_or(DispatchError::MissingChannelMetadata)?;
    let (parameter, unit) =
        parameter_for_channel_key(channel_key).ok_or(DispatchError::UnsupportedChannel)?;
    let timestamp = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(reading.producer_ts)
        .ok_or(DispatchError::InvalidProducerTimestamp)?;
    let event_id =
        event_contracts_rs::EventId::deterministic(&reading.source_event_id, "SensorReading:0")
            .map_err(DispatchError::EventIdentity)?;
    let child_event_id = *event_id.as_uuid();
    let mut event = event_contracts_rs::SensorReadingEvent::new(
        *reading.tenant_id.as_uuid(),
        reading.sensor_id,
    );
    event.event_id = event_id;
    event.timestamp = timestamp;
    event.version = 3;
    event.farm_id = meta.farm_id;
    event.pond_id = meta.pond_id;
    event.parameter = Some(parameter);
    event.unit = Some(unit.to_owned());
    set_reading_value(&mut event, parameter, reading.value);
    let payload = serde_json::to_value(event).map_err(DispatchError::EventPayload)?;
    Ok(DurableDispatch {
        child_event_id,
        tenant_id: reading.tenant_id,
        subject: subject_for(reading.tenant_id),
        payload,
    })
}

fn parameter_for_channel_key(
    channel_key: &str,
) -> Option<(event_contracts_rs::SensorReadingParameter, &'static str)> {
    use event_contracts_rs::SensorReadingParameter;
    match channel_key.to_ascii_lowercase().as_str() {
        "temperature" | "temp" | "water_temperature" | "water_temp" => {
            Some((SensorReadingParameter::Temperature, "°C"))
        }
        "ph" | "ph_level" => Some((SensorReadingParameter::Ph, "pH")),
        "dissolved_oxygen" | "dissolvedoxygen" | "do" | "do_level" | "oxygen" | "o2" => {
            Some((SensorReadingParameter::DissolvedOxygen, "mg/L"))
        }
        "salinity" | "salt" => Some((SensorReadingParameter::Salinity, "ppt")),
        "ammonia" | "nh3" => Some((SensorReadingParameter::Ammonia, "mg/L")),
        "nitrite" | "no2" => Some((SensorReadingParameter::Nitrite, "mg/L")),
        "nitrate" | "no3" => Some((SensorReadingParameter::Nitrate, "mg/L")),
        "turbidity" | "ntu" => Some((SensorReadingParameter::Turbidity, "NTU")),
        "water_level" | "waterlevel" | "level" => Some((SensorReadingParameter::WaterLevel, "cm")),
        _ => None,
    }
}

fn set_reading_value(
    event: &mut event_contracts_rs::SensorReadingEvent,
    parameter: event_contracts_rs::SensorReadingParameter,
    value: f64,
) {
    use event_contracts_rs::SensorReadingParameter;
    match parameter {
        SensorReadingParameter::Temperature => event.reading_temperature = Some(value),
        SensorReadingParameter::Ph => event.reading_ph = Some(value),
        SensorReadingParameter::DissolvedOxygen => event.reading_dissolved_oxygen = Some(value),
        SensorReadingParameter::Salinity => event.reading_salinity = Some(value),
        SensorReadingParameter::Ammonia => event.reading_ammonia = Some(value),
        SensorReadingParameter::Nitrite => event.reading_nitrite = Some(value),
        SensorReadingParameter::Nitrate => event.reading_nitrate = Some(value),
        SensorReadingParameter::Turbidity => event.reading_turbidity = Some(value),
        SensorReadingParameter::WaterLevel => event.reading_water_level = Some(value),
    }
}

/// Production JetStream publisher over the process-wide mTLS NATS client.
#[derive(Debug, Clone)]
pub struct NatsDispatchPublisher {
    client: Arc<nats_client::NatsClient>,
}

/// Publisher for malformed or otherwise poison MQTT bytes. Success means the
/// separate quarantine stream durably accepted the evidence.
#[derive(Debug, Clone)]
pub struct NatsQuarantinePublisher {
    client: Arc<nats_client::NatsClient>,
}

impl NatsQuarantinePublisher {
    /// Wrap the process-wide mTLS NATS connection.
    #[must_use]
    pub const fn from_client(client: Arc<nats_client::NatsClient>) -> Self {
        Self { client }
    }

    /// Publish a flat `MqttPayloadQuarantined` envelope and await JetStream.
    pub async fn publish(
        &self,
        topic: &str,
        payload: &[u8],
        reason: &str,
    ) -> Result<JetStreamPubAck, DispatchError> {
        let digest = Sha256::digest(payload);
        let digest_hex = digest
            .iter()
            .fold(String::with_capacity(64), |mut output, byte| {
                use std::fmt::Write as _;
                let _ = write!(output, "{byte:02x}");
                output
            });
        let event_id =
            event_contracts_rs::EventId::deterministic(&format!("quarantine:{digest_hex}"), topic)
                .map_err(DispatchError::EventIdentity)?;
        let tenant_id = match crate::topic::parse(topic) {
            Ok(
                crate::topic::ParsedTopic::Sensor { tenant, .. }
                | crate::topic::ParsedTopic::Device { tenant, .. },
            ) => *tenant.as_uuid(),
            Err(_) => Uuid::nil(),
        };
        let now = chrono::Utc::now();
        let timestamp = now
            - chrono::Duration::nanoseconds(i64::from(now.timestamp_subsec_nanos() % 1_000_000));
        let envelope = serde_json::json!({
            "eventId": event_id.to_string(),
            "eventType": "MqttPayloadQuarantined",
            "timestamp": timestamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "tenantId": tenant_id.to_string(),
            "version": 1,
            "topic": topic,
            "payloadDigest": digest_hex,
            "reason": reason,
            "payloadBase64": base64::engine::general_purpose::STANDARD.encode(payload),
        });
        let encoded = serde_json::to_vec(&envelope).map_err(DispatchError::EventPayload)?;
        let mut headers = nats_client::HeaderMap::new();
        headers.insert("Nats-Msg-Id", event_id.to_string().as_str());
        self.client
            .publish_jetstream_with_headers("quarantine.mqtt", headers, Bytes::from(encoded))
            .await
            .map_err(DispatchError::Publish)
    }
}

impl NatsDispatchPublisher {
    /// Wrap the already-authenticated certificate-bound connection.
    #[must_use]
    pub const fn from_client(client: Arc<nats_client::NatsClient>) -> Self {
        Self { client }
    }
}

#[async_trait]
impl DispatchPublisher for NatsDispatchPublisher {
    #[instrument(
        skip(self, dispatch),
        fields(
            tenant_id = %dispatch.tenant_id.as_uuid(),
            child_event_id = %dispatch.child_event_id,
        )
    )]
    async fn publish(&self, dispatch: &DurableDispatch) -> Result<JetStreamPubAck, DispatchError> {
        if dispatch.subject != subject_for(dispatch.tenant_id) {
            return Err(DispatchError::SubjectMismatch);
        }
        let payload = serde_json::to_vec(&dispatch.payload).map_err(DispatchError::Encode)?;
        let mut headers = nats_client::HeaderMap::new();
        headers.insert("Nats-Msg-Id", dispatch.child_event_id.to_string().as_str());
        headers.insert(
            observability::TRACEPARENT_HEADER,
            observability::generate_traceparent().as_str(),
        );
        self.client
            .publish_jetstream_with_headers(dispatch.subject.clone(), headers, Bytes::from(payload))
            .await
            .map_err(DispatchError::Publish)
    }
}

/// Broker-free publisher used by unit tests and explicit stub mode.
#[derive(Debug, Default, Clone)]
pub struct LoggingDispatchPublisher {
    count: Arc<std::sync::atomic::AtomicU64>,
    last_subject: Arc<Mutex<Option<String>>>,
}

impl LoggingDispatchPublisher {
    /// Construct an empty recorder.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of server-ack-shaped results returned.
    #[must_use]
    pub fn count(&self) -> u64 {
        self.count.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Most recently published subject.
    pub async fn last_subject(&self) -> Option<String> {
        self.last_subject.lock().await.clone()
    }
}

#[async_trait]
impl DispatchPublisher for LoggingDispatchPublisher {
    async fn publish(&self, dispatch: &DurableDispatch) -> Result<JetStreamPubAck, DispatchError> {
        if dispatch.subject != subject_for(dispatch.tenant_id) {
            return Err(DispatchError::SubjectMismatch);
        }
        let sequence = self
            .count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            .saturating_add(1);
        *self.last_subject.lock().await = Some(dispatch.subject.clone());
        Ok(JetStreamPubAck {
            stream: "AQUACULTURE_TELEMETRY".to_owned(),
            sequence,
            duplicate: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use chrono::{TimeZone, Utc};

    use super::{
        DispatchError, DispatchPublisher, DurableDispatch, LoggingDispatchPublisher,
        build_sensor_reading_dispatch, subject_for,
    };
    use crate::cache::SensorMeta;
    use crate::payload::{PayloadSource, QualityCode, SensorReading};
    use tenant_context::TenantId;
    use uuid::Uuid;

    fn fake_dispatch(tenant: TenantId) -> DurableDispatch {
        DurableDispatch {
            child_event_id: Uuid::new_v4(),
            tenant_id: tenant,
            subject: subject_for(tenant),
            payload: serde_json::json!({
                "eventId": Uuid::new_v4().to_string(),
                "eventType": "SensorReading",
                "tenantId": tenant.as_uuid().to_string(),
                "sensorId": Uuid::new_v4().to_string(),
                "readingPh": 7.4,
            }),
        }
    }

    fn reading(channel_id: Uuid) -> SensorReading {
        SensorReading {
            tenant_id: TenantId::try_parse("550e8400-e29b-41d4-a716-446655440000").unwrap(),
            sensor_id: Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
            channel_id,
            value: 8.25,
            raw_value: 8.25,
            quality: QualityCode::try_new(192).unwrap(),
            producer_ts: 1_735_689_600_000,
            source_event_id: "edge-a:1735689600000:42".to_owned(),
            source_sequence: Some(42),
            source: PayloadSource::OriginalV2,
        }
    }

    #[test]
    fn builder_emits_v3_canonical_event_with_stable_child_identity() {
        let channel_id = Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap();
        let reading = reading(channel_id);
        let meta = SensorMeta {
            sensor_id: reading.sensor_id,
            tenant_id: reading.tenant_id,
            channel_ids: vec![channel_id],
            channel_keys: HashMap::from([(channel_id, "do".to_owned())]),
            farm_id: Some(Uuid::parse_str("33333333-3333-4333-8333-333333333333").unwrap()),
            pond_id: Some(Uuid::parse_str("44444444-4444-4444-8444-444444444444").unwrap()),
        };

        let dispatch = build_sensor_reading_dispatch(&reading, &meta).unwrap();

        assert_eq!(
            dispatch.child_event_id.to_string(),
            "fd8392a1-6076-5288-b415-1b8cc0b3256e"
        );
        assert_eq!(dispatch.subject, subject_for(reading.tenant_id));
        assert_eq!(dispatch.payload["version"], 3);
        assert_eq!(dispatch.payload["parameter"], "dissolvedOxygen");
        assert_eq!(dispatch.payload["readingDissolvedOxygen"], 8.25);
        assert_eq!(
            dispatch.payload["timestamp"],
            Utc.timestamp_millis_opt(reading.producer_ts)
                .single()
                .unwrap()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        );
    }

    #[test]
    fn builder_fails_closed_without_canonical_channel_metadata() {
        let channel_id = Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap();
        let reading = reading(channel_id);
        let meta = SensorMeta {
            sensor_id: reading.sensor_id,
            tenant_id: reading.tenant_id,
            channel_ids: vec![channel_id],
            channel_keys: HashMap::new(),
            farm_id: None,
            pond_id: None,
        };

        assert!(matches!(
            build_sensor_reading_dispatch(&reading, &meta),
            Err(DispatchError::MissingChannelMetadata)
        ));
    }

    #[test]
    fn subject_uses_canonical_telemetry_root() {
        let tenant_str = "550e8400-e29b-41d4-a716-446655440000";
        let tenant = TenantId::try_parse(tenant_str).unwrap();
        assert_eq!(
            subject_for(tenant),
            format!("telemetry.{tenant_str}.SensorReading")
        );
    }

    #[tokio::test]
    async fn logging_publisher_returns_and_records_puback() {
        let tenant = TenantId::try_parse("550e8400-e29b-41d4-a716-446655440000").unwrap();
        let publisher = LoggingDispatchPublisher::new();
        let dispatch = fake_dispatch(tenant);
        let ack = publisher.publish(&dispatch).await.unwrap();
        assert_eq!(ack.stream, "AQUACULTURE_TELEMETRY");
        assert_eq!(ack.sequence, 1);
        assert_eq!(publisher.count(), 1);
        assert_eq!(publisher.last_subject().await, Some(dispatch.subject));
    }

    #[tokio::test]
    async fn publisher_fails_closed_on_noncanonical_subject() {
        let tenant = TenantId::try_parse("550e8400-e29b-41d4-a716-446655440000").unwrap();
        let publisher = LoggingDispatchPublisher::new();
        let mut dispatch = fake_dispatch(tenant);
        dispatch.subject = "events.admin.SensorReading".to_owned();
        assert!(matches!(
            publisher.publish(&dispatch).await,
            Err(DispatchError::SubjectMismatch)
        ));
        assert_eq!(publisher.count(), 0);
    }
}
