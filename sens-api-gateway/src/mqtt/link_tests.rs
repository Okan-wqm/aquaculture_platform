//! The link state against the real rumqttc event loop (EDGE-HIGH-065, EDGE-HIGH-133).
//!
//! The broker here accepts, answers the CONNECT with a CONNACK and then drops
//! the socket, which is what a network loss looks like to an MQTT 3.1.1 client:
//! no DISCONNECT packet, an error of the poll. Everything that decides on the
//! link (the offline-queue dispatcher and its drain, the comms-loss supervisor)
//! is asserted through the client's own answer.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

use std::sync::Arc;
use std::time::Duration;

use super::MqttClient;
use super::fake_broker::{FakeBroker, eventually};
use crate::health::HealthState;
use crate::offline_queue::{MessagePriority, OfflineQueue};
use crate::outbound_publisher::{DrainOutcome, DrainTask, OutboundPublisher, PublishOutcome};

const WITHIN: Duration = Duration::from_secs(10);

/// A client that is connected to `broker`.
async fn connected(broker: &FakeBroker, health: Option<HealthState>) -> MqttClient {
    let client = MqttClient::connect_plain_for_test(broker.port(), health);
    eventually("the first CONNACK", WITHIN, || client.is_connected()).await;
    client
}

#[tokio::test]
async fn the_link_is_down_when_the_socket_drops_and_up_again_after_the_reconnect() {
    let broker = FakeBroker::start().await;
    let health = HealthState::new();
    let client = connected(&broker, Some(health.clone())).await;
    assert!(
        health.readiness().checks.mqtt_connected,
        "the gauge follows the link"
    );
    assert_eq!(broker.connects(), 1);

    // The broker goes away without a word and stays away.
    broker.set_accepting(false);
    broker.drop_connection();
    eventually("the link to read down", WITHIN, || !client.is_connected()).await;
    assert!(
        !health.readiness().checks.mqtt_connected,
        "the gauge is written in the same call as the link state"
    );

    // It is back: the event loop reconnects by itself.
    broker.set_accepting(true);
    eventually("the link to read up again", WITHIN, || {
        client.is_connected()
    })
    .await;
    assert!(health.readiness().checks.mqtt_connected);
    assert_eq!(broker.connects(), 2, "a second CONNECT after the loss");
}

#[tokio::test]
async fn a_publish_while_the_broker_is_down_is_queued_and_drains_on_the_reconnect() {
    let broker = FakeBroker::start().await;
    let client = connected(&broker, None).await;
    let adapter = Arc::new(client.publish_adapter());
    let queue = Arc::new(OfflineQueue::in_memory(100).unwrap());
    let publisher = OutboundPublisher::new(adapter.clone(), adapter.clone(), queue.clone());
    let drain = DrainTask::new(adapter.clone(), adapter, queue.clone());

    // Up: it goes straight to the broker.
    let outcome = publisher
        .publish("t/up", b"before", MessagePriority::Normal, 1, false)
        .await
        .unwrap();
    assert_eq!(outcome, PublishOutcome::Sent);
    eventually("the first publish at the broker", WITHIN, || {
        broker.published().iter().any(|p| p.topic == "t/up")
    })
    .await;

    // The broker is gone. No health state exists at all: the dispatcher must
    // learn it from the client.
    broker.set_accepting(false);
    broker.drop_connection();
    eventually("the link to read down", WITHIN, || !client.is_connected()).await;

    let outcome = publisher
        .publish("t/down", b"during", MessagePriority::High, 1, false)
        .await
        .unwrap();
    assert!(
        matches!(outcome, PublishOutcome::Queued { .. }),
        "a publish while the broker is down lands in the queue, got {outcome:?}"
    );
    assert_eq!(queue.len(), 1);
    assert_eq!(
        drain.drain_once().await,
        DrainOutcome::Skipped,
        "nothing is replayed into a broker that is down"
    );
    assert!(broker.published().iter().all(|p| p.topic != "t/down"));

    // The broker returns: the queue drains into it.
    broker.set_accepting(true);
    eventually("the link to read up again", WITHIN, || {
        client.is_connected()
    })
    .await;
    assert_eq!(
        drain.drain_once().await,
        DrainOutcome::Drained {
            sent: 1,
            remaining: 0
        }
    );
    assert_eq!(queue.len(), 0, "an acknowledged message leaves the queue");
    eventually("the queued publish at the broker", WITHIN, || {
        broker
            .published()
            .iter()
            .any(|p| p.topic == "t/down" && p.payload == b"during" && p.qos == 1)
    })
    .await;
}
