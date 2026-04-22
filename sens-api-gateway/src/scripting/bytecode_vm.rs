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
    /// LoadTag / WriteTag not wired to ProcessImage.
    /// Consumer integration (ProcessImage +
    /// RbacGatedWriter trait) lands in a future batch.
    TagIoNotWired { tag: String, direction: &'static str },
    /// StdlibCall not wired (historic — every Batch 148
    /// StdlibFunctionId now has dispatch per Batch 154).
    /// Variant retained so future StdlibFunctionId
    /// additions can return this error before their VM
    /// dispatch lands.
    StdlibNotWired { fn_id_wire_tag: u8 },
    /// Batch 156: `WriteTag` opcode targeted a tag NOT
    /// in `Bytecode.allowed_write_tags`. Compile-time
    /// whitelist enforcement per plan R-1 — the VM
    /// rejects dispatch rather than silently permitting
    /// the write.
    TagNotAllowed { tag: String },
    /// Batch 156: `WriteTag` opcode targeted a tag listed
    /// in `Bytecode.safe_state_pinned_tags`. Pinned tags
    /// hold operator-configured safe-state values and
    /// MUST NOT be overwritten by script logic — defense-
    /// in-depth even when the tag is also in the
    /// allowlist.
    SafeStatePinned { tag: String },
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
            Self::TagNotAllowed { tag } => {
                write!(f, "vm: write to tag `{}` blocked — not in allowed_write_tags", tag)
            }
            Self::SafeStatePinned { tag } => {
                write!(f, "vm: write to safe-state-pinned tag `{}` blocked", tag)
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

            // Type cast — Batch 153
            Opcode::CastIntToReal => {
                let v = self.pop_int("CastIntToReal")?;
                // i64 → f64 — lossy for magnitudes beyond
                // 2^53, but matches IEC 61131-3 implicit
                // promotion semantic where loss of low-bit
                // precision is accepted for mixed arithmetic.
                self.stack.push(StValue::Real(v as f64));
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

            // Tag IO — Batch 156 layers the tier-1
            // security gates (safe-state-pinned +
            // allowlist) in FRONT of the ProcessImage
            // stub. A future batch replaces the
            // TagIoNotWired leaf with the actual read /
            // RbacGatedWriter.write call.
            Opcode::LoadTag { name } => Err(VmError::TagIoNotWired {
                tag: name.clone(),
                direction: "load",
            }),
            Opcode::WriteTag { name } => {
                // Defense-in-depth ordering: safe-state-
                // pinned is checked BEFORE the allowlist
                // so an operator-error that simultaneously
                // allows + pins a tag still rejects at
                // the pinned layer (matches plan R-1
                // wording: "refuses WriteTag even when
                // name IS in allowed_write_tags").
                if bc
                    .safe_state_pinned_tags
                    .iter()
                    .any(|t| t == name)
                {
                    return Err(VmError::SafeStatePinned {
                        tag: name.clone(),
                    });
                }
                if !bc.allowed_write_tags.iter().any(|t| t == name) {
                    return Err(VmError::TagNotAllowed {
                        tag: name.clone(),
                    });
                }
                // Allowlist + pinned gates cleared.
                // ProcessImage write lands in a future
                // batch; this dispatch surfaces the
                // not-wired error with the value still on
                // the stack so the engine consumer can
                // observe the attempt for audit. The
                // future ProcessImage wiring pops the
                // value before writing — leaving it on
                // the stack during the not-wired phase
                // means the engine layer can inspect the
                // attempted write value via `vm.stack()`.
                Err(VmError::TagIoNotWired {
                    tag: name.clone(),
                    direction: "write",
                })
            }

            // Stdlib — Batch 154 wires the 10 Batch 148
            // numeric functions. Each variant pops its
            // declared arg count in reverse (stack top
            // is the rightmost arg) + pushes the single
            // result. Runtime faults (SQRT of negative,
            // LN of non-positive) trip SafeState per
            // IEC 61131-3 fault semantic.
            Opcode::StdlibCall { fn_id } => self.dispatch_stdlib(*fn_id),

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

    /// Dispatch a single stdlib function call (Batch
    /// 154). Assumes args are already on the stack (left
    /// to right). Pops the declared arg count + pushes
    /// exactly one result.
    ///
    /// Runtime fault policy:
    /// - SQRT(negative) → `VmError::SafeStateTripped`.
    /// - LN(x ≤ 0)      → `VmError::SafeStateTripped`.
    /// - Integer ABS on i64::MIN wraps per Batch 151
    ///   arithmetic discipline (wrapping_abs). PLC
    ///   operators see a deterministic value on overflow
    ///   rather than SafeState — matches Batch 151
    ///   AddInt/SubInt/MulInt wrapping behavior.
    fn dispatch_stdlib(
        &mut self,
        fn_id: super::bytecode::StdlibFunctionId,
    ) -> Result<DispatchStep, VmError> {
        use super::bytecode::StdlibFunctionId as F;

        match fn_id {
            F::AbsInt => {
                let x = self.pop_int("Stdlib::AbsInt")?;
                self.stack.push(StValue::Int(x.wrapping_abs()));
            }
            F::AbsReal => {
                let x = self.pop_real("Stdlib::AbsReal")?;
                self.stack.push(StValue::Real(x.abs()));
            }
            F::SqrtReal => {
                let x = self.pop_real("Stdlib::SqrtReal")?;
                if x < 0.0 {
                    // IEC 61131-3 fault on SQRT(negative)
                    // → trip safe state. Operator sees a
                    // deterministic fault rather than NaN
                    // contamination of downstream tags.
                    return Err(VmError::SafeStateTripped);
                }
                self.stack.push(StValue::Real(x.sqrt()));
            }
            F::LimitReal => {
                // LIMIT(mn, in, mx) → args pushed in
                // that order, so stack top = mx.
                let mx = self.pop_real("Stdlib::LimitReal")?;
                let in_val = self.pop_real("Stdlib::LimitReal")?;
                let mn = self.pop_real("Stdlib::LimitReal")?;
                // Explicit clamp — NaN-safe: if mn > mx
                // (operator-supplied nonsense) result is
                // mn per Rust f64::clamp panic avoidance.
                let clamped = if mn > mx {
                    mn
                } else {
                    in_val.clamp(mn, mx)
                };
                self.stack.push(StValue::Real(clamped));
            }
            F::MinReal => {
                let b = self.pop_real("Stdlib::MinReal")?;
                let a = self.pop_real("Stdlib::MinReal")?;
                // f64::min carries NaN-min semantic per
                // IEEE 754 — NaN vs x → x. Acceptable for
                // numeric IEC types.
                self.stack.push(StValue::Real(a.min(b)));
            }
            F::MaxReal => {
                let b = self.pop_real("Stdlib::MaxReal")?;
                let a = self.pop_real("Stdlib::MaxReal")?;
                self.stack.push(StValue::Real(a.max(b)));
            }
            F::SelReal => {
                // SEL(cond: Bool, if_false: Real, if_true: Real)
                // Args pushed left-to-right → stack top =
                // if_true. Pop order: if_true, if_false,
                // cond. IEC 61131-3: cond=TRUE selects
                // if_true (argument 2), cond=FALSE selects
                // if_false (argument 1).
                let if_true = self.pop_real("Stdlib::SelReal")?;
                let if_false = self.pop_real("Stdlib::SelReal")?;
                let cond = self.pop_bool("Stdlib::SelReal")?;
                self.stack.push(StValue::Real(if cond {
                    if_true
                } else {
                    if_false
                }));
            }
            F::LnReal => {
                let x = self.pop_real("Stdlib::LnReal")?;
                if x <= 0.0 {
                    // LN domain is (0, ∞). x≤0 is a PLC
                    // runtime fault → safe state.
                    return Err(VmError::SafeStateTripped);
                }
                self.stack.push(StValue::Real(x.ln()));
            }
            F::ExpReal => {
                let x = self.pop_real("Stdlib::ExpReal")?;
                self.stack.push(StValue::Real(x.exp()));
            }
            F::PowReal => {
                let exp_arg = self.pop_real("Stdlib::PowReal")?;
                let base = self.pop_real("Stdlib::PowReal")?;
                self.stack.push(StValue::Real(base.powf(exp_arg)));
            }
        }
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
    // Type cast (Batch 153)
    // ====================================================================

    #[test]
    fn run_cast_int_to_real_promotes_to_f64() {
        let b = bc(
            vec![
                Opcode::PushConst { value: StValue::Int(7) },
                Opcode::CastIntToReal,
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(7.0)]);
    }

    #[test]
    fn run_cast_int_to_real_on_non_int_is_type_mismatch() {
        let b = bc(
            vec![
                Opcode::PushConst { value: StValue::Real(1.5) },
                Opcode::CastIntToReal,
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

    #[test]
    fn run_compiled_sqrt_roundtrip() {
        // Batch 155 Faz 3 end-to-end: compile + execute
        // a program that calls SQRT(9.0) + stores into a
        // Real local.
        //
        // PROGRAM p  VAR r: REAL; END_VAR  r := SQRT(9.0);
        use super::super::bytecode_compiler::compile_program;
        use crate::st_validator::{
            DataType, Expression, Program, Statement, VarBlock, VarDeclaration, VarScope,
        };

        let prog = Program {
            name: "p".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: false,
                constant: false,
                declarations: vec![VarDeclaration {
                    name: "r".into(),
                    data_type: DataType::Real,
                    initial_value: None,
                    span: None,
                }],
                span: None,
            }],
            body: vec![Statement::Assignment {
                target: Expression::Variable("r".into(), None),
                value: Expression::FunctionCall {
                    name: "SQRT".into(),
                    args: vec![Expression::RealLiteral(9.0)],
                },
                span: None,
            }],
            span: None,
        };
        let bc_compiled =
            compile_program(&prog, &[], "p".into(), 1_000).expect("compile");
        let mut vm = ScriptVm::new(&bc_compiled);
        assert_eq!(vm.run(&bc_compiled), VmOutcome::Returned);
        assert_eq!(vm.locals()[0], StValue::Real(3.0));
    }

    #[test]
    fn run_compiled_limit_with_int_literal_promotion() {
        // r := LIMIT(0, 5, 10);  — all Int literals
        // promoted to Real per stdlib signature.
        use super::super::bytecode_compiler::compile_program;
        use crate::st_validator::{
            DataType, Expression, Program, Statement, VarBlock, VarDeclaration, VarScope,
        };

        let prog = Program {
            name: "p".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: false,
                constant: false,
                declarations: vec![VarDeclaration {
                    name: "r".into(),
                    data_type: DataType::Real,
                    initial_value: None,
                    span: None,
                }],
                span: None,
            }],
            body: vec![Statement::Assignment {
                target: Expression::Variable("r".into(), None),
                value: Expression::FunctionCall {
                    name: "LIMIT".into(),
                    args: vec![
                        Expression::IntLiteral(0),
                        Expression::IntLiteral(5),
                        Expression::IntLiteral(10),
                    ],
                },
                span: None,
            }],
            span: None,
        };
        let bc_compiled =
            compile_program(&prog, &[], "p".into(), 1_000).expect("compile");
        let mut vm = ScriptVm::new(&bc_compiled);
        assert_eq!(vm.run(&bc_compiled), VmOutcome::Returned);
        assert_eq!(vm.locals()[0], StValue::Real(5.0));
    }

    #[test]
    fn run_compiled_int_plus_real_roundtrip() {
        // PROGRAM p  VAR r: REAL; END_VAR  r := 2 + 3.5;
        use super::super::bytecode_compiler::compile_program;
        use crate::st_validator::{
            BinaryOp, DataType, Expression, Program, Statement, VarBlock, VarDeclaration, VarScope,
        };

        let prog = Program {
            name: "p".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: false,
                constant: false,
                declarations: vec![VarDeclaration {
                    name: "r".into(),
                    data_type: DataType::Real,
                    initial_value: None,
                    span: None,
                }],
                span: None,
            }],
            body: vec![Statement::Assignment {
                target: Expression::Variable("r".into(), None),
                value: Expression::BinaryOp {
                    left: Box::new(Expression::IntLiteral(2)),
                    op: BinaryOp::Add,
                    right: Box::new(Expression::RealLiteral(3.5)),
                },
                span: None,
            }],
            span: None,
        };
        let bc_compiled =
            compile_program(&prog, &[], "p".into(), 1_000).expect("compile");
        let mut vm = ScriptVm::new(&bc_compiled);
        assert_eq!(vm.run(&bc_compiled), VmOutcome::Returned);
        assert_eq!(vm.locals()[0], StValue::Real(5.5));
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

    // ====================================================================
    // Batch 156 — WriteTag tier-1 security gates
    // ====================================================================

    fn bc_with_tag_rules(
        opcodes: Vec<Opcode>,
        locals: u32,
        allowed: Vec<String>,
        pinned: Vec<String>,
    ) -> Bytecode {
        Bytecode {
            program_id: "t".into(),
            program_name: "t".into(),
            max_gas_per_tick: 1_000_000,
            local_count: locals,
            retain_vars: vec![],
            allowed_write_tags: allowed,
            safe_state_pinned_tags: pinned,
            opcodes,
        }
    }

    #[test]
    fn run_write_tag_blocked_when_not_in_allowlist() {
        let b = bc_with_tag_rules(
            vec![
                Opcode::PushConst { value: StValue::Real(1.0) },
                Opcode::WriteTag { name: "rogue_tag".into() },
                Opcode::Return,
            ],
            0,
            vec!["safe_tag".into()],
            vec![],
        );
        let mut vm = ScriptVm::new(&b);
        let outcome = vm.run(&b);
        match outcome {
            VmOutcome::Error(VmError::TagNotAllowed { tag }) => {
                assert_eq!(tag, "rogue_tag");
            }
            other => panic!("expected TagNotAllowed, got {:?}", other),
        }
    }

    #[test]
    fn run_write_tag_blocked_when_safe_state_pinned() {
        // Even with the tag in the allowlist, pinned
        // status must win.
        let b = bc_with_tag_rules(
            vec![
                Opcode::PushConst { value: StValue::Real(1.0) },
                Opcode::WriteTag { name: "aerator_on".into() },
                Opcode::Return,
            ],
            0,
            vec!["aerator_on".into()],
            vec!["aerator_on".into()],
        );
        let mut vm = ScriptVm::new(&b);
        let outcome = vm.run(&b);
        match outcome {
            VmOutcome::Error(VmError::SafeStatePinned { tag }) => {
                assert_eq!(tag, "aerator_on");
            }
            other => panic!("expected SafeStatePinned, got {:?}", other),
        }
    }

    #[test]
    fn run_write_tag_allowed_passes_gates_then_hits_io_stub() {
        // Tag in allowlist + not pinned → both gates
        // cleared; the opcode surfaces TagIoNotWired
        // (future ProcessImage wiring replaces this).
        let b = bc_with_tag_rules(
            vec![
                Opcode::PushConst { value: StValue::Real(2.5) },
                Opcode::WriteTag { name: "feeder_rate".into() },
                Opcode::Return,
            ],
            0,
            vec!["feeder_rate".into()],
            vec![],
        );
        let mut vm = ScriptVm::new(&b);
        let outcome = vm.run(&b);
        match outcome {
            VmOutcome::Error(VmError::TagIoNotWired {
                tag, direction,
            }) => {
                assert_eq!(tag, "feeder_rate");
                assert_eq!(direction, "write");
            }
            other => panic!(
                "expected TagIoNotWired after gates cleared, got {:?}",
                other
            ),
        }
        // Value must remain on the stack so the engine
        // consumer can observe the attempt during the
        // not-yet-wired phase.
        assert_eq!(vm.stack(), &[StValue::Real(2.5)]);
    }

    #[test]
    fn run_write_tag_pinned_check_runs_before_allowlist_check() {
        // Tag NOT in allowlist AND also pinned. Pinned
        // check runs first (order-independent from the
        // allowlist outcome) so the operator-visible
        // error points at the pinned rule.
        let b = bc_with_tag_rules(
            vec![
                Opcode::PushConst { value: StValue::Real(1.0) },
                Opcode::WriteTag { name: "e_stop".into() },
                Opcode::Return,
            ],
            0,
            vec![], // not in allowlist
            vec!["e_stop".into()],
        );
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::SafeStatePinned { .. })
        ));
    }

    // ====================================================================
    // Stdlib dispatch (Batch 154)
    // ====================================================================

    #[test]
    fn run_stdlib_abs_int_negates_negative() {
        use super::super::bytecode::StdlibFunctionId;
        let b = bc(
            vec![
                Opcode::PushConst { value: StValue::Int(-7) },
                Opcode::StdlibCall { fn_id: StdlibFunctionId::AbsInt },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Int(7)]);
    }

    #[test]
    fn run_stdlib_abs_real_returns_magnitude() {
        use super::super::bytecode::StdlibFunctionId;
        let b = bc(
            vec![
                Opcode::PushConst { value: StValue::Real(-3.25) },
                Opcode::StdlibCall { fn_id: StdlibFunctionId::AbsReal },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(3.25)]);
    }

    #[test]
    fn run_stdlib_sqrt_real_returns_root() {
        use super::super::bytecode::StdlibFunctionId;
        let b = bc(
            vec![
                Opcode::PushConst { value: StValue::Real(9.0) },
                Opcode::StdlibCall { fn_id: StdlibFunctionId::SqrtReal },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(3.0)]);
    }

    #[test]
    fn run_stdlib_sqrt_real_negative_trips_safe_state() {
        use super::super::bytecode::StdlibFunctionId;
        let b = bc(
            vec![
                Opcode::PushConst { value: StValue::Real(-1.0) },
                Opcode::StdlibCall { fn_id: StdlibFunctionId::SqrtReal },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(
            vm.run(&b),
            VmOutcome::Error(VmError::SafeStateTripped)
        );
    }

    #[test]
    fn run_stdlib_limit_real_clamps_above_max() {
        use super::super::bytecode::StdlibFunctionId;
        // LIMIT(0, 10, 5) → 5 (clamped to max).
        let b = bc(
            vec![
                Opcode::PushConst { value: StValue::Real(0.0) },
                Opcode::PushConst { value: StValue::Real(10.0) },
                Opcode::PushConst { value: StValue::Real(5.0) },
                Opcode::StdlibCall { fn_id: StdlibFunctionId::LimitReal },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(5.0)]);
    }

    #[test]
    fn run_stdlib_limit_real_clamps_below_min() {
        use super::super::bytecode::StdlibFunctionId;
        // LIMIT(2, -1, 5) → 2 (clamped to min).
        let b = bc(
            vec![
                Opcode::PushConst { value: StValue::Real(2.0) },
                Opcode::PushConst { value: StValue::Real(-1.0) },
                Opcode::PushConst { value: StValue::Real(5.0) },
                Opcode::StdlibCall { fn_id: StdlibFunctionId::LimitReal },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(2.0)]);
    }

    #[test]
    fn run_stdlib_limit_real_passthrough_within_range() {
        use super::super::bytecode::StdlibFunctionId;
        let b = bc(
            vec![
                Opcode::PushConst { value: StValue::Real(0.0) },
                Opcode::PushConst { value: StValue::Real(3.5) },
                Opcode::PushConst { value: StValue::Real(10.0) },
                Opcode::StdlibCall { fn_id: StdlibFunctionId::LimitReal },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(3.5)]);
    }

    #[test]
    fn run_stdlib_min_max_real_picks_extrema() {
        use super::super::bytecode::StdlibFunctionId;
        let b_min = bc(
            vec![
                Opcode::PushConst { value: StValue::Real(5.0) },
                Opcode::PushConst { value: StValue::Real(3.0) },
                Opcode::StdlibCall { fn_id: StdlibFunctionId::MinReal },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b_min);
        assert_eq!(vm.run(&b_min), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(3.0)]);

        let b_max = bc(
            vec![
                Opcode::PushConst { value: StValue::Real(5.0) },
                Opcode::PushConst { value: StValue::Real(3.0) },
                Opcode::StdlibCall { fn_id: StdlibFunctionId::MaxReal },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b_max);
        assert_eq!(vm.run(&b_max), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(5.0)]);
    }

    #[test]
    fn run_stdlib_sel_real_picks_by_cond() {
        use super::super::bytecode::StdlibFunctionId;
        // SEL(cond=TRUE, if_false=1.0, if_true=9.0) → 9.0.
        let b_true = bc(
            vec![
                Opcode::PushConst { value: StValue::Bool(true) },
                Opcode::PushConst { value: StValue::Real(1.0) },
                Opcode::PushConst { value: StValue::Real(9.0) },
                Opcode::StdlibCall { fn_id: StdlibFunctionId::SelReal },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b_true);
        assert_eq!(vm.run(&b_true), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(9.0)]);

        // SEL(cond=FALSE, if_false=1.0, if_true=9.0) → 1.0.
        let b_false = bc(
            vec![
                Opcode::PushConst { value: StValue::Bool(false) },
                Opcode::PushConst { value: StValue::Real(1.0) },
                Opcode::PushConst { value: StValue::Real(9.0) },
                Opcode::StdlibCall { fn_id: StdlibFunctionId::SelReal },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b_false);
        assert_eq!(vm.run(&b_false), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(1.0)]);
    }

    #[test]
    fn run_stdlib_ln_real_returns_log() {
        use super::super::bytecode::StdlibFunctionId;
        // LN(e) = 1.0
        let b = bc(
            vec![
                Opcode::PushConst { value: StValue::Real(std::f64::consts::E) },
                Opcode::StdlibCall { fn_id: StdlibFunctionId::LnReal },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        let top = vm.stack()[0];
        if let StValue::Real(v) = top {
            assert!((v - 1.0).abs() < 1e-12);
        } else {
            panic!("expected Real, got {:?}", top);
        }
    }

    #[test]
    fn run_stdlib_ln_real_non_positive_trips_safe_state() {
        use super::super::bytecode::StdlibFunctionId;
        let b_zero = bc(
            vec![
                Opcode::PushConst { value: StValue::Real(0.0) },
                Opcode::StdlibCall { fn_id: StdlibFunctionId::LnReal },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b_zero);
        assert_eq!(
            vm.run(&b_zero),
            VmOutcome::Error(VmError::SafeStateTripped)
        );

        let b_neg = bc(
            vec![
                Opcode::PushConst { value: StValue::Real(-0.5) },
                Opcode::StdlibCall { fn_id: StdlibFunctionId::LnReal },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b_neg);
        assert_eq!(
            vm.run(&b_neg),
            VmOutcome::Error(VmError::SafeStateTripped)
        );
    }

    #[test]
    fn run_stdlib_exp_real_returns_e_to_the_x() {
        use super::super::bytecode::StdlibFunctionId;
        let b = bc(
            vec![
                Opcode::PushConst { value: StValue::Real(1.0) },
                Opcode::StdlibCall { fn_id: StdlibFunctionId::ExpReal },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        if let StValue::Real(v) = vm.stack()[0] {
            assert!((v - std::f64::consts::E).abs() < 1e-12);
        } else {
            panic!("expected Real");
        }
    }

    #[test]
    fn run_stdlib_pow_real_returns_base_to_exp() {
        use super::super::bytecode::StdlibFunctionId;
        // 2 ^ 10 = 1024
        let b = bc(
            vec![
                Opcode::PushConst { value: StValue::Real(2.0) },
                Opcode::PushConst { value: StValue::Real(10.0) },
                Opcode::StdlibCall { fn_id: StdlibFunctionId::PowReal },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(1024.0)]);
    }

    // ====================================================================
    // Integration with compiler (end-to-end)
    // ====================================================================

    #[test]
    fn run_compiled_while_loop_counts_to_three() {
        // Batch 152 Faz 3 end-to-end test — compile +
        // run a WHILE loop through the Batch 151 VM.
        //
        // PROGRAM p
        //   VAR i: INT; flag: BOOL; END_VAR
        //   i := 0;
        //   flag := TRUE;
        //   WHILE flag DO
        //     i := i + 1;
        //     IF i = 3 THEN flag := FALSE; END_IF;
        //   END_WHILE
        // END_PROGRAM
        use super::super::bytecode_compiler::compile_program;
        use crate::st_validator::{
            BinaryOp, DataType, Expression, Program, Statement, VarBlock, VarDeclaration, VarScope,
        };

        let prog = Program {
            name: "p".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: false,
                constant: false,
                declarations: vec![
                    VarDeclaration {
                        name: "i".into(),
                        data_type: DataType::Int,
                        initial_value: None,
                        span: None,
                    },
                    VarDeclaration {
                        name: "flag".into(),
                        data_type: DataType::Bool,
                        initial_value: None,
                        span: None,
                    },
                ],
                span: None,
            }],
            body: vec![
                // i := 0;
                Statement::Assignment {
                    target: Expression::Variable("i".into(), None),
                    value: Expression::IntLiteral(0),
                    span: None,
                },
                // flag := TRUE;
                Statement::Assignment {
                    target: Expression::Variable("flag".into(), None),
                    value: Expression::BoolLiteral(true),
                    span: None,
                },
                // WHILE flag DO ... END_WHILE
                Statement::While {
                    condition: Expression::Variable("flag".into(), None),
                    body: vec![
                        // i := i + 1;
                        Statement::Assignment {
                            target: Expression::Variable("i".into(), None),
                            value: Expression::BinaryOp {
                                left: Box::new(Expression::Variable("i".into(), None)),
                                op: BinaryOp::Add,
                                right: Box::new(Expression::IntLiteral(1)),
                            },
                            span: None,
                        },
                        // IF i = 3 THEN flag := FALSE; END_IF
                        Statement::If {
                            condition: Expression::BinaryOp {
                                left: Box::new(Expression::Variable("i".into(), None)),
                                op: BinaryOp::Eq,
                                right: Box::new(Expression::IntLiteral(3)),
                            },
                            then_body: vec![Statement::Assignment {
                                target: Expression::Variable("flag".into(), None),
                                value: Expression::BoolLiteral(false),
                                span: None,
                            }],
                            elsif_branches: vec![],
                            else_body: None,
                            span: None,
                        },
                    ],
                    span: None,
                },
            ],
            span: None,
        };
        let bc_compiled =
            compile_program(&prog, &[], "p".into(), 1_000_000).expect("compile");
        let mut vm = ScriptVm::new(&bc_compiled);
        assert_eq!(vm.run(&bc_compiled), VmOutcome::Returned);
        // After loop: i = 3, flag = false.
        assert_eq!(vm.locals()[0], StValue::Int(3));
        assert_eq!(vm.locals()[1], StValue::Bool(false));
    }

    #[test]
    fn run_compiled_repeat_loop_runs_at_least_once() {
        // REPEAT i := 42; UNTIL TRUE END_REPEAT
        // Even though UNTIL is true on first check,
        // REPEAT executes body at least once.
        use super::super::bytecode_compiler::compile_program;
        use crate::st_validator::{
            DataType, Expression, Program, Statement, VarBlock, VarDeclaration, VarScope,
        };

        let prog = Program {
            name: "p".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: false,
                constant: false,
                declarations: vec![VarDeclaration {
                    name: "i".into(),
                    data_type: DataType::Int,
                    initial_value: None,
                    span: None,
                }],
                span: None,
            }],
            body: vec![Statement::Repeat {
                body: vec![Statement::Assignment {
                    target: Expression::Variable("i".into(), None),
                    value: Expression::IntLiteral(42),
                    span: None,
                }],
                condition: Expression::BoolLiteral(true),
                span: None,
            }],
            span: None,
        };
        let bc_compiled =
            compile_program(&prog, &[], "p".into(), 1_000).expect("compile");
        let mut vm = ScriptVm::new(&bc_compiled);
        assert_eq!(vm.run(&bc_compiled), VmOutcome::Returned);
        assert_eq!(vm.locals()[0], StValue::Int(42));
    }

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
            compile_program(&prog, &[], "p".into(), 1_000).expect("compile");
        let mut vm = ScriptVm::new(&bc_compiled);
        assert_eq!(vm.run(&bc_compiled), VmOutcome::Returned);
        // local[0] = x = 8
        assert_eq!(vm.locals()[0], StValue::Int(8));
    }
}
