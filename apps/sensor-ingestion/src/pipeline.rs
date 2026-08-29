//! Durable MQTT ingestion decision pipeline.
//!
//! The pipeline deliberately does not own the MQTT client. It returns a typed
//! disposition and the binary performs the source ACK action. This separation
//! makes the security boundary testable: `COMMITTED`, `NOT_OWNER`, and
//! `ERASED_TENANT` are the only outcomes that may become PUBACK; `RETRY` keeps
//! the persistent session delivery pending, while `POISON` first requires a
//! quarantine JetStream PubAck.

use std::sync::Arc;

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use tenant_context::TenantId;
use uuid::Uuid;

use crate::cache::{SensorMeta, TopicCache};
use crate::events::{DispatchPublisher, build_sensor_reading_dispatch};
use crate::ingest_backend::{OwnershipDecision, VersionedOwnerPolicies};
use crate::persistence::{DurableCommitInput, DurableIngressStore, SinkError};
use crate::sensor_lookup::SensorLookupClient;
use crate::topic::ParsedTopic;

/// Final source-delivery decision understood by the MQTT orchestrator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MqttDisposition {
    /// Tenant transaction and every pending child PubAck are durable.
    Committed,
    /// Retryable infrastructure or indeterminate-policy state; do not ACK.
    Retry,
    /// Invalid/colliding input; quarantine must persist before ACK.
    Poison,
    /// Another backend is provably ACTIVE; this session copy may be ACKed.
    NotOwner,
    /// A committed erasure tombstone prevents recreation; ACK-drop.
    ErasedTenant,
}

/// Metadata resolution boundary used by the pipeline.
#[async_trait]
pub trait SensorMetadataResolver: Send + Sync + std::fmt::Debug {
    /// Resolve one tenant-bound sensor. `None` is authoritative not-found.
    async fn resolve(&self, tenant: TenantId, sensor: Uuid) -> Result<Option<Arc<SensorMeta>>, ()>;
}

/// Cache-first production resolver backed by the sensor-service NATS responder.
#[derive(Debug)]
pub struct CachedSensorMetadataResolver {
    cache: Arc<TopicCache>,
    lookup: Arc<SensorLookupClient>,
}

impl CachedSensorMetadataResolver {
    /// Bind the process-wide cache and certificate-authenticated lookup client.
    #[must_use]
    pub const fn new(cache: Arc<TopicCache>, lookup: Arc<SensorLookupClient>) -> Self {
        Self { cache, lookup }
    }
}

#[async_trait]
impl SensorMetadataResolver for CachedSensorMetadataResolver {
    async fn resolve(&self, tenant: TenantId, sensor: Uuid) -> Result<Option<Arc<SensorMeta>>, ()> {
        if let Some(meta) = self.cache.get(tenant, sensor) {
            return Ok(Some(meta));
        }
        let meta = self
            .lookup
            .fetch_sensor_meta(tenant, sensor)
            .await
            .map_err(|_| ())?;
        let Some(meta) = meta else {
            return Ok(None);
        };
        if meta.tenant_id != tenant || meta.sensor_id != sensor {
            return Err(());
        }
        self.cache.insert(meta);
        Ok(self.cache.get(tenant, sensor))
    }
}

/// Collaborators required by the source-ACK gate.
#[derive(Debug)]
pub struct IngressPipeline {
    owners: Arc<VersionedOwnerPolicies>,
    resolver: Arc<dyn SensorMetadataResolver>,
    store: Arc<dyn DurableIngressStore>,
    publisher: Arc<dyn DispatchPublisher>,
}

impl IngressPipeline {
    /// Construct a pipeline with explicit, mockable boundaries.
    #[must_use]
    pub const fn new(
        owners: Arc<VersionedOwnerPolicies>,
        resolver: Arc<dyn SensorMetadataResolver>,
        store: Arc<dyn DurableIngressStore>,
        publisher: Arc<dyn DispatchPublisher>,
    ) -> Self {
        Self {
            owners,
            resolver,
            store,
            publisher,
        }
    }

    /// Process one MQTT delivery through ownership, validation, commit and all
    /// required child PubAcks. This function never acknowledges MQTT itself.
    pub async fn process(&self, topic: &str, payload: &[u8]) -> MqttDisposition {
        let Ok(parsed) = crate::topic::parse(topic) else {
            return MqttDisposition::Poison;
        };
        let (tenant, topic_sensor) = match parsed {
            ParsedTopic::Sensor { tenant, sensor } => (tenant, sensor),
            ParsedTopic::Device { .. } => return MqttDisposition::Poison,
        };
        match self.owners.decision_for(tenant) {
            OwnershipDecision::Process => {}
            OwnershipDecision::NotOwnerActive => return MqttDisposition::NotOwner,
            OwnershipDecision::Indeterminate => return MqttDisposition::Retry,
        }
        let Ok(reading) = crate::payload::validate(payload, tenant) else {
            return MqttDisposition::Poison;
        };
        if reading.sensor_id != topic_sensor {
            return MqttDisposition::Poison;
        }
        let Ok(Some(meta)) = self.resolver.resolve(tenant, topic_sensor).await else {
            return MqttDisposition::Retry;
        };
        let Ok(dispatch) = build_sensor_reading_dispatch(&reading, &meta) else {
            return MqttDisposition::Poison;
        };
        let payload_digest = hex_sha256(payload);
        let outcome = match self
            .store
            .commit(DurableCommitInput {
                reading,
                mqtt_topic: topic.to_owned(),
                payload_digest,
                dispatch,
            })
            .await
        {
            Ok(outcome) => outcome,
            Err(SinkError::ErasedTenant) => return MqttDisposition::ErasedTenant,
            Err(SinkError::SourceIdentityCollision | SinkError::InvalidLedgerState) => {
                return MqttDisposition::Poison;
            }
            Err(_) => return MqttDisposition::Retry,
        };
        for pending in outcome.pending_dispatches() {
            let Ok(ack) = self.publisher.publish(pending).await else {
                let _ = self
                    .store
                    .mark_publish_failed(tenant, pending.child_event_id)
                    .await;
                return MqttDisposition::Retry;
            };
            if self
                .store
                .mark_acked(tenant, pending.child_event_id, &ack)
                .await
                .is_err()
            {
                return MqttDisposition::Retry;
            }
        }
        MqttDisposition::Committed
    }
}

fn hex_sha256(payload: &[u8]) -> String {
    let digest = Sha256::digest(payload);
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use nats_client::JetStreamPubAck;

    use super::*;
    use crate::events::{DispatchError, DurableDispatch};
    use crate::ingest_backend::{
        IngressOwner, IngressOwnerPolicy, IngressOwnerPolicyState, PolicyApplyOutcome,
    };
    use crate::persistence::DurableCommitOutcome;

    const TENANT: &str = "550e8400-e29b-41d4-a716-446655440000";
    const SENSOR: &str = "11111111-1111-4111-8111-111111111111";
    const CHANNEL: &str = "22222222-2222-4222-8222-222222222222";

    fn tenant() -> TenantId {
        TenantId::try_parse(TENANT).unwrap()
    }

    fn payload() -> Vec<u8> {
        format!(
            r#"{{"tenantId":"{TENANT}","sensorId":"{SENSOR}","channelId":"{CHANNEL}","value":8.2,"rawValue":8.2,"quality":192,"producerTs":1735689600000,"sourceEventId":"edge:1","sourceSequence":1,"payloadVersion":2}}"#
        )
        .into_bytes()
    }

    #[derive(Debug)]
    struct Resolver;

    #[async_trait]
    impl SensorMetadataResolver for Resolver {
        async fn resolve(
            &self,
            tenant_id: TenantId,
            sensor: Uuid,
        ) -> Result<Option<Arc<SensorMeta>>, ()> {
            let channel = Uuid::parse_str(CHANNEL).unwrap();
            Ok(Some(Arc::new(SensorMeta {
                sensor_id: sensor,
                tenant_id,
                channel_ids: vec![channel],
                channel_keys: HashMap::from([(channel, "dissolved_oxygen".to_owned())]),
                farm_id: None,
                pond_id: None,
            })))
        }
    }

    #[derive(Debug, Default)]
    struct Store {
        order: Arc<Mutex<Vec<&'static str>>>,
    }

    #[async_trait]
    impl DurableIngressStore for Store {
        async fn commit(
            &self,
            input: DurableCommitInput,
        ) -> Result<DurableCommitOutcome, SinkError> {
            self.order.lock().unwrap().push("commit");
            Ok(DurableCommitOutcome::Committed(vec![input.dispatch]))
        }

        async fn mark_acked(
            &self,
            _tenant_id: TenantId,
            _child_event_id: Uuid,
            _ack: &JetStreamPubAck,
        ) -> Result<(), SinkError> {
            self.order.lock().unwrap().push("mark_acked");
            Ok(())
        }

        async fn mark_publish_failed(
            &self,
            _tenant_id: TenantId,
            _child_event_id: Uuid,
        ) -> Result<(), SinkError> {
            self.order.lock().unwrap().push("publish_failed");
            Ok(())
        }
    }

    #[derive(Debug)]
    struct Publisher {
        order: Arc<Mutex<Vec<&'static str>>>,
    }

    #[async_trait]
    impl DispatchPublisher for Publisher {
        async fn publish(
            &self,
            _dispatch: &DurableDispatch,
        ) -> Result<JetStreamPubAck, DispatchError> {
            self.order.lock().unwrap().push("puback");
            Ok(JetStreamPubAck {
                stream: "AQUACULTURE_TELEMETRY".to_owned(),
                sequence: 9,
                duplicate: false,
            })
        }
    }

    fn active_rust_policy() -> Arc<VersionedOwnerPolicies> {
        let policies = Arc::new(VersionedOwnerPolicies::new());
        assert_eq!(
            policies.apply(IngressOwnerPolicy {
                tenant_id: tenant(),
                version: 1,
                owner: IngressOwner::Rust,
                effective_epoch: "epoch-1".to_owned(),
                state: IngressOwnerPolicyState::Active,
            }),
            PolicyApplyOutcome::Applied
        );
        policies
    }

    #[tokio::test]
    async fn commit_and_all_puback_state_precede_committed_disposition() {
        let store = Arc::new(Store::default());
        let pipeline = IngressPipeline::new(
            active_rust_policy(),
            Arc::new(Resolver),
            store.clone(),
            Arc::new(Publisher {
                order: store.order.clone(),
            }),
        );
        let disposition = pipeline
            .process(&format!("sensors/{TENANT}/{SENSOR}/data"), &payload())
            .await;
        assert_eq!(disposition, MqttDisposition::Committed);
        assert_eq!(
            store.order.lock().unwrap().as_slice(),
            ["commit", "puback", "mark_acked"]
        );
    }

    #[tokio::test]
    async fn unknown_owner_policy_never_reaches_commit_or_ack() {
        let store = Arc::new(Store::default());
        let pipeline = IngressPipeline::new(
            Arc::new(VersionedOwnerPolicies::new()),
            Arc::new(Resolver),
            store.clone(),
            Arc::new(Publisher {
                order: store.order.clone(),
            }),
        );
        assert_eq!(
            pipeline
                .process(&format!("sensors/{TENANT}/{SENSOR}/data"), &payload())
                .await,
            MqttDisposition::Retry
        );
        assert!(store.order.lock().unwrap().is_empty());
    }
}
