//! Cross-language golden vectors (Task 3, SENSOR-CRITICAL-089).
//!
//! This fixture is shared VERBATIM with the TypeScript SSoT test
//! (tests/invariants/tenant-schema-golden.spec.ts reads the same JSON).
//! Both languages must map every UUID to the identical
//! `tenant_<16-hex>` schema or the sidecar writes into schemas the
//! platform cannot see.

use tenant_context::{SchemaName, TenantId};

#[derive(serde::Deserialize)]
struct GoldenCase {
    tenant_id: String,
    schema_name: String,
}

const GOLDEN: &str = include_str!("schema-golden.json");

#[test]
fn schema_names_match_the_shared_golden_vectors() {
    let cases: Vec<GoldenCase> =
        serde_json::from_str(GOLDEN).expect("golden fixture is valid JSON");
    assert!(
        cases.len() >= 4,
        "golden fixture must carry at least 4 vectors"
    );

    for case in &cases {
        let id = TenantId::try_parse(&case.tenant_id)
            .unwrap_or_else(|e| panic!("fixture UUID {} invalid: {:?}", case.tenant_id, e));
        let schema = SchemaName::from_tenant_id(id);
        assert_eq!(
            schema.as_str(),
            case.schema_name,
            "golden mismatch for {}",
            case.tenant_id
        );
        // The fixture value itself must round-trip strict parse.
        assert_eq!(
            SchemaName::try_parse(&case.schema_name).unwrap().as_str(),
            case.schema_name
        );
    }
}

#[test]
fn unknown_and_malformed_schema_names_fail_closed() {
    for bad in ["", "tenant_", "tenant_550E8400E29B41D4", "sensor", "public"] {
        assert!(SchemaName::try_parse(bad).is_err(), "{bad} must fail parse");
    }
}
