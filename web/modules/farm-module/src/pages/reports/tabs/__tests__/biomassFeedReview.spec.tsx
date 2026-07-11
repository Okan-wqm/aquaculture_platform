/**
 * Biomass feed consumption — review-and-approve conversion (Phase 4, RPT-013).
 *
 * Feed is summed from feeding_records (GetSiteFeedConsumptionQuery). When that
 * provenance is RECORDS the per-feed-type rows render read-only — corrections
 * flow to the feeding records, never the report — and the add/load/remove
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

import { FeedStep, hydrateFormFromPayload } from '../BiomassReportTab';
import type { BiomassReportPayload } from '../../../../hooks/useBiomassReports';
import type { ReportFieldMeta, ReportPrefill } from '../../../../hooks/useReportPrefill';

const payload: BiomassReportPayload = {
  currentBiomass: { totalKg: 1000, bySpecies: [] },
  stockings: [],
  mortality: { totalCount: 0, byCause: [], details: [] },
  slaughter: { totalQuantity: 0, totalBiomassKg: 0, records: [] },
  transfers: [],
  feedConsumption: {
    totalKg: 300,
    byFeedType: [{ feedName: 'Grower 2mm', brandName: 'Skretting', quantityKg: 300 }],
  },
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

describe('Biomass FeedStep — review-and-approve', () => {
  it('renders feed rows READ-ONLY with no add/load affordances when feed is from records', () => {
    render(
      <FeedStep
        formData={formData}
        onChange={vi.fn()}
        prefill={prefillWith({ path: '/feedConsumption', provenance: 'RECORDS', sourceRecordCount: 5, blocking: false })}
      />,
    );
    screen.getAllByRole('textbox').forEach((input) => expect(input).toBeDisabled());
    screen.getAllByRole('spinbutton').forEach((input) => expect(input).toBeDisabled());
    expect(screen.queryByText('+ Add Feed Type')).not.toBeInTheDocument();
    expect(screen.queryByText('Load from System')).not.toBeInTheDocument();
  });

  it('keeps feed rows editable with add/load affordances when feed is MANUAL_REQUIRED', () => {
    render(
      <FeedStep
        formData={formData}
        onChange={vi.fn()}
        prefill={prefillWith({ path: '/feedConsumption', provenance: 'MANUAL_REQUIRED', blocking: false })}
      />,
    );
    expect(screen.getAllByRole('textbox').some((input) => !(input as HTMLInputElement).disabled)).toBe(
      true,
    );
    expect(screen.getByText('+ Add Feed Type')).toBeInTheDocument();
    expect(screen.getByText('Load from System')).toBeInTheDocument();
  });
});
