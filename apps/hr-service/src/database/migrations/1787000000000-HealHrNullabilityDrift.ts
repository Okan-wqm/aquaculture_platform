import { Logger } from '@nestjs/common';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * HealHrNullabilityDrift
 * ============================================================================
 *
 * Second-phase heal for the hr schema. HealHrEnumTypeDrift1786900000000
 * applied 65 validator-relevant queries (CREATE TYPE, CREATE TABLE,
 * ADD COLUMN IF NOT EXISTS, ALTER COLUMN <any sub-action>) emitted by
 * `driver.createSchemaBuilder().log()` and resolved the enum-type drift.
 * Deploy d943f605 confirmed that migration runs green (DROPped
 * IDX_emp_cert_expiry partial index + leave_no_overlap EXCLUDE
 * constraint, applied 65 heal queries across source hr + 5 tenant
 * clones, exit 0).
 *
 * But the deploy's `[hr-service] "Schema drift scan clean"` boot signal
 * still never emits, because `SchemaDriftValidator` finds residual
 * drift after the first-phase heal. Three classes of drift:
 *
 *   1. **Schema location** — log() already emits CREATE TABLE in the
 *      correct schema; first-phase heal covers this.
 *
 *   2. **UUID-type mismatch** — validator flags
 *      `entity.type === 'uuid' && dbColumn.data_type !== 'uuid'`
 *      (schema-drift-validator.service.ts:237). First-phase heal
 *      applies ALTER COLUMN TYPE when log() emits it, which covers
 *      straightforward uuid mismatches — but log() does not always
 *      emit it for pre-existing columns that TypeORM's diff compares
 *      field-by-field; better to assert explicitly via entity metadata.
 *
 *   3. **Nullability drift** — validator flags
 *      `!column.isNullable && dbColumn.is_nullable === 'YES'`
 *      (schema-drift-validator.service.ts:247). First-phase heal
 *      emits `ADD COLUMN IF NOT EXISTS "<col>" type NOT NULL ...` but
 *      when the column ALREADY EXISTS (IF NOT EXISTS → no-op) the
 *      existing DB column's nullability is NEVER updated. TypeORM
 *      `log()` does not emit a standalone `ALTER COLUMN SET NOT NULL`
 *      for this diff class; the first-phase heal's debug dump confirms
 *      no such statements in the 65 queries.
 *
 * This migration closes both class (2) and class (3) deterministically
 * by iterating the hr entity metadata and issuing exactly the DDL the
 * validator's contract requires.
 *
 * # Scope — matches validator contract exactly
 *
 * `SchemaDriftValidator.validateSchema()` (schema-drift-validator.service.ts
 * lines 74–134) checks violations in this order per owned entity:
 *
 *   a) schema location (line 195)        — covered by first-phase heal
 *   b) missing column (line 213–229)     — covered by first-phase heal
 *   c) uuid type mismatch (line 237)     — **THIS MIGRATION (class 2)**
 *   d) nullability mismatch (line 247)   — **THIS MIGRATION (class 3)**
 *
 * No other drift classes are checked. So: applying explicit SET NOT NULL
 * for every entity-declared-non-nullable column + explicit ALTER COLUMN
 * TYPE uuid for every entity-declared-uuid column brings DB state to
 * `violations.length === 0` post-boot → validator emits literal
 * "Schema drift scan clean" → boot signal asserter's substring match
 * succeeds within round 1–5 of the 30-round window.
 *
 * # Why not just run log() again and apply more queries
 *
 * TypeORM's `log()` inside a migration transaction observes the DB
 * AFTER the migration's own DDL commits. For nullability-only drift
 * of pre-existing columns, log() historically does not emit a
 * standalone `ALTER COLUMN SET NOT NULL` — it rolls the nullability
 * into a holistic column-redeclaration that the first-phase heal's
 * `isValidatorRelevant` whitelist cannot safely apply (re-declaring
 * the column requires dropping and recreating, which loses data).
 * Entity-metadata iteration sidesteps log() entirely: we know exactly
 * what the entity declares, and we emit the minimal DDL to align the DB.
 *
 * # Empty-table precondition
 *
 * SET NOT NULL fails if the column has any NULL rows. The first-phase
 * heal already required empty tables; this migration preserves the
 * same invariant because non-empty tables are not safe for this class
 * of DDL either.
 *
 * # Down — no-op
 *
 * "Rolling back" nullability alignment would re-introduce the drift
 * the validator rejects, breaking hr-service boot on the next cold
 * start. Operators who need the pre-heal shape restore from the
 * pre-deploy pg_dump backup (canonical DDL recovery path).
 */
export class HealHrNullabilityDrift1787000000000 implements MigrationInterface {
  private readonly logger = new Logger('HealHrNullabilityDrift1787000000000');

  /** Tenant-schema identifier regex — rejects anything outside the canonical pattern. */
  private static readonly SAFE_TENANT_SCHEMA = /^tenant_[a-f0-9]{16}$/;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const conn = queryRunner.connection;

    const hrEntities = conn.entityMetadatas.filter((m) => m.schema === 'hr');
    if (hrEntities.length === 0) {
      // Non-entity-aware runner path — orchestrator loads hr entities
      // before invoking this migration; a throw here would break
      // non-aqua-db-migrate invocations that have no use for this heal.
      this.logger.warn(
        'HealHrNullabilityDrift: no entities with schema=\'hr\' on connection — skipping (likely non-entity-aware runner).',
      );
      return;
    }

    this.logger.log(
      `Found ${hrEntities.length} hr-scoped entities for nullability+uuid heal: ${hrEntities
        .map((m) => m.tableName)
        .join(', ')}`,
    );

    // Empty-table precondition — SET NOT NULL fails if any column has
    // NULL rows; TYPE uuid USING fails if any value is non-castable. We
    // require empty tables for both, which also preserves the invariant
    // from HealHrEnumTypeDrift.
    for (const meta of hrEntities) {
      const exists: Array<{ count: string }> = await conn.query(
        `SELECT COUNT(*)::text AS count FROM information_schema.tables
         WHERE table_schema = 'hr' AND table_name = $1 AND table_type = 'BASE TABLE'`,
        [meta.tableName],
      );
      if (Number(exists[0]?.count ?? '0') === 0) continue;
      const rowCountRows: Array<{ count: string }> = await conn.query(
        `SELECT COUNT(*)::text AS count FROM hr."${meta.tableName}"`,
      );
      const rowCount = Number(rowCountRows[0]?.count ?? '0');
      if (rowCount > 0) {
        throw new Error(
          `HealHrNullabilityDrift: hr."${meta.tableName}" has ${rowCount} row(s) — refusing to run. ` +
            `This heal applies SET NOT NULL + TYPE uuid which require empty tables. ` +
            `Operator must write data-preserving per-column ALTER scripts manually for non-empty hr tables.`,
        );
      }
    }

    // Apply the heal to source hr + every tenant clone.
    await this.healSchema(queryRunner, 'hr', hrEntities);

    const tenantRows: Array<{ schema_name: string }> = await conn.query(`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name LIKE 'tenant\\_%' ESCAPE '\\'
      ORDER BY schema_name
    `);
    const tenantSchemas = tenantRows
      .map((r) => r.schema_name)
      .filter((s) =>
        HealHrNullabilityDrift1787000000000.SAFE_TENANT_SCHEMA.test(s),
      );

    if (tenantSchemas.length === 0) {
      this.logger.log('No tenant clones found — propagation step is a no-op.');
      return;
    }

    this.logger.log(
      `Propagating nullability+uuid heal to ${tenantSchemas.length} tenant clone(s): ${tenantSchemas.join(', ')}`,
    );

    for (const tenantSchema of tenantSchemas) {
      // Empty-table guard per-tenant (same as source).
      let tenantHasData = false;
      for (const meta of hrEntities) {
        const tableExists: Array<{ count: string }> = await conn.query(
          `SELECT COUNT(*)::text AS count FROM information_schema.tables
           WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`,
          [tenantSchema, meta.tableName],
        );
        if (Number(tableExists[0]?.count ?? '0') === 0) continue;
        const rc: Array<{ count: string }> = await conn.query(
          `SELECT COUNT(*)::text AS count FROM "${tenantSchema}"."${meta.tableName}"`,
        );
        if (Number(rc[0]?.count ?? '0') > 0) {
          tenantHasData = true;
          break;
        }
      }
      if (tenantHasData) {
        this.logger.warn(
          `[${tenantSchema}] has data in at least one hr table — skipping heal. ` +
            `Operator must apply per-column ALTER scripts manually for this tenant.`,
        );
        continue;
      }

      await this.healSchema(queryRunner, tenantSchema, hrEntities);
    }
  }

  /**
   * Per-schema heal: iterate entity metadata, compare to
   * `information_schema.columns`, emit explicit SET NOT NULL and
   * ALTER COLUMN TYPE uuid statements for exactly the mismatches
   * the validator checks.
   */
  private async healSchema(
    queryRunner: QueryRunner,
    schema: string,
    hrEntities: readonly import('typeorm').EntityMetadata[],
  ): Promise<void> {
    const conn = queryRunner.connection;
    let nullabilityFixed = 0;
    let uuidTypeFixed = 0;
    let tablesSkipped = 0;
    const firstSamples: string[] = [];

    for (const meta of hrEntities) {
      // Skip tables that don't exist in this schema yet (tenant clone
      // that's missing a newly-added entity table — first-phase heal
      // already logged/created such tables, but we defend anyway).
      const tableExists: Array<{ count: string }> = await conn.query(
        `SELECT COUNT(*)::text AS count FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`,
        [schema, meta.tableName],
      );
      if (Number(tableExists[0]?.count ?? '0') === 0) {
        tablesSkipped++;
        continue;
      }

      for (const col of meta.columns) {
        // `generated` and virtual-only columns don't map to physical
        // DB columns — skip the ones the validator also skips (see
        // schema-drift-validator.service.ts:212-214).
        if (col.isVirtual) continue;

        const dbRows: Array<{
          is_nullable: 'YES' | 'NO';
          data_type: string;
          udt_name: string;
        }> = await conn.query(
          `SELECT is_nullable, data_type, udt_name
             FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
          [schema, meta.tableName, col.databaseName],
        );

        const dbCol = dbRows[0];
        if (!dbCol) {
          // Column missing in DB — that's the first-phase heal's
          // ADD COLUMN job; not in scope for this migration.
          continue;
        }

        // Class 2 — uuid-type drift. Validator contract:
        //   entity.type === 'uuid' && dbColumn.data_type !== 'uuid'
        // Cast path: text → uuid is safe if all rows are empty or
        // valid uuid strings. Empty-table precondition guarantees the
        // former.
        if (col.type === 'uuid' && dbCol.data_type !== 'uuid') {
          await queryRunner.query(
            `ALTER TABLE "${schema}"."${meta.tableName}" ` +
              `ALTER COLUMN "${col.databaseName}" ` +
              `TYPE uuid USING "${col.databaseName}"::text::uuid`,
          );
          uuidTypeFixed++;
          if (firstSamples.length < 5) {
            firstSamples.push(
              `uuid:${meta.tableName}.${col.databaseName}(was=${dbCol.data_type})`,
            );
          }
        }

        // Class 3 — nullability drift. Validator contract:
        //   !column.isNullable && dbColumn.is_nullable === 'YES'
        if (!col.isNullable && dbCol.is_nullable === 'YES') {
          await queryRunner.query(
            `ALTER TABLE "${schema}"."${meta.tableName}" ` +
              `ALTER COLUMN "${col.databaseName}" SET NOT NULL`,
          );
          nullabilityFixed++;
          if (firstSamples.length < 5) {
            firstSamples.push(
              `notnull:${meta.tableName}.${col.databaseName}`,
            );
          }
        }
      }
    }

    this.logger.log(
      `[${schema}] validator-contract heal: ` +
        `${nullabilityFixed} SET NOT NULL, ${uuidTypeFixed} TYPE uuid, ` +
        `${tablesSkipped} missing table(s) skipped. ` +
        (firstSamples.length > 0
          ? `First ${firstSamples.length} fixes: ${firstSamples.join(', ')}.`
          : 'Zero drift — schema already aligned.'),
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Intentional no-op — this migration aligns DB state with the
    // entity-declared nullability + uuid-type contract. Rolling back
    // would re-introduce drift the SchemaDriftValidator rejects, which
    // would block hr-service boot on the next cold start. Operators
    // who need the pre-heal shape must restore from the pre-deploy
    // pg_dump backup (canonical DDL recovery path per
    // docs/runbooks/schema-drift-response.md).
  }
}
