/**
 * INVARIANT — tenant erasure is declared per table and complete
 * (ADMIN-CRITICAL-009).
 *
 * The kernel executor used to decide which tables to erase by asking
 * `information_schema.columns` for a `tenantId` column; a table whose tenant
 * rows hang off a parent was skipped, a ledger that carried the column was
 * deleted, and no test could say either had happened. Now every
 * source-schema erasure target declares a policy for EVERY table its
 * MODULE_SCHEMAS entry registers: `tenant-column`, `cascade-via` or
 * `excluded`-with-reason. This spec keeps that true from source, without a
 * database:
 *
 *   1. every source-schema target's policy set has no problems against the
 *      registry (complete, no unregistered tables, cascades resolve, no
 *      cycles, outbox and proof ledger excluded);
 *   2. every `tenant-column` and `cascade-via` column the policy names exists
 *      on the table's entity or in the migration that creates the table;
 *   3. the executor no longer sniffs tenant-looking columns anywhere.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  requiredColumns,
  tenantErasurePolicyProblems,
} from '../../libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-table-policy';
import { TENANT_ERASURE_TARGET_OPTIONS_BY_SERVICE } from '../../libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-target-registry';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

/** `git grep -l`; exit status 1 means "no match". */
function gitGrepFiles(pattern: string, pathspecs: string[]): string[] {
  try {
    return execFileSync(
      'git',
      ['-C', REPO_ROOT, 'grep', '-l', '--untracked', '-E', pattern, '--', ...pathspecs],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
  } catch (err: unknown) {
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

const SOURCE_ROOTS = ['apps', 'libs/backend-common/src'];

/**
 * Whether `schema.table` has `column` according to source: the entity class
 * declares a property of that name (or a `name:` mapping to it), or a
 * migration creates the table with that column.
 */
function columnDeclaredInSource(schema: string, table: string, column: string): boolean {
  const entityFiles = gitGrepFiles(
    `@Entity\\('${table}',[[:space:]]*\\{[^}]*schema:[[:space:]]*'${schema}'`,
    SOURCE_ROOTS,
  ).filter((f) => !/(^|\/)(\.archive|dist)\//.test(f));
  for (const file of entityFiles) {
    const src = read(file);
    const start = src.indexOf(`@Entity('${table}'`);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    if (new RegExp(`\\b${column}[!?]?:`).test(body) || body.includes(`name: '${column}'`))
      return true;
  }
  const migrationFiles = gitGrepFiles(
    `CREATE TABLE( IF NOT EXISTS)? "?${schema}"?\\."?${table}"?`,
    ['apps'],
  ).filter((f) => /\/migrations\//.test(f) && !/\.archive\//.test(f));
  for (const file of migrationFiles) {
    const src = read(file);
    const start = src.search(
      new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? "?${schema}"?\\."?${table}"?`),
    );
    const block = src.slice(start, src.indexOf(')', src.indexOf(')', start) + 1) + 400);
    if (block.includes(`"${column}"`) || new RegExp(`\\b${column}\\b`).test(block)) return true;
  }
  return false;
}

describe('INVARIANT (ADMIN-CRITICAL-009): tenant erasure is declared per table and complete', () => {
  const sourceSchemaTargets = Object.values(TENANT_ERASURE_TARGET_OPTIONS_BY_SERVICE).filter(
    (options) => options.mode === 'source-schema-tenant-column',
  );

  it('covers every source-schema target (sanity)', () => {
    expect(sourceSchemaTargets.map((t) => t.targetService).sort()).toEqual([
      'admin-api-service',
      'billing-service',
      'config-service',
      'event-store-service',
      'notification-service',
    ]);
  });

  for (const options of sourceSchemaTargets) {
    if (options.mode !== 'source-schema-tenant-column') continue;

    it(`${options.targetService}: the policy set is complete against MODULE_SCHEMAS`, () => {
      expect(
        tenantErasurePolicyProblems(options.moduleName, options.tables, [
          options.outbox.table,
          options.proofLedger.table,
        ]),
      ).toEqual([]);
    });

    it(`${options.targetService}: every column the policy names is declared in source`, () => {
      const missing = requiredColumns(options.tables)
        .filter((entry) => !columnDeclaredInSource(options.sourceSchema, entry.table, entry.column))
        .map((entry) => `${options.sourceSchema}.${entry.table}.${entry.column}`);
      expect([...new Set(missing)]).toEqual([]);
    });

    it(`${options.targetService}: every exclusion states a reason`, () => {
      const unreasoned = Object.entries(options.tables)
        .filter(([, policy]) => policy.kind === 'excluded' && policy.reason.trim().length < 20)
        .map(([table]) => table);
      expect(unreasoned).toEqual([]);
    });
  }

  it('the executor derives nothing from tenant-looking column names', () => {
    const executor = read(
      'libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-target-executor.ts',
    );
    expect(executor).not.toMatch(/column_name IN \('tenantId'/);
    expect(executor).not.toMatch(/excludedTables/);
    expect(executor).toMatch(/tenantErasurePolicyProblems\(/);
    expect(executor).toMatch(/tenantRowPredicate\(/);
  });
});
