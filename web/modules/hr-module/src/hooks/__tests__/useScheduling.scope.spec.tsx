/**
 * Scheduling hooks — the module scope of the reader reaches both the request and the cache key.
 *
 * The shift schedule of a module workspace plans that module's people; Company plans everyone.
 * Every employee-list read resolves the scope once (useModuleScope), sends it as `moduleCode`
 * and keys its cache entry with it, so two workspaces never share a week's overview.
 */
import { WorkforceScopeProvider, createTenantInvalidationKey } from '@aquaculture/shared-ui';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor, type RenderHookResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GET_OVERTIME_SUMMARY,
  GET_TEAM_WEEKLY_OVERVIEW,
  GET_WEEKLY_PLANS,
} from '../../graphql/scheduling.operations';
import {
  schedulingKeys,
  useOvertimeSummary,
  useTeamWeeklyOverview,
  useTeamWeeklyOverviews,
  useWeeklyPlans,
} from '../useScheduling';
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

// An authenticated tenant session: useTenantQuery fires nothing without one.
vi.mock('../../../../../shared-ui/src/hooks/useAuth', () => ({
  useAuth: () => ({ token: 'token-1', tenantId: 'tenant-1' }),
}));

interface ScopedRead {
  name: string;
  document: unknown;
  /** How many requests one render sends (the per-week list sends one per week). */
  requestsPerRender: number;
  /** The read, seen through the data it hands its caller (the per-week list: its first week). */
  useRead: () => { data: unknown };
  /** The caller's own arguments, which must still reach the request next to `moduleCode`. */
  ownVariables: Record<string, unknown>;
}

const SCOPED_READS: ScopedRead[] = [
  {
    name: 'useTeamWeeklyOverview',
    document: GET_TEAM_WEEKLY_OVERVIEW,
    requestsPerRender: 1,
    useRead: () => useTeamWeeklyOverview('2026-10-12', 'dep-1', 'site-1'),
    ownVariables: { weekStartDate: '2026-10-12', departmentId: 'dep-1', siteId: 'site-1' },
  },
  {
    name: 'useTeamWeeklyOverviews',
    document: GET_TEAM_WEEKLY_OVERVIEW,
    requestsPerRender: 2,
    useRead: () => {
      const [firstWeek] = useTeamWeeklyOverviews(['2026-10-05', '2026-10-12'], undefined, 'site-1');
      return { data: firstWeek?.data };
    },
    ownVariables: { weekStartDate: '2026-10-05', siteId: 'site-1' },
  },
  {
    name: 'useWeeklyPlans',
    document: GET_WEEKLY_PLANS,
    requestsPerRender: 1,
    useRead: () => useWeeklyPlans({ departmentId: 'dep-1', status: 'DRAFT' }, 10, 3),
    ownVariables: { departmentId: 'dep-1', status: 'DRAFT', limit: 10, page: 3 },
  },
  {
    name: 'useOvertimeSummary',
    document: GET_OVERTIME_SUMMARY,
    requestsPerRender: 1,
    useRead: () => useOvertimeSummary(10, 2026, undefined, 'dep-1'),
    ownVariables: { month: 10, year: 2026, departmentId: 'dep-1' },
  },
];

const WORKSPACES: Workspace[] = ['FARM', 'HYDROPONICS', null];

/** Renders `read` in each workspace against one cache and waits until its requests went out. */
async function readInEveryWorkspace(read: ScopedRead, queryClient: QueryClient): Promise<void> {
  for (const workspace of WORKSPACES) {
    const before = requestsFor(mocks.request, read.document).length;
    const { unmount } = renderInWorkspace(read.useRead, workspace, queryClient);
    await waitFor(() =>
      expect(requestsFor(mocks.request, read.document)).toHaveLength(
        before + read.requestsPerRender,
      ),
    );
    unmount();
  }
}

/** A hook whose workspace can be switched while it stays mounted, as the console's switcher does. */
function renderSwitchable<T>(
  useHook: () => T,
  initial: Workspace,
  queryClient: QueryClient,
): RenderHookResult<T, unknown> & { switchTo: (next: Workspace) => void } {
  const scope: { current: Workspace } = { current: initial };
  const rendered = renderHook(useHook, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <WorkforceScopeProvider moduleCode={scope.current}>{children}</WorkforceScopeProvider>
      </QueryClientProvider>
    ),
  });
  return {
    ...rendered,
    switchTo: (next) => {
      scope.current = next;
      rendered.rerender();
    },
  };
}

describe('scheduling hooks module scope', () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.request.mockResolvedValue({});
  });

  describe.each(SCOPED_READS)('$name', (read) => {
    it('sends the workspace module and keeps a cache entry per workspace', async () => {
      const queryClient = newQueryClient();

      await readInEveryWorkspace(read, queryClient);

      const sent = requestsFor(mocks.request, read.document).map(
        (variables) => variables.moduleCode,
      );
      const expected = WORKSPACES.flatMap((workspace) =>
        Array<unknown>(read.requestsPerRender).fill(workspace ?? undefined),
      );
      expect(sent).toEqual(expected);
      expect(new Set(cachedKeys(queryClient)).size).toBe(
        WORKSPACES.length * read.requestsPerRender,
      );
    });

    it('sends no moduleCode in a workspace that spans modules', async () => {
      const queryClient = newQueryClient();
      const { unmount } = renderInWorkspace(read.useRead, null, queryClient);
      await waitFor(() =>
        expect(requestsFor(mocks.request, read.document)).toHaveLength(read.requestsPerRender),
      );
      unmount();

      for (const variables of requestsFor(mocks.request, read.document)) {
        expect(onTheWire(variables)).not.toHaveProperty('moduleCode');
      }
      expect(cachedKeys(queryClient).join()).not.toContain('moduleCode');
    });

    it('keeps the caller’s own arguments next to the module', async () => {
      const queryClient = newQueryClient();
      const { unmount } = renderInWorkspace(read.useRead, 'SENSOR', queryClient);
      await waitFor(() =>
        expect(requestsFor(mocks.request, read.document)).toHaveLength(read.requestsPerRender),
      );
      unmount();

      expect(requestsFor(mocks.request, read.document)[0]).toMatchObject({
        ...read.ownVariables,
        moduleCode: 'SENSOR',
      });
    });

    it('never shows the previous workspace’s data while the new workspace loads', async () => {
      mocks.request.mockImplementation(
        async (_client: unknown, _document: unknown, variables: { moduleCode?: string }) => {
          const answer = `people of ${variables.moduleCode ?? 'every module'}`;
          return { teamWeeklyOverview: answer, weeklyPlans: answer, overtimeSummary: answer };
        },
      );
      const queryClient = newQueryClient();
      const view = renderSwitchable(read.useRead, 'FARM', queryClient);
      await waitFor(() => expect(view.result.current.data).toBe('people of FARM'));

      // The next workspace's request never answers: what the page shows now is all it has.
      mocks.request.mockImplementation(() => new Promise<never>(() => undefined));
      view.switchTo('HYDROPONICS');

      expect(view.result.current.data).toBeUndefined();
    });
  });

  describe('the team overview of one week', () => {
    it('is one cache entry whether the single-week or the per-week hook reads it', async () => {
      const queryClient = newQueryClient();
      const single = renderInWorkspace(
        () => useTeamWeeklyOverview('2026-10-12'),
        'FARM',
        queryClient,
      );
      await waitFor(() => expect(single.result.current.isSuccess).toBe(true));
      const list = renderInWorkspace(
        () => useTeamWeeklyOverviews(['2026-10-12']),
        'FARM',
        queryClient,
      );
      await waitFor(() => expect(list.result.current[0]?.isSuccess).toBe(true));

      // Same week, same filters, same workspace: one entry, not one per hook.
      expect(cachedKeys(queryClient)).toHaveLength(1);
    });

    it('is invalidated for every workspace by the week prefix a saved cell uses', async () => {
      const queryClient = newQueryClient();
      await readInEveryWorkspace(SCOPED_READS[0] as ScopedRead, queryClient);

      await queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(
          'tenant-1',
          ...schedulingKeys.teamOverviewWeek('2026-10-12'),
        ),
        refetchType: 'none',
      });

      const states = queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.state.isInvalidated);
      expect(states).toEqual([true, true, true]);
    });
  });
});
