/**
 * useAsyncData Hook Tests
 *
 * Comprehensive tests for the async data fetching hook.
 * Tests cover loading states, error handling, caching, retry logic,
 * abort functionality, and edge cases.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useAsyncData, clearAsyncCache } from '../useAsyncData';

describe('useAsyncData', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearAsyncCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ============================================================================
  // Initial State Tests
  // ============================================================================

  describe('Initial State', () => {
    it('should have correct initial state with immediate=true (default)', () => {
      const fetcher = vi.fn().mockResolvedValue('data');
      const { result } = renderHook(() => useAsyncData(fetcher));

      expect(result.current.loading).toBe(true);
      expect(result.current.data).toBe(null);
      expect(result.current.error).toBe(null);
      expect(result.current.isInitialLoad).toBe(true);
      expect(result.current.canRetry).toBe(false);
    });

    it('should not fetch immediately when immediate=false', () => {
      const fetcher = vi.fn().mockResolvedValue('data');
      const { result } = renderHook(() =>
        useAsyncData(fetcher, { immediate: false })
      );

      expect(result.current.loading).toBe(false);
      expect(result.current.data).toBe(null);
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('should use initialData when provided', () => {
      const fetcher = vi.fn().mockResolvedValue('new data');
      const { result } = renderHook(() =>
        useAsyncData(fetcher, { initialData: 'initial', immediate: false })
      );

      expect(result.current.data).toBe('initial');
    });
  });

  // ============================================================================
  // Successful Fetch Tests
  // ============================================================================

  describe('Successful Fetch', () => {
    it('should fetch and update data on success', async () => {
      const mockData = { id: 1, name: 'Test' };
      const fetcher = vi.fn().mockResolvedValue(mockData);

      const { result } = renderHook(() => useAsyncData(fetcher));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.data).toEqual(mockData);
      expect(result.current.error).toBe(null);
      expect(result.current.isInitialLoad).toBe(false);
    });

    it('should call onSuccess callback with data', async () => {
      const mockData = { id: 1 };
      const fetcher = vi.fn().mockResolvedValue(mockData);
      const onSuccess = vi.fn();

      renderHook(() => useAsyncData(fetcher, { onSuccess }));

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledWith(mockData);
      });
    });

    it('should apply transform function to data', async () => {
      const rawData = { items: [1, 2, 3] };
      const fetcher = vi.fn().mockResolvedValue(rawData);
      const transform = (data: unknown) => (data as typeof rawData).items.length;

      const { result } = renderHook(() =>
        useAsyncData(fetcher, { transform })
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.data).toBe(3);
    });
  });

  // ============================================================================
  // Error Handling Tests
  // ============================================================================

  describe('Error Handling', () => {
    it('should handle fetch errors', async () => {
      const error = new Error('Network error');
      const fetcher = vi.fn().mockRejectedValue(error);

      const { result } = renderHook(() => useAsyncData(fetcher));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.error).toBe('Network error');
      expect(result.current.data).toBe(null);
    });

    it('should call onError callback with error', async () => {
      const error = new Error('Test error');
      const fetcher = vi.fn().mockRejectedValue(error);
      const onError = vi.fn();

      renderHook(() => useAsyncData(fetcher, { onError }));

      await waitFor(() => {
        expect(onError).toHaveBeenCalledWith(error);
      });
    });

    it('should mark network errors as retryable', async () => {
      const error = new Error('Network error');
      const fetcher = vi.fn().mockRejectedValue(error);

      const { result } = renderHook(() => useAsyncData(fetcher));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.canRetry).toBe(true);
    });

    it('should mark timeout errors as retryable', async () => {
      const error = new Error('timeout exceeded');
      const fetcher = vi.fn().mockRejectedValue(error);

      const { result } = renderHook(() => useAsyncData(fetcher));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.canRetry).toBe(true);
    });

    it('should mark 5xx errors as retryable', async () => {
      const error = Object.assign(new Error('Server error'), { status: 500 });
      const fetcher = vi.fn().mockRejectedValue(error);

      const { result } = renderHook(() => useAsyncData(fetcher));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.canRetry).toBe(true);
    });

    it('should handle timeout', async () => {
      const fetcher = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('data'), 60000))
      );

      const { result } = renderHook(() =>
        useAsyncData(fetcher, { timeout: 1000 })
      );

      // Fast-forward past timeout
      await act(async () => {
        vi.advanceTimersByTime(1500);
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.error).toContain('zaman aşımı');
      expect(result.current.canRetry).toBe(true);
    });
  });

  // ============================================================================
  // Caching Tests
  // ============================================================================

  describe('Caching', () => {
    it('should return cached data without fetching', async () => {
      const fetcher = vi.fn().mockResolvedValue('fresh data');
      const cacheKey = 'test-cache-key';

      // First render - fetches data
      const { result: result1 } = renderHook(() =>
        useAsyncData(fetcher, { cacheKey })
      );

      await waitFor(() => {
        expect(result1.current.loading).toBe(false);
      });

      expect(fetcher).toHaveBeenCalledTimes(1);

      // Second render - should use cache
      const { result: result2 } = renderHook(() =>
        useAsyncData(fetcher, { cacheKey })
      );

      await waitFor(() => {
        expect(result2.current.loading).toBe(false);
      });

      expect(fetcher).toHaveBeenCalledTimes(1); // Still 1
      expect(result2.current.data).toBe('fresh data');
    });

    it('should fetch again after cache TTL expires', async () => {
      const fetcher = vi.fn().mockResolvedValue('data');
      const cacheKey = 'expiring-cache';
      const cacheTTL = 1000;

      const { result: result1 } = renderHook(() =>
        useAsyncData(fetcher, { cacheKey, cacheTTL })
      );

      await waitFor(() => {
        expect(result1.current.loading).toBe(false);
      });

      expect(fetcher).toHaveBeenCalledTimes(1);

      // Advance time past TTL
      await act(async () => {
        vi.advanceTimersByTime(1500);
      });

      // New render after TTL - should fetch again
      const { result: result2 } = renderHook(() =>
        useAsyncData(fetcher, { cacheKey, cacheTTL })
      );

      await waitFor(() => {
        expect(result2.current.loading).toBe(false);
      });

      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('should clear specific cache key', async () => {
      const fetcher = vi.fn().mockResolvedValue('data');
      const cacheKey = 'clear-test';

      const { result: result1 } = renderHook(() =>
        useAsyncData(fetcher, { cacheKey })
      );

      await waitFor(() => {
        expect(result1.current.loading).toBe(false);
      });

      clearAsyncCache(cacheKey);

      const { result: result2 } = renderHook(() =>
        useAsyncData(fetcher, { cacheKey })
      );

      await waitFor(() => {
        expect(result2.current.loading).toBe(false);
      });

      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================================
  // Manual Control Tests
  // ============================================================================

  describe('Manual Controls', () => {
    it('should manually fetch data', async () => {
      const fetcher = vi.fn().mockResolvedValue('manual data');

      const { result } = renderHook(() =>
        useAsyncData(fetcher, { immediate: false })
      );

      expect(result.current.data).toBe(null);
      expect(fetcher).not.toHaveBeenCalled();

      await act(async () => {
        await result.current.fetch();
      });

      expect(result.current.data).toBe('manual data');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('should refresh with loading state', async () => {
      const fetcher = vi.fn()
        .mockResolvedValueOnce('first')
        .mockResolvedValueOnce('second');

      const { result } = renderHook(() => useAsyncData(fetcher));

      await waitFor(() => {
        expect(result.current.data).toBe('first');
      });

      let wasLoading = false;
      act(() => {
        result.current.refresh();
        wasLoading = result.current.loading;
      });

      expect(wasLoading).toBe(true);

      await waitFor(() => {
        expect(result.current.data).toBe('second');
      });
    });

    it('should silently refresh without loading state', async () => {
      const fetcher = vi.fn()
        .mockResolvedValueOnce('first')
        .mockResolvedValueOnce('second');

      const { result } = renderHook(() => useAsyncData(fetcher));

      await waitFor(() => {
        expect(result.current.data).toBe('first');
      });

      let loadingDuringRefresh: boolean;

      await act(async () => {
        const promise = result.current.silentRefresh();
        loadingDuringRefresh = result.current.loading;
        await promise;
      });

      expect(loadingDuringRefresh!).toBe(false);
      expect(result.current.data).toBe('second');
    });

    it('should reset to initial state', async () => {
      const fetcher = vi.fn().mockResolvedValue('data');

      const { result } = renderHook(() =>
        useAsyncData(fetcher, { initialData: 'initial' })
      );

      await waitFor(() => {
        expect(result.current.data).toBe('data');
      });

      act(() => {
        result.current.reset();
      });

      expect(result.current.data).toBe('initial');
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBe(null);
      expect(result.current.isInitialLoad).toBe(true);
    });

    it('should manually set data', async () => {
      const fetcher = vi.fn().mockResolvedValue('fetched');

      const { result } = renderHook(() => useAsyncData(fetcher));

      await waitFor(() => {
        expect(result.current.data).toBe('fetched');
      });

      act(() => {
        result.current.setData('manual');
      });

      expect(result.current.data).toBe('manual');
    });

    it('should manually set error', async () => {
      const fetcher = vi.fn().mockResolvedValue('data');

      const { result } = renderHook(() => useAsyncData(fetcher));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      act(() => {
        result.current.setError('Custom error');
      });

      expect(result.current.error).toBe('Custom error');
      expect(result.current.canRetry).toBe(true);
    });
  });

  // ============================================================================
  // Retry Tests
  // ============================================================================

  describe('Retry Functionality', () => {
    it('should retry failed request', async () => {
      const fetcher = vi.fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce('success');

      const { result } = renderHook(() => useAsyncData(fetcher));

      await waitFor(() => {
        expect(result.current.error).toBe('Network error');
      });

      expect(result.current.canRetry).toBe(true);

      await act(async () => {
        await result.current.retry();
      });

      expect(result.current.data).toBe('success');
      expect(result.current.error).toBe(null);
    });

    it('should not retry if canRetry is false', async () => {
      const fetcher = vi.fn().mockResolvedValue('data');

      const { result } = renderHook(() => useAsyncData(fetcher));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.canRetry).toBe(false);

      await act(async () => {
        await result.current.retry();
      });

      // Should not have made another call
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================================
  // Abort Tests
  // ============================================================================

  describe('Abort Functionality', () => {
    it('should abort pending request', async () => {
      let resolvePromise: (value: string) => void;
      const fetcher = vi.fn().mockImplementation(
        () => new Promise<string>((resolve) => {
          resolvePromise = resolve;
        })
      );

      const { result } = renderHook(() => useAsyncData(fetcher));

      expect(result.current.loading).toBe(true);

      act(() => {
        result.current.abort();
      });

      expect(result.current.loading).toBe(false);

      // Resolve the promise after abort
      await act(async () => {
        resolvePromise!('late data');
      });

      // Data should not be set after abort
      expect(result.current.data).toBe(null);
    });

    it('should abort on unmount', async () => {
      let resolvePromise: (value: string) => void;
      const fetcher = vi.fn().mockImplementation(
        () => new Promise<string>((resolve) => {
          resolvePromise = resolve;
        })
      );

      const { unmount } = renderHook(() => useAsyncData(fetcher));

      unmount();

      // Should not throw when promise resolves after unmount
      await act(async () => {
        resolvePromise!('data');
      });
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('Edge Cases', () => {
    it('should prevent concurrent fetches', async () => {
      let callCount = 0;
      const fetcher = vi.fn().mockImplementation(() => {
        callCount++;
        return new Promise((resolve) =>
          setTimeout(() => resolve(`data-${callCount}`), 100)
        );
      });

      const { result } = renderHook(() =>
        useAsyncData(fetcher, { immediate: false })
      );

      // Start multiple fetches simultaneously
      act(() => {
        result.current.fetch();
        result.current.fetch();
        result.current.fetch();
      });

      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      // Should only have made one call
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('should handle non-Error rejection', async () => {
      const fetcher = vi.fn().mockRejectedValue('string error');

      const { result } = renderHook(() => useAsyncData(fetcher));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.error).toBe('Bir hata oluştu');
    });

    it('should handle undefined/null data', async () => {
      const fetcher = vi.fn().mockResolvedValue(null);

      const { result } = renderHook(() => useAsyncData(fetcher));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.data).toBe(null);
      expect(result.current.error).toBe(null);
    });

    it('should capture error code if available', async () => {
      const error = Object.assign(new Error('Bad request'), { code: 'BAD_REQUEST' });
      const fetcher = vi.fn().mockRejectedValue(error);

      const { result } = renderHook(() => useAsyncData(fetcher));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.errorCode).toBe('BAD_REQUEST');
    });
  });

  // ============================================================================
  // Integration Tests (E2E Style)
  // ============================================================================

  describe('E2E Style Integration', () => {
    it('should handle complete fetch-error-retry cycle', async () => {
      const fetcher = vi.fn()
        .mockRejectedValueOnce(new Error('Server unavailable'))
        .mockRejectedValueOnce(new Error('Server unavailable'))
        .mockResolvedValueOnce({ users: ['Alice', 'Bob'] });

      const onSuccess = vi.fn();
      const onError = vi.fn();

      const { result } = renderHook(() =>
        useAsyncData(fetcher, { onSuccess, onError })
      );

      // Initial fetch fails
      await waitFor(() => {
        expect(result.current.error).toBe('Server unavailable');
      });
      expect(onError).toHaveBeenCalledTimes(1);

      // First retry fails
      await act(async () => {
        await result.current.retry();
      });
      expect(result.current.error).toBe('Server unavailable');
      expect(onError).toHaveBeenCalledTimes(2);

      // Second retry succeeds
      await act(async () => {
        await result.current.retry();
      });
      expect(result.current.data).toEqual({ users: ['Alice', 'Bob'] });
      expect(result.current.error).toBe(null);
      expect(onSuccess).toHaveBeenCalledWith({ users: ['Alice', 'Bob'] });
    });

    it('should handle rapid refresh requests', async () => {
      let counter = 0;
      const fetcher = vi.fn().mockImplementation(async () => {
        counter++;
        return `data-${counter}`;
      });

      const { result } = renderHook(() => useAsyncData(fetcher));

      await waitFor(() => {
        expect(result.current.data).toBe('data-1');
      });

      // Rapid refresh calls
      await act(async () => {
        result.current.refresh();
        result.current.refresh();
        result.current.refresh();
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      // Due to concurrent fetch prevention, only 2 calls should be made
      expect(fetcher.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('should work with paginated data pattern', async () => {
      interface Page {
        items: string[];
        page: number;
        total: number;
      }

      let currentPage = 1;
      const fetcher = vi.fn().mockImplementation(async (): Promise<Page> => ({
        items: [`item-${currentPage}-1`, `item-${currentPage}-2`],
        page: currentPage,
        total: 100,
      }));

      const { result, rerender } = renderHook(
        ({ page }: { page: number }) => {
          currentPage = page;
          return useAsyncData<Page>(fetcher, {
            cacheKey: `page-${page}`,
            immediate: true,
          });
        },
        { initialProps: { page: 1 } }
      );

      await waitFor(() => {
        expect(result.current.data?.page).toBe(1);
      });

      // Navigate to page 2
      currentPage = 2;
      rerender({ page: 2 });

      await waitFor(() => {
        expect(result.current.data?.page).toBe(2);
      });

      // Navigate back to page 1 - should use cache
      currentPage = 1;
      rerender({ page: 1 });

      await waitFor(() => {
        expect(result.current.data?.page).toBe(1);
      });

      // Page 1 should be served from cache (only 2 fetches total)
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });
});
