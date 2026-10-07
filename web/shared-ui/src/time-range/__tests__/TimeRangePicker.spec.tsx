import type { TimeRangeSpec } from '@aquaculture/shared-contracts';
import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { TimeRangePicker } from '../TimeRangePicker';

// 2026-09-20 12:00 in Oslo (CEST, UTC+2).
const NOW = Date.parse('2026-09-20T10:00:00Z');
const ZONE = 'Europe/Oslo';

function renderPicker(
  value: TimeRangeSpec,
  extra: Partial<React.ComponentProps<typeof TimeRangePicker>> = {},
): ReturnType<typeof vi.fn> {
  const onChange = vi.fn();
  render(
    <I18nProvider locale="en">
      <TimeRangePicker
        value={value}
        onChange={onChange}
        presets={['1h', '24h', '7d', '30d']}
        timeZone={ZONE}
        {...extra}
      />
    </I18nProvider>,
  );
  return onChange;
}

const open = (): HTMLElement => {
  fireEvent.click(screen.getByRole('button', { name: /^Choose a time range/ }));
  return screen.getByRole('dialog', { name: 'Choose a time range' });
};

const day = (dialog: HTMLElement, name: RegExp): HTMLElement =>
  within(dialog).getByRole('button', { name });

describe('TimeRangePicker', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('names the current preset and applies another one', () => {
    const onChange = renderPicker({ kind: 'relative', preset: '24h' });
    const dialog = open();
    expect(within(dialog).getByRole('button', { name: 'Last 24 hours' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Last 7 days' }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'relative', preset: '7d' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('turns picked days into a window covering them fully in the chart zone', () => {
    const onChange = renderPicker({ kind: 'relative', preset: '24h' });
    const dialog = open();
    fireEvent.click(day(dialog, /September 16, 2026/));
    expect(within(dialog).getByText('Pick the last day')).toBeInTheDocument();
    fireEvent.click(day(dialog, /September 19, 2026/));
    fireEvent.change(within(dialog).getByLabelText('Start time'), { target: { value: '00:00' } });
    fireEvent.change(within(dialog).getByLabelText('End time'), { target: { value: '23:59' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    // 16 Sep 00:00 CEST … end of 19 Sep CEST.
    expect(onChange).toHaveBeenCalledWith({
      kind: 'absolute',
      startMs: Date.parse('2026-09-15T22:00:00Z'),
      endMs: Date.parse('2026-09-19T22:00:00Z'),
    });
  });

  it('reads times in the chart zone, not the browser zone', () => {
    const onChange = renderPicker({ kind: 'relative', preset: '24h' });
    const dialog = open();
    fireEvent.click(day(dialog, /September 18, 2026/));
    fireEvent.click(day(dialog, /September 17, 2026/));
    fireEvent.change(within(dialog).getByLabelText('Start time'), { target: { value: '14:00' } });
    fireEvent.change(within(dialog).getByLabelText('End time'), { target: { value: '08:00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    // Picked in reverse order; 17 Sep 14:00 CEST through the minute 18 Sep 08:00 CEST.
    expect(onChange).toHaveBeenCalledWith({
      kind: 'absolute',
      startMs: Date.parse('2026-09-17T12:00:00Z'),
      endMs: Date.parse('2026-09-18T06:01:00Z'),
    });
  });

  it('says what is missing instead of applying a half-filled range', () => {
    const onChange = renderPicker({ kind: 'relative', preset: '24h' });
    const dialog = open();
    fireEvent.click(day(dialog, /September 16, 2026/));
    fireEvent.click(day(dialog, /September 17, 2026/));
    fireEvent.change(within(dialog).getByLabelText('End time'), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Pick both days and enter both times',
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reopens a fixed window on its own days and times', () => {
    renderPicker({
      kind: 'absolute',
      startMs: Date.parse('2026-09-17T12:00:00Z'),
      endMs: Date.parse('2026-09-18T06:01:00Z'),
    });
    expect(screen.getByRole('button', { name: /^Choose a time range/ })).toHaveTextContent(
      /Sep 17, 2026, 2:00\sPM – Sep 18, 2026, 8:00\sAM/,
    );
    const dialog = open();
    expect(within(dialog).getByLabelText('Start time')).toHaveValue('14:00');
    expect(within(dialog).getByLabelText('End time')).toHaveValue('08:00');
  });

  it('marks days without stored data and offers no future day', () => {
    renderPicker(
      { kind: 'relative', preset: '24h' },
      {
        dataBounds: {
          firstMs: Date.parse('2026-09-16T06:00:00Z'),
          lastMs: Date.parse('2026-09-19T18:00:00Z'),
        },
      },
    );
    const dialog = open();
    expect(day(dialog, /September 15, 2026, no data stored/)).toBeInTheDocument();
    expect(day(dialog, /^Wednesday, September 16, 2026$/)).toBeInTheDocument();
    expect(day(dialog, /September 21, 2026/)).toBeDisabled();
  });

  it('moves through days by keyboard and closes on Escape back to its trigger', () => {
    renderPicker({ kind: 'relative', preset: '24h' });
    const dialog = open();
    const grid = within(dialog).getByRole('grid');
    const start = day(dialog, /September 20, 2026/);
    expect(start).toHaveAttribute('tabindex', '0');
    start.focus();
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(day(dialog, /September 19, 2026/));
    fireEvent.keyDown(grid, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(day(dialog, /September 12, 2026/));
    fireEvent.keyDown(grid, { key: 'PageUp' });
    expect(within(dialog).getByText('August 2026')).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /^Choose a time range/ }),
    );
  });
});
