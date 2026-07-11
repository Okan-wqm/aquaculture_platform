/**
 * RensefiskReportAssembler — cleaner composition + ledger deltas reconstruct
 * the opening stock; official artskode fail-closed; removals surface as a
 * manual allocation note instead of a guessed cause split.
 */
import { QueryBus } from '@platform/cqrs';
import { createMockDataSource } from '@aquaculture/testing';

import { RensefiskReportAssembler } from '../../assembly/assemblers/rensefisk.assembler';
import { ReportFieldProvenance } from '../../assembly/provenance.types';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteId = 'ssssssss-ssss-4sss-8sss-ssssssssssss';

function makeAssembler(composition: unknown[], ledger: unknown[]): RensefiskReportAssembler {
  const { mockDataSource, mockQueryRunner } = createMockDataSource();
  (mockQueryRunner.query as jest.Mock).mockImplementation((sql: string) => {
    if (sql.includes('cleanerFishDetails')) return Promise.resolve(composition);
    if (sql.includes('cleaner_deployment')) return Promise.resolve(ledger);
    return Promise.resolve([]);
  });
  const queryBus: Pick<QueryBus, 'execute'> = {
    execute: jest.fn().mockResolvedValue({ totalKg: 120.5, byFeedType: [], recordCount: 3 }),
  };
  return new RensefiskReportAssembler(mockDataSource, queryBus as QueryBus);
}

describe('RensefiskReportAssembler', () => {
  it('reconstructs opening stock from closing stock minus the month ledger', async () => {
    const assembler = makeAssembler(
      [
        {
          tankId: 't-1',
          merdId: 'MERD-03',
          speciesId: 'sp-usb',
          artskode: 'USB',
          sourceType: 'farmed',
          quantity: '4200', // closing stock now
        },
      ],
      [
        { tankId: 't-1', speciesId: 'sp-usb', operationType: 'cleaner_deployment', total: '500' },
        { tankId: 't-1', speciesId: 'sp-usb', operationType: 'cleaner_mortality', total: '30' },
        { tankId: 't-1', speciesId: 'sp-usb', operationType: 'cleaner_transfer_out', total: '20' },
      ],
    );

    const { draftPayload, fields } = await assembler.assemble(tenantId, siteId, 2026, 6);

    expect(draftPayload.produksjonsenheter).toHaveLength(1);
    const art = draftPayload.produksjonsenheter[0]?.arter[0];
    // 4200 - 500 (new) + 30 (died) + 20 (moved out) = 3750
    expect(art).toMatchObject({
      artskode: 'USB',
      opprinnelse: 'OPPDRETTET',
      beholdningVedForrigeMånedsslutt: 3750,
      utsett: { antallFlyttetInn: 0, antallNy: 500 },
    });
    expect(art?.uttak).toMatchObject({ antallSelvdød: 30, antallFlyttetUt: 20 });
    expect(fields.some((f) => f.blocking)).toBe(false);
  });

  it('flags removals as a manual cause-allocation note (no guessed split)', async () => {
    const assembler = makeAssembler(
      [
        {
          tankId: 't-1',
          merdId: 'MERD-03',
          speciesId: 'sp-usb',
          artskode: 'USB',
          sourceType: 'wild_caught',
          quantity: '100',
        },
      ],
      [{ tankId: 't-1', speciesId: 'sp-usb', operationType: 'cleaner_removal', total: '40' }],
    );

    const { draftPayload, fields } = await assembler.assemble(tenantId, siteId, 2026, 6);

    const art = draftPayload.produksjonsenheter[0]?.arter[0];
    // Removals count back into the opening stock but stay out of the buckets.
    expect(art?.beholdningVedForrigeMånedsslutt).toBe(140);
    expect(art?.uttak.antallAvlivetSkalIkkeBrukes).toBe(0);
    const note = fields.find((f) => f.message?.includes('40 cleaner fish were removed'));
    expect(note).toBeDefined();
    expect(note?.blocking).toBe(false);
  });

  it('blocks a non-official cleaner species code and an empty site', async () => {
    const withBadCode = makeAssembler(
      [
        {
          tankId: 't-1',
          merdId: 'MERD-01',
          speciesId: 'sp-x',
          artskode: 'LUMPFISH',
          sourceType: null,
          quantity: '10',
        },
      ],
      [],
    );
    const { fields } = await withBadCode.assemble(tenantId, siteId, 2026, 6);
    expect(
      fields.some(
        (f) =>
          f.provenance === ReportFieldProvenance.MANUAL_REQUIRED &&
          f.blocking &&
          f.message?.includes('USB/BER/GRO/BNB'),
      ),
    ).toBe(true);

    const empty = makeAssembler([], []);
    const { fields: emptyFields } = await empty.assemble(tenantId, siteId, 2026, 6);
    expect(emptyFields.some((f) => f.path === '/produksjonsenheter' && f.blocking)).toBe(true);
  });
});
