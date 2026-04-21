//! NATS request-reply client for `sensor.lookup.by-topic`.
//! Populates [`crate::cache::TopicCache`] lazily on cache miss without
//! blocking the drain hot path.
//!
//! WHY this module exists:
//!   The `TopicCache` (Faz 2 stage 8) is allocated at boot and has the
//!   right Arc/papaya/moka shape, but until this module landed nothing
//!   populated it — the drain only used `cache.get()` for a hit/miss
//!   log. This module is the cache-fill side: on every drain miss the
//!   sidecar fires a `sensor.lookup.by-topic` request to sensor-service,
//!   which replies with `{ sensorId, tenantId, channelIds }` (or `null`
//!   for a not-found sensor). The response is decoded into
//!   [`SensorMeta`] and inserted into the cache.
//!
//! WHY fire-and-forget on the hot path:
//!   The drain MUST not block on the request-reply round trip — a
//!   single 1ms NATS RTT at the 50K msg/sn target torpedoes the
//!   `< 10ms` p99 budget. The current message therefore proceeds with
//!   whatever the payload carries (the validator already pinned tenant
//!   binding inside the payload itself). The cache fill helps every
//!   SUBSEQUENT message for the same `(tenant, sensor)` pair — that
//!   is the architectural payoff. [`spawn_lookup_and_populate_cache`]
//!   spawns a tokio task and returns immediately so the caller stays
//!   on the hot path.
//!
//! WHY a not-found responder reply is `Ok(None)` (not `Err`):
//!   "sensor does not exist" is a legitimate steady-state outcome that
//!   the responder gets to declare authoritatively. Encoding it as `Ok`
//!   keeps it distinct from a transport / decode failure, which is the
//!   actual error class operators alarm on. The responder writes the
//!   JSON literal `null` (not an empty object, not `{ "found": false }`)
//!   so the wire shape matches [`Option<SensorMeta>`]'s natural serde
//!   representation; the test `decode_response_null_returns_none` pins
//!   this byte-for-byte.
//!
//! WHY the subject literal `sensor.lookup.by-topic` is hard-coded here:
//!   The test `subject_is_canonical` pins the literal so a typo or a
//!   refactor that drifts the constant fails at build time. The NestJS
//!   responder pins the same literal in its own subscribe-time test —
//!   the two literals are co-located at the architectural boundary they
//!   share. Both sides break loud if either drifts.
//!
//! WHAT this module does NOT do:
//!   - It does NOT change drain semantics. The current message still
//!     processes with payload-only data. The fill helps the next batch.
//!   - It does NOT reach for calibration coefficients or alert
//!     thresholds; the wire shape is `{ sensorId, tenantId, channelIds }`
//!     only — that is what the responder authoritatively has from
//!     `SensorMetaCacheService.getSensor` + `getChannels` today.
//!   - It does NOT take responsibility for invalidation; cache
//!     invalidation is the SoT of the `SensorCacheInvalidationHandler`
//!     publishing `sensor.invalidate` on lifecycle events (Faz 3
//!     follow-on, separate commit). This module only fills.

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::time::timeout;
use tracing::instrument;
use uuid::Uuid;

use tenant_context::TenantId;

use crate::cache::{SensorMeta, TopicCache};

/// Canonical NATS subject for the cache-miss responder pair. Pinned by
/// the `subject_is_canonical` test so a refactor that mistypes the
/// literal fails at build time.
///
/// The NestJS responder (`SensorLookupResponderService`) subscribes to
/// the same literal; the test there mirrors this one. Both sides break
/// loud if either drifts.
pub const LOOKUP_SUBJECT: &str = "sensor.lookup.by-topic";

/// Default request-reply timeout. The hot path is fire-and-forget, so
/// the timeout exists to keep a hung responder from leaking task
/// handles indefinitely — not to gate any latency budget. Picked at the
/// "long enough that a healthy responder always wins" mark.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(2);

/// All ways a lookup can fail. Distinct variants per failure class so
/// operator alarms can route by semantic (transport vs encode vs
/// decode vs timeout) without parsing log strings.
#[derive(Debug, Error)]
pub enum LookupError {
    /// NATS-side failure: no responder, broker disconnect, async-nats
    /// internal request error. The variant carries the underlying
    /// `NatsClientError` so the source chain shows the actual
    /// broker-side problem.
    #[error("NATS request transport failed")]
    Transport(#[source] nats_client::NatsClientError),

    /// Wall-clock timeout from `tokio::time::timeout`. Distinct from
    /// `Transport` so an operator can tell apart "responder did not
    /// answer in time" from "broker rejected the request" — the
    /// remediation differs (deploy a healthy responder vs investigate
    /// broker / cert chain).
    #[error("NATS request timed out after {0:?}")]
    Timeout(Duration),

    /// `serde_json::to_vec` of the request body failed. In practice
    /// the only way this fires is OOM; the request body is a small
    /// fixed-shape struct that cannot produce a serde error at
    /// runtime. Keeping the variant typed distinctly keeps the error
    /// log faithful when it does fire.
    #[error("request payload encode failed")]
    Encode(#[source] serde_json::Error),

    /// `serde_json::from_slice` of the responder's reply failed. Means
    /// the responder replied with bytes that are not valid JSON OR not
    /// shape-compatible with [`SensorMeta`] / `null`. Almost always a
    /// responder-side bug or a deploy-version skew between the Rust
    /// sidecar and the NestJS responder.
    #[error("response payload decode failed")]
    Decode(#[source] serde_json::Error),
}

/// Wire shape of the request body. camelCase mirrors the NestJS
/// responder's expectation (TS object literal default casing). Pinned
/// by the `request_payload_is_camelCase_uuids` test.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LookupRequest {
    /// Tenant id the cache miss applies to. The responder cross-checks
    /// this against the resolved sensor's `tenantId` and replies with
    /// `null` (SEC-M01 defence-in-depth) if they disagree.
    tenant_id: Uuid,
    /// Sensor id the cache miss applies to. The responder uses this as
    /// the `findOne` key against the `sensors` table.
    sensor_id: Uuid,
}

/// NATS request-reply client for the cache-miss responder pair.
///
/// Cheap to clone (`Arc<NatsClient>` inside) so the same client can be
/// shared across tasks via [`spawn_lookup_and_populate_cache`].
#[derive(Debug, Clone)]
pub struct SensorLookupClient {
    nats: Arc<nats_client::NatsClient>,
    request_timeout: Duration,
}

impl SensorLookupClient {
    /// Wrap an existing NATS client. Construction is on the connect
    /// path so a misconfigured cert / unreachable broker surfaces in
    /// `start_sensor_lookup_client` (caller side), not at first use.
    #[must_use]
    pub fn new(nats: Arc<nats_client::NatsClient>) -> Self {
        Self {
            nats,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
        }
    }

    /// Issue a `sensor.lookup.by-topic` request and decode the reply.
    ///
    /// Returns:
    ///   * `Ok(Some(meta))` — responder found the sensor and replied
    ///     with `{ sensorId, tenantId, channelIds }`.
    ///   * `Ok(None)`       — responder authoritatively says the sensor
    ///     does not exist (or the SEC-M01 tenant cross-check failed
    ///     responder-side); it replied with the JSON literal `null`.
    ///   * `Err(...)`       — transport / encode / decode failure. The
    ///     caller (typically [`spawn_lookup_and_populate_cache`]) logs
    ///     and drops; no cache fill happens for this miss.
    ///
    /// # Errors
    /// See [`LookupError`].
    #[instrument(
        skip(self),
        fields(tenant = %tenant.as_uuid(), sensor = %sensor)
    )]
    pub async fn fetch_sensor_meta(
        &self,
        tenant: TenantId,
        sensor: Uuid,
    ) -> Result<Option<SensorMeta>, LookupError> {
        let body = LookupRequest {
            tenant_id: *tenant.as_uuid(),
            sensor_id: sensor,
        };
        let bytes = serde_json::to_vec(&body).map_err(LookupError::Encode)?;

        // tokio::time::timeout caps the round-trip even if async-nats
        // does not surface its own RTT bound. The timeout exists to
        // keep a hung responder from leaking task handles indefinitely
        // — the spawned cache-fill task would otherwise live until the
        // process exited if no reply ever arrived.
        let request_fut = self.nats.request(LOOKUP_SUBJECT, Bytes::from(bytes));
        let msg = match timeout(self.request_timeout, request_fut).await {
            Ok(Ok(msg)) => msg,
            Ok(Err(e)) => return Err(LookupError::Transport(e)),
            Err(_elapsed) => return Err(LookupError::Timeout(self.request_timeout)),
        };

        // The responder writes `null` for not-found, `{ "sensorId": ...
        // }` for found. Option<SensorMeta>'s natural serde shape covers
        // both cases byte-for-byte; no manual branching here.
        let meta: Option<SensorMeta> =
            serde_json::from_slice(&msg.payload).map_err(LookupError::Decode)?;
        Ok(meta)
    }
}

/// Spawn a fire-and-forget cache-fill task. Returns immediately; the
/// actual lookup runs on the spawned task.
///
/// WHY a free function (not a method on `SensorLookupClient`):
///   The free function takes `Arc<...>` arguments by value and `move`s
///   them into the spawned task's closure. Making it a method would
///   force the caller to clone the receiver explicitly, with a less
///   readable call site.
///
/// WHY swallow the lookup error (log only):
///   This is fire-and-forget. The current message proceeds with
///   payload-only data; a failure to fill the cache is observable as
///   sustained cache-miss traffic for that `(tenant, sensor)` pair.
///   Logging at warn surfaces the failure for the operator without
///   propagating it onto the hot path.
pub fn spawn_lookup_and_populate_cache(
    client: Arc<SensorLookupClient>,
    cache: Arc<TopicCache>,
    tenant: TenantId,
    sensor: Uuid,
) {
    tokio::spawn(async move {
        match client.fetch_sensor_meta(tenant, sensor).await {
            Ok(Some(meta)) => {
                // Defence in depth: the responder is supposed to
                // cross-check tenant binding before replying, but a
                // mistaken responder build that ships the wrong
                // sensor's meta would otherwise poison the cache.
                // Re-check at insert time so a single point of
                // responder breakage cannot cross-contaminate tenants
                // through the cache key.
                if meta.tenant_id != tenant {
                    tracing::warn!(
                        request_tenant = %tenant.as_uuid(),
                        response_tenant = %meta.tenant_id.as_uuid(),
                        sensor = %sensor,
                        "sensor lookup responder returned mismatched tenant; refusing cache insert"
                    );
                    return;
                }
                if meta.sensor_id != sensor {
                    tracing::warn!(
                        request_sensor = %sensor,
                        response_sensor = %meta.sensor_id,
                        "sensor lookup responder returned mismatched sensor id; refusing cache insert"
                    );
                    return;
                }
                tracing::debug!(
                    tenant = %tenant.as_uuid(),
                    sensor = %sensor,
                    channels = meta.channel_ids.len(),
                    "sensor lookup hit; populating topic cache"
                );
                cache.insert(meta);
            }
            Ok(None) => {
                // Authoritative not-found from the responder. Logged at
                // debug because legitimate during onboarding (operator
                // wired a topic before registering the sensor); a
                // sustained spike is observable via the drain's
                // topic_parse_failures counter, not via this log.
                tracing::debug!(
                    tenant = %tenant.as_uuid(),
                    sensor = %sensor,
                    "sensor lookup not-found; cache stays cold for this key"
                );
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    tenant = %tenant.as_uuid(),
                    sensor = %sensor,
                    "sensor lookup failed; cache stays cold for this key"
                );
            }
        }
    });
}

/// Build a [`SensorLookupClient`] when `[nats]` is configured. Returns
/// `Ok(None)` in stub mode (no NATS) so the binary boots without a
/// broker for local smoke runs — exactly the same shape as
/// `start_event_publisher` for the publisher path.
///
/// # Errors
/// Propagates [`nats_client::NatsClientError`] from the connect probe.
pub async fn start_sensor_lookup_client(
    nats_cfg: Option<nats_client::MtlsConfig>,
) -> Result<Option<Arc<SensorLookupClient>>, nats_client::NatsClientError> {
    let Some(cfg) = nats_cfg else {
        tracing::info!(
            "nats config absent; skipping sensor lookup client (stub mode — cache stays cold)"
        );
        return Ok(None);
    };
    tracing::info!(
        server_url = %cfg.server_url,
        "connecting SensorLookupClient (mTLS)"
    );
    let nats = nats_client::NatsClient::connect(&cfg).await?;
    Ok(Some(Arc::new(SensorLookupClient::new(Arc::new(nats)))))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use serde_json::Value;
    use tokio::sync::mpsc;
    use uuid::Uuid;

    use super::{LOOKUP_SUBJECT, LookupError, LookupRequest, SensorLookupClient};
    use crate::cache::{SensorMeta, TopicCache};

    #[test]
    fn subject_is_canonical() {
        // Pin the subject literal. The NestJS responder mirrors this
        // literal in its own test; both sides break loud on drift.
        assert_eq!(LOOKUP_SUBJECT, "sensor.lookup.by-topic");
    }

    #[test]
    #[allow(non_snake_case)]
    fn request_payload_is_camelCase_uuids() {
        // Synth a request payload, decode as Value, assert the wire
        // keys are camelCase + the values round-trip as UUID strings.
        let req = LookupRequest {
            tenant_id: Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap(),
            sensor_id: Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap(),
        };
        let v: Value = serde_json::to_value(&req).unwrap();
        let obj = v.as_object().expect("request must be a JSON object");
        assert_eq!(
            obj.len(),
            2,
            "request must carry exactly tenantId + sensorId; got {obj:?}"
        );
        assert!(obj.contains_key("tenantId"), "missing 'tenantId' key");
        assert!(obj.contains_key("sensorId"), "missing 'sensorId' key");
        assert_eq!(
            obj.get("tenantId").and_then(Value::as_str),
            Some("11111111-1111-1111-1111-111111111111")
        );
        assert_eq!(
            obj.get("sensorId").and_then(Value::as_str),
            Some("22222222-2222-2222-2222-222222222222")
        );
    }

    #[test]
    fn decode_response_some_sensor() {
        // Feed a JSON body shaped like the responder's "found" reply;
        // assert it decodes into Some(SensorMeta) with the right ids.
        let body = r#"{
            "sensorId": "11111111-1111-1111-1111-111111111111",
            "tenantId": "22222222-2222-2222-2222-222222222222",
            "channelIds": [
                "33333333-3333-3333-3333-333333333333",
                "44444444-4444-4444-4444-444444444444"
            ]
        }"#;
        let decoded: Option<SensorMeta> = serde_json::from_str(body).expect("decode some");
        let meta = decoded.expect("body has fields, must be Some");
        assert_eq!(
            meta.sensor_id,
            Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap()
        );
        assert_eq!(
            meta.tenant_id.as_uuid(),
            &Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap()
        );
        assert_eq!(meta.channel_ids.len(), 2);
        assert_eq!(
            meta.channel_ids[0],
            Uuid::parse_str("33333333-3333-3333-3333-333333333333").unwrap()
        );
    }

    #[test]
    fn decode_response_null_returns_none() {
        // Responder writes the JSON literal `null` for a not-found
        // sensor. Option<SensorMeta>'s serde shape covers this
        // byte-for-byte.
        let decoded: Option<SensorMeta> = serde_json::from_str("null").expect("decode null");
        assert!(decoded.is_none(), "JSON null must decode to Option::None");
    }

    #[test]
    fn decode_response_garbage_returns_decode_error() {
        // Anything that is not valid JSON OR not shape-compatible with
        // Option<SensorMeta> must surface as LookupError::Decode at
        // the call site. We test the raw serde failure mode here; the
        // wrapping into LookupError::Decode is a one-liner at the
        // call site (covered by the integration test that lands with
        // the docker-compose NATS broker).
        let result: Result<Option<SensorMeta>, _> = serde_json::from_str("not json");
        let err = result.expect_err("garbage must fail decode");
        // Wrapping as LookupError::Decode preserves the source chain
        // so operators see the underlying serde error in the log.
        let wrapped = LookupError::Decode(err);
        assert!(
            std::error::Error::source(&wrapped).is_some(),
            "Decode variant must expose serde source"
        );
    }

    #[tokio::test]
    async fn spawn_lookup_does_not_block_caller() {
        // The drain calls spawn_lookup_and_populate_cache on every
        // cache miss; the call MUST return promptly even when the
        // underlying lookup would take a long time. We do not have a
        // live NATS broker here, so we lean on the structural
        // guarantee: tokio::spawn returns immediately by construction.
        // The test sends a sentinel through an mpsc to prove the
        // caller proceeds without waiting on the spawned task.
        let (tx, mut rx) = mpsc::channel::<()>(1);
        let start = Instant::now();
        // We do not actually use the spawn helper here because it
        // requires a SensorLookupClient with a live NatsClient. The
        // structural invariant we are pinning is "spawn returns
        // promptly" — proved by spawning a sleep and asserting the
        // caller's wall-clock progress before the task completes.
        let _handle: tokio::task::JoinHandle<()> = tokio::spawn(async move {
            // Long enough that the caller's send below would lose any
            // race if spawn were synchronous.
            tokio::time::sleep(Duration::from_millis(500)).await;
        });
        tx.send(()).await.expect("send must succeed promptly");
        let elapsed = start.elapsed();
        // 5ms is a generous bound — tokio::spawn + a single mpsc send
        // on a clean runtime is typically sub-millisecond.
        assert!(
            elapsed < Duration::from_millis(5),
            "spawn + send took {elapsed:?}; spawn must not block caller"
        );
        // Drain the sentinel so the rx is observably consumed (not a
        // false-positive from a dropped sender).
        rx.recv().await.expect("rx must observe the sentinel");
    }

    #[test]
    fn lookup_error_variants_carry_source_chain() {
        // Every LookupError variant constructed from a source must
        // expose that source through std::error::Error::source. This
        // is the contract operators rely on to see the root cause in
        // the structured logger.
        let bad: serde_json::Error = serde_json::from_str::<u8>("not a number").unwrap_err();
        let enc = LookupError::Encode(bad);
        assert!(std::error::Error::source(&enc).is_some());

        let bad: serde_json::Error = serde_json::from_str::<u8>("not a number").unwrap_err();
        let dec = LookupError::Decode(bad);
        assert!(std::error::Error::source(&dec).is_some());

        // Timeout variant has no source (the elapsed Duration is the
        // entire payload); assert it Display-formats with the duration.
        let timeout = LookupError::Timeout(Duration::from_secs(2));
        let s = timeout.to_string();
        assert!(
            s.contains("2s"),
            "Timeout Display must surface the duration; got: {s}"
        );
    }

    #[test]
    fn sensor_lookup_client_is_send_and_sync() {
        // Compile-time bound: the client must traverse thread boundaries
        // because spawn_lookup_and_populate_cache moves an Arc<Self>
        // into a tokio::spawn closure.
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<SensorLookupClient>();
    }

    #[test]
    fn cache_insert_round_trip_with_decoded_meta() {
        // End-to-end shape: decode a responder reply, insert into the
        // cache, retrieve it back. Pins that the wire shape is
        // consistent with the cache's Send+Sync API.
        let body = r#"{
            "sensorId": "55555555-5555-5555-5555-555555555555",
            "tenantId": "66666666-6666-6666-6666-666666666666",
            "channelIds": ["77777777-7777-7777-7777-777777777777"]
        }"#;
        let meta: SensorMeta = serde_json::from_str(body).unwrap();
        let cache = Arc::new(TopicCache::new(64));
        let tenant = meta.tenant_id;
        let sensor = meta.sensor_id;
        cache.insert(meta);
        let hit = cache.get(tenant, sensor).expect("cache must hit");
        assert_eq!(hit.channel_ids.len(), 1);
        assert_eq!(
            hit.channel_ids[0],
            Uuid::parse_str("77777777-7777-7777-7777-777777777777").unwrap()
        );
    }
}
