/**
 * Scheduling hooks — the cache is tenant-scoped (FE-CRITICAL-014).
 *
 * Every scheduling read goes through useTenantQuery, so its entry lives under
 * ['tenant', tenantId, ...key factory, { epoch }] and fires only inside an authenticated tenant
 * session. That prefix is what lets `useEmployees`' workforce invalidation and this file's own
 * mutations reach the reads: both invalidate by createTenantInvalidationKey(tenantId, ...key).
 */
import { createTenantInvalidationKey, createTenantQueryKey } from '@aquaculture/shared-ui';
import type { QueryClient } from '@tanstack/react-query';
import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BULK_ASSIGN_SHIFTS,
  COPY_WEEKLY_PLAN,
  CREATE_WEEKLY_PLAN,
  DELETE_WEEKLY_PLAN,
  GET_OVERTIME_SUMMARY,
  GET_SCHEDULING_SETTINGS,
  GET_TEAM_WEEKLY_OVERVIEW,
  GET_WEEKLY_PLAN,
  GET_WEEKLY_PLANS,
  PUBLISH_WEEKLY_PLAN,
  UPDATE_PLAN_ENTRY,
  UPDATE_SCHEDULING_SETTINGS,
} from '../../graphql/scheduling.operations';
import {
  schedulingKeys,
  useAssignScheduleCell,
  useBulkAssignShifts,
  useCopyWeeklyPlan,
  useCreateWeeklyPlan,
  useDeleteWeeklyPlan,
  useOvertimeSummary,
  usePublishWeekPlans,
  usePublishWeeklyPlan,
  useSchedulingSettings,
  useTeamWeeklyOverview,
  useTeamWeeklyOverviews,
  useUpdatePlanEntry,
  useUpdateSchedulingSettings,
  useWeeklyPlan,
  useWeeklyPlans,
} from '../useScheduling';
import { newQueryClient, renderInWorkspace, requestsFor } from './scopeHarness';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  auth: { token: 'token-1' as string | null, tenantId: 'tenant-1' as string | null },
}));

vi.mock('../useGraphQL', () => ({
  useGraphQLClient: () => ({ client: true }),
  graphqlRequest: mocks.request,
}));

// The session the reads and mutations run in; a spec signs out by clearing the token.
vi.mock('../../../../../shared-ui/src/hooks/useAuth', () => ({
  useAuth: () => ({ token: mocks.auth.token, tenantId: mocks.auth.tenantId }),
}));

const WEEK = '2026-10-12';

/** What the API answers per document: just enough shape for each hook's `select` and `onSuccess`. */
const ANSWERS = new Map<unknown, unknown>([
  [GET_WEEKLY_PLANS, { weeklyPlans: { items: [], total: 0 } }],
  [GET_WEEKLY_PLAN, { weeklyPlan: { id: 'wp-1' } }],
  [GET_TEAM_WEEKLY_OVERVIEW, { teamWeeklyOverview: { weekStartDate: WEEK } }],
  [GET_SCHEDULING_SETTINGS, { schedulingSettings: { standardWeeklyMinutes: 2400 } }],
  [GET_OVERTIME_SUMMARY, { overtimeSummary: { month: 10, year: 2026 } }],
  [CREATE_WEEKLY_PLAN, { createWeeklyPlan: { id: 'wp-1' } }],
  [UPDATE_PLAN_ENTRY, { updatePlanEntry: { id: 'entry-1' } }],
  [BULK_ASSIGN_SHIFTS, { bulkAssignShifts: { success: true, updatedCount: 1, errors: [] } }],
  [COPY_WEEKLY_PLAN, { copyWeeklyPlan: { id: 'wp-2' } }],
  [PUBLISH_WEEKLY_PLAN, { publishWeeklyPlan: { id: 'wp-1' } }],
  [DELETE_WEEKLY_PLAN, { deleteWeeklyPlan: true }],
  [UPDATE_SCHEDULING_SETTINGS, { updateSchedulingSettings: { standardWeeklyMinutes: 2400 } }],
]);

interface TenantRead {
  name: string;
  document: unknown;
  /** How many requests one render sends (the per-week list sends one per week). */
  requestsPerRender: number;
  useRead: () => unknown;
  /** The key factories' output, one per entry the read stores, as read in the FARM workspace. */
  keys: (readonly unknown[])[];
}

const READS: TenantRead[] = [
  {
    name: 'useWeeklyPlans',
    document: GET_WEEKLY_PLANS,
    requestsPerRender: 1,
    useRead: () => useWeeklyPlans({ status: 'DRAFT' }, 10, 3),
    keys: [schedulingKeys.weeklyPlanList({ status: 'DRAFT' }, 10, 3, 'FARM')],
  },
  {
    name: 'useWeeklyPlan',
    document: GET_WEEKLY_PLAN,
    requestsPerRender: 1,
    useRead: () => useWeeklyPlan('wp-1'),
    keys: [schedulingKeys.weeklyPlan('wp-1')],
  },
  {
    name: 'useTeamWeeklyOverview',
    document: GET_TEAM_WEEKLY_OVERVIEW,
    requestsPerRender: 1,
    useRead: () => useTeamWeeklyOverview(WEEK, 'dep-1', 'site-1'),
    keys: [schedulingKeys.teamOverview(WEEK, 'dep-1', 'site-1', 'FARM')],
  },
  {
    name: 'useTeamWeeklyOverviews',
    document: GET_TEAM_WEEKLY_OVERVIEW,
    requestsPerRender: 2,
    useRead: () => useTeamWeeklyOverviews(['2026-10-05', WEEK], 'dep-1', 'site-1'),
    keys: [
      schedulingKeys.teamOverview('2026-10-05', 'dep-1', 'site-1', 'FARM'),
      schedulingKeys.teamOverview(WEEK, 'dep-1', 'site-1', 'FARM'),
    ],
  },
  {
    name: 'useSchedulingSettings',
    document: GET_SCHEDULING_SETTINGS,
    requestsPerRender: 1,
    useRead: () => useSchedulingSettings(),
    keys: [schedulingKeys.settings()],
  },
  {
    name: 'useOvertimeSummary',
    document: GET_OVERTIME_SUMMARY,
    requestsPerRender: 1,
    useRead: () => useOvertimeSummary(10, 2026, 'emp-1', 'dep-1'),
    keys: [schedulingKeys.overtimeSummary(10, 2026, 'emp-1', 'dep-1', 'FARM')],
  },
];

/** Renders `read` in the FARM workspace and waits until every request of that render went out and answered. */
async function mountRead(read: TenantRead, queryClient: QueryClient): Promise<void> {
  renderInWorkspace(read.useRead, 'FARM', queryClient);
  await waitFor(() => {
    expect(requestsFor(mocks.request, read.document)).toHaveLength(read.requestsPerRender);
    expect(queryClient.isFetching()).toBe(0);
  });
}

describe('scheduling hooks tenant scope', () => {
  beforeEach(() => {
    mocks.auth.token = 'token-1';
    mocks.auth.tenantId = 'tenant-1';
    mocks.request.mockReset();
    mocks.request.mockImplementation(
      async (_client: unknown, document: unknown) => ANSWERS.get(document) ?? {},
    );
  });

  describe.each(READS)('$name', (read) => {
    it('stores its entries under the tenant prefix, then the key factory, then the session epoch', async () => {
      const queryClient = newQueryClient();

      await mountRead(read, queryClient);

      const stored = queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey);
      expect(stored).toEqual(
        read.keys.map((key) => [
          'tenant',
          'tenant-1',
          ...key,
          { __sessionEpoch: expect.any(Number) },
        ]),
      );
    });

    it('sends nothing before an authenticated tenant session exists', async () => {
      mocks.auth.token = null;
      const queryClient = newQueryClient();

      renderInWorkspace(read.useRead, 'FARM', queryClient);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(mocks.request).not.toHaveBeenCalled();
    });

    it('is refetched when the tenant’s scheduling prefix is invalidated', async () => {
      const queryClient = newQueryClient();
      await mountRead(read, queryClient);

      await queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey('tenant-1', ...schedulingKeys.all),
      });

      expect(requestsFor(mocks.request, read.document)).toHaveLength(2 * read.requestsPerRender);
    });

    it('is not refetched when another tenant’s scheduling prefix is invalidated', async () => {
      const queryClient = newQueryClient();
      await mountRead(read, queryClient);

      await queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey('tenant-2', ...schedulingKeys.all),
      });

      expect(requestsFor(mocks.request, read.document)).toHaveLength(read.requestsPerRender);
    });
  });

  describe('a read keyed by one record', () => {
    it('shows nothing, not the previous plan, while another plan loads', async () => {
      mocks.request.mockImplementation(
        async (_client: unknown, _document: unknown, variables: { id: string }) => ({
          weeklyPlan: { id: variables.id },
        }),
      );
      const queryClient = newQueryClient();
      let id = 'wp-1';
      const view = renderInWorkspace(() => useWeeklyPlan(id), 'FARM', queryClient);
      await waitFor(() => expect(view.result.current.data).toEqual({ id: 'wp-1' }));

      mocks.request.mockImplementation(() => new Promise<never>(() => undefined));
      id = 'wp-2';
      view.rerender();

      expect(view.result.current.data).toBeUndefined();
      expect(view.result.current.isPlaceholderData).toBe(false);
    });
  });

  describe('mutations', () => {
    /** Every read a scheduling screen can have mounted at once, one per document. */
    const MOUNTED_DOCUMENTS = [
      GET_WEEKLY_PLANS,
      GET_WEEKLY_PLAN,
      GET_TEAM_WEEKLY_OVERVIEW,
      GET_SCHEDULING_SETTINGS,
      GET_OVERTIME_SUMMARY,
    ] as const;

    function useMountedReads(): void {
      useWeeklyPlans(undefined, 20, 1);
      useWeeklyPlan('wp-1');
      useTeamWeeklyOverview(WEEK);
      useSchedulingSettings();
      useOvertimeSummary(10, 2026);
    }

    interface MutationCase {
      name: string;
      /** The mutation hook, as a function that runs it once with fixed variables. */
      useRun: () => () => Promise<unknown>;
      /** The mounted reads the mutation must refetch; every other mounted read must be left alone. */
      refetches: readonly unknown[];
    }

    const WEEKLY_PLAN_READS = [GET_WEEKLY_PLANS, GET_WEEKLY_PLAN];

    const CREATE_PLAN: MutationCase = {
      name: 'useCreateWeeklyPlan',
      useRun: () => {
        const mutation = useCreateWeeklyPlan();
        return () => mutation.mutateAsync({ employeeId: 'emp-1', weekStartDate: WEEK });
      },
      refetches: MOUNTED_DOCUMENTS,
    };

    const MUTATIONS: MutationCase[] = [
      CREATE_PLAN,
      {
        name: 'useUpdatePlanEntry',
        useRun: () => {
          const mutation = useUpdatePlanEntry();
          return () => mutation.mutateAsync({ entryId: 'entry-1', isOffDay: true });
        },
        refetches: MOUNTED_DOCUMENTS,
      },
      {
        name: 'useBulkAssignShifts',
        useRun: () => {
          const mutation = useBulkAssignShifts();
          return () =>
            mutation.mutateAsync({
              weeklyPlanId: 'wp-1',
              assignments: [{ date: WEEK, isOffDay: true }],
            });
        },
        refetches: WEEKLY_PLAN_READS,
      },
      {
        name: 'useCopyWeeklyPlan',
        useRun: () => {
          const mutation = useCopyWeeklyPlan();
          return () =>
            mutation.mutateAsync({ sourceId: 'wp-1', targetWeekStartDate: '2026-10-19' });
        },
        refetches: WEEKLY_PLAN_READS,
      },
      {
        name: 'usePublishWeeklyPlan',
        useRun: () => {
          const mutation = usePublishWeeklyPlan();
          return () => mutation.mutateAsync('wp-1');
        },
        refetches: WEEKLY_PLAN_READS,
      },
      {
        name: 'useDeleteWeeklyPlan',
        useRun: () => {
          const mutation = useDeleteWeeklyPlan();
          return () => mutation.mutateAsync('wp-1');
        },
        refetches: WEEKLY_PLAN_READS,
      },
      {
        name: 'useAssignScheduleCell',
        useRun: () => {
          const mutation = useAssignScheduleCell();
          return () =>
            mutation.mutateAsync({
              employeeId: 'emp-1',
              weekStartDate: WEEK,
              weeklyPlanId: 'wp-1',
              date: WEEK,
              shiftId: 'shift-1',
            });
        },
        refetches: [GET_TEAM_WEEKLY_OVERVIEW, ...WEEKLY_PLAN_READS],
      },
      {
        name: 'usePublishWeekPlans',
        useRun: () => {
          const mutation = usePublishWeekPlans();
          return () => mutation.mutateAsync({ weekStartDate: WEEK, planIds: ['wp-1'] });
        },
        refetches: [GET_TEAM_WEEKLY_OVERVIEW, ...WEEKLY_PLAN_READS],
      },
      {
        name: 'useUpdateSchedulingSettings',
        useRun: () => {
          const mutation = useUpdateSchedulingSettings();
          return () => mutation.mutateAsync({ standardWeeklyMinutes: 2400 });
        },
        refetches: [GET_SCHEDULING_SETTINGS],
      },
    ];

    function isInvalidated(queryClient: QueryClient, queryKey: readonly unknown[]): boolean {
      const query = queryClient.getQueryCache().find({ queryKey, exact: true });
      if (query === undefined) throw new Error('No cache entry under the key');
      return query.state.isInvalidated;
    }

    async function mountReadsAnd(
      useRun: MutationCase['useRun'],
      queryClient: QueryClient,
    ): Promise<() => Promise<unknown>> {
      const view = renderInWorkspace(
        () => {
          useMountedReads();
          return useRun();
        },
        'FARM',
        queryClient,
      );
      await waitFor(() => {
        for (const document of MOUNTED_DOCUMENTS) {
          expect(requestsFor(mocks.request, document)).toHaveLength(1);
        }
        expect(queryClient.isFetching()).toBe(0);
      });
      return () => view.result.current();
    }

    it.each(MUTATIONS)('$name refetches exactly the reads it changes', async (mutation) => {
      const queryClient = newQueryClient();
      const run = await mountReadsAnd(mutation.useRun, queryClient);

      await act(async () => {
        await run();
      });

      await waitFor(() => {
        for (const document of mutation.refetches) {
          expect(requestsFor(mocks.request, document).length).toBeGreaterThan(1);
        }
      });
      for (const document of MOUNTED_DOCUMENTS) {
        if (!mutation.refetches.includes(document)) {
          expect(requestsFor(mocks.request, document)).toHaveLength(1);
        }
      }
    });

    it('leaves another tenant’s cached scheduling entries alone', async () => {
      const queryClient = newQueryClient();
      const otherTenantKeys = [
        createTenantQueryKey('tenant-2', ...schedulingKeys.settings()),
        createTenantQueryKey('tenant-2', ...schedulingKeys.weeklyPlan('wp-9')),
      ];
      for (const key of otherTenantKeys) queryClient.setQueryData(key, { cached: 'tenant-2' });
      const run = await mountReadsAnd(CREATE_PLAN.useRun, queryClient);

      await act(async () => {
        await run();
      });

      for (const key of otherTenantKeys) {
        expect(isInvalidated(queryClient, key)).toBe(false);
      }
    });
  });
});
