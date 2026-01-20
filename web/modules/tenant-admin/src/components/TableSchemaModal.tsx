import React from 'react';
import { X, Key, Link2, Loader2, AlertCircle, Hash, Type } from 'lucide-react';
import { ColumnInfo, IndexInfo } from '../services/tenant-api.service';

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
  if (!isOpen) return null;

  // Parse schema and table name from "schema.table" format
  const parts = tableName.split('.');
  const schemaName = parts.length > 1 ? parts[0] : 'public';
  const tableOnly = parts.length > 1 ? parts[1] : parts[0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-white rounded-2xl shadow-2xl max-w-4xl w-full max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-gradient-to-r from-tenant-50 to-white">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Table Schema</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              <span className="text-tenant-600 font-medium">{schemaName}</span>
              <span className="mx-1">.</span>
              <span className="font-semibold text-gray-700">{tableOnly}</span>
            </p>
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
        <div className="flex-1 overflow-y-auto p-6">
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
                  <Type className="w-4 h-4 text-gray-400" />
                  Columns ({columns.length})
                </h3>
                <div className="bg-gray-50 rounded-xl overflow-hidden border border-gray-100">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-gray-100/50">
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                          Column
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                          Type
                        </th>
                        <th className="px-4 py-3 text-center text-xs font-semibold text-gray-600 uppercase tracking-wider">
                          Nullable
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                          Default
                        </th>
                        <th className="px-4 py-3 text-center text-xs font-semibold text-gray-600 uppercase tracking-wider">
                          Keys
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {columns.map((col, index) => (
                        <tr
                          key={col.columnName}
                          className={`hover:bg-white transition-colors ${index % 2 === 0 ? 'bg-white/50' : ''}`}
                        >
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <Hash className={`w-3.5 h-3.5 ${getTypeColor(col.dataType)}`} />
                              <span className="font-mono text-sm font-medium text-gray-900">
                                {col.columnName}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <code className={`text-xs px-2 py-1 rounded-md bg-gray-100 ${getTypeColor(col.dataType)}`}>
                              {formatDataType(col)}
                            </code>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span
                              className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium ${
                                col.isNullable
                                  ? 'bg-yellow-100 text-yellow-700'
                                  : 'bg-gray-100 text-gray-500'
                              }`}
                            >
                              {col.isNullable ? 'Y' : 'N'}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            {col.columnDefault ? (
                              <code className="text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded max-w-[150px] truncate inline-block">
                                {col.columnDefault.length > 30
                                  ? `${col.columnDefault.substring(0, 30)}...`
                                  : col.columnDefault}
                              </code>
                            ) : (
                              <span className="text-xs text-gray-400">-</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
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
                                <span className="text-xs text-gray-400">-</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Indexes Section */}
              {indexes && indexes.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider mb-3 flex items-center gap-2">
                    <Key className="w-4 h-4 text-gray-400" />
                    Indexes ({indexes.length})
                  </h3>
                  <div className="bg-gray-50 rounded-xl overflow-hidden border border-gray-100">
                    <table className="w-full">
                      <thead>
                        <tr className="bg-gray-100/50">
                          <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                            Index Name
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                            Column
                          </th>
                          <th className="px-4 py-3 text-center text-xs font-semibold text-gray-600 uppercase tracking-wider">
                            Unique
                          </th>
                          <th className="px-4 py-3 text-center text-xs font-semibold text-gray-600 uppercase tracking-wider">
                            Primary
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {indexes.map((idx, index) => (
                          <tr
                            key={`${idx.indexName}-${idx.columnName}`}
                            className={`hover:bg-white transition-colors ${index % 2 === 0 ? 'bg-white/50' : ''}`}
                          >
                            <td className="px-4 py-3">
                              <span className="font-mono text-sm text-gray-700">
                                {idx.indexName}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <span className="font-mono text-sm text-gray-600">
                                {idx.columnName}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-center">
                              {idx.isUnique ? (
                                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-100 text-green-700 text-xs font-medium">
                                  Y
                                </span>
                              ) : (
                                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-gray-500 text-xs font-medium">
                                  N
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-center">
                              {idx.isPrimary ? (
                                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-yellow-100 text-yellow-700 text-xs font-medium">
                                  Y
                                </span>
                              ) : (
                                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-gray-500 text-xs font-medium">
                                  N
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Foreign Key References */}
              {columns.some(col => col.isForeignKey) && (
                <div>
                  <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider mb-3 flex items-center gap-2">
                    <Link2 className="w-4 h-4 text-gray-400" />
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
                            <span className="text-gray-400 mx-2">→</span>
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
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 bg-gray-50">
          <div className="flex items-center justify-between">
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
        </div>
      </div>
    </div>
  );
};

export default TableSchemaModal;
