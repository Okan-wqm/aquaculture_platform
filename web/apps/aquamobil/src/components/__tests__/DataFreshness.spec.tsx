// MOB-MEDIUM-008 — every operational metric must carry a visible age.
//
// A field worker cannot act on a number they cannot date: a DO value from 30
// seconds ago and one from yesterday look identical without an "as of" stamp.
// DataFreshness is the single SSoT for that stamp — tank readings, the tank
// cards, and the global last-synced clock all render through it, so staleness
// tiers (fresh / aging / stale) stay consistent across every surface.

import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';

import { DataFreshness } from '../DataFreshness';

const NOW = new Date('2026-07-12T12:00:00.000Z').getTime();

describe('DataFreshness (MOB-MEDIUM-008)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders a fresh stamp for data under the aging threshold', () => {
    render(<DataFreshness timestamp={new Date(NOW - 45_000).toISOString()} />);

    const stamp = screen.getByText('Just now');
    // v4: the tiers wear semantic tokens (text-ok/text-warn/text-crit) instead
    // of a green/amber/red ramp. The tier boundaries and meanings are unchanged.
    expect(stamp.className).toContain('text-ok');
  });

  it('renders an aging stamp between 2 and 15 minutes', () => {
    render(<DataFreshness timestamp={new Date(NOW - 5 * 60_000).toISOString()} />);

    const stamp = screen.getByText('5m ago');
    expect(stamp.className).toContain('text-warn');
  });

  it('renders a stale stamp past 15 minutes — visually loud, not quietly grey', () => {
    render(<DataFreshness timestamp={new Date(NOW - 2 * 3_600_000).toISOString()} />);

    const stamp = screen.getByText('2h ago');
    expect(stamp.className).toContain('text-crit');
  });

  it('renders an explicit "No data" state instead of pretending', () => {
    render(<DataFreshness timestamp={null} />);

    expect(screen.getByText('No data')).toBeTruthy();
  });

  it('exposes the exact time to assistive tech via title/aria-label', () => {
    const ts = new Date(NOW - 5 * 60_000).toISOString();
    render(<DataFreshness timestamp={ts} />);

    const stamp = screen.getByText('5m ago');
    expect(stamp.getAttribute('title')).toContain('2026');
  });
});
