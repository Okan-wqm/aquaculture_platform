import { parseST } from '../st-parser-lite';
import type {
  ProgramNode,
  FunctionBlockNode,
  FunctionNode,
  IfStatement,
  ForStatement,
  WhileStatement,
  RepeatStatement,
  CaseStatement,
  AssignmentStatement,
  BinaryExpression,
  UnaryExpression,
  FunctionCallExpression,
  MemberAccessExpression,
  ArrayAccessExpression,
  IntegerLiteral,
  RealLiteral,
  BooleanLiteral,
  TimeLiteral,
  IdentifierExpression,
  ExpressionStatement,
} from '../st-ast-types';

// ════════════════════════════════════════════════════════════════════════════
// Plan tests
// ════════════════════════════════════════════════════════════════════════════

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

  // ════════════════════════════════════════════════════════════════════════
  // Extended tests — full construct coverage
  // ════════════════════════════════════════════════════════════════════════

  describe('POU types', () => {
    it('parses FUNCTION_BLOCK', () => {
      const code = `
FUNCTION_BLOCK PIDController
VAR_INPUT
  setpoint : REAL;
  measured : REAL;
END_VAR
VAR_OUTPUT
  output : REAL;
END_VAR
VAR
  kp : REAL := 1.0;
END_VAR
  output := kp * (setpoint - measured);
END_FUNCTION_BLOCK`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      expect(result.ast[0].kind).toBe('functionBlock');
      const fb = result.ast[0] as FunctionBlockNode;
      expect(fb.name).toBe('PIDController');
      expect(fb.varBlocks).toHaveLength(3);
      expect(fb.body).toHaveLength(1);
    });

    it('parses FUNCTION with return type', () => {
      const code = `
FUNCTION Clamp : REAL
VAR_INPUT
  value : REAL;
  minVal : REAL;
  maxVal : REAL;
END_VAR
  IF value < minVal THEN
    Clamp := minVal;
  ELSIF value > maxVal THEN
    Clamp := maxVal;
  ELSE
    Clamp := value;
  END_IF;
END_FUNCTION`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      expect(result.ast[0].kind).toBe('function');
      const fn = result.ast[0] as FunctionNode;
      expect(fn.name).toBe('Clamp');
      expect(fn.returnType.kind).toBe('elementaryType');
    });
  });

  describe('All elementary types', () => {
    it('parses all supported elementary types', () => {
      const types = [
        'BOOL', 'BYTE', 'WORD', 'DWORD',
        'SINT', 'INT', 'DINT', 'LINT',
        'USINT', 'UINT', 'UDINT', 'ULINT',
        'REAL', 'LREAL', 'STRING', 'WSTRING',
        'TIME', 'DATE',
      ];
      for (const typeName of types) {
        const code = `
PROGRAM T
VAR
  x : ${typeName};
END_VAR
END_PROGRAM`;
        const result = parseST(code);
        expect(result.errors).toHaveLength(0);
        if (result.ast[0].kind !== 'program') continue;
        const decl = result.ast[0].varBlocks[0].declarations[0];
        if (typeName === 'STRING' || typeName === 'WSTRING') {
          expect(decl.type.kind).toBe('stringType');
        } else {
          expect(decl.type.kind).toBe('elementaryType');
        }
      }
    });
  });

  describe('ARRAY type', () => {
    it('parses ARRAY[n..m] OF type', () => {
      const code = `
PROGRAM Main
VAR
  data : ARRAY[0..9] OF REAL;
END_VAR
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const decl = result.ast[0].varBlocks[0].declarations[0];
      expect(decl.type.kind).toBe('arrayType');
    });

    it('parses multi-dimensional array', () => {
      const code = `
PROGRAM Main
VAR
  matrix : ARRAY[0..2, 0..4] OF INT;
END_VAR
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const arrType = result.ast[0].varBlocks[0].declarations[0].type;
      expect(arrType.kind).toBe('arrayType');
      if (arrType.kind === 'arrayType') {
        expect(arrType.dimensions).toHaveLength(2);
      }
    });
  });

  describe('VAR block qualifiers', () => {
    it('parses VAR CONSTANT', () => {
      const code = `
PROGRAM Main
VAR CONSTANT
  PI : REAL := 3.14159;
END_VAR
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      expect(result.ast[0].varBlocks[0].constant).toBe(true);
    });

    it('parses VAR RETAIN', () => {
      const code = `
PROGRAM Main
VAR RETAIN
  counter : INT := 0;
END_VAR
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      expect(result.ast[0].varBlocks[0].retain).toBe(true);
    });

    it('parses VAR_IN_OUT and VAR_GLOBAL', () => {
      const code = `
PROGRAM Main
VAR_IN_OUT
  shared_val : INT;
END_VAR
VAR_GLOBAL
  g_flag : BOOL;
END_VAR
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      expect(result.ast[0].varBlocks[0].blockType).toBe('VAR_IN_OUT');
      expect(result.ast[0].varBlocks[1].blockType).toBe('VAR_GLOBAL');
    });
  });

  describe('Operator precedence (Pratt)', () => {
    it('multiplication binds tighter than addition', () => {
      const code = `
PROGRAM Main
VAR
  x : INT := 0;
END_VAR
  x := 2 + 3 * 4;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const assign = result.ast[0].body[0] as AssignmentStatement;
      const binExpr = assign.value as BinaryExpression;
      // Should be (2 + (3 * 4)) — top level is +
      expect(binExpr.operator).toBe('+');
      expect((binExpr.right as BinaryExpression).operator).toBe('*');
    });

    it('** is right-associative and highest', () => {
      const code = `
PROGRAM Main
VAR
  x : INT := 0;
END_VAR
  x := 2 ** 3 ** 2;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const assign = result.ast[0].body[0] as AssignmentStatement;
      const binExpr = assign.value as BinaryExpression;
      // Should be (2 ** (3 ** 2)) — right associative
      expect(binExpr.operator).toBe('**');
      expect((binExpr.right as BinaryExpression).operator).toBe('**');
    });

    it('boolean precedence: OR < XOR < AND', () => {
      const code = `
PROGRAM Main
VAR
  x : BOOL;
END_VAR
  x := TRUE OR FALSE XOR TRUE AND FALSE;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const assign = result.ast[0].body[0] as AssignmentStatement;
      const binExpr = assign.value as BinaryExpression;
      // OR is lowest → top level
      expect(binExpr.operator).toBe('OR');
    });

    it('comparison precedence between boolean and arithmetic', () => {
      const code = `
PROGRAM Main
VAR
  x : BOOL;
END_VAR
  x := 1 + 2 > 3 AND 4 < 5;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const assign = result.ast[0].body[0] as AssignmentStatement;
      const binExpr = assign.value as BinaryExpression;
      // AND is lower than comparison → top level
      expect(binExpr.operator).toBe('AND');
    });

    it('MOD has same precedence as multiplication', () => {
      const code = `
PROGRAM Main
VAR
  x : INT := 0;
END_VAR
  x := 10 + 17 MOD 5;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const assign = result.ast[0].body[0] as AssignmentStatement;
      const binExpr = assign.value as BinaryExpression;
      // + is lower → top level is +
      expect(binExpr.operator).toBe('+');
      expect((binExpr.right as BinaryExpression).operator).toBe('MOD');
    });
  });

  describe('Unary operators', () => {
    it('parses NOT', () => {
      const code = `
PROGRAM Main
VAR
  x : BOOL;
END_VAR
  x := NOT TRUE;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const assign = result.ast[0].body[0] as AssignmentStatement;
      const unary = assign.value as UnaryExpression;
      expect(unary.kind).toBe('unaryExpression');
      expect(unary.operator).toBe('NOT');
    });

    it('parses unary minus', () => {
      const code = `
PROGRAM Main
VAR
  x : INT := 0;
END_VAR
  x := -5;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const assign = result.ast[0].body[0] as AssignmentStatement;
      const unary = assign.value as UnaryExpression;
      expect(unary.kind).toBe('unaryExpression');
      expect(unary.operator).toBe('-');
    });
  });

  describe('Bitwise operators', () => {
    it('parses SHL, SHR, ROL, ROR', () => {
      const ops = ['SHL', 'SHR', 'ROL', 'ROR'];
      for (const op of ops) {
        const code = `
PROGRAM Main
VAR
  x : INT := 0;
END_VAR
  x := 8 ${op} 2;
END_PROGRAM`;
        const result = parseST(code);
        expect(result.errors).toHaveLength(0);
        if (result.ast[0].kind !== 'program') continue;
        const assign = result.ast[0].body[0] as AssignmentStatement;
        const bin = assign.value as BinaryExpression;
        expect(bin.operator).toBe(op);
      }
    });
  });

  describe('Literals', () => {
    it('parses hex literal (16#FF)', () => {
      const code = `
PROGRAM Main
VAR
  x : INT := 0;
END_VAR
  x := 16#FF;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const assign = result.ast[0].body[0] as AssignmentStatement;
      const lit = assign.value as IntegerLiteral;
      expect(lit.kind).toBe('integerLiteral');
      expect(lit.value).toBe(255);
    });

    it('parses time literal T#5s', () => {
      const code = `
PROGRAM Main
VAR
  t : TIME;
END_VAR
  t := T#5s;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const assign = result.ast[0].body[0] as AssignmentStatement;
      const lit = assign.value as TimeLiteral;
      expect(lit.kind).toBe('timeLiteral');
      expect(lit.raw).toContain('5s');
    });

    it('parses boolean literals TRUE and FALSE', () => {
      const code = `
PROGRAM Main
VAR
  a : BOOL;
  b : BOOL;
END_VAR
  a := TRUE;
  b := FALSE;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const a1 = result.ast[0].body[0] as AssignmentStatement;
      const a2 = result.ast[0].body[1] as AssignmentStatement;
      expect((a1.value as BooleanLiteral).value).toBe(true);
      expect((a2.value as BooleanLiteral).value).toBe(false);
    });

    it('parses string literal', () => {
      const code = `
PROGRAM Main
VAR
  s : STRING;
END_VAR
  s := 'hello world';
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const assign = result.ast[0].body[0] as AssignmentStatement;
      expect(assign.value.kind).toBe('stringLiteral');
    });
  });

  describe('Function calls', () => {
    it('parses positional args', () => {
      const code = `
PROGRAM Main
VAR
  x : REAL;
END_VAR
  x := MIN(3.0, 7.0);
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const assign = result.ast[0].body[0] as AssignmentStatement;
      const call = assign.value as FunctionCallExpression;
      expect(call.kind).toBe('functionCall');
      expect(call.name).toBe('MIN');
      expect(call.args).toHaveLength(2);
    });

    it('parses named args (input := val)', () => {
      const code = `
PROGRAM Main
VAR
  x : REAL;
END_VAR
  x := LIMIT(MN := 0.0, IN := 5.0, MX := 10.0);
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const assign = result.ast[0].body[0] as AssignmentStatement;
      const call = assign.value as FunctionCallExpression;
      expect(call.kind).toBe('functionCall');
      expect(call.namedArgs).toHaveLength(3);
      expect(call.namedArgs![0].name).toBe('MN');
      expect(call.namedArgs![0].assignType).toBe('input');
    });
  });

  describe('Member access and array access', () => {
    it('parses obj.field', () => {
      const code = `
PROGRAM Main
VAR
  x : REAL;
END_VAR
  x := sensor.temperature;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const assign = result.ast[0].body[0] as AssignmentStatement;
      const member = assign.value as MemberAccessExpression;
      expect(member.kind).toBe('memberAccess');
      expect(member.member).toBe('temperature');
    });

    it('parses arr[i]', () => {
      const code = `
PROGRAM Main
VAR
  data : ARRAY[0..9] OF INT;
  x : INT;
  i : INT := 3;
END_VAR
  x := data[i];
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const assign = result.ast[0].body[0] as AssignmentStatement;
      const arrAccess = assign.value as ArrayAccessExpression;
      expect(arrAccess.kind).toBe('arrayAccess');
      expect(arrAccess.indices).toHaveLength(1);
    });
  });

  describe('Comments', () => {
    it('ignores single-line comments', () => {
      const code = `
PROGRAM Main
// This is a comment
VAR
  x : INT := 0; // inline comment
END_VAR
  x := 1; // another comment
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
    });

    it('ignores block comments', () => {
      const code = `
PROGRAM Main
(* This is a
   multi-line comment *)
VAR
  x : INT := 0;
END_VAR
  (* nested (* comment *) *)
  x := 1;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('Case-insensitive keywords', () => {
    it('treats PROGRAM, program, Program equally', () => {
      const code = `
program Main
var
  x : int := 0;
end_var
  x := 1;
end_program`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      expect(result.ast[0].kind).toBe('program');
    });

    it('handles mixed case keywords', () => {
      const code = `
Program Main
Var
  x : Bool := True;
End_Var
  If x Then
    x := False;
  End_If;
End_Program`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('REPEAT/UNTIL', () => {
    it('parses REPEAT..UNTIL..END_REPEAT', () => {
      const code = `
PROGRAM Main
VAR
  n : INT := 0;
END_VAR
  REPEAT
    n := n + 1;
  UNTIL n >= 10;
  END_REPEAT;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const repeat = result.ast[0].body[0] as RepeatStatement;
      expect(repeat.kind).toBe('repeatStatement');
      expect(repeat.body).toHaveLength(1);
    });
  });

  describe('CASE with range and multi-labels', () => {
    it('parses range labels 1..5', () => {
      const code = `
PROGRAM Main
VAR
  x : INT := 3;
  y : INT := 0;
END_VAR
  CASE x OF
    1..5: y := 1;
    6..10: y := 2;
  END_CASE;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const caseStmt = result.ast[0].body[0] as CaseStatement;
      expect(caseStmt.cases).toHaveLength(2);
      expect(caseStmt.cases[0].labels[0].kind).toBe('range');
    });

    it('parses comma-separated labels', () => {
      const code = `
PROGRAM Main
VAR
  x : INT := 0;
  y : INT := 0;
END_VAR
  CASE x OF
    1, 2, 3: y := 10;
    4, 5: y := 20;
  ELSE
    y := 0;
  END_CASE;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const caseStmt = result.ast[0].body[0] as CaseStatement;
      expect(caseStmt.cases[0].labels).toHaveLength(3);
      expect(caseStmt.cases[1].labels).toHaveLength(2);
      expect(caseStmt.elseBody).toBeDefined();
    });
  });

  describe('Multi-variable declarations', () => {
    it('parses multiple names in one declaration', () => {
      const code = `
PROGRAM Main
VAR
  a, b, c : INT := 0;
END_VAR
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const decl = result.ast[0].varBlocks[0].declarations[0];
      expect(decl.names).toEqual(['a', 'b', 'c']);
    });
  });

  describe('RETURN and EXIT statements', () => {
    it('parses RETURN', () => {
      const code = `
FUNCTION Foo : INT
VAR_INPUT
  x : INT;
END_VAR
  IF x < 0 THEN
    Foo := 0;
    RETURN;
  END_IF;
  Foo := x;
END_FUNCTION`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
    });

    it('parses EXIT in a loop', () => {
      const code = `
PROGRAM Main
VAR
  i : INT;
END_VAR
  FOR i := 0 TO 100 DO
    IF i > 50 THEN
      EXIT;
    END_IF;
  END_FOR;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Additional edge case tests (beyond plan requirements)
  // ════════════════════════════════════════════════════════════════════════

  describe('Edge case: empty program', () => {
    it('parses a program with no body and no VAR blocks', () => {
      const code = `
PROGRAM Empty
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      expect(result.ast).toHaveLength(1);
      if (result.ast[0].kind !== 'program') return;
      expect(result.ast[0].name).toBe('Empty');
      expect(result.ast[0].varBlocks).toHaveLength(0);
      expect(result.ast[0].body).toHaveLength(0);
    });
  });

  describe('Edge case: only VAR block, no body', () => {
    it('parses a program with variables but no statements', () => {
      const code = `
PROGRAM VarsOnly
VAR
  x : INT := 42;
  y : REAL := 3.14;
  z : BOOL := TRUE;
END_VAR
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      expect(result.ast).toHaveLength(1);
      if (result.ast[0].kind !== 'program') return;
      expect(result.ast[0].varBlocks).toHaveLength(1);
      expect(result.ast[0].varBlocks[0].declarations).toHaveLength(3);
      expect(result.ast[0].body).toHaveLength(0);
    });
  });

  describe('Edge case: nested IFs', () => {
    it('parses deeply nested IF statements', () => {
      const code = `
PROGRAM Nested
VAR
  a : INT := 1;
  b : INT := 2;
  c : INT := 3;
  result : INT := 0;
END_VAR
  IF a > 0 THEN
    IF b > 0 THEN
      IF c > 0 THEN
        result := 1;
      ELSE
        result := 2;
      END_IF;
    ELSE
      result := 3;
    END_IF;
  ELSE
    result := 4;
  END_IF;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const outerIf = result.ast[0].body[0] as IfStatement;
      expect(outerIf.kind).toBe('ifStatement');
      // then body's first statement is another IF
      const middleIf = outerIf.thenBody[0] as IfStatement;
      expect(middleIf.kind).toBe('ifStatement');
      // and that one also has an IF in its then body
      const innerIf = middleIf.thenBody[0] as IfStatement;
      expect(innerIf.kind).toBe('ifStatement');
      expect(innerIf.elseBody).toBeDefined();
    });
  });

  describe('Edge case: complex expression in initializer', () => {
    it('parses arithmetic expression as initial value', () => {
      const code = `
PROGRAM Main
VAR
  x : REAL := 2.0 * 3.14159 / 180.0;
END_VAR
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const decl = result.ast[0].varBlocks[0].declarations[0];
      expect(decl.initialValue).toBeDefined();
      expect(decl.initialValue!.kind).toBe('binaryExpression');
    });
  });

  describe('Edge case: parenthesized expression overriding precedence', () => {
    it('parses (a + b) * c correctly', () => {
      const code = `
PROGRAM Main
VAR
  x : INT := 0;
END_VAR
  x := (2 + 3) * 4;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const assign = result.ast[0].body[0] as AssignmentStatement;
      const bin = assign.value as BinaryExpression;
      // Top level should be *, not +
      expect(bin.operator).toBe('*');
      expect(bin.left.kind).toBe('parenthesized');
    });
  });

  describe('Edge case: multiple POUs in one source', () => {
    it('parses multiple programs', () => {
      const code = `
PROGRAM First
VAR
  x : INT := 0;
END_VAR
END_PROGRAM

FUNCTION_BLOCK Second
VAR
  y : REAL := 1.0;
END_VAR
END_FUNCTION_BLOCK`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      expect(result.ast).toHaveLength(2);
      expect(result.ast[0].kind).toBe('program');
      expect(result.ast[1].kind).toBe('functionBlock');
    });
  });

  describe('Edge case: FOR loop without BY clause', () => {
    it('parses FOR without BY (default step = 1)', () => {
      const code = `
PROGRAM Main
VAR
  i : INT;
  sum : INT := 0;
END_VAR
  FOR i := 1 TO 10 DO
    sum := sum + i;
  END_FOR;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const forStmt = result.ast[0].body[0] as ForStatement;
      expect(forStmt.kind).toBe('forStatement');
      expect(forStmt.by).toBeUndefined();
    });
  });

  describe('Edge case: chained member access', () => {
    it('parses a.b.c as nested MemberAccess', () => {
      const code = `
PROGRAM Main
VAR
  x : REAL;
END_VAR
  x := controller.output.value;
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const assign = result.ast[0].body[0] as AssignmentStatement;
      const outer = assign.value as MemberAccessExpression;
      expect(outer.kind).toBe('memberAccess');
      expect(outer.member).toBe('value');
      const inner = outer.object as MemberAccessExpression;
      expect(inner.kind).toBe('memberAccess');
      expect(inner.member).toBe('output');
    });
  });

  describe('Edge case: expression statement (standalone function call)', () => {
    it('parses standalone function call as expression statement', () => {
      const code = `
PROGRAM Main
VAR
END_VAR
  Reset();
END_PROGRAM`;
      const result = parseST(code);
      expect(result.errors).toHaveLength(0);
      if (result.ast[0].kind !== 'program') return;
      const stmt = result.ast[0].body[0] as ExpressionStatement;
      expect(stmt.kind).toBe('expressionStatement');
      const call = stmt.expression as FunctionCallExpression;
      expect(call.kind).toBe('functionCall');
      expect(call.name).toBe('Reset');
    });
  });
});
