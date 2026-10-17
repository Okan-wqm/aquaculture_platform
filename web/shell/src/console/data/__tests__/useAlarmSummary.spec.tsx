/**
 * useAlarmSummary — the annunciator's counts from alert-engine activeAlertCounts.
 *
 * The hook reads the server's grouped count of unresolved alarms (no page, so
 * an older active CRITICAL is counted however many advisories or cleared
 * alarms came after it), only for viewers whose tenant holds the sensor module
 * (the alarm list and the annunciator exist only then), and refreshes every
 * 15 s. Every non-ready state carries null counts so a tile can never show a
 * made-up zero — including after a refresh fails, when the last counts are no
 * longer current.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authFrom, createWrapper, defaultAuth, moduleOf, type AuthFixture } from './harness';

const auth = vi.hoisted((): { current: AuthFixture } => ({
  current: {
    token: 'tok',
    tenantId: 'tenant-1',
    isTenantAdmin: false,
    permissions: [],
    modules: [],
  },
}));
const request = vi.hoisted(() => vi.fn());

vi.mock('../../../../../shared-ui/src/hooks/useAuth', () => ({
  useAuth: () => authFrom(auth.current),
}));

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return {
    ...actual,
    graphqlClient: { request },
    useAuthContext: () => ({ modules: auth.current.modules }),
  };
});

import { ACTIVE_ALERT_COUNTS_QUERY } from '../console.operations';
import { ALARM_REFRESH_MS } from '../useActiveAlertCounts';
import { useAlarmSummary } from '../useAlarmSummary';
import { useWorkspaceAlarmCounts } from '../useWorkspaceAlarmCounts';

const COUNTS = [
  { severity: 'CRITICAL', acknowledged: false, count: 1 },
  { severity: 'CRITICAL', acknowledged: true, count: 1 },
  { severity: 'HIGH', acknowledged: false, count: 1 },
  { severity: 'WARNING', acknowledged: false, count: 1 },
];

function answerCounts(rows: typeof COUNTS = COUNTS): void {
  request.mockResolvedValue({ activeAlertCounts: rows });
}

beforeEach(() => {
  auth.current = defaultAuth();
  request.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAlarmSummary', () => {
  it('counts the alarms of a sensor-module user from one server-side count', async () => {
    auth.current.modules = [moduleOf('sensor')];
    answerCounts();
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAlarmSummary(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toEqual({
      status: 'ready',
      p1: 2,
      p2: 1,
      p3: 1,
      unack: 3,
      p1Unack: 1,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(ACTIVE_ALERT_COUNTS_QUERY, undefined, expect.anything());
  });

  it('counts every module’s alarms, and the menu’s per-module counts come from the same request', async () => {
    // ALERT-MEDIUM-010: the query groups by module; the annunciator sums all
    // rows (an alarm without a module included), the workspace menu splits.
    auth.current.modules = [moduleOf('sensor')];
    request.mockResolvedValue({
      activeAlertCounts: [
        { severity: 'CRITICAL', acknowledged: false, module: 'FARM', count: 1 },
        { severity: 'CRITICAL', acknowledged: false, module: 'SENSOR', count: 2 },
        { severity: 'HIGH', acknowledged: true, module: null, count: 1 },
      ],
    });
    const { wrapper } = createWrapper();

    const { result } = renderHook(
      () => ({ summary: useAlarmSummary(), menu: useWorkspaceAlarmCounts() }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.menu.status).toBe('ready'));
    expect(result.current.summary).toMatchObject({ status: 'ready', p1: 3, p2: 1, p1Unack: 3 });
    expect(result.current.menu).toEqual({
      status: 'ready',
      byWorkspace: {
        aqua: { p1: 1, p2: 0, p3: 0 },
        ctl: { p1: 2, p2: 0, p3: 0 },
        gh: { p1: 0, p2: 0, p3: 0 },
      },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(ACTIVE_ALERT_COUNTS_QUERY).toContain('activeAlertCounts(groupBy: [MODULE])');
  });

  it('gives the menu no counts, with no request, for a viewer without the sensor module', () => {
    auth.current.modules = [moduleOf('farm')];
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useWorkspaceAlarmCounts(), { wrapper });

    expect(result.current).toEqual({ status: 'unavailable', byWorkspace: null });
    expect(request).not.toHaveBeenCalled();
  });

  it('lights P1 for one older active critical behind hundreds of newer advisories and cleared alarms', async () => {
    // What the count replaced: the newest 100 unacknowledged history rows were
    // INFO feed transitions, so the critical below them was never seen. The
    // server counts unresolved rows only, every one of them.
    auth.current.modules = [moduleOf('sensor')];
    answerCounts([
      { severity: 'INFO', acknowledged: false, count: 250 },
      { severity: 'CRITICAL', acknowledged: false, count: 1 },
    ]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAlarmSummary(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.p1).toBe(1);
    expect(result.current.unack).toBe(1);
  });

  it('reports more than a page of unacknowledged alarms exactly', async () => {
    auth.current.modules = [moduleOf('sensor')];
    answerCounts([{ severity: 'HIGH', acknowledged: false, count: 140 }]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAlarmSummary(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.unack).toBe(140);
  });

  it('reads the counts for a tenant admin whose tenant holds the sensor module', async () => {
    auth.current.isTenantAdmin = true;
    auth.current.modules = [moduleOf('sensor')];
    answerCounts();
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAlarmSummary(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.p1).toBe(2);
  });

  it('is unavailable, with no request, for a tenant admin without the sensor module', () => {
    // No alarm list, so no annunciator or badge: nothing would show the counts.
    auth.current.isTenantAdmin = true;
    auth.current.modules = [moduleOf('farm')];
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAlarmSummary(), { wrapper });

    expect(result.current.status).toBe('unavailable');
    expect(request).not.toHaveBeenCalled();
  });

  it('is unavailable, with no request, for a user without the sensor module', () => {
    auth.current.modules = [moduleOf('farm')];
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAlarmSummary(), { wrapper });

    expect(result.current.status).toBe('unavailable');
    expect(result.current.p1).toBeNull();
    expect(result.current.unack).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('is unavailable without an authenticated tenant session', () => {
    auth.current.modules = [moduleOf('sensor')];
    auth.current.tenantId = null;
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAlarmSummary(), { wrapper });

    expect(result.current.status).toBe('unavailable');
    expect(request).not.toHaveBeenCalled();
  });

  it('is loading with null counts until the count arrives', () => {
    auth.current.modules = [moduleOf('sensor')];
    request.mockImplementation(() => new Promise(() => undefined));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAlarmSummary(), { wrapper });

    expect(result.current).toEqual({
      status: 'loading',
      p1: null,
      p2: null,
      p3: null,
      unack: null,
      p1Unack: null,
    });
  });

  it('reports an error with null counts when the count fails', async () => {
    auth.current.modules = [moduleOf('sensor')];
    request.mockRejectedValue(new Error('alert-engine down'));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAlarmSummary(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.p1).toBeNull();
  });

  it('refreshes the counts every 15 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    auth.current.modules = [moduleOf('sensor')];
    answerCounts();
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAlarmSummary(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(ALARM_REFRESH_MS);

    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(ALARM_REFRESH_MS).toBe(15_000);
  });

  it('turns ready counts into an error with null counts when a refresh fails', async () => {
    // The cached counts are no longer current once a poll fails: the
    // annunciator must not keep presenting them as live (dataStatus.resultFrom).
    vi.useFakeTimers({ shouldAdvanceTime: true });
    auth.current.modules = [moduleOf('sensor')];
    request
      .mockResolvedValueOnce({ activeAlertCounts: COUNTS })
      .mockRejectedValue(new Error('alert-engine down'));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAlarmSummary(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.p1).toBe(2);

    // The failed poll settles the query, which re-renders the hook.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ALARM_REFRESH_MS);
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current).toEqual({
      status: 'error',
      p1: null,
      p2: null,
      p3: null,
      unack: null,
      p1Unack: null,
    });
  });
});
