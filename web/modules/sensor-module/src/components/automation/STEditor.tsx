/**
 * Structured Text Editor - Monaco-based IEC 61131-3 ST code editor
 */

import React, { useRef, useCallback, Suspense } from 'react';

const MonacoEditorLazy = React.lazy(() => import('@monaco-editor/react'));

let monacoRegistered = false;

interface STEditorProps {
  value: string;
  onChange: (value: string) => void;
  height?: string;
  readOnly?: boolean;
}

const STEditor: React.FC<STEditorProps> = ({
  value,
  onChange,
  height = '400px',
  readOnly = false,
}) => {
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);

  const handleEditorDidMount = useCallback(
    (editor: any, monaco: any) => {
      editorRef.current = editor;
      monacoRef.current = monaco;

      // Register ST language if not already done
      if (!monacoRegistered) {
        monacoRegistered = true;

        monaco.languages.register({ id: 'structured-text' });

        monaco.languages.setMonarchTokensProvider('structured-text', {
          ignoreCase: true,
          keywords: [
            'PROGRAM', 'END_PROGRAM', 'FUNCTION', 'END_FUNCTION',
            'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK',
            'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL',
            'VAR_TEMP', 'VAR_EXTERNAL', 'END_VAR', 'CONSTANT', 'RETAIN',
            'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
            'CASE', 'OF', 'END_CASE',
            'FOR', 'TO', 'BY', 'DO', 'END_FOR',
            'WHILE', 'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT',
            'RETURN', 'EXIT', 'CONTINUE',
            'AND', 'OR', 'XOR', 'NOT', 'MOD',
            'TRUE', 'FALSE',
            'TYPE', 'END_TYPE', 'STRUCT', 'END_STRUCT', 'ARRAY',
          ],
          typeKeywords: [
            'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
            'SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT',
            'REAL', 'LREAL', 'STRING', 'WSTRING', 'TIME', 'DATE',
            'TIME_OF_DAY', 'TOD', 'DATE_AND_TIME', 'DT',
          ],
          builtinFunctions: [
            'ABS', 'SQRT', 'LN', 'LOG', 'EXP', 'SIN', 'COS', 'TAN',
            'ASIN', 'ACOS', 'ATAN', 'ATAN2',
            'MAX', 'MIN', 'LIMIT', 'SEL', 'MUX',
            'SHL', 'SHR', 'ROL', 'ROR',
            'LEN', 'LEFT', 'RIGHT', 'MID', 'CONCAT', 'INSERT', 'DELETE', 'REPLACE', 'FIND',
            'BOOL_TO_INT', 'INT_TO_REAL', 'REAL_TO_INT', 'ANY_TO_STRING',
          ],
          functionBlocks: [
            'TON', 'TOF', 'TP', 'CTU', 'CTD', 'CTUD',
            'SR', 'RS', 'R_TRIG', 'F_TRIG',
            'PID', 'RAMP', 'HYSTERESIS',
          ],
          operators: [
            ':=', '<=', '>=', '<>', '=', '<', '>', '+', '-', '*', '/', '**',
            '(', ')', '[', ']', ',', ';', ':', '.', '..',
          ],
          tokenizer: {
            root: [
              [/\/\/.*$/, 'comment'],
              [/\(\*/, 'comment', '@comment'],
              [/T#[0-9]+[smhd]([0-9]+[smhd])*/, 'number'],
              [/16#[0-9A-Fa-f_]+/, 'number.hex'],
              [/8#[0-7_]+/, 'number.octal'],
              [/2#[01_]+/, 'number.binary'],
              [/[0-9]+\.[0-9]+([eE][+-]?[0-9]+)?/, 'number.float'],
              [/[0-9]+/, 'number'],
              [/'[^']*'/, 'string'],
              [/"[^"]*"/, 'string'],
              [
                /[a-zA-Z_]\w*/,
                {
                  cases: {
                    '@keywords': 'keyword',
                    '@typeKeywords': 'type',
                    '@builtinFunctions': 'predefined',
                    '@functionBlocks': 'predefined',
                    '@default': 'identifier',
                  },
                },
              ],
              [/[{}()[\]]/, '@brackets'],
              [/:=/, 'operator'],
              [/[<>]=?|<>/, 'operator'],
              [/[+\-*/]/, 'operator'],
              [/;/, 'delimiter'],
            ],
            comment: [
              [/[^(*]+/, 'comment'],
              [/\*\)/, 'comment', '@pop'],
              [/./, 'comment'],
            ],
          },
        });

        monaco.languages.setLanguageConfiguration('structured-text', {
          comments: {
            lineComment: '//',
            blockComment: ['(*', '*)'],
          },
          brackets: [
            ['(', ')'],
            ['[', ']'],
          ],
          autoClosingPairs: [
            { open: '(', close: ')' },
            { open: '[', close: ']' },
            { open: "'", close: "'", notIn: ['string'] },
            { open: '"', close: '"', notIn: ['string'] },
            { open: '(*', close: '*)' },
          ],
          indentationRules: {
            increaseIndentPattern: /^\s*(IF|ELSIF|ELSE|FOR|WHILE|REPEAT|CASE|VAR|VAR_INPUT|VAR_OUTPUT|PROGRAM|FUNCTION|FUNCTION_BLOCK|STRUCT|TYPE)\b/i,
            decreaseIndentPattern: /^\s*(END_IF|END_FOR|END_WHILE|END_REPEAT|END_CASE|END_VAR|END_PROGRAM|END_FUNCTION|END_FUNCTION_BLOCK|END_STRUCT|END_TYPE|ELSIF|ELSE)\b/i,
          },
        });
      }

      editor.focus();
    },
    [],
  );

  const editorFallback = (
    <div style={{ height }} className="border border-gray-200 rounded-lg overflow-hidden flex items-center justify-center bg-gray-900">
      <div className="text-gray-500 text-sm">Loading editor...</div>
    </div>
  );

  return (
    <div style={{ height }} className="border border-gray-200 rounded-lg overflow-hidden">
      <Suspense fallback={editorFallback}>
      <MonacoEditorLazy
        height={height}
        language="structured-text"
        theme="vs-dark"
        value={value}
        onChange={(val: string | undefined) => onChange(val || '')}
        onMount={handleEditorDidMount}
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 14,
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          tabSize: 2,
          automaticLayout: true,
          suggestOnTriggerCharacters: true,
          quickSuggestions: true,
        }}
      />
      </Suspense>
    </div>
  );
};

export default STEditor;
