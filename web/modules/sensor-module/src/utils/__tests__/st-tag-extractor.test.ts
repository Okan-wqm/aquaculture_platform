/**
 * Tests for ST Tag Reference Extractor
 */

import {
  extractIoVariables,
  analyzeBindings,
  suggestTagBindings,
  type ExtractedIoVariable,
  type ExistingVariable,
  type DeviceTag,
} from '../st-tag-extractor';

describe('extractIoVariables', () => {
  it('should return empty result for empty code', () => {
    const result = extractIoVariables('');
    expect(result.ioVariables).toHaveLength(0);
    expect(result.inputCount).toBe(0);
    expect(result.outputCount).toBe(0);
    expect(result.inoutCount).toBe(0);
  });

  it('should extract VAR_INPUT variables', () => {
    const code = `
PROGRAM WaterControl
VAR_INPUT
  water_temp : REAL;
  pump_enable : BOOL;
END_VAR
VAR
  internal_counter : INT;
END_VAR

IF water_temp > 25.0 THEN
  pump_enable := TRUE;
END_IF;

END_PROGRAM
`;
    const result = extractIoVariables(code);

    expect(result.inputCount).toBe(2);
    expect(result.outputCount).toBe(0);
    expect(result.ioVariables).toHaveLength(2);

    const waterTemp = result.ioVariables.find((v) => v.name === 'water_temp');
    expect(waterTemp).toBeDefined();
    expect(waterTemp!.dataType).toBe('REAL');
    expect(waterTemp!.direction).toBe('input');
    expect(waterTemp!.scope).toBe('VAR_INPUT');

    const pumpEnable = result.ioVariables.find((v) => v.name === 'pump_enable');
    expect(pumpEnable).toBeDefined();
    expect(pumpEnable!.dataType).toBe('BOOL');
    expect(pumpEnable!.direction).toBe('input');
  });

  it('should extract VAR_OUTPUT variables', () => {
    const code = `
PROGRAM PumpControl
VAR_OUTPUT
  pump_speed : REAL;
  alarm_active : BOOL;
END_VAR

pump_speed := 50.0;

END_PROGRAM
`;
    const result = extractIoVariables(code);

    expect(result.outputCount).toBe(2);
    expect(result.ioVariables).toHaveLength(2);

    const pumpSpeed = result.ioVariables.find((v) => v.name === 'pump_speed');
    expect(pumpSpeed).toBeDefined();
    expect(pumpSpeed!.dataType).toBe('REAL');
    expect(pumpSpeed!.direction).toBe('output');
    expect(pumpSpeed!.scope).toBe('VAR_OUTPUT');
  });

  it('should extract VAR_IN_OUT variables', () => {
    const code = `
PROGRAM MixedIO
VAR_IN_OUT
  shared_value : REAL;
END_VAR

shared_value := shared_value + 1.0;

END_PROGRAM
`;
    const result = extractIoVariables(code);

    expect(result.inoutCount).toBe(1);
    expect(result.ioVariables).toHaveLength(1);
    expect(result.ioVariables[0].direction).toBe('inout');
    expect(result.ioVariables[0].scope).toBe('VAR_IN_OUT');
  });

  it('should extract from multiple VAR blocks', () => {
    const code = `
PROGRAM FullIO
VAR_INPUT
  temperature : REAL;
  ph_value : REAL;
  emergency_stop : BOOL;
END_VAR
VAR_OUTPUT
  heater_on : BOOL;
  dosing_pump_speed : REAL;
END_VAR
VAR
  internal_state : INT;
  timer1 : TON;
END_VAR

IF temperature < 20.0 THEN
  heater_on := TRUE;
END_IF;

END_PROGRAM
`;
    const result = extractIoVariables(code);

    expect(result.inputCount).toBe(3);
    expect(result.outputCount).toBe(2);
    expect(result.inoutCount).toBe(0);
    // LOCAL variables should NOT be included
    expect(result.ioVariables).toHaveLength(5);
  });

  it('should ignore LOCAL, RETAIN, and CONSTANT variables', () => {
    const code = `
PROGRAM OnlyLocals
VAR
  counter : INT;
END_VAR
VAR CONSTANT
  MAX_VALUE : INT := 100;
END_VAR
VAR RETAIN
  accumulated : REAL;
END_VAR

counter := counter + 1;

END_PROGRAM
`;
    const result = extractIoVariables(code);
    expect(result.ioVariables).toHaveLength(0);
  });

  it('should extract initial values', () => {
    const code = `
PROGRAM WithDefaults
VAR_INPUT
  setpoint : REAL := 25.0;
  enabled : BOOL := TRUE;
END_VAR

END_PROGRAM
`;
    const result = extractIoVariables(code);

    const setpoint = result.ioVariables.find((v) => v.name === 'setpoint');
    expect(setpoint).toBeDefined();
    expect(setpoint!.initialValue).toBe('25');

    const enabled = result.ioVariables.find((v) => v.name === 'enabled');
    expect(enabled).toBeDefined();
    expect(enabled!.initialValue).toBe('TRUE');
  });

  it('should handle FUNCTION_BLOCK VAR_INPUT/OUTPUT', () => {
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
END_VAR

error := setpoint - process_value;
control_output := error * 1.5;

END_FUNCTION_BLOCK
`;
    const result = extractIoVariables(code);

    expect(result.inputCount).toBe(2);
    expect(result.outputCount).toBe(1);
    expect(result.ioVariables).toHaveLength(3);
  });

  it('should report line numbers', () => {
    const code = `PROGRAM Test
VAR_INPUT
  x : REAL;
END_VAR
END_PROGRAM`;
    const result = extractIoVariables(code);
    expect(result.ioVariables).toHaveLength(1);
    expect(result.ioVariables[0].line).toBe(3); // x is on line 3
  });
});

describe('analyzeBindings', () => {
  const extracted: ExtractedIoVariable[] = [
    { name: 'water_temp', dataType: 'REAL', direction: 'input', scope: 'VAR_INPUT', line: 3, column: 3 },
    { name: 'pump_speed', dataType: 'REAL', direction: 'output', scope: 'VAR_OUTPUT', line: 7, column: 3 },
    { name: 'alarm_active', dataType: 'BOOL', direction: 'output', scope: 'VAR_OUTPUT', line: 8, column: 3 },
  ];

  it('should mark variables as unbound when no existing variables', () => {
    const bindings = analyzeBindings(extracted, []);
    expect(bindings).toHaveLength(3);
    expect(bindings[0].status).toBe('unbound');
    expect(bindings[1].status).toBe('unbound');
    expect(bindings[2].status).toBe('unbound');
  });

  it('should mark variables as bound when they have ioTagName', () => {
    const existing: ExistingVariable[] = [
      { varName: 'water_temp', scope: 'INPUT', ioTagName: 'ai_water_temp', ioConfigId: 'uuid-1', dataType: 'REAL' },
      { varName: 'pump_speed', scope: 'OUTPUT', ioTagName: 'ao_pump_speed', ioConfigId: 'uuid-2', dataType: 'REAL' },
    ];

    const bindings = analyzeBindings(extracted, existing);
    expect(bindings[0].status).toBe('bound');
    expect(bindings[0].boundTagName).toBe('ai_water_temp');
    expect(bindings[1].status).toBe('bound');
    expect(bindings[2].status).toBe('unbound');
  });

  it('should mark variables as unbound when existing variable has no ioTagName', () => {
    const existing: ExistingVariable[] = [
      { varName: 'water_temp', scope: 'INPUT', dataType: 'REAL' },
    ];

    const bindings = analyzeBindings(extracted, existing);
    expect(bindings[0].status).toBe('unbound');
    expect(bindings[0].warning).toBeDefined();
  });

  it('should detect data type mismatches', () => {
    const existing: ExistingVariable[] = [
      { varName: 'water_temp', scope: 'INPUT', ioTagName: 'ai_water_temp', ioConfigId: 'uuid-1', dataType: 'STRING' },
    ];

    const bindings = analyzeBindings(extracted, existing);
    expect(bindings[0].status).toBe('mismatch');
    expect(bindings[0].warning).toContain('Veri tipi');
  });

  it('should be case-insensitive on variable name matching', () => {
    const existing: ExistingVariable[] = [
      { varName: 'Water_Temp', scope: 'INPUT', ioTagName: 'ai_water_temp', ioConfigId: 'uuid-1', dataType: 'REAL' },
    ];

    const bindings = analyzeBindings(extracted, existing);
    expect(bindings[0].status).toBe('bound');
  });

  it('should consider INT and DINT compatible', () => {
    const extractedInt: ExtractedIoVariable[] = [
      { name: 'counter', dataType: 'INT', direction: 'input', scope: 'VAR_INPUT', line: 1, column: 1 },
    ];
    const existing: ExistingVariable[] = [
      { varName: 'counter', scope: 'INPUT', ioTagName: 'count_tag', ioConfigId: 'uuid-1', dataType: 'DINT' },
    ];

    const bindings = analyzeBindings(extractedInt, existing);
    expect(bindings[0].status).toBe('bound');
  });
});

describe('suggestTagBindings', () => {
  const deviceTags: DeviceTag[] = [
    { id: 'tag-1', tagName: 'water_temp', ioType: 'AI', dataType: 'FLOAT32' },
    { id: 'tag-2', tagName: 'pump_speed', ioType: 'AO', dataType: 'FLOAT32' },
    { id: 'tag-3', tagName: 'emergency_stop', ioType: 'DI', dataType: 'BOOL' },
    { id: 'tag-4', tagName: 'heater_relay', ioType: 'DO', dataType: 'BOOL' },
  ];

  it('should suggest exact matches', () => {
    const unbound: ExtractedIoVariable[] = [
      { name: 'water_temp', dataType: 'REAL', direction: 'input', scope: 'VAR_INPUT', line: 3, column: 3 },
    ];

    const suggestions = suggestTagBindings(unbound, deviceTags);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].variableName).toBe('water_temp');
    expect(suggestions[0].suggestedTag.tagName).toBe('water_temp');
    expect(suggestions[0].matchType).toBe('exact');
    expect(suggestions[0].confidence).toBe(1.0);
  });

  it('should respect direction compatibility', () => {
    // pump_speed is an output, and tag pump_speed is AO -- should match
    const unbound: ExtractedIoVariable[] = [
      { name: 'pump_speed', dataType: 'REAL', direction: 'output', scope: 'VAR_OUTPUT', line: 5, column: 3 },
    ];

    const suggestions = suggestTagBindings(unbound, deviceTags);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].suggestedTag.ioType).toBe('AO');
  });

  it('should not suggest input tags for output variables', () => {
    // emergency_stop is DI (input), water_temp var is output -- should NOT match
    const unbound: ExtractedIoVariable[] = [
      { name: 'emergency_stop', dataType: 'BOOL', direction: 'output', scope: 'VAR_OUTPUT', line: 5, column: 3 },
    ];

    const suggestions = suggestTagBindings(unbound, deviceTags);
    // emergency_stop is DI (input), not an output tag, so it should NOT be suggested for an output variable
    expect(suggestions).toHaveLength(0);
  });

  it('should handle case-insensitive matching', () => {
    const unbound: ExtractedIoVariable[] = [
      { name: 'WATER_TEMP', dataType: 'REAL', direction: 'input', scope: 'VAR_INPUT', line: 3, column: 3 },
    ];

    const suggestions = suggestTagBindings(unbound, deviceTags);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].matchType).toBe('exact');
  });

  it('should return empty for no matching tags', () => {
    const unbound: ExtractedIoVariable[] = [
      { name: 'no_match_variable', dataType: 'REAL', direction: 'input', scope: 'VAR_INPUT', line: 3, column: 3 },
    ];

    const suggestions = suggestTagBindings(unbound, deviceTags);
    expect(suggestions).toHaveLength(0);
  });

  it('should suggest partial matches', () => {
    const tags: DeviceTag[] = [
      { id: 'tag-1', tagName: 'ai_water_temperature', ioType: 'AI', dataType: 'FLOAT32' },
    ];

    const unbound: ExtractedIoVariable[] = [
      { name: 'water_temperature', dataType: 'REAL', direction: 'input', scope: 'VAR_INPUT', line: 3, column: 3 },
    ];

    const suggestions = suggestTagBindings(unbound, tags);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].matchType).toBe('partial');
    expect(suggestions[0].confidence).toBeLessThan(1.0);
  });
});
