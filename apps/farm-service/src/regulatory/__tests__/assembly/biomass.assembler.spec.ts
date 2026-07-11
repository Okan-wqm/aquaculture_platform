/**
 * BiomassReportAssembler — the FD-0001 draft is aggregated from operational
 * SSoTs (RPT-012 dedup verdict: BiomassCalculatorService is THE standing
 * stock source), with per-section provenance and an explicit warning when
 * the feed ledger is empty for the period.
 */
import { QueryBus } from '@platform/cqrs';
import { createMockDataSource } from '@aquaculture/testing';

import { BiomassCalculatorService } from '../../../batch/services/biomass-calculator.service';
import { GetMortalityByCauseQuery } from '../../../batch/queries/get-mortality-by-cause.query';
import { GetTransfersSummaryQuery } from '../../../batch/queries/get-transfers-summary.query';
import { GetSiteFeedConsumptionQuery } from '../../../feeding/queries/get-site-feed-consumption.query';
import { BiomassReportAssembler } from '../../assembly/biomass.assembler';
import { ReportFieldProvenance } from '../../assembly/provenance.types';
import { BiomassReportPayload } from '../../entities/biomass-report.entity';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteId = 'ssssssss-ssss-4sss-8sss-ssssssssssss';

function makeQueryBus(overrides?: { feedRecordCount?: number }): Pick<QueryBus, 'execute'> {
  return {
    execute: jest.fn().mockImplementation((query: object) => {
      if (query instanceof GetMortalityByCauseQuery) {
        return Promise.resolve({
          totalCount: 150,
          byCause: [
            { cause: 'disease', count: 120 },
            { cause: 'oxygen', count: 30 },
          ],
          details: [
            {
              date: '2026-06-03',
              cause: 'disease',
              speciesCode: 'SEABASS',
              count: 120,
              biomassLossKg: 84.5,
            },
          ],
          recordCount: 7,
        });
      }
      if (query instanceof GetTransfersSummaryQuery) {
        return Promise.resolve({
          records: [
            {
              date: '2026-06-05',
              direction: 'OUT',
              speciesCode: 'SEABASS',
              fishCount: 5000,
              biomassKg: 1250.499,
              counterparty: 'North Site',
            },
          ],
          recordCount: 2,
        });
      }
      if (query instanceof GetSiteFeedConsumptionQuery) {
        const recordCount = overrides?.feedRecordCount ?? 72;
        return Promise.resolve({
          totalKg: recordCount === 0 ? 0 : 1960.254,
          byFeedType:
            recordCount === 0
              ? []
              : [{ feedName: 'Grower 4mm', brandName: 'Skretting', quantityKg: 1960.254 }],
          recordCount,
        });
      }
      throw new Error(`Unexpected query: ${query.constructor.name}`);
    }),
  };
}

function makeCalculator(): Pick<BiomassCalculatorService, 'getSiteBiomassReport'> {
  return {
    getSiteBiomassReport: jest.fn().mockResolvedValue({
      siteId,
      siteName: 'Main Site',
      totalBiomassKg: 42000.339,
      totalQuantity: 120000,
      avgWeightG: 350,
      batchCount: 3,
      tankCount: 6,
      speciesBreakdown: [
        {
          speciesId: 'sp-1',
          speciesName: 'European seabass',
          biomassKg: 42000.339,
          quantity: 120000,
          percentage: 100,
        },
      ],
    }),
  };
}

function makeAssembler(
  queryBus: Pick<QueryBus, 'execute'>,
  calculator: Pick<BiomassCalculatorService, 'getSiteBiomassReport'>,
  queryMock?: jest.Mock,
): BiomassReportAssembler {
  const { mockDataSource, mockQueryRunner } = createMockDataSource();
  if (queryMock) {
    (mockQueryRunner.query as jest.Mock).mockImplementation(queryMock);
  }
  return new BiomassReportAssembler(
    mockDataSource,
    queryBus as QueryBus,
    calculator as BiomassCalculatorService,
  );
}

describe('BiomassReportAssembler', () => {
  it('assembles every section from source aggregates with RECORDS provenance', async () => {
    const rawQuery = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('FROM batches_v2')) {
        return Promise.resolve([
          {
            date: '2026-06-02',
            speciesCode: 'SEABASS',
            supplier: 'SUP-778',
            fishCount: '40000',
            avgWeightG: '12.5',
            batchNumber: 'B-2026-00031',
          },
        ]);
      }
      if (sql.includes('FROM harvest_records')) {
        return Promise.resolve([
          {
            date: '2026-06-28',
            speciesCode: 'SEABASS',
            quantity: '8000',
            biomassKg: '3600.75',
            buyer: null,
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const assembler = makeAssembler(makeQueryBus(), makeCalculator(), rawQuery);
    // Assemble the CURRENT month so the standing stock is a fresh RECORDS proxy
    // regardless of wall-clock (FARM-HIGH-005 flips a stale period to
    // MANUAL_REQUIRED); the mocked source rows are independent of the period.
    const now = new Date();
    const { draftPayload, fields } = await assembler.assemble(
      tenantId,
      siteId,
      now.getUTCFullYear(),
      now.getUTCMonth() + 1,
    );
    const payload = draftPayload as BiomassReportPayload;

    // Standing stock comes from THE calculator (dedup verdict), avg weight derived.
    expect(payload.currentBiomass.totalKg).toBe(42000.34);
    expect(payload.currentBiomass.bySpecies[0]).toMatchObject({
      speciesName: 'European seabass',
      fishCount: 120000,
      avgWeightG: 350,
    });

    expect(payload.stockings[0]).toMatchObject({
      date: '2026-06-02',
      speciesCode: 'SEABASS',
      fishCount: 40000,
      avgWeightG: 12.5,
      biomassKg: 500,
    });

    expect(payload.mortality.totalCount).toBe(150);
    expect(payload.mortality.byCause).toHaveLength(2);

    expect(payload.slaughter).toMatchObject({ totalQuantity: 8000, totalBiomassKg: 3600.75 });
    expect(payload.transfers[0]).toMatchObject({ direction: 'OUT', biomassKg: 1250.5 });
    expect(payload.feedConsumption.totalKg).toBe(1960.25);

    // Every section carries RECORDS provenance with the query named.
    const paths = fields.map((f) => f.path);
    for (const section of [
      '/currentBiomass',
      '/stockings',
      '/mortality',
      '/slaughter',
      '/transfers',
      '/feedConsumption',
    ]) {
      expect(paths).toContain(section);
    }
    expect(fields.every((f) => !f.blocking)).toBe(true);
    expect(fields.find((f) => f.path === '/mortality')?.sourceRecordCount).toBe(7);
  });

  it('fails the standing stock closed to blocking MANUAL_REQUIRED for a materially historical period (FARM-HIGH-005)', async () => {
    // A report for a month before last: the live inventory no longer reflects
    // that month-end, so the standing stock must NOT be stamped RECORDS —
    // auto-submit is blocked until the operator supplies the real beholdning.
    const assembler = makeAssembler(makeQueryBus(), makeCalculator());
    const { fields } = await assembler.assemble(tenantId, siteId, 2020, 1);

    const standingStock = fields.find((f) => f.path === '/currentBiomass');
    expect(standingStock?.provenance).toBe(ReportFieldProvenance.MANUAL_REQUIRED);
    expect(standingStock?.blocking).toBe(true);
    expect(standingStock?.message).toContain('2020-01');
    expect(standingStock?.message).toMatch(/live inventory|month-end/i);
  });

  it('flags an empty feed ledger as MANUAL_REQUIRED (non-blocking) with an actionable message', async () => {
    const assembler = makeAssembler(makeQueryBus({ feedRecordCount: 0 }), makeCalculator());
    const { fields } = await assembler.assemble(tenantId, siteId, 2026, 6);

    const warning = fields.find(
      (f) =>
        f.path === '/feedConsumption' && f.provenance === ReportFieldProvenance.MANUAL_REQUIRED,
    );
    expect(warning).toBeDefined();
    expect(warning?.blocking).toBe(false);
    expect(warning?.message).toContain('2026-06-01');
  });

  it('computes the month range inclusively (June → 01..30)', async () => {
    const queryBus = makeQueryBus();
    const assembler = makeAssembler(queryBus, makeCalculator());
    await assembler.assemble(tenantId, siteId, 2026, 6);

    const mortalityQuery = (queryBus.execute as jest.Mock).mock.calls
      .map(([q]) => q)
      .find((q) => q instanceof GetMortalityByCauseQuery) as GetMortalityByCauseQuery;
    expect(mortalityQuery.fromDate).toBe('2026-06-01');
    expect(mortalityQuery.toDate).toBe('2026-06-30');
  });
});
