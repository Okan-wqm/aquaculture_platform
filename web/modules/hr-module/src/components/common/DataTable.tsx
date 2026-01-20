/**
 * Generic Data Table Component
 * Reusable table with sorting, pagination, and selection
 */

import React, { useState, useMemo } from 'react';
import { cn } from '@shared-ui/utils';
import {
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';

export interface Column<T> {
  key: string;
  header: string;
  accessor: (row: T) => React.ReactNode;
  sortable?: boolean;
  width?: string;
  align?: 'left' | 'center' | 'right';
}

interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  keyExtractor: (row: T) => string;
  isLoading?: boolean;
  emptyMessage?: string;
  // Pagination
  total?: number;
  page?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  // Sorting
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  onSort?: (key: string) => void;
  // Selection
  selectable?: boolean;
  selectedKeys?: Set<string>;
  onSelectionChange?: (keys: Set<string>) => void;
  // Row actions
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string;
  className?: string;
}

export function DataTable<T>({
  data,
  columns,
  keyExtractor,
  isLoading = false,
  emptyMessage = 'No data available',
  total,
  page = 1,
  pageSize = 10,
  onPageChange,
  sortBy,
  sortOrder = 'asc',
  onSort,
  selectable = false,
  selectedKeys = new Set(),
  onSelectionChange,
  onRowClick,
  rowClassName,
  className,
}: DataTableProps<T>) {
  const totalPages = total ? Math.ceil(total / pageSize) : 1;
  const showPagination = total !== undefined && total > pageSize;

  const allSelected = useMemo(() => {
    if (data.length === 0) return false;
    return data.every((row) => selectedKeys.has(keyExtractor(row)));
  }, [data, selectedKeys, keyExtractor]);

  const someSelected = useMemo(() => {
    if (data.length === 0) return false;
    const selected = data.filter((row) => selectedKeys.has(keyExtractor(row)));
    return selected.length > 0 && selected.length < data.length;
  }, [data, selectedKeys, keyExtractor]);

  const handleSelectAll = () => {
    if (!onSelectionChange) return;

    if (allSelected) {
      const newKeys = new Set(selectedKeys);
      data.forEach((row) => newKeys.delete(keyExtractor(row)));
      onSelectionChange(newKeys);
    } else {
      const newKeys = new Set(selectedKeys);
      data.forEach((row) => newKeys.add(keyExtractor(row)));
      onSelectionChange(newKeys);
    }
  };

  const handleSelectRow = (row: T) => {
    if (!onSelectionChange) return;

    const key = keyExtractor(row);
    const newKeys = new Set(selectedKeys);

    if (newKeys.has(key)) {
      newKeys.delete(key);
    } else {
      newKeys.add(key);
    }

    onSelectionChange(newKeys);
  };

  const renderSortIcon = (columnKey: string) => {
    if (sortBy !== columnKey) return null;
    return sortOrder === 'asc' ? (
      <ChevronUp className="h-4 w-4" />
    ) : (
      <ChevronDown className="h-4 w-4" />
    );
  };

  return (
    <div className={cn('overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700', className)}>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              {selectable && (
                <th className="w-12 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected;
                    }}
                    onChange={handleSelectAll}
                    className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                </th>
              )}
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={cn(
                    'px-4 py-3 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400',
                    column.align === 'center' && 'text-center',
                    column.align === 'right' && 'text-right',
                    column.sortable && 'cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700'
                  )}
                  style={{ width: column.width }}
                  onClick={() => column.sortable && onSort?.(column.key)}
                >
                  <div className={cn(
                    'flex items-center gap-1',
                    column.align === 'center' && 'justify-center',
                    column.align === 'right' && 'justify-end'
                  )}>
                    {column.header}
                    {column.sortable && renderSortIcon(column.key)}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
            {isLoading ? (
              <tr>
                <td
                  colSpan={columns.length + (selectable ? 1 : 0)}
                  className="px-4 py-8 text-center text-gray-500"
                >
                  <div className="flex items-center justify-center gap-2">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-indigo-600" />
                    Loading...
                  </div>
                </td>
              </tr>
            ) : data.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + (selectable ? 1 : 0)}
                  className="px-4 py-8 text-center text-gray-500"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              data.map((row) => {
                const key = keyExtractor(row);
                const isSelected = selectedKeys.has(key);

                return (
                  <tr
                    key={key}
                    className={cn(
                      'transition-colors',
                      isSelected && 'bg-indigo-50 dark:bg-indigo-900/20',
                      onRowClick && 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800',
                      rowClassName?.(row)
                    )}
                    onClick={() => onRowClick?.(row)}
                  >
                    {selectable && (
                      <td className="w-12 px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleSelectRow(row)}
                          className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                        />
                      </td>
                    )}
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={cn(
                          'px-4 py-3 text-sm text-gray-900 dark:text-gray-100',
                          column.align === 'center' && 'text-center',
                          column.align === 'right' && 'text-right'
                        )}
                      >
                        {column.accessor(row)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {showPagination && (
        <div className="flex items-center justify-between border-t border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
          <div className="text-sm text-gray-500">
            Showing {(page - 1) * pageSize + 1} to {Math.min(page * pageSize, total)} of {total} results
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onPageChange?.(1)}
              disabled={page === 1}
              className="rounded p-1 hover:bg-gray-200 disabled:opacity-50 dark:hover:bg-gray-700"
            >
              <ChevronsLeft className="h-5 w-5" />
            </button>
            <button
              onClick={() => onPageChange?.(page - 1)}
              disabled={page === 1}
              className="rounded p-1 hover:bg-gray-200 disabled:opacity-50 dark:hover:bg-gray-700"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <span className="px-2 text-sm">
              Page {page} of {totalPages}
            </span>
            <button
              onClick={() => onPageChange?.(page + 1)}
              disabled={page === totalPages}
              className="rounded p-1 hover:bg-gray-200 disabled:opacity-50 dark:hover:bg-gray-700"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
            <button
              onClick={() => onPageChange?.(totalPages)}
              disabled={page === totalPages}
              className="rounded p-1 hover:bg-gray-200 disabled:opacity-50 dark:hover:bg-gray-700"
            >
              <ChevronsRight className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default DataTable;
