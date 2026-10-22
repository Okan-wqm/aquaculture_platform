//! A fake piControl kernel for the unit tests.
//!
//! [`FakeKernel`] plays `/dev/piControl0` at the level the real thing is
//! used: [`super::device::RawDevice`], the raw bytes of the ioctl arguments
//! and the process image. It is written from the driver's source
//! (`piControlMain.c`, piControl v2.8.2), not from this crate's codec, so a
//! structure laid out wrongly in [`super::abi`] fails against it:
//!
//! * every request but `KB_RESET` answers `EAGAIN` while the driver is not
//!   running (`isRunning()`), and so do `read` and `write`;
//! * `read`/`write` past the end of the image return 0, and a transfer that
//!   crosses the end is cut short;
//! * `KB_SET_VALUE` of a bit is a read-modify-write of one byte; a bit of 8 or
//!   more writes the whole byte; an address of 4096 or more is `EINVAL`;
//! * `KB_FIND_VARIABLE` copies at most 31 bytes of the name, fills
//!   `0xFFFF`/`0xFF`/`0xFFFF` and answers `ENOENT` for an unknown name;
//! * the output watchdog belongs to the descriptor: a write, a bit or byte
//!   set and a re-arm restart its period; when it expires every active
//!   module's output range is zeroed and the period restarts; closing an armed
//!   descriptor zeroes the outputs too (`piControlRelease()`);
//! * a driver reset (`KB_RESET` by another process) queues one `KB_EVENT_RESET`
//!   on every descriptor, and `KB_WAIT_FOR_EVENT` blocks until one is queued.
//!
//! Time is explicit ([`FakeKernel::advance_ms`]): the real driver checks the
//! watchdog from its I/O thread every cycle.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

use std::collections::{BTreeMap, VecDeque};
use std::io;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};

use super::abi::{
    DeviceInfo, EVENT_RESET, MAX_NAME_LEN, PROCESS_IMAGE_LEN, Request, ValueArg, VariableArg,
    module_type,
};
use super::device::RawDevice;
use super::rsc::{ProcessMap, sample};

struct Var {
    name: String,
    address: u16,
    bit: u8,
    length: u16,
    /// The `config.rsc` default (`PiBridgeMaster_setDefaults`).
    default: u32,
}

struct Fd {
    watchdog_ms: u32,
    deadline_ms: u64,
    events: VecDeque<i32>,
}

struct Inner {
    image: Vec<u8>,
    devices: Vec<DeviceInfo>,
    vars: Vec<Var>,
    now_ms: u64,
    fds: BTreeMap<u32, Fd>,
    next_fd: u32,
    resetting: bool,
    /// `(offset, length)` of every process-image write, in order.
    writes: Vec<(usize, usize)>,
    write_error: Option<i32>,
    waiter_error: Option<i32>,
}

/// A fake `/dev/piControl0`.
pub struct FakeKernel {
    inner: Mutex<Inner>,
    events: Condvar,
}

fn device(
    address: u8,
    module_type: u16,
    base: u16,
    inputs: (u16, u16),
    outputs: (u16, u16),
) -> DeviceInfo {
    DeviceInfo {
        address,
        module_type,
        base_offset: base,
        input_offset: inputs.0,
        input_length: inputs.1,
        output_offset: outputs.0,
        output_length: outputs.1,
        active: true,
        entries: 1,
        ..DeviceInfo::default()
    }
}

impl FakeKernel {
    /// The synthetic Connect 4 + DIO + AIO configuration of
    /// [`super::rsc::sample`].
    pub fn sample() -> Arc<Self> {
        let map = ProcessMap::parse(sample::rsc().as_bytes()).expect("sample rsc");
        Self::from_map(
            &map,
            vec![
                device(0, module_type::PI_CONNECT_4, 0, (0, 2), (6, 3)),
                device(32, module_type::PI_DIO_14, 100, (100, 2), (120, 4)),
                device(33, module_type::PI_AIO, 200, (200, 4), (210, 4)),
            ],
        )
    }

    /// A kernel whose variable table is the one `map` declares.
    pub fn from_map(map: &ProcessMap, devices: Vec<DeviceInfo>) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                image: vec![0u8; PROCESS_IMAGE_LEN],
                devices,
                vars: vars_of(map),
                now_ms: 0,
                fds: BTreeMap::new(),
                next_fd: 3,
                resetting: false,
                writes: Vec::new(),
                write_error: None,
                waiter_error: None,
            }),
            events: Condvar::new(),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Open a descriptor.
    pub fn open(self: &Arc<Self>) -> Arc<dyn RawDevice> {
        let mut g = self.lock();
        let id = g.next_fd;
        g.next_fd += 1;
        g.fds.insert(
            id,
            Fd {
                watchdog_ms: 0,
                deadline_ms: 0,
                events: VecDeque::new(),
            },
        );
        Arc::new(FakeFd {
            kernel: self.clone(),
            id,
        })
    }

    /// The device list of a configuration: every module present and active,
    /// outputs 20 bytes into the module.
    pub fn devices_for(map: &ProcessMap) -> Vec<DeviceInfo> {
        map.devices()
            .iter()
            .map(|d| DeviceInfo {
                address: d.position,
                module_type: d.product_type,
                base_offset: d.base_offset,
                output_offset: d.base_offset + 20,
                output_length: 4,
                active: true,
                ..DeviceInfo::default()
            })
            .collect()
    }

    /// Replace the device list without any event (a module list that changed
    /// under a reader that missed the reset).
    pub fn set_devices(&self, devices: Vec<DeviceInfo>) {
        self.lock().devices = devices;
    }

    /// Modules in the device list.
    pub fn device_count(&self) -> usize {
        self.lock().devices.len()
    }

    /// Set one image byte as a module would.
    pub fn poke(&self, address: usize, value: u8) {
        if let Some(b) = self.lock().image.get_mut(address) {
            *b = value;
        }
    }

    /// One image byte.
    pub fn peek(&self, address: usize) -> u8 {
        self.lock().image.get(address).copied().unwrap_or(0)
    }

    /// Mark a module present or absent (`i8uActive`).
    pub fn set_module_active(&self, position: u8, active: bool) {
        for d in &mut self.lock().devices {
            if d.address == position {
                d.active = active;
            }
        }
    }

    /// The driver stops running (a reset in progress, or the PiBridge down):
    /// every request, read and write answers `EAGAIN`.
    pub fn begin_reset(&self) {
        self.lock().resetting = true;
    }

    /// The driver runs again.
    pub fn end_reset(&self) {
        self.lock().resetting = false;
    }

    /// Another process reset the driver: the PiBridge started again with the
    /// variable table of `map` (the process image holds the defaults), and
    /// every descriptor got a `KB_EVENT_RESET`.
    pub fn reset_driver_with(&self, map: &ProcessMap) {
        let mut g = self.lock();
        g.vars = vars_of(map);
        restore_defaults(&mut g);
        for fd in g.fds.values_mut() {
            if !fd.events.contains(&EVENT_RESET) {
                fd.events.push_back(EVENT_RESET);
            }
        }
        g.resetting = false;
        drop(g);
        self.events.notify_all();
    }

    /// A reset that loads the same configuration again.
    pub fn reset_driver(&self) {
        let mut g = self.lock();
        restore_defaults(&mut g);
        for fd in g.fds.values_mut() {
            if !fd.events.contains(&EVENT_RESET) {
                fd.events.push_back(EVENT_RESET);
            }
        }
        g.resetting = false;
        drop(g);
        self.events.notify_all();
    }

    /// Make every waiting and future `KB_WAIT_FOR_EVENT` fail with `errno`.
    pub fn fail_waiters(&self, errno: i32) {
        self.lock().waiter_error = Some(errno);
        self.events.notify_all();
    }

    /// Make every process-image write fail with `errno`.
    pub fn fail_writes(&self, errno: i32) {
        self.lock().write_error = Some(errno);
    }

    /// Advance the clock: the I/O thread's watchdog check
    /// (`revpi_check_timeout`) runs for the elapsed time. One expiry zeroes
    /// the outputs and restarts the period of the descriptor that expired;
    /// like the driver, it handles one descriptor per pass.
    pub fn advance_ms(&self, ms: u64) {
        let mut g = self.lock();
        g.now_ms += ms;
        let now = g.now_ms;
        let expired = g
            .fds
            .iter()
            .find(|(_, fd)| fd.watchdog_ms != 0 && now > fd.deadline_ms)
            .map(|(id, _)| *id);
        if let Some(id) = expired {
            zero_outputs(&mut g);
            if let Some(fd) = g.fds.get_mut(&id) {
                fd.deadline_ms = now + u64::from(fd.watchdog_ms);
            }
        }
    }

    /// `(offset, length)` of every process-image write so far.
    pub fn written_ranges(&self) -> Vec<(usize, usize)> {
        self.lock().writes.clone()
    }

    /// Forget the recorded writes.
    pub fn clear_written_ranges(&self) {
        self.lock().writes.clear();
    }

    /// Armed watchdog of the descriptors, in milliseconds (0 = disarmed).
    pub fn armed_watchdogs(&self) -> Vec<u32> {
        self.lock().fds.values().map(|f| f.watchdog_ms).collect()
    }
}

fn vars_of(map: &ProcessMap) -> Vec<Var> {
    map.variables()
        .map(|v| Var {
            name: v.name.to_string(),
            address: v.address,
            bit: v.bit,
            length: v.bit_length,
            default: v.default,
        })
        .collect()
}

/// `PiBridgeMaster_setDefaults()` and the `memcpy` of the default image over the
/// process image that the PiBridge start performs: every byte not named by a
/// default is 0, every variable holds its `config.rsc` default.
fn restore_defaults(g: &mut Inner) {
    let mut image = vec![0u8; PROCESS_IMAGE_LEN];
    for v in &g.vars {
        let at = usize::from(v.address);
        if v.length == 1 {
            if v.default & 1 != 0 {
                if let Some(b) = image.get_mut(at) {
                    *b |= 1 << v.bit;
                }
            }
        } else {
            let bytes = usize::from(v.length / 8);
            let le = v.default.to_le_bytes();
            if let Some(dst) = image.get_mut(at..at + bytes) {
                dst.copy_from_slice(le.get(..bytes).expect("bytes"));
            }
        }
    }
    g.image = image;
}

fn zero_outputs(g: &mut Inner) {
    let ranges: Vec<(usize, usize)> = g
        .devices
        .iter()
        .filter(|d| d.active)
        .map(|d| (usize::from(d.output_offset), usize::from(d.output_length)))
        .collect();
    for (offset, len) in ranges {
        let end = (offset + len).min(PROCESS_IMAGE_LEN);
        if let Some(range) = g.image.get_mut(offset..end) {
            range.fill(0);
        }
    }
}

fn feed(g: &mut Inner, id: u32) {
    let now = g.now_ms;
    if let Some(fd) = g.fds.get_mut(&id) {
        if fd.watchdog_ms != 0 {
            fd.deadline_ms = now + u64::from(fd.watchdog_ms);
        }
    }
}

fn eagain<T>() -> io::Result<T> {
    Err(io::Error::from_raw_os_error(libc::EAGAIN))
}

struct FakeFd {
    kernel: Arc<FakeKernel>,
    id: u32,
}

impl Drop for FakeFd {
    fn drop(&mut self) {
        let mut g = self.kernel.lock();
        if let Some(fd) = g.fds.remove(&self.id) {
            if fd.watchdog_ms != 0 {
                zero_outputs(&mut g);
            }
        }
    }
}

impl RawDevice for FakeFd {
    fn ioctl(&self, request: Request, arg: &mut [u8]) -> io::Result<i32> {
        assert!(
            arg.len() >= request.arg_len(),
            "{} needs {} bytes of argument",
            request.name(),
            request.arg_len()
        );
        if request == Request::WaitForEvent {
            return self.wait_for_event(arg);
        }
        let mut g = self.kernel.lock();
        if g.resetting {
            return eagain();
        }
        match request {
            Request::GetDeviceInfoList => {
                let count = g.devices.len();
                for (i, d) in g.devices.iter().enumerate() {
                    let at = i * DeviceInfo::WIRE_LEN;
                    if let Some(dst) = arg.get_mut(at..at + DeviceInfo::WIRE_LEN) {
                        dst.copy_from_slice(&d.encode());
                    }
                }
                Ok(i32::try_from(count).unwrap_or(i32::MAX))
            }
            Request::GetValue => {
                let mut v = ValueArg::decode(arg).expect("decode");
                let Some(byte) = g.image.get(usize::from(v.address)).copied() else {
                    return Err(io::Error::from_raw_os_error(libc::EINVAL));
                };
                v.value = if v.bit >= 8 {
                    byte
                } else {
                    u8::from(byte & (1 << v.bit) != 0)
                };
                arg.get_mut(..ValueArg::WIRE_LEN)
                    .expect("len")
                    .copy_from_slice(&v.encode());
                Ok(0)
            }
            Request::SetValue => {
                let v = ValueArg::decode(arg).expect("decode");
                let at = usize::from(v.address);
                let Some(byte) = g.image.get(at).copied() else {
                    return Err(io::Error::from_raw_os_error(libc::EINVAL));
                };
                let new = if v.bit >= 8 {
                    v.value
                } else if v.value != 0 {
                    byte | (1 << v.bit)
                } else {
                    byte & !(1 << v.bit)
                };
                if let Some(slot) = g.image.get_mut(at) {
                    *slot = new;
                }
                g.writes.push((at, 1));
                feed(&mut g, self.id);
                Ok(0)
            }
            Request::FindVariable => {
                // strncpy_from_user(.., sizeof(strVarName) - 1): at most 31
                // bytes, up to the first NUL.
                let raw = arg.get(..MAX_NAME_LEN).expect("len");
                let end = raw.iter().position(|b| *b == 0).unwrap_or(MAX_NAME_LEN);
                let wanted = String::from_utf8_lossy(raw.get(..end).expect("len")).into_owned();
                let found = g.vars.iter().find(|v| v.name == wanted);
                let mut answer = VariableArg::decode(arg).expect("decode");
                answer.address = 0xFFFF;
                answer.bit = 0xFF;
                answer.length = 0xFFFF;
                let result = match found {
                    Some(v) => {
                        answer.address = v.address;
                        answer.bit = v.bit;
                        answer.length = v.length;
                        Ok(0)
                    }
                    None => Err(io::Error::from_raw_os_error(libc::ENOENT)),
                };
                arg.get_mut(..VariableArg::WIRE_LEN)
                    .expect("len")
                    .copy_from_slice(&answer.encode());
                result
            }
            Request::SetOutputWatchdog => {
                let ms = u32::from_ne_bytes(arg.get(..4).expect("len").try_into().expect("4"));
                let now = g.now_ms;
                if let Some(fd) = g.fds.get_mut(&self.id) {
                    fd.watchdog_ms = ms;
                    fd.deadline_ms = now + u64::from(ms);
                }
                Ok(0)
            }
            Request::WaitForEvent => unreachable!("handled above"),
        }
    }

    fn read_at(&self, offset: usize, buf: &mut [u8]) -> io::Result<usize> {
        let g = self.kernel.lock();
        if g.resetting {
            return eagain();
        }
        if offset >= PROCESS_IMAGE_LEN {
            return Ok(0);
        }
        let n = buf.len().min(PROCESS_IMAGE_LEN - offset);
        let src = g.image.get(offset..offset + n).expect("range");
        buf.get_mut(..n).expect("range").copy_from_slice(src);
        Ok(n)
    }

    fn write_at(&self, offset: usize, data: &[u8]) -> io::Result<usize> {
        let mut g = self.kernel.lock();
        if g.resetting {
            return eagain();
        }
        if let Some(errno) = g.write_error {
            return Err(io::Error::from_raw_os_error(errno));
        }
        if offset >= PROCESS_IMAGE_LEN {
            return Ok(0);
        }
        let n = data.len().min(PROCESS_IMAGE_LEN - offset);
        g.image
            .get_mut(offset..offset + n)
            .expect("range")
            .copy_from_slice(data.get(..n).expect("range"));
        g.writes.push((offset, n));
        feed(&mut g, self.id);
        Ok(n)
    }
}

impl FakeFd {
    fn wait_for_event(&self, arg: &mut [u8]) -> io::Result<i32> {
        let mut g = self.kernel.lock();
        loop {
            if let Some(errno) = g.waiter_error {
                return Err(io::Error::from_raw_os_error(errno));
            }
            if let Some(event) = g.fds.get_mut(&self.id).and_then(|fd| fd.events.pop_front()) {
                arg.get_mut(..4)
                    .expect("len")
                    .copy_from_slice(&event.to_ne_bytes());
                return Ok(0);
            }
            g = self
                .kernel
                .events
                .wait(g)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }
}
