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
//! - `GET /scada/tags` — All ProcessImage tags as JSON
//! - `GET /scada/trends?tag=X&from=T1&to=T2` — Trend data query
//! - `GET /scada/alarms` — Active alarms
//! - `GET /scada/alarms/history?limit=N` — Alarm history
//! - `GET /libs/aquaculture-nodes.umd.js` — Node/edge component bundle (SVG shapes, P&ID styles)
//! - `GET /manifest.webmanifest` — PWA manifest
//! - `GET /icons/scada-{192,512}.svg` — PWA icons
//! - `GET /sw.js` — Service worker (fetch passthrough)
//! - `WS /ws/scada` — WebSocket for live sensor data broadcast + bidirectional commands
//!
//! # Architecture
//! - Process definitions are persisted to `/var/lib/suderra/scada/`
//! - Sensor data is broadcast to all connected WebSocket clients via a tokio broadcast channel
//! - The HTML page is embedded at compile time via `include_str!`
//! - Command routing: WS → mpsc channel → main.rs receiver → GPIO/Modbus/I2C → oneshot response
//!
//! # Feature Gate
//! This module is only compiled when the `scada-display` feature is enabled.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    Json, Router,
    extract::Query,
    extract::State as AxumState,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware,
    response::{Html, IntoResponse, Redirect},
    routing::get,
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::{RwLock, broadcast};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::{debug, error, info, warn};

use crate::alarm_engine::{ActiveAlarm, AlarmEngine, AlarmEvent};
use crate::calibration_engine::CalibrationEngine;
use crate::process_image::{ProcessImage, TagQuality};
use crate::scada_db::ScadaDb;
use crate::scada_types::{
    ActiveAlarmInfo, PinSession, ScadaCommand, ScadaPackage, TagInfo, TrendPoint, WsClientMessage,
};
use crate::trend_engine::TrendEngine;

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

/// PIN session timeout in seconds
const PIN_SESSION_TIMEOUT_SECS: u64 = 300;

/// Maximum failed PIN attempts before lockout
const MAX_PIN_FAILURES: u32 = 3;

/// Lockout duration after too many failed PIN attempts (seconds)
const PIN_LOCKOUT_SECS: i64 = 60;

/// PWA manifest
const PWA_MANIFEST: &str = r##"{
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
}"##;

/// SVG icon for PWA (water/SCADA themed)
const SCADA_ICON_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
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
</svg>"##;

/// Service worker with cache-first strategy for PWA offline support
const SERVICE_WORKER_JS: &str = r#"const CACHE_NAME = 'scada-v1';
// IMPORTANT: All precached assets MUST be same-origin paths only.
// External CDN URLs cause all-or-nothing install failure when the edge
// device has no internet access, defeating the offline PWA guarantee.
// All third-party libraries are vendored into /libs/ during the build.
const PRECACHE_URLS = [
  '/scada',
  '/libs/aquaculture-nodes.umd.js',
  '/manifest.webmanifest',
  '/icons/scada-192.svg',
  '/libs/vendor/react.production.min.js',
  '/libs/vendor/react-dom.production.min.js',
  '/libs/vendor/react-is.production.min.js',
  '/libs/vendor/prop-types.min.js',
  '/libs/vendor/reactflow-style.css',
  '/libs/vendor/reactflow.umd.js',
  '/libs/vendor/recharts.min.js'
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
    /// Current SCADA process definition (backward compat)
    process: RwLock<Option<ScadaProcess>>,
    /// Broadcast channel for live sensor data
    broadcast_tx: broadcast::Sender<String>,
    /// Whether the display is currently active
    display_active: RwLock<bool>,
    /// Active WebSocket connection count (DoS protection)
    ws_connection_count: AtomicUsize,

    // --- New runtime fields ---
    /// Current SCADA package (full HMI definition)
    package: RwLock<Option<ScadaPackage>>,
    /// Process image for tag access
    process_image: Option<ProcessImage>,
    /// SQLite database for trends, alarms, calibration, audit
    db: Option<Arc<ScadaDb>>,
    /// Alarm engine
    /// WHY: tokio::sync::Mutex — held across .await (alarm evaluation reads DB)
    alarm_engine: tokio::sync::Mutex<AlarmEngine>,
    /// Trend recording engine
    /// WHY: tokio::sync::Mutex — held across .await (trend recording writes DB)
    trend_engine: tokio::sync::Mutex<Option<TrendEngine>>,
    /// Calibration state machine
    /// WHY: tokio::sync::Mutex — held across .await (calibration interacts with I/O)
    calibration_engine: tokio::sync::Mutex<CalibrationEngine>,
    /// Command channel for WS → I/O routing
    command_tx: Option<tokio::sync::mpsc::Sender<ScadaCommand>>,
    /// Emergency stop state
    emergency_active: AtomicBool,
    /// Tags affected by emergency stop
    emergency_tags: RwLock<Vec<String>>,
    /// Global PIN lockout state (persists across WS reconnections)
    /// WHY: tokio::sync::Mutex — held across .await (PIN validation may check DB)
    pin_lockout: tokio::sync::Mutex<PinLockoutState>,
}

impl ScadaState {
    /// Create a new SCADA state, loading any persisted process from disk (backward compat)
    pub fn new() -> Self {
        let (broadcast_tx, _) = broadcast::channel(BROADCAST_CAPACITY);

        Self {
            inner: Arc::new(ScadaStateInner {
                process: RwLock::new(None),
                broadcast_tx,
                display_active: RwLock::new(false),
                ws_connection_count: AtomicUsize::new(0),
                package: RwLock::new(None),
                process_image: None,
                db: None,
                alarm_engine: tokio::sync::Mutex::new(AlarmEngine::new(None)),
                trend_engine: tokio::sync::Mutex::new(None),
                calibration_engine: tokio::sync::Mutex::new(CalibrationEngine::new(None)),
                command_tx: None,
                emergency_active: AtomicBool::new(false),
                emergency_tags: RwLock::new(Vec::new()),
                pin_lockout: tokio::sync::Mutex::new(PinLockoutState::new()),
            }),
        }
    }

    /// Create a new SCADA state with full runtime engines
    pub fn new_with_runtime(
        process_image: ProcessImage,
        db: Arc<ScadaDb>,
        command_tx: tokio::sync::mpsc::Sender<ScadaCommand>,
    ) -> Self {
        let (broadcast_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let db_clone = Arc::clone(&db);

        // Try loading active package from DB
        let package = db
            .get_active_package()
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str::<ScadaPackage>(&json).ok());

        // Initialize engines
        let alarm_engine = AlarmEngine::new(Some(Arc::clone(&db)));
        let calibration_engine = CalibrationEngine::new(Some(Arc::clone(&db)));

        // Initialize trend engine from package config if available
        let trend_engine = package.as_ref().map(|pkg| {
            let tc = crate::trend_engine::TrendConfig {
                retention_days: pkg.trend_config.retention_days.unwrap_or(7),
                sample_interval_sec: pkg.trend_config.sample_interval_sec.unwrap_or(10),
                tags: pkg.trend_config.tags.clone(),
            };
            TrendEngine::new(Arc::clone(&db), tc)
        });

        Self {
            inner: Arc::new(ScadaStateInner {
                process: RwLock::new(None),
                broadcast_tx,
                display_active: RwLock::new(false),
                ws_connection_count: AtomicUsize::new(0),
                package: RwLock::new(package),
                process_image: Some(process_image),
                db: Some(db_clone),
                alarm_engine: tokio::sync::Mutex::new(alarm_engine),
                trend_engine: tokio::sync::Mutex::new(trend_engine),
                calibration_engine: tokio::sync::Mutex::new(calibration_engine),
                command_tx: Some(command_tx),
                emergency_active: AtomicBool::new(false),
                emergency_tags: RwLock::new(Vec::new()),
                pin_lockout: tokio::sync::Mutex::new(PinLockoutState::new()),
            }),
        }
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

    /// Deploy a new SCADA process definition (backward compat)
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

        // Broadcast setProcess to all WS clients
        let msg = serde_json::json!({
            "type": "setProcess",
            "data": process,
        });
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = self.inner.broadcast_tx.send(json);
        }

        *self.inner.process.write().await = Some(process);
        Ok(())
    }

    /// Deploy a full SCADA package
    pub async fn deploy_package(&self, package: ScadaPackage) -> Result<(), String> {
        // Persist to SQLite
        if let Some(ref db) = self.inner.db {
            let json = serde_json::to_string(&package)
                .map_err(|e| format!("Failed to serialize package: {}", e))?;
            db.save_package(
                package.meta.version,
                &json,
                package.meta.deployed_by.as_deref(),
            )?;
        }

        // Persist to disk as well
        let dir = Path::new(SCADA_DIR);
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| format!("Failed to create SCADA directory: {}", e))?;
        let pkg_path = dir.join("package.json");
        let content = serde_json::to_string_pretty(&package)
            .map_err(|e| format!("Failed to serialize package: {}", e))?;
        tokio::fs::write(&pkg_path, content)
            .await
            .map_err(|e| format!("Failed to write package: {}", e))?;

        // Update alarm rules
        {
            let mut alarm_engine = self.inner.alarm_engine.lock().await;
            let rules: Vec<crate::alarm_engine::AlarmRule> = package
                .alarm_rules
                .iter()
                .map(|r| crate::alarm_engine::AlarmRule {
                    id: r.id.clone(),
                    tag: r.tag.clone(),
                    condition: r.condition.clone(),
                    value: r.value,
                    severity: match r.severity {
                        crate::scada_types::AlarmSeverity::Critical => {
                            crate::alarm_engine::AlarmSeverity::Critical
                        }
                        crate::scada_types::AlarmSeverity::High => {
                            crate::alarm_engine::AlarmSeverity::High
                        }
                        crate::scada_types::AlarmSeverity::Warning => {
                            crate::alarm_engine::AlarmSeverity::Warning
                        }
                        crate::scada_types::AlarmSeverity::Info => {
                            crate::alarm_engine::AlarmSeverity::Info
                        }
                    },
                    message: r.message.clone(),
                    deadband: r.deadband,
                    delay: r.delay,
                })
                .collect();
            alarm_engine.update_rules(rules);
        }

        // Update trend config
        if let Some(ref db) = self.inner.db {
            let tc = crate::trend_engine::TrendConfig {
                retention_days: package.trend_config.retention_days.unwrap_or(7),
                sample_interval_sec: package.trend_config.sample_interval_sec.unwrap_or(10),
                tags: package.trend_config.tags.clone(),
            };
            let mut trend_guard = self.inner.trend_engine.lock().await;
            if let Some(ref mut engine) = *trend_guard {
                engine.update_config(tc);
            } else {
                *trend_guard = Some(TrendEngine::new(Arc::clone(db), tc));
            }
        }

        info!(
            "SCADA package deployed: version={}, screens={}, alarms={}, trend_tags={}",
            package.meta.version,
            package.screens.len(),
            package.alarm_rules.len(),
            package.trend_config.tags.len(),
        );

        // Broadcast setPackage to all WS clients
        let msg = serde_json::json!({
            "type": "setPackage",
            "data": package,
        });
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = self.inner.broadcast_tx.send(json);
        }

        *self.inner.package.write().await = Some(package);
        Ok(())
    }

    /// Get the current SCADA process definition
    pub async fn get_process(&self) -> Option<ScadaProcess> {
        self.inner.process.read().await.clone()
    }

    /// Get the current SCADA package
    pub async fn get_package(&self) -> Option<ScadaPackage> {
        self.inner.package.read().await.clone()
    }

    /// Restore the process sink to "no process": clear the in-memory
    /// definition, drop the persisted file, and broadcast the empty
    /// state. Used by `cmd_deploy_bundle`'s apply-phase rollback to undo
    /// a process applied on a device that had none before the bundle
    /// (the pre-image was `None`). Errors surface so the caller can
    /// downgrade a `rolled_back` ack to `failed` when the restore itself
    /// faults (operator must intervene).
    pub async fn clear_process(&self) -> Result<(), String> {
        let path = Path::new(SCADA_DIR).join("process.json");
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Failed to remove {}: {}", path.display(), e)),
        }

        let msg = serde_json::json!({ "type": "setProcess", "data": serde_json::Value::Null });
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = self.inner.broadcast_tx.send(json);
        }

        *self.inner.process.write().await = None;
        Ok(())
    }

    /// Restore the package sink to "no package": clear the in-memory
    /// definition, drop the persisted file, deactivate the SQLite active
    /// row, empty the alarm rule set, and broadcast the empty state. Used
    /// by the bundle rollback's `None` pre-image case and by
    /// `undeploy_scada_package` (WF-011). The SQLite version HISTORY is
    /// left intact (append-only audit trail) — only `is_active` drops,
    /// because startup reloads the active package from SQLite and would
    /// otherwise resurrect a cleared package on the next agent restart.
    pub async fn clear_package(&self) -> Result<(), String> {
        let path = Path::new(SCADA_DIR).join("package.json");
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Failed to remove {}: {}", path.display(), e)),
        }

        if let Some(ref db) = self.inner.db {
            db.deactivate_package()?;
        }

        // A cleared package has no alarm rules; drop the active set so a
        // rolled-back device does not keep evaluating rules from the
        // failed bundle.
        {
            let mut alarm_engine = self.inner.alarm_engine.lock().await;
            alarm_engine.update_rules(Vec::new());
        }

        let msg = serde_json::json!({ "type": "setPackage", "data": serde_json::Value::Null });
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = self.inner.broadcast_tx.send(json);
        }

        *self.inner.package.write().await = None;
        Ok(())
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

    /// Broadcast all tags to WS clients for dashboard view (works without a process)
    ///
    /// Sends a `{"type":"allTags","data":[...]}` message with every tag's current
    /// value, quality, and optional unit/io_type. This enables the auto-generated
    /// tag dashboard even when no SCADA package has been deployed.
    pub async fn broadcast_all_tags(&self, tags: &HashMap<String, crate::process_image::TagValue>) {
        if tags.is_empty() {
            return;
        }
        let tag_infos: Vec<TagInfo> = tags
            .iter()
            .map(|(name, tv)| TagInfo {
                tag_name: name.clone(),
                value: tv.value,
                quality: format!("{:?}", tv.quality).to_lowercase(),
                unit: None,
                io_type: None,
                timestamp: tv.timestamp.to_rfc3339(),
            })
            .collect();

        let msg = serde_json::json!({
            "type": "allTags",
            "data": tag_infos,
        });
        self.broadcast_json(&msg);
    }

    /// Broadcast a pre-serialized JSON message to all WS clients
    fn broadcast_json(&self, value: &serde_json::Value) {
        if let Ok(json) = serde_json::to_string(value) {
            let _ = self.inner.broadcast_tx.send(json);
        }
    }

    /// Subscribe to the broadcast channel
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.inner.broadcast_tx.subscribe()
    }

    /// Evaluate alarms against current tag values (called from io_poll)
    pub async fn evaluate_alarms(&self, tags: &HashMap<String, crate::process_image::TagValue>) {
        let events = {
            let mut engine = self.inner.alarm_engine.lock().await;
            engine.evaluate(tags)
        };

        for event in events {
            match event {
                AlarmEvent::Triggered(ref alarm) => {
                    let info = active_alarm_to_info(alarm);
                    let msg = serde_json::json!({
                        "type": "alarm",
                        "data": info,
                    });
                    self.broadcast_json(&msg);
                }
                AlarmEvent::Cleared { ref alarm_id, .. } => {
                    let msg = serde_json::json!({
                        "type": "alarmClear",
                        "alarmId": alarm_id,
                    });
                    self.broadcast_json(&msg);
                }
                AlarmEvent::Acknowledged { .. } => {
                    // Ack is handled per-client, no broadcast needed
                }
            }
        }
    }

    /// Record trend data for current tag values (called from io_poll)
    pub async fn record_trends(&self, tags: &HashMap<String, crate::process_image::TagValue>) {
        let mut trend_guard = self.inner.trend_engine.lock().await;
        if let Some(ref mut engine) = *trend_guard {
            engine.record(tags);
        }
    }

    /// Check if emergency stop is active
    pub fn is_emergency_active(&self) -> bool {
        self.inner.emergency_active.load(Ordering::Acquire)
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Convert ActiveAlarm to ActiveAlarmInfo for WS transmission
fn active_alarm_to_info(alarm: &ActiveAlarm) -> ActiveAlarmInfo {
    ActiveAlarmInfo {
        alarm_id: alarm.alarm_id.clone(),
        rule_id: alarm.rule_id.clone(),
        tag: alarm.tag.clone(),
        severity: format!("{:?}", alarm.severity).to_lowercase(),
        message: alarm.message.clone(),
        triggered_at: alarm.triggered_at.clone(),
        value: alarm.value_at_trigger,
        acked: alarm.acknowledged,
    }
}

/// Check if an origin URL belongs to a private network (RFC 1918 + loopback)
fn is_private_network_origin(origin: &str) -> bool {
    // Extract host from origin URL
    let host = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
        .unwrap_or(origin)
        .split(':')
        .next()
        .unwrap_or("");

    // Allow "localhost" hostname
    if host == "localhost" {
        return true;
    }

    // Parse as IPv4 and check RFC 1918 ranges + loopback
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        let octets = ip.octets();
        return octets[0] == 10                                           // 10.0.0.0/8
            || (octets[0] == 172 && (16..=31).contains(&octets[1]))      // 172.16.0.0/12
            || (octets[0] == 192 && octets[1] == 168)                    // 192.168.0.0/16
            || octets[0] == 127; // 127.0.0.0/8
    }

    false
}

/// Determine the security level for a tag based on package control permissions
fn get_security_level(tag: &str, package: &ScadaPackage) -> SecurityLevel {
    let perms = &package.control_permissions;
    if perms.security_levels.pin.contains(&tag.to_string()) {
        SecurityLevel::Pin
    } else if perms.security_levels.confirm.contains(&tag.to_string()) {
        SecurityLevel::Confirm
    } else if perms.security_levels.none.contains(&tag.to_string()) {
        SecurityLevel::None
    } else {
        // Default: require confirmation for unknown tags
        SecurityLevel::Confirm
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum SecurityLevel {
    None,
    Confirm,
    Pin,
}

/// Global PIN lockout state — shared across all WS sessions so attackers
/// cannot bypass lockout by reconnecting.
struct PinLockoutState {
    failed_attempts: u32,
    lockout_until: Option<chrono::DateTime<chrono::Utc>>,
}

impl PinLockoutState {
    fn new() -> Self {
        Self {
            failed_attempts: 0,
            lockout_until: None,
        }
    }

    fn is_locked_out(&self) -> bool {
        if let Some(lockout) = self.lockout_until {
            chrono::Utc::now() < lockout
        } else {
            false
        }
    }

    fn record_failure(&mut self) {
        self.failed_attempts += 1;
        if self.failed_attempts >= MAX_PIN_FAILURES {
            self.lockout_until =
                Some(chrono::Utc::now() + chrono::Duration::seconds(PIN_LOCKOUT_SECS));
            warn!(
                "Global PIN lockout triggered after {} failed attempts",
                self.failed_attempts
            );
        }
    }

    fn reset(&mut self) {
        self.failed_attempts = 0;
        self.lockout_until = None;
    }
}

/// Verify a PIN against the package's pin_hash using SHA-256 with constant-time comparison
fn verify_pin(input: &str, pin_hash: &str) -> bool {
    use subtle::ConstantTimeEq;

    // SEC-LOW-065 (2026-08-23 scan №10): argon2id — single-iteration
    // unsalted SHA-256 let a numeric PIN be brute-forced in milliseconds.
    // Stored pin_hash values carry a format tag: "$argon2id$..." → argon2
    // verify; anything else (legacy hex SHA-256) verifies then the caller
    // transparently upgrades on next write (see hash_pin).
    if pin_hash.starts_with("$argon2id$") {
        use argon2::{Argon2, PasswordHash, PasswordVerifier};
        let parsed = match PasswordHash::new(pin_hash) {
            Ok(parsed) => parsed,
            Err(_) => return false, // malformed PHC string — never accept
        };
        return Argon2::default()
            .verify_password(input.as_bytes(), &parsed)
            .is_ok();
    }

    // Legacy SHA-256 fallback (constant-time compare preserved)
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let result = format!("{:x}", hasher.finalize());
    result.as_bytes().ct_eq(pin_hash.as_bytes()).into()
}

/// SEC-LOW-065 (№10): hash a PIN with argon2id for storage.
pub fn hash_pin(input: &str) -> Result<String, String> {
    use argon2::password_hash::{PasswordHasher, SaltString, rand_core::OsRng};
    let salt = SaltString::generate(&mut OsRng);
    argon2::Argon2::default()
        .hash_password(input.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| format!("argon2 hash failed: {e}"))
}

// ============================================================================
// Query Parameter Structs
// ============================================================================

#[derive(Debug, Deserialize)]
struct TrendQueryParams {
    tag: String,
    from: i64,
    to: i64,
}

#[derive(Debug, Deserialize)]
struct AlarmHistoryParams {
    #[serde(default = "default_alarm_limit")]
    limit: u32,
}

fn default_alarm_limit() -> u32 {
    100
}

// ============================================================================
// Axum Handlers
// ============================================================================

/// Serve the SCADA viewer HTML page
///
/// EDGE-MEDIUM-008: Generates a per-request cryptographic nonce and injects it
/// into all `<script` tags in the SCADA HTML. The matching nonce is set in the
/// Content-Security-Policy header, replacing `'unsafe-inline'` with nonce-based
/// authorization. This prevents injected scripts from executing even if an
/// attacker finds an HTML injection vector in tag labels or process names.
async fn scada_page_handler() -> impl IntoResponse {
    // Generate a 128-bit random nonce (base64-encoded)
    let mut nonce_bytes = [0u8; 16];
    if let Err(e) = getrandom::getrandom(&mut nonce_bytes) {
        warn!(
            "Failed to generate CSP nonce: {}, falling back to static CSP",
            e
        );
        return (HeaderMap::new(), SCADA_HTML.to_string());
    }
    let nonce = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, nonce_bytes);

    // Inject nonce into all <script tags in the embedded HTML
    let html_with_nonce = SCADA_HTML.replace("<script", &format!("<script nonce=\"{}\"", nonce));

    // Build nonce-based CSP (replaces the 'unsafe-inline' from the middleware)
    let csp = format!(
        "default-src 'self'; \
         script-src 'nonce-{nonce}' 'strict-dynamic' https://unpkg.com https://cdn.jsdelivr.net; \
         style-src 'self' 'unsafe-inline' https://unpkg.com; \
         connect-src 'self' ws: wss:; \
         img-src 'self' data:; \
         manifest-src 'self'; \
         frame-ancestors 'none'; \
         base-uri 'self'; \
         form-action 'none'; \
         object-src 'none';",
    );

    let mut headers = HeaderMap::new();
    if let Ok(csp_value) = HeaderValue::from_str(&csp) {
        headers.insert("Content-Security-Policy", csp_value);
    }
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );

    (headers, html_with_nonce)
}

/// Get the current SCADA process definition
async fn scada_process_handler(AxumState(state): AxumState<ScadaState>) -> impl IntoResponse {
    match state.get_process().await {
        Some(process) => (
            StatusCode::OK,
            Json(serde_json::to_value(&process).unwrap_or_default()),
        )
            .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": "No SCADA process deployed"
            })),
        )
            .into_response(),
    }
}

/// Get all ProcessImage tags as JSON
async fn scada_tags_handler(AxumState(state): AxumState<ScadaState>) -> impl IntoResponse {
    if let Some(ref pi) = state.inner.process_image {
        let all_tags = pi.get_all_tags().await;
        let tag_infos: Vec<TagInfo> = all_tags
            .iter()
            .map(|(name, tv)| TagInfo {
                tag_name: name.clone(),
                value: tv.value,
                quality: format!("{:?}", tv.quality).to_lowercase(),
                unit: None,
                io_type: None,
                timestamp: tv.timestamp.to_rfc3339(),
            })
            .collect();
        (
            StatusCode::OK,
            Json(serde_json::json!({ "tags": tag_infos })),
        )
            .into_response()
    } else {
        (StatusCode::OK, Json(serde_json::json!({ "tags": [] }))).into_response()
    }
}

/// Query trend data for a tag
async fn scada_trends_handler(
    AxumState(state): AxumState<ScadaState>,
    Query(params): Query<TrendQueryParams>,
) -> impl IntoResponse {
    let trend_guard = state.inner.trend_engine.lock().await;
    if let Some(ref engine) = *trend_guard {
        match engine.query(&params.tag, params.from, params.to) {
            Ok(points) => {
                let trend_points: Vec<TrendPoint> = points
                    .iter()
                    .map(|p| TrendPoint {
                        timestamp: p.timestamp,
                        value: p.value,
                        quality: p.quality,
                    })
                    .collect();
                (
                    StatusCode::OK,
                    Json(serde_json::json!({
                        "tag": params.tag,
                        "data": trend_points,
                    })),
                )
                    .into_response()
            }
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": e,
                })),
            )
                .into_response(),
        }
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": "Trend engine not available",
            })),
        )
            .into_response()
    }
}

/// Get active alarms
async fn scada_alarms_handler(AxumState(state): AxumState<ScadaState>) -> impl IntoResponse {
    let engine = state.inner.alarm_engine.lock().await;
    let alarms: Vec<ActiveAlarmInfo> = engine
        .get_active_alarms()
        .iter()
        .map(active_alarm_to_info)
        .collect();
    (
        StatusCode::OK,
        Json(serde_json::json!({ "alarms": alarms })),
    )
}

/// Get alarm history
async fn scada_alarms_history_handler(
    AxumState(state): AxumState<ScadaState>,
    Query(params): Query<AlarmHistoryParams>,
) -> impl IntoResponse {
    if let Some(ref db) = state.inner.db {
        match db.get_alarm_history(params.limit) {
            Ok(records) => (
                StatusCode::OK,
                Json(serde_json::json!({ "alarms": records })),
            )
                .into_response(),
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": e,
                })),
            )
                .into_response(),
        }
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": "Database not available",
            })),
        )
            .into_response()
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
        warn!(
            "SCADA WebSocket connection rejected: limit reached ({}/{})",
            current, MAX_WS_CONNECTIONS
        );
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "Too many WebSocket connections",
        )
            .into_response();
    }

    // Origin validation: require Origin header, allow only localhost/private network IPs
    let origin = match headers.get(header::ORIGIN) {
        Some(o) => o,
        None => {
            warn!("SCADA WebSocket rejected: missing Origin header");
            return (StatusCode::FORBIDDEN, "Origin header required").into_response();
        }
    };
    if let Ok(origin_str) = origin.to_str() {
        if !is_private_network_origin(origin_str) {
            warn!("SCADA WebSocket rejected: invalid origin '{}'", origin_str);
            return (StatusCode::FORBIDDEN, "Invalid Origin").into_response();
        }
    } else {
        warn!("SCADA WebSocket rejected: non-ASCII Origin header");
        return (StatusCode::FORBIDDEN, "Invalid Origin").into_response();
    }

    // SEC-MEDIUM-061 (2026-08-23 scan №6): token authentication for OT-NIC
    // deployments. Origin is a client-controlled header — on the documented
    // production pattern (SUDERRA_SCADA_BIND=OT-NIC-IP), any host on the OT
    // LAN passes the RFC1918 check and can drive actuators, recalibrate
    // sensors, ack alarms, and trigger emergency stop. When
    // SUDERRA_SCADA_AUTH_TOKEN is set, the upgrade additionally requires a
    // matching Bearer token (constant-time compare). Unset ⇒ loopback
    // default posture (Origin check only — the existing defense).
    if let Ok(expected_token) = std::env::var("SUDERRA_SCADA_AUTH_TOKEN") {
        if !expected_token.is_empty() {
            let provided = headers
                .get(header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "));
            let authorized = match provided {
                Some(token) => {
                    use subtle::ConstantTimeEq;
                    token.as_bytes().ct_eq(expected_token.as_bytes()).into()
                }
                None => false,
            };
            if !authorized {
                warn!(
                    "SCADA WebSocket rejected: invalid or missing Bearer token (SUDERRA_SCADA_AUTH_TOKEN is set)"
                );
                return (
                    StatusCode::UNAUTHORIZED,
                    "Bearer token required (SUDERRA_SCADA_AUTH_TOKEN is configured)",
                )
                    .into_response();
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

/// Pending confirmation state for a WS connection
struct PendingConfirm {
    tag: String,
    value: f64,
    source_ip: Option<String>,
}

/// Per-connection WS session state
struct WsSession {
    pin_session: Option<PinSession>,
    pending_confirms: HashMap<String, PendingConfirm>,
}

impl WsSession {
    fn new() -> Self {
        Self {
            pin_session: None,
            pending_confirms: HashMap::new(),
        }
    }

    /// Check if there is a valid (non-expired, non-locked) PIN session
    fn has_valid_pin_session(&self) -> bool {
        if let Some(ref session) = self.pin_session {
            let now = chrono::Utc::now();
            if let Some(lockout) = session.lockout_until {
                if now < lockout {
                    return false;
                }
            }
            now < session.valid_until
        } else {
            false
        }
    }

    /// Check if the session is currently locked out
    fn is_locked_out(&self) -> bool {
        if let Some(ref session) = self.pin_session {
            if let Some(lockout) = session.lockout_until {
                return chrono::Utc::now() < lockout;
            }
        }
        false
    }
}

/// Handle a single WebSocket connection with bidirectional messaging
async fn handle_scada_ws(mut socket: WebSocket, state: ScadaState) {
    // Atomically claim a connection slot (TOCTOU-safe: increment first, check after)
    let prev = state
        .inner
        .ws_connection_count
        .fetch_add(1, Ordering::Relaxed);
    if prev >= MAX_WS_CONNECTIONS {
        state
            .inner
            .ws_connection_count
            .fetch_sub(1, Ordering::Relaxed);
        warn!(
            "SCADA WebSocket dropped post-upgrade: limit reached ({}/{})",
            prev, MAX_WS_CONNECTIONS
        );
        let _ = socket
            .send(axum::extract::ws::Message::Close(Some(
                axum::extract::ws::CloseFrame {
                    code: 1013, // Try Again Later
                    reason: "Too many connections".into(),
                },
            )))
            .await;
        return;
    }
    let _guard = WsConnectionGuard(Arc::clone(&state.inner));
    info!("SCADA WebSocket client connected");

    let mut session = WsSession::new();

    // --- Send initial state on connect ---

    // 1. Send package (preferred) or process (backward compat)
    if let Some(package) = state.get_package().await {
        let init_msg = serde_json::json!({
            "type": "setPackage",
            "data": package,
        });
        if let Ok(json) = serde_json::to_string(&init_msg) {
            if socket.send(Message::Text(json.into())).await.is_err() {
                return;
            }
        }
    } else if let Some(process) = state.get_process().await {
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

    // 2. Send all current tag values
    if let Some(ref pi) = state.inner.process_image {
        let all_tags = pi.get_all_tags().await;
        let tag_infos: Vec<TagInfo> = all_tags
            .iter()
            .map(|(name, tv)| TagInfo {
                tag_name: name.clone(),
                value: tv.value,
                quality: format!("{:?}", tv.quality).to_lowercase(),
                unit: None,
                io_type: None,
                timestamp: tv.timestamp.to_rfc3339(),
            })
            .collect();
        let msg = serde_json::json!({
            "type": "allTags",
            "data": tag_infos,
        });
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = socket.send(Message::Text(json.into())).await;
        }
    }

    // 3. Send active alarms
    {
        let engine = state.inner.alarm_engine.lock().await;
        let alarms = engine.get_active_alarms();
        for alarm in &alarms {
            let info = active_alarm_to_info(alarm);
            let msg = serde_json::json!({
                "type": "alarm",
                "data": info,
            });
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = socket.send(Message::Text(json.into())).await;
            }
        }
    }

    // 4. Send emergency state
    {
        let is_emergency = state.inner.emergency_active.load(Ordering::Acquire);
        let msg = serde_json::json!({
            "type": "emergency",
            "active": is_emergency,
        });
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = socket.send(Message::Text(json.into())).await;
        }
    }

    // Subscribe to broadcast channel
    let mut rx = state.subscribe();

    // Forward broadcast messages to the WebSocket client + handle incoming
    loop {
        tokio::select! {
            // Receive from broadcast channel and forward to WS client
            result = rx.recv() => {
                match result {
                    Ok(msg) => {
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
            // Handle incoming WS messages
            result = socket.recv() => {
                match result {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(data))) => {
                        if socket.send(Message::Pong(data)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        if let Err(should_close) = handle_ws_message(
                            &text,
                            &mut socket,
                            &state,
                            &mut session,
                        ).await {
                            if should_close {
                                break;
                            }
                        }
                    }
                    Some(Ok(_)) => {} // Ignore binary
                    Some(Err(_)) => break,
                }
            }
        }
    }

    info!("SCADA WebSocket client disconnected");
}

/// Handle a single incoming WS text message.
/// Returns Ok(()) on success, Err(true) if connection should close, Err(false) on non-fatal error.
async fn handle_ws_message(
    text: &str,
    socket: &mut WebSocket,
    state: &ScadaState,
    session: &mut WsSession,
) -> Result<(), bool> {
    let client_msg: WsClientMessage = match serde_json::from_str(text) {
        Ok(msg) => msg,
        Err(e) => {
            debug!("Invalid WS message from client: {}", e);
            let err = serde_json::json!({
                "type": "error",
                "message": format!("Invalid message: {}", e),
            });
            if let Ok(json) = serde_json::to_string(&err) {
                let _ = socket.send(Message::Text(json.into())).await;
            }
            return Ok(());
        }
    };

    match client_msg {
        WsClientMessage::Command { tag, value } | WsClientMessage::Setpoint { tag, value } => {
            handle_command_or_setpoint(socket, state, session, &tag, value).await
        }
        WsClientMessage::ConfirmResponse {
            request_id,
            confirmed,
        } => handle_confirm_response(socket, state, session, &request_id, confirmed).await,
        WsClientMessage::PinResponse { request_id, pin } => {
            handle_pin_response(socket, state, session, &request_id, &pin).await
        }
        WsClientMessage::AlarmAck { alarm_id } => handle_alarm_ack(state, &alarm_id).await,
        WsClientMessage::Calibrate {
            tag,
            action,
            point_index,
        } => handle_calibrate(socket, state, &tag, &action, point_index).await,
        WsClientMessage::RequestTrend { tag, from, to } => {
            handle_request_trend(socket, state, &tag, from, to).await
        }
        WsClientMessage::EmergencyStop => handle_emergency_stop(socket, state, session).await,
        WsClientMessage::EmergencyReset { pin } => {
            handle_emergency_reset(socket, state, session, &pin).await
        }
    }

    Ok(())
}

// ============================================================================
// WS Message Handlers
// ============================================================================

/// Handle command/setpoint messages with security level checking
async fn handle_command_or_setpoint(
    socket: &mut WebSocket,
    state: &ScadaState,
    session: &mut WsSession,
    tag: &str,
    value: f64,
) {
    // Check emergency stop
    if state.inner.emergency_active.load(Ordering::Acquire) {
        let msg = serde_json::json!({
            "type": "commandResult",
            "tag": tag,
            "success": false,
            "error": "Emergency stop active — commands blocked",
        });
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = socket.send(Message::Text(json.into())).await;
        }
        return;
    }

    // Check security level from package
    let security_level = if let Some(ref package) = *state.inner.package.read().await {
        get_security_level(tag, package)
    } else {
        SecurityLevel::None
    };

    match security_level {
        SecurityLevel::None => {
            // Execute directly
            execute_command(socket, state, tag, value, None, false).await;
        }
        SecurityLevel::Confirm => {
            // Send confirm request to client
            let request_id = uuid::Uuid::new_v4().to_string();
            session.pending_confirms.insert(
                request_id.clone(),
                PendingConfirm {
                    tag: tag.to_string(),
                    value,
                    source_ip: None,
                },
            );
            let msg = serde_json::json!({
                "type": "confirmRequest",
                "requestId": request_id,
                "tag": tag,
                "text": format!("{} = {:.2} olarak ayarlamak istediginize emin misiniz?", tag, value),
            });
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = socket.send(Message::Text(json.into())).await;
            }
        }
        SecurityLevel::Pin => {
            // Check if already authenticated
            if session.has_valid_pin_session() {
                execute_command(socket, state, tag, value, None, true).await;
            } else {
                // Store as pending and request PIN
                let request_id = uuid::Uuid::new_v4().to_string();
                session.pending_confirms.insert(
                    request_id.clone(),
                    PendingConfirm {
                        tag: tag.to_string(),
                        value,
                        source_ip: None,
                    },
                );
                let msg = serde_json::json!({
                    "type": "pinRequest",
                    "requestId": request_id,
                    "tag": tag,
                });
                if let Ok(json) = serde_json::to_string(&msg) {
                    let _ = socket.send(Message::Text(json.into())).await;
                }
            }
        }
    }
}

/// Execute a command via the command channel
async fn execute_command(
    socket: &mut WebSocket,
    state: &ScadaState,
    tag: &str,
    value: f64,
    source_ip: Option<String>,
    pin_used: bool,
) {
    if let Some(ref cmd_tx) = state.inner.command_tx {
        let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
        let command = ScadaCommand {
            tag: tag.to_string(),
            value,
            source_ip: source_ip.clone(),
            response_tx: resp_tx,
        };

        if cmd_tx.send(command).await.is_err() {
            let msg = serde_json::json!({
                "type": "commandResult",
                "tag": tag,
                "success": false,
                "error": "Command channel closed",
            });
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = socket.send(Message::Text(json.into())).await;
            }
            return;
        }

        // Wait for result with timeout
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), resp_rx).await;

        let (success, result_value, error) = match result {
            Ok(Ok(Ok(v))) => (true, Some(v), None),
            Ok(Ok(Err(e))) => (false, None, Some(e)),
            Ok(Err(_)) => (false, None, Some("Command handler dropped".to_string())),
            Err(_) => (false, None, Some("Command timeout".to_string())),
        };

        // Audit log
        if let Some(ref db) = state.inner.db {
            let _ = db.insert_audit(
                source_ip.as_deref(),
                "command",
                Some(tag),
                None,
                Some(value),
                pin_used,
                success,
                error.as_deref(),
            );
        }

        let msg = serde_json::json!({
            "type": "commandResult",
            "tag": tag,
            "success": success,
            "value": result_value,
            "error": error,
        });
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = socket.send(Message::Text(json.into())).await;
        }
    } else {
        // No command channel — backward compat mode
        let msg = serde_json::json!({
            "type": "commandResult",
            "tag": tag,
            "success": false,
            "error": "Command routing not available (no I/O channel)",
        });
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = socket.send(Message::Text(json.into())).await;
        }
    }
}

/// Handle confirm response from client
async fn handle_confirm_response(
    socket: &mut WebSocket,
    state: &ScadaState,
    session: &mut WsSession,
    request_id: &str,
    confirmed: bool,
) {
    if let Some(pending) = session.pending_confirms.remove(request_id) {
        if confirmed {
            // Route emergency stop confirmations to the dedicated handler
            if pending.tag == "__emergency_stop__" {
                execute_emergency_stop(socket, state).await;
                return;
            }
            execute_command(
                socket,
                state,
                &pending.tag,
                pending.value,
                pending.source_ip,
                false,
            )
            .await;
        } else {
            // Audit the rejection
            let action_type = if pending.tag == "__emergency_stop__" {
                info!("Emergency stop cancelled by user");
                "emergency_stop_cancelled"
            } else {
                "command_rejected"
            };
            if let Some(ref db) = state.inner.db {
                let _ = db.insert_audit(
                    pending.source_ip.as_deref(),
                    action_type,
                    Some(&pending.tag),
                    None,
                    Some(pending.value),
                    false,
                    false,
                    Some("User cancelled confirmation"),
                );
            }
            let msg = serde_json::json!({
                "type": "commandResult",
                "tag": pending.tag,
                "success": false,
                "error": "Command cancelled by user",
            });
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = socket.send(Message::Text(json.into())).await;
            }
        }
    }
}

/// Handle PIN response from client
async fn handle_pin_response(
    socket: &mut WebSocket,
    state: &ScadaState,
    session: &mut WsSession,
    request_id: &str,
    pin: &str,
) {
    // Check GLOBAL lockout (persists across WS reconnections)
    {
        let lockout = state.inner.pin_lockout.lock().await;
        if lockout.is_locked_out() {
            let msg = serde_json::json!({
                "type": "commandResult",
                "tag": "",
                "success": false,
                "error": "Too many failed PIN attempts. Try again later.",
            });
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = socket.send(Message::Text(json.into())).await;
            }
            return;
        }
    }

    // Get pin_hash from package
    let pin_hash = state
        .inner
        .package
        .read()
        .await
        .as_ref()
        .and_then(|pkg| pkg.control_permissions.pin_hash.clone());

    let pin_hash = match pin_hash {
        Some(h) => h,
        None => {
            let msg = serde_json::json!({
                "type": "commandResult",
                "tag": "",
                "success": false,
                "error": "PIN authentication not configured",
            });
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = socket.send(Message::Text(json.into())).await;
            }
            return;
        }
    };

    if verify_pin(pin, &pin_hash) {
        // PIN correct — reset global lockout and create session
        {
            let mut lockout = state.inner.pin_lockout.lock().await;
            lockout.reset();
        }

        let timeout = state
            .inner
            .package
            .read()
            .await
            .as_ref()
            .and_then(|pkg| pkg.control_permissions.pin_timeout)
            .unwrap_or(PIN_SESSION_TIMEOUT_SECS as u32);

        session.pin_session = Some(PinSession {
            valid_until: chrono::Utc::now() + chrono::Duration::seconds(timeout as i64),
            failed_attempts: 0,
            lockout_until: None,
        });

        // Execute pending command if any
        if let Some(pending) = session.pending_confirms.remove(request_id) {
            execute_command(
                socket,
                state,
                &pending.tag,
                pending.value,
                pending.source_ip,
                true,
            )
            .await;
        }
    } else {
        // PIN wrong — track failures in GLOBAL state
        let is_locked;
        let attempts;
        {
            let mut lockout = state.inner.pin_lockout.lock().await;
            lockout.record_failure();
            is_locked = lockout.is_locked_out();
            attempts = lockout.failed_attempts;
        }

        // Audit
        if let Some(ref db) = state.inner.db {
            let _ = db.insert_audit(
                None,
                "pin_failed",
                None,
                None,
                None,
                true,
                false,
                Some(&format!("Attempt {}/{}", attempts, MAX_PIN_FAILURES)),
            );
        }

        let msg = serde_json::json!({
            "type": "commandResult",
            "tag": "",
            "success": false,
            "error": if is_locked {
                "Too many failed PIN attempts. Locked out for 60 seconds."
            } else {
                "Invalid PIN"
            },
        });
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = socket.send(Message::Text(json.into())).await;
        }
    }
}

/// Handle alarm acknowledgment
async fn handle_alarm_ack(state: &ScadaState, alarm_id: &str) {
    let mut engine = state.inner.alarm_engine.lock().await;
    if let Err(e) = engine.acknowledge(alarm_id, "ws_client") {
        warn!("Failed to acknowledge alarm {}: {}", alarm_id, e);
    }
}

/// Handle calibration messages
async fn handle_calibrate(
    socket: &mut WebSocket,
    state: &ScadaState,
    tag: &str,
    action: &str,
    point_index: Option<u32>,
) {
    let mut engine = state.inner.calibration_engine.lock().await;

    let result = match action {
        "start" => {
            // We need calibration config — defaults are applied here until
            // the future calibration package schema lands.
            // In a full implementation, config would come from the package
            let config = crate::calibration_engine::CalibSensorConfig {
                tag: tag.to_string(),
                sensor_type: "unknown".to_string(),
                method: "two-point".to_string(),
                points: vec![
                    crate::calibration_engine::CalibPointDef {
                        label: "Point 1".to_string(),
                        reference_value: None,
                    },
                    crate::calibration_engine::CalibPointDef {
                        label: "Point 2".to_string(),
                        reference_value: None,
                    },
                ],
                tolerance: 0.1,
                interval_days: 30,
                stability_window: 15,
                stability_threshold: 0.05,
            };
            Some(engine.start(&config))
        }
        "confirm" => {
            let idx = point_index.unwrap_or(0) as usize;
            match engine.confirm_point(tag, idx) {
                Ok(msg) => Some(msg),
                Err(e) => {
                    warn!("Calibration confirm error for {}: {}", tag, e);
                    None
                }
            }
        }
        "cancel" => {
            engine.cancel(tag);
            None
        }
        _ => {
            warn!("Unknown calibration action: {}", action);
            None
        }
    };

    if let Some(state_msg) = result {
        let msg = serde_json::json!({
            "type": "calibrationState",
            "data": state_msg,
        });
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = socket.send(Message::Text(json.into())).await;
        }
    }
}

/// Handle trend data request
async fn handle_request_trend(
    socket: &mut WebSocket,
    state: &ScadaState,
    tag: &str,
    from: i64,
    to: i64,
) {
    let trend_guard = state.inner.trend_engine.lock().await;
    if let Some(ref engine) = *trend_guard {
        match engine.query(tag, from, to) {
            Ok(points) => {
                let trend_points: Vec<TrendPoint> = points
                    .iter()
                    .map(|p| TrendPoint {
                        timestamp: p.timestamp,
                        value: p.value,
                        quality: p.quality,
                    })
                    .collect();
                let msg = serde_json::json!({
                    "type": "trendData",
                    "tag": tag,
                    "data": trend_points,
                });
                if let Ok(json) = serde_json::to_string(&msg) {
                    let _ = socket.send(Message::Text(json.into())).await;
                }
            }
            Err(e) => {
                warn!("Trend query error for {}: {}", tag, e);
            }
        }
    }
}

/// Handle emergency stop with Confirm-level auth
///
/// Safety note: Emergency stop uses SecurityLevel::Confirm (client-side confirmation)
/// rather than PIN auth. In a real emergency, requiring a PIN could delay critical
/// shutdown and endanger safety. A simple "Are you sure?" is the right balance between
/// preventing accidental activation and allowing rapid response.
async fn handle_emergency_stop(
    socket: &mut WebSocket,
    state: &ScadaState,
    session: &mut WsSession,
) {
    // Send confirm request to client — emergency stop should be quick but deliberate
    let request_id = uuid::Uuid::new_v4().to_string();
    session.pending_confirms.insert(
        request_id.clone(),
        PendingConfirm {
            tag: "__emergency_stop__".to_string(),
            value: 0.0,
            source_ip: None,
        },
    );
    let msg = serde_json::json!({
        "type": "confirmRequest",
        "requestId": request_id,
        "tag": "__emergency_stop__",
        "text": "ACIL DURDURMA: Tum kontrol cikislari sifirlanacak. Onayliyor musunuz?",
    });
    if let Ok(json) = serde_json::to_string(&msg) {
        let _ = socket.send(Message::Text(json.into())).await;
    }
    info!(
        "Emergency stop confirm request sent to client (request_id={})",
        request_id
    );
}

/// Execute the actual emergency stop after confirmation
async fn execute_emergency_stop(socket: &mut WebSocket, state: &ScadaState) {
    info!("EMERGENCY STOP activated via WebSocket (confirmed)");

    // Release ordering ensures all prior writes are visible before the flag is seen
    state.inner.emergency_active.store(true, Ordering::Release);

    // Get affected tags from package
    let affected_tags = if let Some(ref pkg) = *state.inner.package.read().await {
        pkg.control_permissions
            .emergency_stop
            .as_ref()
            .map(|es| es.affected_tags.clone())
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    // Store emergency tags
    *state.inner.emergency_tags.write().await = affected_tags.clone();

    // Send commands to set all affected tags to 0, await each response
    let mut failed_tags: Vec<String> = Vec::new();
    let mut success_count: usize = 0;

    if let Some(ref cmd_tx) = state.inner.command_tx {
        for tag in &affected_tags {
            let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
            let command = ScadaCommand {
                tag: tag.clone(),
                value: 0.0,
                source_ip: None,
                response_tx: resp_tx,
            };
            if let Err(e) = cmd_tx.send(command).await {
                warn!("Failed to send emergency stop command for {}: {}", tag, e);
                failed_tags.push(tag.clone());
                continue;
            }

            // Wait for command result with 5-second timeout
            match tokio::time::timeout(std::time::Duration::from_secs(5), resp_rx).await {
                Ok(Ok(Ok(_))) => {
                    info!("Emergency stop: tag '{}' set to 0 successfully", tag);
                    success_count += 1;
                }
                Ok(Ok(Err(e))) => {
                    warn!("Emergency stop: tag '{}' command failed: {}", tag, e);
                    failed_tags.push(tag.clone());
                }
                Ok(Err(_)) => {
                    warn!("Emergency stop: tag '{}' command handler dropped", tag);
                    failed_tags.push(tag.clone());
                }
                Err(_) => {
                    warn!("Emergency stop: tag '{}' command timed out (5s)", tag);
                    failed_tags.push(tag.clone());
                }
            }
        }
    }

    if !failed_tags.is_empty() {
        error!(
            "EMERGENCY STOP: {}/{} tags failed: {:?}",
            failed_tags.len(),
            affected_tags.len(),
            failed_tags,
        );
    }

    // Audit
    if let Some(ref db) = state.inner.db {
        let error_detail = if failed_tags.is_empty() {
            None
        } else {
            Some(format!("Failed tags: {:?}", failed_tags))
        };
        let _ = db.insert_audit(
            None,
            "emergency_stop",
            None,
            None,
            None,
            false,
            failed_tags.is_empty(),
            error_detail.as_deref(),
        );
    }

    // Notify the requesting client about results
    let result_msg = serde_json::json!({
        "type": "emergencyStopResult",
        "success": failed_tags.is_empty(),
        "totalTags": affected_tags.len(),
        "successCount": success_count,
        "failedTags": failed_tags,
    });
    if let Ok(json) = serde_json::to_string(&result_msg) {
        let _ = socket.send(Message::Text(json.into())).await;
    }

    // Broadcast emergency state to all clients
    let msg = serde_json::json!({
        "type": "emergency",
        "active": true,
    });
    state.broadcast_json(&msg);
}

/// Handle emergency reset (requires PIN)
async fn handle_emergency_reset(
    socket: &mut WebSocket,
    state: &ScadaState,
    session: &mut WsSession,
    pin: &str,
) {
    // Check global lockout before attempting PIN verification
    {
        let lockout = state.inner.pin_lockout.lock().await;
        if lockout.is_locked_out() {
            let msg = serde_json::json!({
                "type": "commandResult",
                "tag": "",
                "success": false,
                "error": "Too many failed PIN attempts. Try again later.",
            });
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = socket.send(Message::Text(json.into())).await;
            }
            return;
        }
    }

    // Get pin_hash from package
    let pin_hash = state
        .inner
        .package
        .read()
        .await
        .as_ref()
        .and_then(|pkg| pkg.control_permissions.pin_hash.clone());

    let pin_hash = match pin_hash {
        Some(h) => h,
        None => {
            // No PIN configured, allow reset
            do_emergency_reset(state).await;
            return;
        }
    };

    if verify_pin(pin, &pin_hash) {
        // Reset global lockout on success
        {
            let mut lockout = state.inner.pin_lockout.lock().await;
            lockout.reset();
        }

        // Establish PIN session as well
        let timeout = state
            .inner
            .package
            .read()
            .await
            .as_ref()
            .and_then(|pkg| pkg.control_permissions.pin_timeout)
            .unwrap_or(PIN_SESSION_TIMEOUT_SECS as u32);

        session.pin_session = Some(PinSession {
            valid_until: chrono::Utc::now() + chrono::Duration::seconds(timeout as i64),
            failed_attempts: 0,
            lockout_until: None,
        });

        do_emergency_reset(state).await;
    } else {
        // Track failure in global state
        {
            let mut lockout = state.inner.pin_lockout.lock().await;
            lockout.record_failure();
        }

        let msg = serde_json::json!({
            "type": "commandResult",
            "tag": "",
            "success": false,
            "error": "Invalid PIN — emergency reset denied",
        });
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = socket.send(Message::Text(json.into())).await;
        }

        // Audit
        if let Some(ref db) = state.inner.db {
            let _ = db.insert_audit(
                None,
                "emergency_reset_failed",
                None,
                None,
                None,
                true,
                false,
                Some("Invalid PIN"),
            );
        }
    }
}

/// Execute emergency reset
async fn do_emergency_reset(state: &ScadaState) {
    info!("EMERGENCY STOP cleared via WebSocket");

    state.inner.emergency_active.store(false, Ordering::Release);
    state.inner.emergency_tags.write().await.clear();

    // Audit
    if let Some(ref db) = state.inner.db {
        let _ = db.insert_audit(None, "emergency_reset", None, None, None, true, true, None);
    }

    // Broadcast to all clients
    let msg = serde_json::json!({
        "type": "emergency",
        "active": false,
    });
    state.broadcast_json(&msg);
}

// ============================================================================
// Static Asset Handlers
// ============================================================================

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
    (
        [(header::CONTENT_TYPE, "application/javascript")],
        NODE_BUNDLE_JS,
    )
}

/// Serve PWA manifest
async fn manifest_handler() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/manifest+json")],
        PWA_MANIFEST,
    )
}

/// Serve PWA icon (same SVG for both sizes)
async fn icon_handler() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "image/svg+xml")], SCADA_ICON_SVG)
}

/// Serve minimal service worker
async fn sw_handler() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/javascript")],
        SERVICE_WORKER_JS,
    )
}

// ============================================================================
// Security Middleware
// ============================================================================

/// Security headers middleware for SCADA display server
async fn security_headers_middleware(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> impl IntoResponse {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert("X-Frame-Options", HeaderValue::from_static("DENY"));
    headers.insert(
        "X-Content-Type-Options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("Referrer-Policy", HeaderValue::from_static("no-referrer"));
    headers.insert(
        "Permissions-Policy",
        HeaderValue::from_static("geolocation=(), camera=(), microphone=(), payment=(), usb=()"),
    );
    // EDGE-MEDIUM-008: Only set CSP if the handler didn't already set a nonce-based
    // one (e.g., scada_page_handler injects a per-request nonce). For non-HTML
    // endpoints (JSON APIs, WebSocket), the static CSP below is sufficient.
    if !headers.contains_key("Content-Security-Policy") {
        headers.insert(
            "Content-Security-Policy",
            HeaderValue::from_static(
                "default-src 'self'; \
                 script-src 'none'; \
                 style-src 'none'; \
                 connect-src 'self' ws: wss:; \
                 img-src 'self' data:; \
                 manifest-src 'self'; \
                 frame-ancestors 'none'; \
                 base-uri 'self'; \
                 form-action 'none'; \
                 object-src 'none';",
            ),
        );
    }
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
        .route("/scada/tags", get(scada_tags_handler))
        .route("/scada/trends", get(scada_trends_handler))
        .route("/scada/alarms", get(scada_alarms_handler))
        .route("/scada/alarms/history", get(scada_alarms_history_handler))
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
/// # Security (IEC 62443 FR-2: Network segmentation)
/// Default bind address is `127.0.0.1` (loopback only). In edge deployments
/// with multiple NICs (OT + IT network), binding `0.0.0.0` exposes the SCADA
/// HMI to the IT network where it should not be accessible.
///
/// Use `SUDERRA_SCADA_BIND` to set the OT interface address explicitly:
///   SUDERRA_SCADA_BIND=192.168.100.1  (OT network only)
///   SUDERRA_SCADA_BIND=127.0.0.1      (loopback, default)
///   SUDERRA_SCADA_BIND=0.0.0.0        (all interfaces — NOT recommended for production)
///
/// Port is configurable via `SUDERRA_SCADA_PORT` (default 6526).
pub async fn start_scada_server(state: ScadaState) -> tokio::task::JoinHandle<()> {
    // Load persistent process
    state.load_persistent_process().await;

    let port: u16 = std::env::var("SUDERRA_SCADA_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(6526);

    // SECURITY: Default to loopback (127.0.0.1) instead of 0.0.0.0.
    // Edge devices with dual NICs (OT + IT) must not expose SCADA to IT network.
    // Operators can override via SUDERRA_SCADA_BIND for the OT interface address.
    let bind_addr: Ipv4Addr = std::env::var("SUDERRA_SCADA_BIND")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(Ipv4Addr::LOCALHOST);

    if bind_addr == Ipv4Addr::UNSPECIFIED {
        warn!(
            "SCADA server binding to 0.0.0.0 (all interfaces). \
             This exposes HMI to ALL networks including IT. \
             Set SUDERRA_SCADA_BIND to the OT interface address for production."
        );
    }

    let addr = SocketAddr::from((bind_addr, port));
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
