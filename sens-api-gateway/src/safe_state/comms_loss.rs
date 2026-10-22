//! The communications-loss supervisor (ADR-048 DEC-13.3, EDGE-HIGH-065).
//!
//! Fail-safe used to be a property of the process lifecycle only: at boot and
//! at a graceful stop. Nothing owned the question "what do outputs do when the
//! commander disappears", so an actuator a remote operator had switched on
//! stayed on for as long as the cloud stayed away: a feeder keeps feeding, a
//! valve stays open.
//!
//! What this supervisor owns, and what it does not:
//!
//! * **Remote commands carry a hold.** Every actuator write that arrived as a
//!   command from the cloud records its output in [`RemoteHolds`]. While the
//!   link is up nothing happens, whatever was commanded stays.
//! * **The hold runs out with the link.** When the MQTT link has been down for
//!   `safe_state.cloud_loss_hold_secs`, the outputs a remote command last wrote
//!   are driven to their configured safe value ([`Event::CloudCommsLoss`] in the
//!   behaviour table). The safe value is the output's own: a life-support
//!   output fails ON, so the same rule keeps an aerator running and stops a
//!   feeder.
//! * **Local control is not touched.** Scripts, the bytecode scan cycle, the
//!   HMI and the alarm engine run on the board and need no cloud; an output
//!   they write is not a remote hold (the supervisor only drives what a remote
//!   command wrote), and a local writer that takes the output over simply
//!   writes it again. Nothing in the supervisor reads a wall clock: the hold is
//!   a monotonic duration, so an unsynchronised clock cannot shorten or extend
//!   it (DEC-7).
//! * **A bus that is gone cannot be driven.** A device the agent lost is the
//!   device's own communications-loss timer's to handle (DEC-13.5, set at
//!   commissioning); the table says so, and the supervisor only reports.
//!
//! The hold has a floor and a ceiling ([`MIN_HOLD_SECS`], [`MAX_HOLD_SECS`]):
//! there is no value that means "hold for ever", because that is the defect.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{RwLock, broadcast};
use tokio::time::Instant;
use tracing::{debug, error, info, warn};

use super::{OutputId, OwnedOutputHandles, apply_leased};
use crate::AppState;

/// The shortest hold (seconds): below it a broker reconnect would drive
/// outputs safe.
pub const MIN_HOLD_SECS: u32 = 10;
/// The longest hold (seconds): one day.
pub const MAX_HOLD_SECS: u32 = 86_400;
/// The default hold (seconds): five minutes, the bound ADR-024 gives a
/// life-support dosing output's `HoldLastKnownGood`.
pub const DEFAULT_HOLD_SECS: u32 = 300;

// The bounds are checked when the crate compiles: no floor of zero, no ceiling
// that reads as "for ever", and a default that lies between them.
const _: () = {
    assert!(MIN_HOLD_SECS > 0);
    assert!(MAX_HOLD_SECS < u32::MAX);
    assert!(MIN_HOLD_SECS <= DEFAULT_HOLD_SECS && DEFAULT_HOLD_SECS <= MAX_HOLD_SECS);
};

/// How often the supervisor looks at the link.
const TICK: Duration = Duration::from_secs(1);

/// The outputs a remote command last wrote.
///
/// Cloned into every handler that executes a remote actuator write and into
/// the supervisor: they share one set.
#[derive(Debug, Clone, Default)]
pub struct RemoteHolds {
    outputs: Arc<Mutex<HashSet<OutputId>>>,
}

impl RemoteHolds {
    /// A remote command wrote `output`.
    pub fn record(&self, output: OutputId) {
        self.lock().insert(output);
    }

    /// Every recorded output, leaving the set empty.
    pub fn take(&self) -> Vec<OutputId> {
        self.lock().drain().collect()
    }

    /// How many outputs are held.
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    /// Whether no output is held.
    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashSet<OutputId>> {
        match self.outputs.lock() {
            Ok(guard) => guard,
            // A poisoned set is still a set of outputs; the supervisor must
            // not stop driving them because some other thread panicked.
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

/// What the link has been doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The link is up.
    Up,
    /// The link is down, the hold has not run out.
    Down,
    /// The link has been down for the whole hold (and still is).
    HoldExpired,
}

/// The link watch: a monotonic count of how long the link has been down.
///
/// The link counts as down from the moment the watch starts: a supervisor that
/// starts before the first connection has no evidence of a commander, and the
/// hold then starts at once.
#[derive(Debug)]
pub struct LinkWatch {
    hold: Duration,
    down_since: Option<Instant>,
}

impl LinkWatch {
    pub fn new(hold: Duration, now: Instant) -> Self {
        Self {
            hold,
            down_since: Some(now),
        }
    }

    /// Feed one observation.
    pub fn observe(&mut self, connected: bool, now: Instant) -> Verdict {
        if connected {
            self.down_since = None;
            return Verdict::Up;
        }
        let since = *self.down_since.get_or_insert(now);
        if now.saturating_duration_since(since) >= self.hold {
            Verdict::HoldExpired
        } else {
            Verdict::Down
        }
    }
}

/// Whether the cloud link is up now: the MQTT client's own link state, which its
/// event loop clears on every way the connection can be lost. No client yet
/// (the connectivity task has not created it) is no link.
fn link_is_up(state: &AppState) -> bool {
    state
        .mqtt_client
        .as_ref()
        .is_some_and(crate::mqtt::MqttClient::is_connected)
}

/// How the supervisor retries a hold it could not drive safe: an output on a
/// device the agent cannot reach fails again as long as the device is away, so a
/// retry every tick would only repeat the failure, hold a field-bus timeout each
/// time and fill the journal. It backs off from one tick to a minute, and the
/// episode is announced once.
#[derive(Debug)]
struct Retry {
    delay: Duration,
    next: Option<Instant>,
    attempts: u32,
}

impl Retry {
    /// The longest wait between two attempts.
    const MAX_DELAY: Duration = Duration::from_secs(60);

    fn new() -> Self {
        Self {
            delay: TICK,
            next: None,
            attempts: 0,
        }
    }

    /// Whether an attempt may be made at `now`.
    fn due(&self, now: Instant) -> bool {
        self.next.is_none_or(|at| now >= at)
    }

    /// Whether no attempt of this episode was made yet (the one that announces).
    fn is_first(&self) -> bool {
        self.attempts == 0
    }

    /// An attempt left outputs held.
    fn failed(&mut self, now: Instant) {
        self.attempts = self.attempts.saturating_add(1);
        self.next = Some(now + self.delay);
        self.delay = (self.delay * 2).min(Self::MAX_DELAY);
    }

    /// The episode is over (the link is back, or nothing is held).
    fn reset(&mut self) {
        *self = Self::new();
    }
}

/// Drive the leased outputs safe: the work of one expired hold. Returns how
/// many outputs are still held (could not be driven, to be tried again).
///
/// Outputs that could not be driven are recorded again, so the next attempt
/// tries them once more; a leased id that is not a registered output has no safe
/// value and is dropped with a warning. `announce` is true for the first attempt
/// of an episode: only that one is logged above debug level.
///
/// The `AppState` lock is held only to copy what the pass needs (the
/// configuration and clones of the handles): a device that does not answer
/// must not keep it for the field-bus timeout.
pub async fn expire_holds(
    state: &Arc<RwLock<AppState>>,
    holds: &RemoteHolds,
    announce: bool,
) -> usize {
    let leased = holds.take();
    if leased.is_empty() {
        return 0;
    }
    if announce {
        // LIFE-SAFETY: loud marker so log analysis tools can find this event.
        error!(
            "LIFE-SAFETY: the cloud link is down past the hold; driving {} remotely commanded \
             output(s) to their safe value",
            leased.len()
        );
    } else {
        debug!(
            "the cloud link is still down: driving {} remotely commanded output(s) to their safe \
             value again",
            leased.len()
        );
    }
    let (config, handles) = {
        let s = state.read().await;
        (s.config.clone(), OwnedOutputHandles::of(&s))
    };
    let (report, unregistered) = apply_leased(&config, &leased, handles.handles()).await;
    for id in &unregistered {
        warn!(
            "{id} was written by a remote command but is not a safe-state output: no safe value is known for it"
        );
    }
    let mut retained = 0;
    for id in &leased {
        let failed = report.failures.iter().any(|f| f.output == id.to_string());
        if failed {
            holds.record(id.clone());
            retained += 1;
        }
    }
    if retained > 0 {
        let why: Vec<String> = report
            .failures
            .iter()
            .map(|f| format!("{}: {}", f.output, f.error))
            .collect();
        if announce {
            error!(
                "LIFE-SAFETY: {retained} remotely commanded output(s) could not be driven to their \
                 safe value and are tried again with backoff: {}",
                why.join("; ")
            );
        } else {
            debug!(
                "{retained} output(s) still not at their safe value: {}",
                why.join("; ")
            );
        }
    } else if report.is_complete() {
        info!(
            "LIFE-SAFETY: {} remotely commanded output(s) are at their safe value",
            report.applied
        );
    }
    retained
}

/// Run the supervisor until shutdown.
pub async fn run_supervisor(
    state: Arc<RwLock<AppState>>,
    holds: RemoteHolds,
    hold: Duration,
    shutdown: broadcast::Receiver<()>,
) {
    supervise(state, holds, hold, TICK, shutdown).await;
}

/// The supervisor loop with its tick as a parameter (the tests run it fast).
async fn supervise(
    state: Arc<RwLock<AppState>>,
    holds: RemoteHolds,
    hold: Duration,
    tick: Duration,
    mut shutdown: broadcast::Receiver<()>,
) {
    let mut watch = LinkWatch::new(hold, Instant::now());
    let mut retry = Retry::new();
    let mut ticker = tokio::time::interval(tick);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            biased;
            _ = shutdown.recv() => break,
            _ = ticker.tick() => {}
        }
        let connected = link_is_up(&*state.read().await);
        let now = Instant::now();
        if watch.observe(connected, now) == Verdict::HoldExpired {
            if retry.due(now) {
                let retained = expire_holds(&state, &holds, retry.is_first()).await;
                if retained > 0 {
                    retry.failed(Instant::now());
                } else {
                    retry.reset();
                }
            }
        } else {
            retry.reset();
        }
    }
    info!("Comms-loss supervisor stopped");
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOLD: Duration = Duration::from_secs(30);

    #[test]
    fn a_link_that_is_up_is_up() {
        let t0 = Instant::now();
        let mut watch = LinkWatch::new(HOLD, t0);
        assert_eq!(watch.observe(true, t0), Verdict::Up);
        assert_eq!(watch.observe(true, t0 + HOLD * 10), Verdict::Up);
    }

    #[test]
    fn the_hold_runs_out_only_after_the_whole_hold_without_a_link() {
        let t0 = Instant::now();
        let mut watch = LinkWatch::new(HOLD, t0);
        assert_eq!(watch.observe(true, t0), Verdict::Up);
        // The link drops at t0 + 5 s.
        let drop_at = t0 + Duration::from_secs(5);
        assert_eq!(watch.observe(false, drop_at), Verdict::Down);
        assert_eq!(
            watch.observe(false, drop_at + HOLD - Duration::from_secs(1)),
            Verdict::Down
        );
        assert_eq!(
            watch.observe(false, drop_at + HOLD),
            Verdict::HoldExpired,
            "the verdict is a state: it stays while the link stays down"
        );
        assert_eq!(
            watch.observe(false, drop_at + HOLD * 4),
            Verdict::HoldExpired
        );
    }

    #[test]
    fn a_link_that_comes_back_restarts_the_hold() {
        let t0 = Instant::now();
        let mut watch = LinkWatch::new(HOLD, t0);
        assert_eq!(watch.observe(false, t0), Verdict::Down);
        assert_eq!(watch.observe(true, t0 + HOLD), Verdict::Up);
        // A second outage counts from its own start.
        let second = t0 + HOLD + Duration::from_secs(1);
        assert_eq!(watch.observe(false, second), Verdict::Down);
        assert_eq!(
            watch.observe(false, second + HOLD - Duration::from_secs(1)),
            Verdict::Down
        );
        assert_eq!(watch.observe(false, second + HOLD), Verdict::HoldExpired);
    }

    #[test]
    fn a_watch_started_before_the_first_connection_counts_from_its_start() {
        let t0 = Instant::now();
        let mut watch = LinkWatch::new(HOLD, t0);
        assert_eq!(watch.observe(false, t0 + HOLD), Verdict::HoldExpired);
    }

    #[test]
    fn the_holds_are_a_shared_set_that_a_take_empties() {
        let holds = RemoteHolds::default();
        let writer = holds.clone();
        writer.record(OutputId::gpio_pin(17));
        writer.record(OutputId::gpio_pin(17));
        writer.record(OutputId::modbus_coil("plc", 3));
        assert_eq!(holds.len(), 2);
        let mut taken: Vec<String> = holds.take().iter().map(ToString::to_string).collect();
        taken.sort();
        assert_eq!(taken, ["gpio pin 17", "modbus coil plc/3"]);
        assert!(holds.is_empty());
    }

    /// The loop applies the hold: a recorded output is untouched while the link
    /// is up however long that is, and is dealt with only once the link has
    /// been down for the whole hold. (The id here is not a registered output,
    /// so "dealt with" is observable as the hold being emptied: no safe value
    /// is known for it and it is dropped with a warning.)
    ///
    /// The link is the production MQTT client's, connected to a broker that
    /// goes away the way a real one does: the socket closes, no DISCONNECT is
    /// sent. A supervisor that read a flag only a DISCONNECT packet clears would
    /// see the link up for ever and never expire a hold.
    #[tokio::test]
    async fn the_supervisor_deals_with_a_hold_only_after_the_hold_without_a_link() {
        use crate::mqtt::MqttClient;
        use crate::mqtt::fake_broker::{FakeBroker, eventually};

        const HOLD: Duration = Duration::from_millis(600);
        let config: crate::config::AgentConfig = serde_yaml::from_str(
            "device_id: \"dev-1\"\ndevice_code: \"EDGE-1\"\napi_url: \"https://api.example.test\"\n\
             mqtt:\n  port: 8883\n",
        )
        .unwrap();
        let broker = FakeBroker::start().await;
        let mut app = AppState::new(config);
        app.mqtt_client = Some(MqttClient::connect_plain_for_test(broker.port(), None));
        let state = Arc::new(RwLock::new(app));
        let linked = |state: &Arc<RwLock<AppState>>| {
            let state = state.clone();
            move || state.try_read().is_ok_and(|s| link_is_up(&s))
        };
        eventually(
            "the link to come up",
            Duration::from_secs(10),
            linked(&state),
        )
        .await;
        let holds = RemoteHolds::default();
        holds.record(OutputId::modbus_coil("ghost", 1));

        let (stop, shutdown) = broadcast::channel(1);
        let task = tokio::spawn(supervise(
            state.clone(),
            holds.clone(),
            HOLD,
            Duration::from_millis(10),
            shutdown,
        ));

        // Link up for longer than the hold: the output is never touched.
        tokio::time::sleep(HOLD * 2).await;
        assert_eq!(
            holds.len(),
            1,
            "an output is never touched while the link is up"
        );

        // The broker goes away: dealt with, and not before the whole hold has
        // passed. (`down` is taken before the link can read down, so the hold
        // cannot have started earlier.)
        let down = Instant::now();
        broker.set_accepting(false);
        broker.drop_connection();
        let deadline = down + Duration::from_secs(10);
        while !holds.is_empty() {
            assert!(Instant::now() < deadline, "the hold never ran out");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            down.elapsed() >= HOLD,
            "dealt with after {:?}, before the {HOLD:?} hold",
            down.elapsed()
        );

        stop.send(()).unwrap();
        task.await.unwrap();
    }

    /// An output on a device the agent cannot reach fails again at every attempt:
    /// the retries back off from one tick to a minute and only the first of an
    /// episode announces; the episode is over when the link returns or nothing
    /// is held.
    #[test]
    fn a_hold_that_cannot_be_driven_is_retried_with_backoff() {
        let t0 = Instant::now();
        let mut retry = Retry::new();
        assert!(retry.due(t0) && retry.is_first());
        // Attempt 1 fails: the next is one tick later, then 2 s, 4 s, ... a minute.
        let mut at = t0;
        let mut waits = Vec::new();
        for _ in 0..9 {
            retry.failed(at);
            assert!(!retry.is_first(), "only the first attempt announces");
            let next = retry.next.expect("scheduled");
            assert!(!retry.due(at), "not due again at once");
            assert!(retry.due(next), "due at the scheduled instant");
            waits.push(next - at);
            at = next;
        }
        let seconds: Vec<u64> = waits.iter().map(Duration::as_secs).collect();
        assert_eq!(seconds, [1, 2, 4, 8, 16, 32, 60, 60, 60]);
        // The link came back (or nothing is held): a fresh episode.
        retry.reset();
        assert!(retry.due(at) && retry.is_first());
    }

    /// The pass holds the `AppState` lock only to copy what it needs: a writer
    /// is not queued behind the field-bus calls of an expired hold.
    #[test]
    fn the_pass_copies_what_it_needs_and_does_not_borrow_the_state_across_a_field_bus_call() {
        let source = include_str!("comms_loss.rs");
        let body = source
            .split("pub async fn expire_holds(")
            .nth(1)
            .and_then(|rest| {
                rest.split("\n/// Run the supervisor until shutdown.")
                    .next()
            })
            .expect("expire_holds");
        assert!(body.contains("OwnedOutputHandles::of(&s)"));
        assert!(
            !body.contains("OutputHandles::of(&s)") || body.contains("OwnedOutputHandles::of(&s)"),
            "the handles are cloned out of the state"
        );
        // The guard `s` ends with the block that copies; the pass runs after it.
        let copy_end = body
            .find("};\n    let (report, unregistered)")
            .expect("the copy block ends");
        let pass = body.find("apply_leased(&config").expect("the pass");
        assert!(
            copy_end < pass,
            "apply_leased runs after the state lock is released"
        );
    }

    /// An output that cannot be driven stays a hold, so the next tick tries it
    /// again; one that is not an output at all is dropped.
    #[tokio::test]
    async fn an_output_that_could_not_be_driven_stays_held() {
        let config: crate::config::AgentConfig = serde_yaml::from_str(
            "device_id: \"dev-1\"\ndevice_code: \"EDGE-1\"\napi_url: \"https://api.example.test\"\n\
             mqtt:\n  port: 8883\n",
        )
        .unwrap();
        let mut app = AppState::new(config);
        app.config
            .gpio
            .push(serde_yaml::from_str("name: pump\npin: 17\ndirection: output\n").unwrap());
        let state = Arc::new(RwLock::new(app));
        let holds = RemoteHolds::default();
        holds.record(OutputId::gpio_pin(17));
        holds.record(OutputId::gpio_pin(18));

        assert_eq!(expire_holds(&state, &holds, true).await, 1);

        // pin 17 is registered but there is no GPIO handle: it failed and is
        // kept; pin 18 is no output: dropped.
        let kept: Vec<String> = holds.take().iter().map(ToString::to_string).collect();
        assert_eq!(kept, ["gpio pin 17"]);
    }
}
