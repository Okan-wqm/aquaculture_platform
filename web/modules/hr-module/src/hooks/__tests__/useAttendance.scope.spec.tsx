/**
 * Attendance hooks — the module scope of the reader reaches both the request and the cache key.
 *
 * A module workspace reads that module's attendance; Company reads everyone's. Each scoped hook
 * resolves the scope once (useModuleScope) and sends that one value as `moduleCode` AND keys its
 * cache entry with it. `useTodaysAttendance` is the exception on purpose: it is the clock
 * widget's own-record read and must find the caller's record in any workspace.
 */
import { createTenantInvalidationKey } from '@aquaculture/shared-ui';
import type { QueryClient } from '@tanstack/react-query';
import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GET_ATTENDANCE_RECORDS,
  GET_DAILY_ATTENDANCE_OVERVIEW,
  GET_TODAYS_ATTENDANCE,
} from '../../graphql';
import { AttendanceStatus } from '../../types';
import {
  attendanceKeys,
  useAttendanceRecords,
  useDailyAttendanceOverview,
  useTeamTodaysAttendance,
  useTodaysAttendance,
} from '../useAttendance';
import {
  cachedKeys,
  newQueryClient,
  onTheWire,
  renderInWorkspace,
  requestsFor,
  type Workspace,
} from './scopeHarness';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('../useGraphQL', () => ({
  useGraphQLClient: () => ({ client: true }),
  graphqlRequest: mocks.request,
}));

// WHY: the hooks read through useTenantQuery, which stays idle until an authenticated tenant
// session exists; mocking the leaf module is what reaches the copy useTenantQuery itself imports.
vi.mock('../../../../../shared-ui/src/hooks/useAuth', () => ({
  useAuth: () => ({ token: 'token-1', tenantId: 'tenant-1' }),
}));

interface ScopedRead {
  name: string;
  document: unknown;
  useRead: () => unknown;
  /** The caller's own arguments, which must still reach the request next to `moduleCode`. */
  ownVariables: Record<string, unknown>;
}

const SCOPED_READS: ScopedRead[] = [
  {
    name: 'useAttendanceRecords',
    document: GET_ATTENDANCE_RECORDS,
    useRead: () =>
      useAttendanceRecords(
        { employeeId: 'e1', status: AttendanceStatus.LATE },
        { limit: 10, page: 2 },
      ),
    ownVariables: { employeeId: 'e1', status: 'LATE', limit: 10, page: 2 },
  },
  {
    name: 'useDailyAttendanceOverview',
    document: GET_DAILY_ATTENDANCE_OVERVIEW,
    useRead: () => useDailyAttendanceOverview('2026-10-16'),
    ownVariables: { date: '2026-10-16' },
  },
  {
    name: 'useTeamTodaysAttendance',
    document: GET_TODAYS_ATTENDANCE,
    useRead: () => useTeamTodaysAttendance(),
    ownVariables: {},
  },
];

const WORKSPACES: Workspace[] = ['FARM', 'HYDROPONICS', null];

/** Renders `read` in each workspace against one cache and waits until each request went out. */
async function readInEveryWorkspace(read: ScopedRead, queryClient: QueryClient): Promise<void> {
  for (const workspace of WORKSPACES) {
    const before = requestsFor(mocks.request, read.document).length;
    const { unmount } = renderInWorkspace(read.useRead, workspace, queryClient);
    await waitFor(() => expect(requestsFor(mocks.request, read.document)).toHaveLength(before + 1));
    unmount();
  }
}

describe('attendance hooks module scope', () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.request.mockResolvedValue({});
  });

  describe.each(SCOPED_READS)('$name', (read) => {
    it('sends the workspace module and keeps a cache entry per workspace', async () => {
      const queryClient = newQueryClient();

      await readInEveryWorkspace(read, queryClient);

      const sent = requestsFor(mocks.request, read.document);
      expect(sent.map((variables) => variables.moduleCode)).toEqual([
        'FARM',
        'HYDROPONICS',
        undefined,
      ]);
      expect(new Set(cachedKeys(queryClient)).size).toBe(WORKSPACES.length);
    });

    it('sends no moduleCode in a workspace that spans modules', async () => {
      const queryClient = newQueryClient();
      const { unmount } = renderInWorkspace(read.useRead, null, queryClient);
      await waitFor(() => expect(requestsFor(mocks.request, read.document)).toHaveLength(1));
      unmount();

      const [variables] = requestsFor(mocks.request, read.document);
      expect(variables).toBeDefined();
      expect(onTheWire(variables ?? {})).not.toHaveProperty('moduleCode');
      expect(cachedKeys(queryClient).join()).not.toContain('moduleCode');
    });

    it('keeps the caller’s own arguments next to the module', async () => {
      const queryClient = newQueryClient();
      const { unmount } = renderInWorkspace(read.useRead, 'SENSOR', queryClient);
      await waitFor(() => expect(requestsFor(mocks.request, read.document)).toHaveLength(1));
      unmount();

      expect(requestsFor(mocks.request, read.document)[0]).toMatchObject({
        ...read.ownVariables,
        moduleCode: 'SENSOR',
      });
    });
  });

  describe('useTodaysAttendance (the clock widget)', () => {
    it('is never module-scoped: it sends no moduleCode inside a module workspace', async () => {
      const queryClient = newQueryClient();
      const { unmount } = renderInWorkspace(() => useTodaysAttendance(), 'FARM', queryClient);
      await waitFor(() =>
        expect(requestsFor(mocks.request, GET_TODAYS_ATTENDANCE)).toHaveLength(1),
      );
      unmount();

      const [variables] = requestsFor(mocks.request, GET_TODAYS_ATTENDANCE);
      expect(onTheWire(variables ?? {})).not.toHaveProperty('moduleCode');
      expect(cachedKeys(queryClient).join()).not.toContain('moduleCode');
    });

    it('does not share a cache entry with the workspace’s team list', async () => {
      const queryClient = newQueryClient();
      const own = renderInWorkspace(() => useTodaysAttendance(), 'FARM', queryClient);
      const team = renderInWorkspace(() => useTeamTodaysAttendance(), 'FARM', queryClient);
      await waitFor(() =>
        expect(requestsFor(mocks.request, GET_TODAYS_ATTENDANCE)).toHaveLength(2),
      );
      own.unmount();
      team.unmount();

      expect(new Set(cachedKeys(queryClient)).size).toBe(2);
    });

    it('is refreshed together with the team list by the "today" prefix a clock-in invalidates', async () => {
      const queryClient = newQueryClient();
      const own = renderInWorkspace(() => useTodaysAttendance(), 'FARM', queryClient);
      const team = renderInWorkspace(() => useTeamTodaysAttendance(), 'FARM', queryClient);
      await waitFor(() =>
        expect(requestsFor(mocks.request, GET_TODAYS_ATTENDANCE)).toHaveLength(2),
      );
      own.unmount();
      team.unmount();

      await queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey('tenant-1', ...attendanceKeys.today()),
        refetchType: 'none',
      });

      const states = queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.state.isInvalidated);
      expect(states).toEqual([true, true]);
    });
  });
});
