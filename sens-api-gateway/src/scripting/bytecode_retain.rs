//! RETAIN variable persistence bridge — Batch 175 Faz 3
//! (plan R-1).
//!
//! ## WHY
//!
//! `VAR_RETAIN` variables in IEC 61131-3 keep their
//! values across power cycles. Batch 175 extended
//! `Bytecode.retain_vars` to carry (name, local_index,
//! type) triples so the VM knows which locals slot to
//! restore. This module now provides the load / save
//! bridge between those declarations + the existing
//! `scripting::persistence::SqlitePersistence` store.
//!
//! ## Lifecycle
//!
//! Per scan tick (once the orchestrator wires this in):
//! 1. `load_retain_vars` — reads persisted values +
//!    writes them into the VM's locals slice BEFORE
//!    `ScriptVm::run_with_io`. First tick with no
//!    prior persistence sees defaults (Bool(false) /
//!    Int(0) / Real(0.0)) matching the VM's zero-init
//!    pattern.
//! 2. Program runs; retain values mutate through
//!    standard LoadLocal / StoreLocal opcodes.
//! 3. `save_retain_vars` — reads the final values
//!    from locals + persists them AFTER the run.
//!
//! Type discipline: persisted JSON values are tagged
//! with the `StValue` serde format. Load-time type
//! check rejects corrupt / drifted rows rather than
//! silently coercing.
//!
//! ## Scope boundary
//!
//! Orchestrator wiring (per-tick load/save around
//! `run_scan_tick`) lands in a future batch that hooks
//! this into `bytecode_scan_cycle_task`. Batch 175
//! owns the primitives + round-trip tests.

#![allow(dead_code)]

use super::bytecode::{StValue, StValueType};
use super::persistence::{PersistenceError, SqlitePersistence};

/// Retain-bridge failure taxonomy. Distinct from
/// `PersistenceError` so the caller knows whether the
/// problem is SQLCipher (treat-as-fatal) vs type drift
/// (treat-as-data-issue).
#[derive(Debug)]
pub enum RetainError {
    /// Underlying SQLCipher / serde failure.
    Persistence(PersistenceError),
    /// Persisted JSON decoded to the wrong StValue
    /// variant for the bytecode's declared type.
    TypeDrift {
        var_name: String,
        expected: StValueType,
        got_json: String,
    },
    /// `local_index` ≥ locals slice length. Defense-in-
    /// depth against a Bytecode whose retain_vars point
    /// past the allocated locals slot array.
    BadLocalIndex {
        var_name: String,
        index: u32,
        locals_len: usize,
    },
}

impl std::fmt::Display for RetainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Persistence(e) => {
                write!(f, "retain: persistence: {}", e)
            }
            Self::TypeDrift { var_name, expected, got_json } => write!(
                f,
                "retain: type drift on `{}`: expected {:?}, got JSON `{}`",
                var_name, expected, got_json
            ),
            Self::BadLocalIndex { var_name, index, locals_len } => write!(
                f,
                "retain: bad local_index on `{}`: index={} >= locals_len={}",
                var_name, index, locals_len
            ),
        }
    }
}

impl std::error::Error for RetainError {}

impl From<PersistenceError> for RetainError {
    fn from(e: PersistenceError) -> Self {
        Self::Persistence(e)
    }
}

/// Convert an `StValue` to the `serde_json::Value`
/// shape the persistence layer stores. Uses the same
/// tagged-enum encoding as `StValue`'s own serde impl
/// so load + save round-trip bit-identically.
pub fn stvalue_to_json(v: &StValue) -> serde_json::Value {
    serde_json::to_value(v).expect("StValue serde never fails")
}

/// Convert a persisted `serde_json::Value` back to an
/// `StValue`, validating against the bytecode's declared
/// type. Mismatch yields `RetainError::TypeDrift`.
pub fn json_to_stvalue(
    v: &serde_json::Value,
    var_name: &str,
    expected: StValueType,
) -> Result<StValue, RetainError> {
    let parsed: StValue = match serde_json::from_value(v.clone()) {
        Ok(s) => s,
        Err(_) => {
            return Err(RetainError::TypeDrift {
                var_name: var_name.to_string(),
                expected,
                got_json: v.to_string(),
            });
        }
    };
    let got_type = match parsed {
        StValue::Bool(_) => StValueType::Bool,
        StValue::Int(_) => StValueType::Int,
        StValue::Real(_) => StValueType::Real,
    };
    if got_type != expected {
        return Err(RetainError::TypeDrift {
            var_name: var_name.to_string(),
            expected,
            got_json: v.to_string(),
        });
    }
    Ok(parsed)
}

/// Load every persisted RETAIN variable for `program_id`
/// into the VM's locals slice. Missing rows (first-boot
/// before any save) leave the corresponding locals slot
/// at the caller's initial value (VM zero-init).
pub async fn load_retain_vars(
    persistence: &SqlitePersistence,
    program_id: &str,
    retain_vars: &[(String, u32, StValueType)],
    locals: &mut [StValue],
) -> Result<(), RetainError> {
    for (name, local_index, declared_type) in retain_vars {
        let idx = *local_index as usize;
        if idx >= locals.len() {
            return Err(RetainError::BadLocalIndex {
                var_name: name.clone(),
                index: *local_index,
                locals_len: locals.len(),
            });
        }
        match persistence.load_async(program_id, name).await {
            Ok(Some(v)) => {
                let stv = json_to_stvalue(&v, name, *declared_type)?;
                locals[idx] = stv;
            }
            Ok(None) => {
                // First boot — persistence row not present.
                // VM's zero-init value stays.
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

/// Save every RETAIN variable's current value from the
/// VM's locals slice to persistence. Called AFTER
/// `ScriptVm::run_with_io` returns so committed scan-
/// cycle state is durable.
pub async fn save_retain_vars(
    persistence: &SqlitePersistence,
    program_id: &str,
    retain_vars: &[(String, u32, StValueType)],
    locals: &[StValue],
) -> Result<(), RetainError> {
    for (name, local_index, _declared_type) in retain_vars {
        let idx = *local_index as usize;
        if idx >= locals.len() {
            return Err(RetainError::BadLocalIndex {
                var_name: name.clone(),
                index: *local_index,
                locals_len: locals.len(),
            });
        }
        let json = stvalue_to_json(&locals[idx]);
        persistence.save_async(program_id, name, &json).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stvalue_to_json_roundtrips_each_variant() {
        for v in [
            StValue::Bool(true),
            StValue::Bool(false),
            StValue::Int(42),
            StValue::Int(-1),
            StValue::Real(3.14),
            StValue::Real(-0.0),
        ] {
            let json = stvalue_to_json(&v);
            let got = json_to_stvalue(
                &json,
                "v",
                match v {
                    StValue::Bool(_) => StValueType::Bool,
                    StValue::Int(_) => StValueType::Int,
                    StValue::Real(_) => StValueType::Real,
                },
            )
            .expect("ok");
            assert_eq!(v, got);
        }
    }

    #[test]
    fn json_to_stvalue_rejects_type_drift() {
        let json = stvalue_to_json(&StValue::Int(5));
        let err = json_to_stvalue(&json, "count", StValueType::Real)
            .expect_err("drift");
        match err {
            RetainError::TypeDrift { var_name, expected, .. } => {
                assert_eq!(var_name, "count");
                assert_eq!(expected, StValueType::Real);
            }
            other => panic!("expected TypeDrift, got {:?}", other),
        }
    }

    #[test]
    fn json_to_stvalue_rejects_malformed_json() {
        let not_stvalue = serde_json::json!({ "kind": "wibble" });
        let err = json_to_stvalue(&not_stvalue, "wat", StValueType::Int)
            .expect_err("malformed");
        assert!(matches!(err, RetainError::TypeDrift { .. }));
    }

    #[tokio::test]
    async fn load_retain_vars_fills_locals_from_persistence() {
        let persistence = SqlitePersistence::in_memory().expect("ok");
        persistence
            .save_async(
                "prog1",
                "counter",
                &stvalue_to_json(&StValue::Int(99)),
            )
            .await
            .expect("save counter");
        persistence
            .save_async(
                "prog1",
                "flag",
                &stvalue_to_json(&StValue::Bool(true)),
            )
            .await
            .expect("save flag");

        // Locals: index 0 = counter (Int), index 1 = flag (Bool).
        let retain_vars = vec![
            ("counter".to_string(), 0u32, StValueType::Int),
            ("flag".to_string(), 1u32, StValueType::Bool),
        ];
        let mut locals = vec![StValue::Bool(false); 2];
        load_retain_vars(&persistence, "prog1", &retain_vars, &mut locals)
            .await
            .expect("load");
        assert_eq!(locals[0], StValue::Int(99));
        assert_eq!(locals[1], StValue::Bool(true));
    }

    #[tokio::test]
    async fn load_retain_vars_missing_row_leaves_default() {
        let persistence = SqlitePersistence::in_memory().expect("ok");
        let retain_vars = vec![
            ("first_boot_counter".to_string(), 0u32, StValueType::Int),
        ];
        let mut locals = vec![StValue::Int(7)]; // caller's default
        load_retain_vars(&persistence, "prog1", &retain_vars, &mut locals)
            .await
            .expect("load");
        // No persisted row → caller's default stays.
        assert_eq!(locals[0], StValue::Int(7));
    }

    #[tokio::test]
    async fn save_retain_vars_persists_each_entry() {
        let persistence = SqlitePersistence::in_memory().expect("ok");
        let retain_vars = vec![
            ("water_level".to_string(), 0u32, StValueType::Real),
            ("is_draining".to_string(), 1u32, StValueType::Bool),
        ];
        let locals = vec![StValue::Real(42.5), StValue::Bool(true)];
        save_retain_vars(&persistence, "prog1", &retain_vars, &locals)
            .await
            .expect("save");

        // Load back + verify.
        let back = persistence
            .load_async("prog1", "water_level")
            .await
            .expect("load ok")
            .expect("present");
        assert_eq!(
            json_to_stvalue(&back, "water_level", StValueType::Real).expect("ok"),
            StValue::Real(42.5)
        );
        let back_bool = persistence
            .load_async("prog1", "is_draining")
            .await
            .expect("load ok")
            .expect("present");
        assert_eq!(
            json_to_stvalue(&back_bool, "is_draining", StValueType::Bool).expect("ok"),
            StValue::Bool(true)
        );
    }

    #[tokio::test]
    async fn load_bad_local_index_errors() {
        let persistence = SqlitePersistence::in_memory().expect("ok");
        let retain_vars = vec![
            ("wild".to_string(), 99u32, StValueType::Int),
        ];
        let mut locals = vec![StValue::Bool(false); 2];
        let err = load_retain_vars(&persistence, "prog1", &retain_vars, &mut locals)
            .await
            .expect_err("bad idx");
        match err {
            RetainError::BadLocalIndex { index, locals_len, .. } => {
                assert_eq!(index, 99);
                assert_eq!(locals_len, 2);
            }
            other => panic!("expected BadLocalIndex, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn save_bad_local_index_errors() {
        let persistence = SqlitePersistence::in_memory().expect("ok");
        let retain_vars = vec![
            ("wild".to_string(), 99u32, StValueType::Int),
        ];
        let locals = vec![StValue::Bool(false); 2];
        let err = save_retain_vars(&persistence, "prog1", &retain_vars, &locals)
            .await
            .expect_err("bad idx");
        assert!(matches!(err, RetainError::BadLocalIndex { .. }));
    }

    #[tokio::test]
    async fn load_rejects_persisted_type_drift() {
        // Program declares counter as Int; persistence
        // stores a Real. Load fails rather than silently
        // coercing.
        let persistence = SqlitePersistence::in_memory().expect("ok");
        persistence
            .save_async(
                "prog1",
                "counter",
                &stvalue_to_json(&StValue::Real(1.5)),
            )
            .await
            .expect("save");

        let retain_vars = vec![
            ("counter".to_string(), 0u32, StValueType::Int),
        ];
        let mut locals = vec![StValue::Int(0)];
        let err = load_retain_vars(&persistence, "prog1", &retain_vars, &mut locals)
            .await
            .expect_err("drift");
        assert!(matches!(err, RetainError::TypeDrift { .. }));
    }

    #[tokio::test]
    async fn round_trip_save_then_load_preserves_all_types() {
        let persistence = SqlitePersistence::in_memory().expect("ok");
        let retain_vars = vec![
            ("r".to_string(), 0u32, StValueType::Real),
            ("i".to_string(), 1u32, StValueType::Int),
            ("b".to_string(), 2u32, StValueType::Bool),
        ];
        let originals = vec![
            StValue::Real(std::f64::consts::PI),
            StValue::Int(-12345),
            StValue::Bool(true),
        ];
        save_retain_vars(&persistence, "roundtrip", &retain_vars, &originals)
            .await
            .expect("save");

        let mut loaded = vec![StValue::Bool(false); 3];
        load_retain_vars(&persistence, "roundtrip", &retain_vars, &mut loaded)
            .await
            .expect("load");
        assert_eq!(loaded, originals);
    }
}
