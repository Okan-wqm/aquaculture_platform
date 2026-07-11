/**
 * SeaLice temperature — review-and-approve conversion (Phase 4, RPT-002/RPT-005).
 *
 * Locks the rule at the tab-integration level: a SENSOR/RECORDS temperature is
 * READ-ONLY in the sea-lice form (corrections flow to the source measurement,
 * never the report), and only a MANUAL_REQUIRED verdict — or provenance not yet
 * resolved — keeps the operator-entry field editable so a schema-required value
 * is never locked read-only before the assembler verdict lands.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import type { ReportFieldMeta } from '../../../../hooks/useReportPrefill';
import { BasicInfoStep, type SeaLiceFormData } from '../SeaLiceReportTab';

const meta = (over: Partial<ReportFieldMeta>): ReportFieldMeta => ({
  path: '/sjøtemperatur',
  provenance: 'SENSOR',
  blocking: false,
  ...over,
});

function makeFormData(waterTemperature3m: number): SeaLiceFormData {
  return {
    weekNumber: 30,
    year: 2026,
    waterTemperature3m,
    siteCounts: { adultFemale: 0, mobile: 0, attached: 0, averagePerFish: 0 },
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

describe('SeaLice BasicInfoStep — temperature review-and-approve', () => {
  it('renders a SENSOR temperature READ-ONLY — no editable number input', () => {
    render(
      <BasicInfoStep
        formData={makeFormData(12.4)}
        onChange={vi.fn()}
        siteName="Test Site"
        temperatureMeta={meta({ provenance: 'SENSOR', sensorId: 'sensor-1' })}
      />,
    );
    expect(screen.getByText('12.4 °C')).toBeInTheDocument();
    // Site + Report Period are disabled text inputs; a RECORDS/SENSOR
    // temperature must not add an editable number field.
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('exposes an editable input for a MANUAL_REQUIRED temperature and threads it into formData', async () => {
    const onChange = vi.fn();
    render(
      <BasicInfoStep
        formData={makeFormData(0)}
        onChange={onChange}
        siteName="Test Site"
        temperatureMeta={meta({
          provenance: 'MANUAL_REQUIRED',
          blocking: true,
          message: 'No site temperature on record',
        })}
      />,
    );
    const input = screen.getByRole('spinbutton', {
      name: 'Water Temperature at 3m Depth (°C)',
    });
    await userEvent.type(input, '9');
    expect(onChange).toHaveBeenCalledWith({ waterTemperature3m: 9 });
  });

  it('keeps the field editable while provenance is unresolved (prefill in flight)', () => {
    render(
      <BasicInfoStep
        formData={makeFormData(0)}
        onChange={vi.fn()}
        siteName="Test Site"
        temperatureMeta={undefined}
      />,
    );
    expect(screen.getByRole('spinbutton')).toBeInTheDocument();
  });
});
