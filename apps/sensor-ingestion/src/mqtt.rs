//! MQTT subscriber — wraps `rumqttc` in a channel-based stream so the
//! rest of the binary stays test-friendly and broker-agnostic.
//!
//! WHY a channel boundary:
//!   The actual MQTT client lives on its own task and only emits
//!   structurally-typed [`RawMqttMessage`] values into an
//!   `mpsc::Receiver`. Downstream stages (topic parser, payload
//!   validator, batch aggregator, COPY pipeline) consume the receiver
//!   without knowing rumqttc exists. That keeps unit tests of the
//!   pipeline able to drive synthetic messages directly into the
//!   channel; the rumqttc EventLoop only needs an integration test
//!   against a real broker.
//!
//! WHY rumqttc 0.25:
//!   The edge agent (`sens-api-gateway`) uses the same crate at the
//!   same version. Sharing the MQTT client implementation between
//!   edge and cloud means the QoS-1 inflight semantics match exactly.
//!
//! Security note: rumqttc 0.25.1 transitively pins rustls-webpki
//! 0.102.8, which carries RUSTSEC-2026-0098/0099/0049 and the
//! rustls-pemfile 2.2.0 unmaintained advisory (RUSTSEC-2025-0134).
//! Tracked as finding RUST-CVE-001 (HIGH, owner Okan-Wqm, deadline
//! 2026-06-30) with a full threat-model justification in
//! `deny.toml`. Resolution requires an upstream rumqttc release, a
//! local fork, or a migration to an alternative MQTT crate.

use std::time::{Duration, Instant};

use bytes::Bytes;
use rumqttc::{AsyncClient, Event, EventLoop, MqttOptions, Packet, QoS, Transport};
use thiserror::Error;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::config::MqttConfig;

/// Channel buffer for the subscriber → pipeline mpsc. Plan §
/// "Mimari (single binary)" — `tokio::mpsc<Bytes> (cap 50K)`.
pub const MQTT_CHANNEL_CAPACITY: usize = 50_000;

/// All ways the MQTT subsystem can fail.
#[derive(Debug, Error)]
pub enum MqttError {
    /// `broker_url` could not be parsed into a `(host, port)` pair, or
    /// its scheme was neither `mqtt://` nor `mqtts://`.
    #[error("invalid broker_url '{got}': {reason}")]
    InvalidBrokerUrl {
        /// The bad URL (truncated to 64 chars to bound log noise).
        got: String,
        /// Why it failed.
        reason: &'static str,
    },

    /// `topic_filters` was empty.
    #[error("topic_filters cannot be empty")]
    NoTopicFilters,

    /// `qos` field was outside `0..=1`. QoS-2 is intentionally not
    /// supported — the plan's baseline is QoS-1 and admitting QoS-2
    /// changes inflight semantics dramatically.
    #[error("qos must be 0 or 1 (QoS-2 not supported); got {0}")]
    UnsupportedQos(u8),

    /// rumqttc's subscribe call failed.
    #[error("subscribe failed for filter '{filter}'")]
    Subscribe {
        /// Topic filter the subscribe call refused.
        filter: String,
        /// Underlying rumqttc error.
        #[source]
        source: rumqttc::ClientError,
    },
}

/// One MQTT message handed to downstream stages.
#[derive(Debug, Clone)]
pub struct RawMqttMessage {
    /// Topic the broker delivered the message on.
    pub topic: String,
    /// Payload bytes (`Bytes` is cheap-clone, Arc-backed).
    pub payload: Bytes,
    /// Wall-clock instant the rumqttc task observed the message.
    pub received_at: Instant,
}

/// Receiver + EventLoop join handle handed to the caller.
#[derive(Debug)]
pub struct MqttMessageStream {
    rx: mpsc::Receiver<RawMqttMessage>,
    handle: JoinHandle<()>,
}

impl MqttMessageStream {
    /// Pull the next message; `None` means the EventLoop task exited.
    pub async fn recv(&mut self) -> Option<RawMqttMessage> {
        self.rx.recv().await
    }

    /// Stop the EventLoop task and wait for it to finish. The caller
    /// drops the receiver half (causing the event-loop task to return)
    /// and then awaits the task's `JoinHandle` so the runtime can
    /// shut down cleanly.
    pub async fn shutdown(self) {
        let Self { rx, handle } = self;
        drop(rx);
        let _ = handle.await;
    }
}

/// Validate the [`MqttConfig`] without touching the network.
pub fn validate_config(cfg: &MqttConfig) -> Result<(), MqttError> {
    if cfg.topic_filters.is_empty() {
        return Err(MqttError::NoTopicFilters);
    }
    if cfg.qos > 1 {
        return Err(MqttError::UnsupportedQos(cfg.qos));
    }
    parse_broker_url(&cfg.broker_url).map(|_| ())
}

/// Spawn the rumqttc EventLoop task and return a stream of incoming
/// messages.
pub async fn start(cfg: MqttConfig) -> Result<MqttMessageStream, MqttError> {
    validate_config(&cfg)?;
    let parsed_url = parse_broker_url(&cfg.broker_url)?;

    let mut opts = MqttOptions::new(&cfg.client_id, parsed_url.host, parsed_url.port);
    opts.set_keep_alive(Duration::from_secs(30));

    if parsed_url.tls {
        // Use rumqttc's default rustls transport — cert chain from
        // system roots. Full mTLS (client cert + custom CA) lands
        // alongside the NATS credential wiring in a follow-on commit
        // when we thread the TlsConfiguration builder through
        // MqttConfig.
        opts.set_transport(Transport::tls_with_default_config());
    }

    let (client, event_loop) = AsyncClient::new(opts, 1024);
    let (tx, rx) = mpsc::channel::<RawMqttMessage>(MQTT_CHANNEL_CAPACITY);

    let qos = qos_from_u8(cfg.qos);
    for filter in &cfg.topic_filters {
        client
            .subscribe(filter.clone(), qos)
            .await
            .map_err(|source| MqttError::Subscribe {
                filter: filter.clone(),
                source,
            })?;
    }

    let handle = tokio::spawn(run_event_loop(event_loop, tx));
    Ok(MqttMessageStream { rx, handle })
}

/// rumqttc EventLoop driver.
async fn run_event_loop(mut event_loop: EventLoop, tx: mpsc::Sender<RawMqttMessage>) {
    loop {
        match event_loop.poll().await {
            Ok(Event::Incoming(Packet::Publish(p))) => {
                let msg = RawMqttMessage {
                    topic: p.topic,
                    payload: p.payload,
                    received_at: Instant::now(),
                };
                if tx.send(msg).await.is_err() {
                    tracing::info!("mqtt receiver dropped; shutting down event loop");
                    return;
                }
            }
            Ok(other) => {
                tracing::trace!(?other, "mqtt non-publish event");
            }
            Err(e) => {
                tracing::warn!(error = %e, "mqtt event loop error; will retry");
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
}

const fn qos_from_u8(q: u8) -> QoS {
    match q {
        0 => QoS::AtMostOnce,
        _ => QoS::AtLeastOnce,
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedBrokerUrl {
    host: String,
    port: u16,
    tls: bool,
}

fn parse_broker_url(raw: &str) -> Result<ParsedBrokerUrl, MqttError> {
    let truncated = || {
        let mut s = raw.to_owned();
        s.truncate(64);
        s
    };
    let (scheme, rest) = raw
        .split_once("://")
        .ok_or_else(|| MqttError::InvalidBrokerUrl {
            got: truncated(),
            reason: "missing '://'",
        })?;
    let tls = match scheme {
        "mqtt" => false,
        "mqtts" => true,
        _ => {
            return Err(MqttError::InvalidBrokerUrl {
                got: truncated(),
                reason: "scheme must be mqtt:// or mqtts://",
            });
        }
    };
    let authority = rest.split('/').next().unwrap_or("");
    let Some((host_str, port_str)) = authority.rsplit_once(':') else {
        return Err(MqttError::InvalidBrokerUrl {
            got: truncated(),
            reason: "missing :port",
        });
    };
    if host_str.is_empty() {
        return Err(MqttError::InvalidBrokerUrl {
            got: truncated(),
            reason: "empty host",
        });
    }
    let port = port_str
        .parse::<u16>()
        .map_err(|_| MqttError::InvalidBrokerUrl {
            got: truncated(),
            reason: "port is not a u16",
        })?;
    Ok(ParsedBrokerUrl {
        host: host_str.to_owned(),
        port,
        tls,
    })
}

#[cfg(test)]
mod tests {
    use super::{MqttError, ParsedBrokerUrl, parse_broker_url, qos_from_u8, validate_config};
    use crate::config::MqttConfig;

    fn cfg(broker: &str, filters: Vec<&str>, qos: u8) -> MqttConfig {
        MqttConfig {
            broker_url: broker.to_owned(),
            client_id: "test".to_owned(),
            topic_filters: filters.into_iter().map(String::from).collect(),
            qos,
        }
    }

    #[test]
    fn parses_plain_mqtt() {
        let p = parse_broker_url("mqtt://broker.internal:1883").unwrap();
        assert_eq!(
            p,
            ParsedBrokerUrl {
                host: "broker.internal".to_owned(),
                port: 1883,
                tls: false,
            }
        );
    }

    #[test]
    fn parses_mqtts() {
        let p = parse_broker_url("mqtts://nats:8883").unwrap();
        assert!(p.tls);
        assert_eq!(p.port, 8883);
    }

    #[test]
    fn parses_with_trailing_path() {
        let p = parse_broker_url("mqtt://b:1883/health").unwrap();
        assert_eq!(p.host, "b");
        assert_eq!(p.port, 1883);
    }

    #[test]
    fn rejects_missing_scheme() {
        match parse_broker_url("broker:1883") {
            Err(MqttError::InvalidBrokerUrl { reason, .. }) => assert!(reason.contains("'://'")),
            other => panic!("expected InvalidBrokerUrl, got {other:?}"),
        }
    }

    #[test]
    fn rejects_wrong_scheme() {
        match parse_broker_url("ws://broker:1883") {
            Err(MqttError::InvalidBrokerUrl { reason, .. }) => assert!(reason.contains("scheme")),
            other => panic!("expected InvalidBrokerUrl, got {other:?}"),
        }
    }

    #[test]
    fn rejects_missing_port() {
        match parse_broker_url("mqtt://broker") {
            Err(MqttError::InvalidBrokerUrl { reason, .. }) => assert!(reason.contains(":port")),
            other => panic!("expected InvalidBrokerUrl, got {other:?}"),
        }
    }

    #[test]
    fn rejects_non_u16_port() {
        match parse_broker_url("mqtt://broker:abc") {
            Err(MqttError::InvalidBrokerUrl { reason, .. }) => assert!(reason.contains("u16")),
            other => panic!("expected InvalidBrokerUrl, got {other:?}"),
        }
    }

    #[test]
    fn rejects_empty_host() {
        match parse_broker_url("mqtt://:1883") {
            Err(MqttError::InvalidBrokerUrl { reason, .. }) => {
                assert!(reason.contains("empty host"));
            }
            other => panic!("expected InvalidBrokerUrl, got {other:?}"),
        }
    }

    #[test]
    fn truncates_long_url_in_error() {
        let bad: String = std::iter::repeat_n('x', 200).collect();
        match parse_broker_url(&bad) {
            Err(MqttError::InvalidBrokerUrl { got, .. }) => {
                assert_eq!(got.len(), 64, "log echo should be truncated");
            }
            other => panic!("expected InvalidBrokerUrl, got {other:?}"),
        }
    }

    #[test]
    fn validate_config_happy() {
        let c = cfg("mqtt://b:1883", vec!["sensors/#"], 1);
        assert!(validate_config(&c).is_ok());
    }

    #[test]
    fn validate_config_rejects_empty_filters() {
        let c = cfg("mqtt://b:1883", vec![], 1);
        match validate_config(&c) {
            Err(MqttError::NoTopicFilters) => {}
            other => panic!("expected NoTopicFilters, got {other:?}"),
        }
    }

    #[test]
    fn validate_config_rejects_qos2() {
        let c = cfg("mqtt://b:1883", vec!["sensors/#"], 2);
        match validate_config(&c) {
            Err(MqttError::UnsupportedQos(q)) => assert_eq!(q, 2),
            other => panic!("expected UnsupportedQos, got {other:?}"),
        }
    }

    #[test]
    fn validate_config_propagates_url_error() {
        let c = cfg("ws://broker", vec!["sensors/#"], 1);
        assert!(validate_config(&c).is_err());
    }

    #[test]
    fn qos_mapping() {
        use rumqttc::QoS;
        assert!(matches!(qos_from_u8(0), QoS::AtMostOnce));
        assert!(matches!(qos_from_u8(1), QoS::AtLeastOnce));
    }
}
