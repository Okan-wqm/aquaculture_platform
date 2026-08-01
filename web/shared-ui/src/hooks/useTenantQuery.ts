/**
 * useTenantQuery / useTenantMutation — the SSoT for tenant-scoped data access.
 *
 * WHY (plan A2, "the single highest-leverage move"): every tenant-scoped query must
 * get the SAME three things right, and today each call site hand-assembles them —
 * so any one of them is a latent cross-tenant leak, a missing-tenant fetch, or a
 * blank-on-error UX bug:
 *   1. key prefixed via createTenantQueryKey(tenantId, …) — tenant cache isolation
 *      + the session-epoch cache generation (so a tenant switch can't serve stale
 *      cross-tenant data);
 *   2. `enabled` gated on an authenticated tenant session (token + tenantId present),
 *      so a query never fires before the session resolves a tenant;
 *   3. boundary-aware placeholder data, so pagination/filter changes keep the
 *      last-good data within one tenant session while tenant and session changes
 *      fail closed instead of rendering the previous principal's data.
 *
 * These hooks bake all three in while forwarding every other standard option, so a
 * call site reduces to its segments + queryFn. Migrating a hand-rolled hook to
 * useTenantQuery is mechanical and removes the chance to get the contract wrong.
 *
 * Reactivity comes from useAuth() (token/tenantId are React-context state), so a
 * login / logout / tenant switch re-renders the consumer and re-derives the key +
 * the enabled gate — no manual wiring.
 */
import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
  type UseQueryResult,
  type UseMutationOptions,
  type UseMutationResult,
  type QueryFunction,
} from '@tanstack/react-query';

import { useAuth } from './useAuth';
import {
  createTenantQueryKey,
  createTenantInvalidationKey,
  hasSameTenantSessionBoundary,
} from '../utils/tenant-query-keys';

export type TenantQueryOptions<TData, TError> = Omit<
  UseQueryOptions<TData, TError, TData, readonly unknown[]>,
  'queryKey' | 'queryFn' | 'placeholderData'
> & {
  /**
   * Keep the last-good data while this query's domain segments change within the
   * same tenant-session generation (default true). Tenant, logout/login, and
   * anonymous boundaries always hard-reset regardless of this option.
   */
  keepPreviousData?: boolean;
};

/**
 * Tenant-scoped useQuery. `segments` are the domain key parts (the tenant prefix +
 * epoch are added for you); `queryFn` is the fetcher. The query is enabled only when
 * an authenticated tenant session exists, ANDed with any caller-provided `enabled`.
 */
export function useTenantQuery<TData = unknown, TError = Error>(
  segments: readonly unknown[],
  queryFn: QueryFunction<TData, readonly unknown[]>,
  options?: TenantQueryOptions<TData, TError>,
): UseQueryResult<TData, TError> {
  const { token, tenantId } = useAuth();
  const { keepPreviousData: keep = true, enabled, ...rest } = options ?? {};
  const authenticatedTenantId = token && tenantId ? tenantId : null;
  const queryKey = createTenantQueryKey(authenticatedTenantId, ...segments);

  return useQuery<TData, TError, TData, readonly unknown[]>({
    ...rest,
    queryKey,
    queryFn,
    enabled: authenticatedTenantId !== null && (enabled ?? true),
    placeholderData: keep
      ? (previousData, previousQuery) =>
          previousQuery && hasSameTenantSessionBoundary(previousQuery.queryKey, queryKey)
            ? previousData
            : undefined
      : undefined,
  });
}

export interface TenantMutationOptions<TData, TError, TVariables>
  extends Omit<UseMutationOptions<TData, TError, TVariables>, 'mutationFn'> {
  /**
   * Query-key segment-lists to invalidate (tenant-scoped) on success. Each entry is
   * passed through createTenantQueryKey(tenantId, …), so callers declare the DOMAIN
   * segments and never re-prefix the tenant by hand (the prefix is where invalidation
   * bugs hide). Example: `invalidate: [['equipment', 'list'], ['equipment', 'types']]`.
   */
  invalidate?: ReadonlyArray<readonly unknown[]>;
}

/**
 * Tenant-scoped useMutation. Standardises tenant-scoped invalidation: declare the
 * domain key-segments to invalidate via `invalidate` and they are prefixed with the
 * current tenant automatically, then any caller `onSuccess` runs.
 */
export function useTenantMutation<TData = unknown, TError = Error, TVariables = void>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  options?: TenantMutationOptions<TData, TError, TVariables>,
): UseMutationResult<TData, TError, TVariables> {
  const { tenantId } = useAuth();
  const queryClient = useQueryClient();
  const { invalidate, onSuccess, ...rest } = options ?? {};

  return useMutation<TData, TError, TVariables>({
    ...rest,
    mutationFn,
    onSuccess: (...args) => {
      for (const segments of invalidate ?? []) {
        // MUST be the epoch-LESS invalidation key: createTenantQueryKey appends a
        // {__sessionEpoch} segment, which would land at the same index as a list
        // query's filter and break the prefix match (it would invalidate nothing).
        // createTenantInvalidationKey is the epoch-less prefix made for this.
        void queryClient.invalidateQueries({
          queryKey: createTenantInvalidationKey(tenantId, ...segments),
        });
      }
      // Forward every arg react-query passes (v5's callback arity), so a caller's
      // onSuccess sees the exact signature it expects.
      onSuccess?.(...args);
    },
  });
}
