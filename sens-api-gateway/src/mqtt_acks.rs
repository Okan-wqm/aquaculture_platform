//! Which broker acknowledgement belongs to which publish (ADR-048 DEC-27: the
//! agent publishes a result "until the broker acknowledged it").
//!
//! rumqttc 0.25 hands a publisher no token: `AsyncClient::publish` returns when
//! the request is in the client's channel, the packet identifier is assigned
//! later by the event loop, and the only evidence of an acknowledgement is an
//! `Incoming(PubAck(pkid))` event with no link back to the caller. A cursor
//! that records "acknowledged" must not guess, so this module makes the link
//! exact instead:
//!
//! * the channel is FIFO and the event loop assigns a packet identifier to each
//!   QoS 1 request in order, emitting `Outgoing(Publish(pkid))` (`0` for QoS 0)
//!   as it does. A retransmission after a reconnect emits the same event for the
//!   same identifier, so an identifier that is not acknowledged yet is a
//!   retransmission, not a new publish;
//! * every QoS 1 request is put in the channel through [`AckTracker::enqueue`],
//!   which holds the lane for the duration of the send and counts the request;
//! * [`AckTracker::publish_acknowledged`] holds the lane from before its send
//!   until the event loop has processed it. It first waits until every earlier
//!   request was processed (no other QoS 1 request can enter the lane
//!   meanwhile), so the next first-time `Outgoing(Publish)` event is its own and
//!   names its identifier; then it waits for the `PubAck` of that identifier.
//!
//! What it never does is guess. When it cannot be sure (the lane is busy with
//! requests the event loop has not processed, the connection is down, the
//! acknowledgement does not come) it reports an error and the caller keeps the
//! message for a later attempt: the failure is always "not acknowledged".

// Only the Suderra OS profile publishes results and so waits for an
// acknowledgement. The generic profile's QoS 1 publishes go through the same lane
// and feed the same tracker, so the two builds' MQTT paths do not differ; what
// the generic build never calls is the waiting side.
#![cfg_attr(not(feature = "suderra-os"), allow(dead_code))]

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rumqttc::{AsyncClient, QoS};
use tokio::sync::Notify;
use tokio::time::Instant;

/// How long the event loop gets to process a request that is already in the
/// channel (it does so as soon as the connection is up).
const DEFAULT_SETTLE: Duration = Duration::from_secs(2);

/// Why a publish was not acknowledged. Every one means "keep the message".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AckError {
    /// Requests are in the channel that the event loop has not processed (the
    /// connection is down, or it is busy), so a new request's identifier cannot
    /// be told from theirs.
    Busy,
    /// The client refused the request (its event loop is gone).
    Enqueue(String),
    /// The request was accepted but the event loop did not send it in time.
    NotSent,
    /// It was sent; no acknowledgement came in time.
    Timeout,
}

impl std::fmt::Display for AckError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy => f.write_str("the publish lane has unprocessed requests"),
            Self::Enqueue(reason) => write!(f, "the client refused the publish: {reason}"),
            Self::NotSent => f.write_str("the event loop did not send the publish"),
            Self::Timeout => f.write_str("the broker did not acknowledge the publish"),
        }
    }
}

impl std::error::Error for AckError {}

#[derive(Default)]
struct State {
    /// QoS 1 requests put in the channel.
    enqueued: u64,
    /// First-time `Outgoing(Publish(pkid != 0))` events seen.
    sent: u64,
    /// Identifiers sent and not acknowledged yet (a repeat is a retransmission).
    unacked: HashSet<u16>,
    /// How many times each identifier was sent for the first time.
    generation: HashMap<u16, u64>,
    /// The generation of each identifier the broker last acknowledged.
    acked: HashMap<u16, u64>,
    /// The identifier and generation of the latest first-time send.
    last_sent: Option<(u16, u64)>,
    /// The broker connection is up.
    connected: bool,
}

/// See the module documentation.
pub struct AckTracker {
    /// The lane every QoS 1 request goes through while it is put in the channel.
    lane: tokio::sync::Mutex<()>,
    state: Mutex<State>,
    changed: Notify,
    /// How long the event loop gets to process a request in the channel.
    settle: Duration,
}

impl Default for AckTracker {
    fn default() -> Self {
        Self::with_settle(DEFAULT_SETTLE)
    }
}

impl AckTracker {
    /// A tracker that gives the event loop `settle` to process a request (a
    /// test shortens it; production uses [`AckTracker::default`]).
    pub fn with_settle(settle: Duration) -> Self {
        Self {
            lane: tokio::sync::Mutex::new(()),
            state: Mutex::new(State::default()),
            changed: Notify::new(),
            settle,
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        // A panic while the lock was held leaves plain counters; they are still
        // coherent enough to refuse on, which is all a poisoned tracker does.
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Put a request in the channel: `counted` is true for QoS 1 and 2. A counted
    /// request holds the lane while `send` runs and is counted when it succeeded.
    pub async fn enqueue<T, E>(
        &self,
        counted: bool,
        send: impl Future<Output = Result<T, E>>,
    ) -> Result<T, E> {
        if !counted {
            return send.await;
        }
        let _lane = self.lane.lock().await;
        let sent = send.await;
        if sent.is_ok() {
            self.state().enqueued += 1;
            self.changed.notify_waiters();
        }
        sent
    }

    /// The event loop emitted `Outgoing(Publish(pkid))`.
    pub fn on_outgoing_publish(&self, pkid: u16) {
        if pkid == 0 {
            return; // QoS 0
        }
        {
            let mut state = self.state();
            if !state.unacked.insert(pkid) {
                return; // a retransmission of an unacknowledged publish
            }
            let generation = state.generation.entry(pkid).or_default();
            *generation += 1;
            let generation = *generation;
            state.sent += 1;
            state.last_sent = Some((pkid, generation));
        }
        self.changed.notify_waiters();
    }

    /// The broker acknowledged a publish.
    pub fn on_puback(&self, pkid: u16) {
        {
            let mut state = self.state();
            if state.unacked.remove(&pkid) {
                let generation = state.generation.get(&pkid).copied().unwrap_or(0);
                state.acked.insert(pkid, generation);
            }
        }
        self.changed.notify_waiters();
    }

    /// The connection is up (a ConnAck).
    pub fn on_connected(&self) {
        self.state().connected = true;
        self.changed.notify_waiters();
    }

    /// The connection is gone.
    pub fn on_disconnected(&self) {
        self.state().connected = false;
        self.changed.notify_waiters();
    }

    /// Whether the broker connection is up.
    pub fn is_connected(&self) -> bool {
        self.state().connected
    }

    /// Wait until `condition` holds of the state, at most `within`. The
    /// notification is registered BEFORE the state is read, so a change between
    /// the read and the wait is not lost.
    async fn wait_until(&self, within: Duration, condition: impl Fn(&State) -> bool) -> bool {
        let deadline = Instant::now() + within;
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if condition(&self.state()) {
                return true;
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                return condition(&self.state());
            }
        }
    }

    /// Publish `payload` on `topic` at QoS 1, not retained, and return once the
    /// broker acknowledged THAT publish, or say why it did not.
    pub async fn publish_acknowledged(
        &self,
        client: &AsyncClient,
        topic: &str,
        payload: Vec<u8>,
        within: Duration,
    ) -> Result<(), AckError> {
        let lane = self.lane.lock().await;
        // Every request enqueued before this one has been sent: this request's
        // identifier is the next first-time one.
        if !self.wait_until(self.settle, |s| s.sent == s.enqueued).await {
            return Err(AckError::Busy);
        }
        client
            .publish(topic, QoS::AtLeastOnce, false, payload)
            .await
            .map_err(|e| AckError::Enqueue(e.to_string()))?;
        let target = {
            let mut state = self.state();
            state.enqueued += 1;
            state.enqueued
        };
        self.changed.notify_waiters();
        if !self.wait_until(self.settle, |s| s.sent == target).await {
            return Err(AckError::NotSent);
        }
        let (pkid, generation) = self.state().last_sent.ok_or(AckError::NotSent)?;
        drop(lane);
        let acknowledged = self
            .wait_until(within, |s| {
                s.acked.get(&pkid).is_some_and(|acked| *acked >= generation)
            })
            .await;
        if acknowledged {
            Ok(())
        } else {
            Err(AckError::Timeout)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn tracker() -> Arc<AckTracker> {
        Arc::new(AckTracker::with_settle(Duration::from_secs(1)))
    }

    /// An event loop that processes requests: for each counted one it emits the
    /// first-time event with the next identifier.
    fn process(tracker: &AckTracker, pkid: u16) {
        tracker.on_outgoing_publish(pkid);
    }

    #[tokio::test]
    async fn a_counted_request_is_counted_when_it_was_sent() {
        let tracker = tracker();
        tracker
            .enqueue(true, async { Ok::<_, ()>(()) })
            .await
            .expect("sent");
        assert_eq!(tracker.state().enqueued, 1);
        let refused: Result<(), &str> = tracker.enqueue(true, async { Err("closed") }).await;
        assert!(refused.is_err());
        assert_eq!(
            tracker.state().enqueued,
            1,
            "a refused request is not counted"
        );
        tracker
            .enqueue(false, async { Ok::<_, ()>(()) })
            .await
            .expect("QoS 0");
        assert_eq!(tracker.state().enqueued, 1, "QoS 0 is not counted");
    }

    #[test]
    fn a_repeat_of_an_unacknowledged_identifier_is_a_retransmission() {
        let tracker = tracker();
        process(&tracker, 1);
        process(&tracker, 1); // after a reconnect
        assert_eq!(tracker.state().sent, 1);
        tracker.on_puback(1);
        process(&tracker, 1); // the identifier is free again: a new publish
        assert_eq!(tracker.state().sent, 2);
        assert_eq!(tracker.state().generation[&1], 2);
        process(&tracker, 0); // QoS 0 carries no identifier
        assert_eq!(tracker.state().sent, 2);
    }

    #[test]
    fn an_acknowledgement_records_the_generation_it_acknowledges() {
        let tracker = tracker();
        process(&tracker, 7);
        tracker.on_puback(7);
        assert_eq!(tracker.state().acked[&7], 1);
        tracker.on_puback(7); // unsolicited: nothing changes
        assert_eq!(tracker.state().acked[&7], 1);
        process(&tracker, 7);
        assert_eq!(
            tracker.state().acked[&7],
            1,
            "the second publish is not acknowledged by the first one's ack"
        );
        tracker.on_puback(7);
        assert_eq!(tracker.state().acked[&7], 2);
    }

    #[tokio::test]
    async fn waiting_sees_a_change_made_before_the_wait_starts() {
        let tracker = tracker();
        process(&tracker, 3);
        assert!(
            tracker
                .wait_until(Duration::from_millis(50), |s| s.sent == 1)
                .await
        );
        assert!(
            !tracker
                .wait_until(Duration::from_millis(30), |s| s.sent == 2)
                .await,
            "a condition that never holds times out"
        );
    }

    #[tokio::test]
    async fn waiting_wakes_on_a_later_event() {
        let tracker = tracker();
        let waiter = {
            let tracker = tracker.clone();
            tokio::spawn(async move {
                tracker
                    .wait_until(Duration::from_secs(5), |s| s.acked.contains_key(&9))
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        process(&tracker, 9);
        tracker.on_puback(9);
        assert!(waiter.await.expect("the waiter"));
    }

    #[test]
    fn the_connection_state_follows_the_events() {
        let tracker = tracker();
        assert!(!tracker.is_connected());
        tracker.on_connected();
        assert!(tracker.is_connected());
        tracker.on_disconnected();
        assert!(!tracker.is_connected());
    }

    /// With a closed client the request is refused and nothing is counted: the
    /// caller keeps the message.
    #[tokio::test]
    async fn a_closed_client_refuses_and_counts_nothing() {
        let (client, eventloop) =
            AsyncClient::new(rumqttc::MqttOptions::new("ack-test", "localhost", 1883), 4);
        drop(eventloop);
        let tracker = tracker();
        let result = tracker
            .publish_acknowledged(&client, "t", b"x".to_vec(), Duration::from_millis(50))
            .await;
        assert!(matches!(result, Err(AckError::Enqueue(_))), "{result:?}");
        assert_eq!(tracker.state().enqueued, 0);
    }

    /// Requests in the channel that the event loop has not processed make a new
    /// request's identifier unknowable: the publish is refused as busy and does
    /// not touch the channel.
    #[tokio::test]
    async fn unprocessed_requests_make_the_lane_busy() {
        let (client, _eventloop) =
            AsyncClient::new(rumqttc::MqttOptions::new("ack-test", "localhost", 1883), 4);
        let tracker = tracker();
        // Another publisher's request that nobody processes.
        tracker
            .enqueue(
                true,
                client.publish("other", QoS::AtLeastOnce, false, b"y".to_vec()),
            )
            .await
            .expect("enqueued");
        let attempt =
            tracker.publish_acknowledged(&client, "t", b"x".to_vec(), Duration::from_secs(1));
        assert_eq!(attempt.await, Err(AckError::Busy));
        assert_eq!(
            tracker.state().enqueued,
            1,
            "the refused publish enqueued nothing"
        );
    }

    /// The whole exchange against a stand-in for the event loop: the publisher
    /// is acknowledged by ITS identifier, even with another publisher's request
    /// processed first and acknowledged in between.
    #[tokio::test]
    async fn the_acknowledgement_of_another_publish_does_not_acknowledge_ours() {
        let (client, mut eventloop) =
            AsyncClient::new(rumqttc::MqttOptions::new("ack-test", "localhost", 1883), 8);
        let tracker = tracker();
        // Another publisher's request, processed and acknowledged before ours.
        tracker
            .enqueue(
                true,
                client.publish("other", QoS::AtLeastOnce, false, b"y".to_vec()),
            )
            .await
            .expect("enqueued");
        process(&tracker, 1);
        tracker.on_puback(1);

        let ours = {
            let tracker = tracker.clone();
            let client = client.clone();
            tokio::spawn(async move {
                tracker
                    .publish_acknowledged(&client, "results", b"r".to_vec(), Duration::from_secs(5))
                    .await
            })
        };
        // Wait until our request is in the channel, then play the event loop:
        // it processes the request (the next first-time identifier is 2) and,
        // later, the broker acknowledges 2.
        assert!(
            tracker
                .wait_until(Duration::from_secs(2), |s| s.enqueued == 2)
                .await
        );
        process(&tracker, 2);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!ours.is_finished(), "not acknowledged before its PubAck");
        tracker.on_puback(2);
        assert_eq!(ours.await.expect("the publisher"), Ok(()));
        // The two requests really are in the client's channel.
        let _ = &mut eventloop;
    }

    #[tokio::test]
    async fn a_publish_nobody_acknowledges_times_out_and_keeps_the_message() {
        let (client, _eventloop) =
            AsyncClient::new(rumqttc::MqttOptions::new("ack-test", "localhost", 1883), 8);
        let tracker = tracker();
        let ours = {
            let tracker = tracker.clone();
            tokio::spawn(async move {
                tracker
                    .publish_acknowledged(
                        &client,
                        "results",
                        b"r".to_vec(),
                        Duration::from_millis(80),
                    )
                    .await
            })
        };
        assert!(
            tracker
                .wait_until(Duration::from_secs(2), |s| s.enqueued == 1)
                .await
        );
        process(&tracker, 4);
        assert_eq!(ours.await.expect("the publisher"), Err(AckError::Timeout));
    }
}
