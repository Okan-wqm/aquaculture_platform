import {
  adminManualResponse,
  adminResponse,
  type AdminResponseProjection,
} from '@platform/admin-http-contracts';

export const databaseExplorerExportProfile = adminManualResponse.binary(
  [200],
  ['application/json', 'text/csv; charset=utf-8'],
  16_777_216,
);

export const voidResponseContract = adminResponse.void();

export type VoidResponseDto = AdminResponseProjection<typeof voidResponseContract>;

export const databaseExplorerGetSchemasResponseContract = adminResponse.object({
  schemas: adminResponse.array(adminResponse.string()),
  capabilities: adminResponse.object({
    writesEnabled: adminResponse.boolean(),
  }),
});

export type DatabaseExplorerGetSchemasResponseDto = AdminResponseProjection<
  typeof databaseExplorerGetSchemasResponseContract
>;

export const databaseExplorerGetTablesResponseContract = adminResponse.object({
  tableName: adminResponse.string(),
  schemaName: adminResponse.string(),
  rowCount: adminResponse.number(),
  sizeBytes: adminResponse.number(),
  columns: adminResponse.array(
    adminResponse.object({
      columnName: adminResponse.string(),
      dataType: adminResponse.string(),
      isNullable: adminResponse.union([
        adminResponse.literal(false),
        adminResponse.literal(true),
      ] as const),
      columnDefault: adminResponse.nullable(adminResponse.string()),
      isPrimaryKey: adminResponse.union([
        adminResponse.literal(false),
        adminResponse.literal(true),
      ] as const),
      isForeignKey: adminResponse.union([
        adminResponse.literal(false),
        adminResponse.literal(true),
      ] as const),
      foreignKeyTable: adminResponse.optional(adminResponse.string()),
      foreignKeyColumn: adminResponse.optional(adminResponse.string()),
      isSensitive: adminResponse.optional(
        adminResponse.union([adminResponse.literal(false), adminResponse.literal(true)] as const),
      ),
    }),
  ),
});

export type DatabaseExplorerGetTablesResponseDto = AdminResponseProjection<
  typeof databaseExplorerGetTablesResponseContract
>;

export const databaseExplorerTableInfoContract = adminResponse.object({
  tableName: adminResponse.string(),
  schemaName: adminResponse.string(),
  rowCount: adminResponse.number(),
  sizeBytes: adminResponse.number(),
  columns: adminResponse.array(
    adminResponse.object({
      columnName: adminResponse.string(),
      dataType: adminResponse.string(),
      isNullable: adminResponse.boolean(),
      columnDefault: adminResponse.nullable(adminResponse.string()),
      isPrimaryKey: adminResponse.boolean(),
      isForeignKey: adminResponse.boolean(),
      foreignKeyTable: adminResponse.optional(adminResponse.string()),
      foreignKeyColumn: adminResponse.optional(adminResponse.string()),
      isSensitive: adminResponse.optional(
        adminResponse.union([adminResponse.literal(false), adminResponse.literal(true)] as const),
      ),
    }),
  ),
});

export type DatabaseExplorerTableInfoDto = AdminResponseProjection<
  typeof databaseExplorerTableInfoContract
>;

export const databaseExplorerGetTableDataResponseContract = adminResponse.object({
  tableName: adminResponse.string(),
  columns: adminResponse.array(
    adminResponse.object({
      isSensitive: adminResponse.boolean(),
      columnName: adminResponse.string(),
      dataType: adminResponse.string(),
      isNullable: adminResponse.boolean(),
      columnDefault: adminResponse.nullable(adminResponse.string()),
      isPrimaryKey: adminResponse.boolean(),
      isForeignKey: adminResponse.boolean(),
      foreignKeyTable: adminResponse.optional(adminResponse.string()),
      foreignKeyColumn: adminResponse.optional(adminResponse.string()),
    }),
  ),
  rows: adminResponse.array(adminResponse.record(adminResponse.json('database-scalar'))),
  totalRows: adminResponse.number(),
  page: adminResponse.number(),
  limit: adminResponse.number(),
  totalPages: adminResponse.number(),
});

export type DatabaseExplorerGetTableDataResponseDto = AdminResponseProjection<
  typeof databaseExplorerGetTableDataResponseContract
>;

export const databaseExplorerInsertRowResponseContract = adminResponse.record(
  adminResponse.json('database-record'),
);

export type DatabaseExplorerInsertRowResponseDto = AdminResponseProjection<
  typeof databaseExplorerInsertRowResponseContract
>;

export const databaseExplorerUpdateRowResponseContract = adminResponse.record(
  adminResponse.json('database-record'),
);

export type DatabaseExplorerUpdateRowResponseDto = AdminResponseProjection<
  typeof databaseExplorerUpdateRowResponseContract
>;

export const databaseExplorerDeleteRowResponseContract = adminResponse.object({
  deleted: adminResponse.boolean(),
  row: adminResponse.json('database-record'),
});

export type DatabaseExplorerDeleteRowResponseDto = AdminResponseProjection<
  typeof databaseExplorerDeleteRowResponseContract
>;

export const databaseExplorerGetTableStructureResponseContract = adminResponse.object({
  tableName: adminResponse.string(),
  schemaName: adminResponse.string(),
  columns: adminResponse.array(
    adminResponse.object({
      columnName: adminResponse.string(),
      dataType: adminResponse.string(),
      isNullable: adminResponse.boolean(),
      columnDefault: adminResponse.nullable(adminResponse.string()),
      isPrimaryKey: adminResponse.boolean(),
      isForeignKey: adminResponse.boolean(),
      foreignKeyTable: adminResponse.optional(adminResponse.string()),
      foreignKeyColumn: adminResponse.optional(adminResponse.string()),
      isSensitive: adminResponse.optional(
        adminResponse.union([adminResponse.literal(false), adminResponse.literal(true)] as const),
      ),
    }),
  ),
  indexes: adminResponse.json('database-record'),
  constraints: adminResponse.json('database-record'),
});

export type DatabaseExplorerGetTableStructureResponseDto = AdminResponseProjection<
  typeof databaseExplorerGetTableStructureResponseContract
>;

export const databaseExplorerExecuteQueryResponseContract = adminResponse.object({
  rows: adminResponse.array(adminResponse.record(adminResponse.json('database-record'))),
  rowCount: adminResponse.number(),
});

export type DatabaseExplorerExecuteQueryResponseDto = AdminResponseProjection<
  typeof databaseExplorerExecuteQueryResponseContract
>;

export const migrationGetAvailableMigrationsResponseContract = adminResponse.object({
  version: adminResponse.string(),
  name: adminResponse.string(),
  description: adminResponse.string(),
  affectedTables: adminResponse.array(adminResponse.string()),
  estimatedDuration: adminResponse.number(),
  isDestructive: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  requiresDowntime: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
});

export type MigrationGetAvailableMigrationsResponseDto = AdminResponseProjection<
  typeof migrationGetAvailableMigrationsResponseContract
>;

export const migrationGetMigrationSummaryResponseContract = adminResponse.object({
  totalMigrations: adminResponse.number(),
  completed: adminResponse.number(),
  failed: adminResponse.number(),
  rolledBack: adminResponse.number(),
  latestVersion: adminResponse.string(),
  tenantsUpToDate: adminResponse.number(),
  tenantsOutdated: adminResponse.number(),
});

export type MigrationGetMigrationSummaryResponseDto = AdminResponseProjection<
  typeof migrationGetMigrationSummaryResponseContract
>;

export const migrationMigrationPlanContract = adminResponse.object({
  id: adminResponse.string(),
  name: adminResponse.string(),
  version: adminResponse.string(),
  description: adminResponse.string(),
  upScript: adminResponse.string(),
  downScript: adminResponse.string(),
  affectedTables: adminResponse.array(adminResponse.string()),
  estimatedDuration: adminResponse.number(),
  isDestructive: adminResponse.boolean(),
  requiresDowntime: adminResponse.boolean(),
});

export type MigrationMigrationPlanDto = AdminResponseProjection<
  typeof migrationMigrationPlanContract
>;

export const migrationSchemaMigrationContract = adminResponse.object({
  id: adminResponse.string(),
  tenantId: adminResponse.nullable(adminResponse.string()),
  schemaName: adminResponse.string(),
  migrationName: adminResponse.string(),
  version: adminResponse.string(),
  status: adminResponse.union([
    adminResponse.literal('pending'),
    adminResponse.literal('running'),
    adminResponse.literal('completed'),
    adminResponse.literal('failed'),
    adminResponse.literal('rolled_back'),
  ] as const),
  upScript: adminResponse.string(),
  downScript: adminResponse.string(),
  errorMessage: adminResponse.string(),
  executionTimeMs: adminResponse.number(),
  isDryRun: adminResponse.boolean(),
  affectedTables: adminResponse.array(adminResponse.string()),
  executedBy: adminResponse.string(),
  startedAt: adminResponse.dateString(),
  completedAt: adminResponse.dateString(),
  createdAt: adminResponse.dateString(),
});

export type MigrationSchemaMigrationDto = AdminResponseProjection<
  typeof migrationSchemaMigrationContract
>;

export const neverResponseContract = adminResponse.never();

export type NeverResponseDto = AdminResponseProjection<typeof neverResponseContract>;

export const migrationGetBatchMigrationStatusResponseContract = adminResponse.object({
  totalTenants: adminResponse.number(),
  completed: adminResponse.number(),
  pending: adminResponse.number(),
  failed: adminResponse.number(),
  tenants: adminResponse.array(
    adminResponse.object({
      tenantId: adminResponse.string(),
      status: adminResponse.union([
        adminResponse.literal('pending'),
        adminResponse.literal('running'),
        adminResponse.literal('completed'),
        adminResponse.literal('failed'),
        adminResponse.literal('rolled_back'),
      ] as const),
      completedAt: adminResponse.nullable(adminResponse.dateString()),
    }),
  ),
});

export type MigrationGetBatchMigrationStatusResponseDto = AdminResponseProjection<
  typeof migrationGetBatchMigrationStatusResponseContract
>;

export const monitoringDatabaseHealthStatusContract = adminResponse.object({
  status: adminResponse.union([
    adminResponse.literal('warning'),
    adminResponse.literal('critical'),
    adminResponse.literal('healthy'),
  ] as const),
  score: adminResponse.number(),
  checks: adminResponse.array(
    adminResponse.object({
      name: adminResponse.string(),
      status: adminResponse.union([
        adminResponse.literal('pass'),
        adminResponse.literal('warn'),
        adminResponse.literal('fail'),
      ] as const),
      value: adminResponse.union([adminResponse.string(), adminResponse.number()] as const),
      threshold: adminResponse.optional(
        adminResponse.union([adminResponse.string(), adminResponse.number()] as const),
      ),
      message: adminResponse.string(),
    }),
  ),
  recommendations: adminResponse.array(adminResponse.string()),
});

export type MonitoringDatabaseHealthStatusDto = AdminResponseProjection<
  typeof monitoringDatabaseHealthStatusContract
>;

export const monitoringGetConnectionStatsResponseContract = adminResponse.object({
  total: adminResponse.number(),
  active: adminResponse.number(),
  idle: adminResponse.number(),
  waiting: adminResponse.number(),
  maxConnections: adminResponse.number(),
  utilizationPercent: adminResponse.number(),
});

export type MonitoringGetConnectionStatsResponseDto = AdminResponseProjection<
  typeof monitoringGetConnectionStatsResponseContract
>;

export const monitoringGetConnectionsByTenantResponseContract = adminResponse.object({
  tenantId: adminResponse.string(),
  schemaName: adminResponse.string(),
  activeConnections: adminResponse.number(),
  maxConnections: adminResponse.number(),
});

export type MonitoringGetConnectionsByTenantResponseDto = AdminResponseProjection<
  typeof monitoringGetConnectionsByTenantResponseContract
>;

export const monitoringGetQueryPerformanceStatsResponseContract = adminResponse.object({
  totalQueries: adminResponse.number(),
  avgExecutionTime: adminResponse.number(),
  slowQueries: adminResponse.number(),
  failedQueries: adminResponse.number(),
  cacheHitRatio: adminResponse.number(),
  queriesPerSecond: adminResponse.number(),
});

export type MonitoringGetQueryPerformanceStatsResponseDto = AdminResponseProjection<
  typeof monitoringGetQueryPerformanceStatsResponseContract
>;

export const monitoringSlowQueryResultContract = adminResponse.object({
  source: adminResponse.union([
    adminResponse.literal('slow_query_logs'),
    adminResponse.literal('pg_stat_statements'),
    adminResponse.literal('pg_stat_activity'),
    adminResponse.literal('none'),
  ] as const),
  data: adminResponse.array(adminResponse.record(adminResponse.json('database-record'))),
  metadata: adminResponse.object({
    total: adminResponse.number(),
    limit: adminResponse.number(),
    minExecutionTimeMs: adminResponse.optional(adminResponse.number()),
    note: adminResponse.optional(adminResponse.string()),
    error: adminResponse.optional(adminResponse.string()),
  }),
});

export type MonitoringSlowQueryResultDto = AdminResponseProjection<
  typeof monitoringSlowQueryResultContract
>;

export const monitoringAnalyzeQueryResponseContract = adminResponse.record(
  adminResponse.json('database-record'),
);

export type MonitoringAnalyzeQueryResponseDto = AdminResponseProjection<
  typeof monitoringAnalyzeQueryResponseContract
>;

export const monitoringGetTotalStorageResponseContract = adminResponse.object({
  totalSizeBytes: adminResponse.number(),
  dataSizeBytes: adminResponse.number(),
  indexSizeBytes: adminResponse.number(),
});

export type MonitoringGetTotalStorageResponseDto = AdminResponseProjection<
  typeof monitoringGetTotalStorageResponseContract
>;

export const monitoringGetStorageByTenantResponseContract = adminResponse.object({
  tenantId: adminResponse.string(),
  schemaName: adminResponse.string(),
  totalSizeBytes: adminResponse.number(),
  dataSizeBytes: adminResponse.number(),
  indexSizeBytes: adminResponse.number(),
  tableCount: adminResponse.number(),
});

export type MonitoringGetStorageByTenantResponseDto = AdminResponseProjection<
  typeof monitoringGetStorageByTenantResponseContract
>;

export const monitoringIndexRecommendationContract = adminResponse.object({
  tableName: adminResponse.string(),
  columns: adminResponse.array(adminResponse.string()),
  indexType: adminResponse.union([
    adminResponse.literal('btree'),
    adminResponse.literal('hash'),
    adminResponse.literal('gin'),
    adminResponse.literal('gist'),
  ] as const),
  reason: adminResponse.string(),
  estimatedImpact: adminResponse.union([
    adminResponse.literal('high'),
    adminResponse.literal('medium'),
    adminResponse.literal('low'),
  ] as const),
  recommendedAction: adminResponse.union([
    adminResponse.literal('add_index'),
    adminResponse.literal('review_unused_index'),
  ] as const),
  indexName: adminResponse.string(),
  authority: adminResponse.literal('db-migrate'),
});

export type MonitoringIndexRecommendationDto = AdminResponseProjection<
  typeof monitoringIndexRecommendationContract
>;

export const monitoringDatabaseMetricContract = adminResponse.object({
  id: adminResponse.string(),
  tenantId: adminResponse.nullable(adminResponse.string()),
  schemaName: adminResponse.string(),
  metricType: adminResponse.string(),
  metrics: adminResponse.object({
    activeConnections: adminResponse.optional(adminResponse.number()),
    idleConnections: adminResponse.optional(adminResponse.number()),
    maxConnections: adminResponse.optional(adminResponse.number()),
    connectionUtilization: adminResponse.optional(adminResponse.number()),
    queriesPerSecond: adminResponse.optional(adminResponse.number()),
    avgQueryTime: adminResponse.optional(adminResponse.number()),
    slowQueries: adminResponse.optional(adminResponse.number()),
    failedQueries: adminResponse.optional(adminResponse.number()),
    totalSizeBytes: adminResponse.optional(adminResponse.number()),
    dataSizeBytes: adminResponse.optional(adminResponse.number()),
    indexSizeBytes: adminResponse.optional(adminResponse.number()),
    freeSizeBytes: adminResponse.optional(adminResponse.number()),
    tableCount: adminResponse.optional(adminResponse.number()),
    rowCount: adminResponse.optional(adminResponse.number()),
    deadTuples: adminResponse.optional(adminResponse.number()),
    cacheHitRatio: adminResponse.optional(adminResponse.number()),
    indexHitRatio: adminResponse.optional(adminResponse.number()),
    bufferHitRatio: adminResponse.optional(adminResponse.number()),
    transactionsPerSecond: adminResponse.optional(adminResponse.number()),
    activeLocks: adminResponse.optional(adminResponse.number()),
    waitingLocks: adminResponse.optional(adminResponse.number()),
    deadlocks: adminResponse.optional(adminResponse.number()),
  }),
  recordedAt: adminResponse.dateString(),
  createdAt: adminResponse.dateString(),
});

export type MonitoringDatabaseMetricDto = AdminResponseProjection<
  typeof monitoringDatabaseMetricContract
>;

export const schemaTenantSchemaContract = adminResponse.object({
  id: adminResponse.string(),
  tenantId: adminResponse.string(),
  schemaName: adminResponse.string(),
  status: adminResponse.union([
    adminResponse.literal('active'),
    adminResponse.literal('creating'),
    adminResponse.literal('migrating'),
    adminResponse.literal('suspended'),
    adminResponse.literal('pending_deletion'),
    adminResponse.literal('deleted'),
  ] as const),
  currentVersion: adminResponse.string(),
  sizeBytes: adminResponse.number(),
  tableCount: adminResponse.number(),
  connectionCount: adminResponse.number(),
  maxConnections: adminResponse.number(),
  metadata: adminResponse.record(adminResponse.json('extension-metadata')),
  lastMigrationAt: adminResponse.dateString(),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type SchemaTenantSchemaDto = AdminResponseProjection<typeof schemaTenantSchemaContract>;

export const schemaGetSchemaSummaryResponseContract = adminResponse.object({
  totalSchemas: adminResponse.number(),
  activeSchemas: adminResponse.number(),
  suspendedSchemas: adminResponse.number(),
  totalSizeBytes: adminResponse.number(),
  avgSizeBytes: adminResponse.number(),
});

export type SchemaGetSchemaSummaryResponseDto = AdminResponseProjection<
  typeof schemaGetSchemaSummaryResponseContract
>;

export const schemaSchemaInfoContract = adminResponse.object({
  schemaName: adminResponse.string(),
  tenantId: adminResponse.string(),
  status: adminResponse.union([
    adminResponse.literal('active'),
    adminResponse.literal('creating'),
    adminResponse.literal('migrating'),
    adminResponse.literal('suspended'),
    adminResponse.literal('pending_deletion'),
    adminResponse.literal('deleted'),
  ] as const),
  version: adminResponse.string(),
  sizeBytes: adminResponse.number(),
  tableCount: adminResponse.number(),
  tables: adminResponse.array(
    adminResponse.object({
      tableName: adminResponse.string(),
      rowCount: adminResponse.number(),
      sizeBytes: adminResponse.number(),
      indexCount: adminResponse.number(),
      lastVacuum: adminResponse.nullable(adminResponse.dateString()),
      lastAnalyze: adminResponse.nullable(adminResponse.dateString()),
    }),
  ),
  createdAt: adminResponse.dateString(),
  lastMigrationAt: adminResponse.nullable(adminResponse.dateString()),
});

export type SchemaSchemaInfoDto = AdminResponseProjection<typeof schemaSchemaInfoContract>;

export const schemaSyncSchemasResponseContract = adminResponse.object({
  results: adminResponse.array(
    adminResponse.object({
      tenantId: adminResponse.string(),
      schemaName: adminResponse.string(),
      created: adminResponse.array(adminResponse.string()),
      skipped: adminResponse.array(adminResponse.string()),
      errors: adminResponse.array(adminResponse.string()),
    }),
  ),
  summary: adminResponse.object({
    totalCreated: adminResponse.number(),
    totalErrors: adminResponse.number(),
    tenantsProcessed: adminResponse.number(),
  }),
});

export type SchemaSyncSchemasResponseDto = AdminResponseProjection<
  typeof schemaSyncSchemasResponseContract
>;

export const schemaValidateSchemaIsolationResponseContract = adminResponse.object({
  isIsolated: adminResponse.boolean(),
  issues: adminResponse.array(adminResponse.string()),
});

export type SchemaValidateSchemaIsolationResponseDto = AdminResponseProjection<
  typeof schemaValidateSchemaIsolationResponseContract
>;

export const schemaConnectionPoolStatusContract = adminResponse.object({
  poolName: adminResponse.string(),
  totalConnections: adminResponse.number(),
  activeConnections: adminResponse.number(),
  idleConnections: adminResponse.number(),
  waitingRequests: adminResponse.number(),
  maxConnections: adminResponse.number(),
  utilizationPercent: adminResponse.number(),
});

export type SchemaConnectionPoolStatusDto = AdminResponseProjection<
  typeof schemaConnectionPoolStatusContract
>;

export const schemaGetConnectionsByTenantResponseContract = adminResponse.object({
  tenantId: adminResponse.string(),
  schemaName: adminResponse.string(),
  activeConnections: adminResponse.number(),
  idleConnections: adminResponse.number(),
});

export type SchemaGetConnectionsByTenantResponseDto = AdminResponseProjection<
  typeof schemaGetConnectionsByTenantResponseContract
>;

export const schemaBackfillTrackingRecordsResponseContract = adminResponse.object({
  created: adminResponse.number(),
  skipped: adminResponse.number(),
  errors: adminResponse.array(adminResponse.string()),
});

export type SchemaBackfillTrackingRecordsResponseDto = AdminResponseProjection<
  typeof schemaBackfillTrackingRecordsResponseContract
>;

export const databaseExplorerGetTablesResponseArrayContract = adminResponse.array(
  databaseExplorerGetTablesResponseContract,
);

export const databaseExplorerTableInfoArrayContract = adminResponse.array(
  databaseExplorerTableInfoContract,
);

export const migrationGetAvailableMigrationsResponseArrayContract = adminResponse.array(
  migrationGetAvailableMigrationsResponseContract,
);

export const migrationMigrationPlanArrayContract = adminResponse.array(
  migrationMigrationPlanContract,
);

export const migrationSchemaMigrationArrayContract = adminResponse.array(
  migrationSchemaMigrationContract,
);

export const migrationSchemaMigrationPageContract = adminResponse.page(
  migrationSchemaMigrationContract,
);

export const monitoringDatabaseMetricArrayContract = adminResponse.array(
  monitoringDatabaseMetricContract,
);

export const monitoringGetConnectionsByTenantResponseArrayContract = adminResponse.array(
  monitoringGetConnectionsByTenantResponseContract,
);

export const monitoringGetStorageByTenantResponseArrayContract = adminResponse.array(
  monitoringGetStorageByTenantResponseContract,
);

export const monitoringIndexRecommendationArrayContract = adminResponse.array(
  monitoringIndexRecommendationContract,
);

export const schemaConnectionPoolStatusArrayContract = adminResponse.array(
  schemaConnectionPoolStatusContract,
);

export const schemaGetConnectionsByTenantResponseArrayContract = adminResponse.array(
  schemaGetConnectionsByTenantResponseContract,
);

export const schemaTenantSchemaPageContract = adminResponse.page(schemaTenantSchemaContract);
