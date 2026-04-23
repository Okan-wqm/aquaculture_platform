//! ST Bytecode IR primitives (Batch 148 Faz 3 / plan R-1
//! Plan B foundation).
//!
//! ## WHY
//!
//! Plan §3 R-1 + plan §5 Faz 3 specify a bytecode
//! compiler + stack VM as the replacement for the
//! original "tree-walking AST interpreter" plan.
//! Reasons from plan R-1 rationale:
//! - Deterministic execution (tick başına sabit opcode
//!   count).
//! - Gas metering (authenticated DoS kapatma).
//! - RBAC bypass prevention (WRITE_TAG opcode goes
//!   through `RbacGatedWriter`, not direct tag access).
//! - Immutable bytecode (verify-once-execute-many).
//! - Industry-standard (CODESYS / TwinCAT / Beckhoff
//!   use this pattern).
//!
//! This batch lands the IR TYPES only — primitive-first
//! discipline (same pattern as Batch 111 BootloaderHandle
//! + Batch 140 EdgeLicenseLimits). Compiler (AST →
//! bytecode) + VM (stack interpreter + gas metering) +
//! RETAIN persistence binding + FB invoke integration
//! land in subsequent Faz 3 batches.
//!
//! ## Scope of Batch 148
//!
//! - `StValue` runtime value enum (Bool / Int / Real).
//!   String + Time types defer to future batches —
//!   they add non-trivial heap / conversion logic.
//! - `StdlibFunctionId` enum — stable 1-byte IDs for
//!   the plan A stdlib corpus.
//! - `Opcode` enum — ~25 variants covering stack,
//!   arithmetic, comparison, logic, control, memory,
//!   tag IO, safety primitives. FB invoke + string ops
//!   defer to future batches.
//! - `Bytecode` struct — program-level header +
//!   instruction vector.
//! - Serde (JSON) roundtrip for on-disk persistence.
//! - Wire-tag stability pin so persisted bytecode
//!   survives agent version upgrades.
//!
//! ## NOT in scope
//!
//! - Compiler (AST → Opcode stream). Future batch.
//! - Stack VM interpreter. Future batch.
//! - Gas metering enforcement. Future batch (opcode
//!   costs declared as const per variant here; VM
//!   consumes).
//! - FB invoke opcode (requires integration with
//!   existing `scripting::function_blocks`). Future
//!   batch.
//! - String operations (LEFT/RIGHT/MID/CONCAT/LEN/FIND).
//!   Future batch once String value variant lands.
//! - Immutable bytecode signature verification (ed25519
//!   over canonical_bytes). Future batch.
//! - Safe-state pinned-tag write rejection. Future
//!   batch — requires ProcessImage integration.
//!
//! Primitive-first batch (Batch 111 / 140 precedent).
//! `#![allow(dead_code)]` removed when Batch 149
//! compiler lands + consumes these types.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// Runtime value on the VM stack (Batch 148).
///
/// Narrow 3-variant subset of IEC 61131-3 types:
/// - IEC `BOOL` → `Bool`.
/// - IEC `SINT..LINT` + `USINT..ULINT` + `BYTE..LWORD`
///   (anything representable in i64) → `Int`.
/// - IEC `REAL` + `LREAL` → `Real`.
///
/// String / Time / Date variants land in future batches.
/// The compiler's type-inference maps AST DataType
/// (Batch 8+ `st_validator::DataType`) to these runtime
/// variants at compile time; the VM dispatches per-
/// variant opcode (AddInt vs AddReal) so there is no
/// runtime type tag overhead beyond the enum
/// discriminant.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum StValue {
    Bool(bool),
    Int(i64),
    Real(f64),
}

impl StValue {
    /// Stable 1-byte type discriminator for
    /// audit + debugging. Kept stable across releases —
    /// wire-format persisted bytecode pivots on these.
    pub const fn type_tag(&self) -> u8 {
        match self {
            Self::Bool(_) => 0,
            Self::Int(_) => 1,
            Self::Real(_) => 2,
        }
    }
}

/// Stdlib function identifier (Batch 148 subset of plan
/// A corpus). Stable 1-byte IDs ensure persisted bytecode
/// containing `StdlibCall(fn_id)` survives agent version
/// upgrades without re-compile.
///
/// Plan A corpus lists ~22 functions; Batch 148 pins the
/// 10 most-used numeric ones. String / time functions
/// defer to the future String-support batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StdlibFunctionId {
    /// ABS(x: Int) -> Int — integer absolute value.
    AbsInt,
    /// ABS(x: Real) -> Real — real absolute value.
    AbsReal,
    /// SQRT(x: Real) -> Real — square root.
    SqrtReal,
    /// LIMIT(min, x, max: Real) -> Real — 3-arg clamp.
    LimitReal,
    /// MIN(a, b: Real) -> Real.
    MinReal,
    /// MAX(a, b: Real) -> Real.
    MaxReal,
    /// SEL(cond: Bool, if_false: Real, if_true: Real) -> Real.
    SelReal,
    /// LN(x: Real) -> Real — natural log.
    LnReal,
    /// EXP(x: Real) -> Real — e^x.
    ExpReal,
    /// POW(base, exp: Real) -> Real.
    PowReal,
}

impl StdlibFunctionId {
    pub const fn wire_tag(self) -> u8 {
        match self {
            Self::AbsInt => 0,
            Self::AbsReal => 1,
            Self::SqrtReal => 2,
            Self::LimitReal => 3,
            Self::MinReal => 4,
            Self::MaxReal => 5,
            Self::SelReal => 6,
            Self::LnReal => 7,
            Self::ExpReal => 8,
            Self::PowReal => 9,
        }
    }
}

/// VM opcode (Batch 148 minimal set).
///
/// Stable wire_tag per variant — persisted bytecode
/// pivots on these bytes. Adding a variant = new wire
/// tag at the END (never renumber existing tags).
///
/// Opcode cost accounting: every variant consumes a
/// fixed gas cost at VM dispatch time. Cost pinned
/// in `gas_cost()` method per plan R-1 "gas metering"
/// requirement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Opcode {
    // ============================ Stack ops ============
    /// Push a constant onto the VM stack.
    PushConst { value: StValue },
    /// Pop top of stack + discard.
    Pop,
    /// Duplicate top of stack.
    Dup,

    // ======================= Integer arithmetic =======
    /// Pop two Ints, push their sum.
    AddInt,
    /// Pop two Ints, push their difference (b - a).
    SubInt,
    /// Pop two Ints, push their product.
    MulInt,
    /// Pop two Ints, push their quotient (b / a). VM
    /// checks divisor != 0 + trips SafeState on
    /// divide-by-zero.
    DivInt,
    /// Pop one Int, push its negation.
    NegInt,

    // ========================= Real arithmetic =========
    /// Pop two Reals, push their sum.
    AddReal,
    SubReal,
    MulReal,
    DivReal,
    NegReal,

    // ============================ Type cast ============
    /// Pop one Int, push its Real equivalent (f64). Batch
    /// 153 Faz 3 (plan R-1): emitted by the compiler on
    /// mixed Int/Real binary ops so the VM sees the
    /// promoted Real on both sides of the operator —
    /// matches IEC 61131-3 mixed-arithmetic semantic
    /// without runtime type-polymorphic operators.
    CastIntToReal,

    // =========================== FB invoke =============
    /// Batch 180 Faz 3 (plan R-1): invoke a function
    /// block instance. Semantics:
    /// 1. Pops `input_names.len()` values from the stack
    ///    (pushed by the compiler left-to-right; VM pops
    ///    in REVERSE order so the first pop is the LAST
    ///    argument).
    /// 2. For each (input_name, value) pair, calls
    ///    `FbIo::set_input(fb_id, input_name, value)`.
    /// 3. Calls `FbIo::execute_fb(fb_id)` so the FB
    ///    updates its internal state + outputs.
    /// 4. Does NOT push anything to the stack —
    ///    outputs are read via `FbReadOutput` opcode
    ///    on demand.
    ///
    /// Rejects with `VmError::FbIoNotWired` when the
    /// VM runs without an FbIo backend injected.
    FbCall {
        fb_id: String,
        input_names: Vec<String>,
    },
    /// Batch 180 Faz 3: read one output of a function
    /// block instance. Pushes the named output's
    /// current value onto the stack. Batch 181 compiler
    /// maps `my_timer.Q` (MemberAccess expression) to
    /// this opcode.
    FbReadOutput {
        fb_id: String,
        output_name: String,
    },

    // ============================ Comparison ==========
    /// Pop two values of same type, push Bool (equal).
    Eq,
    /// Pop two Ints, push Bool (b < a).
    LtInt,
    /// Pop two Reals, push Bool (b < a).
    LtReal,

    // ============================== Logic =============
    /// Pop two Bools, push their AND.
    And,
    /// Pop two Bools, push their OR.
    Or,
    /// Pop one Bool, push its negation.
    Not,

    // ============================= Control ============
    /// Unconditional jump to `target` opcode index.
    Jump { target: u32 },
    /// Pop a Bool; if FALSE, jump to `target`. Common
    /// IF-THEN pattern.
    JumpIfFalse { target: u32 },
    /// End program + return to caller.
    Return,

    // ============================ Memory ==============
    /// Push local variable at `index` (within
    /// `Bytecode.locals`).
    LoadLocal { index: u32 },
    /// Pop + store into local variable at `index`.
    StoreLocal { index: u32 },

    // ========================= Tag IO (IO Channel) ====
    /// Push the current value of tag `name` from
    /// ProcessImage. VM reads via IPC to the
    /// ProcessImage shared store.
    LoadTag { name: String },
    /// Pop value, write to tag `name` via
    /// RbacGatedWriter. VM rejects at dispatch time if
    /// `name` is NOT in
    /// `Bytecode.allowed_write_tags` (compile-time
    /// whitelist enforcement per plan R-1).
    WriteTag { name: String },

    // ========================== Stdlib ================
    /// Call a stdlib function. VM pops the expected
    /// argument count from stack + pushes result.
    StdlibCall { fn_id: StdlibFunctionId },

    // =========================== Safety ===============
    /// Per-opcode gas-budget tick. VM decrements gas
    /// counter + trips SafeState if exhausted.
    GasTick,
    /// Immediately trip safe-state. Compiler emits this
    /// for unrecoverable runtime errors (divide-by-zero,
    /// bytecode integrity violation).
    SafeStateTrip,
}

impl Opcode {
    /// Stable 1-byte wire tag per variant. NEVER
    /// renumber existing tags — persisted bytecode
    /// binary depends on this mapping.
    pub const fn wire_tag(&self) -> u8 {
        match self {
            Self::PushConst { .. } => 0,
            Self::Pop => 1,
            Self::Dup => 2,
            Self::AddInt => 3,
            Self::SubInt => 4,
            Self::MulInt => 5,
            Self::DivInt => 6,
            Self::NegInt => 7,
            Self::AddReal => 8,
            Self::SubReal => 9,
            Self::MulReal => 10,
            Self::DivReal => 11,
            Self::NegReal => 12,
            Self::Eq => 13,
            Self::LtInt => 14,
            Self::LtReal => 15,
            Self::And => 16,
            Self::Or => 17,
            Self::Not => 18,
            Self::Jump { .. } => 19,
            Self::JumpIfFalse { .. } => 20,
            Self::Return => 21,
            Self::LoadLocal { .. } => 22,
            Self::StoreLocal { .. } => 23,
            Self::LoadTag { .. } => 24,
            Self::WriteTag { .. } => 25,
            Self::StdlibCall { .. } => 26,
            Self::GasTick => 27,
            Self::SafeStateTrip => 28,
            // Batch 153 — new tag slots appended only
            // (never renumber existing ones).
            Self::CastIntToReal => 29,
            // Batch 180 — FB invoke opcodes.
            Self::FbCall { .. } => 30,
            Self::FbReadOutput { .. } => 31,
        }
    }

    /// Declared gas cost per variant (plan R-1 gas
    /// metering). VM decrements gas counter by this
    /// amount before dispatch; trip SafeState when
    /// counter reaches 0.
    ///
    /// Costs match plan §5 Faz 3 item 2 rough sketch:
    /// arithmetic=1, memory=2, stdlib=5-20, WriteTag=5,
    /// Jump=1.
    pub const fn gas_cost(&self) -> u32 {
        match self {
            // Stack: trivial.
            Self::PushConst { .. } | Self::Pop | Self::Dup => 1,

            // Arithmetic: all 1 gas (integer + real).
            Self::AddInt | Self::SubInt | Self::MulInt | Self::DivInt | Self::NegInt
            | Self::AddReal | Self::SubReal | Self::MulReal | Self::DivReal | Self::NegReal => 1,

            // Comparison + logic: 1 gas.
            Self::Eq | Self::LtInt | Self::LtReal | Self::And | Self::Or | Self::Not => 1,

            // Cast: 1 gas — a single i64→f64 conversion.
            Self::CastIntToReal => 1,

            // FB invoke: 20 gas. Reflects the cost of
            // N set_input calls + one execute_fb call
            // that may do FB-internal work (timer
            // increment, rising-edge detection, PID
            // integration etc). Matches the "stdlib =
            // 10" conservative cost ceiling, bumped to
            // 20 because FBs do strictly more work than
            // a single stdlib function.
            Self::FbCall { .. } => 20,
            // FB read: 3 gas — one get_output call +
            // one stack push. Slightly cheaper than
            // Tag IO (5 gas) because FB outputs are
            // in-process lookup vs ProcessImage
            // cross-component access.
            Self::FbReadOutput { .. } => 3,

            // Control: 1 gas (branch prediction free in
            // interpreted dispatch).
            Self::Jump { .. } | Self::JumpIfFalse { .. } | Self::Return => 1,

            // Memory: 2 gas (load + cache miss penalty).
            Self::LoadLocal { .. } | Self::StoreLocal { .. } => 2,

            // Tag IO: 5 gas (crosses process-image
            // boundary + RbacGatedWriter check for
            // WriteTag).
            Self::LoadTag { .. } | Self::WriteTag { .. } => 5,

            // Stdlib: transcendentals are expensive;
            // pin conservatively at 10. Future batch
            // can per-function-tune via a
            // StdlibFunctionId::gas_cost().
            Self::StdlibCall { .. } => 10,

            // Safety primitives: trivial — they MUST
            // run even when gas is exhausted.
            Self::GasTick | Self::SafeStateTrip => 0,
        }
    }
}

/// Program-level bytecode artifact (Batch 148).
///
/// Signed by the operator at compile time with the
/// firmware_signing_pubkey (plan R-1 refinement — reuse
/// Batch 114 key ceremony). The signature field is
/// declared here but verification integration lands in
/// a future batch alongside the compiler.
///
/// Persisted as JSON under the script storage +
/// potentially as a binary wire-format in a future
/// batch (wire-tag discipline supports this).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Bytecode {
    /// Program identifier (UUID or operator-chosen name).
    pub program_id: String,
    /// Program name for audit + dashboard display.
    pub program_name: String,
    /// Tenant binding (Batch 165 Faz 3) — bound into the
    /// signed canonical encoding so a cross-tenant replay
    /// cannot swap this field without invalidating the
    /// signature. `None` indicates a platform-scoped
    /// program (rare; factory-default alarms).
    #[serde(default)]
    pub tenant_id: Option<String>,
    /// Monotonic policy version (Batch 165 Faz 3) — the
    /// registry rejects deploys whose version is ≤ the
    /// existing entry's. Bound into the signed canonical
    /// encoding so a rollback / replay attacker cannot
    /// re-sign with a lower number.
    #[serde(default)]
    pub policy_version: u64,
    /// Per-tick gas budget. VM starts each scan cycle
    /// with this amount + trips SafeState on exhaustion.
    pub max_gas_per_tick: u32,
    /// Declared local variable count. VM allocates a
    /// slot array of this length at scan-start.
    pub local_count: u32,
    /// RETAIN variables carried across power-cycles.
    /// Each entry = (name, local_index, declared_type):
    /// - `name` keys the persistence row.
    /// - `local_index` tells the VM which locals slot
    ///   to restore / save so the bytecode can
    ///   reference the variable via standard
    ///   LoadLocal / StoreLocal opcodes.
    /// - `declared_type` catches runtime type drift
    ///   (persisted as Real but bytecode later
    ///   declares Bool → reject rather than silently
    ///   coerce).
    ///
    /// Batch 175 Faz 3 extended the tuple shape from
    /// (name, type) to (name, local_index, type). The
    /// canonical encoding bumps to v3 to bind the new
    /// field into the signed hash.
    pub retain_vars: Vec<(String, u32, StValueType)>,
    /// Tags this program is allowed to write via
    /// WriteTag opcode. VM rejects dispatch on any
    /// WriteTag with a name NOT in this list
    /// (compile-time whitelist enforcement).
    pub allowed_write_tags: Vec<String>,
    /// Tags pinned to safe-state values — VM refuses
    /// WriteTag to these names even when the name IS
    /// in `allowed_write_tags` (defense-in-depth against
    /// operator-error allowlist overlap).
    pub safe_state_pinned_tags: Vec<String>,
    /// Linear instruction vector. Offsets in Jump /
    /// JumpIfFalse target indexes into this vec.
    pub opcodes: Vec<Opcode>,
}

impl Bytecode {
    /// Batch 215 Faz 7 — distinct FB instance identifiers
    /// referenced by this program's opcodes.
    ///
    /// An "FB instance" in IEC 61131-3 semantics is a named
    /// block that holds state between invocations. In the
    /// bytecode, every `FbCall { fb_id, .. }` and
    /// `FbReadOutput { fb_id, .. }` opcode carries the
    /// instance identifier; distinct `fb_id` strings across
    /// the opcode vector = distinct instances used by the
    /// program. Returned as a `BTreeSet` so callers get
    /// deterministic ordering + easy set-union across
    /// programs (downstream registry aggregator unions per-
    /// program sets to get the global FB-instance cardinality
    /// used by the Faz 7 license gate).
    pub fn fb_instance_ids(&self) -> std::collections::BTreeSet<String> {
        let mut ids = std::collections::BTreeSet::new();
        for op in &self.opcodes {
            match op {
                Opcode::FbCall { fb_id, .. }
                | Opcode::FbReadOutput { fb_id, .. } => {
                    ids.insert(fb_id.clone());
                }
                _ => {}
            }
        }
        ids
    }
}

/// Declared type for RETAIN variable slots (Batch 148).
/// Matches the `StValue` variants — runtime value must
/// match declared type at RETAIN restore time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StValueType {
    Bool,
    Int,
    Real,
}

impl StValueType {
    pub const fn wire_tag(self) -> u8 {
        match self {
            Self::Bool => 0,
            Self::Int => 1,
            Self::Real => 2,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ====================================================================
    // Wire tag stability tests — persisted bytecode
    // pivots on these; renumbering BREAKS existing
    // deployed agents. Pin every variant explicitly.
    // ====================================================================

    #[test]
    fn st_value_type_tag_stable() {
        assert_eq!(StValue::Bool(true).type_tag(), 0);
        assert_eq!(StValue::Int(0).type_tag(), 1);
        assert_eq!(StValue::Real(0.0).type_tag(), 2);
    }

    #[test]
    fn st_value_type_wire_tag_stable() {
        assert_eq!(StValueType::Bool.wire_tag(), 0);
        assert_eq!(StValueType::Int.wire_tag(), 1);
        assert_eq!(StValueType::Real.wire_tag(), 2);
    }

    #[test]
    fn stdlib_function_id_wire_tag_stable() {
        // Pin each variant — adding a variant MUST
        // append; renumbering breaks deployed bytecode.
        assert_eq!(StdlibFunctionId::AbsInt.wire_tag(), 0);
        assert_eq!(StdlibFunctionId::AbsReal.wire_tag(), 1);
        assert_eq!(StdlibFunctionId::SqrtReal.wire_tag(), 2);
        assert_eq!(StdlibFunctionId::LimitReal.wire_tag(), 3);
        assert_eq!(StdlibFunctionId::MinReal.wire_tag(), 4);
        assert_eq!(StdlibFunctionId::MaxReal.wire_tag(), 5);
        assert_eq!(StdlibFunctionId::SelReal.wire_tag(), 6);
        assert_eq!(StdlibFunctionId::LnReal.wire_tag(), 7);
        assert_eq!(StdlibFunctionId::ExpReal.wire_tag(), 8);
        assert_eq!(StdlibFunctionId::PowReal.wire_tag(), 9);
    }

    #[test]
    fn opcode_wire_tag_stable_entire_set() {
        use StValue::Int;
        assert_eq!(Opcode::PushConst { value: Int(0) }.wire_tag(), 0);
        assert_eq!(Opcode::Pop.wire_tag(), 1);
        assert_eq!(Opcode::Dup.wire_tag(), 2);
        assert_eq!(Opcode::AddInt.wire_tag(), 3);
        assert_eq!(Opcode::SubInt.wire_tag(), 4);
        assert_eq!(Opcode::MulInt.wire_tag(), 5);
        assert_eq!(Opcode::DivInt.wire_tag(), 6);
        assert_eq!(Opcode::NegInt.wire_tag(), 7);
        assert_eq!(Opcode::AddReal.wire_tag(), 8);
        assert_eq!(Opcode::SubReal.wire_tag(), 9);
        assert_eq!(Opcode::MulReal.wire_tag(), 10);
        assert_eq!(Opcode::DivReal.wire_tag(), 11);
        assert_eq!(Opcode::NegReal.wire_tag(), 12);
        assert_eq!(Opcode::Eq.wire_tag(), 13);
        assert_eq!(Opcode::LtInt.wire_tag(), 14);
        assert_eq!(Opcode::LtReal.wire_tag(), 15);
        assert_eq!(Opcode::And.wire_tag(), 16);
        assert_eq!(Opcode::Or.wire_tag(), 17);
        assert_eq!(Opcode::Not.wire_tag(), 18);
        assert_eq!(Opcode::Jump { target: 0 }.wire_tag(), 19);
        assert_eq!(Opcode::JumpIfFalse { target: 0 }.wire_tag(), 20);
        assert_eq!(Opcode::Return.wire_tag(), 21);
        assert_eq!(Opcode::LoadLocal { index: 0 }.wire_tag(), 22);
        assert_eq!(Opcode::StoreLocal { index: 0 }.wire_tag(), 23);
        assert_eq!(
            Opcode::LoadTag {
                name: "t".into()
            }
            .wire_tag(),
            24
        );
        assert_eq!(
            Opcode::WriteTag {
                name: "t".into()
            }
            .wire_tag(),
            25
        );
        assert_eq!(
            Opcode::StdlibCall {
                fn_id: StdlibFunctionId::AbsInt
            }
            .wire_tag(),
            26
        );
        assert_eq!(Opcode::GasTick.wire_tag(), 27);
        assert_eq!(Opcode::SafeStateTrip.wire_tag(), 28);
        // Batch 153: CastIntToReal appended as tag 29.
        // Stable-tag invariant: new opcodes may only
        // extend this enum at the tail.
        assert_eq!(Opcode::CastIntToReal.wire_tag(), 29);
        // Batch 180: FB invoke appended as tags 30-31.
        assert_eq!(
            Opcode::FbCall {
                fb_id: "t".into(),
                input_names: vec![]
            }
            .wire_tag(),
            30
        );
        assert_eq!(
            Opcode::FbReadOutput {
                fb_id: "t".into(),
                output_name: "Q".into()
            }
            .wire_tag(),
            31
        );
    }

    #[test]
    fn opcode_gas_cost_safety_primitives_are_free() {
        // GasTick + SafeStateTrip MUST run even when
        // gas is exhausted — they're the primitives
        // that ENFORCE gas exhaustion. Zero cost.
        assert_eq!(Opcode::GasTick.gas_cost(), 0);
        assert_eq!(Opcode::SafeStateTrip.gas_cost(), 0);
    }

    #[test]
    fn opcode_gas_cost_tag_io_reflects_crossing_boundary() {
        assert_eq!(Opcode::LoadTag { name: "x".into() }.gas_cost(), 5);
        assert_eq!(Opcode::WriteTag { name: "x".into() }.gas_cost(), 5);
    }

    #[test]
    fn opcode_gas_cost_stdlib_calls_are_expensive() {
        assert_eq!(
            Opcode::StdlibCall {
                fn_id: StdlibFunctionId::SqrtReal
            }
            .gas_cost(),
            10
        );
    }

    // ====================================================================
    // Serde round-trip tests — on-disk bytecode
    // persistence + script_storage JSON shape.
    // ====================================================================

    #[test]
    fn st_value_json_roundtrip() {
        for v in [
            StValue::Bool(true),
            StValue::Bool(false),
            StValue::Int(42),
            StValue::Int(-17),
            StValue::Int(0),
            StValue::Real(3.14),
            StValue::Real(-0.0),
        ] {
            let j = serde_json::to_string(&v).unwrap();
            let parsed: StValue = serde_json::from_str(&j).unwrap();
            assert_eq!(v, parsed, "round-trip failed for {:?}", v);
        }
    }

    #[test]
    fn opcode_json_roundtrip_with_payload() {
        let ops = vec![
            Opcode::PushConst {
                value: StValue::Int(10),
            },
            Opcode::PushConst {
                value: StValue::Real(2.5),
            },
            Opcode::AddReal,
            Opcode::WriteTag {
                name: "sensor1".into(),
            },
            Opcode::StdlibCall {
                fn_id: StdlibFunctionId::SqrtReal,
            },
            Opcode::Jump { target: 0 },
            Opcode::Return,
        ];
        let j = serde_json::to_string(&ops).unwrap();
        let parsed: Vec<Opcode> = serde_json::from_str(&j).unwrap();
        assert_eq!(ops, parsed);
    }

    #[test]
    fn bytecode_full_roundtrip() {
        let bc = Bytecode {
            program_id: "prog-alpha".into(),
            program_name: "fish_feeder".into(),
            tenant_id: Some("tenant-a".into()),
            policy_version: 1,
            max_gas_per_tick: 10_000,
            local_count: 5,
            retain_vars: vec![
                ("counter".into(), 0u32, StValueType::Int),
                ("active".into(), 1u32, StValueType::Bool),
            ],
            allowed_write_tags: vec!["feeder_motor".into(), "status_led".into()],
            safe_state_pinned_tags: vec!["emergency_stop".into()],
            opcodes: vec![
                Opcode::PushConst {
                    value: StValue::Bool(true),
                },
                Opcode::JumpIfFalse { target: 5 },
                Opcode::LoadTag {
                    name: "sensor_a".into(),
                },
                Opcode::PushConst {
                    value: StValue::Real(10.0),
                },
                Opcode::LtReal,
                Opcode::Return,
            ],
        };
        let j = serde_json::to_string(&bc).unwrap();
        let parsed: Bytecode = serde_json::from_str(&j).unwrap();
        assert_eq!(bc, parsed);
    }

    #[test]
    fn bytecode_empty_opcodes_is_valid() {
        // Compiler may produce zero-opcode bytecode
        // during incremental compilation; serde should
        // round-trip without error.
        let bc = Bytecode {
            program_id: "empty".into(),
            program_name: "empty".into(),
            tenant_id: None,
            policy_version: 0,
            max_gas_per_tick: 100,
            local_count: 0,
            retain_vars: vec![],
            allowed_write_tags: vec![],
            safe_state_pinned_tags: vec![],
            opcodes: vec![],
        };
        let j = serde_json::to_string(&bc).unwrap();
        let parsed: Bytecode = serde_json::from_str(&j).unwrap();
        assert_eq!(bc, parsed);
    }

    #[test]
    fn st_value_discriminants_use_kind_tag() {
        let j = serde_json::to_string(&StValue::Int(42)).unwrap();
        // Using tag="kind", content="value" makes the
        // JSON shape { "kind": "int", "value": 42 } —
        // wire-compatible with operator tooling.
        assert!(j.contains("\"kind\":\"int\""));
        assert!(j.contains("\"value\":42"));
    }

    // ============================================================
    // Batch 215 Faz 7 — fb_instance_ids tests
    // ============================================================

    fn mk_bc_with_ops(opcodes: Vec<Opcode>) -> Bytecode {
        Bytecode {
            program_id: "p".into(),
            program_name: "p".into(),
            tenant_id: None,
            policy_version: 0,
            max_gas_per_tick: 1000,
            local_count: 0,
            retain_vars: vec![],
            allowed_write_tags: vec![],
            safe_state_pinned_tags: vec![],
            opcodes,
        }
    }

    #[test]
    fn fb_instance_ids_empty_when_no_fb_ops() {
        let bc = mk_bc_with_ops(vec![
            Opcode::PushConst {
                value: StValue::Int(1),
            },
            Opcode::PushConst {
                value: StValue::Int(2),
            },
            Opcode::AddInt,
            Opcode::Return,
        ]);
        assert!(bc.fb_instance_ids().is_empty());
    }

    #[test]
    fn fb_instance_ids_collects_fb_call_ids() {
        let bc = mk_bc_with_ops(vec![
            Opcode::FbCall {
                fb_id: "timer1".into(),
                input_names: vec![],
            },
            Opcode::FbCall {
                fb_id: "pid1".into(),
                input_names: vec![],
            },
            Opcode::Return,
        ]);
        let ids = bc.fb_instance_ids();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains("timer1"));
        assert!(ids.contains("pid1"));
    }

    #[test]
    fn fb_instance_ids_collects_fb_read_output_ids() {
        let bc = mk_bc_with_ops(vec![
            Opcode::FbReadOutput {
                fb_id: "timer1".into(),
                output_name: "Q".into(),
            },
            Opcode::Return,
        ]);
        assert_eq!(bc.fb_instance_ids().len(), 1);
        assert!(bc.fb_instance_ids().contains("timer1"));
    }

    #[test]
    fn fb_instance_ids_dedup_repeat_references() {
        // Same FB instance referenced multiple times = 1
        // instance. Instances, not invocations.
        let bc = mk_bc_with_ops(vec![
            Opcode::FbCall {
                fb_id: "timer1".into(),
                input_names: vec![],
            },
            Opcode::FbReadOutput {
                fb_id: "timer1".into(),
                output_name: "Q".into(),
            },
            Opcode::FbCall {
                fb_id: "timer1".into(),
                input_names: vec![],
            },
            Opcode::Return,
        ]);
        assert_eq!(bc.fb_instance_ids().len(), 1);
    }

    #[test]
    fn fb_instance_ids_returns_deterministic_order() {
        // BTreeSet ordering — proven so callers using the
        // union across programs get stable results.
        let bc = mk_bc_with_ops(vec![
            Opcode::FbCall {
                fb_id: "zeta".into(),
                input_names: vec![],
            },
            Opcode::FbCall {
                fb_id: "alpha".into(),
                input_names: vec![],
            },
            Opcode::FbCall {
                fb_id: "mike".into(),
                input_names: vec![],
            },
            Opcode::Return,
        ]);
        let collected: Vec<_> = bc.fb_instance_ids().into_iter().collect();
        assert_eq!(collected, vec!["alpha", "mike", "zeta"]);
    }
}
