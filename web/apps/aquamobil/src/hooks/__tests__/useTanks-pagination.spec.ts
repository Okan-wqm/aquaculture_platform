/**
 * Tank pagination visibility tests.
 *
 * WHY: farm-service defaults tank list queries to 20 rows. Aquamobil must fetch
 * every tenant tank page so database rows do not disappear from mobile home,
 * detail, and field-operation screens when a tenant has more than one page.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { graphqlRequest } from '@/services/authenticated-fetch';
import { fetchAllTanks } from '../useTanks';
import type { Tank } from '@/types';

vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: vi.fn(),
}));

const mockedGraphqlRequest = vi.mocked(graphqlRequest);

function tank(id: string): Tank {
  return {
    id,
    name: `Tank ${id}`,
    code: id,
    volume: 10,
    status: 'ACTIVE',
    currentBiomass: 0,
    maxBiomass: 100,
    batchMetrics: null,
  };
}

describe('fetchAllTanks', () => {
  beforeEach(() => {
    mockedGraphqlRequest.mockReset();
  });

  it('fetches all tenant tank pages instead of accepting the backend default page size', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => tank(`T-${index + 1}`));
    const secondPage = [tank('T-101')];
    mockedGraphqlRequest
      .mockResolvedValueOnce({ tanks: { items: firstPage, total: 101 } })
      .mockResolvedValueOnce({ tanks: { items: secondPage, total: 101 } });

    await expect(fetchAllTanks()).resolves.toHaveLength(101);

    expect(mockedGraphqlRequest).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      { filter: { offset: 0, limit: 100, sortBy: 'name', sortOrder: 'ASC' } },
    );
    expect(mockedGraphqlRequest).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      { filter: { offset: 100, limit: 100, sortBy: 'name', sortOrder: 'ASC' } },
    );
  });

  it('fails closed when the backend reports more rows but returns an empty page', async () => {
    mockedGraphqlRequest.mockResolvedValueOnce({ tanks: { items: [], total: 1 } });

    await expect(fetchAllTanks()).rejects.toThrow(
      'Invalid response: tanks pagination stopped at 0 of 1',
    );
  });
});
