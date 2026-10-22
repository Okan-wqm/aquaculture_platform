//! The one place a tag becomes a write to hardware (ADR-048 DEC-9.7;
//! EDGE-HIGH-062).
//!
//! Every ingress path used to improvise its own tag-to-device-to-function
//! mapping. The MQTT `set_output` wrote every Modbus tag as an FC05 coil
//! (`value != 0`) to the first device whose slave id matched, whatever the
//! tag's register type; the HMI executor wrote to `config.modbus.first()` (the
//! wrong PLC as soon as there were two) and saturated an out-of-range analog
//! value into a `u16`. Both now resolve the tag here, and the answer is a
//! typed [`WriteTarget`] that says which device, which function and which
//! value, or a [`Refusal`] that says why not:
//!
//! * the device is the one that owns the register: the one whose configured
//!   register carries the tag's name (the name is also how reads reach the
//!   tag), else the only device with the tag's slave id; two devices that
//!   share a slave id are ambiguous and refused, never guessed;
//! * the function follows the register type (coil: FC5, holding: FC6; input
//!   and discrete registers are read-only) and the tag's own `function` must
//!   agree with it;
//! * an analog value is scaled back to the register's raw units, must be
//!   inside what the register's data type holds, and is refused otherwise: it
//!   is never saturated, and a 32-bit value does not fit the single-register
//!   write the agent implements;
//! * only an output (`DO`, `AO`) is written.
//!
//! [`write_tag`] checks the force registry first, for the tag of every backend
//! (a forced tag is held at its forced value: a remote command or the HMI does not
//! overwrite it, as OPC UA and the piControl handle never did), and [`write`] then
//! performs the write through the hardware handles, which keep their own
//! degraded-mode gate (the piControl handle checks the force registry once more).
//! The safe-state pass does not come through here: a force never keeps an output
//! from its safe value.

use crate::AppState;
use crate::config::{AgentConfig, ModbusDeviceConfig, ModbusRegisterConfig};
use crate::process_image::{IoType, ProtocolConfig, TagConfig, TagQuality};
use crate::safe_state::OutputId;

/// A resolved write.
#[derive(Debug, Clone, PartialEq)]
pub enum WriteTarget {
    Gpio {
        pin: u8,
        high: bool,
    },
    ModbusCoil {
        device: String,
        address: u16,
        on: bool,
    },
    ModbusRegister {
        device: String,
        address: u16,
        raw: u16,
    },
    I2c {
        tag: String,
        data: Vec<u8>,
    },
    PiControl {
        tag: String,
        value: f64,
    },
}

impl WriteTarget {
    /// The kind of hardware the target is on (a row of the behaviour table). Only
    /// the test that keeps the table and the remote holds together asks.
    #[cfg(test)]
    pub fn backend(&self) -> crate::safe_state::behaviour::Backend {
        use crate::safe_state::behaviour::Backend;
        match self {
            Self::Gpio { .. } => Backend::Gpio,
            Self::ModbusCoil { .. } | Self::ModbusRegister { .. } => Backend::Modbus,
            Self::I2c { .. } => Backend::I2c,
            Self::PiControl { .. } => Backend::PiControl,
        }
    }

    /// The identity of the output, as the safe-state registry and the remote
    /// holds spell it; `None` for a target with no registered output.
    ///
    /// An I2C tag has none: it names a bus and an address, the registry's I2C
    /// output a device and a register, nothing maps one to the other, and no
    /// configuration registers an I2C output. A remote write to it therefore
    /// records no hold, and the behaviour table says so for the I2C row of a
    /// cloud communications loss (the test below keeps the two together).
    pub fn output_id(&self) -> Option<OutputId> {
        match self {
            Self::Gpio { pin, .. } => Some(OutputId::gpio_pin(*pin)),
            Self::ModbusCoil {
                device, address, ..
            } => Some(OutputId::modbus_coil(device, *address)),
            Self::ModbusRegister {
                device, address, ..
            } => Some(OutputId::modbus_register(device, *address)),
            Self::PiControl { tag, .. } => Some(OutputId::picontrol(tag)),
            Self::I2c { .. } => None,
        }
    }
}

/// Why a tag cannot be written with this value.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum Refusal {
    #[error("the value {0} is not a finite number")]
    NotFinite(f64),
    #[error("tag '{tag}' is an input ({io_type:?}), not an output")]
    NotAnOutput { tag: String, io_type: IoType },
    #[error("no Modbus device is configured for slave id {0}")]
    NoDevice(u8),
    #[error(
        "slave id {slave_id} belongs to more than one Modbus device ({devices}); name the \
         register in the device configuration so the tag has one device"
    )]
    AmbiguousSlaveId { slave_id: u8, devices: String },
    #[error("the register name '{0}' is configured on more than one Modbus device")]
    AmbiguousRegisterName(String),
    #[error(
        "tag '{tag}' says slave {slave_id} register {register}, but the device configuration \
         ({device}) says slave {device_slave} register {device_register}"
    )]
    ConfigDisagrees {
        tag: String,
        slave_id: u8,
        register: u16,
        device: String,
        device_slave: u8,
        device_register: u16,
    },
    #[error("register type '{0}' cannot be written (input and discrete registers are read-only)")]
    ReadOnlyRegister(String),
    #[error("register type '{0}' is not a Modbus register type")]
    UnknownRegisterType(String),
    #[error("register type '{register_type}' and function code {function} disagree")]
    FunctionDisagrees { register_type: String, function: u8 },
    #[error(
        "data type '{0}' spans more than one register; the agent writes single registers \
         (FC6) only"
    )]
    WideRegister(String),
    #[error("the value {value} is {raw} in raw units, outside {min}..={max} for {data_type}")]
    OutOfRange {
        value: f64,
        raw: f64,
        min: f64,
        max: f64,
        data_type: String,
    },
    #[error("a write to a {0} tag is not supported")]
    UnsupportedProtocol(&'static str),
    #[error("a {0} tag has no safe-state output: the agent has no safe value to drive for it")]
    NoSafeStateOutput(&'static str),
}

/// The kind of register a Modbus write goes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Coil,
    Holding,
}

/// Resolve the write of `value` to `tag` against the configuration as it is.
pub fn resolve(config: &AgentConfig, tag: &TagConfig, value: f64) -> Result<WriteTarget, Refusal> {
    if !value.is_finite() {
        return Err(Refusal::NotFinite(value));
    }
    if !matches!(tag.io_type, IoType::DO | IoType::AO) {
        return Err(Refusal::NotAnOutput {
            tag: tag.tag_name.clone(),
            io_type: tag.io_type,
        });
    }
    match &tag.protocol_config {
        ProtocolConfig::Gpio { pin, .. } => Ok(WriteTarget::Gpio {
            pin: *pin,
            high: value != 0.0,
        }),
        ProtocolConfig::Modbus {
            slave_id,
            register,
            function,
            register_type,
        } => resolve_modbus(
            config,
            tag,
            *slave_id,
            *register,
            *function,
            register_type,
            value,
        ),
        ProtocolConfig::I2c { .. } => Ok(WriteTarget::I2c {
            tag: tag.tag_name.clone(),
            data: raw_i2c(value)?.to_be_bytes().to_vec(),
        }),
        ProtocolConfig::PiControl { .. } => Ok(WriteTarget::PiControl {
            tag: tag.tag_name.clone(),
            value,
        }),
        ProtocolConfig::Spi { .. } => Err(Refusal::UnsupportedProtocol("SPI")),
        ProtocolConfig::Uart { .. } => Err(Refusal::UnsupportedProtocol("UART")),
    }
}

/// The device and register a Modbus tag names, and what kind of register it
/// is: the part of the resolution that does not depend on a value.
struct Located<'a> {
    device: &'a ModbusDeviceConfig,
    configured: Option<&'a ModbusRegisterConfig>,
    kind: Kind,
    address: u16,
}

fn locate_modbus<'a>(
    config: &'a AgentConfig,
    tag: &TagConfig,
    slave_id: u8,
    register: u16,
    function: u8,
    register_type: &str,
) -> Result<Located<'a>, Refusal> {
    // The configured register that carries the tag's name is how reads reach
    // the tag, so it is the register the tag means.
    let named: Vec<(&ModbusDeviceConfig, &ModbusRegisterConfig)> = config
        .modbus
        .iter()
        .flat_map(|device| {
            device
                .registers
                .iter()
                .filter(|r| r.name == tag.tag_name)
                .map(move |r| (device, r))
        })
        .collect();
    let (device, configured) = match named.as_slice() {
        [] => (single_device(config, slave_id)?, None),
        [(device, configured)] => {
            if device.slave_id != slave_id || configured.address != register {
                return Err(Refusal::ConfigDisagrees {
                    tag: tag.tag_name.clone(),
                    slave_id,
                    register,
                    device: device.name.clone(),
                    device_slave: device.slave_id,
                    device_register: configured.address,
                });
            }
            (*device, Some(*configured))
        }
        _ => return Err(Refusal::AmbiguousRegisterName(tag.tag_name.clone())),
    };

    let declared = configured.map_or(register_type, |c| c.register_type.as_str());
    let kind = match declared.to_ascii_lowercase().as_str() {
        "coil" => Kind::Coil,
        "holding" => Kind::Holding,
        "input" | "discrete" => return Err(Refusal::ReadOnlyRegister(declared.to_owned())),
        other => return Err(Refusal::UnknownRegisterType(other.to_owned())),
    };
    let agrees = match kind {
        Kind::Coil => matches!(function, 1 | 5 | 15),
        Kind::Holding => matches!(function, 3 | 6 | 16),
    };
    if !agrees {
        return Err(Refusal::FunctionDisagrees {
            register_type: declared.to_owned(),
            function,
        });
    }
    Ok(Located {
        device,
        configured,
        kind,
        address: register,
    })
}

fn resolve_modbus(
    config: &AgentConfig,
    tag: &TagConfig,
    slave_id: u8,
    register: u16,
    function: u8,
    register_type: &str,
    value: f64,
) -> Result<WriteTarget, Refusal> {
    let located = locate_modbus(config, tag, slave_id, register, function, register_type)?;
    match located.kind {
        Kind::Coil => Ok(WriteTarget::ModbusCoil {
            device: located.device.name.clone(),
            address: located.address,
            on: value != 0.0,
        }),
        Kind::Holding => {
            let data_type = located
                .configured
                .map_or(tag.data_type.as_str(), |c| c.data_type.as_str());
            let raw = raw_register(tag, located.configured, data_type, value)?;
            Ok(WriteTarget::ModbusRegister {
                device: located.device.name.clone(),
                address: located.address,
                raw,
            })
        }
    }
}

/// The identity of the output `tag` is, as the safe-state registry spells it,
/// without a value to write (the emergency stop scopes itself to tags this
/// way). A tag that is not an output, or has no registered output, is refused.
pub fn output_id_of(config: &AgentConfig, tag: &TagConfig) -> Result<OutputId, Refusal> {
    if !matches!(tag.io_type, IoType::DO | IoType::AO) {
        return Err(Refusal::NotAnOutput {
            tag: tag.tag_name.clone(),
            io_type: tag.io_type,
        });
    }
    match &tag.protocol_config {
        ProtocolConfig::Gpio { pin, .. } => Ok(OutputId::gpio_pin(*pin)),
        ProtocolConfig::Modbus {
            slave_id,
            register,
            function,
            register_type,
        } => {
            let located =
                locate_modbus(config, tag, *slave_id, *register, *function, register_type)?;
            Ok(match located.kind {
                Kind::Coil => OutputId::modbus_coil(&located.device.name, located.address),
                Kind::Holding => OutputId::modbus_register(&located.device.name, located.address),
            })
        }
        ProtocolConfig::PiControl { .. } => Ok(OutputId::picontrol(&tag.tag_name)),
        ProtocolConfig::I2c { .. } => Err(Refusal::NoSafeStateOutput("I2C")),
        ProtocolConfig::Spi { .. } => Err(Refusal::UnsupportedProtocol("SPI")),
        ProtocolConfig::Uart { .. } => Err(Refusal::UnsupportedProtocol("UART")),
    }
}

/// The only device with `slave_id`.
fn single_device(config: &AgentConfig, slave_id: u8) -> Result<&ModbusDeviceConfig, Refusal> {
    let mut candidates = config.modbus.iter().filter(|d| d.slave_id == slave_id);
    match (candidates.next(), candidates.next()) {
        (None, _) => Err(Refusal::NoDevice(slave_id)),
        (Some(device), None) => Ok(device),
        (Some(first), Some(second)) => Err(Refusal::AmbiguousSlaveId {
            slave_id,
            devices: [first, second]
                .iter()
                .map(|d| d.name.as_str())
                .chain(candidates.map(|d| d.name.as_str()))
                .collect::<Vec<_>>()
                .join(", "),
        }),
    }
}

/// The 32-bit big-endian payload of a direct I2C write: the value rounded, and
/// refused when it is not a number that fits. A bare `value as u32` saturated an
/// oversize value to `u32::MAX` and clamped a negative one to 0, so a command for
/// -5 drove the device to 0 and one for 1e12 to full scale, as the Modbus path
/// never does.
fn raw_i2c(value: f64) -> Result<u32, Refusal> {
    let rounded = value.round();
    let max = f64::from(u32::MAX);
    if !rounded.is_finite() || rounded < 0.0 || rounded > max {
        return Err(Refusal::OutOfRange {
            value,
            raw: value,
            min: 0.0,
            max,
            data_type: "u32 (direct I2C write)".to_owned(),
        });
    }
    Ok(rounded as u32)
}

/// An engineering value scaled back to the register's raw units, checked
/// against what the data type holds.
fn raw_register(
    tag: &TagConfig,
    configured: Option<&ModbusRegisterConfig>,
    data_type: &str,
    value: f64,
) -> Result<u16, Refusal> {
    let (min, max) = match data_type.to_ascii_lowercase().as_str() {
        "u16" => (0.0, f64::from(u16::MAX)),
        "i16" => (f64::from(i16::MIN), f64::from(i16::MAX)),
        wide @ ("u32" | "i32" | "f32" | "u64" | "i64" | "f64") => {
            return Err(Refusal::WideRegister(wide.to_owned()));
        }
        // An unnamed data type is the register's width.
        _ => (0.0, f64::from(u16::MAX)),
    };
    let raw = match (tag.raw_min, tag.raw_max, tag.eng_min, tag.eng_max) {
        (Some(raw_min), Some(raw_max), Some(eng_min), Some(eng_max))
            if (eng_max - eng_min).abs() >= f64::EPSILON =>
        {
            raw_min + (value - eng_min) * (raw_max - raw_min) / (eng_max - eng_min)
        }
        _ => match configured {
            Some(c) if c.scale != 0.0 && c.scale.is_finite() => value / c.scale,
            _ => value,
        },
    };
    let rounded = raw.round();
    if !rounded.is_finite() || rounded < min || rounded > max {
        return Err(Refusal::OutOfRange {
            value,
            raw,
            min,
            max,
            data_type: data_type.to_owned(),
        });
    }
    // Within the type: a negative i16 is its two's-complement register.
    if rounded < 0.0 {
        Ok((rounded as i16) as u16)
    } else {
        Ok(rounded as u16)
    }
}

/// Resolve and perform the write of `value` to `tag`: what every ingress path
/// (the HMI, the MQTT `set_output`) runs. The error says why in words an
/// operator can act on.
pub async fn write_tag(state: &AppState, tag: &TagConfig, value: f64) -> Result<Written, String> {
    // A forced tag is held at its forced value (the live-debug force of
    // `force_value`): neither a remote command nor the HMI overwrites it. Only
    // the piControl handle used to ask; a write to a forced Modbus, GPIO or I2C
    // tag went through and replaced the forced value in the process image.
    if state.force_registry.is_forced(&tag.tag_name).await {
        return Err(format!(
            "write to '{}' refused: the tag holds a forced value (unforce it first)",
            tag.tag_name
        ));
    }
    let target = resolve(&state.config, tag, value)
        .map_err(|refusal| format!("write to '{}' refused: {refusal}", tag.tag_name))?;
    let written = write(state, &target).await?;
    Ok(Written {
        target: Some(target),
        ..written
    })
}

/// Store what a successful write left in the process image: the value the
/// backend read back in raw units when it read one back, else the commanded
/// value (the tag's scaling is applied by the store).
pub async fn record(state: &AppState, tag: &TagConfig, value: f64, written: &Written) {
    match written.read_back {
        Some(raw) => {
            state
                .process_image
                .update_tag_notifying(&tag.tag_name, raw, TagQuality::Good, tag.source)
                .await;
        }
        None => {
            state
                .process_image
                .update_tag(&tag.tag_name, value, TagQuality::Good, tag.source)
                .await;
        }
    }
}

/// What a write left behind.
#[derive(Debug, Clone, PartialEq)]
pub struct Written {
    /// A value the backend read back in raw units; the caller stores it
    /// instead of the commanded value (the tag's scaling would be applied to
    /// the commanded one a second time). `None` for every other backend.
    pub read_back: Option<f64>,
    /// What was written (set by [`write_tag`], which resolved it).
    pub target: Option<WriteTarget>,
}

/// Perform the write through the hardware handles (they keep their own
/// degraded-mode gate and force registry).
pub async fn write(state: &AppState, target: &WriteTarget) -> Result<Written, String> {
    let none = Written {
        read_back: None,
        target: None,
    };
    match target {
        WriteTarget::Gpio { pin, high } => {
            let handle = state
                .gpio_handle
                .as_ref()
                .ok_or_else(|| "GPIO handle not available".to_string())?;
            handle
                .write_pin(*pin, *high)
                .await
                .map(|()| none)
                .map_err(|e| format!("GPIO write failed: {e}"))
        }
        WriteTarget::ModbusCoil {
            device,
            address,
            on,
        } => {
            let handle = state
                .modbus_handle
                .as_ref()
                .ok_or_else(|| "Modbus handle not available".to_string())?;
            handle
                .write_coil(device, *address, *on)
                .await
                .map(|()| none)
                .map_err(|e| format!("Modbus write failed: {e}"))
        }
        WriteTarget::ModbusRegister {
            device,
            address,
            raw,
        } => {
            let handle = state
                .modbus_handle
                .as_ref()
                .ok_or_else(|| "Modbus handle not available".to_string())?;
            handle
                .write_register(device, *address, *raw)
                .await
                .map(|()| none)
                .map_err(|e| format!("Modbus write failed: {e}"))
        }
        WriteTarget::I2c { tag, data } => {
            let handle = state
                .i2c_handle
                .as_ref()
                .ok_or_else(|| "I2C handle not available".to_string())?;
            handle
                .write_direct(tag, data)
                .await
                .map(|()| none)
                .map_err(|e| format!("I2C write failed: {e}"))
        }
        WriteTarget::PiControl { tag, value } => {
            // The backend checks the degraded gate, the force registry, its
            // output grant and the layout; the value is range-checked against
            // the variable, never saturated.
            let handle = state
                .picontrol_handle
                .as_ref()
                .ok_or_else(|| "piControl handle not available".to_string())?;
            handle
                .write_output(tag, *value)
                .await
                .map(|written| Written {
                    read_back: Some(written.value),
                    target: None,
                })
                .map_err(|e| format!("piControl write failed: {e}"))
        }
    }
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use crate::process_image::{IoType, TagSource};

    fn config(devices: &str) -> AgentConfig {
        serde_yaml::from_str(&format!(
            "device_id: \"dev-1\"\ndevice_code: \"EDGE-1\"\napi_url: \"https://api.example.test\"\n\
             mqtt:\n  port: 8883\nmodbus:\n{devices}"
        ))
        .unwrap()
    }

    fn device(name: &str, slave_id: u8, registers: &str) -> String {
        format!(
            "  - name: \"{name}\"\n    connection_type: tcp\n    address: \"10.0.0.{slave_id}:502\"\n    \
             slave_id: {slave_id}\n    security:\n      allow_writes: true\n      \
             allow_all_write_addresses: true\n    registers:\n{registers}"
        )
    }

    fn register(name: &str, address: u16, kind: &str, data_type: &str, scale: f64) -> String {
        format!(
            "      - name: {name}\n        address: {address}\n        register_type: {kind}\n        \
             data_type: {data_type}\n        scale: {scale}\n"
        )
    }

    fn tag(
        name: &str,
        io_type: IoType,
        slave_id: u8,
        register: u16,
        function: u8,
        register_type: &str,
    ) -> TagConfig {
        TagConfig {
            tag_name: name.to_string(),
            io_type,
            data_type: "u16".into(),
            source: TagSource::Modbus,
            poll_interval_ms: None,
            raw_min: None,
            raw_max: None,
            eng_min: None,
            eng_max: None,
            eng_unit: None,
            invert: false,
            alarm_hh: None,
            alarm_h: None,
            alarm_l: None,
            alarm_ll: None,
            deadband: None,
            protocol_config: ProtocolConfig::Modbus {
                slave_id,
                register,
                function,
                register_type: register_type.to_string(),
            },
        }
    }

    /// EDGE-HIGH-062: two TCP devices share the unit id; the tag whose name a
    /// configured register carries is routed to the device that owns it.
    #[test]
    fn a_tag_is_routed_to_the_device_that_owns_its_register() {
        let cfg = config(&format!(
            "{}{}",
            device("plc-a", 1, &register("pump_a", 10, "coil", "u16", 1.0)),
            device("plc-b", 1, &register("pump_b", 10, "coil", "u16", 1.0)),
        ));
        let b = tag("pump_b", IoType::DO, 1, 10, 1, "coil");
        assert_eq!(
            resolve(&cfg, &b, 1.0).unwrap(),
            WriteTarget::ModbusCoil {
                device: "plc-b".into(),
                address: 10,
                on: true
            }
        );
        let a = tag("pump_a", IoType::DO, 1, 10, 1, "coil");
        assert_eq!(
            resolve(&cfg, &a, 0.0).unwrap(),
            WriteTarget::ModbusCoil {
                device: "plc-a".into(),
                address: 10,
                on: false
            }
        );
    }

    /// Without a register of that name the only evidence is the slave id: one
    /// device owns it, or the tag is refused (never "the first match").
    #[test]
    fn a_tag_with_only_a_slave_id_needs_exactly_one_device() {
        let shared = config(&format!(
            "{}{}",
            device("plc-a", 7, &register("x", 1, "coil", "u16", 1.0)),
            device("plc-b", 7, &register("y", 1, "coil", "u16", 1.0)),
        ));
        let t = tag("io_only", IoType::DO, 7, 20, 1, "coil");
        match resolve(&shared, &t, 1.0) {
            Err(Refusal::AmbiguousSlaveId {
                slave_id: 7,
                devices,
            }) => {
                assert_eq!(devices, "plc-a, plc-b")
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            resolve(&shared, &tag("io_only", IoType::DO, 9, 20, 1, "coil"), 1.0),
            Err(Refusal::NoDevice(9))
        );
        let one = config(&device("plc-a", 7, &register("x", 1, "coil", "u16", 1.0)));
        assert_eq!(
            resolve(&one, &t, 1.0).unwrap(),
            WriteTarget::ModbusCoil {
                device: "plc-a".into(),
                address: 20,
                on: true
            }
        );
    }

    /// The tag and the device configuration may not disagree about where the
    /// register is.
    #[test]
    fn a_tag_that_contradicts_the_device_configuration_is_refused() {
        let cfg = config(&device(
            "plc-a",
            1,
            &register("pump", 10, "coil", "u16", 1.0),
        ));
        for t in [
            tag("pump", IoType::DO, 2, 10, 1, "coil"),
            tag("pump", IoType::DO, 1, 11, 1, "coil"),
        ] {
            assert!(
                matches!(resolve(&cfg, &t, 1.0), Err(Refusal::ConfigDisagrees { .. })),
                "{t:?}"
            );
        }
    }

    /// An analog output is an FC6 register write of the scaled value, not an
    /// FC5 coil (the old set_output wrote every Modbus tag as a coil).
    #[test]
    fn an_analog_output_is_a_register_write_of_the_scaled_value() {
        let cfg = config(&device(
            "vfd",
            3,
            &register("speed", 40, "holding", "u16", 0.1),
        ));
        let t = tag("speed", IoType::AO, 3, 40, 3, "holding");
        // 12.5 in engineering units is 125 raw at scale 0.1.
        assert_eq!(
            resolve(&cfg, &t, 12.5).unwrap(),
            WriteTarget::ModbusRegister {
                device: "vfd".into(),
                address: 40,
                raw: 125
            }
        );
        // A tag with its own raw/eng scaling uses it.
        let mut scaled = t.clone();
        scaled.raw_min = Some(0.0);
        scaled.raw_max = Some(10_000.0);
        scaled.eng_min = Some(0.0);
        scaled.eng_max = Some(10.0);
        assert_eq!(
            resolve(&cfg, &scaled, 5.0).unwrap(),
            WriteTarget::ModbusRegister {
                device: "vfd".into(),
                address: 40,
                raw: 5000
            }
        );
    }

    /// A value the register cannot hold is refused, never saturated.
    #[test]
    fn a_value_outside_the_register_is_refused_not_saturated() {
        let cfg = config(&device(
            "vfd",
            3,
            &register("speed", 40, "holding", "u16", 1.0),
        ));
        let t = tag("speed", IoType::AO, 3, 40, 3, "holding");
        for v in [-1.0, 65_536.0, 1.0e12] {
            assert!(
                matches!(resolve(&cfg, &t, v), Err(Refusal::OutOfRange { .. })),
                "{v}"
            );
        }
        assert!(matches!(
            resolve(&cfg, &t, f64::NAN),
            Err(Refusal::NotFinite(_))
        ));
        assert!(matches!(
            resolve(&cfg, &t, f64::INFINITY),
            Err(Refusal::NotFinite(_))
        ));
        assert_eq!(
            resolve(&cfg, &t, 65_535.0).unwrap(),
            WriteTarget::ModbusRegister {
                device: "vfd".into(),
                address: 40,
                raw: 65_535
            }
        );

        // A signed register holds -32768..=32767 and writes its two's complement.
        let signed = config(&device(
            "vfd",
            3,
            &register("trim", 41, "holding", "i16", 1.0),
        ));
        let s = tag("trim", IoType::AO, 3, 41, 3, "holding");
        assert_eq!(
            resolve(&signed, &s, -2.0).unwrap(),
            WriteTarget::ModbusRegister {
                device: "vfd".into(),
                address: 41,
                raw: 0xFFFE
            }
        );
        assert!(matches!(
            resolve(&signed, &s, 40_000.0),
            Err(Refusal::OutOfRange { .. })
        ));
    }

    /// A 32-bit register does not fit the single-register write: it is refused
    /// rather than written as half a value.
    #[test]
    fn a_wide_register_is_refused() {
        let cfg = config(&device(
            "meter",
            4,
            &register("setpoint", 50, "holding", "f32", 1.0),
        ));
        let t = tag("setpoint", IoType::AO, 4, 50, 3, "holding");
        assert!(matches!(
            resolve(&cfg, &t, 1.5),
            Err(Refusal::WideRegister(_))
        ));
    }

    /// Only outputs, only writable register types, and a function that agrees
    /// with the declared type.
    #[test]
    fn inputs_read_only_registers_and_disagreeing_functions_are_refused() {
        let cfg = config(&device(
            "plc",
            1,
            &format!(
                "{}{}{}",
                register("level", 5, "input", "u16", 1.0),
                register("pump", 6, "coil", "u16", 1.0),
                register("flag", 7, "discrete", "u16", 1.0),
            ),
        ));
        assert!(matches!(
            resolve(&cfg, &tag("level", IoType::AI, 1, 5, 4, "input"), 1.0),
            Err(Refusal::NotAnOutput { .. })
        ));
        assert!(matches!(
            resolve(&cfg, &tag("level", IoType::AO, 1, 5, 4, "input"), 1.0),
            Err(Refusal::ReadOnlyRegister(_))
        ));
        assert!(matches!(
            resolve(&cfg, &tag("flag", IoType::DO, 1, 7, 2, "discrete"), 1.0),
            Err(Refusal::ReadOnlyRegister(_))
        ));
        // A coil tag whose function says holding: the two disagree.
        assert!(matches!(
            resolve(&cfg, &tag("pump", IoType::DO, 1, 6, 3, "coil"), 1.0),
            Err(Refusal::FunctionDisagrees { .. })
        ));
        assert!(matches!(
            resolve(&cfg, &tag("pump", IoType::DO, 1, 6, 5, "no-such-type"), 1.0),
            // The configured register's own type wins over the tag's.
            Ok(WriteTarget::ModbusCoil { .. })
        ));
    }

    /// The emergency stop scopes itself to tags through the same resolution
    /// (and its identity is the registry's): routed by the register's owner,
    /// refused for what has no safe-state output.
    #[test]
    fn a_tag_has_the_identity_of_the_output_the_registry_drives() {
        let cfg = config(&format!(
            "{}{}",
            device("plc-a", 1, &register("pump_a", 10, "coil", "u16", 1.0)),
            device("plc-b", 1, &register("speed_b", 11, "holding", "u16", 1.0)),
        ));
        assert_eq!(
            output_id_of(&cfg, &tag("pump_a", IoType::DO, 1, 10, 1, "coil")),
            Ok(OutputId::modbus_coil("plc-a", 10))
        );
        assert_eq!(
            output_id_of(&cfg, &tag("speed_b", IoType::AO, 1, 11, 3, "holding")),
            Ok(OutputId::modbus_register("plc-b", 11))
        );
        assert!(matches!(
            output_id_of(&cfg, &tag("level", IoType::AI, 1, 12, 4, "input")),
            Err(Refusal::NotAnOutput { .. })
        ));
        let i2c = TagConfig {
            protocol_config: ProtocolConfig::I2c {
                bus: 1,
                address: 0x40,
                driver_type: crate::process_image::I2cDriverType::GenericDirect { read_length: 1 },
            },
            ..tag("dac", IoType::AO, 0, 0, 0, "")
        };
        assert_eq!(
            output_id_of(&cfg, &i2c),
            Err(Refusal::NoSafeStateOutput("I2C"))
        );
    }

    /// The other protocols resolve to their own target; the identity of the
    /// output is the registry's.
    #[test]
    fn every_protocol_resolves_and_its_output_identity_matches_the_registry() {
        let cfg = config(&device("plc", 1, &register("pump", 6, "coil", "u16", 1.0)));
        let gpio = TagConfig {
            protocol_config: ProtocolConfig::Gpio {
                pin: 17,
                direction: "output".into(),
            },
            source: TagSource::Gpio,
            ..tag("fan", IoType::DO, 0, 0, 0, "")
        };
        let target = resolve(&cfg, &gpio, 1.0).unwrap();
        assert_eq!(
            target,
            WriteTarget::Gpio {
                pin: 17,
                high: true
            }
        );
        assert_eq!(target.output_id(), Some(OutputId::gpio_pin(17)));

        let coil = resolve(&cfg, &tag("pump", IoType::DO, 1, 6, 5, "coil"), 1.0).unwrap();
        assert_eq!(coil.output_id(), Some(OutputId::modbus_coil("plc", 6)));

        let pi = TagConfig {
            protocol_config: ProtocolConfig::PiControl {
                variable: "O_1".into(),
            },
            source: TagSource::PiControl,
            ..tag("valve", IoType::DO, 0, 0, 0, "")
        };
        let target = resolve(&cfg, &pi, 1.0).unwrap();
        assert_eq!(target.output_id(), Some(OutputId::picontrol("valve")));

        let spi = TagConfig {
            protocol_config: ProtocolConfig::Spi { bus: 0, cs: 0 },
            ..tag("dac", IoType::AO, 0, 0, 0, "")
        };
        assert!(matches!(
            resolve(&cfg, &spi, 1.0),
            Err(Refusal::UnsupportedProtocol("SPI"))
        ));
    }

    /// A remote write records a hold only for a target whose output the
    /// safe-state registry knows, and the behaviour table promises the
    /// comms-loss supervisor will drive an output safe only for a kind of
    /// hardware whose targets do. The two cannot disagree: an I2C tag has no
    /// registered output, so its row says nothing drives it safe.
    #[test]
    fn the_table_promises_a_leased_drive_only_where_a_remote_write_records_a_hold() {
        use crate::safe_state::behaviour::{AgentAct, Event, behaviour};
        let targets = [
            WriteTarget::Gpio {
                pin: 17,
                high: true,
            },
            WriteTarget::ModbusCoil {
                device: "plc".into(),
                address: 6,
                on: true,
            },
            WriteTarget::ModbusRegister {
                device: "plc".into(),
                address: 7,
                raw: 1,
            },
            WriteTarget::I2c {
                tag: "dac".into(),
                data: vec![0, 0, 1, 0],
            },
            WriteTarget::PiControl {
                tag: "valve".into(),
                value: 1.0,
            },
        ];
        for target in targets {
            let records_a_hold = target.output_id().is_some();
            let promised = behaviour(Event::CloudCommsLoss, target.backend()).agent
                == AgentAct::DriveSafeLeased;
            assert_eq!(
                records_a_hold, promised,
                "{target:?}: a hold is recorded = {records_a_hold}, the table promises a leased drive = {promised}"
            );
        }
    }

    /// The I2C payload is refused outside what 32 bits hold, like a register
    /// value outside its data type, and is rounded rather than truncated.
    #[test]
    fn an_i2c_value_outside_32_bits_is_refused_not_saturated() {
        assert_eq!(raw_i2c(0.0), Ok(0));
        assert_eq!(raw_i2c(4095.0), Ok(4095));
        assert_eq!(raw_i2c(3.7), Ok(4), "rounded, as a register value is");
        assert_eq!(raw_i2c(f64::from(u32::MAX)), Ok(u32::MAX));
        for bad in [
            -1.0,
            -5.0,
            1e12,
            f64::from(u32::MAX) + 1.0,
            f64::NAN,
            f64::INFINITY,
        ] {
            assert!(
                matches!(raw_i2c(bad), Err(Refusal::OutOfRange { .. })),
                "{bad} is not a 32-bit payload"
            );
        }
        let cfg = config(&device("plc", 1, &register("pump", 6, "coil", "u16", 1.0)));
        let dac = TagConfig {
            protocol_config: ProtocolConfig::I2c {
                bus: 1,
                address: 0x60,
                driver_type: crate::process_image::I2cDriverType::GenericDirect { read_length: 1 },
            },
            ..tag("dac", IoType::AO, 0, 0, 0, "")
        };
        assert!(matches!(
            resolve(&cfg, &dac, -5.0),
            Err(Refusal::OutOfRange { .. })
        ));
        match resolve(&cfg, &dac, 2048.0).unwrap() {
            WriteTarget::I2c { data, .. } => assert_eq!(data, 2048u32.to_be_bytes()),
            other => panic!("{other:?}"),
        }
    }

    /// A forced tag is held: neither the HMI nor a remote command overwrites it,
    /// on any backend.
    #[tokio::test]
    async fn a_write_to_a_forced_tag_is_refused_for_every_backend() {
        use crate::process_image::TagQuality;
        let cfg = config(&device("plc", 1, &register("pump", 6, "coil", "u16", 1.0)));
        let state = AppState::new(cfg);
        let forced = tag("pump", IoType::DO, 1, 6, 5, "coil");
        let free = tag("fan", IoType::DO, 1, 7, 5, "coil");
        // No hardware handle is configured, so a write that gets past the force
        // check fails with "handle not available"; the force check answers first.
        state
            .force_registry
            .apply(
                "pump".to_owned(),
                1.0,
                TagQuality::Good,
                "operator".to_owned(),
                "commissioning".to_owned(),
                60,
                false,
                &crate::runtime_safety::SystemClockAuthority::new(),
            )
            .await
            .expect("the force is applied");
        let refused = write_tag(&state, &forced, 0.0).await.unwrap_err();
        assert!(refused.contains("forced value"), "{refused}");
        let free = write_tag(&state, &free, 1.0).await.unwrap_err();
        assert!(
            !free.contains("forced value"),
            "an unforced tag is not refused for a force: {free}"
        );
    }
}
