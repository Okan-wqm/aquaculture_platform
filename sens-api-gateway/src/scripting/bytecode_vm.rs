//! ST stack VM (Batch 151 Faz 3 / plan R-1).
//!
//! Module-level `#![allow(dead_code)]` is held because
//! Batch 151 lands the VM primitives + tests in isolation
//! — no production call-site wires `ScriptVm::run` yet.
//! Batch 152+ consumes the VM from
//! `scripting::engine::ScriptEngine` (scan-cycle dispatch)
//! + `commands::cmd_deploy_program` (compile + verify
//! roundtrip). Lifted the same way Batches 148 / 149 held
//! allow-dead until the next consumer landed.
//!
//! ## WHY
//!
//! Plan §3 R-1 + plan §5 Faz 3 specify a stack-based
//! bytecode interpreter with:
//! - Deterministic dispatch (fixed opcode count per
//!   tick via gas metering).
//! - Safe-state trip on runtime errors
//!   (divide-by-zero, gas exhaustion, type error).
//! - RbacGatedWriter integration for WriteTag opcode
//!   (future batch).
//! - ProcessImage integration for LoadTag/WriteTag
//!   (future batch).
//!
//! Batch 151 lands the CORE VM — arithmetic + logic +
//! control + safety primitives + stdlib dispatch +
//! local variable slots. Tag IO opcodes (LoadTag /
//! WriteTag) return a deterministic error
//! (`VmError::TagIoNotWired`) until the future batch
//! plumbs ProcessImage + RbacGatedWriter.
//!
//! ## Architectural shape
//!
//! - `ScriptVm` owns stack + locals + gas counter.
//! - `run(bc)` executes the bytecode's opcode vec
//!   starting at index 0 + returns on `Return` opcode
//!   OR error.
//! - `dispatch_one(&mut self, &Opcode)` handles a
//!   single opcode — separated for per-opcode
//!   unit-test access.
//! - Gas accounting: every opcode's `gas_cost()` is
//!   deducted BEFORE dispatch; trips SafeState on
//!   exhaustion. `GasTick` / `SafeStateTrip` bypass
//!   the deduction (their cost = 0) + respectively
//!   check gas AND explicit trip.
//!
//! ## Not in scope for Batch 151
//!
//! - LoadTag / WriteTag ProcessImage integration
//!   (Batch 152 — requires RbacGatedWriter trait
//!   design).
//! - StdlibCall actual invocation — Batch 151 stubs
//!   the dispatch to return `VmError::StdlibNotWired`.
//!   Batch 153 wires the 10 Batch-148 stdlib functions.
//! - FB invoke — Batch 154.
//! - String / Time value variants — Batch 153.

#![allow(dead_code)]

use super::bytecode::{Bytecode, Opcode, StValue, StValueType};

/// VM runtime failure taxonomy.
#[derive(Debug, Clone, PartialEq)]
pub enum VmError {
    /// Gas budget exhausted before dispatch.
    GasExhausted { remaining: u32, needed: u32 },
    /// Stack pop with empty stack.
    StackUnderflow { opcode: String },
    /// Stack-top type doesn't match the opcode's
    /// expected operand type (e.g. AddInt on Real).
    TypeMismatch {
        opcode: String,
        expected: StValueType,
        got: StValueType,
    },
    /// Integer or real divide-by-zero.
    DivideByZero { opcode: String },
    /// Jump target opcode index out of range.
    BadJumpTarget { target: u32, opcode_count: usize },
    /// LoadLocal/StoreLocal index ≥ local_count.
    BadLocalIndex { index: u32, local_count: u32 },
    /// SafeStateTrip opcode executed.
    SafeStateTripped,
    /// LoadTag / WriteTag not wired (Batch 151
    /// limitation). Consumer integration lands in a
    /// future batch.
    TagIoNotWired { tag: String, direction: &'static str },
    /// StdlibCall not wired. Consumer integration in
    /// Batch 153.
    StdlibNotWired { fn_id_wire_tag: u8 },
}

impl std::fmt::Display for VmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::GasExhausted { remaining, needed } => {
                write!(f, "vm: gas exhausted (remaining={}, needed={})", remaining, needed)
            }
            Self::StackUnderflow { opcode } => {
                write!(f, "vm: stack underflow on {}", opcode)
            }
            Self::TypeMismatch {
                opcode,
                expected,
                got,
            } => write!(
                f,
                "vm: type mismatch on {}: expected {:?}, got {:?}",
                opcode, expected, got
            ),
            Self::DivideByZero { opcode } => {
                write!(f, "vm: divide-by-zero on {}", opcode)
            }
            Self::BadJumpTarget { target, opcode_count } => {
                write!(
                    f,
                    "vm: bad jump target {} (program has {} opcodes)",
                    target, opcode_count
                )
            }
            Self::BadLocalIndex { index, local_count } => {
                write!(
                    f,
                    "vm: bad local index {} (program declared {} locals)",
                    index, local_count
                )
            }
            Self::SafeStateTripped => f.write_str("vm: safe-state tripped"),
            Self::TagIoNotWired { tag, direction } => {
                write!(f, "vm: tag IO not wired ({} on {})", direction, tag)
            }
            Self::StdlibNotWired { fn_id_wire_tag } => {
                write!(f, "vm: stdlib fn not wired (wire_tag={})", fn_id_wire_tag)
            }
        }
    }
}

impl std::error::Error for VmError {}

/// VM execution outcome.
#[derive(Debug, Clone, PartialEq)]
pub enum VmOutcome {
    /// Program hit a `Return` opcode — normal exit.
    Returned,
    /// Runtime error — VM halted + caller should trip
    /// SafeState at the consumer level (script engine)
    /// + disable the program.
    Error(VmError),
}

/// Stack-based VM runtime state.
#[derive(Debug)]
pub struct ScriptVm {
    /// Evaluation stack. Grows as expressions push +
    /// shrinks as opcodes consume.
    stack: Vec<StValue>,
    /// Local variable slots. Indexed by `Bytecode.local_count`;
    /// bounds-checked on LoadLocal / StoreLocal.
    locals: Vec<StValue>,
    /// Per-tick gas budget, decremented at each
    /// opcode's `gas_cost()` before dispatch.
    gas_remaining: u32,
    /// Instruction pointer (index into `Bytecode.opcodes`).
    ip: usize,
}

impl ScriptVm {
    /// Construct a fresh VM for a bytecode program.
    /// Locals initialize to `StValue::Bool(false)` —
    /// the compiler + ST type-checker ensures locals
    /// are WRITTEN before read, but the zero-
    /// initialization provides a sane default.
    pub fn new(bc: &Bytecode) -> Self {
        Self {
            stack: Vec::with_capacity(32),
            locals: vec![StValue::Bool(false); bc.local_count as usize],
            gas_remaining: bc.max_gas_per_tick,
            ip: 0,
        }
    }

    /// Test helper — access the stack for invariant
    /// assertions.
    #[allow(dead_code)]
    pub(crate) fn stack(&self) -> &[StValue] {
        &self.stack
    }

    #[allow(dead_code)]
    pub(crate) fn locals(&self) -> &[StValue] {
        &self.locals
    }

    #[allow(dead_code)]
    pub(crate) fn gas_remaining(&self) -> u32 {
        self.gas_remaining
    }

    /// Execute the full bytecode program. Returns
    /// `Returned` on `Opcode::Return` OR first
    /// `VmError` on runtime failure.
    pub fn run(&mut self, bc: &Bytecode) -> VmOutcome {
        self.ip = 0;
        loop {
            // Safety: ip bounds check on every
            // iteration. A runaway bytecode that walks
            // past the end without Return gets halted
            // here instead of OOB reading.
            let Some(opcode) = bc.opcodes.get(self.ip) else {
                return VmOutcome::Error(VmError::BadJumpTarget {
                    target: self.ip as u32,
                    opcode_count: bc.opcodes.len(),
                });
            };

            // Gas accounting BEFORE dispatch. GasTick +
            // SafeStateTrip have zero cost (they ENFORCE
            // exhaustion + error paths).
            let cost = opcode.gas_cost();
            if cost > self.gas_remaining {
                return VmOutcome::Error(VmError::GasExhausted {
                    remaining: self.gas_remaining,
                    needed: cost,
                });
            }
            self.gas_remaining -= cost;

            match self.dispatch_one(opcode, bc) {
                Ok(DispatchStep::Advance) => {
                    self.ip += 1;
                }
                Ok(DispatchStep::Jumped) => {
                    // IP already updated by the jump
                    // handler.
                }
                Ok(DispatchStep::Returned) => {
                    return VmOutcome::Returned;
                }
                Err(e) => {
                    return VmOutcome::Error(e);
                }
            }
        }
    }

    /// Dispatch a single opcode. Kept separate from
    /// `run` so per-opcode unit tests can exercise
    /// dispatch logic without driving the full loop.
    fn dispatch_one(
        &mut self,
        opcode: &Opcode,
        bc: &Bytecode,
    ) -> Result<DispatchStep, VmError> {
        match opcode {
            // Stack ops
            Opcode::PushConst { value } => {
                self.stack.push(*value);
                Ok(DispatchStep::Advance)
            }
            Opcode::Pop => {
                self.pop("Pop")?;
                Ok(DispatchStep::Advance)
            }
            Opcode::Dup => {
                let top = *self.peek("Dup")?;
                self.stack.push(top);
                Ok(DispatchStep::Advance)
            }

            // Integer arithmetic
            Opcode::AddInt => self.binop_int("AddInt", |a, b| Some(a.wrapping_add(b))),
            Opcode::SubInt => self.binop_int("SubInt", |a, b| Some(a.wrapping_sub(b))),
            Opcode::MulInt => self.binop_int("MulInt", |a, b| Some(a.wrapping_mul(b))),
            Opcode::DivInt => self.binop_int("DivInt", |a, b| {
                if b == 0 {
                    None
                } else {
                    Some(a.wrapping_div(b))
                }
            }),
            Opcode::NegInt => {
                let v = self.pop_int("NegInt")?;
                self.stack.push(StValue::Int(v.wrapping_neg()));
                Ok(DispatchStep::Advance)
            }

            // Real arithmetic
            Opcode::AddReal => self.binop_real("AddReal", |a, b| a + b),
            Opcode::SubReal => self.binop_real("SubReal", |a, b| a - b),
            Opcode::MulReal => self.binop_real("MulReal", |a, b| a * b),
            Opcode::DivReal => {
                let b = self.pop_real("DivReal")?;
                let a = self.pop_real("DivReal")?;
                if b == 0.0 {
                    return Err(VmError::DivideByZero {
                        opcode: "DivReal".to_string(),
                    });
                }
                self.stack.push(StValue::Real(a / b));
                Ok(DispatchStep::Advance)
            }
            Opcode::NegReal => {
                let v = self.pop_real("NegReal")?;
                self.stack.push(StValue::Real(-v));
                Ok(DispatchStep::Advance)
            }

            // Comparison
            Opcode::Eq => {
                let b = self.pop("Eq")?;
                let a = self.pop("Eq")?;
                let eq = match (a, b) {
                    (StValue::Bool(x), StValue::Bool(y)) => x == y,
                    (StValue::Int(x), StValue::Int(y)) => x == y,
                    (StValue::Real(x), StValue::Real(y)) => x == y,
                    (x, y) => {
                        return Err(VmError::TypeMismatch {
                            opcode: "Eq".to_string(),
                            expected: x_type(&x),
                            got: x_type(&y),
                        });
                    }
                };
                self.stack.push(StValue::Bool(eq));
                Ok(DispatchStep::Advance)
            }
            Opcode::LtInt => {
                let b = self.pop_int("LtInt")?;
                let a = self.pop_int("LtInt")?;
                self.stack.push(StValue::Bool(a < b));
                Ok(DispatchStep::Advance)
            }
            Opcode::LtReal => {
                let b = self.pop_real("LtReal")?;
                let a = self.pop_real("LtReal")?;
                self.stack.push(StValue::Bool(a < b));
                Ok(DispatchStep::Advance)
            }

            // Logic
            Opcode::And => {
                let b = self.pop_bool("And")?;
                let a = self.pop_bool("And")?;
                self.stack.push(StValue::Bool(a && b));
                Ok(DispatchStep::Advance)
            }
            Opcode::Or => {
                let b = self.pop_bool("Or")?;
                let a = self.pop_bool("Or")?;
                self.stack.push(StValue::Bool(a || b));
                Ok(DispatchStep::Advance)
            }
            Opcode::Not => {
                let v = self.pop_bool("Not")?;
                self.stack.push(StValue::Bool(!v));
                Ok(DispatchStep::Advance)
            }

            // Control
            Opcode::Jump { target } => {
                self.jump_to(*target, bc)?;
                Ok(DispatchStep::Jumped)
            }
            Opcode::JumpIfFalse { target } => {
                let cond = self.pop_bool("JumpIfFalse")?;
                if cond {
                    Ok(DispatchStep::Advance)
                } else {
                    self.jump_to(*target, bc)?;
                    Ok(DispatchStep::Jumped)
                }
            }
            Opcode::Return => Ok(DispatchStep::Returned),

            // Memory
            Opcode::LoadLocal { index } => {
                let idx = *index;
                let v = self
                    .locals
                    .get(idx as usize)
                    .copied()
                    .ok_or_else(|| VmError::BadLocalIndex {
                        index: idx,
                        local_count: self.locals.len() as u32,
                    })?;
                self.stack.push(v);
                Ok(DispatchStep::Advance)
            }
            Opcode::StoreLocal { index } => {
                let idx = *index as usize;
                if idx >= self.locals.len() {
                    return Err(VmError::BadLocalIndex {
                        index: *index,
                        local_count: self.locals.len() as u32,
                    });
                }
                let v = self.pop("StoreLocal")?;
                self.locals[idx] = v;
                Ok(DispatchStep::Advance)
            }

            // Tag IO — Batch 151 stub. Future batch
            // plumbs ProcessImage + RbacGatedWriter.
            Opcode::LoadTag { name } => Err(VmError::TagIoNotWired {
                tag: name.clone(),
                direction: "load",
            }),
            Opcode::WriteTag { name } => Err(VmError::TagIoNotWired {
                tag: name.clone(),
                direction: "write",
            }),

            // Stdlib — Batch 151 stub. Batch 153 wires
            // the 10 numeric functions (ABS / SQRT /
            // LIMIT / MIN / MAX / SEL / LN / EXP / POW
            // + Real variants).
            Opcode::StdlibCall { fn_id } => Err(VmError::StdlibNotWired {
                fn_id_wire_tag: fn_id.wire_tag(),
            }),

            // Safety
            Opcode::GasTick => {
                // Explicit tick — zero-cost opcode that
                // checks gas exhaustion. Compilers can
                // emit this at loop backedges or scan-
                // cycle boundaries for tighter bounds
                // than the per-opcode accounting.
                if self.gas_remaining == 0 {
                    return Err(VmError::GasExhausted {
                        remaining: 0,
                        needed: 0,
                    });
                }
                Ok(DispatchStep::Advance)
            }
            Opcode::SafeStateTrip => Err(VmError::SafeStateTripped),
        }
    }

    fn pop(&mut self, op_label: &str) -> Result<StValue, VmError> {
        self.stack.pop().ok_or_else(|| VmError::StackUnderflow {
            opcode: op_label.to_string(),
        })
    }

    fn peek(&self, op_label: &str) -> Result<&StValue, VmError> {
        self.stack.last().ok_or_else(|| VmError::StackUnderflow {
            opcode: op_label.to_string(),
        })
    }

    fn pop_int(&mut self, op_label: &str) -> Result<i64, VmError> {
        match self.pop(op_label)? {
            StValue::Int(n) => Ok(n),
            other => Err(VmError::TypeMismatch {
                opcode: op_label.to_string(),
                expected: StValueType::Int,
                got: x_type(&other),
            }),
        }
    }

    fn pop_real(&mut self, op_label: &str) -> Result<f64, VmError> {
        match self.pop(op_label)? {
            StValue::Real(n) => Ok(n),
            other => Err(VmError::TypeMismatch {
                opcode: op_label.to_string(),
                expected: StValueType::Real,
                got: x_type(&other),
            }),
        }
    }

    fn pop_bool(&mut self, op_label: &str) -> Result<bool, VmError> {
        match self.pop(op_label)? {
            StValue::Bool(b) => Ok(b),
            other => Err(VmError::TypeMismatch {
                opcode: op_label.to_string(),
                expected: StValueType::Bool,
                got: x_type(&other),
            }),
        }
    }

    fn binop_int(
        &mut self,
        op_label: &str,
        f: impl FnOnce(i64, i64) -> Option<i64>,
    ) -> Result<DispatchStep, VmError> {
        let b = self.pop_int(op_label)?;
        let a = self.pop_int(op_label)?;
        let result = f(a, b).ok_or_else(|| VmError::DivideByZero {
            opcode: op_label.to_string(),
        })?;
        self.stack.push(StValue::Int(result));
        Ok(DispatchStep::Advance)
    }

    fn binop_real(
        &mut self,
        op_label: &str,
        f: impl FnOnce(f64, f64) -> f64,
    ) -> Result<DispatchStep, VmError> {
        let b = self.pop_real(op_label)?;
        let a = self.pop_real(op_label)?;
        self.stack.push(StValue::Real(f(a, b)));
        Ok(DispatchStep::Advance)
    }

    fn jump_to(&mut self, target: u32, bc: &Bytecode) -> Result<(), VmError> {
        let idx = target as usize;
        if idx >= bc.opcodes.len() {
            return Err(VmError::BadJumpTarget {
                target,
                opcode_count: bc.opcodes.len(),
            });
        }
        self.ip = idx;
        Ok(())
    }
}

/// Per-opcode dispatch result. Separates "advance IP"
/// from "jump-taken (IP already updated)" from "program
/// returned".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DispatchStep {
    Advance,
    Jumped,
    Returned,
}

fn x_type(v: &StValue) -> StValueType {
    match v {
        StValue::Bool(_) => StValueType::Bool,
        StValue::Int(_) => StValueType::Int,
        StValue::Real(_) => StValueType::Real,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bc(opcodes: Vec<Opcode>, locals: u32) -> Bytecode {
        Bytecode {
            program_id: "t".into(),
            program_name: "t".into(),
            max_gas_per_tick: 1_000_000,
            local_count: locals,
            retain_vars: vec![],
            allowed_write_tags: vec![],
            safe_state_pinned_tags: vec![],
            opcodes,
        }
    }

    // ====================================================================
    // Arithmetic
    // ====================================================================

    #[test]
    fn run_int_add_leaves_sum_on_stack() {
        let b = bc(
            vec![
                Opcode::PushConst { value: StValue::Int(2) },
                Opcode::PushConst { value: StValue::Int(3) },
                Opcode::AddInt,
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Int(5)]);
    }

    #[test]
    fn run_real_mul() {
        let b = bc(
            vec![
                Opcode::PushConst { value: StValue::Real(2.0) },
                Opcode::PushConst { value: StValue::Real(3.5) },
                Opcode::MulReal,
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(7.0)]);
    }

    #[test]
    fn run_int_divide_by_zero_trips_error() {
        let b = bc(
            vec![
                Opcode::PushConst { value: StValue::Int(10) },
                Opcode::PushConst { value: StValue::Int(0) },
                Opcode::DivInt,
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        match vm.run(&b) {
            VmOutcome::Error(VmError::DivideByZero { opcode }) => {
                assert_eq!(opcode, "DivInt");
            }
            other => panic!("expected DivideByZero, got {:?}", other),
        }
    }

    #[test]
    fn run_real_divide_by_zero_trips_error() {
        let b = bc(
            vec![
                Opcode::PushConst { value: StValue::Real(1.0) },
                Opcode::PushConst { value: StValue::Real(0.0) },
                Opcode::DivReal,
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::DivideByZero { .. })
        ));
    }

    // ====================================================================
    // Locals
    // ====================================================================

    #[test]
    fn run_store_and_load_local() {
        // 42 → local[0]; LoadLocal[0] → stack
        let b = bc(
            vec![
                Opcode::PushConst { value: StValue::Int(42) },
                Opcode::StoreLocal { index: 0 },
                Opcode::LoadLocal { index: 0 },
                Opcode::Return,
            ],
            1,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Int(42)]);
    }

    #[test]
    fn run_bad_local_index_trips_error() {
        let b = bc(
            vec![
                Opcode::LoadLocal { index: 99 },
                Opcode::Return,
            ],
            1,
        );
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::BadLocalIndex { index: 99, local_count: 1 })
        ));
    }

    // ====================================================================
    // Control flow
    // ====================================================================

    #[test]
    fn run_jump_if_false_with_true_advances() {
        // true; JumpIfFalse→3; PushConst(99); Return
        let b = bc(
            vec![
                Opcode::PushConst { value: StValue::Bool(true) },
                Opcode::JumpIfFalse { target: 3 },
                Opcode::PushConst { value: StValue::Int(99) },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Int(99)]);
    }

    #[test]
    fn run_jump_if_false_with_false_skips() {
        // false; JumpIfFalse→3; PushConst(99); Return
        // With false, should SKIP the PushConst.
        let b = bc(
            vec![
                Opcode::PushConst { value: StValue::Bool(false) },
                Opcode::JumpIfFalse { target: 3 },
                Opcode::PushConst { value: StValue::Int(99) },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert!(vm.stack().is_empty());
    }

    #[test]
    fn run_jump_past_end_is_bad_target() {
        let b = bc(
            vec![Opcode::Jump { target: 99 }, Opcode::Return],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::BadJumpTarget { target: 99, .. })
        ));
    }

    // ====================================================================
    // Gas metering
    // ====================================================================

    #[test]
    fn run_gas_exhaustion_trips_error() {
        let mut b = bc(
            vec![
                Opcode::PushConst { value: StValue::Int(1) },
                Opcode::PushConst { value: StValue::Int(2) },
                Opcode::AddInt,
                Opcode::Return,
            ],
            0,
        );
        b.max_gas_per_tick = 2; // 3 opcodes at 1 gas each → exhaust
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::GasExhausted { .. })
        ));
    }

    #[test]
    fn run_safe_state_trip_halts_with_error() {
        let b = bc(vec![Opcode::SafeStateTrip], 0);
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::SafeStateTripped)
        ));
    }

    // ====================================================================
    // Stack hygiene
    // ====================================================================

    #[test]
    fn run_pop_from_empty_is_underflow() {
        let b = bc(vec![Opcode::Pop, Opcode::Return], 0);
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::StackUnderflow { .. })
        ));
    }

    #[test]
    fn run_type_mismatch_on_add_int() {
        // Push Real then Int then AddInt → pops Int ok,
        // then tries to pop another Int but finds Real.
        let b = bc(
            vec![
                Opcode::PushConst { value: StValue::Real(1.0) },
                Opcode::PushConst { value: StValue::Int(2) },
                Opcode::AddInt,
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::TypeMismatch { .. })
        ));
    }

    // ====================================================================
    // Stub / future-wire opcodes
    // ====================================================================

    #[test]
    fn run_load_tag_stub_returns_not_wired() {
        let b = bc(
            vec![
                Opcode::LoadTag { name: "t1".into() },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::TagIoNotWired { .. })
        ));
    }

    #[test]
    fn run_stdlib_call_stub_returns_not_wired() {
        use super::super::bytecode::StdlibFunctionId;
        let b = bc(
            vec![
                Opcode::StdlibCall { fn_id: StdlibFunctionId::AbsInt },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::StdlibNotWired { .. })
        ));
    }

    // ====================================================================
    // Integration with compiler (end-to-end)
    // ====================================================================

    #[test]
    fn run_compiled_program_assignment_roundtrip() {
        use super::super::bytecode_compiler::compile_program;
        use crate::st_validator::{
            DataType, Expression, Program, Statement, VarBlock, VarDeclaration, VarScope,
        };

        // x: INT; x := 5 + 3;
        let prog = Program {
            name: "p".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: false,
                constant: false,
                declarations: vec![VarDeclaration {
                    name: "x".into(),
                    data_type: DataType::Int,
                    initial_value: None,
                    span: None,
                }],
                span: None,
            }],
            body: vec![Statement::Assignment {
                target: Expression::Variable("x".into(), None),
                value: Expression::BinaryOp {
                    left: Box::new(Expression::IntLiteral(5)),
                    op: crate::st_validator::BinaryOp::Add,
                    right: Box::new(Expression::IntLiteral(3)),
                },
                span: None,
            }],
            span: None,
        };
        let bc_compiled =
            compile_program(&prog, "p".into(), 1_000).expect("compile");
        let mut vm = ScriptVm::new(&bc_compiled);
        assert_eq!(vm.run(&bc_compiled), VmOutcome::Returned);
        // local[0] = x = 8
        assert_eq!(vm.locals()[0], StValue::Int(8));
    }
}
