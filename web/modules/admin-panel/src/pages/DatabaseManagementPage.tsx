/**
 * Database Management Page
 *
 * Schema yonetimi, migration ve monitoring ana sayfasi. Yedekleme WAL-G'nin
 * (ADR-0009): bu sayfada yedek/geri yukleme yuzeyi yoktur.
 * Sprint 4 Fix: Mock data kaldirildi, gercek API entegrasyonu yapildi.
 *
 * Backend controller'lar:
 *   - schema.controller.ts: /database/schemas
 *   - migration.controller.ts: /database/migrations
 *   - monitoring.controller.ts: /database/monitoring
 */

import React, { useState, useCallback } from 'react';
import { useAsyncData } from '../hooks';
import { databaseApi } from '../services/api/database';

// ============================================================================
// Types
// ============================================================================

type TabType = 'schemas' | 'migrations' | 'monitoring';

interface SchemaItem {
  tenantId: string;
  tenantName?: string;
  schemaName: string;
  status: string;
  currentVersion: string;
  sizeBytes: number;
  tableCount: number;
  rowCount?: number;
  connectionCount?: number;
  maxConnections?: number;
  lastMigrationAt?: string | null;
  lastBackupAt?: string | null;
  createdAt: string;
}

interface MigrationPlan {
  version: string;
  name: string;
  description: string;
  affectedTables: string[];
  estimatedDuration: number;
  isDestructive: boolean;
  requiresDowntime: boolean;
}

interface MigrationHistoryItem {
  id: string;
  version: string;
  name: string;
  status: string;
  appliedToSchemas?: string[];
  failedSchemas?: string[];
  startedAt?: string;
  completedAt?: string;
  error?: string;
  createdBy: string;
  createdAt: string;
  // Fields from inline type fallback
  tenantId?: string | null;
  schemaName?: string;
  migrationName?: string;
  executionTimeMs?: number;
  isDryRun?: boolean;
  executedBy?: string | null;
  errorMessage?: string | null;
}

interface DatabaseHealth {
  status: string;
  score: number;
  checks: Array<{
    name: string;
    status: string;
    value: string | number;
    message: string;
  }>;
  recommendations: string[];
}

interface ConnectionStats {
  total: number;
  active: number;
  idle: number;
  waiting: number;
  maxConnections: number;
  utilizationPercent: number;
}

interface StorageInfo {
  tenantId: string;
  schemaName: string;
  totalSizeBytes: number;
  dataSizeBytes: number;
  indexSizeBytes: number;
  tableCount: number;
}

interface SlowQueryItem {
  query: string;
  count: number;
  avgTime: number;
  maxTime?: number;
  schema?: string;
}

interface IndexRecommendation {
  tableName: string;
  columns: string[];
  indexType: string;
  reason: string;
  estimatedImpact: string;
  createStatement: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
};

const formatDate = (dateStr: string | null | undefined): string => {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString('tr-TR');
};

const getStatusColor = (status: string): string => {
  switch (status) {
    case 'active':
    case 'completed':
    case 'pass':
    case 'healthy':
      return 'text-green-600 bg-green-100';
    case 'creating':
    case 'running':
    case 'in_progress':
    case 'pending':
    case 'migration_pending':
      return 'text-blue-600 bg-blue-100';
    case 'suspended':
    case 'warn':
    case 'warning':
      return 'text-yellow-600 bg-yellow-100';
    case 'failed':
    case 'fail':
    case 'critical':
    case 'deleted':
    case 'expired':
    case 'archived':
      return 'text-red-600 bg-red-100';
    case 'rolled_back':
      return 'text-purple-600 bg-purple-100';
    default:
      return 'text-gray-600 bg-gray-100';
  }
};

// ============================================================================
// Shared UI Components
// ============================================================================

const StatusBadge: React.FC<{ status: string }> = ({ status }) => (
  <span className={`px-2 py-1 text-xs font-medium rounded-full ${getStatusColor(status)}`}>
    {status.replace(/_/g, ' ')}
  </span>
);

const ProgressBar: React.FC<{ value: number; max: number; color?: string }> = ({
  value,
  max,
  color = 'bg-blue-500',
}) => {
  const percentage = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="w-full bg-gray-200 rounded-full h-2">
      <div
        className={`h-2 rounded-full ${color}`}
        style={{ width: `${Math.min(percentage, 100)}%` }}
      />
    </div>
  );
};

const LoadingSpinner: React.FC<{ message?: string }> = ({ message = 'Loading...' }) => (
  <div className="flex items-center justify-center py-12">
    <div className="text-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-3" />
      <p className="text-sm text-gray-500">{message}</p>
    </div>
  </div>
);

const ErrorState: React.FC<{ error: string; onRetry?: () => void }> = ({ error, onRetry }) => (
  <div className="flex items-center justify-center py-12">
    <div className="text-center">
      <div className="text-red-500 mb-3">
        <svg className="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
          />
        </svg>
      </div>
      <p className="text-sm text-red-600 mb-3">{error}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
        >
          Retry
        </button>
      )}
    </div>
  </div>
);

const EmptyState: React.FC<{ message: string }> = ({ message }) => (
  <div className="flex items-center justify-center py-12">
    <p className="text-sm text-gray-500">{message}</p>
  </div>
);

// ============================================================================
// Schema Tab Component
// ============================================================================

const SchemasTab: React.FC = () => {
  const [selectedSchema, setSelectedSchema] = useState<SchemaItem | null>(null);

  const schemasState = useAsyncData<SchemaItem[]>(
    useCallback(
      () => databaseApi.getSchemas({ page: 1, limit: 100 }).then((res): SchemaItem[] => res.data),
      [],
    ),
    { initialData: [] },
  );

  const schemas = schemasState.data || [];

  if (schemasState.loading && schemasState.isInitialLoad) {
    return <LoadingSpinner message="Loading schemas..." />;
  }

  if (schemasState.error) {
    return <ErrorState error={schemasState.error} onRetry={schemasState.retry} />;
  }

  if (schemas.length === 0) {
    return <EmptyState message="No tenant schemas found." />;
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">Total Schemas</div>
          <div className="text-2xl font-bold text-gray-900">{schemas.length}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">Active</div>
          <div className="text-2xl font-bold text-green-600">
            {schemas.filter((s) => s.status === 'active').length}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">Total Size</div>
          <div className="text-2xl font-bold text-blue-600">
            {formatBytes(schemas.reduce((sum, s) => sum + (s.sizeBytes || 0), 0))}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">Total Tables</div>
          <div className="text-2xl font-bold text-purple-600">
            {schemas.reduce((sum, s) => sum + (s.tableCount || 0), 0)}
          </div>
        </div>
      </div>

      {/* Schema List */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
          <h3 className="text-lg font-medium text-gray-900">Tenant Schemas</h3>
          <div className="flex space-x-3">
            <button
              onClick={() => schemasState.refresh()}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 text-sm"
            >
              Refresh
            </button>
            <button className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
              Create Schema
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Schema Name
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Version
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Size
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Tables
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Last Backup
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {schemas.map((schema) => (
                <tr key={schema.tenantId} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div className="text-sm font-medium text-gray-900">{schema.schemaName}</div>
                    <div className="text-xs text-gray-500">Tenant: {schema.tenantId}</div>
                  </td>
                  <td className="px-6 py-4">
                    <StatusBadge status={schema.status} />
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">{schema.currentVersion}</td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {formatBytes(schema.sizeBytes || 0)}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">{schema.tableCount || 0}</td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {formatDate(schema.lastBackupAt)}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex space-x-2">
                      <button
                        onClick={() => setSelectedSchema(schema)}
                        className="text-blue-600 hover:text-blue-800 text-sm"
                      >
                        View
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Schema Detail Modal */}
      {selectedSchema && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
              <h3 className="text-lg font-medium text-gray-900">Schema Details</h3>
              <button
                onClick={() => setSelectedSchema(null)}
                className="text-gray-500 hover:text-gray-600"
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-sm text-gray-500">Schema Name</div>
                  <div className="font-medium">{selectedSchema.schemaName}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Tenant ID</div>
                  <div className="font-medium">{selectedSchema.tenantId}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Status</div>
                  <StatusBadge status={selectedSchema.status} />
                </div>
                <div>
                  <div className="text-sm text-gray-500">Version</div>
                  <div className="font-medium">{selectedSchema.currentVersion}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Size</div>
                  <div className="font-medium">{formatBytes(selectedSchema.sizeBytes || 0)}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Tables</div>
                  <div className="font-medium">{selectedSchema.tableCount || 0}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Last Migration</div>
                  <div className="font-medium">{formatDate(selectedSchema.lastMigrationAt)}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Last Backup</div>
                  <div className="font-medium">{formatDate(selectedSchema.lastBackupAt)}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Created</div>
                  <div className="font-medium">{formatDate(selectedSchema.createdAt)}</div>
                </div>
              </div>
              <div className="flex space-x-3 pt-4">
                <button
                  onClick={() => {
                    databaseApi
                      .validateSchemaIsolation(selectedSchema.tenantId)
                      .then((result) => {
                        alert(
                          result.valid
                            ? 'Schema isolation is valid.'
                            : `Issues found: ${result.issues.join(', ')}`,
                        );
                      })
                      .catch((err) => alert(`Validation failed: ${err.message}`));
                  }}
                  className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 text-sm"
                >
                  Validate Isolation
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Migrations Tab Component
// ============================================================================

const MigrationsTab: React.FC = () => {
  const plansState = useAsyncData<MigrationPlan[]>(
    useCallback(() => databaseApi.getAvailableMigrations(), []),
    { initialData: [] },
  );

  const historyState = useAsyncData<MigrationHistoryItem[]>(
    useCallback(
      () =>
        databaseApi
          .getMigrationHistory({ page: 1, limit: 50 })
          .then((res): MigrationHistoryItem[] => res.data),
      [],
    ),
    { initialData: [] },
  );

  const plans = plansState.data || [];
  const history = historyState.data || [];

  const isLoading =
    (plansState.loading && plansState.isInitialLoad) ||
    (historyState.loading && historyState.isInitialLoad);
  const error = plansState.error || historyState.error;

  if (isLoading) {
    return <LoadingSpinner message="Loading migrations..." />;
  }

  if (error) {
    return (
      <ErrorState
        error={error}
        onRetry={() => {
          plansState.retry();
          historyState.retry();
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Available Migrations */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
          <h3 className="text-lg font-medium text-gray-900">Available Migrations</h3>
          <div className="flex space-x-3">
            <button
              onClick={() => plansState.refresh()}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 text-sm"
            >
              Refresh
            </button>
          </div>
        </div>
        {plans.length === 0 ? (
          <EmptyState message="No available migrations." />
        ) : (
          <div className="p-6 space-y-4">
            {plans.map((plan) => (
              <div
                key={plan.version}
                className="border border-gray-200 rounded-lg p-4 hover:border-blue-300"
              >
                <div className="flex justify-between items-start">
                  <div>
                    <div className="flex items-center space-x-3">
                      <span className="text-lg font-medium text-gray-900">{plan.version}</span>
                      <span className="text-sm text-gray-500">{plan.name}</span>
                      {plan.isDestructive && (
                        <span className="px-2 py-1 text-xs font-medium rounded-full bg-red-100 text-red-600">
                          Destructive
                        </span>
                      )}
                      {plan.requiresDowntime && (
                        <span className="px-2 py-1 text-xs font-medium rounded-full bg-yellow-100 text-yellow-600">
                          Requires Downtime
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-500 mt-1">{plan.description}</p>
                    <div className="flex items-center space-x-4 mt-2 text-xs text-gray-500">
                      <span>Tables: {plan.affectedTables.join(', ')}</span>
                      <span>Est. Duration: {formatDuration(plan.estimatedDuration)}</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Migration History */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
          <h3 className="text-lg font-medium text-gray-900">Migration History</h3>
          <button
            onClick={() => historyState.refresh()}
            className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 text-sm"
          >
            Refresh
          </button>
        </div>
        {history.length === 0 ? (
          <EmptyState message="No migration history found." />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Migration
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Schemas
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Created By
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Date
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {history.map((migration) => (
                  <tr key={migration.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4">
                      <div className="text-sm font-medium text-gray-900">{migration.version}</div>
                      <div className="text-xs text-gray-500">
                        {migration.name || migration.migrationName}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <StatusBadge status={migration.status} />
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500">
                      {migration.appliedToSchemas
                        ? `${migration.appliedToSchemas.length} applied`
                        : migration.schemaName || '-'}
                      {migration.failedSchemas && migration.failedSchemas.length > 0 && (
                        <span className="ml-1 text-red-500">
                          ({migration.failedSchemas.length} failed)
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500">
                      {migration.createdBy || migration.executedBy || '-'}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500">
                      {formatDate(migration.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// Monitoring Tab Component
// ============================================================================

const MonitoringTab: React.FC = () => {
  const healthState = useAsyncData<DatabaseHealth>(
    useCallback(() => databaseApi.getDatabaseHealth(), []),
    { initialData: null },
  );

  const connectionsState = useAsyncData<ConnectionStats>(
    useCallback(() => databaseApi.getConnectionStats(), []),
    { initialData: null },
  );

  const storageState = useAsyncData<StorageInfo[]>(
    useCallback(() => databaseApi.getStorageByTenant(), []),
    { initialData: [] },
  );

  const slowQueriesState = useAsyncData<SlowQueryItem[]>(
    useCallback(() => databaseApi.getSlowQueries({ grouped: true, limit: 20 }), []),
    { initialData: [] },
  );

  const indexState = useAsyncData<IndexRecommendation[]>(
    useCallback(() => databaseApi.getIndexRecommendations(), []),
    { initialData: [] },
  );

  const isLoading =
    (healthState.loading && healthState.isInitialLoad) ||
    (connectionsState.loading && connectionsState.isInitialLoad);

  if (isLoading) {
    return <LoadingSpinner message="Loading monitoring data..." />;
  }

  const health = healthState.data;
  const connections = connectionsState.data;
  const storage = storageState.data || [];
  const slowQueries = slowQueriesState.data || [];
  const indexRecommendations = indexState.data || [];

  return (
    <div className="space-y-6">
      {/* Health Status */}
      {healthState.error ? (
        <ErrorState error={healthState.error} onRetry={healthState.retry} />
      ) : health ? (
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900">Database Health</h3>
            <div className="flex items-center space-x-3">
              <span
                className={`text-3xl font-bold ${
                  health.status === 'healthy'
                    ? 'text-green-600'
                    : health.status === 'warning'
                      ? 'text-yellow-600'
                      : 'text-red-600'
                }`}
              >
                {health.score}
              </span>
              <StatusBadge status={health.status} />
              <button
                onClick={() => healthState.refresh()}
                className="px-3 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 text-sm"
              >
                Refresh
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {health.checks.map((check) => (
              <div key={check.name} className="p-4 bg-gray-50 rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-gray-700">{check.name}</span>
                  <StatusBadge status={check.status} />
                </div>
                <div className="text-xl font-bold text-gray-900">{check.value}</div>
                <div className="text-xs text-gray-500">{check.message}</div>
              </div>
            ))}
          </div>
          {health.recommendations.length > 0 && (
            <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <div className="text-sm font-medium text-yellow-800 mb-2">Recommendations</div>
              <ul className="list-disc list-inside text-sm text-yellow-700 space-y-1">
                {health.recommendations.map((rec, idx) => (
                  <li key={idx}>{rec}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : null}

      {/* Connection Stats */}
      {connectionsState.error ? (
        <ErrorState error={connectionsState.error} onRetry={connectionsState.retry} />
      ) : connections ? (
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900">Connection Pool</h3>
            <button
              onClick={() => connectionsState.refresh()}
              className="px-3 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 text-sm"
            >
              Refresh
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            <div className="text-center">
              <div className="text-3xl font-bold text-gray-900">{connections.total}</div>
              <div className="text-sm text-gray-500">Total</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold text-green-600">{connections.active}</div>
              <div className="text-sm text-gray-500">Active</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold text-blue-600">{connections.idle}</div>
              <div className="text-sm text-gray-500">Idle</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold text-yellow-600">{connections.waiting}</div>
              <div className="text-sm text-gray-500">Waiting</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold text-purple-600">{connections.maxConnections}</div>
              <div className="text-sm text-gray-500">Max</div>
            </div>
          </div>
          <div className="mt-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-gray-500">Utilization</span>
              <span className="text-sm font-medium">
                {(connections.utilizationPercent || 0).toFixed(1)}%
              </span>
            </div>
            <ProgressBar
              value={connections.total}
              max={connections.maxConnections}
              color={
                (connections.utilizationPercent || 0) > 80
                  ? 'bg-red-500'
                  : (connections.utilizationPercent || 0) > 60
                    ? 'bg-yellow-500'
                    : 'bg-green-500'
              }
            />
          </div>
        </div>
      ) : null}

      {/* Storage by Tenant */}
      {storageState.error ? (
        <ErrorState error={storageState.error} onRetry={storageState.retry} />
      ) : storage.length > 0 ? (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
            <h3 className="text-lg font-medium text-gray-900">Storage by Tenant</h3>
            <button
              onClick={() => storageState.refresh()}
              className="px-3 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 text-sm"
            >
              Refresh
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Schema
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Total Size
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Data
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Indexes
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Tables
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Distribution
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {(() => {
                  const totalStorage = storage.reduce((sum, s) => sum + s.totalSizeBytes, 0);
                  return storage.map((item) => {
                    const percentage =
                      totalStorage > 0 ? (item.totalSizeBytes / totalStorage) * 100 : 0;
                    return (
                      <tr key={item.tenantId} className="hover:bg-gray-50">
                        <td className="px-6 py-4">
                          <div className="text-sm font-medium text-gray-900">{item.schemaName}</div>
                          <div className="text-xs text-gray-500">{item.tenantId}</div>
                        </td>
                        <td className="px-6 py-4 text-sm font-medium text-gray-900">
                          {formatBytes(item.totalSizeBytes)}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500">
                          {formatBytes(item.dataSizeBytes)}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500">
                          {formatBytes(item.indexSizeBytes)}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500">{item.tableCount}</td>
                        <td className="px-6 py-4">
                          <div className="flex items-center space-x-2">
                            <ProgressBar value={percentage} max={100} />
                            <span className="text-sm text-gray-500">{percentage.toFixed(1)}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  });
                })()}
              </tbody>
            </table>
          </div>
        </div>
      ) : !storageState.loading ? (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-2">Storage by Tenant</h3>
          <EmptyState message="No storage data available." />
        </div>
      ) : null}

      {/* Slow Queries */}
      {slowQueriesState.error ? (
        <ErrorState error={slowQueriesState.error} onRetry={slowQueriesState.retry} />
      ) : slowQueries.length > 0 ? (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
            <h3 className="text-lg font-medium text-gray-900">Slow Queries (Grouped)</h3>
            <button
              onClick={() => slowQueriesState.refresh()}
              className="px-3 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 text-sm"
            >
              Refresh
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Query Pattern
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Count
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Avg Time
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {slowQueries.map((query, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="px-6 py-4">
                      <code className="text-sm text-gray-700 bg-gray-100 px-2 py-1 rounded">
                        {query.query.length > 80
                          ? query.query.substring(0, 80) + '...'
                          : query.query}
                      </code>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500">{query.count}</td>
                    <td className="px-6 py-4">
                      <span
                        className={`text-sm font-medium ${
                          query.avgTime > 2000 ? 'text-red-600' : 'text-yellow-600'
                        }`}
                      >
                        {formatDuration(query.avgTime)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : !slowQueriesState.loading ? (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-2">Slow Queries</h3>
          <EmptyState message="No slow queries detected." />
        </div>
      ) : null}

      {/* Index Recommendations */}
      {indexState.error ? (
        <ErrorState error={indexState.error} onRetry={indexState.retry} />
      ) : indexRecommendations.length > 0 ? (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
            <h3 className="text-lg font-medium text-gray-900">Index Recommendations</h3>
            <button
              onClick={() => indexState.refresh()}
              className="px-3 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 text-sm"
            >
              Refresh
            </button>
          </div>
          <div className="p-6 space-y-4">
            {indexRecommendations.map((rec, idx) => (
              <div key={idx} className="border border-gray-200 rounded-lg p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center space-x-2">
                      <span className="font-medium text-gray-900">{rec.tableName}</span>
                      <span
                        className={`px-2 py-0.5 text-xs rounded-full ${
                          rec.estimatedImpact === 'high'
                            ? 'bg-red-100 text-red-600'
                            : rec.estimatedImpact === 'medium'
                              ? 'bg-yellow-100 text-yellow-600'
                              : 'bg-green-100 text-green-600'
                        }`}
                      >
                        {rec.estimatedImpact} impact
                      </span>
                    </div>
                    <p className="text-sm text-gray-500 mt-1">{rec.reason}</p>
                    <code className="block text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded mt-2">
                      {rec.createStatement}
                    </code>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : !indexState.loading ? (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-2">Index Recommendations</h3>
          <EmptyState message="No index recommendations at this time." />
        </div>
      ) : null}
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

const DatabaseManagementPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('schemas');

  const tabs: Array<{ id: TabType; label: string }> = [
    { id: 'schemas', label: 'Schemas' },
    { id: 'migrations', label: 'Migrations' },
    { id: 'monitoring', label: 'Monitoring' },
  ];

  return (
    <div className="p-6 bg-gray-100 min-h-screen">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Database Management</h1>
        <p className="text-gray-500">
          Multi-tenant schema yonetimi, migration ve performans izleme
        </p>
      </div>

      {/* Tabs */}
      <div className="mb-6">
        <div className="border-b border-gray-200">
          <nav className="-mb-px flex space-x-8">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`py-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === 'schemas' && <SchemasTab />}
      {activeTab === 'migrations' && <MigrationsTab />}
      {activeTab === 'monitoring' && <MonitoringTab />}
    </div>
  );
};

export default DatabaseManagementPage;
