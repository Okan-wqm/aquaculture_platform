import React from 'react';
import { Key, Link2, Loader2, AlertCircle, Hash, Type } from 'lucide-react';
import { ColumnInfo, IndexInfo } from '../services/tenant-api.service';
import { Modal, DataTable, type DataTableColumn } from '@aquaculture/shared-ui';

interface TableSchemaModalProps {
  isOpen: boolean;
  onClose: () => void;
  tableName: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  loading?: boolean;
  error?: string | null;
}

/**
 * Format data type for display
 */
const formatDataType = (column: ColumnInfo): string => {
  return column.dataType;
};

/**
 * Get icon color class based on data type category
 */
const getTypeColor = (dataType: string): string => {
  const type = dataType.toLowerCase();
  if (type.includes('int') || type.includes('numeric') || type.includes('decimal') || type.includes('float') || type.includes('double')) {
    return 'text-blue-500';
  }
  if (type.includes('varchar') || type.includes('text') || type.includes('char')) {
    return 'text-green-500';
  }
  if (type.includes('timestamp') || type.includes('date') || type.includes('time')) {
    return 'text-purple-500';
  }
  if (type.includes('bool')) {
    return 'text-orange-500';
  }
  if (type.includes('json') || type.includes('array')) {
    return 'text-pink-500';
  }
  if (type.includes('uuid')) {
    return 'text-cyan-500';
  }
  return 'text-gray-500';
};

/**
 * TableSchemaModal Component
 *
 * Displays table schema information including columns, data types,
 * constraints, and indexes in a modal dialog.
 */
export const TableSchemaModal: React.FC<TableSchemaModalProps> = ({
  isOpen,
  onClose,
  tableName,
  columns,
  indexes,
  loading,
  error,
}) => {
  // Parse schema and table name from "schema.table" format
  const parts = tableName.split('.');
  const schemaName = parts.length > 1 ? parts[0] : 'public';
  const tableOnly = parts.length > 1 ? parts[1] : parts[0];

  const indexInfoColumns: DataTableColumn<IndexInfo>[] = [
    {
      key: 'indexName',
      header: 'Index Name',
      render: (_value, idx) => (
        <span className="font-mono text-sm text-gray-700">
          {idx.indexName}
        </span>
      ),
    },
    {
      key: 'column',
      header: 'Column',
      render: (_value, idx) => (
        <span className="font-mono text-sm text-gray-600">
          {idx.columnName}
        </span>
      ),
    },
    {
      key: 'unique',
      header: 'Unique',
      align: 'center',
      render: (_value, idx) => (
        <>
          {idx.isUnique ? (
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-100 text-green-700 text-xs font-medium">
              Y
            </span>
          ) : (
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-gray-500 text-xs font-medium">
              N
            </span>
          )}
        </>
      ),
    },
    {
      key: 'primary',
      header: 'Primary',
      align: 'center',
      render: (_value, idx) => (
        <>
          {idx.isPrimary ? (
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-yellow-100 text-yellow-700 text-xs font-medium">
              Y
            </span>
          ) : (
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-gray-500 text-xs font-medium">
              N
            </span>
          )}
        </>
      ),
    }
  ];

  const columnInfoColumns: DataTableColumn<ColumnInfo>[] = [
    {
      key: 'column',
      header: 'Column',
      render: (_value, col) => (
        <div className="flex items-center gap-2">
          <Hash className={`w-3.5 h-3.5 ${getTypeColor(col.dataType)}`} />
          <span className="font-mono text-sm font-medium text-gray-900">
            {col.columnName}
          </span>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      render: (_value, col) => (
        <code className={`text-xs px-2 py-1 rounded-md bg-gray-100 ${getTypeColor(col.dataType)}`}>
          {formatDataType(col)}
        </code>
      ),
    },
    {
      key: 'nullable',
      header: 'Nullable',
      align: 'center',
      render: (_value, col) => (
        <>
          <span
            className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium ${
              col.isNullable
                ? 'bg-yellow-100 text-yellow-700'
                : 'bg-gray-100 text-gray-500'
            }`}
          >
            {col.isNullable ? 'Y' : 'N'}
          </span>
        </>
      ),
    },
    {
      key: 'default',
      header: 'Default',
      render: (_value, col) => (
        <>
          {col.columnDefault ? (
            <code className="text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded max-w-[150px] truncate inline-block">
              {col.columnDefault.length > 30
                ? `${col.columnDefault.substring(0, 30)}...`
                : col.columnDefault}
            </code>
          ) : (
            <span className="text-xs text-gray-500">-</span>
          )}
        </>
      ),
    },
    {
      key: 'keys',
      header: 'Keys',
      align: 'center',
      render: (_value, col) => (
        <div className="flex items-center justify-center gap-1">
          {col.isPrimaryKey && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700 text-xs font-medium"
              title="Primary Key"
            >
              <Key className="w-3 h-3" />
              PK
            </span>
          )}
          {col.isForeignKey && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium"
              title={`Foreign Key → ${col.foreignKeyTable}.${col.foreignKeyColumn}`}
            >
              <Link2 className="w-3 h-3" />
              FK
            </span>
          )}
          {!col.isPrimaryKey && !col.isForeignKey && (
            <span className="text-xs text-gray-500">-</span>
          )}
        </div>
      ),
    }
  ];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="xl"
      className="max-h-[85vh] overflow-hidden flex flex-col"
      bodyClassName="flex-1 min-h-0 overflow-y-auto p-6"
      title="Table Schema"
      description={
        <>
          <span className="text-tenant-600 font-medium">{schemaName}</span>
          <span className="mx-1">.</span>
          <span className="font-semibold text-gray-700">{tableOnly}</span>
        </>
      }
      footer={
        <div className="flex w-full items-center justify-between">
          <p className="text-xs text-gray-500">
            {!loading && !error && columns.length > 0 && (
              <>
                {columns.length} column{columns.length !== 1 ? 's' : ''}
                {indexes && indexes.length > 0 && (
                  <>, {indexes.length} index{indexes.length !== 1 ? 'es' : ''}</>
                )}
              </>
            )}
          </p>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Close
          </button>
        </div>
      }
    >
      {/* Loading State */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-tenant-600" />
          <p className="mt-3 text-sm text-gray-500">Loading schema information...</p>
        </div>
      )}

      {/* Error State */}
      {error && !loading && (
        <div className="flex flex-col items-center justify-center py-12">
          <div className="p-3 rounded-full bg-red-100">
            <AlertCircle className="w-6 h-6 text-red-500" />
          </div>
          <p className="mt-3 text-sm font-medium text-gray-900">Failed to load schema</p>
          <p className="mt-1 text-sm text-gray-500 text-center max-w-md">{error}</p>
        </div>
      )}

      {/* Schema Data */}
      {!loading && !error && (
        <div className="space-y-6">
          {/* Columns Section */}
          <div>
            <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider mb-3 flex items-center gap-2">
              <Type className="w-4 h-4 text-gray-500" />
              Columns ({columns.length})
            </h3>
            <div className="bg-gray-50 rounded-xl overflow-hidden border border-gray-100">
              <DataTable<ColumnInfo>
                data={columns}
                columns={columnInfoColumns}
                keyExtractor={(col) => col.columnName}
                emptyMessage="No columns"
                searchable={false}
                sortable={false}
                stickyHeader={false}
                className="shadow-none rounded-none"
              />
            </div>
          </div>

          {/* Indexes Section */}
          {indexes && indexes.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider mb-3 flex items-center gap-2">
                <Key className="w-4 h-4 text-gray-500" />
                Indexes ({indexes.length})
              </h3>
              <div className="bg-gray-50 rounded-xl overflow-hidden border border-gray-100">
                <DataTable<IndexInfo>
                  data={indexes}
                  columns={indexInfoColumns}
                  keyExtractor={(idx) => `${idx.indexName}-${idx.columnName}`}
                  emptyMessage="No indexes"
                  searchable={false}
                  sortable={false}
                  stickyHeader={false}
                  className="shadow-none rounded-none"
                />
              </div>
            </div>
          )}

          {/* Foreign Key References */}
          {columns.some(col => col.isForeignKey) && (
            <div>
              <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider mb-3 flex items-center gap-2">
                <Link2 className="w-4 h-4 text-gray-500" />
                Foreign Key References
              </h3>
              <div className="grid gap-2">
                {columns
                  .filter(col => col.isForeignKey)
                  .map(col => (
                    <div
                      key={col.columnName}
                      className="flex items-center gap-3 p-3 bg-blue-50 rounded-lg border border-blue-100"
                    >
                      <Link2 className="w-4 h-4 text-blue-500 flex-shrink-0" />
                      <span className="font-mono text-sm text-gray-700">
                        <span className="font-semibold">{col.columnName}</span>
                        <span className="text-gray-500 mx-2">→</span>
                        <span className="text-blue-600">
                          {col.foreignKeyTable}.{col.foreignKeyColumn}
                        </span>
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};

export default TableSchemaModal;
