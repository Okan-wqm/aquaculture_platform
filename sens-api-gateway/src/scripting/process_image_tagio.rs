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
//!
//! ## Wire status (Batch #275 audit)
//!
//! Production wire confirmed:
//! - `bytecode_runner.rs:67` — `use super::process_image_tagio::
//!   {TagIo, TagIoError, SnapshotTagIo}` — the bytecode runner
//!   passes a SnapshotTagIo adapter into every ScriptVm tick
//!   so the VM's tag READ + tag WRITE opcodes flow through this
//!   adapter to/from the canonical `ProcessImage` snapshot.
//!
//! Per-item dead-code allow audit pending — blanket allow
//! retained as WHITELIST-with-reason while the future
//! RbacGatedWriter wrap (named in the docstring above) consumes
//! the remaining unused write helpers in a focused batch.

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
                        reason: format!("value {} out of INT range", raw),
                    });
                }
                Ok(StValue::Int(raw as i64))
            }
        }
    }

    fn write_tag(&self, tag_name: &str, value: StValue) -> Result<(), TagIoError> {
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

/// Map a `TagConfig.data_type` string (+ fallback to
/// `io_type`) to the VM's `StValueType`. Batch 172 Faz 3.
///
/// Accepted `data_type` strings (case-insensitive):
/// - `bool`, `boolean`, `bit` → Bool
/// - `int`, `int16`, `int32`, `integer`, `word`, `dword`,
///   `uint`, `uint16`, `uint32`, `sint`, `dint` → Int
/// - `real`, `float`, `float32`, `float64`, `double`,
///   `lreal` → Real
///
/// When `data_type` is empty or unrecognized, fallback to
/// `io_type`: DI / DO → Bool; AI / AO → Real.
///
/// Last-resort default is Real — matches the overwhelming
/// common aquaculture sensor case (pH, DO, temp, flow,
/// depth all Real).
pub fn infer_st_value_type(data_type: &str, io_type: crate::process_image::IoType) -> StValueType {
    let lowered = data_type.trim().to_ascii_lowercase();
    match lowered.as_str() {
        "bool" | "boolean" | "bit" => return StValueType::Bool,
        "int" | "int16" | "int32" | "integer" | "word" | "dword" | "uint" | "uint16" | "uint32"
        | "sint" | "dint" => return StValueType::Int,
        "real" | "float" | "float32" | "float64" | "double" | "lreal" => {
            return StValueType::Real;
        }
        _ => {}
    }

    // Fallback to io_type.
    use crate::process_image::IoType;
    match io_type {
        IoType::DI | IoType::DO => StValueType::Bool,
        IoType::AI | IoType::AO => StValueType::Real,
    }
}

/// Build the `declared_types` catalog consumed by
/// `SnapshotTagIo::new` from the authoritative
/// ProcessImage tag config set. Scan-cycle cadence
/// driver calls this once per scan tick (or per
/// boot + config-reload; Batch 172 scans on every
/// tick for simplicity — the config HashMap is small
/// and the clone is cheap vs the scan cycle cost).
pub async fn declared_types_from_process_image(
    pi: &crate::process_image::ProcessImage,
) -> HashMap<String, StValueType> {
    let configs = pi.get_configs().await;
    configs
        .into_iter()
        .map(|cfg| {
            let ty = infer_st_value_type(&cfg.data_type, cfg.io_type);
            (cfg.tag_name, ty)
        })
        .collect()
}

/// Capture a synchronous snapshot of the authoritative
/// ProcessImage tag values. Only quality-Good tags are
/// included — tags in Bad / CommFailure / Uncertain
/// state are EXCLUDED so the VM sees only trustworthy
/// inputs. The scan cycle that runs on this snapshot
/// treats an excluded tag as NotFound (fail-closed).
///
/// Runs in the async boundary — callers await the
/// RwLock read_lock. Returns a plain map so the sync
/// VM scan cycle can run without any tokio dependency.
pub async fn snapshot_process_image(
    pi: &crate::process_image::ProcessImage,
) -> HashMap<String, f64> {
    let all = pi.get_all_tags().await;
    all.into_iter()
        .filter_map(|(name, tv)| {
            // Life-safety: exclude non-Good tags.
            // ProcessImage::update_tag already holds
            // last-known-good on Bad quality, but for the
            // scan cycle we fail-closed — if the value is
            // not trustworthy, the VM doesn't see it.
            if matches!(
                tv.quality,
                crate::process_image::TagQuality::Good
                    | crate::process_image::TagQuality::Simulated
            ) {
                Some((name, tv.value))
            } else {
                None
            }
        })
        .collect()
}

/// Apply the drained pending-writes list to the
/// authoritative ProcessImage. Each write becomes an
/// `update_tag_raw` call with `TagSource::Script` so
/// downstream consumers (audit, alarm engine, HMI)
/// see the origin of the value change.
///
/// Writes ALWAYS apply quality=Good — the VM has
/// already gated the value through compile-time
/// + Batch 156 runtime checks, so the engine
/// considers the script output authoritative.
///
/// Awaits once per write (ProcessImage::update_tag_raw
/// takes the inner lock). For a typical scan cycle with
/// O(10) writes this is negligible; future batches can
/// batch-commit if the write count grows.
pub async fn commit_pending_writes(
    pi: &crate::process_image::ProcessImage,
    writes: Vec<(String, StValue)>,
) {
    use crate::process_image::{TagQuality, TagSource};
    for (name, value) in writes {
        let as_f64 = stvalue_to_f64_for_process_image(&value);
        pi.update_tag_raw(&name, as_f64, TagQuality::Good, TagSource::Script)
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::super::bytecode::{Bytecode, Opcode};
    use super::super::bytecode_vm::{ScriptVm, VmOutcome};
    use super::*;

    fn mk_bc(opcodes: Vec<Opcode>, allowed: Vec<String>) -> Bytecode {
        Bytecode {
            program_id: "t".into(),
            program_name: "t".into(),
            tenant_id: None,
            policy_version: 0,
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
        assert_eq!(io.read_tag("water_temp"), Ok(StValue::Real(22.5)));
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
        let types = HashMap::from([("cycle_count".to_string(), StValueType::Int)]);
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
        io.write_tag("feeder_rate", StValue::Real(2.5)).expect("ok");
        io.write_tag("aerator_pwm", StValue::Real(0.3)).expect("ok");
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
        let types = HashMap::from([("pump_run".to_string(), StValueType::Bool)]);
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
        assert_eq!(stvalue_to_f64_for_process_image(&StValue::Bool(false)), 0.0);
        assert_eq!(stvalue_to_f64_for_process_image(&StValue::Bool(true)), 1.0);
    }

    #[test]
    fn stvalue_to_f64_for_int_casts_as_f64() {
        assert_eq!(stvalue_to_f64_for_process_image(&StValue::Int(42)), 42.0);
    }

    #[test]
    fn stvalue_to_f64_for_real_passes_through() {
        assert_eq!(stvalue_to_f64_for_process_image(&StValue::Real(3.14)), 3.14);
    }

    // ====================================================================
    // Batch 161 — ProcessImage bridge (async snapshot + commit)
    // ====================================================================

    use crate::process_image::{
        IoType, ProcessImage, ProtocolConfig, TagConfig, TagQuality, TagSource,
    };

    // ====================================================================
    // Batch 172 — declared-types inference from TagConfig
    // ====================================================================

    #[test]
    fn infer_bool_from_data_type_string() {
        assert_eq!(infer_st_value_type("bool", IoType::AI), StValueType::Bool);
        assert_eq!(
            infer_st_value_type("BOOLEAN", IoType::AI),
            StValueType::Bool
        );
        assert_eq!(infer_st_value_type("Bit", IoType::AI), StValueType::Bool);
    }

    #[test]
    fn infer_int_from_data_type_string() {
        for s in ["int", "Int16", "INT32", "word", "DWORD", "uint32"] {
            assert_eq!(
                infer_st_value_type(s, IoType::AI),
                StValueType::Int,
                "failed for `{}`",
                s
            );
        }
    }

    #[test]
    fn infer_real_from_data_type_string() {
        for s in ["real", "float", "Float32", "DOUBLE", "lreal"] {
            assert_eq!(
                infer_st_value_type(s, IoType::DI),
                StValueType::Real,
                "failed for `{}`",
                s
            );
        }
    }

    #[test]
    fn infer_fallback_to_io_type_when_data_type_unrecognized() {
        assert_eq!(infer_st_value_type("", IoType::DI), StValueType::Bool);
        assert_eq!(
            infer_st_value_type("unknown", IoType::DO),
            StValueType::Bool
        );
        assert_eq!(infer_st_value_type("", IoType::AI), StValueType::Real);
        assert_eq!(infer_st_value_type("wibble", IoType::AO), StValueType::Real);
    }

    #[tokio::test]
    async fn declared_types_builder_reads_process_image_configs() {
        let pi = ProcessImage::new();
        pi.set_configs(vec![
            TagConfig {
                tag_name: "water_temp".into(),
                io_type: IoType::AI,
                data_type: "real".into(),
                source: TagSource::I2c,
                poll_interval_ms: None,
                raw_min: None,
                raw_max: None,
                eng_min: None,
                eng_max: None,
                eng_unit: None,
                invert: false,
                alarm_hh: None,
                alarm_h: None,
                alarm_l: None,
                alarm_ll: None,
                deadband: None,
                protocol_config: ProtocolConfig::I2c {
                    bus: 1,
                    address: 0x66,
                    driver_type: crate::process_image::I2cDriverType::AtlasEzo {
                        sensor_type: crate::process_image::AtlasEzoType::Temp,
                    },
                },
            },
            TagConfig {
                tag_name: "pump_on".into(),
                io_type: IoType::DO,
                data_type: "bool".into(),
                source: TagSource::Gpio,
                poll_interval_ms: None,
                raw_min: None,
                raw_max: None,
                eng_min: None,
                eng_max: None,
                eng_unit: None,
                invert: false,
                alarm_hh: None,
                alarm_h: None,
                alarm_l: None,
                alarm_ll: None,
                deadband: None,
                protocol_config: ProtocolConfig::Gpio {
                    pin: 17,
                    direction: "output".into(),
                },
            },
            TagConfig {
                tag_name: "feeder_count".into(),
                io_type: IoType::AI,
                data_type: "uint32".into(),
                source: TagSource::Modbus,
                poll_interval_ms: None,
                raw_min: None,
                raw_max: None,
                eng_min: None,
                eng_max: None,
                eng_unit: None,
                invert: false,
                alarm_hh: None,
                alarm_h: None,
                alarm_l: None,
                alarm_ll: None,
                deadband: None,
                protocol_config: ProtocolConfig::Modbus {
                    slave_id: 1,
                    register: 100,
                    function: 3,
                    register_type: "holding".into(),
                },
            },
        ])
        .await;

        let catalog = declared_types_from_process_image(&pi).await;
        assert_eq!(catalog.get("water_temp"), Some(&StValueType::Real));
        assert_eq!(catalog.get("pump_on"), Some(&StValueType::Bool));
        assert_eq!(catalog.get("feeder_count"), Some(&StValueType::Int));
        assert_eq!(catalog.len(), 3);
    }

    #[tokio::test]
    async fn declared_types_builder_empty_configs_yields_empty_catalog() {
        let pi = ProcessImage::new();
        let catalog = declared_types_from_process_image(&pi).await;
        assert!(catalog.is_empty());
    }

    #[tokio::test]
    async fn snapshot_process_image_captures_good_quality_tags() {
        let pi = ProcessImage::new();
        pi.update_tag_raw("water_temp", 22.5, TagQuality::Good, TagSource::Modbus)
            .await;
        pi.update_tag_raw("dissolved_oxygen", 7.1, TagQuality::Good, TagSource::I2c)
            .await;

        let snap = snapshot_process_image(&pi).await;
        assert_eq!(snap.get("water_temp"), Some(&22.5));
        assert_eq!(snap.get("dissolved_oxygen"), Some(&7.1));
        assert_eq!(snap.len(), 2);
    }

    #[tokio::test]
    async fn snapshot_process_image_excludes_bad_quality_tags() {
        let pi = ProcessImage::new();
        pi.update_tag_raw(
            "flaky_sensor",
            0.0,
            TagQuality::CommFailure,
            TagSource::Modbus,
        )
        .await;
        pi.update_tag_raw("good_sensor", 42.0, TagQuality::Good, TagSource::Modbus)
            .await;

        let snap = snapshot_process_image(&pi).await;
        assert!(!snap.contains_key("flaky_sensor"));
        assert_eq!(snap.get("good_sensor"), Some(&42.0));
    }

    #[tokio::test]
    async fn commit_pending_writes_updates_process_image_with_script_source() {
        let pi = ProcessImage::new();
        // Seed with initial value so update_tag_raw keeps
        // raw_value + timestamp semantics clean.
        pi.update_tag_raw("feeder_rate", 0.0, TagQuality::Good, TagSource::Modbus)
            .await;

        let writes = vec![
            ("feeder_rate".to_string(), StValue::Real(2.5)),
            ("aerator_on".to_string(), StValue::Bool(true)),
        ];
        commit_pending_writes(&pi, writes).await;

        let feeder = pi.get_tag("feeder_rate").await.expect("exists");
        assert_eq!(feeder.value, 2.5);
        assert_eq!(feeder.source, TagSource::Script);
        assert_eq!(feeder.quality, TagQuality::Good);

        let aerator = pi.get_tag("aerator_on").await.expect("exists");
        assert_eq!(aerator.value, 1.0); // Bool true → 1.0
        assert_eq!(aerator.source, TagSource::Script);
    }

    #[tokio::test]
    async fn full_scan_cycle_snapshot_run_commit_roundtrip() {
        // Seed process image with water_temp = 20.0.
        let pi = ProcessImage::new();
        pi.update_tag_raw("water_temp", 20.0, TagQuality::Good, TagSource::Modbus)
            .await;
        pi.update_tag_raw("setpoint", 0.0, TagQuality::Good, TagSource::Modbus)
            .await;

        // Scan cycle:
        // Step 1: snapshot.
        let snap = snapshot_process_image(&pi).await;
        let io = SnapshotTagIo::new_reals_only(snap);

        // Step 2: compile-free bytecode simulating
        // `setpoint := water_temp + 5.0`.
        let b = mk_bc(
            vec![
                Opcode::LoadTag {
                    name: "water_temp".into(),
                },
                Opcode::PushConst {
                    value: StValue::Real(5.0),
                },
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

        // Step 3: commit.
        commit_pending_writes(&pi, io.drain_pending_writes()).await;

        // Verify: process image now has setpoint = 25.0
        // with Script source.
        let sp = pi.get_tag("setpoint").await.expect("exists");
        assert_eq!(sp.value, 25.0);
        assert_eq!(sp.source, TagSource::Script);
    }

    #[test]
    fn vm_with_snapshot_io_end_to_end() {
        // LoadTag(water_temp) → 20.0
        // PushConst 5.0
        // AddReal → 25.0
        // WriteTag(setpoint)  (allowlist includes setpoint)
        // Return
        let snap = HashMap::from([("water_temp".to_string(), 20.0)]);
        let io = SnapshotTagIo::new_reals_only(snap);

        let b = mk_bc(
            vec![
                Opcode::LoadTag {
                    name: "water_temp".into(),
                },
                Opcode::PushConst {
                    value: StValue::Real(5.0),
                },
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
