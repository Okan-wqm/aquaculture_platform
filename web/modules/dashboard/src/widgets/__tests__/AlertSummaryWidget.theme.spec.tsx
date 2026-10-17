/**
 * AlertSummaryWidget — Industry console fit (README §6, §7.5, §7.8).
 *
 * Red and amber are the only alarm colours, and HIGH is the amber tile one
 * step stronger than MEDIUM's. HIGH used to paint from the `accent-*` scale,
 * the design system's High tier, which reaches amber only through the console
 * scope's alias; it now names warning, the alarm amber, so HIGH and MEDIUM
 * sit on one scale a step apart. The repeat count borrowed accent for colour
 * alone and would read as an amber alarm, so it is a neutral ink. Industry
 * has no rounded shapes: the scope squares every radius token, but
 * `rounded-full` reads none, so the severity icon, the filter chips and the
 * state marks are drawn square.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import {
  AlertIcon,
  AlertItemCard,
  EmptyState,
  ErrorState,
  LoadingState,
  SeverityFilter,
  severityConfig,
  type AlertItem,
} from '../AlertSummaryWidget';

interface MockProps {
  children?: React.ReactNode;
  className?: string;
  variant?: string;
  size?: string;
  onClick?: () => void;
  disabled?: boolean;
}

vi.mock('@aquaculture/shared-ui', () => ({
  Card: ({ children, className }: MockProps) => <div className={className}>{children}</div>,
  Badge: ({ children, variant }: MockProps) => (
    <span className={`badge badge-${variant}`}>{children}</span>
  ),
  Button: ({ children, onClick, disabled }: MockProps) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  formatRelativeTime: (): string => '5 dakika önce',
}));

const ACCENT = /\baccent-\d/;

function alert(overrides: Partial<AlertItem> = {}): AlertItem {
  return {
    id: 'alert-1',
    title: 'Test Alert',
    description: 'Test alert description',
    severity: 'medium',
    status: 'active',
    source: 'Sensor: TEMP-01',
    triggeredAt: new Date(),
    occurrenceCount: 1,
    ruleId: 'rule-1',
    ...overrides,
  };
}

describe('severityConfig — Industry alarm colours', () => {
  it('paints no severity from the accent scale', () => {
    for (const config of Object.values(severityConfig)) {
      expect(`${config.bgColor} ${config.borderColor} ${config.iconColor}`).not.toMatch(ACCENT);
    }
  });

  it('paints HIGH from the alarm amber, one step above MEDIUM', () => {
    expect(severityConfig.high.bgColor).toMatch(/\bbg-warning-\d/);
    expect(severityConfig.high.iconColor).toMatch(/\btext-warning-\d/);
  });
});

describe('Industry shapes', () => {
  it('draws the severity icon and filter chips square', () => {
    const { container } = render(<AlertIcon severity="critical" />);
    expect(container.firstChild).not.toHaveClass('rounded-full');

    render(
      <SeverityFilter
        selectedSeverities={['high']}
        onFilterChange={() => {}}
        alertCounts={{
          critical: 1,
          high: 1,
          medium: 0,
          warning: 0,
          low: 0,
          info: 0,
        }}
      />,
    );
    for (const chip of within(screen.getByTestId('severity-filter')).getAllByRole('button')) {
      expect(chip).not.toHaveClass('rounded-full');
    }
  });

  it('draws the empty, error and loading marks square', () => {
    render(<EmptyState />);
    render(<ErrorState message="TIMEOUT" />);
    render(<LoadingState count={1} />);

    for (const id of ['empty-state', 'error-state', 'loading-state']) {
      expect(screen.getByTestId(id).querySelector('.rounded-full')).toBeNull();
    }
  });

  it('shows the occurrence count in a neutral ink, not the alarm accent', () => {
    render(<AlertItemCard alert={alert({ occurrenceCount: 4 })} />);

    expect(screen.getByText('4 kez tekrarlandı').className).not.toMatch(ACCENT);
  });
});
