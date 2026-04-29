//! IEC 61131-3 Structured Text Parser and Validator
//!
//! A production-quality lexer, parser, type checker, and validator for
//! IEC 61131-3 Structured Text (ST) programs. Replaces the previous
//! regex-based approach with a proper AST-based analysis.
//!
//! ## Features
//! - Full lexer/tokenizer for ST keywords, operators, literals, comments
//! - Recursive descent parser producing a typed AST
//! - Type checking for assignments and expressions
//! - Validation: undefined refs, duplicates, type mismatches, safety checks
//!
//! ## Usage
//! ```rust
//! let result = validate_st(source);
//! if !result.valid {
//!     for err in &result.errors { eprintln!("{}", err); }
//! }
//! ```

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::sync::LazyLock;

// ============================================================================
// Error Types
// ============================================================================

/// Source location in the ST program
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub line: usize,
    pub column: usize,
}

impl fmt::Display for Span {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.line, self.column)
    }
}

/// Severity level for diagnostics
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Severity {
    Error,
    Warning,
    Info,
}

/// A validation error
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StError {
    pub message: String,
    pub span: Option<Span>,
    pub code: String,
}

impl fmt::Display for StError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(ref span) = self.span {
            write!(f, "[{}] {} at {}", self.code, self.message, span)
        } else {
            write!(f, "[{}] {}", self.code, self.message)
        }
    }
}

/// A validation warning
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StWarning {
    pub message: String,
    pub span: Option<Span>,
    pub code: String,
}

impl fmt::Display for StWarning {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(ref span) = self.span {
            write!(f, "[{}] {} at {}", self.code, self.message, span)
        } else {
            write!(f, "[{}] {}", self.code, self.message)
        }
    }
}

// ============================================================================
// Token Types (Lexer Output)
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum TokenKind {
    // Literals
    IntLiteral(i64),
    RealLiteral(f64),
    StringLiteral(String),
    BoolLiteral(bool),
    TimeLiteral(String),

    // Identifier
    Identifier(String),

    // Keywords - Declarations
    Program,
    EndProgram,
    FunctionBlock,
    EndFunctionBlock,
    Function,
    EndFunction,
    Var,
    VarInput,
    VarOutput,
    VarInOut,
    VarGlobal,
    EndVar,
    Retain,
    Constant,
    Type,
    EndType,
    Struct,
    EndStruct,

    // Keywords - Control flow
    If,
    Then,
    Elsif,
    Else,
    EndIf,
    Case,
    Of,
    EndCase,
    For,
    To,
    By,
    Do,
    EndFor,
    While,
    EndWhile,
    Repeat,
    Until,
    EndRepeat,
    Exit,
    Continue,
    Return,

    // Keywords - Data types
    KwBool,
    KwByte,
    KwWord,
    KwDword,
    KwLword,
    KwSint,
    KwInt,
    KwDint,
    KwLint,
    KwUsint,
    KwUint,
    KwUdint,
    KwUlint,
    KwReal,
    KwLreal,
    KwString,
    KwWstring,
    KwTime,
    KwDate,
    KwTod,
    KwDt,
    KwArray,

    // Operators
    Assign, // :=
    Plus,   // +
    Minus,  // -
    Star,   // *
    Slash,  // /
    Mod,    // MOD
    Power,  // **
    Eq,     // =
    Neq,    // <>
    Lt,     // <
    Gt,     // >
    Le,     // <=
    Ge,     // >=
    And,    // AND / &
    Or,     // OR
    Xor,    // XOR
    Not,    // NOT

    // Delimiters
    LParen,    // (
    RParen,    // )
    LBracket,  // [
    RBracket,  // ]
    Semicolon, // ;
    Colon,     // :
    Comma,     // ,
    Dot,       // .
    DotDot,    // ..

    // Special
    Eof,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Token {
    pub kind: TokenKind,
    pub span: Span,
}

// ============================================================================
// AST Types
// ============================================================================

/// Top-level parsed program unit
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ProgramUnit {
    Program(Program),
    FunctionBlockDecl(FunctionBlockDecl),
    FunctionDecl(FunctionDecl),
}

/// A PROGRAM declaration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Program {
    pub name: String,
    pub var_blocks: Vec<VarBlock>,
    pub body: Vec<Statement>,
    pub span: Option<Span>,
}

/// A FUNCTION_BLOCK declaration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionBlockDecl {
    pub name: String,
    pub var_blocks: Vec<VarBlock>,
    pub body: Vec<Statement>,
    pub span: Option<Span>,
}

/// A FUNCTION declaration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionDecl {
    pub name: String,
    pub return_type: DataType,
    pub var_blocks: Vec<VarBlock>,
    pub body: Vec<Statement>,
    pub span: Option<Span>,
}

/// Variable block (VAR, VAR_INPUT, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VarBlock {
    pub scope: VarScope,
    pub retain: bool,
    pub constant: bool,
    pub declarations: Vec<VarDeclaration>,
    pub span: Option<Span>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum VarScope {
    Local,
    Input,
    Output,
    InOut,
    Global,
}

/// A single variable declaration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VarDeclaration {
    pub name: String,
    pub data_type: DataType,
    pub initial_value: Option<Expression>,
    pub span: Option<Span>,
}

/// Data types
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DataType {
    Bool,
    Byte,
    Word,
    Dword,
    Lword,
    Sint,
    Int,
    Dint,
    Lint,
    Usint,
    Uint,
    Udint,
    Ulint,
    Real,
    Lreal,
    String(Option<usize>), // Optional max length
    Wstring(Option<usize>),
    Time,
    Date,
    TimeOfDay,
    DateAndTime,
    Array {
        base: Box<DataType>,
        lower: i64,
        upper: i64,
    },
    UserDefined(String),
}

impl DataType {
    /// Check if this type is numeric (integer or real)
    pub fn is_numeric(&self) -> bool {
        matches!(
            self,
            DataType::Sint
                | DataType::Int
                | DataType::Dint
                | DataType::Lint
                | DataType::Usint
                | DataType::Uint
                | DataType::Udint
                | DataType::Ulint
                | DataType::Real
                | DataType::Lreal
                | DataType::Byte
                | DataType::Word
                | DataType::Dword
                | DataType::Lword
        )
    }

    /// Check if this type is an integer type
    pub fn is_integer(&self) -> bool {
        matches!(
            self,
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
                | DataType::Lword
        )
    }

    /// Check if this type is a real (float) type
    pub fn is_real(&self) -> bool {
        matches!(self, DataType::Real | DataType::Lreal)
    }

    /// Check if two types are compatible for assignment
    pub fn is_compatible_with(&self, other: &DataType) -> bool {
        if self == other {
            return true;
        }
        // Numeric types are mutually compatible (with possible precision loss)
        if self.is_numeric() && other.is_numeric() {
            return true;
        }
        // String types are compatible
        if matches!(self, DataType::String(_)) && matches!(other, DataType::String(_)) {
            return true;
        }
        // UserDefined types match by name
        if let (DataType::UserDefined(a), DataType::UserDefined(b)) = (self, other) {
            return a.eq_ignore_ascii_case(b);
        }
        false
    }
}

impl fmt::Display for DataType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DataType::Bool => write!(f, "BOOL"),
            DataType::Byte => write!(f, "BYTE"),
            DataType::Word => write!(f, "WORD"),
            DataType::Dword => write!(f, "DWORD"),
            DataType::Lword => write!(f, "LWORD"),
            DataType::Sint => write!(f, "SINT"),
            DataType::Int => write!(f, "INT"),
            DataType::Dint => write!(f, "DINT"),
            DataType::Lint => write!(f, "LINT"),
            DataType::Usint => write!(f, "USINT"),
            DataType::Uint => write!(f, "UINT"),
            DataType::Udint => write!(f, "UDINT"),
            DataType::Ulint => write!(f, "ULINT"),
            DataType::Real => write!(f, "REAL"),
            DataType::Lreal => write!(f, "LREAL"),
            DataType::String(_) => write!(f, "STRING"),
            DataType::Wstring(_) => write!(f, "WSTRING"),
            DataType::Time => write!(f, "TIME"),
            DataType::Date => write!(f, "DATE"),
            DataType::TimeOfDay => write!(f, "TIME_OF_DAY"),
            DataType::DateAndTime => write!(f, "DATE_AND_TIME"),
            DataType::Array { base, lower, upper } => {
                write!(f, "ARRAY[{}..{}] OF {}", lower, upper, base)
            }
            DataType::UserDefined(name) => write!(f, "{}", name),
        }
    }
}

/// Statements
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Statement {
    Assignment {
        target: Expression,
        value: Expression,
        span: Option<Span>,
    },
    If {
        condition: Expression,
        then_body: Vec<Statement>,
        elsif_branches: Vec<(Expression, Vec<Statement>)>,
        else_body: Option<Vec<Statement>>,
        span: Option<Span>,
    },
    Case {
        expr: Expression,
        branches: Vec<(Vec<Expression>, Vec<Statement>)>,
        else_body: Option<Vec<Statement>>,
        span: Option<Span>,
    },
    For {
        variable: String,
        from: Expression,
        to: Expression,
        by: Option<Expression>,
        body: Vec<Statement>,
        span: Option<Span>,
    },
    While {
        condition: Expression,
        body: Vec<Statement>,
        span: Option<Span>,
    },
    Repeat {
        body: Vec<Statement>,
        condition: Expression,
        span: Option<Span>,
    },
    FunctionBlockCall {
        fb_name: String,
        assignments: Vec<(String, Expression)>,
        span: Option<Span>,
    },
    FunctionCall {
        name: String,
        args: Vec<Expression>,
        span: Option<Span>,
    },
    Return {
        value: Option<Expression>,
        span: Option<Span>,
    },
    Exit {
        span: Option<Span>,
    },
    Continue {
        span: Option<Span>,
    },
    Empty,
}

/// Expressions
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Expression {
    IntLiteral(i64),
    RealLiteral(f64),
    StringLiteral(String),
    BoolLiteral(bool),
    TimeLiteral(String),
    Variable(String, Option<Span>),
    ArrayAccess {
        array: Box<Expression>,
        index: Box<Expression>,
    },
    MemberAccess {
        object: Box<Expression>,
        member: String,
    },
    UnaryOp {
        op: UnaryOp,
        operand: Box<Expression>,
    },
    BinaryOp {
        left: Box<Expression>,
        op: BinaryOp,
        right: Box<Expression>,
    },
    FunctionCall {
        name: String,
        args: Vec<Expression>,
    },
    Parenthesized(Box<Expression>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum UnaryOp {
    Neg,
    Not,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Power,
    Eq,
    Neq,
    Lt,
    Gt,
    Le,
    Ge,
    And,
    Or,
    Xor,
}

// ============================================================================
// Public API Types
// ============================================================================

/// A parsed variable extracted from the program
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedVariable {
    pub name: String,
    pub data_type: String,
    pub scope: String,
    pub initial_value: Option<String>,
}

/// A parsed function block call found in the program
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedFunctionBlock {
    pub instance_name: String,
    pub fb_type: String,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
}

/// Result of validating an ST program
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationResult {
    pub valid: bool,
    pub errors: Vec<StError>,
    pub warnings: Vec<StWarning>,
    pub ast: Option<Program>,
    pub variables: Vec<ParsedVariable>,
    pub function_blocks: Vec<ParsedFunctionBlock>,
}

// ============================================================================
// Known Standard Function Blocks
// ============================================================================

/// Known IEC 61131-3 standard function blocks with their I/O signatures.
/// Initialized once via LazyLock - zero allocation after first access.
static KNOWN_FUNCTION_BLOCKS: LazyLock<
    HashMap<&'static str, (Vec<(&'static str, DataType)>, Vec<(&'static str, DataType)>)>,
> = LazyLock::new(|| {
    let mut map = HashMap::with_capacity(11);

    // Timers
    map.insert(
        "TON",
        (
            vec![("IN", DataType::Bool), ("PT", DataType::Time)],
            vec![("Q", DataType::Bool), ("ET", DataType::Time)],
        ),
    );
    map.insert(
        "TOF",
        (
            vec![("IN", DataType::Bool), ("PT", DataType::Time)],
            vec![("Q", DataType::Bool), ("ET", DataType::Time)],
        ),
    );
    map.insert(
        "TP",
        (
            vec![("IN", DataType::Bool), ("PT", DataType::Time)],
            vec![("Q", DataType::Bool), ("ET", DataType::Time)],
        ),
    );

    // Counters
    map.insert(
        "CTU",
        (
            vec![
                ("CU", DataType::Bool),
                ("RESET", DataType::Bool),
                ("PV", DataType::Int),
            ],
            vec![("Q", DataType::Bool), ("CV", DataType::Int)],
        ),
    );
    map.insert(
        "CTD",
        (
            vec![
                ("CD", DataType::Bool),
                ("LOAD", DataType::Bool),
                ("PV", DataType::Int),
            ],
            vec![("Q", DataType::Bool), ("CV", DataType::Int)],
        ),
    );
    map.insert(
        "CTUD",
        (
            vec![
                ("CU", DataType::Bool),
                ("CD", DataType::Bool),
                ("RESET", DataType::Bool),
                ("LOAD", DataType::Bool),
                ("PV", DataType::Int),
            ],
            vec![
                ("QU", DataType::Bool),
                ("QD", DataType::Bool),
                ("CV", DataType::Int),
            ],
        ),
    );

    // Bistable
    map.insert(
        "RS",
        (
            vec![("SET", DataType::Bool), ("RESET1", DataType::Bool)],
            vec![("Q1", DataType::Bool)],
        ),
    );
    map.insert(
        "SR",
        (
            vec![("SET1", DataType::Bool), ("RESET", DataType::Bool)],
            vec![("Q1", DataType::Bool)],
        ),
    );

    // Edge detection
    map.insert(
        "R_TRIG",
        (vec![("CLK", DataType::Bool)], vec![("Q", DataType::Bool)]),
    );
    map.insert(
        "F_TRIG",
        (vec![("CLK", DataType::Bool)], vec![("Q", DataType::Bool)]),
    );

    // PID
    map.insert(
        "PID",
        (
            vec![
                ("AUTO", DataType::Bool),
                ("PV", DataType::Real),
                ("SP", DataType::Real),
                ("KP", DataType::Real),
                ("TI", DataType::Time),
                ("TD", DataType::Time),
            ],
            vec![("OUT", DataType::Real)],
        ),
    );

    map
});

// ============================================================================
// Lexer
// ============================================================================

struct Lexer {
    source: Vec<char>,
    pos: usize,
    line: usize,
    col: usize,
}

impl Lexer {
    fn new(source: &str) -> Self {
        Self {
            source: source.chars().collect(),
            pos: 0,
            line: 1,
            col: 1,
        }
    }

    fn current(&self) -> Option<char> {
        self.source.get(self.pos).copied()
    }

    fn peek(&self) -> Option<char> {
        self.source.get(self.pos + 1).copied()
    }

    fn advance(&mut self) -> Option<char> {
        let ch = self.current()?;
        self.pos += 1;
        if ch == '\n' {
            self.line += 1;
            self.col = 1;
        } else {
            self.col += 1;
        }
        Some(ch)
    }

    fn span(&self) -> Span {
        Span {
            line: self.line,
            column: self.col,
        }
    }

    fn skip_whitespace(&mut self) {
        while let Some(ch) = self.current() {
            if ch.is_ascii_whitespace() {
                self.advance();
            } else {
                break;
            }
        }
    }

    fn skip_comment(&mut self) -> bool {
        // Block comment: (* ... *)
        if self.current() == Some('(') && self.peek() == Some('*') {
            self.advance(); // (
            self.advance(); // *
            let mut depth = 1;
            while depth > 0 {
                match self.current() {
                    None => break,
                    Some('(') if self.peek() == Some('*') => {
                        self.advance();
                        self.advance();
                        depth += 1;
                    }
                    Some('*') if self.peek() == Some(')') => {
                        self.advance();
                        self.advance();
                        depth -= 1;
                    }
                    _ => {
                        self.advance();
                    }
                }
            }
            return true;
        }
        // Line comment: // ...
        if self.current() == Some('/') && self.peek() == Some('/') {
            while let Some(ch) = self.current() {
                if ch == '\n' {
                    break;
                }
                self.advance();
            }
            return true;
        }
        false
    }

    fn read_number(&mut self, errors: &mut Vec<StError>) -> TokenKind {
        let mut s = String::new();
        let mut is_real = false;

        while let Some(ch) = self.current() {
            if ch.is_ascii_digit() || ch == '_' {
                if ch != '_' {
                    s.push(ch);
                }
                self.advance();
            } else if ch == '.' && self.peek() != Some('.') && !is_real {
                is_real = true;
                s.push(ch);
                self.advance();
            } else {
                break;
            }
        }

        // IEC 61131-3 based literals: 16#FF (hex), 8#77 (octal), 2#1010 (binary)
        if !is_real && self.current() == Some('#') {
            if let Ok(base) = s.parse::<u32>() {
                if matches!(base, 2 | 8 | 16) {
                    self.advance(); // consume '#'
                    let mut digits = String::new();
                    while let Some(ch) = self.current() {
                        if ch.is_ascii_alphanumeric() || ch == '_' {
                            if ch != '_' {
                                digits.push(ch);
                            }
                            self.advance();
                        } else {
                            break;
                        }
                    }
                    return match i64::from_str_radix(&digits, base) {
                        Ok(v) => TokenKind::IntLiteral(v),
                        Err(_) => {
                            errors.push(StError {
                                message: format!(
                                    "Integer literal overflow: base-{} value '{}' exceeds i64 range",
                                    base, digits
                                ),
                                span: Some(self.span()),
                                code: "E131".to_string(),
                            });
                            TokenKind::IntLiteral(0)
                        }
                    };
                }
            }
        }

        // Check for exponent
        if let Some(ch) = self.current() {
            if ch == 'e' || ch == 'E' {
                is_real = true;
                s.push(ch);
                self.advance();
                if let Some(sign) = self.current() {
                    if sign == '+' || sign == '-' {
                        s.push(sign);
                        self.advance();
                    }
                }
                while let Some(ch) = self.current() {
                    if ch.is_ascii_digit() {
                        s.push(ch);
                        self.advance();
                    } else {
                        break;
                    }
                }
            }
        }

        if is_real {
            match s.parse::<f64>() {
                Ok(v) if v.is_infinite() || v.is_nan() => {
                    errors.push(StError {
                        message: format!(
                            "Real literal overflow: value '{}' is not representable as f64",
                            s
                        ),
                        span: Some(self.span()),
                        code: "E132".to_string(),
                    });
                    TokenKind::RealLiteral(0.0)
                }
                Ok(v) => TokenKind::RealLiteral(v),
                Err(_) => {
                    errors.push(StError {
                        message: format!(
                            "Invalid real literal: '{}' cannot be parsed as a floating-point number",
                            s
                        ),
                        span: Some(self.span()),
                        code: "E132".to_string(),
                    });
                    TokenKind::RealLiteral(0.0)
                }
            }
        } else {
            match s.parse::<i64>() {
                Ok(v) => TokenKind::IntLiteral(v),
                Err(_) => {
                    errors.push(StError {
                        message: format!(
                            "Integer literal overflow: value '{}' exceeds i64 range",
                            s
                        ),
                        span: Some(self.span()),
                        code: "E131".to_string(),
                    });
                    TokenKind::IntLiteral(0)
                }
            }
        }
    }

    fn read_string(&mut self) -> TokenKind {
        let quote = self.advance().unwrap_or('\''); // consume opening quote
        let mut s = String::new();
        loop {
            match self.current() {
                None => break,
                Some(ch) if ch == quote => {
                    self.advance();
                    // Double quote is escape
                    if self.current() == Some(quote) {
                        s.push(quote);
                        self.advance();
                    } else {
                        break;
                    }
                }
                Some(ch) => {
                    s.push(ch);
                    self.advance();
                }
            }
        }
        TokenKind::StringLiteral(s)
    }

    fn read_identifier(&mut self) -> String {
        let mut s = String::new();
        while let Some(ch) = self.current() {
            if ch.is_ascii_alphanumeric() || ch == '_' {
                s.push(ch);
                self.advance();
            } else {
                break;
            }
        }
        s
    }

    fn keyword_or_ident(&self, word: &str) -> TokenKind {
        match word.to_uppercase().as_str() {
            "PROGRAM" => TokenKind::Program,
            "END_PROGRAM" => TokenKind::EndProgram,
            "FUNCTION_BLOCK" => TokenKind::FunctionBlock,
            "END_FUNCTION_BLOCK" => TokenKind::EndFunctionBlock,
            "FUNCTION" => TokenKind::Function,
            "END_FUNCTION" => TokenKind::EndFunction,
            "VAR_INPUT" => TokenKind::VarInput,
            "VAR_OUTPUT" => TokenKind::VarOutput,
            "VAR_IN_OUT" => TokenKind::VarInOut,
            "VAR_GLOBAL" => TokenKind::VarGlobal,
            "VAR" => TokenKind::Var,
            "END_VAR" => TokenKind::EndVar,
            "RETAIN" => TokenKind::Retain,
            "CONSTANT" => TokenKind::Constant,
            "TYPE" => TokenKind::Type,
            "END_TYPE" => TokenKind::EndType,
            "STRUCT" => TokenKind::Struct,
            "END_STRUCT" => TokenKind::EndStruct,
            "IF" => TokenKind::If,
            "THEN" => TokenKind::Then,
            "ELSIF" => TokenKind::Elsif,
            "ELSE" => TokenKind::Else,
            "END_IF" => TokenKind::EndIf,
            "CASE" => TokenKind::Case,
            "OF" => TokenKind::Of,
            "END_CASE" => TokenKind::EndCase,
            "FOR" => TokenKind::For,
            "TO" => TokenKind::To,
            "BY" => TokenKind::By,
            "DO" => TokenKind::Do,
            "END_FOR" => TokenKind::EndFor,
            "WHILE" => TokenKind::While,
            "END_WHILE" => TokenKind::EndWhile,
            "REPEAT" => TokenKind::Repeat,
            "UNTIL" => TokenKind::Until,
            "END_REPEAT" => TokenKind::EndRepeat,
            "EXIT" => TokenKind::Exit,
            "CONTINUE" => TokenKind::Continue,
            "RETURN" => TokenKind::Return,
            "TRUE" => TokenKind::BoolLiteral(true),
            "FALSE" => TokenKind::BoolLiteral(false),
            "AND" => TokenKind::And,
            "OR" => TokenKind::Or,
            "XOR" => TokenKind::Xor,
            "NOT" => TokenKind::Not,
            "MOD" => TokenKind::Mod,
            "BOOL" => TokenKind::KwBool,
            "BYTE" => TokenKind::KwByte,
            "WORD" => TokenKind::KwWord,
            "DWORD" => TokenKind::KwDword,
            "LWORD" => TokenKind::KwLword,
            "SINT" => TokenKind::KwSint,
            "INT" => TokenKind::KwInt,
            "DINT" => TokenKind::KwDint,
            "LINT" => TokenKind::KwLint,
            "USINT" => TokenKind::KwUsint,
            "UINT" => TokenKind::KwUint,
            "UDINT" => TokenKind::KwUdint,
            "ULINT" => TokenKind::KwUlint,
            "REAL" => TokenKind::KwReal,
            "LREAL" => TokenKind::KwLreal,
            "STRING" => TokenKind::KwString,
            "WSTRING" => TokenKind::KwWstring,
            "TIME" => TokenKind::KwTime,
            "DATE" => TokenKind::KwDate,
            "TOD" | "TIME_OF_DAY" => TokenKind::KwTod,
            "DT" | "DATE_AND_TIME" => TokenKind::KwDt,
            "ARRAY" => TokenKind::KwArray,
            _ => TokenKind::Identifier(word.to_string()),
        }
    }

    fn tokenize(&mut self) -> Result<Vec<Token>, Vec<StError>> {
        let mut tokens = Vec::new();
        let mut errors = Vec::new();

        loop {
            self.skip_whitespace();
            while self.skip_comment() {
                self.skip_whitespace();
            }

            let span = self.span();

            let ch = match self.current() {
                Some(ch) => ch,
                None => {
                    tokens.push(Token {
                        kind: TokenKind::Eof,
                        span,
                    });
                    break;
                }
            };

            let kind = match ch {
                // Numbers
                '0'..='9' => self.read_number(&mut errors),

                // String literals
                '\'' | '"' => self.read_string(),

                // Time literal: T# or TIME#
                'T' | 't' if self.peek() == Some('#') => {
                    self.advance(); // T
                    self.advance(); // #
                    let mut s = String::from("T#");
                    while let Some(c) = self.current() {
                        if c.is_ascii_alphanumeric() || c == '_' || c == '.' {
                            s.push(c);
                            self.advance();
                        } else {
                            break;
                        }
                    }
                    TokenKind::TimeLiteral(s)
                }

                // Identifiers and keywords
                'A'..='Z' | 'a'..='z' | '_' => {
                    let word = self.read_identifier();
                    // Check for time literal like TIME#
                    if word.eq_ignore_ascii_case("TIME") && self.current() == Some('#') {
                        self.advance(); // #
                        let mut s = String::from("T#");
                        while let Some(c) = self.current() {
                            if c.is_ascii_alphanumeric() || c == '_' || c == '.' {
                                s.push(c);
                                self.advance();
                            } else {
                                break;
                            }
                        }
                        TokenKind::TimeLiteral(s)
                    } else {
                        self.keyword_or_ident(&word)
                    }
                }

                // Operators and delimiters
                ':' => {
                    self.advance();
                    if self.current() == Some('=') {
                        self.advance();
                        TokenKind::Assign
                    } else {
                        TokenKind::Colon
                    }
                }
                ';' => {
                    self.advance();
                    TokenKind::Semicolon
                }
                ',' => {
                    self.advance();
                    TokenKind::Comma
                }
                '(' => {
                    self.advance();
                    TokenKind::LParen
                }
                ')' => {
                    self.advance();
                    TokenKind::RParen
                }
                '[' => {
                    self.advance();
                    TokenKind::LBracket
                }
                ']' => {
                    self.advance();
                    TokenKind::RBracket
                }
                '+' => {
                    self.advance();
                    TokenKind::Plus
                }
                '-' => {
                    self.advance();
                    TokenKind::Minus
                }
                '*' => {
                    self.advance();
                    if self.current() == Some('*') {
                        self.advance();
                        TokenKind::Power
                    } else {
                        TokenKind::Star
                    }
                }
                '/' => {
                    self.advance();
                    TokenKind::Slash
                }
                '=' => {
                    self.advance();
                    TokenKind::Eq
                }
                '<' => {
                    self.advance();
                    match self.current() {
                        Some('>') => {
                            self.advance();
                            TokenKind::Neq
                        }
                        Some('=') => {
                            self.advance();
                            TokenKind::Le
                        }
                        _ => TokenKind::Lt,
                    }
                }
                '>' => {
                    self.advance();
                    if self.current() == Some('=') {
                        self.advance();
                        TokenKind::Ge
                    } else {
                        TokenKind::Gt
                    }
                }
                '.' => {
                    self.advance();
                    if self.current() == Some('.') {
                        self.advance();
                        TokenKind::DotDot
                    } else {
                        TokenKind::Dot
                    }
                }
                '&' => {
                    self.advance();
                    TokenKind::And
                }
                '#' => {
                    // Could be a type-prefixed literal like INT#5.
                    // Skip to next whitespace/delimiter; future
                    // Phase 3 parser expansion splits the type
                    // prefix from the literal for type-checked
                    // constants.
                    self.advance();
                    let mut s = String::from("#");
                    while let Some(c) = self.current() {
                        if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' || c == '+'
                        {
                            s.push(c);
                            self.advance();
                        } else {
                            break;
                        }
                    }
                    // Try to parse as integer if it looks numeric
                    if let Ok(v) = s[1..].parse::<i64>() {
                        TokenKind::IntLiteral(v)
                    } else {
                        TokenKind::StringLiteral(s)
                    }
                }
                _ => {
                    errors.push(StError {
                        message: format!("Unexpected character: '{}'", ch),
                        span: Some(span.clone()),
                        code: "E001".to_string(),
                    });
                    self.advance();
                    continue;
                }
            };

            tokens.push(Token { kind, span });
        }

        if errors.is_empty() {
            Ok(tokens)
        } else {
            Err(errors)
        }
    }
}

// ============================================================================
// Parser
// ============================================================================

/// Maximum recursion depth for expression parsing (prevents stack overflow on malicious input)
const MAX_PARSE_DEPTH: usize = 64;

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
    errors: Vec<StError>,
    /// Current recursion depth for expression parsing
    depth: usize,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        Self {
            tokens,
            pos: 0,
            errors: Vec::new(),
            depth: 0,
        }
    }

    fn current(&self) -> &Token {
        self.tokens.get(self.pos).unwrap_or(&Token {
            kind: TokenKind::Eof,
            span: Span { line: 0, column: 0 },
        })
    }

    fn current_kind(&self) -> &TokenKind {
        &self.current().kind
    }

    fn current_span(&self) -> Span {
        self.current().span.clone()
    }

    fn advance(&mut self) -> &Token {
        let tok = self.tokens.get(self.pos).unwrap_or(&Token {
            kind: TokenKind::Eof,
            span: Span { line: 0, column: 0 },
        });
        if self.pos < self.tokens.len() {
            self.pos += 1;
        }
        tok
    }

    fn expect(&mut self, expected: &TokenKind) -> Result<Span, ()> {
        if std::mem::discriminant(self.current_kind()) == std::mem::discriminant(expected) {
            let span = self.current_span();
            self.advance();
            Ok(span)
        } else {
            self.errors.push(StError {
                message: format!("Expected {:?}, found {:?}", expected, self.current_kind()),
                span: Some(self.current_span()),
                code: "E100".to_string(),
            });
            Err(())
        }
    }

    fn eat(&mut self, expected: &TokenKind) -> bool {
        if std::mem::discriminant(self.current_kind()) == std::mem::discriminant(expected) {
            self.advance();
            true
        } else {
            false
        }
    }

    fn at_eof(&self) -> bool {
        matches!(self.current_kind(), TokenKind::Eof)
    }

    // ---- Top-level parsing ----

    fn parse_program_unit(&mut self) -> Option<Program> {
        let span = self.current_span();
        match self.current_kind().clone() {
            TokenKind::Program => {
                self.advance();
                let name = self.parse_identifier()?;
                let var_blocks = self.parse_var_blocks();
                let body = self.parse_statement_list(&[TokenKind::EndProgram]);
                if !self.eat(&TokenKind::EndProgram) {
                    self.errors.push(StError {
                        message: "Missing END_PROGRAM".to_string(),
                        span: Some(self.current_span()),
                        code: "E101".to_string(),
                    });
                }
                Some(Program {
                    name,
                    var_blocks,
                    body,
                    span: Some(span),
                })
            }
            TokenKind::FunctionBlock => {
                self.advance();
                let name = self.parse_identifier()?;
                let var_blocks = self.parse_var_blocks();
                let body = self.parse_statement_list(&[TokenKind::EndFunctionBlock]);
                if !self.eat(&TokenKind::EndFunctionBlock) {
                    self.errors.push(StError {
                        message: "Missing END_FUNCTION_BLOCK".to_string(),
                        span: Some(self.current_span()),
                        code: "E101".to_string(),
                    });
                }
                Some(Program {
                    name,
                    var_blocks,
                    body,
                    span: Some(span),
                })
            }
            TokenKind::Function => {
                self.advance();
                let name = self.parse_identifier()?;
                // Optional return type: FUNCTION name : RETURN_TYPE
                if self.eat(&TokenKind::Colon) {
                    let _ret_type = self.parse_data_type();
                }
                let var_blocks = self.parse_var_blocks();
                let body = self.parse_statement_list(&[TokenKind::EndFunction]);
                if !self.eat(&TokenKind::EndFunction) {
                    self.errors.push(StError {
                        message: "Missing END_FUNCTION".to_string(),
                        span: Some(self.current_span()),
                        code: "E101".to_string(),
                    });
                }
                Some(Program {
                    name,
                    var_blocks,
                    body,
                    span: Some(span),
                })
            }
            _ => {
                // Try parsing as implicit program (just var blocks + statements)
                let var_blocks = self.parse_var_blocks();
                if var_blocks.is_empty() && self.at_eof() {
                    return None;
                }
                let body = self.parse_statement_list(&[TokenKind::Eof]);
                Some(Program {
                    name: "main".to_string(),
                    var_blocks,
                    body,
                    span: Some(span),
                })
            }
        }
    }

    fn parse_identifier(&mut self) -> Option<String> {
        if let TokenKind::Identifier(name) = self.current_kind().clone() {
            self.advance();
            Some(name)
        } else {
            self.errors.push(StError {
                message: format!("Expected identifier, found {:?}", self.current_kind()),
                span: Some(self.current_span()),
                code: "E102".to_string(),
            });
            None
        }
    }

    // ---- Variable blocks ----

    fn parse_var_blocks(&mut self) -> Vec<VarBlock> {
        let mut blocks = Vec::new();
        loop {
            let span = self.current_span();
            let scope = match self.current_kind() {
                TokenKind::Var => {
                    self.advance();
                    VarScope::Local
                }
                TokenKind::VarInput => {
                    self.advance();
                    VarScope::Input
                }
                TokenKind::VarOutput => {
                    self.advance();
                    VarScope::Output
                }
                TokenKind::VarInOut => {
                    self.advance();
                    VarScope::InOut
                }
                TokenKind::VarGlobal => {
                    self.advance();
                    VarScope::Global
                }
                _ => break,
            };

            let retain = self.eat(&TokenKind::Retain);
            let constant = self.eat(&TokenKind::Constant);

            let mut declarations = Vec::new();
            while !matches!(self.current_kind(), TokenKind::EndVar | TokenKind::Eof) {
                if let Some(decl) = self.parse_var_declaration() {
                    declarations.push(decl);
                } else {
                    // Skip to next semicolon or END_VAR to recover
                    while !matches!(
                        self.current_kind(),
                        TokenKind::Semicolon | TokenKind::EndVar | TokenKind::Eof
                    ) {
                        self.advance();
                    }
                    self.eat(&TokenKind::Semicolon);
                }
            }

            if !self.eat(&TokenKind::EndVar) {
                self.errors.push(StError {
                    message: "Missing END_VAR".to_string(),
                    span: Some(self.current_span()),
                    code: "E103".to_string(),
                });
            }

            blocks.push(VarBlock {
                scope,
                retain,
                constant,
                declarations,
                span: Some(span),
            });
        }
        blocks
    }

    fn parse_var_declaration(&mut self) -> Option<VarDeclaration> {
        let span = self.current_span();
        let name = self.parse_identifier()?;
        if self.expect(&TokenKind::Colon).is_err() {
            return None;
        }
        let data_type = self.parse_data_type()?;

        let initial_value = if self.eat(&TokenKind::Assign) {
            Some(self.parse_expression())
        } else {
            None
        };

        self.eat(&TokenKind::Semicolon);

        Some(VarDeclaration {
            name,
            data_type,
            initial_value,
            span: Some(span),
        })
    }

    fn parse_data_type(&mut self) -> Option<DataType> {
        let dt = match self.current_kind().clone() {
            TokenKind::KwBool => {
                self.advance();
                DataType::Bool
            }
            TokenKind::KwByte => {
                self.advance();
                DataType::Byte
            }
            TokenKind::KwWord => {
                self.advance();
                DataType::Word
            }
            TokenKind::KwDword => {
                self.advance();
                DataType::Dword
            }
            TokenKind::KwLword => {
                self.advance();
                DataType::Lword
            }
            TokenKind::KwSint => {
                self.advance();
                DataType::Sint
            }
            TokenKind::KwInt => {
                self.advance();
                DataType::Int
            }
            TokenKind::KwDint => {
                self.advance();
                DataType::Dint
            }
            TokenKind::KwLint => {
                self.advance();
                DataType::Lint
            }
            TokenKind::KwUsint => {
                self.advance();
                DataType::Usint
            }
            TokenKind::KwUint => {
                self.advance();
                DataType::Uint
            }
            TokenKind::KwUdint => {
                self.advance();
                DataType::Udint
            }
            TokenKind::KwUlint => {
                self.advance();
                DataType::Ulint
            }
            TokenKind::KwReal => {
                self.advance();
                DataType::Real
            }
            TokenKind::KwLreal => {
                self.advance();
                DataType::Lreal
            }
            TokenKind::KwString => {
                self.advance();
                let len = if self.eat(&TokenKind::LBracket) {
                    let n = self.parse_int_literal();
                    self.eat(&TokenKind::RBracket);
                    Some(n as usize)
                } else {
                    None
                };
                DataType::String(len)
            }
            TokenKind::KwWstring => {
                self.advance();
                let len = if self.eat(&TokenKind::LBracket) {
                    let n = self.parse_int_literal();
                    self.eat(&TokenKind::RBracket);
                    Some(n as usize)
                } else {
                    None
                };
                DataType::Wstring(len)
            }
            TokenKind::KwTime => {
                self.advance();
                DataType::Time
            }
            TokenKind::KwDate => {
                self.advance();
                DataType::Date
            }
            TokenKind::KwTod => {
                self.advance();
                DataType::TimeOfDay
            }
            TokenKind::KwDt => {
                self.advance();
                DataType::DateAndTime
            }
            TokenKind::KwArray => {
                self.advance();
                self.eat(&TokenKind::LBracket);
                let lower = self.parse_int_literal();
                self.eat(&TokenKind::DotDot);
                let upper = self.parse_int_literal();
                self.eat(&TokenKind::RBracket);
                // OF keyword
                self.eat(&TokenKind::Of);
                let base = self.parse_data_type()?;
                DataType::Array {
                    base: Box::new(base),
                    lower,
                    upper,
                }
            }
            TokenKind::Identifier(name) => {
                self.advance();
                DataType::UserDefined(name)
            }
            _ => {
                self.errors.push(StError {
                    message: format!("Expected data type, found {:?}", self.current_kind()),
                    span: Some(self.current_span()),
                    code: "E104".to_string(),
                });
                return None;
            }
        };
        Some(dt)
    }

    fn parse_int_literal(&mut self) -> i64 {
        // Handle negative literals
        let neg = self.eat(&TokenKind::Minus);
        if let TokenKind::IntLiteral(v) = self.current_kind().clone() {
            self.advance();
            if neg { -v } else { v }
        } else {
            self.errors.push(StError {
                message: format!("Expected integer literal, found {:?}", self.current_kind()),
                span: Some(self.current_span()),
                code: "E105".to_string(),
            });
            0
        }
    }

    // ---- Statement parsing ----

    fn parse_statement_list(&mut self, terminators: &[TokenKind]) -> Vec<Statement> {
        let mut stmts = Vec::new();
        let mut safety_counter = 0;
        let max_iterations = self.tokens.len() + 1;

        while !self.at_eof() && safety_counter < max_iterations {
            safety_counter += 1;

            // Check terminators
            let should_stop = terminators
                .iter()
                .any(|t| std::mem::discriminant(self.current_kind()) == std::mem::discriminant(t));
            if should_stop {
                break;
            }

            // Skip stray semicolons
            if self.eat(&TokenKind::Semicolon) {
                continue;
            }

            let before = self.pos;
            if let Some(stmt) = self.parse_statement() {
                stmts.push(stmt);
            }

            // Ensure progress
            if self.pos == before {
                self.advance();
            }
        }
        stmts
    }

    fn parse_statement(&mut self) -> Option<Statement> {
        let span = self.current_span();
        match self.current_kind().clone() {
            TokenKind::If => self.parse_if_statement(),
            TokenKind::Case => self.parse_case_statement(),
            TokenKind::For => self.parse_for_statement(),
            TokenKind::While => self.parse_while_statement(),
            TokenKind::Repeat => self.parse_repeat_statement(),
            TokenKind::Return => {
                self.advance();
                let value = if !matches!(self.current_kind(), TokenKind::Semicolon | TokenKind::Eof)
                {
                    Some(self.parse_expression())
                } else {
                    None
                };
                self.eat(&TokenKind::Semicolon);
                Some(Statement::Return {
                    value,
                    span: Some(span),
                })
            }
            TokenKind::Exit => {
                self.advance();
                self.eat(&TokenKind::Semicolon);
                Some(Statement::Exit { span: Some(span) })
            }
            TokenKind::Continue => {
                self.advance();
                self.eat(&TokenKind::Semicolon);
                Some(Statement::Continue { span: Some(span) })
            }
            TokenKind::Identifier(_) => self.parse_assignment_or_call(),
            _ => {
                // Unknown token in statement position
                self.errors.push(StError {
                    message: format!("Unexpected token in statement: {:?}", self.current_kind()),
                    span: Some(self.current_span()),
                    code: "E110".to_string(),
                });
                None
            }
        }
    }

    fn parse_if_statement(&mut self) -> Option<Statement> {
        let span = self.current_span();
        self.advance(); // IF
        let condition = self.parse_expression();
        self.expect(&TokenKind::Then).ok();

        let then_body =
            self.parse_statement_list(&[TokenKind::Elsif, TokenKind::Else, TokenKind::EndIf]);

        let mut elsif_branches = Vec::new();
        while self.eat(&TokenKind::Elsif) {
            let cond = self.parse_expression();
            self.expect(&TokenKind::Then).ok();
            let body =
                self.parse_statement_list(&[TokenKind::Elsif, TokenKind::Else, TokenKind::EndIf]);
            elsif_branches.push((cond, body));
        }

        let else_body = if self.eat(&TokenKind::Else) {
            Some(self.parse_statement_list(&[TokenKind::EndIf]))
        } else {
            None
        };

        if !self.eat(&TokenKind::EndIf) {
            self.errors.push(StError {
                message: "Missing END_IF".to_string(),
                span: Some(self.current_span()),
                code: "E111".to_string(),
            });
        }
        self.eat(&TokenKind::Semicolon);

        Some(Statement::If {
            condition,
            then_body,
            elsif_branches,
            else_body,
            span: Some(span),
        })
    }

    fn parse_case_statement(&mut self) -> Option<Statement> {
        let span = self.current_span();
        self.advance(); // CASE
        let expr = self.parse_expression();
        self.expect(&TokenKind::Of).ok();

        let mut branches = Vec::new();
        let mut else_body = None;

        loop {
            if matches!(self.current_kind(), TokenKind::EndCase | TokenKind::Eof) {
                break;
            }
            if self.eat(&TokenKind::Else) {
                else_body = Some(self.parse_statement_list(&[TokenKind::EndCase]));
                break;
            }

            // Parse case labels: expr [ .. expr ] , ... :
            //
            // Batch 178 Faz 3: recognizes the IEC 61131-3
            // range syntax `lo..hi` at the label level.
            // Ranges expand at parse time into the
            // enumerated IntLiteral list so downstream
            // compile_case logic (Batch 174) stays
            // unchanged. Parse-time expansion is capped
            // at CASE_RANGE_MAX_EXPANSION to protect
            // against operator-specified ranges that
            // would blow up opcode count.
            const CASE_RANGE_MAX_EXPANSION: i64 = 256;
            let mut labels = Vec::new();
            loop {
                let first = self.parse_expression();
                if self.eat(&TokenKind::DotDot) {
                    let upper = self.parse_expression();
                    match (&first, &upper) {
                        (Expression::IntLiteral(lo), Expression::IntLiteral(hi)) => {
                            let (lo, hi) = (*lo, *hi);
                            if hi < lo {
                                self.errors.push(StError {
                                    message: format!(
                                        "CASE range `{}..{}` has inverted bounds",
                                        lo, hi
                                    ),
                                    span: Some(self.current_span()),
                                    code: "E203".to_string(),
                                });
                            } else if hi - lo + 1 > CASE_RANGE_MAX_EXPANSION {
                                self.errors.push(StError {
                                    message: format!(
                                        "CASE range `{}..{}` expansion exceeds the {}-label cap",
                                        lo, hi, CASE_RANGE_MAX_EXPANSION
                                    ),
                                    span: Some(self.current_span()),
                                    code: "E204".to_string(),
                                });
                            } else {
                                for v in lo..=hi {
                                    labels.push(Expression::IntLiteral(v));
                                }
                            }
                        }
                        _ => {
                            self.errors.push(StError {
                                message: "CASE range `..` requires integer literals on both sides"
                                    .to_string(),
                                span: Some(self.current_span()),
                                code: "E205".to_string(),
                            });
                            // Fall back to the single-expr
                            // form so parsing continues.
                            labels.push(first);
                        }
                    }
                } else {
                    labels.push(first);
                }
                if !self.eat(&TokenKind::Comma) {
                    break;
                }
            }
            self.expect(&TokenKind::Colon).ok();

            // Batch 85 fix of ORPHAN-HIGH-013 #6: the prior
            // termination list included `Identifier(String::new())`
            // + `IntLiteral(0)` as stop-on-any-ident/int via
            // discriminant match. That wrongly treated the FIRST
            // identifier of a body statement (e.g. `output` in
            // `output := 0`) as the start of the NEXT case label,
            // making parse_statement_list return empty + leaving
            // the outer loop to re-parse `output` as a label and
            // expect `:` where `:=` actually sat. The error cascade
            // produced "Expected Colon, found Assign".
            //
            // Post-fix: use a peek-based custom body loop. Body
            // statements consume until we see Else / EndCase / Eof
            // OR the PEEK pattern `<expr-start> :` where the colon
            // is a BARE Colon (not Assign `:=`). This correctly
            // distinguishes `output :=` (statement) from `1:` or
            // `my_enum_value:` (case label).
            let mut body = Vec::new();
            let body_max_iter = self.tokens.len() + 1;
            let mut body_safety = 0;
            while !self.at_eof() && body_safety < body_max_iter {
                body_safety += 1;
                if matches!(
                    self.current_kind(),
                    TokenKind::Else | TokenKind::EndCase | TokenKind::Eof
                ) {
                    break;
                }
                // Peek for case-label pattern: <int-literal | ident>
                // followed by Colon (NOT Assign). If matched, the
                // outer loop will re-parse this as the next label.
                if self.is_case_label_lookahead() {
                    break;
                }
                if self.eat(&TokenKind::Semicolon) {
                    continue;
                }
                let before = self.pos;
                if let Some(stmt) = self.parse_statement() {
                    body.push(stmt);
                }
                if self.pos == before {
                    self.advance();
                }
            }
            branches.push((labels, body));
        }

        if !self.eat(&TokenKind::EndCase) {
            self.errors.push(StError {
                message: "Missing END_CASE".to_string(),
                span: Some(self.current_span()),
                code: "E112".to_string(),
            });
        }
        self.eat(&TokenKind::Semicolon);

        Some(Statement::Case {
            expr,
            branches,
            else_body,
            span: Some(span),
        })
    }

    /// Batch 85 helper for CASE body parsing. Returns true iff
    /// the current token is an integer literal or identifier
    /// AND the NEXT token is a bare `Colon` (not `Assign`).
    /// This is the "next case label" signature — body should
    /// terminate so the outer loop can parse the label.
    ///
    /// WHY lookahead (not just stop-on-ident): an identifier
    /// inside a case BODY is typically a variable on the LHS of
    /// an assignment (`output := 0;`). The next token after
    /// `output` is `Assign` (`:=`), NOT bare `Colon`. By
    /// distinguishing these we allow ident-starting body
    /// statements to parse correctly while still detecting
    /// enum-identifier case labels (e.g. `MyEnum.Red:`).
    fn is_case_label_lookahead(&self) -> bool {
        // Batch 178 Faz 3: extended to recognize multi-
        // value + range CASE labels in the form
        // `<int|ident> [ .. <int|ident> ] (, <int|ident>
        // [ .. <int|ident> ])* :`.
        //
        // Walks forward through the token stream,
        // consuming a label sequence + stopping at a
        // terminating `:` (label) or returning false on
        // `:=` (statement) or anything unexpected.
        let mut idx = self.pos;
        // Must start with a label atom.
        loop {
            // Expect atom: IntLiteral or Identifier.
            match self.tokens.get(idx).map(|t| &t.kind) {
                Some(TokenKind::IntLiteral(_)) | Some(TokenKind::Identifier(_)) => {
                    idx += 1;
                }
                _ => return false,
            }
            // Optional `.. <atom>` range tail.
            if matches!(
                self.tokens.get(idx).map(|t| &t.kind),
                Some(TokenKind::DotDot)
            ) {
                idx += 1;
                match self.tokens.get(idx).map(|t| &t.kind) {
                    Some(TokenKind::IntLiteral(_)) | Some(TokenKind::Identifier(_)) => {
                        idx += 1;
                    }
                    _ => return false,
                }
            }
            // Terminator: `:` → label; `,` → next atom;
            // `:=` or anything else → not a label.
            match self.tokens.get(idx).map(|t| &t.kind) {
                Some(TokenKind::Colon) => return true,
                Some(TokenKind::Comma) => {
                    idx += 1;
                    continue;
                }
                _ => return false,
            }
        }
    }

    fn parse_for_statement(&mut self) -> Option<Statement> {
        let span = self.current_span();
        self.advance(); // FOR
        let variable = self.parse_identifier()?;
        self.expect(&TokenKind::Assign).ok();
        let from = self.parse_expression();
        self.expect(&TokenKind::To).ok();
        let to = self.parse_expression();
        let by = if self.eat(&TokenKind::By) {
            Some(self.parse_expression())
        } else {
            None
        };
        self.expect(&TokenKind::Do).ok();
        let body = self.parse_statement_list(&[TokenKind::EndFor]);
        if !self.eat(&TokenKind::EndFor) {
            self.errors.push(StError {
                message: "Missing END_FOR".to_string(),
                span: Some(self.current_span()),
                code: "E113".to_string(),
            });
        }
        self.eat(&TokenKind::Semicolon);

        Some(Statement::For {
            variable,
            from,
            to,
            by,
            body,
            span: Some(span),
        })
    }

    fn parse_while_statement(&mut self) -> Option<Statement> {
        let span = self.current_span();
        self.advance(); // WHILE
        let condition = self.parse_expression();
        self.expect(&TokenKind::Do).ok();
        let body = self.parse_statement_list(&[TokenKind::EndWhile]);
        if !self.eat(&TokenKind::EndWhile) {
            self.errors.push(StError {
                message: "Missing END_WHILE".to_string(),
                span: Some(self.current_span()),
                code: "E114".to_string(),
            });
        }
        self.eat(&TokenKind::Semicolon);

        Some(Statement::While {
            condition,
            body,
            span: Some(span),
        })
    }

    fn parse_repeat_statement(&mut self) -> Option<Statement> {
        let span = self.current_span();
        self.advance(); // REPEAT
        let body = self.parse_statement_list(&[TokenKind::Until]);
        if !self.eat(&TokenKind::Until) {
            self.errors.push(StError {
                message: "Missing UNTIL".to_string(),
                span: Some(self.current_span()),
                code: "E115".to_string(),
            });
        }
        let condition = self.parse_expression();
        self.eat(&TokenKind::Semicolon);

        if !self.eat(&TokenKind::EndRepeat) {
            self.errors.push(StError {
                message: "Missing END_REPEAT".to_string(),
                span: Some(self.current_span()),
                code: "E116".to_string(),
            });
        }
        self.eat(&TokenKind::Semicolon);

        Some(Statement::Repeat {
            body,
            condition,
            span: Some(span),
        })
    }

    fn parse_assignment_or_call(&mut self) -> Option<Statement> {
        let span = self.current_span();
        let name = if let TokenKind::Identifier(n) = self.current_kind().clone() {
            self.advance();
            n
        } else {
            return None;
        };

        // Function block call: name(IN := expr, ...)
        if self.eat(&TokenKind::LParen) {
            // Check if this is a named-parameter FB call or positional function call
            // Peek ahead: if we see IDENT := then it's FB call
            let is_fb_call = matches!(self.current_kind(), TokenKind::Identifier(_))
                && self.tokens.get(self.pos + 1).map(|t| &t.kind) == Some(&TokenKind::Assign);

            if is_fb_call {
                let mut assignments = Vec::new();
                loop {
                    if matches!(self.current_kind(), TokenKind::RParen | TokenKind::Eof) {
                        break;
                    }
                    let param_name = self.parse_identifier()?;
                    self.expect(&TokenKind::Assign).ok();
                    let value = self.parse_expression();
                    assignments.push((param_name, value));
                    if !self.eat(&TokenKind::Comma) {
                        break;
                    }
                }
                self.expect(&TokenKind::RParen).ok();
                self.eat(&TokenKind::Semicolon);

                Some(Statement::FunctionBlockCall {
                    fb_name: name,
                    assignments,
                    span: Some(span),
                })
            } else {
                // Positional function call
                let mut args = Vec::new();
                if !matches!(self.current_kind(), TokenKind::RParen) {
                    args.push(self.parse_expression());
                    while self.eat(&TokenKind::Comma) {
                        args.push(self.parse_expression());
                    }
                }
                self.expect(&TokenKind::RParen).ok();
                self.eat(&TokenKind::Semicolon);

                Some(Statement::FunctionCall {
                    name,
                    args,
                    span: Some(span),
                })
            }
        }
        // Member access or array access before assignment
        else {
            let mut target = Expression::Variable(name, Some(span.clone()));

            // Handle chained member access and array access
            loop {
                if self.eat(&TokenKind::Dot) {
                    let member = self.parse_identifier()?;
                    target = Expression::MemberAccess {
                        object: Box::new(target),
                        member,
                    };
                } else if self.eat(&TokenKind::LBracket) {
                    let index = self.parse_expression();
                    self.expect(&TokenKind::RBracket).ok();
                    target = Expression::ArrayAccess {
                        array: Box::new(target),
                        index: Box::new(index),
                    };
                } else {
                    break;
                }
            }

            // Assignment
            if self.eat(&TokenKind::Assign) {
                let value = self.parse_expression();
                self.eat(&TokenKind::Semicolon);
                Some(Statement::Assignment {
                    target,
                    value,
                    span: Some(span),
                })
            } else {
                self.eat(&TokenKind::Semicolon);
                // Bare identifier with semicolon, treat as empty/noop
                Some(Statement::Empty)
            }
        }
    }

    // ---- Expression parsing (Pratt / precedence climbing) ----

    fn parse_expression(&mut self) -> Expression {
        self.depth += 1;
        if self.depth > MAX_PARSE_DEPTH {
            self.errors.push(StError {
                message: "Expression nesting too deep (max 64 levels)".to_string(),
                span: Some(self.current_span()),
                code: "E130".to_string(),
            });
            self.depth -= 1;
            return Expression::IntLiteral(0);
        }
        let expr = self.parse_or_expr();
        self.depth -= 1;
        expr
    }

    fn parse_or_expr(&mut self) -> Expression {
        let mut left = self.parse_xor_expr();
        while matches!(self.current_kind(), TokenKind::Or) {
            self.advance();
            let right = self.parse_xor_expr();
            left = Expression::BinaryOp {
                left: Box::new(left),
                op: BinaryOp::Or,
                right: Box::new(right),
            };
        }
        left
    }

    fn parse_xor_expr(&mut self) -> Expression {
        let mut left = self.parse_and_expr();
        while matches!(self.current_kind(), TokenKind::Xor) {
            self.advance();
            let right = self.parse_and_expr();
            left = Expression::BinaryOp {
                left: Box::new(left),
                op: BinaryOp::Xor,
                right: Box::new(right),
            };
        }
        left
    }

    fn parse_and_expr(&mut self) -> Expression {
        let mut left = self.parse_comparison();
        while matches!(self.current_kind(), TokenKind::And) {
            self.advance();
            let right = self.parse_comparison();
            left = Expression::BinaryOp {
                left: Box::new(left),
                op: BinaryOp::And,
                right: Box::new(right),
            };
        }
        left
    }

    fn parse_comparison(&mut self) -> Expression {
        let left = self.parse_additive();
        let op = match self.current_kind() {
            TokenKind::Eq => BinaryOp::Eq,
            TokenKind::Neq => BinaryOp::Neq,
            TokenKind::Lt => BinaryOp::Lt,
            TokenKind::Gt => BinaryOp::Gt,
            TokenKind::Le => BinaryOp::Le,
            TokenKind::Ge => BinaryOp::Ge,
            _ => return left,
        };
        self.advance();
        let right = self.parse_additive();
        Expression::BinaryOp {
            left: Box::new(left),
            op,
            right: Box::new(right),
        }
    }

    fn parse_additive(&mut self) -> Expression {
        let mut left = self.parse_multiplicative();
        loop {
            let op = match self.current_kind() {
                TokenKind::Plus => BinaryOp::Add,
                TokenKind::Minus => BinaryOp::Sub,
                _ => break,
            };
            self.advance();
            let right = self.parse_multiplicative();
            left = Expression::BinaryOp {
                left: Box::new(left),
                op,
                right: Box::new(right),
            };
        }
        left
    }

    fn parse_multiplicative(&mut self) -> Expression {
        let mut left = self.parse_power();
        loop {
            let op = match self.current_kind() {
                TokenKind::Star => BinaryOp::Mul,
                TokenKind::Slash => BinaryOp::Div,
                TokenKind::Mod => BinaryOp::Mod,
                _ => break,
            };
            self.advance();
            let right = self.parse_power();
            left = Expression::BinaryOp {
                left: Box::new(left),
                op,
                right: Box::new(right),
            };
        }
        left
    }

    fn parse_power(&mut self) -> Expression {
        let left = self.parse_unary();
        if matches!(self.current_kind(), TokenKind::Power) {
            self.advance();
            // Right-associative per IEC 61131-3: 2**3**4 = 2**(3**4)
            let right = self.parse_power();
            Expression::BinaryOp {
                left: Box::new(left),
                op: BinaryOp::Power,
                right: Box::new(right),
            }
        } else {
            left
        }
    }

    fn parse_unary(&mut self) -> Expression {
        match self.current_kind().clone() {
            TokenKind::Not => {
                self.advance();
                let operand = self.parse_unary();
                Expression::UnaryOp {
                    op: UnaryOp::Not,
                    operand: Box::new(operand),
                }
            }
            TokenKind::Minus => {
                self.advance();
                let operand = self.parse_unary();
                Expression::UnaryOp {
                    op: UnaryOp::Neg,
                    operand: Box::new(operand),
                }
            }
            _ => self.parse_primary(),
        }
    }

    fn parse_primary(&mut self) -> Expression {
        let span = self.current_span();
        match self.current_kind().clone() {
            TokenKind::IntLiteral(v) => {
                self.advance();
                Expression::IntLiteral(v)
            }
            TokenKind::RealLiteral(v) => {
                self.advance();
                Expression::RealLiteral(v)
            }
            TokenKind::StringLiteral(s) => {
                self.advance();
                Expression::StringLiteral(s)
            }
            TokenKind::BoolLiteral(v) => {
                self.advance();
                Expression::BoolLiteral(v)
            }
            TokenKind::TimeLiteral(s) => {
                self.advance();
                Expression::TimeLiteral(s)
            }
            TokenKind::LParen => {
                self.advance();
                let expr = self.parse_expression();
                self.expect(&TokenKind::RParen).ok();
                Expression::Parenthesized(Box::new(expr))
            }
            TokenKind::Identifier(name) => {
                self.advance();
                // Function call: name(args)
                if self.eat(&TokenKind::LParen) {
                    let mut args = Vec::new();
                    if !matches!(self.current_kind(), TokenKind::RParen) {
                        args.push(self.parse_expression());
                        while self.eat(&TokenKind::Comma) {
                            args.push(self.parse_expression());
                        }
                    }
                    self.expect(&TokenKind::RParen).ok();
                    Expression::FunctionCall { name, args }
                }
                // Member access
                else if self.eat(&TokenKind::Dot) {
                    let member = self.parse_identifier().unwrap_or_default();
                    Expression::MemberAccess {
                        object: Box::new(Expression::Variable(name, Some(span))),
                        member,
                    }
                }
                // Array access
                else if self.eat(&TokenKind::LBracket) {
                    let index = self.parse_expression();
                    self.expect(&TokenKind::RBracket).ok();
                    Expression::ArrayAccess {
                        array: Box::new(Expression::Variable(name, Some(span))),
                        index: Box::new(index),
                    }
                } else {
                    Expression::Variable(name, Some(span))
                }
            }
            _ => {
                self.errors.push(StError {
                    message: format!("Expected expression, found {:?}", self.current_kind()),
                    span: Some(self.current_span()),
                    code: "E120".to_string(),
                });
                // Return a dummy expression to allow recovery
                self.advance();
                Expression::IntLiteral(0)
            }
        }
    }
}

// ============================================================================
// Type Checker & Validator
// ============================================================================

struct Validator {
    /// All declared variables: name -> (DataType, scope, declared_span)
    variables: HashMap<String, (DataType, VarScope, Option<Span>)>,
    /// Known function block instances: instance_name -> fb_type_name
    fb_instances: HashMap<String, String>,
    /// Collected errors
    errors: Vec<StError>,
    /// Collected warnings
    warnings: Vec<StWarning>,
    /// Current program/FB name (for recursion detection)
    current_unit_name: String,
    /// Loop nesting depth (for EXIT validation)
    loop_depth: usize,
}

impl Validator {
    fn new() -> Self {
        Self {
            variables: HashMap::new(),
            fb_instances: HashMap::new(),
            errors: Vec::new(),
            warnings: Vec::new(),
            current_unit_name: String::new(),
            loop_depth: 0,
        }
    }

    fn validate_program(&mut self, program: &Program) {
        self.current_unit_name = program.name.clone();

        // 1. Register all variables and check for duplicates
        for block in &program.var_blocks {
            for decl in &block.declarations {
                let upper_name = decl.name.to_uppercase();
                if self.variables.contains_key(&upper_name) {
                    self.errors.push(StError {
                        message: format!("Duplicate variable declaration: '{}'", decl.name),
                        span: decl.span.clone(),
                        code: "E200".to_string(),
                    });
                } else {
                    self.variables.insert(
                        upper_name.clone(),
                        (
                            decl.data_type.clone(),
                            block.scope.clone(),
                            decl.span.clone(),
                        ),
                    );
                }

                // Check if the variable type is a known FB type (instance declaration)
                if let DataType::UserDefined(ref type_name) = decl.data_type {
                    let upper_type = type_name.to_uppercase();
                    if KNOWN_FUNCTION_BLOCKS.contains_key(upper_type.as_str()) {
                        self.fb_instances.insert(upper_name, upper_type);
                    }
                }

                // Validate initial value type compatibility
                if let Some(ref init_val) = decl.initial_value {
                    let init_type = self.infer_expression_type(init_val);
                    if let Some(init_t) = init_type {
                        if !decl.data_type.is_compatible_with(&init_t) {
                            self.errors.push(StError {
                                message: format!(
                                    "Type mismatch in initializer for '{}': expected {}, got {}",
                                    decl.name, decl.data_type, init_t
                                ),
                                span: decl.span.clone(),
                                code: "E201".to_string(),
                            });
                        }
                    }
                }
            }
        }

        // 2. Validate statements
        for stmt in &program.body {
            self.validate_statement(stmt);
        }
    }

    fn validate_statement(&mut self, stmt: &Statement) {
        match stmt {
            Statement::Assignment {
                target,
                value,
                span,
            } => {
                let target_type = self.infer_expression_type(target);
                let value_type = self.infer_expression_type(value);
                self.check_variable_references(target);
                self.check_variable_references(value);

                if let (Some(tt), Some(vt)) = (&target_type, &value_type) {
                    if !tt.is_compatible_with(vt) {
                        self.errors.push(StError {
                            message: format!(
                                "Type mismatch in assignment: cannot assign {} to {}",
                                vt, tt
                            ),
                            span: span.clone(),
                            code: "E210".to_string(),
                        });
                    }
                    // Warn on precision loss
                    if tt.is_integer() && vt.is_real() {
                        self.warnings.push(StWarning {
                            message: format!("Possible precision loss: assigning {} to {}", vt, tt),
                            span: span.clone(),
                            code: "W210".to_string(),
                        });
                    }
                }
            }
            Statement::If {
                condition,
                then_body,
                elsif_branches,
                else_body,
                ..
            } => {
                self.check_variable_references(condition);
                let cond_type = self.infer_expression_type(condition);
                if let Some(ref ct) = cond_type {
                    if *ct != DataType::Bool && !ct.is_numeric() {
                        self.errors.push(StError {
                            message: format!("IF condition must be BOOL, got {}", ct),
                            span: None,
                            code: "E211".to_string(),
                        });
                    }
                }

                for s in then_body {
                    self.validate_statement(s);
                }
                for (cond, body) in elsif_branches {
                    self.check_variable_references(cond);
                    for s in body {
                        self.validate_statement(s);
                    }
                }
                if let Some(body) = else_body {
                    for s in body {
                        self.validate_statement(s);
                    }
                }
            }
            Statement::Case {
                expr,
                branches,
                else_body,
                ..
            } => {
                self.check_variable_references(expr);
                for (labels, body) in branches {
                    for label in labels {
                        self.check_variable_references(label);
                    }
                    for s in body {
                        self.validate_statement(s);
                    }
                }
                if let Some(body) = else_body {
                    for s in body {
                        self.validate_statement(s);
                    }
                }
            }
            Statement::For {
                variable,
                from,
                to,
                by,
                body,
                span,
            } => {
                // Check that loop variable exists and is integer
                let upper = variable.to_uppercase();
                if let Some((dt, _, _)) = self.variables.get(&upper) {
                    if !dt.is_integer() {
                        self.errors.push(StError {
                            message: format!(
                                "FOR loop variable '{}' must be integer type, got {}",
                                variable, dt
                            ),
                            span: span.clone(),
                            code: "E212".to_string(),
                        });
                    }
                } else {
                    self.errors.push(StError {
                        message: format!("Undefined variable '{}' in FOR loop", variable),
                        span: span.clone(),
                        code: "E213".to_string(),
                    });
                }
                self.check_variable_references(from);
                self.check_variable_references(to);
                if let Some(b) = by {
                    self.check_variable_references(b);
                }

                self.loop_depth += 1;
                for s in body {
                    self.validate_statement(s);
                }
                self.loop_depth -= 1;
            }
            Statement::While {
                condition,
                body,
                span,
            } => {
                self.check_variable_references(condition);

                // Safety check: WHILE TRUE without EXIT
                if is_always_true(condition) {
                    let has_exit = body_has_exit(body);
                    if !has_exit {
                        self.warnings.push(StWarning {
                            message: "WHILE TRUE without EXIT may cause infinite loop".to_string(),
                            span: span.clone(),
                            code: "W220".to_string(),
                        });
                    }
                }

                self.loop_depth += 1;
                for s in body {
                    self.validate_statement(s);
                }
                self.loop_depth -= 1;
            }
            Statement::Repeat {
                body, condition, ..
            } => {
                self.check_variable_references(condition);
                self.loop_depth += 1;
                for s in body {
                    self.validate_statement(s);
                }
                self.loop_depth -= 1;
            }
            Statement::FunctionBlockCall {
                fb_name,
                assignments,
                span,
            } => {
                let upper = fb_name.to_uppercase();
                // Check if instance exists
                if let Some(fb_type) = self.fb_instances.get(&upper).cloned() {
                    // Validate input parameter names
                    if let Some((inputs, _)) = KNOWN_FUNCTION_BLOCKS.get(fb_type.as_str()) {
                        for (param, value) in assignments {
                            let param_upper = param.to_uppercase();
                            let valid = inputs.iter().any(|(n, _)| n.to_uppercase() == param_upper);
                            if !valid {
                                self.errors.push(StError {
                                    message: format!(
                                        "Unknown input '{}' for function block type '{}'",
                                        param, fb_type
                                    ),
                                    span: span.clone(),
                                    code: "E230".to_string(),
                                });
                            }
                            self.check_variable_references(value);
                        }
                    }
                } else {
                    // Check if it's a known FB type being called directly (edge case)
                    if !KNOWN_FUNCTION_BLOCKS.contains_key(upper.as_str()) {
                        self.warnings.push(StWarning {
                            message: format!("Unknown function block instance '{}'", fb_name),
                            span: span.clone(),
                            code: "W230".to_string(),
                        });
                    }
                    for (_, value) in assignments {
                        self.check_variable_references(value);
                    }
                }

                // Safety: check for recursive calls
                if upper == self.current_unit_name.to_uppercase() {
                    self.errors.push(StError {
                        message: format!(
                            "Recursive call to '{}' is not allowed for safety",
                            fb_name
                        ),
                        span: span.clone(),
                        code: "E240".to_string(),
                    });
                }
            }
            Statement::FunctionCall { name, args, span } => {
                for a in args {
                    self.check_variable_references(a);
                }
                // Recursion check
                if name.to_uppercase() == self.current_unit_name.to_uppercase() {
                    self.errors.push(StError {
                        message: format!("Recursive call to '{}' is not allowed for safety", name),
                        span: span.clone(),
                        code: "E240".to_string(),
                    });
                }
            }
            Statement::Return { value, .. } => {
                if let Some(v) = value {
                    self.check_variable_references(v);
                }
            }
            Statement::Exit { span } => {
                if self.loop_depth == 0 {
                    self.errors.push(StError {
                        message: "EXIT statement outside of a loop".to_string(),
                        span: span.clone(),
                        code: "E250".to_string(),
                    });
                }
            }
            Statement::Continue { span } => {
                if self.loop_depth == 0 {
                    self.errors.push(StError {
                        message: "CONTINUE statement outside of a loop".to_string(),
                        span: span.clone(),
                        code: "E251".to_string(),
                    });
                }
            }
            Statement::Empty => {}
        }
    }

    fn check_variable_references(&mut self, expr: &Expression) {
        match expr {
            Expression::Variable(name, span) => {
                let upper = name.to_uppercase();
                if !self.variables.contains_key(&upper) {
                    self.errors.push(StError {
                        message: format!("Undefined variable '{}'", name),
                        span: span.clone(),
                        code: "E300".to_string(),
                    });
                }
            }
            Expression::BinaryOp { left, right, .. } => {
                self.check_variable_references(left);
                self.check_variable_references(right);
            }
            Expression::UnaryOp { operand, .. } => {
                self.check_variable_references(operand);
            }
            Expression::ArrayAccess { array, index } => {
                self.check_variable_references(array);
                self.check_variable_references(index);
            }
            Expression::MemberAccess { object, .. } => {
                self.check_variable_references(object);
            }
            Expression::FunctionCall { args, .. } => {
                for a in args {
                    self.check_variable_references(a);
                }
            }
            Expression::Parenthesized(e) => {
                self.check_variable_references(e);
            }
            _ => {} // literals
        }
    }

    fn infer_expression_type(&self, expr: &Expression) -> Option<DataType> {
        match expr {
            Expression::IntLiteral(_) => Some(DataType::Dint),
            Expression::RealLiteral(_) => Some(DataType::Lreal),
            Expression::StringLiteral(_) => Some(DataType::String(None)),
            Expression::BoolLiteral(_) => Some(DataType::Bool),
            Expression::TimeLiteral(_) => Some(DataType::Time),
            Expression::Variable(name, _) => {
                let upper = name.to_uppercase();
                self.variables.get(&upper).map(|(dt, _, _)| dt.clone())
            }
            Expression::ArrayAccess { array, .. } => {
                if let Some(DataType::Array { base, .. }) = self.infer_expression_type(array) {
                    Some(*base)
                } else {
                    None
                }
            }
            Expression::MemberAccess { object, member } => {
                // For FB instances, look up the output type
                if let Expression::Variable(name, _) = object.as_ref() {
                    let upper = name.to_uppercase();
                    if let Some(fb_type) = self.fb_instances.get(&upper) {
                        if let Some((_, outputs)) = KNOWN_FUNCTION_BLOCKS.get(fb_type.as_str()) {
                            let member_upper = member.to_uppercase();
                            for (out_name, out_type) in outputs {
                                if out_name.to_uppercase() == member_upper {
                                    return Some(out_type.clone());
                                }
                            }
                        }
                    }
                }
                None
            }
            Expression::UnaryOp { op, operand } => {
                let inner = self.infer_expression_type(operand);
                match op {
                    UnaryOp::Not => Some(DataType::Bool),
                    UnaryOp::Neg => inner,
                }
            }
            Expression::BinaryOp { left, op, right } => {
                let lt = self.infer_expression_type(left);
                let rt = self.infer_expression_type(right);
                match op {
                    BinaryOp::Eq
                    | BinaryOp::Neq
                    | BinaryOp::Lt
                    | BinaryOp::Gt
                    | BinaryOp::Le
                    | BinaryOp::Ge
                    | BinaryOp::And
                    | BinaryOp::Or
                    | BinaryOp::Xor => Some(DataType::Bool),
                    _ => {
                        // Arithmetic: promote to the wider type
                        match (lt, rt) {
                            (Some(l), Some(r)) => {
                                if l.is_real() || r.is_real() {
                                    Some(DataType::Lreal)
                                } else if l.is_integer() && r.is_integer() {
                                    Some(DataType::Dint)
                                } else {
                                    Some(l)
                                }
                            }
                            (Some(t), None) | (None, Some(t)) => Some(t),
                            _ => None,
                        }
                    }
                }
            }
            Expression::FunctionCall { .. } => None, // Can't infer without function registry
            Expression::Parenthesized(e) => self.infer_expression_type(e),
        }
    }
}

/// Check if an expression is always true (literal TRUE or integer non-zero)
fn is_always_true(expr: &Expression) -> bool {
    match expr {
        Expression::BoolLiteral(true) => true,
        Expression::IntLiteral(v) => *v != 0,
        Expression::Parenthesized(e) => is_always_true(e),
        _ => false,
    }
}

/// Check if a list of statements contains an EXIT
fn body_has_exit(stmts: &[Statement]) -> bool {
    for stmt in stmts {
        match stmt {
            Statement::Exit { .. } => return true,
            Statement::If {
                then_body,
                elsif_branches,
                else_body,
                ..
            } => {
                if body_has_exit(then_body) {
                    return true;
                }
                for (_, body) in elsif_branches {
                    if body_has_exit(body) {
                        return true;
                    }
                }
                if let Some(body) = else_body {
                    if body_has_exit(body) {
                        return true;
                    }
                }
            }
            Statement::Return { .. } => return true,
            _ => {}
        }
    }
    false
}

// ============================================================================
// Extraction Helpers
// ============================================================================

fn extract_variables(program: &Program) -> Vec<ParsedVariable> {
    let mut vars = Vec::new();
    for block in &program.var_blocks {
        let scope_str = match block.scope {
            VarScope::Local => "local",
            VarScope::Input => "input",
            VarScope::Output => "output",
            VarScope::InOut => "in_out",
            VarScope::Global => "global",
        };
        for decl in &block.declarations {
            vars.push(ParsedVariable {
                name: decl.name.clone(),
                data_type: format!("{}", decl.data_type),
                scope: scope_str.to_string(),
                initial_value: decl.initial_value.as_ref().map(|e| format!("{:?}", e)),
            });
        }
    }
    vars
}

fn extract_function_blocks(program: &Program) -> Vec<ParsedFunctionBlock> {
    let mut fbs = Vec::new();
    // Collect FB instances from var blocks
    let known = &*KNOWN_FUNCTION_BLOCKS;
    let mut instances: HashMap<String, String> = HashMap::new();

    for block in &program.var_blocks {
        for decl in &block.declarations {
            if let DataType::UserDefined(ref type_name) = decl.data_type {
                let upper = type_name.to_uppercase();
                if known.contains_key(upper.as_str()) {
                    instances.insert(decl.name.to_uppercase(), upper);
                }
            }
        }
    }

    // Find FB calls in body
    for stmt in &program.body {
        collect_fb_calls(stmt, &instances, known, &mut fbs);
    }
    fbs
}

fn collect_fb_calls(
    stmt: &Statement,
    instances: &HashMap<String, String>,
    known: &HashMap<&str, (Vec<(&str, DataType)>, Vec<(&str, DataType)>)>,
    fbs: &mut Vec<ParsedFunctionBlock>,
) {
    match stmt {
        Statement::FunctionBlockCall {
            fb_name,
            assignments,
            ..
        } => {
            let upper = fb_name.to_uppercase();
            let fb_type = instances
                .get(&upper)
                .cloned()
                .unwrap_or_else(|| upper.clone());
            let inputs: Vec<String> = assignments.iter().map(|(n, _)| n.clone()).collect();
            let outputs = if let Some((_, outs)) = known.get(fb_type.as_str()) {
                outs.iter().map(|(n, _)| n.to_string()).collect()
            } else {
                Vec::new()
            };
            fbs.push(ParsedFunctionBlock {
                instance_name: fb_name.clone(),
                fb_type,
                inputs,
                outputs,
            });
        }
        Statement::If {
            then_body,
            elsif_branches,
            else_body,
            ..
        } => {
            for s in then_body {
                collect_fb_calls(s, instances, known, fbs);
            }
            for (_, body) in elsif_branches {
                for s in body {
                    collect_fb_calls(s, instances, known, fbs);
                }
            }
            if let Some(body) = else_body {
                for s in body {
                    collect_fb_calls(s, instances, known, fbs);
                }
            }
        }
        Statement::For { body, .. }
        | Statement::While { body, .. }
        | Statement::Repeat { body, .. } => {
            for s in body {
                collect_fb_calls(s, instances, known, fbs);
            }
        }
        Statement::Case {
            branches,
            else_body,
            ..
        } => {
            for (_, body) in branches {
                for s in body {
                    collect_fb_calls(s, instances, known, fbs);
                }
            }
            if let Some(body) = else_body {
                for s in body {
                    collect_fb_calls(s, instances, known, fbs);
                }
            }
        }
        _ => {}
    }
}

// ============================================================================
// Public API
// ============================================================================

/// Parse an IEC 61131-3 Structured Text source into an AST.
///
/// Returns the parsed program or a list of errors.
pub fn parse_st(source: &str) -> Result<Program, Vec<StError>> {
    let mut lexer = Lexer::new(source);
    let tokens = lexer.tokenize()?;

    let mut parser = Parser::new(tokens);
    match parser.parse_program_unit() {
        Some(program) => {
            if parser.errors.is_empty() {
                Ok(program)
            } else {
                Err(parser.errors)
            }
        }
        None => {
            if parser.errors.is_empty() {
                Err(vec![StError {
                    message: "Empty or unparseable program".to_string(),
                    span: None,
                    code: "E999".to_string(),
                }])
            } else {
                Err(parser.errors)
            }
        }
    }
}

/// Validate an IEC 61131-3 Structured Text source.
///
/// Performs lexing, parsing, type checking, and semantic validation.
/// Returns a comprehensive result with AST, variables, and diagnostics.
pub fn validate_st(source: &str) -> ValidationResult {
    // Phase 1: Lex
    let mut lexer = Lexer::new(source);
    let tokens = match lexer.tokenize() {
        Ok(t) => t,
        Err(lex_errors) => {
            return ValidationResult {
                valid: false,
                errors: lex_errors,
                warnings: Vec::new(),
                ast: None,
                variables: Vec::new(),
                function_blocks: Vec::new(),
            };
        }
    };

    // Phase 2: Parse
    let mut parser = Parser::new(tokens);
    let program = match parser.parse_program_unit() {
        Some(p) => p,
        None => {
            let mut errors = parser.errors;
            if errors.is_empty() {
                errors.push(StError {
                    message: "Empty or unparseable program".to_string(),
                    span: None,
                    code: "E999".to_string(),
                });
            }
            return ValidationResult {
                valid: false,
                errors,
                warnings: Vec::new(),
                ast: None,
                variables: Vec::new(),
                function_blocks: Vec::new(),
            };
        }
    };

    let mut all_errors = parser.errors;

    // Phase 3: Validate
    let mut validator = Validator::new();
    validator.validate_program(&program);

    let variables = extract_variables(&program);
    let function_blocks = extract_function_blocks(&program);

    all_errors.extend(validator.errors);
    let warnings = validator.warnings;
    let valid = all_errors.is_empty();

    ValidationResult {
        valid,
        errors: all_errors,
        warnings,
        ast: Some(program),
        variables,
        function_blocks,
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Lexer tests ----

    #[test]
    fn test_lexer_basic_tokens() {
        let mut lexer = Lexer::new("VAR x : INT := 42; END_VAR");
        let tokens = lexer.tokenize().unwrap();
        assert!(matches!(tokens[0].kind, TokenKind::Var));
        assert!(matches!(&tokens[1].kind, TokenKind::Identifier(n) if n == "x"));
        assert!(matches!(tokens[2].kind, TokenKind::Colon));
        assert!(matches!(tokens[3].kind, TokenKind::KwInt));
        assert!(matches!(tokens[4].kind, TokenKind::Assign));
        assert!(matches!(tokens[5].kind, TokenKind::IntLiteral(42)));
        assert!(matches!(tokens[6].kind, TokenKind::Semicolon));
        assert!(matches!(tokens[7].kind, TokenKind::EndVar));
    }

    #[test]
    fn test_lexer_comments() {
        let mut lexer = Lexer::new("(* comment *) x // line comment\ny");
        let tokens = lexer.tokenize().unwrap();
        assert!(matches!(&tokens[0].kind, TokenKind::Identifier(n) if n == "x"));
        assert!(matches!(&tokens[1].kind, TokenKind::Identifier(n) if n == "y"));
    }

    #[test]
    fn test_lexer_nested_comments() {
        let mut lexer = Lexer::new("(* outer (* inner *) still comment *) x");
        let tokens = lexer.tokenize().unwrap();
        assert!(matches!(&tokens[0].kind, TokenKind::Identifier(n) if n == "x"));
    }

    #[test]
    fn test_lexer_real_literal() {
        let mut lexer = Lexer::new("3.14 1.0e5");
        let tokens = lexer.tokenize().unwrap();
        assert!(matches!(tokens[0].kind, TokenKind::RealLiteral(v) if (v - 3.14).abs() < 1e-10));
        assert!(matches!(tokens[1].kind, TokenKind::RealLiteral(v) if (v - 1.0e5).abs() < 1e-5));
    }

    #[test]
    fn test_lexer_string_literal() {
        let mut lexer = Lexer::new("'hello world'");
        let tokens = lexer.tokenize().unwrap();
        assert!(matches!(&tokens[0].kind, TokenKind::StringLiteral(s) if s == "hello world"));
    }

    #[test]
    fn test_lexer_time_literal() {
        let mut lexer = Lexer::new("T#5s TIME#100ms");
        let tokens = lexer.tokenize().unwrap();
        assert!(matches!(&tokens[0].kind, TokenKind::TimeLiteral(s) if s == "T#5s"));
        assert!(matches!(&tokens[1].kind, TokenKind::TimeLiteral(s) if s == "T#100ms"));
    }

    #[test]
    fn test_lexer_operators() {
        let mut lexer = Lexer::new(":= + - * / ** = <> < > <= >= AND OR NOT");
        let tokens = lexer.tokenize().unwrap();
        assert!(matches!(tokens[0].kind, TokenKind::Assign));
        assert!(matches!(tokens[1].kind, TokenKind::Plus));
        assert!(matches!(tokens[2].kind, TokenKind::Minus));
        assert!(matches!(tokens[3].kind, TokenKind::Star));
        assert!(matches!(tokens[4].kind, TokenKind::Slash));
        assert!(matches!(tokens[5].kind, TokenKind::Power));
        assert!(matches!(tokens[6].kind, TokenKind::Eq));
        assert!(matches!(tokens[7].kind, TokenKind::Neq));
        assert!(matches!(tokens[8].kind, TokenKind::Lt));
        assert!(matches!(tokens[9].kind, TokenKind::Gt));
        assert!(matches!(tokens[10].kind, TokenKind::Le));
        assert!(matches!(tokens[11].kind, TokenKind::Ge));
        assert!(matches!(tokens[12].kind, TokenKind::And));
        assert!(matches!(tokens[13].kind, TokenKind::Or));
        assert!(matches!(tokens[14].kind, TokenKind::Not));
    }

    #[test]
    fn test_lexer_all_keywords() {
        let mut lexer = Lexer::new(
            "PROGRAM END_PROGRAM FUNCTION_BLOCK END_FUNCTION_BLOCK FUNCTION END_FUNCTION \
             VAR VAR_INPUT VAR_OUTPUT VAR_IN_OUT VAR_GLOBAL END_VAR \
             IF THEN ELSIF ELSE END_IF CASE OF END_CASE \
             FOR TO BY DO END_FOR WHILE END_WHILE REPEAT UNTIL END_REPEAT \
             EXIT RETURN TRUE FALSE",
        );
        let tokens = lexer.tokenize().unwrap();
        assert!(matches!(tokens[0].kind, TokenKind::Program));
        assert!(matches!(tokens[1].kind, TokenKind::EndProgram));
        assert!(matches!(tokens[2].kind, TokenKind::FunctionBlock));
        assert!(matches!(tokens[3].kind, TokenKind::EndFunctionBlock));
    }

    // ---- Parser tests ----

    #[test]
    fn test_parse_simple_program() {
        let source = r#"
            PROGRAM MyProg
            VAR
                x : INT := 0;
                y : REAL;
            END_VAR

            x := x + 1;
            y := 3.14;
            END_PROGRAM
        "#;

        let program = parse_st(source).unwrap();
        assert_eq!(program.name, "MyProg");
        assert_eq!(program.var_blocks.len(), 1);
        assert_eq!(program.var_blocks[0].declarations.len(), 2);
        assert_eq!(program.body.len(), 2);
    }

    #[test]
    fn test_parse_var_blocks_all_scopes() {
        let source = r#"
            PROGRAM Test
            VAR_INPUT
                setpoint : REAL;
            END_VAR
            VAR_OUTPUT
                result : BOOL;
            END_VAR
            VAR_IN_OUT
                buffer : DINT;
            END_VAR
            VAR_GLOBAL
                counter : INT;
            END_VAR
            VAR
                temp : LREAL;
            END_VAR
            END_PROGRAM
        "#;

        let program = parse_st(source).unwrap();
        assert_eq!(program.var_blocks.len(), 5);
        assert_eq!(program.var_blocks[0].scope, VarScope::Input);
        assert_eq!(program.var_blocks[1].scope, VarScope::Output);
        assert_eq!(program.var_blocks[2].scope, VarScope::InOut);
        assert_eq!(program.var_blocks[3].scope, VarScope::Global);
        assert_eq!(program.var_blocks[4].scope, VarScope::Local);
    }

    #[test]
    fn test_parse_data_types() {
        let source = r#"
            PROGRAM Test
            VAR
                a : BOOL;
                b : BYTE;
                c : WORD;
                d : DWORD;
                e : SINT;
                f : INT;
                g : DINT;
                h : LINT;
                i : USINT;
                j : UINT;
                k : UDINT;
                l : ULINT;
                m : REAL;
                n : LREAL;
                o : STRING;
                p : STRING[80];
                q : TIME;
                r : ARRAY[0..9] OF INT;
            END_VAR
            END_PROGRAM
        "#;

        let program = parse_st(source).unwrap();
        let decls = &program.var_blocks[0].declarations;
        assert_eq!(decls.len(), 18);
        assert_eq!(decls[0].data_type, DataType::Bool);
        assert_eq!(decls[5].data_type, DataType::Int);
        assert_eq!(decls[12].data_type, DataType::Real);
        assert!(matches!(decls[15].data_type, DataType::String(Some(80))));
        assert!(matches!(
            decls[17].data_type,
            DataType::Array {
                lower: 0,
                upper: 9,
                ..
            }
        ));
    }

    #[test]
    fn test_parse_if_elsif_else() {
        let source = r#"
            PROGRAM Test
            VAR
                x : INT;
                y : INT;
            END_VAR

            IF x > 10 THEN
                y := 1;
            ELSIF x > 5 THEN
                y := 2;
            ELSE
                y := 3;
            END_IF;
            END_PROGRAM
        "#;

        let program = parse_st(source).unwrap();
        assert_eq!(program.body.len(), 1);
        if let Statement::If {
            elsif_branches,
            else_body,
            ..
        } = &program.body[0]
        {
            assert_eq!(elsif_branches.len(), 1);
            assert!(else_body.is_some());
        } else {
            panic!("Expected IF statement");
        }
    }

    #[test]
    fn test_parse_case_statement() {
        let source = r#"
            PROGRAM Test
            VAR
                state : INT;
                output : INT;
            END_VAR

            CASE state OF
                0: output := 0;
                1: output := 10;
                2: output := 20;
            ELSE
                output := -1;
            END_CASE;
            END_PROGRAM
        "#;

        let program = parse_st(source).unwrap();
        if let Statement::Case {
            branches,
            else_body,
            ..
        } = &program.body[0]
        {
            assert_eq!(branches.len(), 3);
            assert!(else_body.is_some());
        } else {
            panic!("Expected CASE statement");
        }
    }

    #[test]
    fn test_parse_case_range_expands_at_parse_time() {
        // Batch 178: `1..5:` at a CASE label should
        // expand to 5 IntLiteral labels.
        let source = r#"
            PROGRAM Test
            VAR
                state : INT;
                output : INT;
            END_VAR

            CASE state OF
                1..5: output := 100;
                10, 20..22: output := 200;
            END_CASE;
            END_PROGRAM
        "#;

        let program = parse_st(source).unwrap();
        if let Statement::Case { branches, .. } = &program.body[0] {
            assert_eq!(branches.len(), 2);
            // Branch 1: `1..5:` → 5 labels.
            assert_eq!(branches[0].0.len(), 5);
            for (i, label) in branches[0].0.iter().enumerate() {
                assert!(matches!(
                    label,
                    Expression::IntLiteral(v) if *v == (i as i64) + 1
                ));
            }
            // Branch 2: `10, 20..22:` → 1 + 3 = 4 labels.
            assert_eq!(branches[1].0.len(), 4);
            assert!(matches!(branches[1].0[0], Expression::IntLiteral(10)));
            assert!(matches!(branches[1].0[1], Expression::IntLiteral(20)));
            assert!(matches!(branches[1].0[2], Expression::IntLiteral(21)));
            assert!(matches!(branches[1].0[3], Expression::IntLiteral(22)));
        } else {
            panic!("Expected CASE statement");
        }
    }

    #[test]
    fn test_parse_case_range_inverted_bounds_errors() {
        // `5..1:` → E203 inverted bounds.
        let source = r#"
            PROGRAM Test
            VAR state : INT; output : INT; END_VAR
            CASE state OF
                5..1: output := 0;
            END_CASE;
            END_PROGRAM
        "#;
        let errors = parse_st(source).err().unwrap_or_default();
        assert!(errors.iter().any(|e| e.code == "E203"));
    }

    #[test]
    fn test_parse_case_range_exceeds_cap_errors() {
        // `1..500:` exceeds CASE_RANGE_MAX_EXPANSION=256.
        let source = r#"
            PROGRAM Test
            VAR state : INT; output : INT; END_VAR
            CASE state OF
                1..500: output := 0;
            END_CASE;
            END_PROGRAM
        "#;
        let errors = parse_st(source).err().unwrap_or_default();
        assert!(errors.iter().any(|e| e.code == "E204"));
    }

    #[test]
    fn test_parse_for_loop() {
        let source = r#"
            PROGRAM Test
            VAR
                i : INT;
                sum : INT := 0;
            END_VAR

            FOR i := 0 TO 10 BY 2 DO
                sum := sum + i;
            END_FOR;
            END_PROGRAM
        "#;

        let program = parse_st(source).unwrap();
        if let Statement::For { variable, by, .. } = &program.body[0] {
            assert_eq!(variable, "i");
            assert!(by.is_some());
        } else {
            panic!("Expected FOR statement");
        }
    }

    #[test]
    fn test_parse_while_loop() {
        let source = r#"
            PROGRAM Test
            VAR
                count : INT := 0;
            END_VAR

            WHILE count < 100 DO
                count := count + 1;
            END_WHILE;
            END_PROGRAM
        "#;

        let program = parse_st(source).unwrap();
        assert!(matches!(program.body[0], Statement::While { .. }));
    }

    #[test]
    fn test_parse_repeat_until() {
        let source = r#"
            PROGRAM Test
            VAR
                n : INT := 10;
            END_VAR

            REPEAT
                n := n - 1;
            UNTIL n <= 0
            END_REPEAT;
            END_PROGRAM
        "#;

        let program = parse_st(source).unwrap();
        assert!(matches!(program.body[0], Statement::Repeat { .. }));
    }

    #[test]
    fn test_parse_function_block_call() {
        let source = r#"
            PROGRAM Test
            VAR
                myTimer : TON;
                start : BOOL;
            END_VAR

            myTimer(IN := start, PT := T#5s);
            END_PROGRAM
        "#;

        let program = parse_st(source).unwrap();
        if let Statement::FunctionBlockCall {
            fb_name,
            assignments,
            ..
        } = &program.body[0]
        {
            assert_eq!(fb_name, "myTimer");
            assert_eq!(assignments.len(), 2);
            assert_eq!(assignments[0].0, "IN");
            assert_eq!(assignments[1].0, "PT");
        } else {
            panic!("Expected FunctionBlockCall, got: {:?}", program.body[0]);
        }
    }

    #[test]
    fn test_parse_expression_precedence() {
        let source = r#"
            PROGRAM Test
            VAR
                a : INT;
                b : INT;
                c : INT;
                result : INT;
            END_VAR

            result := a + b * c;
            END_PROGRAM
        "#;

        let program = parse_st(source).unwrap();
        if let Statement::Assignment { value, .. } = &program.body[0] {
            // Should be Add(a, Mul(b, c)) not Mul(Add(a, b), c)
            if let Expression::BinaryOp { op, right, .. } = value {
                assert_eq!(*op, BinaryOp::Add);
                assert!(matches!(
                    right.as_ref(),
                    Expression::BinaryOp {
                        op: BinaryOp::Mul,
                        ..
                    }
                ));
            } else {
                panic!("Expected BinaryOp");
            }
        }
    }

    #[test]
    fn test_parse_nested_expressions() {
        let source = r#"
            PROGRAM Test
            VAR
                x : BOOL;
                a : INT;
                b : INT;
            END_VAR

            x := (a + b) > 10 AND NOT (a < 0);
            END_PROGRAM
        "#;

        let result = parse_st(source);
        assert!(result.is_ok());
    }

    #[test]
    fn test_parse_function_block_decl() {
        let source = r#"
            FUNCTION_BLOCK MyFB
            VAR_INPUT
                enable : BOOL;
            END_VAR
            VAR_OUTPUT
                done : BOOL;
            END_VAR
            VAR
                counter : INT;
            END_VAR

            IF enable THEN
                counter := counter + 1;
            END_IF;
            done := counter >= 10;
            END_FUNCTION_BLOCK
        "#;

        let result = parse_st(source);
        assert!(result.is_ok());
    }

    #[test]
    fn test_parse_function_decl() {
        let source = r#"
            FUNCTION AddInts : INT
            VAR_INPUT
                a : INT;
                b : INT;
            END_VAR

            AddInts := a + b;
            END_FUNCTION
        "#;

        let result = parse_st(source);
        assert!(result.is_ok());
    }

    // ---- Validation tests ----

    #[test]
    fn test_validate_valid_program() {
        let source = r#"
            PROGRAM WaterControl
            VAR
                temperature : REAL := 0.0;
                setpoint : REAL := 25.0;
                heater_on : BOOL := FALSE;
                cycle_count : INT := 0;
            END_VAR

            cycle_count := cycle_count + 1;

            IF temperature < setpoint THEN
                heater_on := TRUE;
            ELSE
                heater_on := FALSE;
            END_IF;
            END_PROGRAM
        "#;

        let result = validate_st(source);
        assert!(result.valid, "Errors: {:?}", result.errors);
        assert!(result.ast.is_some());
        assert_eq!(result.variables.len(), 4);
    }

    #[test]
    fn test_validate_undefined_variable() {
        let source = r#"
            PROGRAM Test
            VAR
                x : INT;
            END_VAR

            x := undefined_var + 1;
            END_PROGRAM
        "#;

        let result = validate_st(source);
        assert!(!result.valid);
        assert!(result.errors.iter().any(|e| e.code == "E300"));
    }

    #[test]
    fn test_validate_duplicate_variable() {
        let source = r#"
            PROGRAM Test
            VAR
                x : INT;
                x : REAL;
            END_VAR
            END_PROGRAM
        "#;

        let result = validate_st(source);
        assert!(!result.valid);
        assert!(result.errors.iter().any(|e| e.code == "E200"));
    }

    #[test]
    fn test_validate_type_mismatch() {
        let source = r#"
            PROGRAM Test
            VAR
                flag : BOOL;
                name : STRING;
            END_VAR

            flag := name;
            END_PROGRAM
        "#;

        let result = validate_st(source);
        assert!(!result.valid);
        assert!(result.errors.iter().any(|e| e.code == "E210"));
    }

    #[test]
    fn test_validate_numeric_type_compatibility() {
        let source = r#"
            PROGRAM Test
            VAR
                i : INT;
                r : REAL;
                d : DINT;
            END_VAR

            r := i;
            d := i;
            i := d;
            END_PROGRAM
        "#;

        let result = validate_st(source);
        assert!(result.valid, "Errors: {:?}", result.errors);
    }

    #[test]
    fn test_validate_precision_loss_warning() {
        let source = r#"
            PROGRAM Test
            VAR
                i : INT;
                r : REAL := 3.14;
            END_VAR

            i := r;
            END_PROGRAM
        "#;

        let result = validate_st(source);
        // Should succeed but with warning
        assert!(
            result.warnings.iter().any(|w| w.code == "W210"),
            "Expected precision loss warning, warnings: {:?}",
            result.warnings
        );
    }

    #[test]
    fn test_validate_while_true_no_exit() {
        let source = r#"
            PROGRAM Test
            VAR
                x : INT := 0;
            END_VAR

            WHILE TRUE DO
                x := x + 1;
            END_WHILE;
            END_PROGRAM
        "#;

        let result = validate_st(source);
        assert!(
            result.warnings.iter().any(|w| w.code == "W220"),
            "Expected infinite loop warning, warnings: {:?}",
            result.warnings
        );
    }

    #[test]
    fn test_validate_while_true_with_exit_ok() {
        let source = r#"
            PROGRAM Test
            VAR
                x : INT := 0;
            END_VAR

            WHILE TRUE DO
                x := x + 1;
                IF x > 100 THEN
                    EXIT;
                END_IF;
            END_WHILE;
            END_PROGRAM
        "#;

        let result = validate_st(source);
        assert!(
            !result.warnings.iter().any(|w| w.code == "W220"),
            "Should not warn about WHILE TRUE with EXIT"
        );
    }

    #[test]
    fn test_validate_exit_outside_loop() {
        let source = r#"
            PROGRAM Test
            VAR
                x : INT;
            END_VAR

            EXIT;
            END_PROGRAM
        "#;

        let result = validate_st(source);
        assert!(!result.valid);
        assert!(result.errors.iter().any(|e| e.code == "E250"));
    }

    #[test]
    fn test_validate_recursive_call() {
        let source = r#"
            PROGRAM RecursiveProg
            VAR
                x : INT;
            END_VAR

            RecursiveProg(x := 1);
            END_PROGRAM
        "#;

        let result = validate_st(source);
        assert!(
            result.errors.iter().any(|e| e.code == "E240"),
            "Expected recursion error, errors: {:?}",
            result.errors
        );
    }

    #[test]
    fn test_validate_fb_call_with_valid_params() {
        let source = r#"
            PROGRAM Test
            VAR
                myTimer : TON;
                start : BOOL;
                duration : TIME;
            END_VAR

            myTimer(IN := start, PT := T#5s);
            END_PROGRAM
        "#;

        let result = validate_st(source);
        assert!(result.valid, "Errors: {:?}", result.errors);
        assert_eq!(result.function_blocks.len(), 1);
        assert_eq!(result.function_blocks[0].fb_type, "TON");
    }

    #[test]
    fn test_validate_fb_call_unknown_param() {
        let source = r#"
            PROGRAM Test
            VAR
                myTimer : TON;
                start : BOOL;
            END_VAR

            myTimer(IN := start, BOGUS := TRUE);
            END_PROGRAM
        "#;

        let result = validate_st(source);
        assert!(!result.valid);
        assert!(result.errors.iter().any(|e| e.code == "E230"));
    }

    #[test]
    fn test_validate_fb_output_access() {
        let source = r#"
            PROGRAM Test
            VAR
                myTimer : TON;
                start : BOOL;
                done : BOOL;
                elapsed : TIME;
            END_VAR

            myTimer(IN := start, PT := T#5s);
            done := myTimer.Q;
            END_PROGRAM
        "#;

        let result = validate_st(source);
        assert!(result.valid, "Errors: {:?}", result.errors);
    }

    #[test]
    fn test_validate_missing_end_program() {
        let source = r#"
            PROGRAM Test
            VAR
                x : INT;
            END_VAR

            x := 1;
        "#;

        let result = validate_st(source);
        assert!(!result.valid);
        assert!(result.errors.iter().any(|e| e.code == "E101"));
    }

    #[test]
    fn test_validate_missing_end_if() {
        let source = r#"
            PROGRAM Test
            VAR
                x : INT;
            END_VAR

            IF x > 0 THEN
                x := 1;

            END_PROGRAM
        "#;

        let result = validate_st(source);
        assert!(!result.valid);
        assert!(result.errors.iter().any(|e| e.message.contains("END_IF")));
    }

    #[test]
    fn test_validate_for_loop_non_integer_var() {
        let source = r#"
            PROGRAM Test
            VAR
                r : REAL;
                sum : INT := 0;
            END_VAR

            FOR r := 0 TO 10 DO
                sum := sum + 1;
            END_FOR;
            END_PROGRAM
        "#;

        let result = validate_st(source);
        assert!(!result.valid);
        assert!(
            result.errors.iter().any(|e| e.code == "E212"),
            "Expected FOR loop type error, errors: {:?}",
            result.errors
        );
    }

    #[test]
    fn test_validate_complex_aquaculture_program() {
        let source = r#"
            PROGRAM AquacultureControl
            VAR_INPUT
                water_temp : REAL;
                dissolved_oxygen : REAL;
                ph_level : REAL;
                water_level : REAL;
            END_VAR
            VAR_OUTPUT
                heater_cmd : BOOL;
                aerator_cmd : BOOL;
                alarm : BOOL;
            END_VAR
            VAR
                temp_timer : TON;
                temp_setpoint : REAL := 28.0;
                temp_deadband : REAL := 0.5;
                do_low_threshold : REAL := 5.0;
                ph_min : REAL := 6.5;
                ph_max : REAL := 8.5;
                cycle_count : DINT := 0;
                i : INT;
                readings : ARRAY[0..9] OF REAL;
                avg_temp : REAL;
                sum : REAL;
            END_VAR

            cycle_count := cycle_count + 1;

            (* Temperature control with deadband *)
            IF water_temp < (temp_setpoint - temp_deadband) THEN
                heater_cmd := TRUE;
            ELSIF water_temp > (temp_setpoint + temp_deadband) THEN
                heater_cmd := FALSE;
            END_IF;

            (* DO control *)
            IF dissolved_oxygen < do_low_threshold THEN
                aerator_cmd := TRUE;
            ELSE
                aerator_cmd := FALSE;
            END_IF;

            (* pH alarm *)
            alarm := (ph_level < ph_min) OR (ph_level > ph_max);

            (* Timer for heater protection *)
            temp_timer(IN := heater_cmd, PT := T#30m);
            IF temp_timer.Q THEN
                heater_cmd := FALSE;
            END_IF;

            (* Rolling average calculation *)
            sum := 0.0;
            FOR i := 0 TO 9 DO
                sum := sum + readings[i];
            END_FOR;
            avg_temp := sum / 10.0;

            END_PROGRAM
        "#;

        let result = validate_st(source);
        assert!(result.valid, "Errors: {:?}", result.errors);
        assert!(result.ast.is_some());
        assert!(result.variables.len() >= 10);
        assert_eq!(result.function_blocks.len(), 1);
        assert_eq!(result.function_blocks[0].fb_type, "TON");
    }

    #[test]
    fn test_validate_all_standard_fbs() {
        let source = r#"
            PROGRAM FBTest
            VAR
                timer_on : TON;
                timer_off : TOF;
                timer_pulse : TP;
                counter_up : CTU;
                counter_down : CTD;
                rs_flip : RS;
                sr_flip : SR;
                rising : R_TRIG;
                falling : F_TRIG;
                pid_ctrl : PID;
                input_signal : BOOL;
                pv : REAL;
                sp : REAL;
            END_VAR

            timer_on(IN := input_signal, PT := T#1s);
            timer_off(IN := input_signal, PT := T#2s);
            timer_pulse(IN := input_signal, PT := T#500ms);
            counter_up(CU := input_signal, RESET := FALSE, PV := 100);
            counter_down(CD := input_signal, LOAD := FALSE, PV := 50);
            rs_flip(SET := input_signal, RESET1 := FALSE);
            sr_flip(SET1 := input_signal, RESET := FALSE);
            rising(CLK := input_signal);
            falling(CLK := input_signal);
            pid_ctrl(AUTO := TRUE, PV := pv, SP := sp, KP := 1.0, TI := T#10s, TD := T#2s);
            END_PROGRAM
        "#;

        let result = validate_st(source);
        assert!(result.valid, "Errors: {:?}", result.errors);
        assert_eq!(result.function_blocks.len(), 10);
    }

    #[test]
    fn test_validate_serialization_roundtrip() {
        let source = r#"
            PROGRAM Test
            VAR
                x : INT := 42;
            END_VAR
            x := x + 1;
            END_PROGRAM
        "#;

        let result = validate_st(source);
        assert!(result.valid);

        // Serialize to JSON
        let json = serde_json::to_string(&result).unwrap();
        assert!(!json.is_empty());

        // Deserialize back
        let deserialized: ValidationResult = serde_json::from_str(&json).unwrap();
        assert!(deserialized.valid);
        assert_eq!(deserialized.variables.len(), result.variables.len());
    }

    #[test]
    fn test_parse_empty_source() {
        let result = validate_st("");
        assert!(!result.valid);
    }

    #[test]
    fn test_validate_implicit_program() {
        // Some ST sources don't have PROGRAM wrapper
        let source = r#"
            VAR
                x : INT := 0;
            END_VAR

            x := x + 1;
        "#;

        let result = validate_st(source);
        assert!(result.valid, "Errors: {:?}", result.errors);
        assert_eq!(result.variables.len(), 1);
    }

    #[test]
    fn test_validate_member_access_chain() {
        let source = r#"
            PROGRAM Test
            VAR
                myTimer : TON;
                running : BOOL;
            END_VAR

            myTimer(IN := TRUE, PT := T#5s);
            running := myTimer.Q;
            END_PROGRAM
        "#;

        let result = validate_st(source);
        assert!(result.valid, "Errors: {:?}", result.errors);
    }

    #[test]
    fn test_validate_retain_constant_vars() {
        let source = r#"
            PROGRAM Test
            VAR RETAIN
                persistent_count : DINT := 0;
            END_VAR
            VAR CONSTANT
                MAX_VALUE : INT := 1000;
            END_VAR

            persistent_count := persistent_count + 1;
            END_PROGRAM
        "#;

        let result = validate_st(source);
        assert!(result.valid, "Errors: {:?}", result.errors);
        assert!(result.ast.as_ref().unwrap().var_blocks[0].retain);
        assert!(result.ast.as_ref().unwrap().var_blocks[1].constant);
    }

    #[test]
    fn test_validate_case_insensitive_keywords() {
        let source = r#"
            program test
            var
                x : int := 0;
            end_var

            if x > 0 then
                x := x - 1;
            end_if;
            end_program
        "#;

        let result = validate_st(source);
        assert!(result.valid, "Errors: {:?}", result.errors);
    }

    #[test]
    fn test_validate_boolean_expression_in_condition() {
        let source = r#"
            PROGRAM Test
            VAR
                a : BOOL;
                b : BOOL;
                c : BOOL;
                x : INT;
                y : INT;
            END_VAR

            c := a AND b OR NOT a;
            IF (x > 0) AND (y < 100) THEN
                c := TRUE;
            END_IF;
            END_PROGRAM
        "#;

        let result = validate_st(source);
        assert!(result.valid, "Errors: {:?}", result.errors);
    }

    #[test]
    fn test_span_tracking() {
        let source = "PROGRAM Test\nVAR\n    x : INT;\nEND_VAR\nEND_PROGRAM";
        let result = validate_st(source);
        assert!(result.valid);
        let ast = result.ast.unwrap();
        // The program should have a span at line 1
        assert_eq!(ast.span.as_ref().unwrap().line, 1);
    }
}
