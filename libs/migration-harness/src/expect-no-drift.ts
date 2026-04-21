/**
 * expectNoDriftAgainst + toHaveNoDrift Jest matcher — validator contract
 * ============================================================================
 *
 * Mirrors the production `SchemaDriftValidator` in
 * `libs/backend-common/src/database/schema-drift-validator.service.ts` but
 * as a standalone callable for the migration harness — no NestJS runtime
 * dependency, no container lifecycle assumptions.
 *
 * Checks the drift classes the production validator covers (Phase 2):
 *   A. Schema location — entity declares `schema: 'hr'`, DB table lives in 'hr'
 *   B. UUID type — entity `@Column('uuid')`, DB column is uuid (not text/varchar)
 *   C. Nullability — entity `nullable: false`, DB is_nullable === 'NO'
 *   D. Missing column — entity declares column the DB lacks
 *   E. Orphan column — DB has a column the entity does not declare
 *   F. Enum labels — entity enum[] differs from pg_enum labels
 *   G. Check constraint — entity @Check() count diverges from pg_constraint
 *   J. Encrypted column protection — @EncryptedAtRest requires bytea storage
 *
 * Plan v3 R11 expands the validator to 10 classes. H (data_cast_incompatible)
 * and I (per_tenant_shape_divergence) land in subsequent Phase 2 steps.
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

import { getEncryptedAtRestMetadata } from '@aquaculture/backend-common';
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
  | 'missing_column'
  | 'orphan_column'
  | 'enum_labels'
  | 'check_constraint'
  | 'encrypted_column_protection';

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
    orphan_column: 0,
    enum_labels: 0,
    check_constraint: 0,
    encrypted_column_protection: 0,
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

    // Enum columns — collected during the per-column loop, diffed
    // against pg_enum after (Class F). Keeps pg_enum to 1 round-trip
    // per entity instead of N+1.
    const entityEnumColumns: Array<{
      dbName: string;
      typeName: string;
      declaredLabels: readonly string[];
    }> = [];

    // @EncryptedAtRest metadata for this entity (mirrors production
    // Class J semantics).
    const encryptedProperties =
      entity.target && typeof entity.target === 'function'
        ? getEncryptedAtRestMetadata(entity.target as Function)
        : new Map();

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

      // Class J — encrypted_column_protection: DB column must be bytea
      // when property is @EncryptedAtRest. Suppresses Class B + F for
      // decorated columns (ADR-023).
      const encMeta = encryptedProperties.get(column.propertyName);
      const isEncrypted = encMeta !== undefined;
      if (isEncrypted) {
        if (dbColumn.data_type !== 'bytea') {
          violations.push(
            `[${ctx.schema}.${tableName}.${dbName}] column is @EncryptedAtRest(keyId='${encMeta.keyId}', algorithm='${encMeta.algorithm}') but DB type is '${dbColumn.data_type}' — required: bytea (encrypted_column_protection)`,
          );
          byClass.encrypted_column_protection++;
        }
      } else if (entityType === 'uuid' && dbColumn.data_type !== 'uuid') {
        violations.push(
          `[${ctx.schema}.${tableName}.${dbName}] entity declares uuid but DB is ${dbColumn.data_type}`,
        );
        byClass.uuid_type++;
      }

      // Class C — nullability (only catches entity-NOT-NULL / DB-nullable
      // direction; the reverse is safe). Applies regardless of encryption.
      if (!column.isNullable && dbColumn.is_nullable === 'YES') {
        violations.push(
          `[${ctx.schema}.${tableName}.${dbName}] entity declares NOT NULL but DB column is nullable`,
        );
        byClass.nullability++;
      }

      // Class F — enum column collection for batched lookup below.
      // Skipped for encrypted columns (Class J contract).
      if (!isEncrypted && entityType === 'enum' && Array.isArray(column.enum)) {
        const declaredLabels = (column.enum as readonly unknown[])
          .filter((x): x is string => typeof x === 'string');
        if (declaredLabels.length > 0) {
          entityEnumColumns.push({
            dbName,
            typeName:
              typeof column.enumName === 'string'
                ? column.enumName
                : `${tableName}_${dbName}_enum`,
            declaredLabels,
          });
        }
      }
    }

    // Class F — enum_labels: diff entity-declared labels vs pg_enum.
    // Mirrors production validator's Class F detection. WARN severity
    // per drift-classes.ts rollout window (Phase 8 Stage 2 elevates),
    // but the harness reports via byClass.enum_labels so tests can
    // assert drift surface regardless of production severity.
    if (entityEnumColumns.length > 0) {
      const typeNames = entityEnumColumns.map((c) => c.typeName);
      const rows: Array<{ type_name: string; label: string }> =
        await ctx.qr.query(
          `SELECT t.typname AS type_name, e.enumlabel AS label
             FROM pg_type t
             JOIN pg_namespace n ON n.oid = t.typnamespace
             JOIN pg_enum e ON e.enumtypid = t.oid
            WHERE n.nspname = $1
              AND t.typname = ANY($2::text[])
            ORDER BY t.typname, e.enumsortorder`,
          [ctx.schema, typeNames],
        );
      const dbLabelsByType = new Map<string, string[]>();
      for (const row of rows) {
        const list = dbLabelsByType.get(row.type_name) ?? [];
        list.push(row.label);
        dbLabelsByType.set(row.type_name, list);
      }
      for (const col of entityEnumColumns) {
        const dbLabels = dbLabelsByType.get(col.typeName);
        if (!dbLabels) {
          violations.push(
            `[${ctx.schema}.${tableName}.${col.dbName}] entity declares enum type '${col.typeName}' but no such pg_enum exists in schema '${ctx.schema}' (enum_labels)`,
          );
          byClass.enum_labels++;
          continue;
        }
        const dbSet = new Set(dbLabels);
        const declaredSet = new Set(col.declaredLabels);
        const missingInDb = col.declaredLabels.filter((l) => !dbSet.has(l));
        const missingInEntity = dbLabels.filter((l) => !declaredSet.has(l));
        if (missingInDb.length === 0 && missingInEntity.length === 0) continue;
        const parts: string[] = [];
        if (missingInDb.length > 0) {
          parts.push(`entity-only: [${missingInDb.join(', ')}]`);
        }
        if (missingInEntity.length > 0) {
          parts.push(`db-only: [${missingInEntity.join(', ')}]`);
        }
        violations.push(
          `[${ctx.schema}.${tableName}.${col.dbName}] enum '${col.typeName}' label drift — ${parts.join(' | ')} (enum_labels)`,
        );
        byClass.enum_labels++;
      }
    }

    // Class G — check_constraint: count-based drift signal. Mirrors
    // production validator semantics — flags net add/remove between
    // entity @Check() decorators and pg_constraint contype='c' without
    // predicate-text equality (PG canonicalizes ARRAY order + type
    // casts in ways the entity source does not).
    const entityChecks = (entity as unknown as {
      checks?: ReadonlyArray<{ expression: string }>;
    }).checks ?? [];
    const checkRows: Array<{ conname: string; definition: string }> =
      await ctx.qr.query(
        `SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1
            AND t.relname = $2
            AND c.contype = 'c'`,
        [ctx.schema, tableName],
      );
    if (checkRows.length !== entityChecks.length) {
      const entityExprs = entityChecks.map((c) => c.expression.trim()).join(' ; ');
      const dbDefs = checkRows
        .map((r) => `${r.conname}: ${r.definition}`)
        .join(' ; ');
      if (entityChecks.length > checkRows.length) {
        violations.push(
          `[${ctx.schema}.${tableName}] entity declares ${entityChecks.length} @Check() but DB has ${checkRows.length} — ${entityChecks.length - checkRows.length} missing in DB (entity-side: ${entityExprs}) (check_constraint)`,
        );
      } else {
        violations.push(
          `[${ctx.schema}.${tableName}] DB has ${checkRows.length} CHECK but entity declares ${entityChecks.length} — ${checkRows.length - entityChecks.length} orphaned (db-side: ${dbDefs}) (check_constraint)`,
        );
      }
      byClass.check_constraint++;
    }

    // Class E — orphan_column: DB has a column the entity does not
    // declare. Mirrors the production validator's Class E detection.
    // WARN severity per drift-classes.ts — but the harness reports it
    // via byClass.orphan_column so tests can gate on presence.
    const entityColumnNames = new Set(
      entity.columns.map((c) => c.databaseName),
    );
    for (const dbCol of columnRows) {
      if (!entityColumnNames.has(dbCol.column_name)) {
        violations.push(
          `[${ctx.schema}.${tableName}.${dbCol.column_name}] DB has column but entity does not declare it (orphan_column)`,
        );
        byClass.orphan_column++;
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
