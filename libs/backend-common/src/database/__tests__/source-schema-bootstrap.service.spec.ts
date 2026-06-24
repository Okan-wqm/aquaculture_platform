/**
 * SourceSchemaBootstrapService — contract tests
 *
 * INFRA-CRITICAL-009 lock:  this service must NEVER call dataSource.synchronize()
 * at runtime. Migrations are the SSoT (per CLAUDE.md). Verification:
 *   1. The service implements OnApplicationBootstrap (NOT OnModuleInit) and
 *      waits on any in-process MigrationRunnerService completion promise.
 *   2. The service throws on missing tables instead of falling back to
 *      synchronize. The legacy "log and continue" contract is reversed.
 *   3. No code path in the service calls dataSource.synchronize.
 */

import { DataSource } from 'typeorm';

import * as migrationRunner from '../migration-runner';
import { MODULE_SCHEMAS } from '../schema-manager.service';
import { SourceSchemaBootstrapService } from '../source-schema-bootstrap.service';

describe('SourceSchemaBootstrapService — INFRA-CRITICAL-009 contract', () => {
  let mockDataSource: jest.Mocked<DataSource>;
  let service: SourceSchemaBootstrapService;
  let synchronizeSpy: jest.Mock;

  beforeEach(() => {
    jest.restoreAllMocks();
    synchronizeSpy = jest.fn();
    mockDataSource = {
      query: jest.fn(),
      synchronize: synchronizeSpy,
    } as unknown as jest.Mocked<DataSource>;
    service = new SourceSchemaBootstrapService(mockDataSource);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function expectedTablesFor(sourceSchema: string): string[] {
    const mod = MODULE_SCHEMAS.find((entry) => entry.sourceSchema === sourceSchema);
    if (!mod) {
      throw new Error(`MODULE_SCHEMAS missing ${sourceSchema} source schema`);
    }
    return [
      ...mod.tables,
      ...(mod.referenceDataTables ?? []),
      ...(mod.infrastructureTables ?? []),
    ];
  }

  describe('lifecycle hook', () => {
    it('implements OnApplicationBootstrap, not OnModuleInit', () => {
      // Asserted via TypeScript: if implements signature regresses, the file
      // won't compile. This is a runtime mirror.
      expect(typeof (service as unknown as { onApplicationBootstrap: unknown }).onApplicationBootstrap).toBe(
        'function',
      );
      expect(
        (service as unknown as { onModuleInit?: unknown }).onModuleInit,
      ).toBeUndefined();
    });
  });

  describe('synchronize() must NEVER be called', () => {
    it('does NOT synchronize when source schema is empty (throws instead)', async () => {
      // SHOW search_path
      mockDataSource.query
        .mockResolvedValueOnce([{ search_path: 'farm,public' }])
        // strict-ownership orphan-table scan for the farm schema
        .mockResolvedValueOnce([])
        // SELECT table_name from information_schema.tables (returns empty = empty schema)
        .mockResolvedValueOnce([]);

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        /Source schema "farm" is empty AFTER application bootstrap/,
      );
      expect(synchronizeSpy).not.toHaveBeenCalled();
    });

    it('does NOT synchronize when declared MODULE_SCHEMAS tables are missing', async () => {
      const missingTable = 'messages';
      const expectedTables = expectedTablesFor('messaging');
      const existingTables = expectedTables
        .filter((table) => table !== missingTable)
        .map((table_name) => ({ table_name }));

      mockDataSource.query
        .mockResolvedValueOnce([{ search_path: 'messaging,public' }])
        .mockResolvedValueOnce(existingTables);

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        new RegExp(
          `Source schema "messaging" is missing 1/${expectedTables.length} ` +
            `declared tables: ${missingTable}.*Refusing to fall back to runtime synchronize\\(\\) per INFRA-CRITICAL-009`,
        ),
      );
      expect(synchronizeSpy).not.toHaveBeenCalled();
    });

    it('fails closed when no source schema exists in search_path', async () => {
      mockDataSource.query.mockResolvedValueOnce([{ search_path: 'public' }]);

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        /No source schema found in connection search_path/,
      );
      expect(synchronizeSpy).not.toHaveBeenCalled();
    });

    it('fails closed when search_path source schema is not declared in MODULE_SCHEMAS', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([{ search_path: 'unknown_schema_xyz,public' }])
        .mockResolvedValueOnce([{ table_name: 'unowned_table' }]);

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        /Source schema "unknown_schema_xyz" is not declared in MODULE_SCHEMAS/,
      );
      expect(synchronizeSpy).not.toHaveBeenCalled();
    });

    it('waits for MigrationRunnerService completion before verifying tables', async () => {
      let finishMigration!: () => void;
      const migrationCompletion = new Promise<void>((resolve) => {
        finishMigration = resolve;
      });
      jest
        .spyOn(migrationRunner, 'getMigrationRunnerCompletion')
        .mockReturnValue(migrationCompletion);

      const existingTables = expectedTablesFor('auth').map((table_name) => ({
        table_name,
      }));
      mockDataSource.query
        .mockResolvedValueOnce([{ search_path: 'auth,public' }])
        .mockResolvedValueOnce(existingTables);

      const bootstrap = service.onApplicationBootstrap();

      await Promise.resolve();
      await Promise.resolve();
      expect(mockDataSource.query).toHaveBeenCalledTimes(1);
      expect(mockDataSource.query).toHaveBeenNthCalledWith(1, 'SHOW search_path');

      finishMigration();
      await expect(bootstrap).resolves.toBeUndefined();
      expect(mockDataSource.query).toHaveBeenCalledTimes(2);
      expect(String(mockDataSource.query.mock.calls[1]?.[0])).toContain(
        'information_schema.tables',
      );
      expect(synchronizeSpy).not.toHaveBeenCalled();
    });

    it('fails closed when MigrationRunnerService completion rejects', async () => {
      jest
        .spyOn(migrationRunner, 'getMigrationRunnerCompletion')
        .mockReturnValue(Promise.reject(new Error('migration failed')));

      mockDataSource.query.mockResolvedValueOnce([
        { search_path: 'auth,public' },
      ]);

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        'migration failed',
      );
      expect(mockDataSource.query).toHaveBeenCalledTimes(1);
      expect(synchronizeSpy).not.toHaveBeenCalled();
    });

    it('fails closed on strict-ownership orphan tables without DDL cleanup', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([{ search_path: 'farm,public' }])
        .mockResolvedValueOnce([{ table_name: 'audit_logs' }]);

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        /Source schema "farm" has 1 orphan table\(s\): audit_logs.*Runtime services cannot clean this with DDL/,
      );
      expect(synchronizeSpy).not.toHaveBeenCalled();
    });
  });
});
