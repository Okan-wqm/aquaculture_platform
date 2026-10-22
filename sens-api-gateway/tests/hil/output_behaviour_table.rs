//! Hardware-in-the-loop test of the RevPi output behaviour table
//! (ADR-048 DEC-13.3, DEC-6.7, DEC-8.8; EDGE-HIGH-053, EDGE-HIGH-058).
//!
//! NOT RUN IN CI. It needs a RevPi Connect 4 with a DIO module and the KUNBUS
//! `piControl` driver, and it is compiled only with the `hil` feature
//! (`required-features = ["hil"]` in Cargo.toml):
//!
//! ```text
//! SUDERRA_HIL_RSC=/etc/revpi/config.rsc \
//! SUDERRA_HIL_PUMP=O_1 SUDERRA_HIL_AERATOR=O_2 \
//!   cargo test --locked --features hil --test hil_output_behaviour_table \
//!   -- --test-threads=1 --nocapture
//! ```
//!
//! It plays, against the real driver, the same rows of
//! `src/picontrol/behaviour_table.rs` that `cargo test` plays against the fake
//! kernel (`src/picontrol/behaviour_tests.rs`): the agent's real
//! backend code (`Backend`, included from `src/picontrol/`) runs in a child
//! process of this test binary that is stopped, killed or stalled while the
//! parent watches the process image through a descriptor of its own. Nothing
//! here is mocked.
//!
//! # The rig
//!
//! * a RevPi Connect 4 with piControl loaded and a DIO module at any position;
//! * PiCtory's `config.rsc` (the file the driver loaded, `SUDERRA_HIL_RSC`)
//!   defines two DIO outputs the test may drive:
//!   * `SUDERRA_HIL_PUMP` (default `O_1`): a bit output whose PiCtory default is
//!     `0`; wire a lamp or leave it open;
//!   * `SUDERRA_HIL_AERATOR` (default `O_2`): a bit output whose PiCtory
//!     default is `1`, standing for a life-support output that must stay on.
//!     Set the default of that variable to 1 in PiCtory first; the test's grant
//!     is refused otherwise (the registry requires the safe value to equal the
//!     default the driver restores).
//! * the test runs as a user that may open `/dev/piControl0` for writing (root
//!   on the rig, or a member of `suderra-io`); the driver-reset row also needs
//!   to be allowed to reset the driver (root);
//! * nothing else writes the process image while it runs (stop revpipyload,
//!   Node-RED, the agent).
//!
//! # Rows
//!
//! The rows marked `MockAndHil` in the table are automated below:
//! graceful restart, restart with an incomplete safe state, crash, stall,
//! degraded (the control loop keeps feeding after the safe state), driver
//! reset. The rows marked `Commissioning` (OS reboot, hardware watchdog reset,
//! power loss, module communication loss) need a person to cut power or pull
//! the PiBridge cable; no test can, and `commissioning_rows_are_listed` prints
//! them as the checklist for the installation record (DEC-13.1). What those
//! rows leave on an output is module firmware and wiring.
//!
//! # What this test must show on the hardware before SG-1 can open
//!
//! 1. the six request numbers and structure layouts of `abi.rs` are the
//!    driver's (`the_abi_matches_the_driver`);
//! 2. the signed `config.rsc` and the driver agree to the byte and bit
//!    (`the_registry_verifies_against_the_driver`);
//! 3. every row above lands where the table says, including that the
//!    `RevPiOutput`/`RevPiLED` bytes of the base module are never written by
//!    the agent (`the_base_module_outputs_are_never_written`).

#![allow(dead_code, unused_imports, unused_variables, clippy::all)]

/// The agent's piControl modules that depend on nothing else of the crate:
/// the same files `cargo build` compiles into the agent. They sit side by side
/// at the root of this test crate, which is where their `super::` paths expect
/// to find one another.
#[path = "../../src/picontrol/abi.rs"]
mod abi;
#[path = "../../src/picontrol/backend.rs"]
mod backend;
#[path = "../../src/picontrol/behaviour_table.rs"]
mod behaviour_table;
#[path = "../../src/picontrol/config.rs"]
mod config;
#[path = "../../src/picontrol/device.rs"]
mod device;
#[path = "../../src/picontrol/fake.rs"]
mod fake;
#[path = "../../src/picontrol/registry.rs"]
mod registry;
#[path = "../../src/picontrol/rsc.rs"]
mod rsc;

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::abi::{DEVICE_PATH, VariableName, module_type};
use crate::backend::{Backend, RscSource};
use crate::behaviour_table::{Event, Outcome, Proof, TABLE};
use crate::config::PiControlConfig;
use crate::device::{LibcDevice, Opener, PiControl, RawDevice};
use crate::registry::Registry;
use crate::rsc::ProcessMap;

const CHILD_ENV: &str = "SUDERRA_HIL_CHILD";
const WATCHDOG_MS: u32 = 1000;

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_owned())
}

struct Rig {
    rsc: PathBuf,
    pump: String,
    aerator: String,
}

impl Rig {
    fn from_env() -> Self {
        Self {
            rsc: PathBuf::from(env_or("SUDERRA_HIL_RSC", "/etc/revpi/config.rsc")),
            pump: env_or("SUDERRA_HIL_PUMP", "O_1"),
            aerator: env_or("SUDERRA_HIL_AERATOR", "O_2"),
        }
    }

    /// The grant the agent would be given: the pump (safe 0) and the
    /// life-support aerator (safe 1, equal to its PiCtory default).
    fn config(&self) -> PiControlConfig {
        serde_yaml::from_str(&format!(
            "output_watchdog_ms: {WATCHDOG_MS}\npoints:\n  \
             - tag: pump\n    variable: {}\n    direction: output\n  \
             - tag: aerator\n    variable: {}\n    direction: output\n    safe_state_value: 1\n",
            self.pump, self.aerator
        ))
        .expect("grant")
    }

    fn opener(&self) -> Opener {
        Arc::new(|| {
            let dev = LibcDevice::open(Path::new(DEVICE_PATH))?;
            Ok(Arc::new(dev) as Arc<dyn RawDevice>)
        })
    }

    fn backend(&self) -> anyhow::Result<Backend> {
        Backend::open(
            &self.config(),
            250,
            RscSource::File(self.rsc.clone()),
            self.opener(),
        )
    }

    fn map(&self) -> ProcessMap {
        ProcessMap::parse(&std::fs::read(&self.rsc).expect("config.rsc")).expect("config.rsc")
    }

    /// A descriptor of the parent's own, read-only.
    fn observer(&self) -> PiControl {
        PiControl::new(Arc::new(
            LibcDevice::open_read_only(Path::new(DEVICE_PATH)).expect("open /dev/piControl0"),
        ))
    }

    /// `(pump, aerator)` bits in the process image right now.
    fn bits(&self) -> (u8, u8) {
        let map = self.map();
        let image = self.observer().read_image().expect("process image");
        let bit = |name: &str| {
            let v = map
                .variable(&VariableName::new(name).expect("name"))
                .expect("variable in config.rsc");
            (image[usize::from(v.address)] >> v.bit) & 1
        };
        (bit(&self.pump), bit(&self.aerator))
    }
}

fn expected(outcome: Outcome) -> (u8, u8) {
    match outcome {
        // pump safe 0, aerator (life support) safe 1.
        Outcome::SafeValue | Outcome::PiCtoryDefault => (0, 1),
        Outcome::Zero => (0, 0),
        Outcome::ModuleDefault | Outcome::DeEnergised => {
            unreachable!("not observable by the agent")
        }
    }
}

// ---- the child: the agent's backend, in a process that can be killed --------

/// The scenario the parent asked this process to play. Run as a test by the
/// parent (`--exact child_entry`); without the environment variable it is a
/// no-op, so a plain `cargo test` of this file does not play it twice.
#[test]
fn child_entry() {
    let Ok(scenario) = std::env::var(CHILD_ENV) else {
        return;
    };
    let rig = Rig::from_env();
    let backend = rig.backend().expect("the backend opens against the driver");
    // The agent last drove the outputs to the opposite of their safe values.
    backend.write_output("pump", 1.0).expect("drive pump on");
    backend
        .write_output("aerator", 0.0)
        .expect("drive aerator off");
    backend.feed().expect("arm the output watchdog");
    println!("READY");
    match scenario.as_str() {
        "graceful" => {
            backend.drive_safe("pump").expect("safe pump");
            backend.drive_safe("aerator").expect("safe aerator");
            backend.release(true);
            // Dropping the backend closes the descriptors with the watchdog disarmed.
        }
        "safe-state-incomplete" => backend.release(false),
        "crash" => std::process::abort(),
        "stall" => std::thread::sleep(Duration::from_secs(120)),
        "degraded" => {
            backend.drive_safe("pump").expect("safe pump");
            backend.drive_safe("aerator").expect("safe aerator");
            // The loop keeps ticking in degraded mode.
            for _ in 0..(5 * WATCHDOG_MS / 250) {
                std::thread::sleep(Duration::from_millis(250));
                backend.feed().expect("feed");
            }
        }
        other => panic!("unknown scenario {other}"),
    }
}

fn spawn_child(scenario: &str) -> Child {
    Command::new(std::env::current_exe().expect("test binary"))
        .args(["--exact", "child_entry", "--nocapture", "--test-threads=1"])
        .env(CHILD_ENV, scenario)
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn the child scenario")
}

/// Wait until the child printed READY (its outputs are driven and the
/// watchdog is armed).
fn wait_ready(child: &mut Child) {
    use std::io::{BufRead, BufReader};
    let out = child.stdout.as_mut().expect("stdout");
    let mut lines = BufReader::new(out).lines();
    while let Some(line) = lines.next() {
        if line.expect("line").contains("READY") {
            return;
        }
    }
    panic!("the child ended before it was ready");
}

fn run_to_end(scenario: &str) -> std::process::ExitStatus {
    let mut child = spawn_child(scenario);
    wait_ready(&mut child);
    child.wait().expect("child")
}

fn assert_outcome(event: Event, observed: (u8, u8)) {
    let row = behaviour_table::row(event).expect("row");
    assert_eq!(
        row.proof,
        Proof::MockAndHil,
        "{event:?} is not an automated row"
    );
    assert_eq!(
        observed,
        expected(row.outcome),
        "{event:?} ({:?}, {:?}): {}",
        row.layer,
        row.outcome,
        row.note
    );
}

// ---- the tests --------------------------------------------------------------

#[test]
fn the_abi_matches_the_driver() {
    let rig = Rig::from_env();
    let pi = rig.observer();
    let modules = pi.devices().expect("KB_GET_DEVICE_INFO_LIST");
    assert!(!modules.is_empty(), "the driver lists no module");
    let base = modules
        .iter()
        .find(|m| module_type::is_base_module(m.product_type()))
        .expect("a RevPi base module");
    assert_eq!(
        base.product_type(),
        module_type::PI_CONNECT_4,
        "this rig is a Connect 4"
    );
    assert!(
        modules
            .iter()
            .any(|m| module_type::is_io_expansion(m.product_type())),
        "the rig has no DIO/AIO module"
    );
    // KB_FIND_VARIABLE agrees with the file for every variable the file declares.
    let map = rig.map();
    for var in map.variables().take(20) {
        let found = pi
            .find_variable(&var.name)
            .expect("KB_FIND_VARIABLE")
            .unwrap_or_else(|| panic!("the driver does not know {}", var.name));
        assert_eq!(
            (found.address, found.bit, found.length),
            (var.address, var.bit, var.bit_length)
        );
    }
}

#[test]
fn the_registry_verifies_against_the_driver() {
    let rig = Rig::from_env();
    let registry = Registry::build(&rig.config(), &rig.map()).expect("the grant is accepted");
    registry
        .verify(&rig.observer())
        .expect("the driver loaded the signed file");
}

#[test]
fn graceful_restart_leaves_the_safe_values() {
    let rig = Rig::from_env();
    assert!(run_to_end("graceful").success());
    assert_outcome(Event::AgentGracefulRestart, rig.bits());
}

#[test]
fn a_restart_with_an_incomplete_safe_state_is_zeroed_by_the_driver() {
    let rig = Rig::from_env();
    assert!(run_to_end("safe-state-incomplete").success());
    assert_outcome(Event::AgentRestartSafeStateIncomplete, rig.bits());
}

#[test]
fn a_crash_is_zeroed_by_the_driver() {
    let rig = Rig::from_env();
    let status = run_to_end("crash");
    assert!(!status.success(), "the child aborted");
    assert_outcome(Event::AgentCrash, rig.bits());
}

#[test]
fn a_stalled_loop_is_zeroed_within_the_watchdog_period() {
    let rig = Rig::from_env();
    let mut child = spawn_child("stall");
    wait_ready(&mut child);
    assert_eq!(rig.bits(), (1, 0), "driven until the loop stops being fed");
    let started = Instant::now();
    let deadline = started + Duration::from_millis(u64::from(WATCHDOG_MS) * 3);
    let zeroed = loop {
        if rig.bits() == (0, 0) {
            break true;
        }
        if Instant::now() > deadline {
            break false;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    child.kill().expect("kill the stalled child");
    child.wait().expect("reap");
    assert!(zeroed, "not zeroed within 3 x {WATCHDOG_MS} ms");
    eprintln!("stall zeroed the outputs after {:?}", started.elapsed());
    assert_outcome(Event::AgentStall, (0, 0));
}

#[test]
fn degraded_mode_holds_the_safe_values_while_the_loop_keeps_feeding() {
    let rig = Rig::from_env();
    let mut child = spawn_child("degraded");
    wait_ready(&mut child);
    // Several watchdog periods pass while the child feeds.
    std::thread::sleep(Duration::from_millis(u64::from(WATCHDOG_MS) * 3));
    assert_outcome(Event::DegradedEntered, rig.bits());
    assert!(child.wait().expect("child").success());
}

#[test]
fn a_driver_reset_is_reproven_and_leaves_the_pictory_defaults() {
    // The reset needs a privileged descriptor of the test's own: KB_RESET is
    // the one request the agent never issues, so the number lives here and
    // only here (`_IO('K', 12)`, piControl.h).
    const KB_RESET: u64 = ((b'K' as u64) << 8) | 12;
    let rig = Rig::from_env();
    let backend = rig.backend().expect("the backend opens");
    backend.write_output("pump", 1.0).expect("drive pump on");
    backend
        .write_output("aerator", 0.0)
        .expect("drive aerator off");
    assert!(backend.stale_reason().is_none());

    let dev = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(DEVICE_PATH)
        .expect("open for reset");
    use std::os::fd::AsRawFd;
    // SAFETY: KB_RESET takes no argument (`_IO`); the descriptor is open.
    let rc = unsafe { libc::ioctl(dev.as_raw_fd(), KB_RESET as _, 0usize) };
    assert_eq!(rc, 0, "KB_RESET: {}", std::io::Error::last_os_error());

    // The backend gets KB_EVENT_RESET on its own descriptor, proves the layout
    // again and serves writes; until then it refuses them.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match backend.write_output("pump", 0.0) {
            Ok(_) => break,
            Err(e) => {
                assert!(Instant::now() < deadline, "never re-proven: {e}");
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
    assert_outcome(Event::DriverReset, rig.bits());
}

#[test]
fn the_base_module_outputs_are_never_written() {
    let rig = Rig::from_env();
    let map = rig.map();
    let base_outputs: Vec<(u16, u8, String)> = map
        .variables()
        .filter(|v| {
            v.section == rsc::Section::Output
                && map
                    .device(v.device)
                    .is_some_and(|d| module_type::is_base_module(d.product_type))
        })
        .map(|v| (v.address, v.bit, v.name.to_string()))
        .collect();
    assert!(
        !base_outputs.is_empty(),
        "the base module declares outputs (LEDs, X2)"
    );
    let before = rig.observer().read_image().expect("image");

    // A full session of the agent's writer, safe state and watchdog.
    {
        let backend = rig.backend().expect("the backend opens");
        for _ in 0..20 {
            backend.write_output("pump", 1.0).expect("on");
            backend.write_output("pump", 0.0).expect("off");
        }
        backend.write_output("aerator", 0.0).expect("aerator off");
        backend.feed().expect("feed");
        backend.drive_safe("pump").expect("safe");
        backend.drive_safe("aerator").expect("safe");
        backend.release(true);
    }

    let after = rig.observer().read_image().expect("image");
    for (address, bit, name) in base_outputs {
        let a = usize::from(address);
        assert_eq!(
            before[a], after[a],
            "{name} (byte {address}, bit {bit}) of the base module changed during the agent's session"
        );
    }
}

#[test]
fn commissioning_rows_are_listed() {
    eprintln!("Commissioning checklist (DEC-13.1): record the observed behaviour per installation");
    for row in TABLE.iter().filter(|r| r.proof == Proof::Commissioning) {
        eprintln!("  [ ] {:?} ({:?}): {}", row.event, row.layer, row.note);
    }
    assert!(TABLE.iter().any(|r| r.proof == Proof::Commissioning));
}
