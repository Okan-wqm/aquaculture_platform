/**
 * Leave hooks — the module scope of the reader reaches both the request and the cache key.
 *
 * The leave requests, the approver's pending list and the team calendar of a module workspace
 * cover that module's people; Company covers everyone. Each hook resolves the scope once
 * (useModuleScope), sends it as `moduleCode` and keys its cache entry with it.
 */
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { WorkforceScopeProvider } from '@aquaculture/shared-ui';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GET_LEAVE_REQUESTS,
  GET_PENDING_LEAVE_APPROVALS,
  GET_TEAM_LEAVE_CALENDAR,
} from '../../graphql';
import { LeaveRequestStatus } from '../../types';
import { useLeaveRequests, usePendingLeaveApprovals, useTeamLeaveCalendar } from '../useLeaves';
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

// WHY: useTenantQuery reads the session through shared-ui's own useAuth module, so the
// session is faked at that module — a partial mock of the package index cannot reach it.
vi.mock('@shared-ui/hooks/useAuth', () => ({
  useAuth: () => ({ token: 'token', tenantId: 'tenant-1', user: null }),
}));

interface ScopedRead {
  name: string;
  document: unknown;
  useRead: () => unknown;
  /** The caller's own arguments, which must still reach the request next to `moduleCode`. */
  ownVariables: Record<string, unknown>;
  /** What the server answers for a workspace, tagged so two answers can be told apart. */
  response: (tag: string) => Record<string, unknown>;
}

const page = (tag: string): { items: { id: string }[]; total: number } => ({
  items: [{ id: tag }],
  total: 1,
});

const SCOPED_READS: ScopedRead[] = [
  {
    name: 'useLeaveRequests',
    document: GET_LEAVE_REQUESTS,
    useRead: () =>
      useLeaveRequests(
        { employeeId: 'e1', status: LeaveRequestStatus.PENDING, leaveTypeId: 'lt1' },
        { limit: 5, page: 2 },
      ),
    ownVariables: { employeeId: 'e1', status: 'PENDING', leaveTypeId: 'lt1', limit: 5, page: 2 },
    response: (tag) => ({ leaveRequests: page(tag) }),
  },
  {
    name: 'usePendingLeaveApprovals',
    document: GET_PENDING_LEAVE_APPROVALS,
    useRead: () => usePendingLeaveApprovals({ limit: 5, page: 2 }),
    ownVariables: { limit: 5, page: 2 },
    response: (tag) => ({ pendingLeaveApprovals: page(tag) }),
  },
  {
    name: 'useTeamLeaveCalendar',
    document: GET_TEAM_LEAVE_CALENDAR,
    useRead: () => useTeamLeaveCalendar('dep-1', '2026-10-01', '2026-10-31'),
    ownVariables: { departmentId: 'dep-1', startDate: '2026-10-01', endDate: '2026-10-31' },
    response: (tag) => ({ teamLeaveCalendar: [{ id: tag }] }),
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

/** One mounted hook whose workspace the test can change, the way the shell's workspace switcher does. */
function renderSwitchable<T>(
  useHook: () => T,
  queryClient: QueryClient,
): { result: { current: T }; switchTo: (workspace: Workspace) => void } {
  let workspace: Workspace = 'FARM';
  const view = renderHook(useHook, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <WorkforceScopeProvider moduleCode={workspace}>{children}</WorkforceScopeProvider>
      </QueryClientProvider>
    ),
  });
  return {
    result: view.result,
    switchTo: (next) => {
      workspace = next;
      view.rerender();
    },
  };
}

describe('leave hooks module scope', () => {
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

    it('never shows the previous workspace while the next one loads', async () => {
      const queryClient = newQueryClient();
      mocks.request.mockResolvedValueOnce(read.response('farm'));
      const { result, switchTo } = renderSwitchable(
        () => read.useRead() as { data: unknown; isSuccess: boolean },
        queryClient,
      );
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toBeDefined();

      // The next workspace's answer is still on its way.
      mocks.request.mockReturnValueOnce(new Promise(() => undefined));
      switchTo('HYDROPONICS');

      await waitFor(() => expect(requestsFor(mocks.request, read.document)).toHaveLength(2));
      expect(result.current.data).toBeUndefined();
    });
  });

  describe('useLeaveRequests', () => {
    it('sends the filter and the page as the flat variables the operation declares', async () => {
      const queryClient = newQueryClient();
      const { unmount } = renderInWorkspace(
        () => useLeaveRequests({ status: LeaveRequestStatus.APPROVED }, { limit: 20, page: 1 }),
        'FARM',
        queryClient,
      );
      await waitFor(() => expect(requestsFor(mocks.request, GET_LEAVE_REQUESTS)).toHaveLength(1));
      unmount();

      const [variables] = requestsFor(mocks.request, GET_LEAVE_REQUESTS);
      // A nested { filter, pagination } would reach no declared variable and filter nothing.
      expect(variables).not.toHaveProperty('filter');
      expect(variables).not.toHaveProperty('pagination');
      expect(variables).toMatchObject({
        status: 'APPROVED',
        limit: 20,
        page: 1,
        moduleCode: 'FARM',
      });
    });
  });
});
