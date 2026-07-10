/**
 * ReportSchedulerService — period math (previous ISO week / week+2 / previous
 * month), fail-closed on unmapped tenants, idempotent per-site assembly+upsert,
 * the deadline-reminder sweep, retry replay, and auto-submit. The @Cron
 * orchestration (advisory lock + tenant discovery) is integration surface; here
 * we drive the pure + per-tenant core.
 */
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';

const runInTenantTransaction = jest.fn();
const listTenantSchemas = jest.fn().mockResolvedValue([]);

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: (ds: unknown, schema: string, tenantId: string, cb: unknown) =>
    runInTenantTransaction(ds, schema, tenantId, cb),
  listTenantSchemas: (ds: unknown) => listTenantSchemas(ds),
}));

import { ReportSchedulerService } from '../services/report-scheduler.service';
import { ReportAssemblyService, ReportPrefillType } from '../assembly/report-assembly.service';
import { RegulatorySettingsService } from '../regulatory-settings.service';
import { RegulatoryReportStoreService } from '../services/regulatory-report-store.service';
import { RegulatorySubmissionService } from '../services/regulatory-submission.service';
import { RegulatoryReportDraftService } from '../services/regulatory-report-draft.service';
import { RegulatoryDraftSubmissionService } from '../services/regulatory-draft-submission.service';
import { RegulatoryReport } from '../entities/regulatory-report.entity';
import {
  RegulatoryReportDraft,
  ReportDraftStatus,
} from '../entities/regulatory-report-draft.entity';

const TENANT = 'aaaaaaaa-1111-4222-8333-444444444444';
const SITE = 'ssssssss-1111-4222-8333-444444444444';

function makeService(options: {
  mappings?: Record<string, number>;
  assembled?: { schemaValid: boolean };
  insertRows?: unknown[];
  dueRetries?: RegulatoryReport[];
  resubmit?: jest.Mock;
  autoSubmitPolicies?: Record<string, boolean>;
  drafts?: RegulatoryReportDraft[];
  approveAndSubmit?: jest.Mock;
  dataSource?: DataSource;
}): {
  service: ReportSchedulerService;
  assemble: jest.Mock;
  query: jest.Mock;
  update: jest.Mock;
  enqueue: jest.Mock;
  listDueRetries: jest.Mock;
  resubmit: jest.Mock;
  listDrafts: jest.Mock;
  approveAndSubmit: jest.Mock;
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
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  });
  const update = jest.fn().mockResolvedValue({ affected: 1 });
  runInTenantTransaction.mockImplementation(
    async (
      _ds,
      _schema,
      _tenant,
      cb: (qr: { manager: Partial<EntityManager> }) => Promise<unknown>,
    ) => cb({ manager: { query, update } as Partial<EntityManager> }),
  );
  const assemblyService = { assemble } as Partial<ReportAssemblyService> as ReportAssemblyService;
  const settingsService = {
    getEffectiveSiteLocalityMappings: jest.fn().mockResolvedValue(options.mappings ?? {}),
    getSettings: jest
      .fn()
      .mockResolvedValue({ autoSubmitPolicies: options.autoSubmitPolicies ?? {} }),
  } as Partial<RegulatorySettingsService> as RegulatorySettingsService;
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const outboxPublisher = { enqueue } as Partial<OutboxPublisher> as OutboxPublisher;

  const listDueRetries = jest.fn().mockResolvedValue(options.dueRetries ?? []);
  const reportStore = {
    listDueRetries,
  } as Partial<RegulatoryReportStoreService> as RegulatoryReportStoreService;
  const resubmit = options.resubmit ?? jest.fn().mockResolvedValue({ success: true });
  const submissionService = {
    resubmit,
  } as Partial<RegulatorySubmissionService> as RegulatorySubmissionService;

  const listDrafts = jest.fn().mockResolvedValue(options.drafts ?? []);
  const draftService = {
    listDrafts,
  } as Partial<RegulatoryReportDraftService> as RegulatoryReportDraftService;
  const approveAndSubmit =
    options.approveAndSubmit ?? jest.fn().mockResolvedValue({ success: true });
  const draftSubmissionService = {
    approveAndSubmit,
  } as Partial<RegulatoryDraftSubmissionService> as RegulatoryDraftSubmissionService;

  const service = new ReportSchedulerService(
    options.dataSource ?? ({} as Partial<DataSource> as DataSource),
    assemblyService,
    settingsService,
    reportStore,
    submissionService,
    draftService,
    draftSubmissionService,
    outboxPublisher,
  );
  return {
    service,
    assemble,
    query,
    update,
    enqueue,
    listDueRetries,
    resubmit,
    listDrafts,
    approveAndSubmit,
  };
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

describe('ReportSchedulerService.notifyDeadlinesForTenant', () => {
  const NOW = new Date('2026-07-06T09:00:00Z'); // Oslo 2026-07-06

  function draft(over: Partial<RegulatoryReportDraft>): RegulatoryReportDraft {
    const d = new RegulatoryReportDraft();
    d.id = 'd-1';
    d.tenantId = TENANT;
    d.reportType = ReportPrefillType.SEA_LICE;
    d.siteId = SITE;
    d.periodYear = 2026;
    d.periodWeek = 27;
    d.status = ReportDraftStatus.READY;
    Object.assign(d, over);
    return d;
  }

  it('raises an outbox event + records the bucket when the deadline bucket transitions', async () => {
    const { service, enqueue, update } = makeService({
      // Due 2026-07-07 → 1 day out → DUE_SOON; never notified before.
      drafts: [draft({ dueAt: '2026-07-07', deadlineNotifiedBucket: undefined })],
    });

    const notified = await service.notifyDeadlinesForTenant(TENANT, NOW);

    expect(notified).toBe(1);
    expect(update).toHaveBeenCalledWith(
      RegulatoryReportDraft,
      { id: 'd-1', tenantId: TENANT },
      { deadlineNotifiedBucket: 'DUE_SOON' },
    );
    const [event, , opts] = enqueue.mock.calls[0];
    expect(event.eventType).toBe('RegulatoryReportDeadlineApproaching');
    expect(event.bucket).toBe('DUE_SOON');
    expect(event.daysUntilDue).toBe(1);
    expect(opts.idempotencyKey).toBe('deadline:d-1:DUE_SOON');
  });

  it('does not re-notify when the bucket is unchanged', async () => {
    const { service, enqueue } = makeService({
      drafts: [draft({ dueAt: '2026-07-07', deadlineNotifiedBucket: 'DUE_SOON' })],
    });

    const notified = await service.notifyDeadlinesForTenant(TENANT, NOW);

    expect(notified).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('skips terminal and undated drafts, and drafts more than 3 days out', async () => {
    const { service, enqueue } = makeService({
      drafts: [
        draft({ id: 'd-submitted', dueAt: '2026-07-07', status: ReportDraftStatus.SUBMITTED }),
        draft({ id: 'd-dismissed', dueAt: '2026-07-07', status: ReportDraftStatus.DISMISSED }),
        draft({ id: 'd-undated', dueAt: undefined }),
        draft({ id: 'd-far', dueAt: '2026-07-20' }), // >3 days → no bucket
      ],
    });

    const notified = await service.notifyDeadlinesForTenant(TENANT, NOW);

    expect(notified).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('raises OVERDUE for a past deadline', async () => {
    const { service, enqueue } = makeService({
      drafts: [draft({ dueAt: '2026-07-04', deadlineNotifiedBucket: 'DUE' })],
    });

    const notified = await service.notifyDeadlinesForTenant(TENANT, NOW);

    expect(notified).toBe(1);
    expect(enqueue.mock.calls[0][0].bucket).toBe('OVERDUE');
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

describe('ReportSchedulerService advisory-lock discipline', () => {
  /**
   * Regression guard for the session-lock-on-pooled-connection class: the lock
   * MUST be acquired and released on the SAME connection, or a session-scoped
   * pg_try_advisory_lock leaks onto a pool connection and every later cron run
   * self-skips. Invisible in a single-connection dev pool, so it needs an
   * explicit assertion.
   */
  beforeEach(() => {
    listTenantSchemas.mockReset();
    listTenantSchemas.mockResolvedValue([]);
  });

  function makeLockService(): {
    service: ReportSchedulerService;
    lockRunner: { query: jest.Mock; connect: jest.Mock; release: jest.Mock };
    createQueryRunner: jest.Mock;
  } {
    const lockRunner: { connect: jest.Mock; release: jest.Mock; query: jest.Mock } = {
      connect: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn((sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) return Promise.resolve([{ acquired: true }]);
        return Promise.resolve([]);
      }),
    };
    const createQueryRunner = jest.fn(() => lockRunner as Partial<QueryRunner> as QueryRunner);
    const dataSource = { createQueryRunner } as Partial<DataSource> as DataSource;
    const { service } = makeService({ dataSource });
    return { service, lockRunner, createQueryRunner };
  }

  it('acquires and releases the advisory lock on the same dedicated connection', async () => {
    listTenantSchemas.mockResolvedValueOnce([]); // no tenants → body is a no-op
    const { service, lockRunner, createQueryRunner } = makeLockService();

    await service.deadlineSweep(new Date('2026-07-06T05:00:00Z'));

    // exactly one dedicated runner, connected then released
    expect(createQueryRunner).toHaveBeenCalledTimes(1);
    expect(lockRunner.connect).toHaveBeenCalledTimes(1);
    expect(lockRunner.release).toHaveBeenCalledTimes(1);
    // both the acquire and the release ran on THAT runner
    const sqls = lockRunner.query.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => s.includes('pg_try_advisory_lock'))).toBe(true);
    expect(sqls.some((s) => s.includes('pg_advisory_unlock'))).toBe(true);
  });

  it('releases the lock (and the connection) even when the job body throws', async () => {
    listTenantSchemas.mockRejectedValueOnce(new Error('discovery boom'));
    const { service, lockRunner } = makeLockService();

    // the error still propagates (the cron logs it) — but the lock+connection
    // are released in finally regardless.
    await expect(service.retrySweep(new Date('2026-07-06T05:00:00Z'))).rejects.toThrow(
      'discovery boom',
    );

    const sqls = lockRunner.query.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => s.includes('pg_advisory_unlock'))).toBe(true);
    expect(lockRunner.release).toHaveBeenCalledTimes(1);
  });

  it('does not run the job body (nor unlock without acquire) when the lock is held elsewhere', async () => {
    const lockRunner: { connect: jest.Mock; release: jest.Mock; query: jest.Mock } = {
      connect: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn((sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) return Promise.resolve([{ acquired: false }]);
        return Promise.resolve([]);
      }),
    };
    const dataSource = {
      createQueryRunner: jest.fn(() => lockRunner as Partial<QueryRunner> as QueryRunner),
    } as Partial<DataSource> as DataSource;
    const { service } = makeService({ dataSource });

    await service.deadlineSweep(new Date('2026-07-06T05:00:00Z'));

    const sqls = lockRunner.query.mock.calls.map((c) => c[0] as string);
    // acquire attempted, but no unlock when we never held it, and the runner is still released
    expect(sqls.some((s) => s.includes('pg_advisory_unlock'))).toBe(false);
    expect(lockRunner.release).toHaveBeenCalledTimes(1);
    expect(listTenantSchemas).not.toHaveBeenCalled();
  });
});

describe('ReportSchedulerService.autoSubmitForTenant', () => {
  function readyDraft(id: string, reportType: string): RegulatoryReportDraft {
    const draft = new RegulatoryReportDraft();
    draft.id = id;
    draft.tenantId = TENANT;
    draft.reportType = reportType;
    return draft;
  }

  it('submits only READY drafts whose report type is opted in', async () => {
    const approveAndSubmit = jest.fn().mockResolvedValue({ success: true });
    const { service, listDrafts } = makeService({
      autoSubmitPolicies: { SEA_LICE: true, SMOLT: false },
      drafts: [
        readyDraft('d-lice', ReportPrefillType.SEA_LICE),
        readyDraft('d-smolt', ReportPrefillType.SMOLT),
      ],
      approveAndSubmit,
    });

    const submitted = await service.autoSubmitForTenant(TENANT);

    expect(listDrafts).toHaveBeenCalledWith(TENANT, { status: 'ready' });
    expect(approveAndSubmit).toHaveBeenCalledTimes(1);
    expect(approveAndSubmit).toHaveBeenCalledWith(
      TENANT,
      '00000000-0000-0000-0000-000000000000',
      'd-lice',
    );
    expect(submitted).toBe(1);
  });

  it('short-circuits when no report type is opted in (no draft read)', async () => {
    const { service, listDrafts, approveAndSubmit } = makeService({ autoSubmitPolicies: {} });

    const submitted = await service.autoSubmitForTenant(TENANT);

    expect(listDrafts).not.toHaveBeenCalled();
    expect(approveAndSubmit).not.toHaveBeenCalled();
    expect(submitted).toBe(0);
  });

  it('a single auto-submit throwing never aborts the batch', async () => {
    const approveAndSubmit = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ success: true });
    const { service } = makeService({
      autoSubmitPolicies: { SEA_LICE: true },
      drafts: [
        readyDraft('d-1', ReportPrefillType.SEA_LICE),
        readyDraft('d-2', ReportPrefillType.SEA_LICE),
      ],
      approveAndSubmit,
    });

    const submitted = await service.autoSubmitForTenant(TENANT);

    expect(approveAndSubmit).toHaveBeenCalledTimes(2);
    expect(submitted).toBe(1);
  });
});
