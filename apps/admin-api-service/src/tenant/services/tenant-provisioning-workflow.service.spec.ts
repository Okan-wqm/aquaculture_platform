import { ConflictException, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { createTenantOnboardingRequirementSnapshot } from '@aquaculture/backend-common/nats';

import { BillingAdminCommandClientService } from '../../billing/services/billing-admin-command-client.service';
import { ModuleAssignmentService } from '../../modules/tenant-management/services/module-assignment.service';
import { CreateTenantDto, TenantProvisioningState } from '../dto/tenant.dto';

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
  let managerQuery: jest.Mock;

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
    managerQuery = jest.fn().mockResolvedValue([]);
    const mockManager = {
      // The synchronous existing-run lookup (managerRows → manager.query) must
      // return no in-flight run so the flow reaches assertNoDuplicateTenant.
      query: managerQuery,
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

  it('persists the compiled requirement snapshot and normalized rows in the operation transaction', async () => {
    findOne.mockResolvedValue(undefined);
    managerQuery.mockImplementation(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      if (sql.includes('INSERT INTO admin.tenant_provisioning_runs')) {
        return [
          {
            id: '33333333-3333-4333-8333-333333333333',
            tenantId: '22222222-2222-4222-8222-222222222222',
            idempotencyKey: VALID_IDEMPOTENCY_KEY,
            requestHash: 'request-hash',
            requestPayload: buildDto(),
            actorUserId: 'actor-1',
            state: TenantProvisioningState.QUEUED,
            attempts: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ];
      }
      return [];
    });

    await service.createTenantOperation(buildDto(), 'actor-1', VALID_IDEMPOTENCY_KEY);

    const runInsert = managerQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO admin.tenant_provisioning_runs'),
    );
    const requirementInsert = managerQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO admin.tenant_onboarding_requirements'),
    );
    if (!runInsert || !requirementInsert) {
      throw new Error('operation snapshot writes were not issued');
    }
    const runParams = runInsert[1] as unknown[];
    const requirementParams = requirementInsert[1] as unknown[];
    const snapshot = createTenantOnboardingRequirementSnapshot();
    expect(JSON.parse(String(runParams[7]))).toEqual(snapshot);
    expect(runParams[8]).toBe(snapshot.snapshotDigest);
    expect(requirementParams.slice(2)).toEqual([1, 'farm-service', snapshot.snapshotDigest]);
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

describe('TenantProvisioningWorkflowService — durable onboarding activation barrier', () => {
  const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
  const TENANT_ID = '22222222-2222-4222-8222-222222222222';
  const LEASE_TOKEN = '44444444-4444-4444-8444-444444444444';
  const snapshot = createTenantOnboardingRequirementSnapshot();

  async function harness(onboardingStatus: 'ACK' | null): Promise<{
    service: TenantProvisioningWorkflowService;
    markers: string[];
    activateTenant: jest.Mock;
    enqueue: jest.Mock;
    query: jest.Mock;
  }> {
    const markers: string[] = [];
    const completedSteps = new Set([
      'reserve_auth_tenant',
      'begin_provisioning',
      'assign_modules',
      'publish_provisioning_requested',
      'wait_for_db_migrate_provisioner',
      'provision_application_resources',
      'create_subscription',
      'publish_onboarding_requested',
    ]);
    const run = {
      id: OPERATION_ID,
      tenantId: TENANT_ID,
      idempotencyKey: 'barrier-idempotency-key',
      requestHash: 'request-hash',
      requestPayload: { name: 'Barrier Tenant', moduleIds: ['module-1'] },
      actorUserId: 'actor-1',
      state: TenantProvisioningState.RUNNING,
      currentStep: null,
      lastError: null,
      attempts: 1,
      leaseToken: LEASE_TOKEN,
      onboardingQualification: 'QUALIFIED',
      onboardingGeneration: 1,
      onboardingRequirements: snapshot,
      onboardingRequirementsDigest: snapshot.snapshotDigest,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const query = jest.fn(async (sqlValue: unknown, paramsValue?: unknown) => {
      const sql = String(sqlValue);
      const params = Array.isArray(paramsValue) ? paramsValue : [];
      if (sql.includes('AND state IN ($3, $4)')) {
        return [run];
      }
      if (sql.includes('FROM auth.tenants')) {
        return [
          {
            id: TENANT_ID,
            name: 'Barrier Tenant',
            slug: 'barrier-tenant',
            status: 'PROVISIONING',
            plan: 'starter',
            settings: {},
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ];
      }
      if (sql.includes('FROM admin.tenant_provisioning_steps') && sql.includes('LIMIT 1')) {
        const stepName = String(params[1]);
        return [
          {
            stepName,
            state: completedSteps.has(stepName)
              ? TenantProvisioningState.SUCCEEDED
              : TenantProvisioningState.QUEUED,
            attempts: 0,
            lastError: null,
            startedAt: null,
            completedAt: null,
          },
        ];
      }
      if (sql.includes('AS requirements') && sql.includes('tenant_onboarding_requirements')) {
        markers.push('barrier-evidence');
        return [
          {
            requirements: snapshot,
            requirementsDigest: snapshot.snapshotDigest,
            qualification: 'QUALIFIED',
            generation: 1,
            requestedAt: new Date(Date.now() - 60_000),
            deadlineAt: new Date(Date.now() + 60_000),
            safetyFailure: null,
            service: 'farm-service',
            requirementDigest: snapshot.snapshotDigest,
            status: onboardingStatus,
            error: null,
            acknowledgedAt: onboardingStatus === 'ACK' ? new Date() : null,
          },
        ];
      }
      if (sql.includes('seal_tenant_onboarding_activation')) {
        markers.push('db-activation-seal');
        return [
          {
            sealToken: '55555555-5555-4555-8555-555555555555',
            generation: 1,
            evidenceRoot: 'a'.repeat(64),
            publicationDigest: 'b'.repeat(64),
          },
        ];
      }
      return [run];
    });
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager: {},
    };
    const activateTenant = jest.fn(async () => {
      markers.push('activate');
      return { tenantId: TENANT_ID };
    });
    const enqueue = jest.fn(async (event: { eventType: string }) => {
      markers.push(`outbox-${event.eventType}`);
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        TenantProvisioningWorkflowService,
        {
          provide: getDataSourceToken(),
          useValue: { query, createQueryRunner: jest.fn(() => queryRunner) },
        },
        { provide: OutboxPublisher, useValue: { enqueue } },
        { provide: TenantProvisioningService, useValue: {} },
        { provide: ModuleAssignmentService, useValue: {} },
        {
          provide: AuthTenantProvisioningClientService,
          useValue: { activateTenant, failProvisioning: jest.fn() },
        },
        { provide: BillingAdminCommandClientService, useValue: {} },
      ],
    }).compile();
    return {
      service: moduleRef.get(TenantProvisioningWorkflowService),
      markers,
      activateTenant,
      enqueue,
      query,
    };
  }

  it('parks the operation without activation or final outbox when an ACK is missing', async () => {
    const test = await harness(null);

    await test.service.processOperation(OPERATION_ID);

    expect(test.activateTenant).not.toHaveBeenCalled();
    expect(test.enqueue).not.toHaveBeenCalled();
    expect(
      test.query.mock.calls.some(
        ([sql, params]) =>
          String(sql).includes('attempts = GREATEST(attempts - 1, 0)') &&
          Array.isArray(params) &&
          params.includes(TenantProvisioningState.WAITING_ONBOARDING),
      ),
    ).toBe(true);
  });

  it('orders durable evidence gate before activation and the final outbox', async () => {
    const test = await harness('ACK');

    await test.service.processOperation(OPERATION_ID);

    expect(test.markers).toEqual([
      'barrier-evidence',
      'db-activation-seal',
      'activate',
      'outbox-TenantProvisioned',
      'outbox-TenantCreated',
    ]);
    expect(test.activateTenant).toHaveBeenCalledTimes(1);
    expect(test.activateTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        activationProof: {
          schemaVersion: 'tenant-onboarding-activation-proof.v1',
          generation: 1,
          sealToken: '55555555-5555-4555-8555-555555555555',
          evidenceRoot: 'a'.repeat(64),
          publicationDigest: 'b'.repeat(64),
        },
      }),
    );
  });
});
