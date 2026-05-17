import { Logger } from '@nestjs/common';
import { MigrationInterface, QueryRunner, Table, TableColumn } from 'typeorm';
import type { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';
import type { EntityMetadata } from 'typeorm/metadata/EntityMetadata';
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

    await this.configureBoundedMigrationSession(queryRunner);

    const schemas = await this.listTargetSchemas(queryRunner);
    this.logger.log(`Targeting ${schemas.length} HR schema(s): ${schemas.join(', ')}`);
    for (const schema of schemas) {
      await this.renameLegacySnakeCaseColumns(queryRunner, schema, entities);
    }

    await this.assertMissingRequiredColumnsAreSafe(queryRunner, schemas, entities);
    await this.alignEntitySurface(queryRunner, schemas, entities);
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

  private async configureBoundedMigrationSession(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '10s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '10min'`);
    this.logger.log(
      'Bounded migration session configured: lock_timeout=10s, statement_timeout=10min.',
    );
  }

  private async renameLegacySnakeCaseColumns(
    queryRunner: QueryRunner,
    schema: string,
    entities: readonly EntityMetadata[],
  ): Promise<void> {
    this.logger.log(`[${schema}] starting legacy snake_case column normalization.`);
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
      this.logger.log(`[${schema}] starting required-column safety preflight.`);
      for (const entity of entities) {
        if (!(await this.tableExists(queryRunner, schema, entity.tableName))) {
          continue;
        }
        const hasRows = await this.tableHasRows(queryRunner, schema, entity.tableName);
        if (!hasRows) continue;

        const names = await this.columnNames(queryRunner, schema, entity.tableName);
        for (const column of entity.columns) {
          if (column.isVirtual || column.isNullable) continue;
          if (names.has(column.databaseName)) continue;
          if (this.hasSafeAddDefault(column)) continue;
          unsafe.push(`${schema}.${entity.tableName}.${column.databaseName}`);
        }
      }
      this.logger.log(`[${schema}] required-column safety preflight complete.`);
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

  private async alignEntitySurface(
    queryRunner: QueryRunner,
    schemas: readonly string[],
    entities: readonly EntityMetadata[],
  ): Promise<void> {
    let createdTables = 0;
    let addedColumns = 0;

    for (const schema of schemas) {
      this.logger.log(
        `[${schema}] starting deterministic entity-surface alignment for ` +
          `${entities.length} HR table definition(s).`,
      );
      let schemaCreatedTables = 0;
      let schemaAddedColumns = 0;
      const samples: string[] = [];

      for (const entity of entities) {
        const canonicalTable = this.tableForSchema(queryRunner, schema, entity);
        const tablePath = this.tablePath(queryRunner, schema, entity.tableName);
        const exists = await this.tableExists(queryRunner, schema, entity.tableName);

        if (!exists) {
          await queryRunner.createTable(canonicalTable, true, false, true);
          createdTables++;
          schemaCreatedTables++;
          if (samples.length < 8) {
            samples.push(`create:${schema}.${entity.tableName}`);
          }
          continue;
        }

        const names = await this.columnNames(queryRunner, schema, entity.tableName);
        for (const column of entity.columns) {
          if (column.isVirtual) continue;
          if (names.has(column.databaseName)) continue;

          const tableColumn = this.tableColumnFor(canonicalTable, column);
          await queryRunner.addColumn(tablePath, tableColumn);
          names.add(column.databaseName);
          addedColumns++;
          schemaAddedColumns++;
          if (samples.length < 8) {
            samples.push(`add:${schema}.${entity.tableName}.${column.databaseName}`);
          }
        }
      }

      this.logger.log(
        `[${schema}] deterministic entity-surface alignment complete: ` +
          `${schemaCreatedTables} table(s) created, ${schemaAddedColumns} column(s) added` +
          (samples.length > 0 ? `; samples: ${samples.join(', ')}` : ''),
      );
    }

    this.logger.log(
      `Deterministic entity-surface alignment complete: ${createdTables} table(s) ` +
        `created, ${addedColumns} column(s) added across ${schemas.length} schema(s).`,
    );
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
      this.logger.log(`[${schema}] starting validator-contract final heal.`);
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
            const hasNullRows = await this.hasNullRows(
              queryRunner,
              schema,
              entity.tableName,
              column.databaseName,
            );
            if (hasNullRows) {
              throw new Error(
                `ReplayHrEntitySurfaceAlignment refuses to SET NOT NULL on ` +
                  `${schema}.${entity.tableName}.${column.databaseName}; ` +
                  `at least one row is NULL. Backfill explicitly first.`,
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

  private hasSafeAddDefault(column: ColumnMetadata): boolean {
    if (column.isPrimary) return false;
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

  private async tableHasRows(
    queryRunner: QueryRunner,
    schema: string,
    table: string,
  ): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT EXISTS (
        SELECT 1 FROM ${quoteQualified(schema, table)} LIMIT 1
      ) AS exists`,
    );
    return rows[0]?.exists === true;
  }

  private async hasNullRows(
    queryRunner: QueryRunner,
    schema: string,
    table: string,
    column: string,
  ): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT EXISTS (
        SELECT 1
          FROM ${quoteQualified(schema, table)}
         WHERE ${quoteIdent(column)} IS NULL
         LIMIT 1
      ) AS exists`,
    );
    return rows[0]?.exists === true;
  }

  private async assertUuidCastable(
    queryRunner: QueryRunner,
    schema: string,
    table: string,
    column: string,
  ): Promise<void> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT EXISTS (
        SELECT 1
          FROM ${quoteQualified(schema, table)}
         WHERE ${quoteIdent(column)} IS NOT NULL
           AND lower(${quoteIdent(column)}::text) !~ $1
         LIMIT 1
      ) AS exists`,
      [ReplayHrEntitySurfaceAlignment1789300000000.UUID_RE],
    );
    if (rows[0]?.exists === true) {
      throw new Error(
        `ReplayHrEntitySurfaceAlignment refuses to cast ` +
          `${schema}.${table}.${column} to uuid; at least one row is not ` +
          'valid UUID literals. Backfill explicitly first.',
      );
    }
  }

  private tableForSchema(queryRunner: QueryRunner, schema: string, entity: EntityMetadata): Table {
    const table = Table.create(entity, queryRunner.connection.driver);
    table.database = undefined;
    table.schema = schema;
    table.name = this.tablePath(queryRunner, schema, entity.tableName);
    return table;
  }

  private tableColumnFor(table: Table, column: ColumnMetadata): TableColumn {
    const tableColumn = table.findColumnByName(column.databaseName);
    if (!tableColumn) {
      throw new Error(
        `ReplayHrEntitySurfaceAlignment could not derive TableColumn metadata for ` +
          `${table.name}.${column.databaseName}.`,
      );
    }
    return tableColumn.clone();
  }

  private tablePath(queryRunner: QueryRunner, schema: string, table: string): string {
    return queryRunner.connection.driver.buildTableName(table, schema);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      'ReplayHrEntitySurfaceAlignment is forward-only. Rolling back would ' +
        're-introduce SchemaDriftValidator-blocking HR schema drift.',
    );
  }
}
