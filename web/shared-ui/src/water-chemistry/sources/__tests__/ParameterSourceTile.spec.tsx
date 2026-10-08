import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../i18n';
import { ParameterSourceTile, type ParameterSourceTileProps } from '../ParameterSourceTile';

const NOW = Date.parse('2026-10-08T10:00:00.000Z');

function props(overrides: Partial<ParameterSourceTileProps> = {}): ParameterSourceTileProps {
  return {
    name: 'pH',
    value: 7.234,
    unit: 'pH',
    precision: 2,
    observedAt: '2026-10-08T09:55:00.000Z',
    now: NOW,
    windowSeconds: 14_400,
    quality: 'GOOD',
    kind: 'CHANNEL_PRIMARY',
    inheritedFrom: null,
    detail: 'Probe 3 · ph',
    trend: null,
    color: '#0ea5e9',
    problems: [],
    ...overrides,
  };
}

describe('ParameterSourceTile', () => {
  it('shows the value at its precision, its unit, kind, age and quality', () => {
    render(<ParameterSourceTile {...props()} />);
    expect(screen.getByText('7.23')).toBeInTheDocument();
    expect(screen.getByText('Primary channel')).toBeInTheDocument();
    expect(screen.getByText('5 min ago')).toBeInTheDocument();
    expect(screen.getByTitle('Good')).toBeInTheDocument();
    expect(screen.getByText('Probe 3 · ph')).toBeInTheDocument();
  });

  it('says where an inherited value stands and when it is older than its window', () => {
    render(
      <ParameterSourceTile
        {...props({ inheritedFrom: 'system', observedAt: '2026-10-08T04:00:00.000Z' })}
      />,
    );
    expect(screen.getByText('from the system')).toBeInTheDocument();
    expect(screen.getByText('Older than its window')).toBeInTheDocument();
  });

  it('shows no number when there is no value', () => {
    render(<ParameterSourceTile {...props({ value: null, observedAt: null, quality: null })} />);
    expect(screen.getByText('No value')).toBeInTheDocument();
  });

  it('lists the problems and opens their fix without selecting the tile', () => {
    const onFix = vi.fn();
    const onSelect = vi.fn();
    render(<ParameterSourceTile {...props({ problems: ['CHANNEL_DISABLED'], onFix, onSelect })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Fix: The channel is disabled' }));
    expect(onFix).toHaveBeenCalledWith('CHANNEL_DISABLED', 'channel');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps the fix chips reachable by keyboard: Enter on a chip fixes, it does not select the tile', async () => {
    const user = userEvent.setup();
    const onFix = vi.fn();
    const onSelect = vi.fn();
    render(<ParameterSourceTile {...props({ problems: ['CHANNEL_DISABLED'], onFix, onSelect })} />);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Show the trend of pH' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(1);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Fix: The channel is disabled' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onFix).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('draws the trend by time and names its own unit', () => {
    render(
      <ParameterSourceTile
        {...props({
          trend: {
            points: [
              { t: NOW - 3_600_000, v: 7.1 },
              { t: NOW - 1_800_000, v: null },
              { t: NOW, v: 7.2 },
            ],
            start: NOW - 86_400_000,
            end: NOW,
            unit: 'NBS',
          },
        })}
      />,
    );
    expect(screen.getByTestId('time-sparkline')).toHaveTextContent('last 24 h, in NBS');
  });

  it('renders read-only problems as text when no fix is offered', () => {
    render(<ParameterSourceTile {...props({ problems: ['NOT_AT_POINT'] })} />);
    expect(
      screen.getByText('The sensor does not stand at this measurement point'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('speaks Turkish under a Turkish provider', () => {
    render(
      <I18nProvider locale="tr">
        <ParameterSourceTile {...props({ kind: 'MANUAL' })} />
      </I18nProvider>,
    );
    expect(screen.getByText('Elle örnek')).toBeInTheDocument();
  });
});
