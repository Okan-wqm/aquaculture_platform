import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { validate } from 'class-validator';

import { AuditLogService } from '../../audit/audit.service';
import { BillingAdminCommandClientService } from '../../billing/services/billing-admin-command-client.service';
import { ModuleAssignmentService } from '../../modules/tenant-management/services/module-assignment.service';
import { CreateTenantDto, TenantProvisioningState } from '../dto/tenant.dto';

import { AuthTenantProvisioningClientService } from './auth-tenant-provisioning-client.service';
import { TelemetryCapacityService } from './telemetry-capacity.service';
import { TenantProvisioningMetricsService } from './tenant-provisioning-metrics.service';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { TenantProvisioningWorkflowService } from './tenant-provisioning-workflow.service';

import { OutboxPublisher } from '@platform/outbox';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';

describe('Tenant telemetry capacity admission', () => {
  afterEach(() => jest.restoreAllMocks());

  it('rejects tenant creation without both capacity dimensions', async () => {
    const dto = Object.assign(new CreateTenantDto(), {
      name: 'Acme Aqua',
      moduleIds: ['33333333-3333-4333-8333-333333333333'],
    });

    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['sustainedIngressMessagesPerSecond', 'sustainedMetricRowsPerMinute']),
    );
  });

  it('persists a pending admission without queueing downstream provisioning', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const query = jest.fn((sql: string): Promise<unknown[]> => {
      if (sql.includes('FROM admin.tenant_provisioning_runs')) return Promise.resolve([]);
      if (sql.includes('INSERT INTO admin.tenant_provisioning_runs')) {
        return Promise.resolve([
          {
            id: OPERATION_ID,
            tenantId: TENANT_ID,
            idempotencyKey: 'capacity-admission-idempotency',
            requestHash: 'request-hash',
            requestPayload: {},
            actorUserId: 'platform-admin-1',
            state: TenantProvisioningState.RESERVING,
            currentStep: null,
            lastError: null,
            attempts: 0,
            startedAt: null,
            completedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]);
      }
      if (sql.includes('admin.tenant_provisioning_steps')) return Promise.resolve([]);
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const manager = {
      query,
      findOne: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((_entity: unknown, value: object) => value),
    };
    const queryRunner = {
      manager,
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const reserveWithinTransaction = jest.fn().mockResolvedValue({
      activationState: 'PENDING_CAPACITY',
    });
    const reserveTenant = jest.fn();
    const moduleRef = await Test.createTestingModule({
      providers: [
        TenantProvisioningWorkflowService,
        {
          provide: getDataSourceToken(),
          useValue: { createQueryRunner: jest.fn().mockReturnValue(queryRunner) },
        },
        { provide: OutboxPublisher, useValue: {} },
        { provide: AuditLogService, useValue: {} },
        { provide: TenantProvisioningService, useValue: {} },
        { provide: ModuleAssignmentService, useValue: {} },
        {
          provide: AuthTenantProvisioningClientService,
          useValue: { reserveTenant },
        },
        { provide: BillingAdminCommandClientService, useValue: {} },
        {
          provide: TenantProvisioningMetricsService,
          useValue: {
            recordRunTerminal: jest.fn(),
            recordStepOutcome: jest.fn(),
            recordActiveRuns: jest.fn(),
          },
        },
        {
          provide: TelemetryCapacityService,
          useValue: { reserveWithinTransaction },
        },
      ],
    }).compile();
    const service = moduleRef.get(TenantProvisioningWorkflowService);

    const result = await service.createTenantOperation(
      Object.assign(new CreateTenantDto(), {
        name: 'Acme Aqua',
        moduleIds: ['33333333-3333-4333-8333-333333333333'],
        sustainedIngressMessagesPerSecond: 20,
        sustainedMetricRowsPerMinute: 1_200,
      }),
      'platform-admin-1',
      'capacity-admission-idempotency',
    );

    expect(reserveWithinTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: expect.any(String),
        tenantId: expect.any(String),
        sustainedIngressMessagesPerSecond: 20,
        sustainedMetricRowsPerMinute: 1_200,
      }),
      manager,
    );
    expect(result.status).toBe(TenantProvisioningState.RESERVING);
    expect(reserveTenant).not.toHaveBeenCalled();
  });
});
