//! Centralized publish-helper module — Batch #255 ARC-002 part 5.
//!
//! Owns the routing decision between the broker-aware
//! `OutboundPublisher` (queue-on-outage + replay-on-reconnect)
//! and the legacy `MqttClient::publish_*` direct path. Pre-Batch-
//! 255 every call site duplicated the `if let Some(publisher) {
//! publisher.publish(...) } else if let Some(mqtt) {
//! mqtt.publish_xxx(...) }` branching. That worked but
//! propagating the same boilerplate across 12+ call sites would
//! invite drift — a future change to the routing rule (e.g.,
//! "always queue on QoS=1, even when broker up") would have to
//! land in every call site or silently miss one.
//!
//! ## Routing rule (single source of truth)
//!
//! Every helper here applies the same decision:
//! 1. If `state.outbound_publisher` is `Some(...)`: route through
//!    the dispatcher with caller-specified priority. Failures are
//!    warn-logged but NOT propagated — the queue path is the
//!    "delivery promise", a transport rejection at the broker
//!    side is a separate concern (audit / observability picks
//!    that up).
//! 2. Else if `state.mqtt_client` is `Some(...)`: legacy direct
//!    path. Same call shape as pre-Batch-251 callers.
//! 3. Else: no MQTT wired; helper returns silently. Test paths +
//!    pre-init boot stages.
//!
//! ## Why not extension methods on AppState
//!
//! AppState lives in `main.rs` (3000+ lines). Adding 7 publish
//! helpers as `impl AppState` methods would either bloat that
//! file further or require splitting AppState across files. A
//! standalone module with `pub async fn publish_alarms(state:
//! &AppState, ...)` keeps AppState lean + makes each helper
//! independently testable.
//!
//! ## Call shape
//!
//! ```ignore
//! crate::publish_helpers::publish_alarms(&state, &payload).await;
//! crate::publish_helpers::publish_telemetry(&state, metrics).await;
//! ```
//!
//! Helpers consume `&AppState` (read-only access; no mutation
//! needed for publish path). They do NOT return `Result` for the
//! same reason the pre-existing call sites already discarded the
//! result — a publish failure under the OutboundPublisher path
//! either means the queue is full (operator-actionable but not
//! caller-actionable from telemetry hot path) or the broker
//! rejected (e.g., topic ACL — operator-actionable). In both
//! cases the caller of `publish_telemetry` cannot do anything
//! except retry next tick, which the drain task already does.

#![allow(dead_code)]

use serde::Serialize;
use tracing::warn;

use crate::offline_queue::MessagePriority;

/// Internal helper: route payload bytes through the dispatcher
/// when available, falling back to the supplied legacy direct
/// publish closure when not. Centralizes the Some/None branching
/// + bytes serialization.
async fn publish_routed(
    state: &crate::AppState,
    topic: &str,
    payload: &impl Serialize,
    priority: MessagePriority,
    qos: u8,
    retain: bool,
    legacy_label: &str,
) {
    // EDGE-CRITICAL-004: stamp every telemetry-class envelope with a stable
    // (device_id, edge_seq) idempotency key BEFORE the direct-vs-queue fork,
    // so a store-and-forward replay carries the SAME key as its first
    // delivery and a backend consumer can dedup it. The seq is minted here —
    // the single publish chokepoint — so telemetry / io_data / alarms / status
    // are stamped uniformly. edge_seq is allocated only when the offline queue
    // is enabled (its SQLite backs the persisted monotonic counter, and it is
    // also the only replay source); device_id makes the payload self-contained
    // rather than relying on topic parsing.
    let mut value = match serde_json::to_value(payload) {
        Ok(v) => v,
        Err(e) => {
            warn!(
                "publish_helpers: serialize failed for {}: {}",
                legacy_label, e
            );
            return;
        }
    };
    if let Some(obj) = value.as_object_mut() {
        if let Some(ref mqtt) = state.mqtt_client {
            obj.insert(
                "device_id".to_string(),
                serde_json::Value::String(mqtt.device_id().to_string()),
            );
        }
        if let Some(ref queue) = state.offline_queue {
            match queue.alloc_edge_seq().await {
                Ok(seq) => {
                    obj.insert("edge_seq".to_string(), serde_json::json!(seq));
                }
                Err(e) => {
                    warn!(
                        "publish_helpers: edge_seq allocation failed for {}: {}",
                        legacy_label, e
                    );
                }
            }
        }
    } else {
        warn!(
            "publish_helpers: payload for {} is not a JSON object — cannot \
             stamp (device_id, edge_seq) idempotency key",
            legacy_label
        );
    }
    let payload_bytes = match serde_json::to_vec(&value) {
        Ok(b) => b,
        Err(e) => {
            warn!(
                "publish_helpers: serialize failed for {}: {}",
                legacy_label, e
            );
            return;
        }
    };

    if let Some(ref publisher) = state.outbound_publisher {
        if let Err(e) = publisher
            .publish(topic, &payload_bytes, priority, qos, retain)
            .await
        {
            warn!(
                "publish_helpers: OutboundPublisher.publish({}) failed: {}",
                legacy_label, e
            );
        }
        return;
    }

    if let Some(ref mqtt) = state.mqtt_client {
        if let Err(e) = mqtt.publish_raw(topic, &payload_bytes).await {
            warn!(
                "publish_helpers: MqttClient.publish_raw({}) failed: {}",
                legacy_label, e
            );
        }
    }
}

/// Publish an alarm-events payload to the configured alarms
/// topic. Uses [`MessagePriority::Critical`] so the drain task
/// replays alarms BEFORE telemetry/status/etc. on reconnect —
/// life-safety hot path (FDA 21 CFR 117.135, EU Machinery
/// Directive alignment).
pub async fn publish_alarms(state: &crate::AppState, payload: &impl Serialize) {
    let topic = match state.mqtt_client.as_ref() {
        Some(m) => m.topics().alarms.clone(),
        None => return,
    };
    publish_routed(
        state,
        &topic,
        payload,
        MessagePriority::Critical,
        1,
        false,
        "alarms",
    )
    .await;
}

/// Publish telemetry metrics (CPU/memory/disk, etc.) at
/// [`MessagePriority::Normal`]. High frequency, observability
/// data — drains AFTER alarms + status on reconnect.
pub async fn publish_telemetry<P: Serialize>(state: &crate::AppState, payload: &P) {
    let topic = match state.mqtt_client.as_ref() {
        Some(m) => m.topics().telemetry.clone(),
        None => return,
    };
    publish_routed(
        state,
        &topic,
        payload,
        MessagePriority::Normal,
        1,
        false,
        "telemetry",
    )
    .await;
}

/// Publish a device-status transition (Online / Offline /
/// Maintenance / Error) at [`MessagePriority::High`] —
/// connection lifecycle events that operators + cloud automation
/// react to (e.g., alerting on stale device).
pub async fn publish_status<P: Serialize>(state: &crate::AppState, payload: &P) {
    let topic = match state.mqtt_client.as_ref() {
        Some(m) => m.topics().status.clone(),
        None => return,
    };
    publish_routed(
        state,
        &topic,
        payload,
        MessagePriority::High,
        1,
        false,
        "status",
    )
    .await;
}

/// Publish a command-response payload at
/// [`MessagePriority::High`]. Cloud requests are correlated to
/// these by `command_id`; loss during outage breaks the
/// request-response loop until a timeout fires the cloud-side
/// retry — minimizing the response-loss window matters.
pub async fn publish_response<P: Serialize>(state: &crate::AppState, payload: &P) {
    let topic = match state.mqtt_client.as_ref() {
        Some(m) => m.topics().responses.clone(),
        None => return,
    };
    publish_routed(
        state,
        &topic,
        payload,
        MessagePriority::High,
        1,
        false,
        "response",
    )
    .await;
}

/// Publish IO data tags at [`MessagePriority::Normal`]. High-
/// frequency telemetry-class — drains in normal priority order.
pub async fn publish_io_data<P: Serialize>(state: &crate::AppState, payload: &P) {
    let topic = match state.mqtt_client.as_ref() {
        Some(m) => m.topics().io_data.clone(),
        None => return,
    };
    publish_routed(
        state,
        &topic,
        payload,
        MessagePriority::Normal,
        0,
        false,
        "io_data",
    )
    .await;
}

/// **Batch #302 Faz 4 step 5 closure.** Publish per-task
/// scheduler stats at [`MessagePriority::Normal`] —
/// observability-class telemetry, drains in normal priority
/// order on broker reconnect. Loss during broker outage is
/// acceptable (the next interval republishes); the queue-
/// aware path retains historical snapshots for cloud-side
/// time-series correlation.
///
/// QoS=0 — same as io_data telemetry. The 30s interval (plan
/// §5 Faz 4 step 5 default) means a lost message becomes
/// stale within one interval, so QoS=1 retry overhead is
/// unwarranted. Operators tolerating lower fidelity for the
/// scheduler-stats stream is the canonical observability
/// trade-off.
pub async fn publish_task_stats<P: Serialize>(state: &crate::AppState, payload: &P) {
    let topic = match state.mqtt_client.as_ref() {
        Some(m) => m.topics().task_stats.clone(),
        None => return,
    };
    publish_routed(
        state,
        &topic,
        payload,
        MessagePriority::Normal,
        0,
        false,
        "task_stats",
    )
    .await;
}

/// Publish a LoRaWAN event (uplink / join / downlink ack) at
/// [`MessagePriority::Normal`].
pub async fn publish_lora_event<P: Serialize>(state: &crate::AppState, payload: &P) {
    let topic = match state.mqtt_client.as_ref() {
        Some(m) => m.topics().lora_events.clone(),
        None => return,
    };
    publish_routed(
        state,
        &topic,
        payload,
        MessagePriority::Normal,
        0,
        false,
        "lora_event",
    )
    .await;
}

/// Publish raw bytes to a caller-supplied topic at
/// caller-supplied priority. Used for one-off publishes that
/// don't fit the standard topic patterns (e.g., boot-time
/// capabilities report to a dynamic topic, scripting watch-
/// session streams).
pub async fn publish_raw_bytes(
    state: &crate::AppState,
    topic: &str,
    payload: &[u8],
    priority: MessagePriority,
) {
    if let Some(ref publisher) = state.outbound_publisher {
        if let Err(e) = publisher.publish(topic, payload, priority, 1, false).await {
            warn!(
                "publish_helpers: OutboundPublisher.publish_raw({}) failed: {}",
                topic, e
            );
        }
        return;
    }
    if let Some(ref mqtt) = state.mqtt_client {
        if let Err(e) = mqtt.publish_raw(topic, payload).await {
            warn!(
                "publish_helpers: MqttClient.publish_raw({}) failed: {}",
                topic, e
            );
        }
    }
}
