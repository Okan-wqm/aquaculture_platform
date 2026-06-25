/**
 * useColumnVisibility Hook
 * Manages column visibility state with localStorage persistence
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { getTenantId, tenantScopedStorageKey } from '@aquaculture/shared-ui';
import { COLUMN_VISIBILITY_STORAGE_KEY, TankColumn } from './types';
import { DEFAULT_VISIBLE_COLUMNS, getAllColumnKeys, tankColumns, cleanerFishColumns } from './columns';

export interface UseColumnVisibilityReturn {
  visibleColumns: Set<string>;
  toggleColumn: (columnKey: string) => void;
  toggleGroup: (groupColumns: string[], visible: boolean) => void;
  resetToDefaults: () => void;
  showAllColumns: () => void;
  hideAllColumns: () => void;
  isColumnVisible: (key: string) => boolean;
  visibleCount: number;
  totalCount: number;
}

/**
 * Hook for managing column visibility with localStorage persistence
 * @param storageKey - Custom localStorage key (defaults to COLUMN_VISIBILITY_STORAGE_KEY)
 * @param columns - Custom columns array (defaults to tankColumns)
 */
export function useColumnVisibility(
  storageKey: string = COLUMN_VISIBILITY_STORAGE_KEY,
  columns: TankColumn[] = tankColumns
): UseColumnVisibilityReturn {
  // Scope the storage key by tenantId to prevent cross-tenant data leakage.
  // null when no tenant is resolved → the hook uses the in-memory defaults and
  // never reads/writes a shared 'default' bucket (cross-tenant bleed).
  const scopedStorageKey = useMemo(
    () => tenantScopedStorageKey(storageKey, getTenantId()),
    [storageKey],
  );

  // Get column keys and defaults for the provided columns.
  // PERF-015: When using the default tankColumns, reuse the pre-computed
  // DEFAULT_VISIBLE_COLUMNS constant instead of creating a new Set each render.
  const columnKeys = useMemo(() => columns.map(c => c.key), [columns]);
  const defaultVisible = useMemo(
    () => columns === tankColumns
      ? DEFAULT_VISIBLE_COLUMNS
      : new Set(columns.filter(c => c.defaultVisible).map(c => c.key)),
    [columns],
  );

  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(() => {
    try {
      const saved = scopedStorageKey ? localStorage.getItem(scopedStorageKey) : null;
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          // Filter to only include valid, known column keys
          const validKeys = (parsed as string[]).filter(k => columnKeys.includes(k));
          if (validKeys.length > 0) {
            // BUG-020: After a code update that adds new columns, users who had saved prefs
            // would not see the new columns. Merge saved keys with any defaultVisible columns
            // not in the saved set (i.e. newly added columns).
            const newColumnsToAdd = Array.from(defaultVisible).filter(
              k => !parsed.includes(k) && columnKeys.includes(k)
            );
            return new Set([...validKeys, ...newColumnsToAdd]);
          }
        }
      }
    } catch (error) {
      if (import.meta.env.DEV) console.error('Failed to load column visibility settings:', error);
    }
    return defaultVisible;
  });

  // PERF-007: skip the first mount write — the value was just read from localStorage,
  // so there's no need to immediately write it back.
  // PERF-014: Defer the serialization + write via setTimeout so toggling a column
  // does not block the main thread synchronously on each click.
  const isMounted = useRef(false);
  useEffect(() => {
    if (!isMounted.current) {
      isMounted.current = true;
      return;
    }
    if (!scopedStorageKey) return;
    const serialized = JSON.stringify(Array.from(visibleColumns));
    const timerId = setTimeout(() => {
      try {
        localStorage.setItem(scopedStorageKey, serialized);
      } catch (error) {
        if (import.meta.env.DEV) console.error('Failed to save column visibility settings:', error);
      }
    }, 0);
    return () => clearTimeout(timerId);
  }, [visibleColumns, scopedStorageKey]);

  /**
   * Toggle a single column's visibility
   */
  const toggleColumn = useCallback((columnKey: string) => {
    setVisibleColumns((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(columnKey)) {
        // Prevent hiding all columns - keep at least one
        if (newSet.size > 1) {
          newSet.delete(columnKey);
        }
      } else {
        newSet.add(columnKey);
      }
      return newSet;
    });
  }, []);

  /**
   * Toggle a group of columns
   */
  const toggleGroup = useCallback((groupColumns: string[], visible: boolean) => {
    setVisibleColumns((prev) => {
      const newSet = new Set(prev);
      groupColumns.forEach((col) => {
        if (visible) {
          newSet.add(col);
        } else {
          // Keep at least one column visible
          if (newSet.size > 1) {
            newSet.delete(col);
          }
        }
      });
      return newSet;
    });
  }, []);

  /**
   * Reset to default column visibility
   */
  const resetToDefaults = useCallback(() => {
    setVisibleColumns(defaultVisible);
  }, [defaultVisible]);

  /**
   * Show all columns
   */
  const showAllColumns = useCallback(() => {
    setVisibleColumns(new Set(columnKeys));
  }, [columnKeys]);

  /**
   * Hide all columns (keeps only the first one)
   */
  const hideAllColumns = useCallback(() => {
    setVisibleColumns(new Set([columnKeys[0]])); // Keep at least one
  }, [columnKeys]);

  /**
   * Check if a column is visible
   */
  const isColumnVisible = useCallback(
    (key: string) => visibleColumns.has(key),
    [visibleColumns]
  );

  return {
    visibleColumns,
    toggleColumn,
    toggleGroup,
    resetToDefaults,
    showAllColumns,
    hideAllColumns,
    isColumnVisible,
    visibleCount: visibleColumns.size,
    totalCount: columnKeys.length,
  };
}
