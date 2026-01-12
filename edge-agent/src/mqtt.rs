//! MQTT client for cloud communication
//!
//! Handles connection to MQTT broker, publishing telemetry/status,
//! and subscribing to commands/config topics.

use anyhow::{Context, Result};
use chrono::Utc;
use rumqttc::{AsyncClient, Event, MqttOptions, Packet, QoS};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::config::{AgentConfig, ResolvedTopics};
use crate::error::AgentError;

/// MQTT client wrapper
pub struct MqttClient {
    client: AsyncClient,
    topics: ResolvedTopics,
    device_id: String,
    device_code: String,
    /// Channel to receive incoming messages
    message_rx: mpsc::Receiver<IncomingMessage>,
}

/// Incoming message from MQTT
#[derive(Debug, Clone)]
pub struct IncomingMessage {
    pub topic: String,
    pub payload: Vec<u8>,
}

/// Device status message
#[derive(Debug, Serialize)]
pub struct StatusMessage {
    pub device_id: String,
    pub device_code: String,
    pub status: DeviceStatus,
    pub timestamp: String,
    pub agent_version: String,
    pub uptime_seconds: u64,
}

/// Device status enum
#[derive(Debug, Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum DeviceStatus {
    Online,
    Offline,
    Maintenance,
    Error,
}

/// Telemetry message
#[derive(Debug, Serialize)]
pub struct TelemetryMessage {
    pub device_id: String,
    pub device_code: String,
    pub timestamp: String,
    pub metrics: TelemetryMetrics,
}

/// Telemetry metrics
#[derive(Debug, Serialize, Default)]
pub struct TelemetryMetrics {
    // System metrics
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_usage_percent: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_usage_percent: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_used_mb: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_total_mb: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_usage_percent: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_used_gb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_total_gb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature_celsius: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network_rx_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network_tx_bytes: Option<u64>,

    // Hardware metrics (PLC/Sensors via Modbus)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modbus: Option<Vec<ModbusDeviceData>>,

    // GPIO pin states
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpio: Option<Vec<GpioPinData>>,
}

/// Modbus device data for telemetry
#[derive(Debug, Serialize, Clone)]
pub struct ModbusDeviceData {
    pub device_name: String,
    pub registers: Vec<ModbusRegisterData>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

/// Modbus register value
#[derive(Debug, Serialize, Clone)]
pub struct ModbusRegisterData {
    pub name: String,
    pub address: u16,
    pub value: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

/// GPIO pin data for telemetry
#[derive(Debug, Serialize, Clone)]
pub struct GpioPinData {
    pub name: String,
    pub pin: u8,
    pub direction: String,
    pub state: String, // "high" or "low"
}

/// Command message (received from cloud)
#[derive(Debug, Deserialize)]
pub struct CommandMessage {
    pub command_id: String,
    pub command: String,
    #[serde(default)]
    pub params: serde_json::Value,
    pub timestamp: String,
}

/// Command response message
#[derive(Debug, Serialize)]
pub struct CommandResponse {
    pub command_id: String,
    pub device_id: String,
    pub success: bool,
    pub result: serde_json::Value,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl MqttClient {
    /// Create and connect MQTT client
    pub async fn new(config: &AgentConfig) -> Result<Self> {
        // Get MQTT settings
        let broker = config
            .mqtt
            .broker
            .as_ref()
            .ok_or_else(|| AgentError::Mqtt("MQTT broker not configured".into()))?;
        let username = config
            .mqtt
            .username
            .as_ref()
            .ok_or_else(|| AgentError::Mqtt("MQTT username not configured".into()))?;
        let password = config
            .mqtt
            .password
            .as_ref()
            .ok_or_else(|| AgentError::Mqtt("MQTT password not configured".into()))?;

        // Resolve topics
        let tenant_id = config
            .tenant_id
            .as_ref()
            .ok_or_else(|| AgentError::Mqtt("Tenant ID not configured".into()))?;
        let topics = config.mqtt.topics.resolve(tenant_id, &config.device_id);

        // Create MQTT options
        let mut options = MqttOptions::new(
            username, // Use username as client ID
            broker,
            config.mqtt.port,
        );

        options.set_credentials(username, password);
        options.set_keep_alive(Duration::from_secs(config.mqtt.keepalive_secs));
        options.set_clean_session(config.mqtt.clean_session);

        // Set last will (offline status)
        let last_will_payload = serde_json::to_vec(&StatusMessage {
            device_id: config.device_id.clone(),
            device_code: config.device_code.clone(),
            status: DeviceStatus::Offline,
            timestamp: Utc::now().to_rfc3339(),
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
            uptime_seconds: 0,
        })?;

        options.set_last_will(rumqttc::LastWill {
            topic: topics.status.clone(),
            message: last_will_payload.into(),
            qos: QoS::AtLeastOnce,
            retain: true,
        });

        // Create client
        let (client, mut eventloop) = AsyncClient::new(options, 100);

        // Create message channel
        let (message_tx, message_rx) = mpsc::channel(100);

        // Spawn event loop handler
        let topics_clone = topics.clone();
        tokio::spawn(async move {
            Self::handle_events(&mut eventloop, message_tx, topics_clone).await;
        });

        let mqtt_client = Self {
            client,
            topics,
            device_id: config.device_id.clone(),
            device_code: config.device_code.clone(),
            message_rx,
        };

        // Subscribe to command and config topics
        mqtt_client.subscribe().await?;

        // Publish online status
        mqtt_client.publish_status(DeviceStatus::Online, 0).await?;

        Ok(mqtt_client)
    }

    /// Handle MQTT events
    async fn handle_events(
        eventloop: &mut rumqttc::EventLoop,
        message_tx: mpsc::Sender<IncomingMessage>,
        _topics: ResolvedTopics, // Available for future topic filtering
    ) {
        loop {
            match eventloop.poll().await {
                Ok(Event::Incoming(Packet::Publish(publish))) => {
                    debug!("Received message on topic: {}", publish.topic);

                    let msg = IncomingMessage {
                        topic: publish.topic,
                        payload: publish.payload.to_vec(),
                    };

                    if message_tx.send(msg).await.is_err() {
                        warn!("Failed to send message to channel");
                    }
                }
                Ok(Event::Incoming(Packet::ConnAck(connack))) => {
                    info!("MQTT connected: {:?}", connack.code);
                }
                Ok(Event::Incoming(Packet::SubAck(_))) => {
                    debug!("Subscription acknowledged");
                }
                Ok(Event::Incoming(Packet::PingResp)) => {
                    debug!("Ping response received");
                }
                Ok(Event::Outgoing(_)) => {
                    // Outgoing events (publish, subscribe) - no action needed
                }
                Ok(_) => {
                    // Other events
                }
                Err(e) => {
                    error!("MQTT error: {:?}", e);
                    // The event loop will auto-reconnect
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    }

    /// Subscribe to command and config topics
    async fn subscribe(&self) -> Result<()> {
        info!("Subscribing to topics:");
        info!("  Commands: {}", self.topics.commands);
        info!("  Config: {}", self.topics.config);

        self.client
            .subscribe(&self.topics.commands, QoS::AtLeastOnce)
            .await
            .context("Failed to subscribe to commands topic")?;

        self.client
            .subscribe(&self.topics.config, QoS::AtLeastOnce)
            .await
            .context("Failed to subscribe to config topic")?;

        Ok(())
    }

    /// Publish device status
    pub async fn publish_status(&self, status: DeviceStatus, uptime_seconds: u64) -> Result<()> {
        let message = StatusMessage {
            device_id: self.device_id.clone(),
            device_code: self.device_code.clone(),
            status,
            timestamp: Utc::now().to_rfc3339(),
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
            uptime_seconds,
        };

        let payload = serde_json::to_vec(&message)?;

        self.client
            .publish(&self.topics.status, QoS::AtLeastOnce, true, payload)
            .await
            .context("Failed to publish status")?;

        debug!("Published status: {:?}", status);
        Ok(())
    }

    /// Publish telemetry data
    pub async fn publish_telemetry(&self, metrics: TelemetryMetrics) -> Result<()> {
        let message = TelemetryMessage {
            device_id: self.device_id.clone(),
            device_code: self.device_code.clone(),
            timestamp: Utc::now().to_rfc3339(),
            metrics,
        };

        let payload = serde_json::to_vec(&message)?;

        self.client
            .publish(&self.topics.telemetry, QoS::AtMostOnce, false, payload)
            .await
            .context("Failed to publish telemetry")?;

        debug!("Published telemetry");
        Ok(())
    }

    /// Publish command response
    pub async fn publish_response(&self, response: CommandResponse) -> Result<()> {
        let payload = serde_json::to_vec(&response)?;

        self.client
            .publish(&self.topics.responses, QoS::AtLeastOnce, false, payload)
            .await
            .context("Failed to publish response")?;

        debug!("Published response for command: {}", response.command_id);
        Ok(())
    }

    /// Receive next incoming message
    pub async fn recv(&mut self) -> Option<IncomingMessage> {
        self.message_rx.recv().await
    }

    /// Try to receive incoming message without blocking
    pub fn try_recv(&mut self) -> Option<IncomingMessage> {
        self.message_rx.try_recv().ok()
    }

    /// Disconnect from broker
    pub async fn disconnect(self) -> Result<()> {
        // Publish offline status before disconnecting
        let _ = self.publish_status(DeviceStatus::Offline, 0).await;

        self.client
            .disconnect()
            .await
            .context("Failed to disconnect MQTT")?;

        info!("MQTT disconnected");
        Ok(())
    }

    /// Get topics reference
    pub fn topics(&self) -> &ResolvedTopics {
        &self.topics
    }
}
