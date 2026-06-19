import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { TenantStatus } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';

import { AuditLogService } from '../../audit/audit.service';
import {
  ActivateTenantCommand,
  ArchiveTenantCommand,
  DeactivateTenantCommand,
  SuspendTenantCommand,
} from '../commands/tenant.commands';
import { Tenant } from '../entities/tenant.entity';
import {
  ActivateTenantHandler,
  ArchiveTenantHandler,
  DeactivateTenantHandler,
  SuspendTenantHandler,
} from '../handlers/suspend-tenant.handler';
import { AuthTenantProvisioningClientService } from '../services/auth-tenant-provisioning-client.service';

/**
 * MT-HIGH-003: the four admin lifecycle handlers no longer hand-code their
 * precondition (`status !== ACTIVE`, `=== ARCHIVED`, …) — they consult the
 * tenant-status machine via canTransition. These tests pin, for every handler,
 * that EVERY illegal source state is rejected with a BadRequestException BEFORE
 * any side effect (the auth provisioning client is never called), and that the
 * machine's legal source states reach the client. A regression that re-opens an
 * illegal transition (or breaks a legal one) fails here.
 */
const ALL_STATUSES = Object.values(TenantStatus);

interface MockManager {
  findOne: jest.Mock;
  query: jest.Mock;
  save: jest.Mock;
}

interface MockClient {
  suspendTenant: jest.Mock;
  activateTenant: jest.Mock;
  deprovisionTenant: jest.Mock;
  archiveTenant: jest.Mock;
}

describe('Tenant lifecycle handlers — MT-HIGH-003 transition legality', () => {
  let suspendHandler: SuspendTenantHandler;
  let activateHandler: ActivateTenantHandler;
  let deactivateHandler: DeactivateTenantHandler;
  let archiveHandler: ArchiveTenantHandler;

  let manager: MockManager;
  let client: MockClient;
  let outboxPublisher: { enqueue: jest.Mock };

  const seedTenant = (status: TenantStatus): void => {
    const tenant = new Tenant();
    Object.assign(tenant, { id: 'tenant-1', status });
    manager.findOne.mockResolvedValue(tenant);
  };

  beforeEach(async () => {
    manager = {
      findOne: jest.fn(),
      query: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockImplementation((_entity, tenant: Tenant) => Promise.resolve(tenant)),
    };
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager,
    };
    const dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) };
    client = {
      suspendTenant: jest.fn().mockResolvedValue(undefined),
      activateTenant: jest.fn().mockResolvedValue(undefined),
      deprovisionTenant: jest.fn().mockResolvedValue(undefined),
      archiveTenant: jest.fn().mockResolvedValue(undefined),
    };
    outboxPublisher = {
      enqueue: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SuspendTenantHandler,
        ActivateTenantHandler,
        DeactivateTenantHandler,
        ArchiveTenantHandler,
        { provide: getRepositoryToken(Tenant), useValue: {} },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: OutboxPublisher, useValue: outboxPublisher },
        { provide: AuditLogService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: AuthTenantProvisioningClientService, useValue: client },
      ],
    }).compile();

    suspendHandler = module.get(SuspendTenantHandler);
    activateHandler = module.get(ActivateTenantHandler);
    deactivateHandler = module.get(DeactivateTenantHandler);
    archiveHandler = module.get(ArchiveTenantHandler);
  });

  // Each entry encodes the machine's legal source states for the transition the
  // handler performs, plus how to invoke it and which client call it must reach.
  const lifecycleCases: ReadonlyArray<{
    name: string;
    legal: readonly TenantStatus[];
    run: () => Promise<Tenant>;
    client: () => jest.Mock;
  }> = [
    {
      name: 'suspend',
      legal: [TenantStatus.ACTIVE],
      run: () => suspendHandler.execute(new SuspendTenantCommand('tenant-1', { reason: 'x' }, 'admin')),
      client: () => client.suspendTenant,
    },
    {
      name: 'activate',
      legal: [
        TenantStatus.PROVISIONING,
        TenantStatus.SUSPENDED,
        TenantStatus.DEACTIVATED,
        TenantStatus.CANCELLED,
      ],
      run: () => activateHandler.execute(new ActivateTenantCommand('tenant-1', 'admin')),
      client: () => client.activateTenant,
    },
    {
      name: 'deactivate',
      legal: [TenantStatus.ACTIVE, TenantStatus.SUSPENDED],
      run: () => deactivateHandler.execute(new DeactivateTenantCommand('tenant-1', 'x', 'admin')),
      client: () => client.deprovisionTenant,
    },
    {
      name: 'archive',
      legal: [TenantStatus.SUSPENDED, TenantStatus.DEACTIVATED, TenantStatus.CANCELLED],
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
        seedTenant(status);
        await lc.run();
        expect(lc.client()).toHaveBeenCalledTimes(1);
        expect(manager.save).toHaveBeenCalledWith(Tenant, expect.objectContaining({ id: 'tenant-1' }));
        expect(outboxPublisher.enqueue).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: 'TenantStatusChanged',
            tenantId: 'tenant-1',
          }),
          manager,
          { aggregateId: 'tenant-1' },
        );
      });
    });
  }
});
