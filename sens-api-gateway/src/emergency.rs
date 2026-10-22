//! The emergency stop (ADR-048 DEC-9.7, DEC-13.6; EDGE-HIGH-057, EDGE-HIGH-067).
//!
//! The emergency stop was an in-memory flag of the HMI server: only the HMI
//! WebSocket write path looked at it, it cleared on every agent restart, its
//! scope was optional package data that defaulted to an empty list (so a stop
//! with no package de-energised nothing and still reported success), it wrote a
//! literal 0 to every tag (which switches off an aerator), and its reset
//! needed no PIN when the package named none.
//!
//! It is now a device-wide state of the output layer:
//!
//! * **One latch, in the control gate.** [`EmergencyLatch`] lives inside the
//!   [`crate::degraded::ControlGate`] that every hardware handle carries, so
//!   every actuator writer (MQTT command, HMI, script, OPC UA, force, bytecode)
//!   is refused while it is set, and no writer can be added that does not pass
//!   it. Only the safe-state pass bypasses the gate, and it moves outputs in
//!   one direction only: to their safe value.
//! * **Durable.** [`EmergencyLatch::latch`] sets the flag first (writers are
//!   refused from that instant), then writes the record and fsyncs it before
//!   the stop is acknowledged. [`EmergencyLatch::restore`] reads it at boot,
//!   before hardware initialisation, so a restart, an update or a reboot does
//!   not clear a stop. A record that cannot be read latches too: the agent
//!   cannot tell that no stop was pending.
//! * **Safe values, not zeros.** The stop drives the outputs to their
//!   configured safe values ([`crate::safe_state::Event::EmergencyStop`]): a
//!   life-support output (aeration, oxygen) fails ON and is never de-energised
//!   by a stop.
//! * **Scope from the registry.** Every registered output, unless the package
//!   explicitly narrows it to named tags; an empty list is refused when the
//!   package is validated, a named tag that is no safe-state output is a
//!   failure, and a stop that resolved no output does not report success.
//! * **Authenticated reset.** [`EmergencyControl::reset`] is reached only
//!   through a verified credential (the HMI PIN, or a package that explicitly
//!   says the reset needs none). With no PIN configured and no such opt-out the
//!   reset is refused.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tracing::{error, info, warn};

/// Schema name of the persisted record.
pub const RECORD_SCHEMA: &str = "suderra.emergency-stop.v1";

/// What a stop leaves on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    pub schema: String,
    /// Always true in a record that exists: a cleared stop has no record.
    pub latched: bool,
    /// When the stop was requested (RFC 3339; informational, never read for a
    /// decision).
    pub at: String,
    /// Who asked.
    pub by: String,
    /// The tags the stop was asked to cover, empty for "every registered
    /// output".
    pub scope: Vec<String>,
}

impl Record {
    pub fn new(by: &str, scope: Vec<String>) -> Self {
        Self {
            schema: RECORD_SCHEMA.to_owned(),
            latched: true,
            at: chrono::Utc::now().to_rfc3339(),
            by: by.to_owned(),
            scope,
        }
    }
}

/// What the boot found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Restored {
    /// No stop was pending.
    Clear,
    /// A stop was pending and is latched again.
    Latched(Record),
    /// The record could not be read or understood: latched, because the agent
    /// cannot tell that no stop was pending.
    Unreadable(String),
}

/// Why the record could not be written.
#[derive(Debug, thiserror::Error)]
#[error("the emergency-stop record could not be made durable: {0}")]
pub struct NotDurable(String);

#[derive(Debug)]
struct Inner {
    latched: AtomicBool,
    /// The record file; `None` until [`EmergencyLatch::attach_store`] (a latch
    /// built for a test persists nothing).
    store: Mutex<Option<PathBuf>>,
    /// Serialises [`EmergencyLatch::latch`] and [`EmergencyLatch::clear`]: the
    /// flag and the record are one state, and a stop racing a reset must leave
    /// both set or both cleared, never the flag cleared with the record on disk
    /// (a stop that comes back at the next boot) or the flag set with the record
    /// gone (a stop that does not survive one).
    op: Mutex<()>,
}

/// The device-wide emergency-stop state (cheap to clone; every clone is the
/// same latch).
#[derive(Debug, Clone)]
pub struct EmergencyLatch {
    inner: Arc<Inner>,
}

impl Default for EmergencyLatch {
    fn default() -> Self {
        Self::volatile()
    }
}

impl EmergencyLatch {
    /// A latch that is not backed by a file. The agent attaches its store at
    /// boot ([`Self::attach_store`]); only the tests keep it volatile.
    pub fn volatile() -> Self {
        Self {
            inner: Arc::new(Inner {
                latched: AtomicBool::new(false),
                store: Mutex::new(None),
                op: Mutex::new(()),
            }),
        }
    }

    /// Whether a stop is latched.
    pub fn is_latched(&self) -> bool {
        self.inner.latched.load(Ordering::Acquire)
    }

    fn store(&self) -> std::sync::MutexGuard<'_, Option<PathBuf>> {
        match self.inner.store.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn op(&self) -> std::sync::MutexGuard<'_, ()> {
        match self.inner.op.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Back the latch with `file` and restore a stop that was pending: run at
    /// boot, before the hardware is initialised.
    ///
    /// The directory of the record is created when it does not exist (a first
    /// boot): the absence of a record then means no stop was pending. A directory
    /// that cannot be created, or a record's place that cannot be read (an
    /// unmounted or read-only data volume), is [`Restored::Unreadable`] and
    /// latches: the agent cannot tell that no stop was pending, and a stop it is
    /// asked for could not be made durable either.
    pub fn attach_store(&self, file: PathBuf) -> Restored {
        let directory = match file.parent() {
            Some(dir) if !dir.as_os_str().is_empty() => std::fs::create_dir_all(dir)
                .map_err(|e| format!("its directory {} is not available: {e}", dir.display())),
            _ => Ok(()),
        };
        let restored = match directory {
            Err(why) => Restored::Unreadable(why),
            Ok(()) => Self::read_record(&file),
        };
        self.finish_attach(file, restored)
    }

    fn read_record(file: &std::path::Path) -> Restored {
        match std::fs::read(file) {
            Ok(bytes) => match serde_json::from_slice::<Record>(&bytes) {
                Ok(record) if record.schema == RECORD_SCHEMA && record.latched => {
                    Restored::Latched(record)
                }
                Ok(record) => Restored::Unreadable(format!(
                    "unexpected record (schema {:?}, latched {})",
                    record.schema, record.latched
                )),
                Err(e) => Restored::Unreadable(format!("not a record: {e}")),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Restored::Clear,
            Err(e) => Restored::Unreadable(format!("unreadable: {e}")),
        }
    }

    fn finish_attach(&self, file: PathBuf, restored: Restored) -> Restored {
        *self.store() = Some(file);
        match &restored {
            Restored::Clear => {}
            Restored::Latched(record) => {
                self.inner.latched.store(true, Ordering::Release);
                error!(
                    "ALARM emergency-stop restored: requested by {} at {}; every actuator write \
                     is refused until an authenticated reset",
                    record.by, record.at
                );
            }
            Restored::Unreadable(why) => {
                self.inner.latched.store(true, Ordering::Release);
                error!(
                    "ALARM emergency-stop record {why}: treated as latched; every actuator write \
                     is refused until an authenticated reset"
                );
            }
        }
        restored
    }

    /// Latch the stop. The flag is set first, so writers are refused from this
    /// instant whatever happens next; the record is then written and fsynced.
    /// An error means the stop is in force but would not survive a restart.
    pub fn latch(&self, record: &Record) -> Result<(), NotDurable> {
        self.inner.latched.store(true, Ordering::Release);
        let _op = self.op();
        // A reset that ran between the store above and the lock cleared the flag
        // and the record: this stop was requested after it began, so it is the
        // later of the two and stands.
        self.inner.latched.store(true, Ordering::Release);
        warn!(
            "ALARM emergency-stop latched by {}: every actuator write is refused until an \
             authenticated reset",
            record.by
        );
        let Some(file) = self.store().clone() else {
            return Ok(());
        };
        let bytes = serde_json::to_vec_pretty(record).map_err(|e| NotDurable(e.to_string()))?;
        write_durably(&file, &bytes).map_err(|e| {
            error!("emergency-stop record not durable: {e}");
            NotDurable(e.to_string())
        })
    }

    /// Clear the stop. The record is removed durably first: a record that
    /// cannot be removed keeps the stop latched (it would come back at the next
    /// boot anyway).
    pub fn clear(&self) -> Result<(), NotDurable> {
        let _op = self.op();
        if let Some(file) = self.store().clone() {
            match std::fs::remove_file(&file) {
                Ok(()) => {
                    sync_parent(&file).map_err(|e| NotDurable(e.to_string()))?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(NotDurable(e.to_string())),
            }
        }
        self.inner.latched.store(false, Ordering::Release);
        info!("emergency-stop cleared by an authenticated reset");
        Ok(())
    }
}

/// Write `bytes` to `file` so that it is either the old content or the new,
/// and on disk before this returns.
fn write_durably(file: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = file.with_extension("json.tmp");
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, file)?;
    sync_parent(file)
}

fn sync_parent(file: &std::path::Path) -> std::io::Result<()> {
    match file.parent() {
        Some(dir) => std::fs::File::open(dir)?.sync_all(),
        None => Ok(()),
    }
}

/// What a stop did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopOutcome {
    /// The stop is in force (writers are refused).
    pub latched: bool,
    /// The record is on disk, so the stop survives a restart.
    pub durable: bool,
    /// Outputs the stop resolved.
    pub registered: usize,
    /// Outputs that reached their safe value.
    pub applied: usize,
    /// Outputs (or named tags) that did not, with why.
    pub failed: Vec<String>,
}

impl StopOutcome {
    /// A stop succeeded only if it is in force and durable, resolved at least
    /// one output, and every output it resolved is at its safe value: a stop
    /// that de-energised nothing does not say it did.
    pub fn success(&self) -> bool {
        self.latched
            && self.durable
            && self.registered > 0
            && self.failed.is_empty()
            && self.applied == self.registered
    }

    /// What the HMI is told when the stop did not succeed.
    pub fn problem(&self) -> Option<String> {
        if self.success() {
            return None;
        }
        Some(if self.registered == 0 && self.failed.is_empty() {
            "the emergency stop resolved no output: this device has no output to stop".to_string()
        } else if !self.durable {
            "the emergency stop is in force but could not be made durable: it will not survive a \
             restart"
                .to_string()
        } else {
            format!(
                "{} of {} outputs reached their safe value; failed: {}",
                self.applied,
                self.registered,
                self.failed.join("; ")
            )
        })
    }
}

/// What the HMI server asks of the output layer. The implementation lives
/// with the agent state ([`crate::emergency::AppEmergency`]); the server holds
/// only this.
#[async_trait::async_trait]
pub trait EmergencyControl: Send + Sync {
    /// Whether a stop is latched.
    fn is_latched(&self) -> bool;

    /// Latch, make durable and drive the outputs to their safe values. An
    /// empty `scope_tags` is every registered output; otherwise exactly the
    /// outputs of those tags.
    async fn stop(&self, scope_tags: &[String], requested_by: &str) -> StopOutcome;

    /// Clear the stop. The caller has authenticated the request.
    async fn reset(&self, requested_by: &str) -> Result<(), String>;
}

/// The agent's emergency control: the latch of the control gate, the live
/// configuration and the hardware handles.
pub struct AppEmergency {
    state: Arc<tokio::sync::RwLock<crate::AppState>>,
    latch: EmergencyLatch,
}

impl AppEmergency {
    pub fn new(state: Arc<tokio::sync::RwLock<crate::AppState>>, latch: EmergencyLatch) -> Self {
        Self { state, latch }
    }
}

#[async_trait::async_trait]
impl EmergencyControl for AppEmergency {
    fn is_latched(&self) -> bool {
        self.latch.is_latched()
    }

    async fn stop(&self, scope_tags: &[String], requested_by: &str) -> StopOutcome {
        // Latch first, before anything that can wait: the AppState lock below
        // queues behind a pending writer, which queues behind the readers that
        // are in a field-bus call, so a latch taken after it would not refuse the
        // writers for as long as a Modbus timeout. The latch needs no state; the
        // record names the tags the stop was asked for.
        let record = Record::new(requested_by, scope_tags.to_vec());
        let durable = self.latch.latch(&record).is_ok();

        let state = self.state.read().await;

        // The scope: named tags resolve to outputs; none named is everything.
        let mut failed: Vec<String> = Vec::new();
        let mut scope: Vec<crate::safe_state::OutputId> = Vec::new();
        for tag in scope_tags {
            match state.process_image.get_config(tag).await {
                None => failed.push(format!("tag '{tag}' is not in the process image")),
                Some(config) => match crate::tag_writer::output_id_of(&state.config, &config) {
                    Ok(id) => scope.push(id),
                    Err(refusal) => failed.push(format!("tag '{tag}': {refusal}")),
                },
            }
        }

        let handles = crate::safe_state::OutputHandles::of(&state);
        let scoped = (!scope_tags.is_empty()).then_some(scope.as_slice());
        let (report, unregistered) = crate::safe_state::apply_scoped(
            &state.config,
            crate::safe_state::Event::EmergencyStop,
            scoped,
            handles,
        )
        .await;
        for id in unregistered {
            failed.push(format!("{id} is not a safe-state output"));
        }
        for failure in &report.failures {
            failed.push(format!("{}: {}", failure.output, failure.error));
        }
        StopOutcome {
            latched: self.latch.is_latched(),
            durable,
            registered: report.registered,
            applied: report.applied,
            failed,
        }
    }

    async fn reset(&self, requested_by: &str) -> Result<(), String> {
        info!("emergency-stop reset requested by {requested_by}");
        self.latch.clear().map_err(|e| e.to_string())
    }
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used)]
mod tests {
    use super::*;

    fn record() -> Record {
        Record::new("hmi:192.0.2.7", vec![])
    }

    #[test]
    fn a_volatile_latch_latches_and_clears_in_memory() {
        let latch = EmergencyLatch::volatile();
        assert!(!latch.is_latched());
        latch.latch(&record()).unwrap();
        assert!(latch.is_latched());
        latch.clear().unwrap();
        assert!(!latch.is_latched());
    }

    /// EDGE-HIGH-067: the stop survives a restart, an update and a reboot.
    #[test]
    fn a_latched_stop_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("emergency-stop.json");

        let first = EmergencyLatch::volatile();
        assert_eq!(first.attach_store(file.clone()), Restored::Clear);
        first.latch(&record()).unwrap();
        assert!(
            file.exists(),
            "the record is on disk before the stop is acknowledged"
        );

        // The agent restarts: a new latch over the same file.
        let second = EmergencyLatch::volatile();
        match second.attach_store(file.clone()) {
            Restored::Latched(r) => assert_eq!(r.by, "hmi:192.0.2.7"),
            other => panic!("{other:?}"),
        }
        assert!(
            second.is_latched(),
            "restored before any control runtime starts"
        );

        // An authenticated reset removes the record; the next boot is clear.
        second.clear().unwrap();
        assert!(!file.exists());
        let third = EmergencyLatch::volatile();
        assert_eq!(third.attach_store(file), Restored::Clear);
        assert!(!third.is_latched());
    }

    /// A record that cannot be understood latches: the agent cannot tell that
    /// no stop was pending.
    #[test]
    fn an_unreadable_record_latches() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("emergency-stop.json");
        for content in [
            "not json".to_owned(),
            serde_json::json!({"schema": "other", "latched": true, "at": "", "by": "", "scope": []})
                .to_string(),
            serde_json::json!({"schema": RECORD_SCHEMA, "latched": false, "at": "", "by": "", "scope": []})
                .to_string(),
        ] {
            std::fs::write(&file, content).unwrap();
            let latch = EmergencyLatch::volatile();
            assert!(matches!(
                latch.attach_store(file.clone()),
                Restored::Unreadable(_)
            ));
            assert!(latch.is_latched());
        }
    }

    /// The flag is set before the record is written: a record that cannot be
    /// written still stops every writer, and says it is not durable.
    #[test]
    fn a_record_that_cannot_be_written_still_stops_the_writers() {
        let dir = tempfile::tempdir().unwrap();
        let latch = EmergencyLatch::volatile();
        // The place of the record is a directory: it can be neither read as a
        // record nor replaced by one.
        let file = dir.path().join("emergency-stop.json");
        std::fs::create_dir(&file).unwrap();
        let _ = latch.attach_store(file);
        let result = latch.latch(&record());
        assert!(result.is_err(), "not durable");
        assert!(latch.is_latched(), "but in force");
    }

    /// A record that cannot be removed keeps the stop latched.
    #[test]
    fn a_stop_whose_record_cannot_be_removed_stays_latched() {
        let dir = tempfile::tempdir().unwrap();
        // A directory where the file should be: remove_file fails with
        // something other than NotFound.
        let file = dir.path().join("emergency-stop.json");
        std::fs::create_dir(&file).unwrap();
        let latch = EmergencyLatch::volatile();
        let _ = latch.attach_store(file);
        latch.inner.latched.store(true, Ordering::Release);
        assert!(latch.clear().is_err());
        assert!(latch.is_latched());
    }

    #[cfg(unix)]
    #[test]
    fn the_record_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("emergency-stop.json");
        let latch = EmergencyLatch::volatile();
        let _ = latch.attach_store(file.clone());
        latch.latch(&record()).unwrap();
        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn a_stop_that_resolved_no_output_does_not_report_success() {
        let outcome = StopOutcome {
            latched: true,
            durable: true,
            registered: 0,
            applied: 0,
            failed: vec![],
        };
        assert!(!outcome.success());
        assert!(outcome.problem().unwrap().contains("no output"));

        let done = StopOutcome {
            registered: 3,
            applied: 3,
            ..outcome.clone()
        };
        assert!(done.success());
        assert!(done.problem().is_none());

        let partial = StopOutcome {
            registered: 3,
            applied: 2,
            failed: vec!["gpio pin 17: no handle".into()],
            ..outcome.clone()
        };
        assert!(!partial.success());
        assert!(partial.problem().unwrap().contains("2 of 3"));

        let volatile = StopOutcome {
            durable: false,
            registered: 3,
            applied: 3,
            ..outcome
        };
        assert!(!volatile.success());
        assert!(volatile.problem().unwrap().contains("durable"));
    }

    /// A first boot: the directory of the record does not exist yet, which is no
    /// pending stop. It is created, and a stop is then durable.
    #[test]
    fn a_missing_state_directory_is_a_first_boot_not_a_pending_stop() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state/emergency-stop.json");
        let latch = EmergencyLatch::volatile();
        assert_eq!(latch.attach_store(file.clone()), Restored::Clear);
        assert!(!latch.is_latched());
        latch.latch(&record()).unwrap();
        assert!(
            file.exists(),
            "the stop is durable in the directory just made"
        );
    }

    /// A data volume the agent cannot use (here a file where the directory
    /// should be, as an unmounted or read-only volume leaves it) cannot be
    /// searched for a pending stop: the agent cannot tell that none was pending,
    /// so it latches, as it does for a record it cannot read.
    #[test]
    fn a_state_directory_that_cannot_be_made_latches() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("state");
        std::fs::write(&blocker, b"not a directory").unwrap();
        let latch = EmergencyLatch::volatile();
        match latch.attach_store(blocker.join("emergency-stop.json")) {
            Restored::Unreadable(why) => assert!(why.contains("not available"), "{why}"),
            other => panic!("{other:?}"),
        }
        assert!(latch.is_latched());
    }

    /// A stop racing a reset leaves the flag and the record in one state: the
    /// flag set with the record on disk, or both cleared. Run many times, because
    /// the failure is an interleaving.
    #[test]
    fn a_stop_racing_a_reset_leaves_the_flag_and_the_record_in_one_state() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("emergency-stop.json");
        for round in 0..300 {
            let latch = EmergencyLatch::volatile();
            let _ = latch.attach_store(file.clone());
            latch.latch(&record()).unwrap();
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let stop = {
                let (latch, barrier) = (latch.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    latch.latch(&record()).unwrap();
                })
            };
            let reset = {
                let (latch, barrier) = (latch.clone(), barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    latch.clear().unwrap();
                })
            };
            stop.join().unwrap();
            reset.join().unwrap();
            assert_eq!(
                latch.is_latched(),
                file.exists(),
                "round {round}: the flag says {} and the record is {}",
                latch.is_latched(),
                if file.exists() { "on disk" } else { "gone" }
            );
            let _ = std::fs::remove_file(&file);
        }
    }
}
