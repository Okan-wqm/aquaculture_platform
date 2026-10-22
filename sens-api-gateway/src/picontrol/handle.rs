//! The handle the rest of the agent holds: the backend behind the same
//! degraded-mode gate and force registry as every other writer.
//!
//! Every actuator path (the MQTT `set_output` command, the SCADA command
//! executor) reaches the process image through [`PiControlHandle::write_output`],
//! and that method is the only public way to write it. It checks, in this
//! order, the things the other writers check (ADR-048 DEC-6.3, DEC-9):
//!
//! 1. the [`ControlGate`]: while the agent is degraded, control is disabled
//!    and nothing is written (only the safe-state pass, with its capability
//!    token, may drive an output);
//! 2. the force registry: an output whose tag holds an operator's forced
//!    value is not overwritten by any other writer;
//! 3. the backend's own grant: the tag must be an output the `picontrol:`
//!    section lists, the value must fit the variable, and the layout must
//!    still be the one proven against the driver.
//!
//! Authorization — which actor may write which tag — is not repeated here: the
//! commands reach this method after the envelope gate evaluated
//! `Permission::WriteTag { tag }` for the very tag they name
//! (`commands/catalog.rs`, `set_output`), the same permission a GPIO or Modbus
//! tag needs. The backend adds no command of its own, so there is no second,
//! weaker route to the process image.

use std::path::Path;
use std::sync::Arc;

use tracing::warn;

use crate::degraded::ControlGate;
use crate::process_image::{IoType, ProtocolConfig, TagConfig, TagSource};
use crate::safe_state::SafeStateWrite;
use crate::scripting::force_registry::ForceRegistry;

use super::abi::DEVICE_PATH;
use super::backend::{Backend, PollOutcome, RscSource, WriteError, Written};
use super::config::{Direction, PiControlConfig};
use super::device::Opener;
use super::registry::Point;
use super::rsc::Width;

/// Opens the real device. A build without the `revpi-io` feature (or not for
/// Linux) has no driver for it: the error is [`BackendNotCompiled`], so a
/// configured `picontrol:` section fails closed into degraded mode and never
/// runs against nothing.
pub fn production_opener() -> Opener {
    Arc::new(|| {
        #[cfg(all(feature = "revpi-io", target_os = "linux"))]
        {
            use super::device::{LibcDevice, RawDevice};
            use anyhow::Context as _;
            let dev = LibcDevice::open(Path::new(DEVICE_PATH))
                .with_context(|| format!("{DEVICE_PATH} could not be opened"))?;
            Ok(Arc::new(dev) as Arc<dyn RawDevice>)
        }
        #[cfg(not(all(feature = "revpi-io", target_os = "linux")))]
        {
            use crate::degraded::{Backend as DegradedBackend, BackendNotCompiled};
            let _ = Path::new(DEVICE_PATH);
            Err(anyhow::Error::new(BackendNotCompiled(
                DegradedBackend::PiControl,
            )))
        }
    })
}

/// The agent's handle on the RevPi process image.
#[derive(Clone)]
pub struct PiControlHandle {
    backend: Backend,
    gate: ControlGate,
    force: Arc<ForceRegistry>,
}

/// What a tag-level write returns to its writer.
pub type WriteResult = Result<Written, WriteError>;

impl PiControlHandle {
    /// Open the device and prove the signed `config.rsc` against it.
    pub fn open(
        config: &PiControlConfig,
        io_interval_ms: u64,
        source: RscSource,
        gate: ControlGate,
        force: Arc<ForceRegistry>,
        opener: Opener,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            backend: Backend::open(config, io_interval_ms, source, opener)?,
            gate,
            force,
        })
    }

    /// The tag configurations of the points, for the process image.
    pub fn tag_configs(&self) -> Vec<TagConfig> {
        self.backend
            .registry()
            .points()
            .iter()
            .map(tag_config)
            .collect()
    }

    /// The tags of the outputs the proven registry grants right now. The
    /// safe-state pass drives exactly these, so an output a reload granted
    /// after boot is driven too, and no snapshot of the configuration can
    /// disagree with what the agent is able to write.
    pub fn output_tags(&self) -> Vec<String> {
        self.backend
            .registry()
            .points()
            .iter()
            .filter(|p| p.is_output())
            .map(|p| p.tag.clone())
            .collect()
    }

    /// Whether `tag` is one of this backend's points.
    pub fn owns(&self, tag: &str) -> bool {
        self.backend.registry().point_for_tag(tag).is_some()
    }

    /// Read every point.
    pub fn poll(&self) -> PollOutcome {
        self.backend.poll()
    }

    /// Write an output on behalf of an authorized command, an HMI or a
    /// script (see the module documentation for the checks).
    pub async fn write_output(&self, tag: &str, value: f64) -> WriteResult {
        self.gate
            .permit()
            .map_err(|e| WriteError::Disabled(e.to_string()))?;
        if self.force.is_forced(tag).await {
            return Err(WriteError::Forced(tag.to_owned()));
        }
        self.backend.write_output(tag, value)
    }

    /// Drive an output to its safe value. Only the safe-state pass holds the
    /// capability token, so this is the one write that works while control is
    /// disabled.
    pub fn drive_safe(&self, tag: &str, _: &SafeStateWrite) -> WriteResult {
        self.backend.drive_safe(tag)
    }

    /// How often [`PiControlHandle::feed`] is called while the loop is alive
    /// (see [`super::feed::while_feeding`]).
    pub fn feed_every(&self) -> std::time::Duration {
        self.backend.feed_every()
    }

    /// The control loop is alive (arms and feeds the output watchdog). A
    /// failed feed is logged: if the driver cannot be fed the watchdog does
    /// what it is for.
    pub fn feed(&self) {
        if let Err(e) = self.backend.feed() {
            if !e.is_reset_in_progress() {
                warn!("piControl output watchdog could not be fed: {e}");
            }
        }
    }

    /// Finish with the device after the safe state (see
    /// [`Backend::release`]).
    pub fn release(&self, safe_state_complete: bool) {
        self.backend.release(safe_state_complete);
    }

    /// A verified reload: prove the new grant and file against the driver.
    pub fn reload(
        &self,
        config: &PiControlConfig,
        io_interval_ms: u64,
        source: RscSource,
    ) -> anyhow::Result<()> {
        self.backend.reload(config, io_interval_ms, source)
    }

    /// Why the layout is not proven, when it is not.
    pub fn stale_reason(&self) -> Option<String> {
        self.backend.stale_reason()
    }
}

/// The tag a point is published under.
fn tag_config(point: &Point) -> TagConfig {
    let output = point.direction == Direction::Output;
    let io_type = match (point.width, output) {
        (Width::Bit, false) => IoType::DI,
        (Width::Bit, true) => IoType::DO,
        (_, false) => IoType::AI,
        (_, true) => IoType::AO,
    };
    TagConfig {
        tag_name: point.tag.clone(),
        io_type,
        data_type: point.point_type.name().to_owned(),
        source: TagSource::PiControl,
        poll_interval_ms: None,
        raw_min: point.scale.map(|s| s.raw_min),
        raw_max: point.scale.map(|s| s.raw_max),
        eng_min: point.scale.map(|s| s.eng_min),
        eng_max: point.scale.map(|s| s.eng_max),
        eng_unit: point.eng_unit.clone(),
        invert: false,
        alarm_hh: None,
        alarm_h: None,
        alarm_l: None,
        alarm_ll: None,
        deadband: None,
        protocol_config: ProtocolConfig::PiControl {
            variable: point.variable.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

    use super::super::fake::FakeKernel;
    use super::super::rsc::sample;
    use super::*;
    use crate::degraded::{Backend as DegradedBackend, DegradedMode, DegradedReason};
    use crate::runtime_safety::system_clock::SystemClockAuthority;

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
  - tag: level
    variable: InputValue_1
    raw_min: 0
    raw_max: 10000
    eng_min: 0
    eng_max: 10
    eng_unit: V
"#;

    struct Rig {
        kernel: Arc<FakeKernel>,
        handle: PiControlHandle,
        degraded: DegradedMode,
        force: Arc<ForceRegistry>,
        _dir: tempfile::TempDir,
    }

    fn rig() -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let degraded = DegradedMode::new(dir.path().join("health.json"));
        let kernel = FakeKernel::sample();
        let force = Arc::new(ForceRegistry::new());
        let opener: Opener = {
            let k = kernel.clone();
            Arc::new(move || Ok(k.open()))
        };
        let handle = PiControlHandle::open(
            &serde_yaml::from_str(GRANT).unwrap(),
            250,
            RscSource::Verified(sample::rsc().into_bytes().into()),
            degraded.control_gate(),
            force.clone(),
            opener,
        )
        .unwrap();
        Rig {
            kernel,
            handle,
            degraded,
            force,
            _dir: dir,
        }
    }

    #[tokio::test]
    async fn an_authorized_write_reaches_the_output() {
        let r = rig();
        let written = r.handle.write_output("pump", 1.0).await.unwrap();
        assert_eq!(written.raw, 1);
        assert_eq!(r.kernel.peek(122) & 1, 1);
    }

    #[tokio::test]
    async fn degraded_mode_refuses_every_writer_but_the_safe_state() {
        let r = rig();
        r.handle.write_output("pump", 1.0).await.unwrap();
        r.degraded.enter(DegradedReason::BackendUnavailable {
            backend: DegradedBackend::Gpio,
            detail: "gpio is gone".into(),
        });
        let e = r.handle.write_output("pump", 0.0).await.unwrap_err();
        assert!(matches!(e, WriteError::Disabled(_)), "{e}");
        assert_eq!(
            r.kernel.peek(122) & 1,
            1,
            "the refused write changed nothing"
        );
    }

    #[tokio::test]
    async fn a_forced_tag_is_not_overwritten_by_a_writer() {
        let r = rig();
        r.force
            .apply(
                "pump".into(),
                1.0,
                crate::process_image::TagQuality::Good,
                "operator".into(),
                "commissioning".into(),
                60,
                false,
                &SystemClockAuthority::new(),
            )
            .await
            .unwrap();
        let e = r.handle.write_output("pump", 0.0).await.unwrap_err();
        assert!(matches!(e, WriteError::Forced(_)), "{e}");
        assert_eq!(r.kernel.peek(122) & 1, 0);
        // Another tag is not affected.
        assert!(r.handle.write_output("aerator", 0.0).await.is_ok());
    }

    #[tokio::test]
    async fn only_listed_outputs_are_writable() {
        let r = rig();
        for tag in ["level", "RevPiOutput", "RevPiLED", "O_3", "unknown"] {
            let e = r.handle.write_output(tag, 1.0).await.unwrap_err();
            assert!(matches!(e, WriteError::NotAnOutput(_)), "{tag}: {e}");
        }
    }

    #[test]
    fn the_safe_state_pass_is_the_one_writer_that_works_while_degraded() {
        let r = rig();
        r.degraded.enter(DegradedReason::BackendUnavailable {
            backend: DegradedBackend::Gpio,
            detail: "gpio is gone".into(),
        });
        let token = crate::safe_state::test_capability();
        r.kernel.poke(122, 0b0000_0001);
        r.handle.drive_safe("pump", &token).unwrap();
        r.handle.drive_safe("aerator", &token).unwrap();
        assert_eq!(r.kernel.peek(122), 0b0000_0010);
    }

    #[test]
    fn tag_configs_describe_the_points() {
        let r = rig();
        let configs = r.handle.tag_configs();
        let get = |name: &str| configs.iter().find(|c| c.tag_name == name).unwrap();
        let pump = get("pump");
        assert_eq!(pump.io_type, IoType::DO);
        assert_eq!(pump.data_type, "bool");
        assert_eq!(pump.source, TagSource::PiControl);
        assert!(matches!(
            &pump.protocol_config,
            ProtocolConfig::PiControl { variable } if variable == "O_1"
        ));
        let level = get("level");
        assert_eq!(level.io_type, IoType::AI);
        assert_eq!(level.eng_max, Some(10.0));
        assert_eq!(level.eng_unit.as_deref(), Some("V"));
        assert!(r.handle.owns("pump"));
        assert!(!r.handle.owns("nothing"));
    }

    #[test]
    fn feed_and_release_follow_the_backend() {
        let r = rig();
        r.handle.feed();
        assert!(r.kernel.armed_watchdogs().contains(&1000));
        r.handle.release(true);
        assert!(r.kernel.armed_watchdogs().iter().all(|w| *w == 0));
    }

    #[cfg(not(all(feature = "revpi-io", target_os = "linux")))]
    #[test]
    fn a_build_without_the_driver_fails_closed_with_the_typed_error() {
        let opener = production_opener();
        let e = opener().map(|_| ()).unwrap_err();
        let typed = e
            .downcast_ref::<crate::degraded::BackendNotCompiled>()
            .unwrap();
        assert_eq!(typed.0, DegradedBackend::PiControl);
        assert!(typed.to_string().contains("`revpi-io` feature"));
    }

    #[cfg(all(feature = "revpi-io", target_os = "linux"))]
    #[test]
    fn the_production_opener_reports_a_missing_device_node() {
        // This machine has no /dev/piControl0.
        if std::path::Path::new(DEVICE_PATH).exists() {
            return;
        }
        let e = production_opener()().map(|_| ()).unwrap_err();
        assert!(format!("{e:#}").contains("/dev/piControl0 could not be opened"));
    }
}
