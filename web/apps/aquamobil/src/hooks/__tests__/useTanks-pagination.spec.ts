/**
 * Tank pagination visibility tests.
 *
 * WHY: farm-service defaults tank list queries to 20 rows. Aquamobil must fetch
 * every tenant tank page so database rows do not disappear from mobile home,
 * detail, and field-operation screens when a tenant has more than one page.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchAllTanks } from '../useTanks';

import { graphqlRequest } from '@/services/authenticated-fetch';

vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: vi.fn(),
}));

const mockedGraphqlRequest = vi.mocked(graphqlRequest);

/**
 * A single `farmStockInventory.items[]` element — the wire shape `fetchAllTanks`
 * actually reads and maps via `mapInventoryItemToTank` (NOT a flat `Tank`). The
 * test only asserts page count + call args, so the container fields just need to
 * be present and well-typed for the mapper to run without throwing.
 */
function inventoryItem(id: string): {
  container: {
    containerId: string;
    name: string;
    code: string;
    volume: number | null;
    status: string | null;
    currentQuantity: number | null;
    currentBiomassKg: number | null;
    maxBiomassKg: number | null;
    capacityUsedPercent: number | null;
    isOverCapacity: boolean;
  };
  batches: never[];
} {
  return {
    container: {
      containerId: id,
      name: `Tank ${id}`,
      code: id,
      volume: 10,
      status: 'ACTIVE',
      currentQuantity: 0,
      currentBiomassKg: 0,
      maxBiomassKg: 100,
      capacityUsedPercent: 0,
      isOverCapacity: false,
    },
    batches: [],
  };
}

describe('fetchAllTanks', () => {
  beforeEach(() => {
    mockedGraphqlRequest.mockReset();
  });

  it('fetches all tenant tank pages instead of accepting the backend default page size', async () => {
    // The page size is 100 (TANK_PAGE_SIZE); the loop pages until tanks.length >= total.
    const firstPage = Array.from({ length: 100 }, (_, index) => inventoryItem(`T-${index + 1}`));
    const secondPage = [inventoryItem('T-101')];
    mockedGraphqlRequest
      .mockResolvedValueOnce({ farmStockInventory: { items: firstPage, total: 101 } })
      .mockResolvedValueOnce({ farmStockInventory: { items: secondPage, total: 101 } });

    await expect(fetchAllTanks()).resolves.toHaveLength(101);

    // S1-CODEGEN: the first arg is now a gql DocumentNode (not a bare string), and
    // the farm-service `farmStockInventory` query is page-based (page/limit/isActive).
    expect(mockedGraphqlRequest).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ kind: 'Document' }),
      { filter: { page: 1, limit: 100, isActive: true } },
    );
    expect(mockedGraphqlRequest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: 'Document' }),
      { filter: { page: 2, limit: 100, isActive: true } },
    );
  });

  it('fails closed when the backend reports more rows but returns an empty page', async () => {
    mockedGraphqlRequest.mockResolvedValueOnce({
      farmStockInventory: { items: [], total: 1 },
    });

    await expect(fetchAllTanks()).rejects.toThrow(
      'Invalid response: tanks pagination stopped at 0 of 1',
    );
  });
});
