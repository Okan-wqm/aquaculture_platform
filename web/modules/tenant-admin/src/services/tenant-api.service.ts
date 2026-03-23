/**
 * Tenant Admin API Service
 *
 * Handles all GraphQL API calls for the tenant admin panel.
 * Uses centralized apiClient and GraphQL query definitions.
 */

import { apiClient } from './api-client';
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
  UPDATE_TENANT_MUTATION,
  TENANT_ROLES_QUERY,
  TENANT_ROLE_QUERY,
  DEFAULT_TENANT_ROLE_QUERY,
  PERMISSION_CATEGORIES_QUERY,
  CREATE_TENANT_ROLE_MUTATION,
  UPDATE_TENANT_ROLE_MUTATION,
  DELETE_TENANT_ROLE_MUTATION,
  SEED_TENANT_ROLES_MUTATION,
} from '../graphql';

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
  isActive?: boolean;
  isEmailVerified?: boolean;
  // Profile fields
  profileImageUrl?: string | null;
  phoneNumber?: string | null;
  preferredLanguage?: string | null;
  // Security fields
  mfaEnabled?: boolean;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt?: string;
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
// Backward-compatible graphqlRequest wrapper
// ============================================================================

/**
 * Execute GraphQL query/mutation.
 * Delegates to apiClient.graphql() for centralized auth/error handling.
 */
export async function graphqlRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  return apiClient.graphql<T>(query, variables);
}

// ============================================================================
// API Functions
// ============================================================================

export async function getMyTenant(): Promise<Tenant> {
  const data = await apiClient.graphql<{ myTenant: Tenant }>(MY_TENANT_QUERY);
  return data.myTenant;
}

export async function getTenantStats(): Promise<TenantStats> {
  const data = await apiClient.graphql<{ tenantStats: TenantStats }>(TENANT_STATS_QUERY);
  return data.tenantStats;
}

export async function getMyTenantModules(): Promise<TenantModule[]> {
  const data = await apiClient.graphql<{ myTenantModules: TenantModule[] }>(
    MY_TENANT_MODULES_QUERY,
  );
  return data.myTenantModules;
}

export async function getTenantUsers(options?: {
  status?: string;
  role?: string;
  limit?: number;
  offset?: number;
}): Promise<User[]> {
  const data = await apiClient.graphql<{ tenantUsers: User[] }>(
    TENANT_USERS_QUERY,
    options,
  );
  return data.tenantUsers;
}

export async function getTenantDatabase(): Promise<TenantDatabaseInfo> {
  const data = await apiClient.graphql<{ tenantDatabase: TenantDatabaseInfo }>(
    TENANT_DATABASE_QUERY,
  );
  return data.tenantDatabase;
}

export async function assignModuleManager(
  moduleId: string,
  userId: string,
): Promise<TenantModule> {
  const data = await apiClient.graphql<{ assignModuleManager: TenantModule }>(
    ASSIGN_MODULE_MANAGER_MUTATION,
    { input: { moduleId, userId } },
  );
  return data.assignModuleManager;
}

export async function removeModuleManager(moduleId: string): Promise<TenantModule> {
  const data = await apiClient.graphql<{ removeModuleManager: TenantModule }>(
    REMOVE_MODULE_MANAGER_MUTATION,
    { moduleId },
  );
  return data.removeModuleManager;
}

export async function updateTenant(
  id: string,
  input: Partial<Pick<Tenant, 'name' | 'description' | 'logoUrl' | 'contactEmail' | 'contactPhone' | 'address' | 'settings'>>,
): Promise<Tenant> {
  const data = await apiClient.graphql<{ updateTenant: Tenant }>(
    UPDATE_TENANT_MUTATION,
    { id, input },
  );
  return data.updateTenant;
}

export async function getTableSchema(
  schemaName: string,
  tableName: string,
): Promise<TableSchemaInfo> {
  const data = await apiClient.graphql<{ tableSchema: TableSchemaInfo }>(
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
  tableName: string;
  totalRows: number;
  columns: string[];
  rows: string;
  offset: number;
  limit: number;
}

export async function getTableData(input: GetTableDataInput): Promise<TableDataResult> {
  const data = await apiClient.graphql<{ tableData: TableDataResult }>(
    TABLE_DATA_QUERY,
    { input },
  );
  return data.tableData;
}

// ============================================================================
// Re-export Permission Types
// ============================================================================

export type {
  PermissionCategory,
  PanelPermissions,
  TenantRolePermissions,
  PermissionAction,
  PermissionResource,
} from '../types/permissions';

// ============================================================================
// Tenant Role Types
// ============================================================================

import type { TenantRolePermissions } from '../types/permissions';

export interface TenantRole {
  id: string;
  name: string;
  description?: string;
  color: string;
  icon: string;
  level: number;
  isSystem: boolean;
  isDefault: boolean;
  userCount: number;
  permissions?: TenantRolePermissions | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTenantRoleInput {
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  level?: number;
  isDefault?: boolean;
  panelPermissions: Record<string, Record<string, Record<string, boolean>>>;
}

export interface UpdateTenantRoleInput {
  name?: string;
  description?: string;
  color?: string;
  icon?: string;
  level?: number;
  isDefault?: boolean;
  panelPermissions?: Record<string, Record<string, Record<string, boolean>>>;
}

// ============================================================================
// Tenant Role API Functions
// ============================================================================

import type { PermissionCategory as PermCat } from '../types/permissions';

export async function getTenantRoles(): Promise<TenantRole[]> {
  const data = await apiClient.graphql<{ tenantRoles: TenantRole[] }>(TENANT_ROLES_QUERY);
  return data.tenantRoles;
}

export async function getTenantRole(roleId: string): Promise<TenantRole> {
  const data = await apiClient.graphql<{ tenantRole: TenantRole }>(TENANT_ROLE_QUERY, { roleId });
  return data.tenantRole;
}

export async function getDefaultTenantRole(): Promise<TenantRole | null> {
  const data = await apiClient.graphql<{ defaultTenantRole: TenantRole | null }>(DEFAULT_TENANT_ROLE_QUERY);
  return data.defaultTenantRole;
}

export async function getPermissionCategories(): Promise<PermCat[]> {
  const data = await apiClient.graphql<{ permissionCategories: PermCat[] }>(PERMISSION_CATEGORIES_QUERY);
  return data.permissionCategories;
}

export async function createTenantRole(input: CreateTenantRoleInput): Promise<TenantRole> {
  const data = await apiClient.graphql<{ createTenantRole: TenantRole }>(CREATE_TENANT_ROLE_MUTATION, { input });
  return data.createTenantRole;
}

export async function updateTenantRole(roleId: string, input: UpdateTenantRoleInput): Promise<TenantRole> {
  const data = await apiClient.graphql<{ updateTenantRole: TenantRole }>(UPDATE_TENANT_ROLE_MUTATION, { roleId, input });
  return data.updateTenantRole;
}

export async function deleteTenantRole(roleId: string): Promise<boolean> {
  const data = await apiClient.graphql<{ deleteTenantRole: boolean }>(DELETE_TENANT_ROLE_MUTATION, { roleId });
  return data.deleteTenantRole;
}

export async function seedTenantRoles(): Promise<TenantRole[]> {
  const data = await apiClient.graphql<{ seedTenantRoles: TenantRole[] }>(SEED_TENANT_ROLES_MUTATION);
  return data.seedTenantRoles;
}
