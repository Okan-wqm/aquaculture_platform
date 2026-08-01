import { DataSource, EntityManager } from 'typeorm';

import {
  TENANT_ERASURE_REQUEST_RECOVERY_STALE_SECONDS,
  TenantErasureEventSubscriber,
  TenantErasureLegalHoldService,
  TenantErasureOutboxPublisher,
  TenantErasureProofHandler,
} from '../handlers/tenant-erasure.handler';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';

function dataSourceWithQuery(query: jest.Mock): {
  dataSource: DataSource;
  manager: EntityManager;
} {
  const dataSource = new DataSource({
    type: 'postgres',
    database: 'tenant-erasure-recovery-spec',
  });
  const manager = new EntityManager(dataSource);
  jest.spyOn(manager, 'query').mockImplementation(query);
  dataSource.transaction = (async <T>(
    work: (transactionalEntityManager: EntityManager) => Promise<T>,
  ): Promise<T> => work(manager)) as DataSource['transaction'];
  return { dataSource, manager };
}

function recoveryRow(): Record<string, unknown> {
  return {
    id: OPERATION_ID,
    tenantId: TENANT_ID,
    requestedBy: USER_ID,
    dryRun: false,
    requestedAt: new Date('2026-07-31T10:00:00.000Z'),
    legalHoldCheckedAt: new Date('2026-07-31T10:00:01.000Z'),
    targetServices: ['farm-service', 'config-service'],
    updatedAt: new Date('2026-07-31T10:01:00.000Z'),
  };
}

function handlerFixture(query: jest.Mock, enqueue = jest.fn().mockResolvedValue(undefined)) {
  const { dataSource, manager } = dataSourceWithQuery(query);
  const outbox: TenantErasureOutboxPublisher = { enqueue };
  const eventBus: TenantErasureEventSubscriber = {
    subscribeWildcard: jest.fn().mockResolvedValue(undefined),
  };
  const legalHold: TenantErasureLegalHoldService = {
    assertNoHold: jest.fn().mockResolvedValue(undefined),
  };
  const handler = new TenantErasureProofHandler(eventBus, dataSource, outbox, legalHold);
  return { handler, manager, outbox };
}

describe('TenantErasureProofHandler request recovery', () => {
  it('transactionally re-enqueues stale incomplete operations and advances their heartbeat', async () => {
    const query = jest.fn().mockResolvedValueOnce([recoveryRow()]).mockResolvedValueOnce([]);
    const { handler, manager, outbox } = handlerFixture(query);

    await handler.recoverStaleErasureRequests();

    expect(query.mock.calls[0]?.[0]).toEqual(expect.stringContaining("status = 'IN_PROGRESS'"));
    expect(query.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining('FOR UPDATE OF operation SKIP LOCKED'),
    );
    expect(query.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining('WHERE NOT (operation.proofs ? target.service)'),
    );
    expect(query.mock.calls[0]?.[1]).toEqual([25, TENANT_ERASURE_REQUEST_RECOVERY_STALE_SECONDS]);
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'TenantErasureRequested',
        tenantId: TENANT_ID,
        operationId: OPERATION_ID,
        requestedBy: USER_ID,
        requestedAt: '2026-07-31T10:00:00.000Z',
        legalHoldCheckedAt: '2026-07-31T10:00:01.000Z',
        dryRun: false,
        targetServiceCount: 2,
      }),
      manager,
      {
        aggregateId: TENANT_ID,
        idempotencyKey: `tenant-erasure:${OPERATION_ID}:recovery:2026-07-31T10:01:00.000Z`,
      },
    );
    expect(query.mock.calls[1]?.[0]).toEqual(expect.stringContaining('SET "updatedAt" = NOW()'));
    expect(query.mock.calls[1]?.[1]).toEqual([OPERATION_ID]);
  });

  it('does not emit for fresh, completed, or already-proofed operations excluded by the claim', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);
    const { handler, outbox } = handlerFixture(query);

    await handler.recoverStaleErasureRequests();

    expect(outbox.enqueue).not.toHaveBeenCalled();
    const claimSql = String(query.mock.calls[0]?.[0]);
    expect(claimSql).toContain("status = 'IN_PROGRESS'");
    expect(claimSql).toContain('operation."updatedAt" <=');
    expect(claimSql).toContain("NOW() - ($2::double precision * INTERVAL '1 second')");
    expect(claimSql).toContain('"schemaDeletionJobId" IS NULL');
    expect(claimSql).toContain('WHERE NOT (operation.proofs ? target.service)');
  });

  it('does not advance the heartbeat when the transactional outbox write fails', async () => {
    const query = jest.fn().mockResolvedValueOnce([recoveryRow()]);
    const enqueue = jest.fn().mockRejectedValue(new Error('outbox unavailable'));
    const { handler } = handlerFixture(query, enqueue);

    await expect(handler.recoverStaleErasureRequests()).rejects.toThrow('outbox unavailable');

    expect(query).toHaveBeenCalledTimes(1);
  });
});
