import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TenantStatus } from '@platform/event-contracts';
import {
  ResumeTenantCommand,
  ArchiveTenantCommand,
  DeactivateTenantCommand,
  SuspendTenantCommand,
} from '../commands/tenant.commands';
import { Tenant } from '../entities/tenant.entity';
import type { TenantSummaryDto } from '../dto/tenant-summary.dto';
import {
  ResumeTenantHandler,
  ArchiveTenantHandler,
  DeactivateTenantHandler,
  SuspendTenantHandler,
} from '../handlers/suspend-tenant.handler';
import { AuthTenantProvisioningClientService } from '../services/auth-tenant-provisioning-client.service';

/**
 * MT-HIGH-003: canonical machine edges bound the lifecycle commands, while
 * command-specific authorization can be a strict subset (ResumeTenant owns
 * only SUSPENDED -> ACTIVE). These tests pin, for every handler, that every
 * unauthorized source is rejected before a side effect and every authorized
 * source reaches the owner client.
 *
 * DB-ADMIN-HIGH-004 (single-writer): the handlers MUST NOT write auth.tenants
 * themselves — auth-service persists the transition and these handlers re-read
 * the fresh row after the NATS reply. The legal-path assertions pin that
 * contract: the client mock simulates the owner's committed write by flipping
 * the shared row's status, and the handler returns the re-read row carrying
 * the owner-written status without a local mutation dependency.
 */
const ALL_STATUSES = Object.values(TenantStatus);

interface MockClient {
  suspendTenant: jest.Mock;
  resumeTenant: jest.Mock;
  deprovisionTenant: jest.Mock;
  archiveTenant: jest.Mock;
}

describe('Tenant lifecycle handlers — MT-HIGH-003 transition legality + DB-ADMIN-HIGH-004 single-writer', () => {
  let suspendHandler: SuspendTenantHandler;
  let resumeHandler: ResumeTenantHandler;
  let deactivateHandler: DeactivateTenantHandler;
  let archiveHandler: ArchiveTenantHandler;

  let tenantRepository: { findOne: jest.Mock };
  let client: MockClient;

  const seedTenant = (status: TenantStatus): Tenant => {
    const tenant = new Tenant();
    Object.assign(tenant, { id: 'tenant-1', status });
    // Pre-read and post-reply re-read resolve the same shared row object — the client mock mutates it
    // to simulate the owner's committed transition.
    tenantRepository.findOne.mockResolvedValue(tenant);
    return tenant;
  };

  beforeEach(async () => {
    tenantRepository = { findOne: jest.fn() };
    client = {
      suspendTenant: jest.fn().mockResolvedValue({ success: true }),
      resumeTenant: jest.fn().mockResolvedValue({ success: true }),
      deprovisionTenant: jest.fn().mockResolvedValue({ success: true }),
      archiveTenant: jest.fn().mockResolvedValue({ success: true }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SuspendTenantHandler,
        ResumeTenantHandler,
        DeactivateTenantHandler,
        ArchiveTenantHandler,
        { provide: getRepositoryToken(Tenant), useValue: tenantRepository },
        { provide: AuthTenantProvisioningClientService, useValue: client },
      ],
    }).compile();

    suspendHandler = module.get(SuspendTenantHandler);
    resumeHandler = module.get(ResumeTenantHandler);
    deactivateHandler = module.get(DeactivateTenantHandler);
    archiveHandler = module.get(ArchiveTenantHandler);
  });

  // Each entry encodes the machine's legal source states for the transition the
  // handler performs, plus how to invoke it and which client call it must reach.
  const lifecycleCases: ReadonlyArray<{
    name: string;
    legal: readonly TenantStatus[];
    target: TenantStatus;
    run: () => Promise<TenantSummaryDto>;
    client: () => jest.Mock;
  }> = [
    {
      name: 'suspend',
      legal: [TenantStatus.ACTIVE],
      target: TenantStatus.SUSPENDED,
      run: () =>
        suspendHandler.execute(new SuspendTenantCommand('tenant-1', { reason: 'x' }, 'admin')),
      client: () => client.suspendTenant,
    },
    {
      name: 'resume',
      legal: [TenantStatus.SUSPENDED],
      target: TenantStatus.ACTIVE,
      run: () => resumeHandler.execute(new ResumeTenantCommand('tenant-1', 'admin')),
      client: () => client.resumeTenant,
    },
    {
      name: 'deactivate',
      legal: [TenantStatus.ACTIVE, TenantStatus.SUSPENDED],
      target: TenantStatus.DEACTIVATED,
      run: () => deactivateHandler.execute(new DeactivateTenantCommand('tenant-1', 'x', 'admin')),
      client: () => client.deprovisionTenant,
    },
    {
      name: 'archive',
      legal: [TenantStatus.SUSPENDED, TenantStatus.DEACTIVATED, TenantStatus.CANCELLED],
      target: TenantStatus.ARCHIVED,
      run: () => archiveHandler.execute(new ArchiveTenantCommand('tenant-1', 'admin')),
      client: () => client.archiveTenant,
    },
  ];

  for (const lc of lifecycleCases) {
    describe(lc.name, () => {
      const illegal = ALL_STATUSES.filter((s) => !lc.legal.includes(s));

      it.each(illegal)(`rejects ${lc.name} from %s with no side effect`, async (status) => {
        seedTenant(status);
        await expect(lc.run()).rejects.toBeInstanceOf(BadRequestException);
        expect(lc.client()).not.toHaveBeenCalled();
      });

      it.each(lc.legal)(`allows ${lc.name} from %s (reaches the auth client)`, async (status) => {
        const tenant = seedTenant(status);
        // Simulate the single writer: auth-service commits the transition
        // before replying, so the re-read observes the target status.
        lc.client().mockImplementationOnce(async () => {
          tenant.status = lc.target;
          return { success: true };
        });

        const returned = await lc.run();

        expect(lc.client()).toHaveBeenCalledTimes(1);
        // Single-writer: admin-api never writes auth.tenants.
        expect(tenantRepository.findOne).toHaveBeenCalledTimes(2);
        // The synchronous return contract carries the owner-written fresh row.
        expect(returned.status).toBe(lc.target);
      });

      it.each(lc.legal)(
        `${lc.name} from %s records no local side effect when the owner rejects the command`,
        async (status) => {
          seedTenant(status);
          lc.client().mockRejectedValueOnce(new BadRequestException('owner rejected'));

          await expect(lc.run()).rejects.toBeInstanceOf(BadRequestException);

          expect(tenantRepository.findOne).toHaveBeenCalledTimes(1);
        },
      );
    });
  }
});
