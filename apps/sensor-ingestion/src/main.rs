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

use sensor_ingestion::cache::{self, DEFAULT_TOTAL_CAPACITY, TopicCache};
use sensor_ingestion::config::Config;
use sensor_ingestion::mqtt::{self, MqttMessageStream};
use sensor_ingestion::runtime::build_runtime;

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
    // exercised at runtime end-to-end. When the topic parser + cache-
    // miss handler land in subsequent commits the same `Arc` shifts
    // from the placeholder log-line to the real lookup callsite.
    let drain_cache = Arc::clone(&cache);

    tokio::select! {
        () = wait_for_shutdown_signal() => {
            tracing::info!("shutdown signal received, closing mqtt subscriber");
            let taken = shutdown_slot.lock().await.take();
            if let Some(s) = taken {
                s.shutdown().await;
            }
        }
        () = drain_mqtt_stream(drain_slot, drain_cache) => {
            tracing::info!("mqtt stream closed");
        }
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

/// Pull messages off the MQTT stream and drop them. A placeholder for
/// the real pipeline; exists so the module is actually exercised at
/// runtime and the compiler does not treat it as dead code. The
/// `cache` argument is held across the loop so the topic-cache
/// allocation lives for the whole drain session — when the real
/// `topic::parse → cache.get → upstream lookup → cache.insert` wiring
/// lands on this PR, the parameter signature is already in place and
/// callers do not need to be re-routed.
async fn drain_mqtt_stream(
    stream: std::sync::Arc<tokio::sync::Mutex<Option<MqttMessageStream>>>,
    cache: Arc<TopicCache>,
) {
    let mut guard = stream.lock().await;
    let Some(s) = guard.as_mut() else {
        // No MQTT configured — block forever so the select! arm that
        // owns this future cannot race the SIGTERM arm.
        drop(guard);
        std::future::pending::<()>().await;
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
        tracing::trace!(
            topic = %msg.topic,
            bytes = msg.payload.len(),
            age_micros,
            cache_len = ?cache_len,
            "mqtt msg (stub drain)"
        );
        // The real pipeline replaces this in the next commit:
        // topic::parse -> cache.get(tenant, sensor) -> on miss issue
        // upstream lookup and cache.insert -> payload::validate ->
        // batch aggregator -> COPY -> NATS publish.
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
