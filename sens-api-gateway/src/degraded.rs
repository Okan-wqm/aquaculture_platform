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
    /// The RevPi process image behind `/dev/piControl0` (ADR-048 DEC-8.8).
    PiControl,
}

impl Backend {
    pub fn name(self) -> &'static str {
        match self {
            Self::Gpio => "gpio",
            Self::I2c => "i2c",
            Self::Spi => "spi",
            Self::Pwm => "pwm",
            Self::PiControl => "picontrol",
        }
    }

    /// The cargo feature that compiles this backend's driver.
    pub fn feature(self) -> &'static str {
        match self {
            Self::Gpio | Self::I2c | Self::Spi | Self::Pwm => "gpio",
            Self::PiControl => "revpi-io",
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
             `{}` feature or not for Linux); the backend is unavailable and the agent \
             runs in degraded mode (ADR-048 DEC-6.3)",
            self.0.name(),
            self.0.name(),
            self.0.feature()
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
    /// The configuration is not verified (ADR-048 DEC-4.10: Suderra OS site
    /// trust; generic profile: config-integrity in Enforcing mode). The agent
    /// is in standby: it touches no output, opens no network connection and
    /// retries; this is the one reason that clears, because nothing acted on
    /// the unverified configuration.
    ConfigUnverified { detail: String },
    /// A store or service of the full operation failed after the boot
    /// safe-state (EDGE-MEDIUM-078): the outputs are safe, and the agent runs
    /// no network, command plane or local server on a half-initialized
    /// security posture.
    BootDependencyFailed {
        component: &'static str,
        detail: String,
    },
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
                // The health vocabulary of contract 1.2.0 (agent-health
                // `reasons[].code`) has no code for the piControl backend, and
                // this crate may not widen it. A piControl device that is
                // absent, refused or does not match the signed config.rsc is a
                // dependency of the full operation that failed at boot, which is
                // what `boot-dependency-failed` says; the detail names piControl.
                // CONTRACT GAP: `picontrol-backend-unavailable` is the code a
                // contract revision should add; the agent then returns it here.
                Backend::PiControl => "boot-dependency-failed",
            },
            Self::SafeStateIncomplete { .. } => "safe-state-incomplete",
            Self::IoBudgetExceeded { .. } => "io-budget-exceeded",
            Self::ConfigUnverified { .. } => "config-unverified",
            Self::BootDependencyFailed { .. } => "boot-dependency-failed",
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
            Self::ConfigUnverified { detail } => detail.clone(),
            Self::BootDependencyFailed { component, detail } => format!(
                "{component} failed after the boot safe-state: {detail}; no network, command \
                 plane or local server is started"
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
    /// Before READY, before any output is touched: waiting for a verified
    /// configuration (`EXTEND_TIMEOUT_USEC`, no READY).
    Standby,
    /// Before READY: hardware init and boot safe-state.
    Starting,
    /// READY sent: outputs safe, local loop running.
    Running,
    /// Shutdown sequence (safe-state, flush).
    Stopping,
}

/// What stops root from starting an `edge-update`, an `os-update` or a
/// `site-config` right now (ADR-048 DEC-13.4, contract `channels.json`
/// `update_channel.maintenance.blockers`): an alarm that is active, an output
/// that holds a forced value. Only a running control loop can hold either, so
/// it is the agent that reports them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct UpdateBlockers {
    /// An alarm is active.
    pub active_alarm: bool,
    /// An output holds a forced value.
    pub forced_output: bool,
}

impl UpdateBlockers {
    /// The members of `update_blockers` in the health view: the contract's
    /// two-value vocabulary, unique by construction.
    pub fn names(self) -> Vec<&'static str> {
        let mut names = Vec::new();
        if self.active_alarm {
            names.push("active-alarm");
        }
        if self.forced_output {
            names.push("forced-output");
        }
        names
    }
}

#[derive(Debug)]
struct View {
    phase: Phase,
    reasons: Vec<DegradedReason>,
    safe_state: Option<SafeStateSummary>,
    liveness: Option<Verdict>,
    update_blockers: UpdateBlockers,
    write_failed: bool,
}

#[derive(Debug)]
struct Shared {
    control_disabled: AtomicBool,
    /// The device-wide emergency stop (ADR-048 DEC-9.7). It lives in the
    /// state the gate shares so that every hardware handle, each of which
    /// carries a gate, refuses actuator writes while it is latched.
    emergency: crate::emergency::EmergencyLatch,
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

/// The write was refused: control is disabled, by degraded mode or by the
/// emergency stop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlDisabled {
    reasons: Vec<&'static str>,
    emergency_stop: bool,
}

impl ControlDisabled {
    /// The emergency stop is what refused the write.
    pub fn is_emergency_stop(&self) -> bool {
        self.emergency_stop
    }
}

impl std::fmt::Display for ControlDisabled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.emergency_stop {
            f.write_str(
                "the emergency stop is latched: outputs are held in their safe state until an \
                 authenticated reset (ADR-048 DEC-9.7)",
            )
        } else {
            write!(
                f,
                "control is disabled: the agent is in degraded mode ({}); outputs are held in \
                 their safe state (ADR-048 DEC-6.3)",
                self.reasons.join(", ")
            )
        }
    }
}

impl std::error::Error for ControlDisabled {}

impl ControlGate {
    /// `Ok` while control is enabled and no emergency stop is latched.
    pub fn permit(&self) -> Result<(), ControlDisabled> {
        if self.shared.emergency.is_latched() {
            return Err(ControlDisabled {
                reasons: Vec::new(),
                emergency_stop: true,
            });
        }
        if self.shared.control_disabled.load(Ordering::Acquire) {
            Err(ControlDisabled {
                reasons: lock(&self.shared.view)
                    .reasons
                    .iter()
                    .map(DegradedReason::code)
                    .collect(),
                emergency_stop: false,
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
                emergency: crate::emergency::EmergencyLatch::volatile(),
                generation: AtomicU64::new(0),
                view: Mutex::new(View {
                    phase: Phase::Starting,
                    reasons: Vec::new(),
                    safe_state: None,
                    liveness: None,
                    update_blockers: UpdateBlockers::default(),
                    write_failed: false,
                }),
                health_file,
            }),
        }
    }

    /// The emergency-stop latch this state's gate refuses writes on. The agent
    /// attaches its durable store to it at boot, before any hardware is
    /// initialised.
    pub fn emergency(&self) -> crate::emergency::EmergencyLatch {
        self.shared.emergency.clone()
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

    /// Standby: the configuration is not verified, so nothing has acted on
    /// it — no hardware handle exists and no output was touched. Replaces
    /// the previous standby reason (a retry may fail differently); the alarm
    /// line is logged only when the reason changes.
    pub fn enter_standby(&self, reason: DegradedReason) {
        self.shared.control_disabled.store(true, Ordering::Release);
        let mut changed = false;
        self.update(|v| {
            v.phase = Phase::Standby;
            let previous: Vec<DegradedReason> = v
                .reasons
                .iter()
                .filter(|r| matches!(r, DegradedReason::ConfigUnverified { .. }))
                .cloned()
                .collect();
            changed = previous != [reason.clone()];
            v.reasons
                .retain(|r| !matches!(r, DegradedReason::ConfigUnverified { .. }));
            v.reasons.push(reason.clone());
        });
        if changed {
            error!(
                "ALARM agent-standby [{}]: {} — no output touched, no network; retrying \
                 (ADR-048 DEC-4.10, DEC-6.3)",
                reason.code(),
                reason.detail()
            );
        }
    }

    /// The configuration verified: leave standby for the boot (hardware
    /// init and safe-state). Only the standby reason clears; control stays
    /// disabled if any other reason exists.
    pub fn leave_standby(&self) {
        self.update(|v| {
            v.phase = Phase::Starting;
            v.reasons
                .retain(|r| !matches!(r, DegradedReason::ConfigUnverified { .. }));
            self.shared
                .control_disabled
                .store(!v.reasons.is_empty(), Ordering::Release);
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

    /// Publish the current update blockers and rewrite the view, whether or not
    /// anything changed: root treats a view that is not rewritten at least
    /// every `refresh_seconds` as stale, because a view written only on change
    /// cannot prove it is current (`channels.json`).
    pub fn refresh(&self, blockers: UpdateBlockers) {
        self.update(|v| v.update_blockers = blockers);
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
    if v.phase == Phase::Standby {
        let codes: Vec<&str> = v.reasons.iter().map(DegradedReason::code).collect();
        return format!(
            "standby: waiting for a verified configuration, no output touched ({})",
            codes.join(", ")
        );
    }
    if degraded {
        let codes: Vec<&str> = v.reasons.iter().map(DegradedReason::code).collect();
        return format!(
            "degraded: control disabled, outputs held safe ({})",
            codes.join(", ")
        );
    }
    match v.phase {
        Phase::Standby | Phase::Starting => {
            "starting: hardware init and boot safe-state".to_string()
        }
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
        "update_blockers": v.update_blockers.names(),
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

/// How often the health view is rewritten while the agent runs: well inside
/// the contract's 15 s `refresh_seconds`, so a missed tick does not make the
/// view stale (60 s) in root's eyes.
pub const HEALTH_REFRESH: std::time::Duration = std::time::Duration::from_secs(5);

/// What blocks an update now, read from the agent's live state.
pub async fn update_blockers_of(state: &crate::AppState) -> UpdateBlockers {
    #[allow(unused_mut)]
    let mut active_alarm = state.alarm_manager.read().await.active_count() > 0;
    #[cfg(feature = "scada-display")]
    if !active_alarm && let Some(scada) = &state.scada_state {
        active_alarm = scada.active_alarm_count().await > 0;
    }
    UpdateBlockers {
        active_alarm,
        forced_output: state.force_registry.active_count().await > 0,
    }
}

/// Rewrite the health view every [`HEALTH_REFRESH`] with the blockers of the
/// moment, until shutdown. It runs in every mode (degraded included): an
/// active agent that says nothing blocks every update (the gate cannot tell
/// that no alarm is active).
pub async fn run_health_refresh(
    state: std::sync::Arc<tokio::sync::RwLock<crate::AppState>>,
    interval: std::time::Duration,
    mut shutdown: tokio::sync::broadcast::Receiver<()>,
) {
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            biased;
            _ = shutdown.recv() => break,
            _ = ticker.tick() => {}
        }
        let (degraded, blockers) = {
            let s = state.read().await;
            (s.degraded.clone(), update_blockers_of(&s).await)
        };
        degraded.refresh(blockers);
    }
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
    fn standby_reports_and_clears_without_latching() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("health.json");
        let d = DegradedMode::new(file.clone());
        d.enter_standby(DegradedReason::ConfigUnverified {
            detail: "site-config rejected: not-yet-valid".into(),
        });
        assert!(d.is_degraded());
        assert!(d.control_gate().permit().is_err());
        let doc = read(&file);
        assert_eq!(doc["phase"], "standby");
        assert_eq!(doc["degraded"], true);
        assert_eq!(doc["reasons"][0]["code"], "config-unverified");
        assert!(d.status_line().starts_with("standby: "));
        // A retry that fails differently replaces the reason.
        d.enter_standby(DegradedReason::ConfigUnverified {
            detail: "trust anchors missing".into(),
        });
        assert_eq!(d.reasons().len(), 1);
        d.leave_standby();
        assert!(!d.is_degraded());
        assert!(d.control_gate().permit().is_ok());
        assert_eq!(read(&file)["phase"], "starting");
        // Other reasons stay latched.
        d.enter(DegradedReason::IoBudgetExceeded {
            configured: 9,
            cap: 8,
        });
        d.leave_standby();
        assert!(d.is_degraded());
    }

    #[test]
    fn a_boot_dependency_failure_names_its_component() {
        let r = DegradedReason::BootDependencyFailed {
            component: "offline-queue",
            detail: "mkdir failed".into(),
        };
        assert_eq!(r.code(), "boot-dependency-failed");
        assert!(
            r.detail()
                .starts_with("offline-queue failed after the boot safe-state")
        );
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

    #[test]
    fn the_picontrol_backend_reports_a_code_the_contract_defines() {
        // contracts/suderra-edge/v1/schemas/agent-health.schema.json
        // `reasons[].code` has no piControl code: the nearest the contract
        // defines is a boot dependency that failed. The detail names piControl.
        let r = DegradedReason::BackendUnavailable {
            backend: Backend::PiControl,
            detail: "piControl is absent".into(),
        };
        assert_eq!(r.code(), "boot-dependency-failed");
        assert_eq!(r.detail(), "piControl is absent");
        assert_eq!(Backend::PiControl.feature(), "revpi-io");
        assert!(
            BackendNotCompiled(Backend::PiControl)
                .to_string()
                .contains("`revpi-io` feature")
        );
        assert!(
            BackendNotCompiled(Backend::Gpio)
                .to_string()
                .contains("`gpio` feature")
        );
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
mod update_blockers_tests {
    use super::*;

    fn contract_schema() -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../contracts/suderra-edge/v1/schemas/agent-health.schema.json");
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    fn degraded() -> (tempfile::TempDir, DegradedMode) {
        let dir = tempfile::tempdir().unwrap();
        let mode = DegradedMode::new(dir.path().join("health.json"));
        (dir, mode)
    }

    /// ADR-048 DEC-13.4: the view carries every member the contract requires,
    /// `update_blockers` included (an agent that omitted it looked unavailable
    /// to root's maintenance gate and blocked every update while it ran).
    #[test]
    fn the_view_carries_every_member_the_contract_requires() {
        let schema = contract_schema();
        let (_dir, mode) = degraded();
        let doc = mode.health_document();
        for member in schema["required"].as_array().unwrap() {
            let member = member.as_str().unwrap();
            assert!(
                doc.get(member).is_some(),
                "the health view lacks `{member}`"
            );
        }
        assert_eq!(doc["update_blockers"], serde_json::json!([]));
    }

    #[test]
    fn the_blockers_use_the_contracts_vocabulary_and_are_unique() {
        let schema = contract_schema();
        let vocabulary: Vec<&str> = schema["properties"]["update_blockers"]["items"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        let (_dir, mode) = degraded();
        for (blockers, expected) in [
            (UpdateBlockers::default(), vec![]),
            (
                UpdateBlockers {
                    active_alarm: true,
                    forced_output: false,
                },
                vec!["active-alarm"],
            ),
            (
                UpdateBlockers {
                    active_alarm: false,
                    forced_output: true,
                },
                vec!["forced-output"],
            ),
            (
                UpdateBlockers {
                    active_alarm: true,
                    forced_output: true,
                },
                vec!["active-alarm", "forced-output"],
            ),
        ] {
            mode.refresh(blockers);
            let doc = mode.health_document();
            let names: Vec<&str> = doc["update_blockers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap())
                .collect();
            assert_eq!(names, expected);
            for name in names {
                assert!(vocabulary.contains(&name), "{name} is not in the contract");
            }
        }
    }

    /// A refresh rewrites the view with a new `updated_at` even when nothing
    /// changed: a view written only on change cannot prove it is current.
    #[test]
    fn a_refresh_rewrites_the_view_even_when_nothing_changed() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("health.json");
        let mode = DegradedMode::new(file.clone());
        mode.refresh(UpdateBlockers::default());
        let first = std::fs::read_to_string(&file).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        mode.refresh(UpdateBlockers::default());
        let second = std::fs::read_to_string(&file).unwrap();
        assert_ne!(first, second, "the `updated_at` moved");
        let at = |text: &str| {
            let doc: serde_json::Value = serde_json::from_str(text).unwrap();
            chrono::DateTime::parse_from_rfc3339(doc["updated_at"].as_str().unwrap()).unwrap()
        };
        assert!(at(&second) > at(&first));
    }

    /// The refresh interval is well inside the contract's.
    #[test]
    fn the_refresh_interval_is_inside_the_contracts() {
        let channels: serde_json::Value = serde_json::from_slice(
            &std::fs::read(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../contracts/suderra-edge/v1/channels.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let view = &channels["update_channel"]["maintenance"]["blockers"]["health_view"];
        let refresh = view["refresh_seconds"].as_u64().unwrap();
        let max_age = view["max_age_seconds"].as_u64().unwrap();
        assert!(HEALTH_REFRESH.as_secs() < refresh);
        assert!(refresh < max_age);
    }

    /// What blocks an update is read from the live state: an alarm that needs
    /// attention, a forced output.
    #[tokio::test]
    async fn the_blockers_are_read_from_the_live_alarms_and_forces() {
        let config: crate::config::AgentConfig = serde_yaml::from_str(
            "device_id: \"dev-1\"\ndevice_code: \"EDGE-1\"\napi_url: \"https://api.example.test\"\n\
             mqtt:\n  port: 8883\n",
        )
        .unwrap();
        let state = crate::AppState::new(config);
        assert_eq!(update_blockers_of(&state).await, UpdateBlockers::default());

        {
            let mut alarms = state.alarm_manager.write().await;
            alarms.register(crate::alarms::AlarmDefinition::high_limit(
                "tank-high",
                "tank",
                10.0,
            ));
            alarms.process_value("tank-high", 12.0);
        }
        assert_eq!(
            update_blockers_of(&state).await,
            UpdateBlockers {
                active_alarm: true,
                forced_output: false
            }
        );

        state
            .force_registry
            .apply(
                "pump".into(),
                1.0,
                crate::process_image::TagQuality::Good,
                "operator".into(),
                "maintenance".into(),
                60,
                false,
                &crate::runtime_safety::system_clock::SystemClockAuthority::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            update_blockers_of(&state).await,
            UpdateBlockers {
                active_alarm: true,
                forced_output: true
            }
        );
    }
}
