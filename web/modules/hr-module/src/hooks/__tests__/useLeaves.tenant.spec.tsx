/**
 * Leave hooks — every read lives under the tenant prefix.
 *
 * An un-prefixed key shares one cache entry between two tenants of the same browser session
 * (FE-CRITICAL-014) and is out of reach of the tenant-prefixed invalidations the employee,
 * department and leave mutations issue — so a hire or a placement left the leave lists showing
 * the old team. Each read is stored under ['tenant', tenantId, ...its key, {epoch}], is not sent
 * before the session resolved a tenant, and is refetched by invalidating its tenant-prefixed
 * domain prefix.
 */
import { createTenantInvalidationKey, createTenantQueryKey } from '@aquaculture/shared-ui';
import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CALCULATE_LEAVE_DAYS,
  CHECK_LEAVE_OVERLAP,
  GET_LEAVE_BALANCES,
  GET_LEAVE_BALANCE_SUMMARY,
  GET_LEAVE_REQUEST,
  GET_LEAVE_REQUESTS,
  GET_LEAVE_TYPES,
  GET_MY_LEAVE_REQUESTS,
  GET_PENDING_LEAVE_APPROVALS,
  GET_TEAM_LEAVE_CALENDAR,
} from '../../graphql';
import { LeaveRequestStatus } from '../../types';
import {
  leaveKeys,
  useCalculateLeaveDays,
  useCheckLeaveOverlap,
  useLeaveBalanceSummary,
  useLeaveBalances,
  useLeaveRequest,
  useLeaveRequests,
  useLeaveTypes,
  useMyLeaveRequests,
  usePendingLeaveApprovals,
  useTeamLeaveCalendar,
} from '../useLeaves';
import { newQueryClient, renderInWorkspace, requestsFor } from './scopeHarness';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  session: { token: 'token' as string | null, tenantId: 'tenant-1' as string | null },
}));

vi.mock('../useGraphQL', () => ({
  useGraphQLClient: () => ({ client: true }),
  graphqlRequest: mocks.request,
}));

// WHY: useTenantQuery reads the session through shared-ui's own useAuth module, so the
// session is faked at that module — a partial mock of the package index cannot reach it.
vi.mock('@shared-ui/hooks/useAuth', () => ({
  useAuth: () => ({ ...mocks.session, user: null }),
}));

const PENDING_FILTER = { status: LeaveRequestStatus.PENDING, leaveTypeId: 'lt-1' };

interface Read {
  name: string;
  document: unknown;
  /** The domain key the read is filed under, before the tenant prefix. */
  segments: readonly unknown[];
  useRead: () => unknown;
}

// The reads render in the FARM workspace, so a module-scoped key carries 'FARM'.
const READS: Read[] = [
  {
    name: 'useLeaveTypes',
    document: GET_LEAVE_TYPES,
    segments: leaveKeys.types(),
    useRead: () => useLeaveTypes({ isActive: true }),
  },
  {
    name: 'useLeaveBalances',
    document: GET_LEAVE_BALANCES,
    segments: leaveKeys.balances('emp-1', 2026),
    useRead: () => useLeaveBalances('emp-1', 2026),
  },
  {
    name: 'useLeaveBalanceSummary',
    document: GET_LEAVE_BALANCE_SUMMARY,
    segments: leaveKeys.balanceSummary('emp-1', 2026),
    useRead: () => useLeaveBalanceSummary('emp-1', 2026),
  },
  {
    name: 'useLeaveRequests',
    document: GET_LEAVE_REQUESTS,
    segments: leaveKeys.requestList(PENDING_FILTER, { limit: 5, page: 2 }, 'FARM'),
    useRead: () => useLeaveRequests(PENDING_FILTER, { limit: 5, page: 2 }),
  },
  {
    name: 'useLeaveRequest',
    document: GET_LEAVE_REQUEST,
    segments: leaveKeys.requestDetail('lr-1'),
    useRead: () => useLeaveRequest('lr-1'),
  },
  {
    name: 'useMyLeaveRequests',
    document: GET_MY_LEAVE_REQUESTS,
    segments: leaveKeys.myRequests(LeaveRequestStatus.APPROVED, { limit: 10, page: 2 }),
    useRead: () => useMyLeaveRequests(LeaveRequestStatus.APPROVED, { limit: 10, page: 2 }),
  },
  {
    name: 'usePendingLeaveApprovals',
    document: GET_PENDING_LEAVE_APPROVALS,
    segments: leaveKeys.pendingApprovals({ limit: 5, page: 2 }, 'FARM'),
    useRead: () => usePendingLeaveApprovals({ limit: 5, page: 2 }),
  },
  {
    name: 'useTeamLeaveCalendar',
    document: GET_TEAM_LEAVE_CALENDAR,
    segments: leaveKeys.calendar('dep-1', '2026-10-01', '2026-10-31', 'FARM'),
    useRead: () => useTeamLeaveCalendar('dep-1', '2026-10-01', '2026-10-31'),
  },
  {
    name: 'useCheckLeaveOverlap',
    document: CHECK_LEAVE_OVERLAP,
    segments: leaveKeys.overlap('emp-1', '2026-10-01', '2026-10-05', 'lr-9'),
    useRead: () => useCheckLeaveOverlap('emp-1', '2026-10-01', '2026-10-05', 'lr-9'),
  },
  {
    name: 'useCalculateLeaveDays',
    document: CALCULATE_LEAVE_DAYS,
    segments: leaveKeys.calculatedDays('lt-1', '2026-10-01', '2026-10-05', { isHalfDayEnd: true }),
    useRead: () =>
      useCalculateLeaveDays('lt-1', '2026-10-01', '2026-10-05', { isHalfDayEnd: true }),
  },
];

describe('leave hooks tenant scope', () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.request.mockResolvedValue({});
    mocks.session.token = 'token';
    mocks.session.tenantId = 'tenant-1';
  });

  describe.each(READS)('$name', (read) => {
    it('stores its entry under the tenant prefix and the session epoch', async () => {
      const queryClient = newQueryClient();
      const { unmount } = renderInWorkspace(read.useRead, 'FARM', queryClient);
      await waitFor(() => expect(requestsFor(mocks.request, read.document)).toHaveLength(1));
      unmount();

      const keys = queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey);
      expect(keys).toHaveLength(1);
      const [key] = keys;
      expect(key?.slice(0, 2)).toEqual(['tenant', 'tenant-1']);
      expect(key).toEqual(createTenantQueryKey('tenant-1', ...read.segments));
      // The key is built from the domain factory, so `leaveKeys.all` reaches it by prefix.
      expect(key?.slice(2, 2 + leaveKeys.all.length)).toEqual(leaveKeys.all);
    });

    it('is not sent before the session resolved a tenant', async () => {
      mocks.session.token = null;
      mocks.session.tenantId = null;
      const queryClient = newQueryClient();
      const { unmount } = renderInWorkspace(read.useRead, 'FARM', queryClient);

      // A settled macrotask: an enabled query would have fired by now.
      await new Promise((resolve) => setTimeout(resolve, 20));
      unmount();

      expect(requestsFor(mocks.request, read.document)).toHaveLength(0);
    });
  });

  describe('invalidating the tenant-prefixed leave domain', () => {
    it('refetches every mounted leave read of that tenant, and no other tenant’s', async () => {
      const queryClient = newQueryClient();
      const { unmount } = renderInWorkspace(
        () => READS.map((read) => read.useRead()),
        'FARM',
        queryClient,
      );
      await waitFor(() => {
        for (const read of READS) {
          expect(requestsFor(mocks.request, read.document)).toHaveLength(1);
        }
      });
      // The same domain of another tenant, cached but not mounted.
      const otherTenantKey = createTenantQueryKey('tenant-2', ...leaveKeys.requests());
      queryClient.setQueryData(otherTenantKey, { leaveRequests: { items: [], total: 0 } });
      mocks.request.mockClear();

      await queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey('tenant-1', ...leaveKeys.all),
      });
      unmount();

      for (const read of READS) {
        expect(requestsFor(mocks.request, read.document)).toHaveLength(1);
      }
      expect(queryClient.getQueryState(otherTenantKey)?.isInvalidated).toBe(false);
    });

    it('refetches nothing when another tenant’s domain is invalidated', async () => {
      const queryClient = newQueryClient();
      const { unmount } = renderInWorkspace(
        () => READS.map((read) => read.useRead()),
        'FARM',
        queryClient,
      );
      await waitFor(() => {
        for (const read of READS) {
          expect(requestsFor(mocks.request, read.document)).toHaveLength(1);
        }
      });
      mocks.request.mockClear();

      await queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey('tenant-2', ...leaveKeys.all),
      });
      unmount();

      expect(mocks.request).not.toHaveBeenCalled();
    });
  });
});
