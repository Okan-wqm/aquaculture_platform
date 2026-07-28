import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { GracefulShutdownService } from '../lifecycle/graceful-shutdown.service';
import { EmailSenderService } from '../settings/services/email-sender.service';
import type { CircuitBreakerInfo } from '../settings/services/email-sender.service';

/**
 * Every circuit breaker this service publishes, keyed by name.
 *
 * Named here rather than left inline: the health endpoint returns it, so it is
 * a wire contract, and an inline anonymous shape gives the admin panel nothing
 * to generate from — which is why the panel had re-declared it by hand with a
 * NARROWER state type than the `string` the backend was actually promising.
 */
export type CircuitBreakerStatus = Record<string, CircuitBreakerInfo>;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private startupComplete = false;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly emailSenderService: EmailSenderService,
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
      this.logger.error(
        `Database health check failed: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /** Get SMTP circuit breaker status for health reporting */
  getSmtpStatus(): { state: string; consecutiveFailures: number; lastFailureTime: number } {
    return this.emailSenderService.getCircuitStatus();
  }

  /** Get all circuit breaker statuses */
  getCircuitBreakers(): CircuitBreakerStatus {
    return {
      smtp: this.emailSenderService.getCircuitStatus(),
    };
  }

  /** Reset a specific circuit breaker by name */
  resetCircuitBreaker(name: string): boolean {
    if (name === 'smtp') {
      this.emailSenderService.resetCircuit();
      return true;
    }
    return false;
  }

  async getMetrics() {
    const memoryUsage = process.memoryUsage();
    const smtpStatus = this.getSmtpStatus();

    return {
      uptime: process.uptime(),
      memory: {
        heapUsed: memoryUsage.heapUsed,
        heapTotal: memoryUsage.heapTotal,
        external: memoryUsage.external,
        rss: memoryUsage.rss,
      },
      smtp: smtpStatus,
      timestamp: new Date().toISOString(),
    };
  }
}
