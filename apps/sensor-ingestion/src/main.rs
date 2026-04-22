//! `sensor-ingestion` — Rust sidecar for the sensor-service ingestion
//! hot path.
//!
//! WHY this binary exists:
//!   ADR-025 establishes that NestJS `sensor-service` keeps its
//!   control plane (CRUD, GraphQL, batch processor, hypertable +
//!   continuous-aggregate management) but the ingestion data plane
//!   moves to Rust because the V8 / GC / `INSERT VALUES` ceiling
//!   sits well below the multi-tenant target. This binary is that
//!   sidecar. Per-tenant feature flag (`INGEST_BACKEND=rust|node`)
//!   gates the rollout; both backends share the same MQTT broker and
//!   the same TimescaleDB.
//!
//! WHAT lives here at this stage:
//!   - Config loader (TOML file + env-var override).
//!   - Custom-tuned tokio runtime per the plan
//!     (`docs/plans/sensor-rust-migration/PLAN.md` § Faz 2 Tokio
//!     Runtime Tuning): worker_threads = 2, blocking pool 8, no
//!     spawn_blocking on hot path, LIFO slot enabled.
//!   - Observability init via the workspace `observability` crate.
//!   - Stub main loop that logs "started" and waits for SIGTERM.
//!
//! WHAT lands in subsequent commits on this same PR:
//!   - MQTT subscribe loop (rumqttc).
//!   - Topic parse + tenant resolution (papaya cache).
//!   - Payload validate (protocol-codec PDU decoders + topic↔payload
//!     tenantId enforcement).
//!   - Batch aggregator + tokio-postgres COPY pipeline.
//!   - NATS event publish (event-contracts-rs once codegen lands).

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

use std::process::ExitCode;
use std::sync::Arc;

use anyhow::Context;

use crate::cache::{DEFAULT_TOTAL_CAPACITY, TopicCache};
use crate::config::Config;
use crate::runtime::build_runtime;

mod batch;
mod cache;
mod config;
mod error;
mod events;
mod ingest_backend;
mod mqtt;
mod payload;
mod persistence;
mod runtime;
mod sensor_lookup;
mod topic;

// Bootstrap exists in a window where `tracing` is not yet installed
// and there is no other reporting channel. Allow `eprintln!` for the
// few lines that have to surface a config-load or tracing-init error
// to the operator before the structured logger exists. The allow is
// scoped tight to `main` so subsequent code (which runs after
// tracing is up) keeps the workspace `print_stderr = "deny"` posture.
#[allow(clippy::print_stderr)]
fn main() -> ExitCode {
    // Bootstrap is intentionally synchronous: load config, install
    // tracing, build the runtime, then hand off to async main. Any
    // failure before `runtime.block_on` is a configuration problem
    // and must surface at process start, not deep inside an async
    // task that the operator never sees.
    let cfg = match Config::load_from_env_or_default() {
        Ok(cfg) => cfg,
        Err(e) => {
            // tracing is not yet installed — go to stderr directly.
            eprintln!("[sensor-ingestion] config load failed: {e:#}");
            return ExitCode::from(2);
        }
    };

    if let Err(e) = observability::init_tracing(&cfg.observability) {
        eprintln!("[sensor-ingestion] tracing init failed: {e}");
        return ExitCode::from(3);
    }

    tracing::info!(
        worker_threads = cfg.runtime.worker_threads,
        max_blocking = cfg.runtime.max_blocking_threads,
        thread_stack_kb = cfg.runtime.thread_stack_kb,
        "starting sensor-ingestion"
    );

    let runtime = match build_runtime(&cfg.runtime).context("building tokio runtime") {
        Ok(rt) => rt,
        Err(e) => {
            tracing::error!(error = ?e, "tokio runtime construction failed");
            return ExitCode::from(4);
        }
    };

    let result = runtime.block_on(async_main(cfg));
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!(error = ?e, "sensor-ingestion exited with error");
            ExitCode::from(1)
        }
    }
}

async fn async_main(cfg: Config) -> anyhow::Result<()> {
    // Install the Prometheus recorder BEFORE any emitter fires — see
    // `start_metrics_recorder` docstring for the ordering rationale.
    let _metrics_handle = start_metrics_recorder(&cfg.metrics)?;

    // The tenant/sensor topic-cache is process-wide singleton state.
    // Build it before any stream runs so a future cache-miss handler
    // can hand the same `Arc<TopicCache>` to every parser worker.
    // Capacity defaults to the plan number (100K) until config
    // surfaces a per-deploy override; the override knob lands in the
    // batch-aggregator commit on this same PR.
    let cache = Arc::new(TopicCache::new(DEFAULT_TOTAL_CAPACITY));
    tracing::info!(
        cache_total_capacity = DEFAULT_TOTAL_CAPACITY,
        cache_per_tenant_capacity = cache.per_tenant_capacity(),
        cache_initial_len = cache.len(),
        "topic cache constructed"
    );
    // Exercise the cache's public surface (insert -> get -> invalidate
    // -> invalidate_tenant) at process start as a self-smoke check.
    // The full lookup pipeline that calls these methods at message
    // rate lands in the next commit on this PR; running them once here
    // proves the cache layer is wired correctly on this build before
    // any traffic arrives, AND keeps the binary's dead-code lint
    // honest about every surface the topic-parser stage will reach
    // for. The smoke key is a fixed nil-tenant + nil-sensor and is
    // removed before the loop begins, so the cache's observable state
    // post-bootstrap is exactly len = 0.
    cache::self_smoke_check(&cache);
    debug_assert!(
        cache.is_empty(),
        "cache must be empty after self-smoke teardown"
    );
    // If the config names an MQTT broker, start the subscriber task
    // so the entire chain is exercised end-to-end. Downstream stages
    // (topic parser, payload validator, batch aggregator, COPY
    // pipeline) are wired onto this receiver in subsequent commits
    // on this PR; until they land we log-and-drop so the module is
    // live at runtime and the dead-code lint cannot hide a typo.
    let mqtt_stream = if let Some(mqtt_cfg) = cfg.mqtt.clone() {
        tracing::info!(
            broker = %mqtt_cfg.broker_url,
            filters = ?mqtt_cfg.topic_filters,
            "starting mqtt subscriber"
        );
        Some(
            mqtt::start(mqtt_cfg)
                .await
                .context("starting mqtt subscriber")?,
        )
    } else {
        tracing::info!("mqtt config absent; skipping subscriber (stub mode)");
        None
    };

    // Split the stream into an Arc<Mutex<Option<...>>> so both the
    // drain task and the signal-handler path can reach it. The signal
    // path needs ownership to call shutdown(); the drain path needs
    // &mut for recv(). The Mutex mediates the handoff.
    let stream_slot = std::sync::Arc::new(tokio::sync::Mutex::new(mqtt_stream));
    let drain_slot = stream_slot.clone();
    let shutdown_slot = stream_slot;
    // Hand the cache to the drain path so the topic-cache module is
    // exercised at runtime end-to-end.
    let drain_cache = Arc::clone(&cache);

    // Stage 9 + 11: batch aggregator + persistence sink wired in via
    //   `start_persistence_pipeline`. Helper extracted to keep
    //   async_main inside the workspace cognitive-complexity / line
    //   budget; the helper owns the construct + spawn sequence as a
    //   single unit, mirroring the events-side `start_event_publisher`.
    let PersistencePipelineBundle {
        batch_in_tx,
        batch_cancel,
        aggregator_handle,
        sink_handle,
    } = start_persistence_pipeline(cfg.postgres.clone()).await?;

    // Stage 12: NATS event publisher (extracted into `start_event_publisher`
    //   to keep async_main inside the workspace cognitive-complexity +
    //   line budget; the helper owns the connect + boot-smoke + spawn
    //   sequence as a single unit).
    let EventPublisherBundle {
        events_in_tx,
        publisher_handle,
    } = start_event_publisher(cfg.nats.clone()).await?;

    // Faz 3 follow-on: cache-miss responder client. Builds an mTLS
    // NatsClient when [nats] is configured; returns None in stub mode
    // so the binary still boots without a broker for local smoke runs
    // (cache stays cold in that mode — exactly the previous behaviour).
    // The drain holds an `Option<Arc<SensorLookupClient>>` and only
    // fires the fire-and-forget cache-fill helper when Some.
    let lookup_client = sensor_lookup::start_sensor_lookup_client(cfg.nats.clone())
        .await
        .context("starting sensor lookup client")?;

    // Stage 13: per-tenant IngestBackend policy. Built from the
    //   `[ingest_backend]` TOML section (defaults to "every tenant on
    //   Node" when the section is absent — safe rollout). The drain
    //   loop holds an Arc<dyn IngestBackendPolicy> so the eventual
    //   swap to a NATS-served dynamic policy in Faz 3 is mechanical.
    let policy: Arc<dyn ingest_backend::IngestBackendPolicy> = Arc::new(
        ingest_backend::StaticBackendPolicy::from_config(&cfg.ingest_backend),
    );
    tracing::info!(
        default_backend = ?cfg.ingest_backend.default_backend,
        tenant_overrides = cfg.ingest_backend.tenant_overrides.len(),
        "ingest backend policy constructed"
    );

    tokio::select! {
        () = wait_for_shutdown_signal() => {
            tracing::info!("shutdown signal received, closing mqtt subscriber");
            let taken = shutdown_slot.lock().await.take();
            if let Some(s) = taken {
                s.shutdown().await;
            }
        }
        () = drain_mqtt_stream(
            drain_slot,
            drain_cache,
            batch_in_tx.clone(),
            events_in_tx.clone(),
            policy,
            lookup_client.clone(),
        ) => {
            tracing::info!("mqtt stream closed");
        }
    }
    // Drop the input sender so the aggregator drains its remaining
    // buffer and exits cleanly; cancel as a belt-and-braces.
    drop(batch_in_tx);
    batch_cancel.cancel();
    let _ = aggregator_handle.await;
    let _ = sink_handle.await;
    // Drop the event-channel sender so run_publisher_loop sees the
    // channel close and exits. The drain holds a clone of `events_in_tx`
    // (Faz 3 stage 1 wiring); the clone the drain holds is dropped when
    // the drain future returns from `select!`, leaving this `drop` as
    // the LAST sender — guaranteeing the publisher loop terminates
    // before `publisher_handle.await` below.
    drop(events_in_tx);
    let _ = publisher_handle.await;
    // Surface the post-shutdown cache footprint in the log so an
    // operator can correlate cache fill with broker traffic. The
    // explicit reference also keeps the cache alive past the select!
    // suspension point — the compiler would otherwise be free to drop
    // it as soon as it sees the last use.
    tracing::info!(
        cache_final_len = cache.len(),
        "topic cache state at shutdown"
    );
    Ok(())
}

/// What [`start_persistence_pipeline`] hands back to `async_main`:
/// the sender the drain pipeline pushes validated readings into, the
/// cancellation token + join handles for orderly shutdown.
struct PersistencePipelineBundle {
    batch_in_tx: tokio::sync::mpsc::Sender<crate::payload::SensorReading>,
    batch_cancel: tokio_util::sync::CancellationToken,
    aggregator_handle: tokio::task::JoinHandle<()>,
    sink_handle: tokio::task::JoinHandle<()>,
}

/// Construct the batch aggregator, choose the persistence sink
/// (`PostgresSink` when `[postgres]` is configured; `LoggingSink`
/// Install the Prometheus recorder at boot. Separate helper so
/// `async_main` stays within the workspace's cognitive-complexity
/// ceiling — every subsystem owns its own boot helper and the orchestrator
/// only wires them together.
///
/// WHY this runs BEFORE the cache + MQTT subscriber:
///   Every downstream stage (sink, cache, outbox) emits metric counts
///   on the very first batch it processes. Installing the recorder
///   after the first emission would drop those early data points
///   into the no-op recorder; operators would see the gauge climb
///   from zero at T+tick-interval rather than T+0, hiding a cold-
///   start spike.
///
/// `init_metrics` is a no-op when `cfg.enabled = false`, so stub-
/// mode boots (no `[metrics]` block in config.toml) stay silent
/// without branching at the call site. The returned handle exposes
/// `render()` for programmatic scrape and is the surface a future
/// custom HTTP endpoint would reach for; when `bind_addr` is Some,
/// `init_metrics` spawns the `/metrics` listener on that socket.
fn start_metrics_recorder(
    cfg: &observability::MetricsOpts,
) -> anyhow::Result<Option<observability::PrometheusHandle>> {
    let handle =
        observability::init_metrics(cfg).context("initialising prometheus metrics exporter")?;
    if cfg.enabled {
        tracing::info!(
            bind_addr = ?cfg.bind_addr,
            "prometheus metrics recorder installed"
        );
    }
    Ok(handle)
}

/// otherwise), and spawn both loops.
///
/// WHY a helper:
///   Mirrors [`start_event_publisher`]; both extractions keep
///   `async_main` inside the workspace cognitive-complexity / line
///   budget. Each subsystem owns its own boot helper so a future
///   change to the persistence wiring does not balloon `async_main`.
async fn start_persistence_pipeline(
    pg_cfg: Option<persistence::PostgresConfig>,
) -> anyhow::Result<PersistencePipelineBundle> {
    let batch_cancel = tokio_util::sync::CancellationToken::new();
    let (aggregator, batch_in_tx, batch_out_rx) = batch::BatchAggregator::new(
        batch::BatchOpts::default(),
        batch::DEFAULT_INPUT_CHANNEL_CAPACITY,
        batch::DEFAULT_OUTPUT_CHANNEL_CAPACITY,
    )
    .context("constructing batch aggregator")?;
    let batch_cancel_for_run = batch_cancel.clone();
    let aggregator_handle = tokio::spawn(async move {
        match aggregator.run(batch_cancel_for_run).await {
            Ok(count) => tracing::info!(count, "batch aggregator exited"),
            Err(e) => tracing::error!(error = %e, "batch aggregator exited with error"),
        }
    });
    let sink: Arc<dyn persistence::BatchSink> = if let Some(cfg) = pg_cfg {
        tracing::info!(
            host = %cfg.host,
            port = cfg.port,
            db = %cfg.db_name,
            "connecting PostgresSink"
        );
        Arc::new(
            persistence::PostgresSink::connect(&cfg)
                .await
                .context("connecting PostgresSink")?,
        )
    } else {
        tracing::info!("postgres config absent; falling back to LoggingSink");
        Arc::new(persistence::LoggingSink::new())
    };
    let sink_handle = tokio::spawn(persistence::run_sink_loop(sink, batch_out_rx));
    Ok(PersistencePipelineBundle {
        batch_in_tx,
        batch_cancel,
        aggregator_handle,
        sink_handle,
    })
}

/// What [`start_event_publisher`] hands back to `async_main`: the
/// sender the drain pipeline pushes events into, plus the spawned
/// publisher-loop join handle. Bundled into a struct so the call site
/// reads one line and the helper owns the full connect + smoke + spawn
/// sequence as a single unit (architectural cut: keep `async_main`
/// inside the workspace cognitive-complexity / line budget).
struct EventPublisherBundle {
    events_in_tx: tokio::sync::mpsc::Sender<event_contracts_rs::SensorMetricIngestedEvent>,
    publisher_handle: tokio::task::JoinHandle<()>,
}

/// Build the event publisher (NATS or logging fallback), run the
/// boot-time self-smoke, and spawn the publisher loop on the supplied
/// channel. Returns the live sender + join handle inside an
/// [`EventPublisherBundle`].
///
/// WHY a helper:
///   `async_main` is at the workspace's cognitive-complexity ceiling;
///   inlining the connect + smoke + spawn sequence would push it over
///   the budget. The helper owns one cohesive unit of work and is
///   independently testable at the unit level (the tests in
///   `events.rs` cover every code path this helper traverses).
async fn start_event_publisher(
    nats_cfg: Option<nats_client::MtlsConfig>,
) -> anyhow::Result<EventPublisherBundle> {
    // Bounded channel: 10K matches the batch aggregator's flush size
    // so a single batch worth of pending events fits without blocking
    // the producer side.
    let (events_in_tx, events_in_rx) =
        tokio::sync::mpsc::channel::<event_contracts_rs::SensorMetricIngestedEvent>(10_000);

    // Hold the logging handle separately so self_smoke_check can
    // observe + reset it without downcasting from `dyn EventPublisher`.
    let (publisher, logging_handle): (
        Arc<dyn events::EventPublisher>,
        Option<events::LoggingEventPublisher>,
    ) = if let Some(cfg) = nats_cfg {
        tracing::info!(
            server_url = %cfg.server_url,
            "connecting NatsEventPublisher (mTLS)"
        );
        let p = events::NatsEventPublisher::connect(&cfg)
            .await
            .context("connecting NatsEventPublisher")?;
        (Arc::new(p), None)
    } else {
        tracing::info!("nats config absent; falling back to LoggingEventPublisher");
        let logging = events::LoggingEventPublisher::new();
        (Arc::new(logging.clone()), Some(logging))
    };

    // Boot-time self-smoke: exercises the publisher path before any
    // traffic arrives so a deploy-time misconfiguration (bad cert,
    // wrong subject prefix, broken serializer wiring) surfaces at
    // start-up. Resets the LoggingEventPublisher counter to zero on
    // success so steady-state state is observably clean.
    events::self_smoke_check(&publisher, logging_handle.as_ref())
        .await
        .context("event publisher self-smoke check")?;

    let publisher_handle = {
        let publisher = Arc::clone(&publisher);
        tokio::spawn(events::run_publisher_loop(publisher, events_in_rx))
    };

    Ok(EventPublisherBundle {
        events_in_tx,
        publisher_handle,
    })
}

/// Cache-miss → fire-and-forget responder spawn. Returns `true` when a
/// spawn was issued (so the caller can bump its counter), `false`
/// otherwise. Extracted out of `drain_mqtt_stream` to keep that hot-
/// path function inside the workspace `clippy::too_many_lines = 100`
/// budget.
///
/// WHY a free function:
///   The helper holds no state; passing the dependencies in
///   explicitly keeps the call site easy to test and avoids growing
///   the drain's parameter list with a one-shot policy object.
fn maybe_spawn_cache_fill(
    cache_hit: bool,
    sensor_id: Option<uuid::Uuid>,
    tenant: tenant_context::TenantId,
    lookup_client: Option<&Arc<sensor_lookup::SensorLookupClient>>,
    cache: &Arc<TopicCache>,
) -> bool {
    if cache_hit {
        return false;
    }
    let (Some(sensor), Some(client)) = (sensor_id, lookup_client) else {
        return false;
    };
    // The outcome (Spawned vs. DedupSkipped) is a per-call
    // observability signal — the drain does not branch on it. The
    // singleflight metrics emitted by spawn_lookup_and_populate_cache
    // itself are the authoritative rate surface; the caller simply
    // returns `true` to mark that a lookup WAS driven for this miss.
    let _ = sensor_lookup::spawn_lookup_and_populate_cache(
        Arc::clone(client),
        Arc::clone(cache),
        tenant,
        sensor,
    );
    true
}

/// Aggregator-channel push: send the synthesised event to the
/// publisher channel AND the validated reading to the batch
/// aggregator. Returns `false` when the batch aggregator's channel is
/// closed (caller breaks the drain loop); returns `true` for the
/// healthy case OR when only the publisher channel is closed (drain
/// continues — persistence is the load-bearing path, publisher is
/// best-effort). Extracted to keep `drain_mqtt_stream` inside the
/// workspace `clippy::too_many_lines = 100` budget.
///
/// Faz 3 follow-on (enrichment): `cached_meta` is `Some` when the
/// drain's cache lookup hit. The published
/// [`event_contracts_rs::SensorMetricIngestedEvent`] carries
/// `farm_id` / `pond_id` populated from the cache when present —
/// downstream consumers (and the NestJS `NatsIngestionConsumerService`)
/// then use those values directly without their own DB roundtrip on
/// the warm-cache happy path. On a cache miss `cached_meta` is `None`
/// and both event fields stay `None`; the consumer falls back to its
/// own cache lookup (defence-in-depth + cold-path fallback).
async fn forward_validated_reading(
    reading: crate::payload::SensorReading,
    batch_in: &tokio::sync::mpsc::Sender<crate::payload::SensorReading>,
    events_in: &tokio::sync::mpsc::Sender<event_contracts_rs::SensorMetricIngestedEvent>,
    cached_meta: Option<&crate::cache::SensorMeta>,
) -> bool {
    // Faz 3 stage 1: synthesise the SensorMetricIngested event from
    // the validated reading BEFORE the batch send so the event-publish
    // channel observes every reading the persistence channel does.
    // The validator pinned tenant/sensor/channel ids; downstream
    // assertions can rely on TenantMismatch having been enforced.
    let mut ev = event_contracts_rs::SensorMetricIngestedEvent::new(
        *reading.tenant_id.as_uuid(),
        reading.sensor_id,
        reading.channel_id,
        reading.value,
        reading.quality,
        reading.producer_ts,
    );
    // Faz 3 follow-on (enrichment): copy farm_id / pond_id from the
    // warm cache onto the event. WHY here (not in `new()`):
    //   `SensorMetricIngestedEvent::new` keeps a payload-only
    //   signature — adding optional cache-derived fields to the
    //   constructor would force every existing caller (test code,
    //   future producers) to thread an Option<&SensorMeta> through.
    //   Mutating after construction keeps `new()` minimal AND keeps
    //   the cache-miss path a true no-op (the fields stay `None`).
    if let Some(meta) = cached_meta {
        // farm_id/pond_id on SensorMeta are themselves Option — copy
        // through so a sensor with a farm but no pond produces an
        // event with `farmId` set and `pondId` absent.
        ev.farm_id = meta.farm_id;
        ev.pond_id = meta.pond_id;
    }
    if events_in.send(ev).await.is_err() {
        // Publisher loop gone — log and continue; persistence still
        // works, control-plane alarms catch the publisher failure mode.
        tracing::warn!("event publisher gone; continuing without publish");
    }
    // Stage 9: hand the validated reading to the batch aggregator.
    // send().await blocks if the buffer is full, propagating backpressure
    // to the broker (MQTT QoS-1 inflight). A closed sender means the
    // aggregator exited — return false so the drain loop ends naturally.
    if batch_in.send(reading).await.is_err() {
        tracing::warn!("batch aggregator gone; ending drain loop");
        return false;
    }
    true
}

/// Faz 3 follow-on (channel-id validation): cache-warm gate.
///
/// Returns `true` when the message MUST be dropped (channel id is not
/// registered for the resolved sensor); `false` otherwise. Extracted
/// out of `drain_mqtt_stream` to keep that hot-path function inside
/// the workspace `clippy::too_many_lines = 100` budget.
///
/// Architectural-tier-1 invariant pinned by the function signature:
///   The validation runs ONLY when `cached_meta.is_some()`. A cache
///   MISS short-circuits to `false` (do not drop) — the cold path
///   keeps the previous "publish what the payload carries" semantic
///   and the NestJS consumer remains the validation backstop.
fn should_drop_unknown_channel(
    cached_meta: Option<&crate::cache::SensorMeta>,
    reading: &crate::payload::SensorReading,
    topic: &str,
    topic_tenant: tenant_context::TenantId,
) -> bool {
    let Some(meta) = cached_meta else {
        return false;
    };
    if meta.channel_ids.contains(&reading.channel_id) {
        return false;
    }
    tracing::warn!(
        topic = %topic,
        tenant = %topic_tenant.as_uuid(),
        sensor = %reading.sensor_id,
        channel = %reading.channel_id,
        known_channels = meta.channel_ids.len(),
        "mqtt msg references channel not registered for sensor (dropping; cache-warm gate)"
    );
    true
}

/// Per-message bookkeeping counters surfaced in the drain's tail log.
/// Extracted into a struct so [`drain_mqtt_stream`] can pass a single
/// `&mut` reference into the message-processing helper instead of a
/// long argument list — also keeps the drain inside the workspace
/// `clippy::too_many_lines = 100` budget.
#[derive(Debug, Default)]
struct DrainCounters {
    count: u64,
    topic_parse_failures: u64,
    node_routed_count: u64,
    cache_miss_lookup_spawn_count: u64,
    unknown_channel_count: u64,
}

/// Outcome of a single message's pipeline pass. The drain converts
/// this into either `continue` (next message) or `break` (aggregator
/// channel closed; end the drain).
enum DrainStep {
    Continue,
    BreakLoop,
}

/// Process one MQTT message: parse the topic, route by per-tenant
/// IngestBackend policy, lookup the warm cache, validate the payload,
/// validate the channel id (cache-warm gate), and forward the
/// validated reading + synthesised event to the persistence + publish
/// channels. Increments the counters in `c` for every observable
/// outcome the tail log surfaces.
///
/// WHY a helper: keeps `drain_mqtt_stream` inside the workspace
/// `clippy::too_many_lines = 100` budget by hoisting the per-message
/// fan-out out of the loop body.
async fn process_one_message(
    msg: &mqtt::RawMqttMessage,
    cache: &Arc<TopicCache>,
    batch_in: &tokio::sync::mpsc::Sender<crate::payload::SensorReading>,
    events_in: &tokio::sync::mpsc::Sender<event_contracts_rs::SensorMetricIngestedEvent>,
    policy: &Arc<dyn ingest_backend::IngestBackendPolicy>,
    lookup_client: Option<&Arc<sensor_lookup::SensorLookupClient>>,
    c: &mut DrainCounters,
) -> DrainStep {
    let age_micros = msg.received_at.elapsed().as_micros();
    let parsed = match topic::parse(&msg.topic) {
        Ok(p) => p,
        Err(e) => {
            c.topic_parse_failures = c.topic_parse_failures.saturating_add(1);
            tracing::warn!(
                topic = %msg.topic,
                bytes = msg.payload.len(),
                age_micros,
                error = %e,
                "mqtt msg topic parse failed (dropping)"
            );
            return DrainStep::Continue;
        }
    };
    let (topic_tenant, sensor_id) = match parsed {
        topic::ParsedTopic::Sensor { tenant, sensor } => (tenant, Some(sensor)),
        topic::ParsedTopic::Device { tenant, .. } => (tenant, None),
    };
    if matches!(
        policy.backend_for(topic_tenant),
        config::IngestBackend::Node
    ) {
        c.node_routed_count = c.node_routed_count.saturating_add(1);
        tracing::trace!(
            topic = %msg.topic,
            bytes = msg.payload.len(),
            "mqtt msg routed to node backend (dropped here)"
        );
        return DrainStep::Continue;
    }
    let cached_meta = sensor_id.and_then(|s| cache.get(topic_tenant, s));
    let cache_hit = cached_meta.is_some();
    if maybe_spawn_cache_fill(cache_hit, sensor_id, topic_tenant, lookup_client, cache) {
        c.cache_miss_lookup_spawn_count = c.cache_miss_lookup_spawn_count.saturating_add(1);
    }
    let reading = match payload::validate(&msg.payload, topic_tenant) {
        Ok(r) => r,
        Err(e) => {
            c.topic_parse_failures = c.topic_parse_failures.saturating_add(1);
            tracing::warn!(
                topic = %msg.topic,
                bytes = msg.payload.len(),
                age_micros,
                error = %e,
                "mqtt msg payload validate failed (dropping)"
            );
            return DrainStep::Continue;
        }
    };
    if should_drop_unknown_channel(cached_meta.as_deref(), &reading, &msg.topic, topic_tenant) {
        c.unknown_channel_count = c.unknown_channel_count.saturating_add(1);
        return DrainStep::Continue;
    }
    tracing::trace!(
        topic = %msg.topic,
        bytes = msg.payload.len(),
        age_micros,
        quality = reading.quality,
        producer_ts = reading.producer_ts,
        cache_hit,
        "mqtt msg validated"
    );
    if forward_validated_reading(reading, batch_in, events_in, cached_meta.as_deref()).await {
        DrainStep::Continue
    } else {
        DrainStep::BreakLoop
    }
}

/// Pull messages off the MQTT stream and feed them through the
/// validate / batch / event-publish pipeline. The `cache` argument is
/// held across the loop so the topic-cache allocation lives for the
/// whole drain session; on cache miss + lookup_client present the
/// drain spawns a fire-and-forget responder request (fill helps the
/// NEXT message for the same `(tenant, sensor)` key).
async fn drain_mqtt_stream(
    stream: std::sync::Arc<tokio::sync::Mutex<Option<mqtt::MqttMessageStream>>>,
    cache: Arc<TopicCache>,
    batch_in: tokio::sync::mpsc::Sender<crate::payload::SensorReading>,
    events_in: tokio::sync::mpsc::Sender<event_contracts_rs::SensorMetricIngestedEvent>,
    policy: Arc<dyn ingest_backend::IngestBackendPolicy>,
    // Faz 3 follow-on: cache-miss responder client. `None` in stub
    // mode (no [nats] configured) — drain falls back to its previous
    // hit/miss-only behaviour. `Some` when [nats] is configured: a
    // cache miss spawns a fire-and-forget lookup that fills the cache
    // for SUBSEQUENT messages on the same `(tenant, sensor)` key.
    // The current message proceeds with payload-only data either way.
    lookup_client: Option<Arc<sensor_lookup::SensorLookupClient>>,
) {
    let mut guard = stream.lock().await;
    let Some(s) = guard.as_mut() else {
        // No MQTT configured — block forever so the select! arm that
        // owns this future cannot race the SIGTERM arm.
        drop(guard);
        std::future::pending::<()>().await;
        return;
    };
    // Per-message bookkeeping is hoisted into [`DrainCounters`] so
    // [`process_one_message`] can mutate them through a single `&mut`
    // borrow — keeps the loop body tight and the function inside the
    // workspace `clippy::too_many_lines = 100` budget.
    let mut counters = DrainCounters::default();
    while let Some(msg) = s.recv().await {
        counters.count = counters.count.saturating_add(1);
        let step = process_one_message(
            &msg,
            &cache,
            &batch_in,
            &events_in,
            &policy,
            lookup_client.as_ref(),
            &mut counters,
        )
        .await;
        if matches!(step, DrainStep::BreakLoop) {
            break;
        }
    }
    tracing::info!(
        count = counters.count,
        topic_parse_failures = counters.topic_parse_failures,
        node_routed_count = counters.node_routed_count,
        cache_miss_lookup_spawn_count = counters.cache_miss_lookup_spawn_count,
        unknown_channel_count = counters.unknown_channel_count,
        cache_len = cache.len(),
        "mqtt drain complete"
    );
}

async fn wait_for_shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut sigterm = match signal(SignalKind::terminate()) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(error = ?e, "failed to register SIGTERM handler");
            return;
        }
    };
    let mut sigint = match signal(SignalKind::interrupt()) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(error = ?e, "failed to register SIGINT handler");
            return;
        }
    };
    tokio::select! {
        _ = sigterm.recv() => {}
        _ = sigint.recv() => {}
    }
}
