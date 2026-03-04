//! SCADA Display Server — local web-based HMI for edge devices
//!
//! Provides an embedded HTTP + WebSocket server for real-time SCADA visualization
//! on the edge device itself (kiosk mode, local HMI panel, or tablet access).
//!
//! # Endpoints
//! - `GET /` — Redirect to `/scada`
//! - `GET /health` — Health check (JSON)
//! - `GET /scada` — Serve the SCADA viewer HTML page
//! - `GET /scada/process` — Get the current SCADA process definition (JSON)
//! - `GET /libs/aquaculture-nodes.umd.js` — Node/edge component bundle (SVG shapes, P&ID styles)
//! - `GET /manifest.webmanifest` — PWA manifest
//! - `GET /icons/scada-{192,512}.svg` — PWA icons
//! - `GET /sw.js` — Service worker (fetch passthrough)
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
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware,
    response::{Html, IntoResponse, Redirect},
    routing::get,
};
use tower_http::cors::{AllowOrigin, CorsLayer};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, RwLock};
use std::sync::atomic::{AtomicUsize, Ordering};
use tracing::{debug, error, info, warn};

use crate::process_image::{ProcessImage, TagQuality};

/// Directory for persistent SCADA data (process definitions)
const SCADA_DIR: &str = "/var/lib/suderra/scada";

/// Embedded SCADA viewer HTML page
const SCADA_HTML: &str = include_str!("../static/scada-edge.html");

/// Maximum number of WebSocket broadcast subscribers
const BROADCAST_CAPACITY: usize = 64;

/// Maximum concurrent WebSocket connections (DoS protection)
const MAX_WS_CONNECTIONS: usize = 16;

/// Embedded UMD bundle for SCADA node/edge components (SVG shapes, edge styles)
const NODE_BUNDLE_JS: &[u8] = include_bytes!("../static/aquaculture-nodes.umd.js");

/// PWA manifest
const PWA_MANIFEST: &str = r#"{
  "name": "Suderra SCADA",
  "short_name": "SCADA",
  "display": "standalone",
  "orientation": "landscape",
  "theme_color": "#0f172a",
  "background_color": "#0f172a",
  "start_url": "/scada",
  "scope": "/",
  "icons": [
    { "src": "/icons/scada-192.svg", "sizes": "192x192", "type": "image/svg+xml" },
    { "src": "/icons/scada-512.svg", "sizes": "512x512", "type": "image/svg+xml" }
  ]
}"#;

/// SVG icon for PWA (water/SCADA themed)
const SCADA_ICON_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#0f172a"/>
  <g transform="translate(256,256)">
    <circle r="160" fill="none" stroke="#3b82f6" stroke-width="16" opacity="0.3"/>
    <circle r="100" fill="none" stroke="#3b82f6" stroke-width="12" opacity="0.5"/>
    <circle r="40" fill="#3b82f6" opacity="0.8"/>
    <line x1="-140" y1="0" x2="-50" y2="0" stroke="#60a5fa" stroke-width="8" stroke-linecap="round"/>
    <line x1="50" y1="0" x2="140" y2="0" stroke="#60a5fa" stroke-width="8" stroke-linecap="round"/>
    <line x1="0" y1="-140" x2="0" y2="-50" stroke="#60a5fa" stroke-width="8" stroke-linecap="round"/>
    <line x1="0" y1="50" x2="0" y2="140" stroke="#60a5fa" stroke-width="8" stroke-linecap="round"/>
  </g>
</svg>"#;

/// Service worker with cache-first strategy for PWA offline support
const SERVICE_WORKER_JS: &str = r#"const CACHE_NAME = 'scada-v1';
const PRECACHE_URLS = [
  '/scada',
  '/libs/aquaculture-nodes.umd.js',
  '/manifest.webmanifest',
  '/icons/scada-192.svg',
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/react-is@18/umd/react-is.production.min.js',
  'https://unpkg.com/prop-types@15/prop-types.min.js',
  'https://unpkg.com/reactflow@11.11.4/dist/style.css',
  'https://unpkg.com/reactflow@11.11.4/dist/umd/index.js',
  'https://cdn.jsdelivr.net/npm/recharts@2/umd/Recharts.min.js'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(PRECACHE_URLS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(n) { return n !== CACHE_NAME; })
             .map(function(n) { return caches.delete(n); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(event) {
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      return cached || fetch(event.request).then(function(response) {
        if (response.ok && event.request.method === 'GET') {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      });
    }).catch(function() {
      return new Response('Offline', { status: 503 });
    })
  );
});"#;

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
    /// Active WebSocket connection count (DoS protection)
    ws_connection_count: AtomicUsize,
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
                ws_connection_count: AtomicUsize::new(0),
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
    ///
    /// Pre-wraps the data in the `{"type":"sensorData","data":...}` envelope
    /// so WebSocket handlers can forward the string directly without re-parsing.
    pub fn broadcast_sensor_data(&self, data: &ScadaSensorData) {
        let envelope = serde_json::json!({
            "type": "sensorData",
            "data": data,
        });
        match serde_json::to_string(&envelope) {
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
// Helper Functions
// ============================================================================

/// Check if an origin URL belongs to a private network (RFC 1918)
fn is_private_network_origin(origin: &str) -> bool {
    // Extract host from origin URL
    let host = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
        .unwrap_or(origin)
        .split(':')
        .next()
        .unwrap_or("");

    host.starts_with("192.168.")
        || host.starts_with("10.")
        || host.starts_with("172.16.")
        || host.starts_with("172.17.")
        || host.starts_with("172.18.")
        || host.starts_with("172.19.")
        || host.starts_with("172.2")
        || host.starts_with("172.3")
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
    headers: HeaderMap,
    AxumState(state): AxumState<ScadaState>,
) -> impl IntoResponse {
    // DoS protection: limit concurrent WebSocket connections
    let current = state.inner.ws_connection_count.load(Ordering::Relaxed);
    if current >= MAX_WS_CONNECTIONS {
        warn!("SCADA WebSocket connection rejected: limit reached ({}/{})", current, MAX_WS_CONNECTIONS);
        return (StatusCode::SERVICE_UNAVAILABLE, "Too many WebSocket connections").into_response();
    }

    // Origin validation: allow localhost and private network IPs
    if let Some(origin) = headers.get(header::ORIGIN) {
        if let Ok(origin_str) = origin.to_str() {
            let is_allowed = origin_str.starts_with("http://localhost")
                || origin_str.starts_with("http://127.0.0.1")
                || origin_str.starts_with("https://localhost")
                || origin_str.starts_with("https://127.0.0.1")
                || is_private_network_origin(origin_str);
            if !is_allowed {
                warn!("SCADA WebSocket rejected: invalid origin '{}'", origin_str);
                return (StatusCode::FORBIDDEN, "Invalid Origin").into_response();
            }
        }
    }

    ws.max_message_size(64 * 1024) // 64 KB max incoming message
        .on_upgrade(move |socket| handle_scada_ws(socket, state))
        .into_response()
}

/// RAII guard to decrement WebSocket connection count on drop
struct WsConnectionGuard(Arc<ScadaStateInner>);
impl Drop for WsConnectionGuard {
    fn drop(&mut self) {
        self.0.ws_connection_count.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Handle a single WebSocket connection
async fn handle_scada_ws(mut socket: WebSocket, state: ScadaState) {
    state.inner.ws_connection_count.fetch_add(1, Ordering::Relaxed);
    let _guard = WsConnectionGuard(Arc::clone(&state.inner));
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
                        // Message is already a complete JSON envelope from broadcast_sensor_data
                        if socket.send(Message::Text(msg.into())).await.is_err() {
                            break;
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

/// Health check endpoint
async fn health_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "ok",
        "service": "scada-display",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

/// Root redirect to /scada
async fn root_redirect_handler() -> Redirect {
    Redirect::permanent("/scada")
}

/// Serve the UMD node/edge component bundle
async fn node_bundle_handler() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "application/javascript")], NODE_BUNDLE_JS)
}

/// Serve PWA manifest
async fn manifest_handler() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "application/manifest+json")], PWA_MANIFEST)
}

/// Serve PWA icon (same SVG for both sizes)
async fn icon_handler() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "image/svg+xml")], SCADA_ICON_SVG)
}

/// Serve minimal service worker
async fn sw_handler() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "application/javascript")], SERVICE_WORKER_JS)
}

// ============================================================================
// Security Middleware
// ============================================================================

/// Security headers middleware for SCADA display server
///
/// Adds standard security headers to all responses:
/// - X-Frame-Options: DENY — Prevents clickjacking attacks
/// - X-Content-Type-Options: nosniff — Prevents MIME-type sniffing
/// - Referrer-Policy: no-referrer — Prevents referrer leakage to external sites
/// - Permissions-Policy: Disables geolocation, camera, microphone, payment, USB APIs
async fn security_headers_middleware(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> impl IntoResponse {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert("X-Frame-Options", HeaderValue::from_static("DENY"));
    headers.insert("X-Content-Type-Options", HeaderValue::from_static("nosniff"));
    headers.insert("Referrer-Policy", HeaderValue::from_static("no-referrer"));
    headers.insert("Permissions-Policy", HeaderValue::from_static("geolocation=(), camera=(), microphone=(), payment=(), usb=()"));
    response
}

// ============================================================================
// Server Startup
// ============================================================================

/// Build the axum router for the SCADA display server
pub fn build_scada_router(state: ScadaState) -> Router {
    // CORS: restrict to localhost origins and private network IPs
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
            if let Ok(s) = origin.to_str() {
                s.starts_with("http://localhost")
                    || s.starts_with("http://127.0.0.1")
                    || is_private_network_origin(s)
            } else {
                false
            }
        }))
        .allow_methods([Method::GET]);

    Router::new()
        .route("/", get(root_redirect_handler))
        .route("/health", get(health_handler))
        .route("/scada", get(scada_page_handler))
        .route("/scada/process", get(scada_process_handler))
        .route("/ws/scada", get(scada_ws_handler))
        .route("/libs/aquaculture-nodes.umd.js", get(node_bundle_handler))
        .route("/manifest.webmanifest", get(manifest_handler))
        .route("/icons/scada-192.svg", get(icon_handler))
        .route("/icons/scada-512.svg", get(icon_handler))
        .route("/sw.js", get(sw_handler))
        .layer(cors)
        .layer(middleware::from_fn(security_headers_middleware))
        .with_state(state)
}

/// Start the SCADA display HTTP + WebSocket server
///
/// Listens on `0.0.0.0:6526` by default (configurable via `SUDERRA_SCADA_PORT` env var).
pub async fn start_scada_server(state: ScadaState) -> tokio::task::JoinHandle<()> {
    // Load persistent process
    state.load_persistent_process().await;

    let port: u16 = std::env::var("SUDERRA_SCADA_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(6526);

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

/// Build SCADA sensor data from pre-fetched tag values using tag mappings
///
/// Accepts a pre-snapshotted tag map to avoid redundant process image locks
/// when the caller already has a recent snapshot (e.g., io_poll cycle).
pub fn build_scada_sensor_data_from_tags(
    all_tags: &HashMap<String, crate::process_image::TagValue>,
    process: &ScadaProcess,
) -> ScadaSensorData {
    let mut equipment_data: HashMap<String, Vec<SensorReading>> = HashMap::new();

    for mapping in &process.tag_mappings {
        if let Some(tag_value) = all_tags.get(&mapping.tag_name) {
            let status = match tag_value.quality {
                TagQuality::Good => "normal",
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

/// Build SCADA sensor data from the process image using tag mappings
///
/// Convenience wrapper that fetches tags from the process image.
/// Prefer `build_scada_sensor_data_from_tags` when a tag snapshot is already available.
pub async fn build_scada_sensor_data(
    process_image: &ProcessImage,
    process: &ScadaProcess,
) -> ScadaSensorData {
    let all_tags = process_image.get_all_tags().await;
    build_scada_sensor_data_from_tags(&all_tags, process)
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
