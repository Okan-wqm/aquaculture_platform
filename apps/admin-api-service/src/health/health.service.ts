import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async checkDatabase(): Promise<boolean> {
    try {
      await this.dataSource.query('SELECT 1');
      return true;
    } catch (error) {
      this.logger.error(
        `Database health check failed: ${(error as Error).message}`,
      );
      return false;
    }
  }

  async getMetrics() {
    const memoryUsage = process.memoryUsage();

    return {
      uptime: process.uptime(),
      memory: {
        heapUsed: memoryUsage.heapUsed,
        heapTotal: memoryUsage.heapTotal,
        external: memoryUsage.external,
        rss: memoryUsage.rss,
      },
      timestamp: new Date().toISOString(),
    };
  }
}
