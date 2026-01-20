/**
 * Database Management Page
 *
 * Schema yönetimi, migration, backup ve monitoring ana sayfası.
 */

import React, { useState, useEffect } from 'react';

// ============================================================================
// Types
// ============================================================================

type TabType = 'schemas' | 'migrations' | 'backups' | 'monitoring';

interface TenantSchema {
  id: string;
  tenantId: string;
  schemaName: string;
  status: 'creating' | 'active' | 'migrating' | 'suspended' | 'deleted';
  currentVersion: string;
  sizeBytes: number;
  tableCount: number;
  connectionCount: number;
  maxConnections: number;
  lastMigrationAt: string | null;
  lastBackupAt: string | null;
  createdAt: string;
}

interface Migration {
  id: string;
  tenantId: string | null;
  schemaName: string;
  migrationName: string;
  version: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'rolled_back';
  executionTimeMs: number;
  isDryRun: boolean;
  executedBy: string | null;
  createdAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

interface MigrationPlan {
  id: string;
  name: string;
  version: string;
  description: string;
  affectedTables: string[];
  estimatedDuration: number;
  isDestructive: boolean;
  requiresDowntime: boolean;
}

interface Backup {
  id: string;
  tenantId: string | null;
  schemaName: string;
  backupType: 'full' | 'incremental' | 'differential';
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'expired';
  fileName: string;
  sizeBytes: number;
  isCompressed: boolean;
  isEncrypted: boolean;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
}

interface DatabaseHealth {
  status: 'healthy' | 'warning' | 'critical';
  score: number;
  checks: Array<{
    name: string;
    status: 'pass' | 'warn' | 'fail';
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

interface SlowQuery {
  query: string;
  count: number;
  avgTime: number;
}

interface IndexRecommendation {
  tableName: string;
  columns: string[];
  indexType: string;
  reason: string;
  estimatedImpact: 'high' | 'medium' | 'low';
  createStatement: string;
}

// ============================================================================
// Mock Data
// ============================================================================

const mockSchemas: TenantSchema[] = [
  {
    id: '1',
    tenantId: 'tenant-001',
    schemaName: 'tenant_abc123_schema',
    status: 'active',
    currentVersion: '1.3.0',
    sizeBytes: 256000000,
    tableCount: 24,
    connectionCount: 5,
    maxConnections: 10,
    lastMigrationAt: '2024-01-15T10:30:00Z',
    lastBackupAt: '2024-01-20T02:00:00Z',
    createdAt: '2023-06-01T00:00:00Z',
  },
  {
    id: '2',
    tenantId: 'tenant-002',
    schemaName: 'tenant_def456_schema',
    status: 'active',
    currentVersion: '1.2.0',
    sizeBytes: 512000000,
    tableCount: 24,
    connectionCount: 8,
    maxConnections: 10,
    lastMigrationAt: '2024-01-10T08:00:00Z',
    lastBackupAt: '2024-01-20T02:00:00Z',
    createdAt: '2023-07-15T00:00:00Z',
  },
  {
    id: '3',
    tenantId: 'tenant-003',
    schemaName: 'tenant_ghi789_schema',
    status: 'suspended',
    currentVersion: '1.1.0',
    sizeBytes: 128000000,
    tableCount: 18,
    connectionCount: 0,
    maxConnections: 10,
    lastMigrationAt: '2023-12-01T00:00:00Z',
    lastBackupAt: '2024-01-15T02:00:00Z',
    createdAt: '2023-08-20T00:00:00Z',
  },
];

const mockMigrationPlans: MigrationPlan[] = [
  {
    id: 'migration_1_0_0',
    name: 'initial_schema',
    version: '1.0.0',
    description: 'Initial schema setup with metadata and audit tables',
    affectedTables: ['_metadata', '_audit_log'],
    estimatedDuration: 5000,
    isDestructive: false,
    requiresDowntime: false,
  },
  {
    id: 'migration_1_1_0',
    name: 'add_tenant_settings',
    version: '1.1.0',
    description: 'Add tenant-specific settings table',
    affectedTables: ['tenant_settings'],
    estimatedDuration: 7000,
    isDestructive: false,
    requiresDowntime: false,
  },
  {
    id: 'migration_1_2_0',
    name: 'add_data_export_logs',
    version: '1.2.0',
    description: 'Add data export tracking table',
    affectedTables: ['data_exports'],
    estimatedDuration: 7000,
    isDestructive: false,
    requiresDowntime: false,
  },
  {
    id: 'migration_1_3_0',
    name: 'add_activity_tracking',
    version: '1.3.0',
    description: 'Add user activity tracking table',
    affectedTables: ['user_activities'],
    estimatedDuration: 9000,
    isDestructive: false,
    requiresDowntime: false,
  },
];

const mockMigrations: Migration[] = [
  {
    id: '1',
    tenantId: 'tenant-001',
    schemaName: 'tenant_abc123_schema',
    migrationName: 'add_activity_tracking',
    version: '1.3.0',
    status: 'completed',
    executionTimeMs: 8500,
    isDryRun: false,
    executedBy: 'admin@example.com',
    createdAt: '2024-01-15T10:30:00Z',
    completedAt: '2024-01-15T10:30:08Z',
    errorMessage: null,
  },
  {
    id: '2',
    tenantId: 'tenant-002',
    schemaName: 'tenant_def456_schema',
    migrationName: 'add_data_export_logs',
    version: '1.2.0',
    status: 'completed',
    executionTimeMs: 6200,
    isDryRun: false,
    executedBy: 'admin@example.com',
    createdAt: '2024-01-10T08:00:00Z',
    completedAt: '2024-01-10T08:00:06Z',
    errorMessage: null,
  },
  {
    id: '3',
    tenantId: null,
    schemaName: 'all',
    migrationName: 'batch_migration_1.1.0',
    version: '1.1.0',
    status: 'completed',
    executionTimeMs: 45000,
    isDryRun: false,
    executedBy: 'admin@example.com',
    createdAt: '2024-01-05T00:00:00Z',
    completedAt: '2024-01-05T00:00:45Z',
    errorMessage: null,
  },
];

const mockBackups: Backup[] = [
  {
    id: '1',
    tenantId: 'tenant-001',
    schemaName: 'tenant_abc123_schema',
    backupType: 'full',
    status: 'completed',
    fileName: 'backup_tenant_abc123_full_2024-01-20.sql.gz',
    sizeBytes: 45000000,
    isCompressed: true,
    isEncrypted: false,
    createdAt: '2024-01-20T02:00:00Z',
    completedAt: '2024-01-20T02:05:00Z',
    expiresAt: '2024-02-19T02:00:00Z',
  },
  {
    id: '2',
    tenantId: 'tenant-002',
    schemaName: 'tenant_def456_schema',
    backupType: 'incremental',
    status: 'completed',
    fileName: 'backup_tenant_def456_incr_2024-01-20.sql.gz',
    sizeBytes: 12000000,
    isCompressed: true,
    isEncrypted: false,
    createdAt: '2024-01-20T02:00:00Z',
    completedAt: '2024-01-20T02:02:00Z',
    expiresAt: '2024-01-27T02:00:00Z',
  },
  {
    id: '3',
    tenantId: null,
    schemaName: 'all',
    backupType: 'full',
    status: 'in_progress',
    fileName: 'backup_all_full_2024-01-21.sql.gz',
    sizeBytes: 0,
    isCompressed: true,
    isEncrypted: true,
    createdAt: '2024-01-21T02:00:00Z',
    completedAt: null,
    expiresAt: null,
  },
];

const mockHealth: DatabaseHealth = {
  status: 'healthy',
  score: 92,
  checks: [
    { name: 'Connection Pool', status: 'pass', value: '35%', message: 'Connection pool healthy' },
    { name: 'Cache Hit Ratio', status: 'pass', value: '97.2%', message: 'Cache performing well' },
    { name: 'Slow Queries', status: 'warn', value: 15, message: 'Elevated slow query count' },
    { name: 'Replication', status: 'pass', value: 'N/A', message: 'Single node configuration' },
  ],
  recommendations: [
    'Review slow queries and add appropriate indexes',
  ],
};

const mockConnections: ConnectionStats = {
  total: 35,
  active: 12,
  idle: 23,
  waiting: 0,
  maxConnections: 100,
  utilizationPercent: 35,
};

const mockStorage: StorageInfo[] = [
  { tenantId: 'tenant-001', schemaName: 'tenant_abc123_schema', totalSizeBytes: 256000000, dataSizeBytes: 180000000, indexSizeBytes: 76000000, tableCount: 24 },
  { tenantId: 'tenant-002', schemaName: 'tenant_def456_schema', totalSizeBytes: 512000000, dataSizeBytes: 380000000, indexSizeBytes: 132000000, tableCount: 24 },
  { tenantId: 'tenant-003', schemaName: 'tenant_ghi789_schema', totalSizeBytes: 128000000, dataSizeBytes: 95000000, indexSizeBytes: 33000000, tableCount: 18 },
];

const mockSlowQueries: SlowQuery[] = [
  { query: 'SELECT * FROM sensor_readings WHERE recorded_at >= ? AND recorded_at <= ?', count: 45, avgTime: 2500 },
  { query: 'SELECT * FROM user_activities WHERE user_id = ?', count: 23, avgTime: 1800 },
  { query: 'SELECT * FROM audit_log WHERE created_at >= ?', count: 18, avgTime: 1500 },
];

const mockIndexRecommendations: IndexRecommendation[] = [
  {
    tableName: 'tenant_abc123_schema.sensor_readings',
    columns: ['recorded_at', 'sensor_id'],
    indexType: 'btree',
    reason: 'High sequential scan count (45000) with 1500000 rows',
    estimatedImpact: 'high',
    createStatement: 'CREATE INDEX idx_sensor_readings_recorded_sensor ON "tenant_abc123_schema"."sensor_readings" ("recorded_at", "sensor_id")',
  },
  {
    tableName: 'tenant_def456_schema.user_activities',
    columns: ['user_id', 'created_at'],
    indexType: 'btree',
    reason: 'High sequential scan count (12000) with 500000 rows',
    estimatedImpact: 'medium',
    createStatement: 'CREATE INDEX idx_user_activities_user_created ON "tenant_def456_schema"."user_activities" ("user_id", "created_at")',
  },
];

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

const formatDate = (dateStr: string | null): string => {
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
      return 'text-red-600 bg-red-100';
    case 'rolled_back':
      return 'text-purple-600 bg-purple-100';
    default:
      return 'text-gray-600 bg-gray-100';
  }
};

// ============================================================================
// Components
// ============================================================================

const StatusBadge: React.FC<{ status: string }> = ({ status }) => (
  <span className={`px-2 py-1 text-xs font-medium rounded-full ${getStatusColor(status)}`}>
    {status.replace(/_/g, ' ')}
  </span>
);

const ProgressBar: React.FC<{ value: number; max: number; color?: string }> = ({
  value,
  max,
  color = 'bg-blue-500'
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

// Schema Tab Component
const SchemasTab: React.FC<{ schemas: TenantSchema[] }> = ({ schemas }) => {
  const [selectedSchema, setSelectedSchema] = useState<TenantSchema | null>(null);

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
            {schemas.filter(s => s.status === 'active').length}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">Total Size</div>
          <div className="text-2xl font-bold text-blue-600">
            {formatBytes(schemas.reduce((sum, s) => sum + s.sizeBytes, 0))}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">Total Tables</div>
          <div className="text-2xl font-bold text-purple-600">
            {schemas.reduce((sum, s) => sum + s.tableCount, 0)}
          </div>
        </div>
      </div>

      {/* Schema List */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
          <h3 className="text-lg font-medium text-gray-900">Tenant Schemas</h3>
          <button className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
            Create Schema
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Schema Name</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Version</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Size</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Tables</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Connections</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last Backup</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {schemas.map((schema) => (
                <tr key={schema.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div className="text-sm font-medium text-gray-900">{schema.schemaName}</div>
                    <div className="text-xs text-gray-500">Tenant: {schema.tenantId}</div>
                  </td>
                  <td className="px-6 py-4">
                    <StatusBadge status={schema.status} />
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">{schema.currentVersion}</td>
                  <td className="px-6 py-4 text-sm text-gray-500">{formatBytes(schema.sizeBytes)}</td>
                  <td className="px-6 py-4 text-sm text-gray-500">{schema.tableCount}</td>
                  <td className="px-6 py-4">
                    <div className="flex items-center space-x-2">
                      <span className="text-sm text-gray-500">
                        {schema.connectionCount}/{schema.maxConnections}
                      </span>
                      <ProgressBar
                        value={schema.connectionCount}
                        max={schema.maxConnections}
                        color={schema.connectionCount > schema.maxConnections * 0.8 ? 'bg-red-500' : 'bg-green-500'}
                      />
                    </div>
                  </td>
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
                      {schema.status === 'active' ? (
                        <button className="text-yellow-600 hover:text-yellow-800 text-sm">
                          Suspend
                        </button>
                      ) : schema.status === 'suspended' ? (
                        <button className="text-green-600 hover:text-green-800 text-sm">
                          Activate
                        </button>
                      ) : null}
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
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
              <h3 className="text-lg font-medium text-gray-900">Schema Details</h3>
              <button onClick={() => setSelectedSchema(null)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
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
                  <div className="font-medium">{formatBytes(selectedSchema.sizeBytes)}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Tables</div>
                  <div className="font-medium">{selectedSchema.tableCount}</div>
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
                <button className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
                  Run Migration
                </button>
                <button className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm">
                  Create Backup
                </button>
                <button className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 text-sm">
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

// Migrations Tab Component
const MigrationsTab: React.FC<{
  plans: MigrationPlan[];
  history: Migration[];
}> = ({ plans, history }) => {
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      {/* Available Migrations */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
          <h3 className="text-lg font-medium text-gray-900">Available Migrations</h3>
          <button
            onClick={() => setShowBatchModal(true)}
            className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm"
          >
            Batch Migration
          </button>
        </div>
        <div className="p-6 space-y-4">
          {plans.map((plan) => (
            <div
              key={plan.id}
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
                  <div className="flex items-center space-x-4 mt-2 text-xs text-gray-400">
                    <span>Tables: {plan.affectedTables.join(', ')}</span>
                    <span>Est. Duration: {formatDuration(plan.estimatedDuration)}</span>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedVersion(plan.version)}
                  className="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
                >
                  Run
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Migration History */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">Migration History</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Migration</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Schema</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Duration</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Executed By</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {history.map((migration) => (
                <tr key={migration.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div className="text-sm font-medium text-gray-900">{migration.version}</div>
                    <div className="text-xs text-gray-500">{migration.migrationName}</div>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {migration.tenantId ? migration.schemaName : 'All Schemas'}
                  </td>
                  <td className="px-6 py-4">
                    <StatusBadge status={migration.status} />
                    {migration.isDryRun && (
                      <span className="ml-2 px-2 py-1 text-xs font-medium rounded-full bg-gray-100 text-gray-600">
                        Dry Run
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {formatDuration(migration.executionTimeMs)}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {migration.executedBy || '-'}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {formatDate(migration.createdAt)}
                  </td>
                  <td className="px-6 py-4">
                    {migration.status === 'completed' && (
                      <button className="text-red-600 hover:text-red-800 text-sm">
                        Rollback
                      </button>
                    )}
                    {migration.status === 'failed' && migration.errorMessage && (
                      <button className="text-blue-600 hover:text-blue-800 text-sm">
                        View Error
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Batch Migration Modal */}
      {showBatchModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
            <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
              <h3 className="text-lg font-medium text-gray-900">Batch Migration</h3>
              <button onClick={() => setShowBatchModal(false)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Select Migration Version
                </label>
                <select className="w-full border border-gray-300 rounded-lg px-3 py-2">
                  {plans.map((plan) => (
                    <option key={plan.version} value={plan.version}>
                      {plan.version} - {plan.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center space-x-2">
                <input type="checkbox" id="dryRun" className="rounded border-gray-300" />
                <label htmlFor="dryRun" className="text-sm text-gray-700">
                  Dry Run (test without applying changes)
                </label>
              </div>
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                <p className="text-sm text-yellow-800">
                  This will apply the migration to all active tenant schemas.
                  Make sure to have recent backups before proceeding.
                </p>
              </div>
              <div className="flex justify-end space-x-3 pt-4">
                <button
                  onClick={() => setShowBatchModal(false)}
                  className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
                >
                  Cancel
                </button>
                <button className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700">
                  Start Batch Migration
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Backups Tab Component
const BackupsTab: React.FC<{ backups: Backup[] }> = ({ backups }) => {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [selectedBackup, setSelectedBackup] = useState<Backup | null>(null);

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">Total Backups</div>
          <div className="text-2xl font-bold text-gray-900">{backups.length}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">Completed</div>
          <div className="text-2xl font-bold text-green-600">
            {backups.filter(b => b.status === 'completed').length}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">Total Size</div>
          <div className="text-2xl font-bold text-blue-600">
            {formatBytes(backups.filter(b => b.status === 'completed').reduce((sum, b) => sum + b.sizeBytes, 0))}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">In Progress</div>
          <div className="text-2xl font-bold text-yellow-600">
            {backups.filter(b => b.status === 'in_progress').length}
          </div>
        </div>
      </div>

      {/* Backup Schedule */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Backup Schedule</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
            <div>
              <div className="font-medium text-gray-900">Daily Incremental</div>
              <div className="text-sm text-gray-500">Every day at 2:00 AM</div>
            </div>
            <StatusBadge status="active" />
          </div>
          <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
            <div>
              <div className="font-medium text-gray-900">Weekly Full</div>
              <div className="text-sm text-gray-500">Every Sunday at 3:00 AM</div>
            </div>
            <StatusBadge status="active" />
          </div>
        </div>
      </div>

      {/* Backup List */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
          <h3 className="text-lg font-medium text-gray-900">Backups</h3>
          <div className="flex space-x-3">
            <button
              onClick={() => setShowRestoreModal(true)}
              className="px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 text-sm"
            >
              Point-in-Time Recovery
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
            >
              Create Backup
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Backup</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Size</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Options</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Expires</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {backups.map((backup) => (
                <tr key={backup.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div className="text-sm font-medium text-gray-900">{backup.fileName}</div>
                    <div className="text-xs text-gray-500">{backup.schemaName}</div>
                  </td>
                  <td className="px-6 py-4">
                    <StatusBadge status={backup.backupType} />
                  </td>
                  <td className="px-6 py-4">
                    <StatusBadge status={backup.status} />
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {backup.status === 'completed' ? formatBytes(backup.sizeBytes) : '-'}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex space-x-2">
                      {backup.isCompressed && (
                        <span className="px-2 py-0.5 text-xs bg-blue-100 text-blue-600 rounded">
                          Compressed
                        </span>
                      )}
                      {backup.isEncrypted && (
                        <span className="px-2 py-0.5 text-xs bg-purple-100 text-purple-600 rounded">
                          Encrypted
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {formatDate(backup.createdAt)}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {formatDate(backup.expiresAt)}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex space-x-2">
                      {backup.status === 'completed' && (
                        <>
                          <button
                            onClick={() => setSelectedBackup(backup)}
                            className="text-green-600 hover:text-green-800 text-sm"
                          >
                            Restore
                          </button>
                          <button className="text-blue-600 hover:text-blue-800 text-sm">
                            Download
                          </button>
                        </>
                      )}
                      <button className="text-red-600 hover:text-red-800 text-sm">
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Backup Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
            <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
              <h3 className="text-lg font-medium text-gray-900">Create Backup</h3>
              <button onClick={() => setShowCreateModal(false)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Target</label>
                <select className="w-full border border-gray-300 rounded-lg px-3 py-2">
                  <option value="">All Schemas</option>
                  <option value="tenant-001">tenant_abc123_schema</option>
                  <option value="tenant-002">tenant_def456_schema</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Backup Type</label>
                <select className="w-full border border-gray-300 rounded-lg px-3 py-2">
                  <option value="full">Full Backup</option>
                  <option value="incremental">Incremental</option>
                  <option value="differential">Differential</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Retention (days)</label>
                <input
                  type="number"
                  defaultValue={30}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>
              <div className="flex items-center space-x-4">
                <label className="flex items-center space-x-2">
                  <input type="checkbox" defaultChecked className="rounded border-gray-300" />
                  <span className="text-sm text-gray-700">Compress</span>
                </label>
                <label className="flex items-center space-x-2">
                  <input type="checkbox" className="rounded border-gray-300" />
                  <span className="text-sm text-gray-700">Encrypt</span>
                </label>
              </div>
              <div className="flex justify-end space-x-3 pt-4">
                <button
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
                >
                  Cancel
                </button>
                <button className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                  Create Backup
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Restore Modal */}
      {(showRestoreModal || selectedBackup) && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
            <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
              <h3 className="text-lg font-medium text-gray-900">
                {selectedBackup ? 'Restore from Backup' : 'Point-in-Time Recovery'}
              </h3>
              <button
                onClick={() => {
                  setShowRestoreModal(false);
                  setSelectedBackup(null);
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-6 space-y-4">
              {selectedBackup ? (
                <div className="bg-gray-50 rounded-lg p-4">
                  <div className="text-sm text-gray-500">Selected Backup</div>
                  <div className="font-medium">{selectedBackup.fileName}</div>
                  <div className="text-xs text-gray-400">Created: {formatDate(selectedBackup.createdAt)}</div>
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Target Tenant</label>
                    <select className="w-full border border-gray-300 rounded-lg px-3 py-2">
                      <option value="tenant-001">tenant_abc123_schema</option>
                      <option value="tenant-002">tenant_def456_schema</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Recovery Point</label>
                    <input
                      type="datetime-local"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2"
                    />
                  </div>
                </>
              )}
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-sm text-red-800">
                  Warning: This will overwrite existing data in the target schema.
                  This action cannot be undone.
                </p>
              </div>
              <div className="flex justify-end space-x-3 pt-4">
                <button
                  onClick={() => {
                    setShowRestoreModal(false);
                    setSelectedBackup(null);
                  }}
                  className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
                >
                  Cancel
                </button>
                <button className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700">
                  Start Restore
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Monitoring Tab Component
const MonitoringTab: React.FC<{
  health: DatabaseHealth;
  connections: ConnectionStats;
  storage: StorageInfo[];
  slowQueries: SlowQuery[];
  indexRecommendations: IndexRecommendation[];
}> = ({ health, connections, storage, slowQueries, indexRecommendations }) => {
  return (
    <div className="space-y-6">
      {/* Health Status */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-gray-900">Database Health</h3>
          <div className="flex items-center space-x-3">
            <span className={`text-3xl font-bold ${
              health.status === 'healthy' ? 'text-green-600' :
              health.status === 'warning' ? 'text-yellow-600' : 'text-red-600'
            }`}>
              {health.score}
            </span>
            <StatusBadge status={health.status} />
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

      {/* Connection Stats */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Connection Pool</h3>
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
            <span className="text-sm font-medium">{connections.utilizationPercent.toFixed(1)}%</span>
          </div>
          <ProgressBar
            value={connections.total}
            max={connections.maxConnections}
            color={connections.utilizationPercent > 80 ? 'bg-red-500' : connections.utilizationPercent > 60 ? 'bg-yellow-500' : 'bg-green-500'}
          />
        </div>
      </div>

      {/* Storage by Tenant */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">Storage by Tenant</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Schema</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Total Size</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Data</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Indexes</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Tables</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Distribution</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {storage.map((item) => {
                const totalStorage = storage.reduce((sum, s) => sum + s.totalSizeBytes, 0);
                const percentage = totalStorage > 0 ? (item.totalSizeBytes / totalStorage) * 100 : 0;
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
                    <td className="px-6 py-4 text-sm text-gray-500">
                      {item.tableCount}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center space-x-2">
                        <ProgressBar value={percentage} max={100} />
                        <span className="text-sm text-gray-500">{percentage.toFixed(1)}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Slow Queries */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">Slow Queries (Grouped)</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Query Pattern</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Count</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Avg Time</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {slowQueries.map((query, idx) => (
                <tr key={idx} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <code className="text-sm text-gray-700 bg-gray-100 px-2 py-1 rounded">
                      {query.query.length > 80 ? query.query.substring(0, 80) + '...' : query.query}
                    </code>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">{query.count}</td>
                  <td className="px-6 py-4">
                    <span className={`text-sm font-medium ${
                      query.avgTime > 2000 ? 'text-red-600' : 'text-yellow-600'
                    }`}>
                      {formatDuration(query.avgTime)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Index Recommendations */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">Index Recommendations</h3>
        </div>
        <div className="p-6 space-y-4">
          {indexRecommendations.map((rec, idx) => (
            <div key={idx} className="border border-gray-200 rounded-lg p-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center space-x-2">
                    <span className="font-medium text-gray-900">{rec.tableName}</span>
                    <span className={`px-2 py-0.5 text-xs rounded-full ${
                      rec.estimatedImpact === 'high' ? 'bg-red-100 text-red-600' :
                      rec.estimatedImpact === 'medium' ? 'bg-yellow-100 text-yellow-600' :
                      'bg-green-100 text-green-600'
                    }`}>
                      {rec.estimatedImpact} impact
                    </span>
                  </div>
                  <p className="text-sm text-gray-500 mt-1">{rec.reason}</p>
                  <code className="block text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded mt-2">
                    {rec.createStatement}
                  </code>
                </div>
                <button className="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm">
                  Apply
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
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
    { id: 'backups', label: 'Backups' },
    { id: 'monitoring', label: 'Monitoring' },
  ];

  return (
    <div className="p-6 bg-gray-100 min-h-screen">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Database Management</h1>
        <p className="text-gray-500">
          Multi-tenant schema yönetimi, migration, backup ve performans izleme
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
      {activeTab === 'schemas' && <SchemasTab schemas={mockSchemas} />}
      {activeTab === 'migrations' && (
        <MigrationsTab plans={mockMigrationPlans} history={mockMigrations} />
      )}
      {activeTab === 'backups' && <BackupsTab backups={mockBackups} />}
      {activeTab === 'monitoring' && (
        <MonitoringTab
          health={mockHealth}
          connections={mockConnections}
          storage={mockStorage}
          slowQueries={mockSlowQueries}
          indexRecommendations={mockIndexRecommendations}
        />
      )}
    </div>
  );
};

export default DatabaseManagementPage;
