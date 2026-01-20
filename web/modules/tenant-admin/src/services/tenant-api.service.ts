/**
 * Tenant Admin API Service
 *
 * Handles all API calls for the tenant admin panel.
 * Uses GraphQL for data fetching.
 */

import {
  MY_TENANT_QUERY,
  TENANT_STATS_QUERY,
  MY_TENANT_MODULES_QUERY,
  TENANT_USERS_QUERY,
  TENANT_DATABASE_QUERY,
  TABLE_SCHEMA_QUERY,
  TABLE_DATA_QUERY,
  ASSIGN_MODULE_MANAGER_MUTATION,
  REMOVE_MODULE_MANAGER_MUTATION,
  UPDATE_TENANT_SETTINGS_MUTATION,
} from './graphql-queries';

// ============================================================================
// Types
// ============================================================================

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  description?: string;
  logoUrl?: string;
  contactEmail: string;
  contactPhone?: string;
  address?: string;
  status: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';
  plan: 'TRIAL' | 'STARTER' | 'PROFESSIONAL' | 'ENTERPRISE';
  maxUsers: number;
  settings?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TenantStats {
  totalUsers: number;
  activeUsers: number;
  pendingUsers: number;
  inactiveUsers: number;
  totalModules: number;
  activeModules: number;
  activeSessions: number;
  monthlyGrowthPercent?: number;
  lastActivityAt: string;
}

export interface Module {
  id: string;
  code: string;
  name: string;
  description: string;
  icon?: string;
  category: string;
  isActive: boolean;
}

export interface TenantModule {
  id: string;
  moduleId: string;
  isEnabled: boolean;
  configuration?: Record<string, unknown>;
  activatedAt: string;
  expiresAt?: string;
  managerId?: string;
  module: Module;
}

export interface User {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'MODULE_MANAGER' | 'MODULE_USER';
  status: 'ACTIVE' | 'INACTIVE' | 'PENDING';
  lastLoginAt?: string;
  createdAt: string;
}

export interface TableInfo {
  name: string;
  rowCount: number;
  size: string;
  indexCount: number;
  lastModified: string;
}

export interface ColumnInfo {
  columnName: string;
  dataType: string;
  isNullable: boolean;
  columnDefault: string | null;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  foreignKeyTable?: string;
  foreignKeyColumn?: string;
}

export interface IndexInfo {
  indexName: string;
  columnName: string;
  isUnique: boolean;
  isPrimary: boolean;
}

export interface TableSchemaInfo {
  tableName: string;
  schemaName: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
}

export interface TenantDatabaseInfo {
  databaseName: string;
  schemaName: string;
  totalSize: string;
  tableCount: number;
  status: string;
  lastBackup: string;
  activeConnections: number;
  maxConnections: number;
  databaseType: string;
  region: string;
  isolationLevel: string;
  encryption: string;
  tables: TableInfo[];
}

// ============================================================================
// API Configuration
// ============================================================================

const API_URL = '/graphql';

/**
 * Execute GraphQL query/mutation
 */
async function graphqlRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const token = localStorage.getItem('access_token');

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const result = await response.json();

  if (result.errors) {
    throw new Error(result.errors[0]?.message || 'GraphQL error');
  }

  return result.data;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get current tenant information
 */
export async function getMyTenant(): Promise<Tenant> {
  const data = await graphqlRequest<{ myTenant: Tenant }>(MY_TENANT_QUERY);
  return data.myTenant;
}

/**
 * Get tenant statistics
 */
export async function getTenantStats(): Promise<TenantStats> {
  const data = await graphqlRequest<{ tenantStats: TenantStats }>(TENANT_STATS_QUERY);
  return data.tenantStats;
}

/**
 * Get tenant's modules
 */
export async function getMyTenantModules(): Promise<TenantModule[]> {
  const data = await graphqlRequest<{ myTenantModules: TenantModule[] }>(
    MY_TENANT_MODULES_QUERY,
  );
  return data.myTenantModules;
}

/**
 * Get tenant users
 */
export async function getTenantUsers(options?: {
  status?: string;
  role?: string;
  limit?: number;
  offset?: number;
}): Promise<User[]> {
  const data = await graphqlRequest<{ tenantUsers: User[] }>(
    TENANT_USERS_QUERY,
    options,
  );
  return data.tenantUsers;
}

/**
 * Get tenant database information
 */
export async function getTenantDatabase(): Promise<TenantDatabaseInfo> {
  const data = await graphqlRequest<{ tenantDatabase: TenantDatabaseInfo }>(
    TENANT_DATABASE_QUERY,
  );
  return data.tenantDatabase;
}

/**
 * Assign module manager
 */
export async function assignModuleManager(
  moduleId: string,
  userId: string,
): Promise<TenantModule> {
  const data = await graphqlRequest<{ assignModuleManager: TenantModule }>(
    ASSIGN_MODULE_MANAGER_MUTATION,
    {
      input: { moduleId, userId },
    },
  );
  return data.assignModuleManager;
}

/**
 * Remove module manager
 */
export async function removeModuleManager(moduleId: string): Promise<TenantModule> {
  const data = await graphqlRequest<{ removeModuleManager: TenantModule }>(
    REMOVE_MODULE_MANAGER_MUTATION,
    { moduleId },
  );
  return data.removeModuleManager;
}

/**
 * Update tenant settings
 */
export async function updateTenantSettings(
  input: Partial<Pick<Tenant, 'name' | 'description' | 'logoUrl' | 'contactEmail' | 'contactPhone' | 'address' | 'settings'>>,
): Promise<Tenant> {
  const data = await graphqlRequest<{ updateTenantSettings: Tenant }>(
    UPDATE_TENANT_SETTINGS_MUTATION,
    { input },
  );
  return data.updateTenantSettings;
}

/**
 * Get table schema information (columns and indexes)
 * Uses GraphQL query from auth-service
 */
export async function getTableSchema(
  schemaName: string,
  tableName: string,
): Promise<TableSchemaInfo> {
  const data = await graphqlRequest<{ tableSchema: TableSchemaInfo }>(
    TABLE_SCHEMA_QUERY,
    { schemaName, tableName },
  );
  return data.tableSchema;
}

// ============================================================================
// Table Data (Tenant Isolated)
// ============================================================================

export interface GetTableDataInput {
  schemaName: string;
  tableName: string;
  limit?: number;
  offset?: number;
}

export interface TableDataResult {
  tableName: string; // Returns "schema.table" format
  totalRows: number;
  columns: string[];
  rows: string; // JSON string - needs to be parsed
  offset: number;
  limit: number;
}

/**
 * Get table data with pagination (tenant-isolated)
 * Uses GraphQL query from auth-service with tenant isolation
 * @param input.schemaName - Schema name (e.g., 'farm', 'sensor', 'auth')
 * @param input.tableName - Table name (e.g., 'tanks', 'sensors')
 */
export async function getTableData(input: GetTableDataInput): Promise<TableDataResult> {
  const data = await graphqlRequest<{ tableData: TableDataResult }>(
    TABLE_DATA_QUERY,
    { input },
  );
  return data.tableData;
}
