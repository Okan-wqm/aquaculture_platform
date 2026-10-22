//! The synchronous core of the piControl backend: one descriptor, one
//! registry, and the rules that keep a write on the output it was meant for.
//!
//! * **Reads** take one snapshot of the whole process image per cycle (the
//!   driver copies it under its image lock), decode every point from it and
//!   report a module that is absent or inactive as a communication failure,
//!   never as its stale bytes.
//! * **Writes** go to registry outputs only. Before every write the driver is
//!   asked where it keeps the variable (`KB_FIND_VARIABLE`) and the answer
//!   must equal the signed file's; a bit is set with `KB_SET_VALUE` (the
//!   driver's read-modify-write under its lock, so the other bits of the byte
//!   — another output's, the status byte's — are never rewritten from a stale
//!   copy), a wider value is written as exactly its own bytes, and the value
//!   is read back.
//! * **The layout can change under the agent**: root loads a new `config.rsc`
//!   into the driver when a site config update changes it. The driver then
//!   queues `KB_EVENT_RESET` on every other descriptor; a thread owned by the
//!   backend waits on a second descriptor for it. A reset, or a device list
//!   that no longer matches the file, marks the layout *stale*: writes and
//!   safe-state drives are refused and reads report a communication failure
//!   until the file is proven against the driver again (re-verified by the
//!   event thread, by the poll, or by [`Backend::reload`] with a new site).
//! * **The output watchdog** (`KB_SET_OUTPUT_WATCHDOG`) is armed by the first
//!   feed and re-issued by every feed, which restarts its period without
//!   touching the image. It is the control loop's liveness for the outputs:
//!   a loop that stops feeding has every PiBridge output zeroed within the
//!   period, independent of systemd's 60 s watchdog (ADR-048 DEC-6.7). It is
//!   armed when the control loop starts, not when the device is opened,
//!   because the boot between those two moments takes seconds and a period
//!   shorter than it would zero the outputs of a booting agent.
//! * **Closing**: the driver zeroes all outputs when a descriptor with an
//!   armed watchdog closes. [`Backend::release`] therefore disarms the
//!   watchdog only after every safe value is in place, so a graceful restart
//!   leaves the safe values (a life-support output stays on) while a crash —
//!   where nothing can disarm — zeroes the outputs, the documented fail-safe
//!   of the piControl layer.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{Duration, Instant};

use tracing::{error, info, warn};

use super::abi::{DEVICE_PATH, DeviceInfo, EVENT_RESET, NOT_CONNECTED};
use super::config::{Direction, PiControlConfig};
use super::device::{DeviceError, Opener, PiControl};
use super::registry::{Point, Registry, RegistryError, ValueError};
use super::rsc::{MAX_RSC_BYTES, ProcessMap, RscError, Width};

/// Where the signed `config.rsc` comes from.
#[derive(Debug, Clone)]
pub enum RscSource {
    /// Suderra OS: the bytes the site config statement's digest covers,
    /// verified once when the site was accepted.
    Verified(Arc<[u8]>),
    /// Generic profile: the file the driver loaded, read again on every
    /// (re)verification.
    File(PathBuf),
}

impl RscSource {
    /// The bytes, bounded by [`MAX_RSC_BYTES`].
    pub fn load(&self) -> std::io::Result<Arc<[u8]>> {
        match self {
            Self::Verified(bytes) => Ok(bytes.clone()),
            Self::File(path) => {
                let mut bytes = Vec::new();
                std::fs::File::open(path)?
                    .take(MAX_RSC_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)?;
                Ok(bytes.into())
            }
        }
    }
}

/// How long the poll waits between attempts to prove a stale layout again.
const REVERIFY_INTERVAL: Duration = Duration::from_secs(5);

/// A value read from a point.
#[derive(Debug, Clone, PartialEq)]
pub struct Reading {
    pub tag: String,
    /// The raw bits; 0 when the quality is not good.
    pub raw: u32,
    /// The raw bits as a number (signed types sign-extended), before the
    /// tag's scaling.
    pub value: f64,
    /// `false`: the module is absent or inactive, or the layout is stale.
    pub good: bool,
}

/// A point whose raw value differs from the previous poll.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PointChange {
    pub tag: String,
    pub variable: String,
    pub direction: Direction,
    pub old: u32,
    pub new: u32,
    /// An output that no write of this agent produced: the watchdog zeroing
    /// it, a driver reset restoring a default, a module, or another process.
    pub external: bool,
}

/// One poll.
#[derive(Debug, Default, PartialEq)]
pub struct PollOutcome {
    pub readings: Vec<Reading>,
    pub changes: Vec<PointChange>,
}

/// Why a write or a safe-state drive did not happen.
#[derive(Debug)]
pub enum WriteError {
    /// Control is disabled: the agent is in degraded mode.
    Disabled(String),
    /// The tag holds a forced value an operator applied.
    Forced(String),
    /// The layout is not proven against the driver (a reset, or a reload that
    /// failed): nothing is written until it is.
    Stale(String),
    /// The tag is not a registry output.
    NotAnOutput(String),
    /// The value does not fit the variable.
    Value(ValueError),
    /// The driver reports it is resetting.
    Resetting,
    /// The driver no longer puts the variable where the signed file does.
    LayoutMoved(String),
    /// The image does not hold what was written.
    NotRetained {
        wanted: u32,
        got: u32,
    },
    Device(DeviceError),
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disabled(why) => f.write_str(why),
            Self::Forced(tag) => write!(
                f,
                "{tag:?} holds a forced value; unforce it before another writer drives it"
            ),
            Self::Stale(why) => write!(f, "the process-image layout is not verified: {why}"),
            Self::NotAnOutput(tag) => {
                write!(f, "{tag:?} is not an output the picontrol section grants")
            }
            Self::Value(e) => write!(f, "{e}"),
            Self::Resetting => f.write_str("the piControl driver is resetting"),
            Self::LayoutMoved(v) => write!(
                f,
                "the driver no longer places {v:?} where the signed config.rsc does"
            ),
            Self::NotRetained { wanted, got } => write!(
                f,
                "wrote raw {wanted} but the process image holds {got} (another writer?)"
            ),
            Self::Device(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for WriteError {}

impl From<DeviceError> for WriteError {
    fn from(e: DeviceError) -> Self {
        if e.is_reset_in_progress() {
            Self::Resetting
        } else {
            Self::Device(e)
        }
    }
}

/// What a write left in the image.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Written {
    pub raw: u32,
    /// The raw bits as a number, before the tag's scaling.
    pub value: f64,
}

struct Inner {
    config: PiControlConfig,
    source: RscSource,
    io_interval_ms: u64,
    registry: Arc<Registry>,
    stale: Option<String>,
    next_reverify: Instant,
    armed: bool,
    last: BTreeMap<String, u32>,
    commanded: BTreeMap<String, u32>,
    #[cfg(test)]
    generation: u64,
}

struct Shared {
    pi: PiControl,
    inner: Mutex<Inner>,
}

/// The backend. Cloning shares it.
#[derive(Clone)]
pub struct Backend {
    shared: Arc<Shared>,
}

fn lock(inner: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(PoisonError::into_inner)
}

fn prove(
    pi: &PiControl,
    config: &PiControlConfig,
    source: &RscSource,
) -> anyhow::Result<Arc<Registry>> {
    use anyhow::Context as _;
    let bytes = source
        .load()
        .context("config.rsc could not be read")
        .map_err(|e| e.context(source_label(source)))?;
    let map = ProcessMap::parse(&bytes).map_err(|e: RscError| anyhow::Error::new(e))?;
    let registry =
        Registry::build(config, &map).map_err(|e: RegistryError| anyhow::Error::new(e))?;
    registry.verify(pi).map_err(anyhow::Error::new)?;
    Ok(Arc::new(registry))
}

fn source_label(source: &RscSource) -> String {
    match source {
        RscSource::Verified(_) => "the verified site config.rsc".to_owned(),
        RscSource::File(p) => format!("config.rsc {}", p.display()),
    }
}

impl Backend {
    /// Open the device, build the registry from the signed `config.rsc` and
    /// prove it against the driver. Any failure is an error: a backend that
    /// cannot prove where its points live drives nothing.
    pub fn open(
        config: &PiControlConfig,
        io_interval_ms: u64,
        source: RscSource,
        opener: Opener,
    ) -> anyhow::Result<Self> {
        use anyhow::Context as _;
        let device = opener().with_context(|| format!("opening {DEVICE_PATH} failed"))?;
        let pi = PiControl::new(device);
        let registry = prove(&pi, config, &source)?;
        let shared = Arc::new(Shared {
            pi,
            inner: Mutex::new(Inner {
                config: config.clone(),
                source,
                io_interval_ms,
                registry,
                stale: None,
                next_reverify: Instant::now(),
                armed: false,
                last: BTreeMap::new(),
                commanded: BTreeMap::new(),
                #[cfg(test)]
                generation: 0,
            }),
        });
        let waiter = opener()
            .with_context(|| format!("opening the event descriptor of {DEVICE_PATH} failed"))?;
        spawn_event_thread(Arc::downgrade(&shared), PiControl::new(waiter))
            .context("starting the piControl event thread failed")?;
        Ok(Self { shared })
    }

    /// The registry the backend currently trusts.
    pub fn registry(&self) -> Arc<Registry> {
        lock(&self.shared.inner).registry.clone()
    }

    /// Why the layout is not proven, when it is not.
    pub fn stale_reason(&self) -> Option<String> {
        lock(&self.shared.inner).stale.clone()
    }

    /// How many times the layout was (re)proven or invalidated.
    #[cfg(test)]
    pub fn generation(&self) -> u64 {
        lock(&self.shared.inner).generation
    }

    /// One poll: a snapshot of the image decoded into the registry's points.
    pub fn poll(&self) -> PollOutcome {
        let mut inner = lock(&self.shared.inner);
        if inner.stale.is_some() && Instant::now() >= inner.next_reverify {
            self.shared.reverify(&mut inner);
        }
        let registry = inner.registry.clone();
        if inner.stale.is_some() {
            return Self::comm_failure(&registry);
        }

        let image = match self.shared.pi.read_image() {
            Ok(image) => image,
            Err(e) => {
                if !e.is_reset_in_progress() {
                    warn!("piControl process image could not be read: {e}");
                }
                return Self::comm_failure(&registry);
            }
        };
        let modules = match self.shared.pi.devices() {
            Ok(modules) => modules,
            Err(e) => {
                warn!("piControl device list could not be read: {e}");
                return Self::comm_failure(&registry);
            }
        };
        if let Some(why) = layout_moved(&registry, &modules) {
            self.shared.mark_stale(&mut inner, &why);
            return Self::comm_failure(&registry);
        }

        let mut outcome = PollOutcome::default();
        for point in registry.points() {
            let present = modules
                .iter()
                .find(|m| m.address == point.device)
                .is_some_and(|m| m.active && m.module_type & NOT_CONNECTED == 0);
            let raw = if present { point.decode(&image) } else { None };
            let Some(raw) = raw else {
                outcome.readings.push(Reading {
                    tag: point.tag.clone(),
                    raw: 0,
                    value: 0.0,
                    good: false,
                });
                continue;
            };
            outcome.readings.push(Reading {
                tag: point.tag.clone(),
                raw,
                value: point.raw_as_f64(raw),
                good: true,
            });
            if let Some(old) = inner.last.insert(point.tag.clone(), raw) {
                if old != raw {
                    let external =
                        point.is_output() && inner.commanded.get(&point.tag).copied() != Some(raw);
                    outcome.changes.push(PointChange {
                        tag: point.tag.clone(),
                        variable: point.variable.to_string(),
                        direction: point.direction,
                        old,
                        new: raw,
                        external,
                    });
                }
            }
        }
        outcome
    }

    fn comm_failure(registry: &Registry) -> PollOutcome {
        PollOutcome {
            readings: registry
                .points()
                .iter()
                .map(|p| Reading {
                    tag: p.tag.clone(),
                    raw: 0,
                    value: 0.0,
                    good: false,
                })
                .collect(),
            changes: Vec::new(),
        }
    }

    /// Write `value` (engineering units of the tag) to the output `tag`.
    pub fn write_output(&self, tag: &str, value: f64) -> Result<Written, WriteError> {
        let mut inner = lock(&self.shared.inner);
        let point = Self::output(&inner, tag)?;
        let raw = point.raw_from_value(value).map_err(WriteError::Value)?;
        self.shared.store(&mut inner, &point, raw)
    }

    /// Drive the output `tag` to its safe value.
    pub fn drive_safe(&self, tag: &str) -> Result<Written, WriteError> {
        let mut inner = lock(&self.shared.inner);
        let point = Self::output(&inner, tag)?;
        let raw = point.safe_raw;
        self.shared.store(&mut inner, &point, raw)
    }

    fn output(inner: &Inner, tag: &str) -> Result<Point, WriteError> {
        if let Some(why) = &inner.stale {
            return Err(WriteError::Stale(why.clone()));
        }
        inner
            .registry
            .point_for_tag(tag)
            .filter(|p| p.is_output())
            .cloned()
            .ok_or_else(|| WriteError::NotAnOutput(tag.to_owned()))
    }

    /// How often the control loop feeds the watchdog while it is alive: four
    /// times per period, so three feeds in a row can be late before the driver
    /// zeroes the outputs, and no more often than the driver can be asked
    /// usefully.
    pub fn feed_every(&self) -> Duration {
        let inner = lock(&self.shared.inner);
        let ms = u64::from(inner.config.watchdog_ms(inner.io_interval_ms)) / 4;
        Duration::from_millis(ms.clamp(50, 1_000))
    }

    /// The control loop is alive: arm the output watchdog on the first call
    /// and restart its period on every call. Only a grant with outputs has a
    /// watchdog to feed.
    pub fn feed(&self) -> Result<(), DeviceError> {
        let mut inner = lock(&self.shared.inner);
        if !inner.config.has_outputs() {
            return Ok(());
        }
        let ms = inner.config.watchdog_ms(inner.io_interval_ms);
        self.shared.pi.set_output_watchdog(ms)?;
        if !inner.armed {
            info!("piControl output watchdog armed ({ms} ms)");
            inner.armed = true;
        }
        Ok(())
    }

    /// Finish with the device: disarm the output watchdog when (and only
    /// when) every safe value is in place, because the driver zeroes the
    /// outputs of a descriptor that closes while armed. `safe_state_complete`
    /// is the safe-state report's verdict.
    pub fn release(&self, safe_state_complete: bool) {
        let mut inner = lock(&self.shared.inner);
        if !inner.armed {
            return;
        }
        if !safe_state_complete {
            warn!(
                "piControl output watchdog stays armed: the safe values are not all in place, \
                 so the driver zeroes the outputs when the descriptor closes"
            );
            return;
        }
        match self.shared.pi.set_output_watchdog(0) {
            Ok(()) => {
                inner.armed = false;
                info!("piControl output watchdog disarmed after the safe state");
            }
            Err(e) => error!(
                "piControl output watchdog could not be disarmed ({e}); the driver zeroes the \
                 outputs when the descriptor closes"
            ),
        }
    }

    /// Replace the grant and the signed file (a verified SIGHUP reload) and
    /// prove them against the driver. On failure the previous registry stays
    /// but the layout is marked stale: nothing is written until a proven one
    /// is installed.
    pub fn reload(
        &self,
        config: &PiControlConfig,
        io_interval_ms: u64,
        source: RscSource,
    ) -> anyhow::Result<()> {
        let mut inner = lock(&self.shared.inner);
        match prove(&self.shared.pi, config, &source) {
            Ok(registry) => {
                inner.config = config.clone();
                inner.io_interval_ms = io_interval_ms;
                inner.source = source;
                self.shared.install(&mut inner, registry);
                Ok(())
            }
            Err(e) => {
                self.shared
                    .mark_stale(&mut inner, &format!("reload not proven: {e:#}"));
                Err(e)
            }
        }
    }
}

impl Shared {
    fn mark_stale(&self, inner: &mut Inner, why: &str) {
        if inner.stale.is_none() {
            error!("piControl layout is no longer verified: {why}; writes are refused until it is");
        }
        inner.stale = Some(why.to_owned());
        inner.next_reverify = Instant::now() + REVERIFY_INTERVAL;
        #[cfg(test)]
        {
            inner.generation += 1;
        }
    }

    fn install(&self, inner: &mut Inner, registry: Arc<Registry>) {
        inner.registry = registry;
        inner.stale = None;
        inner.last.clear();
        // The driver restored its defaults at the reset: nothing this agent
        // commanded before it is still in force.
        inner.commanded.clear();
        #[cfg(test)]
        {
            inner.generation += 1;
        }
        info!("piControl layout verified against the driver");
    }

    /// Prove the current grant against the driver again.
    fn reverify(&self, inner: &mut Inner) {
        match prove(&self.pi, &inner.config, &inner.source) {
            Ok(registry) => self.install(inner, registry),
            Err(e) => {
                inner.next_reverify = Instant::now() + REVERIFY_INTERVAL;
                inner.stale = Some(format!("not proven after the reset: {e:#}"));
                warn!("piControl layout still not verified: {e:#}");
            }
        }
    }

    /// The driver was reset: the layout it loaded may be a different one.
    fn on_reset(&self) {
        let mut inner = lock(&self.inner);
        self.mark_stale(&mut inner, "the driver was reset (KB_EVENT_RESET)");
        self.reverify(&mut inner);
    }

    /// Write `raw` into the point's bytes after asking the driver where the
    /// variable is, and read it back.
    fn store(&self, inner: &mut Inner, point: &Point, raw: u32) -> Result<Written, WriteError> {
        // The driver must still put the variable where the signed file does.
        let located = self.pi.find_variable(&point.variable)?;
        let expected = (point.address, point.bit, point.width.bits());
        if located.map(|l| (l.address, l.bit, l.length)) != Some(expected) {
            self.mark_stale(inner, &format!("{} moved", point.variable));
            return Err(WriteError::LayoutMoved(point.variable.to_string()));
        }
        match point.width {
            Width::Bit => self.pi.set_bit(point.address, point.bit, raw != 0)?,
            Width::Byte => self.pi.set_byte(point.address, raw as u8)?,
            Width::Word | Width::DWord => {
                self.pi.write_bytes(point.address, &point.bytes_of(raw))?
            }
        }
        let got = self.read_back(point)?;
        if got != raw {
            return Err(WriteError::NotRetained { wanted: raw, got });
        }
        inner.commanded.insert(point.tag.clone(), raw);
        Ok(Written {
            raw,
            value: point.raw_as_f64(raw),
        })
    }

    fn read_back(&self, point: &Point) -> Result<u32, DeviceError> {
        match point.width {
            Width::Bit => self.pi.get_value(point.address, point.bit).map(u32::from),
            Width::Byte => self
                .pi
                .get_value(point.address, super::abi::ValueArg::WHOLE_BYTE)
                .map(u32::from),
            Width::Word | Width::DWord => {
                let mut raw = 0u32;
                for (shift, offset) in point.width.byte_offsets().iter().enumerate() {
                    let byte = self
                        .pi
                        .get_value(point.address + offset, super::abi::ValueArg::WHOLE_BYTE)?;
                    raw |= u32::from(byte) << (8 * shift);
                }
                Ok(raw)
            }
        }
    }
}

/// `Some(why)` when the driver's device list no longer matches the modules
/// the registry's points live on (a different base offset or type means the
/// image was laid out again).
fn layout_moved(registry: &Registry, modules: &[DeviceInfo]) -> Option<String> {
    for decl in registry.devices() {
        let Some(module) = modules.iter().find(|m| m.address == decl.position) else {
            // Absent modules are a per-point communication failure.
            continue;
        };
        if module.product_type() != decl.product_type || module.base_offset != decl.base_offset {
            return Some(format!(
                "the module at position {} is now type {} at offset {} (config.rsc: type {} at \
                 offset {})",
                decl.position,
                module.product_type(),
                module.base_offset,
                decl.product_type,
                decl.base_offset
            ));
        }
    }
    None
}

/// Wait for `KB_EVENT_RESET` on a descriptor of its own. The thread holds the
/// backend weakly and ends when it is gone or when the driver stops answering.
fn spawn_event_thread(shared: Weak<Shared>, waiter: PiControl) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name("picontrol-events".to_owned())
        .spawn(move || {
            loop {
                match waiter.wait_for_event() {
                    Ok(EVENT_RESET) => {
                        let Some(shared) = shared.upgrade() else {
                            return;
                        };
                        shared.on_reset();
                    }
                    Ok(other) => warn!("piControl reported event {other}, which the agent ignores"),
                    Err(e) if e.is_interrupted() => {}
                    Err(e) => {
                        if let Some(shared) = shared.upgrade() {
                            let mut inner = lock(&shared.inner);
                            shared.mark_stale(
                                &mut inner,
                                &format!("the event descriptor failed: {e}"),
                            );
                        }
                        return;
                    }
                }
                if shared.strong_count() == 0 {
                    return;
                }
            }
        })
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

    use super::super::fake::{Driver, FakeKernel};
    use super::super::rsc::sample;
    use super::*;

    const GRANT: &str = r#"
output_watchdog_ms: 1000
points:
  - tag: pump
    variable: O_1
    direction: output
  - tag: aerator
    variable: O_2
    direction: output
    safe_state_value: 1
  - tag: valve
    variable: OutputValue_1
    direction: output
    data_type: uint16
  - tag: in_1
    variable: I_1
  - tag: level
    variable: InputValue_1
  - tag: pb_status
    variable: RevPiStatus
"#;

    fn config() -> PiControlConfig {
        serde_yaml::from_str(GRANT).unwrap()
    }

    fn opener(kernel: &Arc<FakeKernel>) -> Opener {
        let kernel = kernel.clone();
        Arc::new(move || Ok(kernel.open()))
    }

    fn source() -> RscSource {
        RscSource::Verified(sample::rsc().into_bytes().into())
    }

    fn backend() -> (Arc<FakeKernel>, Backend) {
        let kernel = FakeKernel::sample();
        let backend = Backend::open(&config(), 250, source(), opener(&kernel)).unwrap();
        (kernel, backend)
    }

    fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
        let start = Instant::now();
        while !cond() {
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "timed out waiting for {what}"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    // ---- opening ----------------------------------------------------------

    #[test]
    fn opening_proves_the_file_against_the_driver() {
        let (_, b) = backend();
        assert_eq!(b.registry().points().len(), 6);
        assert!(b.stale_reason().is_none());
    }

    #[test]
    fn a_driver_with_another_layout_than_the_signed_file_does_not_open() {
        let kernel = FakeKernel::sample();
        let moved = sample::rsc().replace("\"offset\": 100", "\"offset\": 104");
        kernel.reset_driver_with(&ProcessMap::parse(moved.as_bytes()).unwrap());
        let e = Backend::open(&config(), 250, source(), opener(&kernel))
            .map(|_| ())
            .unwrap_err();
        assert!(
            format!("{e:#}").contains("different configuration"),
            "{e:#}"
        );
    }

    #[test]
    fn a_missing_device_does_not_open() {
        let opener: Opener = Arc::new(|| Err(anyhow::anyhow!("No such file or directory")));
        let e = Backend::open(&config(), 250, source(), opener)
            .map(|_| ())
            .unwrap_err();
        assert!(format!("{e:#}").contains("opening /dev/piControl0 failed"));
    }

    #[test]
    fn an_unreadable_config_rsc_does_not_open() {
        let kernel = FakeKernel::sample();
        let e = Backend::open(
            &config(),
            250,
            RscSource::File("/nonexistent/config.rsc".into()),
            opener(&kernel),
        )
        .map(|_| ())
        .unwrap_err();
        assert!(format!("{e:#}").contains("config.rsc"), "{e:#}");
    }

    // ---- reading ----------------------------------------------------------

    #[test]
    fn a_poll_reports_every_point_from_one_snapshot() {
        let (kernel, b) = backend();
        kernel.poke(100, 0b01);
        kernel.poke(200, 0x10);
        kernel.poke(201, 0x27);
        kernel.poke(0, 3);
        let out = b.poll();
        let get = |tag: &str| out.readings.iter().find(|r| r.tag == tag).unwrap().clone();
        assert_eq!(get("in_1").raw, 1);
        assert_eq!(get("level").raw, 10_000);
        assert_eq!(get("level").value, 10_000.0);
        assert_eq!(get("pb_status").raw, 3);
        assert!(out.readings.iter().all(|r| r.good));
        assert!(out.changes.is_empty(), "the first poll is the baseline");
    }

    #[test]
    fn a_module_that_goes_inactive_reads_as_a_communication_failure() {
        let (kernel, b) = backend();
        kernel.poke(200, 0x10);
        kernel.set_module_active(33, false);
        let out = b.poll();
        let level = out.readings.iter().find(|r| r.tag == "level").unwrap();
        assert!(
            !level.good,
            "stale bytes of an absent module are not a reading"
        );
        assert_eq!(level.raw, 0);
        assert!(out.readings.iter().find(|r| r.tag == "in_1").unwrap().good);
    }

    #[test]
    fn an_input_change_is_reported_once() {
        let (kernel, b) = backend();
        b.poll();
        kernel.poke(100, 1);
        let out = b.poll();
        assert_eq!(
            out.changes,
            vec![PointChange {
                tag: "in_1".into(),
                variable: "I_1".into(),
                direction: Direction::Input,
                old: 0,
                new: 1,
                external: false,
            }]
        );
        assert!(b.poll().changes.is_empty());
    }

    #[test]
    fn an_output_changed_by_someone_else_is_flagged_external() {
        let (kernel, b) = backend();
        b.write_output("pump", 1.0).unwrap();
        b.poll();
        kernel.poke(122, kernel.peek(122) & !1);
        let out = b.poll();
        let change = out.changes.iter().find(|c| c.tag == "pump").unwrap();
        assert!(change.external);
        assert_eq!((change.old, change.new), (1, 0));
    }

    #[test]
    fn an_output_this_agent_wrote_is_not_external() {
        let (_, b) = backend();
        b.poll();
        b.write_output("pump", 1.0).unwrap();
        let out = b.poll();
        let change = out.changes.iter().find(|c| c.tag == "pump").unwrap();
        assert!(!change.external);
    }

    // ---- writing ----------------------------------------------------------

    #[test]
    fn writing_a_bit_changes_only_that_bit_of_the_byte() {
        let (kernel, b) = backend();
        // Another output of the byte is on, and so is a bit nobody listed.
        kernel.poke(122, 0b1000_0010);
        let written = b.write_output("pump", 1.0).unwrap();
        assert_eq!(written.raw, 1);
        assert_eq!(
            kernel.peek(122),
            0b1000_0011,
            "the neighbours kept their bits"
        );
        b.write_output("pump", 0.0).unwrap();
        assert_eq!(kernel.peek(122), 0b1000_0010);
    }

    #[test]
    fn writing_a_word_writes_exactly_its_two_bytes_little_endian() {
        let (kernel, b) = backend();
        kernel.clear_written_ranges();
        b.write_output("valve", 0x1234 as f64).unwrap();
        assert_eq!(kernel.peek(210), 0x34);
        assert_eq!(kernel.peek(211), 0x12);
        assert_eq!(kernel.written_ranges(), vec![(210, 2)]);
    }

    #[test]
    fn a_value_outside_the_variable_is_refused_before_anything_is_written() {
        let (kernel, b) = backend();
        kernel.clear_written_ranges();
        let e = b.write_output("valve", 70_000.0).unwrap_err();
        assert!(matches!(e, WriteError::Value(_)), "{e}");
        assert!(kernel.written_ranges().is_empty());
    }

    #[test]
    fn a_tag_that_is_not_an_output_is_refused() {
        let (kernel, b) = backend();
        kernel.clear_written_ranges();
        for tag in ["in_1", "level", "pb_status", "no_such_tag"] {
            let e = b.write_output(tag, 1.0).unwrap_err();
            assert!(matches!(e, WriteError::NotAnOutput(_)), "{tag}: {e}");
        }
        assert!(kernel.written_ranges().is_empty());
    }

    #[test]
    fn no_write_of_the_session_ever_touches_the_base_module() {
        let (kernel, b) = backend();
        kernel.clear_written_ranges();
        b.write_output("pump", 1.0).unwrap();
        b.write_output("aerator", 0.0).unwrap();
        b.write_output("valve", 7.0).unwrap();
        b.drive_safe("pump").unwrap();
        b.feed().unwrap();
        // The base module's bytes (RevPiOutput at 6, RevPiLED at 7..9, status
        // at 0..2) are never in a written range.
        for (offset, len) in kernel.written_ranges() {
            assert!(
                offset >= 100,
                "write at {offset}+{len} reached the base module"
            );
        }
    }

    #[test]
    fn a_write_is_refused_when_the_driver_moved_the_variable() {
        let (kernel, b) = backend();
        let moved = sample::rsc().replace("\"offset\": 100", "\"offset\": 104");
        kernel.reset_driver_with(&ProcessMap::parse(moved.as_bytes()).unwrap());
        kernel.clear_written_ranges();
        // Whichever the event thread or the write notices first, nothing is
        // written to the old address.
        let e = b.write_output("pump", 1.0).unwrap_err();
        assert!(
            matches!(e, WriteError::LayoutMoved(_) | WriteError::Stale(_)),
            "{e}"
        );
        assert!(kernel.written_ranges().is_empty());
        wait_until("the backend to be stale", || b.stale_reason().is_some());
    }

    #[test]
    fn a_write_the_image_does_not_retain_is_reported() {
        let (kernel, b) = backend();
        kernel.fail_writes(libc::EIO);
        let e = b.write_output("valve", 5.0).unwrap_err();
        assert!(matches!(e, WriteError::Device(_)), "{e}");
    }

    #[test]
    fn a_driver_reset_in_progress_is_a_transient_error() {
        let (kernel, b) = backend();
        kernel.begin_reset();
        let e = b.write_output("pump", 1.0).unwrap_err();
        assert!(matches!(e, WriteError::Resetting), "{e}");
        kernel.end_reset();
        assert!(b.write_output("pump", 1.0).is_ok());
    }

    #[test]
    fn the_safe_value_is_what_config_rsc_restores() {
        let (kernel, b) = backend();
        kernel.poke(122, 0b0000_0001);
        b.drive_safe("pump").unwrap();
        b.drive_safe("aerator").unwrap();
        assert_eq!(
            kernel.peek(122),
            0b0000_0010,
            "pump safe 0, aerator (fail-on) safe 1"
        );
    }

    // ---- the output watchdog ---------------------------------------------

    #[test]
    fn the_first_feed_arms_the_watchdog_and_every_feed_restarts_its_period() {
        let (kernel, b) = backend();
        assert_eq!(
            kernel.armed_watchdogs().iter().filter(|w| **w != 0).count(),
            0
        );
        b.write_output("pump", 1.0).unwrap();
        b.feed().unwrap();
        assert!(kernel.armed_watchdogs().contains(&1000));
        kernel.advance_ms(900);
        b.feed().unwrap();
        kernel.advance_ms(900);
        assert_eq!(kernel.peek(122) & 1, 1, "fed outputs stay driven");
        kernel.advance_ms(200);
        assert_eq!(
            kernel.peek(122) & 1,
            0,
            "a loop that stopped feeding zeroes the outputs"
        );
    }

    #[test]
    fn a_grant_without_outputs_has_no_watchdog() {
        let kernel = FakeKernel::sample();
        let cfg: PiControlConfig = serde_yaml::from_str("points:\n  - variable: I_1\n").unwrap();
        let b = Backend::open(&cfg, 250, source(), opener(&kernel)).unwrap();
        b.feed().unwrap();
        assert!(kernel.armed_watchdogs().iter().all(|w| *w == 0));
    }

    #[test]
    fn release_disarms_only_after_the_safe_state_so_a_restart_keeps_the_safe_values() {
        let (kernel, b) = backend();
        b.write_output("pump", 1.0).unwrap();
        b.feed().unwrap();
        b.drive_safe("pump").unwrap();
        b.drive_safe("aerator").unwrap();
        b.release(true);
        assert!(kernel.armed_watchdogs().iter().all(|w| *w == 0));
        drop(b);
        assert_eq!(
            kernel.peek(122),
            0b0000_0010,
            "the safe values outlive the descriptor"
        );
    }

    #[test]
    fn an_incomplete_safe_state_leaves_the_watchdog_armed_so_the_driver_zeroes_on_close() {
        let (kernel, b) = backend();
        b.feed().unwrap();
        b.release(false);
        assert!(kernel.armed_watchdogs().contains(&1000));
    }

    // ---- the layout changes under the agent ------------------------------

    #[test]
    fn a_driver_reset_to_the_same_layout_is_reproven_by_the_event_thread() {
        let (kernel, b) = backend();
        let before = b.generation();
        kernel.reset_driver();
        wait_until("the layout to be re-proven", || {
            b.generation() >= before + 2
        });
        assert!(b.stale_reason().is_none());
        assert!(b.write_output("pump", 1.0).is_ok());
    }

    #[test]
    fn a_driver_reset_to_another_layout_leaves_the_agent_refusing_writes() {
        let (kernel, b) = backend();
        b.poll();
        let moved = sample::rsc().replace("\"offset\": 100", "\"offset\": 104");
        kernel.reset_driver_with(&ProcessMap::parse(moved.as_bytes()).unwrap());
        wait_until("the backend to be stale", || b.stale_reason().is_some());
        let e = b.write_output("pump", 1.0).unwrap_err();
        assert!(matches!(e, WriteError::Stale(_)), "{e}");
        let e = b.drive_safe("pump").unwrap_err();
        assert!(matches!(e, WriteError::Stale(_)), "{e}");
        let out = b.poll();
        assert!(
            out.readings.iter().all(|r| !r.good),
            "no reading while the layout is unproven"
        );
    }

    #[test]
    fn a_reload_with_the_new_signed_file_restores_service() {
        let (kernel, b) = backend();
        // Root installs a site whose config.rsc moves the DIO and loads it
        // into the driver.
        let moved_rsc = sample::rsc().replace("\"offset\": 100", "\"offset\": 104");
        let moved = ProcessMap::parse(moved_rsc.as_bytes()).unwrap();
        kernel.set_devices(FakeKernel::devices_for(&moved));
        kernel.reset_driver_with(&moved);
        wait_until("the backend to be stale", || b.stale_reason().is_some());
        assert!(matches!(
            b.write_output("pump", 1.0).unwrap_err(),
            WriteError::Stale(_)
        ));
        // The reload hands the agent the file the driver now has.
        b.reload(
            &config(),
            250,
            RscSource::Verified(moved_rsc.into_bytes().into()),
        )
        .unwrap();
        assert!(b.stale_reason().is_none());
        kernel.clear_written_ranges();
        b.write_output("pump", 1.0).unwrap();
        // O_1 is at module base 104 + 22.
        assert_eq!(kernel.written_ranges(), vec![(126, 1)]);
        assert_eq!(kernel.peek(126) & 1, 1);
        assert_eq!(kernel.peek(122), 0, "the old address is not written");
    }

    #[test]
    fn a_failed_reload_marks_the_layout_stale_and_keeps_refusing() {
        let (_, b) = backend();
        let wrong = RscSource::Verified(
            sample::rsc()
                .replace("\"offset\": 100", "\"offset\": 104")
                .into_bytes()
                .into(),
        );
        assert!(b.reload(&config(), 250, wrong).is_err());
        assert!(b.stale_reason().is_some());
        assert!(matches!(
            b.write_output("pump", 1.0).unwrap_err(),
            WriteError::Stale(_)
        ));
        // The file the driver actually has proves it again.
        b.reload(&config(), 250, source()).unwrap();
        assert!(b.stale_reason().is_none());
        assert!(b.write_output("pump", 1.0).is_ok());
    }

    #[test]
    fn a_device_list_that_no_longer_matches_the_file_goes_stale_at_the_poll() {
        let (kernel, b) = backend();
        assert!(b.poll().readings.iter().all(|r| r.good));
        // The driver's module list changes without an event reaching the agent:
        // position 32 is a DO module now.
        let changed = sample::rsc().replace("\"productType\": \"96\"", "\"productType\": \"98\"");
        let map = ProcessMap::parse(changed.as_bytes()).unwrap();
        kernel.set_devices(FakeKernel::devices_for(&map));
        let out = b.poll();
        assert!(out.readings.iter().all(|r| !r.good));
        assert!(b.stale_reason().unwrap().contains("position 32"));
        assert!(matches!(
            b.write_output("pump", 1.0).unwrap_err(),
            WriteError::Stale(_)
        ));
    }

    /// A signal (SIGHUP is how a new site is applied) that lands on the thread
    /// blocked in `KB_WAIT_FOR_EVENT` ends the wait with `EFAULT` on the driver
    /// the image builds (v2.6.2) and `EINTR` on the next one. It is no failure
    /// of the descriptor: the thread waits again and the next reset is seen.
    #[test]
    fn a_signal_in_the_wait_does_not_end_the_event_thread() {
        for driver in [Driver::V2_6_2, Driver::V2_8_2] {
            let (kernel, b) = backend();
            kernel.set_driver(driver);
            kernel.interrupt_waiter();
            // The interrupted wait must not have staled the layout or ended the
            // thread: a reset after it is still noticed and re-proven.
            let before = b.generation();
            kernel.reset_driver();
            wait_until("the reset after the signal to be re-proven", || {
                b.generation() >= before + 2
            });
            assert!(b.stale_reason().is_none(), "{driver:?}");
        }
    }

    /// An unknown variable on either driver is a moved layout (the signed file
    /// names a variable the driver does not have), not an I/O error.
    #[test]
    fn a_variable_the_driver_lacks_is_a_moved_layout_on_both_drivers() {
        for driver in [Driver::V2_6_2, Driver::V2_8_2] {
            let kernel = FakeKernel::sample();
            let b = Backend::open(&config(), 250, source(), opener(&kernel)).unwrap();
            kernel.set_driver(driver);
            // The driver restarts with a configuration that lacks the pump's variable.
            let without = sample::rsc().replace("O_1", "O_9");
            kernel.reset_driver_with(&ProcessMap::parse(without.as_bytes()).unwrap());
            let e = b.write_output("pump", 1.0).unwrap_err();
            assert!(
                matches!(e, WriteError::LayoutMoved(_) | WriteError::Stale(_)),
                "{driver:?}: {e}"
            );
            assert!(b.stale_reason().is_some(), "{driver:?}");
        }
    }

    #[test]
    fn the_event_descriptor_failing_marks_the_layout_stale() {
        let (kernel, b) = backend();
        kernel.fail_waiters(libc::ENODEV);
        wait_until("the backend to be stale", || b.stale_reason().is_some());
        assert!(b.stale_reason().unwrap().contains("event descriptor"));
    }
}
