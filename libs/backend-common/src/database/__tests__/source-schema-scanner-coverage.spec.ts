import { MODULE_SCHEMAS } from '../schema-manager.service';
import {
  SchemaQueryExecutor,
  SourceSchemaScanner,
  WatchdogViolation,
} from '../watchdog/source-schema-scanner';

/**
 * Regression suite for the production incident of 2026-08-15.
 *
 * `farm-service` runs this scanner every ten minutes against EVERY entry in
 * MODULE_SCHEMAS, but connects as the `farm_service` role, which by design has
 * no grants on its siblings' schemas. Postgres refused ~1600 statements per
 * scan cycle — and the scanner's catch-all treated every failure as "table not
 * created yet", returned zero violations, and the run was recorded as clean.
 *
 * A safety mechanism that reports success for the schemas it could not read is
 * worse than one that is switched off, because the report is believed. These
 * tests pin the distinction the code now makes.
 */

type QueryHandler = (sql: string, params?: unknown[]) => Promise<unknown>;

function dataSourceWith(handler: QueryHandler): SchemaQueryExecutor {
  return {
    query<T>(sql: string, parameters?: unknown[]): Promise<T> {
      return handler(sql, parameters) as Promise<T>;
    },
  };
}

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Index access under `noUncheckedIndexedAccess`, without a cast or a `!`. */
function first<T>(items: T[]): T {
  const [head] = items;
  if (head === undefined) throw new Error('expected at least one element');
  return head;
}

const FIRST_SCHEMA = first(MODULE_SCHEMAS).sourceSchema;

function privilegeAnswer(readable: boolean): unknown {
  return [{ readable }];
}

describe('SourceSchemaScanner coverage honesty', () => {
  it('reports a schema it may not read instead of counting it as clean', async () => {
    const scanner = new SourceSchemaScanner(
      dataSourceWith((sql) => {
        if (sql.includes('has_schema_privilege')) return Promise.resolve(privilegeAnswer(false));
        throw pgError('42501', 'permission denied for schema');
      }),
    );

    const violations = await scanner.scan();

    // One per module schema: the scan learned nothing about any of them.
    expect(violations).toHaveLength(MODULE_SCHEMAS.length);
    expect(violations.every((v: WatchdogViolation) => v.type === 'UNVERIFIABLE_SCHEMA')).toBe(true);
    expect(first(violations).severity).toBe('HIGH');
    expect(first(violations).details).toContain('no USAGE privilege');
    // The whole point: silence must not be available as an outcome.
    expect(violations).not.toHaveLength(0);
  });

  it('does not fire a doomed query per table when the schema is unreadable', async () => {
    // The storm, not just the blindness: one refusal per schema, not one per
    // table, is what kept the production postgres log at ~1600 error lines a
    // cycle. The privilege pre-check is what bounds it.
    const statements: string[] = [];
    const scanner = new SourceSchemaScanner(
      dataSourceWith((sql) => {
        statements.push(sql);
        if (sql.includes('has_schema_privilege')) return Promise.resolve(privilegeAnswer(false));
        throw pgError('42501', 'permission denied for schema');
      }),
    );

    await scanner.scan();

    expect(statements).toHaveLength(MODULE_SCHEMAS.length);
    expect(statements.every((s) => s.includes('has_schema_privilege'))).toBe(true);
    expect(statements.some((s) => s.includes('COUNT(*)'))).toBe(false);
  });

  it('still treats a missing table as benign, which is what the old catch was for', async () => {
    const scanner = new SourceSchemaScanner(
      dataSourceWith((sql) => {
        if (sql.includes('has_schema_privilege')) return Promise.resolve(privilegeAnswer(true));
        throw pgError('42P01', 'relation does not exist');
      }),
    );

    await expect(scanner.scan()).resolves.toEqual([]);
  });

  it('reports a table-level refusal even when the schema itself is readable', async () => {
    // A table-scoped REVOKE is rarer than a schema-scoped one, and it is
    // exactly the case a schema-level pre-check alone would let through.
    let firstCall = true;
    const scanner = new SourceSchemaScanner(
      dataSourceWith((sql) => {
        if (sql.includes('has_schema_privilege')) return Promise.resolve(privilegeAnswer(true));
        if (firstCall) {
          firstCall = false;
          throw pgError('42501', 'permission denied for table');
        }
        return Promise.resolve([{ cnt: '0' }]);
      }),
    );

    const violations = await scanner.scan();

    const unverifiable = violations.filter((v) => v.type === 'UNVERIFIABLE_SCHEMA');
    expect(unverifiable).toHaveLength(1);
    expect(first(unverifiable).table).not.toBe('*');
    expect(first(unverifiable).schema).toBe(FIRST_SCHEMA);
  });

  it('surfaces an unknown driver failure rather than swallowing it', async () => {
    const scanner = new SourceSchemaScanner(
      dataSourceWith((sql) => {
        if (sql.includes('has_schema_privilege')) return Promise.resolve(privilegeAnswer(true));
        throw new Error('connection terminated unexpectedly');
      }),
    );

    const violations = await scanner.scan();

    expect(violations.length).toBeGreaterThan(0);
    expect(first(violations).type).toBe('UNVERIFIABLE_SCHEMA');
    expect(first(violations).details).toContain('connection terminated unexpectedly');
  });

  it('still reports real contamination when the schema is readable', async () => {
    // The fix must not cost the scanner its original job.
    const scanner = new SourceSchemaScanner(
      dataSourceWith((sql) => {
        if (sql.includes('has_schema_privilege')) return Promise.resolve(privilegeAnswer(true));
        return Promise.resolve([{ cnt: '3' }]);
      }),
    );

    const violations = await scanner.scan();

    expect(violations.length).toBeGreaterThan(0);
    expect(first(violations).type).toBe('SOURCE_CONTAMINATION');
    expect(first(violations).severity).toBe('CRITICAL');
    expect(first(violations).rowCount).toBe(3);
  });
});
