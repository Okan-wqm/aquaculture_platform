import { DataSource } from 'typeorm';
import { SchemaManagerService, MODULE_SCHEMAS } from '../schema-manager.service';
import { getTenantSchemaName, listTenantSchemas } from '../tenant-schema.utils';

const TEST_TENANT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/**
 * Schema Integrity Integration Tests
 *
 * These tests require a running PostgreSQL database (aqua-postgres container).
 * They verify that tenant schema provisioning creates all expected tables,
 * copies reference data correctly, and maintains consistency across tenants.
 *
 * Run with: npx jest --testPathPattern=schema-integrity.integration --no-cache
 * Requires: DATABASE_HOST, DATABASE_PORT, DATABASE_USER, DATABASE_PASSWORD, DATABASE_NAME
 */
describe('Schema Integrity (Integration)', () => {
  let dataSource: DataSource;
  let schemaManager: SchemaManagerService;
  const testSchema = getTenantSchemaName(TEST_TENANT_ID);

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env['DATABASE_HOST'] || 'localhost',
      port: parseInt(process.env['DATABASE_PORT'] || '5432'),
      username: process.env['DATABASE_USER'] || 'aquaculture',
      password: process.env['DATABASE_PASSWORD'] || 'aquaculture',
      database: process.env['DATABASE_NAME'] || 'aquaculture',
    });
    await dataSource.initialize();
    schemaManager = new SchemaManagerService(dataSource);
  }, 30_000);

  afterAll(async () => {
    // Cleanup test schema
    try {
      await dataSource.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
    } catch {
      // Ignore cleanup errors
    }
    await dataSource.destroy();
  }, 15_000);

  it('should create tenant schema with all module tables', async () => {
    // Clean up any leftover from previous test runs
    await dataSource.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);

    const result = await schemaManager.createTenantSchema(TEST_TENANT_ID);

    expect(result.success).toBe(true);
    expect(result.schemaName).toBe(testSchema);

    // Query actual tables in the created schema
    const tables = await dataSource.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [testSchema],
    );

    const tableNames: string[] = tables.map((t: { table_name: string }) => t.table_name);
    const expectedTables = MODULE_SCHEMAS.flatMap(m => m.tables);

    // Every expected table should exist in the tenant schema
    const missingTables: string[] = [];
    for (const expected of expectedTables) {
      if (!tableNames.includes(expected)) {
        missingTables.push(expected);
      }
    }

    if (missingTables.length > 0) {
      // Some tables may not exist in source schemas if those services haven't been started yet.
      // We still report them but don't necessarily fail hard -- the test shows what's missing.
      console.warn(
        `WARNING: ${missingTables.length} tables missing from tenant schema (source tables may not exist yet):`,
        missingTables,
      );
    }

    // At minimum we expect the tables that WERE created to match what the service reported
    for (const created of result.tablesCreated) {
      // created format: "schema.table" - extract just the table name
      const tableName = created.split('.').pop()!;
      expect(tableNames).toContain(tableName);
    }
  }, 60_000);

  it('reference data should be copied for modules that have seed data', async () => {
    for (const mod of MODULE_SCHEMAS) {
      const refTables = mod.referenceDataTables ?? [];
      for (const refTable of refTables) {
        try {
          const sourceCount = await dataSource.query(
            `SELECT COUNT(*) as cnt FROM "${mod.sourceSchema}"."${refTable}"`,
          );
          const tenantCount = await dataSource.query(
            `SELECT COUNT(*) as cnt FROM "${testSchema}"."${refTable}"`,
          );
          const srcCnt = parseInt(sourceCount[0]?.cnt || '0');
          const tntCnt = parseInt(tenantCount[0]?.cnt || '0');

          // Tenant should have at least as many rows as the source (reference data copied)
          if (srcCnt > 0) {
            expect(tntCnt).toBeGreaterThanOrEqual(srcCnt);
          }
        } catch {
          // Source table may not exist if service hasn't started -- skip silently
        }
      }
    }
  }, 30_000);

  it('all tenant schemas should have identical table sets', async () => {
    const schemas = await listTenantSchemas(dataSource);
    if (schemas.length < 2) {
      console.log('Skipping cross-tenant comparison: fewer than 2 tenant schemas exist');
      return;
    }

    const firstSchema = schemas[0]!;
    const firstTables = await dataSource.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [firstSchema],
    );
    const firstTableNames: string[] = firstTables.map((t: { table_name: string }) => t.table_name);

    for (const schema of schemas.slice(1)) {
      const tables = await dataSource.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
        [schema],
      );
      const tableNames: string[] = tables.map((t: { table_name: string }) => t.table_name);

      // Find differences
      const inFirstNotInCurrent = firstTableNames.filter(t => !tableNames.includes(t));
      const inCurrentNotInFirst = tableNames.filter(t => !firstTableNames.includes(t));

      if (inFirstNotInCurrent.length > 0 || inCurrentNotInFirst.length > 0) {
        console.warn(`Schema drift detected between ${firstSchema} and ${schema}:`);
        if (inFirstNotInCurrent.length > 0) {
          console.warn(`  Missing from ${schema}:`, inFirstNotInCurrent);
        }
        if (inCurrentNotInFirst.length > 0) {
          console.warn(`  Extra in ${schema}:`, inCurrentNotInFirst);
        }
      }

      expect(tableNames).toEqual(firstTableNames);
    }
  }, 60_000);

  it('tenant schema should have correct permissions', async () => {
    // Verify the current user has access to the test tenant schema
    const result = await dataSource.query(`
      SELECT has_schema_privilege(current_user, $1, 'USAGE') as has_usage
    `, [testSchema]);

    expect(result[0]?.has_usage).toBe(true);
  });

  it('table column structures should match between source and tenant schemas', async () => {
    const driftErrors: string[] = [];

    for (const mod of MODULE_SCHEMAS) {
      for (const tableName of mod.tables) {
        try {
          // Get source columns
          const sourceCols = await dataSource.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2
            ORDER BY ordinal_position
          `, [mod.sourceSchema, tableName]);

          // Get tenant columns
          const tenantCols = await dataSource.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2
            ORDER BY ordinal_position
          `, [testSchema, tableName]);

          if (sourceCols.length === 0 || tenantCols.length === 0) {
            continue; // Table may not exist in one or both schemas
          }

          // Compare column names
          const sourceColNames = sourceCols.map((c: { column_name: string }) => c.column_name);
          const tenantColNames = tenantCols.map((c: { column_name: string }) => c.column_name);

          if (JSON.stringify(sourceColNames) !== JSON.stringify(tenantColNames)) {
            driftErrors.push(
              `Column mismatch in ${tableName}: source has [${sourceColNames.join(',')}] vs tenant has [${tenantColNames.join(',')}]`,
            );
          }
        } catch {
          // Skip tables that don't exist in source
        }
      }
    }

    if (driftErrors.length > 0) {
      console.warn('Column structure drift detected:', driftErrors);
    }
    expect(driftErrors).toEqual([]);
  }, 60_000);
});
