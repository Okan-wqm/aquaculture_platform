/**
 * CSV tag import/export utility tests.
 *
 * Property-based-style edge cases (no fast-check dependency — exhaustive
 * hand-rolled generators): quoted newlines, escaped quotes, CRLF, BOM,
 * empty trailing lines, formula cells, hard caps, and the
 * export→import round-trip through the real parse/validate/patch pipeline.
 */

import { describe, it, expect } from 'vitest';
import {
  escapeCsvField,
  neutralizeFormula,
  parseCsv,
  validateImport,
  validateFileSize,
  buildTagConfigPatch,
  stripFormulaNeutralizer,
  IMPORT_LIMITS,
} from '../csvTagUtils';

/* ================================================================== */
/*  Parser — record-accumulating state machine                         */
/* ================================================================== */

describe('parseCsv', () => {
  it('parses simple comma-separated records', () => {
    const r = parseCsv('a,b,c\n1,2,3');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.records).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('parses quoted fields containing commas', () => {
    const r = parseCsv('"a,b",c\n"x,y",z');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.records[0]).toEqual(['a,b', 'c']);
  });

  it('parses quoted fields containing embedded NEWLINES', () => {
    const r = parseCsv('header1,header2\n"line1\nline2",second');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.records).toHaveLength(2);
      expect(r.records[1][0]).toBe('line1\nline2');
      expect(r.records[1][1]).toBe('second');
    }
  });

  it('unescapes doubled quotes inside quoted fields', () => {
    const r = parseCsv('"say ""hi""",plain');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.records[0][0]).toBe('say "hi"');
  });

  it('handles CRLF and bare CR line endings', () => {
    const crlf = parseCsv('a,b\r\n1,2');
    const cr = parseCsv('a,b\r1,2');
    expect(crlf.ok && cr.ok).toBe(true);
    if (crlf.ok) expect(crlf.records).toEqual([['a', 'b'], ['1', '2']]);
    if (cr.ok) expect(cr.records).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('strips a UTF-8 BOM from the start of the text', () => {
    const r = parseCsv('\ufeffwidgetId,tagName\nw1,temp');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.records[0][0]).toBe('widgetId');
  });

  it('ignores empty trailing lines', () => {
    const r = parseCsv('a,b\n1,2\n\n\n');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.records).toHaveLength(2);
  });

  it('keeps a quoted empty field as a record', () => {
    const r = parseCsv('""\n');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.records).toEqual([['']]);
  });

  it('keeps the trailing empty field after a final delimiter', () => {
    const r = parseCsv('a,b,\n');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.records[0]).toEqual(['a', 'b', '']);
  });

  it('rejects an unterminated quoted field', () => {
    const r = parseCsv('a,"unterminated');
    expect(r.ok).toBe(false);
  });

  it('parses the final record when the file does not end with a newline', () => {
    const r = parseCsv('h1,h2\nv1,v2');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.records).toHaveLength(2);
  });
});

/* ================================================================== */
/*  Formula neutralization (OWASP CSV injection)                       */
/* ================================================================== */

describe('neutralizeFormula', () => {
  const cases: Array<[string, string]> = [
    ['=SUM(A1:A9)', "'=SUM(A1:A9)"],
    ['+1+1', "'+1+1"],
    ['-1', "'-1"],
    ['@cmd', "'@cmd"],
    ['\tTAB', "'\tTAB"],
    ['plain', 'plain'],
    ['', ''],
    ['a=b', 'a=b'], // only a LEADING = is dangerous
    ['1+1', '1+1'],
  ];
  for (const [input, expected] of cases) {
    it(`neutralizes ${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(neutralizeFormula(input)).toBe(expected);
    });
  }

  it('round-trips through stripFormulaNeutralizer', () => {
    const value = '=SUM(A1)';
    expect(stripFormulaNeutralizer(neutralizeFormula(value))).toBe(value);
    expect(stripFormulaNeutralizer('plain')).toBe('plain');
  });
});

/* ================================================================== */
/*  Hard caps (before parsing — reject, never truncate)                */
/* ================================================================== */

describe('validateImport', () => {
  const header = ['widgetId', 'widgetType', 'tagName', 'label'];

  it('accepts a valid document', () => {
    const r = validateImport([header, ['w1', 'gauge', 'temp', 'T']]);
    expect(r.ok).toBe(true);
  });

  it('rejects a missing header/data row', () => {
    expect(validateImport([header]).ok).toBe(false);
    expect(validateImport([]).ok).toBe(false);
  });

  it('rejects missing required columns', () => {
    const r = validateImport([['widgetId', 'label'], ['w1', 'x']]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('widgetId');
  });

  it('rejects unknown columns (header whitelist)', () => {
    const r = validateImport([['widgetId', 'tagName', 'evil'], ['w1', 't', 'x']]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('evil');
  });

  it('REJECTS (not truncates) more than 5000 data rows', () => {
    const rows = [header, ...Array.from({ length: IMPORT_LIMITS.maxRows + 1 }, () => ['w', 'g', 't', 'l'])];
    const r = validateImport(rows);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('5000');
  });

  it('rejects fields longer than 200 characters', () => {
    const long = 'x'.repeat(IMPORT_LIMITS.maxFieldLength + 1);
    const r = validateImport([header, ['w1', 'gauge', long, 'T']]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('200');
  });

  it('rejects files over 2 MB before parsing', () => {
    const err = validateFileSize(3 * 1024 * 1024);
    expect(err).toContain('MB');
    expect(validateFileSize(1024)).toBeNull();
  });
});

/* ================================================================== */
/*  TagRef-aware config patch                                          */
/* ================================================================== */

describe('buildTagConfigPatch', () => {
  it('writes config.tagRef for canonical TagRef values', () => {
    const patch = buildTagConfigPatch({ label: 'T' }, 'EDGE-AB12/tank1.do');
    expect(patch.tagRef).toBe('EDGE-AB12/tank1.do');
    expect(patch.tagName).toBeUndefined();
    expect(patch.label).toBe('T');
  });

  it('writes config.tagName for plain local names', () => {
    const patch = buildTagConfigPatch({}, 'tank1.do');
    expect(patch.tagName).toBe('tank1.do');
    expect(patch.tagRef).toBeUndefined();
  });

  it('merges over the existing config without dropping keys', () => {
    const patch = buildTagConfigPatch({ min: 0, max: 10 }, 'ph');
    expect(patch.min).toBe(0);
    expect(patch.max).toBe(10);
    expect(patch.tagName).toBe('ph');
  });
});

/* ================================================================== */
/*  Export → import round-trip                                         */
/* ================================================================== */

describe('CSV export → import round-trip', () => {
  const CSV_HEADER = 'widgetId,widgetType,tagName,label';

  function buildExportCsv(rows: Array<{ id: string; type: string; tag: string; label: string }>): string {
    return [
      CSV_HEADER,
      ...rows.map((r) =>
        [
          escapeCsvField(neutralizeFormula(r.id)),
          escapeCsvField(neutralizeFormula(r.type)),
          escapeCsvField(neutralizeFormula(r.tag)),
          escapeCsvField(neutralizeFormula(r.label)),
        ].join(','),
      ),
    ].join('\n');
  }

  it('round-trips plain rows', () => {
    const csv = buildExportCsv([{ id: 'w-1', type: 'gauge', tag: 'ph', label: 'pH' }]);
    const parsed = parseCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const validation = validateImport(parsed.records);
    expect(validation.ok).toBe(true);
    expect(validation.dataRows[0]).toEqual(['w-1', 'gauge', 'ph', 'pH']);
  });

  it('round-trips cells containing commas and quotes through escaping', () => {
    const csv = buildExportCsv([{ id: 'w,1', type: 'a"b', tag: 't', label: 'L' }]);
    const parsed = parseCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const validation = validateImport(parsed.records);
    expect(validation.ok).toBe(true);
    expect(validation.dataRows[0][0]).toBe('w,1');
    expect(validation.dataRows[0][1]).toBe('a"b');
  });

  it('round-trips formula-prefixed cells via neutralizer + strip', () => {
    const csv = buildExportCsv([{ id: '=DANGER()', type: 'gauge', tag: 't', label: 'L' }]);
    const parsed = parseCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const validation = validateImport(parsed.records);
    expect(validation.ok).toBe(true);
    // The neutralizer escaped the leading '=' — import strips it back
    expect(stripFormulaNeutralizer(validation.dataRows[0][0])).toBe('=DANGER()');
  });
});
