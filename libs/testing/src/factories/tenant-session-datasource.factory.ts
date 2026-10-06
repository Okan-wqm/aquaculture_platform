/**
 * A mock DataSource whose single session honours the tenant boundary's own
 * statements, for code that runs inside runInTenantTransaction /
 * runInTenantRead or that verifies a caller's binding (assertTenantRlsBound).
 *
 * WHY: the plain `createMockDataSource` answers every query with `[]`, so the
 * boundary's read-backs see nothing and a write under the wrong tenant (or
 * under none) passes unnoticed — exactly the defect class FORCE RLS turns into
 * "zero rows stored" in production (SENSOR-HIGH-145/148). Here `set_config`
 * really sets `search_path` / `app.current_tenant` / `app.bypass_rls`,
 * transaction-locally (commit and rollback clear them), and the read-backs
 * answer from that state. Tests can therefore assert WHICH tenant a statement
 * ran under, not merely that it ran.
 *
 * Every other statement goes to `domainQuery`, the mock assertions inspect.
 * `mockManager` is the shared repository-capable manager (`getRepository`,
 * `createQueryBuilder`, …) with `query` routed through the same session.
 */
import { DataSource, EntityManager, QueryRunner } from 'typeorm';

import { createMockDataSource, type MockQueryBuilderChain } from './mock-datasource.factory';

/** A non-boundary statement handler: `(sql, params) => result`. */
export type DomainQueryMock = jest.Mock<Promise<unknown>, [string, (readonly unknown[])?]>;

export interface TenantSession {
  schema: string;
  tenant: string;
  bypass: string;
}

export interface TenantSessionDataSourceResult {
  mockDataSource: jest.Mocked<DataSource>;
  mockQueryRunner: jest.Mocked<QueryRunner>;
  mockManager: jest.Mocked<EntityManager>;
  /** Live session state; read it inside a domain-query mock to see the binding. */
  session: TenantSession;
  /** The tenant each transaction was bound to when it committed, in order. */
  boundTenants: string[];
  /** Every non-boundary statement: `(sql, params) => result`. */
  domainQuery: DomainQueryMock;
  /** Every query-builder chain the manager returned, in order. */
  queryBuilders: MockQueryBuilderChain[];
}

function unboundSession(): TenantSession {
  return { schema: 'public', tenant: '', bypass: '' };
}

/**
 * Answer a tenant-boundary statement from `session`, or return `undefined`
 * when `sql` is not one (the caller then routes it to the domain mock).
 */
export function answerTenantBoundaryStatement(
  session: TenantSession,
  sql: string,
  params: readonly unknown[] = [],
): unknown[] | undefined {
  if (sql.includes("set_config('search_path'")) {
    session.schema = String(params[0]).split(',')[0]?.trim().replace(/"/g, '') ?? '';
    return [];
  }
  if (sql.includes("set_config($1, 'off', true)")) {
    session.bypass = 'off';
    return [];
  }
  if (sql.includes('set_config($1, $2, true)')) {
    if (params[0] === 'app.current_tenant') session.tenant = String(params[1]);
    return [];
  }
  if (sql.includes('current_schema() AS schema')) {
    return [{ schema: session.schema, tenant: session.tenant, bypass: session.bypass }];
  }
  if (sql.includes('current_setting($1, true) AS tenant')) {
    return [{ tenant: session.tenant, bypass: session.bypass }];
  }
  return undefined;
}

export function createTenantSessionDataSource(): TenantSessionDataSourceResult {
  const { mockDataSource, mockQueryRunner, mockManager, queryBuilders } = createMockDataSource();
  const session = unboundSession();
  const boundTenants: string[] = [];
  const domainQuery: DomainQueryMock = jest.fn((_sql: string, _params?: readonly unknown[]) =>
    Promise.resolve<unknown>([]),
  );

  const run = (sql: string, params?: readonly unknown[]): Promise<unknown> => {
    const boundary = answerTenantBoundaryStatement(session, sql, params);
    return boundary === undefined ? domainQuery(sql, params) : Promise.resolve(boundary);
  };
  const end = (committed: boolean) => (): Promise<void> => {
    if (committed) boundTenants.push(session.tenant);
    Object.assign(session, unboundSession());
    return Promise.resolve();
  };

  mockQueryRunner.query.mockImplementation(run);
  mockQueryRunner.commitTransaction.mockImplementation(end(true));
  mockQueryRunner.rollbackTransaction.mockImplementation(end(false));
  mockManager.query = jest.fn(run) as jest.Mocked<EntityManager>['query'];

  return {
    mockDataSource,
    mockQueryRunner,
    mockManager,
    session,
    boundTenants,
    domainQuery,
    queryBuilders,
  };
}

/**
 * A caller-owned transaction manager already bound to `tenantId` (or to no
 * tenant when `null`), for code that writes on someone else's transaction.
 */
export function createTenantBoundManager(
  tenantId: string | null,
  domainQuery: DomainQueryMock,
): EntityManager {
  const session: TenantSession = {
    schema: 'public',
    tenant: tenantId ?? '',
    bypass: tenantId === null ? '' : 'off',
  };
  const manager: Partial<EntityManager> = {
    query: ((sql: string, params?: readonly unknown[]) => {
      const boundary = answerTenantBoundaryStatement(session, sql, params);
      return boundary === undefined ? domainQuery(sql, params) : Promise.resolve(boundary);
    }) as EntityManager['query'],
  };
  return manager as EntityManager;
}
