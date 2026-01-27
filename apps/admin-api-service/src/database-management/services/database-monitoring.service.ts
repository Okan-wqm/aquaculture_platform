/**
 * Database Monitoring Service
 *
 * Database performans izleme, slow query detection ve index optimizasyonu.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, LessThan } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  TenantSchema,
  DatabaseMetric,
  SlowQueryLog,
  DatabaseMetricData,
  IndexRecommendation,
  DatabaseHealthStatus,
  HealthCheck,
} from '../entities/database-management.entity';

// ============================================================================
// Configuration
// ============================================================================

const SLOW_QUERY_THRESHOLD_MS = 1000; // 1 second
const CONNECTION_WARNING_THRESHOLD = 0.7; // 70%
const CONNECTION_CRITICAL_THRESHOLD = 0.9; // 90%
const STORAGE_WARNING_THRESHOLD = 0.8; // 80%
const STORAGE_CRITICAL_THRESHOLD = 0.95; // 95%

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
      const stats = await queryRunner.query(`
        SELECT
          count(*) as total,
          count(*) FILTER (WHERE state = 'active') as active,
          count(*) FILTER (WHERE state = 'idle') as idle,
          count(*) FILTER (WHERE wait_event IS NOT NULL AND state != 'idle') as waiting
        FROM pg_stat_activity
        WHERE datname = current_database()
      `);

      const maxConnResult = await queryRunner.query(`SHOW max_connections`);
      const maxConnections = parseInt(maxConnResult[0]?.max_connections || '100', 10);
      const total = parseInt(stats[0]?.total || '0', 10);

      return {
        total,
        active: parseInt(stats[0]?.active || '0', 10),
        idle: parseInt(stats[0]?.idle || '0', 10),
        waiting: parseInt(stats[0]?.waiting || '0', 10),
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
  async getConnectionsByTenant(): Promise<Array<{
    tenantId: string;
    schemaName: string;
    activeConnections: number;
    maxConnections: number;
  }>> {
    const schemas = await this.schemaRepository.find({
      where: { status: 'active' as any },
    });

    return schemas.map(schema => ({
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
        const stats = await queryRunner.query(`
          SELECT
            sum(calls) as total_queries,
            avg(mean_exec_time) as avg_time,
            count(*) FILTER (WHERE mean_exec_time > $1) as slow_queries,
            sum(calls) / GREATEST(EXTRACT(epoch FROM (max(stats_reset) - min(stats_reset))), 1) as qps
          FROM pg_stat_statements
        `, [SLOW_QUERY_THRESHOLD_MS]);

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
   * Get slow queries
   */
  async getSlowQueries(options: {
    tenantId?: string;
    limit?: number;
    minExecutionTime?: number;
    groupByQuery?: boolean;
  }): Promise<SlowQueryLog[] | Array<{ query: string; count: number; avgTime: number }>> {
    const { tenantId, limit = 50, minExecutionTime = SLOW_QUERY_THRESHOLD_MS, groupByQuery = false } = options;

    if (groupByQuery) {
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();

      try {
        const results = await queryRunner.query(`
          SELECT
            normalized_query as query,
            count(*) as count,
            avg(execution_time_ms) as avg_time
          FROM slow_query_logs
          WHERE execution_time_ms >= $1
            ${tenantId ? 'AND tenant_id = $2' : ''}
          GROUP BY normalized_query
          ORDER BY count DESC
          LIMIT $${tenantId ? '3' : '2'}
        `, tenantId ? [minExecutionTime, tenantId, limit] : [minExecutionTime, limit]);

        return results.map((r: Record<string, unknown>) => ({
          query: r.query as string,
          count: parseInt(r.count as string, 10),
          avgTime: parseFloat(r.avg_time as string),
        }));
      } finally {
        await queryRunner.release();
      }
    }

    const where: Record<string, unknown> = {};
    if (tenantId) where.tenantId = tenantId;

    return this.slowQueryRepository.find({
      where,
      order: { executionTimeMs: 'DESC' },
      take: limit,
    });
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
   * Validate query for EXPLAIN - only allow SELECT statements
   * SECURITY: This prevents DDL/DML injection via EXPLAIN
   */
  private validateQueryForExplain(query: string): { valid: boolean; error?: string } {
    const normalizedQuery = query.trim().toLowerCase();

    // CRITICAL: No semicolons allowed at all - prevents statement chaining
    if (query.includes(';')) {
      return { valid: false, error: 'Semicolons are not allowed in queries' };
    }

    // Forbidden patterns - DDL and DML operations
    const forbiddenPatterns = [
      /\b(insert|update|delete|drop|create|alter|truncate|grant|revoke|vacuum|analyze)\b/i,
      /--/,  // SQL comments
      /\/\*/,  // Block comments
      /\binto\s+outfile\b/i,
      /\bload_file\b/i,
      /\bpg_read_file\b/i,
      /\bpg_write_file\b/i,
      /\bpg_sleep\b/i,  // Time-based attacks
      /\bcopy\b/i,
      /\bexec\b/i,
      /\bexecute\b/i,
      /\bdo\s*\$/i,  // PL/pgSQL blocks
      /\$\$.*\$\$/i,  // Dollar-quoted strings (can contain code)
      /\bset\s+session\b/i,  // Session manipulation
      /\bset\s+local\b/i,
      /\braise\b/i,  // Error raising
      /\bnotify\b/i,  // LISTEN/NOTIFY
      /\blisten\b/i,
    ];

    for (const pattern of forbiddenPatterns) {
      if (pattern.test(query)) {
        return { valid: false, error: 'Query contains forbidden SQL patterns' };
      }
    }

    // Must start with SELECT, WITH, or VALUES
    if (!/^(select|with|values)\b/i.test(normalizedQuery)) {
      return { valid: false, error: 'Only SELECT, WITH, or VALUES queries can be analyzed' };
    }

    // Max query length to prevent DoS
    if (query.length > 10000) {
      return { valid: false, error: 'Query exceeds maximum allowed length (10000 chars)' };
    }

    return { valid: true };
  }

  /**
   * Analyze query with EXPLAIN
   * SECURITY: Input validation prevents SQL injection
   */
  async analyzeQuery(query: string, schemaName?: string): Promise<Record<string, unknown>> {
    // Validate schema name if provided
    if (schemaName) {
      if (!this.validateSchemaName(schemaName)) {
        throw new Error('Invalid schema name format. Only alphanumeric characters, underscores, and hyphens are allowed.');
      }
    }

    // Validate query for EXPLAIN
    const queryValidation = this.validateQueryForExplain(query);
    if (!queryValidation.valid) {
      throw new Error(`Query validation failed: ${queryValidation.error}`);
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      if (schemaName) {
        // Use identifier quoting for schema name (already validated)
        await queryRunner.query(`SET search_path TO ${queryRunner.connection.driver.escape(schemaName)}`);
      }

      // EXPLAIN with ANALYZE false is read-only and safe
      // The query itself is validated above to only allow SELECT/WITH/VALUES
      const result = await queryRunner.query(`EXPLAIN (FORMAT JSON, ANALYZE false) ${query}`);
      return result[0]?.['QUERY PLAN'] || {};
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
  async getStorageByTenant(): Promise<Array<{
    tenantId: string;
    schemaName: string;
    totalSizeBytes: number;
    dataSizeBytes: number;
    indexSizeBytes: number;
    tableCount: number;
  }>> {
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
        const sizeResult = await queryRunner.query(`
          SELECT
            COALESCE(SUM(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename))), 0) as total_size,
            COALESCE(SUM(pg_table_size(quote_ident(schemaname) || '.' || quote_ident(tablename))), 0) as data_size,
            COALESCE(SUM(pg_indexes_size(quote_ident(schemaname) || '.' || quote_ident(tablename))), 0) as index_size,
            count(*) as table_count
          FROM pg_tables
          WHERE schemaname = $1
        `, [schema.schemaName]);

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
      const seqScans = await queryRunner.query(`
        SELECT
          schemaname,
          relname as table_name,
          seq_scan,
          idx_scan,
          n_live_tup as row_count
        FROM pg_stat_user_tables
        WHERE seq_scan > idx_scan * 2
          AND n_live_tup > 1000
          ${schemaName ? "AND schemaname = $1" : ""}
        ORDER BY seq_scan DESC
        LIMIT 10
      `, schemaName ? [schemaName] : []);

      for (const table of seqScans) {
        // Get commonly filtered columns
        const columns = await this.suggestIndexColumns(
          table.schemaname,
          table.table_name,
        );

        if (columns.length > 0) {
          recommendations.push({
            tableName: `${table.schemaname}.${table.table_name}`,
            columns,
            indexType: 'btree',
            reason: `High sequential scan count (${table.seq_scan}) with ${table.row_count} rows`,
            estimatedImpact: table.row_count > 10000 ? 'high' : 'medium',
            createStatement: `CREATE INDEX idx_${table.table_name}_${columns.join('_')} ON "${table.schemaname}"."${table.table_name}" (${columns.map(c => `"${c}"`).join(', ')})`,
          });
        }
      }

      // Find unused indexes
      const unusedIndexes = await queryRunner.query(`
        SELECT
          schemaname,
          relname as table_name,
          indexrelname as index_name,
          pg_size_pretty(pg_relation_size(indexrelid)) as index_size
        FROM pg_stat_user_indexes
        WHERE idx_scan = 0
          AND schemaname NOT IN ('pg_catalog', 'information_schema')
          ${schemaName ? "AND schemaname = $1" : ""}
        ORDER BY pg_relation_size(indexrelid) DESC
        LIMIT 10
      `, schemaName ? [schemaName] : []);

      for (const idx of unusedIndexes) {
        recommendations.push({
          tableName: `${idx.schemaname}.${idx.table_name}`,
          columns: [],
          indexType: 'btree',
          reason: `Unused index "${idx.index_name}" (${idx.index_size})`,
          estimatedImpact: 'low',
          createStatement: `DROP INDEX IF EXISTS "${idx.schemaname}"."${idx.index_name}"`,
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
      const result = await queryRunner.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = $2
          AND (column_name LIKE '%_id' OR column_name LIKE '%_at' OR column_name = 'status')
        ORDER BY ordinal_position
        LIMIT 3
      `, [schemaName, tableName]);

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
  @Cron(CronExpression.EVERY_5_MINUTES)
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

  /**
   * Cleanup old metrics (runs daily)
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupOldMetrics(): Promise<void> {
    this.logger.log('Cleaning up old metrics');

    const retentionDays = 30;
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    await this.metricRepository.delete({
      recordedAt: LessThan(cutoffDate),
    });

    await this.slowQueryRepository.delete({
      recordedAt: LessThan(cutoffDate),
    });
  }
}
