/**
 * RBAC-HIGH-007 — tenant lifecycle transitions OUT of the operational state
 * terminate the tenant's live sessions.
 *
 * Before the cure, SuspendTenant flipped the status and emitted the event but
 * revoked NOTHING: every logged-in user of the suspended tenant kept full
 * access and silently rotated new tokens for the refresh-token lifetime
 * (days). These tests pin the contract at the single transition point
 * (transitionTenantStatus):
 *   - suspend revokes the tenant's refresh tokens IN the receipt transaction
 *     (atomic with the status write) under a tx-local tenant GUC, and cuts
 *     live access tokens post-commit via the RBAC-HIGH-001 user blacklist;
 *   - a transition INTO the operational state (ActivateTenant) revokes nothing;
 *   - a Redis blacklist failure is non-fatal (the durable kill is in-tx).
 */
import { TenantStatus } from '@platform/event-contracts';

import { TenantProvisioningCommandService } from '../tenant-provisioning-command.service';

const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

interface MockManager {
  query: jest.Mock;
  findOne: jest.Mock;
  save: jest.Mock;
}

function createManager(options: {
  tenantStatus: TenantStatus;
  userRows: Array<{ id: string }>;
}): MockManager {
  const manager: MockManager = {
    query: jest.fn((sql: string) => {
      if (sql.includes('FROM auth.tenant_command_receipts') && sql.trimStart().startsWith('SELECT')) {
        return Promise.resolve([]); // no prior receipt — live execution
      }
      if (sql.includes('SELECT id FROM "auth"."users"')) {
        return Promise.resolve(options.userRows);
      }
      return Promise.resolve([]);
    }),
    findOne: jest.fn().mockResolvedValue({ id: TENANT_ID, status: options.tenantStatus }),
    save: jest.fn((_entity: unknown, value: unknown) => Promise.resolve(value)),
  };
  return manager;
}

function createService(manager: MockManager): {
  service: TenantProvisioningCommandService;
  outbox: { enqueue: jest.Mock };
  revocation: { revokeUserTokens: jest.Mock; isTokenValid: jest.Mock };
} {
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const revocation = {
    revokeUserTokens: jest.fn().mockResolvedValue(undefined),
    isTokenValid: jest.fn().mockResolvedValue(true),
  };
  const dataSource = {
    transaction: jest.fn(
      (_isolation: string, cb: (m: MockManager) => Promise<unknown>) => cb(manager),
    ),
  };
  const service = new TenantProvisioningCommandService(
    {} as never, // tenantRepository — unused on the lifecycle path
    {} as never, // userRepository — unused on the lifecycle path
    {} as never, // invitationRepository — unused on the lifecycle path
    dataSource as never,
    outbox as never,
    revocation as never,
  );
  return { service, outbox, revocation };
}

const suspendCommand = {
  operationId: '44444444-4444-4444-8444-444444444444',
  tenantId: TENANT_ID,
  actor: { id: 'platform-admin', type: 'SUPER_ADMIN' },
  reason: 'payment overdue',
} as never;

describe('TenantProvisioningCommandService — suspend session termination (RBAC-HIGH-007)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('suspend revokes ALL of the tenant users refresh tokens in the receipt transaction, under a tx-local tenant GUC', async () => {
    const manager = createManager({
      tenantStatus: TenantStatus.ACTIVE,
      userRows: [{ id: USER_A }, { id: USER_B }],
    });
    const { service } = createService(manager);

    const result = await service.suspendTenant(suspendCommand);
    expect(result.status).toBe(TenantStatus.SUSPENDED);

    const calls = manager.query.mock.calls.map(([sql]) => String(sql));
    const gucCall = manager.query.mock.calls.find(([sql]) =>
      String(sql).includes("set_config('app.current_tenant'"),
    );
    expect(gucCall).toBeDefined();
    expect(gucCall?.[1]).toEqual([TENANT_ID]);

    const revokeCall = manager.query.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE "auth"."refresh_tokens"'),
    );
    expect(revokeCall).toBeDefined();
    expect(revokeCall?.[1]).toEqual([[USER_A, USER_B], `Tenant ${TenantStatus.SUSPENDED}`]);

    // GUC is established BEFORE the bulk revoke (RLS admits the tenant's rows).
    expect(calls.findIndex((s) => s.includes('set_config'))).toBeLessThan(
      calls.findIndex((s) => s.includes('UPDATE "auth"."refresh_tokens"')),
    );
  });

  it('suspend blacklists each affected user post-commit (fleet-wide access-token cut)', async () => {
    const manager = createManager({
      tenantStatus: TenantStatus.ACTIVE,
      userRows: [{ id: USER_A }, { id: USER_B }],
    });
    const { service, revocation } = createService(manager);

    await service.suspendTenant(suspendCommand);

    expect(revocation.revokeUserTokens).toHaveBeenCalledTimes(2);
    expect(revocation.revokeUserTokens).toHaveBeenCalledWith(USER_A);
    expect(revocation.revokeUserTokens).toHaveBeenCalledWith(USER_B);
  });

  it('a Redis blacklist failure is non-fatal: the command still succeeds (durable kill is in-tx)', async () => {
    const manager = createManager({
      tenantStatus: TenantStatus.ACTIVE,
      userRows: [{ id: USER_A }, { id: USER_B }],
    });
    const { service, revocation } = createService(manager);
    revocation.revokeUserTokens.mockRejectedValue(new Error('redis down'));

    const result = await service.suspendTenant(suspendCommand);

    expect(result.status).toBe(TenantStatus.SUSPENDED);
    expect(revocation.revokeUserTokens).toHaveBeenCalledTimes(2);
  });

  it('a tenant with zero users suspends without issuing the bulk revoke', async () => {
    const manager = createManager({ tenantStatus: TenantStatus.ACTIVE, userRows: [] });
    const { service, revocation } = createService(manager);

    const result = await service.suspendTenant(suspendCommand);

    expect(result.status).toBe(TenantStatus.SUSPENDED);
    expect(
      manager.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE "auth"."refresh_tokens"')),
    ).toBe(false);
    expect(revocation.revokeUserTokens).not.toHaveBeenCalled();
  });

  it('idempotent re-suspend (already SUSPENDED) revokes nothing again', async () => {
    const manager = createManager({
      tenantStatus: TenantStatus.SUSPENDED,
      userRows: [{ id: USER_A }],
    });
    const { service, revocation } = createService(manager);

    const result = await service.suspendTenant(suspendCommand);

    expect(result.status).toBe(TenantStatus.SUSPENDED);
    expect(
      manager.query.mock.calls.some(([sql]) => String(sql).includes('SELECT id FROM "auth"."users"')),
    ).toBe(false);
    expect(revocation.revokeUserTokens).not.toHaveBeenCalled();
  });

  it('ActivateTenant (transition INTO the operational state) revokes nothing', async () => {
    const manager = createManager({
      tenantStatus: TenantStatus.PROVISIONING,
      userRows: [{ id: USER_A }],
    });
    const { service, revocation } = createService(manager);

    const result = await service.activateTenant({
      operationId: '55555555-5555-4555-8555-555555555555',
      tenantId: TENANT_ID,
      actor: { id: 'platform-admin', type: 'SUPER_ADMIN' },
    } as never);

    expect(result.status).toBe(TenantStatus.ACTIVE);
    expect(
      manager.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE "auth"."refresh_tokens"')),
    ).toBe(false);
    expect(revocation.revokeUserTokens).not.toHaveBeenCalled();
  });
});
