//! The device layer: the raw descriptor behind a trait, and the typed
//! operations on top of it.
//!
//! [`RawDevice`] is the narrow waist (ADR-048 DEC-8.8): three operations that
//! cross into the kernel — one of the six allow-listed requests, a read of the
//! process image at an offset, a write at an offset. The real implementation,
//! [`LibcDevice`], is a thin wrapper over `open(2)`, `ioctl(2)`, `lseek(2)`,
//! `read(2)` and `write(2)`; everything that carries meaning (structure
//! layout, request arguments, error classes) is in [`PiControl`] and
//! [`super::abi`], which the unit tests drive through a fake kernel that
//! reads the raw bytes the way `piControlIoctl()` does.

use std::fmt;
use std::io;
use std::sync::Arc;

use super::abi::{
    AbiError, DeviceInfo, Errno, PROCESS_IMAGE_LEN, Request, VARIABLE_NOT_FOUND_ADDRESS, ValueArg,
    VariableArg, VariableName,
};

/// What crosses into the kernel. A fake implements this to play the driver.
pub trait RawDevice: Send + Sync + 'static {
    /// One allow-listed request. `arg` is the memory the request's pointer
    /// argument points at, at least [`Request::arg_len`] bytes; the request's
    /// result (the driver's non-negative return value) comes back.
    fn ioctl(&self, request: Request, arg: &mut [u8]) -> io::Result<i32>;
    /// Read the process image at `offset` (lseek + read). Returns the bytes
    /// read; 0 at the end of the image.
    fn read_at(&self, offset: usize, buf: &mut [u8]) -> io::Result<usize>;
    /// Write the process image at `offset` (lseek + write). Returns the bytes
    /// written.
    fn write_at(&self, offset: usize, data: &[u8]) -> io::Result<usize>;
}

/// How a device is opened. The backend opens a second descriptor for its
/// event thread, so it keeps the opener.
pub type Opener = Arc<dyn Fn() -> anyhow::Result<Arc<dyn RawDevice>> + Send + Sync>;

/// Why an operation on the device failed.
#[derive(Debug)]
pub struct DeviceError {
    /// The operation (`KB_FIND_VARIABLE`, `read`, ...).
    pub op: &'static str,
    /// What went wrong.
    pub kind: DeviceErrorKind,
}

#[derive(Debug)]
pub enum DeviceErrorKind {
    /// The kernel answered with an error.
    Errno(Errno, io::Error),
    /// A transfer moved fewer bytes than asked.
    Short { wanted: usize, got: usize },
    /// The kernel's answer did not decode.
    Abi(AbiError),
}

impl DeviceError {
    fn errno(op: &'static str, e: io::Error) -> Self {
        Self {
            op,
            kind: DeviceErrorKind::Errno(errno_of(&e), e),
        }
    }

    fn short(op: &'static str, wanted: usize, got: usize) -> Self {
        Self {
            op,
            kind: DeviceErrorKind::Short { wanted, got },
        }
    }

    fn abi(op: &'static str, e: AbiError) -> Self {
        Self {
            op,
            kind: DeviceErrorKind::Abi(e),
        }
    }

    /// The driver is resetting (`EAGAIN`): the layout is changing.
    pub fn is_reset_in_progress(&self) -> bool {
        matches!(
            &self.kind,
            DeviceErrorKind::Errno(Errno::ResetInProgress, _)
        )
    }

    /// The call was interrupted by a signal.
    pub fn is_interrupted(&self) -> bool {
        matches!(&self.kind, DeviceErrorKind::Errno(Errno::Interrupted, _))
    }
}

impl fmt::Display for DeviceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.kind {
            DeviceErrorKind::Errno(class, e) => write!(f, "{} failed ({class:?}): {e}", self.op),
            DeviceErrorKind::Short { wanted, got } => {
                write!(f, "{} moved {got} of {wanted} bytes", self.op)
            }
            DeviceErrorKind::Abi(e) => write!(f, "{}: {e}", self.op),
        }
    }
}

impl std::error::Error for DeviceError {}

fn errno_of(e: &io::Error) -> Errno {
    match e.raw_os_error() {
        Some(raw) => Errno::classify(raw),
        None => match e.kind() {
            io::ErrorKind::NotFound => Errno::NotFound,
            io::ErrorKind::PermissionDenied => Errno::Permission,
            io::ErrorKind::WouldBlock => Errno::ResetInProgress,
            io::ErrorKind::Interrupted => Errno::Interrupted,
            io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData => Errno::Invalid,
            _ => Errno::Other(-1),
        },
    }
}

/// Where the driver says a variable lives (`KB_FIND_VARIABLE`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Located {
    pub address: u16,
    pub bit: u8,
    pub length: u16,
}

/// The typed operations on one descriptor.
pub struct PiControl {
    dev: Arc<dyn RawDevice>,
}

impl PiControl {
    /// Wrap a descriptor.
    pub fn new(dev: Arc<dyn RawDevice>) -> Self {
        Self { dev }
    }

    fn request(&self, request: Request, arg: &mut [u8]) -> Result<i32, DeviceError> {
        self.dev
            .ioctl(request, arg)
            .map_err(|e| DeviceError::errno(request.name(), e))
    }

    /// `KB_GET_DEVICE_INFO_LIST`: the modules of the loaded configuration.
    pub fn devices(&self) -> Result<Vec<DeviceInfo>, DeviceError> {
        let op = Request::GetDeviceInfoList.name();
        let mut arg = vec![0u8; Request::GetDeviceInfoList.arg_len()];
        let count = self.request(Request::GetDeviceInfoList, &mut arg)?;
        let count = usize::try_from(count)
            .map_err(|_| DeviceError::abi(op, AbiError::BadCount { count }))?;
        let mut devices = Vec::with_capacity(count);
        for chunk in arg.chunks(DeviceInfo::WIRE_LEN).take(count) {
            devices.push(DeviceInfo::decode(chunk).map_err(|e| DeviceError::abi(op, e))?);
        }
        if devices.len() != count {
            return Err(DeviceError::short(op, count, devices.len()));
        }
        Ok(devices)
    }

    /// `KB_FIND_VARIABLE`: where the driver's loaded configuration puts
    /// `name`. `None` when it has no such variable (or no configuration).
    pub fn find_variable(&self, name: &VariableName) -> Result<Option<Located>, DeviceError> {
        let op = Request::FindVariable.name();
        let mut arg = VariableArg::lookup(name.clone()).encode();
        match self.request(Request::FindVariable, &mut arg) {
            Ok(_) => {}
            Err(DeviceError {
                kind: DeviceErrorKind::Errno(Errno::NotFound, _),
                ..
            }) => return Ok(None),
            Err(e) => return Err(e),
        }
        let found = VariableArg::decode(&arg).map_err(|e| DeviceError::abi(op, e))?;
        if found.address == VARIABLE_NOT_FOUND_ADDRESS {
            return Ok(None);
        }
        Ok(Some(Located {
            address: found.address,
            bit: found.bit,
            length: found.length,
        }))
    }

    /// `KB_GET_VALUE`: one bit (`bit` 0-7) or the whole byte at `address`.
    pub fn get_value(&self, address: u16, bit: u8) -> Result<u8, DeviceError> {
        let mut arg = ValueArg {
            address,
            bit,
            value: 0,
        }
        .encode();
        self.request(Request::GetValue, &mut arg)?;
        ValueArg::decode(&arg)
            .map(|v| v.value)
            .map_err(|e| DeviceError::abi(Request::GetValue.name(), e))
    }

    /// `KB_SET_VALUE` of one bit: the driver reads, changes and writes the
    /// byte inside its lock, so no other writer's bits of the byte are lost.
    pub fn set_bit(&self, address: u16, bit: u8, on: bool) -> Result<(), DeviceError> {
        let mut arg = ValueArg {
            address,
            bit: bit & 7,
            value: u8::from(on),
        }
        .encode();
        self.request(Request::SetValue, &mut arg).map(|_| ())
    }

    /// `KB_SET_VALUE` of one whole byte.
    pub fn set_byte(&self, address: u16, value: u8) -> Result<(), DeviceError> {
        let mut arg = ValueArg {
            address,
            bit: ValueArg::WHOLE_BYTE,
            value,
        }
        .encode();
        self.request(Request::SetValue, &mut arg).map(|_| ())
    }

    /// `KB_SET_OUTPUT_WATCHDOG`: all outputs are zeroed when this descriptor
    /// is not written for `ms`; 0 disarms. Re-issuing it with the same value
    /// restarts the period without touching the process image.
    pub fn set_output_watchdog(&self, ms: u32) -> Result<(), DeviceError> {
        let mut arg = ms.to_ne_bytes();
        self.request(Request::SetOutputWatchdog, &mut arg)
            .map(|_| ())
    }

    /// `KB_WAIT_FOR_EVENT`: blocks until the driver reports an event.
    pub fn wait_for_event(&self) -> Result<i32, DeviceError> {
        let mut arg = [0u8; 4];
        self.request(Request::WaitForEvent, &mut arg)?;
        Ok(i32::from_ne_bytes(arg))
    }

    /// The whole process image in one read: a consistent snapshot, because
    /// the driver copies it under its image lock.
    pub fn read_image(&self) -> Result<Vec<u8>, DeviceError> {
        let mut image = vec![0u8; PROCESS_IMAGE_LEN];
        let got = self
            .dev
            .read_at(0, &mut image)
            .map_err(|e| DeviceError::errno("read", e))?;
        if got != PROCESS_IMAGE_LEN {
            return Err(DeviceError::short("read", PROCESS_IMAGE_LEN, got));
        }
        Ok(image)
    }

    /// Write `data` at `address`. The driver copies the bytes into the image
    /// under its lock, so a 16- or 32-bit value lands whole.
    pub fn write_bytes(&self, address: u16, data: &[u8]) -> Result<(), DeviceError> {
        let got = self
            .dev
            .write_at(usize::from(address), data)
            .map_err(|e| DeviceError::errno("write", e))?;
        if got != data.len() {
            return Err(DeviceError::short("write", data.len(), got));
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
pub use libc_device::LibcDevice;

/// The real descriptor.
#[cfg(target_os = "linux")]
mod libc_device {
    use std::fs::{File, OpenOptions};
    use std::io::{self, Read, Seek, SeekFrom, Write};
    use std::os::fd::AsRawFd;
    use std::path::Path;
    use std::sync::{Mutex, PoisonError};

    use super::{RawDevice, Request};

    /// `/dev/piControl0` opened read-write. `lseek` followed by `read` or
    /// `write` is one critical section, so two threads never interleave a
    /// seek and a transfer (the driver keeps the position per descriptor).
    pub struct LibcDevice {
        file: File,
        transfer: Mutex<()>,
    }

    impl LibcDevice {
        /// Open the device for the backend (`O_RDWR`; std sets
        /// `O_CLOEXEC`). Only builds with the `revpi-io` driver open it for
        /// writing.
        #[cfg(feature = "revpi-io")]
        pub fn open(path: &Path) -> io::Result<Self> {
            Self::open_with(path, true)
        }

        /// Open the device for a read-only look (the hardware scan): the
        /// device list and the process image, no write.
        pub fn open_read_only(path: &Path) -> io::Result<Self> {
            Self::open_with(path, false)
        }

        pub(super) fn open_with(path: &Path, write: bool) -> io::Result<Self> {
            let file = OpenOptions::new().read(true).write(write).open(path)?;
            Ok(Self {
                file,
                transfer: Mutex::new(()),
            })
        }
    }

    impl RawDevice for LibcDevice {
        fn ioctl(&self, request: Request, arg: &mut [u8]) -> io::Result<i32> {
            if arg.len() < request.arg_len() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "argument buffer shorter than the request's structure",
                ));
            }
            // SAFETY: `fd` is the open descriptor `self.file` owns for the
            // duration of the call; `arg` is a live, exclusively borrowed
            // buffer of at least `request.arg_len()` bytes, which is exactly
            // what piControlIoctl() copies from and to user space for this
            // request (piControl v2.8.2, `piControl.h` and the man page of
            // the request). The request is one of the six allow-listed
            // numbers of `Request`.
            let rc = unsafe {
                libc::ioctl(
                    self.file.as_raw_fd(),
                    request.number() as _,
                    arg.as_mut_ptr(),
                )
            };
            if rc < 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(rc)
            }
        }

        fn read_at(&self, offset: usize, buf: &mut [u8]) -> io::Result<usize> {
            let _one = self.transfer.lock().unwrap_or_else(PoisonError::into_inner);
            let mut file = &self.file;
            file.seek(SeekFrom::Start(offset as u64))?;
            file.read(buf)
        }

        fn write_at(&self, offset: usize, data: &[u8]) -> io::Result<usize> {
            let _one = self.transfer.lock().unwrap_or_else(PoisonError::into_inner);
            let mut file = &self.file;
            file.seek(SeekFrom::Start(offset as u64))?;
            file.write(data)
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

    use super::super::fake::FakeKernel;
    use super::*;

    fn name(n: &str) -> VariableName {
        VariableName::new(n).unwrap()
    }

    fn pi() -> (Arc<FakeKernel>, PiControl) {
        let kernel = FakeKernel::sample();
        let pi = PiControl::new(kernel.open());
        (kernel, pi)
    }

    #[test]
    fn the_device_list_decodes_every_module_the_driver_returns() {
        let (kernel, pi) = pi();
        let devices = pi.devices().unwrap();
        assert_eq!(devices.len(), kernel.device_count());
        assert_eq!(devices[1].address, 32);
        assert!(devices[1].active);
    }

    #[test]
    fn find_variable_returns_the_drivers_address_bit_and_length() {
        let (_, pi) = pi();
        let o2 = pi.find_variable(&name("O_2")).unwrap().unwrap();
        assert_eq!(
            o2,
            Located {
                address: 122,
                bit: 1,
                length: 1
            }
        );
    }

    #[test]
    fn find_variable_of_an_unknown_name_is_none_not_an_error() {
        let (_, pi) = pi();
        assert_eq!(pi.find_variable(&name("NoSuchVariable")).unwrap(), None);
    }

    #[test]
    fn get_value_reads_a_bit_or_a_byte() {
        let (kernel, pi) = pi();
        kernel.poke(122, 0b0000_0110);
        assert_eq!(pi.get_value(122, 1).unwrap(), 1);
        assert_eq!(pi.get_value(122, 0).unwrap(), 0);
        assert_eq!(pi.get_value(122, ValueArg::WHOLE_BYTE).unwrap(), 0b0110);
    }

    #[test]
    fn set_bit_changes_only_that_bit() {
        let (kernel, pi) = pi();
        kernel.poke(122, 0b1010_0000);
        pi.set_bit(122, 1, true).unwrap();
        assert_eq!(kernel.peek(122), 0b1010_0010);
        pi.set_bit(122, 7, false).unwrap();
        assert_eq!(kernel.peek(122), 0b0010_0010);
    }

    #[test]
    fn set_byte_replaces_the_byte() {
        let (kernel, pi) = pi();
        kernel.poke(123, 0xAA);
        pi.set_byte(123, 0x55).unwrap();
        assert_eq!(kernel.peek(123), 0x55);
    }

    #[test]
    fn an_address_outside_the_image_is_einval() {
        let (_, pi) = pi();
        let e = pi.get_value(4096, 0).unwrap_err();
        assert!(matches!(e.kind, DeviceErrorKind::Errno(Errno::Invalid, _)));
    }

    #[test]
    fn the_image_is_read_whole_and_written_at_an_offset() {
        let (kernel, pi) = pi();
        pi.write_bytes(210, &[0x34, 0x12]).unwrap();
        assert_eq!(kernel.peek(210), 0x34);
        assert_eq!(kernel.peek(211), 0x12);
        let image = pi.read_image().unwrap();
        assert_eq!(image.len(), PROCESS_IMAGE_LEN);
        assert_eq!(&image[210..212], &[0x34, 0x12]);
    }

    #[test]
    fn a_write_past_the_image_end_is_a_short_transfer() {
        let (_, pi) = pi();
        let e = pi.write_bytes(4095, &[1, 2]).unwrap_err();
        assert!(matches!(
            e.kind,
            DeviceErrorKind::Short { wanted: 2, got: 1 }
        ));
    }

    #[test]
    fn a_driver_reset_in_progress_reads_as_eagain_on_every_path() {
        let (kernel, pi) = pi();
        kernel.begin_reset();
        assert!(pi.read_image().unwrap_err().is_reset_in_progress());
        assert!(
            pi.write_bytes(210, &[1])
                .unwrap_err()
                .is_reset_in_progress()
        );
        assert!(pi.set_bit(122, 0, true).unwrap_err().is_reset_in_progress());
        assert!(
            pi.find_variable(&name("O_1"))
                .unwrap_err()
                .is_reset_in_progress()
        );
        assert!(
            pi.devices().unwrap_err().is_reset_in_progress(),
            "isRunning() gates every request but KB_RESET"
        );
    }

    #[test]
    fn the_output_watchdog_zeroes_the_outputs_when_the_descriptor_stops_writing() {
        let (kernel, pi) = pi();
        pi.write_bytes(120, &[0xFF, 0xFF]).unwrap();
        pi.set_output_watchdog(100).unwrap();
        kernel.advance_ms(99);
        assert_eq!(kernel.peek(120), 0xFF);
        kernel.advance_ms(2);
        assert_eq!(
            kernel.peek(120),
            0,
            "past the period the outputs are zeroed"
        );
    }

    #[test]
    fn re_arming_the_watchdog_restarts_its_period_without_a_write() {
        let (kernel, pi) = pi();
        pi.write_bytes(120, &[0xFF]).unwrap();
        pi.set_output_watchdog(100).unwrap();
        kernel.advance_ms(80);
        pi.set_output_watchdog(100).unwrap();
        kernel.advance_ms(80);
        assert_eq!(kernel.peek(120), 0xFF);
        assert_eq!(
            kernel.written_ranges().len(),
            1,
            "feeding wrote no image byte"
        );
    }

    #[test]
    fn closing_a_descriptor_with_the_watchdog_armed_zeroes_the_outputs() {
        let kernel = FakeKernel::sample();
        let fd = kernel.open();
        let pi = PiControl::new(fd);
        pi.write_bytes(120, &[0xFF]).unwrap();
        pi.set_output_watchdog(500).unwrap();
        drop(pi);
        assert_eq!(
            kernel.peek(120),
            0,
            "release() zeroes the outputs of an armed descriptor"
        );
    }

    #[test]
    fn a_disarmed_descriptor_leaves_the_outputs_alone_on_close() {
        let kernel = FakeKernel::sample();
        let pi = PiControl::new(kernel.open());
        pi.write_bytes(120, &[0xFF]).unwrap();
        pi.set_output_watchdog(500).unwrap();
        pi.set_output_watchdog(0).unwrap();
        drop(pi);
        assert_eq!(kernel.peek(120), 0xFF);
    }

    #[test]
    fn a_waiting_descriptor_receives_the_reset_event() {
        let kernel = FakeKernel::sample();
        let waiter = PiControl::new(kernel.open());
        let handle = std::thread::spawn(move || waiter.wait_for_event());
        kernel.reset_driver();
        assert_eq!(
            handle.join().unwrap().unwrap(),
            super::super::abi::EVENT_RESET
        );
    }

    /// The real descriptor against a regular file: `read_at`/`write_at` are
    /// plain lseek+read/write, an ioctl on a file is `ENOTTY`.
    #[cfg(target_os = "linux")]
    mod real_descriptor {
        use super::*;

        fn file_with_image() -> (tempfile::TempDir, LibcDevice) {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("piControl0");
            std::fs::write(&path, vec![0u8; PROCESS_IMAGE_LEN]).unwrap();
            let dev = LibcDevice::open_with(&path, true).unwrap();
            (dir, dev)
        }

        #[test]
        fn a_read_only_descriptor_cannot_write() {
            let (dir, _) = file_with_image();
            let dev = LibcDevice::open_read_only(&dir.path().join("piControl0")).unwrap();
            assert!(dev.write_at(0, &[1]).is_err());
            let mut buf = [9u8; 2];
            assert_eq!(dev.read_at(0, &mut buf).unwrap(), 2);
        }

        #[test]
        fn read_and_write_are_positional() {
            let (_dir, dev) = file_with_image();
            assert_eq!(dev.write_at(210, &[7, 8, 9]).unwrap(), 3);
            let mut buf = [0u8; 4];
            assert_eq!(dev.read_at(209, &mut buf).unwrap(), 4);
            assert_eq!(buf, [0, 7, 8, 9]);
            let pi = PiControl::new(Arc::new(dev));
            assert_eq!(pi.read_image().unwrap()[211], 8);
        }

        #[test]
        fn an_ioctl_on_something_that_is_not_the_driver_is_enotty() {
            let (_dir, dev) = file_with_image();
            let mut arg = [0u8; 4];
            let e = dev.ioctl(Request::SetOutputWatchdog, &mut arg).unwrap_err();
            assert_eq!(e.raw_os_error(), Some(libc::ENOTTY));
        }

        #[test]
        fn a_buffer_shorter_than_the_request_structure_never_reaches_the_kernel() {
            let (_dir, dev) = file_with_image();
            let mut short = [0u8; 3];
            let e = dev.ioctl(Request::GetValue, &mut short).unwrap_err();
            assert_eq!(e.kind(), io::ErrorKind::InvalidInput);
        }

        #[test]
        fn a_missing_device_node_is_not_found() {
            let e = LibcDevice::open_read_only(std::path::Path::new("/nonexistent/piControl0"))
                .map(|_| ())
                .unwrap_err();
            assert_eq!(e.kind(), io::ErrorKind::NotFound);
        }
    }
}
