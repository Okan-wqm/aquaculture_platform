import React, { useMemo } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, Database } from 'lucide-react';
import { TableDataResult } from '../services/tenant-api.service';
import { Modal, DataTable, type DataTableColumn, Spinner } from '@aquaculture/shared-ui';

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

  const tableDataColumns: DataTableColumn<Record<string, unknown>>[] = data
    ? [
        {
          key: '__row',
          header: '#',
          render: (_value, _row, index) => (
            <span className="font-mono text-xs text-gray-500">{data.offset + index + 1}</span>
          ),
        },
        ...data.columns.map(
          (col): DataTableColumn<Record<string, unknown>> => ({
            key: col,
            header: col,
            render: (value) => (
              <span
                className="block max-w-[300px] truncate font-mono text-xs"
                title={String(value ?? '')}
              >
                {formatCellValue(value)}
              </span>
            ),
          }),
        ),
      ]
    : [];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="xl"
      className="max-h-[90vh] overflow-hidden flex flex-col"
      bodyClassName="flex-1 min-h-0 overflow-hidden flex flex-col"
      title={
        <span className="flex items-center gap-3">
          <span className="p-2 rounded-lg bg-blue-100">
            <Database className="w-5 h-5 text-blue-600" />
          </span>
          <span>Table Data</span>
        </span>
      }
      description={
        <>
          <span className="text-blue-600 font-medium">{schemaName}</span>
          <span className="mx-1">.</span>
          <span className="font-semibold text-gray-700">{tableOnly}</span>
        </>
      }
      footer={
        <div className="flex w-full items-center justify-between">
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
                <span className="font-medium text-gray-700">{data.totalRows.toLocaleString()}</span>
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
                      : 'text-gray-500 bg-gray-100 cursor-not-allowed'
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
                      : 'text-gray-500 bg-gray-100 cursor-not-allowed'
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
      }
    >
      {/* Loading State */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-12 flex-1">
          <Spinner size="lg" />
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
          <DataTable<Record<string, unknown>>
            data={rows}
            columns={tableDataColumns}
            keyExtractor={(_row, index) => String(index)}
            emptyMessage="No data found in this table"
            searchable={false}
            sortable={false}
            compact
            className="border-0 rounded-none shadow-none"
          />
        </div>
      )}
    </Modal>
  );
};

export default TableDataModal;
