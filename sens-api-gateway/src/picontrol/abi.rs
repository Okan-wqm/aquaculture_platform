//! The piControl character-device ABI (`/dev/piControl0`).
//!
//! Source of truth: KUNBUS `piControl` v2.8.2 — tag `v2.8.2`, commit
//! `7980b36f361a8c31680dbd1cbc8d567a7afa4a38`
//! (<https://gitlab.com/revolutionpi/piControl/-/archive/v2.8.2/piControl-v2.8.2.tar.gz>,
//! sha256 of the downloaded archive
//! `ea6b8277c70d066068b3f4e359ad73730c3b9af93cb89ce23b3f77c26959e437`): the
//! uapi header `src/piControl.h` (MIT), the ioctl handler `piControlIoctl()` and
//! the file operations in `src/piControlMain.c` (GPL-2.0, read, not copied),
//! `src/piConfig.c` (the `config.rsc` parser whose offset arithmetic
//! [`super::rsc`] reproduces) and the man pages under `doc/`.
//!
//! The request numbers and the structure sizes below are not typed from
//! memory: the vendor header was compiled with the real `_IO()` macro (gcc,
//! Linux uapi headers) and its `sizeof`/`offsetof` printed; the unit tests pin
//! exactly those values.
//!
//! # What is deliberately not here
//!
//! ADR-048 DEC-8.8 gives the agent six requests. The firmware, reset and
//! stop-I/O requests (`KB_RESET` 0x4B0C, `KB_UPDATE_DEVICE_FIRMWARE` 0x4B13,
//! `PICONTROL_UPLOAD_FIRMWARE` 0x40184BC8, `KB_STOP_IO` 0x4B16) have no
//! constant anywhere in this crate, and [`Request`] is a closed enum, so no
//! code path can issue them (piControl has no capability check on its
//! requests: anything that can open the device can reflash a module). Only
//! the root OS tool calls them. `tests/invariants/picontrol_backend.rs` fails
//! when one of those numbers appears in the sources.
//!
//! # Request numbers
//!
//! Every piControl request is `_IO('K', n)`: direction none and size zero, so
//! the number is `('K' << 8) | n` on every architecture whose `_IOC_NONE` is 0
//! (x86, ARM, AArch64, RISC-V; not MIPS, PowerPC, SPARC or Alpha, which a
//! compile error below excludes). The argument is a pointer to a structure the
//! request's man page defines, not part of the number.

use std::fmt;

/// The one device node the agent opens (`PICONTROL_DEVICE`; the unit's
/// `DeviceAllow` line, contract `unit-directives.json` `board_dropins`).
pub const DEVICE_PATH: &str = "/dev/piControl0";
/// Length of the process image in bytes (`PICONTROL_PROCESS_IMAGE_LEN`).
pub const PROCESS_IMAGE_LEN: usize = 4096;
/// Most devices the driver lists (`PICONTROL_MAX_DEVICES`).
pub const MAX_DEVICES: usize = 64;
/// Size of the variable-name field of `SPIVariable` (`strVarName[32]`).
pub const NAME_FIELD_LEN: usize = 32;
/// Longest variable name the driver can hold: it stores 31 characters and a
/// NUL (`strncpy(..., sizeof(strVarName) - 1)` in `piConfig.c`,
/// `strncpy_from_user(..., sizeof(strVarName) - 1)` in `find_variable()`).
pub const MAX_NAME_LEN: usize = NAME_FIELD_LEN - 1;
/// The event `KB_WAIT_FOR_EVENT` reports when the driver was reset
/// (`KB_EVENT_RESET`).
pub const EVENT_RESET: i32 = 1;
/// `i16uModuleType` bit that marks a module configured but not connected
/// (`PICONTROL_NOT_CONNECTED`).
pub const NOT_CONNECTED: u16 = 0x8000;

#[cfg(all(
    target_os = "linux",
    not(any(
        target_arch = "x86_64",
        target_arch = "x86",
        target_arch = "aarch64",
        target_arch = "arm",
        target_arch = "riscv64"
    ))
))]
compile_error!(
    "the piControl request numbers assume _IOC_NONE == 0 (asm-generic ioctl.h); \
     this architecture needs its own numbers"
);

/// The six requests ADR-048 DEC-8.8 allows the agent. A closed enum: there is
/// no way to name another request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Request {
    /// `KB_GET_DEVICE_INFO_LIST`: list the modules (argument: `SDeviceInfo[64]`).
    GetDeviceInfoList,
    /// `KB_GET_VALUE`: read one bit or byte of the process image (`SPIValue`).
    GetValue,
    /// `KB_SET_VALUE`: write one bit or byte; the bit write is a
    /// read-modify-write inside the driver's lock (`SPIValue`).
    SetValue,
    /// `KB_FIND_VARIABLE`: resolve a variable name from the configuration the
    /// driver loaded (`SPIVariable`).
    FindVariable,
    /// `KB_SET_OUTPUT_WATCHDOG`: arm (or, with 0, disarm) the per-descriptor
    /// output watchdog (`unsigned int *`, milliseconds).
    SetOutputWatchdog,
    /// `KB_WAIT_FOR_EVENT`: block until the driver emits an event (`int *`).
    WaitForEvent,
}

impl Request {
    /// The `ioctl(2)` request number.
    pub const fn number(self) -> u32 {
        match self {
            Self::GetDeviceInfoList => io(13),
            Self::GetValue => io(15),
            Self::SetValue => io(16),
            Self::FindVariable => io(17),
            Self::SetOutputWatchdog => io(26),
            Self::WaitForEvent => io(50),
        }
    }

    /// The vendor name, for logs and errors.
    pub const fn name(self) -> &'static str {
        match self {
            Self::GetDeviceInfoList => "KB_GET_DEVICE_INFO_LIST",
            Self::GetValue => "KB_GET_VALUE",
            Self::SetValue => "KB_SET_VALUE",
            Self::FindVariable => "KB_FIND_VARIABLE",
            Self::SetOutputWatchdog => "KB_SET_OUTPUT_WATCHDOG",
            Self::WaitForEvent => "KB_WAIT_FOR_EVENT",
        }
    }

    /// Bytes the kernel reads or writes through the request's argument
    /// pointer. A device implementation hands the kernel a buffer of at least
    /// this size.
    pub const fn arg_len(self) -> usize {
        match self {
            Self::GetDeviceInfoList => MAX_DEVICES * DeviceInfo::WIRE_LEN,
            Self::GetValue | Self::SetValue => ValueArg::WIRE_LEN,
            Self::FindVariable => VariableArg::WIRE_LEN,
            Self::SetOutputWatchdog | Self::WaitForEvent => 4,
        }
    }

    /// Every request, for tests that must cover them all.
    #[cfg(test)]
    pub const ALL: [Request; 6] = [
        Self::GetDeviceInfoList,
        Self::GetValue,
        Self::SetValue,
        Self::FindVariable,
        Self::SetOutputWatchdog,
        Self::WaitForEvent,
    ];
}

/// `_IO('K', nr)` for `_IOC_NONE == 0`.
const fn io(nr: u8) -> u32 {
    ((b'K' as u32) << 8) | nr as u32
}

/// A buffer the kernel structure does not fit, or a field that does not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AbiError {
    /// The buffer is shorter than the structure.
    Short { need: usize, got: usize },
    /// A variable name the driver cannot hold or could not tell apart.
    BadName { reason: &'static str },
    /// A request that returns a count answered with a negative one.
    BadCount { count: i32 },
}

impl fmt::Display for AbiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Short { need, got } => {
                write!(f, "piControl structure needs {need} bytes, got {got}")
            }
            Self::BadName { reason } => write!(f, "piControl variable name: {reason}"),
            Self::BadCount { count } => write!(f, "piControl answered with a count of {count}"),
        }
    }
}

impl std::error::Error for AbiError {}

/// The structure needs `need` bytes; say so, not which field ran out first.
fn check_len(buf: &[u8], need: usize) -> Result<(), AbiError> {
    if buf.len() < need {
        return Err(AbiError::Short {
            need,
            got: buf.len(),
        });
    }
    Ok(())
}

fn field<const N: usize>(buf: &[u8], at: usize) -> Result<[u8; N], AbiError> {
    buf.get(at..at + N)
        .and_then(|s| <[u8; N]>::try_from(s).ok())
        .ok_or(AbiError::Short {
            need: at + N,
            got: buf.len(),
        })
}

fn u16_at(buf: &[u8], at: usize) -> Result<u16, AbiError> {
    field::<2>(buf, at).map(u16::from_ne_bytes)
}

fn u32_at(buf: &[u8], at: usize) -> Result<u32, AbiError> {
    field::<4>(buf, at).map(u32::from_ne_bytes)
}

fn put(buf: &mut [u8], at: usize, bytes: &[u8]) {
    if let Some(dst) = buf.get_mut(at..at + bytes.len()) {
        dst.copy_from_slice(bytes);
    }
}

/// `SDeviceInfo`: one module of the process image, as `KB_GET_DEVICE_INFO_LIST`
/// reports it (72 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DeviceInfo {
    /// Address of the module on the PiBridge.
    pub address: u8,
    /// Serial number.
    pub serial: u32,
    /// Module type; a configured but absent module carries [`NOT_CONNECTED`].
    pub module_type: u16,
    pub hw_revision: u16,
    pub sw_major: u16,
    pub sw_minor: u16,
    pub svn_revision: u32,
    /// Bytes of all inputs together.
    pub input_length: u16,
    /// Bytes of all outputs together.
    pub output_length: u16,
    pub config_length: u16,
    /// Offset of the module in the process image.
    pub base_offset: u16,
    pub input_offset: u16,
    pub output_offset: u16,
    pub config_offset: u16,
    pub first_entry: u16,
    pub entries: u16,
    pub module_state: u8,
    /// `i8uActive`: 0 means the module is not present and no data is available.
    pub active: bool,
    pub features: u16,
}

impl DeviceInfo {
    /// `sizeof(SDeviceInfo)`.
    pub const WIRE_LEN: usize = 72;

    /// Decode the native-endian structure the kernel filled.
    pub fn decode(buf: &[u8]) -> Result<Self, AbiError> {
        check_len(buf, Self::WIRE_LEN)?;
        let [address] = field::<1>(buf, 0)?;
        let [module_state] = field::<1>(buf, 38)?;
        let [active] = field::<1>(buf, 39)?;
        Ok(Self {
            address,
            serial: u32_at(buf, 4)?,
            module_type: u16_at(buf, 8)?,
            hw_revision: u16_at(buf, 10)?,
            sw_major: u16_at(buf, 12)?,
            sw_minor: u16_at(buf, 14)?,
            svn_revision: u32_at(buf, 16)?,
            input_length: u16_at(buf, 20)?,
            output_length: u16_at(buf, 22)?,
            config_length: u16_at(buf, 24)?,
            base_offset: u16_at(buf, 26)?,
            input_offset: u16_at(buf, 28)?,
            output_offset: u16_at(buf, 30)?,
            config_offset: u16_at(buf, 32)?,
            first_entry: u16_at(buf, 34)?,
            entries: u16_at(buf, 36)?,
            module_state,
            active: active != 0,
            features: u16_at(buf, 40)?,
        })
    }

    /// The native-endian structure, for a device that plays the kernel.
    #[cfg(test)]
    pub fn encode(&self) -> [u8; Self::WIRE_LEN] {
        let mut b = [0u8; Self::WIRE_LEN];
        put(&mut b, 0, &[self.address]);
        put(&mut b, 4, &self.serial.to_ne_bytes());
        put(&mut b, 8, &self.module_type.to_ne_bytes());
        put(&mut b, 10, &self.hw_revision.to_ne_bytes());
        put(&mut b, 12, &self.sw_major.to_ne_bytes());
        put(&mut b, 14, &self.sw_minor.to_ne_bytes());
        put(&mut b, 16, &self.svn_revision.to_ne_bytes());
        put(&mut b, 20, &self.input_length.to_ne_bytes());
        put(&mut b, 22, &self.output_length.to_ne_bytes());
        put(&mut b, 24, &self.config_length.to_ne_bytes());
        put(&mut b, 26, &self.base_offset.to_ne_bytes());
        put(&mut b, 28, &self.input_offset.to_ne_bytes());
        put(&mut b, 30, &self.output_offset.to_ne_bytes());
        put(&mut b, 32, &self.config_offset.to_ne_bytes());
        put(&mut b, 34, &self.first_entry.to_ne_bytes());
        put(&mut b, 36, &self.entries.to_ne_bytes());
        put(&mut b, 38, &[self.module_state]);
        put(&mut b, 39, &[u8::from(self.active)]);
        put(&mut b, 40, &self.features.to_ne_bytes());
        b
    }

    /// The module type with the not-connected bit removed
    /// (`PICONTROL_NOT_CONNECTED_MASK`).
    pub const fn product_type(&self) -> u16 {
        self.module_type & !NOT_CONNECTED
    }
}

/// `SPIValue` (4 bytes): the argument of `KB_GET_VALUE` and `KB_SET_VALUE`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ValueArg {
    /// Byte address in the process image.
    pub address: u16,
    /// 0-7 selects one bit; 8 or more selects the whole byte.
    pub bit: u8,
    /// The value read, or to write (0 or 1 for a bit).
    pub value: u8,
}

impl ValueArg {
    /// `sizeof(SPIValue)`.
    pub const WIRE_LEN: usize = 4;
    /// `i8uBit` value that selects the whole byte.
    pub const WHOLE_BYTE: u8 = 8;

    /// The native-endian structure.
    pub fn encode(&self) -> [u8; Self::WIRE_LEN] {
        let mut b = [0u8; Self::WIRE_LEN];
        put(&mut b, 0, &self.address.to_ne_bytes());
        put(&mut b, 2, &[self.bit, self.value]);
        b
    }

    /// Decode the structure.
    pub fn decode(buf: &[u8]) -> Result<Self, AbiError> {
        check_len(buf, Self::WIRE_LEN)?;
        let [bit] = field::<1>(buf, 2)?;
        let [value] = field::<1>(buf, 3)?;
        Ok(Self {
            address: u16_at(buf, 0)?,
            bit,
            value,
        })
    }
}

/// A variable name in the form the driver compares: 1 to 31 printable ASCII
/// bytes. The driver truncates longer names to 31 bytes on both sides of the
/// comparison, so a longer name would silently match another variable's prefix;
/// it is refused instead.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct VariableName(String);

impl VariableName {
    /// Validate a name from a configuration or from `config.rsc`.
    pub fn new(name: &str) -> Result<Self, AbiError> {
        if name.is_empty() {
            return Err(AbiError::BadName { reason: "empty" });
        }
        if name.len() > MAX_NAME_LEN {
            return Err(AbiError::BadName {
                reason: "longer than the 31 bytes the driver stores",
            });
        }
        if !name.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
            return Err(AbiError::BadName {
                reason: "only printable ASCII without spaces is accepted",
            });
        }
        Ok(Self(name.to_owned()))
    }

    /// The name.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for VariableName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// `SPIVariable` (38 bytes): the argument of `KB_FIND_VARIABLE`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariableArg {
    /// The name to look up (request) or looked up (answer).
    pub name: VariableName,
    /// Byte address in the process image; `0xFFFF` when not found.
    pub address: u16,
    /// Bit position 0-7; `0xFF` when not found.
    pub bit: u8,
    /// Length in bits (1, 8, 16, 32); `0xFFFF` when not found.
    pub length: u16,
}

/// What `KB_FIND_VARIABLE` fills in when the name does not exist.
pub const VARIABLE_NOT_FOUND_ADDRESS: u16 = 0xFFFF;

impl VariableArg {
    /// `sizeof(SPIVariable)`: 32 + 2 + 1 + 1 (padding) + 2.
    pub const WIRE_LEN: usize = 38;

    /// A lookup request for `name`; the answer fields are the driver's
    /// "not found" defaults.
    pub fn lookup(name: VariableName) -> Self {
        Self {
            name,
            address: VARIABLE_NOT_FOUND_ADDRESS,
            bit: 0xFF,
            length: 0xFFFF,
        }
    }

    /// The native-endian structure.
    pub fn encode(&self) -> [u8; Self::WIRE_LEN] {
        let mut b = [0u8; Self::WIRE_LEN];
        put(&mut b, 0, self.name.as_str().as_bytes());
        put(&mut b, 32, &self.address.to_ne_bytes());
        put(&mut b, 34, &[self.bit]);
        put(&mut b, 36, &self.length.to_ne_bytes());
        b
    }

    /// Decode the structure the kernel filled.
    pub fn decode(buf: &[u8]) -> Result<Self, AbiError> {
        check_len(buf, Self::WIRE_LEN)?;
        let raw: [u8; NAME_FIELD_LEN] = field(buf, 0)?;
        let end = raw.iter().position(|b| *b == 0).unwrap_or(NAME_FIELD_LEN);
        let name = raw
            .get(..end)
            .and_then(|s| std::str::from_utf8(s).ok())
            .ok_or(AbiError::BadName {
                reason: "not UTF-8",
            })
            .and_then(VariableName::new)?;
        let [bit] = field::<1>(buf, 34)?;
        Ok(Self {
            name,
            address: u16_at(buf, 32)?,
            bit,
            length: u16_at(buf, 36)?,
        })
    }
}

/// How a driver error number reads, for the errors the manual pages define.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Errno {
    /// `EAGAIN`: a driver reset is in progress.
    ResetInProgress,
    /// `ENOENT`: variable not found, or the driver is not initialised.
    NotFound,
    /// `EINVAL`: an address outside the process image.
    Invalid,
    /// `ENODEV`, `ENXIO`: the device node exists but no driver answers.
    NoDevice,
    /// `EACCES`, `EPERM`: the process may not open the device.
    Permission,
    /// `EINTR`: the call was interrupted.
    Interrupted,
    /// Anything else.
    Other(i32),
}

impl Errno {
    /// Classify a raw `errno`.
    pub fn classify(raw: i32) -> Self {
        match raw {
            libc::EAGAIN => Self::ResetInProgress,
            libc::ENOENT => Self::NotFound,
            libc::EINVAL => Self::Invalid,
            libc::ENODEV | libc::ENXIO => Self::NoDevice,
            libc::EACCES | libc::EPERM => Self::Permission,
            libc::EINTR => Self::Interrupted,
            other => Self::Other(other),
        }
    }
}

/// Module types the agent names (`KUNBUS_FW_DESCR_TYP_*` in the vendor
/// `common_define.h`).
pub mod module_type {
    pub const PI_CORE: u16 = 95;
    pub const PI_DIO_14: u16 = 96;
    pub const PI_DI_16: u16 = 97;
    pub const PI_DO_16: u16 = 98;
    pub const PI_AIO: u16 = 103;
    pub const PI_COMPACT: u16 = 104;
    pub const PI_CONNECT: u16 = 105;
    pub const PI_MIO: u16 = 118;
    pub const PI_FLAT: u16 = 135;
    pub const PI_CONNECT_4: u16 = 136;
    pub const PI_RO: u16 = 137;
    pub const PI_CONNECT_5: u16 = 138;

    /// The RevPi base modules: the device the process image starts with
    /// (`piCore_g`: status, LEDs, on-board outputs, and on the Connect and
    /// Connect SE the board watchdog trigger bit). The agent never writes
    /// them (see [`super::super::registry`]).
    pub const fn is_base_module(product_type: u16) -> bool {
        matches!(
            product_type,
            PI_CORE | PI_COMPACT | PI_CONNECT | PI_FLAT | PI_CONNECT_4 | PI_CONNECT_5
        )
    }

    /// An expansion module whose outputs the agent may be allowed to drive.
    pub const fn is_io_expansion(product_type: u16) -> bool {
        matches!(
            product_type,
            PI_DIO_14 | PI_DI_16 | PI_DO_16 | PI_AIO | PI_MIO | PI_RO
        )
    }

    /// A readable name for logs and the hardware scan.
    pub const fn name(product_type: u16) -> &'static str {
        match product_type {
            PI_CORE => "RevPi Core",
            PI_DIO_14 => "RevPi DIO",
            PI_DI_16 => "RevPi DI",
            PI_DO_16 => "RevPi DO",
            PI_AIO => "RevPi AIO",
            PI_COMPACT => "RevPi Compact",
            PI_CONNECT => "RevPi Connect",
            PI_MIO => "RevPi MIO",
            PI_FLAT => "RevPi Flat",
            PI_CONNECT_4 => "RevPi Connect 4",
            PI_RO => "RevPi RO",
            PI_CONNECT_5 => "RevPi Connect 5",
            _ => "unknown module",
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

    use super::*;

    /// Values printed by compiling the vendor `piControl.h` (v2.8.2) with gcc
    /// against the Linux uapi headers and its real `_IO()` macro.
    #[test]
    fn request_numbers_are_the_vendor_header_numbers() {
        assert_eq!(Request::GetDeviceInfoList.number(), 0x4B0D);
        assert_eq!(Request::GetValue.number(), 0x4B0F);
        assert_eq!(Request::SetValue.number(), 0x4B10);
        assert_eq!(Request::FindVariable.number(), 0x4B11);
        assert_eq!(Request::SetOutputWatchdog.number(), 0x4B1A);
        assert_eq!(Request::WaitForEvent.number(), 0x4B32);
    }

    #[test]
    fn the_request_set_is_exactly_the_six_of_dec_8_8() {
        let names: Vec<&str> = Request::ALL.iter().map(|r| r.name()).collect();
        assert_eq!(
            names,
            [
                "KB_GET_DEVICE_INFO_LIST",
                "KB_GET_VALUE",
                "KB_SET_VALUE",
                "KB_FIND_VARIABLE",
                "KB_SET_OUTPUT_WATCHDOG",
                "KB_WAIT_FOR_EVENT"
            ]
        );
        // The four requests that reflash, reset or stop the I/O are not
        // members: their vendor numbers collide with none of ours.
        for forbidden in [0x4B0Cu32, 0x4B13, 0x4B16, 0x4018_4BC8] {
            assert!(Request::ALL.iter().all(|r| r.number() != forbidden));
        }
    }

    #[test]
    fn structure_sizes_are_the_vendor_sizeofs() {
        assert_eq!(DeviceInfo::WIRE_LEN, 72);
        assert_eq!(ValueArg::WIRE_LEN, 4);
        assert_eq!(VariableArg::WIRE_LEN, 38);
        assert_eq!(Request::GetDeviceInfoList.arg_len(), 64 * 72);
    }

    #[test]
    fn device_info_fields_sit_at_the_vendor_offsets() {
        let info = DeviceInfo {
            address: 32,
            serial: 0x0102_0304,
            module_type: 96,
            hw_revision: 3,
            sw_major: 1,
            sw_minor: 7,
            svn_revision: 99,
            input_length: 6,
            output_length: 4,
            config_length: 2,
            base_offset: 100,
            input_offset: 100,
            output_offset: 106,
            config_offset: 110,
            first_entry: 5,
            entries: 28,
            module_state: 1,
            active: true,
            features: 0x11,
        };
        let raw = info.encode();
        // offsetof() values printed by the vendor header's compile.
        assert_eq!(raw[0], 32);
        assert_eq!(
            u32::from_ne_bytes(raw[4..8].try_into().unwrap()),
            0x0102_0304
        );
        assert_eq!(u16::from_ne_bytes(raw[8..10].try_into().unwrap()), 96);
        assert_eq!(u16::from_ne_bytes(raw[20..22].try_into().unwrap()), 6);
        assert_eq!(u16::from_ne_bytes(raw[30..32].try_into().unwrap()), 106);
        assert_eq!(u16::from_ne_bytes(raw[36..38].try_into().unwrap()), 28);
        assert_eq!(raw[38], 1);
        assert_eq!(raw[39], 1);
        assert_eq!(u16::from_ne_bytes(raw[40..42].try_into().unwrap()), 0x11);
        assert_eq!(DeviceInfo::decode(&raw).unwrap(), info);
    }

    #[test]
    fn value_and_variable_arguments_sit_at_the_vendor_offsets() {
        let v = ValueArg {
            address: 0x0123,
            bit: 5,
            value: 1,
        };
        let raw = v.encode();
        assert_eq!(u16::from_ne_bytes(raw[0..2].try_into().unwrap()), 0x0123);
        assert_eq!((raw[2], raw[3]), (5, 1));
        assert_eq!(ValueArg::decode(&raw).unwrap(), v);

        let name = VariableName::new("O_1").unwrap();
        let mut var = VariableArg::lookup(name.clone());
        var.address = 0x0201;
        var.bit = 3;
        var.length = 1;
        let raw = var.encode();
        assert_eq!(&raw[..3], b"O_1");
        assert_eq!(raw[3], 0);
        assert_eq!(u16::from_ne_bytes(raw[32..34].try_into().unwrap()), 0x0201);
        assert_eq!(raw[34], 3);
        assert_eq!(raw[35], 0, "the padding byte stays zero");
        assert_eq!(u16::from_ne_bytes(raw[36..38].try_into().unwrap()), 1);
        assert_eq!(VariableArg::decode(&raw).unwrap(), var);
    }

    #[test]
    fn a_lookup_starts_from_the_drivers_not_found_defaults() {
        let var = VariableArg::lookup(VariableName::new("X").unwrap());
        assert_eq!(var.address, 0xFFFF);
        assert_eq!(var.bit, 0xFF);
        assert_eq!(var.length, 0xFFFF);
    }

    #[test]
    fn variable_names_the_driver_cannot_tell_apart_are_refused() {
        assert!(VariableName::new("").is_err());
        assert!(VariableName::new(&"a".repeat(31)).is_ok());
        assert!(
            VariableName::new(&"a".repeat(32)).is_err(),
            "a 32-byte name would be truncated to 31 and match a prefix"
        );
        assert!(VariableName::new("has space").is_err());
        assert!(VariableName::new("nul\0byte").is_err());
        assert!(VariableName::new("ünicode").is_err());
        assert!(VariableName::new("Core_Temperature").is_ok());
    }

    #[test]
    fn short_buffers_are_an_error_not_a_panic() {
        assert_eq!(
            DeviceInfo::decode(&[0u8; 10]),
            Err(AbiError::Short { need: 72, got: 10 })
        );
        assert!(ValueArg::decode(&[0u8; 3]).is_err());
        assert!(VariableArg::decode(&[0u8; 37]).is_err());
    }

    #[test]
    fn errno_classes_follow_the_manual_pages() {
        assert_eq!(Errno::classify(libc::EAGAIN), Errno::ResetInProgress);
        assert_eq!(Errno::classify(libc::ENOENT), Errno::NotFound);
        assert_eq!(Errno::classify(libc::EINVAL), Errno::Invalid);
        assert_eq!(Errno::classify(libc::ENODEV), Errno::NoDevice);
        assert_eq!(Errno::classify(libc::EACCES), Errno::Permission);
        assert_eq!(Errno::classify(libc::EINTR), Errno::Interrupted);
        assert_eq!(Errno::classify(libc::EIO), Errno::Other(libc::EIO));
    }

    #[test]
    fn the_base_modules_are_not_io_expansions() {
        for t in [
            module_type::PI_CORE,
            module_type::PI_CONNECT,
            module_type::PI_CONNECT_4,
            module_type::PI_CONNECT_5,
            module_type::PI_COMPACT,
            module_type::PI_FLAT,
        ] {
            assert!(module_type::is_base_module(t), "{t}");
            assert!(!module_type::is_io_expansion(t), "{t}");
        }
        for t in [
            module_type::PI_DIO_14,
            module_type::PI_DI_16,
            module_type::PI_DO_16,
            module_type::PI_AIO,
            module_type::PI_MIO,
            module_type::PI_RO,
        ] {
            assert!(module_type::is_io_expansion(t), "{t}");
            assert!(!module_type::is_base_module(t), "{t}");
        }
    }

    #[test]
    fn a_not_connected_module_keeps_its_product_type() {
        let info = DeviceInfo {
            module_type: NOT_CONNECTED | module_type::PI_DIO_14,
            ..DeviceInfo::default()
        };
        assert_eq!(info.product_type(), module_type::PI_DIO_14);
    }
}
