/**
 * useTenantRoles Hook Tests
 *
 * Tests for tenant role CRUD hooks with TanStack Query.
 * Covers: fetch, create (optimistic), update (cache invalidation),
 * delete (rollback on error), and error handling.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { getTenantId } from '@aquaculture/shared-ui';
import {
  createTenantAdminQueryWrapper,
  createTenantAdminTestQueryClient,
} from '../../test/query-client';

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

const mockGetTenantRoles = vi.fn();
const mockGetTenantRole = vi.fn();
const mockGetDefaultTenantRole = vi.fn();
const mockGetPermissionCategories = vi.fn();
const mockCreateTenantRole = vi.fn();
const mockUpdateTenantRole = vi.fn();
const mockDeleteTenantRole = vi.fn();
const mockSeedTenantRoles = vi.fn();

vi.mock('../../services/tenant-api.service', () => ({
  getTenantRoles: (...args: unknown[]) => mockGetTenantRoles(...args),
  getTenantRole: (...args: unknown[]) => mockGetTenantRole(...args),
  getDefaultTenantRole: (...args: unknown[]) => mockGetDefaultTenantRole(...args),
  getPermissionCategories: (...args: unknown[]) => mockGetPermissionCategories(...args),
  createTenantRole: (...args: unknown[]) => mockCreateTenantRole(...args),
  updateTenantRole: (...args: unknown[]) => mockUpdateTenantRole(...args),
  deleteTenantRole: (...args: unknown[]) => mockDeleteTenantRole(...args),
  seedTenantRoles: (...args: unknown[]) => mockSeedTenantRoles(...args),
}));

vi.mock('../../utils/error-handling', () => ({
  processError: (err: unknown) => ({
    code: 'UNKNOWN_ERROR',
    message: err instanceof Error ? err.message : String(err),
    userMessage: 'An unexpected error occurred.',
    originalError: err,
    timestamp: new Date(),
    retryable: false,
  }),
  logError: vi.fn(),
  ErrorCode: {
    NETWORK_ERROR: 'NETWORK_ERROR',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  },
}));

// Import after mocks are defined
import {
  useTenantRoles,
  useTenantRole,
  useDefaultTenantRole,
  usePermissionCategories,
  useCreateTenantRole,
  useUpdateTenantRole,
  useDeleteTenantRole,
  useSeedTenantRoles,
  useMutationError,
  roleKeys,
} from '../useTenantRoles';

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const mockRole = {
  id: 'role-1',
  name: 'Editor',
  description: 'Can edit content',
  color: '#3B82F6',
  icon: 'edit',
  level: 30,
  isSystem: false,
  isDefault: false,
  userCount: 5,
  permissions: {
    id: 'perm-1',
    roleId: 'role-1',
    panelPermissions: {},
    resourcePermissions: [],
  },
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
};

const mockDefaultRole = {
  ...mockRole,
  id: 'role-default',
  name: 'Viewer',
  isDefault: true,
};

const mockRoles = [mockRole, mockDefaultRole];

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function createQueryClient(): QueryClient {
  return createTenantAdminTestQueryClient();
}

function createWrapper(queryClient: QueryClient) {
  return createTenantAdminQueryWrapper(queryClient);
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('useTenantRoles hooks', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = createQueryClient();
  });

  afterEach(() => {
    queryClient.clear();
  });

  // ==========================================================================
  // Query Hooks — fetchRoles (GraphQL query success)
  // ==========================================================================

  describe('useTenantRoles (fetchRoles)', () => {
    it('should fetch roles successfully', async () => {
      mockGetTenantRoles.mockResolvedValue(mockRoles);

      const { result } = renderHook(() => useTenantRoles(), {
        wrapper: createWrapper(queryClient),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual(mockRoles);
      expect(result.current.data).toHaveLength(2);
      expect(mockGetTenantRoles).toHaveBeenCalledTimes(1);
    });

    it('should return loading state initially', () => {
      mockGetTenantRoles.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useTenantRoles(), {
        wrapper: createWrapper(queryClient),
      });

      expect(result.current.isLoading).toBe(true);
      expect(result.current.data).toBeUndefined();
    });

    it('should handle fetch error', async () => {
      mockGetTenantRoles.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useTenantRoles(), {
        wrapper: createWrapper(queryClient),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeTruthy();
      expect(result.current.error!.message).toBe('Network error');
    });

    it('should use correct query key', () => {
      // Tenant-scoped: ['tenant', tenantId, 'tenant-roles', 'list'] (FE-CRITICAL-014).
      expect(roleKeys.lists()).toEqual(['tenant', getTenantId(), 'tenant-roles', 'list']);
    });
  });

  describe('useTenantRole (single)', () => {
    it('should fetch single role by ID', async () => {
      mockGetTenantRole.mockResolvedValue(mockRole);

      const { result } = renderHook(() => useTenantRole('role-1'), {
        wrapper: createWrapper(queryClient),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual(mockRole);
    });

    it('should not fetch when roleId is null', () => {
      const { result } = renderHook(() => useTenantRole(null), {
        wrapper: createWrapper(queryClient),
      });

      expect(result.current.fetchStatus).toBe('idle');
      expect(mockGetTenantRole).not.toHaveBeenCalled();
    });
  });

  describe('useDefaultTenantRole', () => {
    it('should fetch default role', async () => {
      mockGetDefaultTenantRole.mockResolvedValue(mockDefaultRole);

      const { result } = renderHook(() => useDefaultTenantRole(), {
        wrapper: createWrapper(queryClient),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.isDefault).toBe(true);
    });
  });

  describe('usePermissionCategories', () => {
    it('should fetch permission categories', async () => {
      const mockCategories = [
        { categoryKey: 'farm', name: 'Farm', resources: [{ name: 'tanks', actions: ['read', 'write'] }] },
      ];
      mockGetPermissionCategories.mockResolvedValue(mockCategories);

      const { result } = renderHook(() => usePermissionCategories(), {
        wrapper: createWrapper(queryClient),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual(mockCategories);
    });
  });

  // ==========================================================================
  // createRole: Mutation + optimistic update
  // ==========================================================================

  describe('useCreateTenantRole', () => {
    it('should create role and update cache on success', async () => {
      // Seed cache with existing roles
      queryClient.setQueryData(roleKeys.lists(), [mockRole]);

      const newRole = {
        ...mockRole,
        id: 'role-new',
        name: 'Manager',
      };
      mockCreateTenantRole.mockResolvedValue(newRole);

      const { result } = renderHook(() => useCreateTenantRole(), {
        wrapper: createWrapper(queryClient),
      });

      await act(async () => {
        result.current.mutate({
          name: 'Manager',
          panelPermissions: {},
        });
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockCreateTenantRole).toHaveBeenCalledWith({
        name: 'Manager',
        panelPermissions: {},
      });
    });

    it('should add optimistic role to cache immediately (onMutate)', async () => {
      queryClient.setQueryData(roleKeys.lists(), [mockRole]);

      // Never-resolving promise to keep the mutation in-flight
      mockCreateTenantRole.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useCreateTenantRole(), {
        wrapper: createWrapper(queryClient),
      });

      act(() => {
        result.current.mutate({ name: 'Temp Role', panelPermissions: {} });
      });

      // Wait for onMutate to fire — cache should optimistically include the new role
      await waitFor(() => {
        const cached = queryClient.getQueryData<unknown[]>(roleKeys.lists());
        expect(cached).toHaveLength(2);
      });
    });

    it('should rollback optimistic update on create error', async () => {
      queryClient.setQueryData(roleKeys.lists(), [mockRole]);
      mockCreateTenantRole.mockRejectedValue(new Error('Validation error'));

      const { result } = renderHook(() => useCreateTenantRole(), {
        wrapper: createWrapper(queryClient),
      });

      await act(async () => {
        result.current.mutate({ name: 'bad-role', panelPermissions: {} });
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      // Cache should be rolled back to only the original role
      const cached = queryClient.getQueryData<unknown[]>(roleKeys.lists());
      expect(cached).toHaveLength(1);
    });
  });

  // ==========================================================================
  // updateRole: Mutation + cache invalidation
  // ==========================================================================

  describe('useUpdateTenantRole', () => {
    it('should update role and invalidate queries on success', async () => {
      const updatedRole = { ...mockRole, name: 'Senior Editor' };
      queryClient.setQueryData(roleKeys.lists(), mockRoles);
      queryClient.setQueryData(roleKeys.detail('role-1'), mockRole);

      mockUpdateTenantRole.mockResolvedValue(updatedRole);

      const { result } = renderHook(() => useUpdateTenantRole(), {
        wrapper: createWrapper(queryClient),
      });

      await act(async () => {
        result.current.mutate({
          roleId: 'role-1',
          input: { name: 'Senior Editor' },
        });
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockUpdateTenantRole).toHaveBeenCalledWith('role-1', {
        name: 'Senior Editor',
      });

      // Detail cache should be updated
      const cachedDetail = queryClient.getQueryData(roleKeys.detail('role-1'));
      expect(cachedDetail).toEqual(updatedRole);
    });

    it('should optimistically update the role in cache', async () => {
      queryClient.setQueryData(roleKeys.lists(), [mockRole]);
      mockUpdateTenantRole.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useUpdateTenantRole(), {
        wrapper: createWrapper(queryClient),
      });

      act(() => {
        result.current.mutate({
          roleId: 'role-1',
          input: { name: 'Updated Name' },
        });
      });

      await waitFor(() => {
        const cached = queryClient.getQueryData<Array<{ name: string }>>(roleKeys.lists());
        expect(cached?.[0]?.name).toBe('Updated Name');
      });
    });

    it('should rollback on update error', async () => {
      queryClient.setQueryData(roleKeys.lists(), [mockRole]);
      queryClient.setQueryData(roleKeys.detail('role-1'), mockRole);
      mockUpdateTenantRole.mockRejectedValue(new Error('Server error'));

      const { result } = renderHook(() => useUpdateTenantRole(), {
        wrapper: createWrapper(queryClient),
      });

      await act(async () => {
        result.current.mutate({
          roleId: 'role-1',
          input: { name: 'Should Fail' },
        });
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      // Should be rolled back
      const cached = queryClient.getQueryData<Array<{ name: string }>>(roleKeys.lists());
      expect(cached?.[0]?.name).toBe('Editor');
    });
  });

  // ==========================================================================
  // deleteRole: Mutation + rollback on error
  // ==========================================================================

  describe('useDeleteTenantRole', () => {
    it('should delete role and remove from cache on success', async () => {
      queryClient.setQueryData(roleKeys.lists(), [mockRole, mockDefaultRole]);
      mockDeleteTenantRole.mockResolvedValue(true);

      const { result } = renderHook(() => useDeleteTenantRole(), {
        wrapper: createWrapper(queryClient),
      });

      await act(async () => {
        result.current.mutate('role-1');
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockDeleteTenantRole).toHaveBeenCalledWith('role-1');
    });

    it('should optimistically remove role from list', async () => {
      queryClient.setQueryData(roleKeys.lists(), [mockRole, mockDefaultRole]);
      mockDeleteTenantRole.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useDeleteTenantRole(), {
        wrapper: createWrapper(queryClient),
      });

      act(() => {
        result.current.mutate('role-1');
      });

      await waitFor(() => {
        const cached = queryClient.getQueryData<unknown[]>(roleKeys.lists());
        expect(cached).toHaveLength(1);
      });
    });

    it('should rollback on delete error (restore removed role)', async () => {
      queryClient.setQueryData(roleKeys.lists(), [mockRole, mockDefaultRole]);
      mockDeleteTenantRole.mockRejectedValue(new Error('Role in use'));

      const { result } = renderHook(() => useDeleteTenantRole(), {
        wrapper: createWrapper(queryClient),
      });

      await act(async () => {
        result.current.mutate('role-1');
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      // Rollback: both roles should be back
      const cached = queryClient.getQueryData<unknown[]>(roleKeys.lists());
      expect(cached).toHaveLength(2);
    });

    it('should log error context on delete failure', async () => {
      const { logError } = await import('../../utils/error-handling');
      queryClient.setQueryData(roleKeys.lists(), [mockRole]);
      queryClient.setQueryData(roleKeys.detail('role-1'), mockRole);
      mockDeleteTenantRole.mockRejectedValue(new Error('Cannot delete'));

      const { result } = renderHook(() => useDeleteTenantRole(), {
        wrapper: createWrapper(queryClient),
      });

      await act(async () => {
        result.current.mutate('role-1');
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(logError).toHaveBeenCalledWith(
        'useDeleteTenantRole',
        expect.any(Error),
        expect.objectContaining({ operation: 'delete', roleId: 'role-1' }),
      );
    });
  });

  // ==========================================================================
  // Error handling: Network error, validation error
  // ==========================================================================

  describe('Error handling', () => {
    it('should classify network errors via processError', async () => {
      const networkError = new TypeError('Failed to fetch');
      mockGetTenantRoles.mockRejectedValue(networkError);

      const { result } = renderHook(() => useTenantRoles(), {
        wrapper: createWrapper(queryClient),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toEqual(networkError);
    });

    it('should classify validation errors', async () => {
      const validationError = new Error('Validation error: name is required');
      mockCreateTenantRole.mockRejectedValue(validationError);

      const { result } = renderHook(() => useCreateTenantRole(), {
        wrapper: createWrapper(queryClient),
      });

      await act(async () => {
        result.current.mutate({ name: '', panelPermissions: {} });
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error!.message).toContain('Validation');
    });

    it('useMutationError should return null for falsy input', () => {
      const { result } = renderHook(() => useMutationError(null), {
        wrapper: createWrapper(queryClient),
      });

      expect(result.current).toBeNull();
    });

    it('useMutationError should process truthy error', () => {
      const { result } = renderHook(() => useMutationError(new Error('oops')), {
        wrapper: createWrapper(queryClient),
      });

      expect(result.current).toBeTruthy();
      expect(result.current!.message).toBe('oops');
    });
  });

  // ==========================================================================
  // Seed roles
  // ==========================================================================

  describe('useSeedTenantRoles', () => {
    it('should seed roles and invalidate cache', async () => {
      const seeded = [mockRole, mockDefaultRole];
      mockSeedTenantRoles.mockResolvedValue(seeded);

      const { result } = renderHook(() => useSeedTenantRoles(), {
        wrapper: createWrapper(queryClient),
      });

      await act(async () => {
        result.current.mutate();
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual(seeded);
    });
  });
});
