/**
 * Biomass stocking records — review-and-approve conversion (Phase 4, RPT-002).
 *
 * Stockings are assembled from batches_v2 (stockedAt / initialQuantity). When
 * that provenance is RECORDS the rows render read-only (a disabled fieldset) —
 * corrections flow to the batch records, never the report — and the add/remove
 * affordances are hidden. A MANUAL_REQUIRED verdict keeps the rows editable.
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

import { StockingStep, hydrateFormFromPayload } from '../BiomassReportTab';
import type { BiomassReportPayload } from '../../../../hooks/useBiomassReports';
import type { ReportFieldMeta, ReportPrefill } from '../../../../hooks/useReportPrefill';

const payload: BiomassReportPayload = {
  currentBiomass: { totalKg: 0, bySpecies: [] },
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

describe('Biomass StockingStep — review-and-approve', () => {
  it('renders stocking rows READ-ONLY with no add/remove when stockings are from records', () => {
    render(
      <StockingStep
        formData={formData}
        onChange={vi.fn()}
        prefill={prefillWith({ path: '/stockings', provenance: 'RECORDS', sourceRecordCount: 1, blocking: false })}
      />,
    );
    screen.getAllByRole('textbox').forEach((input) => expect(input).toBeDisabled());
    screen.getAllByRole('spinbutton').forEach((input) => expect(input).toBeDisabled());
    expect(screen.queryByText('+ Add Stocking Record')).not.toBeInTheDocument();
  });

  it('keeps stocking rows editable with the add affordance when stockings are MANUAL_REQUIRED', () => {
    render(
      <StockingStep
        formData={formData}
        onChange={vi.fn()}
        prefill={prefillWith({ path: '/stockings', provenance: 'MANUAL_REQUIRED', blocking: false })}
      />,
    );
    expect(screen.getAllByRole('textbox').some((input) => !(input as HTMLInputElement).disabled)).toBe(
      true,
    );
    expect(screen.getByText('+ Add Stocking Record')).toBeInTheDocument();
  });
});
