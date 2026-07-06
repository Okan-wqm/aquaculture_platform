/**
 * ReportSchedulerService — period math (previous ISO week / week+2 / previous
 * month), fail-closed on unmapped tenants, idempotent per-site assembly+upsert,
 * and the overdue sweep. The @Cron orchestration (advisory lock + tenant
 * discovery) is integration surface; here we drive the pure + per-tenant core.
 */
import { DataSource, EntityManager } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

const runInTenantTransaction = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: (ds: unknown, schema: string, tenantId: string, cb: unknown) =>
    runInTenantTransaction(ds, schema, tenantId, cb),
}));

import { ReportSchedulerService } from '../services/report-scheduler.service';
import { ReportAssemblyService, ReportPrefillType } from '../assembly/report-assembly.service';
import { RegulatorySettingsService } from '../regulatory-settings.service';
import { RegulatoryReportStoreService } from '../services/regulatory-report-store.service';
import { RegulatorySubmissionService } from '../services/regulatory-submission.service';
import { RegulatoryReport } from '../entities/regulatory-report.entity';

const TENANT = 'aaaaaaaa-1111-4222-8333-444444444444';
const SITE = 'ssssssss-1111-4222-8333-444444444444';

function makeService(options: {
  mappings?: Record<string, number>;
  assembled?: { schemaValid: boolean };
  insertRows?: unknown[];
  overdueRows?: unknown[];
  dueRetries?: RegulatoryReport[];
  resubmit?: jest.Mock;
}): {
  service: ReportSchedulerService;
  assemble: jest.Mock;
  query: jest.Mock;
  emit: jest.Mock;
  listDueRetries: jest.Mock;
  resubmit: jest.Mock;
} {
  const assemble = jest.fn().mockResolvedValue({
    draftPayload: { ok: true },
    fields: [],
    schemaValid: options.assembled?.schemaValid ?? true,
    assembledAt: new Date('2026-07-06T01:00:00Z'),
  });
  const query = jest.fn((sql: string) => {
    if (sql.includes('INSERT INTO')) return Promise.resolve(options.insertRows ?? [{ id: 'd-1' }]);
    if (sql.includes('FROM "regulatory_report_drafts"')) {
      return Promise.resolve(options.overdueRows ?? []);
    }
    return Promise.resolve([]);
  });
  runInTenantTransaction.mockImplementation(
    async (
      _ds,
      _schema,
      _tenant,
      cb: (qr: { manager: Partial<EntityManager> }) => Promise<unknown>,
    ) => cb({ manager: { query } as Partial<EntityManager> }),
  );
  const assemblyService = { assemble } as Partial<ReportAssemblyService> as ReportAssemblyService;
  const settingsService = {
    getEffectiveSiteLocalityMappings: jest.fn().mockResolvedValue(options.mappings ?? {}),
  } as Partial<RegulatorySettingsService> as RegulatorySettingsService;
  const emit = jest.fn();
  const eventEmitter = { emit } as Partial<EventEmitter2> as EventEmitter2;

  const listDueRetries = jest.fn().mockResolvedValue(options.dueRetries ?? []);
  const reportStore = {
    listDueRetries,
  } as Partial<RegulatoryReportStoreService> as RegulatoryReportStoreService;
  const resubmit = options.resubmit ?? jest.fn().mockResolvedValue({ success: true });
  const submissionService = {
    resubmit,
  } as Partial<RegulatorySubmissionService> as RegulatorySubmissionService;

  const service = new ReportSchedulerService(
    {} as Partial<DataSource> as DataSource,
    assemblyService,
    settingsService,
    reportStore,
    submissionService,
    eventEmitter,
  );
  return { service, assemble, query, emit, listDueRetries, resubmit };
}

describe('ReportSchedulerService period math', () => {
  it('weekly jobs cover the previous ISO week (lice + executed) and week+2 (planned)', () => {
    // Monday 2026-07-06 (ISO week 28). Previous week = 27; week+2 = 30.
    const jobs = ReportSchedulerService.weeklyJobs(new Date('2026-07-06T03:00:00Z'));
    expect(jobs).toEqual([
      { reportType: ReportPrefillType.SEA_LICE, year: 2026, week: 27 },
      { reportType: ReportPrefillType.SLAUGHTER_EXECUTED, year: 2026, week: 27 },
      { reportType: ReportPrefillType.SLAUGHTER_PLANNED, year: 2026, week: 30 },
    ]);
  });

  it('monthly jobs cover the previous calendar month, rolling the year at January', () => {
    expect(ReportSchedulerService.monthlyJobs(new Date('2026-07-01T03:00:00Z'))).toEqual([
      { reportType: ReportPrefillType.SMOLT, year: 2026, month: 6 },
      { reportType: ReportPrefillType.CLEANER_FISH, year: 2026, month: 6 },
      { reportType: ReportPrefillType.BIOMASS, year: 2026, month: 6 },
    ]);
    expect(ReportSchedulerService.monthlyJobs(new Date('2026-01-01T03:00:00Z'))).toEqual([
      { reportType: ReportPrefillType.SMOLT, year: 2025, month: 12 },
      { reportType: ReportPrefillType.CLEANER_FISH, year: 2025, month: 12 },
      { reportType: ReportPrefillType.BIOMASS, year: 2025, month: 12 },
    ]);
  });
});

describe('ReportSchedulerService.rolloverForTenant', () => {
  it('fail-closes: no drafts for a tenant whose sites carry no lokalitetsnummer', async () => {
    const { service, assemble } = makeService({ mappings: {} });

    const created = await service.rolloverForTenant(TENANT, [
      { reportType: ReportPrefillType.SEA_LICE, year: 2026, week: 27 },
    ]);

    expect(created).toBe(0);
    expect(assemble).not.toHaveBeenCalled();
  });

  it('assembles + inserts a draft per mapped site and counts new rows', async () => {
    const { service, assemble, query } = makeService({ mappings: { [SITE]: 12345 } });

    const created = await service.rolloverForTenant(TENANT, [
      { reportType: ReportPrefillType.SEA_LICE, year: 2026, week: 27 },
    ]);

    expect(created).toBe(1);
    expect(assemble).toHaveBeenCalledWith(TENANT, ReportPrefillType.SEA_LICE, SITE, {
      year: 2026,
      week: 27,
      month: undefined,
    });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO "regulatory_report_drafts"');
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('RETURNING id');
    // status READY (schemaValid) + dueAt = Tuesday of the following week.
    expect(params[6]).toBe('ready');
    expect(params[10]).toBe('2026-07-07');
  });

  it('idempotent: an existing period (ON CONFLICT DO NOTHING → no rows) counts as 0', async () => {
    const { service } = makeService({ mappings: { [SITE]: 12345 }, insertRows: [] });

    const created = await service.rolloverForTenant(TENANT, [
      { reportType: ReportPrefillType.SEA_LICE, year: 2026, week: 27 },
    ]);

    expect(created).toBe(0);
  });

  it('a blocking draft is stored as DRAFT, not READY', async () => {
    const { service, query } = makeService({
      mappings: { [SITE]: 12345 },
      assembled: { schemaValid: false },
    });

    await service.rolloverForTenant(TENANT, [
      { reportType: ReportPrefillType.SMOLT, year: 2026, month: 6 },
    ]);

    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params[6]).toBe('draft');
  });
});

describe('ReportSchedulerService.sweepOverdueForTenant', () => {
  it('returns the tenant overdue drafts queried against the Oslo date', async () => {
    const overdue = [
      { id: 'd-1', reportType: 'SEA_LICE', siteId: SITE, dueAt: '2026-07-05', status: 'draft' },
    ];
    const { service, query } = makeService({ overdueRows: overdue });

    const rows = await service.sweepOverdueForTenant(TENANT, new Date('2026-07-06T22:30:00Z'));

    expect(rows).toEqual(overdue);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status IN ('draft', 'ready', 'approved')");
    // 2026-07-06T22:30Z is already 2026-07-07 in Oslo.
    expect(params[1]).toBe('2026-07-07');
  });
});

describe('ReportSchedulerService.retrySweepForTenant', () => {
  const NOW = new Date('2026-07-06T09:00:00Z');

  function dueRow(id: string): RegulatoryReport {
    const row = new RegulatoryReport();
    row.id = id;
    row.tenantId = TENANT;
    return row;
  }

  it('replays every due TRANSIENT failure and counts the ones that reach SUBMITTED', async () => {
    const resubmit = jest
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false }); // still transient — replayed but not yet done
    const { service, listDueRetries } = makeService({
      dueRetries: [dueRow('r-1'), dueRow('r-2')],
      resubmit,
    });

    const submitted = await service.retrySweepForTenant(TENANT, NOW);

    expect(listDueRetries).toHaveBeenCalledWith(TENANT, NOW, 50);
    expect(resubmit).toHaveBeenCalledTimes(2);
    expect(resubmit).toHaveBeenNthCalledWith(1, TENANT, 'r-1');
    expect(resubmit).toHaveBeenNthCalledWith(2, TENANT, 'r-2');
    expect(submitted).toBe(1);
  });

  it('a single replay throwing never aborts the batch', async () => {
    const resubmit = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ success: true });
    const { service } = makeService({
      dueRetries: [dueRow('r-1'), dueRow('r-2')],
      resubmit,
    });

    const submitted = await service.retrySweepForTenant(TENANT, NOW);

    expect(resubmit).toHaveBeenCalledTimes(2);
    expect(submitted).toBe(1);
  });

  it('does nothing when no retries are due', async () => {
    const { service, resubmit } = makeService({ dueRetries: [] });

    const submitted = await service.retrySweepForTenant(TENANT, NOW);

    expect(resubmit).not.toHaveBeenCalled();
    expect(submitted).toBe(0);
  });
});
