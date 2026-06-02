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
//!   - MQTT subscribe loop (rumqttc) → topic parse → per-tenant
//!     IngestBackend gate → strict payload validate → cache-backed
//!     sensor/channel validation → bounded batch aggregator →
//!     Timescale COPY + transactional outbox → NATS dispatcher.

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

use anyhow::{Context, anyhow};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use sensor_ingestion::batch::{
    BatchAggregator, BatchOpts, DEFAULT_INPUT_CHANNEL_CAPACITY, DEFAULT_OUTPUT_CHANNEL_CAPACITY,
};
use sensor_ingestion::cache::{DEFAULT_TOTAL_CAPACITY, SensorMeta, TopicCache};
use sensor_ingestion::config::{Config, IngestBackend};
use sensor_ingestion::events::NatsOutboxPublisher;
use sensor_ingestion::ingest_backend::{DynamicBackendPolicy, IngestBackendPolicy};
use sensor_ingestion::mqtt::{self, MqttMessageStream, RawMqttMessage};
use sensor_ingestion::payload::{self, SensorReading};
use sensor_ingestion::persistence::{BatchSink, LoggingSink, PostgresSink, run_sink_loop};
use sensor_ingestion::policy::{bootstrap_policy, spawn_policy_subscriber};
use sensor_ingestion::runtime::build_runtime;
use sensor_ingestion::sensor_lookup::{SensorLookupClient, build_sensor_lookup_client};
use sensor_ingestion::topic::{self, ParsedTopic};

type DispatcherRuntime = (Arc<outbox_rs::OutboxDispatcher>, JoinHandle<()>);

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
    let _metrics_handle =
        observability::init_metrics(&cfg.metrics).context("initialising metrics recorder")?;

    validate_config_contract(&cfg)?;
    let cache = build_topic_cache();
    let nats = connect_nats_client(cfg.nats.as_ref()).await?;

    let (snapshot, source) = bootstrap_policy(nats.as_deref(), &cfg.ingest_backend).await;
    source.emit_metric();
    let backend_policy = Arc::new(DynamicBackendPolicy::new(snapshot));

    let cancel = CancellationToken::new();
    let policy_task = nats.as_ref().map(|client| {
        spawn_policy_subscriber(
            Arc::clone(client),
            Arc::clone(&backend_policy),
            cfg.ingest_backend.disk_fallback_path.clone(),
            cancel.clone(),
        )
    });

    let (sink, outbox_repo) = build_batch_sink(cfg.postgres.as_ref()).await?;
    let dispatcher = spawn_outbox_dispatcher(outbox_repo, nats.as_ref())?;

    let lookup_client = nats
        .as_ref()
        .map(|client| build_sensor_lookup_client(Arc::clone(client)));

    let (aggregator, reading_tx, batch_rx) = BatchAggregator::new(
        BatchOpts::default(),
        DEFAULT_INPUT_CHANNEL_CAPACITY,
        DEFAULT_OUTPUT_CHANNEL_CAPACITY,
    )
    .context("constructing batch aggregator")?;

    let (exit_tx, mut exit_rx) = mpsc::channel::<TaskExit>(4);

    let aggregator_task = spawn_aggregator_task(aggregator, cancel.clone(), exit_tx.clone());
    let sink_task = spawn_sink_task(sink, batch_rx, exit_tx.clone());
    let mqtt_stream = start_mqtt_stream(cfg.mqtt.clone()).await?;

    let pipeline = PipelineDeps {
        cache: Arc::clone(&cache),
        backend_policy,
        lookup_client,
        reading_tx,
        cancel: cancel.clone(),
    };
    let mqtt_task = spawn_mqtt_task(mqtt_stream, pipeline, exit_tx.clone());
    drop(exit_tx);

    let mut stop_error: Option<anyhow::Error> = None;
    wait_for_shutdown_or_task_exit(&mut exit_rx, &mut stop_error).await;
    cancel.cancel();
    if let Some((dispatcher, _)) = dispatcher.as_ref() {
        dispatcher.shutdown();
    }

    while let Ok(exit) = exit_rx.try_recv() {
        record_task_exit(exit, &mut stop_error);
    }

    join_core_tasks(mqtt_task, aggregator_task, sink_task).await;
    if let Some(handle) = policy_task {
        let _ = handle.await;
    }
    if let Some((_dispatcher, handle)) = dispatcher {
        let _ = handle.await;
    }
    while let Ok(exit) = exit_rx.try_recv() {
        record_task_exit(exit, &mut stop_error);
    }

    tracing::info!(
        cache_final_len = cache.len(),
        "topic cache state at shutdown"
    );
    if let Some(err) = stop_error {
        return Err(err);
    }
    Ok(())
}

fn validate_config_contract(cfg: &Config) -> anyhow::Result<()> {
    if cfg.postgres.is_some() && cfg.nats.is_none() {
        return Err(anyhow!(
            "postgres sink requires [nats] config so transactional outbox rows can dispatch"
        ));
    }
    if cfg.mqtt.is_some() && cfg.postgres.is_none() {
        return Err(anyhow!(
            "mqtt subscriber requires [postgres] config; refusing logging sink for live ingestion"
        ));
    }
    Ok(())
}

fn build_topic_cache() -> Arc<TopicCache> {
    let cache = Arc::new(TopicCache::new(DEFAULT_TOTAL_CAPACITY));
    tracing::info!(
        cache_total_capacity = DEFAULT_TOTAL_CAPACITY,
        cache_per_tenant_capacity = cache.per_tenant_capacity(),
        cache_initial_len = cache.len(),
        "topic cache constructed"
    );
    cache
}

async fn connect_nats_client(
    nats_cfg: Option<&nats_client::MtlsConfig>,
) -> anyhow::Result<Option<Arc<nats_client::NatsClient>>> {
    if let Some(nats_cfg) = nats_cfg {
        let client = nats_client::NatsClient::connect(nats_cfg)
            .await
            .context("connecting to NATS with mTLS")?;
        return Ok(Some(Arc::new(client)));
    }
    Ok(None)
}

async fn build_batch_sink(
    pg_cfg: Option<&sensor_ingestion::persistence::PostgresConfig>,
) -> anyhow::Result<(Arc<dyn BatchSink>, Option<outbox_rs::PgOutboxRepository>)> {
    if let Some(pg_cfg) = pg_cfg {
        let pg_sink = PostgresSink::connect(pg_cfg)
            .await
            .context("connecting postgres sensor sink")?;
        let repo = pg_sink.outbox_repository();
        return Ok((Arc::new(pg_sink), Some(repo)));
    }
    tracing::warn!("postgres config absent; using logging sink (no metric persistence or outbox)");
    Ok((Arc::new(LoggingSink::new()), None))
}

fn spawn_outbox_dispatcher(
    repo: Option<outbox_rs::PgOutboxRepository>,
    nats: Option<&Arc<nats_client::NatsClient>>,
) -> anyhow::Result<Option<DispatcherRuntime>> {
    let Some(repo) = repo else {
        return Ok(None);
    };
    let Some(nats_client) = nats else {
        return Err(anyhow!(
            "outbox dispatcher requires a connected NATS client"
        ));
    };
    let dispatcher = Arc::new(outbox_rs::OutboxDispatcher::new(
        Arc::new(repo),
        Arc::new(NatsOutboxPublisher::from_client(Arc::clone(nats_client))),
        outbox_rs::DispatcherConfig::default(),
    ));
    let runner = Arc::clone(&dispatcher);
    let handle = tokio::spawn(async move {
        runner.run().await;
    });
    Ok(Some((dispatcher, handle)))
}

fn spawn_aggregator_task(
    aggregator: BatchAggregator,
    cancel: CancellationToken,
    tx: mpsc::Sender<TaskExit>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let result = aggregator.run(cancel).await.map_err(|e| e.to_string());
        let _ = tx.send(TaskExit::Aggregator(result)).await;
    })
}

fn spawn_sink_task(
    sink: Arc<dyn BatchSink>,
    batch_rx: mpsc::Receiver<Vec<SensorReading>>,
    tx: mpsc::Sender<TaskExit>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let result = run_sink_loop(sink, batch_rx)
            .await
            .map_err(|e| e.to_string());
        let _ = tx.send(TaskExit::Sink(result)).await;
    })
}

async fn start_mqtt_stream(
    mqtt_cfg: Option<sensor_ingestion::config::MqttConfig>,
) -> anyhow::Result<Option<MqttMessageStream>> {
    if let Some(mqtt_cfg) = mqtt_cfg {
        tracing::info!(
            broker = %mqtt_cfg.broker_url,
            filters = ?mqtt_cfg.topic_filters,
            "starting mqtt subscriber"
        );
        let stream = mqtt::start(mqtt_cfg)
            .await
            .context("starting mqtt subscriber")?;
        return Ok(Some(stream));
    }
    tracing::info!("mqtt config absent; waiting for shutdown without subscriber");
    Ok(None)
}

fn spawn_mqtt_task(
    mqtt_stream: Option<MqttMessageStream>,
    pipeline: PipelineDeps,
    tx: mpsc::Sender<TaskExit>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let result = run_mqtt_pipeline(mqtt_stream, pipeline)
            .await
            .map_err(|e| format!("{e:#}"));
        let _ = tx.send(TaskExit::Mqtt(result)).await;
    })
}

async fn wait_for_shutdown_or_task_exit(
    exit_rx: &mut mpsc::Receiver<TaskExit>,
    stop_error: &mut Option<anyhow::Error>,
) {
    tokio::select! {
        () = wait_for_shutdown_signal() => {
            tracing::info!("shutdown signal received");
        }
        maybe_exit = exit_rx.recv() => {
            if let Some(exit) = maybe_exit {
                record_task_exit(exit, stop_error);
            }
        }
    }
}

async fn join_core_tasks(
    mqtt_task: JoinHandle<()>,
    aggregator_task: JoinHandle<()>,
    sink_task: JoinHandle<()>,
) {
    let _ = mqtt_task.await;
    let _ = aggregator_task.await;
    let _ = sink_task.await;
}

#[derive(Debug)]
enum TaskExit {
    Mqtt(Result<u64, String>),
    Aggregator(Result<u64, String>),
    Sink(Result<(), String>),
}

fn record_task_exit(exit: TaskExit, stop_error: &mut Option<anyhow::Error>) {
    match exit {
        TaskExit::Mqtt(Ok(count)) => {
            tracing::info!(count, "mqtt pipeline exited");
        }
        TaskExit::Mqtt(Err(e)) => {
            tracing::error!(error = %e, "mqtt pipeline failed");
            *stop_error = Some(anyhow!("mqtt pipeline failed: {e}"));
        }
        TaskExit::Aggregator(Ok(flushed)) => {
            tracing::info!(flushed_batches = flushed, "batch aggregator exited");
        }
        TaskExit::Aggregator(Err(e)) => {
            tracing::error!(error = %e, "batch aggregator failed");
            *stop_error = Some(anyhow!("batch aggregator failed: {e}"));
        }
        TaskExit::Sink(Ok(())) => {
            tracing::info!("batch sink loop exited");
        }
        TaskExit::Sink(Err(e)) => {
            tracing::error!(error = %e, "batch sink failed");
            *stop_error = Some(anyhow!("batch sink failed: {e}"));
        }
    }
}

#[derive(Clone)]
struct PipelineDeps {
    cache: Arc<TopicCache>,
    backend_policy: Arc<DynamicBackendPolicy>,
    lookup_client: Option<Arc<SensorLookupClient>>,
    reading_tx: mpsc::Sender<SensorReading>,
    cancel: CancellationToken,
}

async fn run_mqtt_pipeline(
    stream: Option<MqttMessageStream>,
    deps: PipelineDeps,
) -> anyhow::Result<u64> {
    let Some(mut stream) = stream else {
        deps.cancel.cancelled().await;
        return Ok(0);
    };

    let mut accepted = 0u64;
    loop {
        tokio::select! {
            biased;
            () = deps.cancel.cancelled() => {
                break;
            }
            msg = stream.recv() => {
                let Some(msg) = msg else {
                    break;
                };
                if process_mqtt_message(msg, &deps).await? {
                    accepted = accepted.saturating_add(1);
                }
            }
        }
    }

    stream.shutdown().await;
    Ok(accepted)
}

async fn process_mqtt_message(msg: RawMqttMessage, deps: &PipelineDeps) -> anyhow::Result<bool> {
    metrics::counter!("sensor_ingestion_mqtt_received_total").increment(1);
    let topic_for_log = bounded_topic(&msg.topic);
    let parsed = match topic::parse(&msg.topic) {
        Ok(parsed) => parsed,
        Err(e) => {
            metrics::counter!("sensor_ingestion_topic_parse_failed_total").increment(1);
            tracing::warn!(
                topic = %topic_for_log,
                error = %e,
                "mqtt topic rejected"
            );
            return Ok(false);
        }
    };

    let (tenant, topic_sensor, topic_device) = match parsed {
        ParsedTopic::Sensor { tenant, sensor } => (tenant, Some(sensor), None),
        ParsedTopic::Device { tenant, device } => {
            tracing::trace!(
                tenant = %tenant.as_uuid(),
                device = %device,
                "device io_data topic accepted"
            );
            (tenant, None, Some(device))
        }
    };

    if !matches!(deps.backend_policy.backend_for(tenant), IngestBackend::Rust) {
        metrics::counter!("sensor_ingestion_policy_node_routed_total").increment(1);
        tracing::trace!(
            tenant = %tenant.as_uuid(),
            topic = %topic_for_log,
            "tenant routed to node ingestion; rust sidecar skipped message"
        );
        return Ok(false);
    }

    let reading = match payload::validate(&msg.payload, tenant) {
        Ok(reading) => reading,
        Err(e) => {
            metrics::counter!("sensor_ingestion_payload_rejected_total").increment(1);
            tracing::warn!(
                tenant = %tenant.as_uuid(),
                topic = %topic_for_log,
                error = %e,
                "mqtt payload rejected"
            );
            return Ok(false);
        }
    };

    if let Some(expected_sensor) = topic_sensor {
        if reading.sensor_id != expected_sensor {
            metrics::counter!("sensor_ingestion_topic_sensor_mismatch_total").increment(1);
            tracing::warn!(
                tenant = %tenant.as_uuid(),
                topic_sensor = %expected_sensor,
                payload_sensor = %reading.sensor_id,
                "topic sensor id does not match payload sensor id; dropping"
            );
            return Ok(false);
        }
    }

    if !sensor_metadata_accepts(&reading, deps, tenant, topic_device).await {
        return Ok(false);
    }

    deps.reading_tx
        .send(reading)
        .await
        .map_err(|_| anyhow!("batch input channel closed"))?;
    metrics::counter!("sensor_ingestion_reading_enqueued_total").increment(1);
    tracing::trace!(
        topic = %topic_for_log,
        age_micros = msg.received_at.elapsed().as_micros(),
        "mqtt reading accepted into batch aggregator"
    );
    Ok(true)
}

async fn sensor_metadata_accepts(
    reading: &SensorReading,
    deps: &PipelineDeps,
    tenant: tenant_context::TenantId,
    topic_device: Option<uuid::Uuid>,
) -> bool {
    let meta = resolve_sensor_meta(
        &deps.cache,
        deps.lookup_client.as_deref(),
        tenant,
        reading.sensor_id,
        topic_device,
    )
    .await;

    if let Some(meta) = meta {
        if meta.channel_ids.contains(&reading.channel_id) {
            return true;
        }
        metrics::counter!("sensor_ingestion_cache_channel_rejected_total").increment(1);
        tracing::warn!(
            tenant = %tenant.as_uuid(),
            sensor = %reading.sensor_id,
            channel = %reading.channel_id,
            "channel id not present in resolved sensor metadata; dropping"
        );
        return false;
    }
    if deps.lookup_client.is_some() {
        tracing::warn!(
            tenant = %tenant.as_uuid(),
            sensor = %reading.sensor_id,
            "sensor metadata lookup returned no authoritative result; dropping"
        );
        return false;
    }
    tracing::warn!(
        tenant = %tenant.as_uuid(),
        sensor = %reading.sensor_id,
        "sensor lookup unavailable; accepting message only because postgres sink is disabled"
    );
    true
}

async fn resolve_sensor_meta(
    cache: &TopicCache,
    lookup: Option<&SensorLookupClient>,
    tenant: tenant_context::TenantId,
    sensor: uuid::Uuid,
    device: Option<uuid::Uuid>,
) -> Option<Arc<SensorMeta>> {
    if let Some(meta) = cache.get(tenant, sensor) {
        return Some(meta);
    }
    metrics::counter!("sensor_ingestion_cache_miss_total").increment(1);
    let client = lookup?;
    match client.fetch_sensor_meta(tenant, sensor, device).await {
        Ok(Some(meta)) if meta.tenant_id == tenant && meta.sensor_id == sensor => {
            let returned = Arc::new(meta.clone());
            cache.insert(meta);
            Some(returned)
        }
        Ok(Some(meta)) => {
            tracing::warn!(
                request_tenant = %tenant.as_uuid(),
                request_sensor = %sensor,
                response_tenant = %meta.tenant_id.as_uuid(),
                response_sensor = %meta.sensor_id,
                "sensor lookup returned mismatched metadata; refusing cache insert"
            );
            None
        }
        Ok(None) => None,
        Err(e) => {
            tracing::warn!(
                tenant = %tenant.as_uuid(),
                sensor = %sensor,
                error = %e,
                "sensor lookup request failed"
            );
            None
        }
    }
}

fn bounded_topic(topic: &str) -> String {
    const MAX_TOPIC_LOG_BYTES: usize = 256;
    if topic.len() <= MAX_TOPIC_LOG_BYTES {
        return topic.to_owned();
    }
    let mut end = MAX_TOPIC_LOG_BYTES;
    while end > 0 && !topic.is_char_boundary(end) {
        end -= 1;
    }
    topic
        .get(..end)
        .map_or_else(|| "...".to_owned(), |head| format!("{head}..."))
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
