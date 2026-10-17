/**
 * usePaletteSources — people and devices for the command palette.
 *
 * People come from auth-service tenantUsers (users:view, the guard of the
 * users page a person entry opens), with the email and role the palette
 * matches and shows; devices from every page of sensor-service edgeDevices,
 * the fleet in service, each named with its site from farm-service
 * activeSites when the viewer holds the farm module. Both are fetched only
 * while the palette is open and handed over whole: the palette's own ranking
 * is the one matcher (paletteEntries.spec pins people and devices through
 * it), and the query is not an input here, so typing can never refetch.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
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

import { ACTIVE_SITES_QUERY, EDGE_DEVICES_QUERY, TENANT_USERS_QUERY } from '../console.operations';
import { usePaletteSources } from '../usePaletteSources';

const USERS = [
  {
    id: 'u1',
    firstName: 'İlker',
    lastName: 'Şahin',
    email: 'ilker@suderra.test',
    role: 'MODULE_MANAGER',
  },
  {
    id: 'u2',
    firstName: 'Bjørn',
    lastName: null,
    email: 'bjorn@suderra.test',
    role: 'MODULE_USER',
  },
  { id: 'u3', firstName: null, lastName: null, email: 'ops@suderra.test', role: 'TENANT_ADMIN' },
];

const DEVICES = [
  {
    id: 'd1',
    deviceCode: 'EG-KLK-03',
    deviceName: 'Kuluçka gateway',
    isOnline: true,
    siteId: 's1',
  },
  { id: 'd2', deviceCode: 'EG-SEA-01', deviceName: 'Sea pens', isOnline: false, siteId: null },
  // On a site outside the viewer's active set: no name they may read.
  { id: 'd3', deviceCode: 'EG-OLD-02', deviceName: 'Old pier', isOnline: false, siteId: 's9' },
];

const SITES = [{ id: 's1', name: 'Kuluçkahane' }];

function answer(): void {
  request.mockImplementation(async (query: string) => {
    if (query === TENANT_USERS_QUERY) return { tenantUsers: USERS };
    if (query === EDGE_DEVICES_QUERY) return { edgeDevices: { items: DEVICES, totalPages: 1 } };
    if (query === ACTIVE_SITES_QUERY) return { activeSites: SITES };
    throw new Error(`unexpected query ${query}`);
  });
}

beforeEach(() => {
  auth.current = defaultAuth();
  request.mockReset();
});

describe('usePaletteSources', () => {
  it('fetches nothing while the palette is closed', () => {
    auth.current.isTenantAdmin = true;
    auth.current.modules = [moduleOf('farm'), moduleOf('sensor')];
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => usePaletteSources(false), { wrapper });

    expect(result.current.people).toEqual({ status: 'unavailable', items: null });
    expect(result.current.devices).toEqual({ status: 'unavailable', items: null });
    expect(request).not.toHaveBeenCalled();
  });

  it('returns every person, with email and role, and every device with its site while open', async () => {
    auth.current.isTenantAdmin = true;
    auth.current.modules = [moduleOf('farm'), moduleOf('sensor')];
    answer();
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => usePaletteSources(true), { wrapper });

    await waitFor(() => expect(result.current.people.status).toBe('ready'));
    await waitFor(() => expect(result.current.devices.status).toBe('ready'));
    expect(result.current.people.items).toEqual([
      { id: 'u1', name: 'İlker Şahin', email: 'ilker@suderra.test', role: 'MODULE_MANAGER' },
      { id: 'u2', name: 'Bjørn', email: 'bjorn@suderra.test', role: 'MODULE_USER' },
      { id: 'u3', name: '', email: 'ops@suderra.test', role: 'TENANT_ADMIN' },
    ]);
    expect(result.current.devices.items).toEqual([
      {
        id: 'd1',
        code: 'EG-KLK-03',
        name: 'Kuluçka gateway',
        isOnline: true,
        siteName: 'Kuluçkahane',
      },
      { id: 'd2', code: 'EG-SEA-01', name: 'Sea pens', isOnline: false, siteName: null },
      { id: 'd3', code: 'EG-OLD-02', name: 'Old pier', isOnline: false, siteName: null },
    ]);
  });

  it('asks the device list for the fleet in service only', async () => {
    auth.current.modules = [moduleOf('sensor')];
    answer();
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => usePaletteSources(true), { wrapper });

    await waitFor(() => expect(result.current.devices.status).toBe('ready'));
    expect(request).toHaveBeenCalledWith(
      EDGE_DEVICES_QUERY,
      expect.objectContaining({ inService: true }),
      expect.anything(),
    );
  });

  it('lists devices without site names, and asks no farm read, without the farm module', async () => {
    auth.current.modules = [moduleOf('sensor')];
    answer();
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => usePaletteSources(true), { wrapper });

    await waitFor(() => expect(result.current.devices.status).toBe('ready'));
    expect(result.current.devices.items?.map((device) => device.siteName)).toEqual([
      null,
      null,
      null,
    ]);
    expect(request).not.toHaveBeenCalledWith(ACTIVE_SITES_QUERY, undefined, expect.anything());
  });

  it('fetches each list once per session: a re-render does not refetch', async () => {
    auth.current.isTenantAdmin = true;
    auth.current.modules = [moduleOf('farm'), moduleOf('sensor')];
    answer();
    const { wrapper } = createWrapper();

    const { result, rerender } = renderHook(() => usePaletteSources(true), { wrapper });
    await waitFor(() => expect(result.current.devices.status).toBe('ready'));
    await waitFor(() => expect(result.current.people.status).toBe('ready'));
    const calls = request.mock.calls.length;

    act(() => rerender());

    expect(request.mock.calls.length).toBe(calls);
  });

  it('offers people to a delegate holding users:view, and no devices without device access', async () => {
    auth.current.permissions = ['users:view'];
    auth.current.modules = [moduleOf('hr')];
    answer();
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => usePaletteSources(true), { wrapper });

    await waitFor(() => expect(result.current.people.status).toBe('ready'));
    expect(result.current.people.items?.map((p) => p.id)).toEqual(['u1', 'u2', 'u3']);
    expect(result.current.devices).toEqual({ status: 'unavailable', items: null });
    expect(request).not.toHaveBeenCalledWith(
      EDGE_DEVICES_QUERY,
      expect.anything(),
      expect.anything(),
    );
  });

  it('asks for no people without users:view, the guard of tenantUsers', () => {
    auth.current.modules = [moduleOf('hr')];
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => usePaletteSources(true), { wrapper });

    expect(result.current.people).toEqual({ status: 'unavailable', items: null });
    expect(request).not.toHaveBeenCalled();
  });

  it('fetches only the sources the caller can link to (a viewer with no people page)', async () => {
    auth.current.isTenantAdmin = true;
    answer();
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => usePaletteSources(true, { people: false, devices: true }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.devices.status).toBe('ready'));
    expect(result.current.people).toEqual({ status: 'unavailable', items: null });
    expect(request).not.toHaveBeenCalledWith(TENANT_USERS_QUERY, undefined, expect.anything());
  });

  it('reports an error per source', async () => {
    auth.current.isTenantAdmin = true;
    request.mockImplementation(async (query: string) => {
      if (query === TENANT_USERS_QUERY) throw new Error('auth-service down');
      return { edgeDevices: { items: DEVICES, totalPages: 1 } };
    });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => usePaletteSources(true), { wrapper });

    await waitFor(() => expect(result.current.people.status).toBe('error'));
    await waitFor(() => expect(result.current.devices.status).toBe('ready'));
    expect(result.current.people.items).toBeNull();
    expect(result.current.devices.items).toHaveLength(3);
  });

  it('fails the device list when its site names fail, rather than dropping the sites', async () => {
    auth.current.isTenantAdmin = true;
    auth.current.modules = [moduleOf('farm'), moduleOf('sensor')];
    request.mockImplementation(async (query: string) => {
      if (query === ACTIVE_SITES_QUERY) throw new Error('farm-service down');
      if (query === EDGE_DEVICES_QUERY) return { edgeDevices: { items: DEVICES, totalPages: 1 } };
      return { tenantUsers: USERS };
    });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => usePaletteSources(true), { wrapper });

    await waitFor(() => expect(result.current.devices.status).toBe('error'));
    expect(result.current.devices.items).toBeNull();
  });
});
