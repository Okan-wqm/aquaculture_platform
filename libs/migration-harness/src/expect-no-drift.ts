/**
 * expectNoDriftAgainst + toHaveNoDrift Jest matcher — validator contract
 * ============================================================================
 *
 * Mirrors the production `SchemaDriftValidator` in
 * `libs/backend-common/src/database/schema-drift-validator.service.ts` but
 * as a standalone callable for the migration harness — no NestJS runtime
 * dependency, no container lifecycle assumptions.
 *
 * Checks the same 4 drift classes the production validator does:
 *   A. Schema location — entity declares `schema: 'hr'`, DB table lives in 'hr'
 *   B. UUID type — entity `@Column('uuid')`, DB column is uuid (not text/varchar)
 *   C. Nullability — entity `nullable: false`, DB is_nullable === 'NO'
 *   D. Missing column — entity declares column the DB lacks
 *
 * Plan v3 R11 expands the validator to 10 classes. Those land here as
 * Phase 2 ships; Step 5 only implements the 4 production classes so the
 * HR-drift regression (Phase 1 Step 6) reproduces the boot-signal timeout
 * exactly as production observes it.
 *
 * # Usage
 *
 * ```ts
 * import { expectNoDriftAgainst, registerDriftMatcher } from '@platform/migration-harness';
 *
 * registerDriftMatcher(); // once at top of spec file or in jest.setup.ts
 *
 * it('HR migration converges to entity shape', async () => {
 *   await withEphemeralSchema(ctx, async (schema, qr) => {
 *     // ... seed drift + run migration
 *     await expect(
 *       expectNoDriftAgainst({ qr, schema: 'hr' }, HR_ENTITIES)
 *     ).resolves.toHaveNoDrift();
 *   });
 * });
 * ```
 */
import { randomBytes } from 'node:crypto';

import type { DataSourceOptions, EntityMetadata, QueryRunner } from 'typeorm';

export interface DriftReport {
  /** Total violation count across all classes. 0 = clean. */
  readonly totalViolations: number;
  /** Human-readable violation messages, newline-separated on render. */
  readonly violations: readonly string[];
  /** Per-class breakdown — useful for failure messages + metrics. */
  readonly byClass: Readonly<Record<DriftClass, number>>;
}

export type DriftClass =
  | 'schema_location'
  | 'uuid_type'
  | 'nullability'
  | 'missing_column';

/**
 * Scan DB against entity metadata declarations; return a DriftReport
 * enumerating every Class A-D mismatch. Empty report = zero drift.
 *
 * @param ctx.qr     Active QueryRunner. Any open connection against the
 *                   DB under test; search_path should be pinned to the
 *                   target schema OR `ctx.schema` supplied explicitly.
 * @param ctx.schema The schema name the entity declares (e.g. 'hr').
 *                   Used to filter entity_metadatas when the caller's
 *                   entity list spans multiple schemas.
 * @param entities   Entity CLASSES decorated with TypeORM `@Entity()`.
 *                   Harness introspects via a throwaway DataSource
 *                   connected to the same container — 1-2s overhead
 *                   per call.
 */
export async function expectNoDriftAgainst(
  ctx: { qr: QueryRunner; schema: string },
  entities: readonly (new (...args: unknown[]) => object)[],
): Promise<DriftReport> {
  const { DataSource } = await import('typeorm');
  const conn = ctx.qr.connection;

  // Spawn a throwaway DataSource to get EntityMetadata without polluting
  // the main harness DataSource. Uses the same connection options but a
  // unique `name` so TypeORM doesn't complain about duplicate registration.
  const introspector = new DataSource({
    ...(conn.options as DataSourceOptions),
    entities: entities as unknown[],
    synchronize: false,
    name: `drift-introspector-${randomBytes(6).toString('hex')}`,
    logging: false,
  } as DataSourceOptions);
  await introspector.initialize();

  try {
    const owned = introspector.entityMetadatas.filter(
      (m) => m.schema === ctx.schema,
    );
    return await scanDrift(ctx, owned);
  } finally {
    if (introspector.isInitialized) await introspector.destroy();
  }
}

async function scanDrift(
  ctx: { qr: QueryRunner; schema: string },
  entities: readonly EntityMetadata[],
): Promise<DriftReport> {
  const violations: string[] = [];
  const byClass: Record<DriftClass, number> = {
    schema_location: 0,
    uuid_type: 0,
    nullability: 0,
    missing_column: 0,
  };

  for (const entity of entities) {
    const tableName = entity.tableName;

    // Class A — schema location
    const tableRows: Array<{ schemaname: string }> = await ctx.qr.query(
      `SELECT schemaname FROM pg_tables
        WHERE tablename = $1
          AND schemaname NOT LIKE 'tenant\\_%' ESCAPE '\\'
          AND schemaname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY (schemaname = $2) DESC, schemaname
        LIMIT 1`,
      [tableName, ctx.schema],
    );
    const firstRow = tableRows[0];
    if (!firstRow) {
      // Table missing anywhere — could be pre-migration state; skip per
      // production validator semantics (not Class D which is column-level).
      continue;
    }
    if (firstRow.schemaname !== ctx.schema) {
      violations.push(
        `[${tableName}] entity declares schema='${ctx.schema}' but table lives in '${firstRow.schemaname}'`,
      );
      byClass.schema_location++;
      continue;
    }

    // Class B/C/D — column-level checks
    const columnRows: Array<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }> = await ctx.qr.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2`,
      [ctx.schema, tableName],
    );
    const columns = new Map(columnRows.map((r) => [r.column_name, r]));

    for (const column of entity.columns) {
      const dbName = column.databaseName;
      const dbColumn = columns.get(dbName);

      // Class D — missing column
      if (!dbColumn) {
        violations.push(
          `[${ctx.schema}.${tableName}.${dbName}] entity declares column but DB has no such column`,
        );
        byClass.missing_column++;
        continue;
      }

      // Class B — uuid type drift (only type-class the production validator
      // checks; broader type-coercion detection ships with R11 Phase 2)
      const entityType =
        typeof column.type === 'string' ? column.type : '';
      if (entityType === 'uuid' && dbColumn.data_type !== 'uuid') {
        violations.push(
          `[${ctx.schema}.${tableName}.${dbName}] entity declares uuid but DB is ${dbColumn.data_type}`,
        );
        byClass.uuid_type++;
      }

      // Class C — nullability (only catches entity-NOT-NULL / DB-nullable
      // direction; the reverse is safe)
      if (!column.isNullable && dbColumn.is_nullable === 'YES') {
        violations.push(
          `[${ctx.schema}.${tableName}.${dbName}] entity declares NOT NULL but DB column is nullable`,
        );
        byClass.nullability++;
      }
    }
  }

  return {
    totalViolations: violations.length,
    violations,
    byClass,
  };
}

/**
 * Jest matcher — asserts the DriftReport is empty. Failure message
 * renders a per-class breakdown + the first 10 violation strings so
 * the spec output fits in CI log context.
 *
 * Call `registerDriftMatcher()` once per spec file (or globally via
 * jest.setup.ts) before using `expect(...).toHaveNoDrift()`.
 */
export function registerDriftMatcher(): void {
  expect.extend({
    toHaveNoDrift(received: DriftReport) {
      const pass = received.totalViolations === 0;
      if (pass) {
        return {
          pass: true,
          message: () => 'expected DriftReport to have violations, but it was clean',
        };
      }
      const sample = received.violations
        .slice(0, 10)
        .map((v) => `  - ${v}`)
        .join('\n');
      const extra =
        received.violations.length > 10
          ? `\n  ... and ${received.violations.length - 10} more`
          : '';
      const breakdown = Object.entries(received.byClass)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `    ${k}: ${n}`)
        .join('\n');
      return {
        pass: false,
        message: () =>
          `expected DriftReport to be clean, but found ${received.totalViolations} violation(s):\n` +
          `  by class:\n${breakdown}\n` +
          `  first ${Math.min(10, received.violations.length)}:\n${sample}${extra}`,
      };
    },
  });
}

// Augment Jest's Matchers namespace so TypeScript accepts
// `expect(...).toHaveNoDrift()` without @ts-ignore.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toHaveNoDrift(): R;
    }
  }
}
