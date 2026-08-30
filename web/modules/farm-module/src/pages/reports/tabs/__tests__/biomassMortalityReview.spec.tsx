/**
 * Biomass mortality-by-cause — review-and-approve conversion (Phase 4, RPT-012).
 *
 * The mortality section aggregates mortality_records per cause (GetMortalityBy-
 * CauseQuery). When that provenance is RECORDS the per-cause grid renders
 * read-only — corrections flow to the source records, never the report — and the
 * "Load from System" affordance is hidden (hydrateFormFromPayload already seeded
 * the counts). A MANUAL_REQUIRED verdict keeps the grid editable.
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

import { MortalityStep, hydrateFormFromPayload } from '../BiomassReportTab';
import type { BiomassReportPayload } from '../../../../hooks/useBiomassReports';
import type { ReportFieldMeta, ReportPrefill } from '../../../../hooks/useReportPrefill';

const payload: BiomassReportPayload = {
  currentBiomass: { totalKg: 1000, bySpecies: [] },
  stockings: [],
  mortality: {
    totalCount: 12,
    byCause: [{ cause: 'Disease', count: 12 }],
    details: [],
  },
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

describe('Biomass MortalityStep — review-and-approve', () => {
  it('renders the per-cause grid READ-ONLY when mortality is from records', () => {
    render(
      <MortalityStep
        formData={formData}
        onChange={vi.fn()}
        prefill={prefillWith({
          path: '/mortality',
          provenance: 'RECORDS',
          sourceRecordCount: 3,
          blocking: false,
        })}
      />,
    );
    const counts = screen.getAllByRole('spinbutton');
    expect(counts.length).toBeGreaterThan(0);
    counts.forEach((input) => expect(input).toBeDisabled());
    // "Load from System" is hidden once the counts are records-driven.
    expect(screen.queryByText('Load from System')).not.toBeInTheDocument();
  });

  it('keeps the per-cause grid editable when mortality is MANUAL_REQUIRED', () => {
    render(
      <MortalityStep
        formData={formData}
        onChange={vi.fn()}
        prefill={prefillWith({
          path: '/mortality',
          provenance: 'MANUAL_REQUIRED',
          blocking: false,
        })}
      />,
    );
    const counts = screen.getAllByRole('spinbutton');
    expect(counts.some((input) => !(input as HTMLInputElement).disabled)).toBe(true);
    expect(screen.getByText('Load from System')).toBeInTheDocument();
  });
});
