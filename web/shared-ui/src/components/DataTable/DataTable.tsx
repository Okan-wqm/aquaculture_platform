/**
 * Enterprise-grade DataTable Component
 * Features: Sorting, Pagination, Filtering, Search, Export, Column Visibility, Bulk Actions
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';

import { downloadCsv } from '../../utils/csv';

import { useI18n } from '../../i18n';

import { Spinner } from '../Loading/Loading';
import { EmptyState } from '../EmptyState/EmptyState';

// ============================================================================
// Types
// ============================================================================

export interface TableColumn<T> {
  key: keyof T | string;
  /** The column's name: what the export writes, the visibility menu lists and the sort control is labelled with. */
  header: string;
  /** What the header cell shows when the name alone is not enough (key and sensitivity markers, units); defaults to `header`. */
  headerRender?: React.ReactNode;
  sortable?: boolean;
  filterable?: boolean;
  width?: string;
  minWidth?: string;
  align?: 'left' | 'center' | 'right';
  hidden?: boolean;
  sticky?: 'left' | 'right';
  render?: (value: unknown, row: T, index: number) => React.ReactNode;
  filterType?: 'text' | 'select' | 'date' | 'dateRange' | 'number' | 'boolean';
  filterOptions?: Array<{ value: string; label: string }>;
  exportable?: boolean;
  className?: string;
}

export interface SortConfig {
  key: string;
  direction: 'asc' | 'desc';
}

export interface FilterConfig {
  [key: string]: string | string[] | { from?: string; to?: string };
}

export interface PaginationConfig {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface DataTableProps<T> {
  /** Rows to render. Accepts readonly arrays: the table never mutates them. */
  data: readonly T[];
  columns: TableColumn<T>[];
  /** Stable row key; the index is there for rows that have no identity of their own (form arrays). */
  keyExtractor: (row: T, index: number) => string;

  // Sorting
  sortable?: boolean;
  defaultSort?: SortConfig;
  onSort?: (sort: SortConfig | null) => void;
  serverSideSort?: boolean;

  // Pagination
  pagination?: PaginationConfig;
  pageSizeOptions?: number[];
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (limit: number) => void;

  // Filtering
  filterable?: boolean;
  filters?: FilterConfig;
  onFilterChange?: (filters: FilterConfig) => void;

  // Search
  searchable?: boolean;
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (search: string) => void;
  searchDebounceMs?: number;

  // Selection
  selectable?: boolean;
  selectedRows?: string[];
  onSelectionChange?: (selectedIds: string[]) => void;

  // Bulk Actions
  bulkActions?: Array<{
    key: string;
    label: string;
    icon?: React.ReactNode;
    variant?: 'primary' | 'secondary' | 'danger';
    onClick: (selectedIds: string[]) => void;
  }>;

  // Export
  exportable?: boolean;
  exportFormats?: Array<'csv' | 'xlsx' | 'pdf' | 'json'>;
  onExport?: (format: string, selectedIds?: string[]) => void;
  exportFileName?: string;

  // Column Visibility
  columnVisibilityToggle?: boolean;

  // Loading & Empty States
  loading?: boolean;
  loadingMessage?: string;
  /** What the empty body says — a string, or a heading-plus-hint node. */
  emptyMessage?: React.ReactNode;
  emptyIcon?: React.ReactNode;

  // Styling
  striped?: boolean;
  hoverable?: boolean;
  bordered?: boolean;
  compact?: boolean;
  stickyHeader?: boolean;
  maxHeight?: string;
  /**
   * No card chrome (radius, shadow, dark ring): for a table that fills a
   * panel which already draws its own — an operator tray, a collapsible
   * section — so the two do not stack.
   */
  flush?: boolean;
  className?: string;

  // Row Actions
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T, index: number) => string;

  // Expansion
  expandable?: boolean;
  renderExpandedRow?: (row: T) => React.ReactNode;
  /** Controlled expansion: the ids that are open. Omit to let the table keep its own set. */
  expandedRowIds?: string[];
  onExpandedChange?: (ids: string[]) => void;
  /** Whether the table renders its own chevron column; false when a cell of the page toggles expansion instead. */
  expandToggle?: boolean;

  /**
   * A totals row under the body, keyed by column key and aligned with the
   * columns; rendered only when there are rows to total.
   */
  summaryRow?: Partial<Record<string, React.ReactNode>>;

  // Header Actions
  headerActions?: React.ReactNode;

  // Refresh
  onRefresh?: () => void;
  refreshing?: boolean;
}

// ============================================================================
// Helper Components
// ============================================================================

const SortIcon: React.FC<{ direction?: 'asc' | 'desc' }> = ({ direction }) => {
  if (!direction) {
    return (
      <svg className="w-4 h-4 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
      </svg>
    );
  }
  return direction === 'asc' ? (
    <svg className="w-4 h-4 text-primary-600 dark:text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
    </svg>
  ) : (
    <svg className="w-4 h-4 text-primary-600 dark:text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
};

const Checkbox: React.FC<{
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}> = ({ checked, indeterminate, onChange, disabled }) => {
  const ref = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = indeterminate || false;
    }
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      disabled={disabled}
      className="h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500 focus:ring-offset-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800"
    />
  );
};

// ============================================================================
// PERF-010: Memoized table body — prevents rows re-rendering when menu state
// (showColumnMenu / showExportMenu / showFilterPanel) changes in the parent.
// ============================================================================

interface TableBodyProps<T> {
  loading: boolean;
  loadingMessage: string;
  emptyMessage: React.ReactNode;
  emptyIcon?: React.ReactNode;
  processedData: T[];
  activeColumns: TableColumn<T>[];
  selectable: boolean;
  expandable: boolean;
  expandToggle: boolean;
  selectedRows: string[];
  expandedRows: Set<string>;
  keyExtractor: (row: T, index: number) => string;
  rowClasses: (row: T, index: number) => string;
  cellClasses: string;
  onRowClick?: (row: T) => void;
  handleSelectRow: (id: string, checked: boolean) => void;
  handleToggleExpand: (id: string) => void;
  renderExpandedRow?: (row: T) => React.ReactNode;
}

const TableBodyInner = <T,>({
  loading,
  loadingMessage,
  emptyMessage,
  emptyIcon,
  processedData,
  activeColumns,
  selectable,
  expandable,
  expandToggle,
  selectedRows,
  expandedRows,
  keyExtractor,
  rowClasses,
  cellClasses,
  onRowClick,
  handleSelectRow,
  handleToggleExpand,
  renderExpandedRow,
}: TableBodyProps<T>) => {
  const colSpan = (selectable ? 1 : 0) + (expandable && expandToggle ? 1 : 0) + activeColumns.length;

  return (
    <tbody className="bg-white divide-y divide-gray-200 dark:bg-gray-900 dark:divide-gray-700">
      {loading ? (
        <tr>
          <td colSpan={colSpan} className="px-4 py-12 text-center">
            <div className="flex flex-col items-center gap-3">
              <Spinner size="lg" />
              <span className="text-sm text-gray-500 dark:text-gray-400">{loadingMessage}</span>
            </div>
          </td>
        </tr>
      ) : processedData.length === 0 ? (
        <tr>
          <td colSpan={colSpan} className="px-4">
            <EmptyState variant="plain" size="sm" icon={emptyIcon} title={emptyMessage} />
          </td>
        </tr>
      ) : (
        processedData.map((row, index) => {
          const rowId = keyExtractor(row, index);
          const isSelected = selectedRows.includes(rowId);
          const isExpanded = expandedRows.has(rowId);

          return (
            <React.Fragment key={rowId}>
              <tr
                className={`${rowClasses(row, index)} ${isSelected ? 'bg-primary-50 dark:bg-primary-900/30' : ''}`}
                onClick={() => onRowClick?.(row)}
              >
                {selectable && (
                  <td className="px-4 py-3 w-12" onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={isSelected} onChange={(checked) => handleSelectRow(rowId, checked)} />
                  </td>
                )}
                {expandable && expandToggle && (
                  <td className="px-4 py-3 w-12" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => handleToggleExpand(rowId)}
                      className="p-1 rounded hover:bg-gray-200 transition-colors dark:hover:bg-gray-700"
                    >
                      <svg
                        className={`w-4 h-4 text-gray-500 transition-transform dark:text-gray-400 ${isExpanded ? 'rotate-90' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </td>
                )}
                {activeColumns.map((col) => {
                  const value = (row as Record<string, unknown>)[String(col.key)];
                  return (
                    <td
                      key={String(col.key)}
                      className={`${cellClasses} text-gray-700 dark:text-gray-200 ${
                        col.sticky ? `sticky ${col.sticky === 'left' ? 'left-0' : 'right-0'} bg-white z-10 dark:bg-gray-900` : ''
                      } ${col.className || ''}`}
                      style={{ textAlign: col.align }}
                    >
                      {col.render ? col.render(value, row, index) : String(value ?? '-')}
                    </td>
                  );
                })}
              </tr>
              {expandable && isExpanded && renderExpandedRow && (
                <tr className="bg-gray-50 dark:bg-gray-800">
                  <td colSpan={colSpan} className="px-4 py-4">
                    {renderExpandedRow(row)}
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        })
      )}
    </tbody>
  );
};
// memo cast required for generic component
const TableBody = React.memo(TableBodyInner) as typeof TableBodyInner;

// ============================================================================
// Main Component
// ============================================================================

export function DataTable<T>({
  data,
  columns,
  keyExtractor,
  sortable = true,
  defaultSort,
  onSort,
  serverSideSort = false,
  pagination,
  pageSizeOptions = [10, 25, 50, 100],
  onPageChange,
  onPageSizeChange,
  filterable = false,
  filters = {},
  onFilterChange,
  searchable = true,
  searchPlaceholder: searchPlaceholderProp,
  searchValue = '',
  onSearchChange,
  searchDebounceMs = 300,
  selectable = false,
  selectedRows = [],
  onSelectionChange,
  bulkActions = [],
  exportable = false,
  exportFormats = ['csv', 'xlsx'],
  onExport,
  exportFileName = 'export',
  columnVisibilityToggle = false,
  loading = false,
  loadingMessage: loadingMessageProp,
  emptyMessage: emptyMessageProp,
  emptyIcon,
  striped = true,
  hoverable = true,
  bordered = false,
  compact = false,
  stickyHeader = true,
  maxHeight,
  flush = false,
  className = '',
  onRowClick,
  rowClassName,
  expandable = false,
  renderExpandedRow,
  expandedRowIds,
  onExpandedChange,
  expandToggle = true,
  summaryRow,
  headerActions,
  onRefresh,
  refreshing = false,
}: DataTableProps<T>) {
  const { t } = useI18n();
  const searchPlaceholder = searchPlaceholderProp ?? t('table.searchPlaceholder');
  const loadingMessage = loadingMessageProp ?? t('common.loading');
  const emptyMessage = emptyMessageProp ?? t('table.noData');
  // State
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(defaultSort || null);
  const [internalSearch, setInternalSearch] = useState(searchValue);
  // BUG-008: Initialize visible columns based on current columns prop.
  // hidden===true means the column starts hidden; hidden===false or undefined means visible.
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(
    () => new Set(columns.filter((c) => c.hidden !== true).map((c) => String(c.key)))
  );
  const [ownExpandedRows, setOwnExpandedRows] = useState<Set<string>>(new Set());
  // Controlled when the page hands in the open ids; otherwise the table keeps its own set.
  const expandedRows = useMemo(
    () => (expandedRowIds ? new Set(expandedRowIds) : ownExpandedRows),
    [expandedRowIds, ownExpandedRows]
  );
  // PERF-010: These three menu state vars cause the full DataTable (including all rows)
  // to re-render when a menu opens/closes. To fix: extract ColumnMenu, ExportMenu, and
  // FilterPanel into separate child components with their own local state.
  const [showColumnMenu, setShowColumnMenu] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showFilterPanel, setShowFilterPanel] = useState(false);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (onSearchChange && internalSearch !== searchValue) {
        onSearchChange(internalSearch);
      }
    }, searchDebounceMs);
    return () => clearTimeout(timer);
  }, [internalSearch, searchDebounceMs, onSearchChange, searchValue]);

  // Sync external search value
  useEffect(() => {
    setInternalSearch(searchValue);
  }, [searchValue]);

  // Handle sorting
  const handleSort = useCallback(
    (key: string) => {
      let newSort: SortConfig | null = null;
      if (!sortConfig || sortConfig.key !== key) {
        newSort = { key, direction: 'asc' };
      } else if (sortConfig.direction === 'asc') {
        newSort = { key, direction: 'desc' };
      }
      setSortConfig(newSort);
      onSort?.(newSort);
    },
    [sortConfig, onSort]
  );

  // Handle selection
  const handleSelectAll = useCallback(
    (checked: boolean) => {
      if (checked) {
        onSelectionChange?.(data.map((row, index) => keyExtractor(row, index)));
      } else {
        onSelectionChange?.([]);
      }
    },
    [data, keyExtractor, onSelectionChange]
  );

  const handleSelectRow = useCallback(
    (id: string, checked: boolean) => {
      if (checked) {
        onSelectionChange?.([...selectedRows, id]);
      } else {
        onSelectionChange?.(selectedRows.filter((r) => r !== id));
      }
    },
    [selectedRows, onSelectionChange]
  );

  // Handle expansion
  const handleToggleExpand = useCallback(
    (id: string) => {
      const toggled = (prev: Set<string>): Set<string> => {
        const newSet = new Set(prev);
        if (newSet.has(id)) {
          newSet.delete(id);
        } else {
          newSet.add(id);
        }
        return newSet;
      };
      if (expandedRowIds) {
        onExpandedChange?.([...toggled(new Set(expandedRowIds))]);
      } else {
        setOwnExpandedRows(toggled);
      }
    },
    [expandedRowIds, onExpandedChange]
  );

  // Process data (client-side operations)
  // PERF-002: processedData recomputes whenever the `data` reference changes.
  // Callers MUST pass a stable array reference (via useState or useMemo in the parent)
  // to avoid O(n log n) sort on every parent render.
  const processedData = useMemo(() => {
    const result = [...data];

    // Client-side sorting
    if (sortConfig && !serverSideSort) {
      result.sort((a, b) => {
        const aVal = (a as Record<string, unknown>)[sortConfig.key];
        const bVal = (b as Record<string, unknown>)[sortConfig.key];

        if (aVal === bVal) return 0;
        if (aVal === null || aVal === undefined) return 1;
        if (bVal === null || bVal === undefined) return -1;

        const comparison = aVal < bVal ? -1 : 1;
        return sortConfig.direction === 'asc' ? comparison : -comparison;
      });
    }

    return result;
  }, [data, sortConfig, serverSideSort]);

  // Visible columns
  const activeColumns = useMemo(
    () => columns.filter((c) => visibleColumns.has(String(c.key))),
    [columns, visibleColumns]
  );

  // PERF-014: Memoize derived selection state to avoid recomputing on every render
  const isAllSelected = useMemo(
    () => data.length > 0 && selectedRows.length === data.length,
    [data.length, selectedRows.length]
  );
  const isSomeSelected = useMemo(
    () => selectedRows.length > 0 && selectedRows.length < data.length,
    [data.length, selectedRows.length]
  );

  // Export handler
  const handleExport = useCallback(
    (format: string) => {
      setShowExportMenu(false);
      if (onExport) {
        onExport(format, selectedRows.length > 0 ? selectedRows : undefined);
        return;
      }

      // Client-side CSV export — the writer shared with every other Export control
      if (format === 'csv') {
        const exportColumns = activeColumns.filter((c) => c.exportable !== false);
        downloadCsv(
          exportFileName,
          exportColumns.map((c) => c.header),
          processedData.map((row) => exportColumns.map((col) => (row as Record<string, unknown>)[String(col.key)])),
        );
      }
    },
    [activeColumns, processedData, selectedRows, onExport, exportFileName]
  );

  // Styles
  // PERF-006: Memoize static table class string — only changes when border prop changes
  const tableClasses = useMemo(
    () =>
      ['min-w-full divide-y divide-gray-200 dark:divide-gray-700', bordered && 'border border-gray-200 dark:border-gray-700']
        .filter(Boolean)
        .join(' '),
    [bordered]
  );

  // PERF-006: Return a stable function so React reconciler can bail out on rows that haven't changed
  const rowClasses = useCallback(
    (row: T, index: number) =>
      [
        striped && index % 2 === 1 && 'bg-gray-50 dark:bg-gray-800/60',
        hoverable && 'hover:bg-primary-50 transition-colors duration-150 dark:hover:bg-primary-900/20',
        onRowClick && 'cursor-pointer',
        rowClassName?.(row, index),
      ]
        .filter(Boolean)
        .join(' '),
    [striped, hoverable, onRowClick, rowClassName]
  );

  const cellClasses = compact ? 'px-3 py-2 text-sm' : 'px-4 py-3 text-sm';

  // WHY conditional: a page that keeps its own filters above the table would
  // otherwise get an empty bordered strip where the toolbar would be.
  const hasToolbar =
    searchable ||
    filterable ||
    exportable ||
    columnVisibilityToggle ||
    Boolean(headerActions) ||
    Boolean(onRefresh) ||
    (selectable && selectedRows.length > 0 && bulkActions.length > 0);

  return (
    <div className={`bg-white dark:bg-gray-900 ${flush ? '' : 'rounded-lg shadow dark:shadow-none dark:ring-1 dark:ring-gray-700'} ${className}`}>
      {/* Header — only when there is something to put in it */}
      {hasToolbar && (
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          {/* Search */}
          {searchable && (
            <div className="relative flex-1 max-w-md">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <svg className="h-5 w-5 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <input
                type="text"
                placeholder={searchPlaceholder}
                value={internalSearch}
                onChange={(e) => setInternalSearch(e.target.value)}
                className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg text-sm placeholder-gray-400 focus:outline-hidden focus:ring-2 focus:ring-primary-500 focus:border-transparent dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
              />
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Bulk Actions */}
            {selectable && selectedRows.length > 0 && bulkActions.length > 0 && (
              <div className="flex items-center gap-2 px-3 py-1 bg-primary-50 rounded-lg dark:bg-primary-900/30">
                <span className="text-sm text-primary-700 font-medium dark:text-primary-300">{selectedRows.length} selected</span>
                {bulkActions.map((action) => (
                  <button
                    key={action.key}
                    onClick={() => action.onClick(selectedRows)}
                    className={`inline-flex items-center gap-1 px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                      action.variant === 'danger'
                        ? 'text-error-700 hover:bg-error-100 dark:text-error-300 dark:hover:bg-error-900/40'
                        : action.variant === 'secondary'
                        ? 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700'
                        : 'text-primary-700 hover:bg-primary-100 dark:text-primary-300 dark:hover:bg-primary-900/40'
                    }`}
                  >
                    {action.icon}
                    {action.label}
                  </button>
                ))}
              </div>
            )}

            {/* Filter Toggle */}
            {filterable && (
              <button
                onClick={() => setShowFilterPanel(!showFilterPanel)}
                className={`p-2 rounded-lg border transition-colors ${
                  showFilterPanel || Object.keys(filters).length > 0
                    ? 'border-primary-500 bg-primary-50 text-primary-600 dark:bg-primary-900/30 dark:text-primary-300'
                    : 'border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800'
                }`}
                title={t('table.toggleFilters')}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                </svg>
              </button>
            )}

            {/* Column Visibility */}
            {columnVisibilityToggle && (
              <div className="relative">
                <button
                  onClick={() => setShowColumnMenu(!showColumnMenu)}
                  className="p-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                  title={t('table.toggleColumns')}
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
                  </svg>
                </button>
                {showColumnMenu && (
                  <div className="absolute right-0 mt-2 w-56 bg-white rounded-lg shadow-lg border border-gray-200 z-50 dark:bg-gray-800 dark:border-gray-600">
                    <div className="p-2">
                      <div className="text-xs font-semibold text-gray-500 uppercase px-2 py-1 dark:text-gray-400">{t('table.columns')}</div>
                      {columns.map((col) => (
                        <label
                          key={String(col.key)}
                          className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer dark:hover:bg-gray-700"
                        >
                          <Checkbox
                            checked={visibleColumns.has(String(col.key))}
                            onChange={(checked) => {
                              const newSet = new Set(visibleColumns);
                              if (checked) {
                                newSet.add(String(col.key));
                              } else if (newSet.size > 1) {
                                newSet.delete(String(col.key));
                              }
                              setVisibleColumns(newSet);
                            }}
                          />
                          <span className="text-sm text-gray-700 dark:text-gray-200">{col.header}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Export */}
            {exportable && (
              <div className="relative">
                <button
                  onClick={() => setShowExportMenu(!showExportMenu)}
                  className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors dark:text-gray-200 dark:bg-gray-800 dark:border-gray-600 dark:hover:bg-gray-700"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Export
                </button>
                {showExportMenu && (
                  <div className="absolute right-0 mt-2 w-40 bg-white rounded-lg shadow-lg border border-gray-200 z-50 dark:bg-gray-800 dark:border-gray-600">
                    {exportFormats.map((format) => (
                      <button
                        key={format}
                        onClick={() => handleExport(format)}
                        className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 first:rounded-t-lg last:rounded-b-lg dark:text-gray-200 dark:hover:bg-gray-700"
                      >
                        Export as {format.toUpperCase()}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Refresh */}
            {onRefresh && (
              <button
                onClick={onRefresh}
                disabled={refreshing}
                className="p-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                title={t('common.refresh')}
              >
                <svg
                  className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            )}

            {/* Custom Header Actions */}
            {headerActions}
          </div>
        </div>

        {/* Filter Panel */}
        {filterable && showFilterPanel && (
          <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
            <div className="flex flex-wrap gap-3">
              {columns
                .filter((col) => col.filterable)
                .map((col) => (
                  <div key={String(col.key)} className="flex-1 min-w-[200px] max-w-[300px]">
                    <label className="block text-xs font-medium text-gray-500 mb-1 dark:text-gray-400">{col.header}</label>
                    {col.filterType === 'select' ? (
                      <select
                        value={(filters[String(col.key)] as string) || ''}
                        onChange={(e) =>
                          onFilterChange?.({
                            ...filters,
                            [String(col.key)]: e.target.value || undefined,
                          } as FilterConfig)
                        }
                        className="block w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                      >
                        <option value="">{t('common.all')}</option>
                        {col.filterOptions?.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={col.filterType === 'date' ? 'date' : col.filterType === 'number' ? 'number' : 'text'}
                        value={(filters[String(col.key)] as string) || ''}
                        onChange={(e) =>
                          onFilterChange?.({
                            ...filters,
                            [String(col.key)]: e.target.value || undefined,
                          } as FilterConfig)
                        }
                        placeholder={`Filter ${col.header.toLowerCase()}...`}
                        className="block w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                      />
                    )}
                  </div>
                ))}
              {Object.keys(filters).length > 0 && (
                <button
                  onClick={() => onFilterChange?.({})}
                  className="self-end px-3 py-2 text-sm text-error-600 hover:text-error-800 dark:text-error-400 dark:hover:text-error-300"
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      )}

      {/* Table Container */}
      <div className={`overflow-x-auto ${maxHeight ? 'overflow-y-auto' : ''}`} style={{ maxHeight }}>
        <table className={tableClasses}>
          {/* Header */}
          <thead className={`bg-gray-50 dark:bg-gray-800 ${stickyHeader ? 'sticky top-0 z-10' : ''}`}>
            <tr>
              {/* Selection Checkbox */}
              {selectable && (
                <th scope="col" className="px-4 py-3 w-12">
                  <Checkbox
                    checked={isAllSelected}
                    indeterminate={isSomeSelected}
                    onChange={handleSelectAll}
                    disabled={data.length === 0}
                  />
                </th>
              )}

              {/* Expand Toggle */}
              {expandable && expandToggle && <th scope="col" className="px-4 py-3 w-12" />}

              {/* Data Columns — a sortable header is a real <button> inside the
                  <th>, so sorting is reachable by keyboard and the column keeps
                  its own name; aria-sort on the <th> carries the state. */}
              {activeColumns.map((col) => {
                const canSort = col.sortable !== false && sortable;
                const alignClass = col.align === 'right' ? 'justify-end' : col.align === 'center' ? 'justify-center' : '';
                const sorted = sortConfig?.key === String(col.key);
                const headerContent = (
                  <>
                    {col.headerRender ?? col.header}
                    {canSort && <SortIcon direction={sorted ? sortConfig.direction : undefined} />}
                  </>
                );
                return (
                  <th
                    key={String(col.key)}
                    scope="col"
                    className={`${cellClasses} text-left text-xs font-semibold text-gray-600 uppercase tracking-wider dark:text-gray-300 ${
                      canSort ? 'hover:bg-gray-100 dark:hover:bg-gray-700' : ''
                    } ${col.sticky ? `sticky ${col.sticky === 'left' ? 'left-0' : 'right-0'} bg-gray-50 z-20 dark:bg-gray-800` : ''} ${
                      col.className || ''
                    }`}
                    style={{ width: col.width, minWidth: col.minWidth }}
                    aria-sort={sorted ? (sortConfig.direction === 'asc' ? 'ascending' : 'descending') : canSort ? 'none' : undefined}
                  >
                    {canSort ? (
                      <button
                        type="button"
                        onClick={() => handleSort(String(col.key))}
                        className={`flex w-full items-center gap-2 select-none rounded uppercase tracking-wider focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500 ${alignClass}`}
                      >
                        {headerContent}
                      </button>
                    ) : (
                      <div className={`flex items-center gap-2 ${alignClass}`}>{headerContent}</div>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>

          {/* Body — rendered by memoized TableBody to prevent re-renders on menu open/close (PERF-010) */}
          <TableBody
            loading={loading}
            loadingMessage={loadingMessage}
            emptyMessage={emptyMessage}
            emptyIcon={emptyIcon}
            processedData={processedData}
            activeColumns={activeColumns}
            selectable={selectable}
            expandable={expandable}
            expandToggle={expandToggle}
            selectedRows={selectedRows}
            expandedRows={expandedRows}
            keyExtractor={keyExtractor}
            rowClasses={rowClasses}
            cellClasses={cellClasses}
            onRowClick={onRowClick}
            handleSelectRow={handleSelectRow}
            handleToggleExpand={handleToggleExpand}
            renderExpandedRow={renderExpandedRow}
          />

          {/* Summary (totals) row */}
          {summaryRow && !loading && processedData.length > 0 && (
            <tfoot className="bg-gray-50 border-t border-gray-200 dark:bg-gray-800 dark:border-gray-700">
              <tr>
                {selectable && <td className={cellClasses} />}
                {expandable && expandToggle && <td className={cellClasses} />}
                {activeColumns.map((col) => (
                  <td
                    key={String(col.key)}
                    className={`${cellClasses} font-semibold text-gray-900 dark:text-gray-100 ${col.className || ''}`}
                    style={{ textAlign: col.align }}
                  >
                    {summaryRow[String(col.key)]}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Pagination */}
      {pagination && (
        <div className="px-4 py-3 border-t border-gray-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 dark:border-gray-700">
          <div className="text-sm text-gray-600 dark:text-gray-300">
            Showing {Math.min((pagination.page - 1) * pagination.limit + 1, pagination.total)} to{' '}
            {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total} results
          </div>

          <div className="flex items-center gap-4">
            {/* Page Size Selector — only when the page can act on it; an inert select is a false affordance */}
            {onPageSizeChange && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600 dark:text-gray-300">{t('table.rows')}</span>
                <select
                  value={pagination.limit}
                  onChange={(e) => onPageSizeChange(Number(e.target.value))}
                  aria-label={t('table.rowsPerPage')}
                  className="px-2 py-1 text-sm border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                >
                  {pageSizeOptions.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Page Navigation */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => onPageChange?.(1)}
                disabled={pagination.page === 1}
                className="p-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                title={t('table.firstPage')}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                </svg>
              </button>
              <button
                onClick={() => onPageChange?.(pagination.page - 1)}
                disabled={pagination.page === 1}
                className="p-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                title={t('table.previousPage')}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>

              <span className="px-3 py-1 text-sm text-gray-600 dark:text-gray-300">
                {t('table.pageOf', { page: pagination.page, total: pagination.totalPages })}
              </span>

              <button
                onClick={() => onPageChange?.(pagination.page + 1)}
                disabled={pagination.page >= pagination.totalPages}
                className="p-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                title={t('table.nextPage')}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
              <button
                onClick={() => onPageChange?.(pagination.totalPages)}
                disabled={pagination.page >= pagination.totalPages}
                className="p-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                title={t('table.lastPage')}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* BUG-002: Non-blocking click-outside backdrop — use pointer-events-none so it doesn't
          intercept table row clicks or scrolling; menus use z-50 and are above this layer */}
      {(showColumnMenu || showExportMenu) && (
        <div
          className="fixed inset-0 z-40"
          style={{ pointerEvents: 'auto', background: 'transparent' }}
          onClick={() => { setShowColumnMenu(false); setShowExportMenu(false); }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

export default DataTable;
