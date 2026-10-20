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
//!   `run_connectivity`);
//! * real binary (generic profile) against a Modbus-TCP slave that timestamps
//!   every write: every registered output receives its safe value before
//!   READY arrives; a partial safe-state, or a configured backend without a
//!   driver, still yields READY — with `STATUS=degraded`, the health view
//!   `"degraded": true` and continuing watchdog pings — and the process stays
//!   up until it is stopped.

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
    let safe_state = position(&body, "safe_state_manager");
    let apply = safe_state + position(&body[safe_state..], ".apply(");
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
