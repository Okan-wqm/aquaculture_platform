import { DataSource } from 'typeorm';

import { MODULE_SCHEMAS } from '../schema-manager.service';
import type { ModuleSchema } from '../schema-manager.service';
import { getTenantSchemaName, listTenantSchemas } from '../tenant-schema.utils';
import { CrossTenantProbe } from '../watchdog/cross-tenant-probe';
import { SchemaDriftDetector } from '../watchdog/schema-drift-detector';
import { SourceSchemaScanner } from '../watchdog/source-schema-scanner';
import { WatchdogRunner } from '../watchdog/watchdog-runner';
import type { WatchdogReport } from '../watchdog/watchdog-runner';

/**
 * Watchdog Integration Tests
 *
 * These tests require a running PostgreSQL database (aqua-postgres container).
 * They validate that the watchdog scanners correctly detect violations by
 * intentionally introducing contamination, cross-tenant data, and schema drift.
 *
 * Run with: npx jest --testPathPattern=watchdog.integration --no-cache
 * Requires: DATABASE_HOST, DATABASE_PORT, DATABASE_USER, DATABASE_PASSWORD, DATABASE_NAME
 */

const TEST_TENANT_ID_A = 'a1aa1111-bbbb-4ccc-8ddd-eeeeeeeeee01';
const TEST_TENANT_ID_B = 'b2bb2222-cccc-4ddd-8eee-ffffffff0002';
const SCANNER_SOURCE_SCHEMA = 'watchdog_source_fixture';
const SCANNER_TEST_TABLE = 'source_contamination_fixture';
const scannerFixtureModule: ModuleSchema = {
  moduleName: 'watchdog-integration-fixture',
  sourceSchema: SCANNER_SOURCE_SCHEMA,
  tables: [SCANNER_TEST_TABLE],
};

describe('Watchdog Integration Tests', () => {
  let dataSource: DataSource;
  let createdAuthSchema = false;
  let createdAuthTenantsTable = false;
  const schemaA = getTenantSchemaName(TEST_TENANT_ID_A);
  const schemaB = getTenantSchemaName(TEST_TENANT_ID_B);

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

    const authSchemaExists: { exists: boolean }[] = await dataSource.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.schemata WHERE schema_name = 'auth'
       ) AS exists`,
    );
    createdAuthSchema = authSchemaExists[0]?.exists !== true;
    await dataSource.query('CREATE SCHEMA IF NOT EXISTS "auth"');

    const authTenantsExists: { exists: boolean }[] = await dataSource.query(
      `SELECT to_regclass('auth.tenants') IS NOT NULL AS exists`,
    );
    createdAuthTenantsTable = authTenantsExists[0]?.exists !== true;
    if (createdAuthTenantsTable) {
      await dataSource.query(`
        CREATE TABLE "auth"."tenants" (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL
        )
      `);
    }
  }, 30_000);

  afterAll(async () => {
    if (dataSource.isInitialized) {
      await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaA}" CASCADE`);
      await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaB}" CASCADE`);
      await dataSource.query(`DROP SCHEMA IF EXISTS "${SCANNER_SOURCE_SCHEMA}" CASCADE`);
      if (createdAuthTenantsTable) {
        await dataSource.query('DROP TABLE "auth"."tenants"');
      }
      if (createdAuthSchema) {
        await dataSource.query('DROP SCHEMA "auth"');
      }
      await dataSource.destroy();
    }
  }, 15_000);

  describe('SourceSchemaScanner', () => {
    afterEach(async () => {
      const fixtureIndex = MODULE_SCHEMAS.indexOf(scannerFixtureModule);
      if (fixtureIndex >= 0) {
        MODULE_SCHEMAS.splice(fixtureIndex, 1);
      }
      await dataSource.query(`DROP SCHEMA IF EXISTS "${SCANNER_SOURCE_SCHEMA}" CASCADE`);
    });

    it('should not report a queryable source table with no rows', async () => {
      await dataSource.query(`CREATE SCHEMA "${SCANNER_SOURCE_SCHEMA}"`);
      await dataSource.query(
        `CREATE TABLE "${SCANNER_SOURCE_SCHEMA}"."${SCANNER_TEST_TABLE}" (
          id SERIAL PRIMARY KEY
        )`,
      );
      MODULE_SCHEMAS.push(scannerFixtureModule);

      const scanner = new SourceSchemaScanner(dataSource);
      const violations = await scanner.scan();

      expect(
        violations.some(
          (violation) =>
            violation.schema === SCANNER_SOURCE_SCHEMA && violation.table === SCANNER_TEST_TABLE,
        ),
      ).toBe(false);
    });

    it('should detect contamination when source schema has tenant data', async () => {
      await dataSource.query(`CREATE SCHEMA "${SCANNER_SOURCE_SCHEMA}"`);
      await dataSource.query(
        `CREATE TABLE "${SCANNER_SOURCE_SCHEMA}"."${SCANNER_TEST_TABLE}" (
          id SERIAL PRIMARY KEY,
          tenant_id UUID DEFAULT '${TEST_TENANT_ID_A}',
          name TEXT DEFAULT 'watchdog_test'
        )`,
      );
      await dataSource.query(
        `INSERT INTO "${SCANNER_SOURCE_SCHEMA}"."${SCANNER_TEST_TABLE}" (name)
         VALUES ('contamination_test')`,
      );
      MODULE_SCHEMAS.push(scannerFixtureModule);

      const scanner = new SourceSchemaScanner(dataSource);
      const violations = await scanner.scan();
      const fixtureViolation = violations.find(
        (violation) =>
          violation.schema === SCANNER_SOURCE_SCHEMA && violation.table === SCANNER_TEST_TABLE,
      );

      expect(fixtureViolation).toMatchObject({
        type: 'SOURCE_CONTAMINATION',
        severity: 'CRITICAL',
        rowCount: 1,
      });
    });
  });

  describe('SchemaDriftDetector', () => {
    beforeEach(async () => {
      // Create two test schemas with tables
      await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaA}" CASCADE`);
      await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaB}" CASCADE`);
      await dataSource.query(`CREATE SCHEMA "${schemaA}"`);
      await dataSource.query(`CREATE SCHEMA "${schemaB}"`);

      // Create matching table sets in both schemas
      await dataSource.query(`CREATE TABLE "${schemaA}"."test_table1" (id SERIAL PRIMARY KEY)`);
      await dataSource.query(`CREATE TABLE "${schemaA}"."test_table2" (id SERIAL PRIMARY KEY)`);
      await dataSource.query(`CREATE TABLE "${schemaB}"."test_table1" (id SERIAL PRIMARY KEY)`);
      await dataSource.query(`CREATE TABLE "${schemaB}"."test_table2" (id SERIAL PRIMARY KEY)`);
    });

    afterEach(async () => {
      await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaA}" CASCADE`);
      await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaB}" CASCADE`);
    });

    it('should detect missing tables (schema drift)', async () => {
      // Drop a table from schemaB to create drift
      await dataSource.query(`DROP TABLE "${schemaB}"."test_table2"`);

      const detector = new SchemaDriftDetector(dataSource);
      const violations = await detector.detect();

      // Should detect that schemaB is missing tables compared to schemaA
      // It also checks against MODULE_SCHEMAS, so MISSING_TABLE violations are expected
      // for both schemas (test tables aren't in MODULE_SCHEMAS). But SCHEMA_DRIFT
      // between the two schemas should definitely be detected.
      const driftViolations = violations.filter((v) => v.type === 'SCHEMA_DRIFT');

      // schemaA has test_table2 but schemaB doesn't -- drift detected
      const relevantDrift = driftViolations.filter(
        (v) => v.schema === schemaB && v.details.includes('test_table2'),
      );
      expect(relevantDrift.length).toBeGreaterThan(0);
    });

    it('should report MISSING_TABLE for tables defined in MODULE_SCHEMAS but not in tenant schema', async () => {
      const detector = new SchemaDriftDetector(dataSource);
      const violations = await detector.detect();

      // Our test schemas only have test_table1 and test_table2, but MODULE_SCHEMAS
      // defines 133 tables. So we expect MISSING_TABLE violations.
      const missingViolations = violations.filter(
        (v) => v.type === 'MISSING_TABLE' && (v.schema === schemaA || v.schema === schemaB),
      );

      // Each test schema should be missing most of the 133 expected tables
      expect(missingViolations.length).toBeGreaterThan(0);
      expect(missingViolations.every((violation) => violation.severity === 'HIGH')).toBe(true);
    });
  });

  describe('CrossTenantProbe', () => {
    const crossTenantSchema = getTenantSchemaName(TEST_TENANT_ID_A);
    let createdTenant = false;

    function rejectDataSourceQueryAt(callNumber: number, message: string): void {
      const originalQuery = dataSource.query.bind(dataSource);
      const querySpy = jest.spyOn(dataSource, 'query');
      for (let call = 1; call < callNumber; call += 1) {
        querySpy.mockImplementationOnce(originalQuery);
      }
      querySpy.mockRejectedValueOnce(new Error(message));
    }

    function returnRowsFromDataSourceQueryAt(callNumber: number, rows: object[]): void {
      const originalQuery = dataSource.query.bind(dataSource);
      const querySpy = jest.spyOn(dataSource, 'query');
      for (let call = 1; call < callNumber; call += 1) {
        querySpy.mockImplementationOnce(originalQuery);
      }
      querySpy.mockResolvedValueOnce(rows);
    }

    async function runCrossTenantOnly(): Promise<WatchdogReport> {
      const runner = new WatchdogRunner(dataSource);
      return runner.run({
        sourceContamination: false,
        crossTenantData: true,
        schemaDrift: false,
      });
    }

    function expectIncompleteCrossTenantReport(
      report: WatchdogReport,
      expectedError: string,
    ): void {
      expect(report.violations).toEqual([]);
      expect(report.summary.hasCritical).toBe(true);
      expect(report.summary.bySeverity.CRITICAL).toBe(0);
      expect(report.scannerErrors).toHaveLength(1);
      const scannerError = report.scannerErrors[0];
      if (scannerError === undefined) {
        throw new Error('Cross-tenant scanner failure was not recorded');
      }
      expect(scannerError.scanner).toBe('CrossTenantProbe');
      expect(scannerError.error).toContain(expectedError);
    }

    beforeEach(async () => {
      await dataSource.query(`DROP SCHEMA IF EXISTS "${crossTenantSchema}" CASCADE`);
      await dataSource.query(`CREATE SCHEMA "${crossTenantSchema}"`);

      // Create a table with tenant_id column
      await dataSource.query(`
        CREATE TABLE "${crossTenantSchema}"."probe_test" (
          id SERIAL PRIMARY KEY,
          tenant_id UUID NOT NULL,
          data TEXT
        )
      `);
      const existingTenant: { id: string }[] = await dataSource.query(
        `SELECT id FROM auth.tenants WHERE id = $1`,
        [TEST_TENANT_ID_A],
      );

      createdTenant = false;
      if (existingTenant.length === 0) {
        const tenantVersionColumn: { exists: boolean }[] = await dataSource.query(
          `SELECT EXISTS (
             SELECT 1
             FROM information_schema.columns
             WHERE table_schema = 'auth'
               AND table_name = 'tenants'
               AND column_name = 'version'
           ) AS exists`,
        );
        if (tenantVersionColumn[0]?.exists === true) {
          await dataSource.query(
            `INSERT INTO auth.tenants (id, name, slug, status, version)
             VALUES ($1, 'Watchdog Test Tenant', $2, 'ACTIVE', 1)`,
            [TEST_TENANT_ID_A, `watchdog-test-${TEST_TENANT_ID_A}`],
          );
        } else {
          await dataSource.query(
            `INSERT INTO auth.tenants (id, name, slug, status)
             VALUES ($1, 'Watchdog Test Tenant', $2, 'ACTIVE')`,
            [TEST_TENANT_ID_A, `watchdog-test-${TEST_TENANT_ID_A}`],
          );
        }
        createdTenant = true;
      }
    });

    afterEach(async () => {
      jest.restoreAllMocks();
      if (createdTenant) {
        await dataSource.query(`DELETE FROM auth.tenants WHERE id = $1`, [TEST_TENANT_ID_A]);
      }
      await dataSource.query(`DROP SCHEMA IF EXISTS "${crossTenantSchema}" CASCADE`);
    });

    it('should detect cross-tenant data when rows have wrong tenant_id', async () => {
      await dataSource.query(
        `INSERT INTO "${crossTenantSchema}"."probe_test" (tenant_id, data)
         VALUES ($1, 'correct tenant data')`,
        [TEST_TENANT_ID_A],
      );
      await dataSource.query(
        `INSERT INTO "${crossTenantSchema}"."probe_test" (tenant_id, data)
         VALUES ($1, 'WRONG tenant data - this is a leak')`,
        [TEST_TENANT_ID_B],
      );

      const activeTenant: { id: string }[] = await dataSource.query(
        `SELECT id FROM auth.tenants WHERE id = $1 AND status = 'ACTIVE'`,
        [TEST_TENANT_ID_A],
      );
      const tenantSchemas = await listTenantSchemas(dataSource);
      const foreignRows: { count: string }[] = await dataSource.query(
        `SELECT COUNT(*)::text AS count
         FROM "${crossTenantSchema}"."probe_test"
         WHERE tenant_id != $1`,
        [TEST_TENANT_ID_A],
      );
      expect(activeTenant).toHaveLength(1);
      expect(tenantSchemas).toContain(crossTenantSchema);
      expect(foreignRows[0]?.count).toBe('1');

      const probe = new CrossTenantProbe(dataSource);
      const violations = await probe.probe();

      const relevant = violations.filter(
        (v) =>
          v.type === 'CROSS_TENANT_DATA' &&
          v.schema === crossTenantSchema &&
          v.table === 'probe_test',
      );
      expect(relevant).toEqual([
        expect.objectContaining({
          severity: 'CRITICAL',
          rowCount: 1,
        }),
      ]);
    });

    it('records tenant-directory failures instead of an error-free clean report', async () => {
      rejectDataSourceQueryAt(2, 'tenant directory unavailable');

      const report = await runCrossTenantOnly();

      expectIncompleteCrossTenantReport(
        report,
        'could not load the tenant directory: tenant directory unavailable',
      );
    });

    it('records tenant-column discovery failures instead of an error-free clean report', async () => {
      rejectDataSourceQueryAt(3, 'tenant column catalog unavailable');

      const report = await runCrossTenantOnly();

      expectIncompleteCrossTenantReport(
        report,
        `could not discover tenant columns in schema "${crossTenantSchema}": tenant column catalog unavailable`,
      );
    });

    it('records foreign-row query failures instead of an error-free clean report', async () => {
      rejectDataSourceQueryAt(4, 'foreign-row query unavailable');

      const report = await runCrossTenantOnly();

      expectIncompleteCrossTenantReport(
        report,
        `could not inspect "${crossTenantSchema}"."probe_test"."tenant_id": foreign-row query unavailable`,
      );
    });

    it('records an unmapped tenant schema instead of omitting it from coverage', async () => {
      returnRowsFromDataSourceQueryAt(2, []);

      const report = await runCrossTenantOnly();

      expectIncompleteCrossTenantReport(
        report,
        `found schema "${crossTenantSchema}" without a canonical auth.tenants mapping`,
      );
    });

    it('records unsafe catalog identifiers instead of omitting them from coverage', async () => {
      await dataSource.query(`
        CREATE TABLE "${crossTenantSchema}"."unsafe-table" (
          id SERIAL PRIMARY KEY,
          tenant_id UUID NOT NULL
        )
      `);

      const report = await runCrossTenantOnly();

      expectIncompleteCrossTenantReport(
        report,
        `rejected unsafe identifier table="unsafe-table" column="tenant_id" in schema="${crossTenantSchema}"`,
      );
    });
  });

  describe('WatchdogRunner', () => {
    it('should produce a valid report with all scanners', async () => {
      const runner = new WatchdogRunner(dataSource);
      const report = await runner.runFullScan();

      // Verify report structure
      expect(report.scanStartedAt).toBeTruthy();
      expect(report.scanCompletedAt).toBeTruthy();
      expect(report.summary).toBeDefined();
      expect(report.summary.totalViolations).toBeGreaterThanOrEqual(0);
      expect(typeof report.summary.hasCritical).toBe('boolean');
      expect(report.summary.durationMs).toBeGreaterThanOrEqual(0);
      expect(report.scannersRun).toContain('SourceSchemaScanner');
      expect(report.scannersRun).toContain('CrossTenantProbe');
      expect(report.scannersRun).toContain('SchemaDriftDetector');
      expect(Array.isArray(report.violations)).toBe(true);
      expect(Array.isArray(report.scannerErrors)).toBe(true);

      // Verify severity breakdown adds up
      const severitySum =
        report.summary.bySeverity.CRITICAL +
        report.summary.bySeverity.HIGH +
        report.summary.bySeverity.MEDIUM +
        report.summary.bySeverity.LOW;
      expect(severitySum).toBe(report.summary.totalViolations);
    }, 60_000);

    it('should allow running individual scanners', async () => {
      const runner = new WatchdogRunner(dataSource);

      const sourceOnly = await runner.run({
        sourceContamination: true,
        crossTenantData: false,
        schemaDrift: false,
      });

      expect(sourceOnly.scannersRun).toEqual(['SourceSchemaScanner']);
      expect(sourceOnly.scannersRun).not.toContain('CrossTenantProbe');
      expect(sourceOnly.scannersRun).not.toContain('SchemaDriftDetector');
    });

    it('violations should be sorted by severity (CRITICAL first)', async () => {
      const runner = new WatchdogRunner(dataSource);
      const report = await runner.runFullScan();

      if (report.violations.length >= 2) {
        const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
        for (let i = 1; i < report.violations.length; i++) {
          const previousViolation = report.violations[i - 1];
          const currentViolation = report.violations[i];
          if (previousViolation === undefined || currentViolation === undefined) {
            throw new Error('Watchdog violation ordering traversal exceeded report bounds');
          }
          const prev = severityOrder[previousViolation.severity];
          const curr = severityOrder[currentViolation.severity];
          expect(curr).toBeGreaterThanOrEqual(prev);
        }
      }
    }, 60_000);
  });
});
