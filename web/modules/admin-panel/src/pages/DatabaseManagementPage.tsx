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

import React, { useState } from 'react';
import { adminKeys, useAdminMutation, useAdminQuery } from '../hooks';
import { QueryFailureNotice } from '../components/QueryFailureNotice';
import { databaseApi } from '../services/api/database';
import type { ApiSchema } from '../services/contract';
import type { SchemaMigration } from '../services/types/database';

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

  // The four cards above the table are PLATFORM totals, so they come from the
  // platform's own aggregate. They used to be `schemas.length`,
  // `schemas.filter(active).length` and two `reduce`s over the list below —
  // which is fetched with `limit: 100`. Past a hundred tenants every one of
  // them was the first page's subtotal printed under the word "Total".
  const summaryQuery = useAdminQuery<ApiSchema<'SchemaSummaryDto'>>(
    adminKeys.database.summary(),
    ({ signal }) => databaseApi.getSchemaSummary(signal),
  );

  const listParams = { page: 1, limit: 100 };

  // The endpoint returns the platform page contract, so there is one shape to
  // read. The three-way sniff that used to live here existed only because the
  // response could have been a bare array, an `items` envelope or a `data` one.
  const schemasQuery = useAdminQuery<readonly SchemaItem[]>(
    adminKeys.database.tenantSchemas(listParams),
    ({ signal }) => databaseApi.getSchemas(listParams, signal).then((page) => page.data),
  );

  // The isolation check is evidence an operator reads, compares and quotes in
  // an incident. It used to be handed to `alert()` — a modal that cannot be
  // copied out of, is dismissed by the Enter key, and takes the issue list with
  // it. It renders in the detail panel now, and a failed check reports the
  // server's message instead of `Validation failed: …` around it.
  const validateIsolation = useAdminMutation<
    { valid: boolean; issues: string[] },
    { tenantId: string }
  >(({ tenantId }) => databaseApi.validateSchemaIsolation(tenantId));

  const summary = summaryQuery.data;
  const schemas = schemasQuery.data ?? [];

  const reload = (): void => {
    void summaryQuery.refetch();
    void schemasQuery.refetch();
  };

  const openSchema = (schema: SchemaItem): void => {
    validateIsolation.reset();
    setSelectedSchema(schema);
  };

  if (schemasQuery.isPending && summaryQuery.isPending) {
    return <LoadingSpinner message="Loading schemas..." />;
  }

  if (schemasQuery.error && schemas.length === 0) {
    return (
      <QueryFailureNotice
        errors={[schemasQuery.error, summaryQuery.error]}
        hasContent={false}
        onRetry={reload}
      />
    );
  }

  return (
    <div className="space-y-6">
      <QueryFailureNotice
        errors={[schemasQuery.error, summaryQuery.error, validateIsolation.error]}
        hasContent
        onRetry={reload}
      />

      {/* Platform totals — the server's aggregate over every schema, not a
          reduction over the hundred rows this page happens to list. An em dash
          when the aggregate did not load, so a failed read is never read as a
          platform with no tenants. */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">Total Schemas</div>
          <div className="text-2xl font-bold text-gray-900">
            {summary ? summary.totalSchemas.toLocaleString() : '—'}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">Active</div>
          <div className="text-2xl font-bold text-green-600">
            {summary ? summary.activeSchemas.toLocaleString() : '—'}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">Total Size</div>
          <div className="text-2xl font-bold text-blue-600">
            {summary ? formatBytes(summary.totalSizeBytes) : '—'}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">Total Tables</div>
          <div className="text-2xl font-bold text-purple-600">
            {summary ? summary.totalTableCount.toLocaleString() : '—'}
          </div>
        </div>
      </div>

      {/* Schema List */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
          <h3 className="text-lg font-medium text-gray-900">
            Tenant Schemas
            {summary && summary.totalSchemas > schemas.length && (
              <span className="ml-2 text-sm font-normal text-gray-500">
                showing {schemas.length.toLocaleString()} of {summary.totalSchemas.toLocaleString()}
              </span>
            )}
          </h3>
          <div className="flex space-x-3">
            {/* "Create Schema" sat here with no `onClick`. A tenant schema is
                provisioned by the tenant-creation flow — admin-api exposes no
                create-schema route at all — so the button could never have done
                anything, and a button that does nothing on a platform-admin
                page is worse than an absent one: the operator concludes the
                provisioning failed silently. */}
            <button
              onClick={reload}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 text-sm"
            >
              Refresh
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
                        onClick={() => openSchema(schema)}
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
                  onClick={() => validateIsolation.mutate({ tenantId: selectedSchema.tenantId })}
                  disabled={validateIsolation.isPending}
                  className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 text-sm disabled:opacity-50"
                >
                  {validateIsolation.isPending ? 'Validating…' : 'Validate Isolation'}
                </button>
              </div>
              {validateIsolation.error && (
                <div
                  className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700"
                  role="alert"
                >
                  {validateIsolation.error.message}
                </div>
              )}
              {validateIsolation.data &&
                (validateIsolation.data.valid ? (
                  <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-700">
                    Schema isolation is valid.
                  </div>
                ) : (
                  <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-800">
                    <div className="font-medium">
                      {validateIsolation.data.issues.length} isolation issue
                      {validateIsolation.data.issues.length === 1 ? '' : 's'}
                    </div>
                    <ul className="mt-2 list-inside list-disc space-y-1">
                      {validateIsolation.data.issues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  </div>
                ))}
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
  const plansQuery = useAdminQuery<MigrationPlan[]>(
    adminKeys.database.migrationPlans(),
    ({ signal }) => databaseApi.getAvailableMigrations(signal),
  );

  const historyParams = { page: 1, limit: 50 };

  const historyQuery = useAdminQuery<readonly SchemaMigration[]>(
    adminKeys.database.migrationHistory(historyParams),
    ({ signal }) =>
      databaseApi.getMigrationHistory(historyParams, signal).then((page) => page.data),
  );

  const plans = plansQuery.data ?? [];
  const history = historyQuery.data ?? [];

  const reload = (): void => {
    void plansQuery.refetch();
    void historyQuery.refetch();
  };

  if (plansQuery.isPending && historyQuery.isPending) {
    return <LoadingSpinner message="Loading migrations..." />;
  }

  // Either read failing used to replace the WHOLE tab with one error state, so
  // a history read that timed out hid the available-migrations list that had
  // loaded beside it. The notice sits above whichever half arrived.
  const hasContent = plans.length > 0 || history.length > 0;

  if (!hasContent && (plansQuery.error || historyQuery.error)) {
    return (
      <QueryFailureNotice
        errors={[plansQuery.error, historyQuery.error]}
        hasContent={false}
        onRetry={reload}
      />
    );
  }

  return (
    <div className="space-y-6">
      <QueryFailureNotice
        errors={[plansQuery.error, historyQuery.error]}
        hasContent
        onRetry={reload}
      />
      {/* Available Migrations */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
          <h3 className="text-lg font-medium text-gray-900">Available Migrations</h3>
          <div className="flex space-x-3">
            <button
              onClick={() => void plansQuery.refetch()}
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
            onClick={() => void historyQuery.refetch()}
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
                      <div className="text-xs text-gray-500">{migration.migrationName}</div>
                    </td>
                    <td className="px-6 py-4">
                      <StatusBadge status={migration.status} />
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500">
                      {/* A row IS one schema's run (ADMIN-MEDIUM-111); the
                          `appliedToSchemas` / `failedSchemas` counts this cell
                          used to show have no counterpart on it and always
                          rendered '-'. The affected tables are what the row
                          actually carries. */}
                      {migration.schemaName}
                      {migration.affectedTables.length > 0 && (
                        <span className="ml-1 text-gray-400">
                          ({migration.affectedTables.length} tables)
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500">
                      {migration.executedBy || '-'}
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

const SLOW_QUERY_PARAMS = { grouped: true, limit: 20 } as const;

const MonitoringTab: React.FC = () => {
  const healthQuery = useAdminQuery<DatabaseHealth>(adminKeys.database.health(), ({ signal }) =>
    databaseApi.getDatabaseHealth(signal),
  );

  const connectionsQuery = useAdminQuery<ConnectionStats>(
    adminKeys.database.connections(),
    ({ signal }) => databaseApi.getConnectionStats(signal),
  );

  const storageQuery = useAdminQuery<StorageInfo[]>(adminKeys.database.storage(), ({ signal }) =>
    databaseApi.getStorageByTenant(signal),
  );

  const slowQueriesQuery = useAdminQuery<SlowQueryItem[]>(
    adminKeys.database.slowQueries(SLOW_QUERY_PARAMS),
    ({ signal }) => databaseApi.getSlowQueries(SLOW_QUERY_PARAMS, signal),
  );

  const indexQuery = useAdminQuery<IndexRecommendation[]>(
    adminKeys.database.indexRecommendations(),
    ({ signal }) => databaseApi.getIndexRecommendations(undefined, signal),
  );

  if (healthQuery.isPending && connectionsQuery.isPending) {
    return <LoadingSpinner message="Loading monitoring data..." />;
  }

  const health = healthQuery.data;
  const connections = connectionsQuery.data;
  const storage = storageQuery.data ?? [];
  const slowQueries = slowQueriesQuery.data ?? [];
  const indexRecommendations = indexQuery.data ?? [];

  const queryErrors = [
    healthQuery.error,
    connectionsQuery.error,
    storageQuery.error,
    slowQueriesQuery.error,
    indexQuery.error,
  ];

  const reload = (): void => {
    void healthQuery.refetch();
    void connectionsQuery.refetch();
    void storageQuery.refetch();
    void slowQueriesQuery.refetch();
    void indexQuery.refetch();
  };

  return (
    <div className="space-y-6">
      {/* One notice naming every read that failed. Each section used to carry
          its own full-height ErrorState, so a page with three failures showed
          three stacked retry panels and no indication they were related. */}
      <QueryFailureNotice
        errors={queryErrors}
        hasContent={health !== undefined || connections !== undefined}
        onRetry={reload}
      />
      {/* Health Status */}
      {health ? (
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
                onClick={() => void healthQuery.refetch()}
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
      {connections ? (
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900">Connection Pool</h3>
            <button
              onClick={() => void connectionsQuery.refetch()}
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
      {storage.length > 0 ? (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
            <h3 className="text-lg font-medium text-gray-900">Storage by Tenant</h3>
            <button
              onClick={() => void storageQuery.refetch()}
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
      ) : !storageQuery.isPending && !storageQuery.error ? (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-2">Storage by Tenant</h3>
          <EmptyState message="No storage data available." />
        </div>
      ) : null}

      {/* Slow Queries */}
      {slowQueries.length > 0 ? (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
            <h3 className="text-lg font-medium text-gray-900">Slow Queries (Grouped)</h3>
            <button
              onClick={() => void slowQueriesQuery.refetch()}
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
      ) : !slowQueriesQuery.isPending && !slowQueriesQuery.error ? (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-2">Slow Queries</h3>
          <EmptyState message="No slow queries detected." />
        </div>
      ) : null}

      {/* Index Recommendations */}
      {indexRecommendations.length > 0 ? (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
            <h3 className="text-lg font-medium text-gray-900">Index Recommendations</h3>
            <button
              onClick={() => void indexQuery.refetch()}
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
      ) : !indexQuery.isPending && !indexQuery.error ? (
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
