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
        const expectedType = typeof initialFilters[key as keyof T];
        // Only parse as JSON if the initial value type matches (SEC-010: type validation after JSON.parse)
        if (expectedType === 'string' || expectedType === 'undefined') {
          // String filters: use URL value directly, no JSON.parse needed
          (urlFilters as Record<string, unknown>)[key] = urlValue;
        } else {
          try {
            const parsed = JSON.parse(urlValue);
            // Reject parsed values whose type does not match the expected filter type
            if (typeof parsed === expectedType || (expectedType === 'number' && !isNaN(parsed))) {
              (urlFilters as Record<string, unknown>)[key] = parsed;
            } else if (Array.isArray(parsed) && Array.isArray(initialFilters[key as keyof T])) {
              // Only accept primitive-element arrays
              if (parsed.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
                (urlFilters as Record<string, unknown>)[key] = parsed;
              }
            }
            // Otherwise, silently ignore the malformed URL param
          } catch {
            // Invalid JSON — ignore and use initial value
          }
        }
      }
    });

    return { ...initialFilters, ...urlFilters };
  };

  const [filters, setFiltersState] = useState<T>(getInitialFilters);
  const [debouncedFilters, setDebouncedFilters] = useState<T>(filters);

  const debounceTimerRef = useRef<(ReturnType<typeof setTimeout>) | undefined>(undefined);

  // Update URL when filters change (H2: functional update to avoid stale closure)
  const updateUrl = useCallback(
    (newFilters: T) => {
      if (!syncUrl) return;

      setSearchParams(prev => {
        const newParams = new URLSearchParams(prev);

        Object.entries(newFilters).forEach(([key, value]) => {
          const initialValue = initialFilters[key as keyof T];

          // Only add to URL if different from initial
          if (value !== initialValue && value !== '' && value !== null && value !== undefined) {
            newParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
          } else {
            newParams.delete(key);
          }
        });

        return newParams;
      }, { replace: true });
    },
    [syncUrl, setSearchParams, initialFilters]
  );

  // Track which keys were updated immediately (non-debounced) so we don't call onChange twice (BUG-007, PERF-008)
  const immediateUpdateRef = useRef(false);

  // Debounce effect — only calls onChange for debounced keys; immediate keys already called it in setFilter
  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      setDebouncedFilters(filters);
      // Only fire onChange here if this was a debounced-key change
      if (!immediateUpdateRef.current) {
        onChange?.(filters);
      }
      immediateUpdateRef.current = false;
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

        // If not a debounced key, update debouncedFilters immediately and fire onChange once
        if (!debounceKeys.includes(key)) {
          setDebouncedFilters(newFilters);
          onChange?.(newFilters);
          // Mark as immediate so the debounce effect doesn't re-fire onChange (BUG-007)
          immediateUpdateRef.current = true;
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

        // Mirror setFilter's immediate/debounce split so both APIs share one
        // timing contract: a batch touching no debounced key syncs + fires
        // onChange immediately; a batch touching any debounced key defers to
        // the debounce effect.
        const touchesDebouncedKey = Object.keys(updates).some((key) =>
          debounceKeys.includes(key as keyof T)
        );
        if (!touchesDebouncedKey) {
          setDebouncedFilters(newFilters);
          onChange?.(newFilters);
          immediateUpdateRef.current = true;
        }

        return newFilters;
      });
    },
    [debounceKeys, onChange, updateUrl]
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
