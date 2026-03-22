import { Client, QueryResult } from 'pg';

/**
 * Test Database Helper
 *
 * Direct database access for backend verification in E2E tests.
 * Bypasses GraphQL to verify actual database state.
 */
export class TestDatabase {
  private client: Client | null = null;

  constructor(
    private readonly connectionConfig?: {
      host?: string;
      port?: number;
      database?: string;
      user?: string;
      password?: string;
    },
  ) {}

  /**
   * Connect to the database
   */
  async connect(): Promise<void> {
    this.client = new Client({
      host: this.connectionConfig?.host ?? process.env['DB_HOST'] ?? 'localhost',
      port: this.connectionConfig?.port ?? Number(process.env['DB_PORT'] ?? 5432),
      database: this.connectionConfig?.database ?? process.env['DB_NAME'] ?? 'aquaculture',
      user: this.connectionConfig?.user ?? process.env['DB_USER'] ?? 'aquaculture',
      password: this.connectionConfig?.password ?? process.env['DB_PASSWORD'] ?? 'aquaculture',
    });

    await this.client.connect();
  }

  /**
   * Execute a query with parameters
   */
  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    if (!this.client) {
      throw new Error('Database not connected. Call connect() first.');
    }
    return this.client.query<T>(sql, params);
  }

  /**
   * Find a single row by query
   */
  async findOne<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T | null> {
    const result = await this.query<T>(sql, params);
    return result.rows[0] ?? null;
  }

  /**
   * Find multiple rows
   */
  async findMany<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    const result = await this.query<T>(sql, params);
    return result.rows;
  }

  /**
   * Check if a user exists and get their active status
   */
  async getUserStatus(userId: string): Promise<{ isActive: boolean; email: string } | null> {
    const row = await this.findOne<{ isActive: boolean; email: string }>(
      'SELECT "isActive", email FROM auth.users WHERE id = $1',
      [userId],
    );
    return row;
  }

  /**
   * Get a tenant by ID
   */
  async getTenant(tenantId: string): Promise<Record<string, unknown> | null> {
    return this.findOne(
      'SELECT * FROM auth.tenants WHERE id = $1',
      [tenantId],
    );
  }

  /**
   * Get audit logs for a tenant
   */
  async getAuditLogs(
    tenantId: string,
    limit = 10,
  ): Promise<Array<Record<string, unknown>>> {
    return this.findMany(
      'SELECT * FROM auth.audit_logs WHERE "tenantId" = $1 ORDER BY "createdAt" DESC LIMIT $2',
      [tenantId, limit],
    );
  }

  /**
   * Disconnect from the database
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }
}
