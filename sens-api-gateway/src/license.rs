//! Edge license tier enforcement (Faz 7 / plan R-10).
//!
//! ## WHY
//!
//! Plan §3 R-10 + plan §5 Faz 7 specify per-tenant license
//! tier enforcement at the edge:
//! - STARTER / PROFESSIONAL / ENTERPRISE / CUSTOM tiers
//!   with per-tier limits on resource usage.
//! - Offline grace period: 30 days of cached tier after
//!   cloud unreachability; then conservative() STARTER
//!   fallback.
//! - License source: cloud-signed ed25519 manifest
//!   (reuses the Batch 114 firmware signing key ceremony
//!   per plan R-10 refinement — "single crypto
//!   primitive → code path reduction, rotation unified").
//!
//! ## Scope of Batch 140
//!
//! - `EdgeLicenseLimits` struct with all per-tier caps.
//! - `conservative()` STARTER fallback constructor.
//! - `LicenseTier` enum + stable wire tag for audit.
//! - Serde (de)serialization via serde_json (matches
//!   cloud manifest transport).
//!
//! ## NOT in scope for Batch 140
//!
//! - Fetch path (HTTPS GET
//!   `/billing/edge-license/:tenantId`) — Faz 8
//!   platform-side work.
//! - Signature verification (reuses Batch 114 pubkey +
//!   verify_firmware_manifest-style closure injection) —
//!   Batch 141.
//! - Enforcement hooks at cmd_deploy_program, io_poll,
//!   task_scheduler, opc_ua_server, force_value,
//!   watch_subscribe, signature_mode — Batches 142+.
//! - SQLCipher-backed `license_cache` persistence for
//!   offline grace — Batch 143.
//!
//! As of Batch 142, cmd_deploy_program is the first
//! enforcement consumer (FB instance cap + scan cycle
//! floor). Further enforcement hooks land at io_poll,
//! task_scheduler, opc_ua_server, watch_subscribe,
//! force_value, signature_mode in subsequent batches;
//! the verify primitive + SignedLicenseManifest types
//! stay dead-code-allowed at item level until Batch
//! 143 wires the fetch path that consumes them.

use serde::{Deserialize, Serialize};

/// Canonical license tiers. Matches plan R-10 + Faz 7
/// STARTER/PROFESSIONAL/ENTERPRISE/CUSTOM four-variant
/// taxonomy. Operator dashboards + cloud reconciliation
/// pivot on these string identifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LicenseTier {
    /// Most restrictive tier. Default fallback when the
    /// license cache is empty + cloud unreachable beyond
    /// the grace period. Suitable for evaluation devices
    /// + small installations.
    #[default]
    Starter,
    /// Mid-tier. Most commercial deployments.
    Professional,
    /// Multi-site / multi-tenant fleets.
    Enterprise,
    /// Bespoke contract terms. Limits negotiated per-
    /// tenant + stored as-is in the signed license.
    Custom,
}

impl LicenseTier {
    /// Stable 1-byte discriminator for the audit-log +
    /// Prometheus dashboard label set. Keep stable across
    /// releases (downstream dashboards key on these).
    pub const fn wire_tag(self) -> u8 {
        match self {
            Self::Starter => 0,
            Self::Professional => 1,
            Self::Enterprise => 2,
            Self::Custom => 3,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Starter => "starter",
            Self::Professional => "professional",
            Self::Enterprise => "enterprise",
            Self::Custom => "custom",
        }
    }
}

/// Per-device license limits (Faz 7 Batch 140).
///
/// Every enforcement hook (Batch 142+ per-feature wires)
/// reads a field from this struct to decide accept /
/// reject. Adding a new limit is an additive change
/// here + one new enforcement site; never add a limit
/// without the matching enforcement (tier-3 make-it-
/// detectable — an unused limit is dead config that
/// operators tune without effect).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EdgeLicenseLimits {
    /// Tier identifier for operator / dashboard display.
    pub tier: LicenseTier,

    /// Expiry timestamp (UNIX seconds). After this the
    /// license fetch path MUST re-request from cloud +
    /// on failure MUST fall through to conservative()
    /// STARTER tier.
    pub valid_until_unix_secs: i64,

    /// Max total IO channels (sum across modbus + GPIO +
    /// I2C + SPI + PWM). Enforced at io_poll boot: exceed
    /// = task doesn't start + CRITICAL alarm + conservative
    /// tier-policy subset runs. Batch 142.
    pub max_io_channels: u32,

    /// Max function block instances across all loaded
    /// scripts. Enforced at cmd_deploy_program: reject
    /// deploy if post-deploy FB count would exceed.
    pub max_fb_instances: u32,

    /// Minimum scan cycle (ms). Enforced at
    /// cmd_deploy_program: reject if declared scan_cycle
    /// is below this floor. Lower cycle = higher
    /// hardware load = paid-tier only.
    pub min_scan_cycle_ms: u32,

    /// Max ST bytecode programs loadable simultaneously.
    /// Enforced at cmd_deploy_program.
    pub max_st_programs: u32,

    /// Max concurrent tasks in the multi-task scheduler
    /// (Faz 4). Enforced at task_scheduler boot.
    pub max_concurrent_tasks: u32,

    /// Max active watch_subscribe sessions (Faz 6 live-
    /// debug). Enforced at cmd_watch_subscribe.
    pub max_watch_sessions: u32,

    /// Max concurrent force-value entries in
    /// ForceRegistry (Faz 6). Enforced at
    /// cmd_force_value.
    pub max_concurrent_forces: u32,

    /// When true, all incoming mutating commands MUST
    /// carry a valid ed25519 signature (signature_mode
    /// cannot be Disabled). STARTER tier leaves this
    /// false for dev-ergonomics; ENTERPRISE tier
    /// requires it for SL-2 compliance.
    pub signed_deploy_required: bool,

    /// When true, the OPC UA server (Faz 5) is allowed
    /// to start. Gated per-tier because OPC UA is a
    /// commercial-interop feature + ENTERPRISE-only
    /// pre-GA.
    pub opc_ua_server_enabled: bool,
}

impl EdgeLicenseLimits {
    /// Conservative STARTER fallback.
    ///
    /// Returned when:
    /// - First boot + no license cache.
    /// - Cloud fetch failed + 30-day offline grace
    ///   elapsed.
    /// - License signature verification failed
    ///   (operator tampering / key rotation error).
    ///
    /// Limits are the most restrictive across all tiers
    /// to avoid unintentional over-provisioning during
    /// fallback. Operator sees the `tier=Starter` in
    /// dashboards + investigates.
    pub fn conservative() -> Self {
        Self {
            tier: LicenseTier::Starter,
            // 0 expiry → enforcement hooks always treat
            // as "re-verify required" if they check
            // freshness. Safe for fallback because the
            // limits themselves are restrictive.
            valid_until_unix_secs: 0,
            max_io_channels: 16,
            max_fb_instances: 8,
            // Min scan cycle 5000ms = 5s. Sufficient for
            // evaluation + small installations; paid
            // tiers drop to sub-second.
            min_scan_cycle_ms: 5_000,
            max_st_programs: 2,
            max_concurrent_tasks: 1,
            max_watch_sessions: 1,
            max_concurrent_forces: 0,
            signed_deploy_required: false,
            opc_ua_server_enabled: false,
        }
    }

    /// Check whether this license is stale by the given
    /// `now_unix_secs`. `false` means fetchable; `true`
    /// means operator must re-acquire OR conservative()
    /// fallback must fire.
    pub fn is_expired(&self, now_unix_secs: i64) -> bool {
        now_unix_secs > self.valid_until_unix_secs
    }
}

impl Default for EdgeLicenseLimits {
    fn default() -> Self {
        Self::conservative()
    }
}

/// Consistency-check result between a license's
/// `signed_deploy_required` flag + the agent's
/// `signature_mode` runtime setting (Batch 146 Faz 7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignatureModeConsistency {
    /// License does not require signed deploys — any
    /// signature_mode is acceptable.
    LicenseDoesNotRequireSignedDeploy,
    /// License requires signed deploys + operator config
    /// is Permissive or Enforcing — consistent.
    Consistent,
    /// License requires signed deploys but operator
    /// config has signature_mode=Disabled. Plan Faz 7
    /// specifies CRITICAL boot log + alarm — the
    /// license contract is violated by the static
    /// config. Operator MUST flip signature_mode to
    /// Permissive or Enforcing.
    CriticalMismatchDisabledSignatureMode,
}

/// Count configured IO channels across all protocols
/// (Batch 147 Faz 7). Operator-visible granularity:
/// each configured modbus device counts as 1, each GPIO
/// pin counts as 1, each I2C device counts as 1. Matches
/// the "number of things wired to the edge" operator
/// mental model + the license-tier `max_io_channels`
/// field's semantic.
///
/// PWM + SPI channels are counted when their config
/// surfaces land in future batches (Faz 4/5 polling
/// integrations).
pub fn count_configured_io_channels(config: &crate::config::AgentConfig) -> usize {
    config.modbus.len() + config.gpio.len() + config.i2c.len()
}

/// IO channel budget check result (Batch 147 Faz 7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IoChannelBudget {
    /// Configured count within license cap.
    WithinBudget { configured: usize, cap: usize },
    /// Configured count exceeds license cap. Plan Faz 7
    /// discipline: io_poll task does NOT start +
    /// CRITICAL log + operator sees via dashboard.
    Exceeded { configured: usize, cap: usize },
}

/// Check whether configured IO channels fit within the
/// license's `max_io_channels` cap.
///
/// Pure function — testable without AppState fixtures.
/// Returns a structured enum so the caller can route:
/// - io_poll boot decision (start / refuse)
/// - CRITICAL boot log emission
/// - operator-dashboard metric
pub fn check_io_channel_budget(
    config: &crate::config::AgentConfig,
    license: &EdgeLicenseLimits,
) -> IoChannelBudget {
    let configured = count_configured_io_channels(config);
    let cap = license.max_io_channels as usize;
    if configured > cap {
        IoChannelBudget::Exceeded { configured, cap }
    } else {
        IoChannelBudget::WithinBudget { configured, cap }
    }
}

/// Check whether the license's `signed_deploy_required`
/// contract is consistent with the agent's
/// `signature_mode` runtime setting.
///
/// Returns a structured result enum so the caller can
/// route:
/// - boot log emission
/// - Prometheus metric label
/// - operator audit-trail classification
///
/// Pure function — testable without AppState fixtures.
pub fn check_signature_mode_consistency(
    license: &EdgeLicenseLimits,
    signature_mode: crate::command_envelope::envelope::SignatureMode,
) -> SignatureModeConsistency {
    use crate::command_envelope::envelope::SignatureMode;

    if !license.signed_deploy_required {
        return SignatureModeConsistency::LicenseDoesNotRequireSignedDeploy;
    }
    match signature_mode {
        SignatureMode::Disabled => {
            SignatureModeConsistency::CriticalMismatchDisabledSignatureMode
        }
        SignatureMode::Permissive | SignatureMode::Enforcing => {
            SignatureModeConsistency::Consistent
        }
    }
}

// ============================================================
// Batch 213 Faz 7 — remaining enforcement-point primitives
// ============================================================
//
// Plan §5 Faz 7 step 4 lists seven enforcement points; Batches
// 142+146 wired io_poll + signature_mode. The rest are
// introduced here as pure-function checks so each call site
// (cmd_deploy_program, task_scheduler boot, cmd_watch_subscribe,
// cmd_force_value, opc_ua_server boot) can route the decision
// (reject / warn / allow) against a testable primitive.
//
// Primitive-first: none of these functions walk AppState. Each
// one takes the raw counts + the license, returns a structured
// enum so caller assembles the full error message (which
// includes actor + correlation_id context the primitive
// deliberately doesn't know about).

/// ST / FB / scan-cycle budget check result. Batch 213 Faz 7
/// step 4 enforcement point #3 (cmd_deploy_program).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeployProgramBudget {
    /// Every check passed — deploy proceeds.
    WithinBudget {
        st_programs: usize,
        fb_instances: usize,
        scan_cycle_ms: u64,
    },
    /// Post-deploy ST program count would exceed
    /// `max_st_programs`. Handler rejects with the structured
    /// reason; operator upgrades tier OR removes a program.
    StProgramCountExceeded { configured: usize, cap: u32 },
    /// Post-deploy FB instance count would exceed
    /// `max_fb_instances`. Handler rejects similarly.
    FbInstanceCountExceeded { configured: usize, cap: u32 },
    /// Declared scan_cycle_ms below the license tier's
    /// `min_scan_cycle_ms`. Lower cycle = higher hardware
    /// load = paid-tier only. Handler rejects with the tier
    /// hint.
    ScanCycleBelowFloor { configured_ms: u64, min_ms: u32 },
}

/// Check a pending ST program deploy against every limits
/// field the plan's enforcement-point #3 covers. Returns the
/// FIRST failing dimension so the operator error is small +
/// actionable; cascading all three at once would obscure the
/// primary corrective action.
pub fn check_deploy_program_budget(
    pending_st_program_count: usize,
    pending_fb_instance_count: usize,
    pending_scan_cycle_ms: u64,
    license: &EdgeLicenseLimits,
) -> DeployProgramBudget {
    if pending_st_program_count > license.max_st_programs as usize {
        return DeployProgramBudget::StProgramCountExceeded {
            configured: pending_st_program_count,
            cap: license.max_st_programs,
        };
    }
    if pending_fb_instance_count > license.max_fb_instances as usize {
        return DeployProgramBudget::FbInstanceCountExceeded {
            configured: pending_fb_instance_count,
            cap: license.max_fb_instances,
        };
    }
    if pending_scan_cycle_ms < license.min_scan_cycle_ms as u64 {
        return DeployProgramBudget::ScanCycleBelowFloor {
            configured_ms: pending_scan_cycle_ms,
            min_ms: license.min_scan_cycle_ms,
        };
    }
    DeployProgramBudget::WithinBudget {
        st_programs: pending_st_program_count,
        fb_instances: pending_fb_instance_count,
        scan_cycle_ms: pending_scan_cycle_ms,
    }
}

/// Task scheduler cap check. Batch 213 Faz 7 step 4
/// enforcement point #4 (task_scheduler boot).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskSchedulerBudget {
    /// Configured task count within cap.
    WithinBudget { configured: usize, cap: u32 },
    /// Configured count exceeds cap. Plan Faz 7: scheduler
    /// MUST NOT start the excess tasks + CRITICAL boot log.
    Exceeded { configured: usize, cap: u32 },
}

pub fn check_task_scheduler_budget(
    configured_tasks: usize,
    license: &EdgeLicenseLimits,
) -> TaskSchedulerBudget {
    let cap = license.max_concurrent_tasks;
    if configured_tasks > cap as usize {
        TaskSchedulerBudget::Exceeded {
            configured: configured_tasks,
            cap,
        }
    } else {
        TaskSchedulerBudget::WithinBudget {
            configured: configured_tasks,
            cap,
        }
    }
}

/// Concurrent-force cap check. Batch 213 Faz 7 step 4
/// enforcement point #6 (cmd_force_value).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForceBudget {
    /// Current active-force count within cap.
    WithinBudget { active: usize, cap: u32 },
    /// Active count at cap. cmd_force_value MUST reject with
    /// the structured reason; operator clears an existing
    /// force OR upgrades tier.
    Exceeded { active: usize, cap: u32 },
}

pub fn check_force_budget(
    active_forces: usize,
    license: &EdgeLicenseLimits,
) -> ForceBudget {
    let cap = license.max_concurrent_forces;
    // `>=` because incoming force would make active+1 which
    // would exceed cap — reject BEFORE the registry grows.
    if active_forces >= cap as usize {
        ForceBudget::Exceeded {
            active: active_forces,
            cap,
        }
    } else {
        ForceBudget::WithinBudget {
            active: active_forces,
            cap,
        }
    }
}

/// Active watch-session cap check. Batch 213 Faz 7 step 4
/// enforcement point #7 (cmd_watch_subscribe).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchBudget {
    /// Current active watch-session count within cap.
    WithinBudget { active: usize, cap: u32 },
    /// Active count at cap. cmd_watch_subscribe MUST reject;
    /// operator unsubscribes an existing session OR upgrades.
    Exceeded { active: usize, cap: u32 },
}

pub fn check_watch_budget(
    active_watch_sessions: usize,
    license: &EdgeLicenseLimits,
) -> WatchBudget {
    let cap = license.max_watch_sessions;
    // Same `>=` semantics as ForceBudget — reject BEFORE the
    // subscription grows past cap.
    if active_watch_sessions >= cap as usize {
        WatchBudget::Exceeded {
            active: active_watch_sessions,
            cap,
        }
    } else {
        WatchBudget::WithinBudget {
            active: active_watch_sessions,
            cap,
        }
    }
}

/// OPC UA server gate. Batch 213 Faz 7 step 4 enforcement
/// point #5 (opc_ua_server boot).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpcUaServerGate {
    /// License authorizes OPC UA server start. Operator's
    /// `config.opc_ua_server.enabled` is the secondary gate
    /// layered on top.
    LicenseAllowsStart,
    /// License denies OPC UA server start (tier too low).
    /// opc_ua_server boot MUST NOT listen on :4840 + audit
    /// event fires + operator sees CRITICAL log.
    LicenseDisabled,
}

pub fn check_opc_ua_server_gate(license: &EdgeLicenseLimits) -> OpcUaServerGate {
    if license.opc_ua_server_enabled {
        OpcUaServerGate::LicenseAllowsStart
    } else {
        OpcUaServerGate::LicenseDisabled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn license_tier_wire_tag_stable() {
        // Pinned per plan R-10 audit taxonomy — downstream
        // dashboards key on these 1-byte identifiers.
        assert_eq!(LicenseTier::Starter.wire_tag(), 0);
        assert_eq!(LicenseTier::Professional.wire_tag(), 1);
        assert_eq!(LicenseTier::Enterprise.wire_tag(), 2);
        assert_eq!(LicenseTier::Custom.wire_tag(), 3);
    }

    #[test]
    fn license_tier_as_str_matches_serde_rename() {
        assert_eq!(LicenseTier::Starter.as_str(), "starter");
        assert_eq!(LicenseTier::Professional.as_str(), "professional");
        assert_eq!(LicenseTier::Enterprise.as_str(), "enterprise");
        assert_eq!(LicenseTier::Custom.as_str(), "custom");
    }

    #[test]
    fn license_tier_default_is_starter() {
        let t = LicenseTier::default();
        assert!(matches!(t, LicenseTier::Starter));
    }

    #[test]
    fn conservative_fallback_is_most_restrictive() {
        let c = EdgeLicenseLimits::conservative();
        assert!(matches!(c.tier, LicenseTier::Starter));
        assert_eq!(c.valid_until_unix_secs, 0);
        assert_eq!(c.max_io_channels, 16);
        assert_eq!(c.max_fb_instances, 8);
        assert_eq!(c.min_scan_cycle_ms, 5_000);
        assert_eq!(c.max_st_programs, 2);
        assert_eq!(c.max_concurrent_tasks, 1);
        assert_eq!(c.max_watch_sessions, 1);
        assert_eq!(c.max_concurrent_forces, 0);
        assert!(!c.signed_deploy_required);
        assert!(!c.opc_ua_server_enabled);
    }

    #[test]
    fn default_impl_delegates_to_conservative() {
        let d = EdgeLicenseLimits::default();
        let c = EdgeLicenseLimits::conservative();
        assert_eq!(d, c);
    }

    #[test]
    fn is_expired_on_zero_valid_until() {
        // valid_until=0 means any positive now is past
        // expiry. Conservative starts at 0 so it's
        // always-expired by design.
        let c = EdgeLicenseLimits::conservative();
        assert!(c.is_expired(1_700_000_000));
        assert!(!c.is_expired(0));
        assert!(!c.is_expired(-1));
    }

    #[test]
    fn is_expired_respects_future_validity() {
        let l = EdgeLicenseLimits {
            valid_until_unix_secs: 2_000_000_000,
            ..EdgeLicenseLimits::conservative()
        };
        assert!(!l.is_expired(1_700_000_000));
        assert!(l.is_expired(2_000_000_001));
    }

    #[test]
    fn license_limits_json_roundtrip() {
        // Cloud manifest transport is JSON. Verify the
        // shape round-trips cleanly so the future
        // fetch path parses the same structure the edge
        // emits.
        let src = EdgeLicenseLimits {
            tier: LicenseTier::Enterprise,
            valid_until_unix_secs: 1_800_000_000,
            max_io_channels: 256,
            max_fb_instances: 128,
            min_scan_cycle_ms: 100,
            max_st_programs: 32,
            max_concurrent_tasks: 8,
            max_watch_sessions: 10,
            max_concurrent_forces: 50,
            signed_deploy_required: true,
            opc_ua_server_enabled: true,
        };
        let json = serde_json::to_string(&src).expect("serialize");
        assert!(json.contains("\"tier\":\"enterprise\""));
        assert!(json.contains("\"signed_deploy_required\":true"));
        let parsed: EdgeLicenseLimits =
            serde_json::from_str(&json).expect("deserialize");
        assert_eq!(src, parsed);
    }

    #[test]
    fn license_tier_json_is_snake_case() {
        let j = serde_json::to_string(&LicenseTier::Professional).unwrap();
        assert_eq!(j, "\"professional\"");
        let j = serde_json::to_string(&LicenseTier::Custom).unwrap();
        assert_eq!(j, "\"custom\"");
    }

    // ====================================================================
    // Batch 146 Faz 7 — signature_mode consistency tests
    // ====================================================================

    use crate::command_envelope::envelope::SignatureMode;

    #[test]
    fn consistency_conservative_never_requires_signature() {
        // conservative() has signed_deploy_required=false
        // so EVERY signature_mode is acceptable.
        let c = EdgeLicenseLimits::conservative();
        for mode in [SignatureMode::Disabled, SignatureMode::Permissive, SignatureMode::Enforcing] {
            assert!(matches!(
                check_signature_mode_consistency(&c, mode),
                SignatureModeConsistency::LicenseDoesNotRequireSignedDeploy
            ));
        }
    }

    #[test]
    fn consistency_signed_required_plus_disabled_is_critical() {
        let l = EdgeLicenseLimits {
            signed_deploy_required: true,
            ..EdgeLicenseLimits::conservative()
        };
        assert!(matches!(
            check_signature_mode_consistency(&l, SignatureMode::Disabled),
            SignatureModeConsistency::CriticalMismatchDisabledSignatureMode
        ));
    }

    #[test]
    fn consistency_signed_required_plus_permissive_is_consistent() {
        let l = EdgeLicenseLimits {
            signed_deploy_required: true,
            ..EdgeLicenseLimits::conservative()
        };
        assert!(matches!(
            check_signature_mode_consistency(&l, SignatureMode::Permissive),
            SignatureModeConsistency::Consistent
        ));
    }

    #[test]
    fn consistency_signed_required_plus_enforcing_is_consistent() {
        let l = EdgeLicenseLimits {
            signed_deploy_required: true,
            ..EdgeLicenseLimits::conservative()
        };
        assert!(matches!(
            check_signature_mode_consistency(&l, SignatureMode::Enforcing),
            SignatureModeConsistency::Consistent
        ));
    }

    // ====================================================================
    // Batch 147 Faz 7 — IO channel budget tests
    // ====================================================================

    fn empty_config() -> crate::config::AgentConfig {
        // Use Default for the base + override required
        // fields the constructor validator rejects (handled
        // by serde_yaml parse of a minimal config in
        // real paths; for tests we bypass validation).
        let yaml = r#"
device_id: "00000000-0000-0000-0000-000000000000"
device_code: "test"
api_url: "https://example"
mqtt:
  broker: "localhost"
  port: 1883
  keepalive_secs: 60
  clean_session: false
telemetry:
  interval_seconds: 30
modbus: []
gpio: []
i2c: []
"#;
        serde_yaml::from_str(yaml).expect("minimal config parses")
    }

    #[test]
    fn count_empty_config_zero_channels() {
        let c = empty_config();
        assert_eq!(count_configured_io_channels(&c), 0);
    }

    #[test]
    fn budget_within_cap_when_conservative_under_limit() {
        // conservative() cap = 16, empty config = 0.
        let c = empty_config();
        let lic = EdgeLicenseLimits::conservative();
        match check_io_channel_budget(&c, &lic) {
            IoChannelBudget::WithinBudget { configured, cap } => {
                assert_eq!(configured, 0);
                assert_eq!(cap, 16);
            }
            other => panic!("expected WithinBudget, got {:?}", other),
        }
    }

    #[test]
    fn budget_exceeded_when_tight_cap() {
        // Fake a low-cap license vs empty config. Since
        // empty=0 < anything, exceed can't happen via
        // config alone. Test by dropping the cap below
        // zero-count (cap=0 vs configured=0 → still
        // within). Use cap=0 + synthetic channels.
        //
        // Simpler: set license cap=0 + test helper
        // directly. We can't mutate config without
        // rebuilding; instead synthesize a limits that
        // caps at 0 + any config with at least 1 channel.
        //
        // Most robust: count via the helper on a known
        // non-empty yaml, then pair with a low-cap
        // license.
        let yaml = r#"
device_id: "00000000-0000-0000-0000-000000000000"
device_code: "test"
api_url: "https://example"
mqtt:
  broker: "localhost"
  port: 1883
  keepalive_secs: 60
  clean_session: false
telemetry:
  interval_seconds: 30
modbus:
  - name: "plc1"
    connection_type: "tcp"
    address: "1.2.3.4:502"
    slave_id: 1
    polling_interval_ms: 1000
gpio:
  - pin: 17
    direction: "input"
    pull: "none"
    name: "door-sensor"
i2c:
  - name: "atlas1"
    bus: 1
    address: 99
    kind: "EzoPh"
    polling_interval_ms: 5000
"#;
        let c: crate::config::AgentConfig =
            serde_yaml::from_str(yaml).expect("3-channel config parses");
        assert_eq!(count_configured_io_channels(&c), 3);

        // License cap=2 → exceed.
        let lic = EdgeLicenseLimits {
            max_io_channels: 2,
            ..EdgeLicenseLimits::conservative()
        };
        match check_io_channel_budget(&c, &lic) {
            IoChannelBudget::Exceeded { configured, cap } => {
                assert_eq!(configured, 3);
                assert_eq!(cap, 2);
            }
            other => panic!("expected Exceeded, got {:?}", other),
        }

        // License cap=3 → exactly at boundary; within.
        let lic_at_boundary = EdgeLicenseLimits {
            max_io_channels: 3,
            ..EdgeLicenseLimits::conservative()
        };
        match check_io_channel_budget(&c, &lic_at_boundary) {
            IoChannelBudget::WithinBudget { configured, cap } => {
                assert_eq!(configured, 3);
                assert_eq!(cap, 3);
            }
            other => panic!("expected WithinBudget at boundary, got {:?}", other),
        }
    }

    // ========================================================
    // Batch 213 Faz 7 — enforcement-point primitive tests
    // ========================================================

    fn limits_with(
        max_st_programs: u32,
        max_fb_instances: u32,
        min_scan_cycle_ms: u32,
        max_concurrent_tasks: u32,
        max_concurrent_forces: u32,
        max_watch_sessions: u32,
        opc_ua_server_enabled: bool,
    ) -> EdgeLicenseLimits {
        EdgeLicenseLimits {
            max_st_programs,
            max_fb_instances,
            min_scan_cycle_ms,
            max_concurrent_tasks,
            max_concurrent_forces,
            max_watch_sessions,
            opc_ua_server_enabled,
            ..EdgeLicenseLimits::conservative()
        }
    }

    // --- DeployProgramBudget ---

    #[test]
    fn deploy_within_budget_passes_every_check() {
        let lic = limits_with(4, 16, 500, 3, 8, 5, true);
        match check_deploy_program_budget(3, 12, 600, &lic) {
            DeployProgramBudget::WithinBudget {
                st_programs,
                fb_instances,
                scan_cycle_ms,
            } => {
                assert_eq!(st_programs, 3);
                assert_eq!(fb_instances, 12);
                assert_eq!(scan_cycle_ms, 600);
            }
            other => panic!("expected WithinBudget, got {:?}", other),
        }
    }

    #[test]
    fn deploy_reports_st_program_count_first() {
        let lic = limits_with(2, 16, 500, 3, 8, 5, true);
        match check_deploy_program_budget(3, 1, 1000, &lic) {
            DeployProgramBudget::StProgramCountExceeded { configured, cap } => {
                assert_eq!(configured, 3);
                assert_eq!(cap, 2);
            }
            other => panic!("expected StProgramCountExceeded, got {:?}", other),
        }
    }

    #[test]
    fn deploy_reports_fb_instance_count_second() {
        // ST count OK; FB count exceeds.
        let lic = limits_with(4, 4, 500, 3, 8, 5, true);
        match check_deploy_program_budget(2, 5, 1000, &lic) {
            DeployProgramBudget::FbInstanceCountExceeded { configured, cap } => {
                assert_eq!(configured, 5);
                assert_eq!(cap, 4);
            }
            other => panic!("expected FbInstanceCountExceeded, got {:?}", other),
        }
    }

    #[test]
    fn deploy_reports_scan_cycle_below_floor_third() {
        // ST + FB OK; scan cycle below min.
        let lic = limits_with(4, 16, 500, 3, 8, 5, true);
        match check_deploy_program_budget(1, 1, 250, &lic) {
            DeployProgramBudget::ScanCycleBelowFloor {
                configured_ms,
                min_ms,
            } => {
                assert_eq!(configured_ms, 250);
                assert_eq!(min_ms, 500);
            }
            other => panic!("expected ScanCycleBelowFloor, got {:?}", other),
        }
    }

    #[test]
    fn deploy_reports_first_failure_when_multiple_would_fail() {
        // Every dimension fails; ST is checked first so the
        // operator sees the ST rejection — not a downstream
        // message that would obscure the primary fix.
        let lic = limits_with(1, 1, 1000, 3, 8, 5, true);
        match check_deploy_program_budget(5, 5, 100, &lic) {
            DeployProgramBudget::StProgramCountExceeded { .. } => {}
            other => panic!("expected ST first, got {:?}", other),
        }
    }

    #[test]
    fn deploy_accepts_exact_scan_cycle_floor() {
        let lic = limits_with(4, 16, 500, 3, 8, 5, true);
        match check_deploy_program_budget(1, 1, 500, &lic) {
            DeployProgramBudget::WithinBudget { .. } => {}
            other => panic!("expected WithinBudget at floor, got {:?}", other),
        }
    }

    // --- TaskSchedulerBudget ---

    #[test]
    fn task_scheduler_within_budget_at_cap() {
        let lic = limits_with(4, 16, 500, 3, 8, 5, true);
        match check_task_scheduler_budget(3, &lic) {
            TaskSchedulerBudget::WithinBudget { configured, cap } => {
                assert_eq!(configured, 3);
                assert_eq!(cap, 3);
            }
            other => panic!("expected WithinBudget, got {:?}", other),
        }
    }

    #[test]
    fn task_scheduler_exceeds_when_over() {
        let lic = limits_with(4, 16, 500, 2, 8, 5, true);
        match check_task_scheduler_budget(3, &lic) {
            TaskSchedulerBudget::Exceeded { configured, cap } => {
                assert_eq!(configured, 3);
                assert_eq!(cap, 2);
            }
            other => panic!("expected Exceeded, got {:?}", other),
        }
    }

    // --- ForceBudget ---

    #[test]
    fn force_within_budget_when_below_cap() {
        let lic = limits_with(4, 16, 500, 3, 8, 5, true);
        match check_force_budget(5, &lic) {
            ForceBudget::WithinBudget { active, cap } => {
                assert_eq!(active, 5);
                assert_eq!(cap, 8);
            }
            other => panic!("expected WithinBudget, got {:?}", other),
        }
    }

    #[test]
    fn force_exceeds_at_exact_cap() {
        // `>=` semantics — active count reaching cap MUST
        // reject the NEXT incoming force (active=cap would
        // become active+1>cap after apply).
        let lic = limits_with(4, 16, 500, 3, 2, 5, true);
        match check_force_budget(2, &lic) {
            ForceBudget::Exceeded { active, cap } => {
                assert_eq!(active, 2);
                assert_eq!(cap, 2);
            }
            other => panic!("expected Exceeded at cap, got {:?}", other),
        }
    }

    #[test]
    fn force_conservative_zero_cap_always_rejects() {
        // conservative() sets max_concurrent_forces=0; even
        // an empty registry MUST reject the incoming force
        // because 0>=0.
        let lic = EdgeLicenseLimits::conservative();
        match check_force_budget(0, &lic) {
            ForceBudget::Exceeded { active, cap } => {
                assert_eq!(active, 0);
                assert_eq!(cap, 0);
            }
            other => panic!("expected Exceeded for conservative, got {:?}", other),
        }
    }

    // --- WatchBudget ---

    #[test]
    fn watch_within_budget_when_below_cap() {
        let lic = limits_with(4, 16, 500, 3, 8, 5, true);
        match check_watch_budget(2, &lic) {
            WatchBudget::WithinBudget { active, cap } => {
                assert_eq!(active, 2);
                assert_eq!(cap, 5);
            }
            other => panic!("expected WithinBudget, got {:?}", other),
        }
    }

    #[test]
    fn watch_exceeds_at_exact_cap() {
        let lic = limits_with(4, 16, 500, 3, 8, 3, true);
        match check_watch_budget(3, &lic) {
            WatchBudget::Exceeded { active, cap } => {
                assert_eq!(active, 3);
                assert_eq!(cap, 3);
            }
            other => panic!("expected Exceeded at cap, got {:?}", other),
        }
    }

    // --- OpcUaServerGate ---

    #[test]
    fn opc_ua_gate_allows_when_license_enables() {
        let lic = limits_with(4, 16, 500, 3, 8, 5, true);
        assert_eq!(check_opc_ua_server_gate(&lic), OpcUaServerGate::LicenseAllowsStart);
    }

    #[test]
    fn opc_ua_gate_denies_when_license_disables() {
        let lic = limits_with(4, 16, 500, 3, 8, 5, false);
        assert_eq!(check_opc_ua_server_gate(&lic), OpcUaServerGate::LicenseDisabled);
    }

    #[test]
    fn opc_ua_gate_conservative_is_disabled() {
        assert_eq!(
            check_opc_ua_server_gate(&EdgeLicenseLimits::conservative()),
            OpcUaServerGate::LicenseDisabled
        );
    }
}

// ========================================================================
// Batch 141 Faz 7 — SignedLicenseManifest + verify primitive
// ========================================================================

use crate::authz::permission::TenantId;
use crate::authz::policy::Ed25519SignatureBytes;

/// Plaintext license manifest body. Cloud signs
/// `canonical_bytes()` of this with the firmware signing
/// key (plan R-10 key-reuse refinement) + ships as JSON
/// `SignedLicenseManifest` payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LicenseManifest {
    /// Tenant binding. MUST equal the edge's
    /// provisioning-bound tenant. Cross-tenant pivot
    /// defense.
    pub tenant_id: TenantId,

    /// Monotonic policy version. Matches the
    /// rbac_manifest_version rollback-defense pattern:
    /// on-device persists `highest_seen_policy_version`;
    /// inbound manifest with `<=` rejected.
    pub policy_version: u64,

    /// Validity window (UNIX secs). License verify
    /// rejects manifests outside
    /// `[valid_from_unix_secs, valid_until_unix_secs]`.
    pub valid_from_unix_secs: i64,
    pub valid_until_unix_secs: i64,

    /// Issuance timestamp for audit + operator
    /// troubleshooting.
    pub issued_at_unix_secs: i64,

    /// Per-device limits payload. Consumed by Batch 142+
    /// enforcement hooks.
    pub limits: EdgeLicenseLimits,
}

/// Wire-format signed license manifest.
///
/// `pub(crate)` seal on the body — consumers MUST go
/// through `verify_license_manifest`. Same discipline as
/// `updater::SignedFirmwareManifest` (Batch 8) +
/// `authz::SignedRbacManifest`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedLicenseManifest {
    pub(crate) manifest: LicenseManifest,
    pub signature: Ed25519SignatureBytes,
}

impl SignedLicenseManifest {
    /// Construct from body + signature bytes. Validates
    /// signature length at parse boundary (same pattern
    /// as Batch 8 SignedFirmwareManifest).
    ///
    /// Runtime refresh_license path uses
    /// `serde_json::from_value` (consumes the JSON +
    /// validates signature via Serde) — this explicit
    /// constructor is the test-keypair path +
    /// future-consumer bridge (Batch 144 cache reload
    /// will use it).
    #[allow(dead_code)] // Batch 144 cache-reload consumer
    pub fn from_body_and_signature_bytes(
        manifest: LicenseManifest,
        signature_bytes: &[u8],
    ) -> Result<Self, crate::authz::policy::InvalidSignatureLength> {
        Ok(Self {
            manifest,
            signature: Ed25519SignatureBytes::from_slice(signature_bytes)?,
        })
    }
}

/// Canonical byte serialization for signing. Matches the
/// Batch 8 `FirmwareManifest::canonical_bytes` discipline:
/// deterministic BE-encoded fields in a stable order so
/// the cloud HSM ceremony + edge verify compute identical
/// bytes.
impl LicenseManifest {
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(256);
        // Tenant ID (16 bytes).
        out.extend_from_slice(self.tenant_id.as_bytes());
        // Policy version.
        out.extend_from_slice(&self.policy_version.to_be_bytes());
        // Validity window.
        out.extend_from_slice(&self.valid_from_unix_secs.to_be_bytes());
        out.extend_from_slice(&self.valid_until_unix_secs.to_be_bytes());
        // Issuance timestamp.
        out.extend_from_slice(&self.issued_at_unix_secs.to_be_bytes());
        // Limits tier wire tag.
        out.push(self.limits.tier.wire_tag());
        out.extend_from_slice(&self.limits.valid_until_unix_secs.to_be_bytes());
        out.extend_from_slice(&self.limits.max_io_channels.to_be_bytes());
        out.extend_from_slice(&self.limits.max_fb_instances.to_be_bytes());
        out.extend_from_slice(&self.limits.min_scan_cycle_ms.to_be_bytes());
        out.extend_from_slice(&self.limits.max_st_programs.to_be_bytes());
        out.extend_from_slice(&self.limits.max_concurrent_tasks.to_be_bytes());
        out.extend_from_slice(&self.limits.max_watch_sessions.to_be_bytes());
        out.extend_from_slice(&self.limits.max_concurrent_forces.to_be_bytes());
        out.push(u8::from(self.limits.signed_deploy_required));
        out.push(u8::from(self.limits.opc_ua_server_enabled));
        // Domain-separation trailer — prevents canonical-
        // bytes collision with firmware manifest or RBAC
        // manifest bodies signed by the same key.
        out.extend_from_slice(b"license-manifest-v1");
        out
    }
}

/// Verify-time failure taxonomy. Mirrors the Batch 8
/// ManifestVerifyError shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LicenseVerifyError {
    /// Tenant binding mismatch.
    TenantMismatch,
    /// Inbound policy_version ≤ persisted
    /// highest_seen_policy_version → rollback attempt.
    StalePolicyVersion {
        claimed: u64,
        highest_seen: u64,
    },
    /// `now_unix_secs` is negative.
    InvalidNow,
    /// Validity window shape malformed
    /// (valid_from > valid_until).
    InvalidValidityWindow {
        valid_from: i64,
        valid_until: i64,
    },
    /// Manifest not yet valid (now < valid_from).
    NotYetValid {
        now_unix_secs: i64,
        valid_from: i64,
    },
    /// Manifest expired (now > valid_until).
    Expired {
        now_unix_secs: i64,
        valid_until: i64,
    },
    /// ed25519 signature check failed.
    InvalidSignature,
}

impl std::fmt::Display for LicenseVerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TenantMismatch => f.write_str("tenant_mismatch"),
            Self::StalePolicyVersion { .. } => f.write_str("stale_policy_version"),
            Self::InvalidNow => f.write_str("invalid_now"),
            Self::InvalidValidityWindow { .. } => f.write_str("invalid_validity_window"),
            Self::NotYetValid { .. } => f.write_str("not_yet_valid"),
            Self::Expired { .. } => f.write_str("expired"),
            Self::InvalidSignature => f.write_str("invalid_signature"),
        }
    }
}

impl std::error::Error for LicenseVerifyError {}

/// Verify a signed license manifest. Same
/// closure-injection discipline as the Batch 8
/// firmware verify: the ed25519 primitive is injected
/// so the pure function stays crypto-backend-agnostic.
///
/// Gate ordering (cheapest-first):
/// 1. Clock sanity (now < 0).
/// 2. Validity-window shape.
/// 3. Tenant match.
/// 4. Policy-version monotonic (strict `>`).
/// 5. Freshness window (now in [valid_from, valid_until]).
/// 6. ed25519 verify (expensive).
pub fn verify_license_manifest(
    signed: &SignedLicenseManifest,
    expected_tenant: &TenantId,
    highest_seen_policy_version: u64,
    now_unix_secs: i64,
    verify_signature: impl FnOnce(&[u8], &[u8; 64]) -> bool,
) -> Result<LicenseManifest, LicenseVerifyError> {
    // Gate 1 — clock sanity.
    if now_unix_secs < 0 {
        return Err(LicenseVerifyError::InvalidNow);
    }

    // Gate 2 — validity window shape.
    if signed.manifest.valid_from_unix_secs > signed.manifest.valid_until_unix_secs {
        return Err(LicenseVerifyError::InvalidValidityWindow {
            valid_from: signed.manifest.valid_from_unix_secs,
            valid_until: signed.manifest.valid_until_unix_secs,
        });
    }

    // Gate 3 — tenant match.
    if &signed.manifest.tenant_id != expected_tenant {
        return Err(LicenseVerifyError::TenantMismatch);
    }

    // Gate 4 — policy version monotonic.
    if signed.manifest.policy_version <= highest_seen_policy_version {
        return Err(LicenseVerifyError::StalePolicyVersion {
            claimed: signed.manifest.policy_version,
            highest_seen: highest_seen_policy_version,
        });
    }

    // Gate 5 — freshness window.
    if now_unix_secs < signed.manifest.valid_from_unix_secs {
        return Err(LicenseVerifyError::NotYetValid {
            now_unix_secs,
            valid_from: signed.manifest.valid_from_unix_secs,
        });
    }
    if now_unix_secs > signed.manifest.valid_until_unix_secs {
        return Err(LicenseVerifyError::Expired {
            now_unix_secs,
            valid_until: signed.manifest.valid_until_unix_secs,
        });
    }

    // Gate 6 — ed25519 signature.
    let canonical = signed.manifest.canonical_bytes();
    if !verify_signature(&canonical, signed.signature.as_bytes()) {
        return Err(LicenseVerifyError::InvalidSignature);
    }

    Ok(signed.manifest.clone())
}

#[cfg(test)]
mod verify_tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn tenant_id() -> TenantId {
        TenantId::new_from_verified([0xAAu8; 16])
    }

    fn canned_manifest(version: u64) -> LicenseManifest {
        LicenseManifest {
            tenant_id: tenant_id(),
            policy_version: version,
            valid_from_unix_secs: 1_700_000_000,
            valid_until_unix_secs: 1_800_000_000,
            issued_at_unix_secs: 1_700_000_000,
            limits: EdgeLicenseLimits {
                tier: LicenseTier::Professional,
                valid_until_unix_secs: 1_800_000_000,
                max_io_channels: 64,
                max_fb_instances: 32,
                min_scan_cycle_ms: 500,
                max_st_programs: 8,
                max_concurrent_tasks: 4,
                max_watch_sessions: 3,
                max_concurrent_forces: 5,
                signed_deploy_required: false,
                opc_ua_server_enabled: false,
            },
        }
    }

    fn sign(manifest: LicenseManifest, key: &SigningKey) -> SignedLicenseManifest {
        let canonical = manifest.canonical_bytes();
        let sig = key.sign(&canonical);
        SignedLicenseManifest::from_body_and_signature_bytes(
            manifest,
            &sig.to_bytes(),
        )
        .expect("valid sig bytes")
    }

    fn verify_with(pubkey: &ed25519_dalek::VerifyingKey) -> impl FnOnce(&[u8], &[u8; 64]) -> bool + '_ {
        move |canonical, sig_bytes| {
            let sig = ed25519_dalek::Signature::from_bytes(sig_bytes);
            pubkey.verify_strict(canonical, &sig).is_ok()
        }
    }

    #[test]
    fn canonical_bytes_deterministic() {
        let m = canned_manifest(1);
        let a = m.canonical_bytes();
        let b = m.canonical_bytes();
        assert_eq!(a, b);
    }

    #[test]
    fn canonical_bytes_includes_domain_separator() {
        let m = canned_manifest(1);
        let bytes = m.canonical_bytes();
        assert!(bytes.ends_with(b"license-manifest-v1"));
    }

    #[test]
    fn verify_happy_path() {
        let seed = [0x5au8; 32];
        let signing_key = SigningKey::from_bytes(&seed);
        let pubkey = signing_key.verifying_key();
        let signed = sign(canned_manifest(10), &signing_key);

        let ok = verify_license_manifest(
            &signed,
            &tenant_id(),
            5,
            1_700_000_000,
            verify_with(&pubkey),
        )
        .expect("verify ok");
        assert_eq!(ok.policy_version, 10);
        assert!(matches!(ok.limits.tier, LicenseTier::Professional));
    }

    #[test]
    fn verify_rejects_tenant_mismatch() {
        let seed = [0x5au8; 32];
        let signing_key = SigningKey::from_bytes(&seed);
        let pubkey = signing_key.verifying_key();
        let signed = sign(canned_manifest(10), &signing_key);

        let foreign = TenantId::new_from_verified([0xBBu8; 16]);
        let err = verify_license_manifest(
            &signed,
            &foreign,
            5,
            1_700_000_000,
            verify_with(&pubkey),
        )
        .expect_err("must reject");
        assert_eq!(err, LicenseVerifyError::TenantMismatch);
    }

    #[test]
    fn verify_rejects_stale_policy_version() {
        let seed = [0x5au8; 32];
        let signing_key = SigningKey::from_bytes(&seed);
        let pubkey = signing_key.verifying_key();
        let signed = sign(canned_manifest(10), &signing_key);

        let err = verify_license_manifest(
            &signed,
            &tenant_id(),
            10, // equal = rejected
            1_700_000_000,
            verify_with(&pubkey),
        )
        .expect_err("must reject equal");
        assert!(matches!(
            err,
            LicenseVerifyError::StalePolicyVersion {
                claimed: 10,
                highest_seen: 10
            }
        ));
    }

    #[test]
    fn verify_rejects_not_yet_valid() {
        let seed = [0x5au8; 32];
        let signing_key = SigningKey::from_bytes(&seed);
        let pubkey = signing_key.verifying_key();
        let signed = sign(canned_manifest(10), &signing_key);

        let err = verify_license_manifest(
            &signed,
            &tenant_id(),
            5,
            1_600_000_000, // before valid_from
            verify_with(&pubkey),
        )
        .expect_err("must reject");
        assert!(matches!(err, LicenseVerifyError::NotYetValid { .. }));
    }

    #[test]
    fn verify_rejects_expired() {
        let seed = [0x5au8; 32];
        let signing_key = SigningKey::from_bytes(&seed);
        let pubkey = signing_key.verifying_key();
        let signed = sign(canned_manifest(10), &signing_key);

        let err = verify_license_manifest(
            &signed,
            &tenant_id(),
            5,
            1_900_000_000, // after valid_until
            verify_with(&pubkey),
        )
        .expect_err("must reject");
        assert!(matches!(err, LicenseVerifyError::Expired { .. }));
    }

    #[test]
    fn verify_rejects_negative_now() {
        let seed = [0x5au8; 32];
        let signing_key = SigningKey::from_bytes(&seed);
        let pubkey = signing_key.verifying_key();
        let signed = sign(canned_manifest(10), &signing_key);

        let err = verify_license_manifest(
            &signed,
            &tenant_id(),
            5,
            -1,
            verify_with(&pubkey),
        )
        .expect_err("must reject");
        assert_eq!(err, LicenseVerifyError::InvalidNow);
    }

    #[test]
    fn verify_rejects_inverted_validity_window() {
        let seed = [0x5au8; 32];
        let signing_key = SigningKey::from_bytes(&seed);
        let pubkey = signing_key.verifying_key();
        let mut m = canned_manifest(10);
        m.valid_from_unix_secs = 2_000_000_000;
        m.valid_until_unix_secs = 1_700_000_000;
        let signed = sign(m, &signing_key);

        let err = verify_license_manifest(
            &signed,
            &tenant_id(),
            5,
            1_750_000_000,
            verify_with(&pubkey),
        )
        .expect_err("must reject");
        assert!(matches!(err, LicenseVerifyError::InvalidValidityWindow { .. }));
    }

    #[test]
    fn verify_rejects_tampered_body() {
        // Sign genuine manifest, then tamper the limits;
        // verify must reject because canonical bytes
        // change with the tamper.
        let seed = [0x5au8; 32];
        let signing_key = SigningKey::from_bytes(&seed);
        let pubkey = signing_key.verifying_key();
        let genuine = canned_manifest(10);
        let sig = signing_key.sign(&genuine.canonical_bytes());

        let tampered = LicenseManifest {
            limits: EdgeLicenseLimits {
                max_io_channels: 9999,
                ..genuine.limits.clone()
            },
            ..genuine
        };
        let signed = SignedLicenseManifest::from_body_and_signature_bytes(
            tampered,
            &sig.to_bytes(),
        )
        .expect("sig bytes");

        let err = verify_license_manifest(
            &signed,
            &tenant_id(),
            5,
            1_700_000_000,
            verify_with(&pubkey),
        )
        .expect_err("tamper must reject");
        assert_eq!(err, LicenseVerifyError::InvalidSignature);
    }

    #[test]
    fn verify_rejects_wrong_key() {
        let seed_genuine = [0x5au8; 32];
        let seed_attacker = [0x77u8; 32];
        let signing_key = SigningKey::from_bytes(&seed_genuine);
        let attacker_key = SigningKey::from_bytes(&seed_attacker);
        let pubkey_genuine = signing_key.verifying_key();
        // Attacker signs with THEIR key; agent verifies with
        // device-bound genuine key.
        let signed = sign(canned_manifest(10), &attacker_key);

        let err = verify_license_manifest(
            &signed,
            &tenant_id(),
            5,
            1_700_000_000,
            verify_with(&pubkey_genuine),
        )
        .expect_err("wrong key must reject");
        assert_eq!(err, LicenseVerifyError::InvalidSignature);
    }
}
