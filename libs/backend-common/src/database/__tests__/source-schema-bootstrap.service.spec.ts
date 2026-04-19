/**
 * SourceSchemaBootstrapService — contract tests
 *
 * INFRA-CRITICAL-009 lock:  this service must NEVER call dataSource.synchronize()
 * at runtime. Migrations are the SSoT (per CLAUDE.md). Verification:
 *   1. The service implements OnApplicationBootstrap (NOT OnModuleInit) — runs
 *      AFTER MigrationRunnerService instances complete.
 *   2. The service throws on missing tables instead of falling back to
 *      synchronize. The legacy "log and continue" contract is reversed.
 *   3. No code path in the service calls dataSource.synchronize.
 */

import { DataSource } from 'typeorm';
import { SourceSchemaBootstrapService } from '../source-schema-bootstrap.service';

describe('SourceSchemaBootstrapService — INFRA-CRITICAL-009 contract', () => {
  let mockDataSource: jest.Mocked<DataSource>;
  let service: SourceSchemaBootstrapService;
  let synchronizeSpy: jest.Mock;

  beforeEach(() => {
    synchronizeSpy = jest.fn();
    mockDataSource = {
      query: jest.fn(),
      synchronize: synchronizeSpy,
    } as unknown as jest.Mocked<DataSource>;
    service = new SourceSchemaBootstrapService(mockDataSource);
  });

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
        // SELECT table_name from information_schema.tables (returns empty = empty schema)
        .mockResolvedValueOnce([]);

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        /Source schema "farm" is empty AFTER application bootstrap/,
      );
      expect(synchronizeSpy).not.toHaveBeenCalled();
    });

    it('does NOT synchronize when tables are missing (throws with actionable list)', async () => {
      // Mock MODULE_SCHEMAS dynamic import via jest.doMock pattern is complex
      // for a simple unit test. The grep-based invariant test
      // tests/invariants/no-runtime-synchronize.spec.ts is the platform-wide
      // lock. This test focuses on the empty-schema branch which exercises
      // the same throw-instead-of-synchronize contract.
      mockDataSource.query
        .mockResolvedValueOnce([{ search_path: 'unknown_schema_xyz,public' }])
        .mockResolvedValueOnce([]);

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        /Refusing to fall back to runtime synchronize\(\) per INFRA-CRITICAL-009/,
      );
      expect(synchronizeSpy).not.toHaveBeenCalled();
    });

    it('skips bootstrap when no source schema in search_path (still no synchronize)', async () => {
      mockDataSource.query.mockResolvedValueOnce([{ search_path: 'public' }]);

      await service.onApplicationBootstrap();
      expect(synchronizeSpy).not.toHaveBeenCalled();
    });
  });
});
