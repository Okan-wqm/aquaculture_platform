/**
 * useAdminMutation -- React Query adapter for admin-panel GraphQL mutations
 *
 * Thin wrapper around TanStack `useMutation` that uses the shared-ui
 * `graphqlClient` as the transport layer and automatically invalidates
 * specified query keys on success.
 *
 * This solves the core problem: mutations via `useGraphQLMutation` never
 * invalidate query caches, causing stale lists everywhere. With this hook,
 * every mutation declares which cache slices it affects.
 *
 * @example
 * ```ts
 * const { mutateAsync, isPending } = useAdminMutation<
 *   { createSupportThread: Thread },
 *   { input: CreateThreadInput }
 * >(
 *   ADMIN_CREATE_THREAD,
 *   { invalidateKeys: [adminKeys.messaging.threads()] },
 * );
 *
 * await mutateAsync({ input: { subject: 'Hello', initialMessage: '...' } });
 * // ^ automatically invalidates messaging.threads cache on success
 * ```
 *
 * @see web/modules/tenant-admin/src/hooks/useTenantData.ts for the reference pattern
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseMutationOptions, QueryKey } from '@tanstack/react-query';
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
 * Execute a GraphQL mutation through TanStack React Query with automatic cache invalidation.
 *
 * @param mutation - GraphQL mutation operation string
 * @param extras - invalidateKeys and/or additional mutation options
 * @returns Standard React Query mutation result: { mutate, mutateAsync, isPending, isError, error, data, ... }
 */
export function useAdminMutation<
  TData,
  TVariables extends Record<string, unknown> = Record<string, unknown>,
>(
  mutation: string,
  extras?: AdminMutationExtras<TData, TVariables>,
): ReturnType<typeof useMutation<TData, Error, TVariables>> {
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
    mutationFn: async (variables: TVariables): Promise<TData> => {
      return graphqlClient.request<TData>(mutation, variables);
    },
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
