/**
 * PrefilledField (Phase 4) — locks the review-and-approve invariant: a value the
 * platform owns (RECORDS / SENSOR) is READ-ONLY (no input), and only a
 * MANUAL_REQUIRED field exposes an editable input.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { PrefilledField } from '../PrefilledField';
import type { ReportFieldMeta } from '../../../../../hooks/useReportPrefill';
import '@testing-library/jest-dom/vitest';

const meta = (over: Partial<ReportFieldMeta>): ReportFieldMeta => ({
  path: '/x',
  provenance: 'RECORDS',
  blocking: false,
  ...over,
});

describe('PrefilledField', () => {
  it('renders RECORDS values read-only — no editable input', () => {
    render(<PrefilledField label="Mortality" meta={meta({ provenance: 'RECORDS' })} value={42} />);
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('renders SENSOR values read-only — no editable input', () => {
    render(
      <PrefilledField label="Temperature" meta={meta({ provenance: 'SENSOR' })} value={12.4} />,
    );
    expect(screen.getByText('12.4')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('renders an editable input ONLY for a MANUAL_REQUIRED field', () => {
    render(
      <PrefilledField
        label="Approval number"
        meta={meta({ provenance: 'MANUAL_REQUIRED', blocking: true, message: 'Enter it' })}
        overrideValue=""
        onOverrideChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Approval number' })).toBeInTheDocument();
  });

  it('flags a blocking manual field that is still empty', () => {
    render(
      <PrefilledField
        label="Approval number"
        meta={meta({ provenance: 'MANUAL_REQUIRED', blocking: true, message: 'This is required' })}
        overrideValue=""
        onOverrideChange={vi.fn()}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Approval number' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('This is required')).toBeInTheDocument();
  });

  it('emits override changes', async () => {
    const onChange = vi.fn();
    render(
      <PrefilledField
        label="Approval number"
        meta={meta({ provenance: 'MANUAL_REQUIRED', blocking: true })}
        overrideValue=""
        onOverrideChange={onChange}
      />,
    );
    await userEvent.type(screen.getByRole('textbox', { name: 'Approval number' }), 'A');
    expect(onChange).toHaveBeenCalledWith('A');
  });
});
