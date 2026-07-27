import { USER_TOKEN_REVOCATION } from '@aquaculture/backend-common/security';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { OutboxPublisher } from '@platform/outbox';

import { Invitation } from '../../../authentication/entities/invitation.entity';
import { User } from '../../../authentication/entities/user.entity';
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

describe('TenantProvisioningCommandService — suspension audit trio', () => {
  let service: TenantProvisioningCommandService;
  let manager: MockManager;
  let outboxPublisher: { enqueue: jest.Mock };

  const seedTenant = (overrides: Partial<Tenant>): Tenant => {
    const tenant = new Tenant();
    Object.assign(tenant, {
      id: 'tenant-1',
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
    tenantId: 'tenant-1',
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
    const dataSource = {
      transaction: jest.fn(async (_isolation: string, work: (m: MockManager) => Promise<unknown>) =>
        work(manager),
      ),
    };
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
        // W5: lokalizasyon komutunun fail-CLOSED denetim izi (lifecycle
        // yolunda çağrılmaz, ancak DI grafiği için sağlanmalıdır).
        { provide: AuditLogService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    service = module.get(TenantProvisioningCommandService);
  });

  it('SUSPENDED transition persists suspendedAt/suspendedReason/suspendedBy atomically with the status write', async () => {
    seedTenant({ status: TenantStatus.ACTIVE });

    const result = await service.suspendTenant(command('Payment overdue'));

    expect(result).toMatchObject({
      tenantId: 'tenant-1',
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
      expect.objectContaining({ aggregateId: 'tenant-1' }),
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
