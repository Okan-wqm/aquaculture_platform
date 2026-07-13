/**
 * useAdminQuery -- React Query adapter for admin-panel GraphQL queries
 *
 * Thin wrapper around TanStack `useQuery` that uses the shared-ui
 * `graphqlClient` as the transport layer. This provides automatic
 * caching, deduplication, background refetching, and — most importantly —
 * cache invalidation when mutations succeed (via `useAdminMutation`).
 *
 * Existing hooks (`useGraphQLQuery` from shared-ui) use manual `useState`
 * and have no cache awareness. New features should use this hook; existing
 * hooks will be migrated in Sprint 6.
 *
 * @example
 * ```ts
 * const { data, isLoading, error } = useAdminQuery<{ myThreads: Thread[] }>(
 *   adminKeys.messaging.threads(),
 *   ADMIN_GET_THREADS,
 *   { status: 'OPEN' },
 *   { staleTime: 30_000 },
 * );
 * ```
 *
 * @see web/modules/tenant-admin/src/hooks/useTenantData.ts for the reference pattern
 */

import { useQuery } from '@tanstack/react-query';
import type { UseQueryOptions, QueryKey } from '@tanstack/react-query';
import { graphqlClient } from '@aquaculture/shared-ui';

/**
 * Options for useAdminQuery, extending React Query's UseQueryOptions
 * but omitting queryKey and queryFn (we provide those).
 */
export type UseAdminQueryOptions<TData> = Omit<
  UseQueryOptions<TData, Error, TData, QueryKey>,
  'queryKey' | 'queryFn'
>;

/**
 * Execute a GraphQL query through TanStack React Query.
 *
 * @param queryKey - Cache key tuple from `adminKeys` factory
 * @param query - GraphQL operation string (query document)
 * @param variables - GraphQL variables object (optional)
 * @param options - Additional React Query options (staleTime, enabled, etc.)
 * @returns Standard React Query result: { data, isLoading, isError, error, refetch, ... }
 */
export function useAdminQuery<
  TData,
  TVariables extends Record<string, unknown> = Record<string, unknown>,
>(
  queryKey: QueryKey,
  query: string,
  variables?: TVariables,
  options?: UseAdminQueryOptions<TData>,
): ReturnType<typeof useQuery<TData, Error, TData, QueryKey>> {
  return useQuery<TData, Error, TData, QueryKey>({
    queryKey,
    queryFn: async ({ signal }) => {
      return graphqlClient.request<TData>(query, variables, { signal });
    },
    ...options,
  });
}
