import { ConflictException, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';

import { AuditLogService } from '../../audit/audit.service';
import { BillingAdminCommandClientService } from '../../billing/services/billing-admin-command-client.service';
import { ModuleAssignmentService } from '../../modules/tenant-management/services/module-assignment.service';
import { CreateTenantDto, TenantProvisioningState } from '../dto/tenant.dto';

import { AuthTenantProvisioningClientService } from './auth-tenant-provisioning-client.service';
import { TenantProvisioningMetricsService } from './tenant-provisioning-metrics.service';
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
        {
          provide: TenantProvisioningMetricsService,
          useValue: {
            recordRunTerminal: jest.fn(),
            recordStepOutcome: jest.fn(),
            recordActiveRuns: jest.fn(),
          },
        },
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
        {
          provide: TenantProvisioningMetricsService,
          useValue: {
            recordRunTerminal: jest.fn(),
            recordStepOutcome: jest.fn(),
            recordActiveRuns: jest.fn(),
          },
        },
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

/**
 * ORPHAN-HIGH-575 — the provisioning saga verified its own bookkeeping, not the
 * database.
 *
 * `assertDbMigrateProvisionedTenantSchema` joined admin.tenant_schemas to
 * platform.tenant_schema_jobs and, if both rows agreed, declared the tenant
 * schema provisioned. Two ledger rows agreeing with each other is not evidence
 * that `tenant_<id>` exists. Production proved it: a tenant reached ACTIVE with
 * no physical schema at all. These tests pin the physical reconciliation at both
 * gates (verification AND activation) and the step detail the poll response must
 * now carry.
 */
describe('TenantProvisioningWorkflowService — ledger vs physical reality (ORPHAN-HIGH-575)', () => {
  const TENANT_ID = '22222222-2222-4222-8222-222222222222';
  const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
  const LEASE_TOKEN = '44444444-4444-4444-8444-444444444444';
  const MODULE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const EXPECTED_SCHEMA = 'tenant_2222222222224222';
  const LEDGER_TABLE_COUNT = 42;

  interface PhysicalFacts {
    schemaExists: boolean;
    tableCount: number;
  }

  interface StepRow {
    stepName: string;
    state: TenantProvisioningState;
    stepOrder: number;
    attempts: number;
    lastError: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
  }

  interface Harness {
    service: TenantProvisioningWorkflowService;
    query: jest.Mock;
    activateTenant: jest.Mock;
    failProvisioning: jest.Mock;
  }

  const runRow = (state: TenantProvisioningState = TenantProvisioningState.RUNNING): object => ({
    id: OPERATION_ID,
    tenantId: TENANT_ID,
    idempotencyKey: 'idem-key-0123456789abcdef',
    requestHash: 'e3b0c44298fc1c149afbf4c8996fb924',
    requestPayload: {
      name: 'Acme Aqua',
      slug: 'acme-aqua',
      moduleIds: [MODULE_A],
      billingCycle: 'monthly',
    },
    actorUserId: 'actor-1',
    state,
    currentStep: null,
    lastError: null,
    attempts: 1,
    nextRetryAt: null,
    leaseToken: LEASE_TOKEN,
    leasedBy: 'admin-api:1',
    heartbeatAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 60_000),
    startedAt: new Date(),
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  /**
   * Routes every SQL the saga issues to a canned result so `processOperation`
   * can be driven end to end. `physicalFacts` is a queue: entry N answers the
   * Nth pg_catalog probe, which is how "the schema vanished between the
   * verification step and activation" is expressed.
   */
  const createHarness = async (options: {
    physicalFacts: PhysicalFacts[];
    stepRows?: StepRow[];
    runState?: TenantProvisioningState;
    /**
     * ADMIN-HIGH-009: answers to each `platform.tenant_schema_jobs` status
     * read, in order; the last one repeats. Default: always COMMITTED.
     */
    jobStatuses?: string[];
  }): Promise<Harness> => {
    const physicalFacts = [...options.physicalFacts];
    const stepRows = options.stepRows ?? [];
    const lastPhysicalFacts = options.physicalFacts[options.physicalFacts.length - 1];
    const jobStatuses = [...(options.jobStatuses ?? ['COMMITTED'])];
    const lastJobStatus = jobStatuses[jobStatuses.length - 1];

    const query = jest.fn((sql: string, params: unknown[] = []): Promise<unknown[]> => {
      if (sql.includes('pg_catalog.pg_namespace')) {
        return Promise.resolve([physicalFacts.shift() ?? lastPhysicalFacts]);
      }
      if (sql.includes('platform.request_tenant_schema_provisioning')) {
        return Promise.resolve([{ job_id: 'job-1' }]);
      }
      if (sql.includes('FROM platform.tenant_schema_jobs')) {
        const status = jobStatuses.shift() ?? lastJobStatus;
        return Promise.resolve([
          { status, errorMessage: status === 'FAILED' ? 'replay aborted' : null },
        ]);
      }
      if (sql.includes('ts."schemaName" AS "schemaName"')) {
        return Promise.resolve([
          {
            schemaName: EXPECTED_SCHEMA,
            tableCount: LEDGER_TABLE_COUNT,
            evidenceOperationId: OPERATION_ID,
            jobStatus: 'COMMITTED',
          },
        ]);
      }
      if (sql.includes('SELECT ts."tableCount" AS "tableCount"')) {
        return Promise.resolve([{ tableCount: LEDGER_TABLE_COUNT }]);
      }
      if (sql.includes('admin.tenant_onboarding_acks')) {
        return Promise.resolve([{ service: 'farm-service', status: 'ACK', error: null }]);
      }
      if (sql.includes('FROM auth.tenants')) {
        return Promise.resolve([
          {
            id: TENANT_ID,
            name: 'Acme Aqua',
            slug: 'acme-aqua',
            status: 'PROVISIONING',
            plan: 'starter',
            settings: null,
            customDomain: null,
            description: null,
            contactEmail: null,
            contactPhone: null,
            createdBy: 'actor-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]);
      }
      if (sql.includes('admin.tenant_provisioning_steps')) {
        // A one-parameter SELECT is getRunSteps (whole run); the two-parameter
        // one is runStep's "did this step already succeed?" probe, answered
        // from the same rows so a test can pre-mark a step SUCCEEDED.
        if (sql.trimStart().startsWith('SELECT')) {
          return Promise.resolve(
            params.length === 1
              ? stepRows
              : stepRows.filter((row) => row.stepName === String(params[1])),
          );
        }
        return Promise.resolve([
          {
            stepName: String(params[1]),
            state: TenantProvisioningState.RUNNING,
            stepOrder: 1,
            attempts: 1,
            lastError: null,
            startedAt: new Date(),
            completedAt: null,
          },
        ]);
      }
      if (sql.includes('admin.tenant_provisioning_runs')) {
        return Promise.resolve([runRow(options.runState)]);
      }
      return Promise.resolve([]);
    });

    const eventQueryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager: { query: jest.fn().mockResolvedValue([]) },
    };

    const activateTenant = jest.fn().mockResolvedValue(undefined);
    const failProvisioning = jest.fn().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        TenantProvisioningWorkflowService,
        {
          provide: getDataSourceToken(),
          useValue: {
            query,
            createQueryRunner: jest.fn().mockReturnValue(eventQueryRunner),
          },
        },
        { provide: OutboxPublisher, useValue: { enqueue: jest.fn().mockResolvedValue(undefined) } },
        { provide: AuditLogService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: TenantProvisioningService,
          useValue: { provisionTenant: jest.fn().mockResolvedValue({ success: true }) },
        },
        {
          provide: ModuleAssignmentService,
          useValue: {
            assignModulesToTenant: jest
              .fn()
              .mockResolvedValue({ success: true, failedModules: [] }),
            resolveProvisioningModuleItems: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: AuthTenantProvisioningClientService,
          useValue: {
            reserveTenant: jest.fn().mockResolvedValue(undefined),
            beginProvisioning: jest.fn().mockResolvedValue(undefined),
            activateTenant,
            failProvisioning,
          },
        },
        {
          // The workflow now reports every step outcome to the metrics
          // service (this branch's feature); the harness merged from main
          // predates the dependency.
          provide: TenantProvisioningMetricsService,
          useValue: {
            recordRunTerminal: jest.fn(),
            recordStepOutcome: jest.fn(),
            recordActiveRuns: jest.fn(),
          },
        },
        {
          provide: BillingAdminCommandClientService,
          useValue: {
            provisionTenantSubscription: jest
              .fn()
              .mockResolvedValue({ subscriptionId: 'sub-1', receiptId: 'receipt-1' }),
          },
        },
      ],
    }).compile();

    return {
      service: moduleRef.get(TenantProvisioningWorkflowService),
      query,
      activateTenant,
      failProvisioning,
    };
  };

  /** Every terminal write to a provisioning step, in execution order. */
  const stepOutcomes = (query: jest.Mock): Array<{ step: string; state: string; error?: string }> =>
    query.mock.calls
      .filter(
        ([sql]) =>
          typeof sql === 'string' &&
          sql.includes('UPDATE admin.tenant_provisioning_steps') &&
          sql.includes('SET state = $3'),
      )
      .map(([, params]) => {
        const args = params as unknown[];
        const state = String(args[2]);
        return state === TenantProvisioningState.FAILED
          ? { step: String(args[1]), state, error: String(args[3]) }
          : { step: String(args[1]), state };
      });

  const probeCount = (query: jest.Mock): number =>
    query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('pg_catalog.pg_namespace'),
    ).length;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('fails the verification step when the ledger is complete but the physical schema is absent', async () => {
    // The exact production shape: admin.tenant_schemas active + job COMMITTED +
    // tableCount 42, and no such schema in the database.
    const { service, query, activateTenant } = await createHarness({
      physicalFacts: [{ schemaExists: false, tableCount: 0 }],
    });

    await service.processOperation(OPERATION_ID);

    const failed = stepOutcomes(query).find((outcome) => outcome.state === 'FAILED');
    expect(failed?.step).toBe('wait_for_db_migrate_provisioner');
    expect(failed?.error).toContain(EXPECTED_SCHEMA);
    expect(failed?.error).toContain('physical schema does not exist');
    // The whole point: the saga must not walk past a missing schema to ACTIVE.
    expect(activateTenant).not.toHaveBeenCalled();
  });

  it('fails the verification step when the schema exists but holds fewer tables than the ledger claims', async () => {
    const { service, query, activateTenant } = await createHarness({
      physicalFacts: [{ schemaExists: true, tableCount: LEDGER_TABLE_COUNT - 1 }],
    });

    await service.processOperation(OPERATION_ID);

    const failed = stepOutcomes(query).find((outcome) => outcome.state === 'FAILED');
    expect(failed?.step).toBe('wait_for_db_migrate_provisioner');
    expect(failed?.error).toContain(`has ${LEDGER_TABLE_COUNT - 1} tables`);
    expect(activateTenant).not.toHaveBeenCalled();
  });

  it('activates when the ledger and the physical schema agree', async () => {
    const { service, query, activateTenant, failProvisioning } = await createHarness({
      physicalFacts: [{ schemaExists: true, tableCount: LEDGER_TABLE_COUNT }],
    });

    await service.processOperation(OPERATION_ID);

    expect(stepOutcomes(query).filter((outcome) => outcome.state === 'FAILED')).toEqual([]);
    expect(activateTenant).toHaveBeenCalledTimes(1);
    expect(failProvisioning).not.toHaveBeenCalled();
  });

  it('treats a table surplus as normal drift, not corruption', async () => {
    // MIGRATE jobs legitimately add tables after the PROVISION job wrote its
    // count, so only a SHORTFALL may fail the run.
    const { service, activateTenant } = await createHarness({
      physicalFacts: [{ schemaExists: true, tableCount: LEDGER_TABLE_COUNT + 5 }],
    });

    await service.processOperation(OPERATION_ID);

    expect(activateTenant).toHaveBeenCalledTimes(1);
  });

  it('re-verifies immediately before activation, so a schema that disappears mid-run blocks ACTIVE', async () => {
    // First probe: healthy (verification step passes). Second probe: the schema
    // is gone. Without the activation-time re-check this run would flip the
    // tenant ACTIVE over nothing — runStep skips SUCCEEDED steps on retry, so
    // the earlier evidence can never be refreshed.
    const { service, query, activateTenant } = await createHarness({
      physicalFacts: [
        { schemaExists: true, tableCount: LEDGER_TABLE_COUNT },
        { schemaExists: false, tableCount: 0 },
      ],
    });

    await service.processOperation(OPERATION_ID);

    expect(probeCount(query)).toBe(2);
    const failed = stepOutcomes(query).find((outcome) => outcome.state === 'FAILED');
    expect(failed?.step).toBe('activate_tenant');
    expect(failed?.error).toContain('physical schema does not exist');
    expect(activateTenant).not.toHaveBeenCalled();
  });

  it('returns per-step detail with lastError from the polling endpoint', async () => {
    const { service } = await createHarness({
      physicalFacts: [{ schemaExists: true, tableCount: LEDGER_TABLE_COUNT }],
      runState: TenantProvisioningState.FAILED,
      stepRows: [
        {
          stepName: 'reserve_auth_tenant',
          state: TenantProvisioningState.SUCCEEDED,
          stepOrder: 1,
          attempts: 1,
          lastError: null,
          startedAt: new Date(),
          completedAt: new Date(),
        },
        {
          stepName: 'wait_for_db_migrate_provisioner',
          state: TenantProvisioningState.FAILED,
          stepOrder: 6,
          attempts: 3,
          lastError: `tenant schema ledger claims ${EXPECTED_SCHEMA} is active for tenant ${TENANT_ID}, but the physical schema does not exist at wait_for_db_migrate_provisioner`,
          startedAt: new Date(),
          completedAt: new Date(),
        },
      ],
    });

    const response = await service.getOperation(OPERATION_ID);

    expect(response.status).toBe(TenantProvisioningState.FAILED);
    expect(response.steps).toHaveLength(2);
    expect(response.steps[0]).toMatchObject({
      name: 'reserve_auth_tenant',
      state: TenantProvisioningState.SUCCEEDED,
      attempts: 1,
    });
    // "FAILED" alone told the operator nothing; the step name, its attempts and
    // its lastError are what make the outage diagnosable from the API.
    const verificationStep = response.steps[1];
    expect(verificationStep).toMatchObject({
      name: 'wait_for_db_migrate_provisioner',
      state: TenantProvisioningState.FAILED,
      attempts: 3,
    });
    expect(verificationStep?.lastError).toContain('physical schema does not exist');
  });

  describe('a retried run re-issues the provisioning request its first attempt published (ADMIN-HIGH-009)', () => {
    const succeededPublishStep: StepRow = {
      stepName: 'publish_provisioning_requested',
      state: TenantProvisioningState.SUCCEEDED,
      stepOrder: 5,
      attempts: 1,
      lastError: null,
      startedAt: new Date(),
      completedAt: new Date(),
    };

    const requestCount = (query: jest.Mock): number =>
      query.mock.calls.filter(
        ([sql]) =>
          typeof sql === 'string' && sql.includes('platform.request_tenant_schema_provisioning'),
      ).length;

    it('runs the SUCCEEDED publish step again when the job it published has FAILED', async () => {
      // The retry shape: retryOperation kept the publish row SUCCEEDED, the
      // provisioner has since marked the job FAILED. The postcondition probe
      // reads FAILED; once re-issued the job is REQUESTED and then COMMITTED.
      const { service, query, activateTenant } = await createHarness({
        physicalFacts: [{ schemaExists: true, tableCount: LEDGER_TABLE_COUNT }],
        stepRows: [succeededPublishStep],
        jobStatuses: ['FAILED', 'COMMITTED'],
      });

      await service.processOperation(OPERATION_ID);

      expect(requestCount(query)).toBe(1);
      expect(stepOutcomes(query)).toContainEqual({
        step: 'publish_provisioning_requested',
        state: TenantProvisioningState.SUCCEEDED,
      });
      expect(activateTenant).toHaveBeenCalledTimes(1);
    });

    it('leaves the SUCCEEDED publish step alone when its job is still outstanding or committed', async () => {
      const { service, query, activateTenant } = await createHarness({
        physicalFacts: [{ schemaExists: true, tableCount: LEDGER_TABLE_COUNT }],
        stepRows: [succeededPublishStep],
        jobStatuses: ['COMMITTED'],
      });

      await service.processOperation(OPERATION_ID);

      expect(requestCount(query)).toBe(0);
      expect(
        stepOutcomes(query).some((outcome) => outcome.step === 'publish_provisioning_requested'),
      ).toBe(false);
      expect(activateTenant).toHaveBeenCalledTimes(1);
    });

    it('still fails a first attempt whose job FAILED instead of re-issuing it in a loop', async () => {
      // No SUCCEEDED publish row: the step publishes once, the wait step reads
      // the FAILED job and fails the run. Only an explicit retry re-issues.
      const { service, query, activateTenant } = await createHarness({
        physicalFacts: [{ schemaExists: true, tableCount: LEDGER_TABLE_COUNT }],
        jobStatuses: ['FAILED'],
      });

      await service.processOperation(OPERATION_ID);

      expect(requestCount(query)).toBe(1);
      const failed = stepOutcomes(query).find((outcome) => outcome.state === 'FAILED');
      expect(failed?.step).toBe('wait_for_db_migrate_provisioner');
      expect(failed?.error).toContain('failed operation');
      expect(activateTenant).not.toHaveBeenCalled();
    });
  });
});
