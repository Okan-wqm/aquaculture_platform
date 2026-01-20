import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: Date;
  uptime: number;
  version: string;
  checks: {
    database: ComponentHealth;
  };
}

export interface ComponentHealth {
  status: 'healthy' | 'unhealthy';
  responseTime?: number;
  error?: string;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startTime = Date.now();

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async check(): Promise<HealthStatus> {
    const database = await this.checkDatabase();

    const overallStatus = this.determineOverallStatus([database]);

    return {
      status: overallStatus,
      timestamp: new Date(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      version: process.env['APP_VERSION'] || '1.0.0',
      checks: {
        database,
      },
    };
  }

  private async checkDatabase(): Promise<ComponentHealth> {
    const startTime = Date.now();

    try {
      await this.dataSource.query('SELECT 1');
      return {
        status: 'healthy',
        responseTime: Date.now() - startTime,
      };
    } catch (error) {
      this.logger.error(`Database health check failed: ${(error as Error).message}`);
      return {
        status: 'unhealthy',
        responseTime: Date.now() - startTime,
        error: (error as Error).message,
      };
    }
  }

  private determineOverallStatus(
    checks: ComponentHealth[],
  ): 'healthy' | 'unhealthy' | 'degraded' {
    const unhealthyCount = checks.filter((c) => c.status === 'unhealthy').length;

    if (unhealthyCount === 0) {
      return 'healthy';
    } else if (unhealthyCount === checks.length) {
      return 'unhealthy';
    } else {
      return 'degraded';
    }
  }
}
