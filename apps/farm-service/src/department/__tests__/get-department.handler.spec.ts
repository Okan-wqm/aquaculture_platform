import { createMockDataSource } from '@aquaculture/testing';

import { GetDepartmentHandler } from '../handlers/get-department.handler';
import { GetDepartmentQuery } from '../queries/get-department.query';

describe('GetDepartmentHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('reads the department through the tenant boundary and returns it', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const dept = { id: 'dept-1', tenantId, name: 'Hatchery' };
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(dept);

    const handler = new GetDepartmentHandler(mockDataSource);
    const result = await handler.execute(new GetDepartmentQuery('dept-1', tenantId));

    expect(result).toBe(dept);
  });

  it('loads the site relation only when includeRelations is set', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: 'dept-1', tenantId });

    const handler = new GetDepartmentHandler(mockDataSource);
    await handler.execute(new GetDepartmentQuery('dept-1', tenantId, true));

    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: 'dept-1', tenantId },
      relations: ['site'],
    });
  });

  it('returns null when the department genuinely does not exist (not a masked context failure)', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetDepartmentHandler(mockDataSource);
    const result = await handler.execute(new GetDepartmentQuery('missing', tenantId));

    expect(result).toBeNull();
  });
});
