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

// Simple in-memory cache — cleared on logout/session change (SEC-015, BUG-010)
// Fix: H1 -- LRU eviction with max size to prevent unbounded memory growth
const MAX_CACHE_SIZE = 100;

interface CacheEntry {
  data: unknown;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Add an entry to the cache with LRU eviction.
 * Map preserves insertion order, so the first key is the oldest.
 */
function addToCache(key: string, value: CacheEntry): void {
  // If key already exists, delete it first so it moves to the end (most recent)
  cache.delete(key);
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, value);
}

/**
 * Get a cache entry, refreshing its position (LRU touch).
 */
function getCacheEntry(key: string): CacheEntry | undefined {
  const entry = cache.get(key);
  if (entry) {
    // Move to end (most recently used)
    cache.delete(key);
    cache.set(key, entry);
  }
  return entry;
}

// Clear all cached data when the user logs out
if (typeof window !== 'undefined') {
  window.addEventListener('aquaculture:logout', () => cache.clear());
}

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
  const fetchIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Store fetcher in a ref so fetchData doesn't need it as a dep (PERF-001)
  // This prevents infinite re-fetch loops when the caller passes an inline arrow function
  const fetcherRef = useRef(fetcher);
  // Store canRetry in a ref so the retry callback doesn't re-create on every error state
  // change, preventing downstream re-renders in consumers that pass retry as a prop (PERF-001)
  const canRetryRef = useRef(false);

  // Fix: C8 -- Store callbacks in refs to prevent infinite re-fetch loops
  // when consumers pass inline arrow functions for transform/onSuccess/onError.
  // Without this, each render creates new callback references which would cause
  // fetchData identity to change and trigger the refetch useEffect endlessly.
  const transformRef = useRef(transform);
  const onSuccessRef = useRef(onSuccess);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    fetcherRef.current = fetcher;
    transformRef.current = transform;
    onSuccessRef.current = onSuccess;
    onErrorRef.current = onError;
  });

  const fetchData = useCallback(
    async (showLoading = true) => {
      // Abort any previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      abortControllerRef.current = new AbortController();

      // Track this fetch with a unique ID so superseded fetches don't update state
      const fetchId = ++fetchIdRef.current;

      // Check cache (uses LRU touch -- H1)
      if (cacheKey) {
        const cached = getCacheEntry(cacheKey);
        if (cached && Date.now() - cached.timestamp < cacheTTL) {
          if (mountedRef.current && fetchId === fetchIdRef.current) {
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
          return;
        }
      }

      if (showLoading && mountedRef.current) {
        setState((prev) => ({ ...prev, loading: true, error: null, canRetry: false }));
      }

      // Create timeout promise with a clearable timer (BUG-012)
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error('Request timed out'));
        }, timeout);
      });

      try {
        // Race between fetcher and timeout — use ref to avoid stale closure (PERF-001)
        let result = await Promise.race([fetcherRef.current(), timeoutPromise]);

        // Cancel the timeout timer now that fetch completed (BUG-012)
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);

        // Check if this fetch was superseded by a newer one
        if (fetchId !== fetchIdRef.current) {
          return;
        }

        // Apply transform if provided (use ref to avoid stale closure -- C8)
        if (transformRef.current) {
          result = transformRef.current(result) as Awaited<T>;
        }

        // Update cache (uses LRU eviction -- H1)
        if (cacheKey) {
          addToCache(cacheKey, { data: result, timestamp: Date.now() });
        }

        if (mountedRef.current) {
          canRetryRef.current = false;
          setState({
            data: result,
            loading: false,
            error: null,
            isInitialLoad: false,
            canRetry: false,
            errorCode: undefined,
          });
          onSuccessRef.current?.(result);
        }
      } catch (err) {
        // Cancel timeout on any error path too (BUG-012)
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);

        // Ignore superseded or aborted requests
        if (fetchId !== fetchIdRef.current) {
          return;
        }
        if (err instanceof Error && err.name === 'AbortError') {
          if (mountedRef.current) {
            setState((prev) => ({ ...prev, loading: false }));
          }
          return;
        }

        console.error('API fetch failed:', err);

        if (mountedRef.current) {
          const errorMessage = err instanceof Error ? err.message : 'An error occurred';
          const errorCode = (err as { code?: string }).code;

          // Determine if error is retryable (network errors, timeouts, 5xx errors)
          const errStatus = (err as { status?: number }).status;
          const isRetryable =
            errorMessage.includes('timed out') ||
            errorMessage.includes('timeout') ||
            errorMessage.includes('network') ||
            errorMessage.includes('Network') ||
            errStatus === undefined || // Network error (no status)
            (errStatus !== undefined && errStatus >= 500);

          canRetryRef.current = isRetryable;
          setState((prev) => ({
            ...prev,
            loading: false,
            error: errorMessage,
            isInitialLoad: false,
            canRetry: isRetryable,
            errorCode,
          }));
          onErrorRef.current?.(err instanceof Error ? err : new Error(errorMessage));
        }
      }
    },
    // fetcher removed from deps — stored in ref to prevent infinite re-fetch loops (PERF-001)
    // Fix: C8 -- transform, onSuccess, onError removed from deps — stored in refs
    // to prevent infinite re-fetch loops when consumers pass inline arrow functions
    [cacheKey, cacheTTL, timeout]  
  );

  const fetch = useCallback(() => fetchData(true), [fetchData]);
  const refresh = useCallback(() => fetchData(true), [fetchData]);
  const silentRefresh = useCallback(() => fetchData(false), [fetchData]);

  // Read canRetry from ref so this callback is stable and does not re-create every time
  // an error state changes canRetry — prevents downstream re-renders when retry is passed as a prop (PERF-001)
  const retry = useCallback(() => {
    if (canRetryRef.current) {
      return fetchData(true);
    }
    return Promise.resolve();
  }, [fetchData]);

  const abort = useCallback(() => {
    // Increment fetchId so any in-flight fetch is superseded
    fetchIdRef.current++;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
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

  // Fix: C7 -- Refetch when fetchData identity changes (driven by cacheKey / cacheTTL / timeout).
  // Previously used empty dependency array [] which meant no refetch on cacheKey change.
  // Now that C8 stabilized callbacks via refs, fetchData only changes when
  // cacheKey/cacheTTL/timeout change — safe to use as a dependency without infinite loops.
  useEffect(() => {
    if (immediate) {
      fetchData(true);
    }
  }, [fetchData]);  

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
