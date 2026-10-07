//! Cross-language contract for the RLS session settings (SENSOR-HIGH-145).
//!
//! The sensor-ingestion sidecar binds a tenant before writing into a
//! FORCE-RLS `sensor_metrics`; the policy it must satisfy is installed by
//! the TypeScript helper. This fixture is shared VERBATIM with
//! tests/invariants/tenant-schema-golden.spec.ts, so a rename on either
//! side fails both suites instead of silently writing under no tenant.

use tenant_context::{RLS_BYPASS_GUC, RLS_TENANT_GUC};

#[derive(serde::Deserialize)]
struct RlsGucs {
    tenant_guc: String,
    bypass_guc: String,
}

const FIXTURE: &str = include_str!("rls-gucs.json");

#[test]
fn rls_session_settings_match_the_shared_fixture() {
    let parsed: Result<RlsGucs, _> = serde_json::from_str(FIXTURE);
    let mismatches: Vec<String> = match parsed {
        Ok(gucs) => [
            ("tenant_guc", gucs.tenant_guc.as_str(), RLS_TENANT_GUC),
            ("bypass_guc", gucs.bypass_guc.as_str(), RLS_BYPASS_GUC),
        ]
        .into_iter()
        .filter(|(_, fixture, constant)| fixture != constant)
        .map(|(name, fixture, constant)| format!("{name}: fixture {fixture} != crate {constant}"))
        .collect(),
        Err(e) => vec![format!("rls-gucs.json is not valid: {e:?}")],
    };
    assert!(mismatches.is_empty(), "{mismatches:?}");
}
