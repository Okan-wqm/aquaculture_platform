//! # Manifest common verification gates (Batch #243 refactor)
//!
//! Shared "envelope gates" for every signed manifest the edge agent
//! accepts: the structural + tenant + version + expiry checks that run
//! BEFORE the canonical-bytes serialization and signature crypto. Two
//! consumers today, and any future signed-policy manifest inherits the
//! same 5-gate contract:
//!
//! - [`super::verify::verify_manifest`] — RBAC manifest (role/permission
//!   bindings, signed with `rbac_manifest_signing_key`).
//! - [`super::user_token_manifest::verify_user_token_manifest`] — OPC UA
//!   UserName/Password + X.509 credential bindings, signed with
//!   `user_token_manifest_signing_key`.
//!
//! ## Why a shared helper (and not a trait)
//!
//! A trait-based abstraction would force every manifest type to expose a
//! `fn tenant_id() -> &TenantId` + `fn policy_version() -> u64` + … method
//! surface. That's fine for the two current consumers but leaks internal
//! manifest shape into the trait contract — a future manifest with a
//! different expiry semantics (e.g. per-entry validity) would force a
//! trait change. A free function taking the five fields directly is the
//! narrowest coupling — callers pass what they have; the helper returns
//! `now_unix_secs` or a structured error, and the caller proceeds to
//! canonical-bytes + signature verify in its own path.
//!
//! ## Gate ordering (cheapest first, by attacker-cost)
//!
//! 1. Validity window sanity (`valid_from <= valid_until`) — signer-side
//!    bug detection; cheapest.
//! 2. Clock sanity (`now >= UNIX_EPOCH`) — catches pre-epoch skew.
//! 3. Tenant match — CRITICAL make-it-impossible for cross-tenant pivot;
//!    a mismatch is almost certainly an attack signal.
//! 4. Policy version monotonicity — replay defense (ADR-018 §9); strictly
//!    greater required.
//! 5. Validity window covers `now` — expiry gate.
//!
//! Callers run gates 6 (canonical bytes) + 7 (signature crypto) in their
//! own path because the canonical-bytes encoding is manifest-specific
//! (domain tag differs) and the signature key identity is manifest-
//! specific (different HSM slot per Plan B R-4).
//!
//! ## Fail-closed discipline
//!
//! Every gate returns an error variant tagged by gate name. Callers map
//! the common error into their local error enum via `From` impls — see
//! `super::verify::ManifestVerifyError` and
//! `super::user_token_manifest::UserTokenManifestVerifyError`.

use std::time::SystemTime;

use super::permission::TenantId;

/// Common structural error taxonomy returned by [`run_envelope_gates`].
/// Each caller maps this into its own error enum via a `From` impl so
/// local audit-log formatting stays per-manifest-type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestStructuralError {
    /// Validity window is inverted (`valid_from > valid_until`).
    InvalidValidityWindow { valid_from: i64, valid_until: i64 },

    /// `now` is earlier than UNIX_EPOCH — clock skew pre-epoch.
    InvalidNow,

    /// Manifest tenant != device's provisioning-bound tenant.
    TenantMismatch,

    /// `claimed <= highest_seen` — rollback / replay attempt.
    StalePolicyVersion { claimed: u64, highest_seen: u64 },

    /// `now` is before `valid_from` — future-dated manifest.
    NotYetValid { now_unix_secs: i64, valid_from: i64 },

    /// `now` is after `valid_until` — expired manifest.
    Expired {
        now_unix_secs: i64,
        valid_until: i64,
    },
}

impl std::fmt::Display for ManifestStructuralError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidValidityWindow { .. } => f.write_str("invalid_validity_window"),
            Self::InvalidNow => f.write_str("invalid_now"),
            Self::TenantMismatch => f.write_str("tenant_mismatch"),
            Self::StalePolicyVersion { .. } => f.write_str("stale_policy_version"),
            Self::NotYetValid { .. } => f.write_str("not_yet_valid"),
            Self::Expired { .. } => f.write_str("expired"),
        }
    }
}

impl std::error::Error for ManifestStructuralError {}

/// Run the common 5 gates against a manifest envelope. On success returns
/// `now_unix_secs` (already computed from `now`) so the caller doesn't
/// recompute it for the canonical-bytes / audit-log path.
///
/// **Not pub(crate)-gated intentionally.** This helper is authz-internal;
/// outside `super`, no direct caller needs it. Exposed `pub` to let test
/// modules (`#[cfg(test)] mod tests` in manifest files) cross-reference it.
///
/// ## Arguments
///
/// - `expected_tenant` — device's provisioning-bound tenant (trust root).
/// - `manifest_tenant` — tenant binding inside the signed manifest body.
/// - `valid_from`, `valid_until` — manifest validity window in UNIX seconds.
/// - `policy_version` — claimed version inside the signed body.
/// - `highest_seen` — local persisted highest-seen version for this
///   manifest stream. Per-stream monotonic cursors keep RBAC and
///   user-token streams independent.
/// - `now` — caller-supplied clock (typically `SystemTime::now()`; tests
///   inject fixed timestamps).
pub fn run_envelope_gates(
    expected_tenant: &TenantId,
    manifest_tenant: &TenantId,
    valid_from: i64,
    valid_until: i64,
    policy_version: u64,
    highest_seen: u64,
    now: SystemTime,
) -> Result<i64, ManifestStructuralError> {
    // Gate 1: validity window sanity.
    if valid_from > valid_until {
        return Err(ManifestStructuralError::InvalidValidityWindow {
            valid_from,
            valid_until,
        });
    }

    // Gate 2: clock sanity.
    let now_unix_secs = match now.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        Err(_) => return Err(ManifestStructuralError::InvalidNow),
    };

    // Gate 3: tenant match.
    if manifest_tenant != expected_tenant {
        return Err(ManifestStructuralError::TenantMismatch);
    }

    // Gate 4: policy version monotonicity. Strictly greater.
    if policy_version <= highest_seen {
        return Err(ManifestStructuralError::StalePolicyVersion {
            claimed: policy_version,
            highest_seen,
        });
    }

    // Gate 5: validity window covers `now`.
    if now_unix_secs < valid_from {
        return Err(ManifestStructuralError::NotYetValid {
            now_unix_secs,
            valid_from,
        });
    }
    if now_unix_secs > valid_until {
        return Err(ManifestStructuralError::Expired {
            now_unix_secs,
            valid_until,
        });
    }

    Ok(now_unix_secs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn tenant(b: u8) -> TenantId {
        TenantId::new_from_verified([b; 16])
    }

    fn now_at(unix_secs: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(unix_secs)
    }

    #[test]
    fn well_formed_manifest_passes_and_returns_now_unix_secs() {
        let r = run_envelope_gates(
            &tenant(0xAA),
            &tenant(0xAA),
            1_700_000_000,
            1_800_000_000,
            42,
            0,
            now_at(1_750_000_000),
        );
        assert_eq!(r.unwrap(), 1_750_000_000);
    }

    #[test]
    fn inverted_validity_window_is_gate_1() {
        let err = run_envelope_gates(
            &tenant(0xAA),
            &tenant(0xAA),
            1_800_000_000,
            1_700_000_000,
            42,
            0,
            now_at(1_750_000_000),
        )
        .unwrap_err();
        match err {
            ManifestStructuralError::InvalidValidityWindow {
                valid_from,
                valid_until,
            } => {
                assert_eq!(valid_from, 1_800_000_000);
                assert_eq!(valid_until, 1_700_000_000);
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn tenant_mismatch_is_gate_3() {
        let err = run_envelope_gates(
            &tenant(0xAA),
            &tenant(0xBB),
            1_700_000_000,
            1_800_000_000,
            42,
            0,
            now_at(1_750_000_000),
        )
        .unwrap_err();
        assert_eq!(err, ManifestStructuralError::TenantMismatch);
    }

    #[test]
    fn stale_policy_version_is_gate_4() {
        let err = run_envelope_gates(
            &tenant(0xAA),
            &tenant(0xAA),
            1_700_000_000,
            1_800_000_000,
            42,
            42, // equal — STRICTLY greater required
            now_at(1_750_000_000),
        )
        .unwrap_err();
        match err {
            ManifestStructuralError::StalePolicyVersion {
                claimed,
                highest_seen,
            } => {
                assert_eq!(claimed, 42);
                assert_eq!(highest_seen, 42);
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn not_yet_valid_is_gate_5a() {
        let err = run_envelope_gates(
            &tenant(0xAA),
            &tenant(0xAA),
            1_700_000_000,
            1_800_000_000,
            42,
            0,
            now_at(1_600_000_000),
        )
        .unwrap_err();
        match err {
            ManifestStructuralError::NotYetValid { .. } => {}
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn expired_is_gate_5b() {
        let err = run_envelope_gates(
            &tenant(0xAA),
            &tenant(0xAA),
            1_700_000_000,
            1_800_000_000,
            42,
            0,
            now_at(1_900_000_000),
        )
        .unwrap_err();
        match err {
            ManifestStructuralError::Expired { .. } => {}
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn gate_ordering_tenant_before_version() {
        // Both checks would fail; tenant (gate 3) must surface first.
        let err = run_envelope_gates(
            &tenant(0xAA),
            &tenant(0xBB),
            1_700_000_000,
            1_800_000_000,
            42,
            100, // also stale
            now_at(1_750_000_000),
        )
        .unwrap_err();
        assert_eq!(err, ManifestStructuralError::TenantMismatch);
    }

    #[test]
    fn gate_ordering_inverted_window_before_tenant() {
        // Both checks would fail; inverted-window (gate 1) must surface first.
        let err = run_envelope_gates(
            &tenant(0xAA),
            &tenant(0xBB),
            1_800_000_000,
            1_700_000_000, // inverted
            42,
            0,
            now_at(1_750_000_000),
        )
        .unwrap_err();
        match err {
            ManifestStructuralError::InvalidValidityWindow { .. } => {}
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn version_must_be_strictly_greater() {
        // v = 43 > 42 → accepted.
        let r = run_envelope_gates(
            &tenant(0xAA),
            &tenant(0xAA),
            1_700_000_000,
            1_800_000_000,
            43,
            42,
            now_at(1_750_000_000),
        );
        assert!(r.is_ok());

        // v = 41 < 42 → stale.
        let err = run_envelope_gates(
            &tenant(0xAA),
            &tenant(0xAA),
            1_700_000_000,
            1_800_000_000,
            41,
            42,
            now_at(1_750_000_000),
        )
        .unwrap_err();
        match err {
            ManifestStructuralError::StalePolicyVersion { .. } => {}
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn display_strings_are_stable_for_audit_routing() {
        assert_eq!(
            ManifestStructuralError::TenantMismatch.to_string(),
            "tenant_mismatch"
        );
        assert_eq!(
            ManifestStructuralError::StalePolicyVersion {
                claimed: 1,
                highest_seen: 2
            }
            .to_string(),
            "stale_policy_version"
        );
        assert_eq!(
            ManifestStructuralError::Expired {
                now_unix_secs: 0,
                valid_until: 0
            }
            .to_string(),
            "expired"
        );
    }
}
