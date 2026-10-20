//! Control-loop liveness, and the systemd watchdog it drives.
//!
//! ADR-048 DEC-6.4 / EDGE-HIGH-052.
//!
//! WHY: the previous watchdog task was a free-running timer on the
//! multi-thread runtime. It kept pinging while the I/O loop, the script
//! engine or the whole LocalSet was wedged, so systemd never saw a stalled
//! control loop.
//!
//! WHAT: every control loop registers with [`Liveness`] and gets a
//! [`Heartbeat`]; it ticks the heartbeat after every completed cycle and
//! records progress after every completed blocking call inside one. The supervisor
//! ([`run_supervisor`]) sends `WATCHDOG=1` only while every registered loop
//! ticked within `WatchdogSec / 2`. A loop stuck inside an I/O call stops
//! ticking, the pings stop, and systemd restarts the agent. A loop that ends
//! counts as stalled for good (its `Heartbeat` was dropped).
//!
//! Tick budget: a loop that legitimately idles longer than the window (a
//! long poll interval) waits through [`idle`] / [`tick_while_waiting`], which
//! record progress at most every [`IDLE_TICK`] while the loop is idle, and a
//! cycle records progress after each blocking call — so the window bounds a
//! single call that does not return, not a long cycle or a long interval.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tracing::{error, info, warn};

use crate::degraded::DegradedMode;
use crate::systemd_notify::SystemdNotifier;

/// Longest gap between two ticks of an idle loop. Well below the smallest
/// sensible freshness window (`WatchdogSec / 2`), so an idle loop never looks
/// stale.
pub const IDLE_TICK: Duration = Duration::from_millis(250);

/// Freshness window when systemd armed no watchdog (health view only).
const DEFAULT_MAX_TICK_AGE: Duration = Duration::from_secs(30);

/// The loops whose progress is the agent's liveness.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopId {
    /// The I/O loop: reads every input into the process image (always runs).
    IoPoll,
    /// The script engine (runs only while control is enabled).
    ScriptEngine,
}

impl LoopId {
    /// Name for logs and the health view.
    pub fn name(self) -> &'static str {
        match self {
            Self::IoPoll => "io_poll",
            Self::ScriptEngine => "script_engine",
        }
    }
}

const NEVER: u64 = u64::MAX;

#[derive(Debug)]
struct Slot {
    id: LoopId,
    /// Milliseconds since the registry origin of the last sign of progress
    /// (a completed cycle, a completed I/O call, idle time); NEVER before the
    /// first.
    last_tick_ms: AtomicU64,
    /// Completed cycles.
    cycles: AtomicU64,
    exited: AtomicBool,
}

#[derive(Debug)]
struct Inner {
    origin: Instant,
    slots: Mutex<Vec<Arc<Slot>>>,
}

/// Registry of the running control loops.
#[derive(Debug, Clone)]
pub struct Liveness {
    inner: Arc<Inner>,
}

impl Default for Liveness {
    fn default() -> Self {
        Self::new()
    }
}

/// A loop's handle: [`Heartbeat::tick`] after every completed cycle,
/// [`Heartbeat::progress`] after every completed blocking call inside one.
/// Dropping it marks the loop exited, which stops the watchdog pings.
#[derive(Debug)]
pub struct Heartbeat {
    slot: Arc<Slot>,
    origin: Instant,
}

impl Heartbeat {
    /// The loop completed a cycle.
    pub fn tick(&self) {
        self.progress();
        self.slot.cycles.fetch_add(1, Ordering::AcqRel);
    }

    /// The loop made progress inside a cycle (a blocking call returned) or
    /// is idle with nothing in flight.
    ///
    /// DEC-6.4 tick budget: a cycle with many bounded I/O calls (for
    /// example a row of Atlas EZO sensors, each with its read delay) may
    /// legitimately last longer than the freshness window; ticking after
    /// each call makes the budget per call, so only a call that does not
    /// return stops the pings.
    pub fn progress(&self) {
        let ms = u64::try_from(self.origin.elapsed().as_millis()).unwrap_or(NEVER - 1);
        self.slot.last_tick_ms.store(ms, Ordering::Release);
    }

    /// Which loop this is.
    pub fn id(&self) -> LoopId {
        self.slot.id
    }

    /// A tick at a chosen instant (tests drive the clock explicitly).
    #[cfg(test)]
    fn tick_at(&self, at: Instant) {
        let ms = u64::try_from(at.saturating_duration_since(self.origin).as_millis())
            .unwrap_or(NEVER - 1);
        self.slot.last_tick_ms.store(ms, Ordering::Release);
        self.slot.cycles.fetch_add(1, Ordering::AcqRel);
    }
}

impl Drop for Heartbeat {
    fn drop(&mut self) {
        self.slot.exited.store(true, Ordering::Release);
    }
}

/// One loop's state at a verdict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LoopReport {
    #[serde(rename = "loop")]
    pub id: LoopId,
    /// Ticked within the window, and still running.
    pub fresh: bool,
    /// The loop ended.
    pub exited: bool,
    /// The loop never completed a cycle.
    pub never_ticked: bool,
}

/// Whether the agent's control loops are live.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Verdict {
    /// At least one loop is registered and every registered loop is fresh.
    pub live: bool,
    pub loops: Vec<LoopReport>,
}

impl Verdict {
    /// The loops that are not fresh, for logs.
    pub fn stalled_names(&self) -> Vec<&'static str> {
        self.loops
            .iter()
            .filter(|l| !l.fresh)
            .map(|l| l.id.name())
            .collect()
    }
}

impl Liveness {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                origin: Instant::now(),
                slots: Mutex::new(Vec::new()),
            }),
        }
    }

    fn slots(&self) -> Vec<Arc<Slot>> {
        match self.inner.slots.lock() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    /// Register a loop. From now on the watchdog requires its ticks.
    pub fn register(&self, id: LoopId) -> Heartbeat {
        let slot = Arc::new(Slot {
            id,
            last_tick_ms: AtomicU64::new(NEVER),
            cycles: AtomicU64::new(0),
            exited: AtomicBool::new(false),
        });
        match self.inner.slots.lock() {
            Ok(mut guard) => guard.push(slot.clone()),
            Err(poisoned) => poisoned.into_inner().push(slot.clone()),
        }
        Heartbeat {
            slot,
            origin: self.inner.origin,
        }
    }

    /// The verdict at `now` for freshness window `max_age` (pure; the clock
    /// is a parameter so tests need no sleeps).
    pub fn verdict_at(&self, now: Instant, max_age: Duration) -> Verdict {
        let now_ms = u64::try_from(now.saturating_duration_since(self.inner.origin).as_millis())
            .unwrap_or(NEVER - 1);
        let max_ms = u64::try_from(max_age.as_millis()).unwrap_or(NEVER - 1);
        let loops: Vec<LoopReport> = self
            .slots()
            .iter()
            .map(|s| {
                let last = s.last_tick_ms.load(Ordering::Acquire);
                let exited = s.exited.load(Ordering::Acquire);
                let never_ticked = last == NEVER;
                let fresh = !exited && !never_ticked && now_ms.saturating_sub(last) < max_ms;
                LoopReport {
                    id: s.id,
                    fresh,
                    exited,
                    never_ticked,
                }
            })
            .collect();
        Verdict {
            live: !loops.is_empty() && loops.iter().all(|l| l.fresh),
            loops,
        }
    }

    /// The verdict now.
    pub fn verdict(&self, max_age: Duration) -> Verdict {
        self.verdict_at(Instant::now(), max_age)
    }

    /// Wait until each of `ids` completed its first cycle. Fails when one of
    /// them ended before it did. READY waits on this: "the local control loop
    /// runs" means it went round at least once (DEC-6.2). The wait itself is
    /// bounded by the unit's `TimeoutStartSec`.
    pub async fn first_cycles(&self, ids: &[LoopId]) -> Result<(), LoopId> {
        loop {
            let slots = self.slots();
            let mut pending = false;
            for id in ids {
                let mine: Vec<&Arc<Slot>> = slots.iter().filter(|s| s.id == *id).collect();
                if mine.is_empty() {
                    pending = true;
                    continue;
                }
                for s in mine {
                    if s.cycles.load(Ordering::Acquire) == 0 {
                        if s.exited.load(Ordering::Acquire) {
                            return Err(*id);
                        }
                        pending = true;
                    }
                }
            }
            if !pending {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

/// Sleep `total`, ticking `heartbeat` at least every [`IDLE_TICK`]. The
/// caller ticks at the end of each cycle itself; these ticks only cover the
/// idle time, so a loop has no tick before its first completed cycle.
pub async fn idle(heartbeat: &Heartbeat, total: Duration) {
    idle_sliced(heartbeat, total, IDLE_TICK).await;
}

async fn idle_sliced(heartbeat: &Heartbeat, total: Duration, slice: Duration) {
    let deadline = tokio::time::Instant::now() + total;
    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return;
        }
        tokio::time::sleep((deadline - now).min(slice)).await;
        heartbeat.progress();
    }
}

/// Await `wait` (a cancellation-safe wait for the loop's next cycle, such as
/// `Interval::tick`), ticking `heartbeat` at least every [`IDLE_TICK`] while
/// it is pending.
pub async fn tick_while_waiting<F: std::future::Future>(
    heartbeat: &Heartbeat,
    wait: F,
) -> F::Output {
    tokio::pin!(wait);
    loop {
        tokio::select! {
            out = &mut wait => return out,
            _ = tokio::time::sleep(IDLE_TICK) => heartbeat.progress(),
        }
    }
}

/// Freshness window and supervisor period for a watchdog timeout.
///
/// DEC-6.4: a ping is sent only when the last completed tick is younger than
/// `WatchdogSec / 2`; the supervisor checks four times per `WatchdogSec`, so a
/// live agent pings at least twice per period.
pub fn windows(watchdog: Option<Duration>) -> (Duration, Duration) {
    match watchdog {
        Some(w) => (
            (w / 2).max(Duration::from_millis(1)),
            (w / 4).clamp(Duration::from_millis(50), Duration::from_secs(15)),
        ),
        None => (DEFAULT_MAX_TICK_AGE, Duration::from_secs(5)),
    }
}

/// The liveness supervisor: pings the systemd watchdog while the control
/// loops are live, and keeps `STATUS=` and the health view current.
///
/// It runs on the multi-thread runtime, apart from the loops it judges; its
/// verdict depends only on their ticks, so a wedged LocalSet or I/O loop
/// stops the pings even though this task keeps running.
pub async fn run_supervisor(
    notifier: Arc<SystemdNotifier>,
    liveness: Liveness,
    degraded: DegradedMode,
    mut shutdown: tokio::sync::broadcast::Receiver<()>,
) {
    let watchdog = notifier.watchdog_timeout();
    let (max_age, period) = windows(watchdog);
    info!(
        "Liveness supervisor started (watchdog={}, max tick age={}ms, period={}ms)",
        watchdog.map_or_else(|| "off".to_string(), |w| format!("{}ms", w.as_millis())),
        max_age.as_millis(),
        period.as_millis()
    );
    let mut last_live: Option<bool> = None;
    let mut last_generation = degraded.generation();
    let mut interval = tokio::time::interval(period);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = interval.tick() => {}
            _ = shutdown.recv() => {
                info!("Liveness supervisor stopping");
                return;
            }
        }
        let verdict = liveness.verdict(max_age);
        if verdict.live && watchdog.is_some() {
            if let Err(e) = notifier.watchdog_ping() {
                warn!("WATCHDOG=1 could not be sent: {}", e);
            }
        }
        if last_live != Some(verdict.live) {
            if verdict.live {
                info!("Control loops live: {:?}", verdict.loops);
            } else {
                error!(
                    "LIFE-SAFETY: control loop(s) stalled: {:?} — watchdog pings withheld; \
                     systemd restarts the agent after WatchdogSec",
                    verdict.stalled_names()
                );
            }
            last_live = Some(verdict.live);
            degraded.set_liveness(verdict.clone());
        }
        let generation = degraded.generation();
        if generation != last_generation {
            last_generation = generation;
            if let Err(e) = notifier.status(&degraded.status_line()) {
                warn!("STATUS= could not be sent: {}", e);
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn no_loop_is_no_proof_of_life() {
        let l = Liveness::new();
        assert!(!l.verdict(Duration::from_secs(30)).live);
    }

    #[test]
    fn fresh_ticks_are_live_and_a_stalled_loop_is_not() {
        let l = Liveness::new();
        let io = l.register(LoopId::IoPoll);
        let script = l.register(LoopId::ScriptEngine);
        let window = Duration::from_secs(30);
        // Registered but never ticked: not live.
        let v = l.verdict(window);
        assert!(!v.live);
        assert!(v.loops.iter().all(|r| r.never_ticked));
        let t0 = Instant::now();
        io.tick_at(t0);
        script.tick_at(t0);
        assert!(l.verdict_at(t0, window).live);
        assert!(l.verdict_at(t0 + Duration::from_secs(29), window).live);
        // The script engine keeps ticking, the I/O loop is stuck in a cycle:
        // 31 s later only the I/O loop is stale and the ping is withheld.
        script.tick_at(t0 + Duration::from_secs(30));
        let v = l.verdict_at(t0 + Duration::from_secs(31), window);
        assert!(!v.live);
        assert_eq!(v.stalled_names(), vec!["io_poll"]);
        // The I/O loop completes its cycle: live again.
        io.tick_at(t0 + Duration::from_secs(31));
        assert!(l.verdict_at(t0 + Duration::from_secs(31), window).live);
    }

    #[test]
    fn an_exited_loop_stops_the_pings_for_good() {
        let l = Liveness::new();
        let io = l.register(LoopId::IoPoll);
        let script = l.register(LoopId::ScriptEngine);
        io.tick();
        script.tick();
        drop(script);
        let v = l.verdict(Duration::from_secs(30));
        assert!(!v.live);
        let s = v
            .loops
            .iter()
            .find(|r| r.id == LoopId::ScriptEngine)
            .unwrap();
        assert!(s.exited && !s.fresh);
        io.tick();
        assert!(!l.verdict(Duration::from_secs(30)).live);
    }

    #[tokio::test]
    async fn progress_keeps_a_loop_fresh_but_is_not_its_first_cycle() {
        let l = Liveness::new();
        let io = l.register(LoopId::IoPoll);
        io.progress();
        assert!(l.verdict(Duration::from_secs(30)).live);
        let waiter = {
            let l = l.clone();
            tokio::spawn(async move { l.first_cycles(&[LoopId::IoPoll]).await })
        };
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(
            !waiter.is_finished(),
            "progress alone must not count as a cycle"
        );
        io.tick();
        assert_eq!(waiter.await.unwrap(), Ok(()));
    }

    #[test]
    fn windows_follow_dec_6_4() {
        let (age, period) = windows(Some(Duration::from_secs(60)));
        assert_eq!(age, Duration::from_secs(30));
        assert_eq!(period, Duration::from_secs(15));
        let (age, period) = windows(Some(Duration::from_secs(2)));
        assert_eq!(age, Duration::from_secs(1));
        assert_eq!(period, Duration::from_millis(500));
    }

    #[tokio::test]
    async fn first_cycles_waits_for_each_loop_and_fails_on_an_early_exit() {
        let l = Liveness::new();
        let io = l.register(LoopId::IoPoll);
        let waiter = {
            let l = l.clone();
            tokio::spawn(async move { l.first_cycles(&[LoopId::IoPoll]).await })
        };
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(!waiter.is_finished());
        io.tick();
        assert_eq!(waiter.await.unwrap(), Ok(()));

        let script = l.register(LoopId::ScriptEngine);
        drop(script);
        assert_eq!(
            l.first_cycles(&[LoopId::ScriptEngine]).await,
            Err(LoopId::ScriptEngine)
        );
    }

    #[tokio::test]
    async fn idle_ticks_while_it_waits() {
        let l = Liveness::new();
        let hb = l.register(LoopId::IoPoll);
        let before = l.verdict(Duration::from_millis(10));
        assert!(before.loops[0].never_ticked);
        idle_sliced(&hb, Duration::from_millis(70), Duration::from_millis(20)).await;
        // Idle time is progress (fresh) but not a completed cycle.
        let after = l.verdict(Duration::from_millis(15));
        assert!(after.loops[0].fresh, "{after:?}");
        assert_eq!(hb.slot.cycles.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn tick_while_waiting_returns_the_wait_output() {
        let l = Liveness::new();
        let hb = l.register(LoopId::IoPoll);
        let out = tick_while_waiting(&hb, async { 7 }).await;
        assert_eq!(out, 7);
        // A ready wait is not idle time: no progress recorded.
        assert!(l.verdict(Duration::from_secs(30)).loops[0].never_ticked);
    }
}
