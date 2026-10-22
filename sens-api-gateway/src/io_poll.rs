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
///
/// ADR-048 DEC-6.2 / DEC-6.4: this is the agent's local control-loop input
/// side. It runs from boot whether or not the cloud is reachable (the MQTT
/// publishes inside a cycle are no-ops until a client exists), and it ticks
/// `heartbeat` at every idle point — the systemd watchdog is pinged only
/// while it does, so a cycle stuck in an I/O call stops the pings.
///
/// `polling_allowed` is false when the license I/O budget is exceeded
/// (Batch 147 Faz 7). The boot sequence has then already put the agent in
/// degraded mode; the loop stays alive for liveness but reads nothing.
pub async fn io_poll_loop(
    state: Arc<RwLock<AppState>>,
    heartbeat: crate::liveness::Heartbeat,
    polling_allowed: bool,
) {
    let interval_ms = {
        let s = state.read().await;
        s.config.telemetry.io_data_interval_ms
    };

    if polling_allowed {
        info!("Starting I/O poll loop (interval: {}ms)", interval_ms);
    } else {
        error!(
            "CRITICAL LICENSE BUDGET EXCEEDED: I/O polling disabled (degraded mode). Operator \
             must either reduce the modbus/gpio/i2c channel count or refresh_license to a \
             higher tier."
        );
    }

    let mut interval = time::interval(time::Duration::from_millis(interval_ms));
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // The RevPi process-image backend, when the configuration grants one.
    let picontrol = state.read().await.picontrol_handle.clone();

    loop {
        // One pass of the loop: wait for the next cycle, run it, tick.
        let pass = async {
            crate::liveness::tick_while_waiting(&heartbeat, interval.tick()).await;

            if polling_allowed {
                if let Err(e) = poll_cycle(&state, &heartbeat).await {
                    warn!("I/O poll cycle error: {}", e);
                }
            }
            // The cycle completed: nothing is in flight.
            heartbeat.tick();
        };
        match &picontrol {
            // ADR-048 DEC-6.7: the piControl output watchdog is fed for as long
            // as the pass is alive, also in degraded mode (the safe values stay
            // driven, not zeroed), and not only when a cycle completes: a cycle
            // awaits its field buses, and a Modbus device that does not answer
            // would otherwise get the outputs of a healthy agent zeroed every
            // period. A loop that is not polled, or whose call has not returned
            // within the longest bound a call has, is not fed, and the driver
            // zeroes the PiBridge outputs within the watchdog period.
            Some(picontrol) => {
                crate::picontrol::feed::while_feeding(
                    pass,
                    picontrol.feed_every(),
                    OUTPUT_FEED_CALL_BOUND,
                    || heartbeat.stalled_for(),
                    || picontrol.feed(),
                )
                .await
            }
            None => pass.await,
        }
    }
}

/// The longest a single blocking call of the I/O loop may take, which is the
/// Modbus phase of the cycle (every other call is shorter), and a margin. The
/// piControl output watchdog is fed while a call is within it: a bounded call
/// is not a stalled loop. Past it the call is not bounded after all and the
/// feed stops.
const OUTPUT_FEED_CALL_BOUND: std::time::Duration =
    crate::modbus::READ_ALL_BOUND.saturating_add(std::time::Duration::from_secs(2));

/// One I/O cycle. `heartbeat.progress()` follows every blocking read, so
/// the watchdog's freshness window bounds one read, not the whole cycle
/// (ADR-048 DEC-6.4 tick budget).
async fn poll_cycle(
    state: &Arc<RwLock<AppState>>,
    heartbeat: &crate::liveness::Heartbeat,
) -> anyhow::Result<()> {
    // 2026-04-29 enterprise polling concurrency hardening:
    // snapshot cloneable handles/config under the AppState lock, then drop the
    // guard before any fieldbus await.
    //
    // What it solves: slow Modbus/GPIO/I2C calls no longer hold the global
    // AppState read lock and block config reload, shutdown mutation, or other
    // state writers.
    let (
        process_image,
        force_registry,
        gpio_handle,
        modbus_handle,
        i2c_handle,
        alarm_manager,
        health_state,
        picontrol_handle,
    ) = {
        let s = state.read().await;
        (
            s.process_image.clone(),
            s.force_registry.clone(),
            s.gpio_handle.clone(),
            s.modbus_handle.clone(),
            s.i2c_handle.clone(),
            s.alarm_manager.clone(),
            s.health_state.clone(),
            s.picontrol_handle.clone(),
        )
    };
    #[cfg(feature = "scada-display")]
    let scada_state = {
        let s = state.read().await;
        s.scada_state.clone()
    };

    // ADR-048 DEC-6.2: the inputs are read and the process image is updated
    // whether or not the cloud is reachable — local control depends on them.
    // The publishes below do nothing until an MQTT client exists.

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
        heartbeat.progress();
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
        heartbeat.progress();
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

    // --- RevPi process image (one snapshot of /dev/piControl0) ---
    if let Some(ref picontrol) = picontrol_handle {
        let outcome = picontrol.poll();
        heartbeat.progress();
        for reading in &outcome.readings {
            let quality = if reading.good {
                TagQuality::Good
            } else {
                // An absent module, a reset in progress or an unproven layout:
                // the stale bytes are not a reading.
                TagQuality::CommFailure
            };
            if force_registry.is_forced(&reading.tag).await {
                continue;
            }
            process_image
                .update_tag_notifying(&reading.tag, reading.value, quality, TagSource::PiControl)
                .await;
        }
        for change in &outcome.changes {
            if change.external {
                // An output moved without a write of this agent: the output
                // watchdog or a driver reset zeroed or restored it, a module
                // changed it, or another process wrote the process image.
                warn!(
                    "piControl output {} ({}) changed from {} to {} without a write of this \
                     agent",
                    change.tag, change.variable, change.old, change.new
                );
            } else {
                debug!(
                    "piControl {} ({}): {} -> {}",
                    change.tag, change.variable, change.old, change.new
                );
            }
        }
    }

    // --- I2C reads (SEQUENTIAL - shared bus!) ---
    if let Some(ref i2c) = i2c_handle {
        let ezo_driver = AtlasEzoDriver::new(i2c.clone());

        for cfg in &configs {
            // The previous tag's read returned (DEC-6.4 per-call budget).
            heartbeat.progress();
            if let ProtocolConfig::I2c { driver_type, .. } = &cfg.protocol_config {
                match driver_type {
                    I2cDriverType::AtlasEzo { sensor_type } => {
                        let (value, quality) = ezo_driver
                            .read_measurement(&cfg.tag_name, &sensor_type)
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
            crate::publish_helpers::publish_alarms(&s, &payload).await;
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
        crate::publish_helpers::publish_io_data(&s, &payload).await;
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
        2 => data
            .try_into()
            .map(|bytes| u16::from_be_bytes(bytes) as f64)
            .unwrap_or(0.0),
        4 => data
            .try_into()
            .map(|bytes| f32::from_be_bytes(bytes) as f64)
            .unwrap_or(0.0),
        8 => data.try_into().map(f64::from_be_bytes).unwrap_or(0.0),
        _ => {
            warn!("Unexpected I2C data length: {}", data.len());
            0.0
        }
    }
}

#[cfg(test)]
mod picontrol_tests {
    //! The RevPi read pass and the watchdog feed of the poll loop
    //! (ADR-048 DEC-8.8, DEC-6.7), against the fake piControl kernel.

    #![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use super::*;
    use crate::picontrol::PiControlHandle;
    use crate::picontrol::RscSource;
    use crate::picontrol::device::Opener;
    use crate::picontrol::fake::FakeKernel;
    use crate::picontrol::rsc::sample;
    use crate::process_image::TagChange;

    const GRANT: &str = r#"
output_watchdog_ms: 1000
points:
  - tag: pump
    variable: O_1
    direction: output
  - tag: in_1
    variable: I_1
  - tag: level
    variable: InputValue_1
    raw_min: 0
    raw_max: 10000
    eng_min: 0
    eng_max: 10
    eng_unit: V
"#;

    struct Rig {
        kernel: Arc<FakeKernel>,
        state: Arc<RwLock<AppState>>,
        heartbeat: crate::liveness::Heartbeat,
    }

    async fn rig(io_interval_ms: u64) -> Rig {
        let config: crate::config::AgentConfig = serde_yaml::from_str(&format!(
            "device_id: \"123e4567-e89b-42d3-a456-426614174000\"\ndevice_code: \"REVPI-1\"\n\
             api_url: \"https://api.example.test\"\nmqtt:\n  broker: \"localhost\"\n  port: 1883\n\
             telemetry:\n  io_data_interval_ms: {io_interval_ms}\n"
        ))
        .unwrap();
        let mut app = AppState::new(config);
        let kernel = FakeKernel::sample();
        let opener: Opener = {
            let k = kernel.clone();
            Arc::new(move || Ok(k.open()))
        };
        let handle = PiControlHandle::open(
            &serde_yaml::from_str(GRANT).unwrap(),
            io_interval_ms,
            RscSource::Verified(sample::rsc().into_bytes().into()),
            app.degraded.control_gate(),
            app.force_registry.clone(),
            opener,
        )
        .unwrap();
        app.process_image
            .set_picontrol_configs(handle.tag_configs())
            .await;
        app.picontrol_handle = Some(handle);
        let heartbeat = app.liveness.register(crate::liveness::LoopId::IoPoll);
        Rig {
            kernel,
            state: Arc::new(RwLock::new(app)),
            heartbeat,
        }
    }

    async fn tag(r: &Rig, name: &str) -> crate::process_image::TagValue {
        r.state
            .read()
            .await
            .process_image
            .get_tag(name)
            .await
            .unwrap_or_else(|| panic!("no tag {name}"))
    }

    #[tokio::test]
    async fn a_poll_publishes_every_point_with_the_tags_scaling() {
        let r = rig(250).await;
        r.kernel.poke(100, 1);
        r.kernel.poke(200, 0x88);
        r.kernel.poke(201, 0x13); // 0x1388 = 5000 raw
        poll_cycle(&r.state, &r.heartbeat).await.unwrap();
        let level = tag(&r, "level").await;
        assert_eq!(level.value, 5.0, "5000 raw of 0..10000 is 5 V");
        assert_eq!(level.quality, TagQuality::Good);
        assert_eq!(level.source, TagSource::PiControl);
        assert_eq!(tag(&r, "in_1").await.value, 1.0);
        assert_eq!(tag(&r, "pump").await.value, 0.0);
    }

    #[tokio::test]
    async fn an_absent_module_is_a_communication_failure_that_keeps_the_last_value() {
        let r = rig(250).await;
        r.kernel.poke(200, 0x88);
        r.kernel.poke(201, 0x13);
        poll_cycle(&r.state, &r.heartbeat).await.unwrap();
        r.kernel.set_module_active(33, false);
        r.kernel.poke(200, 0);
        r.kernel.poke(201, 0);
        poll_cycle(&r.state, &r.heartbeat).await.unwrap();
        let level = tag(&r, "level").await;
        assert_eq!(level.quality, TagQuality::CommFailure);
        assert_eq!(
            level.value, 5.0,
            "the bytes of an absent module are not a reading"
        );
        assert_eq!(tag(&r, "in_1").await.quality, TagQuality::Good);
    }

    #[tokio::test]
    async fn only_a_change_wakes_a_subscriber() {
        let r = rig(250).await;
        let mut changes = r.state.read().await.process_image.subscribe_changes();
        poll_cycle(&r.state, &r.heartbeat).await.unwrap();
        let first: Vec<TagChange> = std::iter::from_fn(|| changes.try_recv().ok()).collect();
        assert_eq!(first.len(), 3, "each tag is new on the first poll");
        poll_cycle(&r.state, &r.heartbeat).await.unwrap();
        assert!(
            changes.try_recv().is_err(),
            "an unchanged poll sends nothing"
        );
        r.kernel.poke(100, 1);
        poll_cycle(&r.state, &r.heartbeat).await.unwrap();
        let change = changes.try_recv().unwrap();
        assert_eq!((change.tag_name.as_str(), change.new_value), ("in_1", 1.0));
        assert!(changes.try_recv().is_err());
    }

    #[tokio::test]
    async fn a_forced_tag_keeps_its_forced_value() {
        let r = rig(250).await;
        let force = r.state.read().await.force_registry.clone();
        force
            .apply(
                "in_1".into(),
                1.0,
                TagQuality::Good,
                "operator".into(),
                "commissioning".into(),
                60,
                false,
                &crate::runtime_safety::system_clock::SystemClockAuthority::new(),
            )
            .await
            .unwrap();
        r.state
            .read()
            .await
            .process_image
            .update_tag_raw("in_1", 1.0, TagQuality::Good, TagSource::Force)
            .await;
        r.kernel.poke(100, 0);
        poll_cycle(&r.state, &r.heartbeat).await.unwrap();
        let t = tag(&r, "in_1").await;
        assert_eq!((t.value, t.source), (1.0, TagSource::Force));
    }

    #[tokio::test]
    async fn the_poll_loop_feeds_the_output_watchdog_also_when_polling_is_not_allowed() {
        for polling_allowed in [true, false] {
            let r = rig(20).await;
            assert!(r.kernel.armed_watchdogs().iter().all(|w| *w == 0));
            let loop_heartbeat = r
                .state
                .read()
                .await
                .liveness
                .register(crate::liveness::LoopId::ScriptEngine);
            let task = tokio::spawn(io_poll_loop(
                r.state.clone(),
                loop_heartbeat,
                polling_allowed,
            ));
            let start = Instant::now();
            while !r.kernel.armed_watchdogs().contains(&1000) {
                assert!(start.elapsed() < Duration::from_secs(5), "never fed");
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            task.abort();
        }
    }
}
