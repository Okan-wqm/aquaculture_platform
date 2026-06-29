/**
 * GetStorageLocationNameHandler — fail-closed tenant boundary (FARM-HIGH-060).
 * Resolves the location display name, or null when the location is absent
 * (the InventoryCountResponse.locationName field is nullable by design).
 */
import { createMockDataSource } from '@aquaculture/testing';

import { GetStorageLocationNameHandler } from '../handlers/get-storage-location-name.handler';
import { GetStorageLocationNameQuery } from '../queries/get-storage-location-name.query';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('GetStorageLocationNameHandler (fail-closed tenant boundary)', () => {
  it('returns the location name scoped to the tenant', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: 'loc-1', name: 'Main Warehouse' });

    const result = await new GetStorageLocationNameHandler(mockDataSource).execute(
      new GetStorageLocationNameQuery(tenantId, 'loc-1'),
    );

    expect(result).toBe('Main Warehouse');
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: 'loc-1', tenantId },
      select: { id: true, name: true },
    });
  });

  it('returns null when the location is absent (does not crash the nullable field)', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const result = await new GetStorageLocationNameHandler(mockDataSource).execute(
      new GetStorageLocationNameQuery(tenantId, 'missing'),
    );

    expect(result).toBeNull();
  });
});
