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

// ========================================================================
// Batch 141 Faz 7 — SignedLicenseManifest + verify primitive
// ========================================================================

use crate::authz::permission::TenantId;
use crate::authz::policy::Ed25519SignatureBytes;

/// Plaintext license manifest body. Cloud signs
/// `canonical_bytes()` of this with the firmware signing
/// key (plan R-10 key-reuse refinement) + ships as JSON
/// `SignedLicenseManifest` payload.
#[allow(dead_code)] // Batch 143 wires the fetch path consumer.
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
#[allow(dead_code)] // Batch 143 wires the fetch path consumer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedLicenseManifest {
    pub(crate) manifest: LicenseManifest,
    pub signature: Ed25519SignatureBytes,
}

#[allow(dead_code)] // Batch 143 wires the fetch path consumer.
impl SignedLicenseManifest {
    /// Construct from body + signature bytes. Validates
    /// signature length at parse boundary (same pattern
    /// as Batch 8 SignedFirmwareManifest).
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
#[allow(dead_code)] // Batch 143 wires the fetch path consumer.
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
#[allow(dead_code)] // Batch 143 wires the fetch path consumer.
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
