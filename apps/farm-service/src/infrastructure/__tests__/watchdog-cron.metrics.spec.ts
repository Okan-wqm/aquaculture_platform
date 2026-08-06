/**
 * W-C — the tenant isolation watchdog's verdict must leave the process.
 *
 * The scan has run every ten minutes since it was written and its only
 * output was an ERROR log line, so "is isolation holding right now" was
 * answerable only by a human grepping logs — and a scanner that had
 * stopped running looked exactly like a scanner reporting nothing wrong.
 * These tests pin the three properties that make the difference readable:
 * violations are published, a repaired violation falls to zero, and a scan
 * that threw is reported as a distinct outcome rather than as silence.
 */
import { WatchdogRunner } from '@aquaculture/backend-common/database';
import { Test } from '@nestjs/testing';

import { FarmDomainMetricsService } from '../../common/metrics/farm-domain-metrics.service';
import { WatchdogCronService } from '../watchdog-cron.service';

interface ScanCall {
  outcome: 'completed' | 'failed';
  violations?: Array<{ severity: string; type: string }>;
  scannerErrorCount?: number;
}

describe('WatchdogCronService metrics surface', () => {
  let service: WatchdogCronService;
  let calls: ScanCall[];
  let runFullScan: jest.Mock;

  beforeEach(async () => {
    calls = [];
    runFullScan = jest.fn();

    const moduleRef = await Test.createTestingModule({
      providers: [
        WatchdogCronService,
        { provide: WatchdogRunner, useValue: { runFullScan } },
        {
          provide: FarmDomainMetricsService,
          useValue: {
            recordTenantIsolationScan: (params: ScanCall): void => {
              calls.push(params);
            },
          },
        },
      ],
    }).compile();

    service = moduleRef.get(WatchdogCronService);
  });

  it('publishes the violations the scan found', async () => {
    runFullScan.mockResolvedValue({
      violations: [
        { severity: 'CRITICAL', type: 'cross_tenant_row' },
        { severity: 'CRITICAL', type: 'cross_tenant_row' },
        { severity: 'HIGH', type: 'source_schema_contamination' },
      ],
      scannerErrors: [],
      summary: { hasCritical: true, bySeverity: { CRITICAL: 2 } },
    });

    await service.runScheduledScan();

    expect(calls).toEqual([
      {
        outcome: 'completed',
        violations: [
          { severity: 'CRITICAL', type: 'cross_tenant_row' },
          { severity: 'CRITICAL', type: 'cross_tenant_row' },
          { severity: 'HIGH', type: 'source_schema_contamination' },
        ],
        scannerErrorCount: 0,
      },
    ]);
  });

  it('reports a clean scan as a completed scan with nothing found', async () => {
    runFullScan.mockResolvedValue({
      violations: [],
      scannerErrors: [],
      summary: { hasCritical: false, bySeverity: {} },
    });

    await service.runScheduledScan();

    expect(calls).toHaveLength(1);
    const [clean] = calls;
    expect(clean?.outcome).toBe('completed');
    expect(clean?.violations).toEqual([]);
  });

  it('counts scanner errors so a half-blind scan is not read as a clean one', async () => {
    runFullScan.mockResolvedValue({
      violations: [],
      scannerErrors: [{ scanner: 'rls-policy', error: 'permission denied' }],
      summary: { hasCritical: false, bySeverity: {} },
    });

    await service.runScheduledScan();

    const [partial] = calls;
    expect(partial?.scannerErrorCount).toBe(1);
  });

  it('reports a thrown scan as failed rather than staying silent', async () => {
    runFullScan.mockRejectedValue(new Error('connection terminated'));

    await service.runScheduledScan();

    expect(calls).toEqual([{ outcome: 'failed' }]);
  });
});
