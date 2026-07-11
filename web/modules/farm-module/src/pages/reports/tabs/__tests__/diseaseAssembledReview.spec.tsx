/**
 * DiseaseAssembledReview (Phase 4, RPT-011) — the disease varsling assembles from
 * the latest disease_outbreak health event (interim source); disease name /
 * affected % / pathogen category render READ-ONLY with provenance, and the
 * A/C/F list category + confirmation + count are flagged manual.
 */
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { DiseaseAssembledReview } from '../DiseaseOutbreakTab';
import type { ReportFieldMeta, ReportPrefill } from '../../../../hooks/useReportPrefill';

interface DiseasePayload {
  healthEventId: string | null;
  eventDate: string | null;
  diseaseName: string;
  pathogenCategory: string | null;
  affectedPercentage: number | null;
  diseaseCategory: string;
  confirmation: string;
  affectedCount: number | null;
  description: string | null;
}

function prefill(draftPayload: DiseasePayload, fields: ReportFieldMeta[]): ReportPrefill<DiseasePayload> {
  return {
    reportType: 'DISEASE_OUTBREAK',
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

const rec = (path: string): ReportFieldMeta => ({ path, provenance: 'RECORDS', sourceRecordCount: 1, blocking: false });
const manual = (path: string): ReportFieldMeta => ({ path, provenance: 'MANUAL_REQUIRED', blocking: true });

describe('DiseaseAssembledReview', () => {
  it('renders the health-event disease facts read-only + flags the manual A/C/F category', () => {
    render(
      <DiseaseAssembledReview
        prefill={prefill(
          {
            healthEventId: 'he-1',
            eventDate: '2026-06-14',
            diseaseName: 'Amoebic gill disease',
            pathogenCategory: 'parasitic',
            affectedPercentage: 18,
            diseaseCategory: '',
            confirmation: '',
            affectedCount: null,
            description: 'lethargy',
          },
          [rec('/diseaseName'), rec('/affectedPercentage'), manual('/diseaseCategory'), manual('/confirmation')],
        )}
      />,
    );
    expect(screen.getByText('Amoebic gill disease')).toBeInTheDocument();
    expect(screen.getByText('parasitic')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getAllByText(/From records/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Required/i).length).toBeGreaterThan(0);
  });

  it('shows record-first guidance when there is no disease event', () => {
    render(
      <DiseaseAssembledReview
        prefill={prefill(
          {
            healthEventId: null,
            eventDate: null,
            diseaseName: '',
            pathogenCategory: null,
            affectedPercentage: null,
            diseaseCategory: '',
            confirmation: '',
            affectedCount: null,
            description: null,
          },
          [manual('/')],
        )}
      />,
    );
    expect(screen.getByText(/No disease-outbreak health event/i)).toBeInTheDocument();
  });
});
