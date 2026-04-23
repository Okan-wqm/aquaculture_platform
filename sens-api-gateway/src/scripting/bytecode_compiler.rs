//! ST expression compiler — AST `Expression` → `Vec<Opcode>`
//! (Batch 149 Faz 3 / plan R-1).
//!
//! ## WHY
//!
//! Plan §3 R-1 + plan §5 Faz 3 item 1 specify a
//! bytecode compiler that takes the Batch 8+
//! `st_validator::Program` AST + emits a
//! `Bytecode` instruction stream the Batch 150 (future)
//! VM dispatches. Pre-Batch-149 the bytecode module
//! (Batch 148) shipped only the IR types — no path
//! from AST to IR.
//!
//! This batch lands the EXPRESSION subset:
//! literal constants, variable loads, binary
//! arithmetic + comparison, unary negation/not.
//! Statement compilation (Assignment, If, While, etc.)
//! + control flow + retain binding + FB invoke land
//! in subsequent Faz 3 batches.
//!
//! ## Architectural shape
//!
//! Stack-based emission: every expression compiles to
//! an opcode sequence that leaves ONE value on top of
//! the VM stack. Nested expressions compose naturally
//! — BinaryOp emits both operands (each leaves 1 on
//! stack) then the operator opcode (pops 2, pushes 1
//! result).
//!
//! Type inference: a narrow 3-type system (Bool / Int
//! / Real) matches the Batch 148 `StValue` variants.
//! Mixed Int + Real binary ops implicitly promote Int
//! → Real (standard IEC 61131-3 semantic). String /
//! Time types defer to future batches.
//!
//! Symbol table: `SymbolTable` maps variable NAMES to
//! (local slot index, declared type) for LoadLocal
//! emission. Built by the caller from
//! `Program.var_blocks`.
//!
//! Primitive-first batch (Batch 111 / 140 / 148
//! precedent). `#![allow(dead_code)]` removed when
//! Batch 150 VM + statement compiler consume these
//! types end-to-end.
#![allow(dead_code)]

use std::collections::HashMap;

use super::bytecode::{Bytecode, Opcode, StValue, StValueType};
use crate::st_validator::{BinaryOp, DataType, Expression, Statement, UnaryOp};

/// Symbol table mapping variable names → (local slot
/// index, declared type). Built once per program
/// from the Program.var_blocks + consumed by
/// `compile_expression` on every Variable reference.
#[derive(Debug, Clone, Default)]
pub struct SymbolTable {
    entries: HashMap<String, SymbolEntry>,
    /// Batch 182 Faz 3: declared output pin types per
    /// FB instance name. Consumed by
    /// `compile_expression` MemberAccess arm so
    /// `my_timer.Q` resolves to the correct StValueType
    /// (Bool, Int, Real) at compile time. Absence in
    /// the map falls back to Real (the Batch 181
    /// placeholder default — preserves backward compat
    /// for tests that construct SymbolTable without
    /// FB info).
    fb_instance_outputs: HashMap<String, HashMap<String, StValueType>>,
    /// Batch 183 Faz 3: declared INPUT pin types per FB
    /// instance. Symmetric to outputs. Consumed by
    /// `compile_statement` FunctionBlockCall arm so a
    /// wrong-typed argument rejects at compile time
    /// (vs waiting for runtime `FbIoError::TypeMismatch`).
    /// Int→Real promotion is emitted when the argument
    /// is Int and the pin is Real, matching the Batch
    /// 153 assignment-boundary promotion rule.
    fb_instance_inputs: HashMap<String, HashMap<String, StValueType>>,
}

/// Symbol classification — Batch 157 Faz 3 adds the
/// `Tag` kind so the compiler can tell a VAR-declared
/// local (emits LoadLocal / StoreLocal) apart from a
/// ProcessImage tag (emits LoadTag / WriteTag).
///
/// Tag names are not duplicated inside the variant —
/// the compiler already has the name from the
/// `Expression::Variable(name, _)` callsite; keeping
/// the variant unit-shaped preserves `Copy` semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SymbolKind {
    /// Local variable occupying slot `local_index` in
    /// the VM's locals array.
    Local { local_index: u32 },
    /// Process-image tag. Read via LoadTag, write via
    /// WriteTag when `writable` is true.
    Tag,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SymbolEntry {
    pub kind: SymbolKind,
    pub declared_type: StValueType,
    /// False for read-only tags (e.g. sensor inputs).
    /// True for locals (always writable) + writable
    /// tags (actuators, setpoints).
    pub writable: bool,
}

impl SymbolEntry {
    /// Convenience constructor for a local-variable
    /// entry. Locals are always writable.
    pub fn local(local_index: u32, declared_type: StValueType) -> Self {
        Self {
            kind: SymbolKind::Local { local_index },
            declared_type,
            writable: true,
        }
    }

    /// Convenience constructor for a tag entry. Caller
    /// supplies `writable` from the ProcessImage catalog.
    pub fn tag(declared_type: StValueType, writable: bool) -> Self {
        Self {
            kind: SymbolKind::Tag,
            declared_type,
            writable,
        }
    }
}

/// ProcessImage tag descriptor supplied to the compiler
/// so tag references in ST source map to LoadTag /
/// WriteTag opcodes with correct type-check + allowlist
/// population.
///
/// Batch 157: compiler consumes a `&[TagDescriptor]`
/// slice from `compile_program`. The agent wires this
/// up from its `io_poll.tags[]` config in a future
/// batch (Batch 158 or the cmd_deploy_program
/// integration batch).
#[derive(Debug, Clone)]
pub struct TagDescriptor {
    pub name: String,
    pub data_type: StValueType,
    /// Scripts may write to this tag (actuator / setpoint).
    /// False for sensor inputs + read-only metadata.
    pub writable: bool,
}

impl SymbolTable {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, name: impl Into<String>, entry: SymbolEntry) {
        self.entries.insert(name.into(), entry);
    }

    pub fn get(&self, name: &str) -> Option<&SymbolEntry> {
        self.entries.get(name)
    }

    /// Batch 182: register an FB instance's output pin
    /// types so `MemberAccess` typing is precise.
    pub fn insert_fb_outputs(
        &mut self,
        instance_name: impl Into<String>,
        outputs: HashMap<String, StValueType>,
    ) {
        self.fb_instance_outputs.insert(instance_name.into(), outputs);
    }

    /// Batch 182: look up an FB instance output pin's
    /// declared type. Returns None when either the FB
    /// instance or the named pin is unknown — caller
    /// falls back to the Batch 181 placeholder (Real).
    pub fn fb_output_type(
        &self,
        instance_name: &str,
        pin_name: &str,
    ) -> Option<StValueType> {
        self.fb_instance_outputs
            .get(instance_name)?
            .get(pin_name)
            .copied()
    }

    /// Batch 183: register an FB instance's input pin
    /// types so `FbCall` arg typing is enforced at
    /// compile time.
    pub fn insert_fb_inputs(
        &mut self,
        instance_name: impl Into<String>,
        inputs: HashMap<String, StValueType>,
    ) {
        self.fb_instance_inputs
            .insert(instance_name.into(), inputs);
    }

    /// Batch 183: look up an FB instance input pin's
    /// declared type. None when the FB instance or the
    /// named pin is not registered — caller skips the
    /// compile-time type check (matches Batch 181
    /// runtime-only behavior for unregistered FBs).
    pub fn fb_input_type(
        &self,
        instance_name: &str,
        pin_name: &str,
    ) -> Option<StValueType> {
        self.fb_instance_inputs
            .get(instance_name)?
            .get(pin_name)
            .copied()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Compile-time inference result. Mirrors Batch 148
/// `StValueType` enum — the compiler must know which
/// type a value will have at runtime to emit the
/// correct per-type opcode (AddInt vs AddReal etc).
pub type InferredType = StValueType;

/// Compile failure taxonomy. Each variant corresponds to
/// a type-check or resolution error that can't be
/// recovered from — the caller aborts compilation +
/// surfaces the error to the operator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompileError {
    /// Variable referenced by the AST is not in the
    /// symbol table. Pre-compile the program AST must
    /// have passed `st_validator` which catches this;
    /// defense-in-depth here catches the case where
    /// the compiler receives an AST from a different
    /// validation path.
    UnknownVariable { name: String },
    /// Binary operator received operand types it
    /// cannot combine (e.g. Bool + Int).
    TypeMismatch {
        op: String,
        left: InferredType,
        right: InferredType,
    },
    /// Unary operator received an operand type it
    /// cannot handle (e.g. NOT on Int).
    UnaryTypeMismatch {
        op: String,
        operand: InferredType,
    },
    /// Expression contains a construct not yet
    /// supported by the Batch 149 compiler. Batches
    /// 150+ extend coverage.
    Unsupported { what: String },
    /// Batch 157 Faz 3: assignment target is a
    /// ProcessImage tag declared read-only in the tag
    /// catalog. Sensor inputs + read-only metadata tags
    /// cannot be written from scripts.
    ReadOnlyTag { name: String },
}

impl std::fmt::Display for CompileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownVariable { name } => {
                write!(f, "unknown variable: {}", name)
            }
            Self::TypeMismatch { op, left, right } => write!(
                f,
                "type mismatch for {}: left={:?}, right={:?}",
                op, left, right
            ),
            Self::UnaryTypeMismatch { op, operand } => {
                write!(f, "unary type mismatch for {}: operand={:?}", op, operand)
            }
            Self::Unsupported { what } => {
                write!(f, "unsupported expression: {}", what)
            }
            Self::ReadOnlyTag { name } => {
                write!(f, "assignment to read-only tag: {}", name)
            }
        }
    }
}

impl std::error::Error for CompileError {}

/// Compile an expression. Returns (opcode stream,
/// inferred type of the value left on the stack).
///
/// The caller drives allocation of opcodes into the
/// final Bytecode.opcodes vec; this helper returns a
/// fresh Vec per call so nested expression compilation
/// composes cleanly (concat child vecs into parent's).
pub fn compile_expression(
    expr: &Expression,
    symbols: &SymbolTable,
) -> Result<(Vec<Opcode>, InferredType), CompileError> {
    match expr {
        Expression::BoolLiteral(b) => Ok((
            vec![Opcode::PushConst {
                value: StValue::Bool(*b),
            }],
            StValueType::Bool,
        )),
        Expression::IntLiteral(n) => Ok((
            vec![Opcode::PushConst {
                value: StValue::Int(*n),
            }],
            StValueType::Int,
        )),
        Expression::RealLiteral(x) => Ok((
            vec![Opcode::PushConst {
                value: StValue::Real(*x),
            }],
            StValueType::Real,
        )),
        Expression::Variable(name, _span) => {
            let entry = symbols.get(name).ok_or_else(|| {
                CompileError::UnknownVariable {
                    name: name.clone(),
                }
            })?;
            let load_op = match entry.kind {
                SymbolKind::Local { local_index } => {
                    Opcode::LoadLocal { index: local_index }
                }
                SymbolKind::Tag => Opcode::LoadTag {
                    name: name.clone(),
                },
            };
            Ok((vec![load_op], entry.declared_type))
        }
        Expression::UnaryOp { op, operand } => {
            let (mut ops, operand_type) = compile_expression(operand, symbols)?;
            match (op, operand_type) {
                (UnaryOp::Neg, StValueType::Int) => {
                    ops.push(Opcode::NegInt);
                    Ok((ops, StValueType::Int))
                }
                (UnaryOp::Neg, StValueType::Real) => {
                    ops.push(Opcode::NegReal);
                    Ok((ops, StValueType::Real))
                }
                (UnaryOp::Not, StValueType::Bool) => {
                    ops.push(Opcode::Not);
                    Ok((ops, StValueType::Bool))
                }
                (op, t) => Err(CompileError::UnaryTypeMismatch {
                    op: format!("{:?}", op),
                    operand: t,
                }),
            }
        }
        Expression::BinaryOp { left, op, right } => compile_binary_op(left, op, right, symbols),
        Expression::Parenthesized(inner) => compile_expression(inner, symbols),
        Expression::StringLiteral(_) | Expression::TimeLiteral(_) => Err(
            CompileError::Unsupported {
                what: "string / time literals (future batch adds String/Time StValue variants)".to_string(),
            },
        ),
        Expression::ArrayAccess { .. } => Err(CompileError::Unsupported {
            what: "array access (future batch)".to_string(),
        }),
        Expression::MemberAccess { object, member } => {
            // Batch 181 Faz 3: `fb_instance.output_pin`
            // maps to `FbReadOutput { fb_id, output_name }`.
            // The object MUST be a bare Variable whose
            // name denotes an FB instance; more complex
            // left-hand shapes (`arr[0].x`, nested
            // member access) stay Unsupported until
            // the FB-type catalog lands.
            //
            // Type inference: the compiler doesn't know
            // the FB output's declared type at this
            // call site. Pick Real as the inferred
            // type — most FB outputs are numeric
            // (ET timer elapsed, PID output, counter
            // value). Bool outputs (TON.Q, rising-edge
            // trip) downgrade to wrong inferred type
            // which the downstream opcode catches at
            // runtime via VmError::TypeMismatch. Batch
            // 182 plumbs an FbTypeCatalog so the
            // compiler can pick the right type.
            let fb_name = match object.as_ref() {
                Expression::Variable(name, _) => name.clone(),
                other => {
                    return Err(CompileError::Unsupported {
                        what: format!(
                            "member-access LHS must be a bare FB instance name (got {:?})",
                            target_kind(other)
                        ),
                    });
                }
            };
            // Batch 182: look up the FB output pin's
            // declared type from the symbol table.
            // Absent → fall back to Real (Batch 181
            // default). Present → use the precise
            // type so downstream opcodes + assignment
            // targets type-check correctly at compile
            // time.
            let inferred = symbols
                .fb_output_type(&fb_name, member)
                .unwrap_or(StValueType::Real);
            Ok((
                vec![Opcode::FbReadOutput {
                    fb_id: fb_name,
                    output_name: member.clone(),
                }],
                inferred,
            ))
        }
        Expression::FunctionCall { name, args } => {
            compile_stdlib_function_call(name, args, symbols)
        }
    }
}

/// IEC 61131-3 stdlib function signature descriptor.
///
/// Batch 155 Faz 3 (plan R-1): maps the operator-facing
/// ST name (ABS, SQRT, LIMIT, …) to a runtime
/// `StdlibFunctionId` + validates arg count + promotes
/// Int arguments to Real per Batch 153 mixed-type rule.
///
/// Batch 148 pinned 10 stdlib wire-tags. Batch 155
/// exposes all 10 through the compiler; additional
/// names (LOG, SIN, COS, TAN, ATAN, ATAN2 — plan A
/// corpus) land when Batch 148 extends
/// `StdlibFunctionId` + the VM dispatch gains the
/// matching opcodes.
#[derive(Debug, Clone, Copy)]
struct StdlibSignature {
    /// Runtime function id (Batch 148 wire_tag source).
    fn_id: super::bytecode::StdlibFunctionId,
    /// Expected ST argument count.
    arity: usize,
    /// Declared argument types (None means "any numeric
    /// — use promotion"). Length must match `arity`.
    arg_types: &'static [StdlibArgType],
    /// Runtime return type after VM dispatch.
    return_type: StValueType,
}

/// Per-argument type expectation for a stdlib signature.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StdlibArgType {
    /// Strict Bool argument — Int / Real are rejected.
    Bool,
    /// Strict Int argument — Real is rejected.
    Int,
    /// Strict Real argument — Int is promoted via
    /// `CastIntToReal` per Batch 153 rule.
    Real,
}

/// Resolve an uppercase IEC 61131-3 stdlib name to its
/// signature. Name lookup is case-insensitive per the
/// spec (operators write `ABS`, `abs`, `Abs`
/// interchangeably).
fn resolve_stdlib_signature(name: &str) -> Option<StdlibSignature> {
    use super::bytecode::StdlibFunctionId as F;
    use StdlibArgType::{Int, Real};

    match name.to_ascii_uppercase().as_str() {
        // ABS is polymorphic — Int→AbsInt, Real→AbsReal.
        // The caller resolves variant based on the one
        // argument's inferred type (see compile_stdlib_
        // function_call's ABS branch).
        "ABS" => Some(StdlibSignature {
            fn_id: F::AbsInt, // placeholder; real variant resolved per-call
            arity: 1,
            arg_types: &[Int], // placeholder; real type resolved per-call
            return_type: StValueType::Int, // placeholder
        }),
        "SQRT" => Some(StdlibSignature {
            fn_id: F::SqrtReal,
            arity: 1,
            arg_types: &[Real],
            return_type: StValueType::Real,
        }),
        "LIMIT" => Some(StdlibSignature {
            fn_id: F::LimitReal,
            arity: 3,
            arg_types: &[Real, Real, Real],
            return_type: StValueType::Real,
        }),
        "MIN" => Some(StdlibSignature {
            fn_id: F::MinReal,
            arity: 2,
            arg_types: &[Real, Real],
            return_type: StValueType::Real,
        }),
        "MAX" => Some(StdlibSignature {
            fn_id: F::MaxReal,
            arity: 2,
            arg_types: &[Real, Real],
            return_type: StValueType::Real,
        }),
        "SEL" => Some(StdlibSignature {
            fn_id: F::SelReal,
            arity: 3,
            arg_types: &[StdlibArgType::Bool, Real, Real],
            return_type: StValueType::Real,
        }),
        "LN" => Some(StdlibSignature {
            fn_id: F::LnReal,
            arity: 1,
            arg_types: &[Real],
            return_type: StValueType::Real,
        }),
        "EXP" => Some(StdlibSignature {
            fn_id: F::ExpReal,
            arity: 1,
            arg_types: &[Real],
            return_type: StValueType::Real,
        }),
        "POW" => Some(StdlibSignature {
            fn_id: F::PowReal,
            arity: 2,
            arg_types: &[Real, Real],
            return_type: StValueType::Real,
        }),
        _ => None,
    }
}

/// Compile a stdlib function call expression:
/// `NAME(arg1, arg2, ...)` → argument opcodes followed
/// by a single `Opcode::StdlibCall { fn_id }`.
///
/// - Unknown names return `CompileError::Unsupported`.
/// - Wrong arg count returns `CompileError::Unsupported`
///   (pre-compile st_validator normally catches this;
///   defense-in-depth here catches bypassed validation).
/// - Type mismatches surface via the per-arg type check:
///   Int→Real promotion for Real-declared args, strict
///   match otherwise.
fn compile_stdlib_function_call(
    name: &str,
    args: &[Expression],
    symbols: &SymbolTable,
) -> Result<(Vec<Opcode>, InferredType), CompileError> {
    use super::bytecode::StdlibFunctionId as F;

    let sig = resolve_stdlib_signature(name).ok_or_else(|| CompileError::Unsupported {
        what: format!("unknown stdlib function `{}`", name),
    })?;

    if args.len() != sig.arity {
        return Err(CompileError::Unsupported {
            what: format!(
                "stdlib `{}` expects {} arg(s), got {}",
                name.to_ascii_uppercase(),
                sig.arity,
                args.len()
            ),
        });
    }

    // ABS polymorphism — resolve the variant from the
    // argument's inferred type BEFORE emitting any
    // opcodes. Other signatures use their declared arg
    // types directly.
    if name.eq_ignore_ascii_case("ABS") {
        let (arg_ops, arg_type) = compile_expression(&args[0], symbols)?;
        let (variant, ret_type) = match arg_type {
            StValueType::Int => (F::AbsInt, StValueType::Int),
            StValueType::Real => (F::AbsReal, StValueType::Real),
            StValueType::Bool => {
                return Err(CompileError::UnaryTypeMismatch {
                    op: "ABS".to_string(),
                    operand: StValueType::Bool,
                });
            }
        };
        let mut ops = arg_ops;
        ops.push(Opcode::StdlibCall { fn_id: variant });
        return Ok((ops, ret_type));
    }

    // Non-polymorphic signature: emit each arg with
    // per-arg type validation + Int→Real promotion.
    let mut ops: Vec<Opcode> = Vec::new();
    for (i, (arg, expected)) in args.iter().zip(sig.arg_types.iter()).enumerate() {
        let (arg_ops, arg_type) = compile_expression(arg, symbols)?;
        let promoted_ops = match (expected, arg_type) {
            (StdlibArgType::Bool, StValueType::Bool) => arg_ops,
            (StdlibArgType::Int, StValueType::Int) => arg_ops,
            (StdlibArgType::Real, StValueType::Real) => arg_ops,
            (StdlibArgType::Real, StValueType::Int) => {
                let mut promoted = arg_ops;
                promoted.push(Opcode::CastIntToReal);
                promoted
            }
            (expected_t, got_t) => {
                return Err(CompileError::TypeMismatch {
                    op: format!(
                        "{}(arg {})",
                        name.to_ascii_uppercase(),
                        i + 1
                    ),
                    // Map StdlibArgType → StValueType for the
                    // error shape consumers already handle.
                    left: match expected_t {
                        StdlibArgType::Bool => StValueType::Bool,
                        StdlibArgType::Int => StValueType::Int,
                        StdlibArgType::Real => StValueType::Real,
                    },
                    right: got_t,
                });
            }
        };
        ops.extend(promoted_ops);
    }

    ops.push(Opcode::StdlibCall { fn_id: sig.fn_id });
    Ok((ops, sig.return_type))
}

fn compile_binary_op(
    left: &Expression,
    op: &BinaryOp,
    right: &Expression,
    symbols: &SymbolTable,
) -> Result<(Vec<Opcode>, InferredType), CompileError> {
    let (mut left_ops, left_type_raw) = compile_expression(left, symbols)?;
    let (mut right_ops, right_type_raw) = compile_expression(right, symbols)?;

    // IEC 61131-3 Int → Real implicit promotion for
    // mixed-arithmetic + mixed-comparison expressions
    // (Batch 153 Faz 3). Emit `CastIntToReal` on whichever
    // operand is Int when the other is Real so the VM
    // sees matching Real types on both sides.
    //
    // Bool mixed with Int or Real is a TypeMismatch
    // (Bool does not participate in numeric promotion);
    // only Int ↔ Real promote.
    let unified_type = match (left_type_raw, right_type_raw) {
        (a, b) if a == b => a,
        (StValueType::Int, StValueType::Real) => {
            // Left is Int, right is Real — promote left.
            left_ops.push(Opcode::CastIntToReal);
            StValueType::Real
        }
        (StValueType::Real, StValueType::Int) => {
            // Left is Real, right is Int — promote right.
            right_ops.push(Opcode::CastIntToReal);
            StValueType::Real
        }
        (left, right) => {
            return Err(CompileError::TypeMismatch {
                op: format!("{:?}", op),
                left,
                right,
            });
        }
    };

    left_ops.extend(right_ops);

    let (final_op, result_type) = match (op, unified_type) {
        // Arithmetic (matched types).
        (BinaryOp::Add, StValueType::Int) => (Opcode::AddInt, StValueType::Int),
        (BinaryOp::Add, StValueType::Real) => (Opcode::AddReal, StValueType::Real),
        (BinaryOp::Sub, StValueType::Int) => (Opcode::SubInt, StValueType::Int),
        (BinaryOp::Sub, StValueType::Real) => (Opcode::SubReal, StValueType::Real),
        (BinaryOp::Mul, StValueType::Int) => (Opcode::MulInt, StValueType::Int),
        (BinaryOp::Mul, StValueType::Real) => (Opcode::MulReal, StValueType::Real),
        (BinaryOp::Div, StValueType::Int) => (Opcode::DivInt, StValueType::Int),
        (BinaryOp::Div, StValueType::Real) => (Opcode::DivReal, StValueType::Real),

        // Equality works on all 3 runtime types — the
        // VM's `Eq` opcode dispatches on the runtime
        // discriminator + compares per-variant. Bool,
        // Int, Real all supported.
        (BinaryOp::Eq, StValueType::Bool)
        | (BinaryOp::Eq, StValueType::Int)
        | (BinaryOp::Eq, StValueType::Real) => (Opcode::Eq, StValueType::Bool),

        // Less-than per-type (Batch 148 didn't add LtBool
        // — Bool comparison is usually via Eq not Lt).
        (BinaryOp::Lt, StValueType::Int) => (Opcode::LtInt, StValueType::Bool),
        (BinaryOp::Lt, StValueType::Real) => (Opcode::LtReal, StValueType::Bool),

        // Logical ops (Bool only).
        (BinaryOp::And, StValueType::Bool) => (Opcode::And, StValueType::Bool),
        (BinaryOp::Or, StValueType::Bool) => (Opcode::Or, StValueType::Bool),

        // Every other (op, type) is a type error.
        (op, t) => {
            return Err(CompileError::TypeMismatch {
                op: format!("{:?}", op),
                left: t,
                right: t,
            });
        }
    };

    left_ops.push(final_op);
    Ok((left_ops, result_type))
}

// ========================================================================
// Batch 150 Faz 3 — statement compiler + program compiler
// ========================================================================
//
// Statement compilation appends opcodes to a caller-
// supplied &mut Vec<Opcode>. Forward branches (If-
// Then-Else) emit a placeholder Opcode::JumpIfFalse /
// Jump with target=0, remember the opcode index, then
// patch the target AFTER the branch body compiles +
// the true jump-to-address is known.

/// A single active loop's patch-slot context. While the
/// loop body is being compiled, `Exit` and `Continue`
/// statements emit placeholder jumps + record their slot
/// indexes here; the loop compiler patches the slots
/// once the END + CONTINUE addresses are known.
///
/// Batch 152 Faz 3 (plan R-1): introduced alongside
/// WHILE / REPEAT compilation so EXIT / CONTINUE can
/// target the enclosing loop structurally (vs relying
/// on AST-level unfolding).
#[derive(Debug, Default)]
pub struct LoopContext {
    /// `Jump { target: 0 }` placeholder slot indexes for
    /// EXIT statements — patched with loop END address
    /// when the loop compiler finishes emitting.
    pub exit_slots: Vec<usize>,
    /// `Jump { target: 0 }` placeholder slot indexes for
    /// CONTINUE statements — patched with the loop's
    /// "next iteration" address (WHILE: cond re-check
    /// start; REPEAT: UNTIL-cond start).
    pub continue_slots: Vec<usize>,
}

/// Compile a single statement — append opcodes to
/// `ops` in-place.
///
/// Batch 150 covers: Assignment (to local variable),
/// If-Then-Else(-ElsIf-Else), Return, Empty.
///
/// Batch 152 Faz 3 (plan R-1) adds: While, Repeat,
/// Exit, Continue. The `loop_stack` parameter carries
/// the enclosing-loop context so EXIT / CONTINUE
/// statements can emit placeholder jumps patched by
/// the innermost loop. An empty stack means the
/// statement is at program scope; EXIT / CONTINUE at
/// that scope are rejected as `CompileError::
/// Unsupported` with an operator-visible message.
///
/// Batch 153+ adds: For, Case, FunctionBlockCall,
/// FunctionCall (stdlib dispatch).
pub fn compile_statement(
    stmt: &Statement,
    symbols: &SymbolTable,
    ops: &mut Vec<Opcode>,
    loop_stack: &mut Vec<LoopContext>,
) -> Result<(), CompileError> {
    match stmt {
        Statement::Empty => Ok(()),

        Statement::Return { .. } => {
            ops.push(Opcode::Return);
            Ok(())
        }

        Statement::Assignment { target, value, .. } => {
            // LHS MUST be a bare Variable — array /
            // member assignment land in a later batch.
            let target_name = match target {
                Expression::Variable(name, _) => name,
                other => {
                    return Err(CompileError::Unsupported {
                        what: format!(
                            "assignment target must be a bare variable (got {:?})",
                            target_kind(other)
                        ),
                    });
                }
            };
            let target_entry = symbols
                .get(target_name)
                .ok_or_else(|| CompileError::UnknownVariable {
                    name: target_name.clone(),
                })?
                .clone();

            // Read-only check (Batch 157): locals are
            // always writable; tag entries carry
            // `writable=false` when declared read-only
            // in the ProcessImage catalog.
            if !target_entry.writable {
                return Err(CompileError::ReadOnlyTag {
                    name: target_name.clone(),
                });
            }

            // Compile RHS value expr + type-check.
            let (value_ops, value_type) = compile_expression(value, symbols)?;
            if value_type != target_entry.declared_type {
                // Int→Real promotion at assignment boundary
                // matches Batch 153 mixed-arithmetic rule.
                // Only the exact Int→Real direction is
                // implicit; other mismatches stay errors.
                if target_entry.declared_type == StValueType::Real
                    && value_type == StValueType::Int
                {
                    ops.extend(value_ops);
                    ops.push(Opcode::CastIntToReal);
                } else {
                    return Err(CompileError::TypeMismatch {
                        op: "assignment".to_string(),
                        left: target_entry.declared_type,
                        right: value_type,
                    });
                }
            } else {
                ops.extend(value_ops);
            }

            match target_entry.kind {
                SymbolKind::Local { local_index } => {
                    ops.push(Opcode::StoreLocal { index: local_index });
                }
                SymbolKind::Tag => {
                    ops.push(Opcode::WriteTag {
                        name: target_name.clone(),
                    });
                }
            }
            Ok(())
        }

        Statement::If {
            condition,
            then_body,
            elsif_branches,
            else_body,
            ..
        } => compile_if_chain(
            condition,
            then_body,
            elsif_branches,
            else_body.as_deref(),
            symbols,
            ops,
            loop_stack,
        ),

        Statement::While {
            condition, body, ..
        } => compile_while(condition, body, symbols, ops, loop_stack),

        Statement::Repeat {
            body, condition, ..
        } => compile_repeat(body, condition, symbols, ops, loop_stack),

        Statement::Exit { .. } => match loop_stack.last_mut() {
            Some(ctx) => {
                let slot = emit_placeholder_jump(ops);
                ctx.exit_slots.push(slot);
                Ok(())
            }
            None => Err(CompileError::Unsupported {
                what: "EXIT outside of a loop".to_string(),
            }),
        },

        Statement::Continue { .. } => match loop_stack.last_mut() {
            Some(ctx) => {
                let slot = emit_placeholder_jump(ops);
                ctx.continue_slots.push(slot);
                Ok(())
            }
            None => Err(CompileError::Unsupported {
                what: "CONTINUE outside of a loop".to_string(),
            }),
        },

        // Future-batch scope — explicit batch trace so
        // the operator-visible error cites where the
        // construct will land.
        Statement::For {
            variable,
            from,
            to,
            by,
            body,
            ..
        } => compile_for(
            variable, from, to, by.as_ref(), body, symbols, ops, loop_stack,
        ),
        Statement::Case {
            expr,
            branches,
            else_body,
            ..
        } => compile_case(
            expr,
            branches,
            else_body.as_deref(),
            symbols,
            ops,
            loop_stack,
        ),
        Statement::FunctionBlockCall { fb_name, assignments, .. } => {
            // Batch 181 Faz 3: compile the IEC 61131-3
            // `fb_instance(IN1 := expr1, IN2 := expr2);`
            // syntax to a sequence of argument-push
            // opcodes followed by one `FbCall` opcode
            // that carries the input-pin name list.
            //
            // Argument order on the stack matches the
            // assignments' order in the AST (left-to-
            // right). VM pops in reverse so the first
            // pop is the LAST argument; the VM's FbCall
            // handler reverses to match the
            // `input_names` vector.
            let mut input_names: Vec<String> =
                Vec::with_capacity(assignments.len());
            for (input_name, value_expr) in assignments {
                let (value_ops, value_type) =
                    compile_expression(value_expr, symbols)?;

                // Batch 183: compile-time type check
                // against the registered pin type when
                // available. Matches the assignment-
                // boundary promotion rule: Int→Real
                // promotion emits CastIntToReal; other
                // mismatches yield TypeMismatch.
                // Unregistered FBs skip the check +
                // rely on the runtime `FbIoError::
                // TypeMismatch` (Batch 180).
                let promoted_ops = match symbols.fb_input_type(fb_name, input_name) {
                    Some(expected) if expected == value_type => value_ops,
                    Some(expected)
                        if expected == StValueType::Real
                            && value_type == StValueType::Int =>
                    {
                        let mut promoted = value_ops;
                        promoted.push(Opcode::CastIntToReal);
                        promoted
                    }
                    Some(expected) => {
                        return Err(CompileError::TypeMismatch {
                            op: format!(
                                "fb-input `{}.{}`",
                                fb_name, input_name
                            ),
                            left: expected,
                            right: value_type,
                        });
                    }
                    None => value_ops,
                };
                ops.extend(promoted_ops);
                input_names.push(input_name.clone());
            }
            ops.push(Opcode::FbCall {
                fb_id: fb_name.clone(),
                input_names,
            });
            Ok(())
        }
        Statement::FunctionCall { name, args, .. } => {
            // Statement-level call: compile as expression
            // then discard the result. IEC 61131-3
            // permits calling a stdlib function for its
            // side-effect-free numeric computation then
            // throwing the result away (CODESYS / TwinCAT
            // tolerate this shape). Batch 155 Faz 3 wires
            // the expression compiler + appends a Pop so
            // the stack stays balanced.
            let (call_ops, _ret_type) =
                compile_stdlib_function_call(name, args, symbols)?;
            ops.extend(call_ops);
            ops.push(Opcode::Pop);
            Ok(())
        }
    }
}

/// Compile `WHILE cond DO body END_WHILE`.
///
/// Emitted shape:
/// ```text
/// LOOP_START:
///   <compile cond>
///   JumpIfFalse END
///   <compile body>     (Exit → Jump END; Continue → Jump LOOP_START)
///   Jump LOOP_START
/// END:
/// ```
///
/// CONTINUE targets LOOP_START (the cond re-check) per
/// IEC 61131-3 — "proceed to next iteration" = re-evaluate
/// the loop condition.
fn compile_while(
    condition: &Expression,
    body: &[Statement],
    symbols: &SymbolTable,
    ops: &mut Vec<Opcode>,
    loop_stack: &mut Vec<LoopContext>,
) -> Result<(), CompileError> {
    let loop_start = ops.len() as u32;

    // Condition → expect Bool.
    let (cond_ops, cond_type) = compile_expression(condition, symbols)?;
    if cond_type != StValueType::Bool {
        return Err(CompileError::TypeMismatch {
            op: "while-condition".to_string(),
            left: StValueType::Bool,
            right: cond_type,
        });
    }
    ops.extend(cond_ops);

    // On false, branch to loop END (patched after body).
    let exit_cond_slot = emit_placeholder_jump_if_false(ops);

    // Push loop context BEFORE compiling body so nested
    // EXIT / CONTINUE target this loop.
    loop_stack.push(LoopContext::default());

    for s in body {
        compile_statement(s, symbols, ops, loop_stack)?;
    }

    // Unconditional jump back to LOOP_START (re-check
    // cond).
    ops.push(Opcode::Jump { target: loop_start });

    // Loop ended — pop the context + patch EXIT/CONTINUE
    // + patch the cond-false JumpIfFalse.
    let ctx = loop_stack
        .pop()
        .expect("compile_while: loop_stack push/pop mismatch");
    let loop_end = ops.len() as u32;

    patch_jump_if_false(ops, exit_cond_slot, loop_end);
    for slot in ctx.exit_slots {
        patch_jump(ops, slot, loop_end);
    }
    // CONTINUE in WHILE targets LOOP_START so the
    // condition is re-evaluated next iteration.
    for slot in ctx.continue_slots {
        patch_jump(ops, slot, loop_start);
    }

    Ok(())
}

/// Compile `REPEAT body UNTIL cond END_REPEAT`.
///
/// Emitted shape:
/// ```text
/// LOOP_START:
///   <compile body>       (Exit → Jump END; Continue → Jump COND_CHECK)
/// COND_CHECK:
///   <compile cond>
///   JumpIfFalse LOOP_START    (loop while UNTIL-cond is false)
/// END:
/// ```
///
/// IEC 61131-3 semantic: REPEAT body executes at least
/// once; UNTIL-cond false means "keep looping"; true
/// means "exit loop". CONTINUE targets COND_CHECK so the
/// UNTIL-cond is evaluated before deciding to re-enter
/// the body.
fn compile_repeat(
    body: &[Statement],
    condition: &Expression,
    symbols: &SymbolTable,
    ops: &mut Vec<Opcode>,
    loop_stack: &mut Vec<LoopContext>,
) -> Result<(), CompileError> {
    let loop_start = ops.len() as u32;

    // Push loop context BEFORE compiling body so nested
    // EXIT / CONTINUE target this loop.
    loop_stack.push(LoopContext::default());

    for s in body {
        compile_statement(s, symbols, ops, loop_stack)?;
    }

    // COND_CHECK — where CONTINUE lands.
    let cond_check = ops.len() as u32;

    let (cond_ops, cond_type) = compile_expression(condition, symbols)?;
    if cond_type != StValueType::Bool {
        return Err(CompileError::TypeMismatch {
            op: "repeat-until-condition".to_string(),
            left: StValueType::Bool,
            right: cond_type,
        });
    }
    ops.extend(cond_ops);
    // UNTIL-cond false → back to LOOP_START (keep
    // looping). UNTIL-cond true → fall through to END.
    ops.push(Opcode::JumpIfFalse { target: loop_start });

    let ctx = loop_stack
        .pop()
        .expect("compile_repeat: loop_stack push/pop mismatch");
    let loop_end = ops.len() as u32;

    for slot in ctx.exit_slots {
        patch_jump(ops, slot, loop_end);
    }
    for slot in ctx.continue_slots {
        patch_jump(ops, slot, cond_check);
    }

    Ok(())
}

/// Compile `FOR i := from TO to DO body END_FOR`
/// (Batch 162 Faz 3 / plan R-1).
///
/// Emitted shape:
/// ```text
///   <from expr>; StoreLocal(i)          // i := from
/// LOOP_START:
///   <to expr>; LoadLocal(i); LtInt; Not  // i <= to  (= !(to < i))
///   JumpIfFalse END
///   <body>                               // Exit→END, Continue→INCR
/// INCR:
///   LoadLocal(i); PushConst(1); AddInt; StoreLocal(i)  // i += 1
///   Jump LOOP_START
/// END:
/// ```
///
/// The `to` expression is re-evaluated each iteration —
/// the compiler doesn't allocate a hidden local for it
/// in Batch 162. For IntLiteral + Variable expressions
/// (the overwhelming common case) this is semantically
/// identical to the strict IEC 61131-3 evaluate-once
/// rule because both are idempotent. Non-idempotent
/// `to` expressions (any stdlib call, once those can
/// have side effects) will run once per iteration; a
/// future batch introduces hidden-local allocation for
/// strict spec compliance.
///
/// Step (BY) clause: Batch 162 only accepts `by=None`
/// (implicit step=1). Non-trivial step values require
/// negative-step detection + altered comparison
/// direction + a hidden local for the step value —
/// all batch-163 territory.
///
/// The loop variable MUST resolve to a declared Int
/// local. FOR against a tag or a Real local is
/// rejected as `CompileError::TypeMismatch`.
fn compile_for(
    variable: &str,
    from: &Expression,
    to: &Expression,
    by: Option<&Expression>,
    body: &[Statement],
    symbols: &SymbolTable,
    ops: &mut Vec<Opcode>,
    loop_stack: &mut Vec<LoopContext>,
) -> Result<(), CompileError> {
    // BY clause gate.
    if by.is_some() {
        return Err(CompileError::Unsupported {
            what: "FOR … BY clause (batch 163 adds step semantics)"
                .to_string(),
        });
    }

    // Loop variable MUST be a declared Int local.
    let loop_var_entry = symbols.get(variable).ok_or_else(|| {
        CompileError::UnknownVariable {
            name: variable.to_string(),
        }
    })?;
    if loop_var_entry.declared_type != StValueType::Int {
        return Err(CompileError::TypeMismatch {
            op: "for-loop-variable".to_string(),
            left: StValueType::Int,
            right: loop_var_entry.declared_type,
        });
    }
    let loop_var_local_index = match loop_var_entry.kind {
        SymbolKind::Local { local_index } => local_index,
        SymbolKind::Tag => {
            return Err(CompileError::Unsupported {
                what: format!(
                    "FOR loop variable `{}` must be a local — tag targets are not supported",
                    variable
                ),
            });
        }
    };

    // Step 1: i := from.
    let (from_ops, from_type) = compile_expression(from, symbols)?;
    if from_type != StValueType::Int {
        return Err(CompileError::TypeMismatch {
            op: "for-from-expression".to_string(),
            left: StValueType::Int,
            right: from_type,
        });
    }
    ops.extend(from_ops);
    ops.push(Opcode::StoreLocal {
        index: loop_var_local_index,
    });

    let loop_start = ops.len() as u32;

    // Condition: i <= to  (compiled as `!(to < i)` so
    // the existing LtInt opcode suffices without adding
    // a LeInt primitive).
    let (to_ops, to_type) = compile_expression(to, symbols)?;
    if to_type != StValueType::Int {
        return Err(CompileError::TypeMismatch {
            op: "for-to-expression".to_string(),
            left: StValueType::Int,
            right: to_type,
        });
    }
    ops.extend(to_ops);
    ops.push(Opcode::LoadLocal {
        index: loop_var_local_index,
    });
    ops.push(Opcode::LtInt); // (to < i)
    ops.push(Opcode::Not); // !(to < i)  ==  i <= to
    let exit_cond_slot = emit_placeholder_jump_if_false(ops);

    // Push loop context BEFORE body compilation so
    // nested EXIT / CONTINUE resolve against this loop.
    loop_stack.push(LoopContext::default());

    for s in body {
        compile_statement(s, symbols, ops, loop_stack)?;
    }

    // INCR — where CONTINUE lands (next-iteration step).
    let incr_start = ops.len() as u32;
    ops.push(Opcode::LoadLocal {
        index: loop_var_local_index,
    });
    ops.push(Opcode::PushConst {
        value: StValue::Int(1),
    });
    ops.push(Opcode::AddInt);
    ops.push(Opcode::StoreLocal {
        index: loop_var_local_index,
    });
    ops.push(Opcode::Jump { target: loop_start });

    let ctx = loop_stack
        .pop()
        .expect("compile_for: loop_stack push/pop mismatch");
    let loop_end = ops.len() as u32;

    patch_jump_if_false(ops, exit_cond_slot, loop_end);
    for slot in ctx.exit_slots {
        patch_jump(ops, slot, loop_end);
    }
    for slot in ctx.continue_slots {
        patch_jump(ops, slot, incr_start);
    }

    Ok(())
}

/// Compile `CASE expr OF value1, value2: stmts; … ELSE
/// default END_CASE` (Batch 174 Faz 3 / plan R-1).
///
/// Emitted shape (for N branches, each with M_i match
/// values):
/// ```text
///   <compile expr>                // stack: [selector: Int]
///   // Branch 1 match chain:
///   Dup; PushConst v1; Eq; JumpIfFalse skip_v1
///   Pop; Jump body_1
/// skip_v1:
///   Dup; PushConst v2; Eq; JumpIfFalse skip_v2
///   Pop; Jump body_1
///   ...
/// skip_last_of_branch_1:
///   // Branch 2 match chain:
///   ...
/// no_match:
///   Pop                           // drop selector
///   <else_body>                   // optional
///   Jump end
/// body_1:
///   <branch_1 statements>
///   Jump end
/// body_2:
///   ...
/// end:
/// ```
///
/// Batch 174 scope:
/// - Selector expression MUST infer to Int (Bool/Real
///   selectors land in a future batch when the Eq
///   opcode gets per-type variants alongside the
///   existing cross-type behavior).
/// - Match values MUST be IntLiteral — range syntax
///   (`1..10`) + non-literal match expressions defer
///   to a future batch when hidden-local allocation
///   lets us keep the selector cached without stack
///   acrobatics.
///
/// CASE in the aquaculture control domain is
/// predominantly small state-machine discrimination
/// (e.g. `CASE pump_state OF 0: idle; 1: priming;
/// 2: running; END_CASE`) which this int-literal
/// subset covers.
fn compile_case(
    expr: &Expression,
    branches: &[(Vec<Expression>, Vec<Statement>)],
    else_body: Option<&[Statement]>,
    symbols: &SymbolTable,
    ops: &mut Vec<Opcode>,
    loop_stack: &mut Vec<LoopContext>,
) -> Result<(), CompileError> {
    // Compile selector + type-gate Int-only.
    let (selector_ops, selector_type) = compile_expression(expr, symbols)?;
    if selector_type != StValueType::Int {
        return Err(CompileError::TypeMismatch {
            op: "case-selector".to_string(),
            left: StValueType::Int,
            right: selector_type,
        });
    }
    ops.extend(selector_ops);

    // For each branch, generate match-chain that
    // collects the "goto body" slots. We emit the
    // match-chains first, then the no-match branch
    // (else or fall-through), then each body.
    //
    // Branch body emission follows the match-chain
    // emission because body entry addresses aren't
    // known until the chain closes.
    //
    // Strategy: emit match-chain-to-placeholder-body-jumps,
    // record (branch_index, jump_slot) for each, then
    // at the end patch each jump to the actual body
    // entry point.
    let mut body_jump_slots: Vec<(usize, usize)> = Vec::new(); // (branch_idx, slot)
    for (branch_idx, (match_values, _body)) in branches.iter().enumerate() {
        if match_values.is_empty() {
            return Err(CompileError::Unsupported {
                what: format!(
                    "CASE branch {} has no match values",
                    branch_idx
                ),
            });
        }
        for match_expr in match_values {
            let match_value = match match_expr {
                Expression::IntLiteral(n) => *n,
                other => {
                    return Err(CompileError::Unsupported {
                        what: format!(
                            "CASE match value must be IntLiteral (got {:?}) — batch 175 adds range + Variable matches",
                            target_kind(other)
                        ),
                    });
                }
            };

            // Dup + PushConst + Eq + JumpIfFalse skip.
            ops.push(Opcode::Dup);
            ops.push(Opcode::PushConst {
                value: StValue::Int(match_value),
            });
            ops.push(Opcode::Eq);
            let skip_slot = emit_placeholder_jump_if_false(ops);

            // Matched → Pop selector + Jump to body.
            ops.push(Opcode::Pop);
            let body_jump_slot = emit_placeholder_jump(ops);
            body_jump_slots.push((branch_idx, body_jump_slot));

            // Patch the skip-on-no-match: continue to
            // next match value OR next branch's chain.
            let after_skip_idx = ops.len() as u32;
            patch_jump_if_false(ops, skip_slot, after_skip_idx);
        }
    }

    // No match chain fell through here — still have
    // selector on stack. Pop it + run else_body (if
    // any) + fall through to end.
    ops.push(Opcode::Pop);
    if let Some(else_body) = else_body {
        for s in else_body {
            compile_statement(s, symbols, ops, loop_stack)?;
        }
    }

    // After else (or if no else), jump over all bodies
    // to the end.
    let mut end_jump_slots: Vec<usize> = Vec::new();
    end_jump_slots.push(emit_placeholder_jump(ops));

    // Body blocks.
    let mut branch_starts: Vec<u32> = vec![0u32; branches.len()];
    for (branch_idx, (_match_values, body)) in branches.iter().enumerate() {
        branch_starts[branch_idx] = ops.len() as u32;
        for s in body {
            compile_statement(s, symbols, ops, loop_stack)?;
        }
        // Each body ends with Jump to end (patched below).
        end_jump_slots.push(emit_placeholder_jump(ops));
    }

    // Patch all body-jump slots to point at their
    // branch's start.
    for (branch_idx, slot) in body_jump_slots {
        let target = branch_starts[branch_idx];
        patch_jump(ops, slot, target);
    }

    // Patch end jumps.
    let end_idx = ops.len() as u32;
    for slot in end_jump_slots {
        patch_jump(ops, slot, end_idx);
    }

    Ok(())
}

/// Descriptive label for an unsupported assignment
/// target. Kept out of CompileError to avoid bloating
/// the error enum with one-off string variants.
fn target_kind(expr: &Expression) -> &'static str {
    match expr {
        Expression::Variable(..) => "variable",
        Expression::ArrayAccess { .. } => "array-access",
        Expression::MemberAccess { .. } => "member-access",
        Expression::IntLiteral(_) => "int-literal",
        Expression::RealLiteral(_) => "real-literal",
        Expression::BoolLiteral(_) => "bool-literal",
        Expression::StringLiteral(_) => "string-literal",
        Expression::TimeLiteral(_) => "time-literal",
        Expression::UnaryOp { .. } => "unary-op",
        Expression::BinaryOp { .. } => "binary-op",
        Expression::FunctionCall { .. } => "function-call",
        Expression::Parenthesized(_) => "parenthesized",
    }
}

/// Compile an IF (+ ELSIF* + ELSE?) chain.
///
/// Emitted shape for `IF cond THEN then_body ELSIF
/// elsif_cond THEN elsif_body ELSE else_body END_IF`:
/// ```text
///   <compile cond>
///   JumpIfFalse to ELSIF_START
///   <compile then_body>
///   Jump to END
/// ELSIF_START:
///   <compile elsif_cond>
///   JumpIfFalse to ELSE_START
///   <compile elsif_body>
///   Jump to END
/// ELSE_START:
///   <compile else_body>
/// END:
/// ```
///
/// Each `Jump` / `JumpIfFalse` target is patched in
/// after the body compiles + the absolute address is
/// known.
fn compile_if_chain(
    condition: &Expression,
    then_body: &[Statement],
    elsif_branches: &[(Expression, Vec<Statement>)],
    else_body: Option<&[Statement]>,
    symbols: &SymbolTable,
    ops: &mut Vec<Opcode>,
    loop_stack: &mut Vec<LoopContext>,
) -> Result<(), CompileError> {
    // Compile the primary condition + branch around
    // the then body.
    let (cond_ops, cond_type) = compile_expression(condition, symbols)?;
    if cond_type != StValueType::Bool {
        return Err(CompileError::TypeMismatch {
            op: "if-condition".to_string(),
            left: StValueType::Bool,
            right: cond_type,
        });
    }
    ops.extend(cond_ops);
    let then_jump_slot = emit_placeholder_jump_if_false(ops);

    // Then body.
    for s in then_body {
        compile_statement(s, symbols, ops, loop_stack)?;
    }
    // After then-body, jump to END (unless there's no
    // else / elsif — in which case the JumpIfFalse
    // target is END + we skip this unconditional
    // jump). We always emit the Jump for uniform
    // branch structure + patch later.
    let mut end_jump_slots: Vec<usize> = Vec::new();
    let has_elsif_or_else = !elsif_branches.is_empty() || else_body.is_some();
    if has_elsif_or_else {
        end_jump_slots.push(emit_placeholder_jump(ops));
    }

    // Patch the then-jump: on false, branch here (start
    // of elsif / else / end).
    let after_then_idx = ops.len() as u32;
    patch_jump_if_false(ops, then_jump_slot, after_then_idx);

    // Each ELSIF branch.
    for (elsif_cond, elsif_body) in elsif_branches {
        let (cond_ops, cond_type) = compile_expression(elsif_cond, symbols)?;
        if cond_type != StValueType::Bool {
            return Err(CompileError::TypeMismatch {
                op: "elsif-condition".to_string(),
                left: StValueType::Bool,
                right: cond_type,
            });
        }
        ops.extend(cond_ops);
        let elsif_jump_slot = emit_placeholder_jump_if_false(ops);

        for s in elsif_body {
            compile_statement(s, symbols, ops, loop_stack)?;
        }
        end_jump_slots.push(emit_placeholder_jump(ops));

        let after_elsif_idx = ops.len() as u32;
        patch_jump_if_false(ops, elsif_jump_slot, after_elsif_idx);
    }

    // ELSE branch (optional).
    if let Some(else_body) = else_body {
        for s in else_body {
            compile_statement(s, symbols, ops, loop_stack)?;
        }
    }

    // Patch all end-jumps to point at here.
    let end_idx = ops.len() as u32;
    for slot in end_jump_slots {
        patch_jump(ops, slot, end_idx);
    }
    Ok(())
}

fn emit_placeholder_jump(ops: &mut Vec<Opcode>) -> usize {
    let idx = ops.len();
    ops.push(Opcode::Jump { target: 0 });
    idx
}

fn emit_placeholder_jump_if_false(ops: &mut Vec<Opcode>) -> usize {
    let idx = ops.len();
    ops.push(Opcode::JumpIfFalse { target: 0 });
    idx
}

fn patch_jump(ops: &mut [Opcode], at: usize, target: u32) {
    if let Some(Opcode::Jump { target: t }) = ops.get_mut(at) {
        *t = target;
    } else {
        // Internal invariant violation — only the compiler
        // edits these slots. Panic rather than silently
        // skipping; tests catch any future refactor bug.
        panic!(
            "patch_jump: slot {} is not a Jump placeholder (got {:?})",
            at,
            ops.get(at)
        );
    }
}

fn patch_jump_if_false(ops: &mut [Opcode], at: usize, target: u32) {
    if let Some(Opcode::JumpIfFalse { target: t }) = ops.get_mut(at) {
        *t = target;
    } else {
        panic!(
            "patch_jump_if_false: slot {} is not a JumpIfFalse placeholder (got {:?})",
            at,
            ops.get(at)
        );
    }
}

/// Build a symbol table + compile a Program body +
/// wrap the result in a Bytecode struct.
///
/// Batch 157 Faz 3 adds tag support: the compiler now
/// accepts a `tags: &[TagDescriptor]` slice from the
/// ProcessImage catalog; tag references in ST source
/// compile to LoadTag / WriteTag opcodes with type +
/// writability validation. The output Bytecode's
/// `allowed_write_tags` is populated from the set of
/// tags the program actually writes — so the Batch 156
/// runtime gate enforces exactly the declared write
/// surface.
///
/// `program_id` + `max_gas_per_tick` are caller-
/// supplied — these are operator-facing identifiers
/// not encoded in the AST itself.
///
/// Symbol shadowing: if a VAR-declared local shares a
/// name with a tag, the local wins (matches IEC 61131-3
/// scope rule). The compiler walks var_blocks last so
/// the local insert overwrites the tag in the symbol
/// table. Operators who want unambiguous references
/// should avoid the clash.
pub fn compile_program(
    program: &crate::st_validator::Program,
    tags: &[TagDescriptor],
    program_id: String,
    max_gas_per_tick: u32,
) -> Result<Bytecode, CompileError> {
    let mut symbols = SymbolTable::new();
    let mut local_count: u32 = 0;
    let mut retain_vars: Vec<(String, u32, StValueType)> = Vec::new();

    // Insert tags FIRST so VAR-declared locals override
    // any name clash (local wins per IEC scope rule).
    for tag in tags {
        symbols.insert(
            tag.name.clone(),
            SymbolEntry::tag(tag.data_type, tag.writable),
        );
    }

    for block in &program.var_blocks {
        for decl in &block.declarations {
            let st_type = data_type_to_st_type(&decl.data_type).ok_or_else(|| {
                CompileError::Unsupported {
                    what: format!(
                        "variable `{}` of type {:?} — only BOOL/INT/REAL supported at Batch 150",
                        decl.name, decl.data_type
                    ),
                }
            })?;
            symbols.insert(
                decl.name.clone(),
                SymbolEntry::local(local_count, st_type),
            );
            if block.retain {
                // Batch 175: record the local_index
                // BEFORE incrementing so the VM can
                // restore the RETAIN value into the
                // exact slot the compiler assigned.
                retain_vars.push((decl.name.clone(), local_count, st_type));
            }
            local_count += 1;
        }
    }

    let mut opcodes: Vec<Opcode> = Vec::new();
    let mut loop_stack: Vec<LoopContext> = Vec::new();
    for stmt in &program.body {
        compile_statement(stmt, &symbols, &mut opcodes, &mut loop_stack)?;
    }
    // Defense-in-depth: loop push/pop balanced at exit.
    // Non-empty here signals an internal compiler bug.
    debug_assert!(
        loop_stack.is_empty(),
        "compile_program: loop_stack left non-empty ({} contexts)",
        loop_stack.len()
    );
    // Every program ends with a Return so the VM exits
    // cleanly even if the AST body doesn't terminate
    // with an explicit RETURN.
    opcodes.push(Opcode::Return);

    // Derive `allowed_write_tags` from the emitted
    // opcodes: every WriteTag name is a declared write
    // surface; the Batch 156 runtime gate rejects any
    // name not in this list, so the derivation is the
    // source-of-truth binding.
    let mut allowed_write_tags: Vec<String> = opcodes
        .iter()
        .filter_map(|op| match op {
            Opcode::WriteTag { name } => Some(name.clone()),
            _ => None,
        })
        .collect();
    allowed_write_tags.sort();
    allowed_write_tags.dedup();

    Ok(Bytecode {
        program_id,
        program_name: program.name.clone(),
        tenant_id: None,
        policy_version: 0,
        max_gas_per_tick,
        local_count,
        retain_vars,
        allowed_write_tags,
        safe_state_pinned_tags: Vec::new(),
        opcodes,
    })
}

/// Map IEC 61131-3 DataType → narrow runtime StValueType.
///
/// Batch 150 supports only the scalar 3-type subset
/// that matches Batch 148 StValue variants. Array +
/// String + Time + user-defined types → None (caller
/// surfaces as Unsupported).
fn data_type_to_st_type(dt: &DataType) -> Option<StValueType> {
    match dt {
        DataType::Bool => Some(StValueType::Bool),
        DataType::Sint
        | DataType::Int
        | DataType::Dint
        | DataType::Lint
        | DataType::Usint
        | DataType::Uint
        | DataType::Udint
        | DataType::Ulint
        | DataType::Byte
        | DataType::Word
        | DataType::Dword
        | DataType::Lword => Some(StValueType::Int),
        DataType::Real | DataType::Lreal => Some(StValueType::Real),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sym(name: &str, idx: u32, ty: StValueType) -> (String, SymbolEntry) {
        (name.into(), SymbolEntry::local(idx, ty))
    }

    /// Batch 157 helper: construct a tag-kind symbol
    /// entry for read/write compiler tests.
    fn sym_tag(
        name: &str,
        ty: StValueType,
        writable: bool,
    ) -> (String, SymbolEntry) {
        (name.into(), SymbolEntry::tag(ty, writable))
    }

    fn build_symbols(entries: Vec<(String, SymbolEntry)>) -> SymbolTable {
        let mut t = SymbolTable::new();
        for (n, e) in entries {
            t.insert(n, e);
        }
        t
    }

    // ====================================================================
    // Literal compilation
    // ====================================================================

    #[test]
    fn compile_int_literal_emits_push_const_int() {
        let (ops, t) =
            compile_expression(&Expression::IntLiteral(42), &SymbolTable::new())
                .expect("ok");
        assert_eq!(t, StValueType::Int);
        assert_eq!(
            ops,
            vec![Opcode::PushConst {
                value: StValue::Int(42)
            }]
        );
    }

    #[test]
    fn compile_real_literal_emits_push_const_real() {
        let (ops, t) =
            compile_expression(&Expression::RealLiteral(3.14), &SymbolTable::new())
                .expect("ok");
        assert_eq!(t, StValueType::Real);
        assert_eq!(ops.len(), 1);
        assert!(matches!(ops[0], Opcode::PushConst { value: StValue::Real(_) }));
    }

    #[test]
    fn compile_bool_literal_emits_push_const_bool() {
        let (ops, t) = compile_expression(
            &Expression::BoolLiteral(true),
            &SymbolTable::new(),
        )
        .expect("ok");
        assert_eq!(t, StValueType::Bool);
        assert_eq!(
            ops,
            vec![Opcode::PushConst {
                value: StValue::Bool(true)
            }]
        );
    }

    // ====================================================================
    // Variable resolution
    // ====================================================================

    #[test]
    fn compile_variable_resolves_symbol_and_emits_load_local() {
        let syms = build_symbols(vec![sym("x", 5, StValueType::Int)]);
        let (ops, t) = compile_expression(
            &Expression::Variable("x".into(), None),
            &syms,
        )
        .expect("ok");
        assert_eq!(t, StValueType::Int);
        assert_eq!(ops, vec![Opcode::LoadLocal { index: 5 }]);
    }

    #[test]
    fn compile_variable_unknown_name_errors() {
        let err = compile_expression(
            &Expression::Variable("missing".into(), None),
            &SymbolTable::new(),
        )
        .expect_err("unknown var");
        assert!(matches!(err, CompileError::UnknownVariable { .. }));
    }

    // ====================================================================
    // Unary ops
    // ====================================================================

    #[test]
    fn compile_neg_int_emits_neg_int() {
        let (ops, t) = compile_expression(
            &Expression::UnaryOp {
                op: UnaryOp::Neg,
                operand: Box::new(Expression::IntLiteral(7)),
            },
            &SymbolTable::new(),
        )
        .expect("ok");
        assert_eq!(t, StValueType::Int);
        assert_eq!(ops.last(), Some(&Opcode::NegInt));
    }

    #[test]
    fn compile_neg_real_emits_neg_real() {
        let (ops, t) = compile_expression(
            &Expression::UnaryOp {
                op: UnaryOp::Neg,
                operand: Box::new(Expression::RealLiteral(1.5)),
            },
            &SymbolTable::new(),
        )
        .expect("ok");
        assert_eq!(t, StValueType::Real);
        assert_eq!(ops.last(), Some(&Opcode::NegReal));
    }

    #[test]
    fn compile_not_on_bool_emits_not() {
        let (ops, t) = compile_expression(
            &Expression::UnaryOp {
                op: UnaryOp::Not,
                operand: Box::new(Expression::BoolLiteral(true)),
            },
            &SymbolTable::new(),
        )
        .expect("ok");
        assert_eq!(t, StValueType::Bool);
        assert_eq!(ops.last(), Some(&Opcode::Not));
    }

    #[test]
    fn compile_not_on_int_rejects() {
        let err = compile_expression(
            &Expression::UnaryOp {
                op: UnaryOp::Not,
                operand: Box::new(Expression::IntLiteral(1)),
            },
            &SymbolTable::new(),
        )
        .expect_err("type mismatch");
        assert!(matches!(err, CompileError::UnaryTypeMismatch { .. }));
    }

    // ====================================================================
    // Binary ops — arithmetic
    // ====================================================================

    #[test]
    fn compile_int_add_produces_push_push_add_int() {
        let (ops, t) = compile_expression(
            &Expression::BinaryOp {
                left: Box::new(Expression::IntLiteral(2)),
                op: BinaryOp::Add,
                right: Box::new(Expression::IntLiteral(3)),
            },
            &SymbolTable::new(),
        )
        .expect("ok");
        assert_eq!(t, StValueType::Int);
        assert_eq!(
            ops,
            vec![
                Opcode::PushConst { value: StValue::Int(2) },
                Opcode::PushConst { value: StValue::Int(3) },
                Opcode::AddInt,
            ]
        );
    }

    #[test]
    fn compile_real_mul_produces_push_push_mul_real() {
        let (ops, t) = compile_expression(
            &Expression::BinaryOp {
                left: Box::new(Expression::RealLiteral(2.0)),
                op: BinaryOp::Mul,
                right: Box::new(Expression::RealLiteral(3.5)),
            },
            &SymbolTable::new(),
        )
        .expect("ok");
        assert_eq!(t, StValueType::Real);
        assert_eq!(ops.last(), Some(&Opcode::MulReal));
    }

    #[test]
    fn compile_int_plus_real_promotes_int_side() {
        // Batch 153 Faz 3: Int + Real emits
        // CastIntToReal on the Int operand.
        // 2 (Int) + 3.5 (Real) compiles to:
        //   PushConst{Int(2)}, CastIntToReal,
        //   PushConst{Real(3.5)}, AddReal
        let (ops, t) = compile_expression(
            &Expression::BinaryOp {
                left: Box::new(Expression::IntLiteral(2)),
                op: BinaryOp::Add,
                right: Box::new(Expression::RealLiteral(3.5)),
            },
            &SymbolTable::new(),
        )
        .expect("ok");
        assert_eq!(t, StValueType::Real);
        assert_eq!(
            ops,
            vec![
                Opcode::PushConst { value: StValue::Int(2) },
                Opcode::CastIntToReal,
                Opcode::PushConst { value: StValue::Real(3.5) },
                Opcode::AddReal,
            ]
        );
    }

    #[test]
    fn compile_real_plus_int_promotes_int_side() {
        // 3.5 (Real) + 2 (Int) compiles to:
        //   PushConst{Real(3.5)}, PushConst{Int(2)},
        //   CastIntToReal, AddReal
        let (ops, t) = compile_expression(
            &Expression::BinaryOp {
                left: Box::new(Expression::RealLiteral(3.5)),
                op: BinaryOp::Add,
                right: Box::new(Expression::IntLiteral(2)),
            },
            &SymbolTable::new(),
        )
        .expect("ok");
        assert_eq!(t, StValueType::Real);
        assert_eq!(
            ops,
            vec![
                Opcode::PushConst { value: StValue::Real(3.5) },
                Opcode::PushConst { value: StValue::Int(2) },
                Opcode::CastIntToReal,
                Opcode::AddReal,
            ]
        );
    }

    #[test]
    fn compile_int_lt_real_promotes_int_side() {
        // 2 (Int) < 3.5 (Real) compiles to:
        //   PushConst{Int(2)}, CastIntToReal,
        //   PushConst{Real(3.5)}, LtReal → Bool.
        let (ops, t) = compile_expression(
            &Expression::BinaryOp {
                left: Box::new(Expression::IntLiteral(2)),
                op: BinaryOp::Lt,
                right: Box::new(Expression::RealLiteral(3.5)),
            },
            &SymbolTable::new(),
        )
        .expect("ok");
        assert_eq!(t, StValueType::Bool);
        assert_eq!(ops.last(), Some(&Opcode::LtReal));
        assert!(ops.contains(&Opcode::CastIntToReal));
    }

    #[test]
    fn compile_bool_plus_int_still_rejects() {
        // Bool ↔ Int is NOT a valid promotion per
        // Batch 153 — only Int ↔ Real promotes.
        let err = compile_expression(
            &Expression::BinaryOp {
                left: Box::new(Expression::BoolLiteral(true)),
                op: BinaryOp::Add,
                right: Box::new(Expression::IntLiteral(2)),
            },
            &SymbolTable::new(),
        )
        .expect_err("mismatch");
        assert!(matches!(err, CompileError::TypeMismatch { .. }));
    }

    // ====================================================================
    // Binary ops — comparison
    // ====================================================================

    #[test]
    fn compile_int_eq_result_is_bool() {
        let (ops, t) = compile_expression(
            &Expression::BinaryOp {
                left: Box::new(Expression::IntLiteral(1)),
                op: BinaryOp::Eq,
                right: Box::new(Expression::IntLiteral(2)),
            },
            &SymbolTable::new(),
        )
        .expect("ok");
        assert_eq!(t, StValueType::Bool);
        assert_eq!(ops.last(), Some(&Opcode::Eq));
    }

    #[test]
    fn compile_real_lt_emits_lt_real() {
        let (ops, t) = compile_expression(
            &Expression::BinaryOp {
                left: Box::new(Expression::RealLiteral(1.0)),
                op: BinaryOp::Lt,
                right: Box::new(Expression::RealLiteral(2.0)),
            },
            &SymbolTable::new(),
        )
        .expect("ok");
        assert_eq!(t, StValueType::Bool);
        assert_eq!(ops.last(), Some(&Opcode::LtReal));
    }

    // ====================================================================
    // Binary ops — logical
    // ====================================================================

    #[test]
    fn compile_bool_and_emits_and() {
        let (ops, t) = compile_expression(
            &Expression::BinaryOp {
                left: Box::new(Expression::BoolLiteral(true)),
                op: BinaryOp::And,
                right: Box::new(Expression::BoolLiteral(false)),
            },
            &SymbolTable::new(),
        )
        .expect("ok");
        assert_eq!(t, StValueType::Bool);
        assert_eq!(ops.last(), Some(&Opcode::And));
    }

    // ====================================================================
    // Composition / Parenthesized
    // ====================================================================

    #[test]
    fn parenthesized_compiles_inner() {
        let (ops, t) = compile_expression(
            &Expression::Parenthesized(Box::new(Expression::IntLiteral(7))),
            &SymbolTable::new(),
        )
        .expect("ok");
        assert_eq!(t, StValueType::Int);
        assert_eq!(ops.len(), 1);
    }

    #[test]
    fn nested_expression_emits_flat_opcode_stream() {
        // (x + 1) * 2 where x:Int local=0
        let syms = build_symbols(vec![sym("x", 0, StValueType::Int)]);
        let expr = Expression::BinaryOp {
            left: Box::new(Expression::BinaryOp {
                left: Box::new(Expression::Variable("x".into(), None)),
                op: BinaryOp::Add,
                right: Box::new(Expression::IntLiteral(1)),
            }),
            op: BinaryOp::Mul,
            right: Box::new(Expression::IntLiteral(2)),
        };
        let (ops, t) = compile_expression(&expr, &syms).expect("ok");
        assert_eq!(t, StValueType::Int);
        assert_eq!(
            ops,
            vec![
                Opcode::LoadLocal { index: 0 },
                Opcode::PushConst { value: StValue::Int(1) },
                Opcode::AddInt,
                Opcode::PushConst { value: StValue::Int(2) },
                Opcode::MulInt,
            ]
        );
    }

    // ====================================================================
    // Unsupported expressions
    // ====================================================================

    #[test]
    fn compile_string_literal_is_unsupported() {
        let err = compile_expression(
            &Expression::StringLiteral("hi".into()),
            &SymbolTable::new(),
        )
        .expect_err("unsupported");
        assert!(matches!(err, CompileError::Unsupported { .. }));
    }

    // ====================================================================
    // Batch 155 Faz 3 — stdlib function call compilation
    // ====================================================================

    #[test]
    fn compile_abs_int_resolves_abs_int_variant() {
        let (ops, t) = compile_expression(
            &Expression::FunctionCall {
                name: "ABS".into(),
                args: vec![Expression::IntLiteral(-7)],
            },
            &SymbolTable::new(),
        )
        .expect("ok");
        assert_eq!(t, StValueType::Int);
        assert_eq!(
            ops,
            vec![
                Opcode::PushConst { value: StValue::Int(-7) },
                Opcode::StdlibCall {
                    fn_id: super::super::bytecode::StdlibFunctionId::AbsInt,
                },
            ]
        );
    }

    #[test]
    fn compile_abs_real_resolves_abs_real_variant() {
        let (ops, t) = compile_expression(
            &Expression::FunctionCall {
                name: "abs".into(), // case-insensitive
                args: vec![Expression::RealLiteral(-3.25)],
            },
            &SymbolTable::new(),
        )
        .expect("ok");
        assert_eq!(t, StValueType::Real);
        assert_eq!(
            ops.last(),
            Some(&Opcode::StdlibCall {
                fn_id: super::super::bytecode::StdlibFunctionId::AbsReal,
            })
        );
    }

    #[test]
    fn compile_abs_bool_rejects() {
        let err = compile_expression(
            &Expression::FunctionCall {
                name: "ABS".into(),
                args: vec![Expression::BoolLiteral(true)],
            },
            &SymbolTable::new(),
        )
        .expect_err("mismatch");
        assert!(matches!(err, CompileError::UnaryTypeMismatch { .. }));
    }

    #[test]
    fn compile_sqrt_real_emits_sqrt_opcode() {
        let (ops, t) = compile_expression(
            &Expression::FunctionCall {
                name: "SQRT".into(),
                args: vec![Expression::RealLiteral(9.0)],
            },
            &SymbolTable::new(),
        )
        .expect("ok");
        assert_eq!(t, StValueType::Real);
        assert_eq!(
            ops.last(),
            Some(&Opcode::StdlibCall {
                fn_id: super::super::bytecode::StdlibFunctionId::SqrtReal,
            })
        );
    }

    #[test]
    fn compile_sqrt_int_arg_promotes_via_cast() {
        // SQRT(9) with Int arg → promoted via CastIntToReal.
        let (ops, t) = compile_expression(
            &Expression::FunctionCall {
                name: "SQRT".into(),
                args: vec![Expression::IntLiteral(9)],
            },
            &SymbolTable::new(),
        )
        .expect("ok");
        assert_eq!(t, StValueType::Real);
        assert!(ops.contains(&Opcode::CastIntToReal));
        assert_eq!(
            ops.last(),
            Some(&Opcode::StdlibCall {
                fn_id: super::super::bytecode::StdlibFunctionId::SqrtReal,
            })
        );
    }

    #[test]
    fn compile_limit_three_args_emits_limit_opcode() {
        let (ops, t) = compile_expression(
            &Expression::FunctionCall {
                name: "LIMIT".into(),
                args: vec![
                    Expression::RealLiteral(0.0),
                    Expression::RealLiteral(5.0),
                    Expression::RealLiteral(10.0),
                ],
            },
            &SymbolTable::new(),
        )
        .expect("ok");
        assert_eq!(t, StValueType::Real);
        assert_eq!(
            ops.last(),
            Some(&Opcode::StdlibCall {
                fn_id: super::super::bytecode::StdlibFunctionId::LimitReal,
            })
        );
    }

    #[test]
    fn compile_sel_bool_real_real_emits_sel_opcode() {
        let (ops, t) = compile_expression(
            &Expression::FunctionCall {
                name: "SEL".into(),
                args: vec![
                    Expression::BoolLiteral(true),
                    Expression::RealLiteral(1.0),
                    Expression::RealLiteral(9.0),
                ],
            },
            &SymbolTable::new(),
        )
        .expect("ok");
        assert_eq!(t, StValueType::Real);
        assert_eq!(
            ops.last(),
            Some(&Opcode::StdlibCall {
                fn_id: super::super::bytecode::StdlibFunctionId::SelReal,
            })
        );
    }

    #[test]
    fn compile_sel_non_bool_cond_rejects() {
        let err = compile_expression(
            &Expression::FunctionCall {
                name: "SEL".into(),
                args: vec![
                    Expression::IntLiteral(1), // cond must be Bool
                    Expression::RealLiteral(1.0),
                    Expression::RealLiteral(9.0),
                ],
            },
            &SymbolTable::new(),
        )
        .expect_err("mismatch");
        assert!(matches!(err, CompileError::TypeMismatch { .. }));
    }

    #[test]
    fn compile_unknown_function_rejects() {
        let err = compile_expression(
            &Expression::FunctionCall {
                name: "FOOBAR".into(),
                args: vec![],
            },
            &SymbolTable::new(),
        )
        .expect_err("unknown");
        assert!(matches!(err, CompileError::Unsupported { .. }));
    }

    #[test]
    fn compile_wrong_arg_count_rejects() {
        let err = compile_expression(
            &Expression::FunctionCall {
                name: "SQRT".into(),
                args: vec![
                    Expression::RealLiteral(1.0),
                    Expression::RealLiteral(2.0),
                ], // SQRT is unary
            },
            &SymbolTable::new(),
        )
        .expect_err("arity");
        assert!(matches!(err, CompileError::Unsupported { .. }));
    }

    #[test]
    fn compile_function_call_as_statement_emits_pop() {
        // SQRT(9.0);  — discard the result.
        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::FunctionCall {
                name: "SQRT".into(),
                args: vec![Expression::RealLiteral(9.0)],
                span: None,
            },
            &SymbolTable::new(),
            &mut ops,
        )
        .expect("ok");
        // Shape: PushConst(9.0), StdlibCall(SqrtReal), Pop
        assert_eq!(ops.len(), 3);
        assert!(matches!(ops[1], Opcode::StdlibCall { .. }));
        assert_eq!(ops[2], Opcode::Pop);
    }

    // ====================================================================
    // Batch 150 Faz 3 — statement compiler tests
    // ====================================================================

    /// Test helper: compile a statement at program scope
    /// with a fresh (empty) loop stack. All existing test
    /// cases operate at program scope; Batch 152 loop
    /// tests drive loop compilation from this helper so
    /// nested EXIT / CONTINUE are handled through the
    /// `compile_while` / `compile_repeat` entry points
    /// rather than via the loop stack directly.
    fn compile_stmt_program_scope(
        stmt: &Statement,
        symbols: &SymbolTable,
        ops: &mut Vec<Opcode>,
    ) -> Result<(), CompileError> {
        let mut loop_stack: Vec<LoopContext> = Vec::new();
        compile_statement(stmt, symbols, ops, &mut loop_stack)
    }

    #[test]
    fn compile_empty_statement_emits_nothing() {
        let mut ops = vec![];
        compile_stmt_program_scope(&Statement::Empty, &SymbolTable::new(), &mut ops)
            .expect("ok");
        assert!(ops.is_empty());
    }

    #[test]
    fn compile_return_statement_emits_return() {
        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::Return {
                value: None,
                span: None,
            },
            &SymbolTable::new(),
            &mut ops,
        )
        .expect("ok");
        assert_eq!(ops, vec![Opcode::Return]);
    }

    #[test]
    fn compile_assignment_emits_value_then_store() {
        // x := 42  where x:Int local=0
        let syms = build_symbols(vec![sym("x", 0, StValueType::Int)]);
        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::Assignment {
                target: Expression::Variable("x".into(), None),
                value: Expression::IntLiteral(42),
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect("ok");
        assert_eq!(
            ops,
            vec![
                Opcode::PushConst { value: StValue::Int(42) },
                Opcode::StoreLocal { index: 0 },
            ]
        );
    }

    #[test]
    fn compile_assignment_type_mismatch_rejects() {
        // x (Int) := 3.14 (Real) → TypeMismatch
        let syms = build_symbols(vec![sym("x", 0, StValueType::Int)]);
        let mut ops = vec![];
        let err = compile_stmt_program_scope(
            &Statement::Assignment {
                target: Expression::Variable("x".into(), None),
                value: Expression::RealLiteral(3.14),
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect_err("mismatch");
        assert!(matches!(err, CompileError::TypeMismatch { .. }));
    }

    #[test]
    fn compile_assignment_to_non_variable_target_rejects() {
        // Array[0] := 1 → Unsupported
        let mut ops = vec![];
        let err = compile_stmt_program_scope(
            &Statement::Assignment {
                target: Expression::ArrayAccess {
                    array: Box::new(Expression::Variable("a".into(), None)),
                    index: Box::new(Expression::IntLiteral(0)),
                },
                value: Expression::IntLiteral(1),
                span: None,
            },
            &SymbolTable::new(),
            &mut ops,
        )
        .expect_err("unsupported target");
        assert!(matches!(err, CompileError::Unsupported { .. }));
    }

    #[test]
    fn compile_if_without_else_patches_jump_to_end() {
        // IF flag THEN x := 1; END_IF
        let syms = build_symbols(vec![
            sym("flag", 0, StValueType::Bool),
            sym("x", 1, StValueType::Int),
        ]);
        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::If {
                condition: Expression::Variable("flag".into(), None),
                then_body: vec![Statement::Assignment {
                    target: Expression::Variable("x".into(), None),
                    value: Expression::IntLiteral(1),
                    span: None,
                }],
                elsif_branches: vec![],
                else_body: None,
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect("ok");
        // Expected opcode shape:
        //  0: LoadLocal{index=0}      (flag)
        //  1: JumpIfFalse{target=4}   (skip then body)
        //  2: PushConst{Int(1)}
        //  3: StoreLocal{index=1}
        // [end = 4]
        assert_eq!(ops.len(), 4);
        assert_eq!(ops[0], Opcode::LoadLocal { index: 0 });
        assert!(matches!(ops[1], Opcode::JumpIfFalse { target: 4 }));
        assert_eq!(ops[2], Opcode::PushConst { value: StValue::Int(1) });
        assert_eq!(ops[3], Opcode::StoreLocal { index: 1 });
    }

    #[test]
    fn compile_if_with_else_patches_both_branches() {
        // IF flag THEN x := 1; ELSE x := 2; END_IF
        let syms = build_symbols(vec![
            sym("flag", 0, StValueType::Bool),
            sym("x", 1, StValueType::Int),
        ]);
        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::If {
                condition: Expression::Variable("flag".into(), None),
                then_body: vec![Statement::Assignment {
                    target: Expression::Variable("x".into(), None),
                    value: Expression::IntLiteral(1),
                    span: None,
                }],
                elsif_branches: vec![],
                else_body: Some(vec![Statement::Assignment {
                    target: Expression::Variable("x".into(), None),
                    value: Expression::IntLiteral(2),
                    span: None,
                }]),
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect("ok");
        // Expected:
        //  0: LoadLocal{0}
        //  1: JumpIfFalse{target=5}
        //  2: PushConst{1}
        //  3: StoreLocal{1}
        //  4: Jump{target=7}          (skip else)
        //  5: PushConst{2}
        //  6: StoreLocal{1}
        // [end = 7]
        assert_eq!(ops.len(), 7);
        assert!(matches!(ops[1], Opcode::JumpIfFalse { target: 5 }));
        assert!(matches!(ops[4], Opcode::Jump { target: 7 }));
    }

    #[test]
    fn compile_if_non_bool_condition_rejects() {
        let syms = build_symbols(vec![sym("n", 0, StValueType::Int)]);
        let mut ops = vec![];
        let err = compile_stmt_program_scope(
            &Statement::If {
                condition: Expression::Variable("n".into(), None),
                then_body: vec![],
                elsif_branches: vec![],
                else_body: None,
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect_err("mismatch");
        assert!(matches!(err, CompileError::TypeMismatch { .. }));
    }

    // ====================================================================
    // Batch 152 Faz 3 — loop compilation tests
    // ====================================================================

    #[test]
    fn compile_while_emits_cond_branch_body_jump_back() {
        // WHILE flag DO x := 1; END_WHILE
        let syms = build_symbols(vec![
            sym("flag", 0, StValueType::Bool),
            sym("x", 1, StValueType::Int),
        ]);
        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::While {
                condition: Expression::Variable("flag".into(), None),
                body: vec![Statement::Assignment {
                    target: Expression::Variable("x".into(), None),
                    value: Expression::IntLiteral(1),
                    span: None,
                }],
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect("ok");
        // Expected shape:
        //  0: LoadLocal{0}             (flag)
        //  1: JumpIfFalse{target=5}    (exit loop)
        //  2: PushConst{Int(1)}
        //  3: StoreLocal{1}
        //  4: Jump{target=0}           (back to LOOP_START)
        // [end = 5]
        assert_eq!(ops.len(), 5);
        assert_eq!(ops[0], Opcode::LoadLocal { index: 0 });
        assert!(matches!(ops[1], Opcode::JumpIfFalse { target: 5 }));
        assert_eq!(ops[2], Opcode::PushConst { value: StValue::Int(1) });
        assert_eq!(ops[3], Opcode::StoreLocal { index: 1 });
        assert!(matches!(ops[4], Opcode::Jump { target: 0 }));
    }

    #[test]
    fn compile_while_non_bool_condition_rejects() {
        let syms = build_symbols(vec![sym("n", 0, StValueType::Int)]);
        let mut ops = vec![];
        let err = compile_stmt_program_scope(
            &Statement::While {
                condition: Expression::Variable("n".into(), None),
                body: vec![],
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect_err("mismatch");
        assert!(matches!(err, CompileError::TypeMismatch { .. }));
    }

    #[test]
    fn compile_while_with_exit_patches_to_loop_end() {
        // WHILE TRUE DO EXIT; END_WHILE
        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::While {
                condition: Expression::BoolLiteral(true),
                body: vec![Statement::Exit { span: None }],
                span: None,
            },
            &SymbolTable::new(),
            &mut ops,
        )
        .expect("ok");
        // Expected:
        //  0: PushConst{Bool(true)}
        //  1: JumpIfFalse{target=4}
        //  2: Jump{target=4}          (EXIT → END)
        //  3: Jump{target=0}          (loop back)
        // [end = 4]
        assert_eq!(ops.len(), 4);
        assert!(matches!(ops[1], Opcode::JumpIfFalse { target: 4 }));
        assert!(matches!(ops[2], Opcode::Jump { target: 4 }));
        assert!(matches!(ops[3], Opcode::Jump { target: 0 }));
    }

    #[test]
    fn compile_while_with_continue_patches_to_loop_start() {
        // WHILE TRUE DO CONTINUE; END_WHILE
        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::While {
                condition: Expression::BoolLiteral(true),
                body: vec![Statement::Continue { span: None }],
                span: None,
            },
            &SymbolTable::new(),
            &mut ops,
        )
        .expect("ok");
        // Expected:
        //  0: PushConst{Bool(true)}
        //  1: JumpIfFalse{target=4}
        //  2: Jump{target=0}          (CONTINUE → cond re-check)
        //  3: Jump{target=0}          (loop back)
        // [end = 4]
        assert_eq!(ops.len(), 4);
        assert!(matches!(ops[1], Opcode::JumpIfFalse { target: 4 }));
        assert!(matches!(ops[2], Opcode::Jump { target: 0 }));
        assert!(matches!(ops[3], Opcode::Jump { target: 0 }));
    }

    #[test]
    fn compile_repeat_emits_body_then_until_branch_back() {
        // REPEAT x := 1; UNTIL flag END_REPEAT
        let syms = build_symbols(vec![
            sym("flag", 0, StValueType::Bool),
            sym("x", 1, StValueType::Int),
        ]);
        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::Repeat {
                body: vec![Statement::Assignment {
                    target: Expression::Variable("x".into(), None),
                    value: Expression::IntLiteral(1),
                    span: None,
                }],
                condition: Expression::Variable("flag".into(), None),
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect("ok");
        // Expected:
        //  0: PushConst{Int(1)}
        //  1: StoreLocal{1}
        //  2: LoadLocal{0}             (flag = UNTIL-cond)
        //  3: JumpIfFalse{target=0}    (false → keep looping)
        // [end = 4]
        assert_eq!(ops.len(), 4);
        assert_eq!(ops[0], Opcode::PushConst { value: StValue::Int(1) });
        assert_eq!(ops[1], Opcode::StoreLocal { index: 1 });
        assert_eq!(ops[2], Opcode::LoadLocal { index: 0 });
        assert!(matches!(ops[3], Opcode::JumpIfFalse { target: 0 }));
    }

    #[test]
    fn compile_repeat_with_exit_and_continue_patches_correctly() {
        // REPEAT EXIT; CONTINUE; UNTIL FALSE END_REPEAT
        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::Repeat {
                body: vec![
                    Statement::Exit { span: None },
                    Statement::Continue { span: None },
                ],
                condition: Expression::BoolLiteral(false),
                span: None,
            },
            &SymbolTable::new(),
            &mut ops,
        )
        .expect("ok");
        // Expected:
        //  0: Jump{target=4}   (EXIT → END)
        //  1: Jump{target=2}   (CONTINUE → UNTIL-check)
        //  2: PushConst{Bool(false)}  (UNTIL check start)
        //  3: JumpIfFalse{target=0}
        // [end = 4]
        assert_eq!(ops.len(), 4);
        assert!(matches!(ops[0], Opcode::Jump { target: 4 }));
        assert!(matches!(ops[1], Opcode::Jump { target: 2 }));
        assert_eq!(ops[2], Opcode::PushConst { value: StValue::Bool(false) });
        assert!(matches!(ops[3], Opcode::JumpIfFalse { target: 0 }));
    }

    #[test]
    fn compile_exit_outside_loop_rejects() {
        let mut ops = vec![];
        let err = compile_stmt_program_scope(
            &Statement::Exit { span: None },
            &SymbolTable::new(),
            &mut ops,
        )
        .expect_err("unsupported");
        assert!(matches!(err, CompileError::Unsupported { .. }));
    }

    #[test]
    fn compile_continue_outside_loop_rejects() {
        let mut ops = vec![];
        let err = compile_stmt_program_scope(
            &Statement::Continue { span: None },
            &SymbolTable::new(),
            &mut ops,
        )
        .expect_err("unsupported");
        assert!(matches!(err, CompileError::Unsupported { .. }));
    }

    #[test]
    fn compile_nested_while_exit_targets_innermost() {
        // WHILE TRUE DO WHILE TRUE DO EXIT; END_WHILE; END_WHILE
        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::While {
                condition: Expression::BoolLiteral(true),
                body: vec![Statement::While {
                    condition: Expression::BoolLiteral(true),
                    body: vec![Statement::Exit { span: None }],
                    span: None,
                }],
                span: None,
            },
            &SymbolTable::new(),
            &mut ops,
        )
        .expect("ok");
        // Expected (outer loop wraps inner):
        //   0: PushConst{true}         (outer cond)
        //   1: JumpIfFalse{8}          (outer exit)
        //   2: PushConst{true}         (inner cond, LOOP_START_INNER=2)
        //   3: JumpIfFalse{6}          (inner exit → after inner)
        //   4: Jump{6}                 (EXIT → inner END)
        //   5: Jump{2}                 (inner back-jump)
        //   6: Jump{0}                 (outer back-jump)
        // [end=7? Let me recount — outer end = 7]
        // Actually:
        //  0: PushConst{true} outer
        //  1: JumpIfFalse{?} outer-exit placeholder, patched last
        //  2: PushConst{true} inner
        //  3: JumpIfFalse{?} inner-exit placeholder
        //  4: Jump{?} EXIT slot
        //  5: Jump{2} inner back
        //  6: Jump{0} outer back
        // Inner loop ends at 6, outer ends at 7.
        assert_eq!(ops.len(), 7);
        // EXIT at index 4 must target inner END (6).
        assert!(matches!(ops[4], Opcode::Jump { target: 6 }));
        // Inner back-jump at index 5 targets inner LOOP_START (2).
        assert!(matches!(ops[5], Opcode::Jump { target: 2 }));
        // Outer back-jump at index 6 targets outer LOOP_START (0).
        assert!(matches!(ops[6], Opcode::Jump { target: 0 }));
        // Inner cond-exit at index 3 targets inner END (6).
        assert!(matches!(ops[3], Opcode::JumpIfFalse { target: 6 }));
        // Outer cond-exit at index 1 targets outer END (7).
        assert!(matches!(ops[1], Opcode::JumpIfFalse { target: 7 }));
    }

    // ====================================================================
    // Program compilation
    // ====================================================================

    #[test]
    fn compile_program_builds_symbol_table_from_var_blocks() {
        use crate::st_validator::{Program, VarBlock, VarDeclaration, VarScope};

        let prog = Program {
            name: "test_prog".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: false,
                constant: false,
                declarations: vec![
                    VarDeclaration {
                        name: "counter".into(),
                        data_type: DataType::Int,
                        initial_value: None,
                        span: None,
                    },
                    VarDeclaration {
                        name: "active".into(),
                        data_type: DataType::Bool,
                        initial_value: None,
                        span: None,
                    },
                ],
                span: None,
            }],
            body: vec![Statement::Assignment {
                target: Expression::Variable("counter".into(), None),
                value: Expression::IntLiteral(10),
                span: None,
            }],
            span: None,
        };

        let bc = compile_program(&prog, &[], "prog-1".into(), 1000).expect("ok");
        assert_eq!(bc.program_id, "prog-1");
        assert_eq!(bc.program_name, "test_prog");
        assert_eq!(bc.local_count, 2);
        assert_eq!(bc.retain_vars.len(), 0);
        // body = PushConst(10), StoreLocal{index=0}, Return
        assert_eq!(bc.opcodes.len(), 3);
        assert_eq!(
            bc.opcodes.last().unwrap(),
            &Opcode::Return
        );
    }

    #[test]
    fn compile_program_tracks_retain_vars() {
        use crate::st_validator::{Program, VarBlock, VarDeclaration, VarScope};

        let prog = Program {
            name: "retain_test".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: true,
                constant: false,
                declarations: vec![VarDeclaration {
                    name: "persistent_counter".into(),
                    data_type: DataType::Int,
                    initial_value: None,
                    span: None,
                }],
                span: None,
            }],
            body: vec![],
            span: None,
        };

        let bc = compile_program(&prog, &[], "p".into(), 100).expect("ok");
        assert_eq!(bc.retain_vars.len(), 1);
        assert_eq!(bc.retain_vars[0].0, "persistent_counter");
        // Batch 175: tuple shape is (name, local_index, type).
        // Single declared var → local_index = 0.
        assert_eq!(bc.retain_vars[0].1, 0u32);
        assert_eq!(bc.retain_vars[0].2, StValueType::Int);
    }

    #[test]
    fn compile_program_rejects_unsupported_type() {
        use crate::st_validator::{Program, VarBlock, VarDeclaration, VarScope};

        let prog = Program {
            name: "string_test".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: false,
                constant: false,
                declarations: vec![VarDeclaration {
                    name: "msg".into(),
                    data_type: DataType::String(None),
                    initial_value: None,
                    span: None,
                }],
                span: None,
            }],
            body: vec![],
            span: None,
        };

        let err = compile_program(&prog, &[], "p".into(), 100).expect_err("unsupported");
        assert!(matches!(err, CompileError::Unsupported { .. }));
    }

    // ====================================================================
    // Batch 157 Faz 3 — tag read/write compilation
    // ====================================================================

    #[test]
    fn compile_variable_tag_emits_load_tag() {
        let syms = build_symbols(vec![sym_tag(
            "water_temp",
            StValueType::Real,
            false,
        )]);
        let (ops, t) = compile_expression(
            &Expression::Variable("water_temp".into(), None),
            &syms,
        )
        .expect("ok");
        assert_eq!(t, StValueType::Real);
        assert_eq!(
            ops,
            vec![Opcode::LoadTag {
                name: "water_temp".into()
            }]
        );
    }

    #[test]
    fn compile_assignment_to_writable_tag_emits_write_tag() {
        let syms = build_symbols(vec![sym_tag(
            "feeder_rate",
            StValueType::Real,
            true,
        )]);
        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::Assignment {
                target: Expression::Variable("feeder_rate".into(), None),
                value: Expression::RealLiteral(2.5),
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect("ok");
        assert_eq!(
            ops,
            vec![
                Opcode::PushConst { value: StValue::Real(2.5) },
                Opcode::WriteTag {
                    name: "feeder_rate".into()
                },
            ]
        );
    }

    #[test]
    fn compile_assignment_to_read_only_tag_rejects() {
        let syms = build_symbols(vec![sym_tag(
            "ph_sensor",
            StValueType::Real,
            false,
        )]);
        let mut ops = vec![];
        let err = compile_stmt_program_scope(
            &Statement::Assignment {
                target: Expression::Variable("ph_sensor".into(), None),
                value: Expression::RealLiteral(7.0),
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect_err("read-only");
        match err {
            CompileError::ReadOnlyTag { name } => assert_eq!(name, "ph_sensor"),
            other => panic!("expected ReadOnlyTag, got {:?}", other),
        }
    }

    #[test]
    fn compile_program_populates_allowed_write_tags_from_assignments() {
        use crate::st_validator::{Program, VarBlock, VarDeclaration, VarScope};

        let prog = Program {
            name: "tag_writer".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: false,
                constant: false,
                declarations: vec![VarDeclaration {
                    name: "n".into(),
                    data_type: DataType::Int,
                    initial_value: None,
                    span: None,
                }],
                span: None,
            }],
            body: vec![
                // local assignment — does NOT appear in allowed_write_tags.
                Statement::Assignment {
                    target: Expression::Variable("n".into(), None),
                    value: Expression::IntLiteral(1),
                    span: None,
                },
                // tag assignment — DOES appear.
                Statement::Assignment {
                    target: Expression::Variable("feeder_rate".into(), None),
                    value: Expression::RealLiteral(3.0),
                    span: None,
                },
                // duplicate tag write — dedup expected.
                Statement::Assignment {
                    target: Expression::Variable("feeder_rate".into(), None),
                    value: Expression::RealLiteral(4.0),
                    span: None,
                },
                // second distinct tag.
                Statement::Assignment {
                    target: Expression::Variable("aerator_pwm".into(), None),
                    value: Expression::RealLiteral(0.5),
                    span: None,
                },
            ],
            span: None,
        };

        let tags = vec![
            TagDescriptor {
                name: "feeder_rate".into(),
                data_type: StValueType::Real,
                writable: true,
            },
            TagDescriptor {
                name: "aerator_pwm".into(),
                data_type: StValueType::Real,
                writable: true,
            },
        ];

        let bc = compile_program(&prog, &tags, "p".into(), 10_000).expect("ok");
        // Expect exactly these two tags, sorted + dedup'd.
        assert_eq!(
            bc.allowed_write_tags,
            vec!["aerator_pwm".to_string(), "feeder_rate".to_string()]
        );
    }

    #[test]
    fn compile_program_local_shadows_tag_of_same_name() {
        // If a local `temp` is declared in VAR + a tag
        // `temp` exists in the catalog, the local wins.
        use crate::st_validator::{Program, VarBlock, VarDeclaration, VarScope};

        let prog = Program {
            name: "shadow".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: false,
                constant: false,
                declarations: vec![VarDeclaration {
                    name: "temp".into(),
                    data_type: DataType::Real,
                    initial_value: None,
                    span: None,
                }],
                span: None,
            }],
            body: vec![Statement::Assignment {
                target: Expression::Variable("temp".into(), None),
                value: Expression::RealLiteral(1.0),
                span: None,
            }],
            span: None,
        };

        let tags = vec![TagDescriptor {
            name: "temp".into(),
            data_type: StValueType::Real,
            writable: true,
        }];

        let bc = compile_program(&prog, &tags, "p".into(), 10_000).expect("ok");
        // The assignment must emit StoreLocal, NOT WriteTag.
        assert!(bc
            .opcodes
            .iter()
            .any(|op| matches!(op, Opcode::StoreLocal { .. })));
        assert!(!bc
            .opcodes
            .iter()
            .any(|op| matches!(op, Opcode::WriteTag { .. })));
        // And allowed_write_tags stays empty.
        assert!(bc.allowed_write_tags.is_empty());
    }

    #[test]
    fn compile_assignment_int_literal_to_real_tag_promotes() {
        // feeder_rate: Real (tag writable) := 3  (Int literal)
        // → compiler emits CastIntToReal before WriteTag.
        let syms = build_symbols(vec![sym_tag(
            "feeder_rate",
            StValueType::Real,
            true,
        )]);
        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::Assignment {
                target: Expression::Variable("feeder_rate".into(), None),
                value: Expression::IntLiteral(3),
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect("ok");
        assert_eq!(
            ops,
            vec![
                Opcode::PushConst { value: StValue::Int(3) },
                Opcode::CastIntToReal,
                Opcode::WriteTag {
                    name: "feeder_rate".into()
                },
            ]
        );
    }

    // ====================================================================
    // Batch 181 Faz 3 — FunctionBlockCall + MemberAccess compilation
    // ====================================================================

    #[test]
    fn compile_fb_call_emits_push_args_then_fb_call_opcode() {
        // my_timer(IN := flag, PT := 5000);
        // where flag: Bool, 5000 is IntLiteral.
        let syms = build_symbols(vec![
            sym("flag", 0, StValueType::Bool),
        ]);
        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::FunctionBlockCall {
                fb_name: "my_timer".into(),
                assignments: vec![
                    (
                        "IN".to_string(),
                        Expression::Variable("flag".into(), None),
                    ),
                    (
                        "PT".to_string(),
                        Expression::IntLiteral(5000),
                    ),
                ],
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect("ok");
        // Expected shape:
        //  0: LoadLocal{0}                (flag)
        //  1: PushConst{Int(5000)}
        //  2: FbCall { fb_id: "my_timer", input_names: [IN, PT] }
        assert_eq!(ops.len(), 3);
        assert_eq!(ops[0], Opcode::LoadLocal { index: 0 });
        assert_eq!(ops[1], Opcode::PushConst { value: StValue::Int(5000) });
        match &ops[2] {
            Opcode::FbCall { fb_id, input_names } => {
                assert_eq!(fb_id, "my_timer");
                assert_eq!(
                    input_names,
                    &vec!["IN".to_string(), "PT".to_string()]
                );
            }
            other => panic!("expected FbCall, got {:?}", other),
        }
    }

    #[test]
    fn compile_fb_call_with_zero_args_emits_only_fb_call() {
        // my_counter();  — no assignments
        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::FunctionBlockCall {
                fb_name: "my_counter".into(),
                assignments: vec![],
                span: None,
            },
            &SymbolTable::new(),
            &mut ops,
        )
        .expect("ok");
        assert_eq!(ops.len(), 1);
        match &ops[0] {
            Opcode::FbCall { fb_id, input_names } => {
                assert_eq!(fb_id, "my_counter");
                assert!(input_names.is_empty());
            }
            other => panic!("expected FbCall, got {:?}", other),
        }
    }

    #[test]
    fn compile_member_access_as_expression_emits_fb_read_output() {
        // my_timer.Q  (as an expression)
        let (ops, t) = compile_expression(
            &Expression::MemberAccess {
                object: Box::new(Expression::Variable(
                    "my_timer".into(),
                    None,
                )),
                member: "Q".into(),
            },
            &SymbolTable::new(),
        )
        .expect("ok");
        assert_eq!(ops.len(), 1);
        match &ops[0] {
            Opcode::FbReadOutput { fb_id, output_name } => {
                assert_eq!(fb_id, "my_timer");
                assert_eq!(output_name, "Q");
            }
            other => panic!("expected FbReadOutput, got {:?}", other),
        }
        // Batch 181 inferred type = Real; Batch 182
        // adds the FB type catalog for precise typing.
        assert_eq!(t, StValueType::Real);
    }

    #[test]
    fn compile_fb_call_type_checks_args_against_registered_input_types() {
        // Batch 183: register my_timer(IN: Bool, PT: Real).
        // `my_timer(IN := true_flag, PT := 5.0)` → compile
        // ok; same call with `PT := "string"` would not
        // type-check but we don't have String literals
        // compiled yet. Use an Int argument on a Real
        // pin to check the promotion path.
        let mut syms = build_symbols(vec![
            sym("true_flag", 0, StValueType::Bool),
        ]);
        let mut inputs = HashMap::new();
        inputs.insert("IN".to_string(), StValueType::Bool);
        inputs.insert("PT".to_string(), StValueType::Real);
        syms.insert_fb_inputs("my_timer", inputs);

        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::FunctionBlockCall {
                fb_name: "my_timer".into(),
                assignments: vec![
                    (
                        "IN".to_string(),
                        Expression::Variable("true_flag".into(), None),
                    ),
                    (
                        "PT".to_string(),
                        Expression::IntLiteral(5000), // Int → Real promotion
                    ),
                ],
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect("ok");
        // Expected shape:
        //  0: LoadLocal{0}           (true_flag : Bool → matches IN: Bool)
        //  1: PushConst{Int(5000)}
        //  2: CastIntToReal          (promotion because PT is Real)
        //  3: FbCall { ... }
        assert_eq!(ops.len(), 4);
        assert_eq!(ops[0], Opcode::LoadLocal { index: 0 });
        assert_eq!(ops[1], Opcode::PushConst { value: StValue::Int(5000) });
        assert_eq!(ops[2], Opcode::CastIntToReal);
        assert!(matches!(ops[3], Opcode::FbCall { .. }));
    }

    #[test]
    fn compile_fb_call_rejects_wrong_type_on_registered_pin() {
        // IN is Bool; passing an IntLiteral → TypeMismatch
        // (not Int→Real-eligible, no Int→Bool promotion).
        let mut syms = SymbolTable::new();
        let mut inputs = HashMap::new();
        inputs.insert("IN".to_string(), StValueType::Bool);
        syms.insert_fb_inputs("my_timer", inputs);

        let mut ops = vec![];
        let err = compile_stmt_program_scope(
            &Statement::FunctionBlockCall {
                fb_name: "my_timer".into(),
                assignments: vec![(
                    "IN".to_string(),
                    Expression::IntLiteral(1),
                )],
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect_err("type mismatch");
        assert!(matches!(err, CompileError::TypeMismatch { .. }));
    }

    #[test]
    fn compile_fb_call_unregistered_fb_skips_type_check() {
        // No insert_fb_inputs call → compile-time check
        // is skipped, runtime catches (Batch 180 path).
        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::FunctionBlockCall {
                fb_name: "unregistered_fb".into(),
                assignments: vec![(
                    "whatever".to_string(),
                    Expression::IntLiteral(1),
                )],
                span: None,
            },
            &SymbolTable::new(),
            &mut ops,
        )
        .expect("unregistered FB compiles (runtime check path)");
        // One PushConst + one FbCall = 2 opcodes.
        assert_eq!(ops.len(), 2);
    }

    #[test]
    fn compile_member_access_uses_fb_output_type_from_symbol_table() {
        // Batch 182: register my_timer.Q as Bool in the
        // symbol table so compile_expression picks
        // StValueType::Bool rather than the Real
        // placeholder.
        let mut syms = SymbolTable::new();
        let mut timer_outputs = HashMap::new();
        timer_outputs.insert("Q".to_string(), StValueType::Bool);
        timer_outputs.insert("ET".to_string(), StValueType::Int);
        syms.insert_fb_outputs("my_timer", timer_outputs);

        // Q → Bool.
        let (_ops, t_q) = compile_expression(
            &Expression::MemberAccess {
                object: Box::new(Expression::Variable(
                    "my_timer".into(),
                    None,
                )),
                member: "Q".into(),
            },
            &syms,
        )
        .expect("ok");
        assert_eq!(t_q, StValueType::Bool);

        // ET → Int.
        let (_ops, t_et) = compile_expression(
            &Expression::MemberAccess {
                object: Box::new(Expression::Variable(
                    "my_timer".into(),
                    None,
                )),
                member: "ET".into(),
            },
            &syms,
        )
        .expect("ok");
        assert_eq!(t_et, StValueType::Int);
    }

    #[test]
    fn compile_member_access_unknown_fb_falls_back_to_real() {
        // Batch 182: unregistered FB instance → inferred
        // type stays Real (Batch 181 backward-compat).
        let (_ops, t) = compile_expression(
            &Expression::MemberAccess {
                object: Box::new(Expression::Variable(
                    "unknown_fb".into(),
                    None,
                )),
                member: "Q".into(),
            },
            &SymbolTable::new(),
        )
        .expect("ok");
        assert_eq!(t, StValueType::Real);
    }

    #[test]
    fn compile_member_access_unknown_pin_falls_back_to_real() {
        // FB registered but queried pin is not in the
        // output map — falls back to Real.
        let mut syms = SymbolTable::new();
        let mut outputs = HashMap::new();
        outputs.insert("Q".to_string(), StValueType::Bool);
        syms.insert_fb_outputs("my_timer", outputs);

        let (_ops, t) = compile_expression(
            &Expression::MemberAccess {
                object: Box::new(Expression::Variable(
                    "my_timer".into(),
                    None,
                )),
                member: "NotDeclared".into(),
            },
            &syms,
        )
        .expect("ok");
        assert_eq!(t, StValueType::Real);
    }

    #[test]
    fn compile_member_access_bool_output_roundtrips_through_if_condition() {
        // Full smoke: `IF my_timer.Q THEN x := 1; END_IF`
        // compiles cleanly when Q is declared Bool.
        // Without Batch 182, Q would infer as Real,
        // then the IF condition's Bool gate would
        // reject with TypeMismatch.
        let mut syms = build_symbols(vec![sym("x", 0, StValueType::Int)]);
        let mut outputs = HashMap::new();
        outputs.insert("Q".to_string(), StValueType::Bool);
        syms.insert_fb_outputs("my_timer", outputs);

        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::If {
                condition: Expression::MemberAccess {
                    object: Box::new(Expression::Variable(
                        "my_timer".into(),
                        None,
                    )),
                    member: "Q".into(),
                },
                then_body: vec![Statement::Assignment {
                    target: Expression::Variable("x".into(), None),
                    value: Expression::IntLiteral(1),
                    span: None,
                }],
                elsif_branches: vec![],
                else_body: None,
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect("ok");
        // First opcode is FbReadOutput, followed by
        // JumpIfFalse. No promotion / cast opcodes
        // between — proves the compile-time type
        // matched Bool.
        assert!(matches!(ops[0], Opcode::FbReadOutput { .. }));
        assert!(matches!(ops[1], Opcode::JumpIfFalse { .. }));
    }

    #[test]
    fn compile_member_access_non_variable_lhs_rejects() {
        // (1 + 2).foo  → LHS is BinaryOp not Variable → Unsupported.
        let err = compile_expression(
            &Expression::MemberAccess {
                object: Box::new(Expression::BinaryOp {
                    left: Box::new(Expression::IntLiteral(1)),
                    op: BinaryOp::Add,
                    right: Box::new(Expression::IntLiteral(2)),
                }),
                member: "foo".into(),
            },
            &SymbolTable::new(),
        )
        .expect_err("non-variable lhs");
        assert!(matches!(err, CompileError::Unsupported { .. }));
    }

    // ====================================================================
    // Batch 162 Faz 3 — FOR loop compilation
    // ====================================================================

    #[test]
    fn compile_for_loop_emits_init_condition_body_increment_shape() {
        // FOR i := 1 TO 3 DO EXIT END_FOR
        // Loop variable `i` is a declared Int local at index 0.
        let syms = build_symbols(vec![sym("i", 0, StValueType::Int)]);
        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::For {
                variable: "i".into(),
                from: Expression::IntLiteral(1),
                to: Expression::IntLiteral(3),
                by: None,
                body: vec![Statement::Exit { span: None }],
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect("ok");
        // Expected emission:
        //  0: PushConst{Int(1)}       (from)
        //  1: StoreLocal{0}            (i := from)
        //  2: PushConst{Int(3)}        (to)
        //  3: LoadLocal{0}
        //  4: LtInt
        //  5: Not
        //  6: JumpIfFalse{target=EXIT}  (patched = end)
        //  7: Jump{target=EXIT}          (EXIT placeholder, patched)
        //  8: LoadLocal{0}             (INCR)
        //  9: PushConst{Int(1)}
        // 10: AddInt
        // 11: StoreLocal{0}
        // 12: Jump{target=2}           (back to LOOP_START = ops[2])
        // [end = 13]
        assert_eq!(ops.len(), 13);
        assert_eq!(ops[0], Opcode::PushConst { value: StValue::Int(1) });
        assert_eq!(ops[1], Opcode::StoreLocal { index: 0 });
        assert_eq!(ops[4], Opcode::LtInt);
        assert_eq!(ops[5], Opcode::Not);
        assert!(matches!(ops[6], Opcode::JumpIfFalse { target: 13 }));
        // EXIT inside the body jumps to END.
        assert!(matches!(ops[7], Opcode::Jump { target: 13 }));
        // Back-jump targets LOOP_START (index = 2, the
        // first opcode of the `to` expression).
        assert!(matches!(ops[12], Opcode::Jump { target: 2 }));
    }

    #[test]
    fn compile_for_loop_continue_targets_incr() {
        // FOR i := 1 TO 10 DO CONTINUE END_FOR
        // CONTINUE should jump to the INCR block, not the
        // loop start, so the iteration counter advances.
        let syms = build_symbols(vec![sym("i", 0, StValueType::Int)]);
        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::For {
                variable: "i".into(),
                from: Expression::IntLiteral(1),
                to: Expression::IntLiteral(10),
                by: None,
                body: vec![Statement::Continue { span: None }],
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect("ok");
        // CONTINUE at body pos 7 → INCR start = 8.
        assert!(matches!(ops[7], Opcode::Jump { target: 8 }));
    }

    #[test]
    fn compile_for_rejects_non_int_loop_variable() {
        // FOR x := 1 TO 10 DO ... where x is Real → reject.
        let syms = build_symbols(vec![sym("x", 0, StValueType::Real)]);
        let mut ops = vec![];
        let err = compile_stmt_program_scope(
            &Statement::For {
                variable: "x".into(),
                from: Expression::IntLiteral(1),
                to: Expression::IntLiteral(10),
                by: None,
                body: vec![],
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect_err("type mismatch");
        assert!(matches!(err, CompileError::TypeMismatch { .. }));
    }

    #[test]
    fn compile_for_rejects_tag_loop_variable() {
        let syms = build_symbols(vec![sym_tag(
            "counter_tag",
            StValueType::Int,
            true,
        )]);
        let mut ops = vec![];
        let err = compile_stmt_program_scope(
            &Statement::For {
                variable: "counter_tag".into(),
                from: Expression::IntLiteral(1),
                to: Expression::IntLiteral(10),
                by: None,
                body: vec![],
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect_err("tag cannot be loop variable");
        assert!(matches!(err, CompileError::Unsupported { .. }));
    }

    #[test]
    fn compile_for_rejects_by_clause() {
        let syms = build_symbols(vec![sym("i", 0, StValueType::Int)]);
        let mut ops = vec![];
        let err = compile_stmt_program_scope(
            &Statement::For {
                variable: "i".into(),
                from: Expression::IntLiteral(1),
                to: Expression::IntLiteral(10),
                by: Some(Expression::IntLiteral(2)),
                body: vec![],
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect_err("BY clause unsupported in Batch 162");
        assert!(matches!(err, CompileError::Unsupported { .. }));
    }

    #[test]
    fn compile_for_rejects_unknown_loop_variable() {
        let syms = build_symbols(vec![]);
        let mut ops = vec![];
        let err = compile_stmt_program_scope(
            &Statement::For {
                variable: "ghost".into(),
                from: Expression::IntLiteral(1),
                to: Expression::IntLiteral(10),
                by: None,
                body: vec![],
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect_err("unknown");
        assert!(matches!(err, CompileError::UnknownVariable { .. }));
    }

    // ====================================================================
    // Batch 174 Faz 3 — CASE statement compilation
    // ====================================================================

    #[test]
    fn compile_case_three_branches_with_else() {
        // CASE state OF
        //   0: x := 1;
        //   1: x := 2;
        //   2: x := 3;
        //   ELSE x := 99;
        // END_CASE
        let syms = build_symbols(vec![
            sym("state", 0, StValueType::Int),
            sym("x", 1, StValueType::Int),
        ]);
        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::Case {
                expr: Expression::Variable("state".into(), None),
                branches: vec![
                    (
                        vec![Expression::IntLiteral(0)],
                        vec![Statement::Assignment {
                            target: Expression::Variable("x".into(), None),
                            value: Expression::IntLiteral(1),
                            span: None,
                        }],
                    ),
                    (
                        vec![Expression::IntLiteral(1)],
                        vec![Statement::Assignment {
                            target: Expression::Variable("x".into(), None),
                            value: Expression::IntLiteral(2),
                            span: None,
                        }],
                    ),
                    (
                        vec![Expression::IntLiteral(2)],
                        vec![Statement::Assignment {
                            target: Expression::Variable("x".into(), None),
                            value: Expression::IntLiteral(3),
                            span: None,
                        }],
                    ),
                ],
                else_body: Some(vec![Statement::Assignment {
                    target: Expression::Variable("x".into(), None),
                    value: Expression::IntLiteral(99),
                    span: None,
                }]),
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect("ok");
        // Smoke check: opcode count is reasonable + first
        // op loads selector + emission contains the
        // expected Dup / Eq / Pop pattern.
        assert!(ops.len() > 10);
        assert!(matches!(ops[0], Opcode::LoadLocal { index: 0 }));
        // Some Dup opcodes should exist (one per match value).
        assert!(ops.iter().filter(|o| matches!(o, Opcode::Dup)).count() >= 3);
    }

    #[test]
    fn compile_case_multiple_values_per_branch() {
        // CASE n OF 1, 3, 5: x := 100; END_CASE
        // Should emit 3 Dup/Eq/JumpIfFalse match checks
        // all leading to the same body.
        let syms = build_symbols(vec![
            sym("n", 0, StValueType::Int),
            sym("x", 1, StValueType::Int),
        ]);
        let mut ops = vec![];
        compile_stmt_program_scope(
            &Statement::Case {
                expr: Expression::Variable("n".into(), None),
                branches: vec![(
                    vec![
                        Expression::IntLiteral(1),
                        Expression::IntLiteral(3),
                        Expression::IntLiteral(5),
                    ],
                    vec![Statement::Assignment {
                        target: Expression::Variable("x".into(), None),
                        value: Expression::IntLiteral(100),
                        span: None,
                    }],
                )],
                else_body: None,
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect("ok");
        // 3 match values → 3 Dup opcodes.
        assert_eq!(ops.iter().filter(|o| matches!(o, Opcode::Dup)).count(), 3);
    }

    #[test]
    fn compile_case_rejects_non_int_selector() {
        let syms = build_symbols(vec![sym("flag", 0, StValueType::Bool)]);
        let mut ops = vec![];
        let err = compile_stmt_program_scope(
            &Statement::Case {
                expr: Expression::Variable("flag".into(), None),
                branches: vec![],
                else_body: None,
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect_err("type mismatch");
        assert!(matches!(err, CompileError::TypeMismatch { .. }));
    }

    #[test]
    fn compile_case_rejects_non_literal_match_value() {
        let syms = build_symbols(vec![sym("n", 0, StValueType::Int)]);
        let mut ops = vec![];
        let err = compile_stmt_program_scope(
            &Statement::Case {
                expr: Expression::Variable("n".into(), None),
                branches: vec![(
                    vec![Expression::Variable("n".into(), None)],
                    vec![],
                )],
                else_body: None,
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect_err("non-literal match");
        assert!(matches!(err, CompileError::Unsupported { .. }));
    }

    #[test]
    fn compile_case_rejects_empty_match_values_branch() {
        let syms = build_symbols(vec![sym("n", 0, StValueType::Int)]);
        let mut ops = vec![];
        let err = compile_stmt_program_scope(
            &Statement::Case {
                expr: Expression::Variable("n".into(), None),
                branches: vec![(vec![], vec![])],
                else_body: None,
                span: None,
            },
            &syms,
            &mut ops,
        )
        .expect_err("empty branch match values");
        assert!(matches!(err, CompileError::Unsupported { .. }));
    }

    #[test]
    fn compile_program_always_ends_with_return() {
        // Empty program — single Return opcode.
        use crate::st_validator::Program;
        let prog = Program {
            name: "empty".into(),
            var_blocks: vec![],
            body: vec![],
            span: None,
        };
        let bc = compile_program(&prog, &[], "p".into(), 100).expect("ok");
        assert_eq!(bc.opcodes, vec![Opcode::Return]);
    }
}
