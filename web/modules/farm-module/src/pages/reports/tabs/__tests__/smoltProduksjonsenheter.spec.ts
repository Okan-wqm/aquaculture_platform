/**
 * buildSmoltProduksjonsenheter (Phase 4, RPT-016a) — the settefisk report submits
 * the server-assembled per-unit values, not client re-derivations. karId is the
 * assembler's regulatory unit id (Tank.regulatoryUnitId / tank code), and the
 * average weight is per-unit — a single overall weight and the display name are
 * only fallbacks for units the operator adds by hand. This locks the dedup so a
 * loaded unit's karId can never silently become its display name, nor its
 * snittvekt the site-wide average.
 */
import { describe, expect, it } from 'vitest';

import { buildSmoltProduksjonsenheter } from '../SmoltReportTab';

describe('buildSmoltProduksjonsenheter — settefisk wire mapping', () => {
  it('uses the assembled karId and per-unit weight, not the display name or overall weight', () => {
    const result = buildSmoltProduksjonsenheter(
      [
        {
          unitId: 'tank-1',
          unitName: 'Tank A',
          unitType: 'tank',
          quantity: 5000,
          avgWeightG: 82,
          speciesCode: 'SAL',
          karId: 'REG-KAR-01',
        },
      ],
      [
        {
          unitId: 'tank-1',
          unitName: 'Tank A',
          rate: 0,
          count: 0,
          euthanized: 4,
          naturalDeaths: 9,
          externalTransfers: 2,
        },
      ],
      120, // site-wide overall weight — must NOT override the per-unit 82
    );
    expect(result).toEqual([
      {
        karId: 'REG-KAR-01',
        artskode: 'SAL',
        snittvektGram: 82,
        beholdningVedMaanedsslutt: 5000,
        antallAvlivet: 4,
        antallSelvdod: 9,
        antallFlyttetEksternt: 2,
      },
    ]);
  });

  it('falls back to the display name + overall weight for a hand-added unit (no karId/avgWeightG)', () => {
    const result = buildSmoltProduksjonsenheter(
      [
        {
          unitId: 'manual-1',
          unitName: 'Raceway 3',
          unitType: 'raceway',
          quantity: 1200,
          avgWeightG: 0,
          speciesCode: 'ORR',
        },
      ],
      [],
      95,
    );
    expect(result[0]).toMatchObject({
      karId: 'Raceway 3',
      artskode: 'ORR',
      snittvektGram: 95,
      beholdningVedMaanedsslutt: 1200,
      antallAvlivet: 0,
      antallSelvdod: 0,
      antallFlyttetEksternt: 0,
    });
  });
});
