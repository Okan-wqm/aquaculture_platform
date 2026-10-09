import { addColumnWithIndex, dropColumnWithIndex } from './migration-helpers';

/**
 * migration-helpers.spec.ts
 * ============================================================================
 *
 * DEBT-2026-05-07-001 — the shared add-column-then-index helper the
 * debt record demanded. Every service migration used to inline the
 * idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` +
 * `CREATE INDEX IF NOT EXISTS` boilerplate verbatim, so the pattern
 * multiplied across services and silently absorbed maintenance cost.
 *
 * Coverage targets:
 *   1. One call emits exactly two statements — the guarded ADD COLUMN
 *      and the guarded CREATE INDEX — with validated, quoted
 *      identifiers (validateSqlIdentifier rejects before any SQL).
 *   2. Unqualified by default (search_path/current_schema routing for
 *      per-tenant fan-out); an explicit `schema` qualifies both
 *      statements for cross-tenant infrastructure tables.
 *   3. indexColumns defaults to the added column; multi-column order
 *      is preserved.
 *   4. The down counterpart mirrors the pair (DROP INDEX IF EXISTS +
 *      DROP COLUMN IF EXISTS) with the same qualification rules.
 */

class RecordingQueryRunner {
  readonly statements: string[] = [];
  readonly parameters: unknown[][] = [];

  query(statement: string, parameters?: unknown[]): Promise<unknown[]> {
    // Not async on purpose: no await inside, and @typescript-eslint/
    // require-await fires on an async method without one.
    this.statements.push(statement);
    this.parameters.push(parameters ?? []);
    return Promise.resolve([]);
  }
}

function runner(): RecordingQueryRunner {
  // The helpers take Pick<QueryRunner, 'query'>, so the recorder
  // satisfies them structurally — no cast, per the banned-construct gate.
  return new RecordingQueryRunner();
}

describe('addColumnWithIndex', () => {
  it('emits the guarded column+index pair with quoted identifiers', async () => {
    const qr = runner();
    await addColumnWithIndex(qr, {
      table: 'equipment',
      column: 'temperatureSensorId',
      columnType: 'uuid',
      indexName: 'IDX_equipment_temperatureSensorId',
    });
    expect(qr.statements).toEqual([
      'ALTER TABLE "equipment" ADD COLUMN IF NOT EXISTS "temperatureSensorId" uuid',
      'CREATE INDEX IF NOT EXISTS "IDX_equipment_temperatureSensorId" ON "equipment" ("temperatureSensorId")',
    ]);
  });

  it('qualifies both statements when a schema is given', async () => {
    const qr = runner();
    await addColumnWithIndex(qr, {
      table: 'tenant_provisioning_runs',
      column: 'leaseUntil',
      columnType: 'timestamptz',
      indexName: 'IDX_tenant_provisioning_runs_leaseUntil',
      schema: 'admin',
    });
    expect(qr.statements[0]).toBe(
      'ALTER TABLE "admin"."tenant_provisioning_runs" ADD COLUMN IF NOT EXISTS "leaseUntil" timestamptz',
    );
    expect(qr.statements[1]).toBe(
      'CREATE INDEX IF NOT EXISTS "IDX_tenant_provisioning_runs_leaseUntil" ON "admin"."tenant_provisioning_runs" ("leaseUntil")',
    );
  });

  it('defaults the index to the added column and preserves multi-column order', async () => {
    const qr = runner();
    await addColumnWithIndex(qr, {
      table: 't',
      column: 'laborCategory',
      columnType: 'text',
      indexName: 'IDX_t_labor',
      indexColumns: ['tenantId', 'laborCategory'],
    });
    expect(qr.statements[1]).toBe(
      'CREATE INDEX IF NOT EXISTS "IDX_t_labor" ON "t" ("tenantId", "laborCategory")',
    );
  });

  it('rejects a hostile identifier before issuing any SQL', async () => {
    const qr = runner();
    await expect(
      addColumnWithIndex(qr, {
        table: 't; DROP TABLE users; --',
        column: 'c',
        columnType: 'text',
        indexName: 'IDX_t_c',
      }),
    ).rejects.toThrow();
    expect(qr.statements).toEqual([]);
  });
});

describe('dropColumnWithIndex', () => {
  it('mirrors the pair: guarded DROP INDEX then guarded DROP COLUMN', async () => {
    const qr = runner();
    await dropColumnWithIndex(qr, {
      table: 'equipment',
      column: 'temperatureSensorId',
      indexName: 'IDX_equipment_temperatureSensorId',
    });
    expect(qr.statements).toEqual([
      'DROP INDEX IF EXISTS "IDX_equipment_temperatureSensorId"',
      'ALTER TABLE "equipment" DROP COLUMN IF EXISTS "temperatureSensorId"',
    ]);
  });

  it('qualifies the drop pair when a schema is given', async () => {
    const qr = runner();
    await dropColumnWithIndex(qr, {
      table: 'tenant_provisioning_runs',
      column: 'leaseUntil',
      indexName: 'IDX_tenant_provisioning_runs_leaseUntil',
      schema: 'admin',
    });
    expect(qr.statements[0]).toBe(
      'DROP INDEX IF EXISTS "admin"."IDX_tenant_provisioning_runs_leaseUntil"',
    );
    expect(qr.statements[1]).toBe(
      'ALTER TABLE "admin"."tenant_provisioning_runs" DROP COLUMN IF EXISTS "leaseUntil"',
    );
  });
});
