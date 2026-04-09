import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private cachedDbHealthy: boolean | null = null;
  private cacheTimestamp = 0;
  private readonly cacheTtlMs = 5000;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async checkDatabase(): Promise<boolean> {
    const now = Date.now();
    if (this.cachedDbHealthy !== null && now - this.cacheTimestamp < this.cacheTtlMs) {
      return this.cachedDbHealthy;
    }
    try {
      await this.dataSource.query('SELECT 1');
      this.cachedDbHealthy = true;
    } catch (error) {
      this.logger.error(
        `Database health check failed: ${(error as Error).message}`,
      );
      this.cachedDbHealthy = false;
    }
    this.cacheTimestamp = now;
    return this.cachedDbHealthy;
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
      timestamp: new Date().toISOString().toISOString(),
    };
  }
}
