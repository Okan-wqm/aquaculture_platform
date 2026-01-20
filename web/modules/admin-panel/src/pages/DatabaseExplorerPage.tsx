/**
 * Database Explorer Page
 *
 * Veritabanı tablolarını görüntüleme, veri ekleme/güncelleme/silme.
 * SUPER_ADMIN için geliştirme ve debug amaçlı.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Card, Button, Input, Badge, Alert, Modal } from '@aquaculture/shared-ui';

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

interface TableInfo {
  tableName: string;
  schemaName: string;
  rowCount: number;
  sizeBytes: number;
  columns: ColumnInfo[];
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

// ============================================================================
// API Functions
// ============================================================================

const API_BASE = '/api/database/explorer';

const getAuthHeader = (): Record<string, string> => {
  const token = localStorage.getItem('access_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

async function fetchSchemas(): Promise<string[]> {
  const response = await fetch(`${API_BASE}/schemas`, {
    headers: { ...getAuthHeader() },
  });
  if (!response.ok) throw new Error('Failed to fetch schemas');
  return response.json();
}

async function fetchTables(schema: string): Promise<TableInfo[]> {
  const response = await fetch(`${API_BASE}/schemas/${schema}/tables`, {
    headers: { ...getAuthHeader() },
  });
  if (!response.ok) throw new Error('Failed to fetch tables');
  return response.json();
}

async function fetchTableData(
  schema: string,
  table: string,
  page = 1,
  limit = 50,
  orderBy?: string,
  orderDirection?: 'ASC' | 'DESC'
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

async function insertRow(
  schema: string,
  table: string,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_BASE}/schemas/${schema}/tables/${table}/rows`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeader(),
    },
    body: JSON.stringify({ data }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to insert row');
  }
  return response.json();
}

async function updateRow(
  schema: string,
  table: string,
  id: string,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${API_BASE}/schemas/${schema}/tables/${table}/rows/${id}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeader(),
      },
      body: JSON.stringify({ data }),
    }
  );
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to update row');
  }
  return response.json();
}

async function deleteRow(
  schema: string,
  table: string,
  id: string
): Promise<void> {
  const response = await fetch(
    `${API_BASE}/schemas/${schema}/tables/${table}/rows/${id}`,
    {
      method: 'DELETE',
      headers: { ...getAuthHeader() },
    }
  );
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to delete row');
  }
}

// ============================================================================
// Utilities
// ============================================================================

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

const formatValue = (value: unknown): string => {
  if (value === null) return 'NULL';
  if (value === undefined) return '';
  if (typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    return JSON.stringify(value);
  }
  return String(value);
};

const getDataTypeBadgeColor = (dataType: string): 'info' | 'success' | 'warning' | 'error' | 'default' => {
  if (dataType.includes('int') || dataType.includes('numeric') || dataType.includes('decimal')) return 'info';
  if (dataType.includes('varchar') || dataType.includes('text') || dataType.includes('char')) return 'success';
  if (dataType.includes('timestamp') || dataType.includes('date') || dataType.includes('time')) return 'warning';
  if (dataType.includes('bool')) return 'error';
  if (dataType.includes('json') || dataType.includes('uuid')) return 'default';
  return 'default';
};

// ============================================================================
// Components
// ============================================================================

interface RowEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  columns: ColumnInfo[];
  row?: Record<string, unknown>;
  onSave: (data: Record<string, unknown>) => Promise<void>;
  mode: 'create' | 'edit';
}

const RowEditorModal: React.FC<RowEditorModalProps> = ({
  isOpen,
  onClose,
  columns,
  row,
  onSave,
  mode,
}) => {
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      const initialData: Record<string, string> = {};
      columns.forEach((col) => {
        if (row && row[col.columnName] !== undefined) {
          initialData[col.columnName] = formatValue(row[col.columnName]);
        } else {
          initialData[col.columnName] = '';
        }
      });
      setFormData(initialData);
      setError(null);
    }
  }, [isOpen, columns, row]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    try {
      // Parse values based on data types
      const parsedData: Record<string, unknown> = {};
      columns.forEach((col) => {
        const value = formData[col.columnName];
        if (value === '' || value === 'NULL') {
          if (!col.isNullable && mode === 'create' && !col.columnDefault) {
            // Skip, will be handled by DB
          } else {
            parsedData[col.columnName] = null;
          }
        } else if (col.dataType.includes('int')) {
          parsedData[col.columnName] = parseInt(value, 10);
        } else if (col.dataType.includes('numeric') || col.dataType.includes('decimal') || col.dataType.includes('float') || col.dataType.includes('double')) {
          parsedData[col.columnName] = parseFloat(value);
        } else if (col.dataType.includes('bool')) {
          parsedData[col.columnName] = value.toLowerCase() === 'true' || value === '1';
        } else if (col.dataType.includes('json')) {
          try {
            parsedData[col.columnName] = JSON.parse(value);
          } catch {
            parsedData[col.columnName] = value;
          }
        } else {
          parsedData[col.columnName] = value;
        }
      });

      // Remove auto-generated columns for create
      if (mode === 'create') {
        columns.forEach((col) => {
          if (col.columnDefault?.includes('gen_random_uuid') || col.columnDefault?.includes('nextval')) {
            delete parsedData[col.columnName];
          }
        });
      }

      await onSave(parsedData);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={mode === 'create' ? 'Yeni Satır Ekle' : 'Satırı Düzenle'}
      size="lg"
    >
      {error && (
        <Alert type="error" className="mb-4">
          {error}
        </Alert>
      )}

      <div className="space-y-4 max-h-[60vh] overflow-y-auto">
        {columns.map((col) => (
          <div key={col.columnName}>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {col.columnName}
              {col.isPrimaryKey && (
                <Badge variant="info" className="ml-2">
                  PK
                </Badge>
              )}
              {col.isForeignKey && (
                <Badge variant="warning" className="ml-1">
                  FK
                </Badge>
              )}
              {!col.isNullable && !col.columnDefault && (
                <span className="text-red-500 ml-1">*</span>
              )}
            </label>
            <Input
              value={formData[col.columnName] || ''}
              onChange={(e) =>
                setFormData({ ...formData, [col.columnName]: e.target.value })
              }
              placeholder={col.columnDefault || col.dataType}
              disabled={
                mode === 'edit' &&
                col.isPrimaryKey &&
                col.columnDefault?.includes('gen_random_uuid')
              }
            />
            <div className="flex items-center gap-2 mt-1">
              <Badge variant={getDataTypeBadgeColor(col.dataType)}>
                {col.dataType}
              </Badge>
              {col.isNullable && (
                <span className="text-xs text-gray-500">nullable</span>
              )}
              {col.columnDefault && (
                <span className="text-xs text-gray-500">
                  default: {col.columnDefault.substring(0, 30)}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex justify-end gap-3 mt-6 pt-4 border-t">
        <Button variant="outline" onClick={onClose}>
          İptal
        </Button>
        <Button onClick={handleSave} loading={saving}>
          {mode === 'create' ? 'Ekle' : 'Kaydet'}
        </Button>
      </div>
    </Modal>
  );
};

// ============================================================================
// Main Component
// ============================================================================

const DatabaseExplorerPage: React.FC = () => {
  // State
  const [schemas, setSchemas] = useState<string[]>([]);
  const [selectedSchema, setSelectedSchema] = useState('public');
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableData, setTableData] = useState<TableData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pagination & Sorting
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [orderBy, setOrderBy] = useState<string | undefined>();
  const [orderDirection, setOrderDirection] = useState<'ASC' | 'DESC'>('ASC');

  // Modals
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<'create' | 'edit'>('create');
  const [editingRow, setEditingRow] = useState<Record<string, unknown> | undefined>();

  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState<{
    show: boolean;
    id: string;
  }>({ show: false, id: '' });

  // Load schemas
  useEffect(() => {
    fetchSchemas()
      .then(setSchemas)
      .catch((err) => setError(err.message));
  }, []);

  // Load tables when schema changes
  useEffect(() => {
    if (selectedSchema) {
      setLoading(true);
      fetchTables(selectedSchema)
        .then((data) => {
          setTables(data);
          setSelectedTable(null);
          setTableData(null);
        })
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
    }
  }, [selectedSchema]);

  // Load table data
  const loadTableData = useCallback(async () => {
    if (!selectedTable) return;

    setLoading(true);
    setError(null);

    try {
      const data = await fetchTableData(
        selectedSchema,
        selectedTable,
        page,
        limit,
        orderBy,
        orderDirection
      );
      setTableData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [selectedSchema, selectedTable, page, limit, orderBy, orderDirection]);

  useEffect(() => {
    if (selectedTable) {
      loadTableData();
    }
  }, [selectedTable, loadTableData]);

  // Handlers
  const handleTableSelect = (tableName: string) => {
    setSelectedTable(tableName);
    setPage(1);
    setOrderBy(undefined);
    setOrderDirection('ASC');
  };

  const handleSort = (column: string) => {
    if (orderBy === column) {
      setOrderDirection(orderDirection === 'ASC' ? 'DESC' : 'ASC');
    } else {
      setOrderBy(column);
      setOrderDirection('ASC');
    }
  };

  const handleCreateRow = () => {
    setEditorMode('create');
    setEditingRow(undefined);
    setIsEditorOpen(true);
  };

  const handleEditRow = (row: Record<string, unknown>) => {
    setEditorMode('edit');
    setEditingRow(row);
    setIsEditorOpen(true);
  };

  const handleSaveRow = async (data: Record<string, unknown>) => {
    if (!selectedTable || !tableData) return;

    if (editorMode === 'create') {
      await insertRow(selectedSchema, selectedTable, data);
    } else if (editingRow) {
      const pkColumn = tableData.columns.find((c) => c.isPrimaryKey);
      if (pkColumn) {
        const id = String(editingRow[pkColumn.columnName]);
        await updateRow(selectedSchema, selectedTable, id, data);
      }
    }

    loadTableData();
  };

  const handleDeleteRow = async () => {
    if (!selectedTable || !deleteConfirm.id) return;

    try {
      await deleteRow(selectedSchema, selectedTable, deleteConfirm.id);
      setDeleteConfirm({ show: false, id: '' });
      loadTableData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  const confirmDelete = (row: Record<string, unknown>) => {
    const pkColumn = tableData?.columns.find((c) => c.isPrimaryKey);
    if (pkColumn) {
      setDeleteConfirm({
        show: true,
        id: String(row[pkColumn.columnName]),
      });
    }
  };

  // Find selected table info
  const selectedTableInfo = tables.find((t) => t.tableName === selectedTable);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Database Explorer</h1>
          <p className="mt-1 text-sm text-gray-500">
            Veritabanı tablolarını görüntüle ve yönet
          </p>
        </div>
        <div className="mt-4 sm:mt-0 flex gap-2">
          <select
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            value={selectedSchema}
            onChange={(e) => setSelectedSchema(e.target.value)}
          >
            {schemas.map((schema) => (
              <option key={schema} value={schema}>
                {schema}
              </option>
            ))}
          </select>
          {selectedTable && (
            <Button onClick={handleCreateRow}>
              <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Yeni Satır
            </Button>
          )}
        </div>
      </div>

      {error && (
        <Alert type="error" dismissible onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Table List */}
        <Card className="p-4 lg:col-span-1">
          <h3 className="text-lg font-semibold mb-4">Tablolar ({tables.length})</h3>
          <div className="space-y-1 max-h-[calc(100vh-300px)] overflow-y-auto">
            {tables.map((table) => (
              <button
                key={table.tableName}
                onClick={() => handleTableSelect(table.tableName)}
                className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                  selectedTable === table.tableName
                    ? 'bg-blue-100 text-blue-700'
                    : 'hover:bg-gray-100'
                }`}
              >
                <div className="font-medium text-sm">{table.tableName}</div>
                <div className="flex justify-between text-xs text-gray-500">
                  <span>{table.rowCount.toLocaleString()} rows</span>
                  <span>{formatBytes(table.sizeBytes)}</span>
                </div>
              </button>
            ))}
          </div>
        </Card>

        {/* Table Data */}
        <Card className="lg:col-span-3 overflow-hidden">
          {!selectedTable ? (
            <div className="flex items-center justify-center h-64 text-gray-500">
              Bir tablo seçin
            </div>
          ) : loading && !tableData ? (
            <div className="flex items-center justify-center h-64">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
          ) : tableData ? (
            <>
              {/* Table Info Header */}
              <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
                <div>
                  <span className="font-semibold">{selectedTable}</span>
                  <span className="text-sm text-gray-500 ml-2">
                    ({tableData.totalRows.toLocaleString()} rows)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {selectedTableInfo && (
                    <Badge variant="default">{formatBytes(selectedTableInfo.sizeBytes)}</Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={loadTableData}
                    disabled={loading}
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </Button>
                </div>
              </div>

              {/* Data Table */}
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      {tableData.columns.map((col) => (
                        <th
                          key={col.columnName}
                          className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                          onClick={() => handleSort(col.columnName)}
                        >
                          <div className="flex items-center gap-1">
                            {col.columnName}
                            {col.isPrimaryKey && (
                              <svg className="w-3 h-3 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
                                <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
                                <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" />
                              </svg>
                            )}
                            {orderBy === col.columnName && (
                              <svg className={`w-3 h-3 ${orderDirection === 'DESC' ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                              </svg>
                            )}
                          </div>
                        </th>
                      ))}
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                        İşlemler
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {tableData.rows.map((row, idx) => {
                      const pkCol = tableData.columns.find((c) => c.isPrimaryKey);
                      const rowKey = pkCol
                        ? String(row[pkCol.columnName])
                        : idx;

                      return (
                        <tr key={rowKey} className="hover:bg-gray-50">
                          {tableData.columns.map((col) => (
                            <td
                              key={col.columnName}
                              className="px-4 py-2 text-sm text-gray-900 max-w-xs truncate"
                              title={formatValue(row[col.columnName])}
                            >
                              {row[col.columnName] === null ? (
                                <span className="text-gray-400 italic">NULL</span>
                              ) : col.dataType.includes('json') ? (
                                <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">
                                  {formatValue(row[col.columnName]).substring(0, 50)}...
                                </code>
                              ) : (
                                formatValue(row[col.columnName])
                              )}
                            </td>
                          ))}
                          <td className="px-4 py-2 text-right whitespace-nowrap">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleEditRow(row)}
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => confirmDelete(row)}
                            >
                              <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {tableData.totalPages > 1 && (
                <div className="px-4 py-3 border-t flex items-center justify-between">
                  <div className="text-sm text-gray-500">
                    Sayfa {tableData.page} / {tableData.totalPages} (
                    {((tableData.page - 1) * tableData.limit + 1).toLocaleString()} -{' '}
                    {Math.min(tableData.page * tableData.limit, tableData.totalRows).toLocaleString()}{' '}
                    / {tableData.totalRows.toLocaleString()})
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page === 1}
                      onClick={() => setPage(page - 1)}
                    >
                      Önceki
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= tableData.totalPages}
                      onClick={() => setPage(page + 1)}
                    >
                      Sonraki
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : null}
        </Card>
      </div>

      {/* Row Editor Modal */}
      {tableData && (
        <RowEditorModal
          isOpen={isEditorOpen}
          onClose={() => setIsEditorOpen(false)}
          columns={tableData.columns}
          row={editingRow}
          onSave={handleSaveRow}
          mode={editorMode}
        />
      )}

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={deleteConfirm.show}
        onClose={() => setDeleteConfirm({ show: false, id: '' })}
        title="Satırı Sil"
      >
        <p className="text-gray-600 mb-4">
          Bu satırı silmek istediğinizden emin misiniz? Bu işlem geri alınamaz.
        </p>
        <div className="flex justify-end gap-3">
          <Button
            variant="outline"
            onClick={() => setDeleteConfirm({ show: false, id: '' })}
          >
            İptal
          </Button>
          <Button variant="danger" onClick={handleDeleteRow}>
            Sil
          </Button>
        </div>
      </Modal>
    </div>
  );
};

export default DatabaseExplorerPage;
