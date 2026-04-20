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
        () = drain_mqtt_stream(drain_slot, drain_cache, batch_in_tx.clone(), policy) => {
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
    // channel close and exits. There is exactly one sender held by
    // async_main (the bundle returned from start_event_publisher); when
    // stage 13 wires the drain → events_in_tx path, the drain holds a
    // clone and this drop is still the last close.
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
    events_in_tx: tokio::sync::mpsc::Sender<event_contracts_rs::SensorReadingEvent>,
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
        tokio::sync::mpsc::channel::<event_contracts_rs::SensorReadingEvent>(10_000);

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

/// Pull messages off the MQTT stream and drop them. A placeholder for
/// the real pipeline; exists so the module is actually exercised at
/// runtime and the compiler does not treat it as dead code. The
/// `cache` argument is held across the loop so the topic-cache
/// allocation lives for the whole drain session — when the real
/// `topic::parse → cache.get → upstream lookup → cache.insert` wiring
/// lands on this PR, the parameter signature is already in place and
/// callers do not need to be re-routed.
async fn drain_mqtt_stream(
    stream: std::sync::Arc<tokio::sync::Mutex<Option<mqtt::MqttMessageStream>>>,
    cache: Arc<TopicCache>,
    batch_in: tokio::sync::mpsc::Sender<crate::payload::SensorReading>,
    policy: Arc<dyn ingest_backend::IngestBackendPolicy>,
) {
    let mut guard = stream.lock().await;
    let Some(s) = guard.as_mut() else {
        // No MQTT configured — block forever so the select! arm that
        // owns this future cannot race the SIGTERM arm.
        drop(guard);
        std::future::pending::<()>().await;
        return;
    };
    let mut count: u64 = 0;
    let mut topic_parse_failures: u64 = 0;
    // Stage 13: per-tenant IngestBackend gate. Counts messages routed
    // to NestJS (dropped here in the sidecar) so an operator can
    // correlate sidecar throughput against the rollout fraction.
    let mut node_routed_count: u64 = 0;
    while let Some(msg) = s.recv().await {
        count = count.saturating_add(1);
        let age_micros = msg.received_at.elapsed().as_micros();
        // Stage 6 + Stage 7 + Stage 8 wiring in order:
        //   1. topic::parse → ParsedTopic with TenantId.
        //   2. cache.get(tenant, sensor) — warm-lookup; a hit skips
        //      the upstream sensor-meta fetch when that lands in a
        //      follow-on commit. The current drain does NOT block on
        //      a miss (no NATS request-reply yet); it just records
        //      the outcome so cache-fill is observable at the hot
        //      path.
        //   3. payload::validate(bytes, topic_tenant) — enforces the
        //      ADR-025 § Threat 2 topic↔payload tenant bind.
        // Parse / validate FAILURES increment topic_parse_failures
        // and log at warn — ops alarms on a single counter.
        match topic::parse(&msg.topic) {
            Ok(parsed) => {
                let (topic_tenant, sensor_id) = match parsed {
                    topic::ParsedTopic::Sensor { tenant, sensor } => (tenant, Some(sensor)),
                    topic::ParsedTopic::Device { tenant, .. } => (tenant, None),
                };
                // Stage 13: gate on the per-tenant IngestBackend
                // policy AFTER topic parse (we need the tenant id to
                // ask the policy) and BEFORE payload validate (a
                // Node-routed tenant must not pay the validate cost
                // and must not push to the batch buffer). The broker
                // already received QoS-1 ack at recv() time; this is
                // the sidecar acknowledging the message and dropping
                // it because NestJS owns the stream — exactly the
                // strangler-fig contract.
                if matches!(
                    policy.backend_for(topic_tenant),
                    config::IngestBackend::Node
                ) {
                    node_routed_count = node_routed_count.saturating_add(1);
                    tracing::trace!(
                        topic = %msg.topic,
                        bytes = msg.payload.len(),
                        "mqtt msg routed to node backend (dropped here)"
                    );
                    continue;
                }
                let cache_hit = sensor_id.is_some_and(|s| cache.get(topic_tenant, s).is_some());
                match payload::validate(&msg.payload, topic_tenant) {
                    Ok(reading) => {
                        tracing::trace!(
                            topic = %msg.topic,
                            bytes = msg.payload.len(),
                            age_micros,
                            quality = reading.quality,
                            producer_ts = reading.producer_ts,
                            cache_hit,
                            "mqtt msg validated"
                        );
                        // Stage 9: hand the validated reading to the
                        // batch aggregator. send().await blocks if
                        // the batch buffer is full, which propagates
                        // backpressure all the way to the broker
                        // (MQTT QoS-1 inflight). A closed sender
                        // means the aggregator already exited; drop
                        // the message and let the loop end naturally
                        // when the broker delivers the next.
                        if batch_in.send(reading).await.is_err() {
                            tracing::warn!("batch aggregator gone; ending drain loop");
                            break;
                        }
                    }
                    Err(e) => {
                        topic_parse_failures = topic_parse_failures.saturating_add(1);
                        tracing::warn!(
                            topic = %msg.topic,
                            bytes = msg.payload.len(),
                            age_micros,
                            error = %e,
                            "mqtt msg payload validate failed (dropping)"
                        );
                    }
                }
            }
            Err(e) => {
                topic_parse_failures = topic_parse_failures.saturating_add(1);
                tracing::warn!(
                    topic = %msg.topic,
                    bytes = msg.payload.len(),
                    age_micros,
                    error = %e,
                    "mqtt msg topic parse failed (dropping)"
                );
            }
        }
    }
    tracing::info!(
        count,
        topic_parse_failures,
        node_routed_count,
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
