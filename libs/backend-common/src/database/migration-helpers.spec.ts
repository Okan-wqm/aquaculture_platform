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
 *   5. columnType is a closed vocabulary (or a validated enum name), so
 *      the added column is always NULLABLE — no NOT NULL / DEFAULT /
 *      REFERENCES / `;` can ride in.
 *   6. A per-tenant table may not be pinned to a tenant-aware source
 *      schema; only MODULE_SCHEMAS infrastructureTables take one.
 *   7. CONCURRENTLY is refused inside an open transaction.
 */

class RecordingQueryRunner {
  readonly statements: string[] = [];
  constructor(readonly isTransactionActive = false) {}
  readonly parameters: unknown[][] = [];

  query(statement: string, parameters?: unknown[]): Promise<unknown[]> {
    // Not async on purpose: no await inside, and @typescript-eslint/
    // require-await fires on an async method without one.
    this.statements.push(statement);
    this.parameters.push(parameters ?? []);
    return Promise.resolve([]);
  }
}

function runner(isTransactionActive = false): RecordingQueryRunner {
  // The helpers take SqlStatementRunner (query + isTransactionActive), so
  // the recorder satisfies it structurally — no cast, per the
  // banned-construct gate.
  return new RecordingQueryRunner(isTransactionActive);
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

describe('addColumnWithIndex column type vocabulary', () => {
  const base = { table: 't', column: 'c', indexName: 'IDX_t_c' };

  it.each([
    'uuid',
    'text',
    'boolean',
    'smallint',
    'integer',
    'bigint',
    'date',
    'timestamptz',
    'jsonb',
    'numeric(12,3)',
    'numeric(12, 3)',
    'character varying(255)',
    'char(2)',
    'uuid[]',
    'text[]',
  ])('accepts %s', async (columnType) => {
    const qr = runner();
    await addColumnWithIndex(qr, { ...base, columnType });
    expect(qr.statements[0]).toBe(`ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "c" ${columnType}`);
  });

  it.each([
    'uuid NOT NULL',
    "text DEFAULT 'x'",
    'uuid REFERENCES "users"("id")',
    'text; DROP TABLE users',
    'integer NOT NULL DEFAULT 0',
    'serial',
    'TEXT',
    'varchar',
    'numeric',
    '',
  ])('refuses %j before issuing any SQL', async (columnType) => {
    const qr = runner();
    await expect(addColumnWithIndex(qr, { ...base, columnType })).rejects.toThrow(/vocabulary/);
    expect(qr.statements).toEqual([]);
  });

  it('takes an enum type by validated, quoted, unqualified name', async () => {
    const qr = runner();
    await addColumnWithIndex(qr, { ...base, columnType: { enumType: 'labor_category_enum' } });
    expect(qr.statements[0]).toBe(
      'ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "c" "labor_category_enum"',
    );
  });

  it('refuses a hostile enum name before issuing any SQL', async () => {
    const qr = runner();
    await expect(
      addColumnWithIndex(qr, { ...base, columnType: { enumType: 'e" NOT NULL; --' } }),
    ).rejects.toThrow();
    expect(qr.statements).toEqual([]);
  });
});

describe('addColumnWithIndex schema placement', () => {
  it('refuses to pin a per-tenant table to its tenant-aware source schema', async () => {
    const qr = runner();
    await expect(
      addColumnWithIndex(qr, {
        table: 'equipment',
        column: 'temperatureSensorId',
        columnType: 'uuid',
        indexName: 'IDX_equipment_temperatureSensorId',
        schema: 'farm',
      }),
    ).rejects.toThrow(/per-tenant table/);
    expect(qr.statements).toEqual([]);
  });

  it('qualifies a cross-tenant infrastructure table of a tenant-aware schema', async () => {
    const qr = runner();
    await addColumnWithIndex(qr, {
      table: 'farm_outbox',
      column: 'claimedAt',
      columnType: 'timestamptz',
      indexName: 'IDX_farm_outbox_claimedAt',
      schema: 'farm',
    });
    expect(qr.statements[0]).toBe(
      'ALTER TABLE "farm"."farm_outbox" ADD COLUMN IF NOT EXISTS "claimedAt" timestamptz',
    );
  });

  it('refuses the same per-tenant pin on the drop side', async () => {
    const qr = runner();
    await expect(
      dropColumnWithIndex(qr, {
        table: 'equipment',
        column: 'temperatureSensorId',
        indexName: 'IDX_equipment_temperatureSensorId',
        schema: 'farm',
      }),
    ).rejects.toThrow(/per-tenant table/);
    expect(qr.statements).toEqual([]);
  });
});

describe('addColumnWithIndex concurrently', () => {
  const options = {
    table: 'sensor_readings',
    column: 'qualityFlag',
    columnType: 'smallint',
    indexName: 'IDX_sensor_readings_qualityFlag',
    concurrently: true,
  };

  it('builds the index CONCURRENTLY outside a transaction', async () => {
    const qr = runner(false);
    await addColumnWithIndex(qr, options);
    expect(qr.statements[1]).toBe(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_sensor_readings_qualityFlag" ON "sensor_readings" ("qualityFlag")',
    );
  });

  it('refuses CONCURRENTLY inside an open transaction before issuing any SQL', async () => {
    const qr = runner(true);
    await expect(addColumnWithIndex(qr, options)).rejects.toThrow(/transaction/);
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
