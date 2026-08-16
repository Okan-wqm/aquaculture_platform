import { USER_TOKEN_REVOCATION } from '@aquaculture/backend-common/security';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { OutboxPublisher } from '@platform/outbox';

import { Invitation } from '../../../authentication/entities/invitation.entity';
import { User } from '../../../authentication/entities/user.entity';
import { Tenant, TenantStatus } from '../../entities/tenant.entity';
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
  let transaction: jest.Mock;
  const activationProof = Object.freeze({
    schemaVersion: 'tenant-onboarding-activation-proof.v1' as const,
    generation: 3,
    sealToken: '44444444-4444-4444-8444-444444444444',
    evidenceRoot: 'a'.repeat(64),
    publicationDigest: 'b'.repeat(64),
  });

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
    // SuspendTenantLifecycleCommand/DeprovisionTenantCommand require reason.
    reason: reason ?? 'Payment overdue',
  });

  const activationCommand = () => ({
    operationId: '33333333-3333-4333-8333-333333333333',
    tenantId: 'tenant-1',
    actor: { id: 'admin-1', type: 'user' as const },
    activationProof,
  });

  beforeEach(async () => {
    manager = {
      // Covers the receipt SELECT (no prior receipt → []), the receipt INSERT
      // and the receipt SUCCEEDED/FAILED UPDATE in runWithReceipt.
      query: jest.fn(async (sqlValue: unknown) => {
        if (String(sqlValue).includes('admin.consume_tenant_onboarding_activation')) {
          return [
            {
              evidenceRoot: activationProof.evidenceRoot,
              publicationDigest: activationProof.publicationDigest,
            },
          ];
        }
        return [];
      }),
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((_entity, tenant: Tenant) => Promise.resolve(tenant)),
    };
    transaction = jest.fn(async (_isolation: string, work: (m: MockManager) => Promise<unknown>) =>
      work(manager),
    );
    const dataSource = { transaction };
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
        userId: 'admin-1',
      }),
      manager,
      expect.objectContaining({ aggregateId: 'tenant-1' }),
    );
  });

  it('fails the source-owner transaction when lifecycle outbox evidence cannot be enqueued', async () => {
    seedTenant({ status: TenantStatus.ACTIVE });
    outboxPublisher.enqueue.mockRejectedValueOnce(new Error('outbox unavailable'));

    await expect(service.suspendTenant(command('Payment overdue'))).rejects.toThrow(
      'outbox unavailable',
    );

    expect(transaction).toHaveBeenCalledWith('SERIALIZABLE', expect.any(Function));
    expect(
      manager.query.mock.calls.some(([sql]) => String(sql).includes("status = 'SUCCEEDED'")),
    ).toBe(false);
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

    const result = await service.activateTenant(activationCommand());

    expect(result).toMatchObject({ status: TenantStatus.ACTIVE });
    expect(manager.save).toHaveBeenCalledTimes(1);
    const saved = manager.save.mock.calls[0][1] as Tenant;
    expect(saved.suspendedAt).toBeNull();
    expect(saved.suspendedReason).toBeNull();
    expect(saved.suspendedBy).toBeNull();
    const admissionCall = manager.query.mock.calls.find(([sql]) =>
      String(sql).includes('admin.consume_tenant_onboarding_activation'),
    );
    expect(admissionCall?.[1]).toEqual([
      '33333333-3333-4333-8333-333333333333',
      'tenant-1',
      activationProof.generation,
      activationProof.sealToken,
      activationProof.evidenceRoot,
      activationProof.publicationDigest,
    ]);
    const admissionIndex = manager.query.mock.calls.findIndex(([sql]) =>
      String(sql).includes('admin.consume_tenant_onboarding_activation'),
    );
    const admissionOrder = manager.query.mock.invocationCallOrder[admissionIndex];
    expect(admissionOrder).toBeDefined();
    expect(admissionOrder).toBeLessThan(manager.save.mock.invocationCallOrder[0]!);
    expect(admissionOrder).toBeLessThan(outboxPublisher.enqueue.mock.invocationCallOrder[0]!);
  });

  it('resumes only a suspended tenant without consuming an onboarding activation seal', async () => {
    seedTenant({
      status: TenantStatus.SUSPENDED,
      suspendedAt: new Date('2026-06-01T00:00:00Z'),
      suspendedReason: 'Payment overdue',
      suspendedBy: 'admin-1',
    });

    const result = await service.resumeTenant(command());

    expect(result).toMatchObject({
      status: TenantStatus.ACTIVE,
      previousStatus: TenantStatus.SUSPENDED,
    });
    const saved = manager.save.mock.calls[0]?.[1] as Tenant;
    expect(saved.suspendedAt).toBeNull();
    expect(saved.suspendedReason).toBeNull();
    expect(saved.suspendedBy).toBeNull();
    expect(
      manager.query.mock.calls.some(([sql]) =>
        String(sql).includes('admin.consume_tenant_onboarding_activation'),
      ),
    ).toBe(false);
  });

  it('does not let ResumeTenant become a second provisioning activation authority', async () => {
    seedTenant({ status: TenantStatus.PROVISIONING });

    await expect(service.resumeTenant(command())).rejects.toThrow(
      'this command requires one of [SUSPENDED] to reach ACTIVE',
    );

    expect(manager.save).not.toHaveBeenCalled();
    expect(outboxPublisher.enqueue).not.toHaveBeenCalled();
  });

  it('rolls back before tenant or outbox mutation when activation admission rejects', async () => {
    seedTenant({ status: TenantStatus.PROVISIONING });
    manager.query.mockImplementation(async (sqlValue: unknown) => {
      if (String(sqlValue).includes('admin.consume_tenant_onboarding_activation')) {
        throw new Error('tenant onboarding activation proof is stale');
      }
      return [];
    });

    await expect(service.activateTenant(activationCommand())).rejects.toThrow(
      'tenant onboarding activation proof is stale',
    );

    expect(manager.save).not.toHaveBeenCalled();
    expect(outboxPublisher.enqueue).not.toHaveBeenCalled();
  });

  it('rejects an admission response that differs from the command-bound roots', async () => {
    seedTenant({ status: TenantStatus.PROVISIONING });
    manager.query.mockImplementation(async (sqlValue: unknown) => {
      if (String(sqlValue).includes('admin.consume_tenant_onboarding_activation')) {
        return [
          {
            evidenceRoot: 'c'.repeat(64),
            publicationDigest: activationProof.publicationDigest,
          },
        ];
      }
      return [];
    });

    await expect(service.activateTenant(activationCommand())).rejects.toThrow(
      'returned a different proof',
    );
    expect(manager.save).not.toHaveBeenCalled();
    expect(outboxPublisher.enqueue).not.toHaveBeenCalled();
  });

  it('rejects malformed proof before opening the SERIALIZABLE transaction', async () => {
    await expect(
      service.activateTenant({
        ...activationCommand(),
        activationProof: { ...activationProof, generation: 0 },
      }),
    ).rejects.toThrow('positive integer');

    expect(transaction).not.toHaveBeenCalled();
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
