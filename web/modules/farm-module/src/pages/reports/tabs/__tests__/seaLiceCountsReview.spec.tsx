/**
 * SeaLice site counts — review-and-approve conversion (Phase 4, RPT-004).
 *
 * When the platform holds the week's lice_counts, the aggregated site-level
 * counts (voksneHunn/bevegelige/fastsittende) are the SSoT and render READ-ONLY
 * with their provenance badge — corrections flow to the source counts in Fish
 * Health, never the report. A MANUAL_REQUIRED verdict (no counts on record) or a
 * not-yet-resolved prefill keeps the fields editable.
 */
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import type { ReportFieldMeta } from '../../../../hooks/useReportPrefill';
import { LiceCountStep, type SeaLiceFormData } from '../SeaLiceReportTab';

const meta = (over: Partial<ReportFieldMeta>): ReportFieldMeta => ({
  path: '/lusetelling',
  provenance: 'RECORDS',
  blocking: false,
  ...over,
});

function makeFormData(): SeaLiceFormData {
  return {
    weekNumber: 30,
    year: 2026,
    waterTemperature3m: 12,
    siteCounts: { adultFemale: 0.2, mobile: 1.1, attached: 3.4, averagePerFish: 4.7 },
    cageCounts: [],
    treatmentEntries: [],
    cleanerFish: [],
    resistanceSuspicion: false,
    resistanceDetails: '',
    sensitivityTest: {
      performed: false,
      labName: '',
      testDate: '',
      ingredientTested: '',
      result: '',
    },
    treatments: [],
  };
}

describe('SeaLice LiceCountStep — site-count review-and-approve', () => {
  it('renders site counts READ-ONLY with a badge when lusetelling is from records', () => {
    render(
      <LiceCountStep
        formData={makeFormData()}
        onChange={vi.fn()}
        tankOptions={[]}
        lusetellingMeta={meta({ provenance: 'RECORDS', sourceRecordCount: 4 })}
      />,
    );
    const counts = screen.getAllByRole('spinbutton');
    expect(counts.length).toBeGreaterThanOrEqual(3);
    counts.forEach((input) => expect(input).toBeDisabled());
    expect(screen.getByText(/From records/i)).toBeInTheDocument();
  });

  it('keeps site counts editable when lusetelling is MANUAL_REQUIRED', () => {
    render(
      <LiceCountStep
        formData={makeFormData()}
        onChange={vi.fn()}
        tankOptions={[]}
        lusetellingMeta={meta({ provenance: 'MANUAL_REQUIRED', blocking: true })}
      />,
    );
    const counts = screen.getAllByRole('spinbutton');
    expect(counts.some((input) => !(input as HTMLInputElement).disabled)).toBe(true);
  });

  it('keeps site counts editable while provenance is unresolved (no meta)', () => {
    render(
      <LiceCountStep formData={makeFormData()} onChange={vi.fn()} tankOptions={[]} />,
    );
    const counts = screen.getAllByRole('spinbutton');
    expect(counts.some((input) => !(input as HTMLInputElement).disabled)).toBe(true);
  });
});
