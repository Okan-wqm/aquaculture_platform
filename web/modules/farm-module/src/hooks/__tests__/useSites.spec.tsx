import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import { requestMock } from '../../test-utils/sharedUiMock';
import { useSiteList } from '../useSites';

function createWrapper(): React.FC<React.PropsWithChildren> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }): React.ReactElement {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function site(index: number): Record<string, unknown> {
  return {
    id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    name: `Site ${index}`,
    code: `S-${index}`,
    type: 'SEA_CAGE',
    status: 'ACTIVE',
    monitoringRadiusM: 2_000,
    monitoringLocationRevision: 1,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('useSiteList', () => {
  it('loads every authorized site sequentially instead of stopping at the first 100', async () => {
    const firstPage = Array.from({ length: 100 }, (_unused, index) => site(index + 1));
    requestMock.mockImplementation(
      async (_query: string, variables: { pagination: { page: number; limit: number } }) => ({
        sites:
          variables.pagination.page === 1
            ? {
                items: firstPage,
                total: 101,
                page: 1,
                limit: 100,
              }
            : {
                items: [site(101)],
                total: 101,
                page: 2,
                limit: 100,
              },
      }),
    );

    const { result } = renderHook(() => useSiteList({ isActive: true }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items).toHaveLength(101);
    expect(result.current.data).not.toHaveProperty('page');
    expect(result.current.data).not.toHaveProperty('limit');
    expect(requestMock.mock.calls.map((call) => call[1].pagination.page)).toEqual([1, 2]);
    expect(requestMock.mock.calls[0][2].signal).toBe(requestMock.mock.calls[1][2].signal);
  });

  it('aborts the active page request when the last consumer unmounts', async () => {
    let secondPageSignal: AbortSignal | undefined;
    requestMock.mockImplementation(
      async (
        _query: string,
        variables: { pagination: { page: number; limit: number } },
        options: { signal: AbortSignal },
      ) => {
        if (variables.pagination.page === 1) {
          return {
            sites: {
              items: Array.from({ length: 100 }, (_unused, index) => site(index + 1)),
              total: 101,
              page: 1,
              limit: 100,
            },
          };
        }
        secondPageSignal = options.signal;
        return await new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      },
    );

    const rendered = renderHook(() => useSiteList(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(secondPageSignal).toBeDefined());
    rendered.unmount();
    expect(secondPageSignal?.aborted).toBe(true);
  });
});
