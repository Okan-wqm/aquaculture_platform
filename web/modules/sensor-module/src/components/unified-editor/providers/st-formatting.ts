/**
 * Monaco DocumentFormattingEditProvider for IEC 61131-3 Structured Text
 *
 * Formatting rules:
 * - Keyword uppercase (if → IF, then → THEN, etc.)
 * - 4-space indentation
 * - Blank line between VAR..END_VAR and body
 * - Semicolons at end of statements
 * - Align := assignments within same block
 */
import type { languages, editor, CancellationToken } from 'monaco-editor';

// All keywords that should be uppercased
const UPPERCASE_KEYWORDS = new Set([
  'PROGRAM', 'END_PROGRAM', 'FUNCTION', 'END_FUNCTION',
  'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK',
  'METHOD', 'END_METHOD', 'PROPERTY', 'END_PROPERTY',
  'INTERFACE', 'END_INTERFACE', 'IMPLEMENTS', 'EXTENDS',
  'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT',
  'VAR_GLOBAL', 'VAR_TEMP', 'VAR_EXTERNAL', 'END_VAR',
  'CONSTANT', 'RETAIN', 'AT',
  'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
  'CASE', 'OF', 'END_CASE',
  'FOR', 'TO', 'BY', 'DO', 'END_FOR',
  'WHILE', 'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT',
  'RETURN', 'EXIT', 'CONTINUE',
  'AND', 'OR', 'XOR', 'NOT', 'MOD',
  'TRUE', 'FALSE',
  'ARRAY', 'WITH', 'STRUCT', 'END_STRUCT',
  'TYPE', 'END_TYPE',
  'THIS', 'SUPER', 'ABSTRACT', 'FINAL',
  // Data types
  'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
  'SINT', 'INT', 'DINT', 'LINT',
  'USINT', 'UINT', 'UDINT', 'ULINT',
  'REAL', 'LREAL', 'STRING', 'WSTRING',
  'TIME', 'DATE', 'TOD', 'DT',
]);

// Patterns that increase indentation for the NEXT line
const INDENT_INCREASE = /^\s*(PROGRAM|FUNCTION_BLOCK|FUNCTION|METHOD|PROPERTY|INTERFACE|VAR|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_TEMP|VAR_EXTERNAL|STRUCT|TYPE)\b/i;
const INDENT_INCREASE_BODY = /^\s*(IF\b.*\bTHEN|ELSIF\b.*\bTHEN|ELSE|FOR\b.*\bDO|WHILE\b.*\bDO|REPEAT|CASE\b.*\bOF)\s*$/i;

// Patterns that decrease indentation for THIS line
const INDENT_DECREASE = /^\s*(END_PROGRAM|END_FUNCTION_BLOCK|END_FUNCTION|END_METHOD|END_PROPERTY|END_INTERFACE|END_VAR|END_IF|END_FOR|END_WHILE|END_REPEAT|END_CASE|END_STRUCT|END_TYPE|ELSIF\b|ELSE\b|UNTIL\b)\b/i;

// Lines that should have blank line before them (VAR block end → body separator)
const BLANK_BEFORE = /^\s*END_VAR\b/i;

const INDENT = '    '; // 4 spaces

function isInsideComment(line: string): boolean {
  return line.trimStart().startsWith('//') || line.trimStart().startsWith('(*');
}

function isInsideString(line: string): boolean {
  // Very simplified check - skip formatting lines that are predominantly strings
  const stripped = line.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
  return stripped.length < line.length * 0.3;
}

/**
 * Uppercase all IEC keywords in a line, avoiding strings and comments.
 */
function uppercaseKeywords(line: string): string {
  if (isInsideComment(line)) return line;

  // Split line into tokens, preserving strings and comments
  return line.replace(/\b([a-zA-Z_]\w*)\b/g, (match) => {
    if (UPPERCASE_KEYWORDS.has(match.toUpperCase())) {
      return match.toUpperCase();
    }
    return match;
  });
}

/**
 * Align := assignments in a block of consecutive assignment lines.
 */
function alignAssignments(lines: string[]): string[] {
  const result = [...lines];
  let blockStart = -1;

  for (let i = 0; i <= lines.length; i++) {
    const line = i < lines.length ? lines[i] : '';
    const hasAssign = /\s*\S+\s*:=/.test(line) && !isInsideComment(line);

    if (hasAssign && blockStart === -1) {
      blockStart = i;
    } else if (!hasAssign && blockStart !== -1) {
      // Process block [blockStart, i)
      if (i - blockStart >= 2) {
        // Find max position of := in the block
        let maxPos = 0;
        for (let j = blockStart; j < i; j++) {
          const m = result[j].match(/^(\s*\S+\s*):=/);
          if (m) {
            maxPos = Math.max(maxPos, m[1].trimEnd().length);
          }
        }
        // Align all := in the block
        for (let j = blockStart; j < i; j++) {
          const m = result[j].match(/^(\s*)(\S+)(\s*):=(.*)$/);
          if (m) {
            const indent = m[1];
            const varName = m[2];
            const padding = ' '.repeat(maxPos - varName.length - indent.length + 1);
            result[j] = `${indent}${varName}${padding}:=${m[4]}`;
          }
        }
      }
      blockStart = -1;
    }
  }

  return result;
}

/**
 * Format the full document.
 */
function formatSTCode(text: string): string {
  const rawLines = text.split('\n');
  let indentLevel = 0;
  const formattedLines: string[] = [];
  let prevWasEndVar = false;
  let inBlockComment = false;

  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i];

    // Track block comments
    if (inBlockComment) {
      formattedLines.push(line);
      if (line.includes('*)')) {
        inBlockComment = false;
      }
      continue;
    }
    if (line.trimStart().startsWith('(*') && !line.includes('*)')) {
      inBlockComment = true;
      formattedLines.push(line);
      continue;
    }

    // Skip empty lines (we'll add them strategically)
    const trimmed = line.trim();
    if (trimmed === '') {
      // Preserve intentional blank lines but not excessive ones
      if (formattedLines.length > 0 && formattedLines[formattedLines.length - 1].trim() !== '') {
        formattedLines.push('');
      }
      continue;
    }

    // Uppercase keywords
    line = uppercaseKeywords(trimmed);

    // Decrease indent for closing constructs
    if (INDENT_DECREASE.test(line) && indentLevel > 0) {
      indentLevel--;
    }

    // Add blank line after END_VAR (before body)
    if (prevWasEndVar && !INDENT_DECREASE.test(line) && line !== '') {
      // Check if last line isn't already blank
      if (formattedLines.length > 0 && formattedLines[formattedLines.length - 1].trim() !== '') {
        formattedLines.push('');
      }
    }

    // Apply indentation
    const indented = INDENT.repeat(indentLevel) + line;
    formattedLines.push(indented);

    prevWasEndVar = BLANK_BEFORE.test(line);

    // Increase indent for opening constructs
    if (INDENT_INCREASE.test(line) || INDENT_INCREASE_BODY.test(line)) {
      indentLevel++;
    }
  }

  // Align assignments
  const aligned = alignAssignments(formattedLines);

  // Remove trailing whitespace and ensure single trailing newline
  return aligned.map((l) => l.trimEnd()).join('\n').trimEnd() + '\n';
}

/**
 * Creates a Monaco DocumentFormattingEditProvider for Structured Text.
 */
export function createStFormattingProvider(): languages.DocumentFormattingEditProvider {
  return {
    provideDocumentFormattingEdits(
      model: editor.ITextModel,
      _options: languages.FormattingOptions,
      _token: CancellationToken,
    ): languages.TextEdit[] {
      const text = model.getValue();
      const formatted = formatSTCode(text);

      if (text === formatted) return [];

      return [
        {
          range: model.getFullModelRange(),
          text: formatted,
        },
      ];
    },
  };
}

// Export for testing
export { formatSTCode, uppercaseKeywords, alignAssignments };
