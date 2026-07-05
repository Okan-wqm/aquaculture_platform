/**
 * Locks the biomass draft pre-fill mapping (FARM-LOW-152).
 *
 * `hydrateFormFromPayload` is the reverse of the tab's submit mapping: it turns
 * a persisted `BiomassReportPayload` back into wizard `BiomassFormData` so that
 * re-opening the (fixed previous-month) wizard on an existing DRAFT continues it
 * instead of blanking it — the create-or-update-if-draft mutation would
 * otherwise silently overwrite the saved draft on submit.
 *
 * Pure-function test: `@aquaculture/shared-ui` is stubbed only so importing the
 * tab module (which pulls the data-layer hooks) does not require a live
 * federation/provider environment. The mapper itself touches none of it.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@aquaculture/shared-ui', () => ({
  graphqlClient: { request: vi.fn() },
  useTenantQuery: vi.fn(),
  useAuth: vi.fn(),
  createTenantInvalidationKey: vi.fn(),
}));

import { hydrateFormFromPayload } from '../BiomassReportTab';
import type { BiomassReportPayload } from '../../../../hooks/useBiomassReports';

const payload: BiomassReportPayload = {
  currentBiomass: {
    totalKg: 1234.5,
    bySpecies: [
      {
        speciesId: 'sp-1',
        speciesName: 'Atlantic Salmon',
        fishCount: 1000,
        biomassKg: 1234.5,
        avgWeightG: 1234.5,
      },
    ],
  },
  stockings: [
    {
      date: '2026-05-03',
      speciesCode: 'Atlantic Salmon',
      supplier: 'SalmoBreed',
      fishCount: 500,
      avgWeightG: 90,
      biomassKg: 45,
      notes: 'B-2026-001',
    },
  ],
  mortality: {
    totalCount: 12,
    byCause: [{ cause: 'Disease', count: 12 }],
    details: [
      {
        date: '2026-05-10',
        cause: 'Disease',
        speciesCode: 'Atlantic Salmon',
        count: 12,
        biomassLossKg: 6,
        notes: 'gill health',
      },
    ],
  },
  slaughter: {
    totalQuantity: 200,
    totalBiomassKg: 800,
    records: [
      {
        date: '2026-05-20',
        speciesCode: 'Atlantic Salmon',
        quantity: 200,
        biomassKg: 800,
        buyer: 'FishCorp',
        notes: 'harvest run',
      },
    ],
  },
  transfers: [
    {
      date: '2026-05-15',
      direction: 'OUT',
      speciesCode: 'Atlantic Salmon',
      fishCount: 50,
      biomassKg: 60,
      counterparty: 'Site B',
      notes: 'production move',
    },
  ],
  feedConsumption: {
    totalKg: 300,
    byFeedType: [{ feedName: 'Grower 2mm', brandName: 'Skretting', quantityKg: 300 }],
  },
};

describe('hydrateFormFromPayload', () => {
  it('restores the period from the caller (0-indexed month)', () => {
    const form = hydrateFormFromPayload(payload, 4, 2026);
    expect(form.month).toBe(4);
    expect(form.year).toBe(2026);
  });

  it('maps species/mortality/slaughter/feed 1:1 (speciesCode → speciesName)', () => {
    const form = hydrateFormFromPayload(payload, 4, 2026);

    expect(form.currentBiomass.totalKg).toBe(1234.5);
    expect(form.currentBiomass.bySpecies[0]).toMatchObject({
      speciesId: 'sp-1',
      speciesName: 'Atlantic Salmon',
      fishCount: 1000,
      biomassKg: 1234.5,
    });

    expect(form.stockings[0]).toMatchObject({
      date: '2026-05-03',
      speciesName: 'Atlantic Salmon',
      quantity: 500,
      avgWeightG: 90,
      supplier: 'SalmoBreed',
      batchNumber: 'B-2026-001',
    });

    expect(form.mortality.totalCount).toBe(12);
    expect(form.mortality.byCause).toEqual([{ cause: 'Disease', count: 12 }]);
    expect(form.mortality.details[0]).toMatchObject({
      speciesName: 'Atlantic Salmon',
      biomassLossKg: 6,
    });

    expect(form.slaughter.records[0]).toMatchObject({
      speciesName: 'Atlantic Salmon',
      quantity: 200,
      buyer: 'FishCorp',
    });

    expect(form.feedConsumption.totalKg).toBe(300);
    expect(form.feedConsumption.byFeedType[0]).toMatchObject({
      feedName: 'Grower 2mm',
      brandName: 'Skretting',
      quantityKg: 300,
    });
  });

  it('maps the transfer direction enum back to the form vocabulary', () => {
    const form = hydrateFormFromPayload(payload, 4, 2026);
    expect(form.transfers[0]).toMatchObject({
      direction: 'outgoing',
      speciesName: 'Atlantic Salmon',
      quantity: 50,
      fromToSite: 'Site B',
      reason: 'production move',
    });
  });

  it('assigns each restored row a fresh id so React keys stay unique', () => {
    const form = hydrateFormFromPayload(payload, 4, 2026);
    const ids = [
      form.stockings[0].id,
      form.mortality.details[0].id,
      form.slaughter.records[0].id,
      form.transfers[0].id,
    ];
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(id).toBeTruthy());
  });

  it('leaves the "loaded from tanks" banners off — the draft is the source of truth', () => {
    const form = hydrateFormFromPayload(payload, 4, 2026);
    expect(form.biomassLoadedFromSystem).toBe(false);
    expect(form.feedLoadedFromSystem).toBe(false);
  });
});
