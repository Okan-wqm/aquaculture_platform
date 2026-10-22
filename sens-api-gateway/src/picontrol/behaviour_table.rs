//! ADR-048 DEC-13.3 for the RevPi: what each event leaves on a PiBridge
//! output, and which layer makes it so.
//!
//! The agent is not a safety function (DEC-13.1). What it can do is know,
//! per event, which layer decides the state of an output, and prove it. This
//! table is that knowledge as data: the mock-backed tests
//! (`src/picontrol/behaviour_tests.rs`, run by `cargo test`) and the hardware
//! test (`tests/hil/output_behaviour_table.rs`, run on a RevPi Connect 4 with
//! a DIO module, `--features hil`) are driven by the same rows, so the two
//! cannot describe different machines.
//!
//! The rows are about one output the agent last drove to a value that is not
//! its safe value, with `safe_state_value` equal to the default `config.rsc`
//! declares for it (the registry refuses any other, so an output's safe value
//! and the driver's reset default are one number).
//!
//! # Where each outcome comes from (piControl v2.6.2, the release the image builds)
//!
//! * `piControlRelease()` zeroes every active module's output range when a
//!   descriptor with an armed output watchdog closes. A process that dies has
//!   its descriptors closed by the kernel, so a crash zeroes the outputs; a
//!   process that exits cleanly disarms first (see `Backend::release`).
//! * `revpi_check_timeout()` zeroes the same ranges, from the driver's I/O
//!   thread, when the watchdog's period passed without a write, a `KB_SET_VALUE`
//!   or a re-arm on the descriptor that armed it, and again every period while
//!   it stays unfed.
//! * `PiBridgeMaster_setDefaults()` rebuilds the default image from the
//!   defaults of `config.rsc`, and the PiBridge start copies it over the whole
//!   process image: a driver reset or a PiBridge restart puts every variable
//!   at its PiCtory default.
//! * What a module does with its outputs when the PiBridge goes quiet, when it
//!   is power-cycled, or when the board resets is module firmware and wiring
//!   (a normally-open or normally-closed relay): the agent can neither
//!   observe nor change it, and DEC-13.1 puts life-support outputs on
//!   independent, fail-safe wiring for exactly that reason.

/// An event that happens to a running installation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    /// SIGTERM: the agent stops, its safe-state pass completes.
    AgentGracefulRestart,
    /// SIGTERM, but a safe value could not be written (module absent, layout
    /// not proven).
    AgentRestartSafeStateIncomplete,
    /// SIGKILL, an OOM kill, a panic under `panic = "abort"`.
    AgentCrash,
    /// The process lives, the control loop does not tick: no feed (the loop
    /// task is wedged, or a call has not returned within the longest bound any
    /// call has).
    AgentStall,
    /// A call of the I/O loop to a field-bus device stays in flight (a Modbus
    /// device that does not answer, a row of slow I2C probes) while the loop
    /// itself is alive: the watchdog keeps being fed.
    FieldbusStall,
    /// The agent enters degraded mode and stays up.
    DegradedEntered,
    /// Root loads a new `config.rsc` into the driver (a site config update).
    DriverReset,
    /// A graceful OS update reboot: agent stopped first, then the board.
    OsRebootGraceful,
    /// The board's hardware watchdog resets it.
    HardwareWatchdogReset,
    /// The supply drops.
    PowerLoss,
    /// A module stops answering on the PiBridge (cable, module fault).
    ModuleCommsLoss,
}

/// What decides the state of the output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layer {
    /// The agent's safe-state pass.
    AgentSafeState,
    /// The agent's control gate: degraded mode refuses every writer but the
    /// safe-state pass.
    ControlGate,
    /// The agent's I/O loop, which feeds the output watchdog while it is alive.
    ControlLoop,
    /// The driver's per-descriptor output watchdog (timeout or close).
    PiControlWatchdog,
    /// The driver's default image (`config.rsc` defaults).
    PiControlDefaults,
    /// The module's own firmware default.
    ModuleFirmware,
    /// The relay or the load's wiring.
    Wiring,
}

/// What the output ends up as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// The configured `safe_state_value`.
    SafeValue,
    /// 0, all bits.
    Zero,
    /// The `config.rsc` default (equal to the safe value by registry rule).
    PiCtoryDefault,
    /// Whatever the module firmware does (not observable by the agent).
    ModuleDefault,
    /// No supply, no drive.
    DeEnergised,
    /// What control last wrote: the event does not reach the output.
    Unchanged,
}

/// How a row is proven.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Proof {
    /// Against the fake kernel in `cargo test`, and automatically on a RevPi
    /// in `tests/hil` (the HIL test runs the agent's backend in a child
    /// process and kills, stalls or stops it).
    MockAndHil,
    /// Only a person with the hardware can do it (pull the PiBridge cable,
    /// cut the power): the commissioning checklist (DEC-13.1) records it per
    /// installation; no automated test can.
    Commissioning,
}

/// One row.
#[derive(Debug, Clone, Copy)]
pub struct Row {
    /// Which event the row is the answer to: how the mock-backed tests and the
    /// hardware test identify it (the production lookup is [`row`]).
    #[cfg_attr(not(test), allow(dead_code))]
    pub event: Event,
    pub layer: Layer,
    pub outcome: Outcome,
    pub proof: Proof,
    pub note: &'static str,
}

// One constant per row, so the table and the lookup below are the same
// definitions: the lookup names a row, it never indexes into the table.
const AGENT_GRACEFUL_RESTART: Row = Row {
    event: Event::AgentGracefulRestart,
    layer: Layer::AgentSafeState,
    outcome: Outcome::SafeValue,
    proof: Proof::MockAndHil,
    note: "safe values first, then the watchdog is disarmed, then the descriptor closes: \
           nothing zeroes the outputs, so a life-support output stays on across a restart",
};

const AGENT_RESTART_SAFE_STATE_INCOMPLETE: Row = Row {
    event: Event::AgentRestartSafeStateIncomplete,
    layer: Layer::PiControlWatchdog,
    outcome: Outcome::Zero,
    proof: Proof::MockAndHil,
    note: "the watchdog stays armed when a safe value is missing, so the driver zeroes the \
           outputs at close rather than leaving an unknown state",
};

const AGENT_CRASH: Row = Row {
    event: Event::AgentCrash,
    layer: Layer::PiControlWatchdog,
    outcome: Outcome::Zero,
    proof: Proof::MockAndHil,
    note: "the kernel closes the descriptor of a dead process while the watchdog is armed, \
           and piControlRelease() zeroes every active module's outputs: ZERO, not the \
           PiCtory default, so a fail-ON output (an aerator) goes OFF. Arming the watchdog \
           is what makes a crash zero the outputs; a life-support output needs independent \
           fail-safe wiring (DEC-13.1), and whether an output is under the watchdog at all \
           is a per-output decision (DEC-13.2, tracked under EDGE-HIGH-065)",
};

const AGENT_STALL: Row = Row {
    event: Event::AgentStall,
    layer: Layer::PiControlWatchdog,
    outcome: Outcome::Zero,
    proof: Proof::MockAndHil,
    note: "within output_watchdog_ms of the last feed, independent of systemd's 60 s watchdog; \
           the feed stops when the loop task is not polled at all, and when a call has made \
           no progress for longer than the longest bound a call has (the Modbus phase of the \
           cycle, plus a margin)",
};

const FIELDBUS_STALL: Row = Row {
    event: Event::FieldbusStall,
    layer: Layer::ControlLoop,
    outcome: Outcome::Unchanged,
    proof: Proof::MockAndHil,
    note: "the loop feeds the watchdog while a bounded call is in flight, so an unrelated \
           device that does not answer neither zeroes the outputs of a healthy agent nor \
           changes them; a call that outlives its bound is an AgentStall",
};

const DEGRADED_ENTERED: Row = Row {
    event: Event::DegradedEntered,
    layer: Layer::ControlGate,
    outcome: Outcome::SafeValue,
    proof: Proof::MockAndHil,
    note: "the loop keeps feeding the watchdog while degraded, so the safe values are held \
           and nothing is zeroed; every writer but the safe-state pass is refused",
};

const DRIVER_RESET: Row = Row {
    event: Event::DriverReset,
    layer: Layer::PiControlDefaults,
    outcome: Outcome::PiCtoryDefault,
    proof: Proof::MockAndHil,
    note: "the PiBridge start copies the default image over the process image; the agent \
           refuses writes until it proves the new layout, and the registry guarantees the \
           default is the safe value",
};

const OS_REBOOT_GRACEFUL: Row = Row {
    event: Event::OsRebootGraceful,
    layer: Layer::ModuleFirmware,
    outcome: Outcome::ModuleDefault,
    proof: Proof::Commissioning,
    note: "the modules lose and regain their PiBridge supply; until the agent's boot \
           safe-state pass the module firmware decides",
};

const HARDWARE_WATCHDOG_RESET: Row = Row {
    event: Event::HardwareWatchdogReset,
    layer: Layer::ModuleFirmware,
    outcome: Outcome::ModuleDefault,
    proof: Proof::Commissioning,
    note: "as a reboot, without the agent's graceful stop",
};

const POWER_LOSS: Row = Row {
    event: Event::PowerLoss,
    layer: Layer::Wiring,
    outcome: Outcome::DeEnergised,
    proof: Proof::Commissioning,
    note: "normally-open or normally-closed relay selection decides the plant's state",
};

const MODULE_COMMS_LOSS: Row = Row {
    event: Event::ModuleCommsLoss,
    layer: Layer::ModuleFirmware,
    outcome: Outcome::ModuleDefault,
    proof: Proof::Commissioning,
    note: "the agent sees the module inactive (its tags go to communication failure) but \
           cannot drive it; the module's behaviour on a silent bus is firmware",
};

/// The table.
pub const TABLE: &[Row] = &[
    AGENT_GRACEFUL_RESTART,
    AGENT_RESTART_SAFE_STATE_INCOMPLETE,
    AGENT_CRASH,
    AGENT_STALL,
    FIELDBUS_STALL,
    DEGRADED_ENTERED,
    DRIVER_RESET,
    OS_REBOOT_GRACEFUL,
    HARDWARE_WATCHDOG_RESET,
    POWER_LOSS,
    MODULE_COMMS_LOSS,
];

/// The row of an event. Exhaustive over [`Event`]: an event without a row does
/// not compile, so the lookup cannot fail.
pub const fn row(event: Event) -> &'static Row {
    match event {
        Event::AgentGracefulRestart => &AGENT_GRACEFUL_RESTART,
        Event::AgentRestartSafeStateIncomplete => &AGENT_RESTART_SAFE_STATE_INCOMPLETE,
        Event::AgentCrash => &AGENT_CRASH,
        Event::AgentStall => &AGENT_STALL,
        Event::FieldbusStall => &FIELDBUS_STALL,
        Event::DegradedEntered => &DEGRADED_ENTERED,
        Event::DriverReset => &DRIVER_RESET,
        Event::OsRebootGraceful => &OS_REBOOT_GRACEFUL,
        Event::HardwareWatchdogReset => &HARDWARE_WATCHDOG_RESET,
        Event::PowerLoss => &POWER_LOSS,
        Event::ModuleCommsLoss => &MODULE_COMMS_LOSS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_event_has_exactly_one_row() {
        let events = [
            Event::AgentGracefulRestart,
            Event::AgentRestartSafeStateIncomplete,
            Event::AgentCrash,
            Event::AgentStall,
            Event::FieldbusStall,
            Event::DegradedEntered,
            Event::DriverReset,
            Event::OsRebootGraceful,
            Event::HardwareWatchdogReset,
            Event::PowerLoss,
            Event::ModuleCommsLoss,
        ];
        for e in events {
            assert_eq!(TABLE.iter().filter(|r| r.event == e).count(), 1, "{e:?}");
            assert_eq!(row(e).event, e, "{e:?}");
        }
        assert_eq!(TABLE.len(), events.len());
    }

    #[test]
    fn rows_the_agent_can_prove_name_a_layer_the_agent_or_the_driver_owns() {
        for r in TABLE {
            let owned = matches!(
                r.layer,
                Layer::AgentSafeState
                    | Layer::ControlGate
                    | Layer::ControlLoop
                    | Layer::PiControlWatchdog
                    | Layer::PiControlDefaults
            );
            assert_eq!(
                r.proof == Proof::MockAndHil,
                owned,
                "{:?}: only agent- and driver-owned layers can be tested without a person",
                r.event
            );
        }
    }
}
