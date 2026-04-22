# ST Code Simulation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** ST kodunu edge device'a deploy etmeden önce tarayıcıda çalıştırıp test edebilmek — kullanıcı "dozaj pompasını aç" yazdığında hangi değişkenlerin nasıl değiştiğini görsün.

**Architecture:** Mevcut backend ST parser'ın ürettiği AST'yi frontend'de interpret eden bir browser-side engine. Parser backend'de zaten çalışıyor (lexer → parser → AST). Biz AST'yi frontend'e alıp bir tree-walker interpreter yazacağız. Interpreter bir "scan cycle" mantığıyla çalışır — her cycle'da tüm statement'lar sırayla evaluate edilir, variable state güncellenir. Kullanıcı INPUT değişkenlerini manuel set eder, OUTPUT'ları izler.

**Tech Stack:** TypeScript (pure, UI framework bağımsız), React state, mevcut AST tipleri (st-ast.ts'den kopyalanacak — backend'le aynı interface'ler)

---

## Faz 1: ST Interpreter + Variable Watch Table

### Task 1: AST Type Definitions (Frontend)

**Files:**
- Create: `web/modules/sensor-module/src/simulation/st-ast-types.ts`

Backend `st-ast.ts`'deki interface'leri frontend'e kopyalıyoruz. Backend import edemeyiz (farklı workspace), bu yüzden tip tanımlarını çoğaltıyoruz. Sadece interpreter'ın ihtiyaç duyduğu tipler:

**Step 1: AST tip dosyasını oluştur**

```typescript
/**
 * IEC 61131-3 Structured Text AST Type Definitions
 *
 * Mirror of backend st-ast.ts interfaces — kept in sync manually.
 * Only types needed by the browser-side interpreter are included.
 */

// ── Source Location ──────────────────────────────────────────
export interface SourceLocation {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

// ── Top-level POU ────────────────────────────────────────────
export type ASTNode = ProgramNode | FunctionBlockNode | FunctionNode;

export interface ProgramNode {
  kind: 'program';
  name: string;
  varBlocks: VarBlockNode[];
  body: Statement[];
  location: SourceLocation;
}

export interface FunctionBlockNode {
  kind: 'functionBlock';
  name: string;
  varBlocks: VarBlockNode[];
  body: Statement[];
  methods?: MethodNode[];
  extends?: string;
  implements?: string[];
  location: SourceLocation;
}

export interface FunctionNode {
  kind: 'function';
  name: string;
  returnType: TypeNode;
  varBlocks: VarBlockNode[];
  body: Statement[];
  location: SourceLocation;
}

export interface MethodNode {
  kind: 'method';
  name: string;
  returnType?: TypeNode;
  accessSpecifier?: string;
  varBlocks: VarBlockNode[];
  body: Statement[];
  location: SourceLocation;
}

// ── Variable Declarations ────────────────────────────────────
export type VarBlockKind =
  | 'VAR' | 'VAR_INPUT' | 'VAR_OUTPUT' | 'VAR_IN_OUT'
  | 'VAR_GLOBAL' | 'VAR_TEMP' | 'VAR_EXTERNAL';

export interface VarBlockNode {
  kind: 'varBlock';
  blockType: VarBlockKind;
  constant?: boolean;
  retain?: boolean;
  persistent?: boolean;
  declarations: VarDeclarationNode[];
  location: SourceLocation;
}

export interface VarDeclarationNode {
  kind: 'varDeclaration';
  names: string[];
  type: TypeNode;
  initialValue?: Expression;
  atAddress?: string;
  location: SourceLocation;
}

// ── Type Nodes ───────────────────────────────────────────────
export type TypeNode =
  | ElementaryTypeNode
  | ArrayTypeNode
  | StringTypeNode
  | NamedTypeNode
  | EnumTypeNode
  | StructTypeNode
  | SubrangeTypeNode;

export interface ElementaryTypeNode { kind: 'elementaryType'; name: string; }
export interface ArrayTypeNode { kind: 'arrayType'; dimensions: ArrayDimension[]; elementType: TypeNode; }
export interface ArrayDimension { lower: Expression; upper: Expression; }
export interface StringTypeNode { kind: 'stringType'; baseType: 'STRING' | 'WSTRING'; maxLength?: number; }
export interface NamedTypeNode { kind: 'namedType'; name: string; }
export interface EnumTypeNode { kind: 'enumType'; baseType?: TypeNode; members: EnumMemberNode[]; }
export interface EnumMemberNode { kind: 'enumMember'; name: string; value?: Expression; }
export interface StructTypeNode { kind: 'structType'; members: StructMemberNode[]; }
export interface StructMemberNode { kind: 'structMember'; name: string; type: TypeNode; initialValue?: Expression; location: SourceLocation; }
export interface SubrangeTypeNode { kind: 'subrangeType'; baseType: TypeNode; lower: Expression; upper: Expression; }

// ── Statements ───────────────────────────────────────────────
export type Statement =
  | AssignmentStatement
  | IfStatement
  | CaseStatement
  | ForStatement
  | WhileStatement
  | RepeatStatement
  | ReturnStatement
  | ExitStatement
  | ExpressionStatement
  | EmptyStatement;

export interface AssignmentStatement {
  kind: 'assignment';
  target: Expression;
  value: Expression;
  location: SourceLocation;
}

export interface IfStatement {
  kind: 'ifStatement';
  condition: Expression;
  thenBody: Statement[];
  elsifBranches?: ElsifBranch[];
  elseBody?: Statement[];
  location: SourceLocation;
}

export interface ElsifBranch {
  condition: Expression;
  body: Statement[];
  location: SourceLocation;
}

export interface CaseStatement {
  kind: 'caseStatement';
  expression: Expression;
  cases: CaseBranch[];
  elseBody?: Statement[];
  location: SourceLocation;
}

export interface CaseBranch {
  labels: CaseLabel[];
  body: Statement[];
}

export type CaseLabel =
  | { kind: 'single'; value: Expression }
  | { kind: 'range'; lower: Expression; upper: Expression };

export interface ForStatement {
  kind: 'forStatement';
  variable: string;
  from: Expression;
  to: Expression;
  by?: Expression;
  body: Statement[];
  location: SourceLocation;
}

export interface WhileStatement {
  kind: 'whileStatement';
  condition: Expression;
  body: Statement[];
  location: SourceLocation;
}

export interface RepeatStatement {
  kind: 'repeatStatement';
  body: Statement[];
  condition: Expression;
  location: SourceLocation;
}

export interface ReturnStatement {
  kind: 'returnStatement';
  location: SourceLocation;
}

export interface ExitStatement {
  kind: 'exitStatement';
  location: SourceLocation;
}

export interface ExpressionStatement {
  kind: 'expressionStatement';
  expression: Expression;
  location: SourceLocation;
}

export interface EmptyStatement {
  kind: 'emptyStatement';
  location: SourceLocation;
}

// ── Expressions ──────────────────────────────────────────────
export type Expression =
  | BinaryExpression
  | UnaryExpression
  | FunctionCallExpression
  | ArrayAccessExpression
  | MemberAccessExpression
  | IdentifierExpression
  | IntegerLiteral
  | RealLiteral
  | StringLiteral
  | BooleanLiteral
  | TimeLiteral
  | ParenthesizedExpression;

export type BinaryOperator =
  | 'OR' | 'XOR' | 'AND'
  | '=' | '<>' | '<' | '>' | '<=' | '>='
  | '+' | '-' | '*' | '/' | 'MOD' | '**';

export type UnaryOperator = 'NOT' | '-' | '+';

export interface BinaryExpression {
  kind: 'binaryExpression';
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
  location: SourceLocation;
}

export interface UnaryExpression {
  kind: 'unaryExpression';
  operator: UnaryOperator;
  operand: Expression;
  location: SourceLocation;
}

export interface FunctionCallExpression {
  kind: 'functionCall';
  name: string;
  args: Expression[];
  namedArgs?: NamedArgument[];
  location: SourceLocation;
}

export interface NamedArgument {
  name: string;
  value: Expression;
  assignType: 'input' | 'output';
}

export interface ArrayAccessExpression {
  kind: 'arrayAccess';
  array: Expression;
  indices: Expression[];
  location: SourceLocation;
}

export interface MemberAccessExpression {
  kind: 'memberAccess';
  object: Expression;
  member: string;
  location: SourceLocation;
}

export interface IdentifierExpression {
  kind: 'identifier';
  name: string;
  location: SourceLocation;
}

export interface IntegerLiteral { kind: 'integerLiteral'; value: number; raw: string; location: SourceLocation; }
export interface RealLiteral { kind: 'realLiteral'; value: number; raw: string; location: SourceLocation; }
export interface StringLiteral { kind: 'stringLiteral'; value: string; raw: string; location: SourceLocation; }
export interface BooleanLiteral { kind: 'booleanLiteral'; value: boolean; raw: string; location: SourceLocation; }
export interface TimeLiteral { kind: 'timeLiteral'; raw: string; location: SourceLocation; }
export interface ParenthesizedExpression { kind: 'parenthesized'; expression: Expression; location: SourceLocation; }
```

**Step 2: Commit**

```bash
git add web/modules/sensor-module/src/simulation/st-ast-types.ts
git commit -m "feat(simulation): add frontend AST type definitions for ST interpreter"
```

---

### Task 2: ST Lightweight Parser (Frontend)

**Files:**
- Create: `web/modules/sensor-module/src/simulation/st-parser-lite.ts`
- Test: `web/modules/sensor-module/src/simulation/__tests__/st-parser-lite.test.ts`

Backend parser'ı çok büyük (~2000 satır) ve backend-only bağımlılıkları var. Frontend için lightweight bir parser yazıyoruz. Bu parser backend kadar kapsamlı olmak zorunda değil — simülasyon için gereken temel yapıları parse etmesi yeterli: PROGRAM/END_PROGRAM, VAR blokları, IF/ELSIF/ELSE, CASE, FOR, WHILE, REPEAT, assignment, arithmetic, boolean, comparison, function calls.

**Step 1: Test dosyasını oluştur**

```typescript
import { parseST } from '../st-parser-lite';

describe('ST Lightweight Parser', () => {
  describe('Variable declarations', () => {
    it('parses VAR block with BOOL, INT, REAL', () => {
      const code = `
PROGRAM Main
VAR
  pump_on : BOOL := FALSE;
  temperature : REAL := 25.0;
  counter : INT := 0;
END_VAR
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      expect(result.ast).toHaveLength(1);
      const prog = result.ast[0];
      expect(prog.kind).toBe('program');
      expect(prog.name).toBe('Main');
      if (prog.kind !== 'program') return;
      expect(prog.varBlocks).toHaveLength(1);
      const vars = prog.varBlocks[0].declarations;
      expect(vars).toHaveLength(3);
      expect(vars[0].names).toEqual(['pump_on']);
      expect(vars[1].names).toEqual(['temperature']);
    });

    it('parses VAR_INPUT and VAR_OUTPUT blocks', () => {
      const code = `
PROGRAM Dosing
VAR_INPUT
  start_cmd : BOOL;
  setpoint : REAL := 7.0;
END_VAR
VAR_OUTPUT
  pump_running : BOOL;
  actual_dose : REAL;
END_VAR
VAR
  timer_val : INT := 0;
END_VAR
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      expect(result.ast[0].varBlocks).toHaveLength(3);
      expect(result.ast[0].varBlocks[0].blockType).toBe('VAR_INPUT');
      expect(result.ast[0].varBlocks[1].blockType).toBe('VAR_OUTPUT');
      expect(result.ast[0].varBlocks[2].blockType).toBe('VAR');
    });
  });

  describe('Statements', () => {
    it('parses IF/ELSIF/ELSE', () => {
      const code = `
PROGRAM Main
VAR
  x : INT := 0;
  y : INT := 0;
END_VAR
  IF x > 10 THEN
    y := 1;
  ELSIF x > 5 THEN
    y := 2;
  ELSE
    y := 3;
  END_IF;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      expect(result.ast[0].body[0].kind).toBe('ifStatement');
    });

    it('parses FOR loop', () => {
      const code = `
PROGRAM Main
VAR
  i : INT;
  sum : INT := 0;
END_VAR
  FOR i := 1 TO 10 BY 2 DO
    sum := sum + i;
  END_FOR;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const forStmt = result.ast[0].body[0];
      expect(forStmt.kind).toBe('forStatement');
    });

    it('parses assignment with arithmetic', () => {
      const code = `
PROGRAM Main
VAR
  a : REAL := 0.0;
  b : REAL := 5.0;
END_VAR
  a := b * 2.0 + 1.5;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      expect(result.ast[0].body[0].kind).toBe('assignment');
    });

    it('parses CASE statement', () => {
      const code = `
PROGRAM Main
VAR
  state : INT := 0;
  output : BOOL := FALSE;
END_VAR
  CASE state OF
    0: output := FALSE;
    1: output := TRUE;
    2, 3: output := FALSE;
  ELSE
    output := FALSE;
  END_CASE;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      expect(result.ast[0].body[0].kind).toBe('caseStatement');
    });

    it('parses WHILE loop', () => {
      const code = `
PROGRAM Main
VAR
  n : INT := 10;
END_VAR
  WHILE n > 0 DO
    n := n - 1;
  END_WHILE;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
    });

    it('parses function calls', () => {
      const code = `
PROGRAM Main
VAR
  x : REAL := -5.0;
  y : REAL;
END_VAR
  y := ABS(x);
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('Dosing pump scenario', () => {
    it('parses a realistic dosing pump program', () => {
      const code = `
PROGRAM DosingPump
VAR_INPUT
  start_command : BOOL;
  ph_value : REAL;
  ph_setpoint : REAL := 7.0;
END_VAR
VAR_OUTPUT
  pump_active : BOOL;
  valve_open : BOOL;
  alarm : BOOL;
END_VAR
VAR
  error : REAL;
  dose_timer : INT := 0;
  max_dose_time : INT := 300;
END_VAR
  error := ph_setpoint - ph_value;

  IF NOT start_command THEN
    pump_active := FALSE;
    valve_open := FALSE;
    dose_timer := 0;
  ELSIF error > 0.5 THEN
    pump_active := TRUE;
    valve_open := TRUE;
    dose_timer := dose_timer + 1;
  ELSIF error > 0.1 THEN
    pump_active := TRUE;
    valve_open := FALSE;
    dose_timer := dose_timer + 1;
  ELSE
    pump_active := FALSE;
    valve_open := FALSE;
    dose_timer := 0;
  END_IF;

  IF dose_timer > max_dose_time THEN
    alarm := TRUE;
    pump_active := FALSE;
    valve_open := FALSE;
  END_IF;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      expect(result.ast[0].kind).toBe('program');
      if (result.ast[0].kind !== 'program') return;
      expect(result.ast[0].varBlocks).toHaveLength(3);
      expect(result.ast[0].body.length).toBeGreaterThan(0);
    });
  });
});
```

**Step 2: Test'i çalıştır, FAIL olduğunu doğrula**

```bash
cd web/modules/sensor-module
npx vitest run src/simulation/__tests__/st-parser-lite.test.ts
```

Expected: FAIL — `parseST` not found

**Step 3: Parser implementasyonunu yaz**

`st-parser-lite.ts` — ~600 satır, recursive descent parser. Backend parser'ın basitleştirilmiş versiyonu. Tokenizer + parser tek dosyada.

Desteklenen yapılar:
- PROGRAM / END_PROGRAM
- FUNCTION_BLOCK / END_FUNCTION_BLOCK
- VAR / VAR_INPUT / VAR_OUTPUT / VAR_IN_OUT / END_VAR (CONSTANT, RETAIN)
- Elementary types: BOOL, INT, DINT, SINT, UINT, REAL, LREAL, STRING, TIME
- IF / ELSIF / ELSE / END_IF
- CASE / OF / END_CASE
- FOR / TO / BY / DO / END_FOR
- WHILE / DO / END_WHILE
- REPEAT / UNTIL / END_REPEAT
- Assignment (:=)
- Arithmetic: +, -, *, /, MOD, **
- Comparison: =, <>, <, >, <=, >=
- Boolean: AND, OR, XOR, NOT
- Function calls: name(args)
- Literals: integer, real, string, boolean, time
- Comments: // ve (* *)

**Step 4: Test'leri tekrar çalıştır, PASS olduğunu doğrula**

```bash
cd web/modules/sensor-module
npx vitest run src/simulation/__tests__/st-parser-lite.test.ts
```

Expected: ALL PASS

**Step 5: Commit**

```bash
git add web/modules/sensor-module/src/simulation/st-parser-lite.ts
git add web/modules/sensor-module/src/simulation/__tests__/st-parser-lite.test.ts
git commit -m "feat(simulation): add lightweight ST parser for browser-side interpretation"
```

---

### Task 3: ST Interpreter Engine

**Files:**
- Create: `web/modules/sensor-module/src/simulation/st-interpreter.ts`
- Test: `web/modules/sensor-module/src/simulation/__tests__/st-interpreter.test.ts`

Interpreter, parse edilmiş AST'yi alıp çalıştırır. Her "scan cycle" = tüm body statement'ların sırayla evaluate edilmesi. Variable state bir `Map<string, SimValue>` içinde tutulur.

**Step 1: Test dosyasını oluştur**

```typescript
import { parseST } from '../st-parser-lite';
import { StInterpreter, SimValue } from '../st-interpreter';

describe('ST Interpreter', () => {
  function run(code: string, inputs?: Record<string, SimValue>) {
    const { ast, errors } = parseST(code);
    expect(errors).toHaveLength(0);
    const interp = new StInterpreter(ast[0]);
    if (inputs) {
      for (const [name, val] of Object.entries(inputs)) {
        interp.setVariable(name, val);
      }
    }
    interp.runCycle();
    return interp;
  }

  describe('Variable initialization', () => {
    it('initializes variables with default values', () => {
      const interp = run(`
PROGRAM Main
VAR
  a : BOOL := TRUE;
  b : INT := 42;
  c : REAL := 3.14;
  d : BOOL;
END_VAR
END_PROGRAM`);
      expect(interp.getVariable('a')).toBe(true);
      expect(interp.getVariable('b')).toBe(42);
      expect(interp.getVariable('c')).toBeCloseTo(3.14);
      expect(interp.getVariable('d')).toBe(false); // BOOL default
    });
  });

  describe('Assignment & arithmetic', () => {
    it('evaluates arithmetic expressions', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : REAL := 0.0;
END_VAR
  x := 2.0 * 3.0 + 1.0;
END_PROGRAM`);
      expect(interp.getVariable('x')).toBeCloseTo(7.0);
    });

    it('handles operator precedence', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : REAL := 0.0;
END_VAR
  x := 2.0 + 3.0 * 4.0;
END_PROGRAM`);
      expect(interp.getVariable('x')).toBeCloseTo(14.0);
    });

    it('handles MOD operator', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : INT := 0;
END_VAR
  x := 17 MOD 5;
END_PROGRAM`);
      expect(interp.getVariable('x')).toBe(2);
    });
  });

  describe('IF/ELSIF/ELSE', () => {
    it('takes THEN branch when condition true', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : INT := 15;
  result : INT := 0;
END_VAR
  IF x > 10 THEN
    result := 1;
  ELSE
    result := 2;
  END_IF;
END_PROGRAM`);
      expect(interp.getVariable('result')).toBe(1);
    });

    it('takes ELSIF branch', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : INT := 7;
  result : INT := 0;
END_VAR
  IF x > 10 THEN
    result := 1;
  ELSIF x > 5 THEN
    result := 2;
  ELSE
    result := 3;
  END_IF;
END_PROGRAM`);
      expect(interp.getVariable('result')).toBe(2);
    });

    it('takes ELSE branch', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : INT := 2;
  result : INT := 0;
END_VAR
  IF x > 10 THEN
    result := 1;
  ELSIF x > 5 THEN
    result := 2;
  ELSE
    result := 3;
  END_IF;
END_PROGRAM`);
      expect(interp.getVariable('result')).toBe(3);
    });
  });

  describe('FOR loop', () => {
    it('sums 1 to 10', () => {
      const interp = run(`
PROGRAM Main
VAR
  i : INT;
  sum : INT := 0;
END_VAR
  FOR i := 1 TO 10 DO
    sum := sum + i;
  END_FOR;
END_PROGRAM`);
      expect(interp.getVariable('sum')).toBe(55);
    });

    it('respects BY step', () => {
      const interp = run(`
PROGRAM Main
VAR
  i : INT;
  sum : INT := 0;
END_VAR
  FOR i := 0 TO 10 BY 2 DO
    sum := sum + 1;
  END_FOR;
END_PROGRAM`);
      expect(interp.getVariable('sum')).toBe(6); // 0,2,4,6,8,10
    });
  });

  describe('WHILE loop', () => {
    it('counts down', () => {
      const interp = run(`
PROGRAM Main
VAR
  n : INT := 5;
  count : INT := 0;
END_VAR
  WHILE n > 0 DO
    n := n - 1;
    count := count + 1;
  END_WHILE;
END_PROGRAM`);
      expect(interp.getVariable('n')).toBe(0);
      expect(interp.getVariable('count')).toBe(5);
    });

    it('does not enter body when condition false', () => {
      const interp = run(`
PROGRAM Main
VAR
  n : INT := 0;
  count : INT := 0;
END_VAR
  WHILE n > 0 DO
    count := count + 1;
  END_WHILE;
END_PROGRAM`);
      expect(interp.getVariable('count')).toBe(0);
    });
  });

  describe('CASE statement', () => {
    it('matches correct case', () => {
      const interp = run(`
PROGRAM Main
VAR
  state : INT := 2;
  output : INT := 0;
END_VAR
  CASE state OF
    0: output := 10;
    1: output := 20;
    2: output := 30;
  ELSE
    output := 99;
  END_CASE;
END_PROGRAM`);
      expect(interp.getVariable('output')).toBe(30);
    });

    it('falls to ELSE when no match', () => {
      const interp = run(`
PROGRAM Main
VAR
  state : INT := 9;
  output : INT := 0;
END_VAR
  CASE state OF
    0: output := 10;
    1: output := 20;
  ELSE
    output := 99;
  END_CASE;
END_PROGRAM`);
      expect(interp.getVariable('output')).toBe(99);
    });
  });

  describe('Boolean operations', () => {
    it('evaluates AND, OR, NOT', () => {
      const interp = run(`
PROGRAM Main
VAR
  a : BOOL := TRUE;
  b : BOOL := FALSE;
  r1 : BOOL;
  r2 : BOOL;
  r3 : BOOL;
END_VAR
  r1 := a AND b;
  r2 := a OR b;
  r3 := NOT b;
END_PROGRAM`);
      expect(interp.getVariable('r1')).toBe(false);
      expect(interp.getVariable('r2')).toBe(true);
      expect(interp.getVariable('r3')).toBe(true);
    });
  });

  describe('Built-in functions', () => {
    it('ABS returns absolute value', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : REAL := 0.0;
END_VAR
  x := ABS(-5.5);
END_PROGRAM`);
      expect(interp.getVariable('x')).toBeCloseTo(5.5);
    });

    it('MIN/MAX work', () => {
      const interp = run(`
PROGRAM Main
VAR
  a : REAL := 0.0;
  b : REAL := 0.0;
END_VAR
  a := MIN(3.0, 7.0);
  b := MAX(3.0, 7.0);
END_PROGRAM`);
      expect(interp.getVariable('a')).toBeCloseTo(3.0);
      expect(interp.getVariable('b')).toBeCloseTo(7.0);
    });
  });

  describe('External inputs (VAR_INPUT)', () => {
    it('accepts externally set input values', () => {
      const interp = run(`
PROGRAM DosingPump
VAR_INPUT
  start_command : BOOL;
  ph_value : REAL;
END_VAR
VAR_OUTPUT
  pump_active : BOOL;
END_VAR
VAR
  error : REAL;
  ph_setpoint : REAL := 7.0;
END_VAR
  error := ph_setpoint - ph_value;
  IF start_command AND error > 0.5 THEN
    pump_active := TRUE;
  ELSE
    pump_active := FALSE;
  END_IF;
END_PROGRAM`, {
        start_command: true,
        ph_value: 6.0,
      });
      expect(interp.getVariable('pump_active')).toBe(true);
      expect(interp.getVariable('error')).toBeCloseTo(1.0);
    });

    it('pump stays off when not commanded', () => {
      const interp = run(`
PROGRAM DosingPump
VAR_INPUT
  start_command : BOOL;
  ph_value : REAL;
END_VAR
VAR_OUTPUT
  pump_active : BOOL;
END_VAR
VAR
  error : REAL;
  ph_setpoint : REAL := 7.0;
END_VAR
  error := ph_setpoint - ph_value;
  IF start_command AND error > 0.5 THEN
    pump_active := TRUE;
  ELSE
    pump_active := FALSE;
  END_IF;
END_PROGRAM`, {
        start_command: false,
        ph_value: 6.0,
      });
      expect(interp.getVariable('pump_active')).toBe(false);
    });
  });

  describe('Multi-cycle execution', () => {
    it('accumulates state across cycles', () => {
      const code = `
PROGRAM Counter
VAR
  count : INT := 0;
END_VAR
  count := count + 1;
END_PROGRAM`;
      const { ast } = parseST(code);
      const interp = new StInterpreter(ast[0]);
      interp.runCycle();
      expect(interp.getVariable('count')).toBe(1);
      interp.runCycle();
      expect(interp.getVariable('count')).toBe(2);
      interp.runCycle();
      expect(interp.getVariable('count')).toBe(3);
    });
  });

  describe('getVariableInfo - all variables with metadata', () => {
    it('returns scope and type info', () => {
      const code = `
PROGRAM Test
VAR_INPUT
  cmd : BOOL;
END_VAR
VAR_OUTPUT
  result : REAL;
END_VAR
VAR
  temp : INT := 5;
END_VAR
  result := 1.0;
END_PROGRAM`;
      const { ast } = parseST(code);
      const interp = new StInterpreter(ast[0]);
      const info = interp.getVariableInfo();
      expect(info).toHaveLength(3);

      const cmdInfo = info.find(v => v.name === 'cmd');
      expect(cmdInfo?.scope).toBe('VAR_INPUT');
      expect(cmdInfo?.dataType).toBe('BOOL');

      const resultInfo = info.find(v => v.name === 'result');
      expect(resultInfo?.scope).toBe('VAR_OUTPUT');

      const tempInfo = info.find(v => v.name === 'temp');
      expect(tempInfo?.scope).toBe('VAR');
    });
  });

  describe('Infinite loop protection', () => {
    it('breaks out of infinite loops', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : INT := 0;
END_VAR
  WHILE TRUE DO
    x := x + 1;
  END_WHILE;
END_PROGRAM`);
      // Should not hang — interpreter has max iteration guard
      expect(interp.getVariable('x')).toBeGreaterThan(0);
    });
  });
});
```

**Step 2: Test'i çalıştır, FAIL olduğunu doğrula**

```bash
npx vitest run src/simulation/__tests__/st-interpreter.test.ts
```

**Step 3: Interpreter implementasyonunu yaz**

`st-interpreter.ts` — Core interpreter class:

```typescript
export type SimValue = boolean | number | string;

export interface VariableInfo {
  name: string;
  scope: VarBlockKind;
  dataType: string;
  value: SimValue;
}

export class StInterpreter {
  private variables: Map<string, SimValue>;
  private varMeta: Map<string, { scope: VarBlockKind; dataType: string }>;
  private body: Statement[];
  private readonly MAX_ITERATIONS = 100_000;

  constructor(node: ASTNode);
  setVariable(name: string, value: SimValue): void;
  getVariable(name: string): SimValue | undefined;
  getVariableInfo(): VariableInfo[];
  getAllVariables(): Map<string, SimValue>;
  runCycle(): void;
  reset(): void;

  // Private
  private initVariables(varBlocks: VarBlockNode[]): void;
  private executeStatements(stmts: Statement[]): 'normal' | 'return' | 'exit';
  private executeStatement(stmt: Statement): 'normal' | 'return' | 'exit';
  private evaluateExpression(expr: Expression): SimValue;
  private assignToTarget(target: Expression, value: SimValue): void;
  private isTruthy(value: SimValue): boolean;
  private getDefaultValue(type: TypeNode): SimValue;
  private callBuiltinFunction(name: string, args: SimValue[]): SimValue;
}
```

Key design decisions:
- `SimValue = boolean | number | string` — JS primitives, BOOL→boolean, INT/REAL→number, STRING→string
- `runCycle()` = execute all body statements once (one PLC scan)
- Variables persist between cycles (stateful)
- `reset()` re-initializes to declared defaults
- `MAX_ITERATIONS = 100_000` for loop guard (WHILE/FOR/REPEAT)
- Built-in functions: ABS, SQRT, MIN, MAX, LIMIT, SIN, COS, LN, LOG, EXP, TRUNC, SEL

**Step 4: Test'leri çalıştır, PASS olduğunu doğrula**

**Step 5: Commit**

```bash
git add web/modules/sensor-module/src/simulation/st-interpreter.ts
git add web/modules/sensor-module/src/simulation/__tests__/st-interpreter.test.ts
git commit -m "feat(simulation): add ST interpreter engine with scan cycle execution"
```

---

### Task 4: useSimulation React Hook

**Files:**
- Create: `web/modules/sensor-module/src/simulation/useSimulation.ts`
- Create: `web/modules/sensor-module/src/simulation/index.ts` (barrel export)

Hook, StInterpreter'ı React state'e bağlar. Editördeki ST kodunu alır, parse eder, interpreter oluşturur ve UI'a variable state sunar.

**Step 1: Hook'u oluştur**

```typescript
import { useState, useCallback, useRef, useEffect } from 'react';
import { parseST } from './st-parser-lite';
import { StInterpreter, SimValue, VariableInfo } from './st-interpreter';

export type SimulationState = 'idle' | 'ready' | 'running' | 'paused' | 'error';

export interface UseSimulationReturn {
  // State
  state: SimulationState;
  error: string | null;
  variables: VariableInfo[];
  cycleCount: number;
  scanCycleMs: number;

  // Actions
  load: (code: string) => void;           // Parse + init
  runOneCycle: () => void;                 // Single step
  startContinuous: (intervalMs?: number) => void; // Auto-run
  pause: () => void;                      // Pause continuous
  stop: () => void;                       // Reset to initial
  setInput: (name: string, value: SimValue) => void; // Set VAR_INPUT
  setScanCycleMs: (ms: number) => void;
}

export function useSimulation(): UseSimulationReturn;
```

**Step 2: Barrel export dosyası oluştur**

```typescript
// web/modules/sensor-module/src/simulation/index.ts
export { parseST } from './st-parser-lite';
export { StInterpreter } from './st-interpreter';
export type { SimValue, VariableInfo } from './st-interpreter';
export { useSimulation } from './useSimulation';
export type { SimulationState, UseSimulationReturn } from './useSimulation';
```

**Step 3: Commit**

```bash
git add web/modules/sensor-module/src/simulation/useSimulation.ts
git add web/modules/sensor-module/src/simulation/index.ts
git commit -m "feat(simulation): add useSimulation React hook"
```

---

### Task 5: Simulation Panel UI Component

**Files:**
- Create: `web/modules/sensor-module/src/simulation/SimulationPanel.tsx`

Simülasyon paneli — Automation Editor'ın "ST Kodu" tab'ının yanına "Simülasyon" tab'ı olarak eklenir. İçeriği:

1. **Toolbar:** [▶ Başlat] [⏸ Duraklat] [⏹ Durdur] [⏭ 1 Cycle] | Cycle: 42 | Scan: 100ms
2. **Variable Watch Table:** Tüm değişkenler, scope'a göre gruplandırılmış
   - VAR_INPUT → editable (checkbox for BOOL, number input for INT/REAL)
   - VAR_OUTPUT → read-only, value highlighted on change
   - VAR → read-only
3. **Parse error banner** — kod parse edilemezse kırmızı banner

**Step 1: Component'i oluştur**

```tsx
interface SimulationPanelProps {
  code: string; // Current ST code from editor
}
```

Layout:
```
┌──────────────────────────────────────────────────────┐
│ ▶ Başlat  ⏸ Duraklat  ⏹ Durdur  ⏭ 1 Cycle          │
│ Cycle: 0     Scan: [100]ms                           │
├──────────────────────────────────────────────────────┤
│ ┌─ GİRİŞLER (VAR_INPUT) ──────────────────────────┐ │
│ │ start_command  BOOL   [✓]                        │ │
│ │ ph_value       REAL   [6.2    ]                  │ │
│ │ ph_setpoint    REAL   [7.0    ]                  │ │
│ └──────────────────────────────────────────────────┘ │
│ ┌─ ÇIKIŞLAR (VAR_OUTPUT) ─────────────────────────┐ │
│ │ pump_active    BOOL   ● TRUE   ← changed        │ │
│ │ valve_open     BOOL   ○ FALSE                    │ │
│ │ alarm          BOOL   ○ FALSE                    │ │
│ └──────────────────────────────────────────────────┘ │
│ ┌─ DAHİLİ (VAR) ─────────────────────────────────┐ │
│ │ error          REAL   0.800                      │ │
│ │ dose_timer     INT    1                          │ │
│ │ max_dose_time  INT    300                        │ │
│ └──────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

Design decisions:
- Tailwind CSS, dark mode uyumlu (dark:bg-gray-800 vb.)
- VAR_INPUT BOOL → checkbox toggle
- VAR_INPUT INT/REAL → number input, step=1 for INT, step=0.1 for REAL
- VAR_INPUT STRING → text input
- Değişen değerler sarı highlight (500ms fade)
- Parse hatası varsa → kırmızı banner, tablo gösterilmez

**Step 2: Commit**

```bash
git add web/modules/sensor-module/src/simulation/SimulationPanel.tsx
git commit -m "feat(simulation): add SimulationPanel UI component"
```

---

### Task 6: Automation Editor'a Simülasyon Tab'ı Ekle

**Files:**
- Modify: `web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx`

**Step 1: Import ekle ve tab state'ini güncelle**

```typescript
// Mevcut import'lara ekle:
import SimulationPanel from '../../simulation/SimulationPanel';

// activeTab union type'ına 'simulation' ekle:
const [activeTab, setActiveTab] = useState<
  'info' | 'variables' | 'code' | 'simulation' | 'deploy'
>('info');
```

**Step 2: Tab butonunu ekle (ST Kodu tab'ından sonra)**

```tsx
<TabButton
  active={activeTab === 'simulation'}
  onClick={() => setActiveTab('simulation')}
  icon={<Play className="h-4 w-4" />}
  label="Simülasyon"
/>
```

`Play` icon'unu lucide-react import'una ekle.

**Step 3: Tab panel'ini ekle (Code tab panel'inden sonra)**

```tsx
{activeTab === 'simulation' && (
  <div className="flex flex-col" style={{ height: 'calc(100vh - 320px)', minHeight: 400 }}>
    <SimulationPanel code={stCode} />
  </div>
)}
```

**Step 4: Commit**

```bash
git add web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx
git commit -m "feat(simulation): add Simulation tab to automation editor"
```

---

### Task 7: Integration Test — End-to-End Dosing Pump Scenario

**Files:**
- Create: `web/modules/sensor-module/src/simulation/__tests__/dosing-pump-e2e.test.ts`

**Step 1: Test dosyasını oluştur**

Bu test, kullanıcının tam senaryosunu doğrular: dozaj pompası programı yaz → parse et → farklı input'larla çalıştır → output'ları kontrol et.

```typescript
import { parseST } from '../st-parser-lite';
import { StInterpreter } from '../st-interpreter';

const DOSING_PUMP_CODE = `
PROGRAM DosingPump
VAR_INPUT
  start_command : BOOL;
  ph_value : REAL;
  ph_setpoint : REAL := 7.0;
END_VAR
VAR_OUTPUT
  pump_active : BOOL;
  valve_open : BOOL;
  alarm : BOOL;
END_VAR
VAR
  error : REAL;
  dose_timer : INT := 0;
  max_dose_time : INT := 300;
END_VAR
  error := ph_setpoint - ph_value;

  IF NOT start_command THEN
    pump_active := FALSE;
    valve_open := FALSE;
    dose_timer := 0;
  ELSIF error > 0.5 THEN
    pump_active := TRUE;
    valve_open := TRUE;
    dose_timer := dose_timer + 1;
  ELSIF error > 0.1 THEN
    pump_active := TRUE;
    valve_open := FALSE;
    dose_timer := dose_timer + 1;
  ELSE
    pump_active := FALSE;
    valve_open := FALSE;
    dose_timer := 0;
  END_IF;

  IF dose_timer > max_dose_time THEN
    alarm := TRUE;
    pump_active := FALSE;
    valve_open := FALSE;
  END_IF;
END_PROGRAM`;

describe('Dosing Pump E2E Simulation', () => {
  let interp: StInterpreter;

  beforeEach(() => {
    const { ast, errors } = parseST(DOSING_PUMP_CODE);
    expect(errors).toHaveLength(0);
    interp = new StInterpreter(ast[0]);
  });

  it('scenario 1: system idle — pump off', () => {
    interp.setVariable('start_command', false);
    interp.setVariable('ph_value', 6.0);
    interp.runCycle();

    expect(interp.getVariable('pump_active')).toBe(false);
    expect(interp.getVariable('valve_open')).toBe(false);
    expect(interp.getVariable('alarm')).toBe(false);
  });

  it('scenario 2: start + low pH → pump + valve ON', () => {
    interp.setVariable('start_command', true);
    interp.setVariable('ph_value', 6.0); // error = 1.0 > 0.5
    interp.runCycle();

    expect(interp.getVariable('pump_active')).toBe(true);
    expect(interp.getVariable('valve_open')).toBe(true);
    expect(interp.getVariable('error')).toBeCloseTo(1.0);
  });

  it('scenario 3: start + slightly low pH → pump ON, valve OFF', () => {
    interp.setVariable('start_command', true);
    interp.setVariable('ph_value', 6.7); // error = 0.3, between 0.1 and 0.5
    interp.runCycle();

    expect(interp.getVariable('pump_active')).toBe(true);
    expect(interp.getVariable('valve_open')).toBe(false);
  });

  it('scenario 4: pH at setpoint → pump OFF', () => {
    interp.setVariable('start_command', true);
    interp.setVariable('ph_value', 7.0); // error = 0.0 < 0.1
    interp.runCycle();

    expect(interp.getVariable('pump_active')).toBe(false);
    expect(interp.getVariable('valve_open')).toBe(false);
  });

  it('scenario 5: overdose alarm after max_dose_time cycles', () => {
    interp.setVariable('start_command', true);
    interp.setVariable('ph_value', 6.0);

    // Run 301 cycles (dose_timer reaches 301 > 300)
    for (let i = 0; i < 301; i++) {
      interp.runCycle();
    }

    expect(interp.getVariable('alarm')).toBe(true);
    expect(interp.getVariable('pump_active')).toBe(false);
    expect(interp.getVariable('valve_open')).toBe(false);
    expect(interp.getVariable('dose_timer')).toBe(301);
  });

  it('scenario 6: stop command resets timer', () => {
    interp.setVariable('start_command', true);
    interp.setVariable('ph_value', 6.0);

    // Run 50 cycles
    for (let i = 0; i < 50; i++) {
      interp.runCycle();
    }
    expect(interp.getVariable('dose_timer')).toBe(50);

    // Stop command
    interp.setVariable('start_command', false);
    interp.runCycle();
    expect(interp.getVariable('dose_timer')).toBe(0);
    expect(interp.getVariable('pump_active')).toBe(false);
  });

  it('scenario 7: variable info returns correct metadata', () => {
    const info = interp.getVariableInfo();

    const inputs = info.filter(v => v.scope === 'VAR_INPUT');
    const outputs = info.filter(v => v.scope === 'VAR_OUTPUT');
    const locals = info.filter(v => v.scope === 'VAR');

    expect(inputs.map(v => v.name)).toEqual(
      expect.arrayContaining(['start_command', 'ph_value', 'ph_setpoint'])
    );
    expect(outputs.map(v => v.name)).toEqual(
      expect.arrayContaining(['pump_active', 'valve_open', 'alarm'])
    );
    expect(locals.map(v => v.name)).toEqual(
      expect.arrayContaining(['error', 'dose_timer', 'max_dose_time'])
    );
  });
});
```

**Step 2: Test'leri çalıştır, hepsinin PASS olduğunu doğrula**

```bash
npx vitest run src/simulation/__tests__/dosing-pump-e2e.test.ts
```

**Step 3: Commit**

```bash
git add web/modules/sensor-module/src/simulation/__tests__/dosing-pump-e2e.test.ts
git commit -m "test(simulation): add dosing pump end-to-end simulation test"
```

---

## Faz 2: Auto-Generated Simulation View (Gelecek)

> Bu faz, Faz 1 tamamlanıp test edildikten sonra ayrı bir plan olarak yazılacak.

Kısa özet:
- Program değişkenlerinden otomatik SCADA-benzeri view üretilir
- `BOOL` → StatusIndicator widget, `REAL` → Gauge widget, `INT` → NumericDisplay
- VAR_INPUT → interaktif kontroller (slider, toggle)
- VAR_OUTPUT → read-only göstergeler, animasyonlu
- Mevcut SCADA widget renderer bileşenleri import edilip reuse edilir (lazy load)
- ReactFlow/canvas KULLANILMAZ — basit CSS grid layout yeterli

---

## Dosya Özeti

```
web/modules/sensor-module/src/simulation/
├── st-ast-types.ts                    # Task 1: AST type definitions
├── st-parser-lite.ts                  # Task 2: Lightweight ST parser
├── st-interpreter.ts                  # Task 3: AST tree-walker interpreter
├── useSimulation.ts                   # Task 4: React hook
├── SimulationPanel.tsx                # Task 5: Watch table UI
├── index.ts                           # Task 4: Barrel exports
└── __tests__/
    ├── st-parser-lite.test.ts         # Task 2: Parser tests
    ├── st-interpreter.test.ts         # Task 3: Interpreter tests
    └── dosing-pump-e2e.test.ts        # Task 7: E2E scenario test
```

Değiştirilecek mevcut dosya:
- `AutomationProgramEditorPage.tsx`    # Task 6: Simülasyon tab'ı ekleme
