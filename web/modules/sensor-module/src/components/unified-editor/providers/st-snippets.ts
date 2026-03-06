/**
 * IEC 61131-3 Structured Text Snippet Definitions
 *
 * 36 total snippets: 12 existing (from StCompletionProvider) + 24 new
 * Each snippet provides a code template with $1/$2 tab-stop placeholders.
 */
import type { languages } from 'monaco-editor';

export interface StSnippetDef {
  prefix: string;
  body: string;
  description: string;
}

export const ST_SNIPPETS: StSnippetDef[] = [
  // ── Existing 12 snippets (migrated from StCompletionProvider) ──
  {
    prefix: 'PROGRAM',
    body: 'PROGRAM ${1:ProgramName}\nVAR\n    ${2:// variables}\nEND_VAR\n\n${3:// logic}\n\nEND_PROGRAM',
    description: 'Program declaration',
  },
  {
    prefix: 'FUNCTION_BLOCK',
    body: 'FUNCTION_BLOCK ${1:FBName}\nVAR_INPUT\n    ${2}\nEND_VAR\nVAR_OUTPUT\n    ${3}\nEND_VAR\nVAR\n    ${4}\nEND_VAR\n\n${5}\n\nEND_FUNCTION_BLOCK',
    description: 'Function Block declaration',
  },
  {
    prefix: 'IF..THEN..END_IF',
    body: 'IF ${1:condition} THEN\n    ${2}\nEND_IF;',
    description: 'If-Then block',
  },
  {
    prefix: 'IF..THEN..ELSE..END_IF',
    body: 'IF ${1:condition} THEN\n    ${2}\nELSE\n    ${3}\nEND_IF;',
    description: 'If-Then-Else block',
  },
  {
    prefix: 'FOR..DO..END_FOR',
    body: 'FOR ${1:i} := ${2:0} TO ${3:10} DO\n    ${4}\nEND_FOR;',
    description: 'For loop',
  },
  {
    prefix: 'WHILE..DO..END_WHILE',
    body: 'WHILE ${1:condition} DO\n    ${2}\nEND_WHILE;',
    description: 'While loop',
  },
  {
    prefix: 'REPEAT..UNTIL..END_REPEAT',
    body: 'REPEAT\n    ${1}\nUNTIL ${2:condition}\nEND_REPEAT;',
    description: 'Repeat-Until loop',
  },
  {
    prefix: 'CASE..OF..END_CASE',
    body: 'CASE ${1:variable} OF\n    ${2:1}: ${3};\n    ${4:2}: ${5};\nELSE\n    ${6};\nEND_CASE;',
    description: 'Case statement',
  },
  {
    prefix: 'VAR..END_VAR',
    body: 'VAR\n    ${1:varName} : ${2:INT};\nEND_VAR',
    description: 'Variable declaration block',
  },
  {
    prefix: 'VAR_INPUT..END_VAR',
    body: 'VAR_INPUT\n    ${1:inputName} : ${2:REAL};\nEND_VAR',
    description: 'Input variable declaration',
  },
  {
    prefix: 'TON timer',
    body: '${1:timer} : TON;\n${1:timer}(IN := ${2:startCond}, PT := T#${3:1000}ms);\nIF ${1:timer}.Q THEN\n    ${4}\nEND_IF;',
    description: 'TON timer with output check',
  },
  {
    prefix: 'PID controller',
    body: '${1:pid} : PID;\n${1:pid}(\n    SETPOINT := ${2:target},\n    PROCESS_VALUE := ${3:sensor},\n    KP := ${4:1.0},\n    KI := ${5:0.1},\n    KD := ${6:0.01}\n);',
    description: 'PID controller instance',
  },

  // ── 24 new snippets ──
  {
    prefix: 'FUNCTION',
    body: 'FUNCTION ${1:FunctionName} : ${2:REAL}\nVAR_INPUT\n    ${3:param1} : ${4:REAL};\nEND_VAR\nVAR\n    ${5}\nEND_VAR\n\n${1:FunctionName} := ${6:0.0};\n\nEND_FUNCTION',
    description: 'Function declaration with return type',
  },
  {
    prefix: 'METHOD',
    body: 'METHOD ${1:MethodName} : ${2:BOOL}\nVAR_INPUT\n    ${3:param1} : ${4:REAL};\nEND_VAR\n\n${5}\n${1:MethodName} := ${6:TRUE};\n\nEND_METHOD',
    description: 'Method declaration',
  },
  {
    prefix: 'PROPERTY',
    body: 'PROPERTY ${1:PropertyName} : ${2:REAL}\n\n// Getter\nGET\n    ${1:PropertyName} := ${3:_value};\nEND_GET\n\n// Setter\nSET\n    ${3:_value} := ${1:PropertyName};\nEND_SET\n\nEND_PROPERTY',
    description: 'Property with getter and setter',
  },
  {
    prefix: 'INTERFACE',
    body: 'INTERFACE ${1:IMyInterface}\n\n    METHOD ${2:MethodName} : ${3:BOOL}\n    VAR_INPUT\n        ${4:param1} : ${5:REAL};\n    END_VAR\n    END_METHOD\n\nEND_INTERFACE',
    description: 'Interface declaration',
  },
  {
    prefix: 'TYPE_ENUM',
    body: 'TYPE ${1:EnumName} :\n(\n    ${2:VALUE_1} := 0,\n    ${3:VALUE_2} := 1,\n    ${4:VALUE_3} := 2\n);\nEND_TYPE',
    description: 'Enumeration type definition',
  },
  {
    prefix: 'TYPE_STRUCT',
    body: 'TYPE ${1:StructName} :\nSTRUCT\n    ${2:field1} : ${3:REAL};\n    ${4:field2} : ${5:INT};\n    ${6:field3} : ${7:BOOL};\nEND_STRUCT\nEND_TYPE',
    description: 'Structure type definition',
  },
  {
    prefix: 'ARRAY_DECL',
    body: '${1:arrName} : ARRAY[${2:0}..${3:9}] OF ${4:REAL};',
    description: 'One-dimensional array declaration',
  },
  {
    prefix: 'ARRAY_2D',
    body: '${1:matrix} : ARRAY[${2:0}..${3:3}, ${4:0}..${5:3}] OF ${6:REAL};',
    description: 'Two-dimensional array declaration',
  },
  {
    prefix: 'R_TRIG usage',
    body: '${1:risingEdge} : R_TRIG;\n${1:risingEdge}(CLK := ${2:inputSignal});\nIF ${1:risingEdge}.Q THEN\n    ${3:// rising edge detected}\nEND_IF;',
    description: 'Rising edge trigger with usage',
  },
  {
    prefix: 'F_TRIG usage',
    body: '${1:fallingEdge} : F_TRIG;\n${1:fallingEdge}(CLK := ${2:inputSignal});\nIF ${1:fallingEdge}.Q THEN\n    ${3:// falling edge detected}\nEND_IF;',
    description: 'Falling edge trigger with usage',
  },
  {
    prefix: 'TOF timer',
    body: '${1:offDelay} : TOF;\n${1:offDelay}(IN := ${2:runSignal}, PT := T#${3:5000}ms);\nIF ${1:offDelay}.Q THEN\n    ${4:// still active after delay}\nEND_IF;',
    description: 'TOF off-delay timer with usage',
  },
  {
    prefix: 'CTU counter',
    body: '${1:counter} : CTU;\n${1:counter}(CU := ${2:countPulse}, R := ${3:resetSignal}, PV := ${4:100});\nIF ${1:counter}.Q THEN\n    ${5:// count reached}\nEND_IF;',
    description: 'CTU up-counter with usage',
  },
  {
    prefix: 'CTUD counter',
    body: '${1:biCounter} : CTUD;\n${1:biCounter}(\n    CU := ${2:upPulse},\n    CD := ${3:downPulse},\n    R := ${4:reset},\n    LD := ${5:load},\n    PV := ${6:100}\n);\n// ${1:biCounter}.QU = upper limit reached\n// ${1:biCounter}.QD = lower limit reached\n// ${1:biCounter}.CV = current value',
    description: 'CTUD bidirectional counter with usage',
  },
  {
    prefix: 'RAMP',
    body: '${1:ramp} : RAMP;\n${1:ramp}(\n    IN := ${2:targetValue},\n    RATE := ${3:10.0},\n    CYCLE := T#${4:100}ms\n);\n${5:output} := ${1:ramp}.OUT;',
    description: 'RAMP generator for smooth transitions',
  },
  {
    prefix: 'BLINK',
    body: '${1:blinker} : BLINK;\n${1:blinker}(\n    ENABLE := ${2:TRUE},\n    TIMELOW := T#${3:500}ms,\n    TIMEHIGH := T#${4:500}ms\n);\n${5:lamp} := ${1:blinker}.Q;',
    description: 'BLINK timer for flashing outputs',
  },
  {
    prefix: 'LIMITALARM',
    body: '${1:alarm} : LIMITALARM;\n${1:alarm}(\n    IN := ${2:sensorValue},\n    HH := ${3:95.0},\n    H := ${4:80.0},\n    L := ${5:20.0},\n    LL := ${6:5.0}\n);\nIF ${1:alarm}.QHH THEN\n    ${7:// critical high alarm}\nEND_IF;',
    description: 'LIMITALARM four-level alarm with usage',
  },
  {
    prefix: 'PID_COMPACT',
    body: '${1:pidCtrl} : PID_COMPACT;\n${1:pidCtrl}(\n    SETPOINT := ${2:targetTemp},\n    INPUT := ${3:currentTemp},\n    MANUAL := ${4:FALSE}\n);\n${5:controlOutput} := ${1:pidCtrl}.OUTPUT;\n// State: 0=idle, 1=tuning, 2=running',
    description: 'PID_COMPACT self-tuning controller',
  },
  {
    prefix: 'SCALE',
    body: '${1:scaler} : SCALE;\n${1:scaler}(\n    IN := ${2:rawValue},\n    IN_MIN := ${3:0.0},\n    IN_MAX := ${4:4095.0},\n    OUT_MIN := ${5:0.0},\n    OUT_MAX := ${6:100.0}\n);\n${7:scaledValue} := ${1:scaler}.OUT;',
    description: 'SCALE linear scaling (e.g., ADC to engineering units)',
  },
  {
    prefix: 'IO_ADDRESS',
    body: '${1:input} AT %${2|I,Q|}${3|X,B,W,D|}${4:0}.${5:0} : ${6:BOOL};',
    description: 'Direct I/O address mapping (%IX, %QX, etc.)',
  },
  {
    prefix: 'VAR_GLOBAL..END_VAR',
    body: 'VAR_GLOBAL\n    ${1:globalVar1} : ${2:REAL};\n    ${3:globalVar2} : ${4:BOOL};\nEND_VAR',
    description: 'Global variable block',
  },
  {
    prefix: 'VAR_TEMP..END_VAR',
    body: 'VAR_TEMP\n    ${1:tempVar} : ${2:INT};\nEND_VAR',
    description: 'Temporary variable block',
  },
  {
    prefix: 'IF..ELSIF..ELSE..END_IF',
    body: 'IF ${1:cond1} THEN\n    ${2}\nELSIF ${3:cond2} THEN\n    ${4}\nELSIF ${5:cond3} THEN\n    ${6}\nELSE\n    ${7}\nEND_IF;',
    description: 'If-ElsIf chain with multiple branches',
  },
  {
    prefix: 'FOR array iteration',
    body: 'FOR ${1:i} := ${2:0} TO ${3:UPPER_BOUND}(${4:myArray}) DO\n    ${5:// process} ${4:myArray}[${1:i}];\nEND_FOR;',
    description: 'For loop iterating over array elements',
  },
  {
    prefix: 'AQUA_PUMP_CONTROL',
    body: 'PROGRAM ${1:PumpControl}\nVAR\n    waterLevel : REAL;           // Sensor: su seviyesi (cm)\n    waterTemp : REAL;            // Sensor: su sicakligi (C)\n    pumpOn : BOOL;               // Cikis: pompa kontrolu\n    heaterOn : BOOL;             // Cikis: isitici kontrolu\n    levelAlarm : LIMITALARM;\n    tempRamp : RAMP;\nEND_VAR\n\n// Seviye alarm kontrolu\nlevelAlarm(\n    IN := waterLevel,\n    HH := ${2:95.0},\n    H := ${3:85.0},\n    L := ${4:30.0},\n    LL := ${5:20.0}\n);\n\n// Pompa kontrolu - dusuk seviyede calistir\npumpOn := levelAlarm.QL OR levelAlarm.QLL;\n\n// Sicaklik rampa kontrolu\ntempRamp(\n    IN := ${6:25.0},\n    RATE := ${7:1.0},\n    CYCLE := T#100ms\n);\n\nIF waterTemp < tempRamp.OUT THEN\n    heaterOn := TRUE;\nELSE\n    heaterOn := FALSE;\nEND_IF;\n\nEND_PROGRAM',
    description: 'Aquaculture pump control template with level alarm and temperature ramp',
  },
];

/**
 * Creates a Monaco CompletionItemProvider for ST snippets.
 * Register with: monaco.languages.registerCompletionItemProvider(languageId, createStSnippetProvider())
 */
export function createStSnippetProvider(): languages.CompletionItemProvider {
  return {
    provideCompletionItems(
      model,
      position,
    ): languages.ProviderResult<languages.CompletionList> {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions: languages.CompletionItem[] = ST_SNIPPETS.map((s) => ({
        label: s.prefix,
        kind: 27, // Snippet
        insertText: s.body,
        insertTextRules: 4, // InsertAsSnippet
        detail: s.description,
        documentation: { value: '```st\n' + s.body.replace(/\$\{\d+(?::([^}]*))?}/g, '$1') + '\n```' },
        range,
        sortText: '0_' + s.prefix,
      }));

      return { suggestions };
    },
  };
}
