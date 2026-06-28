import { ConflictException, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';

import { AuditLogService } from '../../audit/audit.service';
import { BillingAdminCommandClientService } from '../../billing/services/billing-admin-command-client.service';
import { ModuleAssignmentService } from '../../modules/tenant-management/services/module-assignment.service';
import { CreateTenantDto } from '../dto/tenant.dto';

import { AuthTenantProvisioningClientService } from './auth-tenant-provisioning-client.service';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { TenantProvisioningWorkflowService } from './tenant-provisioning-workflow.service';

import { OutboxPublisher } from '@platform/outbox';

/**
 * Regression guard for ORPHAN-HIGH-133 / the 2026-06 tenant-create-500.
 *
 * `assertNoDuplicateTenant` must NOT take a row lock on auth.tenants: admin-api
 * connects as the least-privilege `admin_service` role (SELECT-only on
 * auth.tenants by SEC-015/D14), and PostgreSQL requires the UPDATE privilege to
 * take any `FOR SHARE`/`FOR UPDATE` row lock. A `lock: { mode: 'pessimistic_*' }`
 * here would 500 with `permission denied for table tenants` once the intended
 * REVOKE is in force. True uniqueness is the auth-service SSoT's job; this
 * pre-check is best-effort UX and must be a plain unlocked SELECT.
 */
describe('TenantProvisioningWorkflowService — duplicate pre-check is unlocked (ORPHAN-HIGH-133)', () => {
  let service: TenantProvisioningWorkflowService;
  let findOne: jest.Mock;

  const VALID_IDEMPOTENCY_KEY = 'idem-key-0123456789abcdef';

  const buildDto = (overrides: Partial<CreateTenantDto> = {}): CreateTenantDto =>
    ({
      name: 'Acme Aqua Farms',
      moduleIds: ['11111111-1111-1111-1111-111111111111'],
      ...overrides,
    }) as CreateTenantDto;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    findOne = jest.fn();
    const mockManager = {
      // The synchronous existing-run lookup (managerRows → manager.query) must
      // return no in-flight run so the flow reaches assertNoDuplicateTenant.
      query: jest.fn().mockResolvedValue([]),
      findOne,
      create: jest.fn((_entity: unknown, value: unknown) => value),
    };
    const mockQueryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager: mockManager,
    };
    const mockDataSource = {
      createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
      query: jest.fn().mockResolvedValue([]),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TenantProvisioningWorkflowService,
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: OutboxPublisher, useValue: {} },
        { provide: AuditLogService, useValue: {} },
        { provide: TenantProvisioningService, useValue: {} },
        { provide: ModuleAssignmentService, useValue: {} },
        { provide: AuthTenantProvisioningClientService, useValue: {} },
        { provide: BillingAdminCommandClientService, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(TenantProvisioningWorkflowService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects a duplicate slug with ConflictException and takes NO row lock', async () => {
    findOne.mockResolvedValueOnce({ id: 'existing-tenant', slug: 'acme-aqua-farms' });

    await expect(
      service.createTenantOperation(buildDto(), 'actor-1', VALID_IDEMPOTENCY_KEY),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(findOne).toHaveBeenCalledTimes(1);
    const [, options] = findOne.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(options).not.toHaveProperty('lock');
  });

  it('rejects a duplicate custom domain with ConflictException and takes NO row lock', async () => {
    // slug is free, customDomain collides.
    findOne
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 'existing-tenant', customDomain: 'acme.example.com' });

    await expect(
      service.createTenantOperation(
        buildDto({ domain: 'acme.example.com' }),
        'actor-1',
        VALID_IDEMPOTENCY_KEY,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(findOne).toHaveBeenCalledTimes(2);
    for (const call of findOne.mock.calls) {
      const [, options] = call as [unknown, Record<string, unknown>];
      expect(options).not.toHaveProperty('lock');
    }
  });
});
