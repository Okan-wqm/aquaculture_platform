import 'reflect-metadata';

import { QueryBus } from '@platform/cqrs';

import { RegulatoryAiQueryResponder } from '../regulatory-ai-query.responder';
import { GetBiomassReportByPeriodQuery } from '../../queries/get-biomass-report-by-period.query';
import { ListRegulatoryReportsQuery } from '../../queries/list-regulatory-reports.query';
import { BiomassReport } from '../../entities/biomass-report.entity';
import { RegulatoryReport } from '../../entities/regulatory-report.entity';

const TENANT = '33333333-3333-4333-8333-333333333333';
const SITE = '22222222-2222-4222-8222-222222222222';

const BIOMASS_REPORT: BiomassReport = {
  id: 'br1',
  tenantId: TENANT,
  siteId: SITE,
  reportMonth: 8,
  reportYear: 2026,
  status: 'submitted' as BiomassReport['status'],
  reportData: {
    currentBiomass: {
      totalKg: 12000,
      bySpecies: [
        { speciesId: 'sp1', speciesName: 'Seabass', fishCount: 9000, biomassKg: 12000, avgWeightG: 380 },
      ],
    },
    stockings: [
      { date: '2026-02-01', speciesCode: 'SEABASS', supplier: 'Supplier AS', fishCount: 10000, avgWeightG: 50, biomassKg: 500, notes: 'operator note' },
    ],
    mortality: {
      totalCount: 480,
      byCause: [{ cause: 'predation', count: 480 }],
      details: [
        { date: '2026-03-01', cause: 'predation', speciesCode: 'SEABASS', count: 480, notes: 'free text' },
      ],
    },
    slaughter: {
      totalQuantity: 500,
      totalBiomassKg: 200,
      records: [
        { date: '2026-08-15', speciesCode: 'SEABASS', quantity: 500, biomassKg: 200, buyer: 'Buyer AS', notes: 'note' },
      ],
    },
    transfers: [
      { date: '2026-04-01', direction: 'OUT', speciesCode: 'SEABASS', fishCount: 200, biomassKg: 80, counterparty: 'Site B', notes: 'note' },
    ],
    feedConsumption: {
      totalKg: 3900,
      byFeedType: [{ feedName: 'Grower 3mm', brandName: 'Skretting', quantityKg: 3900 }],
    },
  } as BiomassReport['reportData'],
  totalBiomassKg: '12000.00' as unknown as number,
  generatedBy: 'generator-user-id', // PII — must never cross the wire
  submittedAt: new Date('2026-09-01T06:00:00.000Z'),
  submittedBy: 'submitter-user-id', // PII — must never cross the wire
  readyAt: null,
  confirmedBy: 'confirmer-user-id', // PII — must never cross the wire
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as BiomassReport;

function regulatoryReport(id: string): RegulatoryReport {
  return {
    id,
    tenantId: TENANT,
    reportType: 'SEA_LICE' as RegulatoryReport['reportType'],
    klientReferanse: 'ref-2026-001',
    siteId: SITE,
    lokalitetsnummer: 12345,
    reportYear: 2026,
    reportWeek: 33,
    reportMonth: null,
    status: 'SUBMITTED' as RegulatoryReport['status'],
    payload: { form: 'secret full form snapshot' } as unknown as RegulatoryReport['payload'],
    referanse: 'MM-123',
    feilmelding: null,
    submittedBy: 'submitter-user-id', // PII — must never cross the wire
    submittedAt: new Date('2026-08-20T10:00:00.000Z'),
    attemptCount: 1,
    nextAttemptAt: null,
    failureClass: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as RegulatoryReport;
}

describe('RegulatoryAiQueryResponder (PR-4 farm-AI read surface)', () => {
  let execute: jest.Mock;
  let responder: RegulatoryAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    responder = new RegulatoryAiQueryResponder({ execute } as unknown as QueryBus);
  });

  // ---------------------------------------------------------- REG_BIOMASS_REPORT
  it('REG_BIOMASS_REPORT: invalid payload → INVALID_REQUEST, no query executed', async () => {
    for (const bad of [
      { tenantId: TENANT, siteId: SITE },
      { tenantId: TENANT, siteId: SITE, reportMonth: 13, reportYear: 2026 },
      { tenantId: TENANT, siteId: SITE, reportMonth: 8, reportYear: 1999 },
      { tenantId: TENANT, siteId: 'site', reportMonth: 8, reportYear: 2026 },
    ]) {
      expect(await responder.biomassReport(bad)).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('REG_BIOMASS_REPORT: happy path projects the payload and strips PII/free-text', async () => {
    execute.mockResolvedValue(BIOMASS_REPORT);

    const reply = await responder.biomassReport({
      tenantId: TENANT,
      siteId: SITE,
      reportMonth: 8,
      reportYear: 2026,
    });

    expect(execute).toHaveBeenCalledWith(expect.any(GetBiomassReportByPeriodQuery));
    const query = execute.mock.calls[0][0] as GetBiomassReportByPeriodQuery;
    expect(query.tenantId).toBe(TENANT);
    expect(query.reportMonth).toBe(8);

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data?.totalBiomassKg).toBe(12000);
      expect(reply.data?.submittedAt).toBe('2026-09-01T06:00:00.000Z');
      expect(reply.data?.currentBiomass.bySpecies[0]?.speciesName).toBe('Seabass');
      const serialized = JSON.stringify(reply.data);
      expect(serialized).not.toContain('generatedBy');
      expect(serialized).not.toContain('submittedBy');
      expect(serialized).not.toContain('confirmedBy');
      expect(serialized).not.toContain('operator note');
      expect(serialized).not.toContain('Supplier AS');
      expect(serialized).not.toContain('Buyer AS');
    }
  });

  it('REG_BIOMASS_REPORT: absent report replies ok with null data', async () => {
    execute.mockResolvedValue(null);
    const reply = await responder.biomassReport({
      tenantId: TENANT,
      siteId: SITE,
      reportMonth: 1,
      reportYear: 2020,
    });
    expect(reply).toEqual({ ok: true, data: null });
  });

  it('REG_BIOMASS_REPORT: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(
      await responder.biomassReport({
        tenantId: TENANT,
        siteId: SITE,
        reportMonth: 8,
        reportYear: 2026,
      }),
    ).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
  });

  // ----------------------------------------------------------------- REG_REPORTS
  it('REG_REPORTS: invalid payload (bad enum / uuid / limit) → INVALID_REQUEST', async () => {
    for (const bad of [
      { tenantId: TENANT },
      { tenantId: TENANT, reportType: 'NOT_A_TYPE' },
      { tenantId: TENANT, reportType: 'SEA_LICE', siteId: 'site' },
      { tenantId: TENANT, reportType: 'SEA_LICE', limit: 51 },
    ]) {
      expect(await responder.reports(bad)).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('REG_REPORTS: happy path bounds the list and strips payload + submitter', async () => {
    execute.mockResolvedValue(Array.from({ length: 60 }, (_, i) => regulatoryReport(`rr${i}`)));

    const reply = await responder.reports({ tenantId: TENANT, reportType: 'SEA_LICE' });

    expect(execute).toHaveBeenCalledWith(expect.any(ListRegulatoryReportsQuery));
    const query = execute.mock.calls[0][0] as ListRegulatoryReportsQuery;
    expect(query.tenantId).toBe(TENANT);
    expect(query.reportType).toBe('SEA_LICE');
    expect(query.limit).toBe(20); // DEFAULT_LIST_LIMIT when the request carries no limit

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.items).toHaveLength(20); // DEFAULT_LIST_LIMIT (no limit in request)
      expect(reply.data.truncated).toBe(true);
      expect(reply.data.total).toBe(60);
      expect(reply.data.items[0]?.klientReferanse).toBe('ref-2026-001');
      const serialized = JSON.stringify(reply.data);
      expect(serialized).not.toContain('submittedBy');
      expect(serialized).not.toContain('secret full form snapshot');
    }
  });

  it('REG_REPORTS: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.reports({ tenantId: TENANT, reportType: 'ESCAPE' })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });
});
