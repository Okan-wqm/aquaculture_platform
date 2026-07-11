/**
 * Slaughter facility binding (Phase 4, RPT-007) — the slakt report selects its
 * facility from the slaughter_facilities catalog instead of accepting free text,
 * so godkjenningsnummer (the approval number the server-side assembler reads)
 * cannot drift from the SSoT. Deferred from Phase 2 ("facility dropdown binding
 * deferred to Phase 4 tab rework").
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

import type { SlaughterFacility } from '../../../../hooks/useSlaughterFacilities';

const hoisted = vi.hoisted(() => {
  const state: { facilities: SlaughterFacility[]; loading: boolean } = {
    facilities: [],
    loading: false,
  };
  return state;
});

vi.mock('../../../../hooks/useSlaughterFacilities', () => ({
  useSlaughterFacilities: () => ({ data: hoisted.facilities, isLoading: hoisted.loading }),
}));

import { FacilityStep, getInitialFormData } from '../SlaughterReportTab';

const facility = (over: Partial<SlaughterFacility>): SlaughterFacility => ({
  id: 'f1',
  tenantId: 't1',
  name: 'Nordfjord Slakteri',
  godkjenningsnummer: 'H-001',
  isDefault: false,
  isActive: true,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  ...over,
});

function baseFormData(approvalNumber = '') {
  const data = getInitialFormData();
  data.facility = { facilityName: '', approvalNumber };
  return data;
}

describe('SlaughterReportTab FacilityStep — catalog binding', () => {
  beforeEach(() => {
    hoisted.facilities = [];
    hoisted.loading = false;
  });

  it('directs the operator to Setup when the catalog is empty — no free-text approval number', () => {
    render(<FacilityStep formData={baseFormData()} onChange={vi.fn()} />);
    expect(screen.getByText(/Setup → Slaughter\s+Facilities/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Slaughter facility')).not.toBeInTheDocument();
  });

  it('auto-seeds the default facility godkjenningsnummer from the catalog', () => {
    hoisted.facilities = [
      facility({ id: 'f1', name: 'Nordfjord', godkjenningsnummer: 'H-001', isDefault: false }),
      facility({ id: 'f2', name: 'Sunnmøre', godkjenningsnummer: 'H-777', isDefault: true }),
    ];
    const onChange = vi.fn();
    render(<FacilityStep formData={baseFormData()} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledWith({
      facility: { facilityName: 'Sunnmøre', approvalNumber: 'H-777' },
    });
  });

  it('sets facilityName + approvalNumber from the chosen catalog entry', async () => {
    hoisted.facilities = [
      facility({ id: 'f1', name: 'Nordfjord', godkjenningsnummer: 'H-001', isDefault: true }),
      facility({ id: 'f2', name: 'Sunnmøre', godkjenningsnummer: 'H-777' }),
    ];
    const onChange = vi.fn();
    // Start already on the default so the auto-seed effect is a no-op.
    render(<FacilityStep formData={baseFormData('H-001')} onChange={onChange} />);
    await userEvent.selectOptions(screen.getByLabelText('Slaughter facility'), 'f2');
    expect(onChange).toHaveBeenCalledWith({
      facility: { facilityName: 'Sunnmøre', approvalNumber: 'H-777' },
    });
  });
});
