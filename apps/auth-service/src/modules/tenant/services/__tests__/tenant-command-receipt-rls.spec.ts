/**
 * ORPHAN-CRITICAL-573 — the receipt transaction must bind its RLS tenant
 * context before it touches `auth.tenant_command_receipts`.
 *
 * The table carries the standard isolation policy: a row is writable only
 * under `app.bypass_rls=on`, or when `app.current_tenant` equals its
 * `tenantId`. The transaction ran with neither, so the very first INSERT was
 * refused — and since the receipt is written before any provisioning step
 * executes, every tenant creation failed at step zero. Two production
 * tenants sat in PENDING with no schema for months because of it.
 *
 * What these tests pin is narrow and deliberate: the GUC is set, it is set
 * BEFORE the first receipt statement, it names the command's tenant, and it
 * is transaction-local. The last one is what makes this a fix rather than a
 * new bug — a session-wide setting on a pooled connection would leak this
 * tenant into the next caller's query.
 */
import { TenantStatus } from '@platform/event-contracts';

import { TenantProvisioningCommandService } from '../tenant-provisioning-command.service';

const TENANT_ID = '33333333-3333-4333-8333-333333333333';

interface MockManager {
  query: jest.Mock;
  findOne: jest.Mock;
  save: jest.Mock;
}

function createManager(): MockManager {
  return {
    query: jest.fn((sql: string) => {
      if (
        sql.includes('FROM auth.tenant_command_receipts') &&
        sql.trimStart().startsWith('SELECT')
      ) {
        return Promise.resolve([]);
      }
      if (sql.includes('SELECT id FROM "auth"."users"')) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }),
    findOne: jest.fn(() =>
      Promise.resolve({ id: TENANT_ID, status: TenantStatus.ACTIVE, name: 'Canary Probe' }),
    ),
    save: jest.fn((_entity: unknown, value: unknown) => Promise.resolve(value)),
  };
}

function createService(manager: MockManager): TenantProvisioningCommandService {
  const dataSource = {
    transaction: jest.fn((_isolation: string, cb: (m: MockManager) => Promise<unknown>) =>
      cb(manager),
    ),
  };
  return new TenantProvisioningCommandService(
    {} as never,
    {} as never,
    {} as never,
    dataSource as never,
    { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
    {
      revokeUserTokens: jest.fn().mockResolvedValue(undefined),
      isTokenValid: jest.fn().mockResolvedValue(true),
    } as never,
  );
}

const command = {
  operationId: '44444444-4444-4444-8444-444444444444',
  tenantId: TENANT_ID,
  actor: { id: 'platform-admin', type: 'SUPER_ADMIN' },
  reason: 'canary provisioning',
} as never;

function sqlOf(calls: unknown[][]): string[] {
  return calls.map(([sql]) => String(sql));
}

describe('tenant command receipts run under an RLS tenant context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sets the tenant GUC before the first receipt statement', async () => {
    const manager = createManager();
    const service = createService(manager);

    await service.suspendTenant(command);

    const statements = sqlOf(manager.query.mock.calls);
    const gucIndex = statements.findIndex((sql) => sql.includes("set_config('app.current_tenant'"));
    const receiptIndex = statements.findIndex((sql) =>
      sql.includes('auth.tenant_command_receipts'),
    );

    expect(gucIndex).toBeGreaterThanOrEqual(0);
    expect(receiptIndex).toBeGreaterThanOrEqual(0);
    // Order is the whole point: a context set after the INSERT is a context
    // the INSERT never had.
    expect(gucIndex).toBeLessThan(receiptIndex);
  });

  it('binds the command tenant, not some ambient one', async () => {
    const manager = createManager();
    const service = createService(manager);

    await service.suspendTenant(command);

    const gucCall = manager.query.mock.calls.find(([sql]) =>
      String(sql).includes("set_config('app.current_tenant'"),
    );

    expect(gucCall?.[1]).toEqual([TENANT_ID]);
  });

  it('keeps the setting transaction-local so a pooled connection cannot carry it', async () => {
    const manager = createManager();
    const service = createService(manager);

    await service.suspendTenant(command);

    const gucCall = manager.query.mock.calls.find(([sql]) =>
      String(sql).includes("set_config('app.current_tenant'"),
    );

    // Third argument `true` = local to the transaction. Without it the tenant
    // outlives the work on a pooled connection, which is a cross-tenant read
    // waiting to happen - strictly worse than the bug being fixed.
    expect(String(gucCall?.[0])).toContain('$1, true');
  });
});
