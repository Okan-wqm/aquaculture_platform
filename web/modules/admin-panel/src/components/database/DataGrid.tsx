/**
 * DataGrid Component
 *
 * A high-performance data grid for displaying database table data with
 * sorting, pagination, and row actions.
 */

import React, { useState, useEffect, useCallback, useMemo, memo } from 'react';
import { Button, Badge, Spinner } from '@aquaculture/shared-ui';

// ============================================================================
// Types
// ============================================================================

interface ColumnInfo {
  columnName: string;
  dataType: string;
  isNullable: boolean;
  columnDefault: string | null;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  foreignKeyTable?: string;
  foreignKeyColumn?: string;
}

interface TableData {
  tableName: string;
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  totalRows: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface DataGridProps {
  schema: string;
  table: string;
  onRowSelect?: (row: Record<string, unknown>) => void;
  onRowEdit?: (row: Record<string, unknown>) => void;
  onRowDelete?: (row: Record<string, unknown>) => void;
  onRefresh?: () => void;
}

type SortDirection = 'ASC' | 'DESC';

// ============================================================================
// API Functions
// ============================================================================

const API_BASE = '/api/database/explorer';

const getAuthHeader = (): Record<string, string> => {
  const token = localStorage.getItem('access_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

async function fetchTableData(
  schema: string,
  table: string,
  page = 1,
  limit = 50,
  orderBy?: string,
  orderDirection?: SortDirection
): Promise<TableData> {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });
  if (orderBy) {
    params.set('orderBy', orderBy);
    params.set('orderDirection', orderDirection || 'ASC');
  }

  const response = await fetch(
    `${API_BASE}/schemas/${schema}/tables/${table}/data?${params}`,
    { headers: { ...getAuthHeader() } }
  );
  if (!response.ok) throw new Error('Failed to fetch table data');
  return response.json();
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Get the badge color based on data type
 */
const getDataTypeBadgeColor = (
  dataType: string
): 'info' | 'success' | 'warning' | 'error' | 'default' => {
  const type = dataType.toLowerCase();
  if (type.includes('int') || type.includes('numeric') || type.includes('decimal') || type.includes('float') || type.includes('double')) {
    return 'info';
  }
  if (type.includes('varchar') || type.includes('text') || type.includes('char')) {
    return 'success';
  }
  if (type.includes('timestamp') || type.includes('date') || type.includes('time')) {
    return 'warning';
  }
  if (type.includes('bool')) {
    return 'error';
  }
  return 'default';
};

/**
 * Check if a string looks like a UUID
 */
const isUUID = (value: string): boolean => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
};

/**
 * Check if a string is an ISO date
 */
const isISODate = (value: string): boolean => {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !isNaN(date.getTime()) && value.includes('T');
};

/**
 * Format a cell value based on its type
 */
const formatCellValue = (
  value: unknown,
  dataType: string
): { display: string; isNull: boolean; isTruncated: boolean; fullValue: string } => {
  // Handle NULL values
  if (value === null || value === undefined) {
    return { display: 'NULL', isNull: true, isTruncated: false, fullValue: 'NULL' };
  }

  const type = dataType.toLowerCase();
  let stringValue = '';
  let isTruncated = false;

  // Handle JSON/JSONB
  if (type.includes('json')) {
    try {
      stringValue = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    } catch {
      stringValue = String(value);
    }
    if (stringValue.length > 50) {
      isTruncated = true;
    }
    return {
      display: isTruncated ? stringValue.substring(0, 50) + '...' : stringValue,
      isNull: false,
      isTruncated,
      fullValue: stringValue,
    };
  }

  // Handle UUIDs
  if (type.includes('uuid') || (typeof value === 'string' && isUUID(value))) {
    const uuidValue = String(value);
    return {
      display: uuidValue.substring(0, 8) + '...',
      isNull: false,
      isTruncated: true,
      fullValue: uuidValue,
    };
  }

  // Handle timestamps and dates
  if (type.includes('timestamp') || type.includes('date')) {
    if (typeof value === 'string' && isISODate(value)) {
      const date = new Date(value);
      const formatted = type.includes('timestamp')
        ? date.toLocaleString()
        : date.toLocaleDateString();
      return { display: formatted, isNull: false, isTruncated: false, fullValue: value as string };
    }
    return { display: String(value), isNull: false, isTruncated: false, fullValue: String(value) };
  }

  // Handle numbers
  if (type.includes('int') || type.includes('numeric') || type.includes('decimal') || type.includes('float') || type.includes('double')) {
    const numValue = typeof value === 'number' ? value : parseFloat(String(value));
    if (!isNaN(numValue)) {
      // Format with locale for readability
      stringValue = numValue.toLocaleString(undefined, {
        maximumFractionDigits: type.includes('int') ? 0 : 4,
      });
      return { display: stringValue, isNull: false, isTruncated: false, fullValue: String(value) };
    }
  }

  // Handle booleans
  if (type.includes('bool')) {
    return {
      display: value ? 'true' : 'false',
      isNull: false,
      isTruncated: false,
      fullValue: String(value),
    };
  }

  // Default string handling
  stringValue = String(value);
  const maxLength = 100;
  if (stringValue.length > maxLength) {
    isTruncated = true;
    return {
      display: stringValue.substring(0, maxLength) + '...',
      isNull: false,
      isTruncated,
      fullValue: stringValue,
    };
  }

  return { display: stringValue, isNull: false, isTruncated: false, fullValue: stringValue };
};

// ============================================================================
// Memoized Sub-Components
// ============================================================================

/**
 * Column Header Component
 */
interface ColumnHeaderProps {
  column: ColumnInfo;
  sortColumn: string | undefined;
  sortDirection: SortDirection;
  onSort: (columnName: string) => void;
}

const ColumnHeader = memo<ColumnHeaderProps>(
  ({ column, sortColumn, sortDirection, onSort }) => {
    const isActive = sortColumn === column.columnName;

    return (
      <th
        className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 select-none transition-colors sticky top-0 bg-gray-50 z-10"
        onClick={() => onSort(column.columnName)}
        role="columnheader"
        aria-sort={isActive ? (sortDirection === 'ASC' ? 'ascending' : 'descending') : 'none'}
      >
        <div className="flex items-center gap-2">
          <span className="truncate max-w-[150px]" title={column.columnName}>
            {column.columnName}
          </span>

          {/* PK/FK Icons */}
          <div className="flex items-center gap-1 flex-shrink-0">
            {column.isPrimaryKey && (
              <span title="Primary Key" className="text-yellow-500">
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M18 8a6 6 0 01-7.743 5.743L10 14l-1 1-1 1H6v2H2v-4l4.257-4.257A6 6 0 1118 8zm-6-4a1 1 0 100 2 2 2 0 012 2 1 1 0 102 0 4 4 0 00-4-4z"
                    clipRule="evenodd"
                  />
                </svg>
              </span>
            )}
            {column.isForeignKey && (
              <span
                title={`Foreign Key: ${column.foreignKeyTable}.${column.foreignKeyColumn}`}
                className="text-blue-500"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                  />
                </svg>
              </span>
            )}
          </div>

          {/* Data Type Badge */}
          <Badge
            variant={getDataTypeBadgeColor(column.dataType)}
            className="text-[10px] px-1 py-0 flex-shrink-0"
          >
            {column.dataType.split('(')[0]}
          </Badge>

          {/* Sort Indicator */}
          <span className="flex-shrink-0">
            {isActive ? (
              <svg
                className={`w-4 h-4 transition-transform ${sortDirection === 'DESC' ? 'rotate-180' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
                />
              </svg>
            )}
          </span>
        </div>
      </th>
    );
  }
);

ColumnHeader.displayName = 'ColumnHeader';

/**
 * Cell Component with proper formatting
 */
interface CellProps {
  value: unknown;
  dataType: string;
}

const Cell = memo<CellProps>(({ value, dataType }) => {
  const formatted = formatCellValue(value, dataType);

  if (formatted.isNull) {
    return (
      <td className="px-4 py-2 text-sm">
        <span className="text-gray-400 italic">NULL</span>
      </td>
    );
  }

  const isJson = dataType.toLowerCase().includes('json');

  return (
    <td
      className="px-4 py-2 text-sm text-gray-900 max-w-xs"
      title={formatted.isTruncated ? formatted.fullValue : undefined}
    >
      {isJson ? (
        <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded font-mono">
          {formatted.display}
        </code>
      ) : (
        <span className={formatted.isTruncated ? 'truncate block' : ''}>
          {formatted.display}
        </span>
      )}
    </td>
  );
});

Cell.displayName = 'Cell';

/**
 * Row Actions Component
 */
interface RowActionsProps {
  row: Record<string, unknown>;
  onSelect?: (row: Record<string, unknown>) => void;
  onEdit?: (row: Record<string, unknown>) => void;
  onDelete?: (row: Record<string, unknown>) => void;
}

const RowActions = memo<RowActionsProps>(({ row, onSelect, onEdit, onDelete }) => {
  return (
    <td className="px-4 py-2 text-right whitespace-nowrap sticky right-0 bg-white">
      <div className="flex items-center justify-end gap-1">
        {/* View Details Button */}
        {onSelect && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onSelect(row)}
            title="View Details"
            aria-label="View details"
          >
            <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
              />
            </svg>
          </Button>
        )}

        {/* Edit Button */}
        {onEdit && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onEdit(row)}
            title="Edit Row"
            aria-label="Edit row"
          >
            <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
          </Button>
        )}

        {/* Delete Button */}
        {onDelete && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDelete(row)}
            title="Delete Row"
            aria-label="Delete row"
          >
            <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
          </Button>
        )}
      </div>
    </td>
  );
});

RowActions.displayName = 'RowActions';

/**
 * Table Row Component
 */
interface TableRowProps {
  row: Record<string, unknown>;
  columns: ColumnInfo[];
  rowKey: string | number;
  onSelect?: (row: Record<string, unknown>) => void;
  onEdit?: (row: Record<string, unknown>) => void;
  onDelete?: (row: Record<string, unknown>) => void;
  hasActions: boolean;
}

const TableRow = memo<TableRowProps>(
  ({ row, columns, rowKey, onSelect, onEdit, onDelete, hasActions }) => {
    return (
      <tr key={rowKey} className="hover:bg-gray-50 transition-colors">
        {columns.map((col, colIdx) => (
          <Cell key={`${rowKey}-${colIdx}`} value={row[col.columnName]} dataType={col.dataType} />
        ))}
        {hasActions && (
          <RowActions row={row} onSelect={onSelect} onEdit={onEdit} onDelete={onDelete} />
        )}
      </tr>
    );
  }
);

TableRow.displayName = 'TableRow';

/**
 * Pagination Component
 */
interface PaginationProps {
  page: number;
  totalPages: number;
  totalRows: number;
  limit: number;
  onPageChange: (page: number) => void;
  onLimitChange: (limit: number) => void;
}

const Pagination = memo<PaginationProps>(
  ({ page, totalPages, totalRows, limit, onPageChange, onLimitChange }) => {
    const startRow = (page - 1) * limit + 1;
    const endRow = Math.min(page * limit, totalRows);

    const pageSizes = [10, 25, 50, 100];

    // Generate page numbers to display
    const getPageNumbers = () => {
      const pages: (number | 'ellipsis')[] = [];
      const maxVisible = 5;

      if (totalPages <= maxVisible) {
        for (let i = 1; i <= totalPages; i++) {
          pages.push(i);
        }
      } else {
        pages.push(1);

        if (page > 3) {
          pages.push('ellipsis');
        }

        const start = Math.max(2, page - 1);
        const end = Math.min(totalPages - 1, page + 1);

        for (let i = start; i <= end; i++) {
          pages.push(i);
        }

        if (page < totalPages - 2) {
          pages.push('ellipsis');
        }

        pages.push(totalPages);
      }

      return pages;
    };

    return (
      <div className="px-4 py-3 border-t bg-white flex flex-col sm:flex-row items-center justify-between gap-4">
        {/* Row count display */}
        <div className="text-sm text-gray-500">
          Showing <span className="font-medium">{startRow.toLocaleString()}</span> to{' '}
          <span className="font-medium">{endRow.toLocaleString()}</span> of{' '}
          <span className="font-medium">{totalRows.toLocaleString()}</span> rows
        </div>

        <div className="flex items-center gap-4">
          {/* Page size selector */}
          <div className="flex items-center gap-2">
            <label htmlFor="page-size" className="text-sm text-gray-500">
              Rows per page:
            </label>
            <select
              id="page-size"
              className="px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={limit}
              onChange={(e) => onLimitChange(Number(e.target.value))}
            >
              {pageSizes.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>

          {/* Page navigation */}
          <div className="flex items-center gap-1">
            {/* First page */}
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1}
              onClick={() => onPageChange(1)}
              title="First page"
              aria-label="Go to first page"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
                />
              </svg>
            </Button>

            {/* Previous page */}
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1}
              onClick={() => onPageChange(page - 1)}
              title="Previous page"
              aria-label="Go to previous page"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </Button>

            {/* Page numbers */}
            <div className="hidden sm:flex items-center gap-1">
              {getPageNumbers().map((pageNum, idx) =>
                pageNum === 'ellipsis' ? (
                  <span key={`ellipsis-${idx}`} className="px-2 text-gray-400">
                    ...
                  </span>
                ) : (
                  <Button
                    key={pageNum}
                    variant={page === pageNum ? 'primary' : 'outline'}
                    size="sm"
                    onClick={() => onPageChange(pageNum)}
                    aria-label={`Go to page ${pageNum}`}
                    aria-current={page === pageNum ? 'page' : undefined}
                  >
                    {pageNum}
                  </Button>
                )
              )}
            </div>

            {/* Mobile page indicator */}
            <span className="sm:hidden text-sm text-gray-500 px-2">
              {page} / {totalPages}
            </span>

            {/* Next page */}
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => onPageChange(page + 1)}
              title="Next page"
              aria-label="Go to next page"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Button>

            {/* Last page */}
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => onPageChange(totalPages)}
              title="Last page"
              aria-label="Go to last page"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 5l7 7-7 7M5 5l7 7-7 7"
                />
              </svg>
            </Button>
          </div>
        </div>
      </div>
    );
  }
);

Pagination.displayName = 'Pagination';

// ============================================================================
// Main Component
// ============================================================================

export const DataGrid: React.FC<DataGridProps> = ({
  schema,
  table,
  onRowSelect,
  onRowEdit,
  onRowDelete,
  onRefresh,
}) => {
  // State
  const [tableData, setTableData] = useState<TableData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pagination state
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);

  // Sorting state
  const [sortColumn, setSortColumn] = useState<string | undefined>();
  const [sortDirection, setSortDirection] = useState<SortDirection>('ASC');

  // Determine if we have any actions
  const hasActions = Boolean(onRowSelect || onRowEdit || onRowDelete);

  // Load table data
  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await fetchTableData(schema, table, page, limit, sortColumn, sortDirection);
      setTableData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [schema, table, page, limit, sortColumn, sortDirection]);

  // Load data when dependencies change
  useEffect(() => {
    loadData();
  }, [loadData]);

  // Reset pagination when table changes
  useEffect(() => {
    setPage(1);
    setSortColumn(undefined);
    setSortDirection('ASC');
  }, [schema, table]);

  // Handle sort
  const handleSort = useCallback((columnName: string) => {
    setSortColumn((currentColumn) => {
      if (currentColumn === columnName) {
        setSortDirection((currentDirection) => (currentDirection === 'ASC' ? 'DESC' : 'ASC'));
        return currentColumn;
      }
      setSortDirection('ASC');
      return columnName;
    });
    setPage(1);
  }, []);

  // Handle page change
  const handlePageChange = useCallback((newPage: number) => {
    setPage(newPage);
  }, []);

  // Handle limit change
  const handleLimitChange = useCallback((newLimit: number) => {
    setLimit(newLimit);
    setPage(1);
  }, []);

  // Handle refresh
  const handleRefresh = useCallback(() => {
    loadData();
    onRefresh?.();
  }, [loadData, onRefresh]);

  // Get row key
  const getRowKey = useCallback(
    (row: Record<string, unknown>, index: number): string | number => {
      if (!tableData) return index;
      const pkColumn = tableData.columns.find((c) => c.isPrimaryKey);
      if (pkColumn && row[pkColumn.columnName] !== null && row[pkColumn.columnName] !== undefined) {
        return String(row[pkColumn.columnName]);
      }
      return index;
    },
    [tableData]
  );

  // Memoized rows
  const rows = useMemo(() => {
    if (!tableData) return [];
    return tableData.rows;
  }, [tableData]);

  // Loading state
  if (loading && !tableData) {
    return (
      <div className="flex items-center justify-center h-64 bg-white rounded-lg border">
        <Spinner size="lg" />
      </div>
    );
  }

  // Error state
  if (error && !tableData) {
    return (
      <div className="flex flex-col items-center justify-center h-64 bg-white rounded-lg border">
        <div className="text-red-500 mb-4">
          <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <p className="text-gray-600 mb-4">{error}</p>
        <Button variant="outline" onClick={loadData}>
          Try Again
        </Button>
      </div>
    );
  }

  // Empty state
  if (!tableData || rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 bg-white rounded-lg border">
        <div className="text-gray-400 mb-4">
          <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
            />
          </svg>
        </div>
        <p className="text-gray-500">No data available</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border overflow-hidden flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-gray-900">{table}</span>
          <Badge variant="default">{schema}</Badge>
          <span className="text-sm text-gray-500">
            ({tableData.totalRows.toLocaleString()} rows)
          </span>
        </div>
        <div className="flex items-center gap-2">
          {loading && <Spinner size="sm" />}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={loading}
            title="Refresh"
            aria-label="Refresh data"
          >
            <svg
              className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </Button>
        </div>
      </div>

      {/* Table Container with horizontal scroll */}
      <div className="overflow-x-auto flex-grow" style={{ maxHeight: 'calc(100vh - 350px)' }}>
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {tableData.columns.map((col) => (
                <ColumnHeader
                  key={col.columnName}
                  column={col}
                  sortColumn={sortColumn}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                />
              ))}
              {hasActions && (
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider sticky right-0 bg-gray-50 z-10">
                  Actions
                </th>
              )}
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {rows.map((row, idx) => (
              <TableRow
                key={getRowKey(row, idx)}
                row={row}
                columns={tableData.columns}
                rowKey={getRowKey(row, idx)}
                onSelect={onRowSelect}
                onEdit={onRowEdit}
                onDelete={onRowDelete}
                hasActions={hasActions}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {tableData.totalPages > 0 && (
        <Pagination
          page={page}
          totalPages={tableData.totalPages}
          totalRows={tableData.totalRows}
          limit={limit}
          onPageChange={handlePageChange}
          onLimitChange={handleLimitChange}
        />
      )}
    </div>
  );
};

export default DataGrid;
