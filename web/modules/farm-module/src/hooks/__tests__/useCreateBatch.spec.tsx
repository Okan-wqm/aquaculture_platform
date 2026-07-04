/**
 * useCreateBatch specs.
 *
 * Regression guard for FARM-MEDIUM-133: creating a batch allocates fish into
 * tanks (initialLocations), so it mutates the tank + tank-batch read models
 * exactly like the tracking mutations do. onSuccess must therefore invalidate
 * the `tanks` and `tankBatches` caches — not only `batches/*` — so a freshly
 * created batch is correct-by-default on every surface, not just pages that
 * remember to call refetch() themselves.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import { requestMock, TEST_TENANT_ID } from '../../test-utils/sharedUiMock';
import { routeGraphql } from '../../test-utils/mockGraphqlClient';
import { useCreateBatch, type CreateBatchInput } from '../useBatches';

beforeEach(() => {
  requestMock.mockReset();
  routeGraphql([
    {
      match: 'mutation CreateBatch',
      result: { createBatch: { id: 'batch-1', batchNumber: 'BATCH-1' } },
    },
  ]);
});

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }): React.ReactElement {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const CREATE_INPUT: CreateBatchInput = {
  speciesId: 'sp-1',
  inputType: 'FRY',
  initialQuantity: 1000,
  initialWeight: { avgWeight: 2, totalBiomass: 2 },
  stockedAt: '2026-07-04',
  targetFCR: 1.2,
  supplierId: 'sup-1',
  arrivalMethod: 'TRUCK',
  initialLocations: [{ locationType: 'tank', tankId: 'tank-1', quantity: 1000, biomass: 2 }],
};

describe('useCreateBatch', () => {
  it('invalidates tanks + tankBatches (not just batches) so tank read models refresh', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useCreateBatch(), {
      wrapper: makeWrapper(queryClient),
    });

    await result.current.mutateAsync(CREATE_INPUT);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const invalidatedKeys = invalidateSpy.mock.calls.map(([arg]) => arg?.queryKey);

    expect(invalidatedKeys).toContainEqual(['tenant', TEST_TENANT_ID, 'tanks']);
    expect(invalidatedKeys).toContainEqual(['tenant', TEST_TENANT_ID, 'tankBatches']);
    // The pre-existing batch invalidations must survive the change.
    expect(invalidatedKeys).toContainEqual(['tenant', TEST_TENANT_ID, 'batches', 'list']);
  });
});
