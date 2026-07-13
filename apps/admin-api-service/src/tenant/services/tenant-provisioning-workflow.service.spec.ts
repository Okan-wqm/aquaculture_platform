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
 * Regression guard for ORPHAN-HIGH-214 / the 2026-06 tenant-create-500.
 *
 * `assertNoDuplicateTenant` must NOT take a row lock on auth.tenants: admin-api
 * connects as the least-privilege `admin_service` role (SELECT-only on
 * auth.tenants by SEC-015/D14), and PostgreSQL requires the UPDATE privilege to
 * take any `FOR SHARE`/`FOR UPDATE` row lock. A `lock: { mode: 'pessimistic_*' }`
 * here would 500 with `permission denied for table tenants` once the intended
 * REVOKE is in force. True uniqueness is the auth-service SSoT's job; this
 * pre-check is best-effort UX and must be a plain unlocked SELECT.
 */
describe('TenantProvisioningWorkflowService — duplicate pre-check is unlocked (ORPHAN-HIGH-214)', () => {
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

/**
 * Backfill path (ORPHAN-CRITICAL-393): reconcileTenantSubscription resolves the
 * tenant's assigned modules into priced moduleItems and passes them to the
 * billing provisioning command — the same fixed path tenant creation uses.
 */
describe('TenantProvisioningWorkflowService.reconcileTenantSubscription', () => {
  const TENANT_ID = '22222222-2222-4222-8222-222222222222';
  const MODULE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  let service: TenantProvisioningWorkflowService;
  let provisionTenantSubscription: jest.Mock;
  let resolveProvisioningModuleItems: jest.Mock;

  const resolvedItems = [
    {
      moduleId: MODULE_A,
      code: 'FARM',
      name: 'Farm Management',
      quantities: { moduleId: MODULE_A, farms: 2 },
      lineItems: [],
      subtotal: 100,
      discountAmount: 0,
      total: 100,
    },
  ];

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    const mockDataSource = {
      // findTenantById → SELECT ... FROM auth.tenants
      query: jest.fn().mockResolvedValue([
        {
          id: TENANT_ID,
          name: 'Acme Aqua',
          slug: 'acme-aqua',
          status: 'ACTIVE',
          plan: 'starter',
        },
      ]),
      createQueryRunner: jest.fn(),
    };

    resolveProvisioningModuleItems = jest.fn().mockResolvedValue(resolvedItems);
    provisionTenantSubscription = jest.fn().mockResolvedValue({
      subscriptionId: 'sub-1',
      receiptId: 'receipt-1',
      status: 'active',
      moduleItemCount: 1,
      replayed: false,
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        TenantProvisioningWorkflowService,
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: OutboxPublisher, useValue: {} },
        { provide: AuditLogService, useValue: {} },
        { provide: TenantProvisioningService, useValue: {} },
        {
          provide: ModuleAssignmentService,
          useValue: {
            getTenantModulesWithPricing: jest
              .fn()
              .mockResolvedValue([{ moduleId: MODULE_A, quantities: { farms: 2 } }]),
            resolveProvisioningModuleItems,
          },
        },
        { provide: AuthTenantProvisioningClientService, useValue: {} },
        { provide: BillingAdminCommandClientService, useValue: { provisionTenantSubscription } },
      ],
    }).compile();

    service = moduleRef.get(TenantProvisioningWorkflowService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('resolves priced moduleItems and passes them to the billing provisioning command', async () => {
    const result = await service.reconcileTenantSubscription(TENANT_ID, 'actor-9');

    expect(resolveProvisioningModuleItems).toHaveBeenCalledTimes(1);
    expect(provisionTenantSubscription).toHaveBeenCalledTimes(1);

    const command = provisionTenantSubscription.mock.calls[0][0] as {
      tenantId: string;
      moduleItems: unknown;
      moduleIds: string[];
    };
    expect(command.tenantId).toBe(TENANT_ID);
    expect(command.moduleItems).toEqual(resolvedItems);
    expect(command.moduleIds).toEqual([MODULE_A]);

    expect(result.subscriptionId).toBe('sub-1');
    expect(result.replayed).toBe(false);
  });
});
