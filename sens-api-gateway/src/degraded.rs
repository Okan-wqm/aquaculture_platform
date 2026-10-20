//! Degraded mode — what "fail closed" means for the edge agent.
//!
//! ADR-048 DEC-6.3, DEC-13 (P0); EDGE-HIGH-051, EDGE-MEDIUM-075,
//! INFRA-CRITICAL-236.
//!
//! WHY: the agent used to "fail closed" by exiting. Under systemd that is a
//! restart loop, and every restart re-runs hardware init and the shutdown /
//! boot safe-state, so pumps and aerators toggle again and again — on a fish
//! farm the toggling is the hazard. A configured I/O backend that was not
//! compiled in or not found silently fell back to a simulation that reported
//! success, so "outputs safe" was claimed for outputs nobody drove.
//!
//! WHAT: degraded mode keeps the process up, disables control, holds the
//! outputs in their safe state and raises an alarm. It is entered when a
//! configured backend (gpio/i2c/spi/pwm) is absent or fails init, when the
//! boot safe-state does not reach every registered output, or when the
//! license forbids polling the configured I/O. It is latched for the run: the
//! operator clears the cause and restarts the agent.
//!
//! * Control disabled: the control runtime (script engine, bytecode scan
//!   cycle, scheduler) is not started, and every actuator write path —
//!   remote command, HMI, OPC UA, script — goes through a [`ControlGate`]
//!   inside the hardware handles, which refuses while degraded. Only the
//!   safe-state writer bypasses it (`safe_state::SafeStateWrite`, a
//!   capability only `SafeStateManager` can construct).
//! * Alarm: an `error!` ALARM line, `STATUS=degraded: …` to systemd, the
//!   health view `agent-health` (`"degraded": true`, read by the OS health
//!   gate, contract `mutable-state.json` `/run/suderra/agent-health`) and a
//!   `status: error` + `degraded` report to the cloud once MQTT is up.
//! * Degraded mode also sends READY, so systemd does not restart-loop the
//!   outputs.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tracing::{error, warn};

use crate::liveness::Verdict;

/// Schema name of the health view document.
pub const HEALTH_SCHEMA: &str = "suderra.agent-health.v1";

/// An I/O backend the configuration can require.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Backend {
    Gpio,
    I2c,
    Spi,
    Pwm,
}

impl Backend {
    pub fn name(self) -> &'static str {
        match self {
            Self::Gpio => "gpio",
            Self::I2c => "i2c",
            Self::Spi => "spi",
            Self::Pwm => "pwm",
        }
    }
}

/// The error a backend returns when the binary has no driver for it. There
/// is no simulation fallback: a configured backend that is not compiled in
/// fails closed (INFRA-CRITICAL-236).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendNotCompiled(pub Backend);

impl std::fmt::Display for BackendNotCompiled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} is configured but this agent build has no {} driver (built without the \
             `gpio` feature or not for Linux); the backend is unavailable and the agent \
             runs in degraded mode (ADR-048 DEC-6.3)",
            self.0.name(),
            self.0.name()
        )
    }
}

impl std::error::Error for BackendNotCompiled {}

/// Why the agent is degraded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DegradedReason {
    /// A configured backend is not compiled in, not present or failed init.
    BackendUnavailable { backend: Backend, detail: String },
    /// The boot safe-state did not reach every registered output.
    SafeStateIncomplete {
        registered: usize,
        failed: Vec<String>,
    },
    /// The license forbids polling the configured I/O channels.
    IoBudgetExceeded { configured: usize, cap: usize },
}

impl DegradedReason {
    /// Stable machine-readable code (health view, cloud report).
    pub fn code(&self) -> &'static str {
        match self {
            Self::BackendUnavailable { backend, .. } => match backend {
                Backend::Gpio => "gpio-backend-unavailable",
                Backend::I2c => "i2c-backend-unavailable",
                Backend::Spi => "spi-backend-unavailable",
                Backend::Pwm => "pwm-backend-unavailable",
            },
            Self::SafeStateIncomplete { .. } => "safe-state-incomplete",
            Self::IoBudgetExceeded { .. } => "io-budget-exceeded",
        }
    }

    /// Human-readable detail.
    pub fn detail(&self) -> String {
        match self {
            Self::BackendUnavailable { detail, .. } => detail.clone(),
            Self::SafeStateIncomplete { registered, failed } => format!(
                "{} of {} registered outputs could not be driven to their safe state: {}",
                failed.len(),
                registered,
                failed.join("; ")
            ),
            Self::IoBudgetExceeded { configured, cap } => format!(
                "{configured} configured I/O channels exceed the license cap of {cap}; \
                 inputs are not polled"
            ),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct ReasonView {
    code: &'static str,
    detail: String,
}

/// The boot safe-state outcome, as reported.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SafeStateSummary {
    pub registered: usize,
    pub applied: usize,
    pub failed: usize,
}

/// Where the run is.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Before READY: hardware init and boot safe-state.
    Starting,
    /// READY sent: outputs safe, local loop running.
    Running,
    /// Shutdown sequence (safe-state, flush).
    Stopping,
}

#[derive(Debug)]
struct View {
    phase: Phase,
    reasons: Vec<DegradedReason>,
    safe_state: Option<SafeStateSummary>,
    liveness: Option<Verdict>,
    write_failed: bool,
}

#[derive(Debug)]
struct Shared {
    control_disabled: AtomicBool,
    generation: AtomicU64,
    view: Mutex<View>,
    health_file: PathBuf,
}

/// The agent's degraded-mode state (one per process, held in `AppState`).
#[derive(Debug, Clone)]
pub struct DegradedMode {
    shared: Arc<Shared>,
}

/// Refuses actuator writes while the agent is degraded. Cloned into every
/// hardware handle at construction; there is no handle without one.
#[derive(Debug, Clone)]
pub struct ControlGate {
    shared: Arc<Shared>,
}

/// The write was refused: control is disabled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlDisabled {
    reasons: Vec<&'static str>,
}

impl std::fmt::Display for ControlDisabled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "control is disabled: the agent is in degraded mode ({}); outputs are held in \
             their safe state (ADR-048 DEC-6.3)",
            self.reasons.join(", ")
        )
    }
}

impl std::error::Error for ControlDisabled {}

impl ControlGate {
    /// `Ok` while control is enabled.
    pub fn permit(&self) -> Result<(), ControlDisabled> {
        if self.shared.control_disabled.load(Ordering::Acquire) {
            Err(ControlDisabled {
                reasons: lock(&self.shared.view)
                    .reasons
                    .iter()
                    .map(DegradedReason::code)
                    .collect(),
            })
        } else {
            Ok(())
        }
    }
}

fn lock(view: &Mutex<View>) -> std::sync::MutexGuard<'_, View> {
    match view.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

impl DegradedMode {
    /// A fresh, non-degraded state that publishes its health view to
    /// `health_file` (`AgentPaths::agent_health_file`).
    pub fn new(health_file: PathBuf) -> Self {
        Self {
            shared: Arc::new(Shared {
                control_disabled: AtomicBool::new(false),
                generation: AtomicU64::new(0),
                view: Mutex::new(View {
                    phase: Phase::Starting,
                    reasons: Vec::new(),
                    safe_state: None,
                    liveness: None,
                    write_failed: false,
                }),
                health_file,
            }),
        }
    }

    /// The gate handed to the hardware handles.
    pub fn control_gate(&self) -> ControlGate {
        ControlGate {
            shared: self.shared.clone(),
        }
    }

    /// Enter (or stay in) degraded mode for `reason`. Latched for the run.
    pub fn enter(&self, reason: DegradedReason) {
        // Disable control first, so no write slips in while the report is
        // being written.
        self.shared.control_disabled.store(true, Ordering::Release);
        error!(
            "ALARM agent-degraded [{}]: {} — control disabled, outputs held in their safe \
             state, process stays up (ADR-048 DEC-6.3)",
            reason.code(),
            reason.detail()
        );
        self.update(|v| {
            if !v.reasons.contains(&reason) {
                v.reasons.push(reason);
            }
        });
    }

    /// `true` once degraded mode was entered.
    pub fn is_degraded(&self) -> bool {
        self.shared.control_disabled.load(Ordering::Acquire)
    }

    /// The reasons, in the order they arose.
    pub fn reasons(&self) -> Vec<DegradedReason> {
        lock(&self.shared.view).reasons.clone()
    }

    /// Record the boot safe-state outcome.
    pub fn record_safe_state(&self, summary: SafeStateSummary) {
        self.update(|v| v.safe_state = Some(summary));
    }

    /// Record the run phase.
    pub fn set_phase(&self, phase: Phase) {
        self.update(|v| v.phase = phase);
    }

    /// Record the latest liveness verdict.
    pub fn set_liveness(&self, verdict: Verdict) {
        self.update(|v| v.liveness = Some(verdict));
    }

    /// Changes on every update; the liveness supervisor resends `STATUS=`
    /// when it moves.
    pub fn generation(&self) -> u64 {
        self.shared.generation.load(Ordering::Acquire)
    }

    /// The `STATUS=` line for systemd.
    pub fn status_line(&self) -> String {
        let v = lock(&self.shared.view);
        status_line(&v, self.is_degraded())
    }

    /// The health view document.
    pub fn health_document(&self) -> serde_json::Value {
        let v = lock(&self.shared.view);
        document(&v, self.is_degraded())
    }

    /// The cloud report merged into the status payload.
    pub fn cloud_report(&self) -> serde_json::Value {
        let v = lock(&self.shared.view);
        serde_json::json!({
            "degraded": self.is_degraded(),
            "degraded_reasons": reason_views(&v.reasons),
            "safe_state": v.safe_state,
        })
    }

    fn update(&self, change: impl FnOnce(&mut View)) {
        let mut v = lock(&self.shared.view);
        change(&mut v);
        self.shared.generation.fetch_add(1, Ordering::AcqRel);
        let doc = document(&v, self.is_degraded());
        // The write happens under the lock, so two updates cannot interleave
        // their documents.
        match write_atomic(&self.shared.health_file, &doc) {
            Ok(()) => v.write_failed = false,
            Err(e) => {
                if !v.write_failed {
                    warn!(
                        "Agent health view {} could not be written: {} (the OS health gate \
                         reads an unreadable view as degraded)",
                        self.shared.health_file.display(),
                        e
                    );
                }
                v.write_failed = true;
            }
        }
    }
}

fn reason_views(reasons: &[DegradedReason]) -> Vec<ReasonView> {
    reasons
        .iter()
        .map(|r| ReasonView {
            code: r.code(),
            detail: r.detail(),
        })
        .collect()
}

fn status_line(v: &View, degraded: bool) -> String {
    if degraded {
        let codes: Vec<&str> = v.reasons.iter().map(DegradedReason::code).collect();
        return format!(
            "degraded: control disabled, outputs held safe ({})",
            codes.join(", ")
        );
    }
    match v.phase {
        Phase::Starting => "starting: hardware init and boot safe-state".to_string(),
        Phase::Stopping => "stopping: driving outputs to their safe state".to_string(),
        Phase::Running => match &v.safe_state {
            Some(s) => format!(
                "running: {}/{} outputs driven safe at boot, control enabled",
                s.applied, s.registered
            ),
            None => "running: control enabled".to_string(),
        },
    }
}

fn document(v: &View, degraded: bool) -> serde_json::Value {
    serde_json::json!({
        "schema": HEALTH_SCHEMA,
        "agent_version": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
        "phase": v.phase,
        "degraded": degraded,
        "control": if degraded { "disabled" } else { "enabled" },
        "reasons": reason_views(&v.reasons),
        "safe_state": v.safe_state,
        "loops": v.liveness,
        "status": status_line(v, degraded),
        "updated_at": chrono::Utc::now().to_rfc3339(),
    })
}

/// Write `doc` to `path` atomically: a temporary file in the same directory,
/// then `rename(2)`. A reader sees the old or the new document, never a part.
fn write_atomic(path: &Path, doc: &serde_json::Value) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "health file has no parent",
        )
    })?;
    std::fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(doc).map_err(std::io::Error::other)?;
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&bytes)?;
        f.write_all(b"\n")?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // contract mutable-state.json: /run/suderra/agent-health file_mode 0640
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o640))?;
    }
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use crate::liveness::{Liveness, LoopId};

    fn read(path: &Path) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(path).expect("health file")).expect("json")
    }

    #[test]
    fn a_fresh_agent_is_not_degraded_and_control_is_permitted() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("agent-health").join("health.json");
        let d = DegradedMode::new(file.clone());
        assert!(!d.is_degraded());
        assert!(d.control_gate().permit().is_ok());
        d.set_phase(Phase::Running);
        let doc = read(&file);
        assert_eq!(doc["schema"], HEALTH_SCHEMA);
        assert_eq!(doc["degraded"], false);
        assert_eq!(doc["control"], "enabled");
        assert_eq!(doc["phase"], "running");
    }

    #[test]
    fn entering_degraded_mode_disables_control_and_reports_it() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("health.json");
        let d = DegradedMode::new(file.clone());
        let gate = d.control_gate();
        let generation = d.generation();
        d.enter(DegradedReason::BackendUnavailable {
            backend: Backend::Gpio,
            detail: BackendNotCompiled(Backend::Gpio).to_string(),
        });
        assert!(d.is_degraded());
        assert!(d.generation() > generation);
        let refused = gate.permit().unwrap_err();
        assert!(refused.to_string().contains("gpio-backend-unavailable"));
        // The OS health gate reads exactly this member.
        let doc = read(&file);
        assert_eq!(doc["degraded"], true);
        assert_eq!(doc["control"], "disabled");
        assert_eq!(doc["reasons"][0]["code"], "gpio-backend-unavailable");
        assert!(d.status_line().starts_with("degraded: "));
        // Re-entering for the same reason does not duplicate it; latched.
        d.enter(DegradedReason::BackendUnavailable {
            backend: Backend::Gpio,
            detail: BackendNotCompiled(Backend::Gpio).to_string(),
        });
        assert_eq!(d.reasons().len(), 1);
        let report = d.cloud_report();
        assert_eq!(report["degraded"], true);
    }

    #[test]
    fn partial_safe_state_reason_lists_the_failed_outputs() {
        let r = DegradedReason::SafeStateIncomplete {
            registered: 3,
            failed: vec!["coil plc/12: timeout".into()],
        };
        assert_eq!(r.code(), "safe-state-incomplete");
        assert!(r.detail().starts_with("1 of 3 registered outputs"));
    }

    #[test]
    fn liveness_is_part_of_the_health_view() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("health.json");
        let d = DegradedMode::new(file.clone());
        let l = Liveness::new();
        let hb = l.register(LoopId::IoPoll);
        hb.tick();
        d.set_liveness(l.verdict(std::time::Duration::from_secs(30)));
        let doc = read(&file);
        assert_eq!(doc["loops"]["live"], true);
        assert_eq!(doc["loops"]["loops"][0]["loop"], "io_poll");
    }

    #[test]
    fn an_unwritable_view_does_not_stop_degraded_mode() {
        let d = DegradedMode::new(PathBuf::from("/proc/suderra-no-such-dir/health.json"));
        d.enter(DegradedReason::IoBudgetExceeded {
            configured: 9,
            cap: 8,
        });
        assert!(d.is_degraded());
        assert!(d.control_gate().permit().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn health_file_mode_is_0640() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("health.json");
        let d = DegradedMode::new(file.clone());
        d.set_phase(Phase::Running);
        let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
    }
}
