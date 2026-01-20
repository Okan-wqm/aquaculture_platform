/**
 * Table Bileşeni
 * Veri tabloları için yeniden kullanılabilir bileşen
 * Sıralama, sayfalama, seçim ve özelleştirilebilir hücre render desteği
 */

import React, { useCallback, useMemo } from 'react';
import type { TableColumn } from '../../types';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

export interface TableProps<T extends object = Record<string, unknown>> {
  /** Tablo kolonları */
  columns: TableColumn<T>[];
  /** Tablo verileri */
  data: T[];
  /** Satır anahtarı alanı (rowKey ile aynı) */
  keyExtractor?: (row: T) => string;
  /** Satır anahtarı alanı */
  rowKey?: keyof T | ((row: T) => string);
  /** Yükleniyor durumu */
  isLoading?: boolean;
  /** Boş durum mesajı */
  emptyMessage?: string;
  /** Satır seçimi etkin mi */
  selectable?: boolean;
  /** Seçili satırlar */
  selectedRows?: string[];
  /** Satır seçimi değiştiğinde */
  onSelectionChange?: (selectedKeys: string[]) => void;
  /** Satır tıklaması */
  onRowClick?: (row: T) => void;
  /** Sayfalama bilgileri */
  pagination?: {
    current: number;
    pageSize: number;
    total: number;
    onChange: (page: number, pageSize: number) => void;
  };
  /** Sıralama bilgileri */
  sorting?: {
    field: string;
    order: 'asc' | 'desc';
    onChange: (field: string, order: 'asc' | 'desc') => void;
  };
  /** Çizgili görünüm */
  striped?: boolean;
  /** Sıkışık görünüm */
  compact?: boolean;
  /** Ek CSS sınıfları */
  className?: string;
}

// ============================================================================
// Yardımcı Fonksiyonlar
// ============================================================================

/**
 * Satırın benzersiz anahtarını döndürür
 */
function getRowKey<T extends object>(
  row: T,
  rowKey: keyof T | ((row: T) => string) | string,
  index: number
): string {
  if (typeof rowKey === 'function') {
    return rowKey(row);
  }
  if (typeof rowKey === 'string') {
    return String((row as Record<string, unknown>)[rowKey] ?? index);
  }
  return String((row as Record<string, unknown>)[String(rowKey)] ?? index);
}

// ============================================================================
// Loading Skeleton
// ============================================================================

const TableSkeleton: React.FC<{ columns: number; rows?: number }> = ({
  columns,
  rows = 5,
}) => (
  <tbody className="animate-pulse">
    {Array.from({ length: rows }).map((_, rowIndex) => (
      <tr key={rowIndex}>
        {Array.from({ length: columns }).map((_, colIndex) => (
          <td key={colIndex} className="px-4 py-3">
            <div className="h-4 bg-gray-200 rounded w-3/4"></div>
          </td>
        ))}
      </tr>
    ))}
  </tbody>
);

// ============================================================================
// Empty State
// ============================================================================

const EmptyState: React.FC<{ columns: number; message: string }> = ({
  columns,
  message,
}) => (
  <tbody>
    <tr>
      <td colSpan={columns} className="px-4 py-12 text-center">
        <div className="flex flex-col items-center">
          <svg
            className="w-12 h-12 text-gray-300 mb-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
            />
          </svg>
          <p className="text-gray-500">{message}</p>
        </div>
      </td>
    </tr>
  </tbody>
);

// ============================================================================
// Sort Indicator
// ============================================================================

const SortIndicator: React.FC<{ active: boolean; direction?: 'asc' | 'desc' }> = ({
  active,
  direction,
}) => (
  <span className="ml-2 inline-flex">
    <svg
      className={`w-4 h-4 transition-colors ${
        active ? 'text-blue-600' : 'text-gray-400'
      }`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      {direction === 'asc' ? (
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
      ) : direction === 'desc' ? (
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      ) : (
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
      )}
    </svg>
  </span>
);

// ============================================================================
// Pagination Bileşeni
// ============================================================================

interface PaginationProps {
  current: number;
  pageSize: number;
  total: number;
  onChange: (page: number, pageSize: number) => void;
}

const Pagination: React.FC<PaginationProps> = ({
  current,
  pageSize,
  total,
  onChange,
}) => {
  const totalPages = Math.ceil(total / pageSize);
  const startItem = (current - 1) * pageSize + 1;
  const endItem = Math.min(current * pageSize, total);

  const pages = useMemo(() => {
    const result: (number | 'ellipsis')[] = [];
    const maxVisible = 5;

    if (totalPages <= maxVisible) {
      for (let i = 1; i <= totalPages; i++) result.push(i);
    } else {
      result.push(1);
      if (current > 3) result.push('ellipsis');
      for (let i = Math.max(2, current - 1); i <= Math.min(totalPages - 1, current + 1); i++) {
        result.push(i);
      }
      if (current < totalPages - 2) result.push('ellipsis');
      if (totalPages > 1) result.push(totalPages);
    }
    return result;
  }, [current, totalPages]);

  return (
    <div className="flex items-center justify-between px-4 py-3 bg-white border-t border-gray-200">
      <div className="text-sm text-gray-700">
        <span className="font-medium">{startItem}</span>
        {' - '}
        <span className="font-medium">{endItem}</span>
        {' / '}
        <span className="font-medium">{total}</span>
        {' kayıt'}
      </div>
      <nav className="flex items-center space-x-1">
        <button
          onClick={() => onChange(current - 1, pageSize)}
          disabled={current === 1}
          className="px-3 py-1 rounded border border-gray-300 text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
        >
          Önceki
        </button>
        {pages.map((page, index) =>
          page === 'ellipsis' ? (
            <span key={`ellipsis-${index}`} className="px-2 text-gray-500">
              ...
            </span>
          ) : (
            <button
              key={page}
              onClick={() => onChange(page, pageSize)}
              className={`px-3 py-1 rounded text-sm ${
                current === page
                  ? 'bg-blue-600 text-white'
                  : 'border border-gray-300 hover:bg-gray-50'
              }`}
            >
              {page}
            </button>
          )
        )}
        <button
          onClick={() => onChange(current + 1, pageSize)}
          disabled={current === totalPages}
          className="px-3 py-1 rounded border border-gray-300 text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
        >
          Sonraki
        </button>
      </nav>
    </div>
  );
};

// ============================================================================
// Table Bileşeni
// ============================================================================

/**
 * Table bileşeni
 *
 * @example
 * // Temel kullanım
 * <Table
 *   columns={[
 *     { key: 'name', label: 'İsim' },
 *     { key: 'status', label: 'Durum' },
 *   ]}
 *   data={farms}
 *   rowKey="id"
 * />
 *
 * @example
 * // Özelleştirilmiş hücre render
 * <Table
 *   columns={[
 *     { key: 'name', label: 'İsim' },
 *     {
 *       key: 'status',
 *       label: 'Durum',
 *       render: (value) => <Badge>{value}</Badge>,
 *     },
 *   ]}
 *   data={farms}
 *   rowKey="id"
 * />
 */
export function Table<T extends object = Record<string, unknown>>({
  columns,
  data,
  keyExtractor,
  rowKey,
  isLoading = false,
  emptyMessage = 'Gösterilecek veri bulunamadı',
  selectable = false,
  selectedRows = [],
  onSelectionChange,
  onRowClick,
  pagination,
  sorting,
  striped = false,
  compact = false,
  className = '',
}: TableProps<T>): React.ReactElement {
  // keyExtractor ve rowKey birleştirmesi - string olarak cast ediyoruz
  const resolvedRowKey: string | ((row: T) => string) = keyExtractor || (typeof rowKey === 'string' ? rowKey : 'id');
  // Tümünü seç durumu
  const allSelected = data.length > 0 && selectedRows.length === data.length;
  const someSelected = selectedRows.length > 0 && selectedRows.length < data.length;

  // Tümünü seç/kaldır
  const handleSelectAll = useCallback(() => {
    if (!onSelectionChange) return;

    if (allSelected) {
      onSelectionChange([]);
    } else {
      const allKeys = data.map((row, index) => getRowKey(row, resolvedRowKey, index));
      onSelectionChange(allKeys);
    }
  }, [allSelected, data, onSelectionChange, resolvedRowKey]);

  // Tek satır seçimi
  const handleSelectRow = useCallback(
    (key: string) => {
      if (!onSelectionChange) return;

      if (selectedRows.includes(key)) {
        onSelectionChange(selectedRows.filter((k) => k !== key));
      } else {
        onSelectionChange([...selectedRows, key]);
      }
    },
    [onSelectionChange, selectedRows]
  );

  // Sıralama değişimi
  const handleSort = useCallback(
    (field: string) => {
      if (!sorting?.onChange) return;

      const newOrder =
        sorting.field === field && sorting.order === 'asc' ? 'desc' : 'asc';
      sorting.onChange(field, newOrder);
    },
    [sorting]
  );

  // Kolon sayısı (seçim kolonu dahil)
  const totalColumns = columns.length + (selectable ? 1 : 0);

  // Hücre padding sınıfları
  const cellPadding = compact ? 'px-3 py-2' : 'px-4 py-3';

  return (
    <div className={`bg-white rounded-lg shadow overflow-hidden ${className}`}>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          {/* Tablo Başlığı */}
          <thead className="bg-gray-50">
            <tr>
              {/* Seçim kolonu */}
              {selectable && (
                <th className={`${cellPadding} w-12`}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(input) => {
                      if (input) input.indeterminate = someSelected;
                    }}
                    onChange={handleSelectAll}
                    className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                  />
                </th>
              )}

              {/* Veri kolonları */}
              {columns.map((column) => (
                <th
                  key={String(column.key)}
                  className={`
                    ${cellPadding}
                    text-left text-xs font-medium text-gray-500 uppercase tracking-wider
                    ${column.sortable ? 'cursor-pointer hover:bg-gray-100' : ''}
                  `}
                  style={{ width: column.width }}
                  onClick={() => column.sortable && handleSort(String(column.key))}
                >
                  <div className={`flex items-center ${column.align === 'center' ? 'justify-center' : column.align === 'right' ? 'justify-end' : ''}`}>
                    {column.header || column.label}
                    {column.sortable && (
                      <SortIndicator
                        active={sorting?.field === column.key}
                        direction={sorting?.field === column.key ? sorting.order : undefined}
                      />
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>

          {/* Tablo Gövdesi */}
          {isLoading ? (
            <TableSkeleton columns={totalColumns} />
          ) : data.length === 0 ? (
            <EmptyState columns={totalColumns} message={emptyMessage} />
          ) : (
            <tbody className="bg-white divide-y divide-gray-200">
              {data.map((row, rowIndex) => {
                const key = getRowKey(row, resolvedRowKey, rowIndex);
                const isSelected = selectedRows.includes(key);

                return (
                  <tr
                    key={key}
                    onClick={() => onRowClick?.(row)}
                    className={`
                      ${onRowClick ? 'cursor-pointer' : ''}
                      ${isSelected ? 'bg-blue-50' : ''}
                      ${striped && rowIndex % 2 === 1 ? 'bg-gray-50' : ''}
                      hover:bg-gray-50 transition-colors
                    `}
                  >
                    {/* Seçim checkbox */}
                    {selectable && (
                      <td className={cellPadding} onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleSelectRow(key)}
                          className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                        />
                      </td>
                    )}

                    {/* Veri hücreleri */}
                    {columns.map((column) => {
                      const value = (row as Record<string, unknown>)[column.key as string];
                      const content = column.render
                        ? column.render(row, rowIndex)
                        : String(value ?? '-');

                      return (
                        <td
                          key={String(column.key)}
                          className={`
                            ${cellPadding}
                            text-sm text-gray-900
                            ${column.align === 'center' ? 'text-center' : column.align === 'right' ? 'text-right' : ''}
                          `}
                        >
                          {content}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>
      </div>

      {/* Sayfalama */}
      {pagination && (
        <Pagination
          current={pagination.current}
          pageSize={pagination.pageSize}
          total={pagination.total}
          onChange={pagination.onChange}
        />
      )}
    </div>
  );
}

export default Table;
