//! The RevPi process-image I/O backend (ADR-048 DEC-8.8, DEC-6.7, DEC-13;
//! EDGE-HIGH-053).
//!
//! A RevPi Connect 4 reads and drives its PiBridge expansion modules (DIO, DI,
//! DO, AIO, MIO, RO) through the KUNBUS `piControl` driver's character device,
//! `/dev/piControl0`: one 4096-byte process image, laid out from PiCtory's
//! `config.rsc`, that every opener may read and write whole. This module is the
//! agent's side of that device.
//!
//! | file | what it holds |
//! |---|---|
//! | [`abi`] | the ioctl numbers and structures, from the vendor header (piControl v2.6.2, the image's release, and v2.8.2); only the six requests DEC-8.8 allows exist |
//! | [`rsc`] | the `config.rsc` parser, reproducing the driver's offset arithmetic |
//! | [`device`] | the raw descriptor behind a trait ([`device::RawDevice`]) and the typed operations on it; the real descriptor is a thin libc wrapper |
//! | [`config`] | the `picontrol:` section of `config.yaml`: the agent's own grant |
//! | [`registry`] | the grant resolved against `config.rsc`, every unsafe grant refused, and proven against the driver |
//! | [`backend`] | reads, writes, the output watchdog, layout changes, change detection |
//! | [`handle`] | the handle the agent holds: degraded-mode gate, force registry, safe-state capability |
//! | `behaviour_table` | DEC-13.3 for the RevPi layers: what each event leaves on an output, the single definition: the agent's `safe_state::behaviour` table takes its PiControl column from it, and the mock tests and the hardware test (`tests/hil/` includes the file) play it |
//!
//! # The decisions that make it safe
//!
//! * **No all-or-nothing access.** The device grants the whole image; the agent
//!   grants itself the listed points only, writes only the listed outputs, and
//!   refuses the base module's outputs outright, so the board watchdog trigger
//!   bit of the RevPi Connect and Connect SE and the LEDs are unreachable by
//!   construction (DEC-6.7).
//! * **The signed file and the driver must agree.** The agent resolves variable
//!   names from the signed `config.rsc`, then asks the driver where it keeps
//!   each one (`KB_FIND_VARIABLE`) and refuses to run unless they match; every
//!   write repeats the question first.
//! * **The device is the only I/O it names.** `piTest` and PiCtory are not on
//!   the image; the hardware scan uses the same ioctl.
//! * **Fail closed.** A build without `revpi-io`, a missing or refused device,
//!   a file the driver disagrees with: degraded mode (outputs held in their
//!   safe state, control disabled), never a simulation.
//!
//! # What only hardware can show
//!
//! The kernel module itself (module scheduling, the PiBridge, the real zeroing
//! of the output ranges, the exact reset sequence) is KUNBUS code. The fake
//! kernel in the tests is written from its source; `tests/hil/` runs the same
//! behaviour table against a real RevPi Connect 4 with a DIO module.

pub mod abi;
pub mod backend;
pub mod behaviour_table;
#[cfg(test)]
mod behaviour_tests;
pub mod config;
pub mod device;
#[cfg(test)]
pub(crate) mod fake;
pub mod feed;
pub mod handle;
pub mod registry;
pub mod rsc;

pub use abi::DEVICE_PATH;
pub use backend::RscSource;
pub use config::PiControlConfig;
pub use handle::{PiControlHandle, production_opener};

/// Where the signed `config.rsc` can be read from on this profile.
///
/// Suderra OS: only the bytes the verified site config named
/// ([`crate::site_trust::SiteTrust::site_file`]); the `configured` path is
/// ignored (a configuration that names one is refused at load). Generic
/// profile: the file the driver loaded (`picontrol.config_rsc`, default
/// [`crate::paths::AgentPaths::revpi_config_rsc`]).
pub fn scan_source(
    configured: Option<&str>,
    verified: Option<std::sync::Arc<[u8]>>,
) -> Option<RscSource> {
    #[cfg(feature = "suderra-os")]
    {
        let _ = configured;
        verified.map(RscSource::Verified)
    }
    #[cfg(not(feature = "suderra-os"))]
    {
        let _ = verified;
        Some(RscSource::File(configured.map_or_else(
            || crate::paths::AgentPaths::current().revpi_config_rsc(),
            std::path::PathBuf::from,
        )))
    }
}

/// [`scan_source`] for the backend, where a site that delivered no
/// `config.rsc` is an error: the grant cannot be resolved without it.
pub fn rsc_source(
    config: &PiControlConfig,
    verified: Option<std::sync::Arc<[u8]>>,
) -> Result<RscSource, String> {
    scan_source(config.config_rsc.as_deref(), verified).ok_or_else(|| {
        let path = crate::paths::AgentPaths::current().revpi_config_rsc();
        format!(
            "the verified site config delivered no revpi/config.rsc ({})",
            path.display()
        )
    })
}

#[cfg(test)]
mod source_tests {
    use super::*;

    fn config(rsc: Option<&str>) -> PiControlConfig {
        PiControlConfig {
            config_rsc: rsc.map(str::to_owned),
            output_watchdog_ms: None,
            points: Vec::new(),
        }
    }

    #[cfg(not(feature = "suderra-os"))]
    #[test]
    fn the_generic_profile_reads_the_file_the_driver_loaded() {
        match rsc_source(&config(None), None).unwrap() {
            RscSource::File(p) => assert_eq!(p.to_str(), Some("/etc/revpi/config.rsc")),
            other => panic!("{other:?}"),
        }
        match rsc_source(&config(Some("/data/x.rsc")), None).unwrap() {
            RscSource::File(p) => assert_eq!(p.to_str(), Some("/data/x.rsc")),
            other => panic!("{other:?}"),
        }
    }

    #[cfg(feature = "suderra-os")]
    #[test]
    fn suderra_os_uses_only_the_verified_site_bytes() {
        let bytes: std::sync::Arc<[u8]> = std::sync::Arc::from(&b"{}"[..]);
        assert!(matches!(
            rsc_source(&config(None), Some(bytes)).unwrap(),
            RscSource::Verified(_)
        ));
        let e = rsc_source(&config(None), None).unwrap_err();
        assert!(e.contains("/var/lib/suderra-site/revpi/config.rsc"), "{e}");
    }
}
