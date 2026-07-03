import { createMockDataSource } from '@aquaculture/testing';
import { NotFoundException } from '@nestjs/common';

import { GetDepartmentDeletePreviewHandler } from '../handlers/get-department-delete-preview.handler';
import { GetDepartmentDeletePreviewQuery } from '../queries/get-department-delete-preview.query';

describe('GetDepartmentDeletePreviewHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const departmentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns a delete preview read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();

    const department = { id: departmentId, tenantId, name: 'Hatchery', isDeleted: false };
    const tanks = [
      { id: 'tank-1', name: 'Tank 1', code: 'T1', currentBiomass: '0' },
      { id: 'tank-2', name: 'Tank 2', code: 'T2', currentBiomass: '12.5' },
    ];
    const equipment = [{ id: 'eq-1', name: 'Pump', code: 'P1', status: 'active' }];

    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(department);
    (mockManager.find as jest.Mock)
      .mockResolvedValueOnce(tanks) // tanks
      .mockResolvedValueOnce(equipment); // equipment

    const handler = new GetDepartmentDeletePreviewHandler(mockDataSource);
    const result = await handler.execute(
      new GetDepartmentDeletePreviewQuery(departmentId, tenantId),
    );

    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: departmentId, tenantId, isDeleted: false },
    });
    expect(result.affectedItems.totalCount).toBe(3);
    expect(result.affectedItems.tanks).toHaveLength(2);
    expect(result.affectedItems.equipment).toHaveLength(1);
    // Tank with active biomass produces a blocker.
    expect(result.canDelete).toBe(false);
    expect(result.blockers).toHaveLength(1);
  });

  it('allows deletion when no tank has active biomass', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();

    const department = { id: departmentId, tenantId, name: 'Hatchery', isDeleted: false };
    const tanks = [{ id: 'tank-1', name: 'Tank 1', code: 'T1', currentBiomass: '0' }];

    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(department);
    (mockManager.find as jest.Mock)
      .mockResolvedValueOnce(tanks) // tanks
      .mockResolvedValueOnce([]); // equipment

    const handler = new GetDepartmentDeletePreviewHandler(mockDataSource);
    const result = await handler.execute(
      new GetDepartmentDeletePreviewQuery(departmentId, tenantId),
    );

    expect(result.canDelete).toBe(true);
    expect(result.blockers).toHaveLength(0);
    expect(result.affectedItems.totalCount).toBe(1);
  });

  it('throws NotFoundException when the department genuinely does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetDepartmentDeletePreviewHandler(mockDataSource);

    await expect(
      handler.execute(new GetDepartmentDeletePreviewQuery(departmentId, tenantId)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
