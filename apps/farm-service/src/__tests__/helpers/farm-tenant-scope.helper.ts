/**
 * Test harness for farm code that runs on a TenantScope (K10 layer 4).
 *
 * WHY: handlers and responders no longer hold a DataSource; they read through
 * the scope the boundary mints. A test gets a GENUINE scope by opening the
 * real boundary over a fake pooled connection (createFakeTenantConnection),
 * so the boundary's pin + assert and the responder's served-tenant read-back
 * run for real in every unit test, and a scope can never be hand-built.
 */
import { TenantScope } from '@aquaculture/backend-common/database';
import {
  collaborator,
  createFakeTenantConnection,
  stub,
  type FakeTenantConnection,
} from '@platform/testing';
import type {
  DataSource,
  EntityManager,
  EntityMetadata,
  ObjectLiteral,
  QueryRunner,
  Repository,
} from 'typeorm';
import type { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';

import { FarmAiResponder } from '../../common/tenant-boundary/farm-ai-responder';
import {
  FARM_SOURCE_SCHEMA,
  FarmTenantScopes,
} from '../../common/tenant-boundary/farm-tenant-scopes';

export interface FarmScopeHarness {
  readonly conn: FakeTenantConnection;
  readonly scopes: FarmTenantScopes;
  readonly responder: FarmAiResponder;
  /**
   * Ids the skeleton's owner lookups find. `undefined` (default) → every id
   * resolves; a set → only those ids exist in the scope's tenant.
   */
  ownedIds: ReadonlySet<string> | undefined;
  /** Run `fn` inside a genuine read scope for `tenantId`. */
  read<T>(tenantId: string, fn: (scope: TenantScope) => Promise<T>): Promise<T>;
}

/** An owner-table repository double: `id` + `tenantId` columns, rows = the harness's ownedIds. */
function ownerRepository(harness: {
  ownedIds: ReadonlySet<string> | undefined;
}): Repository<ObjectLiteral> {
  const metadata = collaborator<EntityMetadata>(
    {
      findColumnWithPropertyName: (name: string): ColumnMetadata | undefined =>
        name === 'id' || name === 'tenantId'
          ? stub<ColumnMetadata>({ propertyName: name })
          : undefined,
    },
    'EntityMetadata',
  );
  return collaborator<Repository<ObjectLiteral>>(
    {
      metadata,
      findOne: jest.fn(async (options: { where: Record<string, unknown> }) => {
        const id = String(options.where['id']);
        return harness.ownedIds === undefined || harness.ownedIds.has(id) ? { id } : null;
      }),
    },
    'OwnerRepository',
  );
}

export function createFarmScopeHarness(): FarmScopeHarness {
  const conn = createFakeTenantConnection();
  const scopes = new FarmTenantScopes(conn.dataSource);
  const harness: FarmScopeHarness = {
    conn,
    scopes,
    responder: new FarmAiResponder(scopes),
    ownedIds: undefined,
    read: (tenantId, fn) => TenantScope.read(conn.dataSource, FARM_SOURCE_SCHEMA, tenantId, fn),
  };
  conn.manager.getRepository.mockImplementation(() => ownerRepository(harness));
  return harness;
}

/**
 * Run `fn` inside a genuine read scope opened on `dataSource` — a
 * createMockDataSource() / createFakeTenantConnection() double whose manager
 * the test drives.
 */
export function inTenantScope<T>(
  tenantId: string,
  fn: (scope: TenantScope) => Promise<T>,
  dataSource: DataSource = createFakeTenantConnection().dataSource,
): Promise<T> {
  return TenantScope.read(dataSource, FARM_SOURCE_SCHEMA, tenantId, fn);
}

/**
 * A DataSource double whose every query runner is backed by `manager` — the
 * boundary pins and asserts on it (the assertion skips: the double returns no
 * rows) and the scope reads through `manager`.
 */
export function dataSourceOver(manager: EntityManager): DataSource {
  const settled = async (): Promise<void> => undefined;
  const runner = collaborator<QueryRunner>(
    {
      manager,
      connect: jest.fn(settled),
      startTransaction: jest.fn(settled),
      commitTransaction: jest.fn(settled),
      rollbackTransaction: jest.fn(settled),
      release: jest.fn(settled),
      query: jest.fn().mockResolvedValue([]),
    },
    'QueryRunner',
  );
  return collaborator<DataSource>({ createQueryRunner: () => runner }, 'DataSource');
}

/**
 * Run `fn` inside a genuine read scope whose manager is `manager` — for a
 * collaborator spec that drives a hand-built EntityManager double.
 */
export function inTenantScopeOver<T>(
  manager: EntityManager,
  tenantId: string,
  fn: (scope: TenantScope) => Promise<T>,
): Promise<T> {
  return TenantScope.read(dataSourceOver(manager), FARM_SOURCE_SCHEMA, tenantId, fn);
}
