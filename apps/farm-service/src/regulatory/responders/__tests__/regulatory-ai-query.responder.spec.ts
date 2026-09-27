import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { QueryBus } from '@platform/cqrs';
import { RegulatoryReportType } from '../../entities/regulatory-report.entity';
import { GetBiomassReportByPeriodQuery } from '../../queries/get-biomass-report-by-period.query';
import { ListRegulatoryReportsQuery } from '../../queries/list-regulatory-reports.query';
import { RegulatoryAiQueryResponder } from '../regulatory-ai-query.responder';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';

describe('RegulatoryAiQueryResponder (FARM-MEDIUM-328)', () => {
  let execute: jest.Mock;
  let responder: RegulatoryAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    const queryBus: Pick<QueryBus, 'execute'> = { execute };
    responder = new RegulatoryAiQueryResponder(queryBus as QueryBus);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('biomass report: found=false when the period has no report, else a compact summary', async () => {
    execute.mockResolvedValue(null);
    const missing = await responder.getBiomassReport({
      tenantId: TENANT,
      siteId: SITE,
      reportMonth: 8,
      reportYear: 2026,
    });
    expect(execute).toHaveBeenCalledWith(expect.any(GetBiomassReportByPeriodQuery));
    expect(missing).toMatchObject({
      ok: true,
      data: { found: false, status: null, totalBiomassKg: null },
    });

    execute.mockResolvedValue({
      status: 'submitted',
      totalBiomassKg: '12345.5',
      submittedAt: new Date('2026-09-05T10:00:00Z'),
      generatedBy: 'user-9',
      reportData: {
        currentBiomass: {
          totalKg: 12345.5,
          bySpecies: [
            {
              speciesId: 's',
              speciesName: 'Salmon',
              fishCount: 30000,
              biomassKg: 12345.5,
              avgWeightG: 411,
            },
          ],
        },
        stockings: [],
        mortality: { totalCount: 120, byCause: [], details: [] },
        slaughter: { totalQuantity: 0, totalBiomassKg: 0, records: [] },
        transfers: [],
        feedConsumption: { totalKg: 900, byFeedType: [] },
      },
    });
    const found = await responder.getBiomassReport({
      tenantId: TENANT,
      siteId: SITE,
      reportMonth: 8,
      reportYear: 2026,
    });
    expect(found).toMatchObject({
      ok: true,
      data: {
        found: true,
        status: 'submitted',
        totalBiomassKg: 12345.5,
        currentBiomassBySpecies: [
          { speciesName: 'Salmon', fishCount: 30000, biomassKg: 12345.5, avgWeightG: 411 },
        ],
        mortalityTotalCount: 120,
        feedConsumptionTotalKg: 900,
        submittedAt: '2026-09-05T10:00:00.000Z',
      },
    });
    expect(JSON.stringify(found)).not.toContain('user-9');
  });

  it('report submissions: maps the type code to the enum and never emits the payload', async () => {
    execute.mockResolvedValue([
      {
        id: SITE,
        reportType: 'SEA_LICE',
        siteId: SITE,
        reportYear: 2026,
        reportWeek: 37,
        status: 'SUBMITTED',
        submittedAt: new Date('2026-09-15T00:00:00Z'),
        attemptCount: 1,
        failureClass: null,
        payload: { operator: 'Jane Doe' },
        submittedBy: 'user-1',
      },
    ]);

    const reply = await responder.listReports({
      tenantId: TENANT,
      reportType: 'SEA_LICE',
      siteId: SITE,
      limit: 10,
    });

    expect(execute).toHaveBeenCalledWith(expect.any(ListRegulatoryReportsQuery));
    const query = execute.mock.calls[0][0] as ListRegulatoryReportsQuery;
    expect(query.reportType).toBe(RegulatoryReportType.SEA_LICE);
    expect(query.limit).toBe(10);
    expect(reply).toMatchObject({
      ok: true,
      data: {
        items: [{ reportType: 'SEA_LICE', reportWeek: 37, status: 'SUBMITTED', attemptCount: 1 }],
      },
    });
    for (const secret of ['Jane Doe', 'user-1', 'payload']) {
      expect(JSON.stringify(reply)).not.toContain(secret);
    }
  });
});
