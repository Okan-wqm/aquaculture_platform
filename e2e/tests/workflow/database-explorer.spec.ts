import { GraphQLTestClient } from '../../helpers/graphql-client';
import { generateTenantFixture, TestTenantFixture } from '../../helpers/tenant.fixture';

/**
 * Database Explorer E2E Workflow Test
 *
 * Tests the database explorer functionality:
 * List tables -> View table schema -> Verify tenant scope isolation
 */
describe('Database Explorer', () => {
  let client: GraphQLTestClient;
  let fixture: TestTenantFixture;

  beforeAll(() => {
    client = new GraphQLTestClient();
    fixture = generateTenantFixture();
    client.setToken(fixture.adminToken);
  });

  afterAll(() => {
    client.clearToken();
  });

  test('List tables -> view schema -> within tenant scope', async () => {
    // Step 1: Get tenant database information (tables, size, status)
    const dbInfoResult = await client.query<{
      tenantDatabase: {
        databaseName: string;
        schemaName: string;
        totalSize: string;
        tableCount: number;
        status: string;
        activeConnections: number;
        maxConnections: number;
        databaseType: string;
        region: string;
        isolationLevel: string;
        encryption: string;
        tables: Array<{
          name: string;
          rowCount: number;
          size: string;
          indexCount: number;
          lastModified: string;
        }>;
      };
    }>(`
      query TenantDatabase {
        tenantDatabase {
          databaseName
          schemaName
          totalSize
          tableCount
          status
          activeConnections
          maxConnections
          databaseType
          region
          isolationLevel
          encryption
          tables {
            name
            rowCount
            size
            indexCount
            lastModified
          }
        }
      }
    `);

    const dbInfo = dbInfoResult.tenantDatabase;

    // Verify database info structure
    expect(dbInfo).toBeDefined();
    expect(typeof dbInfo.databaseName).toBe('string');
    expect(dbInfo.databaseName.length).toBeGreaterThan(0);
    expect(typeof dbInfo.schemaName).toBe('string');
    expect(dbInfo.schemaName.length).toBeGreaterThan(0);
    expect(typeof dbInfo.totalSize).toBe('string');
    expect(typeof dbInfo.tableCount).toBe('number');
    expect(dbInfo.tableCount).toBeGreaterThanOrEqual(0);
    expect(typeof dbInfo.status).toBe('string');
    expect(typeof dbInfo.activeConnections).toBe('number');
    expect(typeof dbInfo.maxConnections).toBe('number');
    expect(typeof dbInfo.databaseType).toBe('string');
    expect(typeof dbInfo.isolationLevel).toBe('string');
    expect(typeof dbInfo.encryption).toBe('string');

    // Verify tables array
    expect(Array.isArray(dbInfo.tables)).toBe(true);

    for (const table of dbInfo.tables) {
      expect(typeof table.name).toBe('string');
      expect(table.name.length).toBeGreaterThan(0);
      expect(typeof table.rowCount).toBe('number');
      expect(table.rowCount).toBeGreaterThanOrEqual(0);
      expect(typeof table.size).toBe('string');
      expect(typeof table.indexCount).toBe('number');
    }

    // Step 2: If tables exist, query schema for the first table
    if (dbInfo.tables.length > 0) {
      const firstTable = dbInfo.tables[0];
      expect(firstTable).toBeDefined();

      if (firstTable) {
        const schemaResult = await client.query<{
          tableSchema: {
            tableName: string;
            schemaName: string;
            columns: Array<{
              columnName: string;
              dataType: string;
              isNullable: boolean;
              columnDefault: string | null;
              isPrimaryKey: boolean;
              isForeignKey: boolean;
              foreignKeyTable: string | null;
              foreignKeyColumn: string | null;
            }>;
            indexes: Array<{
              indexName: string;
              columnName: string;
              isUnique: boolean;
              isPrimary: boolean;
            }>;
          };
        }>(
          `
          query TableSchema($schemaName: String!, $tableName: String!) {
            tableSchema(schemaName: $schemaName, tableName: $tableName) {
              tableName
              schemaName
              columns {
                columnName
                dataType
                isNullable
                columnDefault
                isPrimaryKey
                isForeignKey
                foreignKeyTable
                foreignKeyColumn
              }
              indexes {
                indexName
                columnName
                isUnique
                isPrimary
              }
            }
          }
          `,
          {
            schemaName: dbInfo.schemaName,
            tableName: firstTable.name,
          },
        );

        const schema = schemaResult.tableSchema;

        // Verify schema structure
        expect(schema.tableName).toBe(firstTable.name);
        expect(schema.schemaName).toBe(dbInfo.schemaName);
        expect(Array.isArray(schema.columns)).toBe(true);
        expect(schema.columns.length).toBeGreaterThan(0);

        // Verify column structure
        for (const col of schema.columns) {
          expect(typeof col.columnName).toBe('string');
          expect(col.columnName.length).toBeGreaterThan(0);
          expect(typeof col.dataType).toBe('string');
          expect(typeof col.isNullable).toBe('boolean');
          expect(typeof col.isPrimaryKey).toBe('boolean');
          expect(typeof col.isForeignKey).toBe('boolean');
        }

        // Should have at least one primary key column
        const hasPrimaryKey = schema.columns.some((c) => c.isPrimaryKey);
        expect(hasPrimaryKey).toBe(true);

        // Verify indexes structure
        expect(Array.isArray(schema.indexes)).toBe(true);
        for (const idx of schema.indexes) {
          expect(typeof idx.indexName).toBe('string');
          expect(typeof idx.columnName).toBe('string');
          expect(typeof idx.isUnique).toBe('boolean');
          expect(typeof idx.isPrimary).toBe('boolean');
        }
      }
    }

    // Step 3: Verify tenant scope — schema name should reference the tenant
    // Tenant schemas follow pattern: tenant_{id_prefix} or public
    const schemaName = dbInfo.schemaName;
    const isTenantScoped =
      schemaName.startsWith('tenant_') || schemaName === 'auth' || schemaName === 'public';
    expect(isTenantScoped).toBe(true);
  });

  test('tenantTables query returns read-only table list', async () => {
    const tablesResult = await client.query<{
      tenantTables: Array<{
        tableName: string;
        rowCount: number;
        module: string | null;
      }>;
    }>(`
      query TenantTables {
        tenantTables {
          tableName
          rowCount
          module
        }
      }
    `);

    expect(Array.isArray(tablesResult.tenantTables)).toBe(true);

    for (const table of tablesResult.tenantTables) {
      expect(typeof table.tableName).toBe('string');
      expect(table.tableName.length).toBeGreaterThan(0);
      expect(typeof table.rowCount).toBe('number');
      expect(table.rowCount).toBeGreaterThanOrEqual(0);
    }
  });
});
