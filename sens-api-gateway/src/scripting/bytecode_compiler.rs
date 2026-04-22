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
        Expression::FunctionCall { .. } => Err(CompileError::Unsupported {
            what: "function call (future stdlib-invoke batch)".to_string(),
        }),
    }
}

fn compile_binary_op(
    left: &Expression,
    op: &BinaryOp,
    right: &Expression,
    symbols: &SymbolTable,
) -> Result<(Vec<Opcode>, InferredType), CompileError> {
    let (mut left_ops, left_type) = compile_expression(left, symbols)?;
    let (right_ops, right_type) = compile_expression(right, symbols)?;

    // IEC 61131-3 Int → Real promotion for mixed
    // arithmetic. If one side is Real, the other gets
    // promoted via a runtime cast opcode. Batch 151
    // adds the CastIntToReal opcode + relaxes this
    // rule; Batch 149 keeps the compiler conservative
    // so the known-limit surfaces as an explicit
    // TypeMismatch error rather than silent behavior.
    if left_type != right_type {
        return Err(CompileError::TypeMismatch {
            op: format!("{:?}", op),
            left: left_type,
            right: right_type,
        });
    }

    left_ops.extend(right_ops);

    let (final_op, result_type) = match (op, left_type) {
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

/// Compile a single statement — append opcodes to
/// `ops` in-place.
///
/// Batch 150 covers:
/// - Assignment (to local variable) → expr + StoreLocal
/// - If-Then-Else(-ElsIf-Else) → branch + patch
/// - Return → Return opcode
/// - Empty → no-op (zero opcodes)
///
/// Batch 151+ adds While / For / Case / Repeat /
/// FunctionBlockCall.
pub fn compile_statement(
    stmt: &Statement,
    symbols: &SymbolTable,
    ops: &mut Vec<Opcode>,
) -> Result<(), CompileError> {
    match stmt {
        Statement::Empty => Ok(()),

        Statement::Return { .. } => {
            ops.push(Opcode::Return);
            Ok(())
        }

        Statement::Assignment { target, value, .. } => {
            // LHS MUST be a bare Variable — array /
            // member assignment defer to future batches.
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
        ),

        // Everything else is future-batch scope.
        Statement::While { .. } => Err(CompileError::Unsupported {
            what: "WHILE loop (Batch 151 adds loop compilation)".to_string(),
        }),
        Statement::For { .. } => Err(CompileError::Unsupported {
            what: "FOR loop (Batch 151 adds loop compilation)".to_string(),
        }),
        Statement::Repeat { .. } => Err(CompileError::Unsupported {
            what: "REPEAT loop (Batch 151 adds loop compilation)".to_string(),
        }),
        Statement::Case { .. } => Err(CompileError::Unsupported {
            what: "CASE statement (Batch 151+)".to_string(),
        }),
        Statement::FunctionBlockCall { .. } => Err(CompileError::Unsupported {
            what: "function block call (Batch 154 FB-integration)".to_string(),
        }),
        Statement::FunctionCall { .. } => Err(CompileError::Unsupported {
            what: "function call (Batch 154 stdlib-invoke)".to_string(),
        }),
        Statement::Exit { .. } => Err(CompileError::Unsupported {
            what: "EXIT (Batch 151 adds alongside loop support)".to_string(),
        }),
        Statement::Continue { .. } => Err(CompileError::Unsupported {
            what: "CONTINUE (Batch 151 adds alongside loop support)".to_string(),
        }),
    }
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
        compile_statement(s, symbols, ops)?;
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
            compile_statement(s, symbols, ops)?;
        }
        end_jump_slots.push(emit_placeholder_jump(ops));

        let after_elsif_idx = ops.len() as u32;
        patch_jump_if_false(ops, elsif_jump_slot, after_elsif_idx);
    }

    // ELSE branch (optional).
    if let Some(else_body) = else_body {
        for s in else_body {
            compile_statement(s, symbols, ops)?;
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
    for stmt in &program.body {
        compile_statement(stmt, &symbols, &mut opcodes)?;
    }
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
    fn compile_mixed_int_real_rejects_for_now() {
        // Batch 149 rejects mixed types; Batch 150/151
        // adds promotion opcode.
        let err = compile_expression(
            &Expression::BinaryOp {
                left: Box::new(Expression::IntLiteral(2)),
                op: BinaryOp::Add,
                right: Box::new(Expression::RealLiteral(3.5)),
            },
            &SymbolTable::new(),
        )
        .expect_err("mixed types rejected");
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

    #[test]
    fn compile_function_call_is_unsupported() {
        let err = compile_expression(
            &Expression::FunctionCall {
                name: "ABS".into(),
                args: vec![Expression::IntLiteral(1)],
            },
            &SymbolTable::new(),
        )
        .expect_err("unsupported");
        assert!(matches!(err, CompileError::Unsupported { .. }));
    }

    // ====================================================================
    // Batch 150 Faz 3 — statement compiler tests
    // ====================================================================

    #[test]
    fn compile_empty_statement_emits_nothing() {
        let mut ops = vec![];
        compile_statement(&Statement::Empty, &SymbolTable::new(), &mut ops)
            .expect("ok");
        assert!(ops.is_empty());
    }

    #[test]
    fn compile_return_statement_emits_return() {
        let mut ops = vec![];
        compile_statement(
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
        compile_statement(
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
        let err = compile_statement(
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
        let err = compile_statement(
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
        compile_statement(
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
        compile_statement(
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
        let err = compile_statement(
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

    #[test]
    fn compile_while_rejects_as_unsupported() {
        let mut ops = vec![];
        let err = compile_statement(
            &Statement::While {
                condition: Expression::BoolLiteral(true),
                body: vec![],
                span: None,
            },
            &SymbolTable::new(),
            &mut ops,
        )
        .expect_err("unsupported");
        assert!(matches!(err, CompileError::Unsupported { .. }));
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
