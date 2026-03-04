//! SCADA Display Server — local web-based HMI for edge devices
//!
//! Provides an embedded HTTP + WebSocket server for real-time SCADA visualization
//! on the edge device itself (kiosk mode, local HMI panel, or tablet access).
//!
//! # Endpoints
//! - `GET /scada` — Serve the SCADA viewer HTML page
//! - `GET /scada/process` — Get the current SCADA process definition (JSON)
//! - `WS /ws/scada` — WebSocket for live sensor data broadcast
//!
//! # Architecture
//! - Process definitions are persisted to `/var/lib/suderra/scada/`
//! - Sensor data is broadcast to all connected WebSocket clients via a tokio broadcast channel
//! - The HTML page is embedded at compile time via `include_str!`
//!
//! # Feature Gate
//! This module is only compiled when the `scada-display` feature is enabled.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    Json, Router,
    extract::State as AxumState,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    http::StatusCode,
    response::{Html, IntoResponse},
    routing::get,
};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, RwLock};
use tracing::{debug, error, info, warn};

use crate::process_image::{ProcessImage, TagQuality};

/// Directory for persistent SCADA data (process definitions)
const SCADA_DIR: &str = "/var/lib/suderra/scada";

/// Embedded SCADA viewer HTML page
const SCADA_HTML: &str = include_str!("../static/scada-edge.html");

/// Maximum number of WebSocket broadcast subscribers
const BROADCAST_CAPACITY: usize = 64;

// ============================================================================
// Data Structures
// ============================================================================

/// Tag-to-equipment mapping for SCADA display
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagMapping {
    /// Process image tag name (e.g., "water_temp_1")
    pub tag_name: String,
    /// Equipment ID in the SCADA process (ReactFlow node ID)
    pub equipment_id: String,
    /// Sensor type label (e.g., "temperature", "ph")
    pub sensor_type: String,
    /// Engineering unit (e.g., "C", "mg/L")
    pub unit: String,
}

/// SCADA process definition (ReactFlow nodes + edges + tag mappings)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScadaProcess {
    /// Process name
    pub name: String,
    /// Process version
    #[serde(default = "default_version")]
    pub version: u32,
    /// ReactFlow nodes (equipment, sensors, etc.)
    pub nodes: Vec<serde_json::Value>,
    /// ReactFlow edges (pipes, connections)
    pub edges: Vec<serde_json::Value>,
    /// Tag-to-equipment mappings for live data overlay
    #[serde(default)]
    pub tag_mappings: Vec<TagMapping>,
    /// Deployment timestamp
    #[serde(default)]
    pub deployed_at: Option<String>,
}

fn default_version() -> u32 {
    1
}

/// Sensor data payload sent over WebSocket
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScadaSensorData {
    /// Timestamp (ISO 8601)
    pub timestamp: String,
    /// Sensor readings grouped by equipment ID
    pub equipment_data: HashMap<String, Vec<SensorReading>>,
}

/// Single sensor reading for SCADA overlay
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SensorReading {
    pub tag_name: String,
    pub sensor_type: String,
    pub value: f64,
    pub unit: String,
    pub quality: String,
    pub status: String,
}

/// Shared SCADA server state
#[derive(Clone)]
pub struct ScadaState {
    inner: Arc<ScadaStateInner>,
}

struct ScadaStateInner {
    /// Current SCADA process definition
    process: RwLock<Option<ScadaProcess>>,
    /// Broadcast channel for live sensor data
    broadcast_tx: broadcast::Sender<String>,
    /// Whether the display is currently active
    display_active: RwLock<bool>,
}

impl ScadaState {
    /// Create a new SCADA state, loading any persisted process from disk
    pub fn new() -> Self {
        let (broadcast_tx, _) = broadcast::channel(BROADCAST_CAPACITY);

        let state = Self {
            inner: Arc::new(ScadaStateInner {
                process: RwLock::new(None),
                broadcast_tx,
                display_active: RwLock::new(false),
            }),
        };

        // Load persisted process (non-async init — will be loaded in start_scada_server)
        state
    }

    /// Load persistent process definition from disk
    pub async fn load_persistent_process(&self) {
        match load_persistent_process().await {
            Ok(Some(process)) => {
                info!(
                    "Loaded persistent SCADA process: name='{}', version={}",
                    process.name, process.version
                );
                *self.inner.process.write().await = Some(process);
            }
            Ok(None) => {
                debug!("No persistent SCADA process found");
            }
            Err(e) => {
                warn!("Failed to load persistent SCADA process: {}", e);
            }
        }
    }

    /// Deploy a new SCADA process definition
    pub async fn deploy_process(&self, mut process: ScadaProcess) -> Result<(), String> {
        // Set deployment timestamp
        process.deployed_at = Some(chrono::Utc::now().to_rfc3339());

        // Persist to disk
        if let Err(e) = save_persistent_process(&process).await {
            return Err(format!("Failed to persist SCADA process: {}", e));
        }

        info!(
            "SCADA process deployed: name='{}', version={}, nodes={}, edges={}, mappings={}",
            process.name,
            process.version,
            process.nodes.len(),
            process.edges.len(),
            process.tag_mappings.len()
        );

        *self.inner.process.write().await = Some(process);
        Ok(())
    }

    /// Get the current SCADA process definition
    pub async fn get_process(&self) -> Option<ScadaProcess> {
        self.inner.process.read().await.clone()
    }

    /// Get display active status
    pub async fn is_display_active(&self) -> bool {
        *self.inner.display_active.read().await
    }

    /// Set display active status
    pub async fn set_display_active(&self, active: bool) {
        *self.inner.display_active.write().await = active;
    }

    /// Broadcast sensor data to all connected WebSocket clients
    pub fn broadcast_sensor_data(&self, data: &ScadaSensorData) {
        match serde_json::to_string(data) {
            Ok(json) => {
                // broadcast::send returns Err only if there are no receivers — that's fine
                let _ = self.inner.broadcast_tx.send(json);
            }
            Err(e) => {
                warn!("Failed to serialize SCADA sensor data: {}", e);
            }
        }
    }

    /// Subscribe to the broadcast channel
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.inner.broadcast_tx.subscribe()
    }
}

// ============================================================================
// Axum Handlers
// ============================================================================

/// Serve the SCADA viewer HTML page
async fn scada_page_handler() -> Html<&'static str> {
    Html(SCADA_HTML)
}

/// Get the current SCADA process definition
async fn scada_process_handler(
    AxumState(state): AxumState<ScadaState>,
) -> impl IntoResponse {
    match state.get_process().await {
        Some(process) => (StatusCode::OK, Json(serde_json::to_value(&process).unwrap_or_default())).into_response(),
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({
            "error": "No SCADA process deployed"
        }))).into_response(),
    }
}

/// WebSocket upgrade handler for live SCADA data
async fn scada_ws_handler(
    ws: WebSocketUpgrade,
    AxumState(state): AxumState<ScadaState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_scada_ws(socket, state))
}

/// Handle a single WebSocket connection
async fn handle_scada_ws(mut socket: WebSocket, state: ScadaState) {
    info!("SCADA WebSocket client connected");

    // Send current process definition on connect
    if let Some(process) = state.get_process().await {
        let init_msg = serde_json::json!({
            "type": "setProcess",
            "data": process,
        });
        if let Ok(json) = serde_json::to_string(&init_msg) {
            if socket.send(Message::Text(json.into())).await.is_err() {
                return;
            }
        }
    }

    // Subscribe to broadcast channel
    let mut rx = state.subscribe();

    // Forward broadcast messages to the WebSocket client
    loop {
        tokio::select! {
            // Receive from broadcast channel and forward to WS client
            result = rx.recv() => {
                match result {
                    Ok(msg) => {
                        let ws_msg = serde_json::json!({
                            "type": "sensorData",
                            "data": serde_json::from_str::<serde_json::Value>(&msg).unwrap_or_default(),
                        });
                        if let Ok(json) = serde_json::to_string(&ws_msg) {
                            if socket.send(Message::Text(json.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        debug!("SCADA WS client lagged {} messages", n);
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
            // Handle incoming WS messages (ping/pong, close)
            result = socket.recv() => {
                match result {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(data))) => {
                        if socket.send(Message::Pong(data)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(_)) => {} // Ignore text/binary from client
                    Some(Err(_)) => break,
                }
            }
        }
    }

    info!("SCADA WebSocket client disconnected");
}

// ============================================================================
// Server Startup
// ============================================================================

/// Build the axum router for the SCADA display server
pub fn build_scada_router(state: ScadaState) -> Router {
    Router::new()
        .route("/scada", get(scada_page_handler))
        .route("/scada/process", get(scada_process_handler))
        .route("/ws/scada", get(scada_ws_handler))
        .with_state(state)
}

/// Start the SCADA display HTTP + WebSocket server
///
/// Listens on `0.0.0.0:8080` by default (configurable via `SUDERRA_SCADA_PORT` env var).
pub async fn start_scada_server(state: ScadaState) -> tokio::task::JoinHandle<()> {
    // Load persistent process
    state.load_persistent_process().await;

    let port: u16 = std::env::var("SUDERRA_SCADA_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let app = build_scada_router(state);

    info!("Starting SCADA display server on {}", addr);

    tokio::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                error!("Failed to bind SCADA server to {}: {}", addr, e);
                return;
            }
        };

        if let Err(e) = axum::serve(listener, app).await {
            error!("SCADA server error: {}", e);
        }
    })
}

// ============================================================================
// Sensor Data Builder
// ============================================================================

/// Build SCADA sensor data from the process image using tag mappings
///
/// Reads current tag values from the process image and groups them
/// by equipment ID according to the tag mappings in the SCADA process.
pub async fn build_scada_sensor_data(
    process_image: &ProcessImage,
    process: &ScadaProcess,
) -> ScadaSensorData {
    let all_tags = process_image.get_all_tags().await;
    let mut equipment_data: HashMap<String, Vec<SensorReading>> = HashMap::new();

    for mapping in &process.tag_mappings {
        if let Some(tag_value) = all_tags.get(&mapping.tag_name) {
            let status = match tag_value.quality {
                TagQuality::Good => {
                    // Could be extended with alarm threshold checks
                    "normal"
                }
                TagQuality::Uncertain => "warning",
                _ => "offline",
            };

            let reading = SensorReading {
                tag_name: mapping.tag_name.clone(),
                sensor_type: mapping.sensor_type.clone(),
                value: tag_value.value,
                unit: mapping.unit.clone(),
                quality: format!("{:?}", tag_value.quality).to_lowercase(),
                status: status.to_string(),
            };

            equipment_data
                .entry(mapping.equipment_id.clone())
                .or_default()
                .push(reading);
        }
    }

    ScadaSensorData {
        timestamp: chrono::Utc::now().to_rfc3339(),
        equipment_data,
    }
}

// ============================================================================
// Persistence
// ============================================================================

/// Load the persistent SCADA process from disk
async fn load_persistent_process() -> Result<Option<ScadaProcess>, String> {
    let path = PathBuf::from(SCADA_DIR).join("process.json");

    if !path.exists() {
        return Ok(None);
    }

    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;

    let process: ScadaProcess = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse SCADA process: {}", e))?;

    Ok(Some(process))
}

/// Save the SCADA process definition to disk
async fn save_persistent_process(process: &ScadaProcess) -> Result<(), String> {
    let dir = Path::new(SCADA_DIR);

    // Create directory if it doesn't exist
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("Failed to create SCADA directory: {}", e))?;

    let path = dir.join("process.json");
    let content = serde_json::to_string_pretty(process)
        .map_err(|e| format!("Failed to serialize SCADA process: {}", e))?;

    tokio::fs::write(&path, content)
        .await
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;

    debug!("SCADA process persisted to {}", path.display());
    Ok(())
}
