/**
 * Leave request hooks — the shapes the operations declare, and what a change refreshes.
 *
 * pendingLeaveApprovals answers a paginated connection for the viewer the server resolves from the
 * token, so the hook takes a page, never an approver id. myLeaveRequests answers a bare array for
 * the employee behind the token, so the hook takes a status and a page and returns no total. A
 * request can sit in the all-requests list, in its owner's list and in an approver's pending
 * list, so every mutation that changes one refreshes all three — under the tenant prefix, and
 * whatever filter or page those lists are showing.
 */
import { createTenantQueryKey } from '@aquaculture/shared-ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CREATE_LEAVE_REQUEST,
  GET_LEAVE_BALANCES,
  GET_LEAVE_BALANCE_SUMMARY,
  GET_LEAVE_REQUESTS,
  GET_MY_LEAVE_REQUESTS,
  GET_PENDING_LEAVE_APPROVALS,
} from '../../graphql';
import { LeaveRequestStatus, type CreateLeaveRequestInput } from '../../types';
import {
  leaveKeys,
  useApproveLeaveRequest,
  useCancelLeaveRequest,
  useCreateLeaveRequest,
  useLeaveBalanceSummary,
  useLeaveBalances,
  useLeaveRequest,
  useLeaveRequests,
  useMyLeaveRequests,
  usePendingLeaveApprovals,
  useRejectLeaveRequest,
  useSubmitLeaveRequest,
  useUpdateLeaveRequest,
  useWithdrawLeaveRequest,
} from '../useLeaves';
import { newQueryClient, renderInWorkspace, requestsFor } from './scopeHarness';

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

const YEAR = new Date().getFullYear();
const REQUEST = { id: 'lr-1', employeeId: 'emp-1', status: 'PENDING' };
const NEW_REQUEST: CreateLeaveRequestInput = {
  employeeId: 'emp-1',
  leaveTypeId: 'lt-1',
  startDate: '2026-10-01',
  endDate: '2026-10-02',
  totalDays: 2,
};

/** What the mutations answer: each operation returns the request it changed. */
const MUTATION_RESPONSE = {
  createLeaveRequest: REQUEST,
  updateLeaveRequest: REQUEST,
  submitLeaveRequest: REQUEST,
  approveLeaveRequest: REQUEST,
  rejectLeaveRequest: REQUEST,
  cancelLeaveRequest: REQUEST,
  withdrawLeaveRequest: REQUEST,
};

const connection = { items: [], total: 0, page: 1, limit: 20, totalPages: 0 };

function serve(): void {
  mocks.request.mockImplementation(async (_client: unknown, document: unknown) => {
    if (document === GET_LEAVE_REQUESTS) return { leaveRequests: connection };
    if (document === GET_PENDING_LEAVE_APPROVALS) return { pendingLeaveApprovals: connection };
    if (document === GET_MY_LEAVE_REQUESTS) return { myLeaveRequests: [] };
    return MUTATION_RESPONSE;
  });
}

describe('leave request hooks', () => {
  beforeEach(() => {
    mocks.request.mockReset();
    serve();
  });

  describe('usePendingLeaveApprovals', () => {
    it('asks for a page and names no approver — the server resolves the viewer', async () => {
      const queryClient = newQueryClient();
      const { unmount } = renderInWorkspace(() => usePendingLeaveApprovals(), 'FARM', queryClient);
      await waitFor(() =>
        expect(requestsFor(mocks.request, GET_PENDING_LEAVE_APPROVALS)).toHaveLength(1),
      );
      unmount();

      const [variables] = requestsFor(mocks.request, GET_PENDING_LEAVE_APPROVALS);
      expect(variables).toEqual({ limit: 20, page: 1, moduleCode: 'FARM' });
      expect(variables).not.toHaveProperty('approverId');
    });

    it('sends the caller’s page, and defaults the other half of it', async () => {
      const queryClient = newQueryClient();
      const { unmount } = renderInWorkspace(
        () => usePendingLeaveApprovals({ limit: 1 }),
        null,
        queryClient,
      );
      await waitFor(() =>
        expect(requestsFor(mocks.request, GET_PENDING_LEAVE_APPROVALS)).toHaveLength(1),
      );
      unmount();

      expect(requestsFor(mocks.request, GET_PENDING_LEAVE_APPROVALS)[0]).toEqual({
        limit: 1,
        page: 1,
        moduleCode: undefined,
      });
    });

    it('returns the paginated connection, not the bare list', async () => {
      const pending = { items: [REQUEST], total: 41, page: 2, limit: 20, totalPages: 3 };
      mocks.request.mockResolvedValue({ pendingLeaveApprovals: pending });
      const { result, unmount } = renderInWorkspace(
        () => usePendingLeaveApprovals({ limit: 20, page: 2 }),
        'FARM',
        newQueryClient(),
      );
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      unmount();

      expect(result.current.data).toEqual(pending);
    });

    it('keys each page of each workspace separately', async () => {
      const queryClient = newQueryClient();
      for (const pagination of [
        { limit: 20, page: 1 },
        { limit: 20, page: 2 },
      ]) {
        const { unmount } = renderInWorkspace(
          () => usePendingLeaveApprovals(pagination),
          'FARM',
          queryClient,
        );
        await waitFor(() =>
          expect(requestsFor(mocks.request, GET_PENDING_LEAVE_APPROVALS).length).toBeGreaterThan(0),
        );
        unmount();
      }

      expect(queryClient.getQueryCache().getAll()).toHaveLength(2);
    });
  });

  describe('useMyLeaveRequests', () => {
    it('sends the status and the page as the flat variables the operation declares', async () => {
      const queryClient = newQueryClient();
      const { unmount } = renderInWorkspace(
        () => useMyLeaveRequests(LeaveRequestStatus.APPROVED, { limit: 5, page: 2 }),
        'FARM',
        queryClient,
      );
      await waitFor(() =>
        expect(requestsFor(mocks.request, GET_MY_LEAVE_REQUESTS)).toHaveLength(1),
      );
      unmount();

      const [variables] = requestsFor(mocks.request, GET_MY_LEAVE_REQUESTS);
      // A nested { filter, pagination } would reach no declared variable and filter nothing.
      expect(variables).toEqual({ status: 'APPROVED', limit: 5, page: 2 });
      expect(variables).not.toHaveProperty('filter');
      expect(variables).not.toHaveProperty('pagination');
    });

    it('asks for the most the server serves in one page when the caller names none', async () => {
      const queryClient = newQueryClient();
      const { unmount } = renderInWorkspace(() => useMyLeaveRequests(), null, queryClient);
      await waitFor(() =>
        expect(requestsFor(mocks.request, GET_MY_LEAVE_REQUESTS)).toHaveLength(1),
      );
      unmount();

      // The answer is a bare array with no total, so no caller can page it: one full page.
      expect(requestsFor(mocks.request, GET_MY_LEAVE_REQUESTS)[0]).toEqual({
        status: undefined,
        limit: 100,
        page: 1,
      });
    });

    it('returns the array the server answers', async () => {
      mocks.request.mockResolvedValue({ myLeaveRequests: [REQUEST] });
      const { result, unmount } = renderInWorkspace(
        () => useMyLeaveRequests(),
        null,
        newQueryClient(),
      );
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      unmount();

      expect(result.current.data).toEqual([REQUEST]);
    });

    it('is not sent while the caller holds it back', async () => {
      const queryClient = newQueryClient();
      const { unmount } = renderInWorkspace(
        () => useMyLeaveRequests(undefined, undefined, { enabled: false }),
        null,
        queryClient,
      );

      // A settled macrotask: an enabled query would have fired by now.
      await new Promise((resolve) => setTimeout(resolve, 20));
      unmount();

      expect(requestsFor(mocks.request, GET_MY_LEAVE_REQUESTS)).toHaveLength(0);
    });
  });

  describe('what a change to a request refreshes', () => {
    /** The three lists a request can appear in, each on a page or filter the page may have chosen. */
    function useLists(): unknown[] {
      return [
        useLeaveRequests({ status: LeaveRequestStatus.PENDING }, { limit: 20, page: 3 }),
        useMyLeaveRequests(LeaveRequestStatus.APPROVED, { limit: 5, page: 2 }),
        usePendingLeaveApprovals({ limit: 1, page: 1 }),
      ];
    }
    const LIST_DOCUMENTS = [GET_LEAVE_REQUESTS, GET_MY_LEAVE_REQUESTS, GET_PENDING_LEAVE_APPROVALS];

    const MUTATIONS = [
      ['creating a request', useCreateLeaveRequest, NEW_REQUEST],
      ['updating a request', useUpdateLeaveRequest, { id: 'lr-1' }],
      ['submitting a request', useSubmitLeaveRequest, 'lr-1'],
      ['approving a request', useApproveLeaveRequest, { id: 'lr-1' }],
      ['rejecting a request', useRejectLeaveRequest, { id: 'lr-1', reason: 'No cover' }],
      ['cancelling a request', useCancelLeaveRequest, { id: 'lr-1' }],
      ['withdrawing a request', useWithdrawLeaveRequest, 'lr-1'],
    ] as const;

    it.each(MUTATIONS)(
      '%s refetches the all, own and pending lists of its tenant',
      async (_what, useMutationHook, input) => {
        const queryClient = newQueryClient();
        const { result } = renderInWorkspace(
          () => ({
            lists: useLists(),
            mutation: useMutationHook() as {
              mutateAsync: (variables: unknown) => Promise<unknown>;
            },
          }),
          'FARM',
          queryClient,
        );
        await waitFor(() => {
          for (const document of LIST_DOCUMENTS) {
            expect(requestsFor(mocks.request, document)).toHaveLength(1);
          }
        });
        // Another tenant's lists, cached but not mounted: a change here must not touch them.
        const otherTenantKeys = [
          leaveKeys.requestList(undefined, undefined, undefined),
          leaveKeys.myRequests(undefined, undefined),
          leaveKeys.pendingApprovals(undefined, undefined),
        ].map((segments) => createTenantQueryKey('tenant-2', ...segments));
        for (const key of otherTenantKeys) queryClient.setQueryData(key, {});
        mocks.request.mockClear();

        await act(async () => {
          await result.current.mutation.mutateAsync(input);
        });

        await waitFor(() => {
          for (const document of LIST_DOCUMENTS) {
            expect(requestsFor(mocks.request, document)).toHaveLength(1);
          }
        });
        for (const key of otherTenantKeys) {
          expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
        }
      },
    );

    it('creating a request does not leave an own list behind a status filter stale', async () => {
      const queryClient = newQueryClient();
      const { result } = renderInWorkspace(
        () => ({
          mine: useMyLeaveRequests(LeaveRequestStatus.REJECTED),
          create: useCreateLeaveRequest(),
        }),
        null,
        queryClient,
      );
      await waitFor(() =>
        expect(requestsFor(mocks.request, GET_MY_LEAVE_REQUESTS)).toHaveLength(1),
      );

      await act(async () => {
        await result.current.create.mutateAsync(NEW_REQUEST);
      });

      // An invalidation keyed on the unfiltered list would miss this entry.
      await waitFor(() =>
        expect(requestsFor(mocks.request, GET_MY_LEAVE_REQUESTS)).toHaveLength(2),
      );
    });

    it.each([
      ['creating a request', useCreateLeaveRequest, NEW_REQUEST],
      ['approving a request', useApproveLeaveRequest, { id: 'lr-1' }],
      ['rejecting a request', useRejectLeaveRequest, { id: 'lr-1', reason: 'No cover' }],
      ['cancelling a request', useCancelLeaveRequest, { id: 'lr-1' }],
    ] as const)(
      '%s refetches the balances of the employee it concerns',
      async (_what, useMutationHook, input) => {
        const { result } = renderInWorkspace(
          () => ({
            balances: useLeaveBalances('emp-1', YEAR),
            summary: useLeaveBalanceSummary('emp-1', YEAR),
            mutation: useMutationHook() as {
              mutateAsync: (variables: unknown) => Promise<unknown>;
            },
          }),
          null,
          newQueryClient(),
        );
        await waitFor(() => {
          expect(requestsFor(mocks.request, GET_LEAVE_BALANCES)).toHaveLength(1);
          expect(requestsFor(mocks.request, GET_LEAVE_BALANCE_SUMMARY)).toHaveLength(1);
        });
        mocks.request.mockClear();

        await act(async () => {
          await result.current.mutation.mutateAsync(input);
        });

        await waitFor(() => {
          expect(requestsFor(mocks.request, GET_LEAVE_BALANCES)).toHaveLength(1);
          expect(requestsFor(mocks.request, GET_LEAVE_BALANCE_SUMMARY)).toHaveLength(1);
        });
      },
    );

    it.each([
      ['updating a request', useUpdateLeaveRequest, { id: 'lr-1' }],
      ['submitting a request', useSubmitLeaveRequest, 'lr-1'],
      ['approving a request', useApproveLeaveRequest, { id: 'lr-1' }],
      ['rejecting a request', useRejectLeaveRequest, { id: 'lr-1', reason: 'No cover' }],
      ['cancelling a request', useCancelLeaveRequest, { id: 'lr-1' }],
      ['withdrawing a request', useWithdrawLeaveRequest, 'lr-1'],
    ] as const)(
      '%s caches the changed request as the detail read answers it',
      async (_what, useMutationHook, input) => {
        const queryClient = newQueryClient();
        const { result } = renderInWorkspace(
          () => useMutationHook() as { mutateAsync: (variables: unknown) => Promise<unknown> },
          null,
          queryClient,
        );

        await act(async () => {
          await result.current.mutateAsync(input);
        });

        // The detail read selects `leaveRequest` out of the response, so the cache holds that shape.
        expect(
          queryClient.getQueryData(
            createTenantQueryKey('tenant-1', ...leaveKeys.requestDetail('lr-1')),
          ),
        ).toEqual({ leaveRequest: REQUEST });
        const detail = renderHook(() => useLeaveRequest('lr-1'), {
          wrapper: ({ children }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
          ),
        });
        expect(detail.result.current.data).toEqual(REQUEST);
        detail.unmount();
      },
    );

    it('creating a request sends the input as the operation declares it', async () => {
      const { result } = renderInWorkspace(() => useCreateLeaveRequest(), null, newQueryClient());

      await act(async () => {
        await result.current.mutateAsync(NEW_REQUEST);
      });

      expect(requestsFor(mocks.request, CREATE_LEAVE_REQUEST)).toEqual([{ input: NEW_REQUEST }]);
    });
  });
});
