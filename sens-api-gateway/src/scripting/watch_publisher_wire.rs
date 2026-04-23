//! Watch publisher wire — Batch 206 Faz 6.
//!
//! Production adapter that implements
//! `WatchPublishSink` on top of `MqttClient::
//! publish_raw`. The publisher task (Batch 204)
//! consumes this + fans watch-session payloads out
//! to per-session MQTT topics.
//!
//! Lookup pattern matches the rest of the agent's
//! MQTT-emitting background tasks: take an
//! `Arc<RwLock<AppState>>`, read the `mqtt_client`
//! Option each call. None (agent booted without
//! MQTT — dev mode) surfaces as a structured error
//! back to the publisher, which counts it under
//! `publish_errors` + retries next tick.

#![allow(dead_code)]

use std::sync::Arc;
use tokio::sync::RwLock;

use crate::AppState;
use crate::scripting::watch_sessions::WatchPublishSink;

/// MqttClient-backed sink. Cheap to clone (just an
/// Arc<RwLock<AppState>> clone).
pub struct MqttWatchPublishSink {
    state: Arc<RwLock<AppState>>,
}

impl MqttWatchPublishSink {
    pub fn new(state: Arc<RwLock<AppState>>) -> Self {
        Self { state }
    }
}

#[async_trait::async_trait]
impl WatchPublishSink for MqttWatchPublishSink {
    async fn publish(
        &self,
        topic: &str,
        payload: Vec<u8>,
    ) -> Result<(), String> {
        let s = self.state.read().await;
        match s.mqtt_client.as_ref() {
            Some(client) => client
                .publish_raw(topic, &payload)
                .await
                .map_err(|e| e.to_string()),
            None => Err(
                "mqtt client unavailable — agent booted without MQTT \
                 (dev mode) so watch payloads cannot publish"
                    .to_string(),
            ),
        }
    }
}
