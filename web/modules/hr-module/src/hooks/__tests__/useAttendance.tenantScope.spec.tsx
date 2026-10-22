/**
 * Attendance hooks — every read and write lives under the tenant's cache prefix.
 *
 * The reads go through `useTenantQuery`, so their entries are stored as
 * `['tenant', tenantId, ...attendanceKeys.*, { epoch }]`. That is what lets another tenant's
 * session never find them (FE-CRITICAL-014) and what lets `useEmployees`' workforce invalidation
 * (`createTenantInvalidationKey(tenantId, ...attendanceKeys.all)`) and this file's own mutations
 * reach them. Real QueryClient, mocked `graphqlRequest`: a refetch is a request that went out.
 */
import {
  WorkforceScopeProvider,
  createTenantInvalidationKey,
  createTenantQueryKey,
} from '@aquaculture/shared-ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor, type RenderHookResult } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  APPROVE_ATTENDANCE,
  CLOCK_IN,
  CLOCK_OUT,
  CREATE_MANUAL_ATTENDANCE,
  CREATE_SHIFT,
  GET_ATTENDANCE_RECORDS,
  GET_ATTENDANCE_SUMMARY,
  GET_DAILY_ATTENDANCE_OVERVIEW,
  GET_MY_ATTENDANCE_RECORDS,
  GET_SHIFT,
  GET_SHIFTS,
  GET_TODAYS_ATTENDANCE,
  UPDATE_SHIFT,
} from '../../graphql';
import { ClockMethod, DayOfWeek } from '../../types';
import {
  attendanceKeys,
  useApproveAttendance,
  useAttendanceRecords,
  useAttendanceSummary,
  useClockIn,
  useClockOut,
  useCreateManualAttendance,
  useCreateShift,
  useDailyAttendanceOverview,
  useMyAttendanceRecords,
  useShift,
  useShifts,
  useTeamTodaysAttendance,
  useTodaysAttendance,
  useUpdateShift,
} from '../useAttendance';
import { newQueryClient, requestsFor, type Workspace } from './scopeHarness';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  auth: { token: 'token-1' as string | null, tenantId: 'tenant-1' as string | null },
}));

vi.mock('../useGraphQL', () => ({
  useGraphQLClient: () => ({ client: true }),
  graphqlRequest: mocks.request,
}));

// WHY: useTenantQuery reads the session from the copy of useAuth it imports itself; mocking the
// leaf module is what reaches it (and the barrel's re-export the mutations use).
vi.mock('../../../../../shared-ui/src/hooks/useAuth', () => ({
  useAuth: () => ({ token: mocks.auth.token, tenantId: mocks.auth.tenantId }),
}));

const SHIFT = { id: 'shift-1', code: 'DAY', name: 'Day shift' };
const RENAMED_SHIFT = { ...SHIFT, name: 'Renamed' };

/** What hr-service answers per document; every read's `select` finds the field it unwraps. */
const RESPONSES = new Map<unknown, unknown>([
  [GET_SHIFTS, { shifts: { items: [SHIFT], total: 1 } }],
  [GET_SHIFT, { shift: SHIFT }],
  [GET_ATTENDANCE_RECORDS, { attendanceRecords: { items: [], total: 0 } }],
  [GET_MY_ATTENDANCE_RECORDS, { myAttendanceRecords: [] }],
  [GET_ATTENDANCE_SUMMARY, { attendanceSummary: { employeeId: 'emp-1' } }],
  [GET_DAILY_ATTENDANCE_OVERVIEW, { dailyAttendanceOverview: { date: '2026-10-16' } }],
  [GET_TODAYS_ATTENDANCE, { todaysAttendance: [] }],
  [CLOCK_IN, { clockIn: { id: 'rec-1' } }],
  [CLOCK_OUT, { clockOut: { id: 'rec-1' } }],
  [CREATE_MANUAL_ATTENDANCE, { createManualAttendance: { id: 'rec-2' } }],
  [APPROVE_ATTENDANCE, { approveAttendance: { id: 'rec-1' } }],
  [CREATE_SHIFT, { createShift: SHIFT }],
  [UPDATE_SHIFT, { updateShift: RENAMED_SHIFT }],
]);

/** A request that is never answered: whatever shows while it is pending is not its data. */
function neverAnswered(): Promise<never> {
  return new Promise<never>(() => undefined);
}

interface Rendered<T> extends RenderHookResult<T, unknown> {
  /** Moves the reader to another workspace and renders again, as the console's switcher does. */
  switchTo: (workspace: Workspace) => void;
}

function renderInWorkspace<T>(
  useHook: () => T,
  queryClient: QueryClient,
  workspace: Workspace = 'FARM',
): Rendered<T> {
  const scope = { moduleCode: workspace };
  const rendered = renderHook(useHook, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <WorkforceScopeProvider moduleCode={scope.moduleCode}>{children}</WorkforceScopeProvider>
      </QueryClientProvider>
    ),
  });
  return {
    ...rendered,
    switchTo: (next) => {
      scope.moduleCode = next;
      rendered.rerender();
    },
  };
}

interface ReadResult {
  isSuccess: boolean;
  data: unknown;
  isPlaceholderData: boolean;
}

interface Read {
  name: string;
  document: unknown;
  useRead: () => ReadResult;
  /** The domain segments the hook's key factory builds, between the tenant prefix and the epoch. */
  segments: readonly unknown[];
  /** Whether the key carries `{ moduleCode }`, so another workspace must never stand in for it. */
  moduleScoped: boolean;
}

// Every read is rendered in the FARM workspace.
const READS: Read[] = [
  {
    name: 'useShifts',
    document: GET_SHIFTS,
    useRead: () => useShifts(),
    segments: attendanceKeys.shiftList(undefined),
    moduleScoped: false,
  },
  {
    name: 'useShift',
    document: GET_SHIFT,
    useRead: () => useShift('shift-1'),
    segments: attendanceKeys.shiftDetail('shift-1'),
    moduleScoped: false,
  },
  {
    name: 'useAttendanceRecords',
    document: GET_ATTENDANCE_RECORDS,
    useRead: () => useAttendanceRecords(),
    segments: attendanceKeys.recordList(undefined, undefined, 'FARM'),
    moduleScoped: true,
  },
  {
    name: 'useMyAttendanceRecords',
    document: GET_MY_ATTENDANCE_RECORDS,
    useRead: () => useMyAttendanceRecords(),
    segments: attendanceKeys.myRecords(),
    moduleScoped: false,
  },
  {
    name: 'useAttendanceSummary',
    document: GET_ATTENDANCE_SUMMARY,
    useRead: () => useAttendanceSummary('emp-1', 10, 2026),
    segments: attendanceKeys.summary('emp-1', 10, 2026),
    moduleScoped: false,
  },
  {
    name: 'useDailyAttendanceOverview',
    document: GET_DAILY_ATTENDANCE_OVERVIEW,
    useRead: () => useDailyAttendanceOverview('2026-10-16'),
    segments: attendanceKeys.dailyOverview('2026-10-16', 'FARM'),
    moduleScoped: true,
  },
  {
    name: 'useTodaysAttendance',
    document: GET_TODAYS_ATTENDANCE,
    useRead: () => useTodaysAttendance('emp-1'),
    segments: attendanceKeys.todayOf('emp-1'),
    moduleScoped: false,
  },
  {
    name: 'useTeamTodaysAttendance',
    document: GET_TODAYS_ATTENDANCE,
    useRead: () => useTeamTodaysAttendance(),
    segments: attendanceKeys.todayTeam('FARM'),
    moduleScoped: true,
  },
];

const READ_DOCUMENTS = [...new Set(READS.map((read) => read.document))];

/** Every read mounted at once, so a write is judged by everything it does and does not refresh. */
function useEveryRead(): Record<string, ReadResult> {
  return {
    shifts: useShifts(),
    shift: useShift('shift-1'),
    records: useAttendanceRecords(),
    myRecords: useMyAttendanceRecords(),
    summary: useAttendanceSummary('emp-1', 10, 2026),
    dailyOverview: useDailyAttendanceOverview('2026-10-16'),
    own: useTodaysAttendance('emp-1'),
    team: useTeamTodaysAttendance(),
  };
}

interface Write {
  name: string;
  /** Mounts the mutation and returns the call that runs it. */
  useWrite: () => () => Promise<unknown>;
  /** The documents the write must refetch (document, how many mounted reads ask it); all others stay quiet. */
  refetches: ReadonlyArray<readonly [unknown, number]>;
}

const CLOCK_IN_INPUT = { employeeId: 'emp-1', method: ClockMethod.WEB };

/** What a clock-in or clock-out changes: the records, the caller's own history and both "today" reads. */
const CLOCK_REFETCHES: Write['refetches'] = [
  [GET_ATTENDANCE_RECORDS, 1],
  [GET_MY_ATTENDANCE_RECORDS, 1],
  [GET_TODAYS_ATTENDANCE, 2],
];

const WRITES: Write[] = [
  {
    name: 'useClockIn',
    useWrite: () => {
      const write = useClockIn();
      return () => write.mutateAsync(CLOCK_IN_INPUT);
    },
    refetches: CLOCK_REFETCHES,
  },
  {
    name: 'useClockOut',
    useWrite: () => {
      const write = useClockOut();
      return () => write.mutateAsync(CLOCK_IN_INPUT);
    },
    refetches: CLOCK_REFETCHES,
  },
  {
    name: 'useCreateManualAttendance',
    useWrite: () => {
      const write = useCreateManualAttendance();
      return () =>
        write.mutateAsync({ employeeId: 'emp-1', date: '2026-10-16', reason: 'Forgot to clock' });
    },
    refetches: [[GET_ATTENDANCE_RECORDS, 1]],
  },
  {
    name: 'useApproveAttendance',
    useWrite: () => {
      const write = useApproveAttendance();
      return () => write.mutateAsync({ id: 'rec-1' });
    },
    refetches: [[GET_ATTENDANCE_RECORDS, 1]],
  },
  {
    name: 'useCreateShift',
    useWrite: () => {
      const write = useCreateShift();
      return () =>
        write.mutateAsync({
          code: 'DAY',
          name: 'Day shift',
          startTime: '08:00',
          endTime: '16:00',
          workDays: [DayOfWeek.MONDAY],
        });
    },
    refetches: [
      [GET_SHIFTS, 1],
      [GET_SHIFT, 1],
    ],
  },
  {
    name: 'useUpdateShift',
    useWrite: () => {
      const write = useUpdateShift();
      return () => write.mutateAsync({ id: 'shift-1', name: 'Renamed' });
    },
    refetches: [
      [GET_SHIFTS, 1],
      [GET_SHIFT, 1],
    ],
  },
];

describe('attendance hooks tenant scope', () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.request.mockImplementation(async (_client: unknown, document: unknown) =>
      RESPONSES.get(document),
    );
    mocks.auth.token = 'token-1';
    mocks.auth.tenantId = 'tenant-1';
  });

  describe.each(READS)('$name', (read) => {
    it('stores its entry under the tenant prefix', async () => {
      const queryClient = newQueryClient();
      const { result } = renderInWorkspace(read.useRead, queryClient);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      const keys = queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey);
      expect(keys).toHaveLength(1);
      const [key] = keys;
      expect(key.slice(0, 2)).toEqual(['tenant', 'tenant-1']);
      expect(key).toEqual(createTenantQueryKey('tenant-1', ...read.segments));
    });

    it('is refetched by the tenant’s attendance prefix, which is what the workforce invalidation sends', async () => {
      const queryClient = newQueryClient();
      const { result } = renderInWorkspace(read.useRead, queryClient);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      mocks.request.mockClear();

      await act(async () => {
        await queryClient.invalidateQueries({
          queryKey: createTenantInvalidationKey('tenant-1', ...attendanceKeys.all),
        });
      });

      expect(requestsFor(mocks.request, read.document)).toHaveLength(1);
    });

    it('is left alone by another tenant’s attendance prefix', async () => {
      const queryClient = newQueryClient();
      const { result } = renderInWorkspace(read.useRead, queryClient);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      mocks.request.mockClear();

      await act(async () => {
        await queryClient.invalidateQueries({
          queryKey: createTenantInvalidationKey('tenant-2', ...attendanceKeys.all),
        });
      });

      expect(requestsFor(mocks.request, read.document)).toHaveLength(0);
    });

    it('stays idle until an authenticated tenant session exists', () => {
      mocks.auth.token = null;
      mocks.auth.tenantId = null;

      const { result } = renderInWorkspace(read.useRead, newQueryClient());

      expect(result.current.isSuccess).toBe(false);
      expect(mocks.request).not.toHaveBeenCalled();
    });
  });

  describe.each(READS.filter((read) => read.moduleScoped))('$name across workspaces', (read) => {
    it('never renders the previous workspace’s data while the next workspace loads', async () => {
      const queryClient = newQueryClient();
      const { result, switchTo } = renderInWorkspace(read.useRead, queryClient, 'FARM');
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toBeDefined();

      mocks.request.mockImplementation(neverAnswered);
      switchTo('HYDROPONICS');

      expect(result.current.data).toBeUndefined();
      expect(result.current.isPlaceholderData).toBe(false);
    });
  });

  describe('the clock widget’s own-record read', () => {
    it('shows nothing, not the previous employee’s records, while another’s load', async () => {
      const queryClient = newQueryClient();
      let employeeId = 'emp-1';
      const { result, rerender } = renderInWorkspace(
        () => useTodaysAttendance(employeeId),
        queryClient,
      );
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      mocks.request.mockImplementation(neverAnswered);
      employeeId = 'emp-2';
      rerender();

      expect(result.current.data).toBeUndefined();
      expect(result.current.isPlaceholderData).toBe(false);
    });
  });

  describe.each([
    ['useTodaysAttendance', () => useTodaysAttendance('emp-1')],
    ['useTeamTodaysAttendance', () => useTeamTodaysAttendance()],
  ])('%s polling', (_name, useRead) => {
    it('refreshes every minute and not while the tab is hidden', async () => {
      const queryClient = newQueryClient();
      const { result } = renderInWorkspace(useRead, queryClient);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      const [query] = queryClient.getQueryCache().getAll();
      const [observer] = query.observers;
      expect(observer.options.refetchInterval).toBe(60000);
      expect(observer.options.refetchIntervalInBackground).toBe(false);
    });
  });

  describe('a tenant switch', () => {
    it('gives the new tenant its own entry and never the previous tenant’s data', async () => {
      const queryClient = newQueryClient();
      const { result, rerender } = renderInWorkspace(() => useMyAttendanceRecords(), queryClient);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      mocks.auth.tenantId = 'tenant-2';
      mocks.request.mockImplementation(neverAnswered);
      rerender();

      expect(result.current.data).toBeUndefined();
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey[1]),
      ).toEqual(['tenant-1', 'tenant-2']);
    });
  });

  describe('mutations', () => {
    it.each(WRITES)('$name refetches exactly the mounted reads it changes', async (write) => {
      const queryClient = newQueryClient();
      const { result } = renderInWorkspace(
        () => ({ reads: useEveryRead(), run: write.useWrite() }),
        queryClient,
      );
      await waitFor(() =>
        expect(Object.values(result.current.reads).every((read) => read.isSuccess)).toBe(true),
      );
      mocks.request.mockClear();

      await act(async () => {
        await result.current.run();
      });
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));

      const refetched = new Map(write.refetches);
      for (const document of READ_DOCUMENTS) {
        expect(requestsFor(mocks.request, document)).toHaveLength(refetched.get(document) ?? 0);
      }
    });

    it('useUpdateShift writes the updated shift into the tenant’s mounted detail entry', async () => {
      const queryClient = newQueryClient();
      const { result } = renderInWorkspace(
        () => ({ shift: useShift('shift-1'), update: useUpdateShift() }),
        queryClient,
      );
      await waitFor(() => expect(result.current.shift.data).toEqual(SHIFT));

      // The refetch the invalidation starts is never answered, so what the reader sees is what
      // setQueryData wrote — and it must be the response shape `useShift`'s select unwraps.
      mocks.request.mockImplementation(async (_client: unknown, document: unknown) =>
        document === GET_SHIFT ? neverAnswered() : RESPONSES.get(document),
      );
      await act(async () => {
        await result.current.update.mutateAsync({ id: 'shift-1', name: 'Renamed' });
      });

      expect(result.current.shift.data).toEqual(RENAMED_SHIFT);
      expect(
        queryClient.getQueryData(
          createTenantQueryKey('tenant-1', ...attendanceKeys.shiftDetail('shift-1')),
        ),
      ).toEqual({ shift: RENAMED_SHIFT });
    });
  });
});
