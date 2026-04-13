/**
 * useServerSort Hook
 * Server-side sıralama için Table bileşeni ile entegre çalışan hook.
 *
 * Table'ın `sorting` prop'una doğrudan geçirilebilen bir nesne ve
 * GraphQL sorgularına eklenebilen `sortVariables` döndürür.
 *
 * @example
 * const { sorting, sortVariables } = useServerSort({
 *   defaultField: 'createdAt',
 *   defaultOrder: 'desc',
 * });
 *
 * const { data } = useGraphQLQuery('GetFarms', GET_FARMS, {
 *   variables: { ...pagination, ...sortVariables },
 * });
 *
 * return <Table columns={columns} data={data} sorting={sorting} />;
 */

import { useState, useCallback, useMemo } from 'react';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

/** Internal sort state representation */
interface SortState {
  field: string;
  order: 'asc' | 'desc';
}

/** Configuration options for the hook */
export interface UseServerSortOptions {
  /** Initial sort field — when omitted, sorting starts inactive (no column highlighted) */
  defaultField?: string;
  /** Initial sort direction — defaults to 'asc' when a defaultField is provided */
  defaultOrder?: 'asc' | 'desc';
}

/**
 * Return type of useServerSort.
 *
 * - `sorting`       — pass directly to `<Table sorting={sorting} />`
 * - `sortVariables` — spread into GraphQL query variables
 * - `sortState`     — raw state for external logic (e.g. URL sync)
 */
export interface UseServerSortResult {
  /** Pass this directly to the Table's `sorting` prop.
   *  `undefined` when no sort is active (Table renders unsorted). */
  sorting: {
    field: string;
    order: 'asc' | 'desc';
    onChange: (field: string, order: 'asc' | 'desc') => void;
  } | undefined;
  /** Pass these to your GraphQL query variables.
   *  Returns empty object `{}` when no sort is active. */
  sortVariables: { orderBy?: string; orderDirection?: string };
  /** Current sort state for external use (URL sync, analytics, etc.).
   *  `null` when no sort is active. */
  sortState: SortState | null;
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * Manages server-side sort state for Table components.
 *
 * @param options - Optional default field/order configuration
 * @returns Table-compatible sorting prop and GraphQL-compatible variables
 */
export function useServerSort(options?: UseServerSortOptions): UseServerSortResult {
  // ── Initial State ──
  const initialState: SortState | null = options?.defaultField
    ? { field: options.defaultField, order: options.defaultOrder ?? 'asc' }
    : null;

  const [sortState, setSortState] = useState<SortState | null>(initialState);

  // ── onChange Handler ──
  // WHY: Clicking the same column toggles direction; clicking a different
  // column switches to that column with 'asc' as default direction.
  const handleSortChange = useCallback((field: string, order: 'asc' | 'desc'): void => {
    setSortState({ field, order });
  }, []);

  // ── Table-compatible sorting prop ──
  const sorting = useMemo(() => {
    if (!sortState) {
      return undefined;
    }
    return {
      field: sortState.field,
      order: sortState.order,
      onChange: handleSortChange,
    };
  }, [sortState, handleSortChange]);

  // ── GraphQL-compatible variables ──
  const sortVariables = useMemo(() => {
    if (!sortState) {
      return {};
    }
    return {
      orderBy: sortState.field,
      orderDirection: sortState.order,
    };
  }, [sortState]);

  return { sorting, sortVariables, sortState };
}
