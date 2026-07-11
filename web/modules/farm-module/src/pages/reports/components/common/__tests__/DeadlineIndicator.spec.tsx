/**
 * DeadlineIndicator — data-driven path (RPT-003). When the server-computed
 * daysUntilDue / overdue are supplied, the chip renders from those Oslo-calendar
 * values instead of re-deriving the deadline from the browser's local clock.
 */
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';

import { DeadlineIndicator } from '../DeadlineIndicator';
import '@testing-library/jest-dom/vitest';

// A far-future deadline Date: if the component used it, urgency would be
// "normal" — so any overdue/urgent result must have come from the server props.
const FAR_FUTURE = new Date('2099-01-01T00:00:00Z');

describe('DeadlineIndicator (server-driven)', () => {
  it('renders OVERDUE from a negative daysUntilDue even when the Date is far future', () => {
    render(
      <DeadlineIndicator
        deadline={FAR_FUTURE}
        status="draft"
        daysUntilDue={-2}
        overdue
        showDate={false}
      />,
    );
    expect(screen.getByText('2 days overdue')).toBeInTheDocument();
  });

  it('renders "Due today" for daysUntilDue 0', () => {
    render(
      <DeadlineIndicator deadline={FAR_FUTURE} status="draft" daysUntilDue={0} overdue={false} />,
    );
    expect(screen.getByText('Due today')).toBeInTheDocument();
  });

  it('renders "Due tomorrow" for daysUntilDue 1', () => {
    render(
      <DeadlineIndicator deadline={FAR_FUTURE} status="draft" daysUntilDue={1} overdue={false} />,
    );
    expect(screen.getByText('Due tomorrow')).toBeInTheDocument();
  });

  it('shows the submitted state regardless of days when approved', () => {
    render(<DeadlineIndicator deadline={FAR_FUTURE} status="approved" daysUntilDue={-5} overdue />);
    expect(screen.getByText('Submitted')).toBeInTheDocument();
  });
});
