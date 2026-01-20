import React, { useMemo } from 'react';
import { X, Loader2, AlertCircle, ChevronLeft, ChevronRight, Database } from 'lucide-react';
import { TableDataResult } from '../services/tenant-api.service';

interface TableDataModalProps {
  isOpen: boolean;
  onClose: () => void;
  tableName: string;
  data: TableDataResult | null;
  loading?: boolean;
  error?: string | null;
  onPageChange: (offset: number) => void;
  pageSize: number;
}

/**
 * Format cell value for display
 */
const formatCellValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '-';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  const str = String(value);
  // Truncate long values
  if (str.length > 100) {
    return str.substring(0, 100) + '...';
  }
  return str;
};

/**
 * TableDataModal Component
 *
 * Displays table data with pagination in a modal dialog.
 * Data is tenant-isolated on the backend.
 */
export const TableDataModal: React.FC<TableDataModalProps> = ({
  isOpen,
  onClose,
  tableName,
  data,
  loading,
  error,
  onPageChange,
  pageSize,
}) => {
  if (!isOpen) return null;

  // Parse schema and table name from "schema.table" format
  const parts = tableName.split('.');
  const schemaName = parts.length > 1 ? parts[0] : 'public';
  const tableOnly = parts.length > 1 ? parts[1] : parts[0];

  // Parse rows from JSON string
  const rows = useMemo(() => {
    if (!data?.rows) return [];
    try {
      return JSON.parse(data.rows) as Record<string, unknown>[];
    } catch {
      return [];
    }
  }, [data?.rows]);

  // Calculate pagination info
  const currentPage = data ? Math.floor(data.offset / pageSize) + 1 : 1;
  const totalPages = data ? Math.ceil(data.totalRows / pageSize) : 1;
  const hasNextPage = data ? data.offset + pageSize < data.totalRows : false;
  const hasPrevPage = data ? data.offset > 0 : false;

  const handlePrevPage = () => {
    if (data && hasPrevPage) {
      onPageChange(Math.max(0, data.offset - pageSize));
    }
  };

  const handleNextPage = () => {
    if (data && hasNextPage) {
      onPageChange(data.offset + pageSize);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-white rounded-2xl shadow-2xl max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-white">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-100">
              <Database className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900">Table Data</h2>
              <p className="text-sm text-gray-500 mt-0.5">
                <span className="text-blue-600 font-medium">{schemaName}</span>
                <span className="mx-1">.</span>
                <span className="font-semibold text-gray-700">{tableOnly}</span>
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            aria-label="Close modal"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {/* Loading State */}
          {loading && (
            <div className="flex flex-col items-center justify-center py-12 flex-1">
              <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
              <p className="mt-3 text-sm text-gray-500">Loading table data...</p>
            </div>
          )}

          {/* Error State */}
          {error && !loading && (
            <div className="flex flex-col items-center justify-center py-12 flex-1">
              <div className="p-3 rounded-full bg-red-100">
                <AlertCircle className="w-6 h-6 text-red-500" />
              </div>
              <p className="mt-3 text-sm font-medium text-gray-900">Failed to load data</p>
              <p className="mt-1 text-sm text-gray-500 text-center max-w-md">{error}</p>
            </div>
          )}

          {/* Data Table */}
          {!loading && !error && data && (
            <div className="flex-1 overflow-auto">
              <table className="w-full">
                <thead className="sticky top-0 bg-gray-50 z-10">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider bg-gray-50 border-b border-gray-200">
                      #
                    </th>
                    {data.columns.map((col) => (
                      <th
                        key={col}
                        className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider bg-gray-50 border-b border-gray-200 whitespace-nowrap"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={data.columns.length + 1}
                        className="px-4 py-12 text-center text-gray-500"
                      >
                        No data found in this table
                      </td>
                    </tr>
                  ) : (
                    rows.map((row, idx) => (
                      <tr
                        key={idx}
                        className={`hover:bg-blue-50/50 transition-colors ${
                          idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/30'
                        }`}
                      >
                        <td className="px-4 py-3 text-xs text-gray-400 font-mono">
                          {data.offset + idx + 1}
                        </td>
                        {data.columns.map((col) => (
                          <td
                            key={col}
                            className="px-4 py-3 text-sm text-gray-700 max-w-[300px] truncate"
                            title={String(row[col] ?? '')}
                          >
                            <span className="font-mono text-xs">
                              {formatCellValue(row[col])}
                            </span>
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer with Pagination */}
        <div className="px-6 py-4 border-t border-gray-100 bg-gray-50">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500">
              {!loading && !error && data && (
                <>
                  Showing{' '}
                  <span className="font-medium text-gray-700">
                    {data.totalRows === 0 ? 0 : data.offset + 1}
                  </span>
                  {' - '}
                  <span className="font-medium text-gray-700">
                    {Math.min(data.offset + rows.length, data.totalRows)}
                  </span>
                  {' of '}
                  <span className="font-medium text-gray-700">
                    {data.totalRows.toLocaleString()}
                  </span>
                  {' rows'}
                </>
              )}
            </p>
            <div className="flex items-center gap-2">
              {/* Pagination Controls */}
              {!loading && !error && data && data.totalRows > pageSize && (
                <>
                  <button
                    onClick={handlePrevPage}
                    disabled={!hasPrevPage}
                    className={`inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                      hasPrevPage
                        ? 'text-gray-700 bg-white border border-gray-200 hover:bg-gray-50'
                        : 'text-gray-400 bg-gray-100 cursor-not-allowed'
                    }`}
                  >
                    <ChevronLeft className="w-4 h-4" />
                    Previous
                  </button>
                  <span className="text-sm text-gray-500 px-2">
                    Page {currentPage} of {totalPages}
                  </span>
                  <button
                    onClick={handleNextPage}
                    disabled={!hasNextPage}
                    className={`inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                      hasNextPage
                        ? 'text-gray-700 bg-white border border-gray-200 hover:bg-gray-50'
                        : 'text-gray-400 bg-gray-100 cursor-not-allowed'
                    }`}
                  >
                    Next
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </>
              )}
              <button
                onClick={onClose}
                className="ml-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TableDataModal;
