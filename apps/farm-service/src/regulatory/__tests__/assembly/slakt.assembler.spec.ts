/**
 * SlaktReportAssembler — executed totals per species with a blocking quality
 * class split (never guessed); planned kg into ISO weekday buckets;
 * godkjenningsnummer fail-closed from settings.
 */
import { createMockDataSource } from '@aquaculture/testing';

import { RegulatorySettingsService } from '../../regulatory-settings.service';
import { SlaktReportAssembler } from '../../assembly/assemblers/slakt.assembler';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteId = 'ssssssss-ssss-4sss-8sss-ssssssssssss';

function makeAssembler(options: {
  executed?: unknown[];
  planned?: unknown[];
  approvalNumber?: string;
}): SlaktReportAssembler {
  const { mockDataSource, mockQueryRunner } = createMockDataSource();
  (mockQueryRunner.query as jest.Mock).mockImplementation((sql: string) => {
    if (sql.includes('FROM harvest_records')) return Promise.resolve(options.executed ?? []);
    if (sql.includes('FROM harvest_plans')) return Promise.resolve(options.planned ?? []);
    return Promise.resolve([]);
  });
  const settings: Pick<RegulatorySettingsService, 'getSettings'> = {
    getSettings: jest
      .fn()
      .mockResolvedValue(
        options.approvalNumber === undefined
          ? null
          : { slaughterApprovalNumber: options.approvalNumber },
      ),
  };
  return new SlaktReportAssembler(mockDataSource, settings as RegulatorySettingsService);
}

describe('SlaktReportAssembler', () => {
  it('executed: assembles per-species totals and blocks the quality-class split', async () => {
    const assembler = makeAssembler({
      executed: [{ artskode: 'SAL', totalKg: '21440.456', recordCount: '4' }],
      approvalNumber: 'S123',
    });

    const { draftPayload, fields } = await assembler.assembleExecuted(tenantId, siteId, 2026, 27);

    expect(draftPayload.godkjenningsnummer).toBe('S123');
    expect(draftPayload.totalKgPerArt).toEqual([{ artskode: 'SAL', totalKg: 21440.46 }]);
    expect(draftPayload.arter[0]).toEqual({
      art: 'SAL',
      superiorKg: 0,
      ordinærKg: 0,
      produksjonsfiskKg: 0,
      utkastKg: 0,
    });
    const split = fields.find((f) => f.path === '/arter/0');
    expect(split?.blocking).toBe(true);
    expect(split?.message).toContain('21440.46');
  });

  it('executed: blocks when no approval number is configured', async () => {
    const assembler = makeAssembler({ executed: [], approvalNumber: undefined });

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
      approvalNumber: 'S123',
    });

    const { draftPayload } = await assembler.assemblePlanned(tenantId, siteId, 2026, 29);

    expect(draftPayload.ukeplanPerArt).toEqual([
      { artskode: 'SAL', mandagKg: 12000, torsdagKg: 9000.34 },
    ]);
  });

  it('planned: empty week is a blocking manual field naming the range', async () => {
    const assembler = makeAssembler({ planned: [], approvalNumber: 'S123' });

    const { fields } = await assembler.assemblePlanned(tenantId, siteId, 2026, 29);

    const blocker = fields.find((f) => f.path === '/ukeplanPerArt' && f.blocking);
    expect(blocker?.message).toContain('29/2026');
  });
});
