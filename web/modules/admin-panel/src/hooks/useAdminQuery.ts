/**
 * useAdminQuery — the admin-panel's cross-tenant read primitive (ADMIN-HIGH-105).
 *
 * ## Why this hook owns the CONTRACT and not a TRANSPORT
 *
 * Every admin-panel read has to get the same three things right, and the page
 * that hand-assembles them is the page that gets one of them wrong:
 *   1. a cache key from `adminKeys`, so a mutation can invalidate exactly the
 *      slices it affected instead of nothing (the stale-list class);
 *   2. a cache that lives in the SHELL's `QueryClient`, which `logoutCleanup()`
 *      clears — so a SUPER_ADMIN's platform-wide data cannot outlive the
 *      session that fetched it;
 *   3. request cancellation on unmount, via the `signal` React Query hands the
 *      query function.
 *
 * None of those three is transport-specific, so this hook takes a **query
 * function**, not a GraphQL document. `useAdminGraphQLQuery` below is a thin
 * adapter for the three GraphQL surfaces; the 36 REST pages pass an
 * `adminApi` call directly. An earlier revision hard-coded `graphqlClient`
 * here, which is why the REST pages — the overwhelming majority — had no
 * primitive to adopt and stayed on `useAsyncData`.
 *
 * ## Why NOT `useTenantQuery` from shared-ui
 *
 * That hook is the SSoT for TENANT-scoped access: it prefixes keys with the
 * tenant and gates `enabled` on an authenticated tenant session. The
 * admin-panel is SUPER_ADMIN and reads ACROSS tenants — a platform-wide
 * invoice list has no tenant to prefix, and a platform admin has no tenantId
 * to gate on, so those queries would never fire. Different contract, so a
 * different hook; the shared half (the shell's QueryClient and its
 * logout-clearing registration) is genuinely shared.
 *
 * @example REST
 * ```ts
 * const { data, isLoading, error } = useAdminQuery(
 *   adminKeys.tenants.list(filters),
 *   ({ signal }) => tenantsApi.list(filters, signal),
 * );
 * ```
 *
 * @example GraphQL
 * ```ts
 * const { data } = useAdminGraphQLQuery<{ myThreads: Thread[] }>(
 *   adminKeys.messaging.threads(),
 *   ADMIN_GET_THREADS,
 *   { status: 'OPEN' },
 * );
 * ```
 */

import { useQuery } from '@tanstack/react-query';
import type {
  QueryFunction,
  QueryKey,
  UseQueryOptions,
  UseQueryResult,
} from '@tanstack/react-query';
import { graphqlClient } from '@aquaculture/shared-ui';

/**
 * Options for useAdminQuery — every standard React Query option except the two
 * this hook supplies from its arguments.
 */
export type UseAdminQueryOptions<TData, TError = Error> = Omit<
  UseQueryOptions<TData, TError, TData, QueryKey>,
  'queryKey' | 'queryFn'
>;

/**
 * Run any admin read through React Query.
 *
 * @param queryKey - cache key from the `adminKeys` factory
 * @param queryFn - the fetcher; it receives `{ signal }` and MUST forward it so
 *                  an unmounted page's request is cancelled rather than parked
 * @param options - staleTime, enabled, select, …
 */
export function useAdminQuery<TData, TError = Error>(
  queryKey: QueryKey,
  queryFn: QueryFunction<TData, QueryKey>,
  options?: UseAdminQueryOptions<TData, TError>,
): UseQueryResult<TData, TError> {
  return useQuery<TData, TError, TData, QueryKey>({
    ...options,
    queryKey,
    queryFn,
  });
}

/**
 * The GraphQL flavour: same contract, `graphqlClient` as the transport.
 *
 * Kept as an adapter rather than a second primitive so the cache contract
 * above has exactly one implementation to be correct in.
 */
export function useAdminGraphQLQuery<
  TData,
  TVariables extends Record<string, unknown> = Record<string, unknown>,
  TError = Error,
>(
  queryKey: QueryKey,
  query: string,
  variables?: TVariables,
  options?: UseAdminQueryOptions<TData, TError>,
): UseQueryResult<TData, TError> {
  return useAdminQuery<TData, TError>(
    queryKey,
    ({ signal }) => graphqlClient.request<TData>(query, variables, { signal }),
    options,
  );
}
