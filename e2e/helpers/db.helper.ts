/**
 * Database Test Helper
 * Direct PostgreSQL access for E2E test verification.
 */
import { Client, QueryResult } from 'pg';

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'aquaculture',
  user: process.env.DB_USER || 'aquaculture',
  password: process.env.DB_PASSWORD || 'aquaculture',
};

export class TestDatabase {
  private client: Client | null = null;

  async connect(): Promise<void> {
    this.client = new Client(DB_CONFIG);
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }

  /**
   * Execute a raw SQL query.
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
   * Find a single row by table + id + tenantId.
   */
  async findById(
    table: string,
    id: string,
    tenantId: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.query(
      `SELECT * FROM "${table}" WHERE "id" = $1 AND "tenantId" = $2`,
      [id, tenantId],
    );
    return (result.rows[0] as Record<string, unknown>) || null;
  }

  /**
   * Count rows in a table for a given tenant.
   */
  async countByTenant(table: string, tenantId: string): Promise<number> {
    const result = await this.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM "${table}" WHERE "tenantId" = $1`,
      [tenantId],
    );
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Delete test data by tenantId (cleanup).
   */
  async cleanupTenant(tenantId: string, tables: string[]): Promise<void> {
    for (const table of tables) {
      await this.query(`DELETE FROM "${table}" WHERE "tenantId" = $1`, [
        tenantId,
      ]);
    }
  }

  /**
   * Check if a row exists.
   */
  async exists(
    table: string,
    id: string,
    tenantId: string,
  ): Promise<boolean> {
    const result = await this.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM "${table}" WHERE "id" = $1 AND "tenantId" = $2) as exists`,
      [id, tenantId],
    );
    return result.rows[0].exists;
  }

  /**
   * Check for soft-deleted rows.
   */
  async isSoftDeleted(
    table: string,
    id: string,
    tenantId: string,
  ): Promise<boolean> {
    const result = await this.query<{ is_deleted: boolean }>(
      `SELECT "isDeleted" as is_deleted FROM "${table}" WHERE "id" = $1 AND "tenantId" = $2`,
      [id, tenantId],
    );
    if (result.rows.length === 0) return false;
    return result.rows[0].is_deleted;
  }
}
