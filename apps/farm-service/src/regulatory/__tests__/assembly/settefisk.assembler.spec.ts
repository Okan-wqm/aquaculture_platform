/**
 * SettefiskReportAssembler — one produksjonsenhet per stocked tank; official
 * artskode fail-closed; empty site blocks.
 */
import { createMockDataSource } from '@aquaculture/testing';

import { SettefiskReportAssembler } from '../../assembly/assemblers/settefisk.assembler';
import { ReportFieldProvenance } from '../../assembly/provenance.types';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteId = 'ssssssss-ssss-4sss-8sss-ssssssssssss';

function makeAssembler(rows: unknown[]): SettefiskReportAssembler {
  const { mockDataSource, mockQueryRunner } = createMockDataSource();
  (mockQueryRunner.query as jest.Mock).mockImplementation((sql: string) =>
    Promise.resolve(sql.includes('site_tanks') ? rows : []),
  );
  return new SettefiskReportAssembler(mockDataSource);
}

describe('SettefiskReportAssembler', () => {
  it('maps tank composition + period splits into produksjonsenheter', async () => {
    const assembler = makeAssembler([
      {
        tankId: 't-1',
        karId: 'KAR-01',
        artskode: 'SAL',
        beholdning: '120000',
        snittvektGram: '84.239',
        selvdod: '120',
        avlivet: '350',
        flyttetEksternt: null,
      },
    ]);

    const { draftPayload, fields } = await assembler.assemble(tenantId, siteId, 2026, 6);

    expect(draftPayload.rapporteringsmåned).toBe(6);
    expect(draftPayload.produksjonsenheter).toEqual([
      {
        karId: 'KAR-01',
        artskode: 'SAL',
        snittvektGram: 84.24,
        beholdningVedMånedsslutt: 120000,
        antallAvlivet: 350,
        antallSelvdød: 120,
        antallFlyttetEksternt: 0,
      },
    ]);
    expect(fields.every((f) => !f.blocking)).toBe(true);
  });

  it('flags a non-official species code blocking, pointing at Setup → Species', async () => {
    const assembler = makeAssembler([
      {
        tankId: 't-1',
        karId: 'KAR-02',
        artskode: 'seabass-local',
        beholdning: '500',
        snittvektGram: '10',
        selvdod: null,
        avlivet: null,
        flyttetEksternt: null,
      },
    ]);

    const { fields } = await assembler.assemble(tenantId, siteId, 2026, 6);

    const blocker = fields.find((f) => f.path === '/produksjonsenheter/0/artskode');
    expect(blocker).toMatchObject({
      provenance: ReportFieldProvenance.MANUAL_REQUIRED,
      blocking: true,
    });
    expect(blocker?.message).toContain('Setup → Species');
  });

  it('blocks when the site has no stocked tanks (schema requires a unit)', async () => {
    const assembler = makeAssembler([]);

    const { draftPayload, fields } = await assembler.assemble(tenantId, siteId, 2026, 6);

    expect(draftPayload.produksjonsenheter).toEqual([]);
    expect(fields.some((f) => f.path === '/produksjonsenheter' && f.blocking)).toBe(true);
  });

  it('karId prefers the official regulatoryUnitId over the internal code (RPT-016b)', async () => {
    const { mockDataSource, mockQueryRunner } = createMockDataSource();
    let unitSql = '';
    (mockQueryRunner.query as jest.Mock).mockImplementation((sql: string) => {
      if (sql.includes('site_tanks')) {
        unitSql = sql;
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
    const assembler = new SettefiskReportAssembler(mockDataSource);

    await assembler.assemble(tenantId, siteId, 2026, 6);

    expect(unitSql).toContain('COALESCE(t."regulatoryUnitId", t.code)');
  });
});
