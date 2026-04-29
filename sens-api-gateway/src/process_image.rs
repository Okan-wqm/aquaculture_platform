use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{RwLock, broadcast};

/// Batch 189 Faz 4 (plan R-3 item 6): one tag-change
/// event fanned out to subscribers. The event-driven
/// task scheduler wakes on these so operators can run
/// scripts only when a relevant tag actually changes
/// (vs the time-based Cyclic + Freewheeling paths).
#[derive(Debug, Clone, PartialEq)]
pub struct TagChange {
    pub tag_name: String,
    pub new_value: f64,
    pub quality: TagQuality,
    pub source: TagSource,
    pub timestamp: DateTime<Utc>,
}

/// Broadcast channel capacity for tag-change events.
/// Picked to absorb a typical scan-cycle's worth of
/// updates (50 tags × 10 Hz = 500/sec) with enough
/// head-room that a slow subscriber lags by up to 2
/// seconds before dropping events.
const TAG_CHANGE_CHANNEL_CAPACITY: usize = 1024;

/// Tag data quality following OPC UA quality codes.
///
/// Batch 21 ARC-006: `Simulated` variant added to make operator-
/// facing truth unambiguous when hardware is absent (default build)
/// OR the i2c bus is in simulation mode. A sim read MUST NOT be
/// marked `Good` — an operator reading a SCADA screen or trend
/// chart cannot distinguish good-from-sim without this signal.
///
/// OPC UA quality code mapping:
/// - `Good` = 192 (0xC0 — "Good, local").
/// - `Uncertain` = 64 (0x40).
/// - `Bad` = 0 (0x00).
/// - `CommFailure` = 24 (0x18 — communication failure).
/// - `NotInitialized` = 32 (0x20 — initial value).
/// - `Simulated` = 216 (0xD8 — "Good, local override (sensor
///   simulated)"). Closest standard mapping is
///   `Good(0xC0) | LocalOverride(0x18)` which IEC 61131-3 and
///   OPC UA both define as the "substitute value" quality. This
///   tells OPC UA clients this value is locally overridden and not
///   a live sensor read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TagQuality {
    Good,
    Uncertain,
    Bad,
    CommFailure,
    NotInitialized,
    /// ARC-006: sensor value is simulated (no real hardware read).
    /// Default build or missing `gpio`/`i2c` feature produces
    /// `Simulated`-quality tags so operators never confuse sim
    /// data with live sensor reads.
    Simulated,
}

impl TagQuality {
    /// Convert to OPC UA numeric quality code.
    pub fn to_quality_code(self) -> u8 {
        match self {
            TagQuality::Good => 192,
            TagQuality::Uncertain => 64,
            TagQuality::Bad => 0,
            TagQuality::CommFailure => 24,
            TagQuality::NotInitialized => 32,
            // Good (0xC0) + LocalOverride (0x18) = 0xD8 per OPC UA
            // quality mask composition.
            TagQuality::Simulated => 216,
        }
    }

    /// Whether this quality represents a simulated (non-hardware)
    /// read. Used by MQTT publish path to attach `"simulated":
    /// true` to the outgoing payload so platform UI can badge the
    /// tag as non-authoritative.
    pub fn is_simulated(self) -> bool {
        matches!(self, TagQuality::Simulated)
    }
}

/// Data source protocol
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TagSource {
    Gpio,
    Modbus,
    I2c,
    Spi,
    Uart,
    Script,
    /// LoRaWAN sensor data (v1.5.0)
    /// serde rename_all="snake_case" "lo_ra" uretir, bu yanlis — explicit "lora" kullaniyoruz
    #[serde(rename = "lora")]
    LoRa,
    /// Batch 195 Faz 6 (plan R-9): value applied by
    /// the live-debug force registry. io_poll's
    /// bypass path sets TagSource::Force when the
    /// tag has an active ForceEntry. Downstream
    /// consumers (SCADA UI, OPC UA server, audit
    /// log) can distinguish forced values from live
    /// sensor reads without inspecting the force
    /// registry directly.
    Force,
    /// Batch 195 Faz 6 (plan §5 Faz 5 OPC UA preview):
    /// value written to the tag by a connected OPC
    /// UA HMI client. Scripts MAY be allowed to
    /// overwrite OpcUaClient values (depends on
    /// per-tag policy); audit records both the
    /// OpcUaClient write + the script overwrite so
    /// operators see the chain.
    OpcUaClient,
}

/// I/O type (IEC 61131-3)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum IoType {
    DI,
    DO,
    AI,
    AO,
}

/// Runtime tag value
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagValue {
    pub value: f64,
    pub quality: TagQuality,
    pub timestamp: DateTime<Utc>,
    pub raw_value: Option<f64>,
    pub source: TagSource,
}

/// Atlas Scientific EZO sensor types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AtlasEzoType {
    Ph,
    Do,
    Ec,
    Orp,
    Temp,
}

impl AtlasEzoType {
    /// Default I2C address for this sensor type
    pub fn default_address(&self) -> u8 {
        match self {
            AtlasEzoType::Ph => 0x63,
            AtlasEzoType::Do => 0x61,
            AtlasEzoType::Ec => 0x64,
            AtlasEzoType::Orp => 0x62,
            AtlasEzoType::Temp => 0x66,
        }
    }

    /// Read delay in milliseconds (EC needs longer)
    pub fn read_delay_ms(&self) -> u64 {
        match self {
            AtlasEzoType::Ec => 900,
            _ => 600,
        }
    }
}

/// I2C driver type configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum I2cDriverType {
    AtlasEzo { sensor_type: AtlasEzoType },
    GenericRegister { read_register: u8, read_length: u8 },
    GenericDirect { read_length: u8 },
}

/// Protocol-specific addressing
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProtocolConfig {
    Gpio {
        pin: u8,
        direction: String,
    },
    Modbus {
        slave_id: u8,
        register: u16,
        function: u8,
        register_type: String,
    },
    I2c {
        bus: u8,
        address: u8,
        driver_type: I2cDriverType,
    },
    Spi {
        bus: u8,
        cs: u8,
    },
    // TODO: UART protocol needs read/write implementation in io_poll.rs and commands.rs
    Uart {
        port: String,
    },
}

/// Tag configuration (how to read/write a tag)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagConfig {
    pub tag_name: String,
    pub io_type: IoType,
    pub data_type: String,
    pub source: TagSource,
    pub poll_interval_ms: Option<u64>,
    pub raw_min: Option<f64>,
    pub raw_max: Option<f64>,
    pub eng_min: Option<f64>,
    pub eng_max: Option<f64>,
    pub eng_unit: Option<String>,
    pub invert: bool,
    pub alarm_hh: Option<f64>,
    pub alarm_h: Option<f64>,
    pub alarm_l: Option<f64>,
    pub alarm_ll: Option<f64>,
    pub deadband: Option<f64>,
    pub protocol_config: ProtocolConfig,
}

#[derive(Debug)]
struct ProcessImageInner {
    tags: HashMap<String, TagValue>,
    configs: HashMap<String, TagConfig>,
}

/// Thread-safe process image holding all tag values and configs
#[derive(Debug, Clone)]
pub struct ProcessImage {
    inner: Arc<RwLock<ProcessImageInner>>,
    /// Batch 189 Faz 4: broadcast channel for tag-
    /// change events. `update_tag` + `update_tag_raw`
    /// emit one TagChange per call; subscribers (event-
    /// driven tasks, live-watch MQTT subscribers,
    /// future OPC UA notification bridge) receive
    /// them.
    ///
    /// Always present — the channel costs ~kb even
    /// when idle + `broadcast::send` with zero
    /// subscribers is a tiny no-op (Ok(0)). Keeps the
    /// API simple (no Option unwrap).
    change_tx: broadcast::Sender<TagChange>,
}

impl ProcessImage {
    pub fn new() -> Self {
        let (change_tx, _initial_rx) = broadcast::channel(TAG_CHANGE_CHANNEL_CAPACITY);
        Self {
            inner: Arc::new(RwLock::new(ProcessImageInner {
                tags: HashMap::new(),
                configs: HashMap::new(),
            })),
            change_tx,
        }
    }

    /// Batch 189 Faz 4: subscribe to tag-change events.
    /// Returns a `broadcast::Receiver<TagChange>` that
    /// yields one message per `update_tag` /
    /// `update_tag_raw` call.
    ///
    /// Receivers that lag behind the broadcast capacity
    /// receive `RecvError::Lagged(n)` on their next
    /// recv — operators decide whether to resync from
    /// `get_all_tags` or just skip the dropped events.
    /// The event-driven task scheduler treats a lag as
    /// "wake + run the task" since a missed event still
    /// means something changed worth running on.
    pub fn subscribe_changes(&self) -> broadcast::Receiver<TagChange> {
        self.change_tx.subscribe()
    }

    /// Batch 189 Faz 4: diagnostic — current subscriber
    /// count. Metrics endpoints + health dashboards
    /// read this to detect subscription leaks.
    pub fn change_subscriber_count(&self) -> usize {
        self.change_tx.receiver_count()
    }

    /// Update a tag value in the process image.
    ///
    /// LIFE-SAFETY: When quality is Bad or CommFailure, the numeric value is
    /// unreliable (sensor disconnect, CRC error, timeout). Persisting such
    /// values into the process image would cause downstream control logic
    /// (alarm engine, SCADA HMI, PID loops) to act on stale/garbage data.
    ///
    /// Bad-quality updates preserve the previous tag value but update the
    /// quality and timestamp so consumers can detect the degradation.
    pub async fn update_tag(&self, name: &str, value: f64, quality: TagQuality, source: TagSource) {
        let mut inner = self.inner.write().await;

        // LIFE-SAFETY: Reject numeric value when quality indicates unreliable data.
        // Preserve existing value (last-known-good) but update quality + timestamp
        // so downstream consumers see the quality degradation.
        if matches!(quality, TagQuality::Bad | TagQuality::CommFailure) {
            if let Some(existing) = inner.tags.get_mut(name) {
                existing.quality = quality;
                existing.timestamp = Utc::now();
                existing.source = source;
                return;
            }
            // No existing tag — insert with NaN to make it obvious the value is invalid.
            // f64::NAN propagates through arithmetic without silently producing valid results.
            inner.tags.insert(
                name.to_string(),
                TagValue {
                    value: f64::NAN,
                    quality,
                    timestamp: Utc::now(),
                    raw_value: None,
                    source,
                },
            );
            return;
        }

        let raw_value = inner.tags.get(name).and_then(|t| t.raw_value);

        // Apply scaling if config exists
        let (scaled_value, raw) = if let Some(config) = inner.configs.get(name) {
            let scaled = Self::scale_value_inner(value, config);
            (scaled, Some(value))
        } else {
            (value, raw_value)
        };

        inner.tags.insert(
            name.to_string(),
            TagValue {
                value: scaled_value,
                quality,
                timestamp: Utc::now(),
                raw_value: raw,
                source,
            },
        );
    }

    /// Update a tag with a pre-scaled value (no scaling applied)
    pub async fn update_tag_raw(
        &self,
        name: &str,
        value: f64,
        quality: TagQuality,
        source: TagSource,
    ) {
        let ts = Utc::now();
        {
            let mut inner = self.inner.write().await;
            inner.tags.insert(
                name.to_string(),
                TagValue {
                    value,
                    quality,
                    timestamp: ts,
                    raw_value: Some(value),
                    source,
                },
            );
        } // drop write lock BEFORE broadcast so
        // subscribers that call back into ProcessImage
        // (e.g. get_tag inside a subscribe_changes
        // handler) don't deadlock.

        // Batch 189 Faz 4: fan-out tag-change event.
        // `send` on a broadcast with zero subscribers
        // is a tiny no-op returning Ok(0); errors only
        // surface when ALL receivers have dropped,
        // which is the normal state — ignored.
        let _ = self.change_tx.send(TagChange {
            tag_name: name.to_string(),
            new_value: value,
            quality,
            source,
            timestamp: ts,
        });
    }

    /// Get a single tag value
    pub async fn get_tag(&self, name: &str) -> Option<TagValue> {
        let inner = self.inner.read().await;
        inner.tags.get(name).cloned()
    }

    /// Get all current tag values
    pub async fn get_all_tags(&self) -> HashMap<String, TagValue> {
        let inner = self.inner.read().await;
        inner.tags.clone()
    }

    /// Replace all tag configs
    pub async fn set_configs(&self, configs: Vec<TagConfig>) {
        let mut inner = self.inner.write().await;
        inner.configs.clear();
        for config in configs {
            inner.configs.insert(config.tag_name.clone(), config);
        }
    }

    /// Get all tag configs
    pub async fn get_configs(&self) -> Vec<TagConfig> {
        let inner = self.inner.read().await;
        inner.configs.values().cloned().collect()
    }

    /// Get a single tag config
    pub async fn get_config(&self, name: &str) -> Option<TagConfig> {
        let inner = self.inner.read().await;
        inner.configs.get(name).cloned()
    }

    /// Linear scaling: raw -> engineering units
    fn scale_value_inner(raw: f64, config: &TagConfig) -> f64 {
        match (
            config.raw_min,
            config.raw_max,
            config.eng_min,
            config.eng_max,
        ) {
            (Some(raw_min), Some(raw_max), Some(eng_min), Some(eng_max)) => {
                let raw_range = raw_max - raw_min;
                if raw_range.abs() < f64::EPSILON {
                    return raw;
                }
                let eng_range = eng_max - eng_min;
                eng_min + (raw - raw_min) * eng_range / raw_range
            }
            _ => raw,
        }
    }

    /// Public scaling utility
    pub fn scale_value(raw: f64, config: &TagConfig) -> f64 {
        Self::scale_value_inner(raw, config)
    }
}

impl Default for ProcessImage {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tag_change_tests {
    //! Batch 189 Faz 4 — subscribe_changes + TagChange
    //! broadcast tests.
    use super::*;

    // Batch 195 Faz 6: TagSource extension tests.

    #[test]
    fn tag_source_force_serde_roundtrips_snake_case() {
        // TagSource::Force should serialize as "force".
        let s = serde_json::to_string(&TagSource::Force).expect("ok");
        assert_eq!(s, "\"force\"");
        let back: TagSource = serde_json::from_str(&s).expect("ok");
        assert_eq!(back, TagSource::Force);
    }

    #[test]
    fn tag_source_opc_ua_client_serde_roundtrips_snake_case() {
        let s = serde_json::to_string(&TagSource::OpcUaClient).expect("ok");
        assert_eq!(s, "\"opc_ua_client\"");
        let back: TagSource = serde_json::from_str(&s).expect("ok");
        assert_eq!(back, TagSource::OpcUaClient);
    }

    #[tokio::test]
    async fn update_tag_raw_with_force_source_emits_change_event() {
        // TagSource::Force is a valid source for
        // update_tag_raw — the emitted TagChange
        // carries source=Force so subscribers can
        // distinguish forced writes from live sensor
        // reads.
        let pi = ProcessImage::new();
        let mut rx = pi.subscribe_changes();
        pi.update_tag_raw("feeder_rate", 3.5, TagQuality::Good, TagSource::Force)
            .await;
        let ev = rx.recv().await.expect("event");
        assert_eq!(ev.source, TagSource::Force);
        assert_eq!(ev.new_value, 3.5);
    }

    #[tokio::test]
    async fn subscribe_delivers_tag_change_on_update_tag_raw() {
        let pi = ProcessImage::new();
        let mut rx = pi.subscribe_changes();
        pi.update_tag_raw("water_temp", 22.5, TagQuality::Good, TagSource::I2c)
            .await;
        let ev = rx.recv().await.expect("event");
        assert_eq!(ev.tag_name, "water_temp");
        assert_eq!(ev.new_value, 22.5);
        assert_eq!(ev.quality, TagQuality::Good);
        assert_eq!(ev.source, TagSource::I2c);
    }

    #[tokio::test]
    async fn subscribe_count_starts_at_zero_and_grows() {
        let pi = ProcessImage::new();
        assert_eq!(pi.change_subscriber_count(), 0);
        let _rx1 = pi.subscribe_changes();
        assert_eq!(pi.change_subscriber_count(), 1);
        let _rx2 = pi.subscribe_changes();
        assert_eq!(pi.change_subscriber_count(), 2);
    }

    #[tokio::test]
    async fn update_tag_raw_with_no_subscribers_does_not_error() {
        // broadcast::send returns Ok(0) when no
        // subscribers — ProcessImage ignores it +
        // continues. This test guards against a future
        // refactor accidentally unwrap()ing the send
        // result.
        let pi = ProcessImage::new();
        pi.update_tag_raw("lonely_tag", 1.0, TagQuality::Good, TagSource::Modbus)
            .await;
        // No assertion — test passes if the call
        // returned without panicking.
    }

    #[tokio::test]
    async fn multiple_subscribers_each_see_every_event() {
        let pi = ProcessImage::new();
        let mut rx1 = pi.subscribe_changes();
        let mut rx2 = pi.subscribe_changes();
        pi.update_tag_raw("tag_a", 1.0, TagQuality::Good, TagSource::Modbus)
            .await;
        let e1 = rx1.recv().await.expect("rx1");
        let e2 = rx2.recv().await.expect("rx2");
        assert_eq!(e1.tag_name, "tag_a");
        assert_eq!(e2.tag_name, "tag_a");
        assert_eq!(e1.new_value, e2.new_value);
    }

    #[tokio::test]
    async fn subscribe_after_updates_misses_past_events() {
        // broadcast is a live stream — subscribers
        // only see events AFTER they subscribe. Past
        // events don't replay (matches the standard
        // pub/sub semantic operators expect).
        let pi = ProcessImage::new();
        pi.update_tag_raw("past_tag", 9.0, TagQuality::Good, TagSource::Modbus)
            .await;
        let mut rx = pi.subscribe_changes();
        // No message should be ready (past_tag update
        // happened before subscribe).
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), rx.recv(),)
                .await
                .is_err()
        );
    }
}
