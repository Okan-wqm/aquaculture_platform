/**
 * Custom Hooks for Tenant Roles and Permissions
 *
 * Uses TanStack Query for data fetching and caching.
 * Implements optimistic updates for better UX.
 * Includes comprehensive error handling with user-friendly messages.
 */

import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryResult,
  type UseMutationResult,
} from '@tanstack/react-query';
import { createTenantQueryKey, getTenantId } from '@aquaculture/shared-ui';
import {
  getTenantRoles,
  getTenantRole,
  getDefaultTenantRole,
  getPermissionCategories,
  createTenantRole,
  updateTenantRole,
  deleteTenantRole,
  seedTenantRoles,
  type TenantRole,
  type TenantRolePermissions,
  type PermissionCategory,
  type CreateTenantRoleInput,
  type UpdateTenantRoleInput,
  type PanelPermissions,
} from '../services/tenant-api.service';
import { processError, logError, type AppError } from '../utils/error-handling';

// ============================================================================
// Error Types
// ============================================================================

/**
 * GraphQL error structure
 */
export interface GraphQLError {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: string[];
  extensions?: Record<string, unknown>;
}

/**
 * API error with potential GraphQL errors
 */
export interface ApiError extends Error {
  graphQLErrors?: GraphQLError[];
  networkError?: Error;
  statusCode?: number;
}

// ============================================================================
// Query Result Types
// ============================================================================

/**
 * Result type for useTenantRoles hook
 */
export type UseTenantRolesResult = UseQueryResult<TenantRole[], ApiError>;

/**
 * Result type for useTenantRole hook
 */
export type UseTenantRoleResult = UseQueryResult<TenantRole | null, ApiError>;

/**
 * Result type for useDefaultTenantRole hook
 */
export type UseDefaultTenantRoleResult = UseQueryResult<TenantRole | null, ApiError>;

/**
 * Result type for usePermissionCategories hook
 */
export type UsePermissionCategoriesResult = UseQueryResult<PermissionCategory[], ApiError>;

// ============================================================================
// Mutation Variables Types
// ============================================================================

/**
 * Variables for update mutation
 */
export interface UpdateTenantRoleMutationVariables {
  roleId: string;
  input: UpdateTenantRoleInput;
}

// ============================================================================
// Mutation Result Types
// ============================================================================

/**
 * Context type for optimistic update rollback
 */
interface OptimisticContext {
  previousRoles?: TenantRole[];
  previousRole?: TenantRole | null;
  previousDefaultRole?: TenantRole | null;
}

/**
 * Result type for useCreateTenantRole hook
 */
export type UseCreateTenantRoleMutationResult = UseMutationResult<
  TenantRole,
  ApiError,
  CreateTenantRoleInput,
  OptimisticContext
>;

/**
 * Result type for useUpdateTenantRole hook
 */
export type UseUpdateTenantRoleMutationResult = UseMutationResult<
  TenantRole,
  ApiError,
  UpdateTenantRoleMutationVariables,
  OptimisticContext
>;

/**
 * Result type for useDeleteTenantRole hook
 */
export type UseDeleteTenantRoleMutationResult = UseMutationResult<
  boolean,
  ApiError,
  string,
  OptimisticContext
>;

/**
 * Result type for useSeedTenantRoles hook
 */
export type UseSeedTenantRolesMutationResult = UseMutationResult<
  TenantRole[],
  ApiError,
  void,
  unknown
>;

// ============================================================================
// Constants
// ============================================================================

/** Key for user queries - used for invalidation after role changes */
// Tenant-scoped via createTenantQueryKey (['tenant', tenantId, …]) so cache never
// leaks across a tenant switch (web/CLAUDE.md FE-CRITICAL-014/015/016). `all` is a
// FUNCTION (not a static array) because the tenantId is only known at call time.
export const userKeys = {
  all: () => createTenantQueryKey(getTenantId(), 'tenant-users'),
  lists: () => createTenantQueryKey(getTenantId(), 'tenant-users', 'list'),
};

// ============================================================================
// Query Keys
// ============================================================================

export const roleKeys = {
  all: () => createTenantQueryKey(getTenantId(), 'tenant-roles'),
  lists: () => createTenantQueryKey(getTenantId(), 'tenant-roles', 'list'),
  list: (filters?: Record<string, unknown>) =>
    createTenantQueryKey(getTenantId(), 'tenant-roles', 'list', filters),
  details: () => createTenantQueryKey(getTenantId(), 'tenant-roles', 'detail'),
  detail: (roleId: string) =>
    createTenantQueryKey(getTenantId(), 'tenant-roles', 'detail', roleId),
  default: () => createTenantQueryKey(getTenantId(), 'tenant-roles', 'default'),
  categories: () => createTenantQueryKey(getTenantId(), 'tenant-roles', 'categories'),
};

// ============================================================================
// Query Hooks
// ============================================================================

/**
 * Hook to get all tenant roles
 */
export function useTenantRoles(): UseTenantRolesResult {
  return useQuery({
    queryKey: roleKeys.lists(),
    queryFn: getTenantRoles,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Hook to get a single tenant role by ID
 */
export function useTenantRole(roleId: string | null | undefined): UseTenantRoleResult {
  return useQuery({
    queryKey: roleKeys.detail(roleId || ''),
    queryFn: () => getTenantRole(roleId!),
    enabled: !!roleId,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Hook to get the default tenant role
 */
export function useDefaultTenantRole(): UseDefaultTenantRoleResult {
  return useQuery({
    queryKey: roleKeys.default(),
    queryFn: getDefaultTenantRole,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Hook to get permission categories for UI
 */
export function usePermissionCategories(): UsePermissionCategoriesResult {
  return useQuery({
    queryKey: roleKeys.categories(),
    queryFn: getPermissionCategories,
    staleTime: 30 * 60 * 1000, // 30 minutes (rarely changes)
  });
}

// ============================================================================
// Mutation Hooks with Optimistic Updates
// ============================================================================

/**
 * Generate an optimistic ID for creates
 */
const generateTempId = (): string => `temp-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

/**
 * Hook to create a new tenant role with optimistic update
 */
export function useCreateTenantRole(): UseCreateTenantRoleMutationResult {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateTenantRoleInput) => createTenantRole(input),

    // Optimistically add the new role to the list
    onMutate: async (input: CreateTenantRoleInput): Promise<OptimisticContext> => {
      // Cancel any outgoing refetches to avoid overwriting optimistic update
      await queryClient.cancelQueries({ queryKey: roleKeys.lists() });

      // Snapshot previous value for rollback
      const previousRoles = queryClient.getQueryData<TenantRole[]>(roleKeys.lists());

      // Create optimistic role object
      const optimisticRole: TenantRole = {
        id: generateTempId(),
        name: input.name,
        description: input.description ?? undefined,
        color: input.color ?? '#6366F1',
        icon: input.icon ?? 'shield',
        level: input.level ?? 50,
        isSystem: false,
        isDefault: input.isDefault || false,
        userCount: 0,
        permissions: {
          id: generateTempId(),
          roleId: generateTempId(),
          panelPermissions: input.panelPermissions as PanelPermissions || {},
          resourcePermissions: [],
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Optimistically update the roles list
      queryClient.setQueryData<TenantRole[]>(roleKeys.lists(), (old = []) => [
        ...old,
        optimisticRole,
      ]);

      // If setting as default, update default role query optimistically
      let previousDefaultRole: TenantRole | null | undefined;
      if (input.isDefault) {
        previousDefaultRole = queryClient.getQueryData<TenantRole | null>(roleKeys.default());
        queryClient.setQueryData(roleKeys.default(), optimisticRole);

        // Also update previous default role in list to no longer be default
        queryClient.setQueryData<TenantRole[]>(roleKeys.lists(), (old = []) =>
          old.map((role) =>
            role.isDefault && role.id !== optimisticRole.id
              ? { ...role, isDefault: false }
              : role
          )
        );
      }

      return { previousRoles, previousDefaultRole };
    },

    // On error, rollback to previous state and log error
    onError: (error, input, context) => {
      // Rollback optimistic updates
      if (context?.previousRoles) {
        queryClient.setQueryData(roleKeys.lists(), context.previousRoles);
      }
      if (context?.previousDefaultRole !== undefined) {
        queryClient.setQueryData(roleKeys.default(), context.previousDefaultRole);
      }

      // Log error with context
      logError('useCreateTenantRole', error, {
        operation: 'create',
        roleName: input.name,
      });
    },

    // On success, replace optimistic data with actual data
    onSuccess: (newRole) => {
      // Update the list with real data
      queryClient.setQueryData<TenantRole[]>(roleKeys.lists(), (old = []) =>
        old.map((role) =>
          role.id.startsWith('temp-') ? newRole : role
        )
      );
      // Add the real role to detail cache
      queryClient.setQueryData(roleKeys.detail(newRole.id), newRole);
      // Invalidate to ensure fresh data
      queryClient.invalidateQueries({ queryKey: roleKeys.lists() });
      // If this role is now default, update default query
      if (newRole.isDefault) {
        queryClient.setQueryData(roleKeys.default(), newRole);
      }
    },
  });
}

/**
 * Hook to update an existing tenant role with optimistic update
 */
export function useUpdateTenantRole() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ roleId, input }: { roleId: string; input: UpdateTenantRoleInput }) =>
      updateTenantRole(roleId, input),

    // Optimistically update the role
    onMutate: async ({ roleId, input }): Promise<OptimisticContext> => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: roleKeys.lists() });
      await queryClient.cancelQueries({ queryKey: roleKeys.detail(roleId) });

      // Snapshot previous values
      const previousRoles = queryClient.getQueryData<TenantRole[]>(roleKeys.lists());
      const previousRole = queryClient.getQueryData<TenantRole | null>(roleKeys.detail(roleId));
      const previousDefaultRole = queryClient.getQueryData<TenantRole | null>(roleKeys.default());

      // Optimistically update the role in the list
      queryClient.setQueryData<TenantRole[]>(roleKeys.lists(), (old = []) =>
        old.map((role) => {
          if (role.id === roleId) {
            return {
              ...role,
              ...input,
              permissions: input.panelPermissions
                ? {
                    ...role.permissions,
                    panelPermissions: input.panelPermissions,
                  } as TenantRolePermissions
                : role.permissions,
              updatedAt: new Date().toISOString(),
            };
          }
          // If setting this role as default, unset previous default
          if (input.isDefault && role.isDefault && role.id !== roleId) {
            return { ...role, isDefault: false };
          }
          return role;
        })
      );

      // Update the detail cache
      if (previousRole) {
        queryClient.setQueryData<TenantRole>(roleKeys.detail(roleId), {
          ...previousRole,
          ...input,
          permissions: input.panelPermissions
            ? {
                ...previousRole.permissions,
                panelPermissions: input.panelPermissions,
              } as TenantRolePermissions
            : previousRole.permissions,
          updatedAt: new Date().toISOString(),
        });
      }

      // Update default role query if setting as default
      if (input.isDefault && previousRole) {
        queryClient.setQueryData(roleKeys.default(), {
          ...previousRole,
          ...input,
          updatedAt: new Date().toISOString(),
        });
      }

      return { previousRoles, previousRole, previousDefaultRole };
    },

    // On error, rollback and log
    onError: (error, { roleId, input }, context) => {
      // Rollback optimistic updates
      if (context?.previousRoles) {
        queryClient.setQueryData(roleKeys.lists(), context.previousRoles);
      }
      if (context?.previousRole !== undefined) {
        queryClient.setQueryData(roleKeys.detail(roleId), context.previousRole);
      }
      if (context?.previousDefaultRole !== undefined) {
        queryClient.setQueryData(roleKeys.default(), context.previousDefaultRole);
      }

      // Log error with context
      logError('useUpdateTenantRole', error, {
        operation: 'update',
        roleId,
        updatedFields: Object.keys(input),
      });
    },

    // On success, update with real data
    onSuccess: (updatedRole) => {
      // Update roles list with real data
      queryClient.setQueryData<TenantRole[]>(roleKeys.lists(), (old = []) =>
        old.map((role) => (role.id === updatedRole.id ? updatedRole : role))
      );
      // Update detail cache
      queryClient.setQueryData(roleKeys.detail(updatedRole.id), updatedRole);
      // Invalidate to ensure fresh data
      queryClient.invalidateQueries({ queryKey: roleKeys.lists() });
      // Update default role if needed
      if (updatedRole.isDefault) {
        queryClient.setQueryData(roleKeys.default(), updatedRole);
        queryClient.invalidateQueries({ queryKey: roleKeys.default() });
      }
      // Invalidate user queries since role permissions may have changed
      queryClient.invalidateQueries({ queryKey: userKeys.lists() });
    },
  });
}

/**
 * Hook to delete a tenant role with optimistic update
 */
export function useDeleteTenantRole() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (roleId: string) => deleteTenantRole(roleId),

    // Optimistically remove the role from the list
    onMutate: async (roleId: string): Promise<OptimisticContext> => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: roleKeys.lists() });
      await queryClient.cancelQueries({ queryKey: roleKeys.detail(roleId) });

      // Snapshot previous values
      const previousRoles = queryClient.getQueryData<TenantRole[]>(roleKeys.lists());
      const previousRole = queryClient.getQueryData<TenantRole | null>(roleKeys.detail(roleId));

      // Optimistically remove from list
      queryClient.setQueryData<TenantRole[]>(roleKeys.lists(), (old = []) =>
        old.filter((role) => role.id !== roleId)
      );

      // Remove from detail cache
      queryClient.removeQueries({ queryKey: roleKeys.detail(roleId) });

      return { previousRoles, previousRole };
    },

    // On error, rollback and log
    onError: (error, roleId, context) => {
      // Rollback optimistic updates
      if (context?.previousRoles) {
        queryClient.setQueryData(roleKeys.lists(), context.previousRoles);
      }
      if (context?.previousRole) {
        queryClient.setQueryData(roleKeys.detail(roleId), context.previousRole);
      }

      // Log error with context
      logError('useDeleteTenantRole', error, {
        operation: 'delete',
        roleId,
        roleName: context?.previousRole?.name,
      });
    },

    // On success, ensure cache is updated
    onSuccess: (_, roleId) => {
      // Invalidate roles list to refetch
      queryClient.invalidateQueries({ queryKey: roleKeys.lists() });
      // Remove from cache
      queryClient.removeQueries({ queryKey: roleKeys.detail(roleId) });
      // Invalidate default role query in case the deleted role was default
      queryClient.invalidateQueries({ queryKey: roleKeys.default() });
      // Invalidate user queries since users may have had this role assigned
      queryClient.invalidateQueries({ queryKey: userKeys.lists() });
    },
  });
}

/**
 * Hook to seed default tenant roles
 */
export function useSeedTenantRoles() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: seedTenantRoles,
    onSuccess: () => {
      // Invalidate all role queries to refetch
      queryClient.invalidateQueries({ queryKey: roleKeys.all() });
    },
    onError: (error) => {
      // Log error with context
      logError('useSeedTenantRoles', error, {
        operation: 'seed',
      });
    },
  });
}

// ============================================================================
// Error Handling Hooks
// ============================================================================

/**
 * Hook to get processed error from mutation
 */
export function useMutationError(error: unknown): AppError | null {
  if (!error) return null;
  return processError(error);
}

// ============================================================================
// Re-export types
// ============================================================================

export type {
  TenantRole,
  TenantRolePermissions,
  PermissionCategory,
  CreateTenantRoleInput,
  UpdateTenantRoleInput,
  PanelPermissions,
};

export type { AppError } from '../utils/error-handling';
export { processError, ErrorCode } from '../utils/error-handling';
