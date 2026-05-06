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
    mtls_verifier_state: Option<Arc<crate::mtls::MtlsVerifierState>>,
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
    /// **Batch #307 Faz 6 two-person integrity flow-through.**
    /// True when envelope_adapter verified BOTH the primary
    /// signature AND the co-approver signature against the
    /// same canonical-bytes transcript (Batch #306 gate).
    /// False for legacy CommandMessage parses (no envelope =>
    /// no co-approver concept) AND for envelopes that carried
    /// no co-approver fields. The handler-side gate
    /// (cmd_force_value + future cmd_update_firmware /
    /// cmd_safe_state_trigger / cmd_deploy_program /
    /// cmd_reboot) reads this flag.
    ///
    /// `#[serde(default, skip_deserializing)]` keeps it
    /// Rust-internal: the wire format never carries this
    /// field; the adapter populates it post-verify; legacy
    /// payloads default to false.
    #[serde(default, skip_deserializing)]
    pub verified_co_approver: bool,
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
        let mut options = MqttOptions::new(&client_id, broker, config.mqtt.port);

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
        let mut mtls_verifier_state = None;
        if config.mqtt.tls.enabled {
            let (tls_config, verifier_state) =
                Self::configure_tls(&config.mqtt.tls, &config.mtls)?;
            mtls_verifier_state = verifier_state;
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
            mtls_verifier_state,
            message_rx,
            event_loop_handle: Some(event_loop_handle),
            health_state,
        };

        // Subscribe to command and config topics
        mqtt_client.subscribe().await?;

        // Initial Online status publish was REMOVED from
        // MqttClient::new in Batch #268 — see ORPHAN-MEDIUM-022.
        //
        // **Why removed:** The publish-status path needs to route
        // through the broker-aware OutboundPublisher dispatcher
        // (Batch #251-#255 ARC-002 wire) so a transient broker
        // outage during the connect→publish window queues the
        // status transition to disk + replays on reconnect.
        // Calling publish_status here on the bare MqttClient
        // bypasses the queue protection — a status loss during
        // intermittent broker availability defeats the
        // operator-facing "device just came online" gauge.
        //
        // **Replacement:** main.rs boot sequence calls
        // `publish_helpers::publish_status` from a helper invoked
        // AFTER `init_outbound_publisher` populates the
        // dispatcher Arc, ensuring the Online-publish path goes
        // through the queue-aware route. Wire location:
        // `main.rs::publish_initial_online_status` post-init
        // helper.

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
                            publish.topic,
                            publish.payload.len(),
                            MAX_MQTT_PAYLOAD
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
                        if let Err(e) = client.subscribe(&topics.commands, QoS::AtLeastOnce).await {
                            error!("Failed to resubscribe to commands: {:?}", e);
                        }
                        if let Err(e) = client.subscribe(&topics.config, QoS::AtLeastOnce).await {
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
            .publish(
                &self.topics.lora_events,
                rumqttc::QoS::AtMostOnce,
                false,
                data,
            )
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

    /// Hot-reloadable mTLS verifier state, present only when MQTT TLS is enabled.
    pub fn mtls_verifier_state(&self) -> Option<&Arc<crate::mtls::MtlsVerifierState>> {
        self.mtls_verifier_state.as_ref()
    }

    /// Configure TLS transport (IEC 62443 SL2 FR4: Data Confidentiality)
    ///
    /// Supports:
    /// - Server certificate verification via CA cert
    /// - Client certificate authentication (mTLS) for FR1 compliance
    fn configure_tls(
        tls_config: &crate::config::MqttTlsConfig,
        mtls_config: &crate::config::MtlsConfig,
    ) -> Result<(Transport, Option<Arc<crate::mtls::MtlsVerifierState>>)> {
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

        // Phase 1.1.5 (ORPHAN-HIGH-035 closure) — `install_default()` removed.
        //
        // Pre-Phase-1.1.5 this site planted `rustls::crypto::ring::default_provider()`
        // (the UNRESTRICTED ring provider, every TLS 1.2 ECDHE suite included)
        // as the process-wide default. The Suderra cipher allowlist (TLS 1.3 +
        // 3 AEAD suites) was applied only to MQTT via explicit
        // `ClientConfig::builder_with_provider(suderra_provider)` further down
        // this function. Every HTTPS reqwest callsite that didn't carry an
        // explicit provider would inherit the unrestricted default — silently
        // exposing `provisioning.rs::activate` (single-use device-bootstrap
        // token exchange — edge-expert flagged as the highest-attack-surface
        // HTTPS callsite), `firmware.rs::download_file`, and
        // `scripting/engine.rs` HTTP webhooks to TLS 1.2 cipher-suite-downgrade
        // attacks regardless of how carefully MQTT was hardened.
        //
        // Tier-1 MAKE-IT-IMPOSSIBLE (Phase 1.1.5): every TLS callsite in the
        // agent now MUST go through one of these two factories:
        //   - `crate::mtls::build_suderra_crypto_provider()` for the rustls
        //     `ClientConfig::builder_with_provider(...)` path (MQTT transport).
        //   - `crate::mtls::build_suderra_https_client_config()` for reqwest's
        //     `use_preconfigured_tls(...)` path (HTTPS to cloud APIs).
        //
        // If a future caller skips both and writes
        // `rustls::ClientConfig::builder()` without a provider arg, rustls
        // panics at the builder call ("no process-level CryptoProvider
        // available") — fail-fast at boot/dev/CI rather than silent bypass in
        // production. The `d4_d6_mtls_unified::no_install_default_in_non_test_code`
        // invariant is the source-grep detector that catches a regression.

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

        // PHASE 0.1 — Unified rustls path for system-CA + custom-CA branches.
        //
        // WHY: Pre-Phase-0 the custom-CA branch used `TlsConfiguration::Simple` which
        // rumqttc builds internally — that wrapper does NOT support custom verifiers,
        // so SuderraServerCertVerifier (mode-aware pinning + age cap + chain depth
        // gates) could not run on operator-supplied CA chains. That made Strict +
        // custom-CA architecturally impossible. The fix is to build the RootCertStore
        // from operator PEM bytes and feed it through the same ClientConfig builder
        // used by the system-CA branch — verifier wiring then applies uniformly
        // regardless of CA source. Closes orphan finding ORPHAN-CRITICAL-029.
        //
        // WHY also: pre-Phase-0 the system-CA path silently dropped client_auth
        // (`.with_no_client_auth()` was hard-coded), while the custom-CA path
        // propagated it via TlsConfiguration::Simple. The unified pipeline below
        // honors client_auth on BOTH paths. Closes ORPHAN-MEDIUM-030.

        // Build a unified RootCertStore from EITHER native certs OR custom CA PEM bytes.
        let mut root_store = rumqttc::tokio_rustls::rustls::RootCertStore::empty();
        if ca_cert.is_empty() {
            // System-CA path — pull from rustls-native-certs.
            // Let's Encrypt certificates are pre-installed on most Linux distributions
            // including Raspberry Pi OS, so this works out of the box for production.
            use rustls_native_certs::load_native_certs;
            let native_certs = load_native_certs();
            for err in &native_certs.errors {
                warn!("Error loading native certificate: {:?}", err);
            }
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
            info!(
                "Loaded {} system CA certificates for MQTT TLS",
                root_store.len()
            );
        } else {
            // ORPHAN-MEDIUM-036: per-entry parse failures emit at `error!`
            // severity so structured-log subscribers treating error-level as
            // audit-relevant capture them. A summary event after the loop
            // surfaces partial-load explicitly.
            use rustls::pki_types::CertificateDer;
            use rustls::pki_types::pem::PemObject;
            let mut added = 0usize;
            let mut parse_errs = 0usize;
            for cert_result in CertificateDer::pem_slice_iter(&ca_cert) {
                match cert_result {
                    Ok(cert) => match root_store.add(cert) {
                        Ok(()) => added += 1,
                        Err(e) => {
                            tracing::error!(
                                event_type = "mtls_ca_bundle_entry_rejected",
                                reason = ?e,
                                "Failed to add custom CA certificate to root store"
                            );
                            parse_errs += 1;
                        }
                    },
                    Err(e) => {
                        tracing::error!(
                            event_type = "mtls_ca_bundle_parse_error",
                            reason = ?e,
                            "Failed to parse custom CA PEM entry"
                        );
                        parse_errs += 1;
                    }
                }
            }
            if root_store.is_empty() {
                return Err(anyhow::anyhow!(
                    "Custom CA file contained no valid certificates ({} parse errors). \
                     Ensure the file is PEM-encoded with one or more CERTIFICATE blocks.",
                    parse_errs
                ));
            }
            if parse_errs > 0 {
                // Partial-load: at least one PEM block parsed, but not all. Surface as
                // `error!` so the structured-log pipeline treats this as an integrity
                // event, not background noise. Operator should investigate which
                // entries failed (preceding error-level events) and rotate the bundle.
                tracing::error!(
                    event_type = "mtls_ca_bundle_partial_load",
                    added = added,
                    parse_errs = parse_errs,
                    "Custom CA bundle partially loaded — operator action required \
                     (see preceding mtls_ca_bundle_entry_rejected / mtls_ca_bundle_parse_error events)"
                );
                // Phase 1.1.5 / ORPHAN-MEDIUM-036 closure: ALSO emit through
                // the ADR-020 audit-sink HMAC chain. The `tracing::error!`
                // above is structured-log-only — whether a subscriber bridges
                // error-level to audit is deployment-config-dependent. The
                // explicit audit emit here makes the partial-load event
                // forensically queryable offline via the audit-verify CLI
                // independent of the active tracing subscriber.
                let detail = serde_json::json!({
                    "added": added,
                    "parse_errs": parse_errs,
                });
                crate::audit::try_emit_mtls_forensic_event(
                    crate::audit::AuditAction::MtlsCaBundleParsePartial,
                    "mtls.ca_bundle.partial_load",
                    detail,
                );
            } else {
                info!("Loaded {} custom CA certificate(s) for MQTT TLS", added);
            }
        }

        // PHASE 0.2 — handshake-time cipher allowlist gate.
        //
        // The Suderra CryptoProvider is `rustls::crypto::ring::default_provider`
        // with `cipher_suites` narrowed to `CIPHER_SUITE_ALLOWLIST` (3 TLS 1.3
        // suites). rustls negotiates from this slice, so non-allowlist suites
        // cannot appear in the ClientHello — Tier-1 MAKE-IT-IMPOSSIBLE for
        // cipher-suite downgrade. Replaces the dead-code Gate 4 in
        // `verify_leaf_cert` (cipher isn't finalized at the ServerCertVerifier
        // callback). Closes ORPHAN-HIGH-031.
        //
        // `signature_verification_algorithms` comes from the SAME provider so
        // SuderraServerCertVerifier and the rustls handshake share signature
        // algorithm policy.
        let suderra_provider = crate::mtls::build_suderra_crypto_provider();
        let sig_algs = suderra_provider.signature_verification_algorithms;

        // Phase 1.1.4 (D-4 + D-6): construct the hot-reloadable verifier
        // state and install it as a delegating wrapper. The wrapper queries
        // the state on every handshake, so cmd_update_cert_pinning's
        // rebuild takes effect on the NEXT TLS connect with no
        // ClientConfig reconstruction. Legacy + no-pins still flows
        // through the inner fallback WebPkiServerVerifier (HC-1).
        let root_store_arc = Arc::new(root_store);
        let mtls_verifier_state = Arc::new(
            crate::mtls::MtlsVerifierState::new(
                mtls_config.mode,
                &mtls_config.pinned_leaf_fingerprints_hex,
                sig_algs,
                root_store_arc.clone(),
            )
            .map_err(|e| {
                anyhow::anyhow!(
                    "SuderraServerCertVerifier build failed (check mtls.mode + pinned_leaf_fingerprints_hex): {}",
                    e
                )
            })?,
        );
        let fallback = crate::mtls::build_fallback_webpki(
            root_store_arc,
            suderra_provider.clone(),
        )
        .map_err(|e| anyhow::anyhow!(e))?;
        let verifier = Arc::new(crate::mtls::MtlsDelegatingVerifier::new(
            mtls_verifier_state.clone(),
            fallback,
        ));
        info!(
            "mTLS: MtlsDelegatingVerifier installed (mode={:?}, pins={})",
            mtls_config.mode,
            mtls_config.pinned_leaf_fingerprints_hex.len()
        );

        let builder = rumqttc::tokio_rustls::rustls::ClientConfig::builder_with_provider(
            suderra_provider,
        )
        .with_protocol_versions(&[&rumqttc::tokio_rustls::rustls::version::TLS13])
        .map_err(|e| {
            anyhow::anyhow!(
                "ClientConfig::builder_with_provider rejected TLS 1.3 pin: {:?}",
                e
            )
        })?
        .dangerous()
        .with_custom_certificate_verifier(verifier);

        let mut client_config = if let Some((cert_bytes, key_bytes)) = client_auth {
            use rustls::pki_types::pem::PemObject;
            use rustls::pki_types::{CertificateDer, PrivateKeyDer};

            let cert_chain: Vec<CertificateDer<'static>> =
                CertificateDer::pem_slice_iter(&cert_bytes)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| {
                        anyhow::anyhow!("Failed to parse MQTT client certificate PEM: {}", e)
                    })?;
            let key = PrivateKeyDer::from_pem_slice(&key_bytes)
                .map_err(|e| anyhow::anyhow!("Failed to parse MQTT client key PEM: {}", e))?;
            builder.with_client_auth_cert(cert_chain, key).map_err(|e| {
                anyhow::anyhow!("Failed to configure MQTT client certificate auth: {:?}", e)
            })?
        } else {
            builder.with_no_client_auth()
        };
        client_config.alpn_protocols = vec![b"mqtt".to_vec()];

        let tls = TlsConfiguration::Rustls(Arc::new(client_config));
        Ok((Transport::Tls(tls), Some(mtls_verifier_state)))
    }
}
