//! I/O polling loop — reads all tags, updates process image, publishes io_data
//!
//! Runs as a spawned tokio task. Polls GPIO, Modbus, and I2C at configurable intervals.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::{self, MissedTickBehavior};
use tracing::{debug, error, info, warn};

use crate::AppState;
use crate::atlas_ezo::AtlasEzoDriver;
use crate::gpio::PinState;
use crate::process_image::{I2cDriverType, IoType, ProtocolConfig, TagQuality, TagSource};

/// Payload published to MQTT io_data topic
#[derive(Debug, Serialize)]
pub struct IoDataPayload {
    pub timestamp: String,
    pub tags: HashMap<String, IoTagData>,
}

/// Single tag data in io_data payload.
///
/// Batch 21 ARC-006: `simulated` field attached when tag quality
/// is `TagQuality::Simulated`. Platform UI badges the tag as
/// non-authoritative so operators cannot confuse sim data with
/// live sensor reads. Field is `#[serde(skip)]` when false —
/// real-hardware reads don't carry an unused field in every
/// payload.
#[derive(Debug, Serialize)]
pub struct IoTagData {
    pub value: serde_json::Value,
    pub quality: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub simulated: bool,
}

/// Main I/O polling loop
pub async fn io_poll_loop(state: Arc<RwLock<AppState>>) {
    // Batch 147 Faz 7: license IO channel budget gate.
    // Plan R-10 + Faz 7 discipline: if configured
    // channels exceed license.max_io_channels, the task
    // does NOT start + CRITICAL log fires. Agent
    // degrades observably (zero telemetry from this
    // path) so operator sees the license-contract
    // violation immediately on device bring-up.
    //
    // No fail-closed process exit: the CRITICAL log is
    // the operator signal; the AGENT stays alive so
    // refresh_license + signature_mode + other
    // non-IO-polling paths remain operable while the
    // operator resolves the budget.
    let interval_ms = {
        let s = state.read().await;
        let budget = crate::license::check_io_channel_budget(&s.config, &s.license);
        match budget {
            crate::license::IoChannelBudget::Exceeded { configured, cap } => {
                error!(
                    "CRITICAL LICENSE BUDGET EXCEEDED: configured {} IO channels > license cap {} (tier={}). I/O polling task REFUSES TO START. Operator must either (a) reduce modbus/gpio/i2c channel count in config.yaml to <= {} OR (b) refresh_license to a higher tier. Agent remains operable for license refresh + other paths.",
                    configured,
                    cap,
                    s.license.tier.as_str(),
                    cap
                );
                return;
            }
            crate::license::IoChannelBudget::WithinBudget { configured, cap } => {
                info!(
                    "License IO budget: {} configured / {} cap (tier={})",
                    configured,
                    cap,
                    s.license.tier.as_str()
                );
            }
        }
        s.config.telemetry.io_data_interval_ms
    };

    info!("Starting I/O poll loop (interval: {}ms)", interval_ms);

    let mut interval = time::interval(time::Duration::from_millis(interval_ms));
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        interval.tick().await;

        if let Err(e) = poll_cycle(&state).await {
            warn!("I/O poll cycle error: {}", e);
        }
    }
}

async fn poll_cycle(state: &Arc<RwLock<AppState>>) -> anyhow::Result<()> {
    // 2026-04-29 enterprise polling concurrency hardening:
    // snapshot cloneable handles/config under the AppState lock, then drop the
    // guard before any fieldbus await.
    //
    // What it solves: slow Modbus/GPIO/I2C calls no longer hold the global
    // AppState read lock and block config reload, shutdown mutation, or other
    // state writers.
    let (
        is_ready,
        process_image,
        force_registry,
        gpio_handle,
        modbus_handle,
        i2c_handle,
        alarm_manager,
        health_state,
    ) = {
        let s = state.read().await;
        (
            s.is_activated && s.mqtt_client.is_some(),
            s.process_image.clone(),
            s.force_registry.clone(),
            s.gpio_handle.clone(),
            s.modbus_handle.clone(),
            s.i2c_handle.clone(),
            s.alarm_manager.clone(),
            s.health_state.clone(),
        )
    };
    #[cfg(feature = "scada-display")]
    let scada_state = {
        let s = state.read().await;
        s.scada_state.clone()
    };

    // Skip if not activated or no MQTT
    if !is_ready {
        return Ok(());
    }

    // Batch 199 Faz 6 wire: force-registry bypass.
    // Every update_tag call in this poll cycle passes
    // through `maybe_update_tag` which checks
    // `force_registry.is_forced` first + skips the
    // refresh when the tag is forced. The forced
    // value stays live (ProcessImage was set to the
    // force value when the `force_value` command
    // fired per Batch 197).
    let configs = process_image.get_configs().await;

    if configs.is_empty() {
        return Ok(());
    }

    // --- GPIO reads ---
    if let Some(ref gpio) = gpio_handle {
        let result = gpio.read_all().await;
        for pin_value in &result.values {
            // Find matching tag config for this GPIO pin
            for cfg in &configs {
                if let ProtocolConfig::Gpio { pin, .. } = &cfg.protocol_config {
                    if *pin == pin_value.pin {
                        let value = if matches!(pin_value.state, PinState::High) {
                            1.0
                        } else {
                            0.0
                        };
                        maybe_update_tag(
                            &process_image,
                            &force_registry,
                            &cfg.tag_name,
                            value,
                            TagQuality::Good,
                            TagSource::Gpio,
                        )
                        .await;
                    }
                }
            }
        }
    }

    // --- Modbus reads (parallel per device) ---
    if let Some(ref modbus) = modbus_handle {
        let results = modbus.read_all_parallel().await;
        // Batch 103 observability: count successful + failed
        // device reads for fleet dashboards. Each
        // ModbusReadResult represents ONE DEVICE round-trip;
        // values[] is the register-level output (which could
        // itself be partial). The device-level success/error
        // gauge is the actionable operator signal ("device N
        // is flaky"); register-level counting would explode
        // the cardinality.
        for device_result in &results {
            if let Some(hs) = health_state.as_ref() {
                // ModbusReadResult shape: success = no errors
                // in the errors vector. Partial reads (some
                // registers OK, some failed) count as error
                // for the DEVICE-level signal. Register-level
                // partial counting lands in a follow-up batch
                // if fleet dashboards need it.
                if device_result.errors.is_empty() {
                    hs.inc_modbus_reads();
                } else {
                    hs.inc_modbus_errors();
                }
            }
            for reg_value in &device_result.values {
                // Match register to tag config by tag name
                for cfg in &configs {
                    if let ProtocolConfig::Modbus { .. } = &cfg.protocol_config {
                        if reg_value.name == cfg.tag_name {
                            maybe_update_tag(
                                &process_image,
                                &force_registry,
                                &cfg.tag_name,
                                reg_value.scaled_value,
                                TagQuality::Good,
                                TagSource::Modbus,
                            )
                            .await;
                        }
                    }
                }
            }
        }
    }

    // --- I2C reads (SEQUENTIAL - shared bus!) ---
    if let Some(ref i2c) = i2c_handle {
        let ezo_driver = AtlasEzoDriver::new(i2c.clone());

        for cfg in &configs {
            if let ProtocolConfig::I2c { driver_type, .. } = &cfg.protocol_config {
                match driver_type {
                    I2cDriverType::AtlasEzo { sensor_type } => {
                        let (value, quality) = ezo_driver
                            .read_measurement(&cfg.tag_name, sensor_type)
                            .await;
                        // Batch 104 observability: TagQuality
                        // already encodes Atlas EZO
                        // success/error semantically. Map to
                        // the modbus counter family:
                        // - Good / Simulated → success (real
                        //   sensor data or declared sim).
                        // - Bad / Uncertain / CommFailure /
                        //   ConfigError → error.
                        // No driver-signature refactor needed
                        // (the gap flagged in Batch 103
                        // observations is closed at the
                        // interpretation site, not the
                        // source).
                        if let Some(hs) = health_state.as_ref() {
                            match quality {
                                TagQuality::Good | TagQuality::Simulated => {
                                    hs.inc_modbus_reads();
                                }
                                _ => {
                                    hs.inc_modbus_errors();
                                }
                            }
                        }
                        maybe_update_tag_raw(
                            &process_image,
                            &force_registry,
                            &cfg.tag_name,
                            value,
                            quality,
                            TagSource::I2c,
                        )
                        .await;
                    }
                    I2cDriverType::GenericRegister {
                        read_register,
                        read_length,
                    } => {
                        let result = i2c
                            .read_register(&cfg.tag_name, *read_register, *read_length as usize)
                            .await;
                        // Batch 103 observability: I2C reads
                        // map to the same modbus_reads/errors
                        // counter family since they're both
                        // field-bus ingress (operators care
                        // about "are my sensors talking?",
                        // not "how many via modbus vs i2c").
                        // Future batch could split into
                        // i2c_reads_total for dashboards that
                        // need per-protocol slicing.
                        if let Some(hs) = health_state.as_ref() {
                            if result.success {
                                hs.inc_modbus_reads();
                            } else {
                                hs.inc_modbus_errors();
                            }
                        }
                        if result.success {
                            let value = bytes_to_f64(&result.data);
                            // ARC-006: sim reads surface as
                            // TagQuality::Simulated so SCADA
                            // cannot mistake sim for live data.
                            let quality = if result.simulated {
                                TagQuality::Simulated
                            } else {
                                TagQuality::Good
                            };
                            maybe_update_tag(
                                &process_image,
                                &force_registry,
                                &cfg.tag_name,
                                value,
                                quality,
                                TagSource::I2c,
                            )
                            .await;
                        } else {
                            warn!(
                                "I2C register read failed for '{}': {}",
                                cfg.tag_name,
                                result.error.as_deref().unwrap_or("unknown")
                            );
                            maybe_update_tag(
                                &process_image,
                                &force_registry,
                                &cfg.tag_name,
                                0.0,
                                TagQuality::CommFailure,
                                TagSource::I2c,
                            )
                            .await;
                        }
                    }
                    I2cDriverType::GenericDirect { read_length } => {
                        let result = i2c.read_direct(&cfg.tag_name, *read_length as usize).await;
                        if let Some(hs) = health_state.as_ref() {
                            if result.success {
                                hs.inc_modbus_reads();
                            } else {
                                hs.inc_modbus_errors();
                            }
                        }
                        if result.success {
                            let value = bytes_to_f64(&result.data);
                            // ARC-006: sim read quality routing.
                            let quality = if result.simulated {
                                TagQuality::Simulated
                            } else {
                                TagQuality::Good
                            };
                            maybe_update_tag(
                                &process_image,
                                &force_registry,
                                &cfg.tag_name,
                                value,
                                quality,
                                TagSource::I2c,
                            )
                            .await;
                        } else {
                            warn!(
                                "I2C direct read failed for '{}': {}",
                                cfg.tag_name,
                                result.error.as_deref().unwrap_or("unknown")
                            );
                            maybe_update_tag(
                                &process_image,
                                &force_registry,
                                &cfg.tag_name,
                                0.0,
                                TagQuality::CommFailure,
                                TagSource::I2c,
                            )
                            .await;
                        }
                    }
                }
            }
        }
    }

    // --- Snapshot all tags once (reused for alarms, io_data, and SCADA) ---
    let all_tags = process_image.get_all_tags().await;

    // --- Alarm evaluation ---
    {
        let mut alarm_events = Vec::new();

        {
            let mut mgr = alarm_manager.write().await;
            for (tag_name, tag_value) in &all_tags {
                // ARC-006: skip simulated-quality tags. Sim
                // reads produce a stable placeholder (0.0); a
                // configured low-limit alarm at e.g. 5.0 would
                // otherwise fire spuriously on every sim poll
                // cycle, burying the real-alarm signal in
                // default-build deployments.
                if tag_value.quality.is_simulated() {
                    continue;
                }
                let events = mgr.process_source(tag_name, tag_value.value);
                alarm_events.extend(events);
            }
        }

        // Publish alarm events if any.
        //
        // Batch #255 ARC-002: routes via `publish_helpers::
        // publish_alarms` which encapsulates the Outbound-vs-
        // direct decision. Alarms publish at
        // MessagePriority::Critical so the drain task replays
        // alarms BEFORE telemetry/status/etc. on reconnect —
        // life-safety hot path (FDA 21 CFR 117.135, EU
        // Machinery Directive alignment).
        if !alarm_events.is_empty() {
            let payload = serde_json::json!({
                "timestamp": chrono::Utc::now().to_rfc3339(),
                "alarms": alarm_events.iter().map(|e| serde_json::to_value(e).unwrap_or_default()).collect::<Vec<_>>(),
            });
            let s = state.read().await;
            crate::publish_helpers::publish_alarms_checked(&s, &payload).await?;
        }
    }

    // --- Build and publish io_data ---
    let mut io_tags = HashMap::new();

    for (name, tag) in &all_tags {
        let cfg = configs.iter().find(|c| c.tag_name == *name);
        let value = match cfg.map(|c| &c.io_type) {
            Some(IoType::DI) | Some(IoType::DO) => serde_json::Value::Bool(tag.value != 0.0),
            _ => serde_json::json!(tag.value),
        };

        io_tags.insert(
            name.clone(),
            IoTagData {
                value,
                quality: format!("{:?}", tag.quality).to_lowercase(),
                // ARC-006: attach marker when the underlying read
                // came from the simulation branch.
                simulated: tag.quality.is_simulated(),
            },
        );
    }

    if !io_tags.is_empty() {
        let payload = IoDataPayload {
            timestamp: chrono::Utc::now().to_rfc3339(),
            tags: io_tags,
        };
        // Batch #255 migration to OutboundPublisher routing.
        let s = state.read().await;
        crate::publish_helpers::publish_io_data_checked(&s, &payload).await?;
        debug!("Published io_data ({} tags)", all_tags.len());
    }

    // --- SCADA display broadcast (reuses all_tags snapshot) ---
    #[cfg(feature = "scada-display")]
    {
        if let Some(ref scada_state) = scada_state {
            // Existing: broadcast process-mapped sensor data
            if let Some(process) = scada_state.get_process().await {
                let sensor_data =
                    crate::scada_server::build_scada_sensor_data_from_tags(&all_tags, &process);
                if !sensor_data.equipment_data.is_empty() {
                    scada_state.broadcast_sensor_data(&sensor_data);
                }
            }

            // NEW: Broadcast all tags for dashboard view (even without process)
            scada_state.broadcast_all_tags(&all_tags).await;

            // NEW: Evaluate alarm rules against current tag values
            scada_state.evaluate_alarms(&all_tags).await;

            // NEW: Record trend data to SQLite
            scada_state.record_trends(&all_tags).await;
        }
    }

    Ok(())
}

/// Convert raw bytes to f64 (big-endian, supports 2 or 4 byte values)
/// Batch 199 Faz 6: force-registry-aware update_tag
/// shim. Skips the refresh when the tag has an active
/// force entry so the forced value stays live.
///
/// Consolidated here (instead of inlined at every
/// update_tag callsite) so future refinements
/// (metrics, audit emit on skip) land in one place.
async fn maybe_update_tag(
    pi: &crate::process_image::ProcessImage,
    force_registry: &crate::scripting::force_registry::ForceRegistry,
    tag_name: &str,
    value: f64,
    quality: crate::process_image::TagQuality,
    source: crate::process_image::TagSource,
) {
    if force_registry.is_forced(tag_name).await {
        // Skip — the forced value was written to PI
        // when the `force_value` command fired
        // (Batch 197) + TTL sweep (Batch 198)
        // drops it when expired. Polling refresh
        // would clobber the operator-applied
        // value.
        return;
    }
    pi.update_tag(tag_name, value, quality, source).await;
}

/// Batch 199 Faz 6: the same for the raw variant
/// used by I2C / Atlas EZO paths that write already-
/// scaled values.
async fn maybe_update_tag_raw(
    pi: &crate::process_image::ProcessImage,
    force_registry: &crate::scripting::force_registry::ForceRegistry,
    tag_name: &str,
    value: f64,
    quality: crate::process_image::TagQuality,
    source: crate::process_image::TagSource,
) {
    if force_registry.is_forced(tag_name).await {
        return;
    }
    pi.update_tag_raw(tag_name, value, quality, source).await;
}

fn bytes_to_f64(data: &[u8]) -> f64 {
    match data.len() {
        2 => {
            let value = u16::from_be_bytes([data[0], data[1]]);
            value as f64
        }
        4 => {
            let value = f32::from_be_bytes([data[0], data[1], data[2], data[3]]);
            value as f64
        }
        8 => f64::from_be_bytes([
            data[0], data[1], data[2], data[3], data[4], data[5], data[6], data[7],
        ]),
        _ => {
            warn!("Unexpected I2C data length: {}", data.len());
            0.0
        }
    }
}
