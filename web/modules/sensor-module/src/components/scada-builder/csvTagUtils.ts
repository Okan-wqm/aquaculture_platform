/**
 * CSV tag import/export helpers for CsvTagDialog.
 *
 * Parser: a record-accumulating state machine over the WHOLE text —
 * quoted fields may contain commas, escaped quotes (""), CRLF and even
 * newlines inside quotes. Replaces the old split('\n') + per-line parser
 * which corrupted any quoted field containing a newline.
 *
 * Export hardening: formula prefixes (=, +, -, @, TAB) are neutralized
 * per OWASP CSV injection guidance before writing.
 *
 * Import hard caps are enforced BEFORE parsing (see IMPORT_LIMITS).
 */

import { isTagRef } from '@platform/sensor-contracts';

/* ------------------------------------------------------------------ */
/*  Import limits (checked BEFORE parsing — reject, never truncate)    */
/* ------------------------------------------------------------------ */

export const IMPORT_LIMITS = {
  /** Max accepted file size. */
  maxBytes: 2 * 1024 * 1024, // 2 MB
  /** Max accepted data rows (excluding the header). */
  maxRows: 5000,
  /** Max characters per field. */
  maxFieldLength: 200,
  /** Columns accepted in the header (anything else is rejected). */
  headerWhitelist: ['widgetId', 'widgetType', 'tagName', 'label'] as const,
} as const;

/* ------------------------------------------------------------------ */
/*  CSV formula-injection neutralization (export)                      */
/* ------------------------------------------------------------------ */

/**
 * Neutralize spreadsheet formula prefixes per OWASP "CSV Injection"
 * guidance: a field starting with =, +, -, @ or TAB is prefixed with a
 * single quote so Excel/Sheets renders it as text instead of evaluating it.
 */
export function neutralizeFormula(value: string): string {
  if (value.length === 0) return value;
  const first = value.charCodeAt(0);
  // '=' 61, '+' 43, '-' 45, '@' 64, TAB 9
  if (first === 61 || first === 43 || first === 45 || first === 64 || first === 9) {
    return `'${value}`;
  }
  return value;
}

/** Escape a field for CSV output (wrap in quotes if it contains comma, quote, newline). */
export function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/*  Record-accumulating state machine parser                           */
/* ------------------------------------------------------------------ */

export type CsvParseResult =
  | { ok: true; records: string[][] }
  | { ok: false; error: string };

/**
 * Parse complete CSV text into records.
 * Handles: BOM, CRLF + LF + CR line endings, quoted fields containing
 * commas/newlines, escaped quotes (""), and a possibly-unterminated final
 * quoted field. Empty trailing lines produce NO record.
 */
export function parseCsv(text: string): CsvParseResult {
  // Strip UTF-8 BOM
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let fieldWasQuoted = false;
  let i = 0;

  const pushField = () => {
    record.push(field);
    field = '';
    fieldWasQuoted = false;
  };
  const pushRecord = () => {
    // A completely blank line (no fields accumulated, nothing in the
    // current field, not even quotes) is not a record.
    if (record.length === 0 && field === '' && !fieldWasQuoted) {
      return;
    }
    pushField();
    records.push(record);
    record = [];
  };

  while (i < src.length) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      fieldWasQuoted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRecord();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // CRLF or bare CR both terminate a record
      pushRecord();
      i += src[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  // Final field/record (file not ending in a line break)
  if (inQuotes) {
    return { ok: false, error: 'Malformed CSV: unterminated quoted field' };
  }
  if (field !== '' || record.length > 0) {
    pushRecord();
  }

  return { ok: true, records };
}

/* ------------------------------------------------------------------ */
/*  Header + limit validation                                          */
/* ------------------------------------------------------------------ */

export interface ImportValidation {
  ok: boolean;
  error?: string;
  header: string[];
  dataRows: string[][];
}

/**
 * Validate parsed records against the hard caps and the header whitelist.
 * Rejects (does NOT truncate) oversized input with a clear error.
 */
export function validateImport(records: string[][], limits = IMPORT_LIMITS): ImportValidation {
  if (records.length < 2) {
    return { ok: false, error: 'CSV must have a header row and at least one data row.', header: [], dataRows: [] };
  }

  const header = records[0];
  const required = ['widgetId', 'tagName'];
  for (const col of required) {
    if (!header.includes(col)) {
      return { ok: false, error: `CSV must have "widgetId" and "tagName" columns.`, header, dataRows: [] };
    }
  }
  const unknown = header.filter((col) => !(limits.headerWhitelist as readonly string[]).includes(col));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `Unknown column(s): ${unknown.join(', ')}. Allowed: ${limits.headerWhitelist.join(', ')}.`,
      header,
      dataRows: [],
    };
  }

  const dataRows = records.slice(1);
  if (dataRows.length > limits.maxRows) {
    return {
      ok: false,
      error: `CSV has ${dataRows.length} data rows; the import limit is ${limits.maxRows}.`,
      header,
      dataRows: [],
    };
  }

  for (let r = 0; r < dataRows.length; r++) {
    for (let c = 0; c < dataRows[r].length; c++) {
      if (dataRows[r][c].length > limits.maxFieldLength) {
        return {
          ok: false,
          error: `Field at row ${r + 1} column ${c + 1} exceeds ${limits.maxFieldLength} characters.`,
          header,
          dataRows: [],
        };
      }
    }
  }

  return { ok: true, header, dataRows };
}

/** Pre-parse size gate (checked on the File before reading). */
export function validateFileSize(bytes: number, limits = IMPORT_LIMITS): string | null {
  if (bytes > limits.maxBytes) {
    return `File is ${(bytes / 1024 / 1024).toFixed(1)} MB; the import limit is ${limits.maxBytes / 1024 / 1024} MB.`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Tag binding write helpers                                          */
/* ------------------------------------------------------------------ */

/**
 * Build the widget config patch for an imported tag value: canonical
 * TagRef-shaped values go to config.tagRef, plain local names to
 * config.tagName. Returns the patch merged over the existing config.
 */
export function buildTagConfigPatch(
  existingConfig: Record<string, unknown>,
  tagValue: string,
  label?: string,
): Record<string, unknown> {
  const patch: Record<string, unknown> = isTagRef(tagValue)
    ? { tagRef: tagValue }
    : { tagName: tagValue };
  if (label !== undefined && label !== '') {
    patch.label = label;
  }
  return { ...existingConfig, ...patch };
}

/** Strip a leading neutralization apostrophe (round-trip on import). */
export function stripFormulaNeutralizer(value: string): string {
  return value.startsWith("'") && value.length > 1 ? value.slice(1) : value;
}
