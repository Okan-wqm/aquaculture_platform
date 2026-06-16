import React, { useState, useMemo, useCallback } from 'react';
import {
  Table,
  HardDrive,
  Activity,
  Clock,
  RefreshCw,
  Download,
  ChevronRight,
  ChevronDown,
  CheckCircle,
  AlertCircle,
  Info,
  Server,
  Layers,
  Loader2,
  Warehouse,
  Users,
  Cpu,
  Database,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useTenantDatabase,
  useTableSchema,
  useTableData,
  tenantKeys,
} from '../hooks/useTenantData';
import type { ColumnInfo, IndexInfo } from '../services/tenant-api.service';
import { TableSchemaModal } from '../components/TableSchemaModal';
import { TableDataModal } from '../components/TableDataModal';

/**
 * Module table mappings - matches MODULE_SCHEMAS from schema-manager.service.ts
 */
const MODULE_TABLES: Record<string, string[]> = {
  sensor: [
    'sensors', 'sensor_readings', 'sensor_metrics', 'sensor_data_channels', 'sensor_protocols',
    'processes', 'vfd_devices', 'vfd_readings', 'vfd_register_mappings',
    'dashboard_layouts', 'edge_devices', 'device_io_configs',
    'plc_connections', 'plc_alarms', 'plc_telemetry', 'feeding_parameters',
    'automation_programs', 'program_steps', 'program_transitions', 'program_variables', 'step_actions',
  ],
  farm: [
    'farms', 'sites', 'departments', 'ponds', 'tanks', 'tank_allocations', 'tank_batches', 'tank_operations',
    'batches', 'batches_v2', 'batch_documents', 'batch_feed_assignments', 'batch_locations', 'species',
    'systems', 'sub_systems', 'equipment_types', 'equipment', 'equipment_systems', 'sub_equipment_types', 'sub_equipment',
    'maintenance_schedules', 'work_orders', 'spare_parts',
    'feed_types', 'feed_type_species', 'feeds', 'feed_inventory', 'feed_sites', 'feeding_protocols', 'feeding_records', 'feeding_tables', 'feeding_programs', 'feeding_program_tanks', 'daily_feeding_executions',
    'chemical_types', 'chemicals', 'chemical_sites',
    'growth_measurements', 'mortality_records', 'water_quality_measurements', 'health_events', 'harvest_plans', 'harvest_records',
    'supplier_types', 'suppliers',
    'code_sequences', 'farm_audit_logs', 'regulatory_settings', 'sentinel_hub_settings',
  ],
  hr: [
    'employees', 'payrolls',
    'leave_types', 'leave_balances', 'leave_requests',
    'shifts', 'schedules', 'schedule_entries', 'scheduling_settings', 'attendance_records',
    'weekly_plans', 'weekly_plan_entries',
    'training_courses', 'training_enrollments',
    'certification_types', 'employee_certifications',
    'work_areas', 'work_rotations', 'safety_training_records',
  ],
};

/**
 * Module configuration with display info
 */
const MODULE_CONFIG: Record<string, { label: string; icon: React.ReactNode; color: string; bgColor: string }> = {
  farm: {
    label: 'Farm Module',
    icon: <Warehouse className="w-5 h-5" />,
    color: 'text-green-600',
    bgColor: 'bg-green-50',
  },
  sensor: {
    label: 'Sensor Module',
    icon: <Cpu className="w-5 h-5" />,
    color: 'text-blue-600',
    bgColor: 'bg-blue-50',
  },
  hr: {
    label: 'HR Module',
    icon: <Users className="w-5 h-5" />,
    color: 'text-purple-600',
    bgColor: 'bg-purple-50',
  },
  other: {
    label: 'Other Tables',
    icon: <Database className="w-5 h-5" />,
    color: 'text-gray-600',
    bgColor: 'bg-gray-50',
  },
};

/**
 * PERF-013 / MED-02: Parse size strings (e.g. "1.2 MB") to bytes for numeric comparison.
 * Extracted as module-level utility so it can be referenced inside useMemo without
 * being recreated on every render.
 */
const parseSize = (s: string): number => {
  const m = s.match(/^([\d.]+)\s*(B|KB|MB|GB|TB)?$/i);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const units: Record<string, number> = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 };
  return val * (units[(m[2] || 'B').toUpperCase()] ?? 1);
};

/**
 * Get module name from table name
 */
const getModuleFromTableName = (fullTableName: string): string => {
  // Extract just the table name from "schema.table_name" format
  const parts = fullTableName.split('.');
  const tableName = parts[parts.length - 1];

  for (const [module, tables] of Object.entries(MODULE_TABLES)) {
    if (tables.includes(tableName)) {
      return module;
    }
  }
  return 'other';
};

/**
 * Status badge component
 */
const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const statusConfig: Record<string, { bg: string; text: string; icon: React.ReactNode; label: string }> = {
    healthy: {
      bg: 'bg-green-100',
      text: 'text-green-700',
      icon: <CheckCircle className="w-4 h-4" />,
      label: 'Healthy',
    },
    warning: {
      bg: 'bg-yellow-100',
      text: 'text-yellow-700',
      icon: <AlertCircle className="w-4 h-4" />,
      label: 'Warning',
    },
    error: {
      bg: 'bg-red-100',
      text: 'text-red-700',
      icon: <AlertCircle className="w-4 h-4" />,
      label: 'Error',
    },
    unhealthy: {
      bg: 'bg-red-100',
      text: 'text-red-700',
      icon: <AlertCircle className="w-4 h-4" />,
      label: 'Unhealthy',
    },
  };

  const config = statusConfig[status] || statusConfig.warning;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium ${config.bg} ${config.text}`}
    >
      {config.icon}
      {config.label}
    </span>
  );
};

/**
 * Stat card component
 */
const StatCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string | number;
  subValue?: string;
  color: 'green' | 'blue' | 'purple' | 'yellow';
}> = ({ icon, label, value, subValue, color }) => {
  const colorClasses = {
    green: 'bg-green-50 text-green-600',
    blue: 'bg-blue-50 text-blue-600',
    purple: 'bg-purple-50 text-purple-600',
    yellow: 'bg-yellow-50 text-yellow-600',
  };

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-6">
      <div className="flex items-center gap-4">
        <div className={`p-3 rounded-xl ${colorClasses[color]}`}>{icon}</div>
        <div>
          <p className="text-sm text-gray-500">{label}</p>
          <p className="text-2xl font-bold text-gray-900">{value}</p>
          {subValue && <p className="text-xs text-gray-500">{subValue}</p>}
        </div>
      </div>
    </div>
  );
};

/**
 * TenantDatabase Page
 *
 * Database information page for tenant admin.
 * Features:
 * - Database overview and status
 * - Table list with statistics
 * - Storage usage
 * - Connection info
 * - Backup status
 */
const TenantDatabase: React.FC = () => {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'rows' | 'size'>('name');

  // Module grouping state - all modules expanded by default
  const [expandedModules, setExpandedModules] = useState<Record<string, boolean>>({
    farm: true,
    sensor: true,
    hr: true,
    other: true,
  });

  // Schema modal state
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [selectedSchemaName, setSelectedSchemaName] = useState('');
  const [selectedTableOnly, setSelectedTableOnly] = useState('');

  // Data modal state
  const [dataTableName, setDataTableName] = useState<string | null>(null);
  const [dataSchemaName, setDataSchemaName] = useState('');
  const [dataTableOnly, setDataTableOnly] = useState('');
  const [dataOffset, setDataOffset] = useState(0);
  const DATA_PAGE_SIZE = 50;

  // TanStack Query hooks
  const { data: databaseInfo, isLoading: loading, error: dbError } = useTenantDatabase();
  const error = dbError ? (dbError as Error).message : null;

  // Schema query - enabled only when a table is selected
  const { data: schemaData, isLoading: schemaLoading, error: schemaQueryError } = useTableSchema(
    selectedSchemaName,
    selectedTableOnly,
    !!selectedTable,
  );
  const schemaColumns: ColumnInfo[] = schemaData?.columns || [];
  const schemaIndexes: IndexInfo[] = schemaData?.indexes || [];
  const schemaError = schemaQueryError ? (schemaQueryError as Error).message : null;

  // Data query - enabled only when a data table is selected
  const { data: tableData, isLoading: dataLoading, error: dataQueryError } = useTableData({
    schemaName: dataSchemaName,
    tableName: dataTableOnly,
    limit: DATA_PAGE_SIZE,
    offset: dataOffset,
    enabled: !!dataTableName,
  });
  const dataError = dataQueryError ? (dataQueryError as Error).message : null;

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: tenantKeys.database() });
  };

  // Handle View Schema button click
  const handleViewSchema = (tableName: string) => {
    const parts = tableName.split('.');
    const schemaName = parts.length > 1 ? parts[0] : 'public';
    const tableOnly = parts.length > 1 ? parts[1] : parts[0];
    setSelectedTable(tableName);
    setSelectedSchemaName(schemaName);
    setSelectedTableOnly(tableOnly);
  };

  // Close schema modal
  const handleCloseSchemaModal = () => {
    setSelectedTable(null);
    setSelectedSchemaName('');
    setSelectedTableOnly('');
  };

  // Handle View Data button click
  const handleViewData = (fullTableName: string, offset = 0) => {
    const parts = fullTableName.split('.');
    const schemaName = parts.length > 1 ? parts[0] : 'public';
    const tableName = parts.length > 1 ? parts[1] : parts[0];
    setDataTableName(fullTableName);
    setDataSchemaName(schemaName);
    setDataTableOnly(tableName);
    setDataOffset(offset);
  };

  // Handle page change in data modal
  const handleDataPageChange = (newOffset: number) => {
    if (dataTableName) {
      setDataOffset(newOffset);
    }
  };

  // Close data modal
  const handleCloseDataModal = () => {
    setDataTableName(null);
    setDataSchemaName('');
    setDataTableOnly('');
    setDataOffset(0);
  };

  // Format number with commas
  const formatNumber = (num: number): string => {
    return num.toLocaleString();
  };

  // Format date
  const formatDate = (date: Date | string): string => {
    const d = new Date(date);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    return `${days} day${days > 1 ? 's' : ''} ago`;
  };

  // MED-02: Filter and sort tables — memoized to avoid recomputation on unrelated re-renders
  const tables = databaseInfo?.tables || [];
  const filteredTables = useMemo(
    () =>
      tables
        .filter((table) =>
          table.name.toLowerCase().includes(searchQuery.toLowerCase())
        )
        .sort((a, b) => {
          if (sortBy === 'name') return a.name.localeCompare(b.name);
          if (sortBy === 'rows') return b.rowCount - a.rowCount;
          return parseSize(b.size) - parseSize(a.size);
        }),
    [tables, searchQuery, sortBy],
  );

  // Group tables by module — preserve the order from filteredTables (BUG-020)
  const groupedTables = useMemo(() => {
    const groups: Record<string, typeof filteredTables> = {
      farm: [],
      sensor: [],
      hr: [],
      other: [],
    };

    filteredTables.forEach((table) => {
      const module = getModuleFromTableName(table.name);
      groups[module].push(table);
      // Do NOT re-sort within groups — filteredTables already carries the
      // user's chosen sort order (name / rows / size) and re-sorting here
      // would silently discard that preference.
    });

    return groups;
  }, [filteredTables]);

  // Toggle module expansion
  const toggleModule = useCallback((module: string) => {
    setExpandedModules((prev) => ({
      ...prev,
      [module]: !prev[module],
    }));
  }, []);

  // Get module stats
  const getModuleStats = (module: string) => {
    const moduleTables = groupedTables[module] || [];
    const totalRows = moduleTables.reduce((sum, t) => sum + t.rowCount, 0);
    return {
      tableCount: moduleTables.length,
      totalRows,
    };
  };

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-tenant-600 mx-auto" />
          <p className="mt-2 text-sm text-gray-500">Loading database information...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <AlertCircle className="w-8 h-8 text-red-500 mx-auto" />
          <p className="mt-2 text-sm text-gray-900 font-medium">Failed to load database info</p>
          <p className="mt-1 text-sm text-gray-500">{error}</p>
          <button
            onClick={handleRefresh}
            className="mt-4 px-4 py-2 text-sm font-medium text-white bg-tenant-600 rounded-lg hover:bg-tenant-700"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  if (!databaseInfo) {
    return null;
  }

  const utilizationPercent = databaseInfo.maxConnections > 0
    ? Math.round((databaseInfo.activeConnections / databaseInfo.maxConnections) * 100)
    : 0;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Database</h1>
          <p className="text-sm text-gray-500 mt-1">
            View your tenant database information and statistics
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleRefresh}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
          <button className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-tenant-600 rounded-lg hover:bg-tenant-700 transition-colors">
            <Download className="w-4 h-4" />
            Export Schema
          </button>
        </div>
      </div>

      {/* Info Banner */}
      <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
        <div className="flex gap-3">
          <Info className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-blue-800 font-medium">
              Database Information
            </p>
            <p className="text-sm text-blue-700 mt-1">
              This is a read-only view of your tenant's database. For data
              management operations, please contact your system administrator.
            </p>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={<HardDrive className="w-6 h-6" />}
          label="Database Size"
          value={databaseInfo.totalSize}
          color="green"
        />
        <StatCard
          icon={<Table className="w-6 h-6" />}
          label="Total Tables"
          value={databaseInfo.tableCount}
          color="blue"
        />
        <StatCard
          icon={<Activity className="w-6 h-6" />}
          label="Active Connections"
          value={`${databaseInfo.activeConnections}/${databaseInfo.maxConnections}`}
          subValue={`${utilizationPercent}% utilization`}
          color="purple"
        />
        <StatCard
          icon={<Clock className="w-6 h-6" />}
          label="Last Backup"
          value={databaseInfo.lastBackup ? formatDate(databaseInfo.lastBackup) : 'N/A'}
          color="yellow"
        />
      </div>

      {/* Database Info Card */}
      <div className="bg-white rounded-xl border border-gray-100 p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-xl bg-tenant-50">
              <Server className="w-6 h-6 text-tenant-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                {databaseInfo.databaseName}
              </h2>
              <p className="text-sm text-gray-500">
                Schema: {databaseInfo.schemaName}
              </p>
            </div>
          </div>
          <StatusBadge status={databaseInfo.status} />
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 bg-gray-50 rounded-lg">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider">
              Database Type
            </p>
            <p className="text-sm font-medium text-gray-900 mt-1">{databaseInfo.databaseType}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider">
              Region
            </p>
            <p className="text-sm font-medium text-gray-900 mt-1">{databaseInfo.region}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider">
              Isolation Level
            </p>
            <p className="text-sm font-medium text-gray-900 mt-1">{databaseInfo.isolationLevel}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider">
              Encryption
            </p>
            <p className="text-sm font-medium text-gray-900 mt-1">{databaseInfo.encryption}</p>
          </div>
        </div>
      </div>

      {/* Tables List - Grouped by Module */}
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <div className="p-6 border-b border-gray-100">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-center gap-3">
              <Layers className="w-5 h-5 text-gray-500" />
              <h2 className="text-lg font-semibold text-gray-900">Tables</h2>
              <span className="text-sm text-gray-500">
                ({filteredTables.length} tables)
              </span>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="text"
                placeholder="Search tables..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-hidden focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
              />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as 'name' | 'rows' | 'size')}
                className="px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-hidden focus:ring-2 focus:ring-tenant-500"
              >
                <option value="name">Sort by Name</option>
                <option value="rows">Sort by Rows</option>
                <option value="size">Sort by Size</option>
              </select>
            </div>
          </div>
        </div>

        {/* Module Groups */}
        <div className="divide-y divide-gray-100">
          {['farm', 'sensor', 'hr', 'other'].map((module) => {
            const config = MODULE_CONFIG[module];
            const moduleTables = groupedTables[module] || [];
            const stats = getModuleStats(module);

            // Skip empty modules
            if (moduleTables.length === 0) return null;

            return (
              <div key={module} className="overflow-hidden">
                {/* Module Header - Collapsible */}
                <button
                  onClick={() => toggleModule(module)}
                  className={`w-full px-6 py-4 flex items-center justify-between ${config.bgColor} hover:opacity-90 transition-opacity`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`${config.color}`}>
                      {config.icon}
                    </div>
                    <span className={`text-sm font-semibold ${config.color}`}>
                      {config.label}
                    </span>
                    <span className="text-xs text-gray-500 bg-white/60 px-2 py-0.5 rounded-full">
                      {stats.tableCount} tables
                    </span>
                    <span className="text-xs text-gray-500 bg-white/60 px-2 py-0.5 rounded-full">
                      {formatNumber(stats.totalRows)} rows
                    </span>
                  </div>
                  <ChevronDown
                    className={`w-5 h-5 text-gray-500 transition-transform ${
                      expandedModules[module] ? 'rotate-0' : '-rotate-90'
                    }`}
                  />
                </button>

                {/* Module Tables */}
                {expandedModules[module] && (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="bg-gray-50 border-b border-gray-100">
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Table Name
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Rows
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Size
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Indexes
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Last Modified
                          </th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {moduleTables.map((table) => (
                          <tr
                            key={table.name}
                            className="hover:bg-gray-50 transition-colors"
                          >
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-3">
                                <div className={`w-8 h-8 rounded-lg ${config.bgColor} flex items-center justify-center`}>
                                  <Table className={`w-4 h-4 ${config.color}`} />
                                </div>
                                <span className="text-sm font-medium text-gray-900">
                                  {table.name}
                                </span>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <span className="text-sm text-gray-600">
                                {formatNumber(table.rowCount)}
                              </span>
                            </td>
                            <td className="px-6 py-4">
                              <span className="text-sm text-gray-600">{table.size}</span>
                            </td>
                            <td className="px-6 py-4">
                              <span className="text-sm text-gray-600">{table.indexCount}</span>
                            </td>
                            <td className="px-6 py-4">
                              <span className="text-sm text-gray-500">
                                {formatDate(table.lastModified)}
                              </span>
                            </td>
                            <td className="px-6 py-4 text-right">
                              <div className="flex items-center justify-end gap-3">
                                <button
                                  onClick={() => handleViewData(table.name)}
                                  className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700 font-medium transition-colors"
                                >
                                  View Data
                                </button>
                                <button
                                  onClick={() => handleViewSchema(table.name)}
                                  className="inline-flex items-center gap-1 text-sm text-tenant-600 hover:text-tenant-700 font-medium transition-colors"
                                >
                                  View Schema
                                  <ChevronRight className="w-4 h-4" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Empty State */}
        {filteredTables.length === 0 && (
          <div className="py-12 text-center">
            <Table className="w-12 h-12 text-gray-500 mx-auto" />
            <h3 className="mt-4 text-sm font-medium text-gray-900">
              No tables found
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              Try adjusting your search criteria.
            </p>
          </div>
        )}
      </div>

      {/* Schema Modal */}
      <TableSchemaModal
        isOpen={selectedTable !== null}
        onClose={handleCloseSchemaModal}
        tableName={selectedTable || ''}
        columns={schemaColumns}
        indexes={schemaIndexes}
        loading={schemaLoading}
        error={schemaError}
      />

      {/* Data Modal */}
      <TableDataModal
        isOpen={dataTableName !== null}
        onClose={handleCloseDataModal}
        tableName={dataTableName || ''}
        data={tableData ?? null}
        loading={dataLoading}
        error={dataError}
        onPageChange={handleDataPageChange}
        pageSize={DATA_PAGE_SIZE}
      />
    </div>
  );
};

export default TenantDatabase;
