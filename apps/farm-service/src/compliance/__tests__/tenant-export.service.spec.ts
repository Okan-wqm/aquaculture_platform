/**
 * TenantExportService Unit Tests
 *
 * Covers the GDPR Article 15 export flow in isolation:
 *   - resolveTenantScopedEntities filters to only entities carrying
 *     a tenantId column (global catalogs / pivots are skipped)
 *   - exportTenant issues one tenant-scoped SELECT per entity
 *   - farm_audit_logs rows are re-passed through AuditRedactionService
 *     on the way out (defence in depth vs phase 2.5 write-time)
 *   - query failures are captured into skippedTables rather than
 *     throwing — one bad table never takes the whole export down
 *   - the bundle shape is stable and records totalRows / tableCount
 */
import { DataSource } from 'typeorm';

import { AuditRedactionService } from '../../database/services/audit-redaction.service';
import { TenantExportService } from '../services/tenant-export.service';

interface ColumnDouble {
  propertyName: string;
}
interface EntityMetadataDouble {
  tableName: string;
  target: unknown;
  columns: ColumnDouble[];
}

type RedactionOverrides = Partial<
  Pick<AuditRedactionService, 'redactChanges' | 'redactMetadata'>
>;

function dataSourceDouble(dataSource: {
  entityMetadatas: EntityMetadataDouble[];
  getRepository: jest.Mock;
}): DataSource {
  const instance = new DataSource({
    type: 'postgres',
    database: 'tenant-export-service-spec',
  });
  Object.defineProperty(instance, 'entityMetadatas', {
    configurable: true,
    value: dataSource.entityMetadatas,
  });
  jest.spyOn(instance, 'getRepository').mockImplementation(dataSource.getRepository);
  return instance;
}

function makeDs(opts: {
  entities: EntityMetadataDouble[];
  rowsByTable?: Record<string, unknown[]>;
  failingTables?: Set<string>;
}) {
  const queryLog: Array<{ table: string; tenantId: string }> = [];
  const getRepository = jest.fn().mockImplementation((target: unknown) => {
    const meta = opts.entities.find((e) => e.target === target);
    const tableName = meta?.tableName ?? '<unknown>';
    const qb = {
      where: jest.fn().mockImplementation((_clause: string, params: { tenantId: string }) => {
        queryLog.push({ table: tableName, tenantId: params.tenantId });
        return qb;
      }),
      getMany: jest.fn().mockImplementation(async () => {
        if (opts.failingTables?.has(tableName)) {
          throw new Error(`boom-${tableName}`);
        }
        return opts.rowsByTable?.[tableName] ?? [];
      }),
    };
    return {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };
  });
  const dataSource = {
    entityMetadatas: opts.entities,
    getRepository,
  };
  return { dataSource: dataSourceDouble(dataSource), queryLog };
}

function makeRedaction(overrides?: RedactionOverrides): AuditRedactionService {
  const service = new AuditRedactionService();
  jest.spyOn(service, 'redactChanges').mockImplementation(
    overrides?.redactChanges ??
      ((changes) =>
        changes
          ? {
              before: {
                redacted: true,
                original: changes,
              },
            }
          : undefined),
  );
  jest.spyOn(service, 'redactMetadata').mockImplementation(
    overrides?.redactMetadata ??
      ((metadata) =>
        metadata
          ? {
              source: 'redacted',
              correlationId: JSON.stringify(metadata),
            }
          : undefined),
  );
  return service;
}

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('TenantExportService.resolveTenantScopedEntities', () => {
  it('returns only entities whose columns include tenantId', () => {
    const tenantScopedTarget = class ScopedA {};
    const alsoScopedTarget = class ScopedB {};
    const globalTarget = class Global {};
    const { dataSource } = makeDs({
      entities: [
        {
          tableName: 'scoped_a',
          target: tenantScopedTarget,
          columns: [{ propertyName: 'id' }, { propertyName: 'tenantId' }],
        },
        {
          tableName: 'global_catalog',
          target: globalTarget,
          columns: [{ propertyName: 'id' }, { propertyName: 'name' }],
        },
        {
          tableName: 'scoped_b',
          target: alsoScopedTarget,
          columns: [{ propertyName: 'tenantId' }],
        },
      ],
    });
    const service = new TenantExportService(dataSource, makeRedaction());

    const tables = service.resolveTenantScopedEntities().map((m) => m.tableName);
    expect(tables).toEqual(['scoped_a', 'scoped_b']);
    expect(tables).not.toContain('global_catalog');
  });
});

describe('TenantExportService.exportTenant', () => {
  it('runs one tenant-scoped SELECT per entity and aggregates rows', async () => {
    const { dataSource, queryLog } = makeDs({
      entities: [
        {
          tableName: 'batches_v2',
          target: class Batch {},
          columns: [{ propertyName: 'tenantId' }],
        },
        {
          tableName: 'sites',
          target: class Site {},
          columns: [{ propertyName: 'tenantId' }],
        },
      ],
      rowsByTable: {
        batches_v2: [{ id: 'b1' }, { id: 'b2' }],
        sites: [{ id: 's1' }],
      },
    });
    const service = new TenantExportService(dataSource, makeRedaction());

    const bundle = await service.exportTenant(TENANT);

    expect(queryLog).toEqual([
      { table: 'batches_v2', tenantId: TENANT },
      { table: 'sites', tenantId: TENANT },
    ]);
    expect(bundle.tenantId).toBe(TENANT);
    expect(bundle.tables['batches_v2']).toEqual([{ id: 'b1' }, { id: 'b2' }]);
    expect(bundle.tables['sites']).toEqual([{ id: 's1' }]);
    expect(bundle.summary.tableCount).toBe(2);
    expect(bundle.summary.totalRows).toBe(3);
    expect(bundle.summary.skippedTables).toEqual([]);
    expect(typeof bundle.exportedAt).toBe('string');
    expect(() => new Date(bundle.exportedAt).toISOString()).not.toThrow();
  });

  it('empty tenant returns an empty bundle — no rows, no errors', async () => {
    const { dataSource } = makeDs({
      entities: [
        {
          tableName: 'batches_v2',
          target: class Batch {},
          columns: [{ propertyName: 'tenantId' }],
        },
      ],
      rowsByTable: { batches_v2: [] },
    });
    const service = new TenantExportService(dataSource, makeRedaction());

    const bundle = await service.exportTenant(TENANT);
    expect(bundle.tables['batches_v2']).toEqual([]);
    expect(bundle.summary.totalRows).toBe(0);
    expect(bundle.summary.tableCount).toBe(1);
    expect(bundle.summary.skippedTables).toEqual([]);
  });

  it('re-runs audit redaction on exported farm_audit_logs rows', async () => {
    const redactedChanges = { before: { marker: 'changes-redacted' } };
    const redactedMetadata = { source: 'metadata-redacted' };
    const redactChanges = jest.fn().mockReturnValue(redactedChanges);
    const redactMetadata = jest.fn().mockReturnValue(redactedMetadata);
    const { dataSource } = makeDs({
      entities: [
        {
          tableName: 'farm_audit_logs',
          target: class AuditLog {},
          columns: [{ propertyName: 'tenantId' }],
        },
      ],
      rowsByTable: {
        farm_audit_logs: [
          {
            id: 'a1',
            changes: { before: { email: 'x@y.z' } },
            metadata: { ipAddress: '1.2.3.4' },
          },
          {
            id: 'a2',
            changes: null, // no changes column → skipped
            metadata: undefined, // no metadata column → skipped
          },
        ],
      },
    });
    const service = new TenantExportService(
      dataSource,
      makeRedaction({ redactChanges, redactMetadata }),
    );

    const bundle = await service.exportTenant(TENANT);
    const rows = bundle.tables['farm_audit_logs'] as Array<Record<string, unknown>>;
    const first = rows[0]!;
    const second = rows[1]!;
    expect(first['changes']).toBe(redactedChanges);
    expect(first['metadata']).toBe(redactedMetadata);
    // Null/undefined passed through untouched — redaction skipped.
    expect(second['changes']).toBeNull();
    expect(second['metadata']).toBeUndefined();
    expect(redactChanges).toHaveBeenCalledTimes(1);
    expect(redactMetadata).toHaveBeenCalledTimes(1);
  });

  it('rows from non-audit tables are passed through untouched', async () => {
    const redactChanges = jest.fn();
    const redactMetadata = jest.fn();
    const { dataSource } = makeDs({
      entities: [
        {
          tableName: 'batches_v2',
          target: class Batch {},
          columns: [{ propertyName: 'tenantId' }],
        },
      ],
      rowsByTable: {
        batches_v2: [{ id: 'b1', changes: { shouldNotTouch: true } }],
      },
    });
    const service = new TenantExportService(
      dataSource,
      makeRedaction({ redactChanges, redactMetadata }),
    );

    const bundle = await service.exportTenant(TENANT);
    expect(bundle.tables['batches_v2']).toEqual([
      { id: 'b1', changes: { shouldNotTouch: true } },
    ]);
    expect(redactChanges).not.toHaveBeenCalled();
    expect(redactMetadata).not.toHaveBeenCalled();
  });

  it('query failure on one table lands in skippedTables — the rest still export', async () => {
    const { dataSource } = makeDs({
      entities: [
        {
          tableName: 'batches_v2',
          target: class Batch {},
          columns: [{ propertyName: 'tenantId' }],
        },
        {
          tableName: 'broken_table',
          target: class Broken {},
          columns: [{ propertyName: 'tenantId' }],
        },
        {
          tableName: 'sites',
          target: class Site {},
          columns: [{ propertyName: 'tenantId' }],
        },
      ],
      rowsByTable: {
        batches_v2: [{ id: 'b1' }],
        sites: [{ id: 's1' }],
      },
      failingTables: new Set(['broken_table']),
    });
    const service = new TenantExportService(dataSource, makeRedaction());

    const bundle = await service.exportTenant(TENANT);
    expect(bundle.summary.skippedTables).toEqual(['broken_table']);
    expect(Object.keys(bundle.tables)).toEqual(['batches_v2', 'sites']);
    expect(bundle.summary.tableCount).toBe(2);
    expect(bundle.summary.totalRows).toBe(2);
  });
});
