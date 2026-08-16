import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { GracefulShutdownService } from '../lifecycle/graceful-shutdown.service';

export interface AdminProcessMetrics {
  uptime: number;
  memory: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
  };
  timestamp: string;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private startupComplete = false;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Optional() private readonly shutdownService?: GracefulShutdownService,
  ) {}

  /** Mark startup as complete (called after module init) */
  markStartupComplete(): void {
    this.startupComplete = true;
  }

  /** Check if the application has finished initializing */
  isStartupComplete(): boolean {
    return this.startupComplete;
  }

  /** Check if the application is shutting down (draining) */
  isDraining(): boolean {
    return this.shutdownService?.isDraining() ?? false;
  }

  async checkDatabase(): Promise<boolean> {
    try {
      await this.dataSource.query('SELECT 1');
      return true;
    } catch (error) {
      this.logger.error(`Database health check failed: ${(error as Error).message}`);
      return false;
    }
  }

  getMetrics(): AdminProcessMetrics {
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
