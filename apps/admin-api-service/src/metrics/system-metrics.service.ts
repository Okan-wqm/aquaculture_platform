import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface SystemMetrics {
  timestamp: Date;
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
      timestamp: new Date(),
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
      const results = await Promise.all([
        this.countEntities('tenants'),
        this.countEntities('tenants', "status = 'active'"),
        this.countEntities('users'),
        this.countEntities('users', '"isActive" = true'),
        this.safeCountEntities('farms'),
        this.safeCountEntities('sensors'),
        this.safeCountEntities('sensors', 'is_active = true'),
        this.safeCountEntities('alert_rules'),
        this.safeCountEntities('alert_rules', 'is_active = true'),
        this.countAuditLogsLast24h(),
      ]);

      return {
        totalTenants: results[0],
        activeTenants: results[1],
        totalUsers: results[2],
        totalFarms: results[4],
        totalSensors: results[5],
        activeSensors: results[6],
        totalAlertRules: results[7],
        activeAlertRules: results[8],
        eventsLast24h: results[9],
        apiCallsLast24h: results[9], // Using audit logs as proxy
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
    const serviceEndpoints = [
      { name: 'auth-service', url: 'http://auth-service:3001/api/v1/health' },
      { name: 'gateway-api', url: 'http://gateway-api:3000/api/v1/health' },
      { name: 'farm-service', url: 'http://farm-service:3002/api/v1/health' },
      { name: 'sensor-service', url: 'http://sensor-service:3003/api/v1/health' },
      { name: 'alert-engine', url: 'http://alert-engine:3004/api/v1/health' },
      { name: 'notification-service', url: 'http://notification-service:3005/api/v1/health' },
      { name: 'billing-service', url: 'http://billing-service:3006/api/v1/health' },
      { name: 'config-service', url: 'http://config-service:3007/api/v1/health' },
    ];

    // In real implementation, these would make actual HTTP calls
    for (const endpoint of serviceEndpoints) {
      services.push({
        name: endpoint.name,
        status: 'healthy', // Would be determined by actual health check
        lastCheck: new Date(),
      });
    }

    return services;
  }

  /**
   * Get metric trends over time
   */
  async getMetricTrends(
    _metric: string,
    interval: '1h' | '24h' | '7d' | '30d',
  ): Promise<{ timestamp: Date; value: number }[]> {
    // In real implementation, this would query a time-series database
    // or aggregated metrics table
    const now = new Date();
    const points: { timestamp: Date; value: number }[] = [];

    let intervalMs: number;
    let numPoints: number;

    switch (interval) {
      case '1h':
        intervalMs = 5 * 60 * 1000; // 5 minutes
        numPoints = 12;
        break;
      case '24h':
        intervalMs = 60 * 60 * 1000; // 1 hour
        numPoints = 24;
        break;
      case '7d':
        intervalMs = 6 * 60 * 60 * 1000; // 6 hours
        numPoints = 28;
        break;
      case '30d':
        intervalMs = 24 * 60 * 60 * 1000; // 1 day
        numPoints = 30;
        break;
    }

    for (let i = numPoints - 1; i >= 0; i--) {
      points.push({
        timestamp: new Date(now.getTime() - i * intervalMs),
        value: Math.random() * 100, // Placeholder - would be actual metric value
      });
    }

    return points;
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

  private async countEntities(
    table: string,
    condition?: string,
  ): Promise<number> {
    try {
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
      // Check if table exists first
      const tableExists = await this.dataSource.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public'
          AND table_name = $1
        )
      `, [table]);

      if (!tableExists[0]?.exists) {
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
        FROM audit_logs
        WHERE "createdAt" >= NOW() - INTERVAL '24 hours'
      `);
      return parseInt(result[0]?.count || '0', 10);
    } catch {
      return 0;
    }
  }
}
