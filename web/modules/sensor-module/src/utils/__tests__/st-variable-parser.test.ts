import {
  parseStVariables,
  hasStVariables,
  diffVariables,
  type ParsedVariable,
} from '../st-variable-parser';

// ============================================================================
// parseStVariables
// ============================================================================

describe('parseStVariables', () => {
  it('returns empty for empty or whitespace-only input', () => {
    expect(parseStVariables('').variables).toEqual([]);
    expect(parseStVariables('   \n\n  ').variables).toEqual([]);
  });

  it('extracts VAR block variables (scope = local)', () => {
    const code = `
PROGRAM Main
VAR
  temperature : REAL := 25.0;
  pump_on : BOOL := FALSE;
  counter : INT;
END_VAR
END_PROGRAM`;

    const { variables, errors } = parseStVariables(code);
    expect(errors).toHaveLength(0);
    expect(variables).toHaveLength(3);

    expect(variables[0]).toMatchObject({
      varName: 'temperature',
      dataType: 'REAL',
      scope: 'LOCAL',
      initialValue: '25.0',
    });
    expect(variables[1]).toMatchObject({
      varName: 'pump_on',
      dataType: 'BOOL',
      scope: 'LOCAL',
      initialValue: 'FALSE',
    });
    expect(variables[2]).toMatchObject({
      varName: 'counter',
      dataType: 'INT',
      scope: 'LOCAL',
    });
    // counter has no initial value
    expect(variables[2]!.initialValue).toBeUndefined();
  });

  it('extracts VAR_INPUT variables (scope = input)', () => {
    const code = `
PROGRAM Dosing
VAR_INPUT
  setpoint : REAL;
  enable : BOOL := TRUE;
END_VAR
END_PROGRAM`;

    const { variables } = parseStVariables(code);
    expect(variables).toHaveLength(2);
    expect(variables[0]).toMatchObject({ varName: 'setpoint', scope: 'INPUT', dataType: 'REAL' });
    expect(variables[1]).toMatchObject({ varName: 'enable', scope: 'INPUT', initialValue: 'TRUE' });
  });

  it('extracts VAR_OUTPUT variables (scope = output)', () => {
    const code = `
PROGRAM Ctrl
VAR_OUTPUT
  alarm : BOOL;
  output_value : REAL := 0.0;
END_VAR
END_PROGRAM`;

    const { variables } = parseStVariables(code);
    expect(variables).toHaveLength(2);
    expect(variables[0]).toMatchObject({ varName: 'alarm', scope: 'OUTPUT', dataType: 'BOOL' });
    expect(variables[1]).toMatchObject({ varName: 'output_value', scope: 'OUTPUT', initialValue: '0.0' });
  });

  it('extracts VAR_IN_OUT variables (scope = inout)', () => {
    const code = `
PROGRAM Shared
VAR_IN_OUT
  shared_val : REAL;
END_VAR
END_PROGRAM`;

    const { variables } = parseStVariables(code);
    expect(variables).toHaveLength(1);
    expect(variables[0]).toMatchObject({ varName: 'shared_val', scope: 'INOUT' });
  });

  it('extracts VAR_GLOBAL variables (scope = global)', () => {
    const code = `
PROGRAM Global
VAR_GLOBAL
  global_counter : INT;
END_VAR
END_PROGRAM`;

    const { variables } = parseStVariables(code);
    expect(variables).toHaveLength(1);
    expect(variables[0]).toMatchObject({ varName: 'global_counter', scope: 'global' });
  });

  it('extracts VAR RETAIN variables (scope = retain)', () => {
    const code = `
PROGRAM Persist
VAR RETAIN
  persistent_val : REAL := 1.5;
END_VAR
END_PROGRAM`;

    const { variables } = parseStVariables(code);
    expect(variables).toHaveLength(1);
    expect(variables[0]).toMatchObject({ varName: 'persistent_val', scope: 'RETAIN', initialValue: '1.5' });
  });

  it('extracts VAR CONSTANT variables (scope = constant)', () => {
    const code = `
PROGRAM Constants
VAR CONSTANT
  PI : REAL := 3.14159;
  MAX_TEMP : INT := 100;
END_VAR
END_PROGRAM`;

    const { variables } = parseStVariables(code);
    expect(variables).toHaveLength(2);
    expect(variables[0]).toMatchObject({ varName: 'PI', scope: 'CONSTANT', initialValue: '3.14159' });
    expect(variables[1]).toMatchObject({ varName: 'MAX_TEMP', scope: 'CONSTANT', initialValue: '100' });
  });

  it('handles multiple VAR blocks of different types', () => {
    const code = `
PROGRAM Complex
VAR
  local_var : INT := 0;
END_VAR
VAR_INPUT
  input_val : REAL;
END_VAR
VAR_OUTPUT
  output_val : BOOL;
END_VAR
VAR CONSTANT
  LIMIT : REAL := 99.9;
END_VAR
END_PROGRAM`;

    const { variables } = parseStVariables(code);
    expect(variables).toHaveLength(4);
    expect(variables[0]).toMatchObject({ varName: 'local_var', scope: 'LOCAL' });
    expect(variables[1]).toMatchObject({ varName: 'input_val', scope: 'INPUT' });
    expect(variables[2]).toMatchObject({ varName: 'output_val', scope: 'OUTPUT' });
    expect(variables[3]).toMatchObject({ varName: 'LIMIT', scope: 'CONSTANT' });
  });

  it('handles empty VAR blocks', () => {
    const code = `
PROGRAM Empty
VAR
END_VAR
VAR_INPUT
END_VAR
END_PROGRAM`;

    const { variables, errors } = parseStVariables(code);
    expect(errors).toHaveLength(0);
    expect(variables).toHaveLength(0);
  });

  it('handles multi-name declarations (a, b, c : INT)', () => {
    const code = `
PROGRAM Multi
VAR
  x, y, z : REAL := 0.0;
END_VAR
END_PROGRAM`;

    const { variables } = parseStVariables(code);
    expect(variables).toHaveLength(3);
    expect(variables[0]).toMatchObject({ varName: 'x', dataType: 'REAL', initialValue: '0.0' });
    expect(variables[1]).toMatchObject({ varName: 'y', dataType: 'REAL', initialValue: '0.0' });
    expect(variables[2]).toMatchObject({ varName: 'z', dataType: 'REAL', initialValue: '0.0' });
  });

  it('extracts inline // comments as description', () => {
    const code = `
PROGRAM WithComments
VAR
  temperature : REAL := 25.0; // Water temperature in Celsius
  pump_on : BOOL; // Main pump enable signal
END_VAR
END_PROGRAM`;

    const { variables } = parseStVariables(code);
    expect(variables[0]!.description).toBe('Water temperature in Celsius');
    expect(variables[1]!.description).toBe('Main pump enable signal');
  });

  it('extracts inline (* *) comments as description', () => {
    const code = `
PROGRAM WithBlockComments
VAR
  setpoint : REAL := 7.0; (* pH target value *)
END_VAR
END_PROGRAM`;

    const { variables } = parseStVariables(code);
    expect(variables[0]!.description).toBe('pH target value');
  });

  it('handles variables with no inline comment (no description)', () => {
    const code = `
PROGRAM NoComment
VAR
  count : INT := 0;
END_VAR
END_PROGRAM`;

    const { variables } = parseStVariables(code);
    expect(variables[0]!.description).toBeUndefined();
  });

  it('handles STRING type with max length', () => {
    const code = `
PROGRAM Strings
VAR
  name : STRING;
  label : STRING[50];
END_VAR
END_PROGRAM`;

    const { variables } = parseStVariables(code);
    expect(variables[0]).toMatchObject({ varName: 'name', dataType: 'STRING' });
    // Note: the max-length in STRING[50] is preserved in the type node
    // but the parser represents it with a maxLength expression
    expect(variables[1]!.dataType).toMatch(/^STRING/);
  });

  it('handles ARRAY type', () => {
    const code = `
PROGRAM Arrays
VAR
  readings : ARRAY[0..9] OF REAL;
END_VAR
END_PROGRAM`;

    const { variables } = parseStVariables(code);
    expect(variables[0]!.dataType).toBe('ARRAY[0..9] OF REAL');
  });

  it('handles TIME type initial values', () => {
    const code = `
PROGRAM Timers
VAR
  delay : TIME := T#5s;
END_VAR
END_PROGRAM`;

    const { variables } = parseStVariables(code);
    expect(variables[0]).toMatchObject({
      varName: 'delay',
      dataType: 'TIME',
      initialValue: 'T#5s',
    });
  });

  it('handles string initial values', () => {
    const code = `
PROGRAM StringInit
VAR
  greeting : STRING := 'hello';
END_VAR
END_PROGRAM`;

    const { variables } = parseStVariables(code);
    expect(variables[0]).toMatchObject({
      varName: 'greeting',
      dataType: 'STRING',
      initialValue: "'hello'",
    });
  });

  it('handles negative initial values', () => {
    const code = `
PROGRAM Negative
VAR
  offset : REAL := -10.5;
END_VAR
END_PROGRAM`;

    const { variables } = parseStVariables(code);
    expect(variables[0]).toMatchObject({
      varName: 'offset',
      dataType: 'REAL',
      initialValue: '-10.5',
    });
  });

  it('handles named/user-defined types', () => {
    const code = `
PROGRAM CustomTypes
VAR
  my_timer : TON;
  my_fb : MyFunctionBlock;
END_VAR
END_PROGRAM`;

    const { variables } = parseStVariables(code);
    expect(variables[0]).toMatchObject({ varName: 'my_timer', dataType: 'TON' });
    expect(variables[1]).toMatchObject({ varName: 'my_fb', dataType: 'MyFunctionBlock' });
  });

  it('works with FUNCTION_BLOCK POU', () => {
    const code = `
FUNCTION_BLOCK PIDController
VAR_INPUT
  setpoint : REAL;
  process_value : REAL;
END_VAR
VAR_OUTPUT
  control_output : REAL;
END_VAR
VAR
  error : REAL;
  integral : REAL := 0.0;
END_VAR
END_FUNCTION_BLOCK`;

    const { variables, errors } = parseStVariables(code);
    expect(errors).toHaveLength(0);
    expect(variables).toHaveLength(5);
    expect(variables[0]).toMatchObject({ varName: 'setpoint', scope: 'INPUT' });
    expect(variables[1]).toMatchObject({ varName: 'process_value', scope: 'INPUT' });
    expect(variables[2]).toMatchObject({ varName: 'control_output', scope: 'OUTPUT' });
    expect(variables[3]).toMatchObject({ varName: 'error', scope: 'LOCAL' });
    expect(variables[4]).toMatchObject({ varName: 'integral', scope: 'LOCAL', initialValue: '0.0' });
  });

  it('works with FUNCTION POU', () => {
    const code = `
FUNCTION Clamp : REAL
VAR_INPUT
  value : REAL;
  min_val : REAL;
  max_val : REAL;
END_VAR
END_FUNCTION`;

    const { variables, errors } = parseStVariables(code);
    expect(errors).toHaveLength(0);
    expect(variables).toHaveLength(3);
    expect(variables[0]).toMatchObject({ varName: 'value', scope: 'INPUT' });
  });

  it('populates line numbers', () => {
    const code = `PROGRAM P
VAR
  a : INT;
  b : REAL;
END_VAR
END_PROGRAM`;

    const { variables } = parseStVariables(code);
    expect(variables[0]!.line).toBeDefined();
    expect(variables[1]!.line).toBeDefined();
    // b should be on a later line than a
    expect(variables[1]!.line!).toBeGreaterThan(variables[0]!.line!);
  });

  it('reports parser errors without crashing', () => {
    // Malformed code: missing END_VAR
    const code = `
PROGRAM Broken
VAR
  x : INT;
END_PROGRAM`;

    const result = parseStVariables(code);
    // Should still try to extract variables that were parseable
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('handles a realistic dosing pump program', () => {
    const code = `
PROGRAM DosingPump
VAR_INPUT
  pH_value : REAL;           // Current pH reading
  pH_setpoint : REAL := 7.0; // Target pH
  enable : BOOL := FALSE;    // Master enable
END_VAR
VAR_OUTPUT
  pump_speed : REAL;         // Pump speed 0-100%
  alarm : BOOL;              // High/low pH alarm
END_VAR
VAR
  error : REAL;
  integral : REAL := 0.0;
  kp : REAL := 2.0;          // Proportional gain
  ki : REAL := 0.5;          // Integral gain
END_VAR
VAR CONSTANT
  MAX_SPEED : REAL := 100.0;
  MIN_SPEED : REAL := 0.0;
  ALARM_HIGH : REAL := 9.0;
  ALARM_LOW : REAL := 5.0;
END_VAR

  error := pH_setpoint - pH_value;
  integral := integral + error;
  pump_speed := kp * error + ki * integral;

  IF pump_speed > MAX_SPEED THEN
    pump_speed := MAX_SPEED;
  ELSIF pump_speed < MIN_SPEED THEN
    pump_speed := MIN_SPEED;
  END_IF;

  alarm := (pH_value > ALARM_HIGH) OR (pH_value < ALARM_LOW);

  IF NOT enable THEN
    pump_speed := 0.0;
  END_IF;
END_PROGRAM`;

    const { variables, errors } = parseStVariables(code);
    expect(errors).toHaveLength(0);
    expect(variables).toHaveLength(13);

    // Check scopes
    const inputs = variables.filter((v) => v.scope === 'INPUT');
    const outputs = variables.filter((v) => v.scope === 'OUTPUT');
    const locals = variables.filter((v) => v.scope === 'LOCAL');
    const constants = variables.filter((v) => v.scope === 'CONSTANT');

    expect(inputs).toHaveLength(3);
    expect(outputs).toHaveLength(2);
    expect(locals).toHaveLength(4);
    expect(constants).toHaveLength(4);

    // Check descriptions from inline comments
    expect(inputs.find((v) => v.varName === 'pH_value')!.description).toBe('Current pH reading');
    expect(inputs.find((v) => v.varName === 'pH_setpoint')!.description).toBe('Target pH');
    expect(constants.find((v) => v.varName === 'MAX_SPEED')!.initialValue).toBe('100.0');
  });
});

// ============================================================================
// hasStVariables
// ============================================================================

describe('hasStVariables', () => {
  it('returns true when VAR block is present', () => {
    expect(hasStVariables('VAR\n  x : INT;\nEND_VAR')).toBe(true);
  });

  it('returns true for VAR_INPUT', () => {
    expect(hasStVariables('some code VAR_INPUT stuff')).toBe(true);
  });

  it('returns true for VAR_OUTPUT', () => {
    expect(hasStVariables('VAR_OUTPUT')).toBe(true);
  });

  it('returns true for VAR_IN_OUT', () => {
    expect(hasStVariables('VAR_IN_OUT')).toBe(true);
  });

  it('returns true for VAR_GLOBAL', () => {
    expect(hasStVariables('VAR_GLOBAL')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(hasStVariables('')).toBe(false);
  });

  it('returns false for code without VAR blocks', () => {
    expect(hasStVariables('x := 5; y := x + 1;')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(hasStVariables('var\n  x : int;\nend_var')).toBe(true);
    expect(hasStVariables('Var_Input')).toBe(true);
  });
});

// ============================================================================
// diffVariables
// ============================================================================

describe('diffVariables', () => {
  const parsed: ParsedVariable[] = [
    { varName: 'temperature', dataType: 'REAL', scope: 'INPUT' },
    { varName: 'pump_on', dataType: 'BOOL', scope: 'LOCAL' },
    { varName: 'new_var', dataType: 'INT', scope: 'OUTPUT' },
  ];

  const existing = [
    { varName: 'temperature', id: 'uuid-1', dataType: 'REAL' },
    { varName: 'pump_on', id: 'uuid-2', dataType: 'BOOL' },
    { varName: 'old_var', id: 'uuid-3', dataType: 'INT' },
  ];

  it('identifies new variables (toAdd)', () => {
    const { toAdd } = diffVariables(parsed, existing);
    expect(toAdd).toHaveLength(1);
    expect(toAdd[0]!.varName).toBe('new_var');
  });

  it('identifies removed variables (toRemove)', () => {
    const { toRemove } = diffVariables(parsed, existing);
    expect(toRemove).toHaveLength(1);
    expect(toRemove[0]!.varName).toBe('old_var');
    expect(toRemove[0]!.id).toBe('uuid-3');
  });

  it('identifies unchanged variables', () => {
    const { unchanged } = diffVariables(parsed, existing);
    expect(unchanged).toHaveLength(2);
    expect(unchanged.map((v) => v.varName).sort()).toEqual(['pump_on', 'temperature']);
  });

  it('matches case-insensitively', () => {
    const { toAdd, unchanged } = diffVariables(
      [{ varName: 'Temperature', dataType: 'REAL', scope: 'INPUT' }],
      [{ varName: 'temperature', id: 'uuid-1' }],
    );
    expect(toAdd).toHaveLength(0);
    expect(unchanged).toHaveLength(1);
  });

  it('handles empty parsed list', () => {
    const { toAdd, toRemove } = diffVariables([], existing);
    expect(toAdd).toHaveLength(0);
    expect(toRemove).toHaveLength(3);
  });

  it('handles empty existing list', () => {
    const { toAdd, toRemove } = diffVariables(parsed, []);
    expect(toAdd).toHaveLength(3);
    expect(toRemove).toHaveLength(0);
  });
});
