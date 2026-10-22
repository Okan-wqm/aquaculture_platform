//! Feeding the piControl output watchdog while the control loop is alive
//! (ADR-048 DEC-6.7, DEC-6.4).
//!
//! The driver zeroes every PiBridge output when a descriptor with an armed
//! output watchdog is not written for its period (by default four seconds).
//! The watchdog exists for one failure: the agent's control loop is dead. It
//! must not fire because the loop is merely busy.
//!
//! The first version fed it once per completed I/O cycle. A cycle awaits its
//! field buses, and a Modbus device that does not answer holds it for up to
//! twenty seconds (a write in flight plus the per-device read timeout, both
//! bounded), so one hung device zeroed the outputs of a healthy agent every
//! period, fail-ON ones included, for as long as the device stayed away.
//! A row of Atlas EZO probes, each with its read delay, did the same.
//!
//! [`while_feeding`] drives one pass of the loop and feeds while it is pending:
//!
//! * a **bounded call in flight** (the loop is alive: it ticks at every await)
//!   is fed, whatever its length;
//! * a loop that **is not polled** at all (a task wedged in a blocking call, a
//!   runtime that stopped) cannot feed: the feed is a branch of the same
//!   `select!` the pass runs in;
//! * a call that **has not returned within the longest bound any call has**
//!   (`call_bound`, measured from the loop's last sign of progress, the one
//!   notion of "stalled" the systemd watchdog uses too) is not bounded after
//!   all: feeding stops and the driver zeroes the outputs one period later.
//!
//! The module depends on nothing of the crate, so the hardware-in-the-loop test
//! plays the same function against the real driver.

use std::future::Future;
use std::time::Duration;

use tokio::time::MissedTickBehavior;

/// Drive `work` (one pass of the control loop: its wait and its cycle) to
/// completion, calling `feed` every `every` while it is pending and
/// `stalled_for()` (the time since the loop last made progress) is within
/// `call_bound`. The first feed is immediate, so the loop's first pass arms the
/// watchdog.
pub async fn while_feeding<F: Future>(
    work: F,
    every: Duration,
    call_bound: Duration,
    stalled_for: impl Fn() -> Duration,
    mut feed: impl FnMut(),
) -> F::Output {
    tokio::pin!(work);
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            biased;
            out = &mut work => return out,
            _ = tick.tick() => {
                if stalled_for() <= call_bound {
                    feed();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Instant;

    const EVERY: Duration = Duration::from_millis(10);

    /// The instants of the feeds, relative to `start`.
    struct Feeds {
        start: Instant,
        at: Mutex<Vec<Duration>>,
    }

    impl Feeds {
        fn new() -> Self {
            Self {
                start: Instant::now(),
                at: Mutex::new(Vec::new()),
            }
        }
        fn feed(&self) {
            self.at.lock().unwrap().push(self.start.elapsed());
        }
        fn times(&self) -> Vec<Duration> {
            self.at.lock().unwrap().clone()
        }
    }

    #[tokio::test]
    async fn a_pending_call_of_a_live_loop_is_fed_throughout() {
        let feeds = Feeds::new();
        let out = while_feeding(
            async {
                tokio::time::sleep(Duration::from_millis(300)).await;
                7
            },
            EVERY,
            Duration::from_secs(60),
            || Duration::ZERO,
            || feeds.feed(),
        )
        .await;
        assert_eq!(out, 7, "the pass's own result comes back");
        let times = feeds.times();
        assert!(times.len() >= 10, "fed {} times in 300 ms", times.len());
        assert!(
            times[0] < EVERY,
            "the first feed is immediate: {:?}",
            times[0]
        );
        // No gap anywhere near a watchdog period.
        for pair in times.windows(2) {
            assert!(pair[1] - pair[0] < Duration::from_millis(100), "{pair:?}");
        }
    }

    #[tokio::test]
    async fn a_pass_that_ends_at_once_feeds_once() {
        let feeds = Feeds::new();
        while_feeding(
            async {},
            EVERY,
            Duration::from_secs(60),
            || Duration::ZERO,
            || {
                feeds.feed();
            },
        )
        .await;
        // `biased`: a pass that is ready is not preempted by the tick; the
        // loop's own cycle ending feeds nothing of its own, the next pass does.
        assert!(feeds.times().len() <= 1);
    }

    /// A call that outlives the longest bound any call has is not fed past it:
    /// the watchdog is left to expire.
    #[tokio::test]
    async fn feeding_stops_once_the_loop_has_made_no_progress_for_longer_than_the_bound() {
        let feeds = Feeds::new();
        let start = feeds.start;
        let bound = Duration::from_millis(120);
        while_feeding(
            tokio::time::sleep(Duration::from_millis(500)),
            EVERY,
            bound,
            || start.elapsed(),
            || feeds.feed(),
        )
        .await;
        let times = feeds.times();
        let last = *times.last().expect("fed while within the bound");
        assert!(
            last <= bound + 2 * EVERY,
            "fed at {last:?}, past the {bound:?} bound"
        );
        assert!(
            times.len() >= 5,
            "fed {} times before the bound",
            times.len()
        );
    }

    /// The feed is a branch of the pass's own `select!`: a loop wedged in a
    /// blocking call is not polled, so nothing feeds for it.
    #[tokio::test]
    async fn a_loop_that_is_not_polled_is_not_fed() {
        let feeds = Feeds::new();
        while_feeding(
            async {
                // A blocking call in an async fn: the task cannot reach its
                // `select!`.
                std::thread::sleep(Duration::from_millis(200));
            },
            EVERY,
            Duration::from_secs(60),
            || Duration::ZERO,
            || feeds.feed(),
        )
        .await;
        assert!(
            feeds.times().is_empty(),
            "a wedged pass was fed: {:?}",
            feeds.times()
        );
    }
}
