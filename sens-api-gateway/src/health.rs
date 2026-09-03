//! Health Check HTTP Endpoint
//!
//! Provides a lightweight HTTP server for health checks and readiness probes.
//! Used by orchestrators (Docker, Kubernetes, systemd) to monitor agent status.
//!
//! # Endpoints
//! - `GET /health` - Basic health check (always returns 200 if server is running)
//! - `GET /ready` - Readiness check (returns 200 only when fully initialized)
//! - `GET /metrics` - Basic metrics (queue size, uptime, connections)
//! - `GET /diagnostics` - Comprehensive diagnostics for remote troubleshooting (v1.2.4)
//!
//! # Configuration
//! Enable with the `health` feature flag in Cargo.toml.
//!
//! # IEC 62443 SL2 Compliance
//! - FR6: Timely Response to Events (health monitoring)
//! - FR7: Resource Availability (diagnostics for troubleshooting)

use serde::Serialize;
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::time::Instant;
use tracing::{error, info};

/// Health status response
#[derive(Debug, Clone, Serialize)]
pub struct HealthResponse {
    /// Service status ("healthy", "degraded", "unhealthy")
    pub status: &'static str,
    /// Service version
    pub version: &'static str,
    /// Uptime in seconds
    pub uptime_secs: u64,
}

/// Readiness status response
#[derive(Debug, Clone, Serialize)]
pub struct ReadinessResponse {
    /// Whether the service is ready to accept traffic
    pub ready: bool,
    /// Individual component checks
    pub checks: ReadinessChecks,
}

/// Individual readiness checks
#[derive(Debug, Clone, Serialize)]
pub struct ReadinessChecks {
    /// Configuration loaded
    pub config_loaded: bool,
    /// MQTT connected
    pub mqtt_connected: bool,
    /// Device activated (provisioned)
    pub device_activated: bool,
}

/// Basic metrics response
#[derive(Debug, Clone, Serialize)]
pub struct MetricsResponse {
    /// Uptime in seconds
    pub uptime_secs: u64,
    /// MQTT messages sent
    pub mqtt_messages_sent: u64,
    /// MQTT messages received
    pub mqtt_messages_received: u64,
    /// Modbus read count
    pub modbus_reads: u64,
    /// Script executions
    pub script_executions: u64,
    /// Offline queue size
    pub offline_queue_size: u64,
}

/// Comprehensive diagnostics response for troubleshooting (v1.2.4)
#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticsResponse {
    /// Timestamp of diagnostics collection
    pub timestamp: String,
    /// Agent version
    pub version: &'static str,
    /// Uptime in seconds
    pub uptime_secs: u64,
    /// System information
    pub system: SystemDiagnostics,
    /// Process information
    pub process: ProcessDiagnostics,
    /// Component status
    pub components: ComponentDiagnostics,
    /// Configuration summary (sanitized)
    pub config: ConfigDiagnostics,
    /// Recent errors (last 10)
    pub recent_errors: Vec<String>,
}

/// System-level diagnostics
#[derive(Debug, Clone, Serialize)]
pub struct SystemDiagnostics {
    /// Operating system
    pub os: String,
    /// Hostname
    pub hostname: String,
    /// CPU count
    pub cpu_count: usize,
    /// CPU usage percentage
    pub cpu_usage_percent: f32,
    /// Total memory (bytes)
    pub memory_total_bytes: u64,
    /// Used memory (bytes)
    pub memory_used_bytes: u64,
    /// Memory usage percentage
    pub memory_usage_percent: f32,
    /// Disk information
    pub disk: DiskDiagnostics,
}

/// Disk diagnostics
#[derive(Debug, Clone, Serialize)]
pub struct DiskDiagnostics {
    /// Total disk space (bytes)
    pub total_bytes: u64,
    /// Available disk space (bytes)
    pub available_bytes: u64,
    /// Usage percentage
    pub usage_percent: f32,
}

/// Process-level diagnostics
#[derive(Debug, Clone, Serialize)]
pub struct ProcessDiagnostics {
    /// Process ID
    pub pid: u32,
    /// Process memory usage (bytes)
    pub memory_bytes: u64,
    /// Number of threads
    pub thread_count: u32,
    /// Process start time (ISO 8601)
    pub start_time: String,
}

/// Component status diagnostics
#[derive(Debug, Clone, Serialize)]
pub struct ComponentDiagnostics {
    /// MQTT connection status
    pub mqtt: MqttDiagnostics,
    /// Modbus clients status
    pub modbus: ModbusDiagnostics,
    /// Script engine status
    pub scripts: ScriptDiagnostics,
    /// Function blocks status
    pub function_blocks: FunctionBlockDiagnostics,
    /// Offline queue status
    pub offline_queue: OfflineQueueDiagnostics,
}

/// MQTT connection diagnostics
#[derive(Debug, Clone, Serialize)]
pub struct MqttDiagnostics {
    /// Whether connected
    pub connected: bool,
    /// Messages sent
    pub messages_sent: u64,
    /// Messages received
    pub messages_received: u64,
    /// Last connection time
    pub last_connected: Option<String>,
}

/// Modbus diagnostics
#[derive(Debug, Clone, Serialize)]
pub struct ModbusDiagnostics {
    /// Number of configured clients
    pub client_count: usize,
    /// Total reads performed
    pub total_reads: u64,
    /// Read errors
    pub read_errors: u64,
    /// Circuit breaker states
    pub circuit_states: Vec<(String, String)>,
}

/// Script engine diagnostics
#[derive(Debug, Clone, Serialize)]
pub struct ScriptDiagnostics {
    /// Number of loaded scripts
    pub loaded_count: usize,
    /// Number of active scripts
    pub active_count: usize,
    /// Total executions
    pub total_executions: u64,
    /// Execution errors
    pub execution_errors: u64,
}

/// Function block diagnostics
#[derive(Debug, Clone, Serialize)]
pub struct FunctionBlockDiagnostics {
    /// Total FB instances
    pub instance_count: usize,
    /// FB types and counts
    pub type_counts: std::collections::HashMap<String, usize>,
}

/// Offline queue diagnostics
#[derive(Debug, Clone, Serialize)]
pub struct OfflineQueueDiagnostics {
    /// Current queue size
    pub size: u64,
    /// Queue capacity
    pub capacity: u64,
    /// Total messages queued
    pub total_queued: u64,
    /// Total messages sent from queue
    pub total_sent: u64,
}

/// Configuration diagnostics (sanitized - no secrets)
#[derive(Debug, Clone, Serialize)]
pub struct ConfigDiagnostics {
    /// Device ID (masked)
    pub device_id: String,
    /// MQTT broker host
    pub mqtt_host: String,
    /// Number of Modbus devices
    pub modbus_device_count: usize,
    /// Number of GPIO mappings
    pub gpio_mapping_count: usize,
    /// Telemetry interval (seconds)
    pub telemetry_interval_secs: u64,
}

/// Sanitize a string for safe inclusion as a Prometheus
/// label value (Batch 95). Per Prometheus exposition format
/// (OpenMetrics section 3.3) label values can contain any
/// unicode EXCEPT backslash, double-quote, and LF. We
/// replace each forbidden char with `_`.
///
/// Also enforces a length cap at 128 chars — device_id +
/// tenant UUIDs fit well under this; the cap prevents a
/// misconfigured field from bloating every scrape.
fn sanitize_prom_label(s: &str) -> String {
    let truncated = if s.len() > 128 { &s[..128] } else { s };
    truncated
        .chars()
        .map(|c| match c {
            '\n' | '\r' | '\\' | '"' => '_',
            c => c,
        })
        .collect()
}

/// Health check state shared with the main application
#[derive(Clone)]
pub struct HealthState {
    inner: Arc<HealthStateInner>,
}

struct HealthStateInner {
    /// When the service started
    start_time: Instant,
    /// Prometheus metric label for `device_id` (Batch 95).
    /// Set via `set_device_id()` after config load. Empty
    /// string when unset = "unknown" (valid Prometheus
    /// label value, differentiates from devices with a
    /// real ID so Grafana queries can filter).
    device_id_label: std::sync::RwLock<String>,
    /// Prometheus metric label for `tenant` (Batch 95).
    /// Set via `set_tenant_id()` after provisioning
    /// completes. Empty string = pre-provisioning.
    tenant_id_label: std::sync::RwLock<String>,
    /// Whether config is loaded
    config_loaded: AtomicBool,
    /// Whether MQTT is connected
    mqtt_connected: AtomicBool,
    /// Whether device is activated
    device_activated: AtomicBool,
    /// MQTT messages sent counter
    mqtt_sent: AtomicU64,
    /// MQTT messages received counter
    mqtt_received: AtomicU64,
    /// Modbus reads counter
    modbus_reads: AtomicU64,
    /// Modbus read errors counter (v1.2.4)
    modbus_errors: AtomicU64,
    /// Script executions counter
    script_executions: AtomicU64,
    /// Script execution errors (v1.2.4)
    script_errors: AtomicU64,
    /// Current offline queue size
    offline_queue_size: AtomicU64,
    /// Offline queue capacity (v1.2.4)
    offline_queue_capacity: AtomicU64,
    /// Total messages queued offline (v1.2.4)
    offline_total_queued: AtomicU64,
    /// Total messages sent from offline queue (v1.2.4)
    offline_total_sent: AtomicU64,
    /// Number of Modbus clients (v1.2.4)
    modbus_client_count: AtomicU64,
    /// Number of loaded scripts (v1.2.4)
    script_loaded_count: AtomicU64,
    /// Number of active scripts (v1.2.4)
    script_active_count: AtomicU64,
    /// Number of FB instances (v1.2.4)
    fb_instance_count: AtomicU64,
    /// Recent errors buffer (v1.2.4)
    /// v1.2.6: Changed to VecDeque for O(1) removal from front
    recent_errors: std::sync::RwLock<VecDeque<String>>,
    /// Config diagnostics (v1.2.4)
    config_diagnostics: std::sync::RwLock<Option<ConfigDiagnostics>>,
    /// MQTT last connected timestamp (v1.2.5)
    mqtt_last_connected: AtomicI64,
    /// Modbus circuit breaker states (v1.2.5)
    modbus_circuit_states: std::sync::RwLock<Vec<(String, String)>>,
    /// Function block type counts (v1.2.5)
    fb_type_counts: std::sync::RwLock<std::collections::HashMap<String, usize>>,
    /// Batch 132 Sprint 6.5: firmware lifecycle counters.
    /// Plan §4.2 IEC 62443 SL-2 observability evidence.
    /// `firmware_apply_applied` — successful apply.
    /// `firmware_apply_rejected` — verify / apply / streaming reject.
    /// `firmware_confirm` — successful PendingConfirm→Active.
    /// `firmware_rollback` — watchdog-fired rollback.
    /// `firmware_active_slot` gauge — 0=A, 1=B.
    /// `firmware_active_version` gauge — current active
    /// firmware version (monotonic). Populated after
    /// apply_signed_manifest or confirm_slot advances the
    /// PartitionStore active_firmware_version field.
    firmware_apply_applied: AtomicU64,
    firmware_apply_rejected: AtomicU64,
    firmware_confirm: AtomicU64,
    firmware_rollback: AtomicU64,
    firmware_active_slot: AtomicU64,
    firmware_active_version: AtomicU64,
    /// Batch 135 Sprint 6.5 — closes Batch 132 obs #3:
    /// lifecycle HTTP endpoint HMAC auth rejection
    /// counters. TOTAL bucket tracks ALL rejection
    /// reasons (missing header, malformed, timestamp
    /// skew, wrong HMAC). INVALID_HMAC bucket tracks
    /// the specific "correct shape but wrong key" path
    /// — operator-actionable security signal because it
    /// indicates a client computing HMACs with a
    /// different key than the agent expects (potentially
    /// a compromise or a key-rotation-mismatch).
    ///
    /// Two counters instead of 6-per-variant: simpler
    /// dashboard story ("how often is auth failing?" +
    /// "is there a key mismatch signal?") without
    /// exploding metric cardinality.
    lifecycle_auth_rejected: AtomicU64,
    lifecycle_auth_invalid_hmac: AtomicU64,
}

impl HealthState {
    /// Create a new health state
    pub fn new() -> Self {
        Self {
            inner: Arc::new(HealthStateInner {
                start_time: Instant::now(),
                device_id_label: std::sync::RwLock::new(String::new()),
                tenant_id_label: std::sync::RwLock::new(String::new()),
                config_loaded: AtomicBool::new(false),
                mqtt_connected: AtomicBool::new(false),
                device_activated: AtomicBool::new(false),
                mqtt_sent: AtomicU64::new(0),
                mqtt_received: AtomicU64::new(0),
                modbus_reads: AtomicU64::new(0),
                modbus_errors: AtomicU64::new(0),
                script_executions: AtomicU64::new(0),
                script_errors: AtomicU64::new(0),
                offline_queue_size: AtomicU64::new(0),
                offline_queue_capacity: AtomicU64::new(1000),
                offline_total_queued: AtomicU64::new(0),
                offline_total_sent: AtomicU64::new(0),
                modbus_client_count: AtomicU64::new(0),
                script_loaded_count: AtomicU64::new(0),
                script_active_count: AtomicU64::new(0),
                fb_instance_count: AtomicU64::new(0),
                recent_errors: std::sync::RwLock::new(VecDeque::with_capacity(10)),
                config_diagnostics: std::sync::RwLock::new(None),
                mqtt_last_connected: AtomicI64::new(0),
                modbus_circuit_states: std::sync::RwLock::new(Vec::new()),
                fb_type_counts: std::sync::RwLock::new(std::collections::HashMap::new()),
                firmware_apply_applied: AtomicU64::new(0),
                firmware_apply_rejected: AtomicU64::new(0),
                firmware_confirm: AtomicU64::new(0),
                firmware_rollback: AtomicU64::new(0),
                // firmware_active_slot gauge — 0=A by
                // convention matches PartitionState::initial.
                firmware_active_slot: AtomicU64::new(0),
                firmware_active_version: AtomicU64::new(0),
                lifecycle_auth_rejected: AtomicU64::new(0),
                lifecycle_auth_invalid_hmac: AtomicU64::new(0),
            }),
        }
    }

    // ========================================================================
    // Batch 132 Sprint 6.5 — firmware lifecycle metrics accessors
    // ========================================================================

    pub fn inc_firmware_apply_applied(&self) {
        self.inner
            .firmware_apply_applied
            .fetch_add(1, Ordering::AcqRel);
    }

    pub fn inc_firmware_apply_rejected(&self) {
        self.inner
            .firmware_apply_rejected
            .fetch_add(1, Ordering::AcqRel);
    }

    pub fn inc_firmware_confirm(&self) {
        self.inner.firmware_confirm.fetch_add(1, Ordering::AcqRel);
    }

    pub fn inc_firmware_rollback(&self) {
        self.inner.firmware_rollback.fetch_add(1, Ordering::AcqRel);
    }

    /// Set firmware_active_slot gauge. 0 = slot A, 1 = slot B.
    /// Other values are clamped to the enum range (defense
    /// against accidental non-enum writes; no harm if
    /// clamped since dashboards filter by 0/1).
    pub fn set_firmware_active_slot(&self, slot_index: u64) {
        let clamped = if slot_index > 1 { 1 } else { slot_index };
        self.inner
            .firmware_active_slot
            .store(clamped, Ordering::Release);
    }

    pub fn set_firmware_active_version(&self, version: u64) {
        self.inner
            .firmware_active_version
            .store(version, Ordering::Release);
    }

    /// Bump both the total-rejection counter AND, when
    /// `is_invalid_hmac` is true, the invalid-hmac
    /// counter. The is_invalid_hmac bucket is the
    /// operator-security signal (client + server disagree
    /// on the key); the total bucket tracks all rejection
    /// causes including operator misconfig.
    pub fn inc_lifecycle_auth_rejected(&self, is_invalid_hmac: bool) {
        self.inner
            .lifecycle_auth_rejected
            .fetch_add(1, Ordering::AcqRel);
        if is_invalid_hmac {
            self.inner
                .lifecycle_auth_invalid_hmac
                .fetch_add(1, Ordering::AcqRel);
        }
    }

    /// Get uptime in seconds
    pub fn uptime_secs(&self) -> u64 {
        self.inner.start_time.elapsed().as_secs()
    }

    /// Set the device_id label for Prometheus output
    /// (Batch 95 enterprise fleet observability). Called
    /// once from main.rs after config load — the label
    /// stays stable for the agent's lifetime.
    ///
    /// Validates against Prometheus label-value character
    /// set: rejects newline, double-quote, backslash
    /// (avoids exposition-format injection). Invalid chars
    /// are replaced with `_`.
    pub fn set_device_id(&self, device_id: &str) {
        let sanitized = sanitize_prom_label(device_id);
        if let Ok(mut w) = self.inner.device_id_label.write() {
            *w = sanitized;
        }
    }

    /// Set the tenant_id label for Prometheus output.
    /// Called once from main.rs after provisioning
    /// completes; before provisioning, the tenant label is
    /// the empty string.
    pub fn set_tenant_id(&self, tenant_id: &str) {
        let sanitized = sanitize_prom_label(tenant_id);
        if let Ok(mut w) = self.inner.tenant_id_label.write() {
            *w = sanitized;
        }
    }

    /// Set config loaded status
    pub fn set_config_loaded(&self, loaded: bool) {
        self.inner.config_loaded.store(loaded, Ordering::Release);
    }

    /// Set MQTT connected status
    pub fn set_mqtt_connected(&self, connected: bool) {
        self.inner
            .mqtt_connected
            .store(connected, Ordering::Release);
        // Track last connected time (v1.2.5)
        if connected {
            let now = chrono::Utc::now().timestamp();
            self.inner.mqtt_last_connected.store(now, Ordering::Release);
        }
    }

    /// Read current MQTT connection state (Batch #251 ARC-002 wire).
    ///
    /// Used by [`crate::outbound_publisher::OutboundPublisher`] to
    /// route publishes between direct-broker delivery and
    /// queue-on-disk persistence. The atomic load uses Acquire
    /// ordering so a `set_mqtt_connected(true)` from the event-loop
    /// thread is observed by the publish-path before the
    /// corresponding `publish_to_broker` call (load-bearing for the
    /// connect-handshake → first-publish ordering).
    pub fn is_mqtt_connected(&self) -> bool {
        self.inner.mqtt_connected.load(Ordering::Acquire)
    }

    /// Set device activated status
    pub fn set_device_activated(&self, activated: bool) {
        self.inner
            .device_activated
            .store(activated, Ordering::Release);
    }

    /// Increment MQTT sent counter
    pub fn inc_mqtt_sent(&self) {
        self.inner.mqtt_sent.fetch_add(1, Ordering::Relaxed);
    }

    /// Increment MQTT received counter
    pub fn inc_mqtt_received(&self) {
        self.inner.mqtt_received.fetch_add(1, Ordering::Relaxed);
    }

    /// Increment Modbus reads counter
    pub fn inc_modbus_reads(&self) {
        self.inner.modbus_reads.fetch_add(1, Ordering::Relaxed);
    }

    /// Increment script executions counter
    pub fn inc_script_executions(&self) {
        self.inner.script_executions.fetch_add(1, Ordering::Relaxed);
    }

    /// Increment Modbus errors counter (v1.2.4)
    pub fn inc_modbus_errors(&self) {
        self.inner.modbus_errors.fetch_add(1, Ordering::Relaxed);
    }

    /// Increment script errors counter (v1.2.4)
    pub fn inc_script_errors(&self) {
        self.inner.script_errors.fetch_add(1, Ordering::Relaxed);
    }

    /// Set Modbus client count (v1.2.4)
    pub fn set_modbus_client_count(&self, count: usize) {
        self.inner
            .modbus_client_count
            .store(count as u64, Ordering::Release);
    }

    /// Set script counts (v1.2.4)
    pub fn set_script_counts(&self, loaded: usize, active: usize) {
        self.inner
            .script_loaded_count
            .store(loaded as u64, Ordering::Release);
        self.inner
            .script_active_count
            .store(active as u64, Ordering::Release);
    }

    /// Set FB instance count (v1.2.4)
    pub fn set_fb_instance_count(&self, count: usize) {
        self.inner
            .fb_instance_count
            .store(count as u64, Ordering::Release);
    }

    /// Set Modbus circuit breaker states (v1.2.5)
    pub fn set_modbus_circuit_states(&self, states: Vec<(String, String)>) {
        if let Ok(mut guard) = self.inner.modbus_circuit_states.write() {
            *guard = states;
        }
    }

    /// Set function block type counts (v1.2.5)
    pub fn set_fb_type_counts(&self, counts: std::collections::HashMap<String, usize>) {
        if let Ok(mut guard) = self.inner.fb_type_counts.write() {
            *guard = counts;
        }
    }

    /// Set offline queue size
    pub fn set_offline_queue_size(&self, size: u64) {
        self.inner.offline_queue_size.store(size, Ordering::Release);
    }

    /// Set offline queue capacity (v1.2.4)
    pub fn set_offline_queue_capacity(&self, capacity: u64) {
        self.inner
            .offline_queue_capacity
            .store(capacity, Ordering::Release);
    }

    /// Increment offline messages queued (v1.2.4)
    pub fn inc_offline_queued(&self) {
        self.inner
            .offline_total_queued
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Increment offline messages sent (v1.2.4)
    pub fn inc_offline_sent(&self) {
        self.inner
            .offline_total_sent
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Add an error to the recent errors buffer (v1.2.4)
    /// v1.2.6: Uses VecDeque::pop_front() for O(1) removal instead of Vec::remove(0)
    pub fn add_error(&self, error: impl Into<String>) {
        if let Ok(mut errors) = self.inner.recent_errors.write() {
            if errors.len() >= 10 {
                errors.pop_front(); // O(1) instead of O(n)
            }
            let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
            errors.push_back(format!("[{}] {}", timestamp, error.into()));
        }
    }

    /// Set configuration diagnostics (v1.2.4)
    pub fn set_config_diagnostics(&self, diag: ConfigDiagnostics) {
        if let Ok(mut config) = self.inner.config_diagnostics.write() {
            *config = Some(diag);
        }
    }

    /// Check if ready (all components initialized)
    pub fn is_ready(&self) -> bool {
        self.inner.config_loaded.load(Ordering::Acquire)
            && self.inner.device_activated.load(Ordering::Acquire)
    }

    /// Get health response
    pub fn health(&self) -> HealthResponse {
        let status = if self.is_ready() {
            "healthy"
        } else if self.inner.config_loaded.load(Ordering::Acquire) {
            "degraded"
        } else {
            "unhealthy"
        };

        HealthResponse {
            status,
            version: env!("CARGO_PKG_VERSION"),
            uptime_secs: self.uptime_secs(),
        }
    }

    /// Get readiness response
    pub fn readiness(&self) -> ReadinessResponse {
        ReadinessResponse {
            ready: self.is_ready(),
            checks: ReadinessChecks {
                config_loaded: self.inner.config_loaded.load(Ordering::Acquire),
                mqtt_connected: self.inner.mqtt_connected.load(Ordering::Acquire),
                device_activated: self.inner.device_activated.load(Ordering::Acquire),
            },
        }
    }

    /// Get metrics response
    pub fn metrics(&self) -> MetricsResponse {
        MetricsResponse {
            uptime_secs: self.uptime_secs(),
            mqtt_messages_sent: self.inner.mqtt_sent.load(Ordering::Acquire),
            mqtt_messages_received: self.inner.mqtt_received.load(Ordering::Acquire),
            modbus_reads: self.inner.modbus_reads.load(Ordering::Acquire),
            script_executions: self.inner.script_executions.load(Ordering::Acquire),
            offline_queue_size: self.inner.offline_queue_size.load(Ordering::Acquire),
        }
    }

    /// Get metrics in Prometheus text exposition format
    /// (Batch 94 enterprise observability foundation).
    ///
    /// Returns a String in the standard Prometheus
    /// exposition format consumable by
    /// `prometheus_scrape`, Grafana Agent, VictoriaMetrics,
    /// etc. Metric names follow Prometheus naming
    /// conventions:
    /// - `snake_case` identifiers.
    /// - Counters end with `_total`.
    /// - Gauges have plain names.
    /// - Durations in seconds (not milliseconds).
    ///
    /// All metrics carry `agent="suderra-edge"` + `device_id`
    /// + `tenant` labels so multi-tenant fleet dashboards can
    /// slice by device + tenant. `device_id` / `tenant`
    /// default to empty string pre-config-load +
    /// pre-provisioning respectively.
    pub fn metrics_prometheus(&self) -> String {
        let mut out = String::with_capacity(2048);

        // Batch 95: assemble label set once per scrape.
        // Empty values are still valid Prometheus label
        // values — distinguish from missing metrics via
        // the empty string sentinel (Grafana queries
        // filter `device_id!=""`).
        let device_id = self
            .inner
            .device_id_label
            .read()
            .map(|g| g.clone())
            .unwrap_or_default();
        let tenant_id = self
            .inner
            .tenant_id_label
            .read()
            .map(|g| g.clone())
            .unwrap_or_default();
        let labels = format!(
            "agent=\"suderra-edge\",device_id=\"{}\",tenant=\"{}\"",
            device_id, tenant_id
        );

        // Helper macros via simple string concat — avoiding
        // prometheus crate dep + matching the existing
        // vanilla approach in this module.
        let counter = |out: &mut String, name: &str, help: &str, value: u64, labels: &str| {
            out.push_str(&format!("# HELP {} {}\n", name, help));
            out.push_str(&format!("# TYPE {} counter\n", name));
            out.push_str(&format!("{}{{{}}} {}\n", name, labels, value));
        };
        let gauge = |out: &mut String, name: &str, help: &str, value: u64, labels: &str| {
            out.push_str(&format!("# HELP {} {}\n", name, help));
            out.push_str(&format!("# TYPE {} gauge\n", name));
            out.push_str(&format!("{}{{{}}} {}\n", name, labels, value));
        };

        counter(
            &mut out,
            "suderra_uptime_seconds_total",
            "Total uptime since agent start",
            self.uptime_secs(),
            &labels,
        );
        counter(
            &mut out,
            "suderra_mqtt_messages_sent_total",
            "Total MQTT messages published",
            self.inner.mqtt_sent.load(Ordering::Acquire),
            &labels,
        );
        counter(
            &mut out,
            "suderra_mqtt_messages_received_total",
            "Total MQTT messages received",
            self.inner.mqtt_received.load(Ordering::Acquire),
            &labels,
        );
        gauge(
            &mut out,
            "suderra_mqtt_connected",
            "MQTT broker connection state (1=connected, 0=disconnected)",
            u64::from(self.inner.mqtt_connected.load(Ordering::Acquire)),
            &labels,
        );
        counter(
            &mut out,
            "suderra_modbus_reads_total",
            "Total Modbus register reads completed",
            self.inner.modbus_reads.load(Ordering::Acquire),
            &labels,
        );
        counter(
            &mut out,
            "suderra_modbus_errors_total",
            "Total Modbus read errors",
            self.inner.modbus_errors.load(Ordering::Acquire),
            &labels,
        );
        counter(
            &mut out,
            "suderra_script_executions_total",
            "Total ST script executions",
            self.inner.script_executions.load(Ordering::Acquire),
            &labels,
        );
        counter(
            &mut out,
            "suderra_script_errors_total",
            "Total ST script execution errors",
            self.inner.script_errors.load(Ordering::Acquire),
            &labels,
        );
        gauge(
            &mut out,
            "suderra_offline_queue_size",
            "Current number of messages queued offline",
            self.inner.offline_queue_size.load(Ordering::Acquire),
            &labels,
        );
        gauge(
            &mut out,
            "suderra_offline_queue_capacity",
            "Offline queue capacity ceiling",
            self.inner.offline_queue_capacity.load(Ordering::Acquire),
            &labels,
        );
        counter(
            &mut out,
            "suderra_offline_queue_queued_total",
            "Total messages ever queued offline (lifetime)",
            self.inner.offline_total_queued.load(Ordering::Acquire),
            &labels,
        );
        counter(
            &mut out,
            "suderra_offline_queue_sent_total",
            "Total messages ever sent from offline queue (lifetime)",
            self.inner.offline_total_sent.load(Ordering::Acquire),
            &labels,
        );
        gauge(
            &mut out,
            "suderra_modbus_clients",
            "Number of currently-registered Modbus clients",
            self.inner.modbus_client_count.load(Ordering::Acquire),
            &labels,
        );
        gauge(
            &mut out,
            "suderra_scripts_loaded",
            "Number of ST scripts loaded",
            self.inner.script_loaded_count.load(Ordering::Acquire),
            &labels,
        );
        gauge(
            &mut out,
            "suderra_scripts_active",
            "Number of ST scripts actively executing",
            self.inner.script_active_count.load(Ordering::Acquire),
            &labels,
        );
        gauge(
            &mut out,
            "suderra_function_blocks",
            "Number of function block instances",
            self.inner.fb_instance_count.load(Ordering::Acquire),
            &labels,
        );

        // Batch 132 Sprint 6.5: firmware lifecycle metrics.
        // Plan §4.2 IEC 62443 SL-2 observability evidence.
        counter(
            &mut out,
            "suderra_firmware_apply_applied_total",
            "Total signed-manifest firmware applies that succeeded end-to-end (verify + stream + apply_roll + bootloader coord)",
            self.inner.firmware_apply_applied.load(Ordering::Acquire),
            &labels,
        );
        counter(
            &mut out,
            "suderra_firmware_apply_rejected_total",
            "Total signed-manifest firmware applies that were rejected at any gate (verify / streaming / apply_roll)",
            self.inner.firmware_apply_rejected.load(Ordering::Acquire),
            &labels,
        );
        counter(
            &mut out,
            "suderra_firmware_confirm_total",
            "Total A/B slot confirms that succeeded (PendingConfirm -> Active transition)",
            self.inner.firmware_confirm.load(Ordering::Acquire),
            &labels,
        );
        counter(
            &mut out,
            "suderra_firmware_rollback_total",
            "Total watchdog-fired firmware rollbacks (cold-boot-budget expired on PendingConfirm slot)",
            self.inner.firmware_rollback.load(Ordering::Acquire),
            &labels,
        );
        gauge(
            &mut out,
            "suderra_firmware_active_slot",
            "Currently-active A/B partition slot (0=slot_a, 1=slot_b)",
            self.inner.firmware_active_slot.load(Ordering::Acquire),
            &labels,
        );
        gauge(
            &mut out,
            "suderra_firmware_active_version",
            "Monotonic firmware version currently active on the device",
            self.inner.firmware_active_version.load(Ordering::Acquire),
            &labels,
        );
        // Batch 135 Sprint 6.5: lifecycle HTTP HMAC auth
        // rejection counters. Total = any reject reason;
        // invalid_hmac = specifically wrong-key path.
        counter(
            &mut out,
            "suderra_lifecycle_auth_rejected_total",
            "Total POST /lifecycle/* HMAC auth rejections across all gates (missing header, malformed, timestamp skew, wrong hmac)",
            self.inner.lifecycle_auth_rejected.load(Ordering::Acquire),
            &labels,
        );
        counter(
            &mut out,
            "suderra_lifecycle_auth_invalid_hmac_total",
            "POST /lifecycle/* HMAC auth rejections where HMAC bytes parsed correctly but did not match (client+server key mismatch signal)",
            self.inner
                .lifecycle_auth_invalid_hmac
                .load(Ordering::Acquire),
            &labels,
        );
        gauge(
            &mut out,
            "suderra_device_activated",
            "Device activation state (1=activated, 0=pending-provisioning)",
            u64::from(self.inner.device_activated.load(Ordering::Acquire)),
            &labels,
        );
        gauge(
            &mut out,
            "suderra_config_loaded",
            "Config load state (1=loaded, 0=not-yet)",
            u64::from(self.inner.config_loaded.load(Ordering::Acquire)),
            &labels,
        );

        out
    }

    /// Get comprehensive diagnostics response (v1.2.4)
    pub fn diagnostics(&self) -> DiagnosticsResponse {
        use sysinfo::{Disks, System};

        // Collect system information
        let mut sys = System::new_all();
        sys.refresh_all();

        let cpu_usage = sys.global_cpu_usage();
        let total_memory = sys.total_memory();
        let used_memory = sys.used_memory();

        // Get disk info for root partition
        let disks = Disks::new_with_refreshed_list();
        let (disk_total, disk_available) = disks
            .iter()
            .find(|d| d.mount_point().to_string_lossy() == "/")
            .map(|d| (d.total_space(), d.available_space()))
            .unwrap_or((0, 0));

        let disk_usage_percent = if disk_total > 0 {
            ((disk_total - disk_available) as f32 / disk_total as f32) * 100.0
        } else {
            0.0
        };

        // Get process info
        let pid = std::process::id();
        let (proc_memory, thread_count) = sys
            .process(sysinfo::Pid::from_u32(pid))
            .map(|p| (p.memory(), 0u32)) // thread count not directly available
            .unwrap_or((0, 0));

        // Recent errors (v1.2.6: convert VecDeque to Vec for serialization)
        let recent_errors: Vec<String> = self
            .inner
            .recent_errors
            .read()
            .map(|e| e.iter().cloned().collect())
            .unwrap_or_default();

        // Config diagnostics
        let config = self
            .inner
            .config_diagnostics
            .read()
            .map(|c| c.clone())
            .unwrap_or(None)
            .unwrap_or(ConfigDiagnostics {
                device_id: "not_configured".to_string(),
                mqtt_host: "not_configured".to_string(),
                modbus_device_count: 0,
                gpio_mapping_count: 0,
                telemetry_interval_secs: 0,
            });

        DiagnosticsResponse {
            timestamp: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
            version: env!("CARGO_PKG_VERSION"),
            uptime_secs: self.uptime_secs(),
            system: SystemDiagnostics {
                os: System::long_os_version().unwrap_or_else(|| "unknown".to_string()),
                hostname: System::host_name().unwrap_or_else(|| "unknown".to_string()),
                cpu_count: sys.cpus().len(),
                cpu_usage_percent: cpu_usage,
                memory_total_bytes: total_memory,
                memory_used_bytes: used_memory,
                memory_usage_percent: if total_memory > 0 {
                    (used_memory as f32 / total_memory as f32) * 100.0
                } else {
                    0.0
                },
                disk: DiskDiagnostics {
                    total_bytes: disk_total,
                    available_bytes: disk_available,
                    usage_percent: disk_usage_percent,
                },
            },
            process: ProcessDiagnostics {
                pid,
                memory_bytes: proc_memory,
                thread_count,
                start_time: chrono::Utc::now()
                    .checked_sub_signed(chrono::Duration::seconds(self.uptime_secs() as i64))
                    .map(|t| t.format("%Y-%m-%dT%H:%M:%SZ").to_string())
                    .unwrap_or_else(|| "unknown".to_string()),
            },
            components: ComponentDiagnostics {
                mqtt: MqttDiagnostics {
                    connected: self.inner.mqtt_connected.load(Ordering::Acquire),
                    messages_sent: self.inner.mqtt_sent.load(Ordering::Acquire),
                    messages_received: self.inner.mqtt_received.load(Ordering::Acquire),
                    last_connected: {
                        let ts = self.inner.mqtt_last_connected.load(Ordering::Acquire);
                        if ts > 0 {
                            chrono::DateTime::from_timestamp(ts, 0)
                                .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
                        } else {
                            None
                        }
                    },
                },
                modbus: ModbusDiagnostics {
                    client_count: self.inner.modbus_client_count.load(Ordering::Acquire) as usize,
                    total_reads: self.inner.modbus_reads.load(Ordering::Acquire),
                    read_errors: self.inner.modbus_errors.load(Ordering::Acquire),
                    circuit_states: self
                        .inner
                        .modbus_circuit_states
                        .read()
                        .map(|g| g.clone())
                        .unwrap_or_default(),
                },
                scripts: ScriptDiagnostics {
                    loaded_count: self.inner.script_loaded_count.load(Ordering::Acquire) as usize,
                    active_count: self.inner.script_active_count.load(Ordering::Acquire) as usize,
                    total_executions: self.inner.script_executions.load(Ordering::Acquire),
                    execution_errors: self.inner.script_errors.load(Ordering::Acquire),
                },
                function_blocks: FunctionBlockDiagnostics {
                    instance_count: self.inner.fb_instance_count.load(Ordering::Acquire) as usize,
                    type_counts: self
                        .inner
                        .fb_type_counts
                        .read()
                        .map(|g| g.clone())
                        .unwrap_or_default(),
                },
                offline_queue: OfflineQueueDiagnostics {
                    size: self.inner.offline_queue_size.load(Ordering::Acquire),
                    capacity: self.inner.offline_queue_capacity.load(Ordering::Acquire),
                    total_queued: self.inner.offline_total_queued.load(Ordering::Acquire),
                    total_sent: self.inner.offline_total_sent.load(Ordering::Acquire),
                },
            },
            config,
            recent_errors,
        }
    }
}

impl Default for HealthState {
    fn default() -> Self {
        Self::new()
    }
}

/// Start the health check HTTP server
///
/// This function spawns a background task that listens for HTTP requests.
/// It should be called early in the application startup.
///
/// # Arguments
/// * `addr` - Socket address to bind to (e.g., "127.0.0.1:8080")
/// * `state` - Health state shared with the main application
///
/// # Returns
/// A join handle that can be used to wait for the server to stop.
// BATCH-001-CI-FIX-017 (Batch 14 bug revealed by default="health"):
// `State` tuple-struct pattern at health_handler et al. needs `State` as a
// BARE NAME in scope — a full path `axum::extract::State` in the type
// annotation doesn't satisfy tuple-struct pattern syntax. Handlers live
// OUTSIDE `start_health_server`, so the function-local `use axum::{...}`
// inside that body didn't cover them. Before Batch 14 the `health` feature
// was OFF by default, so the cfg-gated handlers never compiled and the
// scope bug stayed silent.
//
// Fix: module-level `use axum::extract::State` (cfg-gated) so all
// `#[cfg(feature = "health")]` handlers see it. Function-local imports
// inside `start_health_server` removed (router methods use full paths).
//
// Logged as OBS-14-004 in session-observations.md.
#[cfg(feature = "health")]
use axum::extract::State;

// EDGE-HIGH-020: `Extension` must be a BARE NAME in scope for the
// tuple-struct extractor pattern in the sensitive handlers (same
// constraint as `State`, see BATCH-001-CI-FIX-017 above).
#[cfg(feature = "health")]
use axum::Extension;

/// EDGE-HIGH-020 — authentication gate for the SENSITIVE health-server
/// endpoints (`/metrics`, `/metrics/prometheus`, `/diagnostics`).
///
/// These expose internal counters and comprehensive diagnostics. Unlike
/// the liveness (`/health`) and readiness (`/ready`) probes — which
/// orchestrators MUST be able to hit anonymously — they are gated. The
/// gate reuses the health-server HMAC mechanism: the same
/// systemd-credential-delivered key the lifecycle control endpoint uses,
/// carried on the shared `LifecycleHandlesCell`. No new key, no new config
/// surface — one auth SSoT for the whole health server.
///
/// Trust boundary:
///   * auth key present            → a valid per-request HMAC is REQUIRED;
///   * auth key absent, loopback    → allowed (localhost is the SL-2 trust
///     boundary — preserves the default local-scrape posture, zero
///     regression);
///   * auth key absent, NON-loopback → REFUSED (401).
///
/// The last arm is the fix: internal diagnostics can no longer be exposed
/// to the network anonymously. Binding externally without a configured
/// auth key fails closed by construction (make-it-impossible) rather than
/// silently serving diagnostics to any network peer.
#[cfg(feature = "health")]
#[derive(Clone)]
struct ObservabilityAuth {
    lifecycle_cell: Option<crate::lifecycle::LifecycleHandlesCell>,
    bind_is_loopback: bool,
}

#[cfg(feature = "health")]
enum ObservabilityAuthRejection {
    Hmac(String),
    ExternalBindNoKey,
}

#[cfg(feature = "health")]
impl ObservabilityAuthRejection {
    fn into_response(self) -> axum::response::Response {
        use axum::response::IntoResponse;
        let (reason, detail) = match self {
            Self::Hmac(e) => ("hmac_auth_failed", e),
            Self::ExternalBindNoKey => (
                "auth_required_for_external_bind",
                "health server is bound to a non-loopback address but no HMAC \
                 auth key is configured; sensitive endpoints refuse anonymous \
                 network access"
                    .to_string(),
            ),
        };
        (
            axum::http::StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({ "error": reason, "reason": detail })),
        )
            .into_response()
    }
}

#[cfg(feature = "health")]
impl ObservabilityAuth {
    /// Fail-closed authorization for one sensitive request. `path` is the
    /// canonical route (must match the HMAC input the client signed).
    async fn authorize(
        &self,
        path: &str,
        headers: &axum::http::HeaderMap,
    ) -> Result<(), ObservabilityAuthRejection> {
        use crate::lifecycle_auth::{HEADER_HMAC, HEADER_TIMESTAMP, verify_request};

        let handles = self.lifecycle_cell.as_ref().and_then(|c| c.get());
        let auth_key = handles.and_then(|h| h.auth_key.as_ref());

        match auth_key {
            Some(key) => {
                let hmac_header = headers.get(HEADER_HMAC).and_then(|v| v.to_str().ok());
                let ts_header = headers.get(HEADER_TIMESTAMP).and_then(|v| v.to_str().ok());

                // Prefer the wired clock authority (fail-closed on NTS-stale);
                // fall back to a fresh SystemClockAuthority only when the cell
                // predates clock wiring — same posture as the lifecycle handler.
                let clock_owned;
                let clock_ref: &dyn crate::runtime_safety::ClockAuthority =
                    match handles.and_then(|h| h.clock_authority.as_ref()) {
                        Some(c) => &**c,
                        None => {
                            clock_owned = crate::runtime_safety::SystemClockAuthority::new();
                            &clock_owned
                        }
                    };

                verify_request(key, "GET", path, hmac_header, ts_header, clock_ref)
                    .await
                    .map_err(|e| ObservabilityAuthRejection::Hmac(e.to_string()))
            }
            None => {
                if self.bind_is_loopback {
                    Ok(())
                } else {
                    Err(ObservabilityAuthRejection::ExternalBindNoKey)
                }
            }
        }
    }
}

#[cfg(feature = "health")]
pub async fn start_health_server(
    addr: SocketAddr,
    state: HealthState,
    lifecycle_cell: Option<crate::lifecycle::LifecycleHandlesCell>,
) -> tokio::task::JoinHandle<()> {
    use axum::{
        Extension, Router,
        routing::{get, post},
    };

    // Build the router. The lifecycle cell is layered in
    // as Extension so the confirm-active handler can read
    // it independently of the HealthState state. Axum's
    // with_state type takes exactly ONE state type; we
    // keep HealthState there + layer the lifecycle cell
    // on top so the routes that need it can extract it
    // via Extension<LifecycleHandlesCell>.
    // EDGE-HIGH-020: the sensitive endpoints (/metrics, /metrics/prometheus,
    // /diagnostics) authorize against the shared health-server HMAC key and
    // fail closed on a non-loopback bind without a key. /health and /ready
    // stay anonymous for orchestrator probes.
    let obs_auth = ObservabilityAuth {
        lifecycle_cell: lifecycle_cell.clone(),
        bind_is_loopback: addr.ip().is_loopback(),
    };

    let mut app = Router::new()
        .route("/health", get(health_handler))
        .route("/ready", get(ready_handler))
        .route("/metrics", get(metrics_handler))
        .route("/metrics/prometheus", get(metrics_prometheus_handler))
        .route("/diagnostics", get(diagnostics_handler))
        .layer(Extension(obs_auth));

    // Batch 122 Sprint 6.5: register the lifecycle
    // endpoint(s) conditionally. When the caller supplied
    // a cell (main path wires one iff partition_store
    // init succeeds), the route is live; otherwise the
    // route is NOT registered so there is no half-wired
    // 503-always state.
    if let Some(cell) = lifecycle_cell {
        app = app
            .route(
                "/lifecycle/confirm-active",
                post(crate::lifecycle::confirm_active_handler),
            )
            .layer(Extension(cell))
            // PR935-HIGH-005: give the confirm-active POST the same
            // bind-address context the observability GETs use, so its keyless
            // branch fails closed on a non-loopback bind instead of accepting
            // anonymous firmware-lifecycle writes from any network peer.
            .layer(Extension(crate::lifecycle::HealthBindIsLoopback(
                addr.ip().is_loopback(),
            )));
        info!("Lifecycle HTTP endpoint registered: POST /lifecycle/confirm-active");
    }

    let app = app.with_state(state);

    info!("Starting health check server on {}", addr);

    // Spawn the server in a background task
    tokio::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                error!("Failed to bind health server to {}: {}", addr, e);
                return;
            }
        };

        if let Err(e) = axum::serve(listener, app).await {
            error!("Health server error: {}", e);
        }
    })
}

#[cfg(feature = "health")]
async fn health_handler(
    State(state): axum::extract::State<HealthState>,
) -> impl axum::response::IntoResponse {
    let health = state.health();
    let status_code = match health.status {
        "healthy" => axum::http::StatusCode::OK,
        "degraded" => axum::http::StatusCode::OK, // Still return 200 for degraded
        _ => axum::http::StatusCode::SERVICE_UNAVAILABLE,
    };
    (status_code, axum::Json(health))
}

#[cfg(feature = "health")]
async fn ready_handler(
    State(state): axum::extract::State<HealthState>,
) -> impl axum::response::IntoResponse {
    let readiness = state.readiness();
    let status_code = if readiness.ready {
        axum::http::StatusCode::OK
    } else {
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    };
    (status_code, axum::Json(readiness))
}

#[cfg(feature = "health")]
async fn metrics_handler(
    State(state): axum::extract::State<HealthState>,
    Extension(auth): Extension<ObservabilityAuth>,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    if let Err(rej) = auth.authorize("/metrics", &headers).await {
        tracing::warn!("observability endpoint /metrics: auth REJECTED");
        return rej.into_response();
    }
    (axum::http::StatusCode::OK, axum::Json(state.metrics())).into_response()
}

/// Prometheus text-format metrics endpoint (Batch 94
/// enterprise observability).
///
/// Returns the Prometheus exposition format with
/// `Content-Type: text/plain; version=0.0.4; charset=utf-8`
/// per Prometheus scrape protocol. Grafana Agent /
/// VictoriaMetrics / plain Prometheus all consume this
/// shape natively.
#[cfg(feature = "health")]
async fn metrics_prometheus_handler(
    State(state): axum::extract::State<HealthState>,
    Extension(auth): Extension<ObservabilityAuth>,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    if let Err(rej) = auth.authorize("/metrics/prometheus", &headers).await {
        tracing::warn!("observability endpoint /metrics/prometheus: auth REJECTED");
        return rej.into_response();
    }
    let body = state.metrics_prometheus();
    (
        axum::http::StatusCode::OK,
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        body,
    )
        .into_response()
}

#[cfg(feature = "health")]
async fn diagnostics_handler(
    State(state): axum::extract::State<HealthState>,
    Extension(auth): Extension<ObservabilityAuth>,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    if let Err(rej) = auth.authorize("/diagnostics", &headers).await {
        tracing::warn!("observability endpoint /diagnostics: auth REJECTED");
        return rej.into_response();
    }
    (axum::http::StatusCode::OK, axum::Json(state.diagnostics())).into_response()
}

/// Simple TCP health check (no HTTP, just connection test)
///
/// This is a fallback for when the `health` feature is not enabled.
/// It simply accepts and closes connections to indicate the service is alive.
#[cfg(not(feature = "health"))]
pub async fn start_health_server(
    addr: SocketAddr,
    _state: HealthState,
) -> tokio::task::JoinHandle<()> {
    info!("Starting simple TCP health check on {}", addr);

    tokio::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                error!("Failed to bind health server to {}: {}", addr, e);
                return;
            }
        };

        loop {
            match listener.accept().await {
                Ok((socket, peer)) => {
                    // Just close the connection immediately - connection success = healthy
                    drop(socket);
                    tracing::trace!("Health check from {}", peer);
                }
                Err(e) => {
                    error!("Health server accept error: {}", e);
                    // Brief pause before retrying
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_health_state_default() {
        let state = HealthState::new();

        assert!(!state.is_ready());
        let health = state.health();
        assert_eq!(health.status, "unhealthy");
    }

    #[test]
    fn test_health_state_transitions() {
        let state = HealthState::new();

        // Config loaded -> degraded
        state.set_config_loaded(true);
        let health = state.health();
        assert_eq!(health.status, "degraded");
        assert!(!state.is_ready());

        // Device activated -> healthy
        state.set_device_activated(true);
        let health = state.health();
        assert_eq!(health.status, "healthy");
        assert!(state.is_ready());
    }

    #[test]
    fn test_readiness_checks() {
        let state = HealthState::new();

        let readiness = state.readiness();
        assert!(!readiness.ready);
        assert!(!readiness.checks.config_loaded);
        assert!(!readiness.checks.mqtt_connected);
        assert!(!readiness.checks.device_activated);

        state.set_config_loaded(true);
        state.set_mqtt_connected(true);
        state.set_device_activated(true);

        let readiness = state.readiness();
        assert!(readiness.ready);
        assert!(readiness.checks.config_loaded);
        assert!(readiness.checks.mqtt_connected);
        assert!(readiness.checks.device_activated);
    }

    #[test]
    fn test_metrics_counters() {
        let state = HealthState::new();

        state.inc_mqtt_sent();
        state.inc_mqtt_sent();
        state.inc_mqtt_received();
        state.inc_modbus_reads();
        state.inc_modbus_reads();
        state.inc_modbus_reads();
        state.inc_script_executions();
        state.set_offline_queue_size(42);

        let metrics = state.metrics();
        assert_eq!(metrics.mqtt_messages_sent, 2);
        assert_eq!(metrics.mqtt_messages_received, 1);
        assert_eq!(metrics.modbus_reads, 3);
        assert_eq!(metrics.script_executions, 1);
        assert_eq!(metrics.offline_queue_size, 42);
    }

    #[test]
    fn test_uptime() {
        let state = HealthState::new();

        // Uptime should be 0 or very small
        assert!(state.uptime_secs() < 2);

        std::thread::sleep(std::time::Duration::from_millis(100));

        // Still very small
        assert!(state.uptime_secs() < 2);
    }

    #[test]
    fn prometheus_output_contains_expected_metric_families() {
        let state = HealthState::new();
        let out = state.metrics_prometheus();

        // Spot-check a representative set across counter +
        // gauge types. The contract is that every field in
        // HealthStateInner becomes a prometheus metric.
        let expected = [
            "suderra_uptime_seconds_total",
            "suderra_mqtt_messages_sent_total",
            "suderra_mqtt_messages_received_total",
            "suderra_mqtt_connected",
            "suderra_modbus_reads_total",
            "suderra_modbus_errors_total",
            "suderra_script_executions_total",
            "suderra_script_errors_total",
            "suderra_offline_queue_size",
            "suderra_offline_queue_capacity",
            "suderra_offline_queue_queued_total",
            "suderra_offline_queue_sent_total",
            "suderra_modbus_clients",
            "suderra_scripts_loaded",
            "suderra_scripts_active",
            "suderra_function_blocks",
            "suderra_device_activated",
            "suderra_config_loaded",
        ];
        for metric in expected {
            assert!(out.contains(metric), "missing metric: {}\n{}", metric, out);
            // Each metric MUST carry the agent label.
            assert!(
                out.contains(&format!(
                    "{}{{agent=\"suderra-edge\",device_id=\"\",tenant=\"\"}} ",
                    metric
                )),
                "metric {} missing expected labels (raw:\n{})",
                metric,
                out
            );
        }
    }

    #[test]
    fn prometheus_output_uses_correct_type_declarations() {
        let state = HealthState::new();
        let out = state.metrics_prometheus();
        // Counters MUST declare TYPE counter.
        assert!(out.contains("# TYPE suderra_mqtt_messages_sent_total counter"));
        assert!(out.contains("# TYPE suderra_uptime_seconds_total counter"));
        // Gauges MUST declare TYPE gauge.
        assert!(out.contains("# TYPE suderra_mqtt_connected gauge"));
        assert!(out.contains("# TYPE suderra_offline_queue_size gauge"));
    }

    #[test]
    fn prometheus_output_reflects_counter_increments() {
        let state = HealthState::new();
        state.inc_mqtt_sent();
        state.inc_mqtt_sent();
        state.inc_mqtt_received();
        let out = state.metrics_prometheus();
        assert!(
            out.contains(
                "suderra_mqtt_messages_sent_total{agent=\"suderra-edge\",device_id=\"\",tenant=\"\"} 2"
            ),
            "sent counter not incremented: {}",
            out
        );
        assert!(
            out.contains(
                "suderra_mqtt_messages_received_total{agent=\"suderra-edge\",device_id=\"\",tenant=\"\"} 1"
            ),
            "received counter not incremented: {}",
            out
        );
    }

    #[test]
    fn prometheus_output_reflects_gauge_state() {
        let state = HealthState::new();
        assert!(state.metrics_prometheus().contains(
            "suderra_mqtt_connected{agent=\"suderra-edge\",device_id=\"\",tenant=\"\"} 0"
        ));
        state.set_mqtt_connected(true);
        assert!(state.metrics_prometheus().contains(
            "suderra_mqtt_connected{agent=\"suderra-edge\",device_id=\"\",tenant=\"\"} 1"
        ));
    }

    #[test]
    fn prometheus_labels_reflect_device_id_and_tenant() {
        let state = HealthState::new();
        state.set_device_id("dev-alpha-123");
        state.set_tenant_id("fd23af6b-167f-4afd-a62a-ceace2a4046b");
        let out = state.metrics_prometheus();
        assert!(
            out.contains(
                "suderra_mqtt_connected{agent=\"suderra-edge\",device_id=\"dev-alpha-123\",tenant=\"fd23af6b-167f-4afd-a62a-ceace2a4046b\"}"
            ),
            "labels not injected: {}",
            out
        );
    }

    #[test]
    fn prometheus_label_sanitization_replaces_forbidden_chars() {
        let state = HealthState::new();
        // Malicious / misconfigured values with injection
        // attempts — MUST be neutralized to `_`.
        state.set_device_id("evil\"injected\nmulti\\line");
        let out = state.metrics_prometheus();
        // No raw double-quote or newline in the value.
        assert!(
            !out.contains("evil\"injected"),
            "raw double-quote leaked: {}",
            out
        );
        // Sanitized form present.
        assert!(
            out.contains("device_id=\"evil_injected_multi_line\""),
            "sanitized form missing: {}",
            out
        );
    }

    #[test]
    fn prometheus_output_ends_with_newline_for_each_metric() {
        let state = HealthState::new();
        let out = state.metrics_prometheus();
        // Final line MUST be newline-terminated per
        // Prometheus exposition format (each sample ends
        // with LF). Our last metric is suderra_config_loaded.
        assert!(
            out.ends_with('\n'),
            "prometheus output must end with newline (scrape protocol): last 40 chars={:?}",
            &out[out.len().saturating_sub(40)..]
        );
    }

    // ========================================================================
    // Batch 132 Sprint 6.5 — firmware lifecycle metrics tests
    // ========================================================================

    #[test]
    fn firmware_metrics_present_in_prometheus_output() {
        let state = HealthState::new();
        let out = state.metrics_prometheus();
        for name in [
            "suderra_firmware_apply_applied_total",
            "suderra_firmware_apply_rejected_total",
            "suderra_firmware_confirm_total",
            "suderra_firmware_rollback_total",
            "suderra_firmware_active_slot",
            "suderra_firmware_active_version",
        ] {
            assert!(
                out.contains(name),
                "firmware metric '{}' missing from scrape output",
                name
            );
        }
    }

    #[test]
    fn firmware_counters_initialize_at_zero() {
        let state = HealthState::new();
        let out = state.metrics_prometheus();
        // Match the exact " 0" suffix to rule out partial
        // string coincidence (e.g. a timestamp ending in 0).
        for name in [
            "suderra_firmware_apply_applied_total",
            "suderra_firmware_apply_rejected_total",
            "suderra_firmware_confirm_total",
            "suderra_firmware_rollback_total",
        ] {
            let line = out
                .lines()
                .find(|l| l.starts_with(name))
                .expect(&format!("missing metric line for {}", name));
            assert!(
                line.ends_with(" 0"),
                "{} should start at 0, got line: {}",
                name,
                line
            );
        }
    }

    #[test]
    fn firmware_apply_applied_increment_reflected_in_output() {
        let state = HealthState::new();
        state.inc_firmware_apply_applied();
        state.inc_firmware_apply_applied();
        state.inc_firmware_apply_applied();
        let out = state.metrics_prometheus();
        let line = out
            .lines()
            .find(|l| l.starts_with("suderra_firmware_apply_applied_total"))
            .expect("missing metric line");
        assert!(line.ends_with(" 3"), "expected 3 applies, got: {}", line);
    }

    #[test]
    fn firmware_rollback_increment_reflected_in_output() {
        let state = HealthState::new();
        state.inc_firmware_rollback();
        let out = state.metrics_prometheus();
        let line = out
            .lines()
            .find(|l| l.starts_with("suderra_firmware_rollback_total"))
            .expect("missing metric line");
        assert!(line.ends_with(" 1"), "expected 1 rollback, got: {}", line);
    }

    #[test]
    fn firmware_active_slot_gauge_reflects_value() {
        let state = HealthState::new();
        state.set_firmware_active_slot(1);
        let out = state.metrics_prometheus();
        let line = out
            .lines()
            .find(|l| l.starts_with("suderra_firmware_active_slot"))
            .expect("missing gauge line");
        assert!(line.ends_with(" 1"), "expected slot=1 (B), got: {}", line);
    }

    #[test]
    fn firmware_active_slot_gauge_clamps_invalid_values() {
        // Defense: if a caller accidentally writes 42,
        // the gauge clamps to 1 (max-valid) rather than
        // expose nonsense to dashboards.
        let state = HealthState::new();
        state.set_firmware_active_slot(42);
        let out = state.metrics_prometheus();
        let line = out
            .lines()
            .find(|l| l.starts_with("suderra_firmware_active_slot"))
            .expect("missing gauge line");
        assert!(line.ends_with(" 1"), "expected clamped=1, got: {}", line);
    }

    #[test]
    fn firmware_active_version_gauge_reflects_value() {
        let state = HealthState::new();
        state.set_firmware_active_version(42);
        let out = state.metrics_prometheus();
        let line = out
            .lines()
            .find(|l| l.starts_with("suderra_firmware_active_version"))
            .expect("missing gauge line");
        assert!(line.ends_with(" 42"), "expected version=42, got: {}", line);
    }

    // ========================================================================
    // Batch 135 Sprint 6.5 — lifecycle auth rejection metric tests
    // ========================================================================

    #[test]
    fn lifecycle_auth_rejection_metrics_present_in_output() {
        let state = HealthState::new();
        let out = state.metrics_prometheus();
        assert!(out.contains("suderra_lifecycle_auth_rejected_total"));
        assert!(out.contains("suderra_lifecycle_auth_invalid_hmac_total"));
    }

    #[test]
    fn lifecycle_auth_non_invalid_hmac_bumps_only_total() {
        let state = HealthState::new();
        // Simulate a MissingHmacHeader reject (not invalid_hmac).
        state.inc_lifecycle_auth_rejected(false);
        let out = state.metrics_prometheus();
        let total = out
            .lines()
            .find(|l| l.starts_with("suderra_lifecycle_auth_rejected_total"))
            .expect("total missing");
        let invalid = out
            .lines()
            .find(|l| l.starts_with("suderra_lifecycle_auth_invalid_hmac_total"))
            .expect("invalid missing");
        assert!(total.ends_with(" 1"), "total should be 1, got: {}", total);
        assert!(
            invalid.ends_with(" 0"),
            "invalid_hmac should stay 0 for non-invalid-hmac rejection, got: {}",
            invalid
        );
    }

    #[test]
    fn lifecycle_auth_invalid_hmac_bumps_both_counters() {
        let state = HealthState::new();
        state.inc_lifecycle_auth_rejected(true);
        let out = state.metrics_prometheus();
        let total = out
            .lines()
            .find(|l| l.starts_with("suderra_lifecycle_auth_rejected_total"))
            .expect("total missing");
        let invalid = out
            .lines()
            .find(|l| l.starts_with("suderra_lifecycle_auth_invalid_hmac_total"))
            .expect("invalid missing");
        assert!(total.ends_with(" 1"), "total should be 1, got: {}", total);
        assert!(
            invalid.ends_with(" 1"),
            "invalid_hmac should be 1 for invalid-hmac rejection, got: {}",
            invalid
        );
    }

    #[test]
    fn lifecycle_auth_multiple_rejections_accumulate_independently() {
        let state = HealthState::new();
        // 3 non-invalid (missing headers / timestamp skew / etc)
        state.inc_lifecycle_auth_rejected(false);
        state.inc_lifecycle_auth_rejected(false);
        state.inc_lifecycle_auth_rejected(false);
        // 2 invalid_hmac (operator-security signal)
        state.inc_lifecycle_auth_rejected(true);
        state.inc_lifecycle_auth_rejected(true);

        let out = state.metrics_prometheus();
        let total = out
            .lines()
            .find(|l| l.starts_with("suderra_lifecycle_auth_rejected_total"))
            .expect("total");
        let invalid = out
            .lines()
            .find(|l| l.starts_with("suderra_lifecycle_auth_invalid_hmac_total"))
            .expect("invalid");
        assert!(total.ends_with(" 5"), "total = 5, got: {}", total);
        assert!(invalid.ends_with(" 2"), "invalid = 2, got: {}", invalid);
    }

    // EDGE-HIGH-020: fail-closed posture of the sensitive-endpoint gate.
    // When no HMAC key is available (lifecycle cell absent or auth disabled),
    // a loopback bind stays open (localhost trust boundary) but a non-loopback
    // bind refuses anonymous access — internal diagnostics cannot be exposed
    // to the network without a configured key.

    #[cfg(feature = "health")]
    #[tokio::test]
    async fn observability_gate_allows_loopback_without_key() {
        let auth = ObservabilityAuth {
            lifecycle_cell: None,
            bind_is_loopback: true,
        };
        let headers = axum::http::HeaderMap::new();
        assert!(
            auth.authorize("/metrics", &headers).await.is_ok(),
            "loopback bind without a key must stay open for local scrapers"
        );
    }

    #[cfg(feature = "health")]
    #[tokio::test]
    async fn observability_gate_refuses_external_bind_without_key() {
        let auth = ObservabilityAuth {
            lifecycle_cell: None,
            bind_is_loopback: false,
        };
        let headers = axum::http::HeaderMap::new();
        let rejection = auth.authorize("/diagnostics", &headers).await;
        assert!(
            matches!(
                rejection,
                Err(ObservabilityAuthRejection::ExternalBindNoKey)
            ),
            "non-loopback bind without a key must fail closed"
        );
    }
}
