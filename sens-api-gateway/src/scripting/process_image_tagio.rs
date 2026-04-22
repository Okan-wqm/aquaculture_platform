//! ProcessImage ↔ TagIo adapter — Batch 160 Faz 3 (plan R-1).
//!
//! ## WHY
//!
//! Batch 159 introduced the `TagIo` trait so the VM can read /
//! write tags without coupling to a specific backend.
//! `ProcessImage` (the agent's authoritative tag store) is
//! async (uses `tokio::sync::RwLock`) but the VM runs a
//! synchronous scan-cycle dispatch loop. Direct integration
//! would either require making the VM async (heavy refactor)
//! or block the async runtime on a scan cycle (poor).
//!
//! Batch 160 lands the SNAPSHOT-AND-COMMIT pattern that
//! matches IEC 61131-3 scan-cycle semantics:
//! 1. **Before scan**: snapshot the process image tags into a
//!    local `HashMap<String, f64>`.
//! 2. **During scan**: VM runs against `SnapshotTagIo`
//!    synchronously — reads resolve from the snapshot,
//!    writes buffer into a pending-writes Vec.
//! 3. **After scan**: `drain_pending_writes` yields the
//!    buffered writes; the engine consumer commits them back
//!    to `ProcessImage` via `ProcessImage::update_tag_raw`
//!    in an async boundary.
//!
//! The snapshot + commit boundaries are symmetric so the
//! VM never sees partial updates from concurrent scan
//! cycles — the scan cycle is the atomic unit.
//!
//! ## Declared types
//!
//! ProcessImage stores every tag as `f64`. The VM expects
//! `StValue { Bool, Int, Real }`. The adapter needs the
//! declared type per tag (from the compiler's
//! `TagDescriptor` catalog) to convert:
//! - Bool: `f64 != 0.0`
//! - Int: `f64 as i64` (caller-responsible magnitude check)
//! - Real: direct
//!
//! Unknown tag → `TagIoError::NotFound`. Tag without a
//! declared type → treat as Real (most common case).
//!
//! ## What's not in Batch 160
//!
//! - The actual ProcessImage snapshot/commit bridge — the
//!   engine consumer calls `ProcessImage::get_all_tags()
//!   .await` to build the snapshot + loops over drained
//!   pending writes to call `ProcessImage::update_tag_raw`.
//!   That integration lands in the ScriptEngine Phase 5b
//!   batch.
//! - RBAC enforcement at the write boundary — the Batch
//!   156 runtime gate already blocks disallowed tag
//!   names + safe-state-pinned tags; `SnapshotTagIo`
//!   trusts the VM's gated input + performs the write
//!   unconditionally. The future RbacGatedWriter layer
//!   wraps this adapter for permission-aware writes.

#![allow(dead_code)]

use std::cell::RefCell;
use std::collections::HashMap;

use super::bytecode::{StValue, StValueType};
use super::bytecode_vm::{TagIo, TagIoError};

/// Synchronous TagIo backed by a frozen snapshot of tag
/// values + a pending-writes buffer drained after the
/// scan cycle.
#[derive(Debug)]
pub struct SnapshotTagIo {
    /// Tag name → numeric value captured at scan-cycle
    /// start. VM reads from this map.
    snapshot: HashMap<String, f64>,
    /// Tag name → declared type from the compiler's tag
    /// catalog. Drives the f64 → StValue conversion.
    /// Missing entry → Real (default numeric type).
    declared_types: HashMap<String, StValueType>,
    /// Buffered writes the VM issued during the scan
    /// cycle. Commit-phase engine consumer drains this
    /// + applies each to ProcessImage.
    pending_writes: RefCell<Vec<(String, StValue)>>,
}

impl SnapshotTagIo {
    /// Construct a fresh adapter from a pre-captured
    /// snapshot + a declared-types catalog. Both maps
    /// are owned by the adapter (caller moves them in).
    pub fn new(
        snapshot: HashMap<String, f64>,
        declared_types: HashMap<String, StValueType>,
    ) -> Self {
        Self {
            snapshot,
            declared_types,
            pending_writes: RefCell::new(Vec::new()),
        }
    }

    /// Test-friendly constructor: declared-types map
    /// omitted (every tag treated as Real).
    pub fn new_reals_only(snapshot: HashMap<String, f64>) -> Self {
        Self::new(snapshot, HashMap::new())
    }

    /// Drain the pending-writes buffer. Consumers call
    /// this AFTER `ScriptVm::run_with_io` returns to
    /// obtain the list of tag writes the program issued
    /// during the scan cycle. Clears the internal
    /// buffer so the same adapter can be re-used for
    /// the next cycle (re-snapshot first).
    pub fn drain_pending_writes(&self) -> Vec<(String, StValue)> {
        std::mem::take(&mut *self.pending_writes.borrow_mut())
    }

    /// Current pending-writes count — diagnostic helper.
    pub fn pending_write_count(&self) -> usize {
        self.pending_writes.borrow().len()
    }
}

impl TagIo for SnapshotTagIo {
    fn read_tag(&self, tag_name: &str) -> Result<StValue, TagIoError> {
        let raw = self
            .snapshot
            .get(tag_name)
            .copied()
            .ok_or_else(|| TagIoError::NotFound {
                tag: tag_name.to_string(),
            })?;

        let declared = self
            .declared_types
            .get(tag_name)
            .copied()
            .unwrap_or(StValueType::Real);

        match declared {
            StValueType::Real => Ok(StValue::Real(raw)),
            StValueType::Bool => Ok(StValue::Bool(raw != 0.0)),
            StValueType::Int => {
                // `as i64` is deterministic for finite
                // f64 values but saturates at i64::MAX /
                // i64::MIN for out-of-range magnitudes +
                // yields 0 for NaN. Range-check here so
                // callers see a structured error rather
                // than a silently clamped value.
                if raw.is_nan() {
                    return Err(TagIoError::Internal {
                        tag: tag_name.to_string(),
                        reason: "NaN cannot be converted to INT".to_string(),
                    });
                }
                if raw > i64::MAX as f64 || raw < i64::MIN as f64 {
                    return Err(TagIoError::Internal {
                        tag: tag_name.to_string(),
                        reason: format!(
                            "value {} out of INT range",
                            raw
                        ),
                    });
                }
                Ok(StValue::Int(raw as i64))
            }
        }
    }

    fn write_tag(
        &self,
        tag_name: &str,
        value: StValue,
    ) -> Result<(), TagIoError> {
        // Type match against declared type — Bool/Int/Real
        // must align with the compiler's tag catalog.
        // Unknown tags default to Real.
        let declared = self
            .declared_types
            .get(tag_name)
            .copied()
            .unwrap_or(StValueType::Real);
        let got = match value {
            StValue::Bool(_) => StValueType::Bool,
            StValue::Int(_) => StValueType::Int,
            StValue::Real(_) => StValueType::Real,
        };
        if declared != got {
            return Err(TagIoError::TypeMismatch {
                tag: tag_name.to_string(),
                expected: declared,
                got,
            });
        }
        self.pending_writes
            .borrow_mut()
            .push((tag_name.to_string(), value));
        Ok(())
    }
}

/// Convert a drained `StValue` write back to the f64
/// representation ProcessImage uses. Bool → 0.0/1.0,
/// Int → as f64, Real → direct.
///
/// Used by the ScriptEngine Phase 5b commit loop when
/// applying pending writes to the actual ProcessImage
/// via `ProcessImage::update_tag_raw`.
pub fn stvalue_to_f64_for_process_image(v: &StValue) -> f64 {
    match v {
        StValue::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        StValue::Int(n) => *n as f64,
        StValue::Real(x) => *x,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::bytecode::{Bytecode, Opcode};
    use super::super::bytecode_vm::{ScriptVm, VmOutcome};

    fn mk_bc(
        opcodes: Vec<Opcode>,
        allowed: Vec<String>,
    ) -> Bytecode {
        Bytecode {
            program_id: "t".into(),
            program_name: "t".into(),
            max_gas_per_tick: 1_000_000,
            local_count: 0,
            retain_vars: vec![],
            allowed_write_tags: allowed,
            safe_state_pinned_tags: vec![],
            opcodes,
        }
    }

    #[test]
    fn read_real_tag_returns_real_stvalue() {
        let snap = HashMap::from([("water_temp".to_string(), 22.5)]);
        let io = SnapshotTagIo::new_reals_only(snap);
        assert_eq!(
            io.read_tag("water_temp"),
            Ok(StValue::Real(22.5))
        );
    }

    #[test]
    fn read_bool_tag_returns_bool_stvalue() {
        let snap = HashMap::from([
            ("pump_running".to_string(), 1.0),
            ("alarm_active".to_string(), 0.0),
        ]);
        let types = HashMap::from([
            ("pump_running".to_string(), StValueType::Bool),
            ("alarm_active".to_string(), StValueType::Bool),
        ]);
        let io = SnapshotTagIo::new(snap, types);
        assert_eq!(io.read_tag("pump_running"), Ok(StValue::Bool(true)));
        assert_eq!(io.read_tag("alarm_active"), Ok(StValue::Bool(false)));
    }

    #[test]
    fn read_int_tag_returns_int_stvalue() {
        let snap = HashMap::from([("cycle_count".to_string(), 42.0)]);
        let types =
            HashMap::from([("cycle_count".to_string(), StValueType::Int)]);
        let io = SnapshotTagIo::new(snap, types);
        assert_eq!(io.read_tag("cycle_count"), Ok(StValue::Int(42)));
    }

    #[test]
    fn read_int_tag_nan_returns_internal_error() {
        let snap = HashMap::from([("bad".to_string(), f64::NAN)]);
        let types = HashMap::from([("bad".to_string(), StValueType::Int)]);
        let io = SnapshotTagIo::new(snap, types);
        match io.read_tag("bad") {
            Err(TagIoError::Internal { reason, .. }) => {
                assert!(reason.contains("NaN"));
            }
            other => panic!("expected Internal, got {:?}", other),
        }
    }

    #[test]
    fn read_int_tag_out_of_range_returns_internal_error() {
        let snap = HashMap::from([("huge".to_string(), 1e25)]);
        let types = HashMap::from([("huge".to_string(), StValueType::Int)]);
        let io = SnapshotTagIo::new(snap, types);
        match io.read_tag("huge") {
            Err(TagIoError::Internal { reason, .. }) => {
                assert!(reason.contains("out of INT range"));
            }
            other => panic!("expected Internal, got {:?}", other),
        }
    }

    #[test]
    fn read_missing_tag_returns_not_found() {
        let io = SnapshotTagIo::new_reals_only(HashMap::new());
        assert_eq!(
            io.read_tag("nope"),
            Err(TagIoError::NotFound {
                tag: "nope".to_string()
            })
        );
    }

    #[test]
    fn write_buffers_into_pending_writes() {
        let io = SnapshotTagIo::new_reals_only(HashMap::new());
        io.write_tag("feeder_rate", StValue::Real(2.5))
            .expect("ok");
        io.write_tag("aerator_pwm", StValue::Real(0.3))
            .expect("ok");
        assert_eq!(io.pending_write_count(), 2);
        let drained = io.drain_pending_writes();
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0], ("feeder_rate".into(), StValue::Real(2.5)));
        assert_eq!(drained[1], ("aerator_pwm".into(), StValue::Real(0.3)));
        // After drain, buffer is empty — next cycle
        // starts fresh.
        assert_eq!(io.pending_write_count(), 0);
    }

    #[test]
    fn write_type_mismatch_rejects() {
        let snap = HashMap::new();
        let types = HashMap::from([
            ("pump_run".to_string(), StValueType::Bool),
        ]);
        let io = SnapshotTagIo::new(snap, types);
        match io.write_tag("pump_run", StValue::Real(1.0)) {
            Err(TagIoError::TypeMismatch { tag, expected, got }) => {
                assert_eq!(tag, "pump_run");
                assert_eq!(expected, StValueType::Bool);
                assert_eq!(got, StValueType::Real);
            }
            other => panic!("expected TypeMismatch, got {:?}", other),
        }
        assert_eq!(io.pending_write_count(), 0);
    }

    #[test]
    fn stvalue_to_f64_for_bool_maps_zero_and_one() {
        assert_eq!(
            stvalue_to_f64_for_process_image(&StValue::Bool(false)),
            0.0
        );
        assert_eq!(
            stvalue_to_f64_for_process_image(&StValue::Bool(true)),
            1.0
        );
    }

    #[test]
    fn stvalue_to_f64_for_int_casts_as_f64() {
        assert_eq!(
            stvalue_to_f64_for_process_image(&StValue::Int(42)),
            42.0
        );
    }

    #[test]
    fn stvalue_to_f64_for_real_passes_through() {
        assert_eq!(
            stvalue_to_f64_for_process_image(&StValue::Real(3.14)),
            3.14
        );
    }

    #[test]
    fn vm_with_snapshot_io_end_to_end() {
        // LoadTag(water_temp) → 20.0
        // PushConst 5.0
        // AddReal → 25.0
        // WriteTag(setpoint)  (allowlist includes setpoint)
        // Return
        let snap =
            HashMap::from([("water_temp".to_string(), 20.0)]);
        let io = SnapshotTagIo::new_reals_only(snap);

        let b = mk_bc(
            vec![
                Opcode::LoadTag {
                    name: "water_temp".into(),
                },
                Opcode::PushConst { value: StValue::Real(5.0) },
                Opcode::AddReal,
                Opcode::WriteTag {
                    name: "setpoint".into(),
                },
                Opcode::Return,
            ],
            vec!["setpoint".into()],
        );

        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run_with_io(&b, &io), VmOutcome::Returned);

        let drained = io.drain_pending_writes();
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0], ("setpoint".into(), StValue::Real(25.0)));
    }
}
