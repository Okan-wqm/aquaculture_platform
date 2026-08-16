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
 *   I. Per-tenant shape divergence (opt-in via ctx.tenantScan) — tenant_*
 *      schemas diverge from source
 *   J. Encrypted column protection — @EncryptedAtRest requires bytea storage
 *
 * Plan v3 R11 — Class H (data_cast_incompatible) is a semantic check (can
 * we cast existing rows?) and lives in Phase 3.5 backfill primitives,
 * not in the validator contract.
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

import {
  type EncryptedAtRestMetadata,
  compareForeignKeyPresence,
  expectedEntityDbType,
  getEncryptedAtRestMetadata,
  isTenantDeltaAllowed,
  isUuidTypeDrift,
  normalizeInformationSchemaType,
} from '@aquaculture/backend-common/database/drift-inspection';
import type { EntityMetadata, QueryRunner } from 'typeorm';

import { queryRows } from './query-runner';

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
  | 'encrypted_column_protection'
  | 'per_tenant_shape_divergence'
  | 'foreign_key_presence';

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
  ctx: {
    qr: QueryRunner;
    schema: string;
    /**
     * Opt-in Class I (per-tenant shape divergence) check. When true,
     * the harness enumerates `tenant_<uuid16>` schemas and diffs each
     * clone's table shape against the source schema. Defaults false —
     * mirrors production's SCHEMA_DRIFT_TENANT_SCAN_ENABLED opt-in.
     */
    tenantScan?: boolean;
  },
  entities: readonly (new (...args: unknown[]) => object)[],
): Promise<DriftReport> {
  const { DataSource } = await import('typeorm');
  const conn = ctx.qr.connection;

  // Spawn a throwaway DataSource to get EntityMetadata without polluting
  // the main harness DataSource. Uses the same connection options but a
  // unique `name` so TypeORM doesn't complain about duplicate registration.
  const introspector = new DataSource({
    ...conn.options,
    entities: [...entities],
    synchronize: false,
    name: `drift-introspector-${randomBytes(6).toString('hex')}`,
    logging: false,
  });
  await introspector.initialize();

  try {
    const owned = introspector.entityMetadatas.filter((m) => m.schema === ctx.schema);
    return await scanDrift(ctx, owned);
  } finally {
    if (introspector.isInitialized) await introspector.destroy();
  }
}

async function scanDrift(
  ctx: { qr: QueryRunner; schema: string; tenantScan?: boolean },
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
    per_tenant_shape_divergence: 0,
    foreign_key_presence: 0,
  };

  for (const entity of entities) {
    const tableName = entity.tableName;

    // Class A — schema location
    const tableRows = await queryRows<{ schemaname: string }>(
      ctx.qr,
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
    const columnRows = await queryRows<{
      column_name: string;
      data_type: string;
      udt_name: string | null;
      is_nullable: string;
    }>(
      ctx.qr,
      `SELECT column_name, data_type, udt_name, is_nullable
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
    const encryptedProperties: ReadonlyMap<string, EncryptedAtRestMetadata> =
      typeof entity.target === 'function' ? getEncryptedAtRestMetadata(entity.target) : new Map();

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
      const entityType = typeof column.type === 'string' ? column.type : '';

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
      } else if (isUuidTypeDrift(column, dbColumn)) {
        const expected = expectedEntityDbType(column);
        const actual = normalizeInformationSchemaType(dbColumn);
        violations.push(
          `[${ctx.schema}.${tableName}.${dbName}] entity declares ${expected} but DB is ${actual}`,
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
        const declaredLabels = (column.enum as readonly unknown[]).filter(
          (x): x is string => typeof x === 'string',
        );
        if (declaredLabels.length > 0) {
          entityEnumColumns.push({
            dbName,
            typeName:
              typeof column.enumName === 'string' ? column.enumName : `${tableName}_${dbName}_enum`,
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
      const rows = await queryRows<{ type_name: string; label: string }>(
        ctx.qr,
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
    const entityChecks = entity.checks;
    const checkRows = await queryRows<{ conname: string; definition: string }>(
      ctx.qr,
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
      const dbDefs = checkRows.map((r) => `${r.conname}: ${r.definition}`).join(' ; ');
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

    // Class K — foreign_key_presence. This uses the exact same pure decision
    // kernel as production boot validation; only the pg_constraint reader is
    // harness-local. The signal intentionally mirrors the production
    // cardinality contract during the baseline-reset rollout.
    const fkRows = await queryRows<{ conname: string; definition: string }>(
      ctx.qr,
      `SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1
            AND t.relname = $2
            AND c.contype = 'f'`,
      [ctx.schema, tableName],
    );
    const foreignKeyDrift = compareForeignKeyPresence(entity.foreignKeys.length, fkRows.length);
    if (foreignKeyDrift) {
      const dbDefinitions = fkRows
        .map((row) => `${row.conname}: ${row.definition}`)
        .join(' ; ');
      if (foreignKeyDrift.direction === 'missing_in_database') {
        violations.push(
          `[${ctx.schema}.${tableName}] entity declares ${foreignKeyDrift.entityCount} FK(s) but DB has ${foreignKeyDrift.databaseCount} — ${foreignKeyDrift.delta} missing in DB (db-side: ${dbDefinitions}) (foreign_key_presence)`,
        );
      } else {
        violations.push(
          `[${ctx.schema}.${tableName}] DB has ${foreignKeyDrift.databaseCount} foreign-key constraint(s) but entity declares ${foreignKeyDrift.entityCount} — ${foreignKeyDrift.delta} orphaned (db-side: ${dbDefinitions}) (foreign_key_presence)`,
        );
      }
      byClass.foreign_key_presence++;
    }

    // Class E — orphan_column: DB has a column the entity does not
    // declare. Mirrors the production validator's Class E detection.
    // WARN severity per drift-classes.ts — but the harness reports it
    // via byClass.orphan_column so tests can gate on presence.
    const entityColumnNames = new Set(entity.columns.map((c) => c.databaseName));
    for (const dbCol of columnRows) {
      if (!entityColumnNames.has(dbCol.column_name)) {
        violations.push(
          `[${ctx.schema}.${tableName}.${dbCol.column_name}] DB has column but entity does not declare it (orphan_column)`,
        );
        byClass.orphan_column++;
      }
    }
  }

  // Class I — per_tenant_shape_divergence (opt-in). Mirrors production
  // validator's scanPerTenantShapeDivergence: diff every tenant_<uuid16>
  // clone's table shape against the source schema. Gated by
  // ctx.tenantScan to keep the harness fast by default.
  if (ctx.tenantScan) {
    const tenantSchemaRows = await queryRows<{ schema_name: string }>(
      ctx.qr,
      `SELECT schema_name FROM information_schema.schemata
        WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'
        ORDER BY schema_name`,
    );
    const tenantSchemas = tenantSchemaRows.map((r) => r.schema_name);
    if (tenantSchemas.length > 0 && entities.length > 0) {
      const tableNames = Array.from(new Set(entities.map((e) => e.tableName)));
      const schemasToScan = [ctx.schema, ...tenantSchemas];
      const shapeRows = await queryRows<{
        table_schema: string;
        table_name: string;
        column_name: string;
        data_type: string;
        udt_name: string | null;
        is_nullable: string;
      }>(
        ctx.qr,
        `SELECT table_schema, table_name, column_name, data_type, udt_name, is_nullable
           FROM information_schema.columns
          WHERE table_schema = ANY($1::text[])
            AND table_name = ANY($2::text[])`,
        [schemasToScan, tableNames],
      );
      const shapesBySchemaTable = new Map<string, Map<string, string>>();
      for (const row of shapeRows) {
        const key = `${row.table_schema}.${row.table_name}`;
        const shape = shapesBySchemaTable.get(key) ?? new Map<string, string>();
        shape.set(row.column_name, `${normalizeInformationSchemaType(row)}|${row.is_nullable}`);
        shapesBySchemaTable.set(key, shape);
      }
      for (const entity of entities) {
        const sourceKey = `${ctx.schema}.${entity.tableName}`;
        const sourceShape = shapesBySchemaTable.get(sourceKey);
        if (!sourceShape) continue;
        for (const tenant of tenantSchemas) {
          const tenantKey = `${tenant}.${entity.tableName}`;
          const tenantShape = shapesBySchemaTable.get(tenantKey);
          if (!tenantShape) {
            violations.push(
              `[${tenant}.${entity.tableName}] tenant schema missing table that source '${ctx.schema}' declares (per_tenant_shape_divergence)`,
            );
            byClass.per_tenant_shape_divergence++;
            continue;
          }
          const diffs: string[] = [];
          for (const [col, sourceSig] of sourceShape) {
            const tenantSig = tenantShape.get(col);
            if (tenantSig === undefined) {
              diffs.push(`missing col '${col}'`);
            } else if (tenantSig !== sourceSig) {
              diffs.push(`col '${col}' source=${sourceSig} vs tenant=${tenantSig}`);
            }
          }
          // Extra-on-tenant columns — honor @AllowTenantDelta per
          // production validator semantics (R24).
          const entityCtor = typeof entity.target === 'function' ? entity.target : undefined;
          for (const [col] of tenantShape) {
            if (!sourceShape.has(col)) {
              if (entityCtor !== undefined && isTenantDeltaAllowed(entityCtor, col)) {
                continue;
              }
              diffs.push(`extra col '${col}'`);
            }
          }
          if (diffs.length > 0) {
            violations.push(
              `[${tenant}.${entity.tableName}] shape diverges from source '${ctx.schema}.${entity.tableName}' — ${diffs.slice(0, 5).join(' ; ')}${diffs.length > 5 ? ` (+${diffs.length - 5} more)` : ''} (per_tenant_shape_divergence)`,
            );
            byClass.per_tenant_shape_divergence++;
          }
        }
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
