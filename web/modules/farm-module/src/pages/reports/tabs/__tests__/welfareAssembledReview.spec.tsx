/**
 * WelfareAssembledReview (Phase 4, RPT-010) — the welfare varsling assembles from
 * the latest welfare_assessment; indicator scores + derived severity render
 * READ-ONLY with provenance, no assessment shows the record-first guidance.
 */
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { WelfareAssembledReview } from '../WelfareEventTab';
import type { ReportFieldMeta, ReportPrefill } from '../../../../hooks/useReportPrefill';

interface WelfarePayload {
  assessmentId: string | null;
  assessedAt: string | null;
  fishSampled: number;
  gillScore: number | null;
  finScore: number | null;
  woundScore: number | null;
  deformityScore: number | null;
  worstScore: number | null;
  severity: string;
  welfareEventType: string;
  mortalityRate: number | null;
  affectedUnits: string[];
}

function prefill(draftPayload: WelfarePayload, fields: ReportFieldMeta[]): ReportPrefill<WelfarePayload> {
  return {
    reportType: 'WELFARE_EVENT',
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

describe('WelfareAssembledReview', () => {
  it('renders the assessment scores + derived severity read-only with badges', () => {
    render(
      <WelfareAssembledReview
        prefill={prefill(
          {
            assessmentId: 'wa-1',
            assessedAt: '2026-06-12',
            fishSampled: 100,
            gillScore: 3,
            finScore: 1,
            woundScore: 0,
            deformityScore: 0,
            worstScore: 3,
            severity: 'critical',
            welfareEventType: '',
            mortalityRate: null,
            affectedUnits: ['MERD-03'],
          },
          [rec('/assessedAt'), rec('/gillScore'), rec('/severity'), manual('/welfareEventType')],
        )}
      />,
    );
    expect(screen.getByText('critical')).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.getAllByText(/From records/i).length).toBeGreaterThan(0);
    // The manual event type is flagged, not silently omitted.
    expect(screen.getByText(/Required/i)).toBeInTheDocument();
  });

  it('shows record-first guidance when there is no assessment', () => {
    render(
      <WelfareAssembledReview
        prefill={prefill(
          {
            assessmentId: null,
            assessedAt: null,
            fishSampled: 0,
            gillScore: null,
            finScore: null,
            woundScore: null,
            deformityScore: null,
            worstScore: null,
            severity: '',
            welfareEventType: '',
            mortalityRate: null,
            affectedUnits: [],
          },
          [manual('/')],
        )}
      />,
    );
    expect(screen.getByText(/No welfare assessment on record/i)).toBeInTheDocument();
  });
});
