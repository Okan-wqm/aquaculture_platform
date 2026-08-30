/**
 * Biomass current-stock (by species) — review-and-approve conversion (Phase 4,
 * RPT-002). Standing stock is assembled from batch/tank records via
 * BiomassCalculatorService. When that provenance is RECORDS the per-species rows
 * render read-only — corrections flow to the batch/tank records, never the
 * report — and the add/load/remove affordances are hidden. A MANUAL_REQUIRED
 * verdict keeps the rows editable.
 *
 * `@aquaculture/shared-ui` is stubbed so importing the tab module (which pulls
 * the data-layer hooks) does not need a live federation/provider environment.
 */
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', () => ({
  graphqlClient: { request: vi.fn() },
  useTenantQuery: vi.fn(),
  useAuth: vi.fn(),
  createTenantInvalidationKey: vi.fn(),
}));

import { BiomassStep, hydrateFormFromPayload } from '../BiomassReportTab';
import type { BiomassReportPayload } from '../../../../hooks/useBiomassReports';
import type { ReportFieldMeta, ReportPrefill } from '../../../../hooks/useReportPrefill';

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
  stockings: [],
  mortality: { totalCount: 0, byCause: [], details: [] },
  slaughter: { totalQuantity: 0, totalBiomassKg: 0, records: [] },
  transfers: [],
  feedConsumption: { totalKg: 0, byFeedType: [] },
};

function prefillWith(meta: ReportFieldMeta): ReportPrefill<BiomassReportPayload> {
  return {
    reportType: 'BIOMASS',
    siteId: 'site-1',
    periodYear: 2026,
    periodWeek: null,
    periodMonth: 5,
    draftPayload: payload,
    fields: [meta],
    schemaValid: true,
    assembledAt: '2026-06-01T00:00:00.000Z',
  };
}

const formData = hydrateFormFromPayload(payload, 4, 2026);

describe('Biomass BiomassStep — current-stock review-and-approve', () => {
  it('renders species rows READ-ONLY with no add/load affordances when stock is from records', () => {
    render(
      <BiomassStep
        formData={formData}
        onChange={vi.fn()}
        prefill={prefillWith({
          path: '/currentBiomass',
          provenance: 'RECORDS',
          sourceRecordCount: 2,
          blocking: false,
        })}
      />,
    );
    screen.getAllByRole('textbox').forEach((input) => expect(input).toBeDisabled());
    screen.getAllByRole('spinbutton').forEach((input) => expect(input).toBeDisabled());
    expect(screen.queryByText('+ Add Species')).not.toBeInTheDocument();
    expect(screen.queryByText('Load from System')).not.toBeInTheDocument();
  });

  it('keeps species rows editable with add/load affordances when stock is MANUAL_REQUIRED', () => {
    render(
      <BiomassStep
        formData={formData}
        onChange={vi.fn()}
        prefill={prefillWith({
          path: '/currentBiomass',
          provenance: 'MANUAL_REQUIRED',
          blocking: false,
        })}
      />,
    );
    // Species name becomes editable (the avg-weight field is always derived/disabled).
    expect(
      screen.getAllByRole('textbox').some((input) => !(input as HTMLInputElement).disabled),
    ).toBe(true);
    expect(screen.getByText('+ Add Species')).toBeInTheDocument();
    expect(screen.getByText('Load from System')).toBeInTheDocument();
  });
});
