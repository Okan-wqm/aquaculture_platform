/**
 * useFilters Hook
 *
 * Reusable filter state management with URL sync and debounce support.
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

export interface UseFiltersOptions<T extends Record<string, unknown>> {
  /** Initial filter values */
  initialFilters: T;
  /** Sync with URL search params */
  syncUrl?: boolean;
  /** Debounce delay for search filters (ms) */
  debounceDelay?: number;
  /** Keys to debounce (e.g., 'search', 'query') */
  debounceKeys?: (keyof T)[];
  /** Callback when filters change */
  onChange?: (filters: T) => void;
}

export interface UseFiltersReturn<T extends Record<string, unknown>> {
  /** Current filter values */
  filters: T;
  /** Debounced filter values (for API calls) */
  debouncedFilters: T;
  /** Set a single filter value */
  setFilter: <K extends keyof T>(key: K, value: T[K]) => void;
  /** Set multiple filter values */
  setFilters: (updates: Partial<T>) => void;
  /** Reset all filters to initial values */
  resetFilters: () => void;
  /** Clear all filters */
  clearFilters: () => void;
  /** Check if filters have changed from initial */
  hasActiveFilters: boolean;
  /** Get active filter count */
  activeFilterCount: number;
  /** Get filter value by key */
  getFilter: <K extends keyof T>(key: K) => T[K];
}

export function useFilters<T extends Record<string, unknown>>(
  options: UseFiltersOptions<T>
): UseFiltersReturn<T> {
  const {
    initialFilters,
    syncUrl = false,
    debounceDelay = 300,
    debounceKeys = [],
    onChange,
  } = options;

  const [searchParams, setSearchParams] = useSearchParams();

  // Initialize from URL if syncing
  const getInitialFilters = (): T => {
    if (!syncUrl) return initialFilters;

    const urlFilters: Partial<T> = {};
    Object.keys(initialFilters).forEach((key) => {
      const urlValue = searchParams.get(key);
      if (urlValue !== null) {
        // Try to parse as JSON for objects/arrays, otherwise use string
        try {
          (urlFilters as Record<string, unknown>)[key] = JSON.parse(urlValue);
        } catch {
          (urlFilters as Record<string, unknown>)[key] = urlValue;
        }
      }
    });

    return { ...initialFilters, ...urlFilters };
  };

  const [filters, setFiltersState] = useState<T>(getInitialFilters);
  const [debouncedFilters, setDebouncedFilters] = useState<T>(filters);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Update URL when filters change
  const updateUrl = useCallback(
    (newFilters: T) => {
      if (!syncUrl) return;

      const newParams = new URLSearchParams(searchParams);

      Object.entries(newFilters).forEach(([key, value]) => {
        const initialValue = initialFilters[key as keyof T];

        // Only add to URL if different from initial
        if (value !== initialValue && value !== '' && value !== null && value !== undefined) {
          newParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
        } else {
          newParams.delete(key);
        }
      });

      setSearchParams(newParams, { replace: true });
    },
    [syncUrl, searchParams, setSearchParams, initialFilters]
  );

  // Debounce effect
  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      setDebouncedFilters(filters);
      onChange?.(filters);
    }, debounceDelay);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [filters, debounceDelay, onChange]);

  const setFilter = useCallback(
    <K extends keyof T>(key: K, value: T[K]) => {
      setFiltersState((prev) => {
        const newFilters = { ...prev, [key]: value };
        updateUrl(newFilters);

        // If not a debounced key, update immediately
        if (!debounceKeys.includes(key)) {
          setDebouncedFilters(newFilters);
          onChange?.(newFilters);
        }

        return newFilters;
      });
    },
    [debounceKeys, onChange, updateUrl]
  );

  const setFiltersMultiple = useCallback(
    (updates: Partial<T>) => {
      setFiltersState((prev) => {
        const newFilters = { ...prev, ...updates };
        updateUrl(newFilters);
        return newFilters;
      });
    },
    [updateUrl]
  );

  const resetFilters = useCallback(() => {
    setFiltersState(initialFilters);
    setDebouncedFilters(initialFilters);
    updateUrl(initialFilters);
    onChange?.(initialFilters);
  }, [initialFilters, onChange, updateUrl]);

  const clearFilters = useCallback(() => {
    const clearedFilters = Object.keys(initialFilters).reduce((acc, key) => {
      const value = initialFilters[key as keyof T];
      // Keep the same type but set to empty/default
      if (typeof value === 'string') {
        (acc as Record<string, unknown>)[key] = '';
      } else if (Array.isArray(value)) {
        (acc as Record<string, unknown>)[key] = [];
      } else if (typeof value === 'number') {
        (acc as Record<string, unknown>)[key] = 0;
      } else if (typeof value === 'boolean') {
        (acc as Record<string, unknown>)[key] = false;
      } else {
        (acc as Record<string, unknown>)[key] = null;
      }
      return acc;
    }, {} as T);

    setFiltersState(clearedFilters);
    setDebouncedFilters(clearedFilters);
    updateUrl(clearedFilters);
    onChange?.(clearedFilters);
  }, [initialFilters, onChange, updateUrl]);

  const hasActiveFilters = useMemo(() => {
    return Object.keys(filters).some((key) => {
      const currentValue = filters[key as keyof T];
      const initialValue = initialFilters[key as keyof T];

      if (currentValue === initialValue) return false;
      if (currentValue === '' || currentValue === null || currentValue === undefined) return false;
      if (Array.isArray(currentValue) && currentValue.length === 0) return false;

      return true;
    });
  }, [filters, initialFilters]);

  const activeFilterCount = useMemo(() => {
    return Object.keys(filters).filter((key) => {
      const currentValue = filters[key as keyof T];
      const initialValue = initialFilters[key as keyof T];

      if (currentValue === initialValue) return false;
      if (currentValue === '' || currentValue === null || currentValue === undefined) return false;
      if (Array.isArray(currentValue) && currentValue.length === 0) return false;

      return true;
    }).length;
  }, [filters, initialFilters]);

  const getFilter = useCallback(
    <K extends keyof T>(key: K): T[K] => filters[key],
    [filters]
  );

  return {
    filters,
    debouncedFilters,
    setFilter,
    setFilters: setFiltersMultiple,
    resetFilters,
    clearFilters,
    hasActiveFilters,
    activeFilterCount,
    getFilter,
  };
}

export default useFilters;
