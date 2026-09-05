/**
 * Database Monitoring Service
 *
 * Provides database performance monitoring, slow query detection with
 * graceful fallback, and index optimization recommendations.
 */

import {
  ScheduledJob,
  ScheduledJobRunner,
  type ScheduledJobExecutor,
} from '@aquaculture/backend-common/scheduling';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource, LessThan, QueryRunner, Repository } from 'typeorm';

import {
  TenantSchema,
  SchemaStatus,
  DatabaseMetric,
  SlowQueryLog,
  DatabaseMetricData,
  IndexRecommendation,
  DatabaseHealthStatus,
  HealthCheck,
  SlowQueryResult,
} from '../entities/database-management.entity';

// ============================================================================
// Configuration
// ============================================================================

const SLOW_QUERY_THRESHOLD_MS = 1000; // 1 second
const CONNECTION_WARNING_THRESHOLD = 0.7; // 70%
const CONNECTION_CRITICAL_THRESHOLD = 0.9; // 90%

type DbScalar = boolean | number | string | null | undefined;

interface ConnectionStatsRow {
  total?: DbScalar;
  active?: DbScalar;
  idle?: DbScalar;
  waiting?: DbScalar;
}

interface MaxConnectionsRow {
  max_connections?: DbScalar;
}

function parseDbInt(value: DbScalar, fallback = 0): number {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ignoreRollbackError(_error: unknown): void {
  void _error;
}

async function queryRows<T extends object>(
  queryRunner: QueryRunner,
  query: string,
  parameters?: unknown[],
): Promise<T[]> {
  const result: unknown = await queryRunner.query(query, parameters);
  return Array.isArray(result) ? (result as T[]) : [];
}

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class DatabaseMonitoringService {
  private readonly logger = new Logger(DatabaseMonitoringService.name);

  constructor(
    @InjectRepository(TenantSchema)
    private readonly schemaRepository: Repository<TenantSchema>,
    @InjectRepository(DatabaseMetric)
    private readonly metricRepository: Repository<DatabaseMetric>,
    @InjectRepository(SlowQueryLog)
    private readonly slowQueryRepository: Repository<SlowQueryLog>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(ScheduledJobRunner) readonly scheduledJobs: ScheduledJobExecutor,
  ) {}

  // ============================================================================
  // Connection Monitoring
  // ============================================================================

  /**
   * Get current connection statistics
   */
  async getConnectionStats(): Promise<{
    total: number;
    active: number;
    idle: number;
    waiting: number;
    maxConnections: number;
    utilizationPercent: number;
  }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const stats = await queryRows<ConnectionStatsRow>(
        queryRunner,
        `
        SELECT
          count(*) as total,
          count(*) FILTER (WHERE state = 'active') as active,
          count(*) FILTER (WHERE state = 'idle') as idle,
          count(*) FILTER (WHERE wait_event IS NOT NULL AND state != 'idle') as waiting
        FROM pg_stat_activity
        WHERE datname = current_database()
      `,
      );

      const maxConnResult = await queryRows<MaxConnectionsRow>(queryRunner, `SHOW max_connections`);
      const maxConnections = parseDbInt(maxConnResult[0]?.max_connections, 100);
      const total = parseDbInt(stats[0]?.total);

      return {
        total,
        active: parseDbInt(stats[0]?.active),
        idle: parseDbInt(stats[0]?.idle),
        waiting: parseDbInt(stats[0]?.waiting),
        maxConnections,
        utilizationPercent: (total / maxConnections) * 100,
      };
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get connections by tenant
   */
  async getConnectionsByTenant(): Promise<
    Array<{
      tenantId: string;
      schemaName: string;
      activeConnections: number;
      maxConnections: number;
    }>
  > {
    const schemas = await this.schemaRepository.find({
      where: { status: 'active' as SchemaStatus },
    });

    return schemas.map((schema) => ({
      tenantId: schema.tenantId,
      schemaName: schema.schemaName,
      activeConnections: schema.connectionCount,
      maxConnections: schema.maxConnections,
    }));
  }

  // ============================================================================
  // Query Performance
  // ============================================================================

  /**
   * Get query performance stats
   */
  async getQueryPerformanceStats(): Promise<{
    totalQueries: number;
    avgExecutionTime: number;
    slowQueries: number;
    failedQueries: number;
    cacheHitRatio: number;
    queriesPerSecond: number;
  }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      // Get pg_stat_statements if available
      const pgStatExists = await queryRunner.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
        ) as exists
      `);

      if (pgStatExists[0]?.exists) {
        const stats = await queryRunner.query(
          `
          SELECT
            sum(calls) as total_queries,
            avg(mean_exec_time) as avg_time,
            count(*) FILTER (WHERE mean_exec_time > $1) as slow_queries,
            sum(calls) / GREATEST(EXTRACT(epoch FROM (max(stats_reset) - min(stats_reset))), 1) as qps
          FROM pg_stat_statements
        `,
          [SLOW_QUERY_THRESHOLD_MS],
        );

        return {
          totalQueries: parseInt(stats[0]?.total_queries || '0', 10),
          avgExecutionTime: parseFloat(stats[0]?.avg_time || '0'),
          slowQueries: parseInt(stats[0]?.slow_queries || '0', 10),
          failedQueries: 0,
          cacheHitRatio: await this.getCacheHitRatio(),
          queriesPerSecond: parseFloat(stats[0]?.qps || '0'),
        };
      }

      // Fallback to basic stats
      return {
        totalQueries: 0,
        avgExecutionTime: 0,
        slowQueries: await this.slowQueryRepository.count(),
        failedQueries: 0,
        cacheHitRatio: await this.getCacheHitRatio(),
        queriesPerSecond: 0,
      };
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get cache hit ratio
   */
  private async getCacheHitRatio(): Promise<number> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const result = await queryRunner.query(`
        SELECT
          sum(heap_blks_hit) / NULLIF(sum(heap_blks_hit) + sum(heap_blks_read), 0) as ratio
        FROM pg_statio_user_tables
      `);

      return parseFloat(result[0]?.ratio || '0') * 100;
    } finally {
      await queryRunner.release();
    }
  }

  // ============================================================================
  // Slow Query Detection
  // ============================================================================

  /**
   * Log slow query
   */
  async logSlowQuery(
    query: string,
    executionTimeMs: number,
    tenantId?: string,
    schemaName?: string,
    userId?: string,
  ): Promise<SlowQueryLog> {
    const slowQuery = this.slowQueryRepository.create({
      tenantId,
      schemaName,
      query: query.substring(0, 10000), // Limit query length
      normalizedQuery: this.normalizeQuery(query),
      executionTimeMs,
      recordedAt: new Date(),
      userId,
    });

    return this.slowQueryRepository.save(slowQuery);
  }

  /**
   * Normalize query for grouping
   */
  private normalizeQuery(query: string): string {
    return query
      .replace(/\$\d+/g, '?') // Replace numbered params
      .replace(/'[^']*'/g, "'?'") // Replace string literals
      .replace(/\b\d+\b/g, '?') // Replace numbers
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim()
      .substring(0, 500);
  }

  /**
   * Slow query monitoring with graceful fallback.
   *
   * Primary source: slow_query_logs table — internal log of queries that
   * exceeded the configured threshold. Populated by the application layer
   * via logSlowQuery().
   *
   * Enrichment source: pg_stat_statements extension — provides historical
   * query-level statistics including execution time, call count, and row
   * counts. Requires the extension to be installed AND loaded via
   * shared_preload_libraries.
   *
   * Fallback enrichment: pg_stat_activity — provides currently running
   * queries with their elapsed time. Always available, but only shows
   * active queries (not historical statistics).
   *
   * The endpoint attempts slow_query_logs first (always available). When
   * grouped=true, it also attempts pg_stat_statements for richer stats.
   * If that extension is unavailable (common in managed databases or
   * TimescaleDB setups that don't preload it), it falls back gracefully
   * to pg_stat_activity with a clear indication in the response metadata.
   */
  async getSlowQueries(options: {
    tenantId?: string;
    limit?: number;
    minExecutionTime?: number;
    groupByQuery?: boolean;
  }): Promise<SlowQueryResult> {
    const {
      tenantId,
      limit = 50,
      minExecutionTime = SLOW_QUERY_THRESHOLD_MS,
      groupByQuery = false,
    } = options;

    if (groupByQuery) {
      return this.getGroupedSlowQueries(tenantId, minExecutionTime, limit);
    }

    const where: Record<string, unknown> = {};
    if (tenantId) where.tenantId = tenantId;

    try {
      const queries = await this.slowQueryRepository.find({
        where,
        order: { executionTimeMs: 'DESC' },
        take: limit,
      });

      return {
        source: 'slow_query_logs',
        data: queries.map((q) => ({ ...q })),
        metadata: {
          total: queries.length,
          limit,
          minExecutionTimeMs: minExecutionTime,
        },
      };
    } catch (error) {
      this.logger.error(
        `Failed to fetch slow queries: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        source: 'none',
        data: [],
        metadata: {
          total: 0,
          limit,
          minExecutionTimeMs: minExecutionTime,
          error: 'Failed to retrieve slow query logs',
        },
      };
    }
  }

  /**
   * Retrieve grouped slow queries from the slow_query_logs table.
   * Column names use quoted camelCase to match TypeORM's default naming strategy.
   *
   * Falls back to pg_stat_statements or pg_stat_activity for enrichment
   * when the slow_query_logs table has no matching records.
   */
  private async getGroupedSlowQueries(
    tenantId: string | undefined,
    minExecutionTime: number,
    limit: number,
  ): Promise<SlowQueryResult> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      // Primary: query the slow_query_logs table using correct camelCase column names
      const params: (number | string)[] = [minExecutionTime];
      let tenantFilter = '';
      if (tenantId) {
        params.push(tenantId);
        tenantFilter = `AND "tenantId" = $${params.length}`;
      }
      params.push(limit);
      const limitParam = `$${params.length}`;

      const results = await queryRunner.query(
        `
        SELECT
          "normalizedQuery" as query,
          count(*)::text as count,
          avg("executionTimeMs")::text as avg_time,
          max("executionTimeMs") as max_time,
          min("executionTimeMs") as min_time,
          max("recordedAt") as last_seen
        FROM slow_query_logs
        WHERE "executionTimeMs" >= $1
          ${tenantFilter}
        GROUP BY "normalizedQuery"
        ORDER BY count(*) DESC
        LIMIT ${limitParam}
      `,
        params,
      );

      if (results.length > 0) {
        return {
          source: 'slow_query_logs',
          data: results.map((r: Record<string, unknown>) => ({
            query: r.query as string,
            count: parseInt(r.count as string, 10),
            avgTime: parseFloat(r.avg_time as string),
            maxTime: parseInt(String(r.max_time), 10),
            minTime: parseInt(String(r.min_time), 10),
            lastSeen: r.last_seen as string,
          })),
          metadata: {
            total: results.length,
            limit,
            minExecutionTimeMs: minExecutionTime,
          },
        };
      }

      // No records in slow_query_logs — attempt enrichment from pg_stat_statements
      return await this.getSlowQueriesFromPgStats(queryRunner, limit);
    } catch (error) {
      this.logger.error(
        `Failed to fetch grouped slow queries: ${error instanceof Error ? error.message : String(error)}`,
      );

      // Fallback: attempt pg_stat_activity (always available)
      try {
        return await this.getSlowQueriesFromPgActivity(queryRunner, limit);
      } catch (fallbackError) {
        this.logger.error(
          `Fallback to pg_stat_activity also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        );
        return {
          source: 'none',
          data: [],
          metadata: {
            total: 0,
            limit,
            minExecutionTimeMs: minExecutionTime,
            error: 'All slow query sources unavailable',
          },
        };
      }
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Attempt to retrieve slow query statistics from pg_stat_statements.
   * This extension must be installed and loaded via shared_preload_libraries.
   * If unavailable, falls back to pg_stat_activity.
   */
  private async getSlowQueriesFromPgStats(
    queryRunner: ReturnType<DataSource['createQueryRunner']>,
    limit: number,
  ): Promise<SlowQueryResult> {
    // Check if pg_stat_statements extension is available
    const extCheck = await queryRunner.query(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') as exists`,
    );

    if (!extCheck[0]?.exists) {
      this.logger.warn(
        'pg_stat_statements extension is not installed by db-migrate/infra. ' +
          'Falling back to pg_stat_activity for active query monitoring.',
      );
      return this.getSlowQueriesFromPgActivity(queryRunner, limit);
    }

    try {
      const results = await queryRunner.query(
        `
        SELECT
          query,
          calls::text as count,
          mean_exec_time::text as avg_time,
          max_exec_time as max_time,
          min_exec_time as min_time,
          total_exec_time as total_time,
          rows as total_rows
        FROM pg_stat_statements
        WHERE query NOT LIKE '%pg_stat_statements%'
          AND calls > 0
        ORDER BY mean_exec_time DESC
        LIMIT $1
      `,
        [limit],
      );

      return {
        source: 'pg_stat_statements',
        data: results.map((r: Record<string, unknown>) => ({
          query: r.query as string,
          count: parseInt(r.count as string, 10),
          avgTime: parseFloat(r.avg_time as string),
          maxTime: parseFloat(String(r.max_time)),
          minTime: parseFloat(String(r.min_time)),
          totalTime: parseFloat(String(r.total_time)),
          totalRows: parseInt(String(r.total_rows), 10),
        })),
        metadata: {
          total: results.length,
          limit,
          note: 'Data sourced from pg_stat_statements extension (historical query statistics)',
        },
      };
    } catch (queryError) {
      this.logger.warn(
        `pg_stat_statements query failed: ${queryError instanceof Error ? queryError.message : String(queryError)}. ` +
          'Falling back to pg_stat_activity.',
      );
      return this.getSlowQueriesFromPgActivity(queryRunner, limit);
    }
  }

  /**
   * Retrieve currently running slow queries from pg_stat_activity.
   * This view is always available in PostgreSQL and does not require
   * any extensions. It only shows currently active queries, not historical data.
   */
  private async getSlowQueriesFromPgActivity(
    queryRunner: ReturnType<DataSource['createQueryRunner']>,
    limit: number,
  ): Promise<SlowQueryResult> {
    const results = await queryRunner.query(
      `
      SELECT
        query,
        state,
        EXTRACT(EPOCH FROM (now() - query_start))::numeric * 1000 as elapsed_ms,
        usename as username,
        datname as database,
        application_name,
        client_addr,
        query_start,
        wait_event_type,
        wait_event
      FROM pg_stat_activity
      WHERE state != 'idle'
        AND query NOT LIKE '%pg_stat_activity%'
        AND datname = current_database()
        AND pid != pg_backend_pid()
      ORDER BY query_start ASC
      LIMIT $1
    `,
      [limit],
    );

    return {
      source: 'pg_stat_activity',
      data: results.map((r: Record<string, unknown>) => ({
        query: r.query as string,
        state: r.state as string,
        elapsedMs: parseFloat(String(r.elapsed_ms)),
        username: r.username as string,
        database: r.database as string,
        applicationName: r.application_name as string,
        clientAddr: r.client_addr as string,
        queryStart: r.query_start as string,
        waitEventType: r.wait_event_type as string | null,
        waitEvent: r.wait_event as string | null,
      })),
      metadata: {
        total: results.length,
        limit,
        note:
          'Data sourced from pg_stat_activity (currently running queries only). ' +
          'Install pg_stat_statements extension and add it to shared_preload_libraries ' +
          'for historical query statistics.',
      },
    };
  }

  /**
   * Validate schema name to prevent SQL injection
   * Only allows alphanumeric characters, underscores, and hyphens
   */
  private validateSchemaName(schemaName: string): boolean {
    const SCHEMA_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/;
    return SCHEMA_NAME_PATTERN.test(schemaName);
  }

  /**
   * Allowlist-based query validation for EXPLAIN execution.
   *
   * SQL Injection Prevention Strategy (C-13):
   * ──────────────────────────────────────────
   * A blocklist approach (forbidding known-bad patterns) is inherently bypassable
   * because attackers can use encoding tricks, Unicode normalization, or novel SQL
   * syntax to evade pattern matching. Instead, this method uses a strict allowlist:
   *
   * 1. **Length limit**: Rejects queries exceeding MAX_EXPLAIN_QUERY_LENGTH (10,000 chars)
   *    to prevent DoS via oversized payloads.
   *
   * 2. **Statement-chaining prevention**: Rejects any query containing semicolons,
   *    which prevents executing multiple statements.
   *
   * 3. **Allowlist-first parsing**: The query MUST begin with SELECT, WITH, or VALUES
   *    (after trimming whitespace). This is an allowlist — only known-safe read-only
   *    statement types are permitted.
   *
   * 4. **Dangerous pattern rejection**: As defense-in-depth, known dangerous patterns
   *    (DDL, DML, PL/pgSQL blocks, session manipulation, system functions) are also
   *    rejected even if disguised within a SELECT.
   *
   * 5. **READ ONLY transaction**: The caller (analyzeQuery) wraps execution in a
   *    READ ONLY transaction so even if validation is bypassed, PostgreSQL itself
   *    will reject any write operation.
   *
   * @param query - The raw SQL query string to validate
   * @returns Validation result with error message if invalid
   */
  private validateQueryForExplain(query: string): { valid: boolean; error?: string } {
    /** Maximum allowed query length to prevent DoS via oversized payloads */
    const MAX_EXPLAIN_QUERY_LENGTH = 10000;

    // Step 1: Enforce maximum query length before any processing
    if (query.length > MAX_EXPLAIN_QUERY_LENGTH) {
      return {
        valid: false,
        error: `Query exceeds maximum allowed length (${MAX_EXPLAIN_QUERY_LENGTH} chars)`,
      };
    }

    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      return { valid: false, error: 'Query must not be empty' };
    }

    // Step 2: Reject statement chaining — no semicolons allowed anywhere
    if (trimmedQuery.includes(';')) {
      return { valid: false, error: 'Semicolons are not allowed in queries' };
    }

    // Step 3: Allowlist — query MUST start with a read-only statement type
    const normalizedQuery = trimmedQuery.toLowerCase();
    const ALLOWED_STATEMENT_PREFIXES = /^(select|with|values)\b/i;
    if (!ALLOWED_STATEMENT_PREFIXES.test(normalizedQuery)) {
      return { valid: false, error: 'Only SELECT, WITH, or VALUES queries can be analyzed' };
    }

    // Step 4: Defense-in-depth — reject dangerous patterns even within allowed statements
    const forbiddenPatterns: Array<{ pattern: RegExp; reason: string }> = [
      // DDL/DML keywords that should never appear in a read-only EXPLAIN context
      {
        pattern: /\b(insert|update|delete|drop|create|alter|truncate|grant|revoke|vacuum)\b/i,
        reason: 'DDL/DML statement',
      },
      // SQL comments can hide malicious payloads
      { pattern: /--/, reason: 'SQL line comment' },
      { pattern: /\/\*/, reason: 'SQL block comment' },
      // File system access functions
      { pattern: /\binto\s+outfile\b/i, reason: 'File write attempt' },
      { pattern: /\bload_file\b/i, reason: 'File read attempt' },
      { pattern: /\bpg_read_file\b/i, reason: 'PostgreSQL file read' },
      { pattern: /\bpg_write_file\b/i, reason: 'PostgreSQL file write' },
      // Time-based attack functions
      { pattern: /\bpg_sleep\b/i, reason: 'Time-based attack' },
      // Data exfiltration
      { pattern: /\bcopy\b/i, reason: 'COPY command' },
      // Dynamic SQL execution
      { pattern: /\bexec\b/i, reason: 'Dynamic execution' },
      { pattern: /\bexecute\b/i, reason: 'Dynamic execution' },
      // PL/pgSQL code blocks
      { pattern: /\bdo\s*\$/i, reason: 'PL/pgSQL block' },
      { pattern: /\$\$/, reason: 'Dollar-quoted string (potential code injection)' },
      // Session/config manipulation
      { pattern: /\bset\s+session\b/i, reason: 'Session manipulation' },
      { pattern: /\bset\s+local\b/i, reason: 'Local config manipulation' },
      // PostgreSQL-specific dangerous operations
      { pattern: /\braise\b/i, reason: 'Error raising' },
      { pattern: /\bnotify\b/i, reason: 'NOTIFY command' },
      { pattern: /\blisten\b/i, reason: 'LISTEN command' },
      // Large object functions
      { pattern: /\blo_import\b/i, reason: 'Large object import' },
      { pattern: /\blo_export\b/i, reason: 'Large object export' },
    ];

    for (const { pattern, reason } of forbiddenPatterns) {
      if (pattern.test(trimmedQuery)) {
        return { valid: false, error: `Query contains forbidden SQL pattern: ${reason}` };
      }
    }

    return { valid: true };
  }

  /**
   * Analyze a user-supplied query using PostgreSQL EXPLAIN.
   *
   * SECURITY (C-13): Multi-layered SQL injection prevention:
   * 1. Schema name is validated against a strict alphanumeric allowlist
   * 2. Query is validated via allowlist-based parsing (SELECT/WITH/VALUES only)
   * 3. Dangerous patterns are rejected as defense-in-depth
   * 4. Execution runs inside a READ ONLY transaction — PostgreSQL itself rejects
   *    any write operation even if validation is somehow bypassed
   * 5. ANALYZE is explicitly set to false so the query plan is estimated, not executed
   *
   * @param query - The SQL query to analyze (must be a SELECT/WITH/VALUES statement)
   * @param schemaName - Optional schema name to set as search_path context
   * @returns The EXPLAIN output as a JSON object
   * @throws Error if validation fails or the query cannot be analyzed
   */
  async analyzeQuery(query: string, schemaName?: string): Promise<Record<string, unknown>> {
    // Validate schema name if provided
    if (schemaName) {
      if (!this.validateSchemaName(schemaName)) {
        throw new Error(
          'Invalid schema name format. Only alphanumeric characters, underscores, and hyphens are allowed.',
        );
      }
    }

    // Validate query via allowlist-based parsing
    const queryValidation = this.validateQueryForExplain(query);
    if (!queryValidation.valid) {
      throw new Error(`Query validation failed: ${queryValidation.error}`);
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      // SECURITY: Start a READ ONLY transaction so PostgreSQL itself prevents writes.
      // This is the ultimate safety net — even if the allowlist validation is somehow
      // bypassed, the database engine will reject INSERT/UPDATE/DELETE/DDL operations.
      await queryRunner.query('BEGIN TRANSACTION READ ONLY');

      if (schemaName) {
        // Use identifier quoting for schema name (already validated against allowlist)
        await queryRunner.query(
          `SET LOCAL search_path TO ${queryRunner.connection.driver.escape(schemaName)}`,
        );
      }

      // EXPLAIN with ANALYZE false produces an estimated plan without executing the query.
      // Combined with READ ONLY transaction, this provides defense-in-depth.
      const result = await queryRunner.query(`EXPLAIN (FORMAT JSON, ANALYZE false) ${query}`);

      await queryRunner.query('COMMIT');

      return result[0]?.['QUERY PLAN'] || {};
    } catch (error) {
      // Rollback on any error to release the transaction
      await queryRunner.query('ROLLBACK').catch(ignoreRollbackError);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // ============================================================================
  // Storage Monitoring
  // ============================================================================

  /**
   * Get storage usage by tenant
   */
  async getStorageByTenant(): Promise<
    Array<{
      tenantId: string;
      schemaName: string;
      totalSizeBytes: number;
      dataSizeBytes: number;
      indexSizeBytes: number;
      tableCount: number;
    }>
  > {
    const schemas = await this.schemaRepository.find();
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const results: Array<{
        tenantId: string;
        schemaName: string;
        totalSizeBytes: number;
        dataSizeBytes: number;
        indexSizeBytes: number;
        tableCount: number;
      }> = [];

      for (const schema of schemas) {
        const sizeResult = await queryRunner.query(
          `
          SELECT
            COALESCE(SUM(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename))), 0) as total_size,
            COALESCE(SUM(pg_table_size(quote_ident(schemaname) || '.' || quote_ident(tablename))), 0) as data_size,
            COALESCE(SUM(pg_indexes_size(quote_ident(schemaname) || '.' || quote_ident(tablename))), 0) as index_size,
            count(*) as table_count
          FROM pg_tables
          WHERE schemaname = $1
        `,
          [schema.schemaName],
        );

        results.push({
          tenantId: schema.tenantId,
          schemaName: schema.schemaName,
          totalSizeBytes: parseInt(sizeResult[0]?.total_size || '0', 10),
          dataSizeBytes: parseInt(sizeResult[0]?.data_size || '0', 10),
          indexSizeBytes: parseInt(sizeResult[0]?.index_size || '0', 10),
          tableCount: parseInt(sizeResult[0]?.table_count || '0', 10),
        });
      }

      return results;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get total database storage
   */
  async getTotalStorage(): Promise<{
    totalSizeBytes: number;
    dataSizeBytes: number;
    indexSizeBytes: number;
    tempSizeBytes: number;
    walSizeBytes: number;
  }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const dbSize = await queryRunner.query(`SELECT pg_database_size(current_database()) as size`);

      const breakdown = await queryRunner.query(`
        SELECT
          COALESCE(SUM(pg_table_size(quote_ident(schemaname) || '.' || quote_ident(tablename))), 0) as data_size,
          COALESCE(SUM(pg_indexes_size(quote_ident(schemaname) || '.' || quote_ident(tablename))), 0) as index_size
        FROM pg_tables
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      `);

      return {
        totalSizeBytes: parseInt(dbSize[0]?.size || '0', 10),
        dataSizeBytes: parseInt(breakdown[0]?.data_size || '0', 10),
        indexSizeBytes: parseInt(breakdown[0]?.index_size || '0', 10),
        tempSizeBytes: 0, // Would need separate calculation
        walSizeBytes: 0, // Would need pg_wal access
      };
    } finally {
      await queryRunner.release();
    }
  }

  // ============================================================================
  // Index Optimization
  // ============================================================================

  /**
   * Get index recommendations
   */
  async getIndexRecommendations(schemaName?: string): Promise<IndexRecommendation[]> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const recommendations: IndexRecommendation[] = [];

      // Find tables with sequential scans but no indexes
      const seqScans = await queryRunner.query(
        `
        SELECT
          schemaname,
          relname as table_name,
          seq_scan,
          idx_scan,
          n_live_tup as row_count
        FROM pg_stat_user_tables
        WHERE seq_scan > idx_scan * 2
          AND n_live_tup > 1000
          ${schemaName ? 'AND schemaname = $1' : ''}
        ORDER BY seq_scan DESC
        LIMIT 10
      `,
        schemaName ? [schemaName] : [],
      );

      for (const table of seqScans) {
        // Get commonly filtered columns
        const columns = await this.suggestIndexColumns(table.schemaname, table.table_name);

        if (columns.length > 0) {
          recommendations.push({
            tableName: `${table.schemaname}.${table.table_name}`,
            columns,
            indexType: 'btree',
            reason: `High sequential scan count (${table.seq_scan}) with ${table.row_count} rows`,
            estimatedImpact: table.row_count > 10000 ? 'high' : 'medium',
            recommendedAction: 'add_index',
            indexName: `idx_${table.table_name}_${columns.join('_')}`,
            authority: 'db-migrate',
          });
        }
      }

      // Find unused indexes
      const unusedIndexes = await queryRunner.query(
        `
        SELECT
          schemaname,
          relname as table_name,
          indexrelname as index_name,
          pg_size_pretty(pg_relation_size(indexrelid)) as index_size
        FROM pg_stat_user_indexes
        WHERE idx_scan = 0
          AND schemaname NOT IN ('pg_catalog', 'information_schema')
          ${schemaName ? 'AND schemaname = $1' : ''}
        ORDER BY pg_relation_size(indexrelid) DESC
        LIMIT 10
      `,
        schemaName ? [schemaName] : [],
      );

      for (const idx of unusedIndexes) {
        recommendations.push({
          tableName: `${idx.schemaname}.${idx.table_name}`,
          columns: [],
          indexType: 'btree',
          reason: `Unused index "${idx.index_name}" (${idx.index_size})`,
          estimatedImpact: 'low',
          recommendedAction: 'review_unused_index',
          indexName: idx.index_name,
          authority: 'db-migrate',
        });
      }

      return recommendations;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Suggest columns for indexing
   */
  private async suggestIndexColumns(schemaName: string, tableName: string): Promise<string[]> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      // Get primary key columns (these typically need indexes on FKs)
      const result = await queryRunner.query(
        `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = $2
          AND (column_name LIKE '%_id' OR column_name LIKE '%_at' OR column_name = 'status')
        ORDER BY ordinal_position
        LIMIT 3
      `,
        [schemaName, tableName],
      );

      return result.map((r: Record<string, unknown>) => r.column_name as string);
    } finally {
      await queryRunner.release();
    }
  }

  // ============================================================================
  // Health Status
  // ============================================================================

  /**
   * Get database health status
   */
  async getDatabaseHealthStatus(): Promise<DatabaseHealthStatus> {
    const checks: HealthCheck[] = [];
    let score = 100;

    // Connection check
    const connStats = await this.getConnectionStats();
    const connUtilization = connStats.utilizationPercent / 100;

    if (connUtilization >= CONNECTION_CRITICAL_THRESHOLD) {
      checks.push({
        name: 'Connection Pool',
        status: 'fail',
        value: `${connStats.utilizationPercent.toFixed(1)}%`,
        threshold: `${CONNECTION_CRITICAL_THRESHOLD * 100}%`,
        message: 'Connection pool nearly exhausted',
      });
      score -= 30;
    } else if (connUtilization >= CONNECTION_WARNING_THRESHOLD) {
      checks.push({
        name: 'Connection Pool',
        status: 'warn',
        value: `${connStats.utilizationPercent.toFixed(1)}%`,
        threshold: `${CONNECTION_WARNING_THRESHOLD * 100}%`,
        message: 'Connection pool usage high',
      });
      score -= 10;
    } else {
      checks.push({
        name: 'Connection Pool',
        status: 'pass',
        value: `${connStats.utilizationPercent.toFixed(1)}%`,
        message: 'Connection pool healthy',
      });
    }

    // Cache hit ratio check
    const cacheHitRatio = await this.getCacheHitRatio();
    if (cacheHitRatio < 90) {
      checks.push({
        name: 'Cache Hit Ratio',
        status: 'warn',
        value: `${cacheHitRatio.toFixed(1)}%`,
        threshold: '90%',
        message: 'Low cache hit ratio - consider increasing shared_buffers',
      });
      score -= 10;
    } else {
      checks.push({
        name: 'Cache Hit Ratio',
        status: 'pass',
        value: `${cacheHitRatio.toFixed(1)}%`,
        message: 'Cache performing well',
      });
    }

    // Slow queries check
    const recentSlowQueries = await this.slowQueryRepository.count({
      where: {
        recordedAt: LessThan(new Date(Date.now() - 3600000)), // Last hour
      },
    });

    if (recentSlowQueries > 100) {
      checks.push({
        name: 'Slow Queries',
        status: 'fail',
        value: recentSlowQueries,
        threshold: 100,
        message: 'High number of slow queries in last hour',
      });
      score -= 20;
    } else if (recentSlowQueries > 20) {
      checks.push({
        name: 'Slow Queries',
        status: 'warn',
        value: recentSlowQueries,
        threshold: 20,
        message: 'Elevated slow query count',
      });
      score -= 5;
    } else {
      checks.push({
        name: 'Slow Queries',
        status: 'pass',
        value: recentSlowQueries,
        message: 'Query performance normal',
      });
    }

    // Replication lag check (if applicable)
    checks.push({
      name: 'Replication',
      status: 'pass',
      value: 'N/A',
      message: 'Single node configuration',
    });

    // Generate recommendations
    const recommendations: string[] = [];
    if (connUtilization >= CONNECTION_WARNING_THRESHOLD) {
      recommendations.push('Consider increasing max_connections or using connection pooling');
    }
    if (cacheHitRatio < 90) {
      recommendations.push('Review and optimize frequently accessed queries');
    }
    if (recentSlowQueries > 20) {
      recommendations.push('Review slow queries and add appropriate indexes');
    }

    return {
      status: score >= 80 ? 'healthy' : score >= 50 ? 'warning' : 'critical',
      score: Math.max(0, score),
      checks,
      recommendations,
    };
  }

  // ============================================================================
  // Metrics Collection
  // ============================================================================

  /**
   * Collect and store metrics (runs every 5 minutes)
   */
  @ScheduledJob({
    name: 'database-monitoring.collect-metrics',
    cron: CronExpression.EVERY_5_MINUTES,
  })
  async collectMetrics(): Promise<void> {
    this.logger.debug('Collecting database metrics');

    const connStats = await this.getConnectionStats();
    const queryStats = await this.getQueryPerformanceStats();
    const storage = await this.getTotalStorage();

    const metrics: DatabaseMetricData = {
      activeConnections: connStats.active,
      idleConnections: connStats.idle,
      maxConnections: connStats.maxConnections,
      connectionUtilization: connStats.utilizationPercent,
      queriesPerSecond: queryStats.queriesPerSecond,
      avgQueryTime: queryStats.avgExecutionTime,
      slowQueries: queryStats.slowQueries,
      cacheHitRatio: queryStats.cacheHitRatio,
      totalSizeBytes: storage.totalSizeBytes,
      dataSizeBytes: storage.dataSizeBytes,
      indexSizeBytes: storage.indexSizeBytes,
    };

    const metric = this.metricRepository.create({
      metricType: 'system',
      metrics,
      recordedAt: new Date(),
    });

    await this.metricRepository.save(metric);
  }

  /**
   * Get metrics history
   */
  async getMetricsHistory(options: {
    hours?: number;
    tenantId?: string;
    metricType?: string;
  }): Promise<DatabaseMetric[]> {
    const { hours = 24, tenantId, metricType = 'system' } = options;

    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const where: Record<string, unknown> = {
      metricType,
    };
    if (tenantId) where.tenantId = tenantId;

    return this.metricRepository
      .createQueryBuilder('metric')
      .where(where)
      .andWhere('metric.recordedAt >= :since', { since })
      .orderBy('metric.recordedAt', 'ASC')
      .getMany();
  }
}
