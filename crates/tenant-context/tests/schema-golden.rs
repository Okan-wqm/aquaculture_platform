//! Cross-language golden vectors (Task 3, SENSOR-CRITICAL-089).
//!
//! This fixture is shared VERBATIM with the TypeScript SSoT test
//! (tests/invariants/tenant-schema-golden.spec.ts reads the same JSON).
//! Both languages must map every UUID to the identical
//! `tenant_<16-hex>` schema or the sidecar writes into schemas the
//! platform cannot see.
//!
//! No unwrap/expect/panic/assert!(false): the workspace clippy profile
//! denies them in every target, tests included — errors accumulate into
//! a vector and one assert reports them all.

use tenant_context::{SchemaName, TenantId};

#[derive(serde::Deserialize)]
struct GoldenCase {
    tenant_id: String,
    schema_name: String,
}

const GOLDEN: &str = include_str!("schema-golden.json");

#[test]
fn schema_names_match_the_shared_golden_vectors() {
    let mut errors: Vec<String> = Vec::new();

    let cases: Vec<GoldenCase> = match serde_json::from_str(GOLDEN) {
        Ok(cases) => cases,
        Err(e) => {
            errors.push(format!("golden fixture is not valid JSON: {e:?}"));
            Vec::new()
        }
    };
    if cases.len() < 4 {
        errors.push(format!(
            "golden fixture must carry at least 4 vectors, has {}",
            cases.len()
        ));
    }

    for case in &cases {
        let id = match TenantId::try_parse(&case.tenant_id) {
            Ok(id) => id,
            Err(e) => {
                errors.push(format!("fixture UUID {} invalid: {:?}", case.tenant_id, e));
                continue;
            }
        };
        let schema = SchemaName::from_tenant_id(id);
        if schema.as_str() != case.schema_name {
            errors.push(format!(
                "golden mismatch for {}: rust says {}, fixture says {}",
                case.tenant_id,
                schema.as_str(),
                case.schema_name
            ));
        }
        // The fixture value itself must round-trip strict parse.
        match SchemaName::try_parse(&case.schema_name) {
            Ok(round) => {
                if round.as_str() != case.schema_name {
                    errors.push(format!(
                        "fixture schema {} does not round-trip parse",
                        case.schema_name
                    ));
                }
            }
            Err(e) => errors.push(format!(
                "fixture schema {} must round-trip parse: {:?}",
                case.schema_name, e
            )),
        }
    }

    let report = errors.join("\n");
    assert!(errors.is_empty(), "golden vector failures:\n{report}");
}

#[test]
fn unknown_and_malformed_schema_names_fail_closed() {
    for bad in ["", "tenant_", "tenant_550E8400E29B41D4", "sensor", "public"] {
        assert!(SchemaName::try_parse(bad).is_err(), "{bad} must fail parse");
    }
}
