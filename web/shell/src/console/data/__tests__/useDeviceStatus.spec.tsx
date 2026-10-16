/**
 * useDeviceStatus — "11 of 12 devices online" from sensor-service edgeDeviceStats.
 *
 * The figure is the fleet in service (inService / onlineInService): a
 * decommissioned device keeps its row, and counting it would show it as down.
 * Device data is readable by viewers who have the sensor module or administer
 * the tenant (the tenant console's Devices page); anyone else gets
 * 'unavailable' and no request, and every non-ready state carries null counts.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { EDGE_DEVICE_STATS_QUERY } from '../console.operations';
import { useDeviceStatus } from '../useDeviceStatus';

beforeEach(() => {
  auth.current = defaultAuth();
  request.mockReset();
});

describe('useDeviceStatus', () => {
  it('reads the fleet in service from edgeDeviceStats for a sensor-module user', async () => {
    auth.current.modules = [moduleOf('sensor')];
    request.mockResolvedValue({ edgeDeviceStats: { inService: 12, onlineInService: 11 } });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useDeviceStatus(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toEqual({ status: 'ready', online: 11, total: 12 });
    expect(request).toHaveBeenCalledWith(EDGE_DEVICE_STATS_QUERY, undefined, expect.anything());
    expect(EDGE_DEVICE_STATS_QUERY).toMatch(/\binService\b/);
    expect(EDGE_DEVICE_STATS_QUERY).toMatch(/\bonlineInService\b/);
    expect(EDGE_DEVICE_STATS_QUERY).not.toMatch(/\btotal\b/);
  });

  it('shows a fleet with one decommissioned device and the rest online as all online', async () => {
    // 12 registered, 1 decommissioned, 11 online: sensor-service reports the
    // 11 in service, so the cell reads 11 of 11, not a permanent 11 of 12.
    auth.current.modules = [moduleOf('sensor')];
    request.mockResolvedValue({ edgeDeviceStats: { inService: 11, onlineInService: 11 } });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useDeviceStatus(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toEqual({ status: 'ready', online: 11, total: 11 });
  });

  it('reads the counts for a tenant admin without the sensor module', async () => {
    auth.current.isTenantAdmin = true;
    request.mockResolvedValue({ edgeDeviceStats: { inService: 0, onlineInService: 0 } });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useDeviceStatus(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toEqual({ status: 'ready', online: 0, total: 0 });
  });

  it('is unavailable, with no request, for a viewer without device access', () => {
    auth.current.modules = [moduleOf('hr')];
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useDeviceStatus(), { wrapper });

    expect(result.current).toEqual({ status: 'unavailable', online: null, total: null });
    expect(request).not.toHaveBeenCalled();
  });

  it('reports an error with null counts when the query fails', async () => {
    auth.current.isTenantAdmin = true;
    request.mockRejectedValue(new Error('sensor-service down'));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useDeviceStatus(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.online).toBeNull();
    expect(result.current.total).toBeNull();
  });
});
