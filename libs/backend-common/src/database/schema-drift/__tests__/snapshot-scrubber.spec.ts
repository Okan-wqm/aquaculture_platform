import { defined } from '@aquaculture/testing';

import type { SchemaSnapshot } from '../pg-catalog-introspector';
import { DEFAULT_PII_COLUMN_NAMES, scrubSnapshot } from '../snapshot-scrubber';

function snap(overrides: Partial<SchemaSnapshot> = {}): SchemaSnapshot {
  return {
    schema: 'hr',
    tables: [],
    enums: [],
    checkConstraints: [],
    partialIndexes: [],
    excludeConstraints: [],
    foreignKeyActions: [],
    generatedColumns: [],
    hypertables: [],
    rlsPolicies: [],
    capturedAt: '2026-04-21T10:00:00.000Z',
    ...overrides,
  };
}

function tableAt(snapshot: SchemaSnapshot, index = 0): SchemaSnapshot['tables'][number] {
  return defined(snapshot.tables[index], `Expected table ${index}`);
}

function columnAt(
  snapshot: SchemaSnapshot,
  columnIndex: number,
  tableIndex = 0,
): SchemaSnapshot['tables'][number]['columns'][number] {
  return defined(
    tableAt(snapshot, tableIndex).columns[columnIndex],
    `Expected column ${columnIndex}`,
  );
}

function checkAt(snapshot: SchemaSnapshot, index = 0): SchemaSnapshot['checkConstraints'][number] {
  return defined(snapshot.checkConstraints[index], `Expected check constraint ${index}`);
}

describe('scrubSnapshot', () => {
  it('redacts a column whose name matches the PII deny-list', () => {
    const input = snap({
      tables: [
        {
          schema: 'hr',
          name: 'employees',
          columns: [
            {
              name: 'id',
              dataType: 'uuid',
              isNullable: 'NO',
              characterMaximumLength: null,
              ordinalPosition: 1,
              columnDefault: null,
            },
            {
              name: 'national_id',
              dataType: 'text',
              isNullable: 'NO',
              characterMaximumLength: null,
              ordinalPosition: 2,
              columnDefault: null,
            },
          ],
        },
      ],
    });
    const out = scrubSnapshot(input);
    expect(out.redactedColumnCount).toBe(1);
    expect(columnAt(out, 0).name).toBe('id');
    expect(columnAt(out, 1).name).toMatch(/^<REDACTED_PII:[a-f0-9]{10}>$/);
    // data_type + nullability preserved (shape matters for diff).
    expect(columnAt(out, 1).dataType).toBe('text');
    expect(columnAt(out, 1).isNullable).toBe('NO');
  });

  it('applies the allowlist to skip legitimate matches', () => {
    const input = snap({
      tables: [
        {
          schema: 'hr',
          name: 'internal',
          columns: [
            {
              name: 'id_number',
              dataType: 'integer',
              isNullable: 'NO',
              characterMaximumLength: null,
              ordinalPosition: 1,
              columnDefault: null,
            },
          ],
        },
      ],
    });
    const out = scrubSnapshot(input, {
      allowlist: new Set(['id_number']),
    });
    expect(out.redactedColumnCount).toBe(0);
    expect(columnAt(out, 0).name).toBe('id_number');
  });

  it('redacts CHECK constraint literals but keeps predicate structure', () => {
    const input = snap({
      checkConstraints: [
        {
          schema: 'hr',
          tableName: 't',
          name: 'chk_status_whitelist',
          definition: `(status IN ('active', 'archived', 'O''Brien'))`,
        },
      ],
    });
    const out = scrubSnapshot(input);
    expect(out.redactedCheckLiteralCount).toBe(1);
    expect(checkAt(out).definition).toBe(
      `(status IN ('<REDACTED_LITERAL>', '<REDACTED_LITERAL>', '<REDACTED_LITERAL>'))`,
    );
  });

  it('preserves CHECK constraints with no string literals', () => {
    const input = snap({
      checkConstraints: [
        {
          schema: 'hr',
          tableName: 't',
          name: 'chk_positive_amount',
          definition: '(amount > 0)',
        },
      ],
    });
    const out = scrubSnapshot(input);
    expect(out.redactedCheckLiteralCount).toBe(0);
    expect(checkAt(out).definition).toBe('(amount > 0)');
  });

  it('keeps function-call column defaults intact', () => {
    const input = snap({
      tables: [
        {
          schema: 'hr',
          name: 't',
          columns: [
            {
              name: 'id',
              dataType: 'uuid',
              isNullable: 'NO',
              characterMaximumLength: null,
              ordinalPosition: 1,
              columnDefault: 'gen_random_uuid()',
            },
            {
              name: 'created_at',
              dataType: 'timestamptz',
              isNullable: 'NO',
              characterMaximumLength: null,
              ordinalPosition: 2,
              columnDefault: 'CURRENT_TIMESTAMP',
            },
          ],
        },
      ],
    });
    const out = scrubSnapshot(input);
    expect(columnAt(out, 0).columnDefault).toBe('gen_random_uuid()');
    expect(columnAt(out, 1).columnDefault).toBe('CURRENT_TIMESTAMP');
  });

  it('keeps numeric and boolean defaults intact', () => {
    const input = snap({
      tables: [
        {
          schema: 'hr',
          name: 't',
          columns: [
            {
              name: 'score',
              dataType: 'integer',
              isNullable: 'YES',
              characterMaximumLength: null,
              ordinalPosition: 1,
              columnDefault: '42',
            },
            {
              name: 'is_active',
              dataType: 'boolean',
              isNullable: 'NO',
              characterMaximumLength: null,
              ordinalPosition: 2,
              columnDefault: 'true',
            },
          ],
        },
      ],
    });
    const out = scrubSnapshot(input);
    expect(columnAt(out, 0).columnDefault).toBe('42');
    expect(columnAt(out, 1).columnDefault).toBe('true');
  });

  it('redacts string-literal defaults', () => {
    const input = snap({
      tables: [
        {
          schema: 'hr',
          name: 't',
          columns: [
            {
              name: 'status',
              dataType: 'text',
              isNullable: 'NO',
              characterMaximumLength: null,
              ordinalPosition: 1,
              columnDefault: "'pending'::text",
            },
          ],
        },
      ],
    });
    const out = scrubSnapshot(input);
    expect(columnAt(out, 0).columnDefault).toBe('<REDACTED_DEFAULT>');
  });

  it('is deterministic — same input produces byte-identical output', () => {
    const input = snap({
      tables: [
        {
          schema: 'hr',
          name: 'employees',
          columns: [
            {
              name: 'national_id',
              dataType: 'text',
              isNullable: 'NO',
              characterMaximumLength: null,
              ordinalPosition: 1,
              columnDefault: null,
            },
          ],
        },
      ],
    });
    const a = scrubSnapshot(input);
    const b = scrubSnapshot(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('DEFAULT_PII_COLUMN_NAMES includes key KVKK + GDPR terms', () => {
    expect(DEFAULT_PII_COLUMN_NAMES.has('national_id')).toBe(true);
    expect(DEFAULT_PII_COLUMN_NAMES.has('tc_kimlik')).toBe(true);
    expect(DEFAULT_PII_COLUMN_NAMES.has('iban')).toBe(true);
    expect(DEFAULT_PII_COLUMN_NAMES.has('credit_card_number')).toBe(true);
    expect(DEFAULT_PII_COLUMN_NAMES.has('email')).toBe(true);
  });

  it('empty snapshot → empty redaction counts, no errors', () => {
    const out = scrubSnapshot(snap());
    expect(out.redactedColumnCount).toBe(0);
    expect(out.redactedCheckLiteralCount).toBe(0);
  });

  it('custom piiColumnNames overrides the default deny-list', () => {
    const input = snap({
      tables: [
        {
          schema: 'hr',
          name: 't',
          columns: [
            {
              name: 'national_id', // in DEFAULT list
              dataType: 'text',
              isNullable: 'NO',
              characterMaximumLength: null,
              ordinalPosition: 1,
              columnDefault: null,
            },
            {
              name: 'secret_field',
              dataType: 'text',
              isNullable: 'NO',
              characterMaximumLength: null,
              ordinalPosition: 2,
              columnDefault: null,
            },
          ],
        },
      ],
    });
    const out = scrubSnapshot(input, {
      piiColumnNames: new Set(['secret_field']),
    });
    // Custom deny-list replaces default, so national_id is now NOT redacted.
    expect(columnAt(out, 0).name).toBe('national_id');
    expect(columnAt(out, 1).name).toMatch(/^<REDACTED_PII:/);
  });
});
