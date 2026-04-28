import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { buildSignedInternalHeaders } from '@aquaculture/backend-common/http';

export interface SystemMetrics {
  timestamp: string;
  database: DatabaseMetrics;
  platform: PlatformMetrics;
  resources: ResourceMetrics;
}

export interface DatabaseMetrics {
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
  waitingClients: number;
  databaseSize: string;
  tablesCount: number;
}

export interface PlatformMetrics {
  totalTenants: number;
  activeTenants: number;
  totalUsers: number;
  totalFarms: number;
  totalSensors: number;
  activeSensors: number;
  totalAlertRules: number;
  activeAlertRules: number;
  eventsLast24h: number;
  apiCallsLast24h: number;
}

export interface ResourceMetrics {
  memoryUsage: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
  };
  cpuUsage: {
    user: number;
    system: number;
  };
  uptime: number;
  nodeVersion: string;
  platform: string;
}

export interface ServiceHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  responseTime?: number;
  lastCheck: Date;
  details?: Record<string, unknown>;
}

@Injectable()
export class SystemMetricsService {
  private readonly logger = new Logger(SystemMetricsService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Get comprehensive system metrics
   */
  async getSystemMetrics(): Promise<SystemMetrics> {
    const [database, platform, resources] = await Promise.all([
      this.getDatabaseMetrics(),
      this.getPlatformMetrics(),
      this.getResourceMetrics(),
    ]);

    return {
      timestamp: new Date().toISOString(),
      database,
      platform,
      resources,
    };
  }

  /**
   * Get database connection and size metrics
   */
  async getDatabaseMetrics(): Promise<DatabaseMetrics> {
    try {
      // Get connection pool stats
      const poolStats = await this.dataSource.query(`
        SELECT
          count(*) as total_connections,
          count(*) FILTER (WHERE state = 'active') as active_connections,
          count(*) FILTER (WHERE state = 'idle') as idle_connections
        FROM pg_stat_activity
        WHERE datname = current_database()
      `);

      // Get database size
      const dbSize = await this.dataSource.query(`
        SELECT pg_size_pretty(pg_database_size(current_database())) as size
      `);

      // Get tables count
      const tablesCount = await this.dataSource.query(`
        SELECT count(*) as count
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `);

      return {
        totalConnections: parseInt(poolStats[0]?.total_connections || '0', 10),
        activeConnections: parseInt(poolStats[0]?.active_connections || '0', 10),
        idleConnections: parseInt(poolStats[0]?.idle_connections || '0', 10),
        waitingClients: 0,
        databaseSize: dbSize[0]?.size || 'unknown',
        tablesCount: parseInt(tablesCount[0]?.count || '0', 10),
      };
    } catch (error) {
      this.logger.error(
        `Failed to get database metrics: ${(error as Error).message}`,
      );
      return {
        totalConnections: 0,
        activeConnections: 0,
        idleConnections: 0,
        waitingClients: 0,
        databaseSize: 'unknown',
        tablesCount: 0,
      };
    }
  }

  /**
   * Get platform-level metrics
   */
  async getPlatformMetrics(): Promise<PlatformMetrics> {
    try {
      // H-2 fix: removed dead query for active users (results[3]) that was fetched but never used
      const results = await Promise.all([
        this.countEntities('tenants'),           // 0: totalTenants
        this.countEntities('tenants', "status = 'active'"), // 1: activeTenants
        this.countEntities('users'),             // 2: totalUsers
        this.safeCountEntities('farms'),         // 3: totalFarms
        this.safeCountEntities('sensors'),       // 4: totalSensors
        this.safeCountEntities('sensors', 'is_active = true'), // 5: activeSensors
        this.safeCountEntities('alert_rules'),   // 6: totalAlertRules
        this.safeCountEntities('alert_rules', 'is_active = true'), // 7: activeAlertRules
        this.countAuditLogsLast24h(),            // 8: eventsLast24h
      ]);

      return {
        totalTenants: results[0],
        activeTenants: results[1],
        totalUsers: results[2],
        totalFarms: results[3],
        totalSensors: results[4],
        activeSensors: results[5],
        totalAlertRules: results[6],
        activeAlertRules: results[7],
        eventsLast24h: results[8],
        apiCallsLast24h: results[8], // Using audit logs as proxy
      };
    } catch (error) {
      this.logger.error(
        `Failed to get platform metrics: ${(error as Error).message}`,
      );
      return {
        totalTenants: 0,
        activeTenants: 0,
        totalUsers: 0,
        totalFarms: 0,
        totalSensors: 0,
        activeSensors: 0,
        totalAlertRules: 0,
        activeAlertRules: 0,
        eventsLast24h: 0,
        apiCallsLast24h: 0,
      };
    }
  }

  /**
   * Get Node.js resource metrics
   */
  getResourceMetrics(): ResourceMetrics {
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    return {
      memoryUsage: {
        heapUsed: memoryUsage.heapUsed,
        heapTotal: memoryUsage.heapTotal,
        external: memoryUsage.external,
        rss: memoryUsage.rss,
      },
      cpuUsage: {
        user: cpuUsage.user,
        system: cpuUsage.system,
      },
      uptime: process.uptime(),
      nodeVersion: process.version,
      platform: process.platform,
    };
  }

  /**
   * Check health of dependent services
   */
  async checkServicesHealth(): Promise<ServiceHealth[]> {
    const services: ServiceHealth[] = [];

    // Database health
    const dbHealth = await this.checkDatabaseHealth();
    services.push(dbHealth);

    // Add checks for other services (would use HTTP calls in real implementation)
    // IMPORTANT: Hostnames are Docker Compose service names (not container_name).
    // Docker internal DNS resolves service names on the aqua-internal network.
    // container_name (aqua-auth) != service name (auth-service).
    const serviceEndpoints = [
      { name: 'gateway-api', url: 'http://gateway-api:3000/health/live' },
      { name: 'auth-service', url: 'http://auth-service:3000/health/live' },
      { name: 'farm-service', url: 'http://farm-service:3000/health/live' },
      { name: 'sensor-service', url: 'http://sensor-service:3000/health/live' },
      { name: 'alert-engine', url: 'http://alert-engine:3000/health/live' },
      { name: 'billing-service', url: 'http://billing-service:3000/health/live' },
      { name: 'hr-service', url: 'http://hr-service:3000/health/live' },
      { name: 'notification-service', url: 'http://notification-service:3000/health/live' },
      { name: 'config-service', url: 'http://config-service:3000/health/live' },
      { name: 'hydroponics-service', url: 'http://hydroponics-service:3000/health/live' },
      { name: 'messaging-service', url: 'http://messaging-service:3000/health/live' },
      { name: 'observability-service', url: 'http://observability-service:3009/health/live' },
    ];

    // C-3 fix: Report status as 'degraded' with a note instead of falsely claiming 'healthy'.
    // Real implementation requires actual HTTP health check calls.
    for (const endpoint of serviceEndpoints) {
      const startTime = Date.now();
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        // SECURITY (HIGH-003): admin-api scrapes service /metrics endpoints
        // — an internal cross-service path. Empty tenantId is the explicit
        // non-tenant declaration; HMAC keeps the platform invariant intact.
        const response = await fetch(endpoint.url, {
          signal: controller.signal,
          headers: buildSignedInternalHeaders({
            serviceName: 'admin-api',
            tenantId: '',
          }),
        }).catch(() => null);
        clearTimeout(timeout);

        services.push({
          name: endpoint.name,
          status: response?.ok ? 'healthy' : 'degraded',
          responseTime: Date.now() - startTime,
          lastCheck: new Date(),
          details: response ? { statusCode: response.status } : { error: 'unreachable' },
        });
      } catch {
        services.push({
          name: endpoint.name,
          status: 'degraded',
          responseTime: Date.now() - startTime,
          lastCheck: new Date(),
          details: { error: 'Health check not available' },
        });
      }
    }

    return services;
  }

  /**
   * Get metric trends over time
   */
  async getMetricTrends(
    _metric: string,
    _interval: '1h' | '24h' | '7d' | '30d',
  ): Promise<{ timestamp: Date; value: number }[]> {
    // C-3 fix: Return empty array instead of fabricated Math.random() data.
    // Real implementation requires time-series database or aggregated metrics table.
    this.logger.warn('getMetricTrends requires time-series database integration - returning empty data');
    return [];
  }

  private async checkDatabaseHealth(): Promise<ServiceHealth> {
    const startTime = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      return {
        name: 'database',
        status: 'healthy',
        responseTime: Date.now() - startTime,
        lastCheck: new Date(),
      };
    } catch (error) {
      return {
        name: 'database',
        status: 'unhealthy',
        responseTime: Date.now() - startTime,
        lastCheck: new Date(),
        details: { error: (error as Error).message },
      };
    }
  }

  // H-3 fix: whitelist table names to prevent SQL injection
  private static readonly ALLOWED_TABLES = new Set([
    'tenants', 'users', 'farms', 'sensors', 'alert_rules', 'audit_logs',
  ]);

  // H-3 fix: whitelist conditions to prevent SQL injection
  private static readonly ALLOWED_CONDITIONS = new Set([
    "status = 'active'",
    '"isActive" = true',
    'is_active = true',
  ]);

  /**
   * HIGH-006 fix: cache table-existence results at first use to avoid an
   * information_schema round-trip on every safeCountEntities() call.
   */
  private readonly tableExistsCache = new Map<string, boolean>();

  private async countEntities(
    table: string,
    condition?: string,
  ): Promise<number> {
    try {
      if (!SystemMetricsService.ALLOWED_TABLES.has(table)) {
        this.logger.warn(`countEntities called with disallowed table: ${table}`);
        return 0;
      }
      if (condition && !SystemMetricsService.ALLOWED_CONDITIONS.has(condition)) {
        this.logger.warn(`countEntities called with disallowed condition: ${condition}`);
        return 0;
      }

      const query = condition
        ? `SELECT count(*) as count FROM ${table} WHERE ${condition}`
        : `SELECT count(*) as count FROM ${table}`;

      const result = await this.dataSource.query(query);
      return parseInt(result[0]?.count || '0', 10);
    } catch {
      return 0;
    }
  }

  private async safeCountEntities(
    table: string,
    condition?: string,
  ): Promise<number> {
    try {
      // HIGH-006 fix: serve table-existence from the in-process cache so we
      // avoid an information_schema round-trip on every call.
      if (!this.tableExistsCache.has(table)) {
        const tableExistsRows = await this.dataSource.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = 'public'
            AND table_name = $1
          ) AS exists
        `, [table]);
        this.tableExistsCache.set(table, tableExistsRows[0]?.exists === true);
      }

      if (!this.tableExistsCache.get(table)) {
        return 0;
      }

      return this.countEntities(table, condition);
    } catch {
      return 0;
    }
  }

  private async countAuditLogsLast24h(): Promise<number> {
    try {
      const result = await this.dataSource.query(`
        SELECT count(*) as count
        FROM shared.audit_logs
        WHERE "createdAt" >= NOW() - INTERVAL '24 hours'
      `);
      return parseInt(result[0]?.count || '0', 10);
    } catch {
      return 0;
    }
  }
}
