import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTenantAdminQueryWrapper,
  createTenantAdminTestQueryClient,
} from '../../test/query-client';

const testState = vi.hoisted(() => ({
  auth: {
    tenantId: 'tenant-a' as string | null,
    token: 'token-a' as string | null,
    role: 'TENANT_ADMIN' as string,
    epoch: 0,
  },
  api: {
    getActiveTenantSites: vi.fn(),
    getUserAssignedSiteIds: vi.fn(),
    assignUserToSite: vi.fn(),
    unassignUserFromSite: vi.fn(),
  },
}));

vi.mock('@aquaculture/shared-ui', () => ({
  createTenantQueryKey: (
    tenantId: string | null,
    ...segments: readonly unknown[]
  ): readonly unknown[] => [
    'tenant',
    tenantId,
    ...segments,
    { __sessionEpoch: testState.auth.epoch },
  ],
  getSessionSnapshot: () => ({
    accessToken: testState.auth.token,
    effectiveTenantId: testState.auth.tenantId,
    sessionEpoch: testState.auth.epoch,
    tokenState: testState.auth.token ? 'valid' : 'empty',
    ready: Boolean(testState.auth.token && testState.auth.tenantId),
  }),
  hasSameTenantSessionBoundary: (
    previous: readonly unknown[],
    current: readonly unknown[],
  ): boolean =>
    previous[1] === current[1] &&
    JSON.stringify(previous.at(-1)) === JSON.stringify(current.at(-1)),
  useAuth: () => ({
    tenantId: testState.auth.tenantId,
    token: testState.auth.token,
    user: { role: testState.auth.role },
  }),
}));

vi.mock('../../lib/api', () => ({
  getActiveTenantSites: (...args: unknown[]) => testState.api.getActiveTenantSites(...args),
  getUserAssignedSiteIds: (...args: unknown[]) => testState.api.getUserAssignedSiteIds(...args),
  assignUserToSite: (...args: unknown[]) => testState.api.assignUserToSite(...args),
  unassignUserFromSite: (...args: unknown[]) => testState.api.unassignUserFromSite(...args),
}));

import {
  SiteAccessSessionChangedError,
  useAssignUserToSite,
  useUserAssignedSiteIds,
  userSiteAccessKeys,
} from '../useUserSiteAccess';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';

function createClient(): QueryClient {
  return createTenantAdminTestQueryClient();
}

describe('tenant-admin user site access hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.auth.tenantId = 'tenant-a';
    testState.auth.token = 'token-a';
    testState.auth.role = 'TENANT_ADMIN';
    testState.auth.epoch = 0;
  });

  it('does not carry assignment data across a tenant/session boundary', async () => {
    testState.api.getUserAssignedSiteIds.mockImplementation(() =>
      Promise.resolve(testState.auth.tenantId === 'tenant-a' ? ['site-a'] : ['site-b']),
    );
    const queryClient = createClient();
    const { result, rerender } = renderHook(() => useUserAssignedSiteIds(USER_ID, true), {
      wrapper: createTenantAdminQueryWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.data).toEqual(['site-a']));

    testState.auth.tenantId = 'tenant-b';
    testState.auth.token = 'token-b';
    testState.auth.epoch = 1;
    rerender();

    expect(result.current.data).not.toEqual(['site-a']);
    await waitFor(() => expect(result.current.data).toEqual(['site-b']));
    expect(
      queryClient.getQueryData(userSiteAccessKeys.assignments('tenant-a', USER_ID)),
    ).toBeUndefined();
  });

  it('invalidates the exact assignment snapshot only after a successful write', async () => {
    testState.api.assignUserToSite.mockResolvedValue({
      success: true,
      message: 'Assigned',
      userId: USER_ID,
      siteId: SITE_ID,
    });
    const queryClient = createClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useAssignUserToSite(), {
      wrapper: createTenantAdminQueryWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ userId: USER_ID, siteId: SITE_ID });
    });

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: [
        'tenant',
        'tenant-a',
        'userSiteAccess',
        'assignments',
        USER_ID,
        { __sessionEpoch: 0 },
      ],
      exact: true,
      refetchType: 'none',
    });
  });

  it('does not alter or invalidate authoritative cache when a write fails', async () => {
    testState.api.assignUserToSite.mockRejectedValue(new Error('write failed'));
    const queryClient = createClient();
    const key = userSiteAccessKeys.assignments('tenant-a', USER_ID);
    queryClient.setQueryData(key, ['site-existing']);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useAssignUserToSite(), {
      wrapper: createTenantAdminQueryWrapper(queryClient),
    });

    await expect(result.current.mutateAsync({ userId: USER_ID, siteId: SITE_ID })).rejects.toThrow(
      'write failed',
    );

    expect(queryClient.getQueryData(key)).toEqual(['site-existing']);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('rejects an old mutation completion after the tenant/session changes', async () => {
    let resolveWrite:
      | ((value: { success: boolean; message: string; userId: string; siteId: string }) => void)
      | undefined;
    testState.api.assignUserToSite.mockReturnValue(
      new Promise((resolve) => {
        resolveWrite = resolve;
      }),
    );
    const queryClient = createClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result, rerender } = renderHook(() => useAssignUserToSite(), {
      wrapper: createTenantAdminQueryWrapper(queryClient),
    });

    const settled = result.current
      .mutateAsync({ userId: USER_ID, siteId: SITE_ID })
      .then(() => null)
      .catch((error: unknown) => error);
    await waitFor(() => expect(testState.api.assignUserToSite).toHaveBeenCalled());

    testState.auth.tenantId = 'tenant-b';
    testState.auth.token = 'token-b';
    testState.auth.epoch = 1;
    rerender();
    resolveWrite?.({
      success: true,
      message: 'Assigned in the prior session',
      userId: USER_ID,
      siteId: SITE_ID,
    });

    await expect(settled).resolves.toBeInstanceOf(SiteAccessSessionChangedError);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('does not start a write from a stale render after the session has switched', async () => {
    testState.api.assignUserToSite.mockResolvedValue({
      success: true,
      message: 'Assigned',
      userId: USER_ID,
      siteId: SITE_ID,
    });
    const queryClient = createClient();
    const { result } = renderHook(() => useAssignUserToSite(), {
      wrapper: createTenantAdminQueryWrapper(queryClient),
    });

    // Simulate storage/session rotation before React has rerendered this hook.
    testState.auth.tenantId = 'tenant-b';
    testState.auth.token = 'token-b';
    testState.auth.epoch = 1;

    await expect(
      result.current.mutateAsync({ userId: USER_ID, siteId: SITE_ID }),
    ).rejects.toBeInstanceOf(SiteAccessSessionChangedError);
    expect(testState.api.assignUserToSite).not.toHaveBeenCalled();
  });

  it('fails closed before calling the API for a non-admin role', async () => {
    testState.auth.role = 'MODULE_MANAGER';
    const queryClient = createClient();
    const { result } = renderHook(() => useAssignUserToSite(), {
      wrapper: createTenantAdminQueryWrapper(queryClient),
    });

    await expect(result.current.mutateAsync({ userId: USER_ID, siteId: SITE_ID })).rejects.toThrow(
      'not authorized',
    );
    expect(testState.api.assignUserToSite).not.toHaveBeenCalled();
  });
});
