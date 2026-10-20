#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]

//! ADR-048 DEC-6.1 / EDGE-CRITICAL-049 — READY must not take the notify
//! socket with it.
//!
//! The agent's READY used `sd_notify::notify(true, ..)`; `true` removed
//! `NOTIFY_SOCKET` from the environment, so every later `WATCHDOG=1` was a
//! silent no-op and `WatchdogSec=60` killed and restarted the agent about
//! once a minute.
//!
//! Tier 1 does the work: `src/systemd_notify.rs` captures the socket address
//! once, before any thread exists, and has no "unset" operation; the
//! `sd-notify` crate is gone. This test keeps it that way:
//!
//! * source: no `notify(true`, no `sd_notify::` path, no environment
//!   mutation in production code, and the systemd protocol variables are read
//!   only by the notifier;
//! * real binary (generic profile): bind an `AF_UNIX` datagram socket, start
//!   the agent with `NOTIFY_SOCKET`, `WATCHDOG_USEC` and `WATCHDOG_PID` as
//!   systemd does, and require READY followed by at least two `WATCHDOG=1`
//!   datagrams — the exact sequence the bug made impossible.

#[path = "source_scan_support/mod.rs"]
mod source_scan_support;

#[cfg(not(feature = "suderra-os"))]
#[path = "../boot_support/mod.rs"]
mod boot_support;

#[test]
fn no_notify_call_can_unset_the_socket() {
    let mut violations = Vec::new();
    for file in source_scan_support::scan_src() {
        for needle in ["notify(true", "sd_notify::", "remove_var(", "set_var("] {
            for line in file.code_lines_with(needle) {
                violations.push(format!("{}:{line}: {needle}", file.rel));
            }
        }
    }
    assert!(
        violations.is_empty(),
        "production code may neither call sd_notify with unset_env nor mutate the \
         environment (ADR-048 DEC-6.1); use crate::systemd_notify::SystemdNotifier:\n{}",
        violations.join("\n")
    );
}

#[test]
fn systemd_protocol_variables_are_read_only_by_the_notifier() {
    let mut readers = Vec::new();
    for file in source_scan_support::scan_src() {
        for lit in &file.literals {
            if ["NOTIFY_SOCKET", "WATCHDOG_USEC", "WATCHDOG_PID"].contains(&lit.text.as_str()) {
                readers.push((file.rel.clone(), lit.text.clone(), lit.line));
            }
        }
    }
    let foreign: Vec<_> = readers
        .iter()
        .filter(|(f, _, _)| f != "src/systemd_notify.rs")
        .collect();
    assert!(
        foreign.is_empty(),
        "systemd notify variables used outside src/systemd_notify.rs: {foreign:?}"
    );
    for var in ["NOTIFY_SOCKET", "WATCHDOG_USEC", "WATCHDOG_PID"] {
        assert!(
            readers.iter().any(|(_, v, _)| v == var),
            "src/systemd_notify.rs no longer reads {var}"
        );
    }
}

#[test]
fn the_sd_notify_crate_is_not_a_dependency() {
    let manifest = std::fs::read_to_string(source_scan_support::crate_root().join("Cargo.toml"))
        .expect("Cargo.toml");
    let declared = manifest
        .lines()
        .map(str::trim)
        .any(|l| l.starts_with("sd-notify") || l.starts_with("sd_notify"));
    assert!(
        !declared,
        "the sd-notify crate came back; its unset_env flag is the EDGE-CRITICAL-049 bug"
    );
}

#[cfg(not(feature = "suderra-os"))]
#[test]
fn real_binary_sends_ready_then_repeated_watchdog_pings() {
    use boot_support::{Device, DeviceConfig};
    use std::time::{Duration, Instant};

    let mut device = Device::new(&DeviceConfig {
        activated: true,
        extra_yaml: String::new(),
    });
    // WatchdogSec=6: pings are due while the control loops ticked within 3 s;
    // the supervisor checks every 1.5 s.
    device.start(Duration::from_secs(6));
    let ready = device.wait_ready(Duration::from_secs(90));

    let deadline = Instant::now() + Duration::from_secs(15);
    while device.notify.watchdogs_after(ready.at) < 2 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    let pings = device.notify.watchdogs_after(ready.at);
    assert!(
        pings >= 2,
        "READY must leave the notify socket usable: {pings} WATCHDOG=1 after READY\n\
         datagrams: {:?}\nlog:\n{}",
        device.notify.all(),
        device.log()
    );
    // No ping before READY: the watchdog follows the running control loops.
    assert!(
        device
            .notify
            .all()
            .iter()
            .all(|d| !d.is_watchdog() || d.at >= ready.at),
        "WATCHDOG=1 before READY: {:?}",
        device.notify.all()
    );
    assert!(device.alive(), "agent exited:\n{}", device.log());
    let status = device.stop().expect("agent was running");
    assert!(
        status.success(),
        "graceful stop failed: {status}\n{}",
        device.log()
    );
}
