import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { NatsEventBus } from '@platform/event-bus';
import { DataSource } from 'typeorm';

import { GracefulShutdownService } from '../lifecycle/graceful-shutdown.service';
import { EmailSenderService } from '../settings/services/email-sender.service';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private startupComplete = false;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly emailSenderService: EmailSenderService,
    private readonly eventBus: NatsEventBus,
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

  /** NATS is a mandatory dependency because onboarding completion is event-driven. */
  async checkNats(): Promise<boolean> {
    try {
      const health = await this.eventBus.getHealth();
      return health.isHealthy && health.connectionState === 'connected';
    } catch (error) {
      this.logger.error(`NATS health check failed: ${(error as Error).message}`);
      return false;
    }
  }

  /** Get SMTP circuit breaker status for health reporting */
  getSmtpStatus(): { state: string; consecutiveFailures: number; lastFailureTime: number } {
    return this.emailSenderService.getCircuitStatus();
  }

  /** Get all circuit breaker statuses */
  getCircuitBreakers(): Record<
    string,
    { state: string; consecutiveFailures: number; lastFailureTime: number }
  > {
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
