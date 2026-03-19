/**
 * useGraphQL Hooks
 * GraphQL sorguları ve mutasyonları için React hooks
 * @tanstack/react-query ile entegre çalışır
 */

import { useCallback, useRef, useState } from 'react';
import { graphqlClient, GraphQLClientError, GraphQLRequestOptions } from '../utils/api-client';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

/**
 * GraphQL hata tipi
 */
export interface GraphQLError {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: string[];
  extensions?: Record<string, unknown>;
}

/**
 * GraphQL yanıt tipi
 */
export interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
}

/**
 * Hook durumu
 */
interface QueryState<T> {
  data: T | null;
  isLoading: boolean;
  error: Error | null;
}

// ============================================================================
// useGraphQLQuery Hook
// ============================================================================

export interface UseGraphQLQueryOptions<TVariables> {
  /** Sorgu değişkenleri */
  variables?: TVariables;
  /** GraphQL istek seçenekleri */
  requestOptions?: GraphQLRequestOptions;
  /** Sorgu aktif mi */
  enabled?: boolean;
}

/**
 * GraphQL sorgusu için hook
 *
 * @example
 * const { data, isLoading, error, refetch } = useGraphQLQuery<FarmsData>(
 *   'GetFarms',
 *   `query GetFarms { farms { id name } }`
 * );
 */
/** Maximum consecutive UNAUTHENTICATED retries per hook instance */
const MAX_AUTH_RETRIES = 3;

export function useGraphQLQuery<TData, TVariables extends Record<string, unknown> = Record<string, unknown>>(
  queryKey: string,
  query: string,
  options?: UseGraphQLQueryOptions<TVariables>
) {
  const [state, setState] = useState<QueryState<TData>>({
    data: null,
    isLoading: false,
    error: null,
  });

  /** Track consecutive auth failures to prevent infinite retry loops */
  const authRetryCount = useRef(0);

  const execute = useCallback(async () => {
    if (options?.enabled === false) return;

    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      const response = await graphqlClient.request<TData>(
        query,
        options?.variables as Record<string, unknown>,
        options?.requestOptions
      );
      // Reset retry counter on success
      authRetryCount.current = 0;
      setState({ data: response, isLoading: false, error: null });
      return response;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('GraphQL error');

      // Track UNAUTHENTICATED errors to prevent infinite retry spirals.
      // The GraphQLClient already retries once internally; if we still get
      // UNAUTHENTICATED here, the refresh cycle has failed.
      if (
        error instanceof GraphQLClientError &&
        (error.code === 'UNAUTHENTICATED' || error.code === 'REFRESH_FAILED')
      ) {
        authRetryCount.current++;
        if (authRetryCount.current >= MAX_AUTH_RETRIES) {
          if (import.meta.env.DEV) {
            console.warn(
              `[useGraphQLQuery:${queryKey}] Max auth retries (${MAX_AUTH_RETRIES}) exceeded, giving up`,
            );
          }
        }
      }

      setState({ data: null, isLoading: false, error: err });
      throw err;
    }
  }, [query, queryKey, options?.variables, options?.enabled, options?.requestOptions]);

  const refetch = useCallback(() => {
    // If we've exceeded auth retries, don't retry — the user needs to re-login
    if (authRetryCount.current >= MAX_AUTH_RETRIES) {
      return Promise.resolve();
    }
    return execute();
  }, [execute]);

  return {
    ...state,
    refetch,
  };
}

// ============================================================================
// useGraphQLMutation Hook
// ============================================================================

export interface UseGraphQLMutationOptions {
  /** GraphQL istek seçenekleri */
  requestOptions?: GraphQLRequestOptions;
  /** Başarılı olduğunda */
  onSuccess?: (data: unknown) => void;
  /** Hata olduğunda */
  onError?: (error: Error) => void;
}

/**
 * GraphQL mutasyonu için hook
 *
 * @example
 * const { mutate, isLoading } = useGraphQLMutation<CreateFarmResponse>(
 *   `mutation CreateFarm($input: CreateFarmInput!) {
 *     createFarm(input: $input) { id name }
 *   }`
 * );
 *
 * await mutate({ input: { name: 'New Farm' } });
 */
export function useGraphQLMutation<TData, TVariables extends Record<string, unknown> = Record<string, unknown>>(
  mutation: string,
  options?: UseGraphQLMutationOptions
) {
  const [state, setState] = useState<QueryState<TData>>({
    data: null,
    isLoading: false,
    error: null,
  });

  const mutate = useCallback(
    async (variables?: TVariables): Promise<TData> => {
      setState((prev) => ({ ...prev, isLoading: true, error: null }));

      try {
        const response = await graphqlClient.request<TData>(
          mutation,
          variables as Record<string, unknown>,
          options?.requestOptions
        );
        setState({ data: response, isLoading: false, error: null });
        options?.onSuccess?.(response);
        return response;
      } catch (error) {
        const err = error instanceof Error ? error : new Error('GraphQL mutation error');
        setState({ data: null, isLoading: false, error: err });
        options?.onError?.(err);
        throw err;
      }
    },
    [mutation, options]
  );

  const reset = useCallback(() => {
    setState({ data: null, isLoading: false, error: null });
  }, []);

  return {
    ...state,
    mutate,
    reset,
  };
}

// ============================================================================
// Cache Utilities (Placeholder — @deprecated)
// ============================================================================

/**
 * Sorgu önbelleğini prefetch et.
 * @deprecated Placeholder only — no-op. Use @tanstack/react-query's useQueryClient().prefetchQuery() directly.
 */
export function usePrefetchQuery() {
  return useCallback(async (_key: string, _query: string, _variables?: unknown) => {
    // No-op placeholder — use @tanstack/react-query directly
  }, []);
}

/**
 * Sorgu önbelleğini güncelle.
 * @deprecated Placeholder only — no-op. Use @tanstack/react-query's useQueryClient().setQueryData() directly.
 */
export function useUpdateQueryCache() {
  return useCallback((_key: string, _updater: (oldData: unknown) => unknown) => {
    // No-op placeholder — use @tanstack/react-query directly
  }, []);
}

/**
 * Sorgu önbelleğini geçersiz kıl.
 * @deprecated Placeholder only — no-op. Use @tanstack/react-query's useQueryClient().invalidateQueries() directly.
 */
export function useInvalidateQueries() {
  return useCallback((_key: string | string[]) => {
    // No-op placeholder — use @tanstack/react-query directly
  }, []);
}

export default useGraphQLQuery;
