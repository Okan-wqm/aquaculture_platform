import { Logger } from '@nestjs/common';
import { MigrationInterface, QueryRunner } from 'typeorm';
import type { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';
import type { EntityMetadata } from 'typeorm/metadata/EntityMetadata';
import {
  dropDependentPartialIndexes,
  parseAlterColumnTypeTargets,
} from '@aquaculture/backend-common/database';
import { listHrOwnedEntities, quoteIdent, quoteQualified, toSnakeCase } from './hr-owned-entities';

/**
 * ReplayHrEntitySurfaceAlignment1789300000000
 * ============================================================================
 *
 * Forward migration for the production state where historical HR entity-driven
 * heal migrations were already marked as applied by db-migrate before that
 * runner loaded HR entity metadata. The migration ledger said "done", but
 * `hr` still carried the legacy physical shape and SchemaDriftValidator blocked
 * hr-service boot.
 *
 * This is deliberately not a bypass:
 *   - db-migrate must load HR entities; otherwise this migration fails before
 *     services start instead of recording another no-op.
 *   - legacy snake_case columns are renamed to the entity-owned camelCase names
 *     before any ADD COLUMN plan runs, preserving data where an old column maps
 *     cleanly to the current entity column.
 *   - non-empty tables with genuinely missing required columns fail with a
 *     clear operator error rather than inventing domain defaults.
 */
export class ReplayHrEntitySurfaceAlignment1789300000000 implements MigrationInterface {
  name = 'ReplayHrEntitySurfaceAlignment1789300000000';

  private readonly logger = new Logger(this.name);

  private static readonly SAFE_TENANT_SCHEMA = /^tenant_[a-f0-9]{16}$/;
  private static readonly UUID_RE =
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const entities = listHrOwnedEntities(queryRunner.connection.entityMetadatas);
    if (entities.length === 0) {
      throw new Error(
        'ReplayHrEntitySurfaceAlignment: no HR entity metadata is loaded. ' +
          'db-migrate must declare entitiesGlob for hr-service before running ' +
          'entity-driven HR alignment migrations.',
      );
    }

    this.logger.log(
      `Loaded ${entities.length} HR-owned entity metadata record(s): ${entities
        .map((m) => m.tableName)
        .join(', ')}`,
    );

    const schemas = await this.listTargetSchemas(queryRunner);
    for (const schema of schemas) {
      await this.renameLegacySnakeCaseColumns(queryRunner, schema, entities);
    }

    await this.assertMissingRequiredColumnsAreSafe(queryRunner, schemas, entities);

    const plan = await this.buildValidatorAlignmentPlan(queryRunner, entities);
    if (plan.length > 0) {
      await this.applyPlan(queryRunner, 'hr', plan);
      for (const schema of schemas.filter((s) => s !== 'hr')) {
        await this.applyPlan(queryRunner, schema, plan);
      }
    } else {
      this.logger.log('SchemaBuilder emitted no validator-relevant HR DDL.');
    }

    await this.healUuidAndNullability(queryRunner, schemas, entities);
  }

  private async listTargetSchemas(queryRunner: QueryRunner): Promise<string[]> {
    const rows: Array<{ schema_name: string }> = await queryRunner.query(`
      SELECT schema_name FROM information_schema.schemata
       WHERE schema_name LIKE 'tenant\\_%' ESCAPE '\\'
       ORDER BY schema_name
    `);
    const tenants = rows
      .map((r) => r.schema_name)
      .filter((s) => ReplayHrEntitySurfaceAlignment1789300000000.SAFE_TENANT_SCHEMA.test(s));
    return ['hr', ...tenants];
  }

  private async renameLegacySnakeCaseColumns(
    queryRunner: QueryRunner,
    schema: string,
    entities: readonly EntityMetadata[],
  ): Promise<void> {
    let renamed = 0;
    const samples: string[] = [];

    for (const entity of entities) {
      if (!(await this.tableExists(queryRunner, schema, entity.tableName))) {
        continue;
      }

      const names = await this.columnNames(queryRunner, schema, entity.tableName);
      for (const column of entity.columns) {
        if (column.isVirtual) continue;
        const target = column.databaseName;
        const legacy = toSnakeCase(target);
        if (legacy === target) continue;
        if (names.has(target) || !names.has(legacy)) continue;

        await queryRunner.query(
          `ALTER TABLE ${quoteQualified(schema, entity.tableName)} ` +
            `RENAME COLUMN ${quoteIdent(legacy)} TO ${quoteIdent(target)}`,
        );
        names.delete(legacy);
        names.add(target);
        renamed++;
        if (samples.length < 8) {
          samples.push(`${schema}.${entity.tableName}.${legacy}->${target}`);
        }
      }
    }

    this.logger.log(
      `[${schema}] legacy snake_case column normalization: ${renamed} rename(s)` +
        (samples.length > 0 ? `; samples: ${samples.join(', ')}` : ''),
    );
  }

  private async assertMissingRequiredColumnsAreSafe(
    queryRunner: QueryRunner,
    schemas: readonly string[],
    entities: readonly EntityMetadata[],
  ): Promise<void> {
    const unsafe: string[] = [];

    for (const schema of schemas) {
      for (const entity of entities) {
        if (!(await this.tableExists(queryRunner, schema, entity.tableName))) {
          continue;
        }
        const rowCount = await this.rowCount(queryRunner, schema, entity.tableName);
        if (rowCount === 0) continue;

        const names = await this.columnNames(queryRunner, schema, entity.tableName);
        for (const column of entity.columns) {
          if (column.isVirtual || column.isNullable) continue;
          if (names.has(column.databaseName)) continue;
          if (this.hasSafeAddDefault(column)) continue;
          unsafe.push(`${schema}.${entity.tableName}.${column.databaseName}`);
        }
      }
    }

    if (unsafe.length > 0) {
      throw new Error(
        'ReplayHrEntitySurfaceAlignment refuses to add required columns to ' +
          'non-empty tables without entity defaults. Write an explicit ' +
          `data-preserving backfill first. Unsafe columns: ${unsafe
            .slice(0, 20)
            .join(', ')}${unsafe.length > 20 ? ` (+${unsafe.length - 20} more)` : ''}`,
      );
    }
  }

  private async buildValidatorAlignmentPlan(
    queryRunner: QueryRunner,
    entities: readonly EntityMetadata[],
  ): Promise<Array<{ query: string; parameters?: unknown[] }>> {
    await queryRunner.connection.query(`
      CREATE TABLE IF NOT EXISTS "hr"."typeorm_metadata" (
        "type" varchar NOT NULL,
        "database" varchar,
        "schema" varchar,
        "table" varchar,
        "name" varchar,
        "value" text
      )
    `);

    await queryRunner.query(`SET LOCAL search_path = "hr", public`);
    const defaults = this.entityDefaultsByTableColumn(entities);
    const sqlInMemory = await queryRunner.connection.driver.createSchemaBuilder().log();

    const sourceQueries = sqlInMemory.upQueries
      .filter((q) => this.referencesOnlyHrOrUnqualified(q.query))
      .filter((q) => this.isValidatorRelevant(q.query))
      .map((q) => ({ ...q, query: this.makeIdempotent(q.query) }))
      .flatMap((q) => this.expandAlterColumnTypeWithDefaultRecovery(q, defaults));

    this.logger.log(
      `SchemaBuilder emitted ${sqlInMemory.upQueries.length} query plan item(s); ` +
        `${sourceQueries.length} validator-relevant HR item(s) retained.`,
    );

    return sourceQueries;
  }

  private async applyPlan(
    queryRunner: QueryRunner,
    schema: string,
    plan: readonly { query: string; parameters?: unknown[] }[],
  ): Promise<void> {
    await queryRunner.query(`SET LOCAL search_path = ${quoteIdent(schema)}, public`);

    const rebased = plan.map((q) => ({
      query: schema === 'hr' ? q.query : q.query.replace(/"hr"\./g, `${quoteIdent(schema)}.`),
      parameters: q.parameters,
    }));

    const alterTargets = parseAlterColumnTypeTargets(
      rebased.map((q) => q.query),
      schema,
    );
    if (alterTargets.length > 0) {
      const dropped = await dropDependentPartialIndexes(queryRunner, alterTargets);
      this.logger.log(
        `[${schema}] pre-flight DROP: ${dropped.length} blocker(s) for ` +
          `${alterTargets.length} ALTER COLUMN TYPE target(s).`,
      );
    }

    for (const q of rebased) {
      await queryRunner.query(q.query, q.parameters);
    }
    this.logger.log(`[${schema}] applied ${rebased.length} alignment statement(s).`);
  }

  private async healUuidAndNullability(
    queryRunner: QueryRunner,
    schemas: readonly string[],
    entities: readonly EntityMetadata[],
  ): Promise<void> {
    const missing: string[] = [];
    let uuidFixed = 0;
    let notNullFixed = 0;

    for (const schema of schemas) {
      for (const entity of entities) {
        if (!(await this.tableExists(queryRunner, schema, entity.tableName))) {
          continue;
        }

        for (const column of entity.columns) {
          if (column.isVirtual) continue;
          const dbCol = await this.columnInfo(
            queryRunner,
            schema,
            entity.tableName,
            column.databaseName,
          );
          if (!dbCol) {
            missing.push(`${schema}.${entity.tableName}.${column.databaseName}`);
            continue;
          }

          if (column.type === 'uuid' && !column.isArray && dbCol.data_type !== 'uuid') {
            await this.assertUuidCastable(
              queryRunner,
              schema,
              entity.tableName,
              column.databaseName,
            );
            await queryRunner.query(
              `ALTER TABLE ${quoteQualified(schema, entity.tableName)} ` +
                `ALTER COLUMN ${quoteIdent(column.databaseName)} ` +
                `TYPE uuid USING ${quoteIdent(column.databaseName)}::text::uuid`,
            );
            uuidFixed++;
          }

          if (!column.isNullable && dbCol.is_nullable === 'YES') {
            const nullRows = await this.nullCount(
              queryRunner,
              schema,
              entity.tableName,
              column.databaseName,
            );
            if (nullRows > 0) {
              throw new Error(
                `ReplayHrEntitySurfaceAlignment refuses to SET NOT NULL on ` +
                  `${schema}.${entity.tableName}.${column.databaseName}; ` +
                  `${nullRows} row(s) are NULL. Backfill explicitly first.`,
              );
            }
            await queryRunner.query(
              `ALTER TABLE ${quoteQualified(schema, entity.tableName)} ` +
                `ALTER COLUMN ${quoteIdent(column.databaseName)} SET NOT NULL`,
            );
            notNullFixed++;
          }
        }
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `ReplayHrEntitySurfaceAlignment finished but ${missing.length} ` +
          `entity-declared column(s) are still missing: ${missing
            .slice(0, 20)
            .join(', ')}${missing.length > 20 ? ` (+${missing.length - 20} more)` : ''}`,
      );
    }

    this.logger.log(
      `Validator-contract final heal complete: ${uuidFixed} uuid type fix(es), ` +
        `${notNullFixed} SET NOT NULL fix(es).`,
    );
  }

  private referencesOnlyHrOrUnqualified(sql: string): boolean {
    for (const match of sql.matchAll(/"([a-zA-Z_][a-zA-Z0-9_]*)"\./g)) {
      const schema = match[1];
      if (schema !== undefined && schema.toLowerCase() !== 'hr') {
        return false;
      }
    }
    return true;
  }

  private isValidatorRelevant(sql: string): boolean {
    const t = sql.trim();
    if (/^CREATE\s+TYPE\b/i.test(t)) return true;
    if (/^CREATE\s+TABLE\b/i.test(t)) return true;
    if (/^ALTER\s+TABLE\b[^;]*?\bADD\s+(?!CONSTRAINT\b)"/i.test(t)) return true;
    if (/^ALTER\s+TABLE\b[^;]*?\bALTER\s+COLUMN\b/i.test(t)) return true;
    return false;
  }

  private makeIdempotent(sql: string): string {
    let s = sql;
    s = s.replace(/^CREATE\s+TABLE\s+"/i, 'CREATE TABLE IF NOT EXISTS "');
    s = s.replace(
      /(\bALTER\s+TABLE\s+(?:"[^"]+"\.)?"[^"]+"\s+)ADD\s+"/i,
      '$1ADD COLUMN IF NOT EXISTS "',
    );
    if (/^CREATE\s+TYPE\b/i.test(s)) {
      s = `DO $$ BEGIN ${s}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`;
    }
    return s;
  }

  private expandAlterColumnTypeWithDefaultRecovery(
    q: { query: string; parameters?: unknown[] },
    defaults: ReadonlyMap<string, string>,
  ): Array<{ query: string; parameters?: unknown[] }> {
    const m = q.query.match(
      /^ALTER\s+TABLE\s+(?:"([^"]+)"\.)?"([^"]+)"\s+ALTER\s+COLUMN\s+"([^"]+)"\s+TYPE\b/i,
    );
    if (!m) return [{ query: q.query, parameters: q.parameters }];

    const schemaName = m[1] ?? 'hr';
    const tableName = m[2];
    const columnName = m[3];
    if (tableName === undefined || columnName === undefined) {
      return [{ query: q.query, parameters: q.parameters }];
    }

    const tableRef = m[1] ? quoteQualified(schemaName, tableName) : quoteIdent(tableName);
    const out: Array<{ query: string; parameters?: unknown[] }> = [
      {
        query: `ALTER TABLE ${tableRef} ALTER COLUMN ${quoteIdent(columnName)} DROP DEFAULT`,
      },
      { query: q.query, parameters: q.parameters },
    ];
    const declared = defaults.get(`${tableName}.${columnName}`);
    if (declared !== undefined) {
      out.push({
        query:
          `ALTER TABLE ${tableRef} ALTER COLUMN ${quoteIdent(columnName)} ` +
          `SET DEFAULT ${declared}`,
      });
    }
    return out;
  }

  private entityDefaultsByTableColumn(entities: readonly EntityMetadata[]): Map<string, string> {
    const defaults = new Map<string, string>();
    for (const meta of entities) {
      for (const col of meta.columns) {
        const rendered = this.renderEntityDefaultLiteral(col);
        if (rendered !== undefined) {
          defaults.set(`${meta.tableName}.${col.databaseName}`, rendered);
        }
      }
    }
    return defaults;
  }

  private renderEntityDefaultLiteral(col: ColumnMetadata): string | undefined {
    const d = col.default;
    if (d === undefined) return undefined;
    if (d === null) return 'NULL';
    if (typeof d === 'function') {
      const result = d();
      return typeof result === 'string' && result.length > 0 ? result : undefined;
    }
    if (typeof d === 'string') return `'${d.replace(/'/g, "''")}'`;
    if (typeof d === 'number' || typeof d === 'boolean') return String(d);
    if (Array.isArray(d)) {
      return `ARRAY[${d
        .map((v) => (typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : String(v)))
        .join(', ')}]`;
    }
    if (typeof d === 'object') {
      return `'${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    }
    return undefined;
  }

  private hasSafeAddDefault(column: ColumnMetadata): boolean {
    return (
      column.default !== undefined ||
      column.isGenerated ||
      column.isCreateDate ||
      column.isUpdateDate ||
      column.isVersion
    );
  }

  private async tableExists(
    queryRunner: QueryRunner,
    schema: string,
    table: string,
  ): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'
      ) AS exists`,
      [schema, table],
    );
    return rows[0]?.exists === true;
  }

  private async columnNames(
    queryRunner: QueryRunner,
    schema: string,
    table: string,
  ): Promise<Set<string>> {
    const rows: Array<{ column_name: string }> = await queryRunner.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`,
      [schema, table],
    );
    return new Set(rows.map((r) => r.column_name));
  }

  private async columnInfo(
    queryRunner: QueryRunner,
    schema: string,
    table: string,
    column: string,
  ): Promise<{ data_type: string; udt_name: string; is_nullable: 'YES' | 'NO' } | undefined> {
    const rows: Array<{
      data_type: string;
      udt_name: string;
      is_nullable: 'YES' | 'NO';
    }> = await queryRunner.query(
      `SELECT data_type, udt_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
      [schema, table, column],
    );
    return rows[0];
  }

  private async rowCount(queryRunner: QueryRunner, schema: string, table: string): Promise<number> {
    const rows: Array<{ count: string }> = await queryRunner.query(
      `SELECT COUNT(*)::text AS count FROM ${quoteQualified(schema, table)}`,
    );
    return Number(rows[0]?.count ?? '0');
  }

  private async nullCount(
    queryRunner: QueryRunner,
    schema: string,
    table: string,
    column: string,
  ): Promise<number> {
    const rows: Array<{ count: string }> = await queryRunner.query(
      `SELECT COUNT(*)::text AS count
       FROM ${quoteQualified(schema, table)}
       WHERE ${quoteIdent(column)} IS NULL`,
    );
    return Number(rows[0]?.count ?? '0');
  }

  private async assertUuidCastable(
    queryRunner: QueryRunner,
    schema: string,
    table: string,
    column: string,
  ): Promise<void> {
    const rows: Array<{ count: string }> = await queryRunner.query(
      `SELECT COUNT(*)::text AS count
       FROM ${quoteQualified(schema, table)}
       WHERE ${quoteIdent(column)} IS NOT NULL
         AND lower(${quoteIdent(column)}::text) !~ $1`,
      [ReplayHrEntitySurfaceAlignment1789300000000.UUID_RE],
    );
    const invalid = Number(rows[0]?.count ?? '0');
    if (invalid > 0) {
      throw new Error(
        `ReplayHrEntitySurfaceAlignment refuses to cast ` +
          `${schema}.${table}.${column} to uuid; ${invalid} row(s) are not ` +
          'valid UUID literals. Backfill explicitly first.',
      );
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      'ReplayHrEntitySurfaceAlignment is forward-only. Rolling back would ' +
        're-introduce SchemaDriftValidator-blocking HR schema drift.',
    );
  }
}
