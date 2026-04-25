//! MQTT client for cloud communication
//!
//! Handles connection to MQTT broker, publishing telemetry/status,
//! and subscribing to commands/config topics.
//!
//! ## IEC 62443 SL2 Security Features
//! - TLS 1.2+ encryption for data confidentiality (FR4)
//! - mTLS for device authentication (FR1)
//! - Last Will for device status monitoring
//!
//! ## v1.2.3 Improvements
//! - Increased message channel capacity (100 -> 500)
//! - Added backpressure handling with retry logic
//! - Improved error reporting for channel full conditions
//!
//! ## v1.3.4 Failover Support
//! - Failover infrastructure in mqtt_failover.rs (FailoverManager, BrokerEndpoint)
//! - FailoverMqttClient to be wired in a future release

use anyhow::{Context, Result};
use chrono::Utc;
use rumqttc::{AsyncClient, Event, MqttOptions, Packet, QoS, Transport};
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{debug, error, info, trace, warn};

/// Message channel capacity (v1.2.3: increased from 100 to 500)
/// Higher capacity reduces message loss during burst traffic
const MESSAGE_CHANNEL_CAPACITY: usize = 500;

/// Internal MQTT event loop buffer size (v1.2.6)
/// Should match MESSAGE_CHANNEL_CAPACITY for consistent backpressure behavior
const INTERNAL_MQTT_BUFFER_SIZE: usize = 500;

/// Maximum retry attempts when channel is full (v1.2.3)
const CHANNEL_SEND_MAX_RETRIES: u32 = 3;

/// Delay between retry attempts in milliseconds (v1.2.3)
const CHANNEL_SEND_RETRY_DELAY_MS: u64 = 10;

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
    /// Event loop task handle for graceful shutdown (v1.2.6)
    event_loop_handle: Option<tokio::task::JoinHandle<()>>,
    /// Optional metrics observer (Batch 102 observability
    /// wire). When Some, publish / receive / connect /
    /// disconnect events increment the corresponding
    /// HealthState counters + update the connection gauge.
    /// None = no-op (HC-1 backward compat + test paths that
    /// don't spin up the health server).
    health_state: Option<crate::health::HealthState>,
}

/// Incoming message from MQTT
#[derive(Debug, Clone)]
pub struct IncomingMessage {
    pub topic: String,
    pub payload: Vec<u8>,
    /// MQTT retain flag — command handler rejects retained command messages
    /// to prevent replay attacks from broker-persisted messages.
    pub retain: bool,
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
    pub agent_version: String,
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
    // LOW-42: Network counters in MB to avoid u64 precision issues in JSON parsers
    // that use 64-bit floats (IEEE 754 double has 53-bit mantissa; raw byte counters
    // on busy interfaces can exceed 2^53 after ~9PB of traffic, causing rounding).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network_rx_mb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network_tx_mb: Option<f64>,

    // Network identity
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip_address: Option<String>,

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
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct CommandMessage {
    pub command_id: String,
    pub command: String,
    #[serde(default)]
    pub params: serde_json::Value,
    pub timestamp: String,
}

/// Command response message
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
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
    /// Create and connect MQTT client (Batch 102: optional
    /// HealthState for observability wire).
    ///
    /// `health_state` — Some when the caller has a live
    /// HealthState Arc (standard main.rs boot path);
    /// None in test contexts that don't spin up the
    /// health server. All counter increments + connection
    /// gauge updates short-circuit to no-op when None.
    pub async fn new(
        config: &AgentConfig,
        health_state: Option<crate::health::HealthState>,
    ) -> Result<Self> {
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

        // SECURITY: Derive client_id deterministically from device_code so the broker
        // can resume the persistent session (clean_session=false) across reconnects.
        // A random UUID would create a new session on every restart, losing QoS 1/2
        // messages queued by the broker during the disconnect window.
        // The username prefix prevents cross-device collision; device_code is unique
        // per physical device (e.g. "RPI-A1B2C3D4").
        let client_id = format!("{}-{}", username, config.device_code);

        // Create MQTT options
        let mut options = MqttOptions::new(
            &client_id,
            broker,
            config.mqtt.port,
        );

        // v1.2.2: Use expose_secret() to access password (zeroize on drop)
        options.set_credentials(username, password.expose_secret());
        options.set_keep_alive(Duration::from_secs(config.mqtt.keepalive_secs));
        options.set_clean_session(config.mqtt.clean_session);

        // SECURITY: Limit max incoming/outgoing packet size to 1 MiB to prevent
        // pre-authentication OOM DoS via oversized PUBLISH packets. Without this
        // limit, a malicious broker or MITM can send an arbitrarily large packet
        // that exhausts memory on the constrained edge device.
        options.set_max_packet_size(1_048_576, 1_048_576);

        // Configure TLS transport if enabled (IEC 62443 SL2 FR4)
        if config.mqtt.tls.enabled {
            let tls_config =
                Self::configure_tls(&config.mqtt.tls, &config.mtls)?;
            options.set_transport(tls_config);
            info!("MQTT TLS enabled");
        }

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

        // Create client (v1.2.6: use constant for buffer size)
        let (client, mut eventloop) = AsyncClient::new(options, INTERNAL_MQTT_BUFFER_SIZE);

        // Create message channel (v1.2.3: increased capacity)
        let (message_tx, message_rx) = mpsc::channel(MESSAGE_CHANNEL_CAPACITY);

        // Spawn event loop handler with exponential backoff config (v1.2.6: track handle)
        let topics_clone = topics.clone();
        let client_clone = client.clone();
        let min_backoff = config.runtime.mqtt_reconnect_min_secs;
        let max_backoff = config.runtime.mqtt_reconnect_max_secs;
        // Batch 102: clone the HealthState Arc into the event-
        // loop task so ConnAck/Disconnect/Publish events update
        // the gauge + counters without a separate IPC channel.
        let health_state_for_task = health_state.clone();
        let event_loop_handle = tokio::spawn(async move {
            Self::handle_events(
                &mut eventloop,
                message_tx,
                client_clone,
                topics_clone,
                min_backoff,
                max_backoff,
                health_state_for_task,
            )
            .await;
        });

        let mqtt_client = Self {
            client,
            topics,
            device_id: config.device_id.clone(),
            device_code: config.device_code.clone(),
            message_rx,
            event_loop_handle: Some(event_loop_handle),
            health_state,
        };

        // Subscribe to command and config topics
        mqtt_client.subscribe().await?;

        // Publish online status
        mqtt_client.publish_status(DeviceStatus::Online, 0).await?;

        Ok(mqtt_client)
    }

    /// Handle MQTT events with exponential backoff on errors
    async fn handle_events(
        eventloop: &mut rumqttc::EventLoop,
        message_tx: mpsc::Sender<IncomingMessage>,
        client: AsyncClient,
        topics: ResolvedTopics,
        min_backoff_secs: u64,
        max_backoff_secs: u64,
        health_state: Option<crate::health::HealthState>,
    ) {
        let mut consecutive_errors: u32 = 0;
        let mut first_connect = true;

        loop {
            // Poll the event loop or detect that the message receiver has been dropped
            // (which indicates the owning MqttClient was disconnected/dropped).
            // Using tokio::select! avoids spinning forever after disconnect (LOW-36).
            //
            // EDGE-MEDIUM-005: `biased;` ensures the MQTT poll branch is always
            // checked first. Without this, tokio::select! uses a random branch order.
            // If message_tx.closed() wins the race while eventloop.poll() has a
            // partially buffered MQTT message, the poll future is dropped mid-read
            // and the partial message is lost. With biased, the MQTT branch is
            // evaluated first on every iteration, and message_tx.closed() only wins
            // when the poll is genuinely pending (no data available).
            let poll_result = tokio::select! {
                biased;
                result = eventloop.poll() => result,
                _ = message_tx.closed() => {
                    // All receivers dropped — owner has shut down, exit loop cleanly
                    debug!("MQTT event loop: message channel closed, exiting");
                    return;
                }
            };
            match poll_result {
                Ok(Event::Incoming(Packet::Publish(publish))) => {
                    consecutive_errors = 0; // Reset on success

                    // Batch 102: observability counter.
                    // Increment BEFORE the size check so
                    // dropped oversized messages still
                    // show up in the received count
                    // (operators need to see them).
                    if let Some(hs) = health_state.as_ref() {
                        hs.inc_mqtt_received();
                    }

                    // Reject oversized payloads to prevent memory exhaustion on constrained devices.
                    const MAX_MQTT_PAYLOAD: usize = 1_048_576; // 1 MiB
                    if publish.payload.len() > MAX_MQTT_PAYLOAD {
                        warn!(
                            "Dropping oversized MQTT message on topic='{}': {} bytes > {} limit",
                            publish.topic, publish.payload.len(), MAX_MQTT_PAYLOAD
                        );
                        continue;
                    }

                    debug!(
                        "MQTT message received: topic='{}', size={} bytes, qos={:?}, retain={}",
                        publish.topic,
                        publish.payload.len(),
                        publish.qos,
                        publish.retain
                    );

                    let topic_for_log = publish.topic.clone();
                    let mut msg = IncomingMessage {
                        topic: publish.topic,
                        payload: publish.payload.to_vec(),
                        retain: publish.retain,
                    };

                    // v1.2.3: Retry logic with backpressure handling
                    // Optimized: reuse msg from TrySendError::Full instead of cloning
                    let mut send_attempts = 0u32;
                    loop {
                        match message_tx.try_send(msg) {
                            Ok(()) => {
                                if send_attempts > 0 {
                                    debug!(
                                        "Message sent after {} retries (topic: {})",
                                        send_attempts, topic_for_log
                                    );
                                }
                                break;
                            }
                            Err(mpsc::error::TrySendError::Full(returned_msg)) => {
                                send_attempts = send_attempts.saturating_add(1);
                                if send_attempts >= CHANNEL_SEND_MAX_RETRIES {
                                    error!(
                                        "Message channel full after {} retries. \
                                        Message dropped (topic: {}). Consider increasing \
                                        MESSAGE_CHANNEL_CAPACITY or processing messages faster.",
                                        send_attempts, topic_for_log
                                    );
                                    break;
                                }
                                warn!(
                                    "Message channel full (attempt {}/{}), retrying...",
                                    send_attempts, CHANNEL_SEND_MAX_RETRIES
                                );
                                // Reuse the returned message instead of cloning
                                msg = returned_msg;
                                tokio::time::sleep(Duration::from_millis(
                                    CHANNEL_SEND_RETRY_DELAY_MS,
                                ))
                                .await;
                            }
                            Err(mpsc::error::TrySendError::Closed(_)) => {
                                error!(
                                    "Message channel closed. Receiver dropped. \
                                    This indicates a critical error in the command handler."
                                );
                                break;
                            }
                        }
                    }
                }
                Ok(Event::Incoming(Packet::ConnAck(connack))) => {
                    consecutive_errors = 0; // Reset on successful connection
                    info!(
                        "🟢 MQTT CONNECTED: code={:?}, session_present={}",
                        connack.code, connack.session_present
                    );

                    // Batch 102: flip the connection gauge ON
                    // + bump mqtt_last_connected timestamp via
                    // set_mqtt_connected(true).
                    if let Some(hs) = health_state.as_ref() {
                        hs.set_mqtt_connected(true);
                    }

                    // Resubscribe after reconnection: when clean_session=true,
                    // the broker drops all subscriptions on disconnect.
                    // Default is now false (persistent session), but resubscribe if
                    // session_present=false (broker lost session). Skip on first
                    // connect since new() already calls subscribe().
                    if !first_connect || !connack.session_present {
                        if !first_connect {
                            info!("Resubscribing to topics after reconnection...");
                        }
                        if let Err(e) = client
                            .subscribe(&topics.commands, QoS::AtLeastOnce)
                            .await
                        {
                            error!("Failed to resubscribe to commands: {:?}", e);
                        }
                        if let Err(e) = client
                            .subscribe(&topics.config, QoS::AtLeastOnce)
                            .await
                        {
                            error!("Failed to resubscribe to config: {:?}", e);
                        }
                    }
                    first_connect = false;
                }
                Ok(Event::Incoming(Packet::SubAck(suback))) => {
                    // v1.2.6: Log subscription acknowledgment with QoS
                    info!(
                        "📋 MQTT subscription acknowledged: qos={:?}",
                        suback.return_codes
                    );
                }
                Ok(Event::Incoming(Packet::PingResp)) => {
                    trace!("🏓 MQTT ping response received (connection alive)");
                }
                Ok(Event::Incoming(Packet::Disconnect)) => {
                    // v1.2.6: Log disconnection events
                    warn!("🔴 MQTT DISCONNECTED by broker");

                    // Batch 102: flip the connection gauge
                    // OFF. Reconnect attempts hit the
                    // ConnAck path above on success.
                    if let Some(hs) = health_state.as_ref() {
                        hs.set_mqtt_connected(false);
                    }
                }
                Ok(Event::Outgoing(outgoing)) => {
                    // v1.2.6: Log outgoing events at trace level
                    trace!("📤 MQTT outgoing event: {:?}", outgoing);
                }
                Ok(event) => {
                    // v1.2.6: Log other events at trace level
                    trace!("MQTT event: {:?}", event);
                }
                Err(e) => {
                    consecutive_errors = consecutive_errors.saturating_add(1);

                    // Exponential backoff with jitter: base * 2^(errors-1), capped at max.
                    // Jitter prevents thundering herd when broker recovers and all edge
                    // agents reconnect simultaneously (IEC 62443 FR-7 availability).
                    // Uses "full jitter" strategy: uniform random in [0, backoff].
                    let shift_amount = consecutive_errors.saturating_sub(1).min(6) as u32;
                    let multiplier = 1u64 << shift_amount;
                    let base_backoff_secs = min_backoff_secs
                        .saturating_mul(multiplier)
                        .min(max_backoff_secs);

                    // Full jitter: random value between 50% and 100% of base backoff.
                    // This spreads reconnection attempts across the window while
                    // maintaining a minimum delay floor (50% of computed backoff).
                    let jitter_range_ms = (base_backoff_secs * 500) as u64; // 50% in ms
                    let jitter_ms = if jitter_range_ms > 0 {
                        // Simple PRNG: use lower bits of current time as entropy source.
                        // No cryptographic requirement here — just spread reconnections.
                        let seed = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .subsec_nanos() as u64;
                        seed % jitter_range_ms
                    } else {
                        0
                    };
                    let backoff_ms = (base_backoff_secs * 500) + jitter_ms; // 50% base + jitter
                    let backoff_display = backoff_ms as f64 / 1000.0;

                    error!(
                        "MQTT error (attempt {}): {:?}. Retrying in {:.1}s (base={}s, jitter={}ms)",
                        consecutive_errors, e, backoff_display, base_backoff_secs, jitter_ms
                    );

                    tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
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
        let payload_len = payload.len();

        self.client
            .publish(&self.topics.status, QoS::AtLeastOnce, true, payload)
            .await
            .context("Failed to publish status")?;
        self.record_publish();

        // v1.2.6: Enhanced publish logging
        info!(
            "📤 MQTT status published: topic='{}', status={:?}, size={} bytes",
            self.topics.status, status, payload_len
        );
        Ok(())
    }

    /// Publish telemetry data
    pub async fn publish_telemetry(&self, metrics: TelemetryMetrics) -> Result<()> {
        // Generate a single timestamp for the entire telemetry message so that all
        // fields in the payload share exactly one wall-clock observation.
        // Calling Utc::now() once avoids microsecond skew between fields (MED-27).
        let now_ts = Utc::now().to_rfc3339();

        let message = TelemetryMessage {
            device_id: self.device_id.clone(),
            device_code: self.device_code.clone(),
            timestamp: now_ts,
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
            metrics,
        };

        let payload = serde_json::to_vec(&message)?;
        let payload_len = payload.len();

        // QoS::AtLeastOnce (1) ensures telemetry is acknowledged by the broker.
        // QoS 0 ("fire-and-forget") drops silently during broker reconnect, causing
        // data gaps in TimescaleDB that are invisible to the monitoring stack.
        self.client
            .publish(&self.topics.telemetry, QoS::AtLeastOnce, false, payload)
            .await
            .context("Failed to publish telemetry")?;
        self.record_publish();

        // v1.2.6: Enhanced telemetry logging
        info!(
            "📤 MQTT telemetry published: topic='{}', size={} bytes",
            self.topics.telemetry, payload_len
        );
        Ok(())
    }

    /// Publish command response
    pub async fn publish_response(&self, response: CommandResponse) -> Result<()> {
        let payload = serde_json::to_vec(&response)?;
        let payload_len = payload.len();
        let command_id = response.command_id.clone();
        let success = response.success;

        self.client
            .publish(&self.topics.responses, QoS::AtLeastOnce, false, payload)
            .await
            .context("Failed to publish response")?;
        self.record_publish();

        // v1.2.6: Enhanced response logging
        info!(
            "📤 MQTT response published: topic='{}', command_id='{}', success={}, size={} bytes",
            self.topics.responses, command_id, success, payload_len
        );
        Ok(())
    }

    /// Publish I/O data (QoS 0, not retained - latest value is what matters)
    pub async fn publish_io_data(&self, payload: &impl serde::Serialize) -> Result<()> {
        let data = serde_json::to_vec(payload)?;
        self.client
            .publish(&self.topics.io_data, rumqttc::QoS::AtMostOnce, false, data)
            .await?;
        self.record_publish();
        Ok(())
    }

    /// Publish alarm events (QoS 1, not retained - must be delivered)
    pub async fn publish_alarms(&self, payload: &impl serde::Serialize) -> Result<()> {
        let data = serde_json::to_vec(payload)?;
        self.client
            .publish(&self.topics.alarms, rumqttc::QoS::AtLeastOnce, false, data)
            .await?;
        self.record_publish();
        Ok(())
    }

    /// Publish LoRa event (v1.5.0: uplink/join/downlink events, QoS 0)
    pub async fn publish_lora_event(&self, payload: &impl serde::Serialize) -> Result<()> {
        let data = serde_json::to_vec(payload)?;
        self.client
            .publish(&self.topics.lora_events, rumqttc::QoS::AtMostOnce, false, data)
            .await?;
        self.record_publish();
        Ok(())
    }

    /// Publish raw bytes to an arbitrary MQTT topic.
    ///
    /// Used for one-off publishes that don't fit the standard topic patterns
    /// (e.g. boot-time capabilities report to a dynamic topic).
    pub async fn publish_raw(&self, topic: &str, payload: &[u8]) -> Result<()> {
        self.client
            .publish(topic, QoS::AtLeastOnce, false, payload)
            .await
            .with_context(|| format!("Failed to publish to {}", topic))?;
        self.record_publish();
        debug!("Published {} bytes to {}", payload.len(), topic);
        Ok(())
    }

    /// Internal helper: convert u8 QoS to rumqttc::QoS.
    /// Used by the [`crate::outbound_publisher::MqttPublishSink`]
    /// impl below + by a future Batch #254+ migration of the
    /// existing publish_* methods to a single canonical publish
    /// path. Centralizes the u8 → enum conversion so adding QoS=2
    /// support (currently no caller uses ExactlyOnce) is a one-
    /// line change.
    pub(crate) fn qos_from_u8(qos: u8) -> QoS {
        match qos {
            0 => QoS::AtMostOnce,
            1 => QoS::AtLeastOnce,
            2 => QoS::ExactlyOnce,
            // Unknown value — treat as QoS 1 (the conservative
            // default for "must be delivered"). Caller-supplied u8
            // beyond {0,1,2} indicates a config or wire-format
            // bug; we don't drop the message but we do log via the
            // record_publish path.
            _ => QoS::AtLeastOnce,
        }
    }
}

// =============================================================================
// MqttPublishAdapter — Batch #253 ARC-002 part 3
// =============================================================================
//
// Lightweight clone-able adapter that holds JUST the pieces of
// `MqttClient` needed for the
// `outbound_publisher::MqttPublishSink` trait: the rumqttc
// `AsyncClient` (internally Arc-wrapped + Clone-able) + an
// optional `HealthState` for the `record_publish` observability
// hook.
//
// **Why a separate struct:** `MqttClient` itself is NOT Clone
// because it owns a `mpsc::Receiver<IncomingMessage>` (single-
// owner channel for inbound traffic). The OutboundPublisher
// dispatcher needs an `Arc<S: MqttPublishSink>` for the publish-
// path; wrapping MqttClient itself in an Arc would force every
// existing `&mut MqttClient` consumer to thread the Arc — a much
// larger refactor than this batch's scope. The lightweight
// adapter keeps MqttClient's existing struct shape intact while
// giving the outbound dispatcher exactly the surface it needs.
//
// The adapter is constructed via `MqttClient::publish_adapter()`
// at boot, before the message-loop consumer takes ownership of
// the inbound receiver. Production wires ONE adapter Arc shared
// between OutboundPublisher (direct path) and DrainTask (replay
// path) so both paths flow through identical record_publish
// instrumentation.
#[derive(Clone)]
pub struct MqttPublishAdapter {
    client: AsyncClient,
    health_state: Option<crate::health::HealthState>,
}

impl MqttClient {
    /// Extract a clone-able publish adapter that the
    /// `outbound_publisher::OutboundPublisher` + `DrainTask` can
    /// share. The returned adapter holds clones of the internal
    /// rumqttc client + the optional health-state observer; the
    /// `MqttClient` itself is unaffected by this call (no
    /// ownership transfer).
    pub fn publish_adapter(&self) -> MqttPublishAdapter {
        MqttPublishAdapter {
            client: self.client.clone(),
            health_state: self.health_state.clone(),
        }
    }
}

impl MqttPublishAdapter {
    #[inline]
    fn record_publish(&self) {
        if let Some(hs) = self.health_state.as_ref() {
            hs.inc_mqtt_sent();
        }
    }
}

#[async_trait::async_trait]
impl crate::outbound_publisher::MqttPublishSink for MqttPublishAdapter {
    async fn publish_to_broker(
        &self,
        topic: &str,
        payload: &[u8],
        qos: u8,
        retain: bool,
    ) -> Result<(), crate::outbound_publisher::PublishSinkError> {
        use crate::outbound_publisher::PublishSinkError;
        let qos_enum = MqttClient::qos_from_u8(qos);

        // rumqttc 0.24 ClientError variants don't expose a
        // structured "broker disconnected" tag — every transport
        // failure surfaces as a generic ClientError. The
        // OutboundPublisher dispatcher treats `Transport(_)` as
        // "do not enqueue, propagate error" and `Disconnected` as
        // "fall through to enqueue". We deliberately classify ALL
        // rumqttc errors as Transport here:
        //
        // - rumqttc owns reconnect logic internally; a transient
        //   broker drop is invisible to the caller (publish()
        //   future blocks on the reconnect-buffer until the
        //   eventloop reconnects, then returns Ok).
        // - The `is_connected` check in the dispatcher (read from
        //   HealthState atomic) IS the canonical "broker down"
        //   signal at the start of publish; rumqttc-side errors
        //   AFTER that check are genuine transport faults
        //   (payload too large, eventloop dropped, etc.) — those
        //   should surface to caller, not silently get queued.
        match self.client.publish(topic, qos_enum, retain, payload).await {
            Ok(()) => {
                self.record_publish();
                Ok(())
            }
            Err(e) => Err(PublishSinkError::Transport(e.to_string())),
        }
    }
}

// Continuation of `impl MqttClient` (Batch #253 split — the
// MqttPublishAdapter struct + its trait impl interleave between
// MqttClient method blocks; Rust permits multiple `impl` blocks
// for the same type).
impl MqttClient {
    /// Private Batch 102 observability hook — called by every
    /// publish method after a successful `.client.publish()
    /// .await?`. Increments the MQTT sent counter on the
    /// registered HealthState (no-op when
    /// `health_state = None`).
    ///
    /// Kept private + single-source so adding a new publish
    /// method automatically picks up instrumentation if the
    /// author calls this helper. A future code review can
    /// grep for `.client.publish(` without `record_publish`
    /// to find uninstrumented paths.
    #[inline]
    fn record_publish(&self) {
        if let Some(hs) = self.health_state.as_ref() {
            hs.inc_mqtt_sent();
        }
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
    pub async fn disconnect(mut self) -> Result<()> {
        // Publish offline status before disconnecting
        let _ = self.publish_status(DeviceStatus::Offline, 0).await;

        self.client
            .disconnect()
            .await
            .context("Failed to disconnect MQTT")?;

        // v1.2.6: Abort event loop task for graceful shutdown
        if let Some(handle) = self.event_loop_handle.take() {
            handle.abort();
            // Wait briefly for task to terminate
            let _ = tokio::time::timeout(std::time::Duration::from_millis(100), handle).await;
        }

        info!("MQTT disconnected");
        Ok(())
    }

    /// Get topics reference
    pub fn topics(&self) -> &ResolvedTopics {
        &self.topics
    }

    /// Device identifier accessor (Batch #255 ARC-002 wire).
    /// Used by `publish_helpers` to populate the envelope shape
    /// that the legacy `publish_status` / `publish_telemetry`
    /// internal methods built. Returning `&str` keeps the call
    /// site allocation-free.
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// Device code accessor (Batch #255 ARC-002 wire).
    pub fn device_code(&self) -> &str {
        &self.device_code
    }

    /// Configure TLS transport (IEC 62443 SL2 FR4: Data Confidentiality)
    ///
    /// Supports:
    /// - Server certificate verification via CA cert
    /// - Client certificate authentication (mTLS) for FR1 compliance
    fn configure_tls(
        tls_config: &crate::config::MqttTlsConfig,
        mtls_config: &crate::config::MtlsConfig,
    ) -> Result<Transport> {
        use rumqttc::TlsConfiguration;

        // LOW/H-01: validate verify_hostname config is not set to false.
        // This field was parsed from YAML but never enforced — an operator who
        // sets verify_hostname: false gets no effect (rustls always verifies),
        // creating a false sense of control. Fail-fast with a clear error.
        if !tls_config.verify_hostname {
            return Err(anyhow::anyhow!(
                "SECURITY: verify_hostname=false is not supported. rustls always \
                 verifies the broker hostname against the TLS certificate. To connect \
                 to a broker with a self-signed cert, add the CA to ca_cert_path instead."
            ));
        }

        // rustls 0.23+ requires explicit CryptoProvider when both ring and aws-lc-rs
        // are compiled in. Install ring (portable, good ARM cross-compilation support).
        // install_default() returns Err if already installed — ignore that.
        let _ = rumqttc::tokio_rustls::rustls::crypto::ring::default_provider().install_default();

        // Read CA certificate for server verification
        let ca_cert = if let Some(ref ca_path) = tls_config.ca_cert_path {
            let ca_bytes = std::fs::read(ca_path)
                .with_context(|| format!("Failed to read CA certificate: {}", ca_path))?;
            info!("Loaded CA certificate from: {}", ca_path);
            ca_bytes
        } else {
            // Use system root certificates if no CA specified
            info!("Using system root certificates for TLS");
            Vec::new()
        };

        // Read client certificate and key for mTLS (optional)
        // v1.2.4: Rust 2024 edition - implicit borrowing in patterns
        let client_auth = if let (Some(cert_path), Some(key_path)) =
            (&tls_config.client_cert_path, &tls_config.client_key_path)
        {
            let cert_bytes = std::fs::read(cert_path)
                .with_context(|| format!("Failed to read client certificate: {}", cert_path))?;
            let key_bytes = std::fs::read(key_path)
                .with_context(|| format!("Failed to read client key: {}", key_path))?;
            info!("Loaded client certificate from: {}", cert_path);
            Some((cert_bytes, key_bytes))
        } else {
            None
        };

        // Build TLS configuration
        // Note: rumqttc requires explicit CA certificate for TLS validation
        // If no CA cert is provided, return error (security requirement)
        if ca_cert.is_empty() {
            // No custom CA certificate — use system CA store.
            // Let's Encrypt certificates are pre-installed on most Linux distributions
            // including Raspberry Pi OS, so this works out of the box for production.
            use rustls_native_certs::load_native_certs;
            let native_certs = load_native_certs();
            if !native_certs.errors.is_empty() {
                for err in &native_certs.errors {
                    warn!("Error loading native certificate: {:?}", err);
                }
            }
            let mut root_store = rumqttc::tokio_rustls::rustls::RootCertStore::empty();
            for cert in native_certs.certs {
                if let Err(e) = root_store.add(cert) {
                    warn!("Failed to add native certificate to root store: {:?}", e);
                }
            }
            if root_store.is_empty() {
                return Err(anyhow::anyhow!(
                    "TLS enabled but no CA certificates available (neither custom CA path nor system CA store). \
                     Ensure system CA certificates are installed (e.g., ca-certificates package)."
                ));
            }
            info!("Loaded {} system CA certificates for MQTT TLS", root_store.len());

            // Batch 139 Sprint 6.6/6.8: install
            // SuderraServerCertVerifier when configured
            // (mtls.mode != Legacy OR pins supplied).
            // Legacy-no-pins path returns None from
            // build_suderra_verifier + we fall through
            // to the rustls default webpki verifier — HC-1
            // backward compat.
            //
            // Root-store is shared between the default
            // builder AND the SuderraServerCertVerifier's
            // inner WebPkiServerVerifier so X.509 chain
            // trust uses the SAME anchors either path.
            let root_store_arc = Arc::new(root_store.clone());
            let provider = rumqttc::tokio_rustls::rustls::crypto::ring::default_provider();
            let sig_algs = provider.signature_verification_algorithms;
            let suderra_verifier = crate::mtls::build_suderra_verifier(
                mtls_config.mode,
                sig_algs,
                &mtls_config.pinned_leaf_fingerprints_hex,
                root_store_arc,
            )
            .map_err(|e| {
                anyhow::anyhow!(
                    "SuderraServerCertVerifier build failed (check mtls.mode + pinned_leaf_fingerprints_hex): {}",
                    e
                )
            })?;

            let mut client_config = if let Some(verifier) = suderra_verifier {
                info!(
                    "mTLS: SuderraServerCertVerifier installed (mode={:?}, pins={})",
                    mtls_config.mode,
                    mtls_config.pinned_leaf_fingerprints_hex.len()
                );
                rumqttc::tokio_rustls::rustls::ClientConfig::builder()
                    .dangerous()
                    .with_custom_certificate_verifier(verifier)
                    .with_no_client_auth()
            } else {
                info!(
                    "mTLS: Suderra custom verifier NOT installed (mode={:?}, no pins — HC-1 default webpki only)",
                    mtls_config.mode
                );
                rumqttc::tokio_rustls::rustls::ClientConfig::builder()
                    .with_root_certificates(root_store)
                    .with_no_client_auth()
            };
            client_config.alpn_protocols = vec![b"mqtt".to_vec()];

            let tls = TlsConfiguration::Rustls(Arc::new(client_config));
            return Ok(Transport::Tls(tls));
        }

        // Batch 139: custom-CA branch keeps
        // `TlsConfiguration::Simple` which rumqttc builds
        // internally — it does NOT support custom
        // verifiers. Surface this as a WARN log when
        // operator has configured Suderra mTLS so they
        // know the gates are INACTIVE on this path +
        // migrate to system-CA mode for Suderra-policy
        // enforcement. Strict mode + custom CA is an
        // explicit fail-closed because Strict requires
        // pinning which isn't reachable here.
        if !matches!(
            mtls_config.mode,
            crate::mtls::MtlsMode::Legacy
        ) {
            warn!(
                "mTLS: custom-CA TLS branch in use + mtls.mode={:?} — Suderra policy gates (fingerprint pinning, age caps) are NOT ACTIVE on this path (rumqttc::TlsConfiguration::Simple does not support custom verifiers). Migrate to system-CA TLS for Suderra mTLS enforcement.",
                mtls_config.mode
            );
        }
        if matches!(mtls_config.mode, crate::mtls::MtlsMode::Strict) {
            return Err(anyhow::anyhow!(
                "mTLS Strict mode is incompatible with custom-CA TLS branch (rumqttc::TlsConfiguration::Simple cannot install SuderraServerCertVerifier). Either migrate to system-CA TLS (omit mqtt.tls.ca_cert_path) or downgrade mtls.mode to Warn during rollout."
            ));
        }

        let tls = TlsConfiguration::Simple {
            ca: ca_cert,
            alpn: Some(vec![b"mqtt".to_vec()]),
            client_auth,
        };

        Ok(Transport::Tls(tls))
    }

}
