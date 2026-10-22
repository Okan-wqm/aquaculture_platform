/**
 * useSeaLandSplit — a department narrows the split on the server.
 *
 * The hook used to ignore its department argument and fetch every employee
 * ("EmployeeFilterInput does not support departmentHrId"). The filter exists now,
 * so the employees of one department are asked for as such, and the offshore
 * crew — whose query has no department argument — is narrowed to the same one.
 */
import { WorkforceScopeProvider } from '@aquaculture/shared-ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET_CURRENTLY_OFFSHORE, GET_EMPLOYEES } from '../../graphql';
import { useSeaLandSplit } from '../useAquaculture';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('../useGraphQL', () => ({
  useGraphQLClient: () => ({ client: true }),
  graphqlRequest: mocks.request,
}));

// WHY: useTenantQuery reads the session through shared-ui's own useAuth module, so the
// session is faked at that module — a partial mock of the package index cannot reach it.
vi.mock('@shared-ui/hooks/useAuth', () => ({
  useAuth: () => ({ token: 'token', tenantId: 'tenant-1', user: null }),
}));

const DECK = '11111111-1111-4111-8111-111111111111';
const GALLEY = '22222222-2222-4222-8222-222222222222';

const person = (id: string, departmentHrId: string, status = 'ACTIVE') => ({
  id,
  firstName: id,
  lastName: 'Crew',
  status,
  departmentHrId,
  personnelCategory: 'OFFSHORE',
});

function wrapper({ children }: { children: ReactNode }): ReactNode {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <WorkforceScopeProvider moduleCode={null}>{children}</WorkforceScopeProvider>
    </QueryClientProvider>
  );
}

function employeeFilters(): unknown[] {
  return mocks.request.mock.calls
    .filter(([, doc]) => doc === GET_EMPLOYEES)
    .map(([, , variables]) => variables.filter);
}

describe('useSeaLandSplit', () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.request.mockImplementation(async (_client: unknown, document: unknown) =>
      document === GET_CURRENTLY_OFFSHORE
        ? { currentlyOffshore: [person('deck-at-sea', DECK), person('galley-at-sea', GALLEY)] }
        : {
            employees: {
              items: [person('deck-ashore', DECK), person('deck-away', DECK, 'ON_LEAVE')],
              total: 2,
            },
          },
    );
  });

  it('asks the server for the employees of the department, and keeps only its offshore crew', async () => {
    const { result } = renderHook(() => useSeaLandSplit(DECK), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(employeeFilters()).toEqual([{ departmentHrId: DECK, moduleCode: undefined }]);
    expect(result.current.data.offshore.employees.map((e) => e.id)).toEqual(['deck-at-sea']);
    expect(result.current.data.onLeave.employees.map((e) => e.id)).toEqual(['deck-away']);
    expect(result.current.data.onshore.employees.map((e) => e.id)).toEqual(['deck-ashore']);
  });

  it('splits the whole company when no department is named', async () => {
    const { result } = renderHook(() => useSeaLandSplit(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(employeeFilters()).toEqual([{ moduleCode: undefined }]);
    expect(result.current.data.offshore.employees.map((e) => e.id)).toEqual([
      'deck-at-sea',
      'galley-at-sea',
    ]);
  });
});
