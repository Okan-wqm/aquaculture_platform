//! The PiCtory configuration (`config.rsc`) the driver builds its process
//! image from.
//!
//! piControl lays the process image out from `/etc/revpi/config.rsc`
//! (`PICONFIG_FILE`, `piControl.4`): every configured device carries a base
//! offset, and every variable an offset inside its device. On Suderra OS that
//! file is signed site material the root installer delivers to
//! `/var/lib/suderra-site/revpi/config.rsc` (contract mutable-state.json,
//! DEC-4.12, DEC-8.8): root loads it into the driver, and the agent receives
//! the same verified bytes. This parser reproduces the arithmetic of the
//! driver's own parser (`piConfigParse()` in `piConfig.c`, piControl v2.8.2),
//! so the agent can name every variable's process-image location from the
//! signed file; [`super::registry`] then proves, request by request
//! (`KB_FIND_VARIABLE`), that the driver loaded the same layout.
//!
//! # Format (as `piConfig.c` reads it)
//!
//! ```text
//! { "Devices": [ { "productType": "96", "position": "32", "offset": 100,
//!                  "inp": { "0": [name, default, bitLength, offset, exported,
//!                                 sortPos, comment, bitPos], ... },
//!                  "out": { ... }, "mem": { ... }, "config": { ... } }, ... ] }
//! ```
//!
//! * the device's `offset` is its base in the process image, an entry's
//!   `offset` is relative to it;
//! * `bitPos` counts only for 1-bit variables, and a `bitPos` of 8 or more
//!   carries into the byte offset (`while (bitPos >= 8)`);
//! * numbers may be JSON numbers or strings, read with base 0 (`kstrtou16`):
//!   decimal, `0x` hexadecimal or a leading-zero octal;
//! * `exported` marks an output another process owns and copies in with
//!   `KB_SET_EXPORTED_OUTPUTS`.
//!
//! Where the driver falls back to 0 on a field it cannot parse (an address, a
//! length), this parser refuses the file instead: a variable at the wrong
//! address is a write to the wrong output.

use std::collections::BTreeMap;
use std::fmt;

use serde_json::Value;

use super::abi::{AbiError, PROCESS_IMAGE_LEN, VariableName};

/// Largest `config.rsc` accepted: the site-file cap of `site_trust`.
pub const MAX_RSC_BYTES: usize = 1_048_576;
/// Most variables one file may declare.
const MAX_VARIABLES: usize = 65_536;

/// Which block of its device a variable belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Section {
    /// `inp`: the module writes it, the agent reads it.
    Input,
    /// `out`: the application writes it.
    Output,
    /// `mem`: module memory (counters, parameters).
    Memory,
    /// `config`: module configuration.
    Config,
}

/// How many bits a variable occupies, among the widths the driver exposes
/// (`SPIVariable.i16uLength`: 1, 8, 16 and 32).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Width {
    Bit,
    Byte,
    Word,
    DWord,
}

impl Width {
    /// The width of a bit length the driver exposes.
    pub fn of_bits(bits: u16) -> Option<Self> {
        match bits {
            1 => Some(Self::Bit),
            8 => Some(Self::Byte),
            16 => Some(Self::Word),
            32 => Some(Self::DWord),
            _ => None,
        }
    }

    /// Bytes a value of this width occupies in the process image (a bit
    /// shares its byte).
    pub const fn bytes(self) -> usize {
        self.byte_offsets().len()
    }

    /// The offset of each byte of the value from its address, least
    /// significant first. The one table of how wide a value is, so no caller
    /// converts a count into an offset.
    pub const fn byte_offsets(self) -> &'static [u16] {
        match self {
            Self::Bit | Self::Byte => &[0],
            Self::Word => &[0, 1],
            Self::DWord => &[0, 1, 2, 3],
        }
    }

    /// Bits of the value.
    pub const fn bits(self) -> u16 {
        match self {
            Self::Bit => 1,
            Self::Byte => 8,
            Self::Word => 16,
            Self::DWord => 32,
        }
    }
}

/// One device of the configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceDecl {
    /// `position`: the module's PiBridge address.
    pub position: u8,
    /// `productType`: the module type (`KUNBUS_FW_DESCR_TYP_*`).
    pub product_type: u16,
    /// `offset`: the module's base in the process image.
    pub base_offset: u16,
}

/// One variable, located as the driver locates it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariableDecl {
    pub name: VariableName,
    /// `position` of the device that owns the variable.
    pub device: u8,
    pub section: Section,
    /// `exported`: another process owns this output.
    pub exported: bool,
    /// Absolute byte address in the process image.
    pub address: u16,
    /// Bit 0-7 for a 1-bit variable, 0 otherwise.
    pub bit: u8,
    /// Length in bits as the file declares it.
    pub bit_length: u16,
    /// The value the driver gives the variable when it is reset.
    pub default: u32,
}

impl VariableDecl {
    /// The width, when the driver exposes one for this length.
    pub fn width(&self) -> Option<Width> {
        Width::of_bits(self.bit_length)
    }
}

/// Why a `config.rsc` is refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RscError {
    /// Larger than [`MAX_RSC_BYTES`].
    TooLarge { len: usize },
    /// Not JSON (the driver tolerates comments; the signed file has none).
    NotJson(String),
    /// `Devices` is missing or not an array.
    NoDevices,
    /// A device the driver could not place.
    Device { index: usize, reason: String },
    /// A variable the driver could not place.
    Variable { name: String, reason: String },
    /// Two variables of one name (PiCtory keeps names unique).
    DuplicateName(String),
    /// More variables than any real configuration holds.
    TooManyVariables,
}

impl fmt::Display for RscError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge { len } => {
                write!(f, "config.rsc is {len} bytes, more than {MAX_RSC_BYTES}")
            }
            Self::NotJson(e) => write!(f, "config.rsc is not JSON: {e}"),
            Self::NoDevices => f.write_str("config.rsc has no Devices array"),
            Self::Device { index, reason } => {
                write!(f, "config.rsc device #{index}: {reason}")
            }
            Self::Variable { name, reason } => {
                write!(f, "config.rsc variable {name:?}: {reason}")
            }
            Self::DuplicateName(n) => {
                write!(f, "config.rsc declares variable {n:?} more than once")
            }
            Self::TooManyVariables => {
                write!(f, "config.rsc declares more than {MAX_VARIABLES} variables")
            }
        }
    }
}

impl std::error::Error for RscError {}

/// The process image a `config.rsc` describes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessMap {
    devices: Vec<DeviceDecl>,
    variables: BTreeMap<VariableName, VariableDecl>,
}

impl ProcessMap {
    /// Parse the signed (or, in the generic profile, the on-disk) file.
    pub fn parse(bytes: &[u8]) -> Result<Self, RscError> {
        if bytes.len() > MAX_RSC_BYTES {
            return Err(RscError::TooLarge { len: bytes.len() });
        }
        let root: Value =
            serde_json::from_slice(bytes).map_err(|e| RscError::NotJson(e.to_string()))?;
        let devices = root
            .get("Devices")
            .and_then(Value::as_array)
            .ok_or(RscError::NoDevices)?;

        let mut map = Self {
            devices: Vec::new(),
            variables: BTreeMap::new(),
        };
        for (index, device) in devices.iter().enumerate() {
            map.add_device(index, device)?;
        }
        Ok(map)
    }

    fn add_device(&mut self, index: usize, device: &Value) -> Result<(), RscError> {
        let bad = |reason: String| RscError::Device { index, reason };
        let number = |key: &str| -> Result<u64, RscError> {
            device
                .get(key)
                .ok_or_else(|| bad(format!("no {key}")))
                .and_then(|v| number_of(v).ok_or_else(|| bad(format!("{key} is not an integer"))))
        };
        let position = u8::try_from(number("position")?)
            .map_err(|_| bad("position does not fit one byte".into()))?;
        let product_type = u16::try_from(number("productType")?)
            .map_err(|_| bad("productType does not fit 16 bits".into()))?;
        let base_offset = u16::try_from(number("offset")?)
            .map_err(|_| bad("offset does not fit 16 bits".into()))?;
        if usize::from(base_offset) >= PROCESS_IMAGE_LEN {
            return Err(bad(format!(
                "offset {base_offset} is outside the {PROCESS_IMAGE_LEN}-byte process image"
            )));
        }
        if self.devices.iter().any(|d| d.position == position) {
            return Err(bad(format!("position {position} is declared twice")));
        }
        self.devices.push(DeviceDecl {
            position,
            product_type,
            base_offset,
        });

        for (key, section) in [
            ("inp", Section::Input),
            ("out", Section::Output),
            ("mem", Section::Memory),
            ("config", Section::Config),
        ] {
            let Some(entries) = device.get(key) else {
                continue;
            };
            let entries = entries
                .as_object()
                .ok_or_else(|| bad(format!("{key} is not an object")))?;
            for entry in entries.values() {
                // The driver only counts array members as entries.
                let Some(fields) = entry.as_array() else {
                    continue;
                };
                self.add_variable(position, base_offset, section, fields)?;
            }
        }
        Ok(())
    }

    fn add_variable(
        &mut self,
        device: u8,
        base_offset: u16,
        section: Section,
        fields: &[Value],
    ) -> Result<(), RscError> {
        // Every entry is an 8-element array (piConfig.c: "bitPos at index 7").
        let name_text = fields.first().and_then(Value::as_str).unwrap_or_default();
        let bad = |reason: String| RscError::Variable {
            name: name_text.to_owned(),
            reason,
        };
        if fields.len() < 8 {
            return Err(bad(format!("{} fields, the driver needs 8", fields.len())));
        }
        // The driver stores 31 bytes; two longer names that agree in their
        // first 31 would be one variable to it.
        let name = VariableName::new(truncate_like_driver(name_text))
            .map_err(|e: AbiError| bad(e.to_string()))?;
        let field = |i: usize| -> Result<u64, RscError> {
            fields
                .get(i)
                .and_then(number_of)
                .ok_or_else(|| bad(format!("field {i} is not an integer")))
        };
        let bit_length =
            u16::try_from(field(2)?).map_err(|_| bad("bit length too large".into()))?;
        let entry_offset = u16::try_from(field(3)?).map_err(|_| bad("offset too large".into()))?;
        let exported = fields.get(4).is_some_and(|v| match v {
            Value::Bool(b) => *b,
            Value::String(s) => s == "true",
            _ => false,
        });
        let raw_bit = if bit_length == 1 {
            u16::try_from(field(7)?).map_err(|_| bad("bit position too large".into()))?
        } else {
            0
        };
        let default = fields.get(1).map(default_of).unwrap_or(0);

        let address = base_offset
            .checked_add(entry_offset)
            .and_then(|a| a.checked_add(raw_bit / 8))
            .ok_or_else(|| bad("address overflows".into()))?;
        let bit = u8::try_from(raw_bit % 8).map_err(|_| bad("bit position".into()))?;

        let decl = VariableDecl {
            name: name.clone(),
            device,
            section,
            exported,
            address,
            bit,
            bit_length,
            default,
        };
        if let Some(width) = decl.width() {
            if usize::from(address) + width.bytes() > PROCESS_IMAGE_LEN {
                return Err(bad(format!(
                    "address {address} + {} bytes is outside the process image",
                    width.bytes()
                )));
            }
        }
        if self.variables.len() >= MAX_VARIABLES {
            return Err(RscError::TooManyVariables);
        }
        if self.variables.insert(name.clone(), decl).is_some() {
            return Err(RscError::DuplicateName(name.to_string()));
        }
        Ok(())
    }

    /// The device at a PiBridge position.
    pub fn device(&self, position: u8) -> Option<&DeviceDecl> {
        self.devices.iter().find(|d| d.position == position)
    }

    /// Every device, in file order.
    #[cfg(test)]
    pub fn devices(&self) -> &[DeviceDecl] {
        &self.devices
    }

    /// The variable of that name.
    pub fn variable(&self, name: &VariableName) -> Option<&VariableDecl> {
        self.variables.get(name)
    }

    /// Every variable, ordered by name.
    pub fn variables(&self) -> impl Iterator<Item = &VariableDecl> {
        self.variables.values()
    }
}

/// The driver keeps `sizeof(strVarName) - 1` bytes of a name.
fn truncate_like_driver(name: &str) -> &str {
    name.get(..super::abi::MAX_NAME_LEN).unwrap_or(name)
}

/// An integer as `kstrtou*(.., 0, ..)` reads it: a JSON integer, or a string
/// in decimal, `0x` hexadecimal or leading-zero octal.
fn number_of(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => parse_base0(s),
        _ => None,
    }
}

fn parse_base0(s: &str) -> Option<u64> {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        return u64::from_str_radix(hex, 16).ok();
    }
    if s.len() > 1 && s.starts_with('0') {
        return u64::from_str_radix(s.get(1..)?, 8).ok();
    }
    s.parse::<u64>().ok()
}

/// The default value as the driver reads it: unsigned, else signed (kept as
/// the 32 bits the driver stores), else `0b` binary, else 0.
fn default_of(v: &Value) -> u32 {
    let text = match v {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.trim().to_owned(),
        _ => return 0,
    };
    if let Some(u) = parse_base0(&text) {
        return u32::try_from(u).unwrap_or(0);
    }
    if let Ok(i) = text.parse::<i32>() {
        return u32::from_ne_bytes(i.to_ne_bytes());
    }
    if let Some(bin) = text.strip_prefix("0b") {
        return u32::from_str_radix(bin, 2).unwrap_or(0);
    }
    if let Some(bin) = text.strip_prefix("-0b") {
        return u32::from_str_radix(bin, 2).unwrap_or(0);
    }
    0
}

/// A small configuration in the shape `piConfig.c` parses, for the tests of
/// this module and of its consumers. The layout is synthetic (it follows the
/// format, not a KUNBUS module's real variable table): a Connect 4 base at
/// offset 0, a DIO at position 32 (base 100) and an AIO at position 33
/// (base 200).
#[cfg(test)]
pub(crate) mod sample {
    pub fn rsc() -> String {
        r#"{
  "App": { "name": "synthetic" },
  "Summary": { "inpTotal": 0 },
  "Devices": [
    { "id": "base", "productType": "136", "position": "0", "name": "RevPi Connect 4", "offset": 0,
      "inp": {
        "0": ["RevPiStatus", "0", "8", "0", false, "0000", "", ""],
        "1": ["RevPiIOCycle", "0", "8", "1", false, "0001", "", ""]
      },
      "out": {
        "0": ["RevPiOutput", "0", "8", "6", false, "0002", "", ""],
        "1": ["RevPiLED", "0", "16", "7", false, "0003", "", ""]
      },
      "mem": {}
    },
    { "id": "dio", "productType": "96", "position": "32", "name": "RevPi DIO", "offset": 100,
      "inp": {
        "0": ["Input_Status", "0", "16", "0", false, "0000", "", ""],
        "1": ["I_1", "0", "1", "0", false, "0001", "", "0"],
        "2": ["I_2", "0", "1", "0", false, "0002", "", "1"],
        "3": ["I_9", "0", "1", "0", false, "0003", "", "8"]
      },
      "out": {
        "0": ["Output_Status", "0", "16", "20", false, "0000", "", ""],
        "1": ["O_1", "0", "1", "22", false, "0001", "", "0"],
        "2": ["O_2", "1", "1", "22", false, "0002", "", "1"],
        "3": ["O_3", "0", "1", "22", true, "0003", "", "2"],
        "4": ["PWM_1", "0", "8", "23", false, "0004", "", ""]
      },
      "mem": {
        "0": ["Counter_1", "0", "32", "30", false, "0000", "", ""]
      }
    },
    { "id": "aio", "productType": "103", "position": "33", "name": "RevPi AIO", "offset": 200,
      "inp": {
        "0": ["InputValue_1", "0", "16", "0", false, "0000", "", ""],
        "1": ["InputValue_2", "0", "16", "2", false, "0001", "", ""]
      },
      "out": {
        "0": ["OutputValue_1", "0", "16", "10", false, "0000", "", ""],
        "1": ["OutputValue_2", "0", "16", "12", false, "0001", "", ""]
      },
      "mem": {}
    }
  ],
  "Connections": []
}"#
        .to_owned()
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

    use super::*;

    fn name(n: &str) -> VariableName {
        VariableName::new(n).unwrap()
    }

    fn parsed() -> ProcessMap {
        ProcessMap::parse(sample::rsc().as_bytes()).unwrap()
    }

    #[test]
    fn devices_carry_position_type_and_base() {
        let map = parsed();
        assert_eq!(map.devices().len(), 3);
        let dio = map.device(32).unwrap();
        assert_eq!((dio.product_type, dio.base_offset), (96, 100));
        assert_eq!(map.device(33).unwrap().base_offset, 200);
    }

    #[test]
    fn a_variable_address_is_the_device_base_plus_its_offset() {
        let map = parsed();
        let status = map.variable(&name("Output_Status")).unwrap();
        assert_eq!(status.address, 120);
        assert_eq!(status.width(), Some(Width::Word));
        assert_eq!(map.variable(&name("OutputValue_2")).unwrap().address, 212);
        assert_eq!(map.variable(&name("RevPiLED")).unwrap().address, 7);
    }

    #[test]
    fn a_one_bit_variable_keeps_its_bit_position() {
        let map = parsed();
        let o2 = map.variable(&name("O_2")).unwrap();
        assert_eq!((o2.address, o2.bit, o2.bit_length), (122, 1, 1));
        assert_eq!(o2.width(), Some(Width::Bit));
        assert_eq!(o2.default, 1);
    }

    #[test]
    fn a_bit_position_of_eight_or_more_carries_into_the_byte_offset() {
        // piConfig.c: while (bitPos >= 8) { bitPos -= 8; offset++; }
        let i9 = parsed().variable(&name("I_9")).unwrap().clone();
        assert_eq!((i9.address, i9.bit), (101, 0));
    }

    #[test]
    fn the_bit_position_is_ignored_for_whole_byte_variables() {
        let map = ProcessMap::parse(
            br#"{"Devices":[{"productType":"96","position":"1","offset":10,
              "out":{"0":["B","0","8","2",false,"0","","5"]}}]}"#,
        )
        .unwrap();
        let b = map.variable(&name("B")).unwrap();
        assert_eq!((b.address, b.bit), (12, 0));
    }

    #[test]
    fn the_section_and_the_exported_flag_are_kept() {
        let map = parsed();
        assert_eq!(map.variable(&name("I_1")).unwrap().section, Section::Input);
        assert_eq!(map.variable(&name("O_1")).unwrap().section, Section::Output);
        assert_eq!(
            map.variable(&name("Counter_1")).unwrap().section,
            Section::Memory
        );
        assert!(map.variable(&name("O_3")).unwrap().exported);
        assert!(!map.variable(&name("O_1")).unwrap().exported);
    }

    #[test]
    fn numbers_read_like_kstrtou_base_zero() {
        let map = ProcessMap::parse(
            br#"{"Devices":[{"productType":"0x60","position":16,"offset":"010",
              "out":{"0":["H","0x1F","0x10","0x2",false,"0","",""]}}]}"#,
        )
        .unwrap();
        let dev = map.device(16).unwrap();
        assert_eq!(
            (dev.product_type, dev.base_offset),
            (0x60, 8),
            "0x60 and octal 010"
        );
        let h = map.variable(&name("H")).unwrap();
        assert_eq!((h.address, h.bit_length, h.default), (10, 16, 0x1F));
    }

    #[test]
    fn defaults_read_like_the_driver() {
        let d = |v: &str| {
            let doc = format!(
                r#"{{"Devices":[{{"productType":"96","position":"1","offset":0,
                   "out":{{"0":["V",{v},"16","0",false,"0","",""]}}}}]}}"#
            );
            ProcessMap::parse(doc.as_bytes())
                .unwrap()
                .variable(&name("V"))
                .unwrap()
                .default
        };
        assert_eq!(d("\"7\""), 7);
        assert_eq!(d("9"), 9);
        assert_eq!(
            d("\"-1\""),
            u32::MAX,
            "negative defaults keep their 32 bits"
        );
        assert_eq!(d("\"0b101\""), 5);
        assert_eq!(d("\"-0b11\""), 3);
        assert_eq!(d("\"junk\""), 0, "the driver falls back to 0");
    }

    #[test]
    fn an_unparsable_address_is_refused_not_zeroed() {
        let doc = br#"{"Devices":[{"productType":"96","position":"1","offset":0,
          "out":{"0":["V","0","16","oops",false,"0","",""]}}]}"#;
        let e = ProcessMap::parse(doc).unwrap_err();
        assert!(matches!(e, RscError::Variable { .. }), "{e}");
    }

    #[test]
    fn a_short_entry_is_refused() {
        let doc = br#"{"Devices":[{"productType":"96","position":"1","offset":0,
          "out":{"0":["V","0","16","0"]}}]}"#;
        assert!(
            ProcessMap::parse(doc)
                .unwrap_err()
                .to_string()
                .contains("needs 8")
        );
    }

    #[test]
    fn duplicate_names_are_refused_even_across_devices() {
        let doc = br#"{"Devices":[
          {"productType":"96","position":"1","offset":0,"out":{"0":["V","0","8","0",false,"0","",""]}},
          {"productType":"98","position":"2","offset":50,"out":{"0":["V","0","8","0",false,"0","",""]}}]}"#;
        assert_eq!(
            ProcessMap::parse(doc).unwrap_err(),
            RscError::DuplicateName("V".into())
        );
    }

    #[test]
    fn two_names_equal_in_their_first_31_bytes_are_one_name_to_the_driver() {
        let a = "a".repeat(31);
        let doc = format!(
            r#"{{"Devices":[{{"productType":"96","position":"1","offset":0,"out":{{
              "0":["{a}x","0","8","0",false,"0","",""],
              "1":["{a}y","0","8","1",false,"0","",""]}}}}]}}"#
        );
        assert_eq!(
            ProcessMap::parse(doc.as_bytes()).unwrap_err(),
            RscError::DuplicateName(a)
        );
    }

    #[test]
    fn a_variable_outside_the_process_image_is_refused() {
        let doc = br#"{"Devices":[{"productType":"96","position":"1","offset":4090,
          "out":{"0":["V","0","32","4","false","0","",""]}}]}"#;
        let e = ProcessMap::parse(doc).unwrap_err();
        assert!(e.to_string().contains("outside the process image"), "{e}");
    }

    #[test]
    fn a_position_declared_twice_is_refused() {
        let doc = br#"{"Devices":[
          {"productType":"96","position":"1","offset":0},
          {"productType":"98","position":"1","offset":50}]}"#;
        assert!(
            ProcessMap::parse(doc)
                .unwrap_err()
                .to_string()
                .contains("declared twice")
        );
    }

    #[test]
    fn files_without_devices_or_json_or_within_the_cap_are_refused() {
        assert_eq!(ProcessMap::parse(b"{}"), Err(RscError::NoDevices));
        assert!(matches!(
            ProcessMap::parse(b"{ // comment\n}"),
            Err(RscError::NotJson(_))
        ));
        assert!(matches!(
            ProcessMap::parse(&vec![b' '; MAX_RSC_BYTES + 1]),
            Err(RscError::TooLarge { .. })
        ));
    }

    #[test]
    fn a_width_names_the_offset_of_each_of_its_bytes() {
        assert_eq!(Width::Bit.byte_offsets(), &[0]);
        assert_eq!(Width::Byte.byte_offsets(), &[0]);
        assert_eq!(Width::Word.byte_offsets(), &[0, 1]);
        assert_eq!(Width::DWord.byte_offsets(), &[0, 1, 2, 3]);
        for w in [Width::Bit, Width::Byte, Width::Word, Width::DWord] {
            assert_eq!(w.byte_offsets().len(), w.bytes());
            assert!(usize::from(w.bits()) <= 8 * w.bytes(), "{w:?}");
        }
    }

    #[test]
    fn widths_other_than_the_four_the_driver_exposes_have_no_width() {
        let doc = br#"{"Devices":[{"productType":"96","position":"1","offset":0,
          "inp":{"0":["W24","0","24","0",false,"0","",""]}}]}"#;
        let map = ProcessMap::parse(doc).unwrap();
        assert_eq!(map.variable(&name("W24")).unwrap().width(), None);
    }
}
