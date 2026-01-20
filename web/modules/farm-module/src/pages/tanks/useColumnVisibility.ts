/**
 * useColumnVisibility Hook
 * Manages column visibility state with localStorage persistence
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { COLUMN_VISIBILITY_STORAGE_KEY, TankColumn } from './types';
import { getDefaultVisibleColumns, getAllColumnKeys, tankColumns, cleanerFishColumns } from './columns';

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
  // Get column keys and defaults for the provided columns
  const columnKeys = useMemo(() => columns.map(c => c.key), [columns]);
  const defaultVisible = useMemo(() => new Set(columns.filter(c => c.defaultVisible).map(c => c.key)), [columns]);

  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved) as string[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          // Filter to only include valid column keys
          const validKeys = parsed.filter(k => columnKeys.includes(k));
          if (validKeys.length > 0) {
            return new Set(validKeys);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load column visibility settings:', error);
    }
    return defaultVisible;
  });

  // Persist to localStorage when visibility changes
  useEffect(() => {
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify(Array.from(visibleColumns))
      );
    } catch (error) {
      console.error('Failed to save column visibility settings:', error);
    }
  }, [visibleColumns, storageKey]);

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
