/**
 * Database Helper for E2E Integration Tests
 *
 * Provides direct PostgreSQL access for test assertions.
 * Uses the pg library to query the database directly,
 * bypassing GraphQL/API layer for verification.
 */

import { Pool, PoolConfig } from 'pg';

const DEFAULT_DB_CONFIG: PoolConfig = {
  host: process.env['DB_HOST'] || 'localhost',
  port: parseInt(process.env['DB_PORT'] || '5432', 10),
  user: process.env['DB_USER'] || 'aquaculture',
  password: process.env['DB_PASSWORD'] || 'aquaculture',
  database: process.env['DB_NAME'] || 'aquaculture',
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

let pool: Pool | null = null;

/**
 * Get or create the database connection pool.
 */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool(DEFAULT_DB_CONFIG);
  }
  return pool;
}

/**
 * Close the database connection pool.
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Execute a parameterized SQL query.
 */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query(sql, params);
  return result.rows as T[];
}

/**
 * Execute a query and return the first row, or null if no rows.
 */
export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] || null;
}

// ============================================================
// Auth Schema Helpers
// ============================================================

export interface DbUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  tenantId: string | null;
  isActive: boolean;
  isEmailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Find a user in auth.users by ID.
 */
export async function findUserById(userId: string): Promise<DbUser | null> {
  return queryOne<DbUser>(
    `SELECT id, email, "firstName", "lastName", role, "tenantId", "isActive", "isEmailVerified", "createdAt", "updatedAt"
     FROM auth.users WHERE id = $1`,
    [userId],
  );
}

/**
 * Find a user in auth.users by email.
 */
export async function findUserByEmail(email: string): Promise<DbUser | null> {
  return queryOne<DbUser>(
    `SELECT id, email, "firstName", "lastName", role, "tenantId", "isActive", "isEmailVerified", "createdAt", "updatedAt"
     FROM auth.users WHERE email = $1`,
    [email],
  );
}

/**
 * Delete a user from auth.users by ID (hard delete for test cleanup).
 */
export async function deleteUserById(userId: string): Promise<void> {
  // Delete related records first
  await query('DELETE FROM auth.refresh_tokens WHERE "userId" = $1', [userId]);
  await query('DELETE FROM auth.user_module_assignments WHERE "userId" = $1', [userId]);
  await query('DELETE FROM auth.users WHERE id = $1', [userId]);
}

// ============================================================
// Tenant Schema Helpers
// ============================================================

export interface DbTenant {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  maxUsers: number;
  createdAt: Date;
}

/**
 * Find a tenant by ID.
 */
export async function findTenantById(tenantId: string): Promise<DbTenant | null> {
  return queryOne<DbTenant>(
    `SELECT id, name, slug, status, plan, "maxUsers", "createdAt"
     FROM auth.tenants WHERE id = $1`,
    [tenantId],
  );
}

/**
 * Check if a tenant PostgreSQL schema exists.
 */
export async function tenantSchemaExists(tenantId: string): Promise<boolean> {
  const schemaName = getTenantSchemaName(tenantId);
  const result = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.schemata WHERE schema_name = $1
     ) as exists`,
    [schemaName],
  );
  return result?.exists === true;
}

/**
 * Get tables in a tenant schema.
 */
export async function getTenantSchemaTables(tenantId: string): Promise<string[]> {
  const schemaName = getTenantSchemaName(tenantId);
  const rows = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1
     ORDER BY table_name`,
    [schemaName],
  );
  return rows.map((r) => r.table_name);
}

/**
 * Delete a tenant and its schema (for test cleanup).
 */
export async function deleteTenant(tenantId: string): Promise<void> {
  const schemaName = getTenantSchemaName(tenantId);

  // Drop tenant schema
  await query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);

  // Delete related records
  await query('DELETE FROM auth.tenant_modules WHERE "tenantId" = $1', [tenantId]);
  await query('DELETE FROM auth.users WHERE "tenantId" = $1', [tenantId]);
  await query('DELETE FROM auth.tenants WHERE id = $1', [tenantId]);
}

// ============================================================
// Tenant Role Assignment Helpers
// ============================================================

export interface DbUserRoleAssignment {
  id: string;
  user_id: string;
  role_id: string;
  is_active: boolean;
  assigned_at: Date;
}

/**
 * Find user role assignments in a tenant schema.
 */
export async function findUserRoleAssignment(
  tenantId: string,
  userId: string,
): Promise<DbUserRoleAssignment | null> {
  const schemaName = getTenantSchemaName(tenantId);
  try {
    return await queryOne<DbUserRoleAssignment>(
      `SELECT id, user_id, role_id, is_active, assigned_at
       FROM "${schemaName}"."user_role_assignments"
       WHERE user_id = $1 AND is_active = true`,
      [userId],
    );
  } catch {
    return null;
  }
}

/**
 * Get tenant role permissions from a tenant schema.
 */
export async function getTenantRolePermissions(
  tenantId: string,
  roleId: string,
): Promise<{ resource_permissions: string[] } | null> {
  const schemaName = getTenantSchemaName(tenantId);
  try {
    return await queryOne<{ resource_permissions: string[] }>(
      `SELECT resource_permissions
       FROM "${schemaName}"."tenant_role_permissions"
       WHERE role_id = $1`,
      [roleId],
    );
  } catch {
    return null;
  }
}

// ============================================================
// Utility Functions
// ============================================================

/**
 * Derive tenant schema name from tenant ID.
 * Mirrors getTenantSchemaName from @platform/backend-common.
 */
export function getTenantSchemaName(tenantId: string): string {
  const cleanId = tenantId.replace(/-/g, '').substring(0, 16).toLowerCase();
  return `tenant_${cleanId}`;
}
