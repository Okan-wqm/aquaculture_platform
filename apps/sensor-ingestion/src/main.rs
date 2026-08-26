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
//! The production path is a strict durability chain: validate owner and source
//! identity, commit the tenant receipt + metric + dispatch intent, obtain every
//! JetStream PubAck, persist those PubAcks, and only then acknowledge MQTT.

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

use sensor_ingestion::cache::{self, DEFAULT_TOTAL_CAPACITY, TopicCache};
use sensor_ingestion::config::Config;
use sensor_ingestion::events::{NatsDispatchPublisher, NatsQuarantinePublisher};
use sensor_ingestion::mqtt::{self, MqttMessageStream};
use sensor_ingestion::persistence::{DurableIngressStore, PostgresSink};
use sensor_ingestion::pipeline::{
    CachedSensorMetadataResolver, IngressPipeline, MqttDisposition, SensorMetadataResolver,
};
use sensor_ingestion::runtime::build_runtime;
use sensor_ingestion::sensor_lookup::SensorLookupClient;
use tokio_util::sync::CancellationToken;

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
    let cancellation = CancellationToken::new();
    let (mqtt_stream, pipeline, quarantine, owner_policy_task) =
        if let Some(mqtt_cfg) = cfg.mqtt.clone() {
            let nats_cfg = cfg
                .nats
                .as_ref()
                .context("mqtt ingress requires an mTLS NATS configuration")?;
            let postgres_cfg = cfg
                .postgres
                .as_ref()
                .context("mqtt ingress requires a PostgreSQL configuration")?;
            let nats = Arc::new(
                nats_client::NatsClient::connect(nats_cfg)
                    .await
                    .context("connecting certificate-authenticated NATS")?,
            );
            let postgres = Arc::new(
                PostgresSink::connect(postgres_cfg)
                    .await
                    .context("connecting durable tenant ingest store")?,
            );
            let owners = sensor_ingestion::policy::bootstrap_owner_policies(
                &nats,
                std::time::Duration::from_secs(cfg.ingest_backend.snapshot_request_timeout_secs),
                cfg.ingest_backend.snapshot_request_retries,
            )
            .await;
            let owner_task = sensor_ingestion::policy::spawn_owner_policy_subscriber(
                Arc::clone(&nats),
                Arc::clone(&owners),
                cancellation.clone(),
            );
            let lookup = Arc::new(SensorLookupClient::new(Arc::clone(&nats)));
            let resolver: Arc<dyn SensorMetadataResolver> = Arc::new(
                CachedSensorMetadataResolver::new(Arc::clone(&cache), lookup),
            );
            let store: Arc<dyn DurableIngressStore> = postgres;
            let publisher = Arc::new(NatsDispatchPublisher::from_client(Arc::clone(&nats)));
            let pipeline = Arc::new(IngressPipeline::new(owners, resolver, store, publisher));
            let quarantine = Arc::new(NatsQuarantinePublisher::from_client(nats));
            tracing::info!(
                broker = %mqtt_cfg.broker_url,
                filters = ?mqtt_cfg.topic_filters,
                "starting durable mqtt subscriber"
            );
            (
                Some(
                    mqtt::start(mqtt_cfg)
                        .await
                        .context("starting mqtt subscriber")?,
                ),
                Some(pipeline),
                Some(quarantine),
                Some(owner_task),
            )
        } else {
            tracing::info!("mqtt config absent; running control-plane-free idle mode");
            (None, None, None, None)
        };

    // Split the stream into an Arc<Mutex<Option<...>>> so both the
    // drain task and the signal-handler path can reach it. The signal
    // path needs ownership to call shutdown(); the drain path needs
    // &mut for recv(). The Mutex mediates the handoff.
    let stream_slot = std::sync::Arc::new(tokio::sync::Mutex::new(mqtt_stream));
    let drain_slot = stream_slot.clone();
    let shutdown_slot = stream_slot;
    let drain_cache = Arc::clone(&cache);

    tokio::select! {
        () = wait_for_shutdown_signal() => {
            tracing::info!("shutdown signal received, closing mqtt subscriber");
            cancellation.cancel();
            let taken = shutdown_slot.lock().await.take();
            if let Some(s) = taken {
                s.shutdown().await;
            }
        }
        () = drain_mqtt_stream(drain_slot, drain_cache, pipeline, quarantine) => {
            tracing::info!("mqtt stream closed");
            cancellation.cancel();
        }
    }
    if let Some(task) = owner_policy_task {
        let _ = task.await;
    }
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

/// Drain one singleton persistent MQTT session. The 10-second deadline covers
/// validation, tenant commit, all JetStream PubAcks and quarantine persistence.
async fn drain_mqtt_stream(
    stream: std::sync::Arc<tokio::sync::Mutex<Option<MqttMessageStream>>>,
    cache: Arc<TopicCache>,
    pipeline: Option<Arc<IngressPipeline>>,
    quarantine: Option<Arc<NatsQuarantinePublisher>>,
) {
    let mut guard = stream.lock().await;
    let Some(s) = guard.as_mut() else {
        // No MQTT configured — block forever so the select! arm that
        // owns this future cannot race the SIGTERM arm.
        drop(guard);
        std::future::pending::<()>().await;
        return;
    };
    let (Some(pipeline), Some(quarantine)) = (pipeline, quarantine) else {
        tracing::error!("mqtt stream exists without its required durable dependencies");
        return;
    };
    let mut count = 0u64;
    while let Some(msg) = s.recv().await {
        count = count.saturating_add(1);
        let age_micros = msg.received_at.elapsed().as_micros();
        // Read the cache fill periodically so the cache reference is
        // exercised even before the topic-parser commit lands. Once
        // every 1024 messages keeps the log volume bounded — the
        // count is observable in tracing without polluting trace
        // output for short bursts.
        let cache_len = if count.is_multiple_of(1024) {
            Some(cache.len())
        } else {
            None
        };
        tracing::trace!(topic = %msg.topic, bytes = msg.payload.len(), age_micros, cache_len = ?cache_len, "mqtt delivery admitted");
        let deadline =
            tokio::time::Instant::from_std(msg.received_at + std::time::Duration::from_secs(10));
        let disposition =
            tokio::time::timeout_at(deadline, pipeline.process(&msg.topic, &msg.payload))
                .await
                .unwrap_or(MqttDisposition::Retry);
        match disposition {
            MqttDisposition::Committed
            | MqttDisposition::NotOwner
            | MqttDisposition::ErasedTenant => {
                if let Err(error) = msg.acknowledge().await {
                    tracing::error!(error = %error, "mqtt PUBACK failed");
                    return;
                }
            }
            MqttDisposition::Poison => {
                let quarantined = tokio::time::timeout_at(
                    deadline,
                    quarantine.publish(&msg.topic, &msg.payload, "POISON_INPUT"),
                )
                .await;
                if !matches!(quarantined, Ok(Ok(_))) {
                    tracing::error!("quarantine PubAck failed; source remains unacknowledged");
                    let _ = msg.retry_without_ack().await;
                    return;
                }
                if let Err(error) = msg.acknowledge().await {
                    tracing::error!(error = %error, "mqtt PUBACK after quarantine failed");
                    return;
                }
            }
            MqttDisposition::Retry => {
                tracing::warn!("retryable MQTT delivery left unacknowledged; reconnecting session");
                let _ = msg.retry_without_ack().await;
                return;
            }
        }
    }
    tracing::info!(count, cache_len = cache.len(), "mqtt drain complete");
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
