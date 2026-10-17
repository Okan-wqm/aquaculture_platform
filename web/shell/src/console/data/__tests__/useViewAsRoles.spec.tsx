/**
 * useViewAsRoles — the tenant's roles with their capabilities, for the user
 * menu's "view as role".
 *
 * auth-service tenantRoles is guarded by roles:view (TENANT_ADMIN bypasses),
 * so the hook asks only when the viewer holds it; a role with no permission
 * row grants nothing, matching the backend's fail-closed check.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authFrom, createWrapper, defaultAuth, type AuthFixture } from './harness';

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

import { TENANT_ROLES_QUERY } from '../console.operations';
import { useViewAsRoles } from '../useViewAsRoles';

const ROLES = [
  {
    id: 'r1',
    name: 'Operator',
    description: 'Feeds and checks tanks',
    color: '#0ea5e9',
    level: 3,
    isSystem: true,
    permissions: { resourcePermissions: ['feeding:create', 'tanks:view'] },
  },
  {
    id: 'r2',
    name: 'Auditor',
    description: null,
    color: '#64748b',
    level: 5,
    isSystem: false,
    permissions: null,
  },
];

beforeEach(() => {
  auth.current = defaultAuth();
  request.mockReset();
});

describe('useViewAsRoles', () => {
  it('lists the roles with their resource permissions for a tenant admin', async () => {
    auth.current.isTenantAdmin = true;
    request.mockResolvedValue({ tenantRoles: ROLES });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useViewAsRoles(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.roles).toEqual([
      {
        id: 'r1',
        name: 'Operator',
        description: 'Feeds and checks tanks',
        color: '#0ea5e9',
        level: 3,
        isSystem: true,
        resourcePermissions: ['feeding:create', 'tanks:view'],
      },
      {
        id: 'r2',
        name: 'Auditor',
        description: null,
        color: '#64748b',
        level: 5,
        isSystem: false,
        resourcePermissions: [],
      },
    ]);
    expect(request).toHaveBeenCalledWith(TENANT_ROLES_QUERY, undefined, expect.anything());
  });

  it('asks for a delegated user who holds roles:view', async () => {
    auth.current.permissions = ['roles:view'];
    request.mockResolvedValue({ tenantRoles: ROLES });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useViewAsRoles(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.roles).toHaveLength(2);
  });

  it('is unavailable, with no request, without roles:view', () => {
    auth.current.permissions = ['tanks:view'];
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useViewAsRoles(), { wrapper });

    expect(result.current).toEqual({ status: 'unavailable', roles: null });
    expect(request).not.toHaveBeenCalled();
  });

  it('is unavailable, with no request, when the caller does not ask (the menu offers it to admins only)', () => {
    auth.current.permissions = ['roles:view'];
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useViewAsRoles({ enabled: false }), { wrapper });

    expect(result.current).toEqual({ status: 'unavailable', roles: null });
    expect(request).not.toHaveBeenCalled();
  });

  it('reports an error with no roles when the query fails', async () => {
    auth.current.isTenantAdmin = true;
    request.mockRejectedValue(new Error('forbidden'));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useViewAsRoles(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.roles).toBeNull();
  });
});
