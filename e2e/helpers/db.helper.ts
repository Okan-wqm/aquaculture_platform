import { Pool, QueryResult, PoolConfig } from 'pg';

/**
 * Default connection string for E2E tests.
 * Matches the docker-compose and CI service container configuration.
 */
const DEFAULT_DATABASE_URL =
  'postgresql://aquaculture:aquaculture@localhost:5432/aquaculture';

/**
 * Row type for a user record from auth.users.
 *
 * Index signature satisfies the `T extends Record<string, unknown>`
 * constraint on `query<T>()` — pg's `QueryResult<T>` row shape is
 * structurally a record, and downstream tests treat it that way.
 * Without the signature, ts-jest under e2e/tsconfig's stricter
 * settings rejects `query<UserRow>(...)` with TS2344.
 */
export interface UserRow {
  id: string;
  email: string;
  role: string;
  tenantId: string | null;
  isActive: boolean;
  isEmailVerified: boolean;
  firstName: string | null;
  lastName: string | null;
  createdAt: Date;
  updatedAt: Date;
  [key: string]: unknown;
}

/**
 * Row type for a tenant record from auth.tenants.
 * See UserRow for the index-signature rationale.
 */
export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  maxUsers: number;
  userCount: number;
  createdAt: Date;
  updatedAt: Date;
  [key: string]: unknown;
}

/**
 * Direct PostgreSQL helper for E2E tests.
 *
 * Provides type-safe database access for:
 * - Verifying data was persisted correctly after API calls
 * - Setting up test fixtures directly in the database
 * - Cleaning up test data after tests complete
 *
 * This bypasses all application layers (ORM, guards, interceptors)
 * to provide ground-truth assertions.
 */
export class TestDatabase {
  private pool: Pool;
  private closed = false;
  private readonly config: PoolConfig;

  constructor(connectionString?: string) {
    this.config = {
      connectionString: connectionString ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    };
    this.pool = new Pool(this.config);
  }

  async connect(): Promise<void> {
    if (this.closed) {
      this.pool = new Pool(this.config);
      this.closed = false;
    }
    await this.query('SELECT 1');
  }

  async disconnect(): Promise<void> {
    await this.close();
  }

  /**
   * Execute a parameterized SQL query.
   * Always use parameterized queries to prevent SQL injection.
   */
  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    if (this.closed) {
      throw new Error('TestDatabase pool is closed');
    }
    return this.pool.query<T>(sql, params);
  }

  /**
   * Close the connection pool.
   * Must be called in global teardown or afterAll.
   */
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      await this.pool.end();
    }
  }

  /**
   * Check if the database connection is healthy.
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.query('SELECT 1 AS health');
      return true;
    } catch {
      return false;
    }
  }

  // ── User Helpers ──────────────────────────────────────────

  /**
   * Look up a user by ID from auth.users.
   */
  async getUserById(userId: string): Promise<UserRow | null> {
    const result = await this.query<UserRow>(
      `SELECT id, email, role, "tenantId", "isActive", "isEmailVerified",
              "firstName", "lastName", "createdAt", "updatedAt"
       FROM auth.users WHERE id = $1`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Look up a user by email from auth.users.
   */
  async getUserByEmail(email: string): Promise<UserRow | null> {
    const result = await this.query<UserRow>(
      `SELECT id, email, role, "tenantId", "isActive", "isEmailVerified",
              "firstName", "lastName", "createdAt", "updatedAt"
       FROM auth.users WHERE email = $1`,
      [email],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Count users for a given tenant.
   */
  async countTenantUsers(tenantId: string): Promise<number> {
    const result = await this.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM auth.users WHERE "tenantId" = $1',
      [tenantId],
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  // ── Tenant Helpers ────────────────────────────────────────

  /**
   * Look up a tenant by ID from auth.tenants.
   */
  async getTenantById(tenantId: string): Promise<TenantRow | null> {
    const result = await this.query<TenantRow>(
      `SELECT id, name, slug, status, plan, "maxUsers", "userCount",
              "createdAt", "updatedAt"
       FROM auth.tenants WHERE id = $1`,
      [tenantId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Look up a tenant by slug.
   */
  async getTenantBySlug(slug: string): Promise<TenantRow | null> {
    const result = await this.query<TenantRow>(
      `SELECT id, name, slug, status, plan, "maxUsers", "userCount",
              "createdAt", "updatedAt"
       FROM auth.tenants WHERE slug = $1`,
      [slug],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Check if a tenant-specific schema exists.
   * Tenant schemas follow the pattern: tenant_{first16hex_of_uuid}
   */
  async tenantSchemaExists(tenantId: string): Promise<boolean> {
    const schemaName = `tenant_${tenantId.replace(/-/g, '').slice(0, 16)}`;
    const result = await this.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.schemata
         WHERE schema_name = $1
       ) AS exists`,
      [schemaName],
    );
    return result.rows[0]?.exists ?? false;
  }

  /**
   * Get the tenant schema name from a tenant ID.
   */
  getTenantSchemaName(tenantId: string): string {
    return `tenant_${tenantId.replace(/-/g, '').slice(0, 16)}`;
  }

  // ── Schema Helpers ────────────────────────────────────────

  /**
   * List all schemas in the database.
   */
  async listSchemas(): Promise<string[]> {
    const result = await this.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       ORDER BY schema_name`,
    );
    return result.rows.map((r) => r.schema_name);
  }

  /**
   * Check if a table exists in a given schema.
   */
  async tableExists(schema: string, table: string): Promise<boolean> {
    const result = await this.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = $2
       ) AS exists`,
      [schema, table],
    );
    return result.rows[0]?.exists ?? false;
  }

  async findById<T extends Record<string, unknown> = Record<string, unknown>>(
    table: string,
    id: string,
    tenantId: string,
  ): Promise<T | null> {
    const safeTable = validateTestIdentifier(table);
    const schemaName = this.getTenantSchemaName(tenantId);
    const result = await this.query<T>(
      `SELECT * FROM "${schemaName}"."${safeTable}" WHERE id = $1 LIMIT 1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async exists(table: string, id: string, tenantId: string): Promise<boolean> {
    const safeTable = validateTestIdentifier(table);
    const schemaName = this.getTenantSchemaName(tenantId);
    const result = await this.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM "${schemaName}"."${safeTable}" WHERE id = $1
       ) AS exists`,
      [id],
    );
    return result.rows[0]?.exists ?? false;
  }

  async cleanupTenant(tenantId: string, tables: string[]): Promise<void> {
    const schemaName = this.getTenantSchemaName(tenantId);
    for (const table of tables) {
      const safeTable = validateTestIdentifier(table);
      await this.query(`DELETE FROM "${schemaName}"."${safeTable}"`);
    }
  }

  async getAuditLogs(
    tenantId: string,
    limit = 10,
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.query<Record<string, unknown>>(
      `SELECT * FROM auth.audit_logs
       WHERE "tenantId" = $1
       ORDER BY "createdAt" DESC
       LIMIT $2`,
      [tenantId, limit],
    );
    return result.rows;
  }

  async getUserStatus(
    userId: string,
  ): Promise<{ status: string | null; isActive: boolean | null; email: string } | null> {
    const result = await this.query<{ status: string | null; isActive: boolean | null; email: string }>(
      `SELECT status, "isActive", email FROM auth.users WHERE id = $1`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  // ── Cleanup Helpers ───────────────────────────────────────

  /**
   * Delete a user by ID. Use for test cleanup.
   */
  async deleteUser(userId: string): Promise<void> {
    await this.query('DELETE FROM auth.users WHERE id = $1', [userId]);
  }

  /**
   * Delete a tenant and drop its schema. Use for test cleanup.
   */
  async deleteTenant(tenantId: string): Promise<void> {
    const schemaName = this.getTenantSchemaName(tenantId);

    // Drop tenant schema if it exists (CASCADE to remove all objects)
    await this.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);

    // Remove tenant record
    await this.query('DELETE FROM auth.tenants WHERE id = $1', [tenantId]);
  }

  /**
   * Delete all users associated with a tenant.
   */
  async deleteTenantUsers(tenantId: string): Promise<void> {
    await this.query(
      'DELETE FROM auth.users WHERE "tenantId" = $1',
      [tenantId],
    );
  }
}

const sharedDb = new TestDatabase();

function validateTestIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier in E2E helper: ${identifier}`);
  }
  return identifier;
}

export function getTenantSchemaName(tenantId: string): string {
  return sharedDb.getTenantSchemaName(tenantId);
}

export async function findTenantById(tenantId: string): Promise<TenantRow | null> {
  return sharedDb.getTenantById(tenantId);
}

/**
 * Look up a tenant by id from auth.tenants (ground-truth read).
 * Alias of findTenantById used by the tenant fixture's lifecycle helpers.
 */
export async function getTenantById(tenantId: string): Promise<TenantRow | null> {
  return sharedDb.getTenantById(tenantId);
}

/**
 * Look up a tenant by slug from auth.tenants (ground-truth read).
 * Used by createTestTenant to resolve the canonical tenant id after async
 * REST provisioning (the 202 response does not surface the id).
 */
export async function getTenantBySlug(slug: string): Promise<TenantRow | null> {
  return sharedDb.getTenantBySlug(slug);
}

/**
 * Drop a tenant's schema (CASCADE) and delete its auth.tenants row plus its
 * users (ground-truth teardown). Delegates to TestDatabase.deleteTenant +
 * deleteTenantUsers so specs can tear down without holding a TestDatabase.
 */
export async function deleteTenantById(tenantId: string): Promise<void> {
  await sharedDb.deleteTenantUsers(tenantId);
  await sharedDb.deleteTenant(tenantId);
}

export async function findUserById(userId: string): Promise<UserRow | null> {
  return sharedDb.getUserById(userId);
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  return sharedDb.getUserByEmail(email);
}

export async function findUserRoleAssignment(
  tenantId: string,
  userId: string,
): Promise<Record<string, unknown> | null> {
  const schemaName = getTenantSchemaName(tenantId);
  const result = await sharedDb.query<Record<string, unknown>>(
    `SELECT * FROM "${schemaName}"."user_role_assignments"
     WHERE user_id = $1 AND is_active = true
     LIMIT 1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function deleteUserById(userId: string): Promise<void> {
  await sharedDb.deleteUser(userId);
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await sharedDb.query<T>(sql, params);
  return result.rows;
}

export async function tenantSchemaExists(tenantId: string): Promise<boolean> {
  return sharedDb.tenantSchemaExists(tenantId);
}

export async function getTenantSchemaTables(tenantId: string): Promise<string[]> {
  const schemaName = getTenantSchemaName(tenantId);
  const result = await sharedDb.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = $1
       AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    [schemaName],
  );
  return result.rows.map((row) => row.table_name);
}

export async function closePool(): Promise<void> {
  await sharedDb.close();
}
