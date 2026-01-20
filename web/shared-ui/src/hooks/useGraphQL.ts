/**
 * useGraphQL Hooks
 * GraphQL sorguları ve mutasyonları için React hooks
 * @tanstack/react-query ile entegre çalışır
 */

import { useCallback, useState } from 'react';
import { graphqlClient, GraphQLRequestOptions } from '../utils/api-client';

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

  const execute = useCallback(async () => {
    if (options?.enabled === false) return;

    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      const response = await graphqlClient.request<TData>(
        query,
        options?.variables as Record<string, unknown>,
        options?.requestOptions
      );
      setState({ data: response, isLoading: false, error: null });
      return response;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('GraphQL error');
      setState({ data: null, isLoading: false, error: err });
      throw err;
    }
  }, [query, options?.variables, options?.enabled, options?.requestOptions]);

  const refetch = useCallback(() => execute(), [execute]);

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
// Cache Utilities (Placeholder)
// ============================================================================

/**
 * Sorgu önbelleğini prefetch et (placeholder)
 */
export function usePrefetchQuery() {
  return useCallback(async (key: string, query: string, variables?: unknown) => {
    // Placeholder - can be implemented with react-query
    console.log('Prefetch:', key, query, variables);
  }, []);
}

/**
 * Sorgu önbelleğini güncelle (placeholder)
 */
export function useUpdateQueryCache() {
  return useCallback((key: string, updater: (oldData: unknown) => unknown) => {
    // Placeholder - can be implemented with react-query
    console.log('Update cache:', key, updater);
  }, []);
}

/**
 * Sorgu önbelleğini geçersiz kıl (placeholder)
 */
export function useInvalidateQueries() {
  return useCallback((key: string | string[]) => {
    // Placeholder - can be implemented with react-query
    console.log('Invalidate:', key);
  }, []);
}

export default useGraphQLQuery;
