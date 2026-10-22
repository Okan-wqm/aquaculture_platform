//! The mock-backed variant of the output behaviour table
//! ([`super::behaviour_table`], ADR-048 DEC-13.3): every row the agent and the
//! driver own is played against the fake kernel and the outcome compared with
//! the table. `tests/hil/output_behaviour_table.rs` plays the same rows
//! against a real RevPi.
//!
//! Two outputs of one DIO module tell the outcomes apart: `pump` (safe value
//! 0) and `aerator` (a life-support output, safe value 1, PiCtory default 1).
//! The agent last drove them to the opposite of their safe values, so a
//! restored safe value reads `pump=0 aerator=1`, a watchdog zeroing reads
//! `pump=0 aerator=0`, and an output left as the agent drove it reads
//! `pump=1 aerator=0`.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

use std::sync::Arc;
use std::time::{Duration, Instant};

use super::backend::RscSource;
use super::behaviour_table::{Event, Outcome, Proof, TABLE};
use super::device::Opener;
use super::fake::FakeKernel;
use super::handle::PiControlHandle;
use super::rsc::sample;
use crate::degraded::{Backend as DegradedBackend, DegradedMode, DegradedReason};
use crate::scripting::force_registry::ForceRegistry;

const GRANT: &str = r#"
output_watchdog_ms: 1000
points:
  - tag: pump
    variable: O_1
    direction: output
  - tag: aerator
    variable: O_2
    direction: output
    safe_state_value: 1
"#;

/// The bits of the two outputs after an event: `(pump, aerator)`.
type Bits = (u8, u8);

struct Rig {
    kernel: Arc<FakeKernel>,
    handle: PiControlHandle,
    degraded: DegradedMode,
    _dir: tempfile::TempDir,
}

fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let degraded = DegradedMode::new(dir.path().join("health.json"));
    let kernel = FakeKernel::sample();
    let opener: Opener = {
        let k = kernel.clone();
        Arc::new(move || Ok(k.open()))
    };
    let handle = PiControlHandle::open(
        &serde_yaml::from_str(GRANT).unwrap(),
        250,
        RscSource::Verified(sample::rsc().into_bytes().into()),
        degraded.control_gate(),
        Arc::new(ForceRegistry::new()),
        opener,
    )
    .unwrap();
    Rig {
        kernel,
        handle,
        degraded,
        _dir: dir,
    }
}

fn bits(kernel: &FakeKernel) -> Bits {
    let b = kernel.peek(122);
    (b & 1, (b >> 1) & 1)
}

/// The agent runs: it drove `pump` on and `aerator` off (the opposite of
/// their safe values) and feeds the watchdog.
async fn running() -> Rig {
    let r = rig();
    r.handle.write_output("pump", 1.0).await.unwrap();
    r.handle.write_output("aerator", 0.0).await.unwrap();
    r.handle.feed();
    assert_eq!(
        bits(&r.kernel),
        (1, 0),
        "precondition: driven off their safe values"
    );
    r
}

fn safe_state(r: &Rig) {
    let token = crate::safe_state::test_capability();
    r.handle.drive_safe("pump", &token).unwrap();
    r.handle.drive_safe("aerator", &token).unwrap();
}

async fn observe(event: Event) -> Option<Bits> {
    match event {
        Event::AgentGracefulRestart => {
            let r = running().await;
            safe_state(&r);
            r.handle.release(true);
            let kernel = r.kernel.clone();
            drop(r);
            Some(bits(&kernel))
        }
        Event::AgentRestartSafeStateIncomplete => {
            let r = running().await;
            r.handle.release(false);
            let kernel = r.kernel.clone();
            drop(r);
            Some(bits(&kernel))
        }
        Event::AgentCrash => {
            // The process dies: nothing disarms, the kernel closes the descriptors.
            let r = running().await;
            let kernel = r.kernel.clone();
            drop(r);
            Some(bits(&kernel))
        }
        Event::AgentStall => {
            let r = running().await;
            // The loop stops: no feed for longer than the period.
            r.kernel.advance_ms(1001);
            Some(bits(&r.kernel))
        }
        Event::FieldbusStall => {
            let r = running().await;
            Some(stalled_call(&r, FEEDING).await)
        }
        Event::DegradedEntered => {
            let r = running().await;
            safe_state(&r);
            r.degraded.enter(DegradedReason::BackendUnavailable {
                backend: DegradedBackend::Gpio,
                detail: "another backend failed".into(),
            });
            // The loop keeps ticking, and a writer is refused.
            for _ in 0..8 {
                r.kernel.advance_ms(500);
                r.handle.feed();
            }
            assert!(r.handle.write_output("pump", 1.0).await.is_err());
            Some(bits(&r.kernel))
        }
        Event::DriverReset => {
            let r = running().await;
            r.kernel.reset_driver();
            let start = Instant::now();
            while r.handle.stale_reason().is_some()
                || r.handle.write_output("pump", 0.0).await.is_err()
            {
                assert!(
                    start.elapsed() < Duration::from_secs(5),
                    "layout never re-proven"
                );
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            // The default image is what the reset left; the probe above wrote the
            // safe value of `pump` only.
            Some((r.kernel.peek(122) & 1, (r.kernel.peek(122) >> 1) & 1))
        }
        Event::OsRebootGraceful
        | Event::HardwareWatchdogReset
        | Event::PowerLoss
        | Event::ModuleCommsLoss => None,
    }
}

/// How long the loop has made no progress, as the feeder sees it.
type Stalled = fn() -> Duration;

/// A loop that has made progress just now.
const FEEDING: Stalled = || Duration::ZERO;
/// A loop whose call has outlived every bound.
const PAST_THE_BOUND: Stalled = || Duration::from_secs(3600);

/// One call of the I/O loop stays in flight for four watchdog periods of the
/// fake kernel's clock (ten steps of 400 ms, each a real 20 ms), and the loop
/// feeds the way `io_poll` does. Returns the outputs afterwards.
async fn stalled_call(r: &Rig, stalled_for: Stalled) -> Bits {
    let kernel = r.kernel.clone();
    let handle = r.handle.clone();
    let call = async move {
        for _ in 0..10 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            kernel.advance_ms(400);
        }
    };
    super::feed::while_feeding(
        call,
        Duration::from_millis(5),
        Duration::from_secs(60),
        stalled_for,
        || handle.feed(),
    )
    .await;
    bits(&r.kernel)
}

fn expected(outcome: Outcome) -> Bits {
    match outcome {
        // What control last wrote: the opposite of the safe values.
        Outcome::Unchanged => (1, 0),
        // pump safe 0, aerator (life support) safe 1.
        Outcome::SafeValue | Outcome::PiCtoryDefault => (0, 1),
        Outcome::Zero => (0, 0),
        Outcome::ModuleDefault | Outcome::DeEnergised => {
            unreachable!("not observable by the agent")
        }
    }
}

#[tokio::test]
async fn every_row_the_agent_and_the_driver_own_behaves_as_the_table_says() {
    for row in TABLE {
        let observed = observe(row.event).await;
        match row.proof {
            Proof::MockAndHil => {
                assert_eq!(
                    observed,
                    Some(expected(row.outcome)),
                    "{:?} ({:?}, {:?}): {}",
                    row.event,
                    row.layer,
                    row.outcome,
                    row.note
                );
            }
            Proof::Commissioning => assert_eq!(
                observed, None,
                "{:?} cannot be played without the hardware",
                row.event
            ),
        }
    }
}

/// The stall test has teeth: with the feed withheld (a call past every bound)
/// the same four periods zero the outputs, which is what a loop that fed only
/// when a cycle completed did to a healthy agent whenever a Modbus device did
/// not answer.
#[tokio::test]
async fn a_call_past_the_bound_is_not_fed_and_the_driver_zeroes_the_outputs() {
    let r = running().await;
    assert_eq!(stalled_call(&r, PAST_THE_BOUND).await, (0, 0));
}

#[tokio::test]
async fn a_crash_zeroes_the_life_support_output_and_a_graceful_restart_does_not() {
    // The two behaviours the commissioning checklist (DEC-13.1) must tell the
    // customer: the driver's zeroing is why a life-support output needs
    // independent, fail-safe wiring, and why the agent disarms only after the
    // safe state.
    assert_eq!(observe(Event::AgentCrash).await, Some((0, 0)));
    assert_eq!(observe(Event::AgentGracefulRestart).await, Some((0, 1)));
}
