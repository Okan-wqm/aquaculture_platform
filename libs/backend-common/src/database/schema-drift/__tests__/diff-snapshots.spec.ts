import {
  diffSnapshots,
  partitionBySeverity,
  type SnapshotChange,
} from '../diff-snapshots';
import type { SchemaSnapshot } from '../pg-catalog-introspector';

function snap(overrides: Partial<SchemaSnapshot> = {}): SchemaSnapshot {
  return {
    schema: 'hr',
    tables: [],
    enums: [],
    checkConstraints: [],
    capturedAt: '2026-04-21T09:00:00.000Z',
    ...overrides,
  };
}

describe('diffSnapshots', () => {
  it('empty vs empty → no changes', () => {
    expect(diffSnapshots(snap(), snap())).toEqual([]);
  });

  it('throws when comparing different schemas', () => {
    expect(() =>
      diffSnapshots(snap({ schema: 'hr' }), snap({ schema: 'farm' })),
    ).toThrow(/different schemas/);
  });

  it('detects table_added (expand)', () => {
    const after = snap({
      tables: [
        {
          schema: 'hr',
          name: 'employees',
          columns: [],
        },
      ],
    });
    const diff = diffSnapshots(snap(), after);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({
      kind: 'table_added',
      severity: 'expand',
      subject: 'hr.employees',
    });
  });

  it('detects table_removed (breaking)', () => {
    const before = snap({
      tables: [{ schema: 'hr', name: 'legacy', columns: [] }],
    });
    const diff = diffSnapshots(before, snap());
    expect(diff[0]).toMatchObject({
      kind: 'table_removed',
      severity: 'breaking',
      subject: 'hr.legacy',
    });
  });

  it('detects column_added + column_removed across same table', () => {
    const before = snap({
      tables: [
        {
          schema: 'hr',
          name: 'e',
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
              name: 'legacy_flag',
              dataType: 'boolean',
              isNullable: 'YES',
              characterMaximumLength: null,
              ordinalPosition: 2,
              columnDefault: null,
            },
          ],
        },
      ],
    });
    const after = snap({
      tables: [
        {
          schema: 'hr',
          name: 'e',
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
              name: 'preferred_name',
              dataType: 'text',
              isNullable: 'YES',
              characterMaximumLength: null,
              ordinalPosition: 2,
              columnDefault: null,
            },
          ],
        },
      ],
    });
    const kinds = diffSnapshots(before, after).map((c) => c.kind);
    expect(kinds).toContain('column_added');
    expect(kinds).toContain('column_removed');
  });

  it('column_type_changed is breaking', () => {
    const before = snap({
      tables: [
        {
          schema: 'hr',
          name: 't',
          columns: [
            {
              name: 'x',
              dataType: 'text',
              isNullable: 'YES',
              characterMaximumLength: null,
              ordinalPosition: 1,
              columnDefault: null,
            },
          ],
        },
      ],
    });
    const after = snap({
      tables: [
        {
          schema: 'hr',
          name: 't',
          columns: [
            {
              name: 'x',
              dataType: 'uuid',
              isNullable: 'YES',
              characterMaximumLength: null,
              ordinalPosition: 1,
              columnDefault: null,
            },
          ],
        },
      ],
    });
    const diff = diffSnapshots(before, after);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({
      kind: 'column_type_changed',
      severity: 'breaking',
      details: { before: 'text', after: 'uuid' },
    });
  });

  it('NULL → NOT NULL tightening is breaking; NOT NULL → NULL loosening is expand', () => {
    const col = (isNullable: 'YES' | 'NO'): Parameters<typeof snap>[0] => ({
      tables: [
        {
          schema: 'hr',
          name: 't',
          columns: [
            {
              name: 'x',
              dataType: 'text',
              isNullable,
              characterMaximumLength: null,
              ordinalPosition: 1,
              columnDefault: null,
            },
          ],
        },
      ],
    });
    const tighten = diffSnapshots(snap(col('YES')), snap(col('NO')));
    expect(tighten[0]?.severity).toBe('breaking');

    const loosen = diffSnapshots(snap(col('NO')), snap(col('YES')));
    expect(loosen[0]?.severity).toBe('expand');
  });

  it('enum_labels_added is expand, enum_labels_removed is breaking', () => {
    const e = (labels: string[]): Parameters<typeof snap>[0] => ({
      enums: [{ schema: 'hr', name: 's', labels }],
    });
    const diffAdd = diffSnapshots(
      snap(e(['a', 'b'])),
      snap(e(['a', 'b', 'c'])),
    );
    expect(diffAdd).toHaveLength(1);
    expect(diffAdd[0]).toMatchObject({
      kind: 'enum_labels_added',
      severity: 'expand',
      details: { added: ['c'] },
    });
    const diffRemove = diffSnapshots(
      snap(e(['a', 'b', 'c'])),
      snap(e(['a', 'b'])),
    );
    expect(diffRemove[0]).toMatchObject({
      kind: 'enum_labels_removed',
      severity: 'breaking',
      details: { removed: ['c'] },
    });
  });

  it('check_added is breaking (rows may violate), check_removed is expand', () => {
    const c = (defs: Array<{ name: string; def: string }>): Parameters<typeof snap>[0] => ({
      checkConstraints: defs.map((d) => ({
        name: d.name,
        schema: 'hr',
        tableName: 't',
        definition: d.def,
      })),
    });
    const diffAdd = diffSnapshots(
      snap(c([])),
      snap(c([{ name: 'chk_x', def: 'x > 0' }])),
    );
    expect(diffAdd[0]).toMatchObject({
      kind: 'check_added',
      severity: 'breaking',
    });
    const diffRemove = diffSnapshots(
      snap(c([{ name: 'chk_x', def: 'x > 0' }])),
      snap(c([])),
    );
    expect(diffRemove[0]).toMatchObject({
      kind: 'check_removed',
      severity: 'expand',
    });
  });

  it('column_default_changed is neutral', () => {
    const col = (def: string | null): Parameters<typeof snap>[0] => ({
      tables: [
        {
          schema: 'hr',
          name: 't',
          columns: [
            {
              name: 'x',
              dataType: 'text',
              isNullable: 'YES',
              characterMaximumLength: null,
              ordinalPosition: 1,
              columnDefault: def,
            },
          ],
        },
      ],
    });
    const diff = diffSnapshots(snap(col("'old'")), snap(col("'new'")));
    expect(diff[0]).toMatchObject({
      kind: 'column_default_changed',
      severity: 'neutral',
    });
  });

  it('partitionBySeverity buckets changes correctly', () => {
    const changes: SnapshotChange[] = [
      { kind: 'table_added', severity: 'expand', subject: 'x' },
      { kind: 'column_removed', severity: 'breaking', subject: 'y' },
      { kind: 'column_default_changed', severity: 'neutral', subject: 'z' },
      { kind: 'enum_labels_added', severity: 'expand', subject: 'w' },
    ];
    const parts = partitionBySeverity(changes);
    expect(parts.breaking).toHaveLength(1);
    expect(parts.expand).toHaveLength(2);
    expect(parts.neutral).toHaveLength(1);
  });

  it('diff is deterministic for the same input pair', () => {
    const before = snap({
      tables: [
        {
          schema: 'hr',
          name: 'a',
          columns: [
            {
              name: 'x',
              dataType: 'text',
              isNullable: 'YES',
              characterMaximumLength: null,
              ordinalPosition: 1,
              columnDefault: null,
            },
          ],
        },
      ],
    });
    const after = snap();
    const d1 = diffSnapshots(before, after);
    const d2 = diffSnapshots(before, after);
    expect(JSON.stringify(d1)).toBe(JSON.stringify(d2));
  });
});
