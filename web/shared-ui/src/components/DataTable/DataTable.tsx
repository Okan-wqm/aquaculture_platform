/**
 * Enterprise-grade DataTable Component
 * Features: Sorting, Pagination, Filtering, Search, Export, Column Visibility, Bulk Actions
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';

// ============================================================================
// Types
// ============================================================================

export interface TableColumn<T> {
  key: keyof T | string;
  header: string;
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
  data: T[];
  columns: TableColumn<T>[];
  keyExtractor: (row: T) => string;

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
  serverSidePagination?: boolean;

  // Filtering
  filterable?: boolean;
  filters?: FilterConfig;
  onFilterChange?: (filters: FilterConfig) => void;
  serverSideFilter?: boolean;

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
  emptyMessage?: string;
  emptyIcon?: React.ReactNode;

  // Styling
  striped?: boolean;
  hoverable?: boolean;
  bordered?: boolean;
  compact?: boolean;
  stickyHeader?: boolean;
  maxHeight?: string;
  className?: string;

  // Row Actions
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T, index: number) => string;

  // Expansion
  expandable?: boolean;
  renderExpandedRow?: (row: T) => React.ReactNode;

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
      <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
      </svg>
    );
  }
  return direction === 'asc' ? (
    <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
    </svg>
  ) : (
    <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
      className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 focus:ring-offset-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
};

const Spinner: React.FC<{ size?: 'sm' | 'md' | 'lg' }> = ({ size = 'md' }) => {
  const sizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-6 h-6',
    lg: 'w-8 h-8',
  };
  return (
    <svg className={`animate-spin ${sizeClasses[size]} text-blue-600`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );
};

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
  serverSidePagination = false,
  filterable = false,
  filters = {},
  onFilterChange,
  serverSideFilter = false,
  searchable = true,
  searchPlaceholder = 'Search...',
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
  loadingMessage = 'Loading...',
  emptyMessage = 'No data available',
  emptyIcon,
  striped = true,
  hoverable = true,
  bordered = false,
  compact = false,
  stickyHeader = true,
  maxHeight,
  className = '',
  onRowClick,
  rowClassName,
  expandable = false,
  renderExpandedRow,
  headerActions,
  onRefresh,
  refreshing = false,
}: DataTableProps<T>) {
  // State
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(defaultSort || null);
  const [internalSearch, setInternalSearch] = useState(searchValue);
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(
    new Set(columns.filter((c) => !c.hidden).map((c) => String(c.key)))
  );
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
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
        onSelectionChange?.(data.map(keyExtractor));
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
  const handleToggleExpand = useCallback((id: string) => {
    setExpandedRows((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  }, []);

  // Process data (client-side operations)
  const processedData = useMemo(() => {
    let result = [...data];

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

  // Selection state
  const isAllSelected = data.length > 0 && selectedRows.length === data.length;
  const isSomeSelected = selectedRows.length > 0 && selectedRows.length < data.length;

  // Export handler
  const handleExport = useCallback(
    (format: string) => {
      setShowExportMenu(false);
      if (onExport) {
        onExport(format, selectedRows.length > 0 ? selectedRows : undefined);
        return;
      }

      // Client-side CSV export
      if (format === 'csv') {
        const exportColumns = activeColumns.filter((c) => c.exportable !== false);
        const headers = exportColumns.map((c) => c.header).join(',');
        const rows = processedData.map((row) =>
          exportColumns
            .map((col) => {
              const value = (row as Record<string, unknown>)[String(col.key)];
              const str = String(value ?? '');
              return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
            })
            .join(',')
        );
        const csv = [headers, ...rows].join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${exportFileName}.csv`;
        link.click();
        URL.revokeObjectURL(url);
      }
    },
    [activeColumns, processedData, selectedRows, onExport, exportFileName]
  );

  // Styles
  const tableClasses = [
    'min-w-full divide-y divide-gray-200',
    bordered && 'border border-gray-200',
  ]
    .filter(Boolean)
    .join(' ');

  const rowClasses = (row: T, index: number) =>
    [
      striped && index % 2 === 1 && 'bg-gray-50',
      hoverable && 'hover:bg-blue-50 transition-colors duration-150',
      onRowClick && 'cursor-pointer',
      rowClassName?.(row, index),
    ]
      .filter(Boolean)
      .join(' ');

  const cellClasses = compact ? 'px-3 py-2 text-sm' : 'px-4 py-3 text-sm';

  return (
    <div className={`bg-white rounded-lg shadow ${className}`}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          {/* Search */}
          {searchable && (
            <div className="relative flex-1 max-w-md">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <input
                type="text"
                placeholder={searchPlaceholder}
                value={internalSearch}
                onChange={(e) => setInternalSearch(e.target.value)}
                className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Bulk Actions */}
            {selectable && selectedRows.length > 0 && bulkActions.length > 0 && (
              <div className="flex items-center gap-2 px-3 py-1 bg-blue-50 rounded-lg">
                <span className="text-sm text-blue-700 font-medium">{selectedRows.length} selected</span>
                {bulkActions.map((action) => (
                  <button
                    key={action.key}
                    onClick={() => action.onClick(selectedRows)}
                    className={`inline-flex items-center gap-1 px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                      action.variant === 'danger'
                        ? 'text-red-700 hover:bg-red-100'
                        : action.variant === 'secondary'
                        ? 'text-gray-700 hover:bg-gray-100'
                        : 'text-blue-700 hover:bg-blue-100'
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
                    ? 'border-blue-500 bg-blue-50 text-blue-600'
                    : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                }`}
                title="Toggle filters"
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
                  className="p-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
                  title="Toggle columns"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
                  </svg>
                </button>
                {showColumnMenu && (
                  <div className="absolute right-0 mt-2 w-56 bg-white rounded-lg shadow-lg border border-gray-200 z-50">
                    <div className="p-2">
                      <div className="text-xs font-semibold text-gray-500 uppercase px-2 py-1">Columns</div>
                      {columns.map((col) => (
                        <label
                          key={String(col.key)}
                          className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer"
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
                          <span className="text-sm text-gray-700">{col.header}</span>
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
                  className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Export
                </button>
                {showExportMenu && (
                  <div className="absolute right-0 mt-2 w-40 bg-white rounded-lg shadow-lg border border-gray-200 z-50">
                    {exportFormats.map((format) => (
                      <button
                        key={format}
                        onClick={() => handleExport(format)}
                        className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 first:rounded-t-lg last:rounded-b-lg"
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
                className="p-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
                title="Refresh"
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
          <div className="mt-3 pt-3 border-t border-gray-200">
            <div className="flex flex-wrap gap-3">
              {columns
                .filter((col) => col.filterable)
                .map((col) => (
                  <div key={String(col.key)} className="flex-1 min-w-[200px] max-w-[300px]">
                    <label className="block text-xs font-medium text-gray-500 mb-1">{col.header}</label>
                    {col.filterType === 'select' ? (
                      <select
                        value={(filters[String(col.key)] as string) || ''}
                        onChange={(e) =>
                          onFilterChange?.({
                            ...filters,
                            [String(col.key)]: e.target.value || undefined,
                          } as FilterConfig)
                        }
                        className="block w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">All</option>
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
                        className="block w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    )}
                  </div>
                ))}
              {Object.keys(filters).length > 0 && (
                <button
                  onClick={() => onFilterChange?.({})}
                  className="self-end px-3 py-2 text-sm text-red-600 hover:text-red-800"
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Table Container */}
      <div className={`overflow-x-auto ${maxHeight ? 'overflow-y-auto' : ''}`} style={{ maxHeight }}>
        <table className={tableClasses}>
          {/* Header */}
          <thead className={`bg-gray-50 ${stickyHeader ? 'sticky top-0 z-10' : ''}`}>
            <tr>
              {/* Selection Checkbox */}
              {selectable && (
                <th className="px-4 py-3 w-12">
                  <Checkbox
                    checked={isAllSelected}
                    indeterminate={isSomeSelected}
                    onChange={handleSelectAll}
                    disabled={data.length === 0}
                  />
                </th>
              )}

              {/* Expand Toggle */}
              {expandable && <th className="px-4 py-3 w-12" />}

              {/* Data Columns */}
              {activeColumns.map((col) => (
                <th
                  key={String(col.key)}
                  className={`${cellClasses} text-left text-xs font-semibold text-gray-600 uppercase tracking-wider ${
                    col.sortable !== false && sortable ? 'cursor-pointer select-none hover:bg-gray-100' : ''
                  } ${col.sticky ? `sticky ${col.sticky === 'left' ? 'left-0' : 'right-0'} bg-gray-50 z-20` : ''} ${
                    col.className || ''
                  }`}
                  style={{ width: col.width, minWidth: col.minWidth }}
                  onClick={() => col.sortable !== false && sortable && handleSort(String(col.key))}
                >
                  <div className={`flex items-center gap-2 ${col.align === 'right' ? 'justify-end' : col.align === 'center' ? 'justify-center' : ''}`}>
                    {col.header}
                    {col.sortable !== false && sortable && (
                      <SortIcon direction={sortConfig?.key === String(col.key) ? sortConfig.direction : undefined} />
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>

          {/* Body */}
          <tbody className="bg-white divide-y divide-gray-200">
            {loading ? (
              <tr>
                <td
                  colSpan={(selectable ? 1 : 0) + (expandable ? 1 : 0) + activeColumns.length}
                  className="px-4 py-12 text-center"
                >
                  <div className="flex flex-col items-center gap-3">
                    <Spinner size="lg" />
                    <span className="text-sm text-gray-500">{loadingMessage}</span>
                  </div>
                </td>
              </tr>
            ) : processedData.length === 0 ? (
              <tr>
                <td
                  colSpan={(selectable ? 1 : 0) + (expandable ? 1 : 0) + activeColumns.length}
                  className="px-4 py-12 text-center"
                >
                  <div className="flex flex-col items-center gap-3 text-gray-500">
                    {emptyIcon || (
                      <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
                        />
                      </svg>
                    )}
                    <span className="text-sm">{emptyMessage}</span>
                  </div>
                </td>
              </tr>
            ) : (
              processedData.map((row, index) => {
                const rowId = keyExtractor(row);
                const isSelected = selectedRows.includes(rowId);
                const isExpanded = expandedRows.has(rowId);

                return (
                  <React.Fragment key={rowId}>
                    <tr
                      className={`${rowClasses(row, index)} ${isSelected ? 'bg-blue-50' : ''}`}
                      onClick={() => onRowClick?.(row)}
                    >
                      {/* Selection Checkbox */}
                      {selectable && (
                        <td className="px-4 py-3 w-12" onClick={(e) => e.stopPropagation()}>
                          <Checkbox checked={isSelected} onChange={(checked) => handleSelectRow(rowId, checked)} />
                        </td>
                      )}

                      {/* Expand Toggle */}
                      {expandable && (
                        <td className="px-4 py-3 w-12" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => handleToggleExpand(rowId)}
                            className="p-1 rounded hover:bg-gray-200 transition-colors"
                          >
                            <svg
                              className={`w-4 h-4 text-gray-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                          </button>
                        </td>
                      )}

                      {/* Data Cells */}
                      {activeColumns.map((col) => {
                        const value = (row as Record<string, unknown>)[String(col.key)];
                        return (
                          <td
                            key={String(col.key)}
                            className={`${cellClasses} text-gray-700 ${
                              col.sticky ? `sticky ${col.sticky === 'left' ? 'left-0' : 'right-0'} bg-white z-10` : ''
                            } ${col.className || ''}`}
                            style={{ textAlign: col.align }}
                          >
                            {col.render ? col.render(value, row, index) : String(value ?? '-')}
                          </td>
                        );
                      })}
                    </tr>

                    {/* Expanded Row */}
                    {expandable && isExpanded && renderExpandedRow && (
                      <tr className="bg-gray-50">
                        <td colSpan={(selectable ? 1 : 0) + 1 + activeColumns.length} className="px-4 py-4">
                          {renderExpandedRow(row)}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pagination && (
        <div className="px-4 py-3 border-t border-gray-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="text-sm text-gray-600">
            Showing {Math.min((pagination.page - 1) * pagination.limit + 1, pagination.total)} to{' '}
            {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total} results
          </div>

          <div className="flex items-center gap-4">
            {/* Page Size Selector */}
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-600">Rows:</span>
              <select
                value={pagination.limit}
                onChange={(e) => onPageSizeChange?.(Number(e.target.value))}
                className="px-2 py-1 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {pageSizeOptions.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </div>

            {/* Page Navigation */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => onPageChange?.(1)}
                disabled={pagination.page === 1}
                className="p-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                title="First page"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                </svg>
              </button>
              <button
                onClick={() => onPageChange?.(pagination.page - 1)}
                disabled={pagination.page === 1}
                className="p-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Previous page"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>

              <span className="px-3 py-1 text-sm text-gray-600">
                Page {pagination.page} of {pagination.totalPages}
              </span>

              <button
                onClick={() => onPageChange?.(pagination.page + 1)}
                disabled={pagination.page >= pagination.totalPages}
                className="p-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Next page"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
              <button
                onClick={() => onPageChange?.(pagination.totalPages)}
                disabled={pagination.page >= pagination.totalPages}
                className="p-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Last page"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Click outside handler for menus */}
      {(showColumnMenu || showExportMenu) && (
        <div className="fixed inset-0 z-40" onClick={() => { setShowColumnMenu(false); setShowExportMenu(false); }} />
      )}
    </div>
  );
}

export default DataTable;
