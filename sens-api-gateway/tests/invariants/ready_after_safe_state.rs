#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]

//! ADR-048 DEC-6.2, DEC-6.3, DEC-13 (P0) — READY means "outputs safe, local
//! control loop running"; a failure to get there is degraded mode, not an
//! exit.
//!
//! EDGE-HIGH-051: READY used to be sent before activation, MQTT, hardware
//! init and the boot safe-state. EDGE-HIGH-061 / EDGE-MEDIUM-075: the boot
//! gate counted successes, so a sensor-only node aborted while a partially
//! safe node carried on. INFRA-CRITICAL-236: a configured backend without a
//! driver simulated success.
//!
//! * source: in `run_agent`, the boot safe-state comes before the first
//!   control cycle, which comes before the one READY; activation and MQTT are
//!   not reached from `run_agent` before READY (they live in
//!   `run_connectivity`); the stores and services of the full operation
//!   (`init_boot_dependencies`) start after the boot safe-state and before
//!   the first control cycle, and `async_main` reaches none of them, so no
//!   store failure can exit ahead of the safe-state (EDGE-MEDIUM-078);
//! * real binary (generic profile) against a Modbus-TCP slave that timestamps
//!   every write: every registered output receives its safe value before
//!   READY arrives; a partial safe-state, or a configured backend without a
//!   driver, still yields READY — with `STATUS=degraded`, the health view
//!   `"degraded": true` and continuing watchdog pings — and the process stays
//!   up until it is stopped. A store that fails after the safe-state is
//!   degraded mode with the outputs safe and no connectivity; a
//!   configuration that fails its integrity check is standby: no output
//!   touched, no READY, the start timeout extended (ADR-048 DEC-4.10).

#[path = "source_scan_support/mod.rs"]
mod source_scan_support;

#[cfg(not(feature = "suderra-os"))]
#[path = "../boot_support/mod.rs"]
mod boot_support;

/// `run_agent`'s production code (comments and strings blanked).
fn run_agent_body() -> String {
    let main = source_scan_support::scan_src()
        .into_iter()
        .find(|f| f.rel == "src/main.rs")
        .expect("src/main.rs");
    let start = main
        .code
        .find("async fn run_agent(")
        .expect("run_agent in main.rs");
    let rest = &main.code[start..];
    // The body ends at the next top-level item.
    let end = rest[1..]
        .find("\nasync fn ")
        .into_iter()
        .chain(rest[1..].find("\nfn "))
        .min()
        .map_or(rest.len(), |e| e + 1);
    rest[..end].to_string()
}

fn position(body: &str, needle: &str) -> usize {
    body.find(needle)
        .unwrap_or_else(|| panic!("run_agent no longer contains `{needle}`"))
}

#[test]
fn ready_comes_after_safe_state_and_the_first_control_cycle() {
    let body = run_agent_body();
    let apply = position(&body, "safe_state::apply_event(");
    let first_cycles = position(&body, "first_cycles(");
    let ready = position(&body, "notifier.ready(");
    assert!(
        apply < first_cycles && first_cycles < ready,
        "run_agent must apply the boot safe-state, then wait for the first control cycle, \
         then send READY (ADR-048 DEC-6.2)"
    );
    assert_eq!(
        body.matches("notifier.ready(").count(),
        1,
        "READY is sent from exactly one place"
    );
    let all_ready: usize = source_scan_support::scan_src()
        .iter()
        .map(|f| f.code.matches(".ready(").count())
        .sum();
    assert_eq!(all_ready, 1, "READY is sent only from run_agent");
}

#[test]
fn network_and_activation_never_gate_ready() {
    let body = run_agent_body();
    for needle in [
        "MqttClient::new(",
        "request_activation(",
        "self_register(",
        ".activate()",
        "init_outbound_publisher(",
    ] {
        assert!(
            !body.contains(needle),
            "run_agent reaches `{needle}`; network steps belong to run_connectivity, which runs \
             in the background and never gates READY (ADR-048 DEC-6.2)"
        );
    }
    assert!(
        body.contains("spawn_local(run_connectivity("),
        "run_agent must start the connectivity task in the background"
    );
}

#[test]
fn boot_failures_enter_degraded_mode_instead_of_exiting() {
    let body = run_agent_body();
    let ready = position(&body, "notifier.ready(");
    let before_ready = &body[..ready];
    for needle in ["process::exit(", "return Err("] {
        assert!(
            !before_ready.contains(needle),
            "run_agent exits before READY (`{needle}`); fail closed is degraded mode \
             (ADR-048 DEC-6.3)"
        );
    }
    assert!(before_ready.contains("degraded.enter("));
}

/// The body of the top-level function `name` in main.rs's production code.
fn main_fn_body(name: &str) -> String {
    let main = source_scan_support::scan_src()
        .into_iter()
        .find(|f| f.rel == "src/main.rs")
        .expect("src/main.rs");
    let start = main
        .code
        .find(name)
        .unwrap_or_else(|| panic!("main.rs has no `{name}`"));
    let rest = &main.code[start..];
    let end = rest.find("\n}\n").map_or(rest.len(), |e| e + 2);
    rest[..end].to_string()
}

#[test]
fn stores_start_after_the_boot_safe_state_and_before_ready() {
    let body = run_agent_body();
    let apply = position(&body, "safe_state::apply_event(");
    let stores = position(&body, "init_boot_dependencies(");
    let first_cycles = position(&body, "first_cycles(");
    assert!(
        apply < stores && stores < first_cycles,
        "run_agent must start the stores after the boot safe-state and before the first \
         control cycle (ADR-048 DEC-6.2, EDGE-MEDIUM-078)"
    );
    // The stores themselves fail into degraded mode, never out of the process.
    let deps = main_fn_body("async fn init_boot_dependencies(");
    assert!(
        !deps.contains("process::exit("),
        "init_boot_dependencies exits"
    );
    for store in [
        "init_keystore(",
        "init_offline_queue(",
        "init_backup_manager(",
        "init_user_token_manifest_store(",
        "init_firmware_signing_pubkey(",
        "init_audit_sink(",
        "init_license_cache(",
    ] {
        assert!(
            deps.contains(store),
            "init_boot_dependencies lost `{store}`"
        );
    }
}

#[test]
fn async_main_reaches_no_store_before_the_safe_state() {
    let body = main_fn_body("async fn async_main(");
    for needle in [
        "init_keystore(",
        "init_offline_queue(",
        "init_backup_manager(",
        "init_rbac_manifest_store(",
        "init_user_token_manifest_store(",
        "init_partition_store(",
        "init_firmware_signing_pubkey(",
        "init_audit_sink(",
        "init_lifecycle_auth_key(",
        "init_health_server(",
    ] {
        assert!(
            !body.contains(needle),
            "async_main reaches `{needle}` ahead of the boot safe-state (EDGE-MEDIUM-078)"
        );
    }
    // The one exit left before run_agent is the generic profile's unreadable
    // configuration: without one nothing is known about the outputs.
    assert_eq!(
        body.matches("process::exit(").count(),
        2,
        "async_main exits only for an unreadable configuration and after run_agent returned \
         an error"
    );
}

#[cfg(not(feature = "suderra-os"))]
mod generic {
    use super::boot_support::{
        Device, DeviceConfig, ModbusServer, ModbusWrite, closed_port, modbus_output_device,
    };
    use std::time::{Duration, Instant};

    const WATCHDOG: Duration = Duration::from_secs(6);

    fn wait_pings(device: &Device, after: Instant, n: usize) -> usize {
        let deadline = Instant::now() + Duration::from_secs(15);
        while device.notify.watchdogs_after(after) < n && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        device.notify.watchdogs_after(after)
    }

    fn expected_safe_writes() -> Vec<ModbusWrite> {
        vec![
            ModbusWrite::Coil {
                address: 10,
                value: true,
            },
            ModbusWrite::Coil {
                address: 11,
                value: false,
            },
            ModbusWrite::Register {
                address: 20,
                value: 123,
            },
        ]
    }

    /// Every registered output receives its fail-safe value before READY.
    #[test]
    fn outputs_are_driven_safe_before_ready() {
        let plc = ModbusServer::start();
        let mut device = Device::new(&DeviceConfig {
            activated: true,
            extra_yaml: format!("modbus:\n{}", modbus_output_device("plc", plc.port)),
        });
        device.start(WATCHDOG);
        let ready = device.wait_ready(Duration::from_secs(90));

        let writes = plc.writes();
        for expected in expected_safe_writes() {
            let w = writes
                .iter()
                .find(|w| w.write == expected)
                .unwrap_or_else(|| {
                    panic!(
                        "safe write {expected:?} never arrived; writes: {writes:?}\n{}",
                        device.log()
                    )
                });
            assert!(
                w.at <= ready.at,
                "{expected:?} arrived after READY\n{}",
                device.log()
            );
        }
        let status = ready.status().unwrap_or_default().to_string();
        assert!(
            status.starts_with("running: 3/3 outputs"),
            "STATUS: {status}"
        );
        let health = device.health();
        assert_eq!(health["degraded"], false, "{health}");
        assert_eq!(health["safe_state"]["registered"], 3);
        assert_eq!(health["safe_state"]["applied"], 3);
        assert!(wait_pings(&device, ready.at, 2) >= 2, "{}", device.log());
        let exit = device.stop().expect("running");
        assert!(exit.success(), "{exit}\n{}", device.log());
    }

    /// One reachable and one unreachable output device: the reachable one is
    /// driven safe, the agent is degraded, still READY, still pinging, and
    /// still running.
    #[test]
    fn partial_safe_state_is_degraded_mode_not_an_exit() {
        let plc = ModbusServer::start();
        let mut device = Device::new(&DeviceConfig {
            activated: true,
            extra_yaml: format!(
                "modbus:\n{}{}",
                modbus_output_device("plc", plc.port),
                modbus_output_device("offline-plc", closed_port())
            ),
        });
        device.start(WATCHDOG);
        let ready = device.wait_ready(Duration::from_secs(120));

        let status = ready.status().unwrap_or_default().to_string();
        assert!(
            status.starts_with("degraded: ") && status.contains("safe-state-incomplete"),
            "STATUS: {status}\n{}",
            device.log()
        );
        let writes = plc.writes();
        for expected in expected_safe_writes() {
            assert!(
                writes
                    .iter()
                    .any(|w| w.write == expected && w.at <= ready.at),
                "reachable output {expected:?} not driven safe before READY: {writes:?}"
            );
        }
        let health = device.health();
        assert_eq!(health["degraded"], true, "{health}");
        assert_eq!(health["control"], "disabled");
        assert_eq!(health["reasons"][0]["code"], "safe-state-incomplete");
        assert_eq!(health["safe_state"]["registered"], 6);
        assert_eq!(health["safe_state"]["applied"], 3);
        // Degraded mode keeps the I/O loop and the watchdog alive.
        assert!(wait_pings(&device, ready.at, 2) >= 2, "{}", device.log());
        std::thread::sleep(Duration::from_secs(2));
        assert!(device.alive(), "degraded agent exited:\n{}", device.log());
        // Control is disabled: no write after the boot safe-state.
        let after: Vec<_> = plc
            .writes()
            .into_iter()
            .filter(|w| w.at > ready.at)
            .collect();
        assert!(after.is_empty(), "writes in degraded mode: {after:?}");
        let exit = device.stop().expect("running");
        assert!(exit.success(), "{exit}\n{}", device.log());
    }

    /// EDGE-MEDIUM-078: a store that fails (the offline queue, whose
    /// directory cannot be created) no longer exits ahead of the boot
    /// safe-state. The outputs are driven safe before READY, READY carries
    /// the degraded status naming the component, the watchdog keeps pinging,
    /// no connectivity starts, nothing is written after the safe-state and
    /// the process stays up.
    #[test]
    fn a_failing_store_after_the_safe_state_is_degraded_not_an_exit() {
        let plc = ModbusServer::start();
        let mut device = Device::new(&DeviceConfig {
            activated: true,
            extra_yaml: format!(
                "offline_queue:\n  enabled: true\n  db_path_override: \
                 \"/dev/null/queue/offline_queue.db\"\nmodbus:\n{}",
                modbus_output_device("plc", plc.port)
            ),
        });
        device.start(WATCHDOG);
        let ready = device.wait_ready(Duration::from_secs(90));

        let writes = plc.writes();
        for expected in expected_safe_writes() {
            assert!(
                writes
                    .iter()
                    .any(|w| w.write == expected && w.at <= ready.at),
                "output {expected:?} not driven safe before READY: {writes:?}\n{}",
                device.log()
            );
        }
        let status = ready.status().unwrap_or_default().to_string();
        assert!(
            status.starts_with("degraded: ") && status.contains("boot-dependency-failed"),
            "STATUS: {status}\n{}",
            device.log()
        );
        let health = device.health();
        assert_eq!(health["degraded"], true, "{health}");
        assert_eq!(health["control"], "disabled");
        assert_eq!(health["reasons"][0]["code"], "boot-dependency-failed");
        assert!(
            health["reasons"][0]["detail"]
                .as_str()
                .unwrap_or_default()
                .starts_with("offline-queue failed after the boot safe-state"),
            "{health}"
        );
        assert_eq!(health["safe_state"]["applied"], 3);
        assert!(wait_pings(&device, ready.at, 2) >= 2, "{}", device.log());
        std::thread::sleep(Duration::from_secs(2));
        assert!(device.alive(), "degraded agent exited:\n{}", device.log());
        assert!(
            device.log().contains("Connectivity NOT started"),
            "{}",
            device.log()
        );
        let after: Vec<_> = plc
            .writes()
            .into_iter()
            .filter(|w| w.at > ready.at)
            .collect();
        assert!(after.is_empty(), "writes in degraded mode: {after:?}");
        let exit = device.stop().expect("running");
        assert!(exit.success(), "{exit}\n{}", device.log());
    }

    /// ADR-048 DEC-4.10 / DEC-6.3: a configuration that fails its
    /// integrity check (Enforcing, no sidecar) is never acted on. The agent
    /// stays up in standby: no output touched, no READY, the start timeout
    /// extended, the reason in STATUS= and the health view; SIGTERM ends it
    /// cleanly.
    #[test]
    fn an_unverified_configuration_is_standby_with_no_output_touched() {
        let plc = ModbusServer::start();
        let mut device = Device::new(&DeviceConfig {
            activated: true,
            extra_yaml: format!(
                "config_integrity:\n  mode: enforcing\n  factory_pubkey_hex: \
                 \"d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a\"\n\
                 modbus:\n{}",
                modbus_output_device("plc", plc.port)
            ),
        });
        device.start(WATCHDOG);
        let standby = device
            .notify
            .wait_for(Duration::from_secs(30), |d| {
                d.text.contains("EXTEND_TIMEOUT_USEC=")
            })
            .unwrap_or_else(|| panic!("no standby notification\n{}", device.log()));
        let status = standby.status().unwrap_or_default().to_string();
        assert!(
            status.starts_with("standby: ") && status.contains("config-unverified"),
            "STATUS: {status}"
        );
        let health = device.health();
        assert_eq!(health["phase"], "standby", "{health}");
        assert_eq!(health["degraded"], true);
        assert_eq!(health["reasons"][0]["code"], "config-unverified");
        std::thread::sleep(Duration::from_secs(3));
        assert!(device.alive(), "standby agent exited:\n{}", device.log());
        assert!(
            !device.notify.all().iter().any(|d| d.is_ready()),
            "READY in standby"
        );
        assert!(plc.writes().is_empty(), "an output was touched in standby");
        let exit = device.stop().expect("running");
        assert!(exit.success(), "{exit}\n{}", device.log());
    }

    /// A configured GPIO output in a build without the GPIO driver: no
    /// simulated success — degraded mode, READY, the process stays up.
    #[cfg(not(feature = "gpio"))]
    #[test]
    fn a_configured_backend_without_driver_is_degraded_not_simulated() {
        let mut device = Device::new(&DeviceConfig {
            activated: true,
            extra_yaml: "gpio:\n  - name: pump\n    pin: 17\n    direction: output\n    \
                         safe_state_level: true\n"
                .to_string(),
        });
        device.start(WATCHDOG);
        let ready = device.wait_ready(Duration::from_secs(90));
        let status = ready.status().unwrap_or_default().to_string();
        assert!(
            status.contains("gpio-backend-unavailable"),
            "STATUS: {status}\n{}",
            device.log()
        );
        let health = device.health();
        assert_eq!(health["degraded"], true);
        assert_eq!(health["reasons"][0]["code"], "gpio-backend-unavailable");
        assert_eq!(
            health["safe_state"]["applied"], 0,
            "no simulated safe write"
        );
        assert!(wait_pings(&device, ready.at, 2) >= 2, "{}", device.log());
        assert!(device.alive(), "{}", device.log());
        let exit = device.stop().expect("running");
        assert!(exit.success(), "{exit}\n{}", device.log());
    }
}
