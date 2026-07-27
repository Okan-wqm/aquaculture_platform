/**
 * APA-145 — a failed report generator must propagate, not resolve into a
 * success-shaped `{ data: [], summary: { …, error } }`.
 *
 * generateRevenueReport / generatePaymentsReport / generatePerformanceReport
 * each wrapped their whole body in try/catch and, on ANY failure, returned that
 * success-shaped value. Because it RESOLVES, it defeats executeReport's own
 * try/catch (which exists to set status='failed' + errorMessage and rethrow):
 * the execution was recorded 'completed' with rowCount 0, so a broken report was
 * indistinguishable from a legitimately-empty one. The sibling generators
 * (tenant_overview, tenant_churn) never swallowed — these three were the drift.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-145
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RedisService } from '@aquaculture/backend-common/redis';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AuditLogService } from '../../../audit/audit.service';
import {
  AnalyticsSnapshot,
  ReportDefinition,
  ReportExecution,
  ReportType,
} from '../../entities/analytics-snapshot.entity';
import { InvoiceReadOnly } from '../../entities/external/invoice.entity';
import { TenantReadOnly } from '../../entities/external/tenant.entity';
import { UserReadOnly } from '../../entities/external/user.entity';
import { AnalyticsService } from '../../services/analytics.service';
import { ReportsService } from '../../services/reports.service';

const DB_FAILURE = 'connection terminated unexpectedly';

describe('ReportsService generator failures propagate (APA-145)', () => {
  let service: ReportsService;

  beforeEach(async () => {
    const rejectingDataSource = {
      query: jest.fn().mockRejectedValue(new Error(DB_FAILURE)),
      createQueryRunner: jest.fn(),
    };
    // Every read path these three generators use must fail, so the assertion
    // proves propagation regardless of which store a given generator reads.
    const emptyRepo = {
      find: jest.fn().mockRejectedValue(new Error(DB_FAILURE)),
      findOne: jest.fn().mockRejectedValue(new Error(DB_FAILURE)),
      count: jest.fn().mockRejectedValue(new Error(DB_FAILURE)),
      create: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn(() => {
        throw new Error(DB_FAILURE);
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: getRepositoryToken(AnalyticsSnapshot), useValue: emptyRepo },
        { provide: getRepositoryToken(TenantReadOnly), useValue: emptyRepo },
        { provide: getRepositoryToken(UserReadOnly), useValue: emptyRepo },
        // billing.invoices is the payments report's SSoT (APA-138) and must
        // fail like every other store, or the propagation assertion is vacuous.
        { provide: getRepositoryToken(InvoiceReadOnly), useValue: emptyRepo },
        { provide: getRepositoryToken(ReportDefinition), useValue: emptyRepo },
        { provide: getRepositoryToken(ReportExecution), useValue: emptyRepo },
        { provide: AnalyticsService, useValue: {} },
        { provide: AuditLogService, useValue: { log: jest.fn() } },
        { provide: DataSource, useValue: rejectingDataSource },
        // Cache must not intercept: a miss forces the generator to run.
        {
          provide: RedisService,
          useValue: {
            getJson: jest.fn().mockResolvedValue(null),
            setJson: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    service = module.get(ReportsService);
  });

  it.each<ReportType>(['financial_revenue', 'financial_payments'])(
    '%s rejects on a DB failure instead of resolving as an empty success',
    async (type) => {
      await expect(
        service.generateReport({
          type,
          format: 'json',
          startDate: new Date('2026-06-01T00:00:00.000Z'),
          endDate: new Date('2026-06-30T00:00:00.000Z'),
        }),
      ).rejects.toThrow(DB_FAILURE);
    },
  );

  // system_performance is not driven behaviourally here: its inner best-effort
  // catches (deliberately preserved) substitute defaults, so no store failure
  // reaches the removed outer handler. Assert at the source that none of the
  // three generators can reintroduce the success-shaped error return.
  it('no generator returns a success-shaped {data:[], summary:{error}} on failure', () => {
    const src = readFileSync(
      join(__dirname, '..', 'reports.service.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/error: 'Failed to generate revenue report'/);
    expect(src).not.toMatch(/error: 'Failed to generate payments report'/);
    expect(src).not.toMatch(/error: 'Failed to generate performance report'/);
  });
});
