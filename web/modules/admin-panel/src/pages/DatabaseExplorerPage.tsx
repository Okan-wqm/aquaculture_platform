/**
 * Database Explorer Page
 *
 * Veritabanı tablolarını görüntüleme, veri ekleme/güncelleme/silme.
 * SUPER_ADMIN için geliştirme ve debug amaçlı.
 */

import React, { useState, useEffect } from 'react';
import {
  Card,
  Button,
  Input,
  Badge,
  Alert,
  Modal,
  DataTable,
  type DataTableColumn,
  type SortConfig,
  Spinner,
  PageHeader,
} from '@aquaculture/shared-ui';
import { databaseApi } from '../services/adminApi';
import { saveBlob } from '../services/blob-client';
import { useAdminQuery, useAdminMutation, adminKeys } from '../hooks';
import { QueryFailureNotice } from '../components/QueryFailureNotice';
import {
  ChevronDown,
  Clipboard,
  Code,
  Download,
  FileText,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';

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
  isSensitive?: boolean;
}

// Sensitive columns that should be visually marked
const SENSITIVE_COLUMN_PATTERNS = [
  'password',
  'secret',
  'token',
  'api_key',
  'hash',
  'salt',
  'mfa_secret',
  'credential',
  'private_key',
  'encryption_key',
];

const isSensitiveColumnName = (name: string): boolean => {
  const lowerName = name.toLowerCase();
  return SENSITIVE_COLUMN_PATTERNS.some((pattern) => lowerName.includes(pattern));
};

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

const MASKED_VALUE = '********';

const isMaskedValue = (value: unknown): boolean => {
  return value === MASKED_VALUE;
};

const getDataTypeBadgeColor = (
  dataType: string,
): 'info' | 'success' | 'warning' | 'error' | 'default' => {
  if (dataType.includes('int') || dataType.includes('numeric') || dataType.includes('decimal'))
    return 'info';
  if (dataType.includes('varchar') || dataType.includes('text') || dataType.includes('char'))
    return 'success';
  if (dataType.includes('timestamp') || dataType.includes('date') || dataType.includes('time'))
    return 'warning';
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
    setError(null);

    // Validate required fields before submitting (BUG-015)
    if (mode === 'create') {
      const missingFields = columns.filter(
        (col) =>
          !col.isNullable &&
          !col.columnDefault &&
          (formData[col.columnName] || '').trim() === '' &&
          !col.columnDefault?.includes('gen_random_uuid') &&
          !col.columnDefault?.includes('nextval'),
      );
      if (missingFields.length > 0) {
        setError(`Required fields missing: ${missingFields.map((c) => c.columnName).join(', ')}`);
        return;
      }
    }

    setSaving(true);

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
        } else if (
          col.dataType.includes('numeric') ||
          col.dataType.includes('decimal') ||
          col.dataType.includes('float') ||
          col.dataType.includes('double')
        ) {
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
          if (
            col.columnDefault?.includes('gen_random_uuid') ||
            col.columnDefault?.includes('nextval')
          ) {
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
      title={mode === 'create' ? 'Add New Row' : 'Edit Row'}
      size="lg"
    >
      {error && (
        <Alert type="error" className="mb-4">
          {error}
        </Alert>
      )}

      <div className="space-y-4 max-h-[60vh] overflow-y-auto">
        {columns.map((col) => {
          const isSensitive = col.isSensitive || isSensitiveColumnName(col.columnName);
          return (
            <div key={col.columnName}>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
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
                {isSensitive && (
                  <Badge variant="error" className="ml-1">
                    Sensitive
                  </Badge>
                )}
                {!col.isNullable && !col.columnDefault && (
                  <span className="text-red-500 ml-1">*</span>
                )}
              </label>
              {isSensitive ? (
                <div className="px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-500 dark:text-gray-400 italic">
                  [Sensitive field — not shown for security. Clear to unset.]
                </div>
              ) : (
                <Input
                  value={formData[col.columnName] || ''}
                  onChange={(e) => setFormData({ ...formData, [col.columnName]: e.target.value })}
                  placeholder={col.columnDefault || col.dataType}
                  disabled={
                    mode === 'edit' &&
                    col.isPrimaryKey &&
                    col.columnDefault?.includes('gen_random_uuid')
                  }
                />
              )}
              <div className="flex items-center gap-2 mt-1">
                <Badge variant={getDataTypeBadgeColor(col.dataType)}>{col.dataType}</Badge>
                {col.isNullable && (
                  <span className="text-xs text-gray-500 dark:text-gray-400">nullable</span>
                )}
                {col.columnDefault && (
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    default: {col.columnDefault.substring(0, 30)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex justify-end gap-3 mt-6 pt-4 border-t">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={handleSave} loading={saving}>
          {mode === 'create' ? 'Add' : 'Save'}
        </Button>
      </div>
    </Modal>
  );
};

// ============================================================================
// Main Component
// ============================================================================

const PAGE_SIZE = 50;

const DatabaseExplorerPage: React.FC = () => {
  // Selection
  const [selectedSchema, setSelectedSchema] = useState('public');
  const [selectedTable, setSelectedTable] = useState<string | null>(null);

  // Pagination & Sorting — part of the table-data cache key, not local
  // bookkeeping over one shared result.
  const [page, setPage] = useState(1);
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

  const [showExportMenu, setShowExportMenu] = useState(false);

  // ==========================================================================
  // Reads (ADMIN-HIGH-121)
  // ==========================================================================

  const schemasQuery = useAdminQuery<string[]>(adminKeys.database.schemas(), ({ signal }) =>
    databaseApi.getExplorerSchemas(signal),
  );

  const tablesQuery = useAdminQuery<TableInfo[]>(
    adminKeys.database.tables(selectedSchema),
    ({ signal }) => databaseApi.getExplorerTables(selectedSchema, signal),
  );

  const dataParams = {
    page,
    limit: PAGE_SIZE,
    orderBy,
    orderDirection,
  };

  const tableDataQuery = useAdminQuery<TableData>(
    adminKeys.database.tableData(selectedSchema, selectedTable ?? '', dataParams),
    ({ signal }) =>
      databaseApi.getExplorerTableData(
        selectedSchema,
        // `enabled` below keeps this from running with no table selected; the
        // coalesce is what makes that provable to the compiler rather than
        // asserted with a cast.
        selectedTable ?? '',
        dataParams,
        signal,
      ),
    { enabled: selectedTable !== null },
  );

  const schemas = schemasQuery.data ?? [];
  const tables = tablesQuery.data ?? [];
  const tableData = selectedTable === null ? undefined : tableDataQuery.data;

  // The primary key decides which row actions are POSSIBLE, so it is read once
  // here and the actions that need it are not rendered without it. Before W8p
  // both were rendered unconditionally: an edit on a key-less table ran no
  // request and closed the modal as if it had saved, and its delete button did
  // nothing at all, silently, every time.
  const primaryKey = tableData?.columns.find((column) => column.isPrimaryKey);

  // ==========================================================================
  // Writes (ADMIN-HIGH-121)
  // ==========================================================================

  // A row write changes the table's row count and on-disk size, both of which
  // the sidebar shows — so it invalidates the table LIST as well as the data.
  // `database.table(...)` is a prefix over every page and sort, so a delete on
  // page 1 does not leave page 2 holding the row it removed.
  const rowWriteKeys = (table: string) => [
    adminKeys.database.tables(selectedSchema),
    adminKeys.database.table(selectedSchema, table),
  ];

  const insertRow = useAdminMutation<
    Record<string, unknown>,
    { table: string; data: Record<string, unknown> }
  >(({ table, data }) => databaseApi.insertExplorerRow(selectedSchema, table, data), {
    invalidateKeys: selectedTable ? rowWriteKeys(selectedTable) : [],
  });

  const updateRow = useAdminMutation<
    Record<string, unknown>,
    { table: string; id: string; data: Record<string, unknown> }
  >(({ table, id, data }) => databaseApi.updateExplorerRow(selectedSchema, table, id, data), {
    invalidateKeys: selectedTable ? rowWriteKeys(selectedTable) : [],
  });

  const deleteRow = useAdminMutation<void, { table: string; id: string }>(
    ({ table, id }) => databaseApi.deleteExplorerRow(selectedSchema, table, id),
    { invalidateKeys: selectedTable ? rowWriteKeys(selectedTable) : [] },
  );

  const exportTable = useAdminMutation<void, { table: string; format: 'csv' | 'json' }>(
    async ({ table, format }) => {
      const { blob, filename } = await databaseApi.exportExplorerTable(
        selectedSchema,
        table,
        format,
        orderBy,
        orderDirection,
      );
      saveBlob(blob, filename ?? `${table}_export.${format}`);
    },
  );

  // A failed read or a failed delete/export has no modal of its own, so it is
  // named here. Insert and update report inside the editor that caused them.
  const queryErrors = [
    schemasQuery.error,
    tablesQuery.error,
    tableDataQuery.error,
    deleteRow.error,
    exportTable.error,
  ];

  const loading =
    schemasQuery.isPending ||
    tablesQuery.isPending ||
    (selectedTable !== null && tableDataQuery.isPending);

  const reload = (): void => {
    void schemasQuery.refetch();
    void tablesQuery.refetch();
    if (selectedTable !== null) {
      void tableDataQuery.refetch();
    }
  };

  // Handlers
  const handleTableSelect = (tableName: string) => {
    // All four setState calls are inside a React event handler — React 18 batches them
    // automatically into a single render, preventing multiple loadTableData triggers (PERF-004)
    setSelectedTable(tableName);
    setPage(1);
    setOrderBy(undefined);
    setOrderDirection('ASC');
  };

  const handleSchemaSelect = (schema: string): void => {
    setSelectedSchema(schema);
    setSelectedTable(null);
    setPage(1);
    setOrderBy(undefined);
    setOrderDirection('ASC');
  };

  const handleSort = (sort: SortConfig | null) => {
    setOrderBy(sort ? sort.key : undefined);
    setOrderDirection(sort?.direction === 'desc' ? 'DESC' : 'ASC');
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

  const handleSaveRow = async (data: Record<string, unknown>): Promise<void> => {
    if (!selectedTable) return;

    if (editorMode === 'create') {
      await insertRow.mutateAsync({ table: selectedTable, data });
      return;
    }

    if (!editingRow) return;
    if (!primaryKey) {
      // Reported in the editor rather than swallowed. The edit button should
      // not be reachable on a key-less table; this is the second line.
      throw new Error(
        `${selectedTable} has no primary key, so a single row cannot be addressed for update.`,
      );
    }

    await updateRow.mutateAsync({
      table: selectedTable,
      id: String(editingRow[primaryKey.columnName]),
      data,
    });
  };

  // `mutate`, not `mutateAsync`: the outcome is read off the mutation — the
  // confirmation closes on success, and a failure reaches the operator through
  // `queryErrors` below. `mutateAsync` here would reject into a click handler
  // with nothing to catch it.
  const handleDeleteRow = (): void => {
    if (!selectedTable || !deleteConfirm.id) return;

    deleteRow.mutate(
      { table: selectedTable, id: deleteConfirm.id },
      { onSuccess: () => setDeleteConfirm({ show: false, id: '' }) },
    );
  };

  const confirmDelete = (row: Record<string, unknown>) => {
    if (!primaryKey) return;
    setDeleteConfirm({
      show: true,
      id: String(row[primaryKey.columnName]),
    });
  };

  const handleExport = (format: 'csv' | 'json'): void => {
    if (!selectedTable) return;
    setShowExportMenu(false);
    exportTable.mutate({ table: selectedTable, format });
  };

  // Find selected table info
  const selectedTableInfo = tables.find((t) => t.tableName === selectedTable);

  // Server-described columns: the header carries the key and sensitivity markers, the cells mask and format.
  const explorerColumns: DataTableColumn<Record<string, unknown>>[] = tableData
    ? [
        ...tableData.columns.map((col): DataTableColumn<Record<string, unknown>> => {
          const isSensitive = col.isSensitive || isSensitiveColumnName(col.columnName);
          return {
            key: col.columnName,
            header: col.columnName,
            className: isSensitive ? 'text-orange-600' : undefined,
            headerRender: (
              <span
                className={`inline-flex items-center gap-1 ${isSensitive ? 'rounded bg-orange-50 px-1' : ''}`}
                title={isSensitive ? 'This column contains sensitive data (masked)' : undefined}
              >
                {col.columnName}
                {col.isPrimaryKey && (
                  <Clipboard className="w-3 h-3 text-yellow-500" aria-hidden="true" />
                )}
                {isSensitive && (
                  <Lock className="w-3 h-3 text-orange-500" aria-label="Hassas veri - Maskeli" />
                )}
              </span>
            ),
            render: (value) => {
              const valueIsMasked = isMaskedValue(value);
              return (
                <span
                  className={`block max-w-xs truncate ${valueIsMasked ? 'rounded bg-orange-50 px-1' : ''}`}
                  title={valueIsMasked ? 'Sensitive data (masked)' : formatValue(value)}
                >
                  {value === null ? (
                    <span className="text-gray-500 dark:text-gray-400 italic">NULL</span>
                  ) : valueIsMasked ? (
                    <span className="flex items-center gap-1 text-orange-600 font-mono">
                      <Lock className="w-3 h-3" aria-hidden="true" />
                      {MASKED_VALUE}
                    </span>
                  ) : col.dataType.includes('json') ? (
                    <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded">
                      {formatValue(value).substring(0, 50)}...
                    </code>
                  ) : (
                    formatValue(value)
                  )}
                </span>
              );
            },
          };
        }),
        {
          key: '__actions',
          header: 'Actions',
          align: 'right',
          sortable: false,
          render: (_value, row) =>
            primaryKey ? (
              <span className="whitespace-nowrap">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Edit row"
                  onClick={() => handleEditRow(row)}
                >
                  <Pencil className="w-4 h-4" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Delete row"
                  onClick={() => confirmDelete(row)}
                >
                  <Trash2 className="w-4 h-4 text-red-500" aria-hidden="true" />
                </Button>
              </span>
            ) : (
              <span className="text-xs italic text-gray-500 dark:text-gray-400">
                no primary key
              </span>
            ),
        },
      ]
    : [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Database Explorer"
        description="View and manage database tables"
        actions={
          <div className="mt-4 sm:mt-0 flex gap-2">
            <select
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm"
              value={selectedSchema}
              onChange={(e) => handleSchemaSelect(e.target.value)}
            >
              {schemas.map((schema) => (
                <option key={schema} value={schema}>
                  {schema}
                </option>
              ))}
            </select>
            {selectedTable && (
              <>
                {/* Export Dropdown */}
                <div className="relative">
                  <Button
                    variant="outline"
                    onClick={() => setShowExportMenu(!showExportMenu)}
                    disabled={exportTable.isPending}
                  >
                    {exportTable.isPending ? (
                      <Spinner size="sm" color="gray" className="mr-2" />
                    ) : (
                      <Download className="w-4 h-4 mr-2" aria-hidden="true" />
                    )}
                    Export
                    <ChevronDown className="w-4 h-4 ml-1" aria-hidden="true" />
                  </Button>
                  {showExportMenu && (
                    <div className="absolute right-0 mt-1 w-36 bg-white dark:bg-gray-900 rounded-lg shadow-lg border z-50">
                      <button
                        className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 rounded-t-lg"
                        onClick={() => handleExport('csv')}
                      >
                        <FileText className="w-4 h-4 inline mr-2" aria-hidden="true" />
                        CSV
                      </button>
                      <button
                        className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 rounded-b-lg"
                        onClick={() => handleExport('json')}
                      >
                        <Code className="w-4 h-4 inline mr-2" aria-hidden="true" />
                        JSON
                      </button>
                    </div>
                  )}
                </div>
                <Button onClick={handleCreateRow}>
                  <Plus className="w-4 h-4 mr-2" aria-hidden="true" />
                  New Row
                </Button>
              </>
            )}
          </div>
        }
      />

      <QueryFailureNotice errors={queryErrors} hasContent={tables.length > 0} onRetry={reload} />

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Table List */}
        <Card className="p-4 lg:col-span-1">
          <h3 className="text-lg font-semibold mb-4">Tables ({tables.length})</h3>
          <div className="space-y-1 max-h-[calc(100vh-300px)] overflow-y-auto">
            {tables.map((table) => (
              <button
                key={table.tableName}
                onClick={() => handleTableSelect(table.tableName)}
                className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                  selectedTable === table.tableName
                    ? 'bg-blue-100 text-blue-700'
                    : 'hover:bg-gray-100 dark:hover:bg-gray-700'
                }`}
              >
                <div className="font-medium text-sm">{table.tableName}</div>
                <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
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
            <div className="flex items-center justify-center h-64 text-gray-500 dark:text-gray-400">
              Select a table
            </div>
          ) : loading && !tableData ? (
            <div className="flex items-center justify-center h-64">
              <Spinner size="lg" />
            </div>
          ) : tableData ? (
            <>
              {/* Table Info Header */}
              <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800 border-b flex items-center justify-between">
                <div>
                  <span className="font-semibold">{selectedTable}</span>
                  <span className="text-sm text-gray-500 dark:text-gray-400 ml-2">
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
                    onClick={() => void tableDataQuery.refetch()}
                    disabled={tableDataQuery.isFetching}
                  >
                    <RefreshCw className="w-4 h-4" aria-hidden="true" />
                  </Button>
                </div>
              </div>

              {/* Data Table */}
              <DataTable<Record<string, unknown>>
                data={tableData.rows}
                columns={explorerColumns}
                keyExtractor={(row, index) =>
                  primaryKey ? String(row[primaryKey.columnName]) : String(index)
                }
                emptyMessage="No rows"
                searchable={false}
                serverSideSort
                defaultSort={
                  orderBy
                    ? { key: orderBy, direction: orderDirection === 'ASC' ? 'asc' : 'desc' }
                    : undefined
                }
                onSort={handleSort}
                stickyHeader={false}
                compact
                className="border-0 rounded-none shadow-none"
              />

              {/* Pagination */}
              {tableData.totalPages > 1 && (
                <div className="px-4 py-3 border-t flex items-center justify-between">
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    Page {tableData.page} / {tableData.totalPages} (
                    {((tableData.page - 1) * tableData.limit + 1).toLocaleString()} -{' '}
                    {Math.min(
                      tableData.page * tableData.limit,
                      tableData.totalRows,
                    ).toLocaleString()}{' '}
                    / {tableData.totalRows.toLocaleString()})
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page === 1}
                      onClick={() => setPage(page - 1)}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= tableData.totalPages}
                      onClick={() => setPage(page + 1)}
                    >
                      Next
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
        title="Delete Row"
      >
        <p className="text-gray-600 dark:text-gray-400 mb-4">
          Are you sure you want to delete this row? This action cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={() => setDeleteConfirm({ show: false, id: '' })}>
            Cancel
          </Button>
          <Button variant="danger" loading={deleteRow.isPending} onClick={handleDeleteRow}>
            Delete
          </Button>
        </div>
      </Modal>
    </div>
  );
};

export default DatabaseExplorerPage;
