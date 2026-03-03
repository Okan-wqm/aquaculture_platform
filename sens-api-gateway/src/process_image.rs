use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use chrono::{DateTime, Utc};
use serde::{Serialize, Deserialize};

/// Tag data quality following OPC UA quality codes
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TagQuality {
    Good,
    Uncertain,
    Bad,
    CommFailure,
    NotInitialized,
}

impl TagQuality {
    /// Convert to OPC UA numeric quality code
    pub fn to_quality_code(self) -> u8 {
        match self {
            TagQuality::Good => 192,
            TagQuality::Uncertain => 64,
            TagQuality::Bad => 0,
            TagQuality::CommFailure => 24,
            TagQuality::NotInitialized => 32,
        }
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
    Gpio { pin: u8, direction: String },
    Modbus { slave_id: u8, register: u16, function: u8, register_type: String },
    I2c { bus: u8, address: u8, driver_type: I2cDriverType },
    Spi { bus: u8, cs: u8 },
    Uart { port: String },
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
}

impl ProcessImage {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(ProcessImageInner {
                tags: HashMap::new(),
                configs: HashMap::new(),
            })),
        }
    }

    /// Update a tag value in the process image
    pub async fn update_tag(&self, name: &str, value: f64, quality: TagQuality, source: TagSource) {
        let mut inner = self.inner.write().await;
        let raw_value = inner.tags.get(name).and_then(|t| t.raw_value);

        // Apply scaling if config exists
        let (scaled_value, raw) = if let Some(config) = inner.configs.get(name) {
            let scaled = Self::scale_value_inner(value, config);
            (scaled, Some(value))
        } else {
            (value, raw_value)
        };

        inner.tags.insert(name.to_string(), TagValue {
            value: scaled_value,
            quality,
            timestamp: Utc::now(),
            raw_value: raw,
            source,
        });
    }

    /// Update a tag with a pre-scaled value (no scaling applied)
    pub async fn update_tag_raw(&self, name: &str, value: f64, quality: TagQuality, source: TagSource) {
        let mut inner = self.inner.write().await;
        inner.tags.insert(name.to_string(), TagValue {
            value,
            quality,
            timestamp: Utc::now(),
            raw_value: Some(value),
            source,
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
        match (config.raw_min, config.raw_max, config.eng_min, config.eng_max) {
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
