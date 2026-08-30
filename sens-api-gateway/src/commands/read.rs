//! Hardware read + discovery command handlers (Batch 20f ARC-008 split).
//!
//! WHY: Plan §5 Faz 1 Step 5 domain isolation. Read handlers touch
//! only `AppState.modbus_handle` + `AppState.gpio_handle` + static
//! `HardwareScanner`; zero state mutation. Extracting them
//! separately from write/set_output handlers surfaces the IO-
//! SURFACE-READ vs IO-SURFACE-MUTATE distinction clearly for
//! reviewers.
//!
//! WHAT: 4 handlers moved from mod.rs as `impl CommandHandler`
//! block:
//! - `cmd_get_hardware` — configured-device inventory +
//!   connectivity status for Modbus + GPIO + platform metadata.
//! - `cmd_scan_hardware` — full I/O enumeration via
//!   `HardwareScanner`. Platform-specific discovery:
//!   Revolution Pi piControl / RPi BCM GPIO / generic sysfs.
//!   Wrapped in `tokio::task::spawn_blocking` because piTest
//!   subprocess + sysfs reads block the tokio runtime.
//! - `cmd_read_modbus` — parallel reads across all configured
//!   Modbus devices via `read_all_parallel()`.
//! - `cmd_read_gpio` — actor-pattern read via `gpio_handle.
//!   read_all()` (v2.2 replaced the deprecated sync gpio_manager).
//!
//! MUTABILITY: All 4 take `&self` — proving at the type level that
//! no state mutation occurs on the read path. Write handlers (20g)
//! take `&self` but MUTATE through the handle's internal mutex.

use serde_json::{Value, json};
use tracing::{info, warn};

use crate::hardware_scanner::HardwareScanner;

use super::CommandHandler;

impl CommandHandler {
    /// Get hardware info - lists all connected devices and sensors.
    pub(super) async fn cmd_get_hardware(&self) -> (bool, Value, Option<String>) {
        info!("Executing get_hardware command");

        let state = self.state.read().await;

        let modbus_devices: Vec<Value> = state
            .config
            .modbus
            .iter()
            .map(|device| {
                json!({
                    "name": device.name,
                    "connection_type": device.connection_type,
                    "address": device.address,
                    "slave_id": device.slave_id,
                    "registers": device.registers.iter().map(|r| {
                        json!({
                            "name": r.name,
                            "address": r.address,
                            "type": r.register_type,
                            "data_type": r.data_type,
                            "unit": r.unit
                        })
                    }).collect::<Vec<_>>()
                })
            })
            .collect();

        let gpio_pins: Vec<Value> = state
            .config
            .gpio
            .iter()
            .map(|pin| {
                json!({
                    "name": pin.name,
                    "pin": pin.pin,
                    "direction": pin.direction,
                    "pull": pin.pull,
                    "invert": pin.invert
                })
            })
            .collect();

        // "connected" reflects whether Modbus DEVICES are configured, not merely
        // whether the (always-present) actor exists — the actor is now started
        // unconditionally to support runtime device provisioning, so its presence
        // no longer implies configured devices.
        let modbus_connected = !state.config.modbus.is_empty();
        // v2.2: gpio_handle actor pattern (deprecated gpio_manager removed).
        let gpio_available = state.gpio_handle.is_some();

        // Batch 43: query Linux prctl(PR_GET_DUMPABLE) to verify
        // the Batch 24 coredump-disable hardening is still
        // effective. Surfaces the runtime-observable flag so
        // operators can verify post-Batch-24 that the hardening
        // actually took effect (systemd unit overrides OR some
        // future subprocess fork + setuid transition could have
        // reset the flag).
        //
        // On non-Linux platforms (dev laptop builds) the field
        // is absent — prctl doesn't exist; serializing a
        // placeholder would mislead operators.
        let coredump_disabled: Option<bool> = {
            #[cfg(target_os = "linux")]
            {
                const PR_GET_DUMPABLE: libc::c_int = 3;
                // SAFETY: prctl(PR_GET_DUMPABLE) reads a per-
                // process kernel flag; no memory touched.
                // Stable syscall since Linux 2.4.
                let flag = unsafe { libc::prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) };
                if flag >= 0 { Some(flag == 0) } else { None }
            }
            #[cfg(not(target_os = "linux"))]
            {
                None
            }
        };

        let hardware_info = json!({
            "modbus": {
                "configured": !modbus_devices.is_empty(),
                "connected": modbus_connected,
                "devices": modbus_devices
            },
            "gpio": {
                "configured": !gpio_pins.is_empty(),
                "available": gpio_available,
                "pins": gpio_pins
            },
            "platform": {
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH
            },
            // Batch 43: process-hardening status for operator
            // visibility. coredump_disabled indicates the Batch
            // 24 prctl(PR_SET_DUMPABLE=0) is in effect; None on
            // non-Linux builds means prctl unavailable.
            "process_hardening": {
                "coredump_disabled": coredump_disabled,
            }
        });

        (true, hardware_info, None)
    }

    /// Scan hardware — enumerates all available I/O channels on the
    /// device.
    ///
    /// Platform-specific discovery:
    /// - Revolution Pi: piControl process image (piTest -d).
    /// - Raspberry Pi: BCM GPIO 2-27 enumeration.
    /// - Generic Linux: /sys/class/gpio/gpiochip* sysfs.
    ///
    /// Returns a list of `DiscoveredIo` channels that can be bulk-
    /// imported via the platform's "Auto-Detect I/O" feature.
    ///
    /// WHY spawn_blocking: `piTest` is a subprocess fork+exec and
    /// sysfs reads are synchronous syscalls — both would stall the
    /// tokio worker thread. Offloading to the blocking pool keeps
    /// the command handler responsive.
    pub(super) async fn cmd_scan_hardware(&self) -> (bool, Value, Option<String>) {
        info!("Executing scan_hardware command — full I/O enumeration");

        let platform = {
            let state = self.state.read().await;
            state.config.gpio_platform()
        };

        let result = match tokio::task::spawn_blocking(move || {
            let scanner = HardwareScanner::new(platform);
            scanner.scan()
        })
        .await
        {
            Ok(r) => r,
            Err(e) => {
                warn!("Scan task panicked: {}", e);
                return (false, json!(null), Some(format!("Scan task failed: {}", e)));
            }
        };

        match serde_json::to_value(&result) {
            Ok(value) => (true, value, None),
            Err(e) => {
                warn!("Failed to serialize scan result: {}", e);
                (
                    false,
                    json!(null),
                    Some(format!("Serialization error: {}", e)),
                )
            }
        }
    }

    /// Read all Modbus registers or specific device.
    ///
    /// Uses `read_all_parallel()` (v1.2.2) to minimize wall-clock
    /// latency when multiple Modbus devices are configured — each
    /// device's read happens concurrently rather than serially.
    pub(super) async fn cmd_read_modbus(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing read_modbus command");

        let _device_name = params.get("device").and_then(|v| v.as_str());

        let modbus_handle = {
            let state = self.state.read().await;
            state.modbus_handle.clone()
        };

        let handle = match modbus_handle {
            Some(h) => h,
            None => {
                return (
                    false,
                    json!(null),
                    Some("No Modbus devices configured".to_string()),
                );
            }
        };

        let results = handle.read_all_parallel().await;
        let data: Vec<Value> = results
            .iter()
            .map(|result| {
                json!({
                    "device": result.device_name,
                    "values": result.values.iter().map(|v| {
                        json!({
                            "name": v.name,
                            "address": v.address,
                            "raw_value": v.raw_value,
                            "scaled_value": v.scaled_value,
                            "unit": v.unit,
                            "timestamp": v.timestamp
                        })
                    }).collect::<Vec<_>>(),
                    "errors": result.errors.clone()
                })
            })
            .collect();

        (true, json!({"devices": data}), None)
    }

    /// Read all GPIO pins (v2.2: uses gpio_handle actor pattern).
    ///
    /// The `errors` vector is retained in the response EVEN on
    /// success — operators need visibility into per-pin read
    /// failures (e.g., one pin misconfigured while others read
    /// correctly). Returning just an Err would lose the
    /// successful-read subset.
    pub(super) async fn cmd_read_gpio(&self) -> (bool, Value, Option<String>) {
        info!("Executing read_gpio command");

        let gpio_handle = {
            let state = self.state.read().await;
            state.gpio_handle.clone()
        };

        let gpio_handle = match gpio_handle {
            Some(h) => h,
            None => {
                return (
                    false,
                    json!(null),
                    Some("No GPIO pins configured".to_string()),
                );
            }
        };

        let result = gpio_handle.read_all().await;

        let pins: Vec<Value> = result
            .values
            .iter()
            .map(|v| {
                json!({
                    "name": v.name,
                    "pin": v.pin,
                    "direction": v.direction,
                    "state": format!("{:?}", v.state).to_lowercase(),
                    "timestamp": v.timestamp
                })
            })
            .collect();

        if result.errors.is_empty() {
            (true, json!({"pins": pins}), None)
        } else {
            (true, json!({"pins": pins, "errors": result.errors}), None)
        }
    }
}
