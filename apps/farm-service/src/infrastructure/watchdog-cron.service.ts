/**
 * Watchdog Cron Service
 *
 * Runs tenant isolation watchdog scans on a schedule.
 * Detects: source schema contamination, cross-tenant data leaks, schema drift.
 * CRITICAL violations are logged at ERROR level for alerting.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { WatchdogRunner, WatchdogReport } from '@platform/backend-common';

@Injectable()
export class WatchdogCronService implements OnModuleInit {
  private readonly logger = new Logger(WatchdogCronService.name);
  private runner!: WatchdogRunner;
  private lastReport: WatchdogReport | null = null;

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    this.runner = new WatchdogRunner(this.dataSource);
    this.logger.log('Watchdog cron service initialized — scanning every 15 minutes');
  }

  /**
   * Run full watchdog scan every 15 minutes.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async runScheduledScan(): Promise<void> {
    this.logger.log('Starting scheduled watchdog scan...');

    try {
      const report = await this.runner.runFullScan();
      this.lastReport = report;

      if (report.summary.hasCritical) {
        this.logger.error(
          `WATCHDOG ALERT: ${report.summary.bySeverity.CRITICAL} CRITICAL violations! ` +
            `Tenant data isolation may be compromised. Details: ` +
            JSON.stringify(
              report.violations
                .filter((v) => v.severity === 'CRITICAL')
                .map((v) => ({ type: v.type, schema: v.schema, table: v.table, detail: v.detail })),
            ),
        );
      }

      if (report.scannerErrors.length > 0) {
        this.logger.warn(
          `Watchdog scanner errors: ${report.scannerErrors.map((e) => `${e.scanner}: ${e.error}`).join('; ')}`,
        );
      }
    } catch (err) {
      this.logger.error(`Watchdog scan failed: ${(err as Error).message}`);
    }
  }

  /**
   * Run scan on startup (after module init).
   */
  async onApplicationBootstrap(): Promise<void> {
    // Wait 30 seconds for DB connections to settle, then run initial scan
    setTimeout(() => {
      this.logger.log('Running startup watchdog scan...');
      this.runScheduledScan().catch((err) => {
        this.logger.error(`Startup watchdog scan failed: ${(err as Error).message}`);
      });
    }, 30_000);
  }

  /**
   * Get the last watchdog report (for admin API or health checks).
   */
  getLastReport(): WatchdogReport | null {
    return this.lastReport;
  }
}
