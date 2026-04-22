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

use super::bytecode::{Opcode, StValue, StValueType};
use crate::st_validator::{BinaryOp, Expression, UnaryOp};

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
}
