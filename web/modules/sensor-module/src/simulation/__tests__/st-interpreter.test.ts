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

  // ── Variable initialization ──────────────────────────────

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

  // ── Assignment & arithmetic ──────────────────────────────

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

    it('handles power operator (**)', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : REAL := 0.0;
END_VAR
  x := 2.0 ** 10.0;
END_PROGRAM`);
      expect(interp.getVariable('x')).toBeCloseTo(1024.0);
    });
  });

  // ── IF/ELSIF/ELSE ────────────────────────────────────────

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

  // ── Nested IF (3 levels) ─────────────────────────────────

  describe('Nested IF (3 levels)', () => {
    it('evaluates 3-level nested IF correctly', () => {
      const interp = run(`
PROGRAM Main
VAR
  a : INT := 10;
  b : INT := 20;
  c : INT := 30;
  result : INT := 0;
END_VAR
  IF a > 5 THEN
    IF b > 15 THEN
      IF c > 25 THEN
        result := 111;
      ELSE
        result := 110;
      END_IF;
    ELSE
      result := 100;
    END_IF;
  ELSE
    result := 0;
  END_IF;
END_PROGRAM`);
      expect(interp.getVariable('result')).toBe(111);
    });

    it('takes middle branch in nested IF', () => {
      const interp = run(`
PROGRAM Main
VAR
  a : INT := 10;
  b : INT := 20;
  c : INT := 20;
  result : INT := 0;
END_VAR
  IF a > 5 THEN
    IF b > 15 THEN
      IF c > 25 THEN
        result := 111;
      ELSE
        result := 110;
      END_IF;
    ELSE
      result := 100;
    END_IF;
  ELSE
    result := 0;
  END_IF;
END_PROGRAM`);
      expect(interp.getVariable('result')).toBe(110);
    });
  });

  // ── FOR loop ─────────────────────────────────────────────

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

    it('handles negative FOR step (BY -1)', () => {
      const interp = run(`
PROGRAM Main
VAR
  i : INT;
  sum : INT := 0;
END_VAR
  FOR i := 10 TO 1 BY -1 DO
    sum := sum + i;
  END_FOR;
END_PROGRAM`);
      expect(interp.getVariable('sum')).toBe(55); // 10+9+8+...+1 = 55
    });

    it('does not execute body when from > to with positive step', () => {
      const interp = run(`
PROGRAM Main
VAR
  i : INT;
  count : INT := 0;
END_VAR
  FOR i := 10 TO 1 DO
    count := count + 1;
  END_FOR;
END_PROGRAM`);
      expect(interp.getVariable('count')).toBe(0);
    });
  });

  // ── EXIT from FOR loop ───────────────────────────────────

  describe('EXIT from FOR loop', () => {
    it('exits FOR loop early with EXIT', () => {
      const interp = run(`
PROGRAM Main
VAR
  i : INT;
  sum : INT := 0;
END_VAR
  FOR i := 1 TO 100 DO
    IF i > 5 THEN
      EXIT;
    END_IF;
    sum := sum + i;
  END_FOR;
END_PROGRAM`);
      expect(interp.getVariable('sum')).toBe(15); // 1+2+3+4+5
    });
  });

  // ── WHILE loop ───────────────────────────────────────────

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

  // ── REPEAT...UNTIL ───────────────────────────────────────

  describe('REPEAT...UNTIL', () => {
    it('executes body at least once', () => {
      const interp = run(`
PROGRAM Main
VAR
  count : INT := 0;
END_VAR
  REPEAT
    count := count + 1;
  UNTIL TRUE
  END_REPEAT;
END_PROGRAM`);
      expect(interp.getVariable('count')).toBe(1);
    });

    it('repeats until condition becomes true', () => {
      const interp = run(`
PROGRAM Main
VAR
  n : INT := 0;
END_VAR
  REPEAT
    n := n + 1;
  UNTIL n >= 5
  END_REPEAT;
END_PROGRAM`);
      expect(interp.getVariable('n')).toBe(5);
    });

    it('accumulates correctly in REPEAT loop', () => {
      const interp = run(`
PROGRAM Main
VAR
  i : INT := 1;
  product : INT := 1;
END_VAR
  REPEAT
    product := product * i;
    i := i + 1;
  UNTIL i > 5
  END_REPEAT;
END_PROGRAM`);
      // 1*1*2*3*4*5 = 120
      expect(interp.getVariable('product')).toBe(120);
    });
  });

  // ── CASE statement ───────────────────────────────────────

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

    it('handles multi-value case labels (2, 3:)', () => {
      const interp = run(`
PROGRAM Main
VAR
  state : INT := 3;
  output : INT := 0;
END_VAR
  CASE state OF
    0: output := 10;
    1: output := 20;
    2, 3: output := 50;
  ELSE
    output := 99;
  END_CASE;
END_PROGRAM`);
      expect(interp.getVariable('output')).toBe(50);
    });

    it('handles CASE with range labels (1..5:)', () => {
      const interp = run(`
PROGRAM Main
VAR
  val : INT := 3;
  output : INT := 0;
END_VAR
  CASE val OF
    1..5: output := 100;
    6..10: output := 200;
  ELSE
    output := 0;
  END_CASE;
END_PROGRAM`);
      expect(interp.getVariable('output')).toBe(100);
    });

    it('CASE range: value at boundary', () => {
      const interp = run(`
PROGRAM Main
VAR
  val : INT := 5;
  output : INT := 0;
END_VAR
  CASE val OF
    1..5: output := 100;
    6..10: output := 200;
  ELSE
    output := 0;
  END_CASE;
END_PROGRAM`);
      expect(interp.getVariable('output')).toBe(100);
    });

    it('CASE range: value outside range', () => {
      const interp = run(`
PROGRAM Main
VAR
  val : INT := 15;
  output : INT := 0;
END_VAR
  CASE val OF
    1..5: output := 100;
    6..10: output := 200;
  ELSE
    output := 999;
  END_CASE;
END_PROGRAM`);
      expect(interp.getVariable('output')).toBe(999);
    });
  });

  // ── Boolean operations ───────────────────────────────────

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

    it('evaluates XOR', () => {
      const interp = run(`
PROGRAM Main
VAR
  a : BOOL := TRUE;
  b : BOOL := TRUE;
  c : BOOL := FALSE;
  r1 : BOOL;
  r2 : BOOL;
END_VAR
  r1 := a XOR b;
  r2 := a XOR c;
END_PROGRAM`);
      expect(interp.getVariable('r1')).toBe(false);
      expect(interp.getVariable('r2')).toBe(true);
    });
  });

  // ── Built-in functions ───────────────────────────────────

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

    it('SQRT works', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : REAL := 0.0;
END_VAR
  x := SQRT(16.0);
END_PROGRAM`);
      expect(interp.getVariable('x')).toBeCloseTo(4.0);
    });

    it('LIMIT clamps value', () => {
      const interp = run(`
PROGRAM Main
VAR
  a : REAL := 0.0;
  b : REAL := 0.0;
  c : REAL := 0.0;
END_VAR
  a := LIMIT(0.0, 5.0, 10.0);
  b := LIMIT(0.0, -3.0, 10.0);
  c := LIMIT(0.0, 15.0, 10.0);
END_PROGRAM`);
      expect(interp.getVariable('a')).toBeCloseTo(5.0);
      expect(interp.getVariable('b')).toBeCloseTo(0.0);
      expect(interp.getVariable('c')).toBeCloseTo(10.0);
    });

    it('TRUNC truncates real to integer', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : REAL := 0.0;
END_VAR
  x := TRUNC(3.7);
END_PROGRAM`);
      expect(interp.getVariable('x')).toBe(3);
    });

    it('SIN/COS work', () => {
      const interp = run(`
PROGRAM Main
VAR
  s : REAL := 0.0;
  c : REAL := 0.0;
END_VAR
  s := SIN(0.0);
  c := COS(0.0);
END_PROGRAM`);
      expect(interp.getVariable('s')).toBeCloseTo(0.0);
      expect(interp.getVariable('c')).toBeCloseTo(1.0);
    });

    it('EXPT (power) works', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : REAL := 0.0;
END_VAR
  x := EXPT(2.0, 8.0);
END_PROGRAM`);
      expect(interp.getVariable('x')).toBeCloseTo(256.0);
    });

    it('SEL selects based on condition', () => {
      const interp = run(`
PROGRAM Main
VAR
  a : REAL := 0.0;
  b : REAL := 0.0;
END_VAR
  a := SEL(TRUE, 10.0, 20.0);
  b := SEL(FALSE, 10.0, 20.0);
END_PROGRAM`);
      expect(interp.getVariable('a')).toBeCloseTo(20.0); // true → third arg
      expect(interp.getVariable('b')).toBeCloseTo(10.0); // false → second arg
    });

    it('unknown function returns 0 with warning', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const interp = run(`
PROGRAM Main
VAR
  x : REAL := 0.0;
END_VAR
  x := UNKNOWN_FUNC(1.0, 2.0);
END_PROGRAM`);
      expect(interp.getVariable('x')).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unknown function')
      );
      warnSpy.mockRestore();
    });
  });

  // ── External inputs (VAR_INPUT) ──────────────────────────

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

  // ── Multi-cycle execution ────────────────────────────────

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

  // ── getVariableInfo ──────────────────────────────────────

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

  // ── Infinite loop protection ─────────────────────────────

  describe('Infinite loop protection', () => {
    it('breaks out of infinite WHILE loops', () => {
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

    it('breaks out of infinite REPEAT loops', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : INT := 0;
END_VAR
  REPEAT
    x := x + 1;
  UNTIL FALSE
  END_REPEAT;
END_PROGRAM`);
      // Should not hang
      expect(interp.getVariable('x')).toBeGreaterThan(0);
    });
  });

  // ── Division by zero handling ────────────────────────────

  describe('Division by zero handling', () => {
    it('returns Infinity for positive / 0', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : REAL := 0.0;
END_VAR
  x := 10.0 / 0.0;
END_PROGRAM`);
      expect(interp.getVariable('x')).toBe(Infinity);
    });

    it('returns -Infinity for negative / 0', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : REAL := 0.0;
END_VAR
  x := -10.0 / 0.0;
END_PROGRAM`);
      expect(interp.getVariable('x')).toBe(-Infinity);
    });

    it('returns 0 for 0 / 0', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : REAL := 99.0;
END_VAR
  x := 0.0 / 0.0;
END_PROGRAM`);
      expect(interp.getVariable('x')).toBe(0);
    });

    it('MOD by zero returns 0', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : INT := 99;
END_VAR
  x := 10 MOD 0;
END_PROGRAM`);
      expect(interp.getVariable('x')).toBe(0);
    });
  });

  // ── String concatenation ─────────────────────────────────

  describe('String concatenation', () => {
    it('concatenates strings with + operator', () => {
      const interp = run(`
PROGRAM Main
VAR
  a : STRING := 'Hello';
  b : STRING := ' World';
  c : STRING;
END_VAR
  c := a + b;
END_PROGRAM`);
      expect(interp.getVariable('c')).toBe('Hello World');
    });
  });

  // ── Reset ────────────────────────────────────────────────

  describe('reset()', () => {
    it('restores variables to initial values', () => {
      const code = `
PROGRAM Main
VAR
  count : INT := 0;
  flag : BOOL := FALSE;
END_VAR
  count := count + 1;
  flag := TRUE;
END_PROGRAM`;
      const { ast } = parseST(code);
      const interp = new StInterpreter(ast[0]);

      interp.runCycle();
      interp.runCycle();
      interp.runCycle();
      expect(interp.getVariable('count')).toBe(3);
      expect(interp.getVariable('flag')).toBe(true);

      interp.reset();
      expect(interp.getVariable('count')).toBe(0);
      expect(interp.getVariable('flag')).toBe(false);
    });
  });

  // ── getAllVariables ──────────────────────────────────────

  describe('getAllVariables()', () => {
    it('returns a map of all variables', () => {
      const interp = run(`
PROGRAM Main
VAR
  a : INT := 1;
  b : REAL := 2.5;
  c : BOOL := TRUE;
END_VAR
END_PROGRAM`);
      const vars = interp.getAllVariables();
      expect(vars.size).toBe(3);
      expect(vars.get('a')).toBe(1);
      expect(vars.get('b')).toBeCloseTo(2.5);
      expect(vars.get('c')).toBe(true);
    });
  });

  // ── Comparison operators ─────────────────────────────────

  describe('Comparison operators', () => {
    it('evaluates all comparison operators', () => {
      const interp = run(`
PROGRAM Main
VAR
  r1 : BOOL;
  r2 : BOOL;
  r3 : BOOL;
  r4 : BOOL;
  r5 : BOOL;
  r6 : BOOL;
END_VAR
  r1 := 5 = 5;
  r2 := 5 <> 3;
  r3 := 3 < 5;
  r4 := 5 > 3;
  r5 := 5 <= 5;
  r6 := 5 >= 6;
END_PROGRAM`);
      expect(interp.getVariable('r1')).toBe(true);
      expect(interp.getVariable('r2')).toBe(true);
      expect(interp.getVariable('r3')).toBe(true);
      expect(interp.getVariable('r4')).toBe(true);
      expect(interp.getVariable('r5')).toBe(true);
      expect(interp.getVariable('r6')).toBe(false);
    });
  });

  // ── Complex scenarios ────────────────────────────────────

  describe('Complex scenarios', () => {
    it('implements a simple state machine', () => {
      const code = `
PROGRAM StateMachine
VAR
  state : INT := 0;
  counter : INT := 0;
  output : BOOL := FALSE;
END_VAR
  CASE state OF
    0:
      output := FALSE;
      counter := 0;
      state := 1;
    1:
      output := TRUE;
      counter := counter + 1;
      IF counter >= 3 THEN
        state := 2;
      END_IF;
    2:
      output := FALSE;
      state := 0;
  END_CASE;
END_PROGRAM`;
      const { ast } = parseST(code);
      const interp = new StInterpreter(ast[0]);

      // Cycle 1: state 0 → 1
      interp.runCycle();
      expect(interp.getVariable('state')).toBe(1);
      expect(interp.getVariable('output')).toBe(false);

      // Cycle 2: state 1, counter 1
      interp.runCycle();
      expect(interp.getVariable('state')).toBe(1);
      expect(interp.getVariable('output')).toBe(true);
      expect(interp.getVariable('counter')).toBe(1);

      // Cycle 3: state 1, counter 2
      interp.runCycle();
      expect(interp.getVariable('counter')).toBe(2);

      // Cycle 4: state 1, counter 3 → state 2
      interp.runCycle();
      expect(interp.getVariable('counter')).toBe(3);
      expect(interp.getVariable('state')).toBe(2);

      // Cycle 5: state 2 → 0
      interp.runCycle();
      expect(interp.getVariable('state')).toBe(0);
      expect(interp.getVariable('output')).toBe(false);
    });

    it('handles nested loops', () => {
      const interp = run(`
PROGRAM Main
VAR
  i : INT;
  j : INT;
  sum : INT := 0;
END_VAR
  FOR i := 1 TO 3 DO
    FOR j := 1 TO 3 DO
      sum := sum + 1;
    END_FOR;
  END_FOR;
END_PROGRAM`);
      expect(interp.getVariable('sum')).toBe(9);
    });

    it('handles FUNCTION_BLOCK node', () => {
      const interp = run(`
FUNCTION_BLOCK Timer
VAR_INPUT
  enable : BOOL;
END_VAR
VAR_OUTPUT
  done : BOOL;
END_VAR
VAR
  count : INT := 0;
END_VAR
  IF enable THEN
    count := count + 1;
    IF count >= 10 THEN
      done := TRUE;
    END_IF;
  ELSE
    count := 0;
    done := FALSE;
  END_IF;
END_FUNCTION_BLOCK`, { enable: true });
      expect(interp.getVariable('count')).toBe(1);
      expect(interp.getVariable('done')).toBe(false);
    });
  });

  // ── Unary minus on variables ─────────────────────────────

  describe('Unary expressions', () => {
    it('handles unary minus on variable', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : REAL := 5.0;
  y : REAL := 0.0;
END_VAR
  y := -x;
END_PROGRAM`);
      expect(interp.getVariable('y')).toBeCloseTo(-5.0);
    });

    it('handles unary plus', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : REAL := -3.0;
  y : REAL := 0.0;
END_VAR
  y := +x;
END_PROGRAM`);
      expect(interp.getVariable('y')).toBeCloseTo(-3.0);
    });
  });

  // ── Multiple VAR blocks ──────────────────────────────────

  describe('Multiple VAR blocks', () => {
    it('handles VAR_INPUT, VAR_OUTPUT, VAR blocks', () => {
      const code = `
PROGRAM Test
VAR_INPUT
  a : REAL;
  b : REAL;
END_VAR
VAR_OUTPUT
  sum : REAL;
  diff : REAL;
END_VAR
VAR
  temp : REAL;
END_VAR
  temp := a + b;
  sum := temp;
  diff := a - b;
END_PROGRAM`;
      const { ast } = parseST(code);
      const interp = new StInterpreter(ast[0]);
      interp.setVariable('a', 10.0);
      interp.setVariable('b', 3.0);
      interp.runCycle();

      expect(interp.getVariable('sum')).toBeCloseTo(13.0);
      expect(interp.getVariable('diff')).toBeCloseTo(7.0);
      expect(interp.getVariable('temp')).toBeCloseTo(13.0);
    });
  });

  // ── Type conversion built-ins ────────────────────────────

  describe('Type conversion built-ins', () => {
    it('INT_TO_REAL converts', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : REAL := 0.0;
END_VAR
  x := INT_TO_REAL(42);
END_PROGRAM`);
      expect(interp.getVariable('x')).toBe(42);
    });

    it('REAL_TO_INT truncates', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : INT := 0;
END_VAR
  x := REAL_TO_INT(3.9);
END_PROGRAM`);
      expect(interp.getVariable('x')).toBe(3);
    });

    it('BOOL_TO_INT converts', () => {
      const interp = run(`
PROGRAM Main
VAR
  x : INT := 0;
  y : INT := 0;
END_VAR
  x := BOOL_TO_INT(TRUE);
  y := BOOL_TO_INT(FALSE);
END_PROGRAM`);
      expect(interp.getVariable('x')).toBe(1);
      expect(interp.getVariable('y')).toBe(0);
    });

    it('INT_TO_BOOL converts', () => {
      const interp = run(`
PROGRAM Main
VAR
  a : BOOL;
  b : BOOL;
END_VAR
  a := INT_TO_BOOL(1);
  b := INT_TO_BOOL(0);
END_PROGRAM`);
      expect(interp.getVariable('a')).toBe(true);
      expect(interp.getVariable('b')).toBe(false);
    });
  });
});
