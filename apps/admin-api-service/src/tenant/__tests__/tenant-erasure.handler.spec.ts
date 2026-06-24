import { LegalHoldService } from '@aquaculture/backend-common/compliance';
import { BadRequestException } from '@nestjs/common';
import { IEventBus } from '@platform/event-bus';
import { TenantDataErasedEvent, TenantStatus } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';

import { AuditLogService } from '../../audit/audit.service';
import { RequestTenantErasureCommand } from '../commands/tenant.commands';
import {
  RequestTenantErasureHandler,
  TenantErasureProofHandler,
} from '../handlers/tenant-erasure.handler';
import { Tenant } from '../entities/tenant.entity';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';

function createDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    database: 'tenant-erasure-handler-spec',
  });
}

function createQueryRunner(manager: EntityManager): QueryRunner {
  return Object.assign({} as QueryRunner, {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    isTransactionActive: true,
    manager,
  });
}

function assignTransaction(
  dataSource: DataSource,
  manager: EntityManager,
): void {
  dataSource.transaction = (async <T>(
    first:
      | ((transactionalEntityManager: EntityManager) => Promise<T>)
      | string,
    second?: (transactionalEntityManager: EntityManager) => Promise<T>,
  ): Promise<T> => {
    const work = typeof first === 'function' ? first : second;
    if (!work) {
      throw new Error('transaction callback missing');
    }
    return work(manager);
  }) as DataSource['transaction'];
}

function createOutboxPublisher(): Pick<OutboxPublisher, 'enqueue'> {
  return {
    enqueue: jest.fn().mockResolvedValue(undefined),
  };
}

function createLegalHoldService(): Pick<LegalHoldService, 'assertNoHold'> {
  return {
    assertNoHold: jest.fn().mockResolvedValue(undefined),
  };
}

function createAuditLogService(): Pick<AuditLogService, 'log'> {
  return {
    log: jest.fn().mockResolvedValue(undefined),
  };
}

describe('RequestTenantErasureHandler', () => {
  it('requires archived tenant state and enqueues TenantErasureRequested in the same transaction', async () => {
    const tenant = new Tenant();
    Object.assign(tenant, { id: TENANT_ID, status: TenantStatus.ARCHIVED });

    const manager = {
      findOne: jest.fn().mockResolvedValue(tenant),
      query: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(undefined),
    } as Partial<EntityManager> as EntityManager;
    const queryRunner = createQueryRunner(manager);
    const dataSource = createDataSource();
    jest.spyOn(dataSource, 'createQueryRunner').mockReturnValue(queryRunner);

    const outbox = createOutboxPublisher();
    const legalHold = createLegalHoldService();
    const audit = createAuditLogService();
    const handler = new RequestTenantErasureHandler(
      dataSource,
      outbox as OutboxPublisher,
      legalHold as LegalHoldService,
      audit as AuditLogService,
    );

    const result = await handler.execute(
      new RequestTenantErasureCommand(
        TENANT_ID,
        'data subject request',
        USER_ID,
        true,
      ),
    );

    expect(result).toEqual({
      operationId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
      tenantId: TENANT_ID,
      status: 'IN_PROGRESS',
    });
    expect(legalHold.assertNoHold).toHaveBeenCalledWith(TENANT_ID, 'tenant');
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin.tenant_erasure_operations'),
      expect.arrayContaining([result.operationId, TENANT_ID, USER_ID]),
    );
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'TenantErasureRequested',
        tenantId: TENANT_ID,
        operationId: result.operationId,
        requestedBy: USER_ID,
        dryRun: true,
        targetServiceCount: 10,
      }),
      manager,
      {
        aggregateId: TENANT_ID,
        idempotencyKey: `tenant-erasure:${result.operationId}:requested`,
      },
    );
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('rejects non-archived tenants before event emission', async () => {
    const tenant = new Tenant();
    Object.assign(tenant, { id: TENANT_ID, status: TenantStatus.ACTIVE });

    const manager = {
      findOne: jest.fn().mockResolvedValue(tenant),
      query: jest.fn(),
    } as Partial<EntityManager> as EntityManager;
    const queryRunner = createQueryRunner(manager);
    const dataSource = createDataSource();
    jest.spyOn(dataSource, 'createQueryRunner').mockReturnValue(queryRunner);

    const outbox = createOutboxPublisher();
    const handler = new RequestTenantErasureHandler(
      dataSource,
      outbox as OutboxPublisher,
      createLegalHoldService() as LegalHoldService,
      createAuditLogService() as AuditLogService,
    );

    await expect(
      handler.execute(
        new RequestTenantErasureCommand(TENANT_ID, 'data subject request', USER_ID),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('TenantErasureProofHandler', () => {
  it('finalizes the operation and emits final TenantErased when all target proofs are present', async () => {
    const tenant = new Tenant();
    Object.assign(tenant, { id: TENANT_ID, status: TenantStatus.ARCHIVED });

    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: OPERATION_ID,
            tenantId: TENANT_ID,
            status: 'IN_PROGRESS',
            requestedBy: USER_ID,
            reason: 'data subject request',
            requestedAt: new Date('2026-06-20T10:00:00.000Z'),
            legalHoldCheckedAt: new Date('2026-06-20T10:00:01.000Z'),
            targetServices: ['farm-service'],
            proofs: {},
            failures: [],
            schemaDeletionJobId: null,
            schemaDeletionRequestedAt: null,
            schemaDeletedAt: null,
          },
        ])
        .mockResolvedValueOnce([
          {
            schemaName: 'tenant_1111111111114111',
            status: 'active',
            tableCount: '12',
          },
        ])
        .mockResolvedValueOnce([{ nspname: 'tenant_1111111111114111' }])
        .mockResolvedValueOnce([{ jobId: '55555555-5555-4555-8555-555555555555' }])
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce([
          {
            jobId: '55555555-5555-4555-8555-555555555555',
            schemaName: 'tenant_1111111111114111',
            jobStatus: 'DELETED',
            schemaLedgerStatus: 'deleted',
            schemaExists: false,
            tableCount: '0',
            requestedAt: '2026-06-20T10:00:03.000Z',
            deletedAt: '2026-06-20T10:00:04.000Z',
            failureResidue: {},
            errorMessage: null,
          },
        ])
        .mockResolvedValueOnce(undefined),
      findOne: jest.fn().mockResolvedValue(tenant),
      save: jest.fn().mockResolvedValue(tenant),
    } as Partial<EntityManager> as EntityManager;
    const dataSource = createDataSource();
    assignTransaction(dataSource, manager);

    const outbox = createOutboxPublisher();
    const legalHold = createLegalHoldService();
    const eventBus = {
      subscribeWildcard: jest.fn().mockResolvedValue(undefined),
    } as Pick<IEventBus, 'subscribeWildcard'> as IEventBus;
    const handler = new TenantErasureProofHandler(
      eventBus,
      dataSource,
      outbox as OutboxPublisher,
      legalHold as LegalHoldService,
    );

    const proof: TenantDataErasedEvent = {
      eventId: '44444444-4444-4444-8444-444444444444' as TenantDataErasedEvent['eventId'],
      eventType: 'TenantDataErased',
      timestamp: '2026-06-20T10:00:02.000Z',
      tenantId: TENANT_ID,
      version: 1,
      aggregateId: TENANT_ID,
      aggregateType: 'Tenant',
      operationId: OPERATION_ID,
      targetService: 'farm-service',
      erasedAt: '2026-06-20T10:00:02.000Z',
      dryRun: false,
      matchedRecordCount: 5,
      erasedRecordCount: 5,
      proofHash: 'sha256:service-proof',
    };

    await handler.handle(proof);

    expect(legalHold.assertNoHold).toHaveBeenCalledWith(TENANT_ID, 'tenant');
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('platform.request_tenant_schema_deletion'),
      expect.arrayContaining([OPERATION_ID, TENANT_ID, 'tenant_1111111111114111']),
    );
    expect(tenant.status).toBe(TenantStatus.PURGED);
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'TenantErased',
        tenantId: TENANT_ID,
        operationId: OPERATION_ID,
        requestedBy: USER_ID,
        targetServiceCount: 1,
        proofHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        proofVersion: 1,
      }),
      manager,
      {
        aggregateId: TENANT_ID,
        idempotencyKey: `tenant-erasure:${OPERATION_ID}:final`,
      },
    );
    expect(manager.query).toHaveBeenLastCalledWith(
      expect.stringContaining("SET status = 'COMPLETED'"),
      expect.arrayContaining([OPERATION_ID]),
    );
  });
});
