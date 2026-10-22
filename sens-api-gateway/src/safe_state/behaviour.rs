//! ADR-048 DEC-13.3 — what each event leaves on an output, which layer decides
//! it, and what the agent itself does about it.
//!
//! The agent is not a safety function (DEC-13.1). What it can do is know, per
//! event and per kind of output, which layer decides the state of the output
//! and act exactly where it is the layer. This table is that knowledge as
//! code: [`behaviour`] is an exhaustive `match`, so an event or an output
//! backend without a row does not compile, and the safe-state pass
//! ([`super::apply_event`]) asks it what to do instead of carrying a second
//! opinion in `main.rs`.
//!
//! # The default policy
//!
//! Every output follows the default policy: **force-safe**. Its safe value is
//! the one the configuration names (`safe_state_value` / `safe_state_level`,
//! EDGE-HIGH-012: a life-support output fails ON, everything else OFF). The
//! per-output policies of DEC-13.2 (`hold-last`, `must-stay-on`, with range,
//! rate and interlock limits) arrive with the signed site config in P2; the
//! table gets its policy dimension then. Until then a row is the behaviour of
//! a force-safe output.
//!
//! # Where the agent can and cannot act
//!
//! * **Before and after a process:** every start drives every output to its
//!   safe value before READY ([`Event::AgentStart`]), and a graceful stop does
//!   it again before the buses are released ([`Event::AgentGracefulStop`]).
//!   Restart, update and the first half of an OS-update reboot are graceful
//!   stops.
//! * **While it is not running:** a crash, a watchdog reset or a power loss
//!   leaves the output to the layers below the agent. That is the point of
//!   DEC-13.1: the agent's own safe-state guarantees exactly what it can
//!   deliver (a SIGTERM or SIGINT stop), and everything else is hardware: the
//!   piControl output watchdog, a module's default, a Modbus device's
//!   communications-loss timer, a normally-open relay. Those are proven
//!   per installation by the commissioning checklist and, on a RevPi, by the
//!   HIL table in `src/picontrol/behaviour_table.rs`.
//! * **While the link to the commander is gone:** outputs a remote command
//!   last wrote are driven safe when the hold of the supervisor expires
//!   ([`AgentAct::DriveSafeLeased`], [`super::comms_loss`]); local control, the
//!   alarms and the safe-state itself never depend on the cloud.

/// An event that happens to a running installation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Event {
    /// The agent starts: after an install, a restart, an update, a crash, a
    /// reboot, a watchdog reset or the return of power. The pass runs before
    /// READY, so no control runtime starts on an output that is not safe.
    AgentStart,
    /// The agent is restarted (SIGTERM or SIGINT, then started again).
    AgentRestart,
    /// The agent is replaced by a newer release: the old one is stopped
    /// gracefully, the new one starts.
    AgentUpdate,
    /// An OS update: the agent is stopped gracefully, then the board reboots.
    OsUpdateReboot,
    /// SIGKILL, an out-of-memory kill, a panic under `panic = "abort"`.
    AgentCrash,
    /// The board's hardware watchdog resets it (a hung kernel or agent).
    WatchdogReset,
    /// The supply drops.
    PowerLoss,
    /// The agent is in degraded mode and stays up (DEC-6.3).
    DegradedMode,
    /// The cloud link stays down past the supervisor's hold.
    CloudCommsLoss,
    /// The agent loses the bus to the device that holds the output (a Modbus
    /// device, a PiBridge module, an I2C chip).
    FieldbusCommsLoss,
    /// An operator triggers the emergency stop (DEC-9.7): the agent latches
    /// the stop and drives the outputs in scope to their safe values.
    EmergencyStop,
}

/// The event the shutdown sequence runs. It cannot tell a restart from an
/// update or an OS-update reboot (the stop is the same SIGTERM), and the table
/// gives the three the same agent act on every backend
/// (`a_graceful_stop_is_one_act`), so the sequence runs this one.
pub const GRACEFUL_STOP: Event = Event::AgentRestart;

impl Event {
    /// Every event, in declaration order.
    pub const ALL: [Event; 11] = [
        Event::AgentStart,
        Event::AgentRestart,
        Event::AgentUpdate,
        Event::OsUpdateReboot,
        Event::AgentCrash,
        Event::WatchdogReset,
        Event::PowerLoss,
        Event::DegradedMode,
        Event::CloudCommsLoss,
        Event::FieldbusCommsLoss,
        Event::EmergencyStop,
    ];

    /// The name used in logs and reports.
    pub const fn name(self) -> &'static str {
        match self {
            Event::AgentStart => "agent-start",
            Event::AgentRestart => "agent-restart",
            Event::AgentUpdate => "agent-update",
            Event::OsUpdateReboot => "os-update-reboot",
            Event::AgentCrash => "agent-crash",
            Event::WatchdogReset => "watchdog-reset",
            Event::PowerLoss => "power-loss",
            Event::DegradedMode => "degraded-mode",
            Event::CloudCommsLoss => "cloud-comms-loss",
            Event::FieldbusCommsLoss => "fieldbus-comms-loss",
            Event::EmergencyStop => "emergency-stop",
        }
    }
}

/// Which kind of hardware holds the output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Backend {
    /// A Modbus device (PLC, relay bank, VFD): outside the agent's board, on
    /// its own supply.
    Modbus,
    /// A GPIO line of the board's SoC.
    Gpio,
    /// An I2C chip (DAC, relay expander).
    I2c,
    /// A RevPi PiBridge module behind the piControl driver.
    PiControl,
}

impl Backend {
    /// Every backend.
    pub const ALL: [Backend; 4] = [
        Backend::Modbus,
        Backend::Gpio,
        Backend::I2c,
        Backend::PiControl,
    ];

    /// The name used in reports.
    pub const fn name(self) -> &'static str {
        match self {
            Backend::Modbus => "modbus",
            Backend::Gpio => "gpio",
            Backend::I2c => "i2c",
            Backend::PiControl => "picontrol",
        }
    }
}

/// What the agent does for an output when the event happens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentAct {
    /// Drive the output to its safe value now (a pass over the registry).
    DriveSafe,
    /// Nothing to drive: the output is already at its safe value (the boot
    /// pass precedes any degraded-mode entry) and the control gate refuses
    /// every write since.
    HoldSafe,
    /// Drive the output to its safe value if a remote command was the last to
    /// write it and the hold has run out (the comms-loss supervisor).
    DriveSafeLeased,
    /// The agent cannot act: it is not running, or it cannot reach the
    /// output. It reports, and the next start runs the boot pass.
    Nothing,
}

impl AgentAct {
    /// The name used in reports.
    pub const fn name(self) -> &'static str {
        match self {
            AgentAct::DriveSafe => "drive-safe",
            AgentAct::HoldSafe => "hold-safe",
            AgentAct::DriveSafeLeased => "drive-safe-leased",
            AgentAct::Nothing => "nothing",
        }
    }
}

/// The layer that decides the state of the output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layer {
    /// The agent's safe-state pass or its supervisor.
    AgentSafeState,
    /// The agent's control gate (degraded mode refuses every write).
    ControlGate,
    /// The level the pin or device keeps without anything driving it.
    Latch,
    /// The piControl driver's output watchdog or default image.
    PiControlDriver,
    /// A Modbus device's own communications-loss timer (DEC-13.5, set at
    /// commissioning).
    DeviceTimer,
    /// The module's firmware default.
    ModuleFirmware,
    /// The relay or the load's wiring.
    Wiring,
}

impl Layer {
    /// The name used in reports.
    pub const fn name(self) -> &'static str {
        match self {
            Layer::AgentSafeState => "agent-safe-state",
            Layer::ControlGate => "control-gate",
            Layer::Latch => "latch",
            Layer::PiControlDriver => "picontrol-driver",
            Layer::DeviceTimer => "device-timer",
            Layer::ModuleFirmware => "module-firmware",
            Layer::Wiring => "wiring",
        }
    }
}

/// What the output ends up as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// The configured safe value.
    SafeValue,
    /// The last commanded value, kept by a latch or by the device.
    LastValue,
    /// Whatever the device or module does by itself (its default, its
    /// timer): not observable by the agent.
    DeviceDefault,
    /// The pin is an input again: the wiring decides.
    Floating,
    /// No supply, no drive.
    DeEnergised,
    /// The event cannot happen to this kind of output (a GPIO pin has no field
    /// bus between it and the agent).
    Unaffected,
}

impl Outcome {
    /// The name used in reports.
    pub const fn name(self) -> &'static str {
        match self {
            Outcome::SafeValue => "safe-value",
            Outcome::LastValue => "last-value",
            Outcome::DeviceDefault => "device-default",
            Outcome::Floating => "floating",
            Outcome::DeEnergised => "de-energised",
            Outcome::Unaffected => "unaffected",
        }
    }
}

/// How a row is proven.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Proof {
    /// By a test that runs without hardware (`cargo test`).
    Automated,
    /// By a test on the hardware (the `hil` feature, a person with a RevPi or
    /// a Raspberry Pi).
    Hardware,
    /// By the commissioning checklist, per installation: wiring, module
    /// defaults, a device's communications-loss timer (DEC-13.1).
    Commissioning,
}

impl Proof {
    /// The name used in reports.
    pub const fn name(self) -> &'static str {
        match self {
            Proof::Automated => "automated",
            Proof::Hardware => "hardware",
            Proof::Commissioning => "commissioning",
        }
    }
}

/// One row of the table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Behaviour {
    pub agent: AgentAct,
    pub layer: Layer,
    pub outcome: Outcome,
    pub proof: Proof,
}

const fn row(agent: AgentAct, layer: Layer, outcome: Outcome, proof: Proof) -> Behaviour {
    Behaviour {
        agent,
        layer,
        outcome,
        proof,
    }
}

/// The agent drives the output safe (the proof depends on whether the backend
/// can be driven without hardware).
const fn drives_safe(backend: Backend) -> Behaviour {
    row(
        AgentAct::DriveSafe,
        Layer::AgentSafeState,
        Outcome::SafeValue,
        match backend {
            // The Modbus actor runs against a TCP server, the piControl handle
            // against the fake kernel: both without hardware.
            Backend::Modbus | Backend::PiControl => Proof::Automated,
            // rppal and the I2C bus need the board.
            Backend::Gpio | Backend::I2c => Proof::Hardware,
        },
    )
}

/// What the table says about `event` on an output held by `backend` (the
/// default force-safe policy).
pub const fn behaviour(event: Event, backend: Backend) -> Behaviour {
    use AgentAct::{DriveSafe, DriveSafeLeased, HoldSafe, Nothing};
    use Backend::{Gpio, I2c, Modbus, PiControl};
    use Layer::{
        AgentSafeState, ControlGate, DeviceTimer, Latch, ModuleFirmware, PiControlDriver, Wiring,
    };
    use Outcome::{DeEnergised, DeviceDefault, Floating, LastValue, SafeValue, Unaffected};
    use Proof::{Automated, Commissioning, Hardware};

    match event {
        // Every start, whatever preceded it.
        Event::AgentStart => drives_safe(backend),
        // A graceful stop drives everything safe before the buses are
        // released; restart, update and the OS-update reboot's first half are
        // that stop. What the reboot does next to the output is the board's.
        Event::AgentRestart | Event::AgentUpdate => drives_safe(backend),
        Event::OsUpdateReboot => match backend {
            // The device is outside the board: it keeps what the stop left.
            Modbus => drives_safe(backend),
            // The SoC resets its pins: inputs until the next start drives
            // them, so the wiring decides in the gap.
            Gpio => row(DriveSafe, Wiring, Floating, Hardware),
            I2c => drives_safe(backend),
            // The driver comes back with the PiCtory defaults, which the
            // registry keeps equal to the safe values.
            PiControl => drives_safe(backend),
        },
        // The agent cannot act; the layers below do.
        Event::AgentCrash => match backend {
            Modbus => row(Nothing, DeviceTimer, DeviceDefault, Commissioning),
            // The latch keeps the last commanded level (the reset on drop is
            // off, and a killed process never runs its drop anyway).
            Gpio => row(Nothing, Latch, LastValue, Hardware),
            I2c => row(Nothing, Latch, LastValue, Hardware),
            // Closing the descriptor of an armed output watchdog zeroes the
            // module's outputs (piControlRelease): the PiCtory default.
            PiControl => row(Nothing, PiControlDriver, DeviceDefault, Hardware),
        },
        Event::WatchdogReset => match backend {
            // The device does not reset with the board.
            Modbus => row(Nothing, DeviceTimer, DeviceDefault, Commissioning),
            Gpio => row(Nothing, Wiring, Floating, Hardware),
            I2c => row(Nothing, Latch, LastValue, Hardware),
            PiControl => row(Nothing, ModuleFirmware, DeviceDefault, Hardware),
        },
        Event::PowerLoss => match backend {
            // An external device has its own supply and its own timer.
            Modbus => row(Nothing, DeviceTimer, DeviceDefault, Commissioning),
            Gpio => row(Nothing, Wiring, DeEnergised, Commissioning),
            I2c => row(Nothing, Wiring, DeEnergised, Commissioning),
            PiControl => row(Nothing, ModuleFirmware, DeEnergised, Commissioning),
        },
        // Degraded mode is entered only after the boot pass, and the gate
        // refuses writes since: the output is at its safe value and stays.
        Event::DegradedMode => row(HoldSafe, ControlGate, SafeValue, Automated),
        // The stop drives every output in scope to its safe value (never a
        // blanket zero: a life-support output fails ON) and latches the control
        // gate; a dead agent cannot stop anything, so there is no row for it.
        Event::EmergencyStop => drives_safe(backend),
        // Remote commands lose their hold; local control continues.
        Event::CloudCommsLoss => row(DriveSafeLeased, AgentSafeState, SafeValue, Automated),
        // The agent cannot write to what it cannot reach.
        Event::FieldbusCommsLoss => match backend {
            Modbus => row(Nothing, DeviceTimer, DeviceDefault, Commissioning),
            // No bus between the agent and the pin.
            Gpio => row(Nothing, Latch, Unaffected, Automated),
            I2c => row(Nothing, Latch, LastValue, Hardware),
            PiControl => row(Nothing, ModuleFirmware, DeviceDefault, Hardware),
        },
    }
}

#[cfg(test)]
impl Event {
    /// The agent is stopped by SIGTERM or SIGINT and runs its shutdown
    /// sequence (restart, update, the OS-update reboot).
    pub const fn is_graceful_stop(self) -> bool {
        matches!(
            self,
            Event::AgentRestart | Event::AgentUpdate | Event::OsUpdateReboot
        )
    }

    /// The board resets or loses its supply, so whatever the agent left on its
    /// own pins is up to the board afterwards.
    pub const fn resets_the_board(self) -> bool {
        matches!(
            self,
            Event::OsUpdateReboot | Event::WatchdogReset | Event::PowerLoss
        )
    }

    /// The process is gone and cannot run anything (crash, reset, no supply).
    pub const fn kills_the_agent(self) -> bool {
        matches!(
            self,
            Event::AgentCrash | Event::WatchdogReset | Event::PowerLoss
        )
    }
}

/// The whole table as the agent reports it (`get_config`), so the cloud and a
/// commissioning engineer read the behaviour the running agent actually
/// follows, not a document that may have drifted from it.
pub fn table_json() -> serde_json::Value {
    let rows: Vec<serde_json::Value> = Event::ALL
        .iter()
        .flat_map(|&event| {
            Backend::ALL.iter().map(move |&backend| {
                let b = behaviour(event, backend);
                serde_json::json!({
                    "event": event.name(),
                    "output": backend.name(),
                    "agent": b.agent.name(),
                    "layer": b.layer.name(),
                    "outcome": b.outcome.name(),
                    "proof": b.proof.name(),
                })
            })
        })
        .collect();
    serde_json::Value::Array(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reported_table_has_one_row_per_event_and_backend() {
        let table = table_json();
        let rows = table.as_array().unwrap();
        assert_eq!(rows.len(), Event::ALL.len() * Backend::ALL.len());
        let keys: std::collections::HashSet<(String, String)> = rows
            .iter()
            .map(|r| {
                (
                    r["event"].as_str().unwrap().to_string(),
                    r["output"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        assert_eq!(keys.len(), rows.len(), "no row twice");
        let crash = rows
            .iter()
            .find(|r| r["event"] == "agent-crash" && r["output"] == "picontrol")
            .unwrap();
        assert_eq!(crash["layer"], "picontrol-driver");
        assert_eq!(crash["agent"], "nothing");
    }

    /// `ALL` lists every variant: the exhaustive matches fail to compile when
    /// a variant is added without being listed here too.
    #[test]
    fn the_enumerations_list_every_variant_once() {
        const fn event_index(e: Event) -> usize {
            match e {
                Event::AgentStart => 0,
                Event::AgentRestart => 1,
                Event::AgentUpdate => 2,
                Event::OsUpdateReboot => 3,
                Event::AgentCrash => 4,
                Event::WatchdogReset => 5,
                Event::PowerLoss => 6,
                Event::DegradedMode => 7,
                Event::CloudCommsLoss => 8,
                Event::FieldbusCommsLoss => 9,
                Event::EmergencyStop => 10,
            }
        }
        const fn backend_index(b: Backend) -> usize {
            match b {
                Backend::Modbus => 0,
                Backend::Gpio => 1,
                Backend::I2c => 2,
                Backend::PiControl => 3,
            }
        }
        for (i, e) in Event::ALL.iter().enumerate() {
            assert_eq!(event_index(*e), i, "{e:?}");
        }
        for (i, b) in Backend::ALL.iter().enumerate() {
            assert_eq!(backend_index(*b), i, "{b:?}");
        }
        let names: std::collections::HashSet<_> = Event::ALL.iter().map(|e| e.name()).collect();
        assert_eq!(names.len(), Event::ALL.len(), "event names are unique");
    }

    /// The agent acts exactly where it is the layer that decides the output.
    #[test]
    fn a_row_says_the_agent_acts_only_where_the_agent_decides() {
        for event in Event::ALL {
            for backend in Backend::ALL {
                let b = behaviour(event, backend);
                let agent_layer = matches!(b.layer, Layer::AgentSafeState | Layer::ControlGate);
                let acts = !matches!(b.agent, AgentAct::Nothing);
                if !acts {
                    assert!(
                        !agent_layer,
                        "{event:?}/{backend:?}: the agent decides but does nothing: {b:?}"
                    );
                } else if !event.resets_the_board() {
                    assert!(
                        agent_layer,
                        "{event:?}/{backend:?}: the agent acts but another layer decides: {b:?}"
                    );
                }
                // The configured safe value is the outcome only when the agent
                // put it there (or it was already there).
                if b.outcome == Outcome::SafeValue {
                    assert!(
                        acts,
                        "{event:?}/{backend:?}: SafeValue without an agent act"
                    );
                }
                // A pass that drives an output safe leaves it safe, unless the
                // event also resets the board and the layer after the reset
                // decides (the OS-update reboot's GPIO pins).
                if matches!(b.agent, AgentAct::DriveSafe | AgentAct::DriveSafeLeased)
                    && !event.resets_the_board()
                {
                    assert_eq!(b.outcome, Outcome::SafeValue, "{event:?}/{backend:?}");
                    assert_eq!(b.layer, Layer::AgentSafeState, "{event:?}/{backend:?}");
                }
            }
        }
    }

    /// Every event that stops the agent gracefully drives every output safe
    /// before the buses go: the guarantee DEC-13 states and the only one the
    /// agent's own code can give.
    #[test]
    fn a_graceful_stop_drives_every_backend_safe() {
        for event in Event::ALL.into_iter().filter(|e| e.is_graceful_stop()) {
            for backend in Backend::ALL {
                assert_eq!(
                    behaviour(event, backend).agent,
                    AgentAct::DriveSafe,
                    "{event:?}/{backend:?}"
                );
            }
        }
    }

    /// The shutdown sequence runs one event for every graceful stop, which is
    /// only right if the table prescribes the same agent act for all of them.
    #[test]
    fn a_graceful_stop_is_one_act() {
        assert!(GRACEFUL_STOP.is_graceful_stop());
        for backend in Backend::ALL {
            let reference = behaviour(GRACEFUL_STOP, backend).agent;
            for event in Event::ALL.into_iter().filter(|e| e.is_graceful_stop()) {
                assert_eq!(
                    behaviour(event, backend).agent,
                    reference,
                    "{event:?}/{backend:?}"
                );
            }
        }
    }

    /// An event that kills the process leaves the outputs to hardware, and the
    /// way back is one thing: the boot pass drives every output safe.
    #[test]
    fn a_dead_agent_leaves_the_outputs_to_hardware_and_every_start_drives_them_safe() {
        for event in Event::ALL.into_iter().filter(|e| e.kills_the_agent()) {
            for backend in Backend::ALL {
                let b = behaviour(event, backend);
                assert_eq!(b.agent, AgentAct::Nothing, "{event:?}/{backend:?}");
                assert_ne!(
                    b.outcome,
                    Outcome::SafeValue,
                    "{event:?}/{backend:?}: a dead agent does not make an output safe"
                );
            }
        }
        for backend in Backend::ALL {
            assert_eq!(
                behaviour(Event::AgentStart, backend).agent,
                AgentAct::DriveSafe,
                "{backend:?}"
            );
        }
    }

    /// What no test and no agent can prove is named as such: the rows that
    /// depend on wiring, module defaults or a device's own timer are the
    /// commissioning checklist's, and the rows that need a board are the
    /// hardware tests'.
    #[test]
    fn rows_the_agent_cannot_prove_are_labelled_commissioning_or_hardware() {
        for event in Event::ALL {
            for backend in Backend::ALL {
                let b = behaviour(event, backend);
                if matches!(b.layer, Layer::Wiring | Layer::DeviceTimer) {
                    assert!(
                        matches!(b.proof, Proof::Commissioning | Proof::Hardware),
                        "{event:?}/{backend:?}: {b:?}"
                    );
                }
                if b.proof == Proof::Automated {
                    assert!(
                        matches!(
                            b.layer,
                            Layer::AgentSafeState | Layer::ControlGate | Layer::Latch
                        ),
                        "{event:?}/{backend:?}: an automated proof of a layer outside the agent: {b:?}"
                    );
                }
            }
        }
    }
}
