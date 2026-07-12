/**
 * EscapeAssembledReview (Phase 4, RPT-009) — the escape varsling assembles from
 * the recorded escape_incident. The facts render READ-ONLY with provenance
 * badges (corrections go to Fish Health); a site with no open incident shows the
 * fail-closed "record it first" guidance.
 */
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { EscapeAssembledReview } from '../EscapeReportTab';
import type { ReportFieldMeta, ReportPrefill } from '../../../../hooks/useReportPrefill';

interface EscapePayload {
  incidentId: string | null;
  detectedAt: string | null;
  estimatedCount: number;
  species: string;
  avgWeightG: number | null;
  totalBiomassKg: number | null;
  cause: string;
  affectedUnits: string[];
  recoveryOngoing: boolean;
}

function prefill(
  draftPayload: EscapePayload,
  fields: ReportFieldMeta[],
): ReportPrefill<EscapePayload> {
  return {
    reportType: 'ESCAPE',
    siteId: 'site-1',
    periodYear: 2026,
    periodWeek: null,
    periodMonth: null,
    draftPayload,
    fields,
    schemaValid: !fields.some((f) => f.blocking),
    assembledAt: '2026-07-10T00:00:00.000Z',
  };
}

const rec = (path: string): ReportFieldMeta => ({
  path,
  provenance: 'RECORDS',
  sourceRecordCount: 1,
  blocking: false,
});

describe('EscapeAssembledReview', () => {
  it('renders the recorded incident facts read-only with a records badge', () => {
    render(
      <EscapeAssembledReview
        prefill={prefill(
          {
            incidentId: 'inc-1',
            detectedAt: '2026-06-10T08:30:00.000Z',
            estimatedCount: 1200,
            species: 'SAL',
            avgWeightG: 4200,
            totalBiomassKg: 5040,
            cause: 'hole_in_net',
            affectedUnits: ['MERD-07'],
            recoveryOngoing: true,
          },
          [rec('/detectedAt'), rec('/estimatedCount'), rec('/species'), rec('/cause')],
        )}
      />,
    );
    expect(screen.getByText('1200')).toBeInTheDocument();
    expect(screen.getByText('SAL')).toBeInTheDocument();
    expect(screen.getByText('MERD-07')).toBeInTheDocument();
    // No editable inputs — the card is a pure review surface.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.getAllByText(/From records/i).length).toBeGreaterThan(0);
  });

  it('shows fail-closed guidance when the site has no open incident', () => {
    render(
      <EscapeAssembledReview
        prefill={prefill(
          {
            incidentId: null,
            detectedAt: null,
            estimatedCount: 0,
            species: '',
            avgWeightG: null,
            totalBiomassKg: null,
            cause: '',
            affectedUnits: [],
            recoveryOngoing: false,
          },
          [{ path: '/', provenance: 'MANUAL_REQUIRED', blocking: true }],
        )}
      />,
    );
    expect(screen.getByText(/No open, unreported escape incident/i)).toBeInTheDocument();
  });

  it('renders nothing until the prefill resolves', () => {
    const { container } = render(<EscapeAssembledReview prefill={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
