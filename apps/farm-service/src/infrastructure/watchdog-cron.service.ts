/**
 * Watchdog Cron Service
 *
 * Runs tenant isolation watchdog scans on a schedule.
 * Detects: source schema contamination, cross-tenant data leaks, schema drift.
 * CRITICAL violations are logged at ERROR level for alerting.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { WatchdogRunner, WatchdogReport } from '@aquaculture/backend-common/database';
import { CronHeartbeatService } from '@aquaculture/backend-common/metrics';

import { FarmDomainMetricsService } from '../common/metrics/farm-domain-metrics.service';

/** Heartbeat series name. A code constant, not user input — see the label discipline note. */
const WATCHDOG_JOB = 'farm-tenant-isolation-watchdog';

@Injectable()
export class WatchdogCronService {
  private readonly logger = new Logger(WatchdogCronService.name);
  private lastReport: WatchdogReport | null = null;

  // The runner arrives as a dependency rather than being constructed in
  // onModuleInit. It used to be built inside the service, which meant the
  // scheduling, the reporting and the scanning could only ever be exercised
  // together against a live DataSource — so the reporting path this commit
  // adds had no way to be tested except by reaching in and replacing a
  // private field, which is a cast the gate rightly refuses.
  constructor(
    private readonly runner: WatchdogRunner,
    private readonly metrics: FarmDomainMetricsService,
    private readonly heartbeat: CronHeartbeatService,
  ) {
    // Declared before the first run so "this job has never executed" is a
    // value someone can alert on rather than an absent series.
    this.heartbeat.declare(WATCHDOG_JOB);
  }

  /**
   * Run full watchdog scan every 15 minutes.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async runScheduledScan(): Promise<void> {
    await this.heartbeat.track(WATCHDOG_JOB, async () => this.scan());
  }

  private async scan(): Promise<void> {
    this.logger.log('Starting scheduled watchdog scan...');

    try {
      const report = await this.runner.runFullScan();
      this.lastReport = report;
      // W-C: the verdict leaves the process. Before this the scan's only
      // output was a log line, so "is isolation holding" was answerable
      // only by grep, and a scanner that stopped running looked exactly
      // like a clean scan.
      this.metrics.recordTenantIsolationScan({
        outcome: 'completed',
        violations: report.violations,
        scannerErrorCount: report.scannerErrors.length,
      });

      if (report.summary.hasCritical) {
        this.logger.error(
          `WATCHDOG ALERT: ${report.summary.bySeverity.CRITICAL} CRITICAL violations! ` +
            `Tenant data isolation may be compromised. Details: ` +
            JSON.stringify(
              report.violations
                .filter((v) => v.severity === 'CRITICAL')
                .map((v) => ({ type: v.type, schema: v.schema, table: v.table, details: v.details })),
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
      // A scan that threw scanned nothing. Reporting it as a distinct
      // outcome keeps "the watchdog is broken" from reading as "no
      // violations found".
      this.metrics.recordTenantIsolationScan({ outcome: 'failed' });
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
