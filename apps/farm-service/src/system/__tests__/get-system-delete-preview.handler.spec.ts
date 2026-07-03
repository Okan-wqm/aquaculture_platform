import { NotFoundException } from '@nestjs/common';

import { createMockDataSource } from '@aquaculture/testing';

import { GetSystemDeletePreviewQuery } from '../queries/get-system-delete-preview.query';
import { GetSystemDeletePreviewHandler } from '../handlers/get-system-delete-preview.handler';

describe('GetSystemDeletePreviewHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const systemId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  const makeQb = (rows: unknown[]) => ({
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  });

  it('returns a delete preview read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();

    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({
      id: systemId,
      name: 'Main System',
      code: 'SYS-1',
    });
    // First children level returns one child, second level returns [] (default) to terminate.
    (mockManager.find as jest.Mock).mockResolvedValueOnce([
      { id: 'child-1', name: 'Child System', code: 'SYS-1-A' },
    ]);

    const qb = makeQb([
      {
        systemId: 'child-1',
        equipment: { id: 'eq-1', name: 'Pump', code: 'EQ-1', status: 'active' },
      },
    ]);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new GetSystemDeletePreviewHandler(mockDataSource);
    const result = await handler.execute(
      new GetSystemDeletePreviewQuery(systemId, tenantId),
    );

    expect(result.system).toEqual({ id: systemId, name: 'Main System', code: 'SYS-1' });
    expect(result.canDelete).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.affectedItems.childSystems).toHaveLength(1);
    expect(result.affectedItems.childSystems[0]).toEqual({
      id: 'child-1',
      name: 'Child System',
      code: 'SYS-1-A',
      equipmentCount: 1,
    });
    expect(result.affectedItems.equipment).toHaveLength(1);
    expect(result.affectedItems.totalCount).toBe(2);
    expect(qb.where).toHaveBeenCalledWith('es.systemId IN (:...systemIds)', {
      systemIds: [systemId, 'child-1'],
    });
  });

  it('throws NotFoundException when the system does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetSystemDeletePreviewHandler(mockDataSource);

    await expect(
      handler.execute(new GetSystemDeletePreviewQuery(systemId, tenantId)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
