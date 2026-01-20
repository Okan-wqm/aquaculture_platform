/**
 * usePagination Hook
 *
 * Reusable pagination logic with URL sync support.
 */

import { useState, useCallback, useMemo } from 'react';
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

  // Get initial values from URL if syncing
  const getInitialPage = () => {
    if (syncUrl) {
      const urlPage = searchParams.get('page');
      return urlPage ? parseInt(urlPage, 10) : initialPage;
    }
    return initialPage;
  };

  const getInitialLimit = () => {
    if (syncUrl) {
      const urlLimit = searchParams.get('limit');
      return urlLimit ? parseInt(urlLimit, 10) : initialLimit;
    }
    return initialLimit;
  };

  const [page, setPage] = useState(getInitialPage);
  const [limit, setLimitState] = useState(getInitialLimit);
  const [total, setTotalState] = useState(initialTotal);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / limit)), [total, limit]);
  const offset = useMemo(() => (page - 1) * limit, [page, limit]);
  const canPrev = page > 1;
  const canNext = page < totalPages;

  // Update URL when syncing
  const updateUrl = useCallback(
    (newPage: number, newLimit: number) => {
      if (syncUrl) {
        const newParams = new URLSearchParams(searchParams);
        newParams.set('page', String(newPage));
        newParams.set('limit', String(newLimit));
        setSearchParams(newParams, { replace: true });
      }
    },
    [syncUrl, searchParams, setSearchParams]
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

  const setTotal = useCallback((newTotal: number) => {
    setTotalState(newTotal);
  }, []);

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
