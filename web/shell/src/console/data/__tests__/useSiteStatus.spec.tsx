/**
 * useSiteStatus — "2 of 3 sites live" for the title block.
 *
 * total = farm-service activeSites (the viewer's active sites); live = those
 * of them with at least one online edge device in service (sensor-service
 * edgeDevices, isOnline + inService, grouped by siteId). Needs the farm module
 * for the sites and device access (sensor module or tenant admin) for the
 * devices; otherwise 'unavailable' with no request. A source that fails —
 * first time or on a later poll — fails the ratio.
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

import { ACTIVE_SITES_QUERY, EDGE_DEVICES_QUERY } from '../console.operations';
import { countLiveSites } from '../liveSites';
import { useSiteStatus } from '../useSiteStatus';

function onlineDevice(
  id: string,
  siteId: string | null,
): {
  id: string;
  deviceCode: string;
  deviceName: string;
  isOnline: boolean;
  siteId: string | null;
} {
  return { id, deviceCode: `EG-${id}`, deviceName: id, isOnline: true, siteId };
}

function answer(sites: string[], devices: ReturnType<typeof onlineDevice>[]): void {
  request.mockImplementation(async (query: string) => {
    if (query === ACTIVE_SITES_QUERY) {
      return { activeSites: sites.map((id) => ({ id, name: `Site ${id}` })) };
    }
    if (query === EDGE_DEVICES_QUERY) return { edgeDevices: { items: devices, totalPages: 1 } };
    throw new Error(`unexpected query ${query}`);
  });
}

beforeEach(() => {
  auth.current = defaultAuth();
  request.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('countLiveSites', () => {
  it('counts each active site with an online device once', () => {
    expect(
      countLiveSites(
        ['s1', 's2', 's3'],
        [onlineDevice('a', 's1'), onlineDevice('b', 's1'), onlineDevice('c', 's3')],
      ),
    ).toBe(2);
  });

  it('ignores devices with no site and devices on sites outside the active set', () => {
    expect(
      countLiveSites(['s1'], [onlineDevice('a', null), onlineDevice('b', 'closed-site')]),
    ).toBe(0);
  });
});

describe('useSiteStatus', () => {
  it('reports live of total for a farm and sensor user', async () => {
    auth.current.modules = [moduleOf('farm'), moduleOf('sensor')];
    answer(['s1', 's2', 's3'], [onlineDevice('a', 's1'), onlineDevice('b', 's2')]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useSiteStatus(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toEqual({ status: 'ready', live: 2, total: 3 });
    expect(request).toHaveBeenCalledWith(
      EDGE_DEVICES_QUERY,
      expect.objectContaining({ isOnline: true, inService: true, page: 1 }),
      expect.anything(),
    );
  });

  it('reads the devices for a tenant admin with the farm module', async () => {
    auth.current.isTenantAdmin = true;
    auth.current.modules = [moduleOf('farm')];
    answer(['s1'], []);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useSiteStatus(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toEqual({ status: 'ready', live: 0, total: 1 });
  });

  it('is unavailable, with no request, when the farm module is not assigned', () => {
    auth.current.isTenantAdmin = true;
    auth.current.modules = [moduleOf('sensor')];
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useSiteStatus(), { wrapper });

    expect(result.current).toEqual({ status: 'unavailable', live: null, total: null });
    expect(request).not.toHaveBeenCalled();
  });

  it('is unavailable when the viewer cannot read devices', () => {
    auth.current.modules = [moduleOf('farm')];
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useSiteStatus(), { wrapper });

    expect(result.current.status).toBe('unavailable');
    expect(request).not.toHaveBeenCalled();
  });

  it('reports an error when either source fails', async () => {
    auth.current.modules = [moduleOf('farm'), moduleOf('sensor')];
    request.mockImplementation(async (query: string) => {
      if (query === ACTIVE_SITES_QUERY) return { activeSites: [{ id: 's1', name: 'Site s1' }] };
      throw new Error('sensor-service down');
    });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useSiteStatus(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.live).toBeNull();
    expect(result.current.total).toBeNull();
  });

  it('turns a ready ratio into an error when the device poll later fails', async () => {
    // The sites are still cached, but live is no longer known: half a ratio is
    // not a value, so the cell must not keep showing the last-good one.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    auth.current.modules = [moduleOf('farm'), moduleOf('sensor')];
    let devicesUp = true;
    request.mockImplementation(async (query: string) => {
      if (query === ACTIVE_SITES_QUERY) return { activeSites: [{ id: 's1', name: 'Site s1' }] };
      if (query === EDGE_DEVICES_QUERY && devicesUp) {
        return { edgeDevices: { items: [onlineDevice('a', 's1')], totalPages: 1 } };
      }
      throw new Error('sensor-service down');
    });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useSiteStatus(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toEqual({ status: 'ready', live: 1, total: 1 });

    devicesUp = false;
    // The failed poll settles the query, which re-renders the hook.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current).toEqual({ status: 'error', live: null, total: null });
  });
});
