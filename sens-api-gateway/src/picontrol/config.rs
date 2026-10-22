//! The `picontrol:` section of `config.yaml`.
//!
//! `/dev/piControl0` gives its opener the whole process image: every input,
//! every output, the base module's status and LEDs, and (on the RevPi Connect
//! and Connect SE) the bit that triggers the board watchdog. The section is
//! therefore the agent's own, narrower grant (ADR-048 DEC-8.8): the points it
//! lists are the only variables it reads or writes, an output exists only
//! when it is listed here as an output, and the section is part of the signed
//! site configuration (on Suderra OS `config.yaml` is digest-bound by the site
//! config statement, DEC-4.10), so widening the grant needs a signed site
//! config and the local approval root asks for (DEC-4.12, DEC-13.4).
//!
//! ```yaml
//! picontrol:
//!   output_watchdog_ms: 4000          # optional; default max(2000, 4 x io_data_interval_ms)
//!   points:
//!     - tag: pump_1_run               # optional; defaults to the variable name
//!       variable: O_1                 # the PiCtory variable name (config.rsc)
//!       direction: output
//!       safe_state_value: 0           # outputs: raw value on safe state (default 0)
//!     - variable: InputValue_1
//!       data_type: uint16
//!       raw_min: 0
//!       raw_max: 10000
//!       eng_min: 0
//!       eng_max: 10
//!       eng_unit: V
//! ```

use serde::{Deserialize, Serialize};

use super::rsc::Width;

/// Lowest accepted output watchdog: below this the period is shorter than a
/// RevPi I/O cycle can be fed reliably.
pub const MIN_OUTPUT_WATCHDOG_MS: u32 = 200;
/// Highest accepted output watchdog: a stalled control loop must not leave
/// the outputs driven for minutes.
pub const MAX_OUTPUT_WATCHDOG_MS: u32 = 60_000;
/// How many polling intervals one watchdog period must span, so an ordinary
/// late cycle never zeroes the outputs.
pub const WATCHDOG_CYCLES: u64 = 3;
/// The default period never goes below this.
const DEFAULT_WATCHDOG_FLOOR_MS: u64 = 2_000;

/// What the agent does with a point.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    /// Read only.
    #[default]
    Input,
    /// Read, and written by the agent's writers (and driven to its safe
    /// value by the safe-state pass).
    Output,
}

/// How the raw bits of a point read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointType {
    Bool,
    Uint8,
    Int8,
    Uint16,
    Int16,
    Uint32,
    Int32,
}

impl PointType {
    /// The width a variable must have for this type.
    pub const fn width(self) -> Width {
        match self {
            Self::Bool => Width::Bit,
            Self::Uint8 | Self::Int8 => Width::Byte,
            Self::Uint16 | Self::Int16 => Width::Word,
            Self::Uint32 | Self::Int32 => Width::DWord,
        }
    }

    /// Two's-complement reading.
    pub const fn signed(self) -> bool {
        matches!(self, Self::Int8 | Self::Int16 | Self::Int32)
    }

    /// The type of an unsigned variable of `width`.
    pub const fn unsigned_of(width: Width) -> Self {
        match width {
            Width::Bit => Self::Bool,
            Width::Byte => Self::Uint8,
            Width::Word => Self::Uint16,
            Width::DWord => Self::Uint32,
        }
    }

    /// The name the tag configuration carries (`TagConfig.data_type`).
    pub const fn name(self) -> &'static str {
        match self {
            Self::Bool => "bool",
            Self::Uint8 => "uint8",
            Self::Int8 => "int8",
            Self::Uint16 => "uint16",
            Self::Int16 => "int16",
            Self::Uint32 => "uint32",
            Self::Int32 => "int32",
        }
    }
}

/// One variable of the process image the agent reads, and perhaps writes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PointConfig {
    /// The tag name; defaults to the variable name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    /// The PiCtory variable name, as `config.rsc` declares it.
    pub variable: String,
    #[serde(default)]
    pub direction: Direction,
    /// How the bits read; defaults to the unsigned type of the variable's
    /// width.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_type: Option<PointType>,
    /// Outputs: the raw value the safe-state pass drives (default 0). It must
    /// equal the default `config.rsc` declares for the variable, which is what
    /// the driver restores on a reset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safe_state_value: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eng_min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eng_max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eng_unit: Option<String>,
}

impl PointConfig {
    /// The tag name.
    pub fn tag_name(&self) -> &str {
        self.tag.as_deref().unwrap_or(&self.variable)
    }
}

/// The `picontrol:` section.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PiControlConfig {
    /// Generic profile only: the PiCtory file the driver loaded (default
    /// `/etc/revpi/config.rsc`). On Suderra OS the path is a compile-time
    /// constant (`paths.rs`) and the verified bytes come with the site; a
    /// site that names a path is refused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_rsc: Option<String>,
    /// The output watchdog period, in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_watchdog_ms: Option<u32>,
    /// The variables the agent reads and writes.
    #[serde(default)]
    pub points: Vec<PointConfig>,
}

impl PiControlConfig {
    /// The output watchdog period for a control loop that runs every
    /// `io_interval_ms`.
    pub fn watchdog_ms(&self, io_interval_ms: u64) -> u32 {
        match self.output_watchdog_ms {
            Some(ms) => ms,
            None => {
                let ms = DEFAULT_WATCHDOG_FLOOR_MS.max(io_interval_ms.saturating_mul(4));
                u32::try_from(ms.min(u64::from(MAX_OUTPUT_WATCHDOG_MS))).unwrap_or(u32::MAX)
            }
        }
    }

    /// Whether any point is an output.
    pub fn has_outputs(&self) -> bool {
        self.points.iter().any(|p| p.direction == Direction::Output)
    }

    /// Checks that need no `config.rsc` and no device (those are
    /// [`super::registry::Registry::build`]).
    pub fn validate(&self, io_interval_ms: u64) -> Result<(), String> {
        if self.points.is_empty() {
            return Err(
                "picontrol: lists no points; remove the section or list the variables \
                        the agent may read and write"
                    .into(),
            );
        }
        let watchdog = self.watchdog_ms(io_interval_ms);
        if !(MIN_OUTPUT_WATCHDOG_MS..=MAX_OUTPUT_WATCHDOG_MS).contains(&watchdog) {
            return Err(format!(
                "picontrol: output_watchdog_ms {watchdog} is outside \
                 {MIN_OUTPUT_WATCHDOG_MS}..={MAX_OUTPUT_WATCHDOG_MS}"
            ));
        }
        if self.has_outputs()
            && u64::from(watchdog) < io_interval_ms.saturating_mul(WATCHDOG_CYCLES)
        {
            return Err(format!(
                "picontrol: output_watchdog_ms {watchdog} is shorter than {WATCHDOG_CYCLES} \
                 polling intervals ({io_interval_ms} ms each): an ordinary late cycle would \
                 zero the outputs"
            ));
        }
        for p in &self.points {
            if p.direction == Direction::Input && p.safe_state_value.is_some() {
                return Err(format!(
                    "picontrol: point {:?} is an input and has a safe_state_value",
                    p.tag_name()
                ));
            }
            let scaled = [p.raw_min, p.raw_max, p.eng_min, p.eng_max];
            let given = scaled.iter().filter(|v| v.is_some()).count();
            if given != 0 && given != 4 {
                return Err(format!(
                    "picontrol: point {:?} sets some of raw_min, raw_max, eng_min, eng_max \
                     but not all four",
                    p.tag_name()
                ));
            }
            if scaled.iter().flatten().any(|v| !v.is_finite()) {
                return Err(format!(
                    "picontrol: point {:?} has a non-finite scaling value",
                    p.tag_name()
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

    use super::*;

    fn parse(yaml: &str) -> PiControlConfig {
        serde_yaml::from_str(yaml).unwrap()
    }

    #[test]
    fn the_documented_section_parses() {
        let c = parse(
            r#"
output_watchdog_ms: 4000
points:
  - tag: pump_1_run
    variable: O_1
    direction: output
    safe_state_value: 0
  - variable: InputValue_1
    data_type: uint16
    raw_min: 0
    raw_max: 10000
    eng_min: 0
    eng_max: 10
    eng_unit: V
"#,
        );
        assert_eq!(c.points.len(), 2);
        assert_eq!(c.points[0].tag_name(), "pump_1_run");
        assert_eq!(c.points[1].tag_name(), "InputValue_1");
        assert_eq!(c.points[1].direction, Direction::Input);
        assert_eq!(c.points[1].data_type, Some(PointType::Uint16));
        assert!(c.validate(1000).is_ok());
    }

    #[test]
    fn unknown_keys_are_refused() {
        assert!(serde_yaml::from_str::<PiControlConfig>("points: []\nwatchdog: 1\n").is_err());
        assert!(
            serde_yaml::from_str::<PiControlConfig>(
                "points:\n  - variable: O_1\n    write_anything: true\n"
            )
            .is_err()
        );
    }

    #[test]
    fn the_default_watchdog_follows_the_polling_interval() {
        let c = parse("points:\n  - variable: I_1\n");
        assert_eq!(c.watchdog_ms(1000), 4000);
        assert_eq!(c.watchdog_ms(100), 2000, "never below the floor");
        assert_eq!(c.watchdog_ms(60_000), MAX_OUTPUT_WATCHDOG_MS);
    }

    #[test]
    fn an_explicit_watchdog_shorter_than_three_cycles_is_refused_for_outputs() {
        let c =
            parse("output_watchdog_ms: 2500\npoints:\n  - variable: O_1\n    direction: output\n");
        assert!(
            c.validate(1000)
                .unwrap_err()
                .contains("3 polling intervals")
        );
        assert!(c.validate(800).is_ok());
    }

    #[test]
    fn the_watchdog_range_is_enforced() {
        let low = parse("output_watchdog_ms: 100\npoints:\n  - variable: I_1\n");
        assert!(low.validate(10).unwrap_err().contains("outside"));
        let high = parse("output_watchdog_ms: 90000\npoints:\n  - variable: I_1\n");
        assert!(high.validate(10).unwrap_err().contains("outside"));
    }

    #[test]
    fn an_empty_section_is_refused() {
        assert!(parse("points: []\n").validate(1000).is_err());
    }

    #[test]
    fn an_input_cannot_carry_a_safe_state_value() {
        let c = parse("points:\n  - variable: I_1\n    safe_state_value: 0\n");
        assert!(c.validate(1000).unwrap_err().contains("is an input"));
    }

    #[test]
    fn scaling_is_all_or_nothing() {
        let c = parse("points:\n  - variable: V\n    raw_min: 0\n    raw_max: 10\n");
        assert!(c.validate(1000).unwrap_err().contains("all four"));
    }

    #[test]
    fn point_types_know_their_width_and_sign() {
        assert_eq!(PointType::Bool.width(), Width::Bit);
        assert_eq!(PointType::Int16.width(), Width::Word);
        assert!(PointType::Int32.signed());
        assert!(!PointType::Uint8.signed());
        assert_eq!(PointType::unsigned_of(Width::DWord), PointType::Uint32);
    }
}
