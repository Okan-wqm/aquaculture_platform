//! A scripted MQTT 3.1.1 broker for tests that need the REAL rumqttc event loop.
//!
//! The link state of the agent (ADR-048 DEC-13.3, EDGE-HIGH-065/133) is decided
//! by what the event loop sees when a connection dies, and no mock of the
//! publish sink or of the connectivity port can show that: the defect it guards
//! against is the event loop not noticing. This broker speaks just enough of the
//! protocol (CONNECT, SUBSCRIBE, PUBLISH QoS 0 and 1, PINGREQ, DISCONNECT) over
//! plain TCP for a client to connect, subscribe, publish and be acknowledged,
//! and it can be told to drop the connection, to refuse connections (a broker
//! that is down) and to accept them again.
//!
//! An MQTT 3.1.1 broker never sends a DISCONNECT packet, so "the broker went
//! away" is a socket that closes, which is what [`FakeBroker::drop_connection`]
//! does.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rumqttc::MqttOptions;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinSet;

use super::{MqttClient, ReconnectBackoff};
use crate::config::ResolvedTopics;

/// One PUBLISH the broker received.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Published {
    pub topic: String,
    pub payload: Vec<u8>,
    pub qos: u8,
}

struct Shared {
    accepting: AtomicBool,
    connects: AtomicUsize,
    published: Mutex<Vec<Published>>,
    subscriptions: Mutex<Vec<String>>,
}

/// The broker. It stops when dropped.
pub(crate) struct FakeBroker {
    addr: SocketAddr,
    shared: Arc<Shared>,
    drop_generation: watch::Sender<u64>,
    accept_task: tokio::task::JoinHandle<()>,
}

impl Drop for FakeBroker {
    fn drop(&mut self) {
        self.accept_task.abort();
    }
}

impl FakeBroker {
    /// Listen on a free loopback port.
    pub(crate) async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local addr");
        let shared = Arc::new(Shared {
            accepting: AtomicBool::new(true),
            connects: AtomicUsize::new(0),
            published: Mutex::new(Vec::new()),
            subscriptions: Mutex::new(Vec::new()),
        });
        let (drop_generation, generation) = watch::channel(0u64);
        let accept_shared = shared.clone();
        let accept_task = tokio::spawn(async move {
            // The connections end with the accept task (the JoinSet aborts them).
            let mut connections = JoinSet::new();
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    return;
                };
                if !accept_shared.accepting.load(Ordering::Acquire) {
                    // A broker that is down: the client's connect attempt ends
                    // at once.
                    drop(socket);
                    continue;
                }
                connections.spawn(serve(socket, accept_shared.clone(), generation.clone()));
            }
        });
        Self {
            addr,
            shared,
            drop_generation,
            accept_task,
        }
    }

    pub(crate) fn port(&self) -> u16 {
        self.addr.port()
    }

    /// Close every open connection (the socket just goes away).
    pub(crate) fn drop_connection(&self) {
        self.drop_generation.send_modify(|g| *g += 1);
    }

    /// Whether new connections are served (`false`: they are closed at once).
    pub(crate) fn set_accepting(&self, accepting: bool) {
        self.shared.accepting.store(accepting, Ordering::Release);
    }

    /// How many CONNECT packets were answered with a CONNACK.
    pub(crate) fn connects(&self) -> usize {
        self.shared.connects.load(Ordering::Acquire)
    }

    pub(crate) fn published(&self) -> Vec<Published> {
        self.shared.published.lock().unwrap().clone()
    }

    pub(crate) fn subscriptions(&self) -> Vec<String> {
        self.shared.subscriptions.lock().unwrap().clone()
    }
}

/// One packet: the fixed header's first byte and the body.
async fn read_packet(socket: &mut TcpStream) -> std::io::Result<(u8, Vec<u8>)> {
    let first = socket.read_u8().await?;
    let mut length = 0usize;
    let mut multiplier = 1usize;
    loop {
        let byte = socket.read_u8().await?;
        length += usize::from(byte & 0x7F) * multiplier;
        if byte & 0x80 == 0 {
            break;
        }
        multiplier *= 128;
    }
    let mut body = vec![0u8; length];
    socket.read_exact(&mut body).await?;
    Ok((first, body))
}

fn be_u16(bytes: &[u8]) -> usize {
    (usize::from(bytes[0]) << 8) | usize::from(bytes[1])
}

async fn serve(mut socket: TcpStream, shared: Arc<Shared>, mut dropped: watch::Receiver<u64>) {
    // A drop requested before this connection existed is not for it.
    dropped.borrow_and_update();
    loop {
        let (first, body) = tokio::select! {
            _ = dropped.changed() => return,
            packet = read_packet(&mut socket) => match packet {
                Ok(packet) => packet,
                Err(_) => return,
            },
        };
        match first >> 4 {
            // CONNECT -> CONNACK (session not present, accepted)
            1 => {
                shared.connects.fetch_add(1, Ordering::AcqRel);
                if socket.write_all(&[0x20, 0x02, 0x00, 0x00]).await.is_err() {
                    return;
                }
            }
            // PUBLISH
            3 => {
                let qos = (first >> 1) & 0x03;
                let topic_len = be_u16(&body);
                let topic = String::from_utf8_lossy(&body[2..2 + topic_len]).into_owned();
                let mut at = 2 + topic_len;
                let mut pkid = [0u8; 2];
                if qos > 0 {
                    pkid.copy_from_slice(&body[at..at + 2]);
                    at += 2;
                }
                shared.published.lock().unwrap().push(Published {
                    topic,
                    payload: body[at..].to_vec(),
                    qos,
                });
                if qos == 1
                    && socket
                        .write_all(&[0x40, 0x02, pkid[0], pkid[1]])
                        .await
                        .is_err()
                {
                    return;
                }
            }
            // SUBSCRIBE -> SUBACK granting QoS 1 to every filter
            8 => {
                let pkid = [body[0], body[1]];
                let mut at = 2;
                let mut granted = Vec::new();
                while at < body.len() {
                    let filter_len = be_u16(&body[at..]);
                    let filter =
                        String::from_utf8_lossy(&body[at + 2..at + 2 + filter_len]).into_owned();
                    shared.subscriptions.lock().unwrap().push(filter);
                    at += 2 + filter_len + 1;
                    granted.push(0x01);
                }
                let mut ack = vec![0x90, (2 + granted.len()) as u8, pkid[0], pkid[1]];
                ack.extend(granted);
                if socket.write_all(&ack).await.is_err() {
                    return;
                }
            }
            // PINGREQ -> PINGRESP
            12 => {
                if socket.write_all(&[0xD0, 0x00]).await.is_err() {
                    return;
                }
            }
            // DISCONNECT
            14 => return,
            _ => {}
        }
    }
}

/// Poll `condition` every 10 ms until it holds; fail the test after `within`.
pub(crate) async fn eventually(what: &str, within: Duration, condition: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + within;
    while !condition() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "gave up waiting {within:?} for: {what}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The topics a test client resolves (their values do not matter here).
pub(crate) fn topics() -> ResolvedTopics {
    let t = |name: &str| format!("tenants/t/devices/d/{name}");
    ResolvedTopics {
        status: t("status"),
        telemetry: t("telemetry"),
        responses: t("responses"),
        commands: t("commands"),
        config: t("config"),
        capabilities: t("capabilities"),
        io_data: t("io"),
        alarms: t("alarms"),
        lora_events: t("lora"),
        task_stats: t("task_stats"),
    }
}

impl MqttClient {
    /// The production client (the same `start`, so the same event loop, the same
    /// ack tracker) connected over plain TCP to a [`FakeBroker`], reconnecting
    /// after about a second (the shortest backoff the loop supports).
    pub(crate) fn connect_plain_for_test(
        port: u16,
        health_state: Option<crate::health::HealthState>,
    ) -> Self {
        let mut options = MqttOptions::new("test-agent", "127.0.0.1", port);
        options.set_keep_alive(Duration::from_secs(5));
        // As in production (`mqtt.clean_session` defaults to false).
        options.set_clean_session(false);
        Self::start(
            options,
            topics(),
            "dev-test".to_string(),
            "EDGE-TEST".to_string(),
            None,
            ReconnectBackoff {
                min_secs: 1,
                max_secs: 1,
            },
            health_state,
        )
    }
}
