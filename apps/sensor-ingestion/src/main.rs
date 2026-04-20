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

use anyhow::Context;

use crate::config::Config;
use crate::runtime::build_runtime;

mod config;
mod error;
mod mqtt;
mod runtime;

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

    tokio::select! {
        () = wait_for_shutdown_signal() => {
            tracing::info!("shutdown signal received, closing mqtt subscriber");
            let taken = shutdown_slot.lock().await.take();
            if let Some(s) = taken {
                s.shutdown().await;
            }
        }
        () = drain_mqtt_stream(drain_slot) => {
            tracing::info!("mqtt stream closed");
        }
    }
    Ok(())
}

/// Pull messages off the MQTT stream and drop them. A placeholder for
/// the real pipeline; exists so the module is actually exercised at
/// runtime and the compiler does not treat it as dead code.
async fn drain_mqtt_stream(
    stream: std::sync::Arc<tokio::sync::Mutex<Option<mqtt::MqttMessageStream>>>,
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
    while let Some(msg) = s.recv().await {
        count = count.saturating_add(1);
        let age_micros = msg.received_at.elapsed().as_micros();
        tracing::trace!(
            topic = %msg.topic,
            bytes = msg.payload.len(),
            age_micros,
            "mqtt msg (stub drain)"
        );
        // The real pipeline replaces this in the next commit:
        // topic::parse -> payload::validate -> batch aggregator ->
        // COPY -> NATS publish.
    }
    tracing::info!(count, "mqtt drain complete");
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
