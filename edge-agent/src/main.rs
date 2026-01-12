//! Suderra Edge Agent
//!
//! Industrial IoT agent for aquaculture monitoring and control.
//! Handles device provisioning, MQTT communication, telemetry,
//! and PLC/sensor integration.
//!
//! Architecture v2.0:
//! - Actor pattern for GPIO and Modbus (thread-safe handles)
//! - Circuit breaker for fault tolerance
//! - Graceful shutdown coordinator
//! - Granular state management

mod config;
mod error;
mod provisioning;
mod mqtt;
mod telemetry;
mod commands;
mod modbus;
mod gpio;
mod scripting;
mod resilience;
mod shutdown;

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tracing::{info, error, warn, debug};
use anyhow::Result;

use crate::config::AgentConfig;
use crate::provisioning::ProvisioningClient;
use crate::mqtt::MqttClient;
use crate::telemetry::TelemetryCollector;
use crate::commands::CommandHandler;
use crate::modbus::ModbusHandle;
use crate::gpio::{GpioHandle, GpioManager};
use crate::scripting::ScriptEngine;
use crate::shutdown::ShutdownCoordinator;

/// Activation state - minimal mutable state
pub struct ActivationState {
    pub is_activated: bool,
    pub tenant_id: Option<String>,
    pub device_id: String,
}

/// Application state shared across components (v2.0 - Granular)
///
/// Architecture:
/// - Config is immutable after init (Arc)
/// - Hardware handles use actor pattern (thread-safe)
/// - Only activation state needs RwLock
pub struct AppState {
    /// Configuration (immutable after init)
    pub config: AgentConfig,

    /// MQTT client
    pub mqtt_client: Option<MqttClient>,

    /// Modbus handle (actor pattern - thread-safe)
    pub modbus_handle: Option<ModbusHandle>,

    /// GPIO handle (actor pattern - thread-safe, v2.0)
    pub gpio_handle: Option<GpioHandle>,

    /// Legacy GPIO manager (deprecated, for backwards compatibility)
    #[deprecated(note = "Use gpio_handle instead")]
    pub gpio_manager: Option<GpioManager>,

    /// Activation state
    pub is_activated: bool,
    pub tenant_id: Option<String>,
}

#[allow(deprecated)]
impl AppState {
    /// Create new AppState (v2.0)
    ///
    /// Note: Hardware handles will be initialized in LocalSet context
    pub fn new(config: AgentConfig) -> Self {
        Self {
            config,
            mqtt_client: None,
            modbus_handle: None,
            gpio_handle: None,
            gpio_manager: None, // Deprecated
            is_activated: false,
            tenant_id: None,
        }
    }

    /// Initialize hardware handles (must be called within LocalSet context)
    pub fn init_hardware_handles(&mut self) {
        // Initialize Modbus actor
        if !self.config.modbus.is_empty() {
            self.modbus_handle = Some(ModbusHandle::new(self.config.modbus.clone()));
            info!("Modbus actor initialized with {} devices", self.config.modbus.len());
        }

        // Initialize GPIO actor (v2.0 - actor pattern)
        if !self.config.gpio.is_empty() {
            self.gpio_handle = Some(GpioHandle::new(self.config.gpio.clone()));
            info!("GPIO actor initialized with {} pins", self.config.gpio.len());
        }
    }

    /// Legacy: Initialize Modbus handle only
    #[deprecated(note = "Use init_hardware_handles instead")]
    pub fn init_modbus(&mut self) {
        if !self.config.modbus.is_empty() {
            self.modbus_handle = Some(ModbusHandle::new(self.config.modbus.clone()));
            info!("Modbus actor initialized with {} devices", self.config.modbus.len());
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    init_logging();

    info!("======================================");
    info!("  Suderra Edge Agent v{}", env!("CARGO_PKG_VERSION"));
    info!("======================================");

    // Load configuration
    let config = match AgentConfig::load() {
        Ok(cfg) => {
            info!("Configuration loaded successfully");
            info!("  Device ID: {}", cfg.device_id);
            info!("  Device Code: {}", cfg.device_code);
            info!("  API URL: {}", cfg.api_url);
            cfg
        }
        Err(e) => {
            error!("Failed to load configuration: {}", e);
            error!("Please ensure /etc/suderra/config.yaml exists and is valid");
            std::process::exit(1);
        }
    };

    // Create shared state
    let state = Arc::new(RwLock::new(AppState::new(config.clone())));

    // Setup graceful shutdown
    let shutdown = setup_shutdown_handler();

    // Use LocalSet to allow non-Send futures (required for Modbus client)
    let local = tokio::task::LocalSet::new();
    let result = local.run_until(run_agent(state, shutdown)).await;

    if let Err(e) = result {
        error!("Agent error: {}", e);
        std::process::exit(1);
    }

    info!("Agent shutdown complete");
    Ok(())
}

/// Initialize logging with tracing
fn init_logging() {
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(fmt::layer().with_target(true))
        .with(filter)
        .init();
}

/// Setup Ctrl+C handler for graceful shutdown
fn setup_shutdown_handler() -> tokio::sync::watch::Receiver<bool> {
    let (tx, rx) = tokio::sync::watch::channel(false);

    ctrlc::set_handler(move || {
        info!("Shutdown signal received");
        let _ = tx.send(true);
    })
    .expect("Error setting Ctrl-C handler");

    rx
}

/// Main agent loop
async fn run_agent(
    state: Arc<RwLock<AppState>>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    // Step 1: Check if already activated (MQTT credentials in config)
    let needs_activation = {
        let state_guard = state.read().await;
        state_guard.config.mqtt.username.is_none()
    };

    if needs_activation {
        info!("Device not activated, starting provisioning...");

        // Step 2: Activate with cloud platform
        let provisioning_client = ProvisioningClient::new(state.clone());

        match provisioning_client.activate().await {
            Ok(response) => {
                info!("Device activated successfully!");
                info!("  MQTT Broker: {}", response.mqtt_broker);
                info!("  Tenant ID: {}", response.tenant_id);

                // Update state with activation response
                let mut state_guard = state.write().await;
                state_guard.config.mqtt.broker = Some(response.mqtt_broker);
                state_guard.config.mqtt.port = response.mqtt_port;
                state_guard.config.mqtt.username = Some(response.mqtt_username);
                state_guard.config.mqtt.password = Some(response.mqtt_password);
                state_guard.tenant_id = Some(response.tenant_id.clone());
                state_guard.is_activated = true;

                // Save updated config to disk
                if let Err(e) = state_guard.config.save() {
                    warn!("Failed to save config after activation: {}", e);
                }
            }
            Err(e) => {
                error!("Activation failed: {}", e);
                error!("Will retry on next restart");
                return Err(e.into());
            }
        }
    } else {
        info!("Device already activated, using stored credentials");
        let mut state_guard = state.write().await;
        state_guard.is_activated = true;
    }

    // Step 3: Connect to MQTT
    info!("Connecting to MQTT broker...");
    let mqtt_client = {
        let state_guard = state.read().await;
        MqttClient::new(&state_guard.config).await?
    };

    {
        let mut state_guard = state.write().await;
        state_guard.mqtt_client = Some(mqtt_client);
    }
    info!("MQTT connected successfully");

    // Step 4: Initialize hardware interfaces
    info!("Initializing hardware interfaces...");
    init_hardware(&state).await;

    // Step 5: Start telemetry collector
    let telemetry_collector = TelemetryCollector::new(state.clone());
    let telemetry_handle = tokio::spawn(async move {
        telemetry_collector.run().await
    });

    // Step 6: Start command handler
    let command_handler = CommandHandler::new(state.clone());
    let command_handle = tokio::spawn(async move {
        command_handler.run().await
    });

    // Step 7: Start script engine
    info!("Starting script engine...");
    let mut script_engine = ScriptEngine::new(state.clone());
    if let Err(e) = script_engine.init().await {
        warn!("Script engine initialization failed: {}", e);
    } else {
        info!("Script engine initialized with {} scripts", script_engine.script_count());
    }

    let script_handle = tokio::spawn(async move {
        script_engine.run().await
    });

    // Step 8: Main loop - wait for shutdown
    info!("Agent running. Press Ctrl+C to stop.");

    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    info!("Initiating graceful shutdown...");
                    break;
                }
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_secs(1)) => {
                // Periodic health check could go here
            }
        }
    }

    // Cleanup - abort spawned tasks
    telemetry_handle.abort();
    command_handle.abort();
    script_handle.abort();

    // Disconnect hardware interfaces
    // Disconnect Modbus devices via handle
    let modbus_handle = {
        let state_guard = state.read().await;
        state_guard.modbus_handle.clone()
    };

    if let Some(handle) = modbus_handle {
        handle.disconnect_all().await;
        info!("Modbus devices disconnected");
    }

    // Disconnect MQTT gracefully
    {
        let mut state_guard = state.write().await;
        if let Some(mqtt) = state_guard.mqtt_client.take() {
            if let Err(e) = mqtt.disconnect().await {
                warn!("Error disconnecting MQTT: {}", e);
            }
        }
    }

    Ok(())
}

/// Initialize hardware interfaces (Modbus, GPIO) v2.0
///
/// Uses actor pattern for both Modbus and GPIO
async fn init_hardware(state: &Arc<RwLock<AppState>>) {
    // Initialize hardware actors (must be done in LocalSet context)
    {
        let mut state_guard = state.write().await;
        state_guard.init_hardware_handles();
    }

    // Initialize GPIO via actor handle
    let gpio_handle = {
        let state_guard = state.read().await;
        state_guard.gpio_handle.clone()
    };

    if let Some(handle) = gpio_handle {
        let pin_count = handle.pin_count().await;
        info!("Initializing GPIO with {} pins configured", pin_count);

        match handle.init().await {
            Ok(()) => {
                info!("GPIO initialized successfully");
                if handle.is_available().await {
                    info!("  GPIO hardware is available");
                } else {
                    info!("  GPIO running in simulation mode");
                }
            }
            Err(e) => {
                warn!("GPIO initialization failed: {}", e);
            }
        }
    } else {
        debug!("No GPIO pins configured");
    }

    // Connect to Modbus devices via handle
    let modbus_handle = {
        let state_guard = state.read().await;
        state_guard.modbus_handle.clone()
    };

    if let Some(handle) = modbus_handle {
        info!("Connecting to Modbus devices...");
        let errors = handle.connect_all().await;

        if errors.is_empty() {
            info!("All Modbus devices connected successfully");
        } else {
            for err in &errors {
                warn!("Modbus connection error: {}", err);
            }
        }

        // Log connected device info
        let results = handle.read_all().await;
        for result in results {
            if result.errors.is_empty() {
                info!("  {} - {} registers available", result.device_name, result.values.len());
                for value in &result.values {
                    debug!("    {}: {:.2} {}",
                        value.name,
                        value.scaled_value,
                        value.unit.as_deref().unwrap_or("")
                    );
                }
            } else {
                warn!("  {} - errors: {:?}", result.device_name, result.errors);
            }
        }
    } else {
        debug!("No Modbus devices configured");
    }

    // Log hardware summary
    let state_guard = state.read().await;
    let gpio_count = state_guard.config.gpio.len();
    let modbus_count = state_guard.config.modbus.len();

    info!("Hardware summary: {} GPIO pins, {} Modbus devices", gpio_count, modbus_count);
}
