import { USER_TOKEN_REVOCATION } from '@aquaculture/backend-common/security';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { OutboxPublisher } from '@platform/outbox';

import { Invitation } from '../../../authentication/entities/invitation.entity';
import { User } from '../../../authentication/entities/user.entity';
import { DurableUserTokenInvalidationService } from '../../../authentication/services/durable-user-token-invalidation.service';
import { Tenant, TenantStatus } from '../../entities/tenant.entity';
import { AuditLogService } from '../../../../audit/audit-log.service';
import { TenantProvisioningCommandService } from '../tenant-provisioning-command.service';

/**
 * DB-ADMIN-HIGH-003 / ORPHAN-HIGH-360 — suspension audit persistence.
 *
 * auth-service is the single writer of auth.tenants (DB-ADMIN-HIGH-004). These
 * tests pin that transitionTenantStatus — the one code path all five lifecycle
 * transitions flow through — persists the suspension audit trio
 * (suspendedAt / suspendedReason / suspendedBy) atomically with the status
 * write on the SUSPENDED transition, clears it on the ACTIVE transition, and
 * leaves it untouched on every other transition so a tenant deactivated OUT of
 * suspension keeps the audit trail of its last suspension.
 */
interface MockManager {
  query: jest.Mock;
  findOne: jest.Mock;
  save: jest.Mock;
}

// auth.tenants.id is a uuid column and the RLS predicate casts the GUC to
// uuid, so a placeholder like 'tenant-1' was never a value this code could
// receive in production. bindTenantRlsContext refuses it, which is how the
// unrealistic fixture surfaced (ORPHAN-CRITICAL-573).
const TENANT_ID = '33333333-3333-4333-8333-333333333333';

describe('TenantProvisioningCommandService — suspension audit trio', () => {
  let service: TenantProvisioningCommandService;
  let manager: MockManager;
  let outboxPublisher: { enqueue: jest.Mock };
  let transaction: jest.Mock;
  let durableInvalidation: { enqueue: jest.Mock; applyImmediately: jest.Mock };

  const seedTenant = (overrides: Partial<Tenant>): Tenant => {
    const tenant = new Tenant();
    Object.assign(tenant, {
      id: TENANT_ID,
      name: 'Test Tenant',
      slug: 'test-tenant',
      status: TenantStatus.ACTIVE,
      ...overrides,
    });
    manager.findOne.mockResolvedValue(tenant);
    return tenant;
  };

  const command = (
    reason?: string,
  ): {
    operationId: string;
    tenantId: string;
    actor: { id: string; type: 'user' };
    reason: string;
  } => ({
    operationId: 'op-1',
    tenantId: TENANT_ID,
    actor: { id: 'admin-1', type: 'user' },
    // SuspendTenantLifecycleCommand/DeprovisionTenantCommand require reason;
    // ActivateTenantCommand ignores the extra property (structural typing).
    reason: reason ?? 'Payment overdue',
  });

  beforeEach(async () => {
    manager = {
      // Covers the receipt SELECT (no prior receipt → []), the receipt INSERT
      // and the receipt SUCCEEDED/FAILED UPDATE in runWithReceipt.
      query: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((_entity, tenant: Tenant) => Promise.resolve(tenant)),
    };
    transaction = jest.fn(async (_isolation: string, work: (m: MockManager) => Promise<unknown>) =>
      work(manager),
    );
    const dataSource = { transaction };
    durableInvalidation = { enqueue: jest.fn(), applyImmediately: jest.fn() };
    outboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantProvisioningCommandService,
        { provide: getRepositoryToken(Tenant), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(User), useValue: {} },
        { provide: getRepositoryToken(Invitation), useValue: {} },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: OutboxPublisher, useValue: outboxPublisher },
        // RBAC-HIGH-007: transitionTenantStatus fleet-revokes holders' live
        // tokens on non-operational transitions (post-commit). The suspension
        // path exercises it, so the collaborator must be provided.
        {
          provide: USER_TOKEN_REVOCATION,
          useValue: {
            revokeUserTokens: jest.fn().mockResolvedValue(undefined),
            isTokenValid: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: DurableUserTokenInvalidationService, useValue: durableInvalidation },
        // W5: lokalizasyon komutunun fail-CLOSED denetim izi (lifecycle
        // yolunda çağrılmaz, ancak DI grafiği için sağlanmalıdır).
        { provide: AuditLogService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    service = module.get(TenantProvisioningCommandService);
  });

  it.each(['40001', '40P01'])(
    'retries the complete receipt transaction for SQLSTATE %s without an aborted-transaction write',
    async (code) => {
      const tenant = seedTenant({ status: TenantStatus.ACTIVE });
      manager.findOne
        .mockRejectedValueOnce(Object.assign(new Error('Database concurrency conflict'), { code }))
        .mockResolvedValueOnce(tenant);
      await expect(service.suspendTenant(command())).resolves.toMatchObject({
        status: TenantStatus.SUSPENDED,
      });
      expect(transaction).toHaveBeenCalledTimes(2);
      expect(
        manager.query.mock.calls.some(
          (call) => typeof call[0] === 'string' && call[0].includes("status = 'FAILED'"),
        ),
      ).toBe(false);
      expect(outboxPublisher.enqueue).toHaveBeenCalledTimes(1);
    },
  );

  it('bounds serialization retries and preserves the original SQLSTATE', async () => {
    const failure = Object.assign(new Error('Concurrent update remains unresolved'), {
      code: '40001',
    });
    transaction.mockRejectedValue(failure);
    await expect(service.suspendTenant(command())).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(durableInvalidation.applyImmediately).not.toHaveBeenCalled();
  });

  it('does not retry domain failures or non-concurrency database errors', async () => {
    const failure = Object.assign(new Error('Audit constraint rejected'), { code: '23514' });
    transaction.mockRejectedValue(failure);
    await expect(service.suspendTenant(command())).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('projects only the successful transaction attempt after a commit-time serialization rollback', async () => {
    const firstUser = '11111111-1111-4111-8111-111111111111';
    const secondUser = '22222222-2222-4222-8222-222222222222';
    let attempt = 0;
    transaction.mockImplementation(
      async (_isolation: string, work: (m: MockManager) => Promise<unknown>) => {
        attempt += 1;
        const result = await work(manager);
        if (attempt === 1)
          throw Object.assign(new Error('Commit serialization conflict'), { code: '40001' });
        return result;
      },
    );
    manager.findOne.mockImplementation(async () =>
      Object.assign(new Tenant(), {
        id: TENANT_ID,
        status: TenantStatus.ACTIVE,
        name: 'Tenant',
        slug: 'retry-tenant',
      }),
    );
    manager.query.mockImplementation(async (sql: string) =>
      sql.includes('SELECT id FROM "auth"."users"')
        ? [{ id: attempt === 1 ? firstUser : secondUser }]
        : [],
    );
    await expect(service.suspendTenant(command())).resolves.toMatchObject({
      status: TenantStatus.SUSPENDED,
    });
    expect(durableInvalidation.enqueue).toHaveBeenCalledTimes(2);
    expect(durableInvalidation.applyImmediately).toHaveBeenCalledTimes(1);
    expect(durableInvalidation.applyImmediately).toHaveBeenCalledWith(
      expect.objectContaining({ userId: secondUser }),
    );
  });

  it('does not project a rolled-back attempt when retry converges on another successful receipt', async () => {
    let attempt = 0;
    let receiptHash: unknown;
    transaction.mockImplementation(
      async (_isolation: string, work: (m: MockManager) => Promise<unknown>) => {
        attempt += 1;
        const result = await work(manager);
        if (attempt === 1)
          throw Object.assign(new Error('Commit serialization conflict'), { code: '40001' });
        return result;
      },
    );
    seedTenant({ status: TenantStatus.ACTIVE });
    manager.query.mockImplementation(async (sql: string, parameters: unknown[]) => {
      if (sql.includes('INSERT INTO auth.tenant_command_receipts')) receiptHash = parameters[5];
      if (attempt === 2 && sql.includes('SELECT "payloadHash"')) {
        return [
          {
            payloadHash: receiptHash,
            status: 'SUCCEEDED',
            entityId: TENANT_ID,
            resultSummary: { tenantId: TENANT_ID, status: TenantStatus.SUSPENDED },
          },
        ];
      }
      return sql.includes('SELECT id FROM "auth"."users"')
        ? [{ id: '11111111-1111-4111-8111-111111111111' }]
        : [];
    });
    await expect(service.suspendTenant(command())).resolves.toMatchObject({
      status: TenantStatus.SUSPENDED,
    });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(durableInvalidation.enqueue).toHaveBeenCalledTimes(1);
    expect(durableInvalidation.applyImmediately).not.toHaveBeenCalled();
  });

  it('SUSPENDED transition persists suspendedAt/suspendedReason/suspendedBy atomically with the status write', async () => {
    seedTenant({ status: TenantStatus.ACTIVE });

    const result = await service.suspendTenant(command('Payment overdue'));

    expect(result).toMatchObject({
      tenantId: TENANT_ID,
      status: TenantStatus.SUSPENDED,
      previousStatus: TenantStatus.ACTIVE,
      reason: 'Payment overdue',
    });
    expect(manager.save).toHaveBeenCalledTimes(1);
    const saved = manager.save.mock.calls[0][1] as Tenant;
    expect(saved.status).toBe(TenantStatus.SUSPENDED);
    expect(saved.suspendedAt).toBeInstanceOf(Date);
    expect(saved.suspendedReason).toBe('Payment overdue');
    expect(saved.suspendedBy).toBe('admin-1');
    // The durable TenantStatusChanged event commits in the same transaction.
    expect(outboxPublisher.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'TenantStatusChanged',
        previousStatus: TenantStatus.ACTIVE,
        newStatus: TenantStatus.SUSPENDED,
        reason: 'Payment overdue',
      }),
      manager,
      expect.objectContaining({ aggregateId: TENANT_ID }),
    );
  });

  it('ACTIVE transition clears all three suspension audit fields', async () => {
    // Stale trio on a PROVISIONING row is synthetic, but it pins the clearing
    // rule for EVERY path into ACTIVE — an active tenant is never "suspended".
    seedTenant({
      status: TenantStatus.PROVISIONING,
      suspendedAt: new Date('2026-01-01T00:00:00Z'),
      suspendedReason: 'old reason',
      suspendedBy: 'old-admin',
    });

    const result = await service.activateTenant(command());

    expect(result).toMatchObject({ status: TenantStatus.ACTIVE });
    expect(manager.save).toHaveBeenCalledTimes(1);
    const saved = manager.save.mock.calls[0][1] as Tenant;
    expect(saved.suspendedAt).toBeNull();
    expect(saved.suspendedReason).toBeNull();
    expect(saved.suspendedBy).toBeNull();
  });

  it('idempotent re-suspend (already SUSPENDED) is a no-op: nothing saved, trio untouched', async () => {
    const suspendedAt = new Date('2026-06-01T00:00:00Z');
    seedTenant({
      status: TenantStatus.SUSPENDED,
      suspendedAt,
      suspendedReason: 'original reason',
      suspendedBy: 'original-admin',
    });

    const result = await service.suspendTenant(command('retry reason'));

    expect(result).toMatchObject({ status: TenantStatus.SUSPENDED });
    expect(manager.save).not.toHaveBeenCalled();
    expect(outboxPublisher.enqueue).not.toHaveBeenCalled();
  });

  it('DEACTIVATED transition out of suspension preserves the suspension audit trail', async () => {
    const suspendedAt = new Date('2026-06-01T00:00:00Z');
    seedTenant({
      status: TenantStatus.SUSPENDED,
      suspendedAt,
      suspendedReason: 'Payment overdue',
      suspendedBy: 'admin-1',
    });

    const result = await service.deprovisionTenant(command('Contract ended'));

    expect(result).toMatchObject({
      status: TenantStatus.DEACTIVATED,
      previousStatus: TenantStatus.SUSPENDED,
    });
    const saved = manager.save.mock.calls[0][1] as Tenant;
    expect(saved.status).toBe(TenantStatus.DEACTIVATED);
    expect(saved.suspendedAt).toBe(suspendedAt);
    expect(saved.suspendedReason).toBe('Payment overdue');
    expect(saved.suspendedBy).toBe('admin-1');
  });
});
