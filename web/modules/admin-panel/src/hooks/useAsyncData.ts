/**
 * useAsyncData Hook
 *
 * Generic hook for fetching data with loading, error, and refresh states.
 * Eliminates boilerplate code for API calls across pages.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  isInitialLoad: boolean;
  /** Whether the request can be retried */
  canRetry: boolean;
  /** Error code if available */
  errorCode?: string;
}

export interface UseAsyncDataOptions<T> {
  /** Initial data value */
  initialData?: T | null;
  /** Whether to fetch immediately on mount */
  immediate?: boolean;
  /** Cache key for deduplication */
  cacheKey?: string;
  /** Cache TTL in milliseconds */
  cacheTTL?: number;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Transform response data */
  transform?: (data: unknown) => T;
  /** Callback on success */
  onSuccess?: (data: T) => void;
  /** Callback on error */
  onError?: (error: Error) => void;
}

export interface UseAsyncDataReturn<T> extends AsyncState<T> {
  /** Manually trigger fetch */
  fetch: () => Promise<void>;
  /** Refresh data (shows loading state) */
  refresh: () => Promise<void>;
  /** Silently refresh (no loading state) */
  silentRefresh: () => Promise<void>;
  /** Reset to initial state */
  reset: () => void;
  /** Manually set data */
  setData: (data: T | null) => void;
  /** Manually set error */
  setError: (error: string | null) => void;
  /** Retry the last failed request */
  retry: () => Promise<void>;
  /** Abort the current request */
  abort: () => void;
}

// Simple in-memory cache
const cache = new Map<string, { data: unknown; timestamp: number }>();

export function useAsyncData<T>(
  fetcher: () => Promise<T>,
  options: UseAsyncDataOptions<T> = {}
): UseAsyncDataReturn<T> {
  const {
    initialData = null,
    immediate = true,
    cacheKey,
    cacheTTL = 30000, // 30 seconds default
    timeout = 30000, // 30 seconds default timeout
    transform,
    onSuccess,
    onError,
  } = options;

  const [state, setState] = useState<AsyncState<T>>({
    data: initialData,
    loading: immediate,
    error: null,
    isInitialLoad: true,
    canRetry: false,
    errorCode: undefined,
  });

  const mountedRef = useRef(true);
  const fetchingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(
    async (showLoading = true) => {
      // Prevent concurrent fetches
      if (fetchingRef.current) return;
      fetchingRef.current = true;

      // Abort any previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      abortControllerRef.current = new AbortController();

      // Check cache
      if (cacheKey) {
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < cacheTTL) {
          if (mountedRef.current) {
            setState((prev) => ({
              ...prev,
              data: cached.data as T,
              loading: false,
              error: null,
              isInitialLoad: false,
              canRetry: false,
              errorCode: undefined,
            }));
          }
          fetchingRef.current = false;
          return;
        }
      }

      if (showLoading && mountedRef.current) {
        setState((prev) => ({ ...prev, loading: true, error: null, canRetry: false }));
      }

      // Create timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error('İstek zaman aşımına uğradı'));
        }, timeout);
      });

      try {
        // Race between fetcher and timeout
        let result = await Promise.race([fetcher(), timeoutPromise]);

        // Check if aborted
        if (abortControllerRef.current?.signal.aborted) {
          fetchingRef.current = false;
          return;
        }

        // Apply transform if provided
        if (transform) {
          result = transform(result) as Awaited<T>;
        }

        // Update cache
        if (cacheKey) {
          cache.set(cacheKey, { data: result, timestamp: Date.now() });
        }

        if (mountedRef.current) {
          setState({
            data: result,
            loading: false,
            error: null,
            isInitialLoad: false,
            canRetry: false,
            errorCode: undefined,
          });
          onSuccess?.(result);
        }
      } catch (err) {
        // Ignore aborted requests
        if (err instanceof Error && err.name === 'AbortError') {
          fetchingRef.current = false;
          return;
        }

        console.error('API fetch failed:', err);

        if (mountedRef.current) {
          const errorMessage = err instanceof Error ? err.message : 'Bir hata oluştu';
          const errorCode = (err as { code?: string }).code;

          // Determine if error is retryable (network errors, timeouts, 5xx errors)
          const isRetryable =
            errorMessage.includes('zaman aşımı') ||
            errorMessage.includes('timeout') ||
            errorMessage.includes('network') ||
            errorMessage.includes('Network') ||
            (err as { status?: number }).status === undefined || // Network error
            ((err as { status?: number }).status ?? 0) >= 500;

          setState((prev) => ({
            ...prev,
            loading: false,
            error: errorMessage,
            isInitialLoad: false,
            canRetry: isRetryable,
            errorCode,
          }));
          onError?.(err instanceof Error ? err : new Error(errorMessage));
        }
      } finally {
        fetchingRef.current = false;
      }
    },
    [fetcher, cacheKey, cacheTTL, timeout, transform, onSuccess, onError]
  );

  const fetch = useCallback(() => fetchData(true), [fetchData]);
  const refresh = useCallback(() => fetchData(true), [fetchData]);
  const silentRefresh = useCallback(() => fetchData(false), [fetchData]);

  const retry = useCallback(() => {
    if (state.canRetry) {
      return fetchData(true);
    }
    return Promise.resolve();
  }, [fetchData, state.canRetry]);

  const abort = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    fetchingRef.current = false;
    setState((prev) => ({ ...prev, loading: false }));
  }, []);

  const reset = useCallback(() => {
    abort();
    setState({
      data: initialData,
      loading: false,
      error: null,
      isInitialLoad: true,
      canRetry: false,
      errorCode: undefined,
    });
  }, [initialData, abort]);

  const setData = useCallback((data: T | null) => {
    setState((prev) => ({ ...prev, data }));
  }, []);

  const setError = useCallback((error: string | null) => {
    setState((prev) => ({ ...prev, error, canRetry: error !== null }));
  }, []);

  // Initial fetch
  useEffect(() => {
    if (immediate) {
      fetchData(true);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Abort any pending request on unmount
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  return {
    ...state,
    fetch,
    refresh,
    silentRefresh,
    reset,
    setData,
    setError,
    retry,
    abort,
  };
}

/**
 * Clear cache for a specific key or all cache
 */
export function clearAsyncCache(key?: string): void {
  if (key) {
    cache.delete(key);
  } else {
    cache.clear();
  }
}

export default useAsyncData;
