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
//! 2026-04-29 enterprise delivery semantics: every helper now has a checked
//! variant that returns [`PublishRouteError`].
//!
//! What it solves: command responses, alarm events and status transitions can
//! no longer fail as warn-only side effects. Critical callers use the checked
//! variants and attach command/domain context to the failure.

#![allow(dead_code)]

use serde::Serialize;
use tracing::warn;

use crate::offline_queue::MessagePriority;

/// 2026-04-29 enterprise publish error taxonomy.
///
/// What it solves: callers can distinguish serialization failure, missing MQTT
/// wiring, queue/dispatcher failure and legacy transport failure without
/// parsing log strings.
#[derive(Debug)]
pub enum PublishRouteError {
    Serialize { label: String, reason: String },
    NoMqttClient { label: String },
    Outbound { label: String, reason: String },
    Legacy { label: String, reason: String },
}

impl std::fmt::Display for PublishRouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Serialize { label, reason } => {
                write!(f, "publish serialize failed for {}: {}", label, reason)
            }
            Self::NoMqttClient { label } => {
                write!(
                    f,
                    "publish skipped for {}: mqtt client not initialized",
                    label
                )
            }
            Self::Outbound { label, reason } => {
                write!(f, "outbound publish failed for {}: {}", label, reason)
            }
            Self::Legacy { label, reason } => {
                write!(f, "legacy mqtt publish failed for {}: {}", label, reason)
            }
        }
    }
}

impl std::error::Error for PublishRouteError {}

/// Internal helper: route payload bytes through the dispatcher
/// when available, falling back to the supplied legacy direct
/// publish closure when not. Centralizes the Some/None branching
/// + bytes serialization.
async fn publish_routed_checked<P: Serialize + ?Sized>(
    state: &crate::AppState,
    topic: &str,
    payload: &P,
    priority: MessagePriority,
    qos: u8,
    retain: bool,
    legacy_label: &str,
) -> Result<(), PublishRouteError> {
    let payload_bytes = match serde_json::to_vec(payload) {
        Ok(b) => b,
        Err(e) => {
            return Err(PublishRouteError::Serialize {
                label: legacy_label.to_string(),
                reason: e.to_string(),
            });
        }
    };

    if let Some(ref publisher) = state.outbound_publisher {
        publisher
            .publish(topic, &payload_bytes, priority, qos, retain)
            .await
            .map(|_| ())
            .map_err(|e| PublishRouteError::Outbound {
                label: legacy_label.to_string(),
                reason: e.to_string(),
            })?;
        return Ok(());
    }

    if let Some(ref mqtt) = state.mqtt_client {
        return mqtt.publish_raw(topic, &payload_bytes).await.map_err(|e| {
            PublishRouteError::Legacy {
                label: legacy_label.to_string(),
                reason: e.to_string(),
            }
        });
    }

    Err(PublishRouteError::NoMqttClient {
        label: legacy_label.to_string(),
    })
}

async fn publish_routed<P: Serialize + ?Sized>(
    state: &crate::AppState,
    topic: &str,
    payload: &P,
    priority: MessagePriority,
    qos: u8,
    retain: bool,
    legacy_label: &str,
) {
    if let Err(e) =
        publish_routed_checked(state, topic, payload, priority, qos, retain, legacy_label).await
    {
        warn!("publish_helpers: {}", e);
    }
}

/// Publish an alarm-events payload to the configured alarms
/// topic. Uses [`MessagePriority::Critical`] so the drain task
/// replays alarms BEFORE telemetry/status/etc. on reconnect —
/// life-safety hot path (FDA 21 CFR 117.135, EU Machinery
/// Directive alignment).
pub async fn publish_alarms(state: &crate::AppState, payload: &impl Serialize) {
    if let Err(e) = publish_alarms_checked(state, payload).await {
        warn!("publish_helpers: {}", e);
    }
}

pub async fn publish_alarms_checked<P: Serialize + ?Sized>(
    state: &crate::AppState,
    payload: &P,
) -> Result<(), PublishRouteError> {
    let topic = match state.mqtt_client.as_ref() {
        Some(m) => m.topics().alarms.clone(),
        None => {
            return Err(PublishRouteError::NoMqttClient {
                label: "alarms".to_string(),
            });
        }
    };
    publish_routed_checked(
        state,
        &topic,
        payload,
        MessagePriority::Critical,
        1,
        false,
        "alarms",
    )
    .await
}

/// Publish telemetry metrics (CPU/memory/disk, etc.) at
/// [`MessagePriority::Normal`]. High frequency, observability
/// data — drains AFTER alarms + status on reconnect.
pub async fn publish_telemetry<P: Serialize>(state: &crate::AppState, payload: &P) {
    if let Err(e) = publish_telemetry_checked(state, payload).await {
        warn!("publish_helpers: {}", e);
    }
}

pub async fn publish_telemetry_checked<P: Serialize + ?Sized>(
    state: &crate::AppState,
    payload: &P,
) -> Result<(), PublishRouteError> {
    let topic = match state.mqtt_client.as_ref() {
        Some(m) => m.topics().telemetry.clone(),
        None => {
            return Err(PublishRouteError::NoMqttClient {
                label: "telemetry".to_string(),
            });
        }
    };
    publish_routed_checked(
        state,
        &topic,
        payload,
        MessagePriority::Normal,
        1,
        false,
        "telemetry",
    )
    .await
}

/// Publish a device-status transition (Online / Offline /
/// Maintenance / Error) at [`MessagePriority::High`] —
/// connection lifecycle events that operators + cloud automation
/// react to (e.g., alerting on stale device).
pub async fn publish_status<P: Serialize>(state: &crate::AppState, payload: &P) {
    if let Err(e) = publish_status_checked(state, payload).await {
        warn!("publish_helpers: {}", e);
    }
}

pub async fn publish_status_checked<P: Serialize + ?Sized>(
    state: &crate::AppState,
    payload: &P,
) -> Result<(), PublishRouteError> {
    let topic = match state.mqtt_client.as_ref() {
        Some(m) => m.topics().status.clone(),
        None => {
            return Err(PublishRouteError::NoMqttClient {
                label: "status".to_string(),
            });
        }
    };
    publish_routed_checked(
        state,
        &topic,
        payload,
        MessagePriority::High,
        1,
        false,
        "status",
    )
    .await
}

/// Publish a command-response payload at
/// [`MessagePriority::High`]. Cloud requests are correlated to
/// these by `command_id`; loss during outage breaks the
/// request-response loop until a timeout fires the cloud-side
/// retry — minimizing the response-loss window matters.
pub async fn publish_response<P: Serialize>(state: &crate::AppState, payload: &P) {
    if let Err(e) = publish_response_checked(state, payload).await {
        warn!("publish_helpers: {}", e);
    }
}

pub async fn publish_response_checked<P: Serialize + ?Sized>(
    state: &crate::AppState,
    payload: &P,
) -> Result<(), PublishRouteError> {
    let topic = match state.mqtt_client.as_ref() {
        Some(m) => m.topics().responses.clone(),
        None => {
            return Err(PublishRouteError::NoMqttClient {
                label: "response".to_string(),
            });
        }
    };
    publish_routed_checked(
        state,
        &topic,
        payload,
        MessagePriority::High,
        1,
        false,
        "response",
    )
    .await
}

/// Publish IO data tags at [`MessagePriority::Normal`]. High-
/// frequency telemetry-class — drains in normal priority order.
pub async fn publish_io_data<P: Serialize>(state: &crate::AppState, payload: &P) {
    if let Err(e) = publish_io_data_checked(state, payload).await {
        warn!("publish_helpers: {}", e);
    }
}

pub async fn publish_io_data_checked<P: Serialize + ?Sized>(
    state: &crate::AppState,
    payload: &P,
) -> Result<(), PublishRouteError> {
    let topic = match state.mqtt_client.as_ref() {
        Some(m) => m.topics().io_data.clone(),
        None => {
            return Err(PublishRouteError::NoMqttClient {
                label: "io_data".to_string(),
            });
        }
    };
    publish_routed_checked(
        state,
        &topic,
        payload,
        MessagePriority::Normal,
        0,
        false,
        "io_data",
    )
    .await
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
    if let Err(e) = publish_task_stats_checked(state, payload).await {
        warn!("publish_helpers: {}", e);
    }
}

pub async fn publish_task_stats_checked<P: Serialize + ?Sized>(
    state: &crate::AppState,
    payload: &P,
) -> Result<(), PublishRouteError> {
    let topic = match state.mqtt_client.as_ref() {
        Some(m) => m.topics().task_stats.clone(),
        None => {
            return Err(PublishRouteError::NoMqttClient {
                label: "task_stats".to_string(),
            });
        }
    };
    publish_routed_checked(
        state,
        &topic,
        payload,
        MessagePriority::Normal,
        0,
        false,
        "task_stats",
    )
    .await
}

/// Publish a LoRaWAN event (uplink / join / downlink ack) at
/// [`MessagePriority::Normal`].
pub async fn publish_lora_event<P: Serialize>(state: &crate::AppState, payload: &P) {
    if let Err(e) = publish_lora_event_checked(state, payload).await {
        warn!("publish_helpers: {}", e);
    }
}

pub async fn publish_lora_event_checked<P: Serialize + ?Sized>(
    state: &crate::AppState,
    payload: &P,
) -> Result<(), PublishRouteError> {
    let topic = match state.mqtt_client.as_ref() {
        Some(m) => m.topics().lora_events.clone(),
        None => {
            return Err(PublishRouteError::NoMqttClient {
                label: "lora_event".to_string(),
            });
        }
    };
    publish_routed_checked(
        state,
        &topic,
        payload,
        MessagePriority::Normal,
        0,
        false,
        "lora_event",
    )
    .await
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
    if let Err(e) = publish_raw_bytes_checked(state, topic, payload, priority).await {
        warn!("publish_helpers: {}", e);
    }
}

pub async fn publish_raw_bytes_checked(
    state: &crate::AppState,
    topic: &str,
    payload: &[u8],
    priority: MessagePriority,
) -> Result<(), PublishRouteError> {
    if let Some(ref publisher) = state.outbound_publisher {
        publisher
            .publish(topic, payload, priority, 1, false)
            .await
            .map(|_| ())
            .map_err(|e| PublishRouteError::Outbound {
                label: topic.to_string(),
                reason: e.to_string(),
            })?;
        return Ok(());
    }
    if let Some(ref mqtt) = state.mqtt_client {
        return mqtt
            .publish_raw(topic, payload)
            .await
            .map_err(|e| PublishRouteError::Legacy {
                label: topic.to_string(),
                reason: e.to_string(),
            });
    }
    Err(PublishRouteError::NoMqttClient {
        label: topic.to_string(),
    })
}
