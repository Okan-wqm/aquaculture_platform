import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { MODULE_SCHEMAS } from '../schema-manager.service';
import { listTenantSchemas } from '../tenant-schema.utils';

import { CrossTenantProbe } from './cross-tenant-probe';
import { SchemaDriftDetector } from './schema-drift-detector';
import { SourceSchemaScanner, WatchdogViolation, ViolationSeverity } from './source-schema-scanner';

/**
 * Which scanners to run in a watchdog scan.
 */
export interface WatchdogScanOptions {
  /** Check source schemas for tenant data contamination (default: true) */
  sourceContamination?: boolean;
  /** Probe tenant schemas for cross-tenant data leaks (default: true) */
  crossTenantData?: boolean;
  /** Detect schema drift between tenants and MODULE_SCHEMAS (default: true) */
  schemaDrift?: boolean;
  /** Per-scanner timeout in milliseconds. Default: 5 minutes (300_000). Set 0 to disable. */
  scannerTimeoutMs?: number;
}

/**
 * Summary statistics for a watchdog scan run.
 */
export interface WatchdogScanSummary {
  /** Total number of violations found */
  totalViolations: number;
  /** Breakdown by severity */
  bySeverity: Record<ViolationSeverity, number>;
  /** Breakdown by violation type */
  byType: Record<string, number>;
  /** Whether any CRITICAL violations were found */
  hasCritical: boolean;
  /** Schemas that were scanned */
  schemasScanned: number;
  /** Wall-clock duration of the scan in milliseconds */
  durationMs: number;
}

/**
 * Complete report from a watchdog scan run.
 */
export interface WatchdogReport {
  /** ISO timestamp of when the scan started */
  scanStartedAt: string;
  /** ISO timestamp of when the scan completed */
  scanCompletedAt: string;
  /** Summary statistics */
  summary: WatchdogScanSummary;
  /** All violations found, ordered by severity (CRITICAL first) */
  violations: WatchdogViolation[];
  /** Which scanners were included in this run */
  scannersRun: string[];
  /** Any scanner-level errors that occurred */
  scannerErrors: { scanner: string; error: string }[];
}

const SEVERITY_ORDER: Record<ViolationSeverity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

function toWatchdogError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * WatchdogRunner orchestrates all watchdog scanners and produces a unified report.
 *
 * Usage:
 * ```typescript
 * const runner = new WatchdogRunner(dataSource);
 * const report = await runner.runFullScan();
 *
 * if (report.summary.hasCritical) {
 *   // Alert ops team immediately
 * }
 * ```
 *
 * Can be invoked:
 * - As a cron job (e.g., every 15 minutes)
 * - From an admin API endpoint
 * - As part of CI integration tests
 * - Manually via a CLI script
 */
export class WatchdogRunner {
  private readonly logger = new Logger(WatchdogRunner.name);

  /** Default per-scanner timeout: 5 minutes */
  static readonly DEFAULT_SCANNER_TIMEOUT_MS = 300_000;

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Run a full watchdog scan with all scanners enabled.
   */
  async runFullScan(): Promise<WatchdogReport> {
    return this.run({
      sourceContamination: true,
      crossTenantData: true,
      schemaDrift: true,
    });
  }

  /**
   * Wrap a scanner promise with a timeout to prevent runaway scans from
   * blocking the database connection pool.
   */
  private async withTimeout<T>(
    scannerName: string,
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    if (timeoutMs <= 0) return promise;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${scannerName} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      promise.then(
        (result) => { clearTimeout(timer); resolve(result); },
        (err) => { clearTimeout(timer); reject(toWatchdogError(err)); },
      );
    });
  }

  /**
   * Run a watchdog scan with specified scanners.
   *
   * Each scanner runs independently. If one scanner fails, the others still run.
   * Scanner-level errors are captured in the report's scannerErrors array.
   */
  async run(options: WatchdogScanOptions = {}): Promise<WatchdogReport> {
    const startTime = Date.now();
    const scanStartedAt = new Date().toISOString();
    const violations: WatchdogViolation[] = [];
    const scannersRun: string[] = [];
    const scannerErrors: { scanner: string; error: string }[] = [];

    const scannerTimeoutMs = options.scannerTimeoutMs ?? WatchdogRunner.DEFAULT_SCANNER_TIMEOUT_MS;

    const opts: Required<WatchdogScanOptions> = {
      sourceContamination: options.sourceContamination ?? true,
      crossTenantData: options.crossTenantData ?? true,
      schemaDrift: options.schemaDrift ?? true,
      scannerTimeoutMs,
    };

    // Scanner 1: Source schema contamination
    if (opts.sourceContamination) {
      scannersRun.push('SourceSchemaScanner');
      try {
        const scanner = new SourceSchemaScanner(this.dataSource);
        const results = await this.withTimeout('SourceSchemaScanner', scanner.scan(), scannerTimeoutMs);
        violations.push(...results);
        this.logger.log(`SourceSchemaScanner: ${results.length} violations found`);
      } catch (err) {
        const errorMsg = `SourceSchemaScanner failed: ${toWatchdogError(err).message}`;
        this.logger.error(errorMsg);
        scannerErrors.push({ scanner: 'SourceSchemaScanner', error: errorMsg });
      }
    }

    // Scanner 2: Cross-tenant data leaks
    if (opts.crossTenantData) {
      scannersRun.push('CrossTenantProbe');
      try {
        const probe = new CrossTenantProbe(this.dataSource);
        const results = await this.withTimeout('CrossTenantProbe', probe.probe(), scannerTimeoutMs);
        violations.push(...results);
        this.logger.log(`CrossTenantProbe: ${results.length} violations found`);
      } catch (err) {
        const errorMsg = `CrossTenantProbe failed: ${toWatchdogError(err).message}`;
        this.logger.error(errorMsg);
        scannerErrors.push({ scanner: 'CrossTenantProbe', error: errorMsg });
      }
    }

    // Scanner 3: Schema drift
    if (opts.schemaDrift) {
      scannersRun.push('SchemaDriftDetector');
      try {
        const detector = new SchemaDriftDetector(this.dataSource);
        const results = await this.withTimeout('SchemaDriftDetector', detector.detect(), scannerTimeoutMs);
        violations.push(...results);
        this.logger.log(`SchemaDriftDetector: ${results.length} violations found`);
      } catch (err) {
        const errorMsg = `SchemaDriftDetector failed: ${toWatchdogError(err).message}`;
        this.logger.error(errorMsg);
        scannerErrors.push({ scanner: 'SchemaDriftDetector', error: errorMsg });
      }
    }

    // Sort violations: CRITICAL first, then HIGH, MEDIUM, LOW
    violations.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

    const durationMs = Date.now() - startTime;
    const scanCompletedAt = new Date().toISOString();

    // Build summary
    const bySeverity: Record<ViolationSeverity, number> = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
    };
    const byType: Record<string, number> = {};

    for (const v of violations) {
      bySeverity[v.severity]++;
      byType[v.type] = (byType[v.type] || 0) + 1;
    }

    // Count schemas scanned. Always query the actual count rather than
    // deriving it from violations (which would be 0 for a clean scan).
    // Also include source schemas when the SourceSchemaScanner ran.
    let schemasScanned = 0;
    try {
      if (opts.schemaDrift || opts.crossTenantData) {
        schemasScanned += (await listTenantSchemas(this.dataSource)).length;
      }
      if (opts.sourceContamination) {
        // Source schemas scanned = number of MODULE_SCHEMAS entries
        schemasScanned += MODULE_SCHEMAS.length;
      }
    } catch {
      // Fallback: count unique schemas from violations
      schemasScanned = new Set(violations.map(v => v.schema)).size;
    }

    const summary: WatchdogScanSummary = {
      totalViolations: violations.length,
      bySeverity,
      byType,
      hasCritical: bySeverity.CRITICAL > 0,
      schemasScanned,
      durationMs,
    };

    // Log summary
    if (summary.hasCritical) {
      this.logger.error(
        `WATCHDOG CRITICAL: ${bySeverity.CRITICAL} critical violations detected! ` +
          `Total: ${violations.length} violations across ${schemasScanned} schemas in ${durationMs}ms`,
      );
    } else if (violations.length > 0) {
      this.logger.warn(
        `Watchdog scan complete: ${violations.length} violations found ` +
          `(${bySeverity.HIGH} HIGH, ${bySeverity.MEDIUM} MEDIUM, ${bySeverity.LOW} LOW) ` +
          `across ${schemasScanned} schemas in ${durationMs}ms`,
      );
    } else {
      this.logger.log(
        `Watchdog scan clean: 0 violations across ${schemasScanned} schemas in ${durationMs}ms`,
      );
    }

    return {
      scanStartedAt,
      scanCompletedAt,
      summary,
      violations,
      scannersRun,
      scannerErrors,
    };
  }
}
