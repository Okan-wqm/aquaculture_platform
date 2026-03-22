import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

/**
 * Regex for validating SQL identifiers to prevent SQL injection.
 * Allows: letters, digits, underscores. Must start with letter or underscore.
 */
const SAFE_IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * UUID v4 validation regex
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PostgreSQL error code for duplicate object (policy/constraint already exists)
 */
const PG_DUPLICATE_OBJECT = '42710';

/**
 * TenantRlsService
 *
 * Manages PostgreSQL Row-Level Security (RLS) policies for tenant isolation.
 * Provides methods to:
 * - Enable RLS on tables
 * - Create tenant isolation policies
 * - Set tenant context for transaction-scoped RLS
 *
 * All SQL identifiers are validated against injection attacks.
 */
@Injectable()
export class TenantRlsService {
  private readonly logger = new Logger(TenantRlsService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Validate that a string is a safe SQL identifier.
   * Prevents SQL injection by ensuring only alphanumeric characters and underscores are used.
   *
   * @throws Error if the identifier is not safe
   */
  private validateIdentifier(identifier: string, label: string): void {
    if (!identifier || !SAFE_IDENTIFIER_REGEX.test(identifier)) {
      throw new Error(
        `Invalid SQL identifier for ${label}: "${identifier}". ` +
        `Must match pattern: ${SAFE_IDENTIFIER_REGEX.source}`,
      );
    }
  }

  /**
   * Generate SQL to enable Row-Level Security on a table.
   *
   * @param schema - The PostgreSQL schema name
   * @param table - The table name
   * @returns The ALTER TABLE ENABLE RLS SQL statement
   */
  generateEnableRlsSql(schema: string, table: string): string {
    this.validateIdentifier(schema, 'schema');
    this.validateIdentifier(table, 'table');
    return `ALTER TABLE "${schema}"."${table}" ENABLE ROW LEVEL SECURITY`;
  }

  /**
   * Generate SQL to force Row-Level Security on a table.
   * FORCE ensures that even table owners are subject to RLS policies.
   *
   * @param schema - The PostgreSQL schema name
   * @param table - The table name
   * @returns The ALTER TABLE FORCE RLS SQL statement
   */
  generateForceRlsSql(schema: string, table: string): string {
    this.validateIdentifier(schema, 'schema');
    this.validateIdentifier(table, 'table');
    return `ALTER TABLE "${schema}"."${table}" FORCE ROW LEVEL SECURITY`;
  }

  /**
   * Generate SQL to create a tenant isolation policy on a table.
   * The policy uses current_setting('app.current_tenant') to match the tenantId column.
   *
   * @param schema - The PostgreSQL schema name
   * @param table - The table name
   * @param tenantIdColumn - The column name for tenant ID (default: 'tenantId')
   * @returns The CREATE POLICY SQL statement
   */
  generateCreatePolicySql(
    schema: string,
    table: string,
    tenantIdColumn: string = 'tenantId',
  ): string {
    this.validateIdentifier(schema, 'schema');
    this.validateIdentifier(table, 'table');
    this.validateIdentifier(tenantIdColumn, 'tenantIdColumn');

    const policyName = `tenant_isolation_${schema}_${table}`;

    return (
      `CREATE POLICY "${policyName}" ON "${schema}"."${table}" ` +
      `FOR ALL ` +
      `USING ("${tenantIdColumn}" = current_setting('app.current_tenant')::text)`
    );
  }

  /**
   * Set the tenant context for RLS using SET LOCAL (transaction-scoped).
   * Must be called within a transaction for the context to be effective.
   *
   * Uses set_config('app.current_tenant', tenantId, true) where true = is_local,
   * making the setting transaction-scoped and preventing leakage across connections.
   *
   * @param manager - The EntityManager (within a transaction)
   * @param tenantId - The tenant UUID to set as context
   * @throws Error if tenantId is not a valid UUID
   */
  async setTenantContext(manager: EntityManager, tenantId: string): Promise<void> {
    if (!tenantId || !UUID_REGEX.test(tenantId)) {
      throw new Error(
        `tenantId must be a valid UUID for RLS context, got: "${tenantId}"`,
      );
    }

    // Use set_config with is_local=true for transaction-scoped setting
    // This is equivalent to SET LOCAL but parameterized to prevent injection
    await manager.query(
      `SELECT set_config('app.current_tenant', $1, true) /* SET LOCAL for RLS */`,
      [tenantId],
    );
  }

  /**
   * Enable RLS on a table and create the tenant isolation policy.
   * Handles "already exists" errors gracefully for idempotent execution.
   *
   * @param schema - The PostgreSQL schema name
   * @param table - The table name
   * @param tenantIdColumn - The column name for tenant ID (default: 'tenantId')
   */
  async enableRls(
    schema: string,
    table: string,
    tenantIdColumn: string = 'tenantId',
  ): Promise<void> {
    // Enable RLS on the table
    const enableSql = this.generateEnableRlsSql(schema, table);
    try {
      await this.dataSource.query(enableSql);
      this.logger.log(`RLS enabled on "${schema}"."${table}"`);
    } catch (err: unknown) {
      if (this.isDuplicateError(err)) {
        this.logger.debug(`RLS already enabled on "${schema}"."${table}"`);
      } else {
        throw err;
      }
    }

    // Create the tenant isolation policy
    const policySql = this.generateCreatePolicySql(schema, table, tenantIdColumn);
    try {
      await this.dataSource.query(policySql);
      this.logger.log(`RLS policy created for "${schema}"."${table}"`);
    } catch (err: unknown) {
      if (this.isDuplicateError(err)) {
        this.logger.debug(`RLS policy already exists for "${schema}"."${table}"`);
      } else {
        throw err;
      }
    }
  }

  /**
   * Check if an error is a PostgreSQL duplicate object error.
   */
  private isDuplicateError(err: unknown): boolean {
    if (err && typeof err === 'object') {
      const pgErr = err as { code?: string; message?: string };
      if (pgErr.code === PG_DUPLICATE_OBJECT) {
        return true;
      }
      // Some PostgreSQL versions/drivers report this differently
      if (pgErr.message?.includes('already exists') || pgErr.message?.includes('already enabled')) {
        return true;
      }
    }
    return false;
  }
}
