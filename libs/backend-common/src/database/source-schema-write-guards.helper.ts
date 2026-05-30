import { MODULE_SCHEMAS } from './schema-manager.service';
import { validateSqlIdentifier } from './sql-identifier.util';

export interface SourceSchemaWriteGuardQueryExecutor {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface SourceSchemaWriteGuardLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface InstallSourceSchemaWriteGuardsOptions {
  sourceSchema: string;
  logger?: SourceSchemaWriteGuardLogger;
}

export interface InstallSourceSchemaWriteGuardsResult {
  sourceSchema: string;
  installed: number;
  skipped: number;
  reset: number;
}

function rowsFromQuery<T extends Record<string, unknown>>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function installSourceSchemaWriteGuards(
  executor: SourceSchemaWriteGuardQueryExecutor,
  options: InstallSourceSchemaWriteGuardsOptions,
): Promise<InstallSourceSchemaWriteGuardsResult> {
  const sourceSchema = validateSqlIdentifier(options.sourceSchema, 'schema');
  const logger = options.logger;

  const mod = MODULE_SCHEMAS.find((entry) => entry.sourceSchema === sourceSchema);
  if (!mod) {
    logger?.log(`No MODULE_SCHEMAS entry for "${sourceSchema}" — skipping write guards`);
    return { sourceSchema, installed: 0, skipped: 0, reset: 0 };
  }

  const referenceSet = new Set(mod.referenceDataTables ?? []);
  const infrastructureSet = new Set(mod.infrastructureTables ?? []);
  const protectedTables = mod.tables.filter(
    (table) => !referenceSet.has(table) && !infrastructureSet.has(table),
  );

  if (protectedTables.length === 0) {
    logger?.log(`No non-reference tables to protect in "${sourceSchema}"`);
    return { sourceSchema, installed: 0, skipped: 0, reset: 0 };
  }

  const existingGuards = rowsFromQuery<{
    schemaname: string;
    tablename: string;
  }>(
    await executor.query(
      `
        SELECT n.nspname AS schemaname, c.relname AS tablename
        FROM pg_trigger t
        JOIN pg_class c ON t.tgrelid = c.oid
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE t.tgname = 'guard_source_write'
          AND n.nspname = $1
          AND NOT t.tgisinternal
      `,
      [sourceSchema],
    ),
  );

  for (const row of existingGuards) {
    const schemaName = validateSqlIdentifier(row.schemaname, 'schema');
    const tableName = validateSqlIdentifier(row.tablename, 'table');
    await executor.query(
      `DROP TRIGGER IF EXISTS guard_source_write ON "${schemaName}"."${tableName}"`,
    );
  }

  if (existingGuards.length > 0) {
    logger?.log(
      `Clean-slate trigger reset: dropped ${existingGuards.length} existing guard_source_write trigger(s) in "${sourceSchema}" before reinstall.`,
    );
  }

  await executor.query(`
    CREATE OR REPLACE FUNCTION "${sourceSchema}".block_source_writes()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'TENANT_ISOLATION_VIOLATION: Direct write to source schema %.% blocked. Use tenant schema instead.',
        TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'P0999';
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `);

  let installed = 0;
  let skipped = 0;

  for (const rawTableName of protectedTables) {
    const tableName = validateSqlIdentifier(rawTableName, 'table');
    const exists = rowsFromQuery<{ exists: boolean }>(
      await executor.query(
        `SELECT EXISTS (
           SELECT 1
             FROM information_schema.tables
            WHERE table_schema = $1
              AND table_name = $2
              AND table_type = 'BASE TABLE'
         ) AS exists`,
        [sourceSchema, tableName],
      ),
    );

    if (exists[0]?.exists !== true) {
      skipped++;
      continue;
    }

    await executor.query(
      `DROP TRIGGER IF EXISTS guard_source_write ON "${sourceSchema}"."${tableName}"`,
    );
    await executor.query(`
      CREATE TRIGGER guard_source_write
        BEFORE INSERT OR UPDATE OR DELETE ON "${sourceSchema}"."${tableName}"
        FOR EACH ROW EXECUTE FUNCTION "${sourceSchema}".block_source_writes()
    `);
    installed++;
  }

  logger?.log(
    `Write guards installed: ${installed} tables protected in "${sourceSchema}" ` +
      `(${referenceSet.size} reference tables excluded, ` +
      `${infrastructureSet.size} infrastructure tables excluded, ` +
      `${skipped} not-yet-created skipped)`,
  );

  return {
    sourceSchema,
    installed,
    skipped,
    reset: existingGuards.length,
  };
}
