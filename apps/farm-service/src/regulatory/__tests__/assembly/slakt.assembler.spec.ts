/**
 * SlaktReportAssembler — executed kg split across the official quality classes
 * from harvest_records.qualityClass (RECORDS); planned kg into ISO weekday
 * buckets; godkjenningsnummer from the slaughter-facility catalog's default
 * facility (the sole SSoT — Phase 4 dedup), blocking MANUAL_REQUIRED when no
 * default facility exists.
 */
import { createMockDataSource } from '@aquaculture/testing';

import { SlaughterFacilityService } from '../../services/slaughter-facility.service';
import { SlaughterFacility } from '../../entities/slaughter-facility.entity';
import { SlaktReportAssembler } from '../../assembly/assemblers/slakt.assembler';
import { ReportFieldProvenance } from '../../assembly/provenance.types';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteId = 'ssssssss-ssss-4sss-8sss-ssssssssssss';

function makeAssembler(options: {
  executed?: unknown[];
  planned?: unknown[];
  defaultFacilityNumber?: string;
}): SlaktReportAssembler {
  const { mockDataSource, mockQueryRunner } = createMockDataSource();
  (mockQueryRunner.query as jest.Mock).mockImplementation((sql: string) => {
    if (sql.includes('FROM harvest_records')) return Promise.resolve(options.executed ?? []);
    if (sql.includes('FROM harvest_plans')) return Promise.resolve(options.planned ?? []);
    return Promise.resolve([]);
  });
  const facilities: Pick<SlaughterFacilityService, 'getDefaultFacility'> = {
    getDefaultFacility: jest
      .fn()
      .mockResolvedValue(
        options.defaultFacilityNumber === undefined
          ? null
          : ({ godkjenningsnummer: options.defaultFacilityNumber } as SlaughterFacility),
      ),
  };
  return new SlaktReportAssembler(mockDataSource, facilities as SlaughterFacilityService);
}

describe('SlaktReportAssembler', () => {
  it('executed: folds kg into the official quality classes from records (no blocking)', async () => {
    const assembler = makeAssembler({
      executed: [
        { artskode: 'SAL', qualityClass: 'superior', totalKg: '18000.44', recordCount: '3' },
        { artskode: 'SAL', qualityClass: 'produksjonsfisk', totalKg: '3440.016', recordCount: '1' },
      ],
      defaultFacilityNumber: 'S123',
    });

    const { draftPayload, fields } = await assembler.assembleExecuted(tenantId, siteId, 2026, 27);

    expect(draftPayload.godkjenningsnummer).toBe('S123');
    expect(draftPayload.totalKgPerArt).toEqual([{ artskode: 'SAL', totalKg: 21440.46 }]);
    expect(draftPayload.arter[0]).toEqual({
      art: 'SAL',
      superiorKg: 18000.44,
      ordinærKg: 0,
      produksjonsfiskKg: 3440.02,
      utkastKg: 0,
    });
    // The class split is RECORDS now — no MANUAL_REQUIRED distribution.
    expect(fields.some((f) => f.path.startsWith('/arter') && f.blocking)).toBe(false);
    const meta = fields.find((f) => f.path === '/arter');
    expect(meta?.provenance).toBe(ReportFieldProvenance.RECORDS);
  });

  it('sources godkjenningsnummer from the default facility catalog (the sole SSoT)', async () => {
    const assembler = makeAssembler({
      executed: [],
      defaultFacilityNumber: 'NEW99',
    });

    const { draftPayload, fields } = await assembler.assembleExecuted(tenantId, siteId, 2026, 27);

    expect(draftPayload.godkjenningsnummer).toBe('NEW99');
    const meta = fields.find((f) => f.path === '/godkjenningsnummer');
    expect(meta?.sourceQuery).toBe('SlaughterFacilityService.defaultFacility');
  });

  it('executed: blocks when no default facility is configured', async () => {
    const assembler = makeAssembler({ executed: [], defaultFacilityNumber: undefined });

    const { fields } = await assembler.assembleExecuted(tenantId, siteId, 2026, 27);

    expect(fields.some((f) => f.path === '/godkjenningsnummer' && f.blocking)).toBe(true);
  });

  it('planned: sums estimated kg into the ISO weekday buckets per species', async () => {
    const assembler = makeAssembler({
      planned: [
        { artskode: 'SAL', weekday: '1', totalKg: '12000' },
        { artskode: 'SAL', weekday: '4', totalKg: '8000.336' },
        { artskode: 'SAL', weekday: '4', totalKg: '1000' },
      ],
      defaultFacilityNumber: 'S123',
    });

    const { draftPayload } = await assembler.assemblePlanned(tenantId, siteId, 2026, 29);

    expect(draftPayload.ukeplanPerArt).toEqual([
      { artskode: 'SAL', mandagKg: 12000, torsdagKg: 9000.34 },
    ]);
  });

  it('planned: empty week is a blocking manual field naming the range', async () => {
    const assembler = makeAssembler({ planned: [], defaultFacilityNumber: 'S123' });

    const { fields } = await assembler.assemblePlanned(tenantId, siteId, 2026, 29);

    const blocker = fields.find((f) => f.path === '/ukeplanPerArt' && f.blocking);
    expect(blocker?.message).toContain('29/2026');
  });
});
