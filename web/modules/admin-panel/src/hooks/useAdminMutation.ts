/**
 * useAdminMutation — the admin-panel's write primitive (ADMIN-HIGH-105).
 *
 * A write that does not invalidate the reads it invalidated is the stale-list
 * bug, and it is invisible: the mutation succeeds, the toast fires, and the
 * table still shows the old row until something else happens to refetch. This
 * hook makes the invalidation part of performing the write — `invalidateKeys`
 * sits next to the mutation function, so the two cannot drift apart in
 * separate call sites.
 *
 * Like `useAdminQuery`, it owns the CONTRACT and not a transport: it takes a
 * mutation FUNCTION, so a REST page passes an `adminApi` call and
 * `useAdminGraphQLMutation` adapts the three GraphQL surfaces.
 *
 * @example REST
 * ```ts
 * const { mutateAsync, isPending } = useAdminMutation(
 *   (input: UpdateTenantInput) => tenantsApi.update(tenantId, input),
 *   { invalidateKeys: [adminKeys.tenants.detail(tenantId), adminKeys.tenants.list()] },
 * );
 * ```
 *
 * @example GraphQL
 * ```ts
 * const { mutateAsync } = useAdminGraphQLMutation<{ createSupportThread: Thread }>(
 *   ADMIN_CREATE_THREAD,
 *   { invalidateKeys: [adminKeys.messaging.threads()] },
 * );
 * ```
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  QueryKey,
  UseMutationOptions,
  UseMutationResult,
} from '@tanstack/react-query';
import { graphqlClient } from '@aquaculture/shared-ui';

/**
 * Extra options specific to useAdminMutation (beyond standard React Query mutation options).
 */
export interface AdminMutationExtras<TData, TVariables> {
  /**
   * Query keys to invalidate when the mutation succeeds.
   * Each key is passed to `queryClient.invalidateQueries({ queryKey })`.
   *
   * Tip: use broad keys (e.g. `adminKeys.messaging.all()`) to invalidate
   * an entire domain, or narrow keys for surgical cache busting.
   */
  invalidateKeys?: QueryKey[];

  /**
   * Additional React Query mutation options (onSuccess, onError, onSettled, etc.).
   * The wrapper's onSuccess runs first (for invalidation), then yours.
   */
  mutationOptions?: Omit<
    UseMutationOptions<TData, Error, TVariables>,
    'mutationFn'
  >;
}

/**
 * Run any admin write through React Query, invalidating the reads it affects.
 *
 * @param mutationFn - the writer; receives the mutation variables
 * @param extras - invalidateKeys and/or additional mutation options
 */
export function useAdminMutation<TData, TVariables = void>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  extras?: AdminMutationExtras<TData, TVariables>,
): UseMutationResult<TData, Error, TVariables> {
  const queryClient = useQueryClient();
  const { invalidateKeys, mutationOptions } = extras ?? {};

  // WHY: Destructure callbacks separately to avoid forwarding arity issues
  // when optional-chaining. The rest is spread into useMutation directly.
  const {
    onSuccess: callerOnSuccess,
    onError: callerOnError,
    onSettled: callerOnSettled,
    ...restOptions
  } = mutationOptions ?? {};

  return useMutation<TData, Error, TVariables>({
    ...restOptions,
    mutationFn,
    onSuccess: async (data, variables, onMutateResult, context) => {
      // ── Invalidate specified cache keys ──
      if (invalidateKeys && invalidateKeys.length > 0) {
        await Promise.all(
          invalidateKeys.map((key) =>
            queryClient.invalidateQueries({ queryKey: key }),
          ),
        );
      }

      // ── Forward to caller's onSuccess if provided ──
      if (callerOnSuccess) {
        await callerOnSuccess(data, variables, onMutateResult, context);
      }
    },
    onError: async (error, variables, onMutateResult, context) => {
      if (callerOnError) {
        await callerOnError(error, variables, onMutateResult, context);
      }
    },
    onSettled: async (data, error, variables, onMutateResult, context) => {
      if (callerOnSettled) {
        await callerOnSettled(data, error, variables, onMutateResult, context);
      }
    },
  });
}

/**
 * The GraphQL flavour: same contract, `graphqlClient` as the transport.
 */
export function useAdminGraphQLMutation<
  TData,
  TVariables extends Record<string, unknown> = Record<string, unknown>,
>(
  mutation: string,
  extras?: AdminMutationExtras<TData, TVariables>,
): UseMutationResult<TData, Error, TVariables> {
  return useAdminMutation<TData, TVariables>(
    (variables: TVariables) => graphqlClient.request<TData>(mutation, variables),
    extras,
  );
}
