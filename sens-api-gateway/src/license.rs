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
//! Primitive-first batch — no consumers yet. Accepted
//! dead-code status per the same pattern as the
//! Batch 111 BootloaderHandle primitive (runtime
//! wire lands in Batch 142 when cmd_deploy_program
//! consumes EdgeLicenseLimits + the allow is removed).
#![allow(dead_code)]

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
}
