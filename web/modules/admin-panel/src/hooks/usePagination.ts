/**
 * usePagination Hook
 *
 * Reusable pagination logic with URL sync support.
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

export interface PaginationState {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface UsePaginationOptions {
  /** Initial page number (1-indexed) */
  initialPage?: number;
  /** Items per page */
  initialLimit?: number;
  /** Total items (can be updated later) */
  initialTotal?: number;
  /** Sync with URL search params */
  syncUrl?: boolean;
  /** Available page size options */
  pageSizeOptions?: number[];
}

export interface UsePaginationReturn extends PaginationState {
  /** Go to specific page */
  goToPage: (page: number) => void;
  /** Go to next page */
  nextPage: () => void;
  /** Go to previous page */
  prevPage: () => void;
  /** Go to first page */
  firstPage: () => void;
  /** Go to last page */
  lastPage: () => void;
  /** Change page size */
  setLimit: (limit: number) => void;
  /** Update total count */
  setTotal: (total: number) => void;
  /** Reset pagination */
  reset: () => void;
  /** Check if can go to previous */
  canPrev: boolean;
  /** Check if can go to next */
  canNext: boolean;
  /** Calculate offset for API calls */
  offset: number;
  /** Page size options */
  pageSizeOptions: number[];
  /** Get API params object */
  getApiParams: () => { page: number; limit: number; offset: number };
}

export function usePagination(options: UsePaginationOptions = {}): UsePaginationReturn {
  const {
    initialPage = 1,
    initialLimit = 20,
    initialTotal = 0,
    syncUrl = false,
    pageSizeOptions = [10, 20, 50, 100],
  } = options;

  const [searchParams, setSearchParams] = useSearchParams();

  // Get initial values from URL if syncing — clamp to valid ranges (SEC-011, BUG-008)
  const getInitialPage = () => {
    if (syncUrl) {
      const urlPage = searchParams.get('page');
      if (urlPage) {
        const parsed = parseInt(urlPage, 10);
        if (!isNaN(parsed)) return Math.max(1, parsed);
      }
    }
    return initialPage;
  };

  const getInitialLimit = () => {
    if (syncUrl) {
      const urlLimit = searchParams.get('limit');
      if (urlLimit) {
        const parsed = parseInt(urlLimit, 10);
        if (!isNaN(parsed) && pageSizeOptions.includes(parsed)) return parsed;
        // Clamp to nearest allowed value if not in the allowed list
        if (!isNaN(parsed)) return pageSizeOptions.reduce((prev, curr) =>
          Math.abs(curr - parsed) < Math.abs(prev - parsed) ? curr : prev
        );
      }
    }
    return initialLimit;
  };

  const [page, setPage] = useState(getInitialPage);
  const [limit, setLimitState] = useState(getInitialLimit);
  const [total, setTotalState] = useState(initialTotal);

  // Sync pagination state when URL changes externally (e.g., browser back/forward) (BUG-008)
  useEffect(() => {
    if (!syncUrl) return;
    const urlPage = searchParams.get('page');
    const urlLimit = searchParams.get('limit');
    if (urlPage) {
      const parsed = parseInt(urlPage, 10);
      if (!isNaN(parsed) && parsed >= 1 && parsed !== page) setPage(parsed);
    }
    if (urlLimit) {
      const parsed = parseInt(urlLimit, 10);
      if (!isNaN(parsed) && pageSizeOptions.includes(parsed) && parsed !== limit) setLimitState(parsed);
    }
  }, [searchParams]);  

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / limit)), [total, limit]);
  const offset = useMemo(() => (page - 1) * limit, [page, limit]);
  const canPrev = page > 1;
  const canNext = page < totalPages;

  // Update URL when syncing (H2: functional update to avoid stale closure)
  const updateUrl = useCallback(
    (newPage: number, newLimit: number) => {
      if (syncUrl) {
        setSearchParams(prev => {
          const next = new URLSearchParams(prev);
          next.set('page', String(newPage));
          next.set('limit', String(newLimit));
          return next;
        }, { replace: true });
      }
    },
    [syncUrl, setSearchParams]
  );

  const goToPage = useCallback(
    (newPage: number) => {
      const validPage = Math.max(1, Math.min(newPage, totalPages));
      setPage(validPage);
      updateUrl(validPage, limit);
    },
    [totalPages, limit, updateUrl]
  );

  const nextPage = useCallback(() => {
    if (canNext) {
      goToPage(page + 1);
    }
  }, [canNext, page, goToPage]);

  const prevPage = useCallback(() => {
    if (canPrev) {
      goToPage(page - 1);
    }
  }, [canPrev, page, goToPage]);

  const firstPage = useCallback(() => {
    goToPage(1);
  }, [goToPage]);

  const lastPage = useCallback(() => {
    goToPage(totalPages);
  }, [totalPages, goToPage]);

  const setLimit = useCallback(
    (newLimit: number) => {
      setLimitState(newLimit);
      // Reset to first page when changing limit
      setPage(1);
      updateUrl(1, newLimit);
    },
    [updateUrl]
  );

  // M4: clamp current page when total changes to avoid out-of-bounds
  const setTotal = useCallback((newTotal: number) => {
    setTotalState(newTotal);
    setPage(prev => {
      const maxPage = Math.max(1, Math.ceil(newTotal / limit));
      return Math.min(prev, maxPage);
    });
  }, [limit]);

  const reset = useCallback(() => {
    setPage(initialPage);
    setLimitState(initialLimit);
    setTotalState(initialTotal);
    updateUrl(initialPage, initialLimit);
  }, [initialPage, initialLimit, initialTotal, updateUrl]);

  const getApiParams = useCallback(
    () => ({
      page,
      limit,
      offset,
    }),
    [page, limit, offset]
  );

  return {
    page,
    limit,
    total,
    totalPages,
    offset,
    canPrev,
    canNext,
    pageSizeOptions,
    goToPage,
    nextPage,
    prevPage,
    firstPage,
    lastPage,
    setLimit,
    setTotal,
    reset,
    getApiParams,
  };
}

export default usePagination;
