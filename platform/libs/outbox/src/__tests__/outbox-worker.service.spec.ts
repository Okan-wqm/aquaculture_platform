import type { DataSource, EntityManager, Repository } from 'typeorm';
import type { IEventBus } from '@platform/event-bus';
import { OutboxEntityBase } from '../outbox-entity.base';
import { OutboxMetricsService } from '../outbox-metrics.service';
import { OutboxWorkerService } from '../outbox-worker.service';

class TestOutbox extends OutboxEntityBase {}

describe('OutboxWorkerService', () => {
  it('claims rows by sequence and gates later events for the same aggregate', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const update = jest.fn().mockResolvedValue(undefined);
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: EntityManager) => Promise<unknown>) =>
        callback({ query, update } as unknown as EntityManager),
      ),
    } as unknown as DataSource;

    const worker = new OutboxWorkerService(
      TestOutbox,
      dataSource,
      { isConnected: jest.fn(() => true) } as unknown as IEventBus,
      {} as OutboxMetricsService,
    );
    (worker as unknown as { repo: Repository<OutboxEntityBase> }).repo = {
      metadata: { tableName: 'test_outbox' },
    } as Repository<OutboxEntityBase>;

    await (worker as unknown as { acquireLease: () => Promise<OutboxEntityBase[]> })
      .acquireLease();

    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('ORDER BY candidate."sequence" ASC');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('prior."aggregateId" = candidate."aggregateId"');
    expect(sql).toContain('prior."sequence" < candidate."sequence"');
  });
});
