/**
 * Biomass transfers — review-and-approve conversion (Phase 4, RPT-002/RPT-014).
 *
 * Transfers are assembled from tank_operations (TRANSFER_IN/OUT). When that
 * provenance is RECORDS the rows render read-only (a disabled fieldset) —
 * corrections flow to the transfer records, never the report — and the
 * add/remove affordances are hidden. A MANUAL_REQUIRED verdict keeps the rows
 * editable.
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

import { TransfersStep, hydrateFormFromPayload } from '../BiomassReportTab';
import type { BiomassReportPayload } from '../../../../hooks/useBiomassReports';
import type { ReportFieldMeta, ReportPrefill } from '../../../../hooks/useReportPrefill';

const payload: BiomassReportPayload = {
  currentBiomass: { totalKg: 0, bySpecies: [] },
  stockings: [],
  mortality: { totalCount: 0, byCause: [], details: [] },
  slaughter: { totalQuantity: 0, totalBiomassKg: 0, records: [] },
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

describe('Biomass TransfersStep — review-and-approve', () => {
  it('renders transfer rows READ-ONLY with no add/remove when transfers are from records', () => {
    render(
      <TransfersStep
        formData={formData}
        onChange={vi.fn()}
        prefill={prefillWith({ path: '/transfers', provenance: 'RECORDS', sourceRecordCount: 1, blocking: false })}
      />,
    );
    screen.getAllByRole('textbox').forEach((input) => expect(input).toBeDisabled());
    screen.getAllByRole('spinbutton').forEach((input) => expect(input).toBeDisabled());
    screen.getAllByRole('combobox').forEach((select) => expect(select).toBeDisabled());
    expect(screen.queryByText('+ Add Transfer')).not.toBeInTheDocument();
  });

  it('keeps transfer rows editable with the add affordance when transfers are MANUAL_REQUIRED', () => {
    render(
      <TransfersStep
        formData={formData}
        onChange={vi.fn()}
        prefill={prefillWith({ path: '/transfers', provenance: 'MANUAL_REQUIRED', blocking: false })}
      />,
    );
    expect(screen.getAllByRole('textbox').some((input) => !(input as HTMLInputElement).disabled)).toBe(
      true,
    );
    expect(screen.getByText('+ Add Transfer')).toBeInTheDocument();
  });
});
