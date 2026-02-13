import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  BeforeApplicationShutdown,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Injectable()
export class GracefulShutdownService
  implements BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly logger = new Logger(GracefulShutdownService.name);
  private draining = false;

  /** Grace period in ms to allow in-flight requests to complete */
  private readonly drainTimeoutMs: number;

  private static parseDrainTimeout(): number {
    const envValue = process.env['SHUTDOWN_DRAIN_TIMEOUT_MS'];
    if (envValue !== undefined) {
      const parsed = parseInt(envValue, 10);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return 10_000;
  }

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {
    this.drainTimeoutMs = GracefulShutdownService.parseDrainTimeout();
  }

  /** Whether the service is shutting down (draining) */
  isDraining(): boolean {
    return this.draining;
  }

  /**
   * Called before the application shuts down.
   * Marks the service as draining so readiness probes return 503.
   */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.warn(`Shutdown signal received: ${signal ?? 'unknown'}`);
    this.draining = true;

    // Wait for in-flight requests to drain
    this.logger.log(
      `Draining in-flight requests (${this.drainTimeoutMs}ms grace period)…`,
    );
    await this.sleep(this.drainTimeoutMs);
  }

  /**
   * Called when the application shuts down.
   * Closes database connections and other resources.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Application shutting down (signal: ${signal ?? 'unknown'})`);

    // Close database connection pool
    if (this.dataSource?.isInitialized) {
      try {
        await this.dataSource.destroy();
        this.logger.log('Database connection pool closed');
      } catch (error) {
        this.logger.error(
          `Error closing database connections: ${(error as Error).message}`,
        );
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
