# IEC 61131-3 Structured Text IDE - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the existing basic Monaco ST editor into a professional IEC 61131-3 IDE with IntelliSense, real-time diagnostics via WebSocket, and JSON bundle export/import.

**Architecture:** Backend ST compiler pipeline (Lexer → Parser → AST → Semantic Analyzer) in sensor-service with WebSocket gateway for real-time diagnostics. Frontend Monaco editor with custom providers for completion, hover, formatting, and outline panel. JSON bundle for program serialization.

**Tech Stack:** NestJS WebSocket Gateway (socket.io), Monaco Editor (@monaco-editor/react), TypeScript recursive descent parser, socket.io-client

**Design Doc:** `docs/plans/ST-plan.md`

---

## Conventions & References

- **Backend base:** `apps/sensor-service/src/automation/`
- **Frontend base:** `web/modules/sensor-module/src/`
- **Test base backend:** `apps/sensor-service/src/automation/compiler/__tests__/`
- **Existing WebSocket pattern:** `apps/gateway-api/src/websocket/sensor-readings.gateway.ts`
- **Existing validation types:** `web/modules/sensor-module/src/components/automation/CompileResultPanel.tsx` (ValidationDiagnostic, ValidationResult interfaces)
- **WebSocket deps already installed:** `@nestjs/websockets`, `@nestjs/platform-socket.io`, `socket.io-client`
- **Sensor-service port:** 4003

---

## Task 1: ST Token Definitions & Keyword Dictionary

**Files:**
- Create: `apps/sensor-service/src/automation/compiler/lexer/st-tokens.ts`
- Create: `apps/sensor-service/src/automation/compiler/lexer/st-keywords.ts`

### Step 1: Create token enum and types

Create `st-tokens.ts` with all IEC 61131-3 token types:

```typescript
export enum TokenType {
  // Literals
  INTEGER_LITERAL = 'INTEGER_LITERAL',
  REAL_LITERAL = 'REAL_LITERAL',
  STRING_LITERAL = 'STRING_LITERAL',
  WSTRING_LITERAL = 'WSTRING_LITERAL',
  BOOLEAN_LITERAL = 'BOOLEAN_LITERAL',
  TIME_LITERAL = 'TIME_LITERAL',
  DATE_LITERAL = 'DATE_LITERAL',
  TOD_LITERAL = 'TOD_LITERAL',
  DT_LITERAL = 'DT_LITERAL',
  TYPED_LITERAL = 'TYPED_LITERAL', // 16#FF, 2#1010, 8#77

  // Identifiers & Keywords
  IDENTIFIER = 'IDENTIFIER',
  KEYWORD = 'KEYWORD',
  TYPE_KEYWORD = 'TYPE_KEYWORD',
  BUILTIN_FUNCTION = 'BUILTIN_FUNCTION',
  FUNCTION_BLOCK = 'FUNCTION_BLOCK_KEYWORD',

  // Operators
  ASSIGN = 'ASSIGN',           // :=
  OUTPUT_ASSIGN = 'OUTPUT_ASSIGN', // =>
  PLUS = 'PLUS',
  MINUS = 'MINUS',
  MULTIPLY = 'MULTIPLY',
  DIVIDE = 'DIVIDE',
  MODULO = 'MODULO',           // MOD
  POWER = 'POWER',             // **
  EQUAL = 'EQUAL',             // =
  NOT_EQUAL = 'NOT_EQUAL',     // <>
  LESS_THAN = 'LESS_THAN',
  GREATER_THAN = 'GREATER_THAN',
  LESS_EQUAL = 'LESS_EQUAL',
  GREATER_EQUAL = 'GREATER_EQUAL',
  AND = 'AND',
  OR = 'OR',
  XOR = 'XOR',
  NOT = 'NOT',

  // Delimiters
  SEMICOLON = 'SEMICOLON',
  COLON = 'COLON',
  COMMA = 'COMMA',
  DOT = 'DOT',
  DOTDOT = 'DOTDOT',           // .. (subrange)
  LPAREN = 'LPAREN',
  RPAREN = 'RPAREN',
  LBRACKET = 'LBRACKET',
  RBRACKET = 'RBRACKET',
  HASH = 'HASH',               // # in typed literals

  // Special
  COMMENT = 'COMMENT',
  NEWLINE = 'NEWLINE',
  WHITESPACE = 'WHITESPACE',
  EOF = 'EOF',
  UNKNOWN = 'UNKNOWN',
}

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
  offset: number;
  length: number;
}

export interface LexerError {
  line: number;
  column: number;
  message: string;
  offset: number;
}
```

### Step 2: Create keyword dictionary

Create `st-keywords.ts` with IEC 61131-3 keyword sets:

```typescript
export const ST_KEYWORDS = new Set([
  // Program Organization Units
  'PROGRAM', 'END_PROGRAM', 'FUNCTION', 'END_FUNCTION',
  'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK',
  'TYPE', 'END_TYPE', 'STRUCT', 'END_STRUCT',

  // Variable declarations
  'VAR', 'END_VAR', 'VAR_INPUT', 'END_VAR',
  'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL',
  'VAR_EXTERNAL', 'VAR_TEMP', 'VAR_ACCESS',
  'CONSTANT', 'RETAIN', 'NON_RETAIN', 'PERSISTENT',
  'AT',

  // Control flow
  'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
  'CASE', 'OF', 'END_CASE',
  'FOR', 'TO', 'BY', 'DO', 'END_FOR',
  'WHILE', 'END_WHILE',
  'REPEAT', 'UNTIL', 'END_REPEAT',
  'EXIT', 'CONTINUE', 'RETURN',

  // SFC
  'STEP', 'END_STEP', 'INITIAL_STEP',
  'TRANSITION', 'END_TRANSITION', 'FROM',
  'ACTION', 'END_ACTION',

  // Boolean
  'TRUE', 'FALSE',

  // Operators (keyword form)
  'AND', 'OR', 'XOR', 'NOT', 'MOD',
]);

export const ST_TYPE_KEYWORDS = new Set([
  'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
  'SINT', 'INT', 'DINT', 'LINT',
  'USINT', 'UINT', 'UDINT', 'ULINT',
  'REAL', 'LREAL',
  'STRING', 'WSTRING', 'CHAR', 'WCHAR',
  'TIME', 'LTIME', 'DATE', 'TOD', 'DT',
  'DATE_AND_TIME', 'TIME_OF_DAY',
  'ARRAY', 'POINTER', 'REFERENCE',
  'ANY', 'ANY_NUM', 'ANY_INT', 'ANY_REAL', 'ANY_STRING',
]);

export const ST_BUILTIN_FUNCTIONS = new Set([
  // Math
  'ABS', 'SQRT', 'LN', 'LOG', 'EXP', 'EXPT',
  'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'ATAN2',
  'MAX', 'MIN', 'LIMIT', 'MUX', 'SEL',
  // Bit
  'SHL', 'SHR', 'ROL', 'ROR',
  // String
  'LEN', 'LEFT', 'RIGHT', 'MID', 'CONCAT', 'INSERT', 'DELETE', 'REPLACE', 'FIND',
  // Type conversion
  'TO_BOOL', 'TO_INT', 'TO_DINT', 'TO_REAL', 'TO_LREAL', 'TO_STRING', 'TO_TIME',
  'BOOL_TO_INT', 'INT_TO_REAL', 'REAL_TO_INT', 'INT_TO_STRING', 'STRING_TO_INT',
  'TRUNC', 'ROUND',
]);

export const ST_FUNCTION_BLOCKS = new Set([
  // Timers
  'TON', 'TOF', 'TP', 'RTC',
  // Counters
  'CTU', 'CTD', 'CTUD',
  // Bistable
  'SR', 'RS',
  // Edge detection
  'R_TRIG', 'F_TRIG',
  // PID
  'PID',
  // Communication
  'RAMP', 'HYSTERESIS', 'LIMITER',
]);

/** Standard FB documentation for hover/completion */
export const ST_FB_DOCS: Record<string, { description: string; inputs: string[]; outputs: string[] }> = {
  TON: {
    description: 'Timer On Delay - starts timing when IN is TRUE. Q becomes TRUE after PT elapsed.',
    inputs: ['IN : BOOL', 'PT : TIME'],
    outputs: ['Q : BOOL', 'ET : TIME'],
  },
  TOF: {
    description: 'Timer Off Delay - Q stays TRUE for PT after IN goes FALSE.',
    inputs: ['IN : BOOL', 'PT : TIME'],
    outputs: ['Q : BOOL', 'ET : TIME'],
  },
  TP: {
    description: 'Pulse Timer - generates a pulse of duration PT on rising edge of IN.',
    inputs: ['IN : BOOL', 'PT : TIME'],
    outputs: ['Q : BOOL', 'ET : TIME'],
  },
  CTU: {
    description: 'Count Up - increments CV on rising edge of CU. Q is TRUE when CV >= PV.',
    inputs: ['CU : BOOL', 'RESET : BOOL', 'PV : INT'],
    outputs: ['Q : BOOL', 'CV : INT'],
  },
  CTD: {
    description: 'Count Down - decrements CV on rising edge of CD. Q is TRUE when CV <= 0.',
    inputs: ['CD : BOOL', 'LOAD : BOOL', 'PV : INT'],
    outputs: ['Q : BOOL', 'CV : INT'],
  },
  CTUD: {
    description: 'Count Up/Down - counts up on CU, down on CD.',
    inputs: ['CU : BOOL', 'CD : BOOL', 'RESET : BOOL', 'LOAD : BOOL', 'PV : INT'],
    outputs: ['QU : BOOL', 'QD : BOOL', 'CV : INT'],
  },
  SR: {
    description: 'Set-Reset Flip-Flop (Set dominant).',
    inputs: ['SET1 : BOOL', 'RESET : BOOL'],
    outputs: ['Q1 : BOOL'],
  },
  RS: {
    description: 'Reset-Set Flip-Flop (Reset dominant).',
    inputs: ['SET : BOOL', 'RESET1 : BOOL'],
    outputs: ['Q1 : BOOL'],
  },
  R_TRIG: {
    description: 'Rising Edge Trigger - Q is TRUE for one cycle on rising edge of CLK.',
    inputs: ['CLK : BOOL'],
    outputs: ['Q : BOOL'],
  },
  F_TRIG: {
    description: 'Falling Edge Trigger - Q is TRUE for one cycle on falling edge of CLK.',
    inputs: ['CLK : BOOL'],
    outputs: ['Q : BOOL'],
  },
  PID: {
    description: 'PID Controller - Proportional-Integral-Derivative control loop.',
    inputs: ['SETPOINT : REAL', 'ACTUAL : REAL', 'KP : REAL', 'KI : REAL', 'KD : REAL', 'MANUAL : BOOL', 'MAN_VALUE : REAL'],
    outputs: ['OUTPUT : REAL', 'ERROR : REAL', 'LIMITED : BOOL'],
  },
};

/** Maps keyword to its category for autocomplete */
export function classifyIdentifier(name: string): 'keyword' | 'type' | 'builtin' | 'fb' | 'identifier' {
  const upper = name.toUpperCase();
  if (ST_KEYWORDS.has(upper)) return 'keyword';
  if (ST_TYPE_KEYWORDS.has(upper)) return 'type';
  if (ST_BUILTIN_FUNCTIONS.has(upper)) return 'builtin';
  if (ST_FUNCTION_BLOCKS.has(upper)) return 'fb';
  return 'identifier';
}
```

### Step 3: Commit

```bash
git add apps/sensor-service/src/automation/compiler/lexer/st-tokens.ts apps/sensor-service/src/automation/compiler/lexer/st-keywords.ts
git commit -m "feat(sensor-service): add IEC 61131-3 ST token definitions and keyword dictionary"
```

---

## Task 2: ST Lexer (Tokenizer)

**Files:**
- Create: `apps/sensor-service/src/automation/compiler/lexer/st-lexer.ts`
- Create: `apps/sensor-service/src/automation/compiler/__tests__/st-lexer.spec.ts`

### Step 1: Write lexer tests

Create `__tests__/st-lexer.spec.ts` with core test cases:

```typescript
import { STLexer } from '../lexer/st-lexer';
import { TokenType } from '../lexer/st-tokens';

describe('STLexer', () => {
  let lexer: STLexer;

  beforeEach(() => {
    lexer = new STLexer();
  });

  describe('basic tokens', () => {
    it('should tokenize assignment', () => {
      const tokens = lexer.tokenize('x := 5;');
      expect(tokens.filter(t => t.type !== TokenType.WHITESPACE)).toEqual([
        expect.objectContaining({ type: TokenType.IDENTIFIER, value: 'x' }),
        expect.objectContaining({ type: TokenType.ASSIGN, value: ':=' }),
        expect.objectContaining({ type: TokenType.INTEGER_LITERAL, value: '5' }),
        expect.objectContaining({ type: TokenType.SEMICOLON, value: ';' }),
        expect.objectContaining({ type: TokenType.EOF }),
      ]);
    });

    it('should tokenize keywords case-insensitively', () => {
      const tokens = lexer.tokenize('IF x THEN');
      const meaningful = tokens.filter(t => t.type !== TokenType.WHITESPACE);
      expect(meaningful[0].type).toBe(TokenType.KEYWORD);
      expect(meaningful[2].type).toBe(TokenType.KEYWORD);
    });

    it('should tokenize type keywords', () => {
      const tokens = lexer.tokenize('myVar : REAL;');
      const meaningful = tokens.filter(t => t.type !== TokenType.WHITESPACE);
      expect(meaningful[2].type).toBe(TokenType.TYPE_KEYWORD);
    });

    it('should tokenize REAL literals', () => {
      const tokens = lexer.tokenize('3.14');
      expect(tokens[0].type).toBe(TokenType.REAL_LITERAL);
    });

    it('should tokenize string literals', () => {
      const tokens = lexer.tokenize("'hello world'");
      expect(tokens[0].type).toBe(TokenType.STRING_LITERAL);
    });

    it('should tokenize time literals', () => {
      const tokens = lexer.tokenize('T#5s');
      expect(tokens[0].type).toBe(TokenType.TIME_LITERAL);
    });

    it('should tokenize typed literals', () => {
      const tokens = lexer.tokenize('16#FF');
      expect(tokens[0].type).toBe(TokenType.TYPED_LITERAL);
    });

    it('should tokenize line comments', () => {
      const tokens = lexer.tokenize('x := 5; // comment');
      const comment = tokens.find(t => t.type === TokenType.COMMENT);
      expect(comment).toBeDefined();
      expect(comment!.value).toBe('// comment');
    });

    it('should tokenize block comments', () => {
      const tokens = lexer.tokenize('(* multi\nline *) x');
      const comment = tokens.find(t => t.type === TokenType.COMMENT);
      expect(comment).toBeDefined();
    });

    it('should track line and column numbers', () => {
      const tokens = lexer.tokenize('x := 5;\ny := 10;');
      const y = tokens.find(t => t.value === 'y');
      expect(y!.line).toBe(2);
      expect(y!.column).toBe(1);
    });

    it('should tokenize comparison operators', () => {
      const tokens = lexer.tokenize('x <> y');
      const meaningful = tokens.filter(t => t.type !== TokenType.WHITESPACE);
      expect(meaningful[1].type).toBe(TokenType.NOT_EQUAL);
    });

    it('should tokenize power operator', () => {
      const tokens = lexer.tokenize('x ** 2');
      const meaningful = tokens.filter(t => t.type !== TokenType.WHITESPACE);
      expect(meaningful[1].type).toBe(TokenType.POWER);
    });

    it('should tokenize boolean literals', () => {
      const tokens = lexer.tokenize('TRUE FALSE');
      const meaningful = tokens.filter(t => t.type !== TokenType.WHITESPACE);
      expect(meaningful[0].type).toBe(TokenType.BOOLEAN_LITERAL);
      expect(meaningful[1].type).toBe(TokenType.BOOLEAN_LITERAL);
    });
  });

  describe('full program', () => {
    it('should tokenize a complete PROGRAM block', () => {
      const code = `PROGRAM MyProg
VAR
  temp : REAL := 25.0;
  running : BOOL;
END_VAR

IF temp > 30.0 THEN
  running := TRUE;
END_IF;
END_PROGRAM`;
      const result = lexer.tokenize(code);
      expect(result.find(t => t.type === TokenType.UNKNOWN)).toBeUndefined();
      expect(result[result.length - 1].type).toBe(TokenType.EOF);
    });
  });

  describe('error handling', () => {
    it('should report unterminated string', () => {
      const tokens = lexer.tokenize("'unterminated");
      expect(lexer.errors.length).toBeGreaterThan(0);
    });

    it('should report unterminated block comment', () => {
      const tokens = lexer.tokenize('(* not closed');
      expect(lexer.errors.length).toBeGreaterThan(0);
    });
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd apps/sensor-service && npx jest --config jest.config.js --testPathPattern="st-lexer" --no-coverage
```

Expected: FAIL (module not found)

### Step 3: Implement the lexer

Create `st-lexer.ts` - a character-by-character scanner that produces tokens with line/column tracking. Key features:
- Handles all IEC 61131-3 number formats (integer, real, hex `16#`, binary `2#`, octal `8#`, time `T#`)
- Case-insensitive keyword classification using `classifyIdentifier()` from st-keywords.ts
- `(* *)` and `//` comment support
- Tracks errors for unterminated strings/comments
- Returns all tokens including whitespace (for formatting) with EOF terminator

The lexer should be a class with:
```typescript
export class STLexer {
  errors: LexerError[] = [];
  tokenize(source: string): Token[] { ... }
}
```

Core scanning loop pattern:
- `scanToken()` dispatches on current char
- Single-char tokens (`;`, `:`, `(`, `)`, etc.) return immediately
- Multi-char tokens (`<>`, `:=`, `**`, `<=`, `>=`, `=>`) peek ahead
- Numbers: scan integer part, check for `.` → REAL, check for `#` → TYPED_LITERAL
- Strings: scan until matching `'` or `"`, handle unterminated
- Identifiers: scan alphanumeric + `_`, classify via keyword sets
- Time literals: detect `T#`, `TIME#`, `DATE#`, `TOD#`, `DT#` patterns

### Step 4: Run tests to verify they pass

```bash
cd apps/sensor-service && npx jest --config jest.config.js --testPathPattern="st-lexer" --no-coverage
```

Expected: All tests PASS

### Step 5: Commit

```bash
git add apps/sensor-service/src/automation/compiler/
git commit -m "feat(sensor-service): implement IEC 61131-3 ST lexer with full token support"
```

---

## Task 3: ST AST Node Definitions

**Files:**
- Create: `apps/sensor-service/src/automation/compiler/parser/st-ast.ts`

### Step 1: Create AST node types

Define discriminated union types for the AST. Key node types:

```typescript
// Base
interface BaseNode { type: string; line: number; column: number; endLine: number; endColumn: number; }

// Top-level
ProgramNode         { name, variables, body }
FunctionNode        { name, returnType, variables, body }
FunctionBlockNode   { name, variables, body }

// Variable declarations
VarBlockNode        { qualifier: 'VAR'|'VAR_INPUT'|'VAR_OUTPUT'|'VAR_IN_OUT'|'VAR_GLOBAL'|'VAR_TEMP',
                      isConstant, isRetain, declarations }
VarDeclarationNode  { name, dataType, initialValue?, atAddress? }

// Types
SimpleTypeNode      { typeName: string }
ArrayTypeNode       { elementType, ranges: {low, high}[] }
StringTypeNode      { maxLength? }
StructTypeNode      { members }
EnumTypeNode        { members }
SubrangeTypeNode    { baseType, low, high }

// Statements
AssignmentNode      { target, value }
IfNode              { condition, thenBody, elsifClauses, elseBody }
ElsifClauseNode     { condition, body }
CaseNode            { expression, cases, elseBody }
CaseBranchNode      { values, body }
ForNode             { variable, from, to, by, body }
WhileNode           { condition, body }
RepeatNode          { body, condition }
ReturnNode          { value? }
ExitNode
ContinueNode
FunctionCallNode    { name, arguments }
FBCallNode          { instance, arguments }
EmptyStatementNode

// Expressions
BinaryExprNode      { operator, left, right }
UnaryExprNode       { operator, operand }
LiteralNode         { value, literalType }
IdentifierNode      { name }
MemberAccessNode    { object, member }
ArrayAccessNode     { array, indices }
ParenExprNode       { expression }
```

All nodes extend `BaseNode` which carries source location (line/column ranges) for diagnostics and outline support.

Export a union type `ASTNode = ProgramNode | FunctionNode | ...` and `Statement = AssignmentNode | IfNode | ...` and `Expression = BinaryExprNode | ...`.

### Step 2: Commit

```bash
git add apps/sensor-service/src/automation/compiler/parser/st-ast.ts
git commit -m "feat(sensor-service): define IEC 61131-3 AST node types"
```

---

## Task 4: ST Parser (Recursive Descent)

**Files:**
- Create: `apps/sensor-service/src/automation/compiler/parser/st-parser.ts`
- Create: `apps/sensor-service/src/automation/compiler/parser/st-errors.ts`
- Create: `apps/sensor-service/src/automation/compiler/__tests__/st-parser.spec.ts`

### Step 1: Create parse error types

```typescript
// st-errors.ts
export interface ParseError {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  message: string;
  code: string;  // e.g., "P001"
}
```

### Step 2: Write parser tests

Test cases covering:
- `parseProgram()`: PROGRAM...END_PROGRAM with VAR block
- `parseVarBlock()`: VAR...END_VAR with typed declarations, initial values
- `parseIfStatement()`: IF/ELSIF/ELSE/END_IF
- `parseCaseStatement()`: CASE...OF...END_CASE
- `parseForLoop()`: FOR...TO...BY...DO...END_FOR
- `parseWhileLoop()`: WHILE...END_WHILE
- `parseRepeatLoop()`: REPEAT...UNTIL
- `parseAssignment()`: x := expr
- `parseExpression()`: operator precedence (NOT > ** > * / MOD > + - > comparison > AND > XOR > OR)
- `parseFunctionCall()`: ABS(x), custom_func(a, b)
- `parseFBCall()`: timer1(IN := TRUE, PT := T#5s)
- Error recovery: missing semicolons, unmatched END_IF
- Nested structures: IF inside FOR inside PROGRAM

### Step 3: Run test to verify they fail

```bash
cd apps/sensor-service && npx jest --config jest.config.js --testPathPattern="st-parser" --no-coverage
```

### Step 4: Implement the parser

Create `st-parser.ts` - a recursive descent parser. Class structure:

```typescript
export class STParser {
  errors: ParseError[] = [];
  parse(tokens: Token[]): ProgramNode | FunctionNode | FunctionBlockNode | null { ... }
}
```

Key methods:
- `parseProgram()`, `parseFunction()`, `parseFunctionBlock()` — top-level POUs
- `parseVarBlock()` — variable declarations with qualifier, CONSTANT, RETAIN
- `parseStatementList()` — sequence of statements until END_xxx keyword
- `parseStatement()` — dispatches to specific statement parser
- `parseExpression()` — Pratt parser or recursive descent with operator precedence:
  - Level 1 (lowest): OR
  - Level 2: XOR
  - Level 3: AND
  - Level 4: =, <>, <, >, <=, >=
  - Level 5: +, -
  - Level 6: *, /, MOD
  - Level 7: ** (right-associative)
  - Level 8 (highest): NOT, unary -, unary +
- `parsePrimary()` — literals, identifiers, parenthesized expressions, function calls
- Error recovery: on parse error, skip tokens until next semicolon or known keyword, continue parsing

The parser should be tolerant - produce as many AST nodes as possible even with errors, for IDE diagnostics.

### Step 5: Run tests to verify they pass

```bash
cd apps/sensor-service && npx jest --config jest.config.js --testPathPattern="st-parser" --no-coverage
```

### Step 6: Commit

```bash
git add apps/sensor-service/src/automation/compiler/parser/ apps/sensor-service/src/automation/compiler/__tests__/st-parser.spec.ts
git commit -m "feat(sensor-service): implement IEC 61131-3 recursive descent parser"
```

---

## Task 5: Semantic Analyzer (Symbol Table + Type Checker)

**Files:**
- Create: `apps/sensor-service/src/automation/compiler/analyzer/symbol-table.ts`
- Create: `apps/sensor-service/src/automation/compiler/analyzer/type-checker.ts`
- Create: `apps/sensor-service/src/automation/compiler/analyzer/semantic-analyzer.ts`
- Create: `apps/sensor-service/src/automation/compiler/__tests__/semantic-analyzer.spec.ts`

### Step 1: Create symbol table

```typescript
// symbol-table.ts
export interface Symbol {
  name: string;
  kind: 'variable' | 'function' | 'functionBlock' | 'program' | 'type' | 'fbInstance';
  dataType: string;
  scope: 'local' | 'input' | 'output' | 'inout' | 'global' | 'temp';
  isConstant: boolean;
  isRetain: boolean;
  initialValue?: string;
  line: number;
  column: number;
  references: { line: number; column: number }[];
  // For FB instances
  fbType?: string;
  // For functions
  returnType?: string;
  parameters?: Symbol[];
}

export class SymbolTable {
  private scopes: Map<string, Symbol>[] = [new Map()];
  enterScope(): void;
  exitScope(): void;
  define(symbol: Symbol): void;
  resolve(name: string): Symbol | undefined;
  resolveLocal(name: string): Symbol | undefined;
  addReference(name: string, line: number, column: number): void;
  getAllSymbols(): Symbol[];
  getSymbolsInCurrentScope(): Symbol[];
}
```

### Step 2: Create type checker

```typescript
// type-checker.ts
export class TypeChecker {
  /** Check if assignment is type-compatible */
  isAssignmentCompatible(targetType: string, sourceType: string): boolean;
  /** Get result type of binary operation */
  getBinaryResultType(op: string, leftType: string, rightType: string): string | null;
  /** Get result type of unary operation */
  getUnaryResultType(op: string, operandType: string): string | null;
  /** Check if types can be compared */
  isComparable(leftType: string, rightType: string): boolean;
  /** Get function return type */
  getBuiltinReturnType(funcName: string, argTypes: string[]): string | null;
}
```

IEC 61131-3 type compatibility rules:
- Integer types: SINT < INT < DINT < LINT (implicit widening)
- Real types: REAL < LREAL
- Integer ↔ Real: implicit in expressions, assignment may warn
- BOOL: only with BOOL for assignment, any for conditions
- STRING: only with STRING

### Step 3: Create semantic analyzer

```typescript
// semantic-analyzer.ts
import { Diagnostic } from '../services/diagnostic.types';

export class SemanticAnalyzer {
  analyze(ast: ASTNode, externalSymbols?: Symbol[]): AnalysisResult;
}

export interface AnalysisResult {
  diagnostics: Diagnostic[];
  symbols: Symbol[];
  outline: OutlineNode[];
}

export interface OutlineNode {
  name: string;
  kind: 'program' | 'function' | 'functionBlock' | 'variable' | 'if' | 'for' | 'while' | 'case';
  range: { startLine: number; startCol: number; endLine: number; endCol: number };
  children: OutlineNode[];
}

export interface Diagnostic {
  range: { startLine: number; startCol: number; endLine: number; endCol: number };
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  code: string;
  source: 'st-parser';
}
```

The analyzer traverses the AST and:
1. Builds symbol table from VAR blocks
2. Type-checks all assignments and expressions
3. Reports: undeclared variables, type mismatches, unused variables, duplicate declarations
4. Generates outline tree for the editor's outline panel

### Step 4: Write tests

Test cases:
- Undeclared variable → error E001
- Type mismatch in assignment (BOOL := INT) → error E002
- Duplicate variable declaration → error E003
- Unused variable → warning W001
- Constant variable assignment → error E004
- Function return type mismatch → error E005
- Correct program → no diagnostics
- Outline generation for nested structures

### Step 5: Run tests, implement, verify

```bash
cd apps/sensor-service && npx jest --config jest.config.js --testPathPattern="semantic" --no-coverage
```

### Step 6: Commit

```bash
git add apps/sensor-service/src/automation/compiler/analyzer/ apps/sensor-service/src/automation/compiler/__tests__/semantic-analyzer.spec.ts
git commit -m "feat(sensor-service): implement ST semantic analyzer with type checking"
```

---

## Task 6: ST Code Formatter

**Files:**
- Create: `apps/sensor-service/src/automation/compiler/formatter/st-formatter.ts`
- Create: `apps/sensor-service/src/automation/compiler/__tests__/st-formatter.spec.ts`

### Step 1: Write formatter tests

Test cases:
- Indentation: 2 spaces per nesting level
- Keyword casing: uppercase (PROGRAM, IF, VAR, END_IF)
- Spacing around operators (`:=`, `+`, `-`, `*`, `/`, comparison)
- Blank line before/after VAR blocks
- Semicolons at end of statements
- Nested IF/FOR formatting
- No trailing whitespace

### Step 2: Implement formatter

The formatter takes source code, parses it to AST, then emits formatted code. Works at the token level for whitespace/indentation and uses the AST for structural formatting.

```typescript
export class STFormatter {
  format(source: string, options?: FormatOptions): string;
}

export interface FormatOptions {
  indentSize: number;       // default: 2
  uppercaseKeywords: boolean; // default: true
  insertSpaces: boolean;     // default: true
}
```

### Step 3: Run tests, commit

```bash
git add apps/sensor-service/src/automation/compiler/formatter/ apps/sensor-service/src/automation/compiler/__tests__/st-formatter.spec.ts
git commit -m "feat(sensor-service): implement ST code formatter"
```

---

## Task 7: Compiler Module & Interface

**Files:**
- Create: `apps/sensor-service/src/automation/compiler/services/compiler.interface.ts`
- Create: `apps/sensor-service/src/automation/compiler/services/compiler.service.ts`
- Create: `apps/sensor-service/src/automation/compiler/compiler.module.ts`

### Step 1: Create compiler interface (Faz 2 ready)

```typescript
// compiler.interface.ts
export interface ICompilerService {
  compile(source: string, target: CompileTarget): Promise<CompileResult>;
  validate(source: string): Promise<ValidationResult>;
}

export enum CompileTarget {
  CODESYS_ARM = 'CODESYS_ARM',
  CODESYS_X86 = 'CODESYS_X86',
  SIMULATION = 'SIMULATION',
}

export interface CompileResult {
  success: boolean;
  diagnostics: Diagnostic[];
  binary?: Buffer;
  bootApplication?: Buffer;
  compiledAt?: Date;
}
```

### Step 2: Create mock compiler service

Uses the lexer + parser + semantic analyzer for validation. Compile returns mock success. This will be replaced by Codesys REST API client in Faz 2.

```typescript
// compiler.service.ts
@Injectable()
export class CompilerService implements ICompilerService {
  constructor(/* no deps */) {}

  async validate(source: string): Promise<ValidationResult> {
    const lexer = new STLexer();
    const tokens = lexer.tokenize(source);
    const parser = new STParser();
    const ast = parser.parse(tokens);
    const analyzer = new SemanticAnalyzer();
    const result = analyzer.analyze(ast);
    return {
      valid: result.diagnostics.filter(d => d.severity === 'error').length === 0,
      errors: result.diagnostics.filter(d => d.severity === 'error'),
      warnings: result.diagnostics.filter(d => d.severity === 'warning'),
      infos: result.diagnostics.filter(d => d.severity === 'info'),
      parsedSymbols: result.symbols.length,
    };
  }

  async compile(source: string, target: CompileTarget): Promise<CompileResult> {
    const validation = await this.validate(source);
    if (!validation.valid) {
      return { success: false, diagnostics: [...validation.errors, ...validation.warnings] };
    }
    // Faz 2: Codesys Automation Server REST API call
    return { success: true, diagnostics: validation.warnings, compiledAt: new Date() };
  }
}
```

### Step 3: Create compiler module

```typescript
// compiler.module.ts
@Module({
  providers: [CompilerService],
  exports: [CompilerService],
})
export class CompilerModule {}
```

### Step 4: Commit

```bash
git add apps/sensor-service/src/automation/compiler/services/ apps/sensor-service/src/automation/compiler/compiler.module.ts
git commit -m "feat(sensor-service): add compiler service with mock implementation (Faz 2 ready)"
```

---

## Task 8: WebSocket Language Service Gateway

**Files:**
- Create: `apps/sensor-service/src/automation/language-service/st-language.gateway.ts`
- Create: `apps/sensor-service/src/automation/language-service/st-language.service.ts`
- Create: `apps/sensor-service/src/automation/language-service/language-service.module.ts`
- Modify: `apps/sensor-service/src/automation/automation.module.ts` — import LanguageServiceModule

### Step 1: Create language service (business logic)

```typescript
// st-language.service.ts
@Injectable()
export class STLanguageService {
  constructor(
    private readonly compilerService: CompilerService,
    @InjectRepository(AutomationProgram) private readonly programRepo: Repository<AutomationProgram>,
  ) {}

  async analyze(code: string, tenantId?: string): Promise<{
    diagnostics: Diagnostic[];
    outline: OutlineNode[];
    symbols: Symbol[];
  }>;

  async getCompletions(code: string, position: { line: number; character: number }, tenantId?: string): Promise<CompletionItem[]>;

  async getHoverInfo(code: string, position: { line: number; character: number }): Promise<HoverInfo | null>;

  async format(code: string): Promise<string>;

  async getDefinition(code: string, position: { line: number; character: number }): Promise<Location | null>;

  async getReferences(code: string, position: { line: number; character: number }): Promise<Location[]>;
}
```

Key behaviors:
- `analyze()`: Full pipeline (lex → parse → analyze), returns diagnostics + outline + symbols
- `getCompletions()`: Context-aware - inside VAR block suggests types, outside suggests keywords/variables. If tenantId provided, query other programs for FB references. Include SCADA tags.
- `getHoverInfo()`: Looks up symbol under cursor, returns type + description + I/O mapping info
- `format()`: Delegates to STFormatter
- `getDefinition()`: Finds where a variable/function is declared
- `getReferences()`: Finds all usages of a symbol

### Step 2: Create WebSocket gateway

Follow the pattern from `apps/gateway-api/src/websocket/sensor-readings.gateway.ts` for auth.

```typescript
// st-language.gateway.ts
@WebSocketGateway({
  namespace: '/st-language',
  cors: { origin: '*', credentials: false },
})
export class STLanguageGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  constructor(private readonly languageService: STLanguageService) {}

  handleConnection(client: Socket) {
    // Extract tenantId from handshake query or auth
    const tenantId = client.handshake.query.tenantId as string;
    client.data.tenantId = tenantId;
  }

  handleDisconnect(client: Socket) { /* cleanup */ }

  @SubscribeMessage('analyze')
  async handleAnalyze(client: Socket, payload: { requestId: string; code: string; programId?: string }) {
    const result = await this.languageService.analyze(payload.code, client.data.tenantId);
    client.emit('diagnostics', { requestId: payload.requestId, data: result.diagnostics });
    client.emit('outline', { requestId: payload.requestId, data: result.outline });
  }

  @SubscribeMessage('hover')
  async handleHover(client: Socket, payload: { requestId: string; code: string; position: Position }) {
    const result = await this.languageService.getHoverInfo(payload.code, payload.position);
    client.emit('hover', { requestId: payload.requestId, data: result });
  }

  @SubscribeMessage('complete')
  async handleComplete(client: Socket, payload: { requestId: string; code: string; position: Position }) {
    const result = await this.languageService.getCompletions(payload.code, payload.position, client.data.tenantId);
    client.emit('completions', { requestId: payload.requestId, data: result });
  }

  @SubscribeMessage('format')
  async handleFormat(client: Socket, payload: { requestId: string; code: string }) {
    const result = await this.languageService.format(payload.code);
    client.emit('formatted', { requestId: payload.requestId, data: result });
  }

  @SubscribeMessage('definition')
  async handleDefinition(client: Socket, payload: { requestId: string; code: string; position: Position }) {
    const result = await this.languageService.getDefinition(payload.code, payload.position);
    client.emit('definition', { requestId: payload.requestId, data: result });
  }

  @SubscribeMessage('references')
  async handleReferences(client: Socket, payload: { requestId: string; code: string; position: Position }) {
    const result = await this.languageService.getReferences(payload.code, payload.position);
    client.emit('references', { requestId: payload.requestId, data: result });
  }
}
```

### Step 3: Create language service module

```typescript
// language-service.module.ts
@Module({
  imports: [
    TypeOrmModule.forFeature([AutomationProgram]),
    CompilerModule,
  ],
  providers: [STLanguageService, STLanguageGateway],
  exports: [STLanguageService],
})
export class LanguageServiceModule {}
```

### Step 4: Register in automation module

Modify `automation.module.ts` to import `LanguageServiceModule` and `CompilerModule`.

### Step 5: Commit

```bash
git add apps/sensor-service/src/automation/language-service/ apps/sensor-service/src/automation/compiler/compiler.module.ts apps/sensor-service/src/automation/automation.module.ts
git commit -m "feat(sensor-service): add WebSocket language service gateway for ST IDE"
```

---

## Task 9: Backend JSON Bundle Endpoints

**Files:**
- Create: `apps/sensor-service/src/automation/dto/json-bundle.dto.ts`
- Modify: `apps/sensor-service/src/automation/automation.service.ts` — add export/import methods
- Modify: `apps/sensor-service/src/automation/automation.resolver.ts` — add mutations

### Step 1: Create JSON bundle DTO

```typescript
// json-bundle.dto.ts
@InputType()
export class ImportBundleInput {
  @Field() bundleJson: string; // Stringified JSON
  @Field({ nullable: true }) overwriteExisting?: boolean;
}

@ObjectType()
export class ExportBundleOutput {
  @Field() bundleJson: string;
  @Field() programCode: string;
  @Field() exportedAt: Date;
}
```

### Step 2: Add export/import methods to AutomationService

```typescript
// In automation.service.ts add:
async exportBundle(programId: string, tenantId: string): Promise<object> {
  const program = await this.findById(programId, tenantId);
  // Load relations: steps, variables, transitions
  // Serialize to JSON bundle format (per ST-plan.md section 4.4)
  return bundle;
}

async importBundle(bundleJson: string, tenantId: string, createdBy?: string, overwrite?: boolean): Promise<AutomationProgram> {
  // Parse and validate JSON bundle
  // Create or update program with all relations
  return program;
}
```

### Step 3: Add GraphQL mutations to resolver

```typescript
// In automation.resolver.ts add:
@Mutation(() => ExportBundleOutput)
@Roles(TENANT_ADMIN, MODULE_MANAGER)
async exportAutomationBundle(@Args('programId') programId: string, @CurrentTenantId() tenantId: string) { ... }

@Mutation(() => AutomationProgram)
@Roles(TENANT_ADMIN, MODULE_MANAGER)
async importAutomationBundle(@Args('input') input: ImportBundleInput, @CurrentTenantId() tenantId: string, @CurrentUser() user: any) { ... }
```

### Step 4: Add frontend GraphQL queries

Add to `automation.queries.ts`:
```typescript
export const EXPORT_BUNDLE_MUTATION = gql`...`;
export const IMPORT_BUNDLE_MUTATION = gql`...`;
```

### Step 5: Commit

```bash
git add apps/sensor-service/src/automation/dto/json-bundle.dto.ts apps/sensor-service/src/automation/automation.service.ts apps/sensor-service/src/automation/automation.resolver.ts web/modules/sensor-module/src/graphql/automation.queries.ts
git commit -m "feat(sensor-service): add JSON bundle export/import for automation programs"
```

---

## Task 10: Frontend - Enhanced ST Language Definition & Snippets

**Files:**
- Create: `web/modules/sensor-module/src/components/automation/st-editor/providers/st-language.ts`
- Create: `web/modules/sensor-module/src/components/automation/st-editor/providers/st-snippets.ts`

### Step 1: Create enhanced language definition

Enhance the existing monarch tokenizer from current `STEditor.tsx` with:
- Better token classifications for theme support
- Bracket matching for `IF/END_IF`, `FOR/END_FOR`, etc.
- Folding regions based on keyword pairs
- Auto-closing pairs
- Indentation rules (indent after THEN, DO, VAR; dedent at END_*)
- On-enter rules for automatic indentation

```typescript
// st-language.ts
import * as monaco from 'monaco-editor';

export function registerSTLanguage(m: typeof monaco): void {
  // Check if already registered
  if (m.languages.getLanguages().some(l => l.id === 'structured-text')) return;

  m.languages.register({ id: 'structured-text', extensions: ['.st', '.stx'], aliases: ['ST', 'Structured Text'] });

  m.languages.setMonarchTokensProvider('structured-text', { ... });
  m.languages.setLanguageConfiguration('structured-text', {
    comments: { lineComment: '//', blockComment: ['(*', '*)'] },
    brackets: [['(', ')'], ['[', ']']],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: "'", close: "'", notIn: ['string'] },
      { open: '"', close: '"', notIn: ['string'] },
      { open: '(*', close: '*)' },
    ],
    folding: {
      markers: {
        start: /\b(PROGRAM|FUNCTION|FUNCTION_BLOCK|IF|FOR|WHILE|REPEAT|CASE|VAR|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|STRUCT|TYPE|STEP|ACTION|TRANSITION)\b/i,
        end: /\b(END_PROGRAM|END_FUNCTION|END_FUNCTION_BLOCK|END_IF|END_FOR|END_WHILE|END_REPEAT|END_CASE|END_VAR|END_STRUCT|END_TYPE|END_STEP|END_ACTION|END_TRANSITION)\b/i,
      },
    },
    indentationRules: {
      increaseIndentPattern: /\b(THEN|DO|OF|VAR|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_TEMP|ELSE|ELSIF|PROGRAM|FUNCTION|FUNCTION_BLOCK|STRUCT|TYPE|STEP|ACTION|TRANSITION|REPEAT)\s*$/i,
      decreaseIndentPattern: /^\s*(END_IF|END_FOR|END_WHILE|END_REPEAT|END_CASE|END_VAR|END_PROGRAM|END_FUNCTION|END_FUNCTION_BLOCK|END_STRUCT|END_TYPE|END_STEP|END_ACTION|END_TRANSITION|ELSE|ELSIF)\b/i,
    },
  });
}
```

### Step 2: Create snippet provider

```typescript
// st-snippets.ts
import * as monaco from 'monaco-editor';

export function registerSTSnippets(m: typeof monaco): monaco.IDisposable {
  return m.languages.registerCompletionItemProvider('structured-text', {
    triggerCharacters: [],
    provideCompletionItems(model, position) {
      const range = { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column };

      return {
        suggestions: [
          {
            label: 'program',
            kind: m.languages.CompletionItemKind.Snippet,
            insertText: 'PROGRAM ${1:ProgramName}\nVAR\n  ${2:// variables}\nEND_VAR\n\n${3:// code}\n\nEND_PROGRAM',
            insertTextRules: m.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: 'PROGRAM...END_PROGRAM block',
            documentation: 'Creates a new IEC 61131-3 program organization unit',
            range,
          },
          // ... fb, if, ifelse, for, while, repeat, case, ton, tof, tp, ctu, ctd, pid, var, var_input, var_output, sr, rs snippets
          // Each with proper insertText using ${N:placeholder} syntax
        ],
      };
    },
  });
}
```

Include all snippets from ST-plan.md section 4.2 plus additional ones:
- `var` → VAR...END_VAR block
- `var_input` → VAR_INPUT...END_VAR block
- `var_output` → VAR_OUTPUT...END_VAR block
- `repeat` → REPEAT...UNTIL...END_REPEAT
- `struct` → TYPE...STRUCT...END_STRUCT...END_TYPE
- `sr` → SR flip-flop instantiation
- `rtrig` → R_TRIG edge detection

### Step 3: Commit

```bash
git add web/modules/sensor-module/src/components/automation/st-editor/providers/
git commit -m "feat(sensor-module): add enhanced ST language definition and snippet provider"
```

---

## Task 11: Frontend - WebSocket Service & Hook

**Files:**
- Create: `web/modules/sensor-module/src/types/st-editor.types.ts`
- Create: `web/modules/sensor-module/src/services/st-websocket.service.ts`
- Create: `web/modules/sensor-module/src/hooks/useSTLanguageService.ts`

### Step 1: Create shared types

```typescript
// st-editor.types.ts
export interface STDiagnostic {
  range: { startLine: number; startCol: number; endLine: number; endCol: number };
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  code?: string;
  source: 'st-parser';
}

export interface STOutlineNode {
  name: string;
  kind: 'program' | 'function' | 'functionBlock' | 'variable' | 'if' | 'for' | 'while' | 'case';
  range: { startLine: number; startCol: number; endLine: number; endCol: number };
  children: STOutlineNode[];
}

export interface STCompletionItem {
  label: string;
  kind: 'keyword' | 'variable' | 'function' | 'functionBlock' | 'type' | 'snippet' | 'tag';
  detail?: string;
  documentation?: string;
  insertText: string;
  isSnippet?: boolean;
}

export interface STHoverInfo {
  contents: string;
  range?: { startLine: number; startCol: number; endLine: number; endCol: number };
}

export interface STLocation {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export type STRequestType = 'analyze' | 'hover' | 'complete' | 'format' | 'definition' | 'references';
```

### Step 2: Create WebSocket service

```typescript
// st-websocket.service.ts
import { io, Socket } from 'socket.io-client';

export class STWebSocketService {
  private socket: Socket | null = null;
  private pendingRequests = new Map<string, { resolve: Function; reject: Function; timeout: NodeJS.Timeout }>();
  private listeners = new Map<string, Set<Function>>();

  connect(url: string, tenantId: string): void;
  disconnect(): void;
  isConnected(): boolean;

  /** Send request and wait for response */
  async request<T>(type: STRequestType, payload: any): Promise<T>;

  /** Subscribe to event */
  on(event: string, callback: Function): () => void;

  /** Send fire-and-forget */
  emit(type: string, payload: any): void;
}
```

The service:
- Connects to `ws://localhost:4003/st-language` (sensor-service) with tenantId query param
- Generates unique requestId per request
- Matches responses by requestId
- Auto-reconnect with exponential backoff
- Request timeout (5s default)
- Cleanup on disconnect

### Step 3: Create React hook

```typescript
// useSTLanguageService.ts
export function useSTLanguageService(programId?: string) {
  const [diagnostics, setDiagnostics] = useState<STDiagnostic[]>([]);
  const [outline, setOutline] = useState<STOutlineNode[]>([]);
  const [connected, setConnected] = useState(false);

  const serviceRef = useRef<STWebSocketService | null>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  // Connect on mount, disconnect on unmount
  useEffect(() => { ... }, []);

  // Debounced analyze
  const analyze = useCallback((code: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const result = await serviceRef.current?.request('analyze', { code, programId });
      // result comes back as 'diagnostics' and 'outline' events
    }, 300);
  }, [programId]);

  const getCompletions = useCallback(async (code: string, position: Position): Promise<STCompletionItem[]> => { ... }, []);
  const getHoverInfo = useCallback(async (code: string, position: Position): Promise<STHoverInfo | null> => { ... }, []);
  const formatCode = useCallback(async (code: string): Promise<string> => { ... }, []);
  const getDefinition = useCallback(async (code: string, position: Position): Promise<STLocation | null> => { ... }, []);
  const getReferences = useCallback(async (code: string, position: Position): Promise<STLocation[]> => { ... }, []);

  return { diagnostics, outline, connected, analyze, getCompletions, getHoverInfo, formatCode, getDefinition, getReferences };
}
```

### Step 4: Commit

```bash
git add web/modules/sensor-module/src/types/st-editor.types.ts web/modules/sensor-module/src/services/st-websocket.service.ts web/modules/sensor-module/src/hooks/useSTLanguageService.ts
git commit -m "feat(sensor-module): add WebSocket language service client and hook"
```

---

## Task 12: Frontend - Monaco Providers (Completion, Hover, Diagnostics)

**Files:**
- Create: `web/modules/sensor-module/src/components/automation/st-editor/providers/st-completion.ts`
- Create: `web/modules/sensor-module/src/components/automation/st-editor/providers/st-hover.ts`
- Create: `web/modules/sensor-module/src/components/automation/st-editor/providers/st-diagnostics.ts`
- Create: `web/modules/sensor-module/src/components/automation/st-editor/providers/st-formatting.ts`
- Create: `web/modules/sensor-module/src/components/automation/st-editor/providers/st-definition.ts`
- Create: `web/modules/sensor-module/src/components/automation/st-editor/providers/st-references.ts`
- Create: `web/modules/sensor-module/src/components/automation/st-editor/providers/st-symbols.ts`

### Step 1: Create completion provider

The completion provider combines static suggestions (keywords, types, builtins, FBs) with dynamic ones from the WebSocket service (program variables, SCADA tags, other program FBs).

```typescript
// st-completion.ts
export function createSTCompletionProvider(
  monacoInstance: typeof monaco,
  getCompletions: (code: string, position: Position) => Promise<STCompletionItem[]>,
): monaco.IDisposable {
  return monacoInstance.languages.registerCompletionItemProvider('structured-text', {
    triggerCharacters: ['.', '(', ',', ' '],
    async provideCompletionItems(model, position, context, token) {
      const code = model.getValue();
      const pos = { line: position.lineNumber, character: position.column };

      // Get dynamic completions from backend
      const dynamicItems = await getCompletions(code, pos);

      // Combine with static keyword completions
      const suggestions = [
        ...dynamicItems.map(item => ({
          label: item.label,
          kind: mapCompletionKind(monacoInstance, item.kind),
          detail: item.detail,
          documentation: item.documentation,
          insertText: item.insertText,
          insertTextRules: item.isSnippet ? monacoInstance.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          range: wordRange,
        })),
      ];

      return { suggestions };
    },
  });
}
```

### Step 2: Create hover provider

```typescript
// st-hover.ts
export function createSTHoverProvider(
  monacoInstance: typeof monaco,
  getHoverInfo: (code: string, position: Position) => Promise<STHoverInfo | null>,
): monaco.IDisposable {
  return monacoInstance.languages.registerHoverProvider('structured-text', {
    async provideHover(model, position) {
      const code = model.getValue();
      const info = await getHoverInfo(code, { line: position.lineNumber, character: position.column });
      if (!info) return null;
      return {
        contents: [{ value: info.contents, isTrusted: true }],
        range: info.range ? new monacoInstance.Range(...) : undefined,
      };
    },
  });
}
```

### Step 3: Create diagnostics manager

```typescript
// st-diagnostics.ts
export class STDiagnosticsManager {
  private model: monaco.editor.ITextModel | null = null;

  setModel(model: monaco.editor.ITextModel): void { this.model = model; }

  updateDiagnostics(diagnostics: STDiagnostic[], monacoInstance: typeof monaco): void {
    if (!this.model) return;
    const markers = diagnostics.map(d => ({
      severity: mapSeverity(monacoInstance, d.severity),
      message: d.message,
      startLineNumber: d.range.startLine,
      startColumn: d.range.startCol,
      endLineNumber: d.range.endLine,
      endColumn: d.range.endCol,
      source: d.source,
      code: d.code,
    }));
    monacoInstance.editor.setModelMarkers(this.model, 'st-parser', markers);
  }

  clear(monacoInstance: typeof monaco): void {
    if (this.model) monacoInstance.editor.setModelMarkers(this.model, 'st-parser', []);
  }
}
```

### Step 4: Create formatting provider

```typescript
// st-formatting.ts
export function createSTFormattingProvider(
  monacoInstance: typeof monaco,
  formatCode: (code: string) => Promise<string>,
): monaco.IDisposable {
  return monacoInstance.languages.registerDocumentFormattingEditProvider('structured-text', {
    async provideDocumentFormattingEdits(model) {
      const formatted = await formatCode(model.getValue());
      return [{ range: model.getFullModelRange(), text: formatted }];
    },
  });
}
```

### Step 5: Create definition and references providers

```typescript
// st-definition.ts - Go to Definition
// st-references.ts - Find All References
// st-symbols.ts - Document Symbol Provider (for breadcrumbs and outline)
```

Each follows the same pattern: register provider with Monaco, forward request to WebSocket service, map response to Monaco types.

### Step 6: Commit

```bash
git add web/modules/sensor-module/src/components/automation/st-editor/providers/
git commit -m "feat(sensor-module): add Monaco providers for ST IDE (completion, hover, diagnostics, formatting)"
```

---

## Task 13: Frontend - Editor UI Components

**Files:**
- Create: `web/modules/sensor-module/src/components/automation/st-editor/STEditorContainer.tsx`
- Create: `web/modules/sensor-module/src/components/automation/st-editor/STEditorToolbar.tsx`
- Create: `web/modules/sensor-module/src/components/automation/st-editor/STOutlinePanel.tsx`
- Create: `web/modules/sensor-module/src/components/automation/st-editor/STProblemsPanel.tsx`
- Create: `web/modules/sensor-module/src/components/automation/st-editor/STMonacoEditor.tsx`

### Step 1: Create STMonacoEditor (Monaco wrapper)

Core component that:
- Loads Monaco lazily with `@monaco-editor/react`
- Registers the ST language definition, snippets
- Sets up all providers (completion, hover, formatting, definition, references, symbols) using the WebSocket service callbacks
- Manages the diagnostics manager
- Forwards `onChange` with debounced analysis
- Exposes editor ref for parent access

```typescript
// STMonacoEditor.tsx
interface STMonacoEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  onAnalyze: (code: string) => void;
  getCompletions: (code: string, pos: Position) => Promise<STCompletionItem[]>;
  getHoverInfo: (code: string, pos: Position) => Promise<STHoverInfo | null>;
  formatCode: (code: string) => Promise<string>;
  getDefinition: (code: string, pos: Position) => Promise<STLocation | null>;
  getReferences: (code: string, pos: Position) => Promise<STLocation[]>;
  diagnostics: STDiagnostic[];
  editorRef?: React.MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>;
}
```

Editor options:
- fontSize: 14, fontFamily: 'JetBrains Mono, Fira Code, Consolas, monospace'
- minimap: enabled, scale 1
- lineNumbers: on
- renderWhitespace: 'selection'
- bracketPairColorization: enabled
- guides (indentation, brackets): enabled
- suggest.preview: true
- scrollBeyondLastLine: false
- automaticLayout: true
- tabSize: 2

### Step 2: Create STEditorToolbar

```typescript
// STEditorToolbar.tsx
interface STEditorToolbarProps {
  onSave: () => void;
  onValidate: () => void;
  onFormat: () => void;
  onExport: () => void;
  onImport: () => void;
  isSaving?: boolean;
  isValidating?: boolean;
  connected: boolean; // WebSocket connection indicator
  diagnosticCounts: { errors: number; warnings: number; infos: number };
}
```

Toolbar buttons with lucide-react icons:
- Save (Save icon)
- Validate (CheckCircle icon)
- Format (AlignLeft icon)
- Export JSON (Download icon)
- Import JSON (Upload icon)
- Connection status indicator (green dot = connected, red = disconnected)
- Diagnostic summary badge (3 errors, 2 warnings)

### Step 3: Create STOutlinePanel

```typescript
// STOutlinePanel.tsx
interface STOutlinePanelProps {
  outline: STOutlineNode[];
  onNavigate: (line: number, column: number) => void;
  collapsed?: boolean;
  onToggleCollapse: () => void;
}
```

Renders a tree view of the AST outline:
- PROGRAM/FUNCTION/FB as top-level nodes
- VAR blocks as children
- Control flow (IF, FOR, WHILE) as nested children
- Click to navigate to source line
- Collapsible panel with drag-to-resize border
- Icons per node kind (using lucide-react)

### Step 4: Create STProblemsPanel

Reuses the existing `ValidationDiagnostic` interface from `CompileResultPanel.tsx`.

```typescript
// STProblemsPanel.tsx
interface STProblemsPanelProps {
  diagnostics: STDiagnostic[];
  onNavigate: (line: number, column: number) => void;
  collapsed?: boolean;
  onToggleCollapse: () => void;
}
```

Features:
- Tab bar: Errors (count) | Warnings (count) | Info (count)
- Sortable by line number
- Click to navigate to error location
- Color-coded severity icons
- Collapsible panel

### Step 5: Create STEditorContainer (main layout)

```typescript
// STEditorContainer.tsx
interface STEditorContainerProps {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onValidate?: () => void;
  programId?: string;
  readOnly?: boolean;
  // JSON bundle
  onExport?: () => void;
  onImport?: () => void;
}
```

Layout using CSS Grid:
```
grid-template-rows: auto 1fr auto
grid-template-columns: minmax(180px, 220px) 1fr

[toolbar]                    → spans full width
[outline-panel] [monaco]     → main area
[problems-panel]             → spans full width
```

- Uses `useSTLanguageService` hook for WebSocket connection
- Passes callbacks to STMonacoEditor
- Manages panel collapse state
- Keyboard shortcuts: Ctrl+S (save), Ctrl+Shift+F (format), F5 (validate)

### Step 6: Commit

```bash
git add web/modules/sensor-module/src/components/automation/st-editor/
git commit -m "feat(sensor-module): add ST IDE editor components (container, toolbar, outline, problems)"
```

---

## Task 14: Frontend - JSON Bundle UI

**Files:**
- Create: `web/modules/sensor-module/src/components/automation/json-bundle/ExportDialog.tsx`
- Create: `web/modules/sensor-module/src/components/automation/json-bundle/ImportDialog.tsx`
- Create: `web/modules/sensor-module/src/components/automation/json-bundle/bundle.utils.ts`

### Step 1: Create bundle utilities

```typescript
// bundle.utils.ts
export interface AutomationBundle {
  version: '1.0';
  exportedAt: string;
  exportedBy?: string;
  platform: 'suderra-aquaculture';
  program: { ... };
  variables: { ... }[];
  steps: { ... }[];
  transitions: { ... }[];
  deployConfig?: { ... };
}

export function serializeBundle(program: any, variables: any[], steps: any[], transitions: any[]): AutomationBundle;
export function deserializeBundle(json: string): { valid: boolean; bundle?: AutomationBundle; errors?: string[] };
export function downloadBundle(bundle: AutomationBundle): void; // Triggers browser download
export function validateBundleSchema(bundle: unknown): { valid: boolean; errors: string[] };
```

### Step 2: Create ExportDialog

Dialog that:
- Shows program name and code
- Preview of the JSON (read-only Monaco editor with JSON mode, small)
- "Download JSON" button → triggers file download as `{programCode}.json`
- "Copy to Clipboard" button

### Step 3: Create ImportDialog

Dialog that:
- File upload zone (drag & drop or click to browse, accept `.json`)
- Validates the uploaded JSON against bundle schema
- Shows validation errors if any
- Shows preview: program name, variable count, step count
- "Import" button → calls `importAutomationBundle` mutation
- Option: "Overwrite if program code exists"

### Step 4: Commit

```bash
git add web/modules/sensor-module/src/components/automation/json-bundle/
git commit -m "feat(sensor-module): add JSON bundle export/import UI"
```

---

## Task 15: Integration - Wire Into AutomationProgramEditorPage

**Files:**
- Modify: `web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx`
- Delete: `web/modules/sensor-module/src/components/automation/STEditor.tsx` (old editor)

### Step 1: Replace ST Code tab content

In `AutomationProgramEditorPage.tsx`, replace the 'code' tab content:

**Before:**
```tsx
{activeTab === 'code' && (
  <Box>
    <STEditor value={stCode} onChange={setStCode} height="500px" />
    {/* validation button, CompileResultPanel */}
  </Box>
)}
```

**After:**
```tsx
{activeTab === 'code' && (
  <STEditorContainer
    value={stCode}
    onChange={setStCode}
    onSave={handleSave}
    onValidate={handleValidate}
    programId={programId}
    readOnly={program?.status === ProgramStatus.DEPLOYED}
    onExport={() => setExportDialogOpen(true)}
    onImport={() => setImportDialogOpen(true)}
  />
)}
```

### Step 2: Add export/import dialog state and rendering

Add state variables and render ExportDialog / ImportDialog components. Wire up to GraphQL mutations.

### Step 3: Remove old STEditor import

Remove the import of `STEditor` and the old component file. All functionality is now in `STEditorContainer`.

### Step 4: Verify the page loads correctly

```bash
cd web/modules/sensor-module && npm run build
```

Expected: Build succeeds with no errors.

### Step 5: Commit

```bash
git add web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx
git rm web/modules/sensor-module/src/components/automation/STEditor.tsx
git commit -m "feat(sensor-module): integrate ST IDE into automation editor page, remove old STEditor"
```

---

## Task 16: Backend Build Verification

### Step 1: Build sensor-service

```bash
npx nx build sensor-service
```

Expected: Build succeeds.

### Step 2: Run existing tests

```bash
cd apps/sensor-service && npx jest --config jest.config.js --testPathPattern="automation" --no-coverage
```

Expected: All tests pass (existing + new).

### Step 3: Build sensor-module frontend

```bash
npx nx build sensor-module
```

Expected: Build succeeds.

### Step 4: Final commit

```bash
git add -A
git commit -m "chore: build verification for ST IDE feature"
```

---

## Dependency Order

```
Task 1 (Tokens/Keywords)
  └→ Task 2 (Lexer)
       └→ Task 3 (AST)
            └→ Task 4 (Parser)
                 └→ Task 5 (Semantic Analyzer)
                      └→ Task 6 (Formatter)
                           └→ Task 7 (Compiler Module)
                                └→ Task 8 (WS Language Service)
                                     └→ Task 9 (JSON Bundle Backend)

Task 10 (ST Language Def + Snippets) ← independent, can start early

Task 11 (WS Service + Hook) ← depends on Task 8 (gateway must exist)
  └→ Task 12 (Monaco Providers) ← depends on Task 11
       └→ Task 13 (Editor Components) ← depends on Task 12
            └→ Task 14 (JSON Bundle UI) ← depends on Task 9 + Task 13
                 └→ Task 15 (Integration) ← depends on Task 13 + Task 14
                      └→ Task 16 (Build Verification)
```

**Parallelizable:** Tasks 1-9 (backend) and Task 10 (frontend language def) can be done in parallel by different agents.
