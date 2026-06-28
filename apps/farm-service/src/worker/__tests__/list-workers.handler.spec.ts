import { createMockDataSource } from '@aquaculture/testing';

import { ListWorkersQuery } from '../queries/list-workers.query';
import { ListWorkersHandler } from '../handlers/list-workers.handler';
import { Worker } from '../entities/worker.entity';

describe('ListWorkersHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const makeWorker = (id: string, firstName: string, lastName: string): Worker =>
    ({ id, firstName, lastName, tenantId, isDeleted: false } as Worker);

  it('returns workers read through the tenant boundary, sorted by decrypted name', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([
      makeWorker('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Zoe', 'Adams'),
      makeWorker('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Alice', 'Baker'),
      makeWorker('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Alice', 'Abbot'),
    ]);

    const handler = new ListWorkersHandler(mockDataSource);
    const result = await handler.execute(new ListWorkersQuery(tenantId));

    expect(mockManager.find).toHaveBeenCalledWith(Worker, {
      where: { tenantId, isDeleted: false },
    });
    expect(result.map((w) => w.id)).toEqual([
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]);
  });

  it('returns an empty array when no workers exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([]);

    const handler = new ListWorkersHandler(mockDataSource);
    const result = await handler.execute(new ListWorkersQuery(tenantId));

    expect(result).toEqual([]);
  });
});
