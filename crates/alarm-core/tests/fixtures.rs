//! Shared-fixture conformance test for `alarm-core`.
//!
//! Reads `libs/sensor-contracts/fixtures/alarm/decision-core.json` — the SAME
//! file the TypeScript twin (`libs/alarm-core/src/decision-core.spec.ts`) drives
//! through the wasm façade — and asserts each case against the native kernel. A
//! divergence between the two engines' decision math would fail in exactly one
//! language. The fixture path is relative (not copied), so one edit reddens both
//! legs (the same discipline as `contract_fixtures_tests.rs`).

#![allow(clippy::unwrap_used, clippy::panic, clippy::print_stdout)]

use std::path::PathBuf;

use serde::Deserialize;
use serde_json::Value;

use alarm_core::{DEFAULT_EPSILON, delay_elapsed, evaluate_condition, is_outside_deadband};

#[derive(Debug, Deserialize)]
struct Suite {
    #[serde(default)]
    epsilon: Option<f64>,
    condition: Vec<Value>,
    deadband: Vec<Value>,
    delay: Vec<Value>,
}

fn fixture() -> Suite {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../libs/sensor-contracts/fixtures/alarm/decision-core.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("malformed fixture: {e}"))
}

fn f64_of(v: &Value, key: &str) -> f64 {
    v.get(key)
        .and_then(Value::as_f64)
        .unwrap_or_else(|| panic!("case missing numeric '{key}': {v}"))
}

fn u64_of(v: &Value, key: &str) -> u64 {
    v.get(key)
        .and_then(Value::as_u64)
        .unwrap_or_else(|| panic!("case missing integer '{key}': {v}"))
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("case missing string '{key}': {v}"))
}

fn name_of(v: &Value) -> String {
    v.get("name")
        .and_then(Value::as_str)
        .unwrap_or("<unnamed>")
        .to_string()
}

#[test]
fn every_alarm_decision_fixture_matches() {
    let suite = fixture();
    let epsilon = suite.epsilon.unwrap_or(DEFAULT_EPSILON);
    let mut count = 0_usize;

    for case in &suite.condition {
        let got = evaluate_condition(
            str_of(case, "operator"),
            f64_of(case, "value"),
            f64_of(case, "threshold"),
            epsilon,
        );
        let want = case.get("expected").and_then(Value::as_bool).unwrap();
        assert_eq!(got, want, "condition case '{}'", name_of(case));
        count += 1;
    }

    for case in &suite.deadband {
        let got = is_outside_deadband(
            str_of(case, "operator"),
            f64_of(case, "value"),
            f64_of(case, "threshold"),
            f64_of(case, "deadband"),
        );
        let want = case.get("expected").and_then(Value::as_bool).unwrap();
        assert_eq!(got, want, "deadband case '{}'", name_of(case));
        count += 1;
    }

    for case in &suite.delay {
        let elapsed = u64_of(case, "elapsed_ms");
        let delay = u64_of(case, "delay_ms");
        let got = delay_elapsed(elapsed, delay);
        let want = case.get("expected").and_then(Value::as_bool).unwrap();
        assert_eq!(got, want, "delay case '{}'", name_of(case));
        count += 1;
    }

    assert!(count >= 20, "expected a substantial fixture suite, got {count}");
    println!("[alarm-core] {count} decision fixtures asserted");
}
