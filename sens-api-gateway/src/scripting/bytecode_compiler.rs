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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SymbolEntry {
    pub local_index: u32,
    pub declared_type: StValueType,
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
            Ok((
                vec![Opcode::LoadLocal {
                    index: entry.local_index,
                }],
                entry.declared_type,
            ))
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
        Expression::MemberAccess { .. } => Err(CompileError::Unsupported {
            what: "member access (future FB-integration batch)".to_string(),
        }),
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
            let target_entry =
                symbols.get(target_name).ok_or_else(|| {
                    CompileError::UnknownVariable {
                        name: target_name.clone(),
                    }
                })?;

            // Compile RHS value expr + type-check.
            let (value_ops, value_type) = compile_expression(value, symbols)?;
            if value_type != target_entry.declared_type {
                return Err(CompileError::TypeMismatch {
                    op: "assignment".to_string(),
                    left: target_entry.declared_type,
                    right: value_type,
                });
            }

            ops.extend(value_ops);
            ops.push(Opcode::StoreLocal {
                index: target_entry.local_index,
            });
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
        Statement::For { .. } => Err(CompileError::Unsupported {
            what: "FOR loop (Batch 153 adds FOR alongside Int→Real promotion)".to_string(),
        }),
        Statement::Case { .. } => Err(CompileError::Unsupported {
            what: "CASE statement (Batch 154)".to_string(),
        }),
        Statement::FunctionBlockCall { .. } => Err(CompileError::Unsupported {
            what: "function block call (Batch 155 FB-integration)".to_string(),
        }),
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
/// Batch 150 handles local variables only; RETAIN
/// variable persistence lands in Batch 151. GLOBAL /
/// INPUT / OUTPUT scopes land in the Batch 154 FB-
/// integration batch when FB declarations carry their
/// own scoped variables.
///
/// `program_id` + `max_gas_per_tick` are caller-
/// supplied — these are operator-facing identifiers
/// not encoded in the AST itself.
pub fn compile_program(
    program: &crate::st_validator::Program,
    program_id: String,
    max_gas_per_tick: u32,
) -> Result<Bytecode, CompileError> {
    let mut symbols = SymbolTable::new();
    let mut local_count: u32 = 0;
    let mut retain_vars: Vec<(String, StValueType)> = Vec::new();

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
                SymbolEntry {
                    local_index: local_count,
                    declared_type: st_type,
                },
            );
            local_count += 1;
            if block.retain {
                retain_vars.push((decl.name.clone(), st_type));
            }
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

    Ok(Bytecode {
        program_id,
        program_name: program.name.clone(),
        max_gas_per_tick,
        local_count,
        retain_vars,
        allowed_write_tags: Vec::new(),
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
        (
            name.into(),
            SymbolEntry {
                local_index: idx,
                declared_type: ty,
            },
        )
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

        let bc = compile_program(&prog, "prog-1".into(), 1000).expect("ok");
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

        let bc = compile_program(&prog, "p".into(), 100).expect("ok");
        assert_eq!(bc.retain_vars.len(), 1);
        assert_eq!(bc.retain_vars[0].0, "persistent_counter");
        assert_eq!(bc.retain_vars[0].1, StValueType::Int);
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

        let err = compile_program(&prog, "p".into(), 100).expect_err("unsupported");
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
        let bc = compile_program(&prog, "p".into(), 100).expect("ok");
        assert_eq!(bc.opcodes, vec![Opcode::Return]);
    }
}
