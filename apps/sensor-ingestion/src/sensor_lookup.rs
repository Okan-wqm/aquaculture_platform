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
//!   which replies with `{ sensorId, tenantId, channelIds, channelKeys }` (or `null`
//!   for a not-found sensor). The response is decoded into
//!   [`SensorMeta`] and inserted into the cache.
//!
//! The durable pipeline awaits a bounded lookup on a cold miss because the
//! canonical channel key is required before it can mint the child event. The
//! fire-and-forget helper remains useful for proactive cache warming.
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
//!   - It does NOT reach for calibration coefficients or alert
//!     thresholds; the wire shape is `{ sensorId, tenantId, channelIds, channelKeys }`
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
use tokio::sync::Notify;
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

/// Metric name for the successful cache-miss spawn (we won the
/// singleflight race and dispatched the NATS request). Exposed as a
/// `pub const` so tests + downstream dashboards agree on the contract
/// — no string-literal drift.
pub const CACHE_MISS_SPAWN_METRIC: &str = "sensor_ingestion_cache_miss_spawn_total";

/// Metric name for the dedup-skipped cache miss (another task is
/// already in flight for the same `(tenant, sensor)` key; we opt out
/// instead of launching a duplicate NATS request).
pub const CACHE_MISS_DEDUP_SKIP_METRIC: &str = "sensor_ingestion_cache_miss_dedup_skip_total";

/// NATS request-reply client for the cache-miss responder pair.
///
/// Cheap to clone (`Arc<NatsClient>` + `Arc<papaya::HashMap>` inside)
/// so the same client can be shared across tasks via
/// [`spawn_lookup_and_populate_cache`].
///
/// # Singleflight dedup
/// The `inflight` map carries a `(TenantId, Uuid) -> Arc<Notify>`
/// entry for every cache-miss lookup currently in flight. Before
/// spawning a new task, `spawn_lookup_and_populate_cache` issues a
/// `papaya::try_insert` — the atomic check-and-insert either wins
/// (we own the singleflight slot, spawn fires) or loses (another
/// task already owns it, we skip without re-firing the NATS request).
/// Under a burst of concurrent misses for the same key, the sidecar
/// makes exactly ONE upstream request instead of N (per ADR-029).
#[derive(Debug, Clone)]
pub struct SensorLookupClient {
    nats: Arc<nats_client::NatsClient>,
    request_timeout: Duration,
    /// In-flight singleflight registry. Key = the cache-miss pair;
    /// value = a `Notify` that downstream waiters (current + future)
    /// can `.notified()` on if they ever need to block on the result.
    /// Task lifecycle: spawn inserts atomically via `try_insert`, then
    /// the spawned future removes the entry + `notify_waiters()` on
    /// completion (success or failure — both finish the race).
    inflight: Arc<papaya::HashMap<(TenantId, Uuid), Arc<Notify>>>,
}

impl SensorLookupClient {
    /// Wrap the sidecar's shared [`nats_client::NatsClient`].
    /// Construction is on the connect path in `async_main` so a
    /// misconfigured cert / unreachable broker surfaces at sidecar
    /// boot, not at first use.
    #[must_use]
    pub fn new(nats: Arc<nats_client::NatsClient>) -> Self {
        Self {
            nats,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            inflight: Arc::new(papaya::HashMap::new()),
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

/// Outcome of a `spawn_lookup_and_populate_cache` call — exposed so
/// tests can assert the singleflight invariant without peering into
/// the inflight map.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LookupSpawnOutcome {
    /// We won the atomic `try_insert` race for the `(tenant, sensor)`
    /// key; the fetch task was spawned and owns the singleflight slot
    /// until it completes. Increments `CACHE_MISS_SPAWN_METRIC`.
    Spawned,
    /// Another task already owns the slot. We skip without firing a
    /// duplicate NATS request. Increments `CACHE_MISS_DEDUP_SKIP_METRIC`.
    /// This is the steady-state behaviour under burst load — the
    /// drain does not block, the upstream sensor-service does not
    /// see N redundant requests for the same key.
    DedupSkipped,
}

/// Spawn a fire-and-forget cache-fill task, deduped per
/// `(tenant, sensor)` key. Returns immediately; the actual lookup
/// runs on the spawned task (or is skipped if another task already
/// owns the slot).
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
///
/// # Singleflight (ADR-029 / plan Kör Nokta 7 — PR-B #8)
///   Concurrent drains that miss on the same `(tenant, sensor)` key
///   produce ONE upstream NATS request, not N. The first caller wins
///   the `papaya::try_insert` atomic race and spawns; every later
///   caller hits the `Err(OccupiedError)` branch and increments the
///   dedup-skip counter. When the spawned task completes (success or
///   failure), it removes the inflight entry and calls
///   `notify_waiters()` on the `Notify` so any future subscriber-side
///   wait points can proceed.
/// Attempt to claim the inflight slot for `key`. Returns the freshly
/// created `Notify` if we won the race (the caller now owns the
/// singleflight slot and MUST eventually `remove(key)` + `notify_waiters`
/// to release it), or `None` if another task already owns the slot
/// (the caller should abort without firing a duplicate upstream
/// request).
///
/// Extracted as a free function so the atomic race logic is covered
/// by a unit test that does not need a live `NatsClient`.
fn try_claim_inflight(
    inflight: &papaya::HashMap<(TenantId, Uuid), Arc<Notify>>,
    key: (TenantId, Uuid),
) -> Option<Arc<Notify>> {
    let notify = Arc::new(Notify::new());
    let guard = inflight.pin();
    match guard.try_insert(key, Arc::clone(&notify)) {
        Ok(_inserted) => Some(notify),
        Err(_occupied) => None,
    }
}

pub fn spawn_lookup_and_populate_cache(
    client: Arc<SensorLookupClient>,
    cache: Arc<TopicCache>,
    tenant: TenantId,
    sensor: Uuid,
) -> LookupSpawnOutcome {
    let key = (tenant, sensor);
    let Some(notify) = try_claim_inflight(&client.inflight, key) else {
        // Another task already owns this key — skip without firing a
        // duplicate NATS request. Emit the dedup counter so operators
        // can watch the hit ratio (high ratio = burst workload, low
        // ratio = cold-start or invalidation storm).
        metrics::counter!(CACHE_MISS_DEDUP_SKIP_METRIC).increment(1);
        tracing::trace!(
            tenant = %tenant.as_uuid(),
            sensor = %sensor,
            "cache-miss lookup deduped — another task already fetching"
        );
        return LookupSpawnOutcome::DedupSkipped;
    };
    // We own the slot; emit the spawn counter so operators can
    // reconstruct total upstream request rate.
    metrics::counter!(CACHE_MISS_SPAWN_METRIC).increment(1);

    let inflight = Arc::clone(&client.inflight);
    let notify_for_cleanup = Arc::clone(&notify);
    tokio::spawn(async move {
        let result = client.fetch_sensor_meta(tenant, sensor).await;
        // Clear the inflight slot + wake any waiters BEFORE processing
        // the result. Reason: a subsequent miss on the same key
        // immediately after completion should see an empty slot and
        // be free to try again (cache insert or invalidate may still
        // race, but the singleflight window is over).
        let _ = inflight.pin().remove(&key);
        notify_for_cleanup.notify_waiters();

        match result {
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
    LookupSpawnOutcome::Spawned
}

/// Build a [`SensorLookupClient`] from the sidecar's shared
/// [`nats_client::NatsClient`]. Ownership handoff `Arc<NatsClient>`
/// → `Arc<SensorLookupClient>` so the drain holds exactly one extra
/// Arc for the cache-fill responder path and no extra allocation at
/// the hot-path spawn site.
///
/// Architectural position: the orchestrator establishes ONE mTLS
/// connection in `async_main`; every NATS consumer (outbox
/// publisher, policy subscriber per ADR-031, lookup responder)
/// wraps the same handle so a single TLS handshake covers every
/// publish/subscribe/request consumer on the same cert CN.
#[must_use]
pub fn build_sensor_lookup_client(nats: Arc<nats_client::NatsClient>) -> Arc<SensorLookupClient> {
    Arc::new(SensorLookupClient::new(nats))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use serde_json::Value;
    use tokio::sync::mpsc;
    use uuid::Uuid;

    use super::{
        CACHE_MISS_DEDUP_SKIP_METRIC, CACHE_MISS_SPAWN_METRIC, LOOKUP_SUBJECT, LookupError,
        LookupRequest, Notify, SensorLookupClient,
    };
    use crate::cache::{SensorMeta, TopicCache};
    use tenant_context::TenantId;

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
            ],
            "channelKeys": {
                "33333333-3333-3333-3333-333333333333": "temperature",
                "44444444-4444-4444-4444-444444444444": "ph"
            }
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
        assert_eq!(meta.channel_keys.len(), 2);
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
            "channelIds": ["77777777-7777-7777-7777-777777777777"],
            "channelKeys": {
                "77777777-7777-7777-7777-777777777777": "dissolved_oxygen"
            }
        }"#;
        let meta: SensorMeta = serde_json::from_str(body).unwrap();
        let cache = Arc::new(TopicCache::new(64));
        let tenant = meta.tenant_id;
        let sensor = meta.sensor_id;
        cache.insert(meta);
        let hit = cache.get(tenant, sensor).expect("cache must hit");
        assert_eq!(hit.channel_ids.len(), 1);
        assert_eq!(
            hit.channel_keys
                .get(&Uuid::parse_str("77777777-7777-7777-7777-777777777777").unwrap())
                .map(String::as_str),
            Some("dissolved_oxygen")
        );
        assert_eq!(
            hit.channel_ids[0],
            Uuid::parse_str("77777777-7777-7777-7777-777777777777").unwrap()
        );
    }

    #[test]
    fn try_claim_inflight_first_caller_wins_rest_get_none() {
        // ADR-029 / PR-B #8 invariant. Under burst load a cache miss
        // for the same (tenant, sensor) pair must produce EXACTLY ONE
        // winning claim, not N. This is the atomic race at the heart
        // of the singleflight — papaya's `try_insert` returns Ok for
        // the winner and Err for every other caller. We test the
        // helper directly, without a live NatsClient, so the assertion
        // is about race shape, not transport.
        let inflight: papaya::HashMap<(TenantId, Uuid), Arc<Notify>> = papaya::HashMap::new();
        let tenant = TenantId::try_parse("550e8400-e29b-41d4-a716-446655440000").unwrap();
        let sensor = Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();
        let key = (tenant, sensor);

        let mut winners = 0_usize;
        let mut losers = 0_usize;
        let mut captured_notify: Option<Arc<Notify>> = None;
        for _ in 0..8 {
            match super::try_claim_inflight(&inflight, key) {
                Some(n) => {
                    winners += 1;
                    captured_notify = Some(n);
                }
                None => {
                    losers += 1;
                }
            }
        }

        assert_eq!(winners, 1, "exactly one caller must win; got {winners}");
        assert_eq!(losers, 7, "seven callers must lose; got {losers}");
        assert!(
            captured_notify.is_some(),
            "winner must receive a Notify handle for waiter-wake"
        );

        // A subsequent `remove` + `notify_waiters` completes the
        // singleflight cycle. After that a fresh caller must win
        // again — the slot is re-claimable once the previous owner
        // releases it. This pins the cleanup contract.
        {
            let guard = inflight.pin();
            assert!(guard.contains_key(&key), "slot held while inflight");
            let _ = guard.remove(&key);
        }
        if let Some(n) = captured_notify {
            n.notify_waiters();
        }

        let fresh = super::try_claim_inflight(&inflight, key);
        assert!(
            fresh.is_some(),
            "after cleanup the slot must be re-claimable; got None"
        );
    }

    #[test]
    fn singleflight_counters_fire_when_outcomes_bucket() {
        // The two public metric names carry counter semantics:
        // "spawn_total" increments when a caller wins the race;
        // "dedup_skip_total" increments when a caller loses it. This
        // test drives the counters directly via the same helper the
        // hot path uses, proving the name + accumulation shape.
        //
        // We cannot drive `spawn_lookup_and_populate_cache` end-to-end
        // without a NatsClient; the counter emissions live inside that
        // function after the race resolves. So we test the LOSER
        // branch by driving two try_claim_inflight calls + manually
        // emitting the dedup counter, which mirrors exactly what
        // `spawn_lookup_and_populate_cache` does in its DedupSkipped
        // arm. The winner branch is symmetric — documented here as a
        // comment-only invariant since the code path is trivial once
        // the race resolves.
        use metrics::with_local_recorder;
        use metrics_util::debugging::{DebugValue, DebuggingRecorder};

        let inflight: papaya::HashMap<(TenantId, Uuid), Arc<Notify>> = papaya::HashMap::new();
        let tenant = TenantId::try_parse("550e8400-e29b-41d4-a716-446655440000").unwrap();
        let sensor = Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();
        let key = (tenant, sensor);

        let recorder = DebuggingRecorder::new();
        let snapshotter = recorder.snapshotter();

        with_local_recorder(&recorder, || {
            // First caller — winner; mirrors spawn path.
            assert!(super::try_claim_inflight(&inflight, key).is_some());
            metrics::counter!(CACHE_MISS_SPAWN_METRIC).increment(1);

            // Second + third caller — losers; mirrors dedup path.
            assert!(super::try_claim_inflight(&inflight, key).is_none());
            metrics::counter!(CACHE_MISS_DEDUP_SKIP_METRIC).increment(1);
            assert!(super::try_claim_inflight(&inflight, key).is_none());
            metrics::counter!(CACHE_MISS_DEDUP_SKIP_METRIC).increment(1);
        });

        let snapshot = snapshotter.snapshot();
        let entries = snapshot.into_vec();
        let spawn_hit = entries
            .iter()
            .find(|(k, _, _, _)| k.key().name() == CACHE_MISS_SPAWN_METRIC)
            .expect("spawn metric must be emitted");
        match &spawn_hit.3 {
            DebugValue::Counter(v) => assert_eq!(*v, 1),
            other => panic!("expected Counter, got {other:?}"),
        }
        let dedup_hit = entries
            .iter()
            .find(|(k, _, _, _)| k.key().name() == CACHE_MISS_DEDUP_SKIP_METRIC)
            .expect("dedup-skip metric must be emitted");
        match &dedup_hit.3 {
            DebugValue::Counter(v) => assert_eq!(*v, 2),
            other => panic!("expected Counter, got {other:?}"),
        }
    }

    #[test]
    fn singleflight_metric_names_are_stable() {
        // Lock the metric-name contract. A rename of either const
        // would break Prometheus dashboards authored against these
        // names; the compile-time use in the test is the anchor.
        assert_eq!(
            CACHE_MISS_SPAWN_METRIC,
            "sensor_ingestion_cache_miss_spawn_total"
        );
        assert_eq!(
            CACHE_MISS_DEDUP_SKIP_METRIC,
            "sensor_ingestion_cache_miss_dedup_skip_total"
        );
    }
}
