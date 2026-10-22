//! The agent's own grant on the process image: which variables it reads and
//! which outputs it may write, resolved against `config.rsc` and proven
//! against the driver.
//!
//! [`Registry::build`] turns the `picontrol:` section and the signed
//! `config.rsc` into points with their process-image addresses and refuses
//! every grant that would be unsafe on the RevPi:
//!
//! * an output must be an `out` variable of an I/O expansion module (DIO, DI,
//!   DO, AIO, MIO, RO). The base module's outputs (status, LEDs, the Connect 4
//!   X2 output and, on the Connect and Connect SE, the bit that triggers the
//!   board watchdog, `PICONTROL_WD_TRIGGER` = 0x80 of the `RevPiLED` byte in
//!   piControl's `PiBridgeMaster.c`) can never be listed, so the board
//!   watchdog bit is unreachable by construction (DEC-6.7), not by care;
//! * an `exported` output belongs to another process that copies it in with
//!   `KB_SET_EXPORTED_OUTPUTS`; two writers of one output are refused;
//! * an output's safe value must be the default `config.rsc` declares for it:
//!   the driver restores that default when it is reset (a site config update
//!   that changes `config.rsc` makes root reset the driver), so a different
//!   safe value would energise or drop the output at the reset;
//! * a variable the driver exposes in no width the agent codec handles
//!   (1, 8, 16, 32 bits) is refused.
//!
//! [`Registry::verify`] then asks the driver (`KB_FIND_VARIABLE`) where each
//! point lives and refuses the registry unless the driver agrees with the
//! signed file to the byte and bit: the file the agent was given and the
//! configuration the driver loaded must be the same one, because a point at
//! the wrong address is a write to the wrong output.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use super::abi::{VariableName, module_type};
use super::config::{Direction, PiControlConfig, PointConfig, PointType};
use super::device::{DeviceError, PiControl};
use super::rsc::{DeviceDecl, ProcessMap, Section, VariableDecl, Width};

/// Linear raw-to-engineering scaling, the one `ProcessImage::scale_value`
/// applies on the read path; the write path inverts it here.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Scale {
    pub raw_min: f64,
    pub raw_max: f64,
    pub eng_min: f64,
    pub eng_max: f64,
}

/// One variable of the process image the agent handles.
#[derive(Debug, Clone, PartialEq)]
pub struct Point {
    /// The tag the value is published under.
    pub tag: String,
    pub variable: VariableName,
    pub direction: Direction,
    pub point_type: PointType,
    pub width: Width,
    /// Byte address in the process image.
    pub address: u16,
    /// Bit 0-7 for a bit point.
    pub bit: u8,
    /// PiBridge position of the owning module.
    pub device: u8,
    /// Module type of the owning module.
    pub product_type: u16,
    /// What the driver restores on a reset (`config.rsc`).
    pub default: u32,
    /// Outputs: the raw bits the safe-state pass drives.
    pub safe_raw: u32,
    pub scale: Option<Scale>,
    pub eng_unit: Option<String>,
}

/// A value the point cannot hold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValueError {
    NotFinite,
    OutOfRange { raw: i64, min: i64, max: i64 },
}

impl fmt::Display for ValueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFinite => f.write_str("the value is not a finite number"),
            Self::OutOfRange { raw, min, max } => {
                write!(f, "raw value {raw} is outside {min}..={max}")
            }
        }
    }
}

impl std::error::Error for ValueError {}

const fn width_mask(width: Width) -> u32 {
    match width {
        Width::Bit => 1,
        Width::Byte => 0xFF,
        Width::Word => 0xFFFF,
        Width::DWord => u32::MAX,
    }
}

impl Point {
    /// The raw bits of the point in a process-image snapshot. `None` when the
    /// snapshot does not reach the point (never for a registry built from the
    /// same configuration: the address was checked against the image length).
    pub fn decode(&self, image: &[u8]) -> Option<u32> {
        let at = usize::from(self.address);
        let bytes = image.get(at..at + self.width.bytes())?;
        Some(match self.width {
            Width::Bit => u32::from((*bytes.first()? >> self.bit) & 1),
            Width::Byte => u32::from(*bytes.first()?),
            // Two- and four-byte variables are little endian (KB_FIND_VARIABLE(2)).
            Width::Word => u32::from(u16::from_le_bytes(bytes.try_into().ok()?)),
            Width::DWord => u32::from_le_bytes(bytes.try_into().ok()?),
        })
    }

    /// The raw bits as a number: sign-extended for a signed type.
    pub fn raw_as_f64(&self, raw: u32) -> f64 {
        if !self.point_type.signed() {
            return f64::from(raw);
        }
        match self.width {
            Width::Byte => f64::from(i8::from_ne_bytes([raw as u8])),
            Width::Word => f64::from(i16::from_ne_bytes((raw as u16).to_ne_bytes())),
            Width::DWord | Width::Bit => f64::from(i32::from_ne_bytes(raw.to_ne_bytes())),
        }
    }

    /// The raw bits a tag value (engineering units) stands for: scaled back
    /// through the point's scaling, then checked against the type's range.
    /// A value that does not fit is an error, never saturated.
    pub fn raw_from_value(&self, value: f64) -> Result<u32, ValueError> {
        if !value.is_finite() {
            return Err(ValueError::NotFinite);
        }
        if self.width == Width::Bit {
            return Ok(u32::from(value != 0.0));
        }
        let raw = match self.scale {
            Some(s) if (s.eng_max - s.eng_min).abs() >= f64::EPSILON => {
                s.raw_min + (value - s.eng_min) * (s.raw_max - s.raw_min) / (s.eng_max - s.eng_min)
            }
            _ => value,
        };
        let rounded = raw.round();
        let (min, max) = self.raw_range();
        // A f64 holds every integer of the 32-bit range exactly.
        if !(min as f64..=max as f64).contains(&rounded) {
            return Err(ValueError::OutOfRange {
                raw: rounded as i64,
                min,
                max,
            });
        }
        let n = rounded as i64;
        // The range check above keeps `n` inside the type, so the mask only
        // drops the sign extension of a negative value; a result that still
        // does not fit 32 bits is an error, never a substituted zero.
        u32::try_from(n & i64::from(width_mask(self.width))).map_err(|_| ValueError::OutOfRange {
            raw: n,
            min,
            max,
        })
    }

    fn raw_range(&self) -> (i64, i64) {
        let bits = u32::from(self.width.bits());
        if self.point_type.signed() {
            (-(1i64 << (bits - 1)), (1i64 << (bits - 1)) - 1)
        } else {
            (0, (1i64 << bits) - 1)
        }
    }

    /// The bytes a whole-byte, word or dword point is written as
    /// (little endian, [`Width::bytes`] long).
    pub fn bytes_of(&self, raw: u32) -> Vec<u8> {
        raw.to_le_bytes()
            .iter()
            .copied()
            .take(self.width.bytes())
            .collect()
    }

    /// Whether this point is an output the agent may write.
    pub fn is_output(&self) -> bool {
        self.direction == Direction::Output
    }
}

/// Why a grant or a driver is refused.
#[derive(Debug)]
pub enum RegistryError {
    UnknownVariable(String),
    UnsupportedWidth {
        variable: String,
        bits: u16,
    },
    NotReadable {
        variable: String,
        section: Section,
    },
    OutputNotInOutputSection {
        variable: String,
        section: Section,
    },
    OutputOnBaseModule {
        variable: String,
        product_type: u16,
    },
    OutputOnUnknownModule {
        variable: String,
        product_type: u16,
    },
    ExportedOutput(String),
    TypeMismatch {
        variable: String,
        declared: PointType,
        bits: u16,
    },
    DuplicateTag(String),
    DuplicateVariable(String),
    SafeValueOutOfRange {
        variable: String,
        value: i64,
    },
    SafeValueIsNotTheDefault {
        variable: String,
        safe: u32,
        default: u32,
    },
    BadName(String),
    /// The module of a point is not in the driver's device list, or is not
    /// the module the file declares.
    DeviceMismatch {
        variable: String,
        detail: String,
    },
    /// The module of an output is configured but absent.
    OutputModuleInactive {
        variable: String,
        position: u8,
    },
    /// The driver places the variable elsewhere (or nowhere).
    DriverDisagrees {
        variable: String,
        file: (u16, u8, u16),
        driver: Option<(u16, u8, u16)>,
    },
    Device(DeviceError),
}

impl fmt::Display for RegistryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownVariable(v) => write!(f, "variable {v:?} is not in config.rsc"),
            Self::UnsupportedWidth { variable, bits } => write!(
                f,
                "variable {variable:?} is {bits} bits wide; the agent handles 1, 8, 16 and 32"
            ),
            Self::NotReadable { variable, section } => write!(
                f,
                "variable {variable:?} is a {section:?} variable (module configuration); only \
                 inputs, outputs and memory can be points"
            ),
            Self::OutputNotInOutputSection { variable, section } => write!(
                f,
                "output {variable:?} is declared in the {section:?} block of config.rsc, not out"
            ),
            Self::OutputOnBaseModule {
                variable,
                product_type,
            } => write!(
                f,
                "output {variable:?} belongs to the base module (type {product_type}): its \
                 outputs include the LEDs and, on the Connect and Connect SE, the board \
                 watchdog trigger bit; the agent writes expansion modules only"
            ),
            Self::OutputOnUnknownModule {
                variable,
                product_type,
            } => write!(
                f,
                "output {variable:?} belongs to module type {product_type}, which is not a \
                 DIO, DI, DO, AIO, MIO or RO module"
            ),
            Self::ExportedOutput(v) => write!(
                f,
                "output {v:?} is exported in PiCtory: another process owns it \
                 (KB_SET_EXPORTED_OUTPUTS)"
            ),
            Self::TypeMismatch {
                variable,
                declared,
                bits,
            } => write!(
                f,
                "point {variable:?} declares {declared:?} but the variable is {bits} bits wide"
            ),
            Self::DuplicateTag(t) => write!(f, "tag {t:?} is listed twice"),
            Self::DuplicateVariable(v) => write!(f, "variable {v:?} is listed twice"),
            Self::SafeValueOutOfRange { variable, value } => write!(
                f,
                "safe_state_value {value} does not fit the variable {variable:?}"
            ),
            Self::SafeValueIsNotTheDefault {
                variable,
                safe,
                default,
            } => write!(
                f,
                "output {variable:?}: safe_state_value {safe} differs from the default \
                 {default} config.rsc declares; the driver restores that default when it is \
                 reset, so set the PiCtory default to the safe value (or the safe value to \
                 the default)"
            ),
            Self::BadName(e) => write!(f, "{e}"),
            Self::DeviceMismatch { variable, detail } => {
                write!(f, "variable {variable:?}: {detail}")
            }
            Self::OutputModuleInactive { variable, position } => write!(
                f,
                "output {variable:?}: the module at position {position} is not connected, so \
                 the output cannot be driven"
            ),
            Self::DriverDisagrees {
                variable,
                file,
                driver,
            } => write!(
                f,
                "config.rsc puts {variable:?} at address {} bit {} length {}, the driver {}: \
                 the driver loaded a different configuration than the one the agent was given",
                file.0,
                file.1,
                file.2,
                match driver {
                    Some((a, b, l)) => format!("at address {a} bit {b} length {l}"),
                    None => "does not know the variable".to_owned(),
                }
            ),
            Self::Device(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for RegistryError {}

impl From<DeviceError> for RegistryError {
    fn from(e: DeviceError) -> Self {
        Self::Device(e)
    }
}

/// The points the agent handles, resolved against one `config.rsc`.
#[derive(Debug, Clone, PartialEq)]
pub struct Registry {
    points: Vec<Point>,
    by_tag: BTreeMap<String, usize>,
    devices: BTreeMap<u8, DeviceDecl>,
}

impl Registry {
    /// Resolve `config` against `map` and refuse every unsafe grant.
    pub fn build(config: &PiControlConfig, map: &ProcessMap) -> Result<Self, RegistryError> {
        let mut points = Vec::with_capacity(config.points.len());
        let mut tags = BTreeSet::new();
        let mut variables = BTreeSet::new();
        let mut devices = BTreeMap::new();
        for p in &config.points {
            let name = VariableName::new(&p.variable)
                .map_err(|e| RegistryError::BadName(format!("point {:?}: {e}", p.variable)))?;
            let decl = map
                .variable(&name)
                .ok_or_else(|| RegistryError::UnknownVariable(p.variable.clone()))?;
            let device = map.device(decl.device).ok_or_else(|| {
                RegistryError::UnknownVariable(format!("{} (its device is missing)", p.variable))
            })?;
            let point = resolve(p, decl, device)?;
            if !tags.insert(point.tag.clone()) {
                return Err(RegistryError::DuplicateTag(point.tag));
            }
            if !variables.insert(name.clone()) {
                return Err(RegistryError::DuplicateVariable(p.variable.clone()));
            }
            devices.insert(device.position, device.clone());
            points.push(point);
        }
        let by_tag = points
            .iter()
            .enumerate()
            .map(|(i, p)| (p.tag.clone(), i))
            .collect();
        Ok(Self {
            points,
            by_tag,
            devices,
        })
    }

    /// Every point, in configuration order.
    pub fn points(&self) -> &[Point] {
        &self.points
    }

    /// The point published under `tag`.
    pub fn point_for_tag(&self, tag: &str) -> Option<&Point> {
        self.by_tag.get(tag).and_then(|i| self.points.get(*i))
    }

    /// The modules the points live on.
    pub fn devices(&self) -> impl Iterator<Item = &DeviceDecl> {
        self.devices.values()
    }

    /// Ask the driver where it put each point and refuse the registry unless
    /// it agrees with `config.rsc`; check the modules the points live on.
    pub fn verify(&self, pi: &PiControl) -> Result<(), RegistryError> {
        let listed = pi.devices()?;
        for p in &self.points {
            let file = (p.address, p.bit, p.width.bits());
            let driver = pi.find_variable(&p.variable)?;
            let driver = driver.map(|l| (l.address, l.bit, l.length));
            if driver != Some(file) {
                return Err(RegistryError::DriverDisagrees {
                    variable: p.variable.to_string(),
                    file,
                    driver,
                });
            }
            let decl = self.devices.get(&p.device);
            let module = listed.iter().find(|d| d.address == p.device);
            match (decl, module) {
                (Some(decl), Some(module)) => {
                    if module.product_type() != decl.product_type {
                        return Err(RegistryError::DeviceMismatch {
                            variable: p.variable.to_string(),
                            detail: format!(
                                "the module at position {} is type {}, config.rsc declares {}",
                                p.device,
                                module.product_type(),
                                decl.product_type
                            ),
                        });
                    }
                    if module.base_offset != decl.base_offset {
                        return Err(RegistryError::DeviceMismatch {
                            variable: p.variable.to_string(),
                            detail: format!(
                                "the module at position {} starts at offset {}, config.rsc \
                                 declares {}",
                                p.device, module.base_offset, decl.base_offset
                            ),
                        });
                    }
                    if p.is_output() && (!module.active || module.module_type & 0x8000 != 0) {
                        return Err(RegistryError::OutputModuleInactive {
                            variable: p.variable.to_string(),
                            position: p.device,
                        });
                    }
                }
                _ => {
                    // An absent input module reads as a communication failure at
                    // poll time; an output that cannot be driven is refused here.
                    if p.is_output() {
                        return Err(RegistryError::OutputModuleInactive {
                            variable: p.variable.to_string(),
                            position: p.device,
                        });
                    }
                }
            }
        }
        Ok(())
    }
}

fn resolve(
    cfg: &PointConfig,
    decl: &VariableDecl,
    device: &DeviceDecl,
) -> Result<Point, RegistryError> {
    let variable = cfg.variable.clone();
    let width = decl
        .width()
        .ok_or_else(|| RegistryError::UnsupportedWidth {
            variable: variable.clone(),
            bits: decl.bit_length,
        })?;
    if decl.section == Section::Config {
        return Err(RegistryError::NotReadable {
            variable,
            section: decl.section,
        });
    }
    let point_type = cfg
        .data_type
        .unwrap_or_else(|| PointType::unsigned_of(width));
    if point_type.width() != width {
        return Err(RegistryError::TypeMismatch {
            variable,
            declared: point_type,
            bits: decl.bit_length,
        });
    }

    let mut safe_raw = 0;
    if cfg.direction == Direction::Output {
        if decl.section != Section::Output {
            return Err(RegistryError::OutputNotInOutputSection {
                variable,
                section: decl.section,
            });
        }
        if module_type::is_base_module(device.product_type) {
            return Err(RegistryError::OutputOnBaseModule {
                variable,
                product_type: device.product_type,
            });
        }
        if !module_type::is_io_expansion(device.product_type) {
            return Err(RegistryError::OutputOnUnknownModule {
                variable,
                product_type: device.product_type,
            });
        }
        if decl.exported {
            return Err(RegistryError::ExportedOutput(variable));
        }
        safe_raw = safe_bits(cfg.safe_state_value.unwrap_or(0), width, point_type).ok_or(
            RegistryError::SafeValueOutOfRange {
                variable: variable.clone(),
                value: cfg.safe_state_value.unwrap_or(0),
            },
        )?;
        let default = decl.default & width_mask(width);
        if safe_raw != default {
            return Err(RegistryError::SafeValueIsNotTheDefault {
                variable,
                safe: safe_raw,
                default,
            });
        }
    }

    let scale = match (cfg.raw_min, cfg.raw_max, cfg.eng_min, cfg.eng_max) {
        (Some(raw_min), Some(raw_max), Some(eng_min), Some(eng_max)) => Some(Scale {
            raw_min,
            raw_max,
            eng_min,
            eng_max,
        }),
        _ => None,
    };
    Ok(Point {
        tag: cfg.tag_name().to_owned(),
        variable: decl.name.clone(),
        direction: cfg.direction,
        point_type,
        width,
        address: decl.address,
        bit: decl.bit,
        device: decl.device,
        product_type: device.product_type,
        default: decl.default & width_mask(width),
        safe_raw,
        scale,
        eng_unit: cfg.eng_unit.clone(),
    })
}

/// The raw bits of a configured safe value, when it fits the type.
fn safe_bits(value: i64, width: Width, point_type: PointType) -> Option<u32> {
    let bits = u32::from(width.bits());
    let (min, max) = if point_type.signed() {
        (-(1i64 << (bits - 1)), (1i64 << (bits - 1)) - 1)
    } else {
        (0, (1i64 << bits) - 1)
    };
    if !(min..=max).contains(&value) {
        return None;
    }
    u32::try_from(value & i64::from(width_mask(width))).ok()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

    use super::super::device::PiControl;
    use super::super::fake::FakeKernel;
    use super::super::rsc::sample;
    use super::*;

    fn map() -> ProcessMap {
        ProcessMap::parse(sample::rsc().as_bytes()).unwrap()
    }

    fn cfg(yaml: &str) -> PiControlConfig {
        serde_yaml::from_str(yaml).unwrap()
    }

    fn build(yaml: &str) -> Result<Registry, RegistryError> {
        Registry::build(&cfg(yaml), &map())
    }

    const OK: &str = r#"
points:
  - tag: pump
    variable: O_1
    direction: output
  - tag: aerator
    variable: O_2
    direction: output
    safe_state_value: 1
  - variable: I_1
  - variable: InputValue_1
    raw_min: 0
    raw_max: 10000
    eng_min: 0
    eng_max: 10
  - variable: OutputValue_1
    direction: output
    data_type: uint16
"#;

    #[test]
    fn a_valid_grant_resolves_every_point_to_its_address() {
        let r = build(OK).unwrap();
        assert_eq!(r.points().len(), 5);
        let pump = r.point_for_tag("pump").unwrap();
        assert_eq!((pump.address, pump.bit, pump.width), (122, 0, Width::Bit));
        let aerator = r.point_for_tag("aerator").unwrap();
        assert_eq!(
            (aerator.address, aerator.bit, aerator.safe_raw),
            (122, 1, 1)
        );
        assert_eq!(r.point_for_tag("I_1").unwrap().direction, Direction::Input);
        assert_eq!(r.points().iter().filter(|p| p.is_output()).count(), 3);
        assert!(r.point_for_tag("nothing").is_none());
    }

    #[test]
    fn an_unknown_variable_is_refused() {
        let e = build("points:\n  - variable: Nope\n").unwrap_err();
        assert!(matches!(e, RegistryError::UnknownVariable(_)), "{e}");
    }

    #[test]
    fn an_output_on_the_base_module_is_refused_so_the_board_watchdog_bit_is_unreachable() {
        for variable in ["RevPiOutput", "RevPiLED"] {
            let e = build(&format!(
                "points:\n  - variable: {variable}\n    direction: output\n"
            ))
            .unwrap_err();
            assert!(
                matches!(e, RegistryError::OutputOnBaseModule { .. }),
                "{variable}: {e}"
            );
        }
    }

    #[test]
    fn the_connect_series_watchdog_trigger_byte_cannot_be_granted_either() {
        // A RevPi Connect: type 105, RevPiLED is the byte whose bit 7 is
        // PICONTROL_WD_TRIGGER. It is a base-module output like any other.
        let rsc = br#"{"Devices":[{"productType":"105","position":"0","offset":0,
          "out":{"0":["RevPiLED","0","8","6",false,"0","",""]}}]}"#;
        let map = ProcessMap::parse(rsc).unwrap();
        let e = Registry::build(
            &cfg("points:\n  - variable: RevPiLED\n    direction: output\n"),
            &map,
        )
        .unwrap_err();
        assert!(matches!(
            e,
            RegistryError::OutputOnBaseModule {
                product_type: 105,
                ..
            }
        ));
    }

    #[test]
    fn the_base_module_can_still_be_read() {
        let r = build("points:\n  - variable: RevPiStatus\n").unwrap();
        assert_eq!(r.points()[0].device, 0);
    }

    #[test]
    fn an_input_variable_cannot_be_an_output() {
        let e = build("points:\n  - variable: I_1\n    direction: output\n").unwrap_err();
        assert!(
            matches!(e, RegistryError::OutputNotInOutputSection { .. }),
            "{e}"
        );
    }

    #[test]
    fn a_memory_variable_can_be_read_but_not_written() {
        assert!(build("points:\n  - variable: Counter_1\n").is_ok());
        let e = build("points:\n  - variable: Counter_1\n    direction: output\n").unwrap_err();
        assert!(
            matches!(e, RegistryError::OutputNotInOutputSection { .. }),
            "{e}"
        );
    }

    #[test]
    fn an_exported_output_is_another_processes_and_is_refused() {
        let e = build("points:\n  - variable: O_3\n    direction: output\n").unwrap_err();
        assert!(matches!(e, RegistryError::ExportedOutput(_)), "{e}");
        assert!(
            build("points:\n  - variable: O_3\n").is_ok(),
            "reading it is fine"
        );
    }

    #[test]
    fn the_safe_value_must_be_the_default_the_driver_restores() {
        // O_2's PiCtory default is 1.
        let e = build("points:\n  - variable: O_2\n    direction: output\n").unwrap_err();
        assert!(matches!(
            e,
            RegistryError::SafeValueIsNotTheDefault {
                safe: 0,
                default: 1,
                ..
            }
        ));
        assert!(
            build("points:\n  - variable: O_2\n    direction: output\n    safe_state_value: 1\n")
                .is_ok()
        );
    }

    #[test]
    fn a_safe_value_outside_the_type_is_refused() {
        let e = build(
            "points:\n  - variable: OutputValue_1\n    direction: output\n    safe_state_value: 70000\n",
        )
        .unwrap_err();
        assert!(
            matches!(e, RegistryError::SafeValueOutOfRange { .. }),
            "{e}"
        );
        let e = build(
            "points:\n  - variable: OutputValue_1\n    direction: output\n    safe_state_value: -1\n",
        )
        .unwrap_err();
        assert!(
            matches!(e, RegistryError::SafeValueOutOfRange { .. }),
            "{e}"
        );
    }

    #[test]
    fn a_data_type_that_does_not_match_the_width_is_refused() {
        let e = build("points:\n  - variable: InputValue_1\n    data_type: uint8\n").unwrap_err();
        assert!(matches!(e, RegistryError::TypeMismatch { .. }), "{e}");
    }

    #[test]
    fn duplicate_tags_and_variables_are_refused() {
        let e = build("points:\n  - variable: I_1\n  - tag: I_1\n    variable: I_2\n").unwrap_err();
        assert!(matches!(e, RegistryError::DuplicateTag(_)), "{e}");
        let e =
            build("points:\n  - variable: I_1\n  - tag: other\n    variable: I_1\n").unwrap_err();
        assert!(matches!(e, RegistryError::DuplicateVariable(_)), "{e}");
    }

    #[test]
    fn module_configuration_variables_are_not_points() {
        let rsc = br#"{"Devices":[{"productType":"96","position":"32","offset":100,
          "config":{"0":["InputMode_1","0","8","40",false,"0","",""]}}]}"#;
        let map = ProcessMap::parse(rsc).unwrap();
        let e = Registry::build(&cfg("points:\n  - variable: InputMode_1\n"), &map).unwrap_err();
        assert!(matches!(e, RegistryError::NotReadable { .. }), "{e}");
    }

    #[test]
    fn a_bit_variable_decodes_from_a_snapshot() {
        let r = build(OK).unwrap();
        let mut image = vec![0u8; 4096];
        image[122] = 0b10;
        assert_eq!(r.point_for_tag("pump").unwrap().decode(&image), Some(0));
        assert_eq!(r.point_for_tag("aerator").unwrap().decode(&image), Some(1));
    }

    #[test]
    fn words_are_little_endian() {
        let r = build(OK).unwrap();
        let mut image = vec![0u8; 4096];
        image[200] = 0x34;
        image[201] = 0x12;
        assert_eq!(
            r.point_for_tag("InputValue_1").unwrap().decode(&image),
            Some(0x1234)
        );
        assert_eq!(
            r.point_for_tag("OutputValue_1").unwrap().bytes_of(0x1234),
            vec![0x34, 0x12]
        );
    }

    #[test]
    fn signed_points_sign_extend() {
        let r = build(
            "points:\n  - variable: InputValue_1\n    data_type: int16\n  - variable: RevPiStatus\n    data_type: int8\n",
        )
        .unwrap();
        let p = r.point_for_tag("InputValue_1").unwrap();
        assert_eq!(p.raw_as_f64(0xFFFF), -1.0);
        assert_eq!(p.raw_as_f64(0x7FFF), 32767.0);
        let b = r.point_for_tag("RevPiStatus").unwrap();
        assert_eq!(b.raw_as_f64(0x80), -128.0);
    }

    #[test]
    fn a_value_is_scaled_back_and_range_checked() {
        let r = build(
            r#"
points:
  - variable: OutputValue_1
    direction: output
    raw_min: 0
    raw_max: 10000
    eng_min: 0
    eng_max: 10
"#,
        )
        .unwrap();
        let p = r.point_for_tag("OutputValue_1").unwrap();
        assert_eq!(p.raw_from_value(5.0).unwrap(), 5000);
        assert_eq!(p.raw_from_value(10.0).unwrap(), 10000);
        assert!(matches!(
            p.raw_from_value(7000.0).unwrap_err(),
            ValueError::OutOfRange { .. }
        ));
        assert_eq!(
            p.raw_from_value(f64::NAN).unwrap_err(),
            ValueError::NotFinite
        );
        // 70000 raw does not fit 16 bits: refused, never saturated.
        assert!(p.raw_from_value(70.0).is_err());
        assert!(p.raw_from_value(-0.5).is_err());
    }

    #[test]
    fn a_bit_value_is_nonzero_means_on() {
        let r = build(OK).unwrap();
        let p = r.point_for_tag("pump").unwrap();
        assert_eq!(p.raw_from_value(0.0).unwrap(), 0);
        assert_eq!(p.raw_from_value(1.0).unwrap(), 1);
        assert_eq!(p.raw_from_value(2.5).unwrap(), 1);
        assert_eq!(
            p.raw_from_value(f64::INFINITY).unwrap_err(),
            ValueError::NotFinite
        );
    }

    // ---- verification against the driver --------------------------------

    fn pi_of(kernel: &std::sync::Arc<FakeKernel>) -> PiControl {
        PiControl::new(kernel.open())
    }

    #[test]
    fn a_driver_that_loaded_the_same_file_verifies() {
        let kernel = FakeKernel::sample();
        build(OK).unwrap().verify(&pi_of(&kernel)).unwrap();
    }

    #[test]
    fn a_driver_that_places_a_variable_elsewhere_is_refused() {
        let kernel = FakeKernel::sample();
        // The driver was reset with a file that moves the DIO by 4 bytes.
        let moved = sample::rsc().replace("\"offset\": 100", "\"offset\": 104");
        kernel.reset_driver_with(&ProcessMap::parse(moved.as_bytes()).unwrap());
        let e = build(OK).unwrap().verify(&pi_of(&kernel)).unwrap_err();
        assert!(matches!(e, RegistryError::DriverDisagrees { .. }), "{e}");
        assert!(e.to_string().contains("different configuration"));
    }

    #[test]
    fn a_driver_without_the_variable_is_refused() {
        let kernel = FakeKernel::sample();
        let without = sample::rsc().replace("\"O_1\"", "\"O_one\"");
        kernel.reset_driver_with(&ProcessMap::parse(without.as_bytes()).unwrap());
        let e = build(OK).unwrap().verify(&pi_of(&kernel)).unwrap_err();
        assert!(matches!(
            e,
            RegistryError::DriverDisagrees { driver: None, .. }
        ));
    }

    #[test]
    fn an_output_module_that_is_not_connected_is_refused() {
        let kernel = FakeKernel::sample();
        kernel.set_module_active(32, false);
        let e = build(OK).unwrap().verify(&pi_of(&kernel)).unwrap_err();
        assert!(
            matches!(e, RegistryError::OutputModuleInactive { position: 32, .. }),
            "{e}"
        );
    }

    #[test]
    fn an_input_module_that_is_not_connected_does_not_stop_the_registry() {
        let kernel = FakeKernel::sample();
        kernel.set_module_active(33, false);
        let r = build("points:\n  - variable: InputValue_1\n").unwrap();
        r.verify(&pi_of(&kernel)).unwrap();
    }

    #[test]
    fn a_module_of_another_type_than_declared_is_refused() {
        // The driver lists position 32 as an AIO although config.rsc says DIO.
        let moved = sample::rsc().replace("\"productType\": \"96\"", "\"productType\": \"103\"");
        let map = ProcessMap::parse(moved.as_bytes()).unwrap();
        let wrong = FakeKernel::from_map(&map, {
            let mut devices = vec![];
            for d in map.devices() {
                devices.push(super::super::abi::DeviceInfo {
                    address: d.position,
                    module_type: d.product_type,
                    base_offset: d.base_offset,
                    active: true,
                    ..Default::default()
                });
            }
            devices
        });
        let e = build(OK).unwrap().verify(&pi_of(&wrong)).unwrap_err();
        assert!(matches!(e, RegistryError::DeviceMismatch { .. }), "{e}");
    }
}
