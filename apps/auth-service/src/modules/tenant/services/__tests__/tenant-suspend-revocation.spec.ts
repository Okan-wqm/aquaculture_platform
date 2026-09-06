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
import {
  TenantStatus,
  type AuthTenantCommandMetadata,
  type SuspendTenantLifecycleCommand,
} from '@platform/event-contracts';
import { collaborator, stub } from '@aquaculture/testing';

import { AuditLog } from '../../../../audit/audit-log.entity';
import { DurableUserTokenInvalidationService } from '../../../authentication/services/durable-user-token-invalidation.service';
import { AuditLogService } from '../../../../audit/audit-log.service';
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
      if (
        sql.includes('FROM auth.tenant_command_receipts') &&
        sql.trimStart().startsWith('SELECT')
      ) {
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
  revocation: { enqueue: jest.Mock; applyImmediately: jest.Mock };
} {
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const revocation = {
    enqueue: jest.fn().mockResolvedValue(undefined),
    applyImmediately: jest.fn().mockResolvedValue(undefined),
  };
  const dataSource = {
    transaction: jest.fn((_isolation: string, cb: (m: MockManager) => Promise<unknown>) =>
      cb(manager),
    ),
  };
  const service = new TenantProvisioningCommandService(
    {} as never, // tenantRepository — unused on the lifecycle path
    {} as never, // userRepository — unused on the lifecycle path
    {} as never, // invitationRepository — unused on the lifecycle path
    dataSource as never,
    outbox as never,
    { revokeUserTokens: jest.fn(), isTokenValid: jest.fn() } as never,
    collaborator<DurableUserTokenInvalidationService>(
      revocation,
      'DurableUserTokenInvalidationService',
    ),
    // W5: lokalizasyon yazımının fail-CLOSED denetim izi (lifecycle yolunda
    // kullanılmaz). Tipli çift: `AuditLogService.log` imzası değişirse bu
    // satır DERLEME zamanında kırılır, ve lifecycle yolu beklenmedik bir
    // denetim üyesine dokunursa MissingDoubleMemberError adıyla patlar.
    collaborator<AuditLogService>(
      { log: jest.fn(() => Promise.resolve(stub<AuditLog>({}))) },
      'AuditLogService',
    ),
  );
  return { service, outbox, revocation };
}

// `actor.type` is 'user' | 'service' | 'system' on AuthTenantCommandActor. This
// fixture said 'SUPER_ADMIN', which the union does not admit — a platform admin
// suspending a tenant is a 'user'. The blanket cast on the whole literal hid it,
// this RBAC-HIGH-007 regression guard was driving the service with a command
// shape the contract rejects. Typed at the real command now, which also proves
// `reason` is where SuspendTenantLifecycleCommand declares it.
const suspendCommand: SuspendTenantLifecycleCommand = {
  operationId: '44444444-4444-4444-8444-444444444444',
  tenantId: TENANT_ID,
  actor: { id: 'platform-admin', type: 'user' },
  reason: 'payment overdue',
};

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

    expect(revocation.applyImmediately).toHaveBeenCalledTimes(2);
    const intents = revocation.enqueue.mock.calls.map(([, intent]) => intent);
    expect(intents).toEqual([
      expect.objectContaining({
        userId: USER_A,
        tenantId: TENANT_ID,
        invalidatedAt: expect.any(Date),
      }),
      expect.objectContaining({
        userId: USER_B,
        tenantId: TENANT_ID,
        invalidatedAt: expect.any(Date),
      }),
    ]);
    expect(intents[0].invalidatedAt).toBe(intents[1].invalidatedAt);
    expect(revocation.applyImmediately).toHaveBeenNthCalledWith(1, intents[0]);
    expect(revocation.applyImmediately).toHaveBeenNthCalledWith(2, intents[1]);
  });

  it('a Redis blacklist failure is non-fatal: the command still succeeds (durable kill is in-tx)', async () => {
    const manager = createManager({
      tenantStatus: TenantStatus.ACTIVE,
      userRows: [{ id: USER_A }, { id: USER_B }],
    });
    const { service, revocation } = createService(manager);
    revocation.applyImmediately.mockRejectedValue(new Error('redis down'));

    const result = await service.suspendTenant(suspendCommand);

    expect(result.status).toBe(TenantStatus.SUSPENDED);
    expect(revocation.applyImmediately).toHaveBeenCalledTimes(2);
  });

  it('a tenant with zero users suspends without issuing the bulk revoke', async () => {
    const manager = createManager({ tenantStatus: TenantStatus.ACTIVE, userRows: [] });
    const { service, revocation } = createService(manager);

    const result = await service.suspendTenant(suspendCommand);

    expect(result.status).toBe(TenantStatus.SUSPENDED);
    expect(
      manager.query.mock.calls.some(([sql]) =>
        String(sql).includes('UPDATE "auth"."refresh_tokens"'),
      ),
    ).toBe(false);
    expect(revocation.applyImmediately).not.toHaveBeenCalled();
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
      manager.query.mock.calls.some(([sql]) =>
        String(sql).includes('SELECT id FROM "auth"."users"'),
      ),
    ).toBe(false);
    expect(revocation.applyImmediately).not.toHaveBeenCalled();
  });

  it('ActivateTenant (transition INTO the operational state) revokes nothing', async () => {
    const manager = createManager({
      tenantStatus: TenantStatus.PROVISIONING,
      userRows: [{ id: USER_A }],
    });
    const { service, revocation } = createService(manager);

    const activateCommand: AuthTenantCommandMetadata = {
      operationId: '55555555-5555-4555-8555-555555555555',
      tenantId: TENANT_ID,
      actor: { id: 'platform-admin', type: 'user' },
    };
    const result = await service.activateTenant(activateCommand);

    expect(result.status).toBe(TenantStatus.ACTIVE);
    expect(
      manager.query.mock.calls.some(([sql]) =>
        String(sql).includes('UPDATE "auth"."refresh_tokens"'),
      ),
    ).toBe(false);
    expect(revocation.applyImmediately).not.toHaveBeenCalled();
  });
});
