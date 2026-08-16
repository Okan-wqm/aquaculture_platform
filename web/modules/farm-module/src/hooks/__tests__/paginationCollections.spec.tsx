import React from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import { requestMock } from '../../test-utils/sharedUiMock';
import { useBatchList } from '../useBatches';
import { useTanksList } from '../useTanks';

function createWrapper(): React.FC<React.PropsWithChildren> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }): React.ReactElement {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function pageMetadata(page: number, limit: number, total: number): Record<string, unknown> {
  const totalPages = Math.ceil(total / limit);
  return {
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('exhaustive farm collections', () => {
  it('does not expose the first batch page coordinates as collection metadata', async () => {
    requestMock.mockImplementation(
      async (_query: string, variables: { page: number; limit: number }) => ({
        batches: {
          items:
            variables.page === 1
              ? Array.from({ length: 100 }, (_unused, index) => ({ id: `batch-${index + 1}` }))
              : [{ id: 'batch-101' }],
          ...pageMetadata(variables.page, variables.limit, 101),
        },
      }),
    );

    const { result } = renderHook(() => useBatchList(undefined, { fetchAll: true }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items).toHaveLength(101);
    expect(Object.keys(result.current.data ?? {}).sort()).toEqual(['items', 'total']);
  });

  it('does not synthesize a tank page whose limit is the complete collection size', async () => {
    requestMock.mockImplementation(
      async (_query: string, variables: { pagination: { page: number; limit: number } }) => ({
        equipmentList: {
          items:
            variables.pagination.page === 1
              ? Array.from({ length: 100 }, (_unused, index) => ({ id: `tank-${index + 1}` }))
              : [{ id: 'tank-101' }],
          ...pageMetadata(variables.pagination.page, variables.pagination.limit, 101),
        },
      }),
    );

    const { result } = renderHook(() => useTanksList(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items).toHaveLength(101);
    expect(Object.keys(result.current.data ?? {}).sort()).toEqual(['items', 'total']);
  });
});
