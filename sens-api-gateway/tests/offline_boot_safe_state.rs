#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]

//! ADR-048 DEC-6.2 / EDGE-MEDIUM-078 — no network, no exit: the outputs are
//! driven safe and READY is sent whether or not the cloud is reachable.
//!
//! Before DEC-6.2 the boot ran activation (five attempts, then exit) and the
//! MQTT client before hardware init, so an unactivated or offline device
//! restart-looped without ever driving its outputs safe. Now activation and
//! MQTT are a background task: these tests boot the real binary (generic
//! profile) with an unreachable provisioning endpoint and an unreachable
//! broker, against a Modbus-TCP slave that timestamps every write.

#[cfg(not(feature = "suderra-os"))]
#[path = "boot_support/mod.rs"]
mod boot_support;

#[cfg(not(feature = "suderra-os"))]
mod generic {
    use super::boot_support::{
        Device, DeviceConfig, ModbusServer, ModbusWrite, modbus_output_device,
    };
    use std::time::Duration;

    fn assert_safe_before(plc: &ModbusServer, ready_at: std::time::Instant, device: &Device) {
        let writes = plc.writes();
        for expected in [
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
        ] {
            assert!(
                writes
                    .iter()
                    .any(|w| w.write == expected && w.at <= ready_at),
                "{expected:?} not driven safe before READY: {writes:?}\n{}",
                device.log()
            );
        }
    }

    /// Unactivated, provisioning endpoint unreachable: outputs safe, READY,
    /// activation keeps retrying in the background, the process stays up.
    #[test]
    fn unactivated_device_offline_drives_outputs_safe_and_becomes_ready() {
        let plc = ModbusServer::start();
        let mut device = Device::new(&DeviceConfig {
            activated: false,
            extra_yaml: format!("modbus:\n{}", modbus_output_device("plc", plc.port)),
        });
        device.start(Duration::from_secs(6));
        let ready = device.wait_ready(Duration::from_secs(90));
        assert_safe_before(&plc, ready.at, &device);
        std::thread::sleep(Duration::from_secs(3));
        assert!(device.alive(), "agent exited:\n{}", device.log());
        let log = device.log();
        assert!(
            log.contains("Activation attempt 1 failed"),
            "activation never attempted:\n{log}"
        );
        assert_eq!(device.health()["degraded"], false);
        let exit = device.stop().expect("running");
        assert!(exit.success(), "{exit}\n{}", device.log());
    }

    /// Activated, broker unreachable: the same.
    #[test]
    fn activated_device_with_broker_down_drives_outputs_safe_and_becomes_ready() {
        let plc = ModbusServer::start();
        let mut device = Device::new(&DeviceConfig {
            activated: true,
            extra_yaml: format!("modbus:\n{}", modbus_output_device("plc", plc.port)),
        });
        device.start(Duration::from_secs(6));
        let ready = device.wait_ready(Duration::from_secs(90));
        assert_safe_before(&plc, ready.at, &device);
        std::thread::sleep(Duration::from_secs(3));
        assert!(device.alive(), "agent exited:\n{}", device.log());
        assert_eq!(device.health()["degraded"], false);
        // EDGE-HIGH-133: the default configuration has no health listener, and
        // the outbound publisher (the offline queue's only producer) is built
        // anyway; before, every default boot logged "health_state must be
        // initialized first" and published straight into the outage.
        let log = device.log();
        assert!(
            log.contains("Outbound publisher initialized"),
            "no outbound publisher was built with the default configuration:\n{log}"
        );
        assert!(
            !log.contains("Outbound publisher not started"),
            "the outbound publisher refused to start:\n{log}"
        );
        let exit = device.stop().expect("running");
        assert!(exit.success(), "{exit}\n{log}");
    }
}
