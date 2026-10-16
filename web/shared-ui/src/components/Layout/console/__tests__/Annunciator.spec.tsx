/**
 * Annunciator — the console's alarm strip (design handoff README §7.5).
 *
 * Four tile buttons, CRIT / HIGH / MED / UNACK: CRIT lights hazard red and its
 * square blinks while a P1 alarm awaits acknowledgement (never under
 * prefers-reduced-motion), HIGH lights amber, MED
 * and UNACK stand on the surface, a zero count greys its tile out. A tile is
 * pressed while its filter is the active one; pressing it again clears the
 * filter. Loading shows "—"; a failed query greys every tile and says why in
 * the tile's title. Real counts only — the strip has no value of its own.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../../i18n';
import { Annunciator, type AnnunciatorProps } from '../Annunciator';

const COUNTS = { p1: 2, p2: 3, p3: 2, unack: 5 } as const;

function renderStrip(overrides: Partial<AnnunciatorProps> = {}): {
  onSelect: ReturnType<typeof vi.fn>;
} {
  const onSelect = vi.fn();
  render(
    <Annunciator
      status="ready"
      counts={COUNTS}
      unacknowledgedP1={1}
      activePriority={null}
      onSelect={onSelect}
      {...overrides}
    />,
  );
  return { onSelect };
}

function tiles(): HTMLElement[] {
  return within(screen.getByRole('region', { name: 'Alarm summary' })).getAllByRole('button');
}

/** The tile's text as a reader sees it: whitespace collapsed, ends trimmed. */
function text(element: HTMLElement): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function tile(code: string): HTMLElement {
  const found = tiles().find((button) => text(button).split(' ').includes(code));
  if (!found) throw new Error(`no tile ${code}`);
  return found;
}

describe('Annunciator — tiles', () => {
  it('renders the alarm summary as four tiles, CRIT, HIGH, MED, UNACK, with their counts', () => {
    renderStrip();

    const buttons = tiles();
    expect(buttons.map(text)).toEqual([
      '2 CRIT Critical',
      '3 HIGH High',
      '2 MED Medium',
      '5 UNACK Awaiting acknowledgement',
    ]);
    expect(buttons[0]).toHaveAccessibleName('2 CRIT Critical');
    expect(buttons[3]).toHaveAccessibleName('5 UNACK Awaiting acknowledgement');
  });

  it('lights CRIT red and HIGH amber, and stands MED and UNACK on the surface', () => {
    renderStrip();

    expect(tile('CRIT')).toHaveAttribute('data-tone', 'crit');
    expect(tile('HIGH')).toHaveAttribute('data-tone', 'high');
    expect(tile('MED')).toHaveAttribute('data-tone', 'med');
    expect(tile('UNACK')).toHaveAttribute('data-tone', 'unack');
    expect(tile('CRIT').className).toContain('bg-sd-hz-red-deep');
    expect(tile('HIGH').className).toContain('bg-sd-hz-amber');
  });

  it('greys out a tile whose count is zero', () => {
    renderStrip({ counts: { p1: 0, p2: 3, p3: 0, unack: 0 } });

    expect(tile('CRIT')).toHaveAttribute('data-tone', 'idle');
    expect(tile('MED')).toHaveAttribute('data-tone', 'idle');
    expect(tile('UNACK')).toHaveAttribute('data-tone', 'idle');
    expect(tile('HIGH')).toHaveAttribute('data-tone', 'high');
    expect(tile('CRIT')).toHaveAccessibleName('0 CRIT Critical');
  });

  it('draws the glyphs ■ ▲ ◇ on the priority tiles and none on UNACK', () => {
    renderStrip();

    expect(tile('CRIT').querySelector('[data-glyph="p1"]')).not.toBeNull();
    expect(tile('HIGH').querySelector('[data-glyph="p2"]')).not.toBeNull();
    expect(tile('MED').querySelector('[data-glyph="p3"]')).not.toBeNull();
    expect(tile('UNACK').querySelector('[data-glyph]')).toBeNull();
  });

  it('draws the tile glyphs at the tile size, larger than the workspace menu’s', () => {
    renderStrip();

    const classes = (code: string, priority: string): string[] =>
      (tile(code).querySelector(`[data-glyph="${priority}"]`)?.getAttribute('class') ?? '').split(
        /\s+/,
      );
    expect(classes('CRIT', 'p1')).toContain('size-3.5');
    expect(classes('HIGH', 'p2')).toEqual(expect.arrayContaining(['h-3.5', 'w-4']));
    expect(classes('MED', 'p3')).toEqual(expect.arrayContaining(['size-2.5', 'border-[1.5px]']));
  });

  it('blinks the CRIT glyph while a P1 alarm awaits acknowledgement, only when motion is allowed', () => {
    renderStrip({ unacknowledgedP1: 1 });

    const glyph = tile('CRIT').querySelector('[data-glyph="p1"]');
    const classes = (glyph?.getAttribute('class') ?? '').split(/\s+/);
    expect(classes).toContain('motion-safe:animate-sd-blink');
    // No unconditional animation: prefers-reduced-motion leaves the square still.
    expect(classes.filter((name) => name.startsWith('animate-'))).toEqual([]);
    expect(tile('HIGH').querySelector('[data-glyph="p2"]')?.getAttribute('class')).not.toContain(
      'animate-sd-blink',
    );
  });

  it('keeps the CRIT glyph still when CRIT holds no alarm', () => {
    renderStrip({ counts: { ...COUNTS, p1: 0 }, unacknowledgedP1: 0 });

    expect(tile('CRIT').querySelector('[data-glyph="p1"]')?.getAttribute('class')).not.toContain(
      'animate-sd-blink',
    );
  });

  // WCAG 2.2.2: a flash that never ends needs a way to stop it. ISA-18.2
  // flashes an alarm until it is acknowledged, so acknowledging every P1
  // alarm (in the list the tile opens) stops it; the tile stays lit.
  it('stops blinking once every P1 alarm is acknowledged, the tile still lit', () => {
    renderStrip({ unacknowledgedP1: 0 });

    expect(tile('CRIT')).toHaveAttribute('data-tone', 'crit');
    expect(tile('CRIT').querySelector('[data-glyph="p1"]')?.getAttribute('class')).not.toContain(
      'animate-sd-blink',
    );
  });

  it('does not blink on an unacknowledged count it cannot trust', () => {
    renderStrip({ status: 'loading', unacknowledgedP1: 3 });
    expect(tile('CRIT').querySelector('[data-glyph="p1"]')?.getAttribute('class')).not.toContain(
      'animate-sd-blink',
    );
  });

  it('lays the tiles in four columns, two when the page container is 820px or narrower', () => {
    renderStrip();

    const region = screen.getByRole('region', { name: 'Alarm summary' });
    expect(region.className).toContain('grid-cols-4');
    // Tailwind's @max-[821px] is `width < 821px`: 820px included, as README §7.5 says.
    expect(region.className).toContain('@max-[821px]/page:grid-cols-2');
  });
});

describe('Annunciator — filter', () => {
  it('presses the tile of the active filter only', () => {
    renderStrip({ activePriority: 'p2' });

    expect(tile('HIGH')).toHaveAttribute('aria-pressed', 'true');
    for (const code of ['CRIT', 'MED', 'UNACK']) {
      expect(tile(code)).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('marks the pressed tile with a foot bar that holds 3:1 on its fill', () => {
    renderStrip({ activePriority: 'p1' });

    const bar = tile('CRIT').querySelector('span.absolute');
    // On the red fill the bar takes the tile's white text; accent-900 is 2.3:1 there.
    expect(bar?.getAttribute('class')).toContain('bg-current');
    expect(tile('HIGH').querySelector('span.absolute')).toBeNull();
  });

  it('draws the accent foot bar on a surface tile', () => {
    renderStrip({ activePriority: 'unack' });

    expect(tile('UNACK').querySelector('span.absolute')?.getAttribute('class')).toContain(
      'bg-sd-accent-900',
    );
  });

  it('selects a tile, and clears the filter when its own tile is pressed again', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderStrip({ activePriority: 'p1' });

    await user.click(tile('UNACK'));
    expect(onSelect).toHaveBeenLastCalledWith('unack');

    await user.click(tile('CRIT'));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('works from the keyboard: Tab reaches the tiles in order, Enter and Space press them', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderStrip();

    await user.tab();
    expect(tile('CRIT')).toHaveFocus();
    await user.tab();
    expect(tile('HIGH')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith('p2');
    await user.tab();
    await user.keyboard(' ');
    expect(onSelect).toHaveBeenLastCalledWith('p3');
  });

  it('still navigates while the counts are not known', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderStrip({
      status: 'error',
      counts: { p1: null, p2: null, p3: null, unack: null },
    });

    await user.click(tile('CRIT'));
    expect(onSelect).toHaveBeenLastCalledWith('p1');
  });
});

describe('Annunciator — loading and error', () => {
  const NO_COUNTS = { p1: null, p2: null, p3: null, unack: null } as const;

  it('shows "—" on grey tiles while loading and marks the strip busy', () => {
    renderStrip({ status: 'loading', counts: NO_COUNTS });

    const region = screen.getByRole('region', { name: 'Alarm summary' });
    expect(region).toHaveAttribute('aria-busy', 'true');
    for (const button of tiles()) {
      expect(text(button).startsWith('—')).toBe(true);
      expect(button).toHaveAttribute('data-tone', 'idle');
      expect(button).not.toHaveAttribute('title');
    }
    expect(tile('CRIT')).toHaveAccessibleName('CRIT Critical loading');
  });

  it('greys every tile on a failed query and gives the reason in its title', () => {
    renderStrip({ status: 'error', counts: NO_COUNTS });

    const region = screen.getByRole('region', { name: 'Alarm summary' });
    expect(region).not.toHaveAttribute('aria-busy');
    for (const button of tiles()) {
      expect(text(button).startsWith('—')).toBe(true);
      expect(button).toHaveAttribute('data-tone', 'idle');
      expect(button).toHaveAttribute('title', 'Alarm counts could not be loaded.');
    }
    expect(tile('CRIT')).toHaveAccessibleName('CRIT Critical count unavailable');
    // A stale or absent count never lights a tile, so the CRIT square stays still.
    expect(tile('CRIT').querySelector('[data-glyph="p1"]')?.getAttribute('class')).not.toContain(
      'animate-sd-blink',
    );
  });
});

describe('Annunciator — Turkish', () => {
  it('speaks the user language', () => {
    render(
      <I18nProvider locale="tr">
        <Annunciator
          status="ready"
          counts={COUNTS}
          unacknowledgedP1={1}
          activePriority={null}
          onSelect={vi.fn()}
        />
      </I18nProvider>,
    );

    const region = screen.getByRole('region', { name: 'Alarm özeti' });
    expect(within(region).getAllByRole('button').map(text)).toEqual([
      '2 KRİT Kritik',
      '3 YÜKS Yüksek',
      '2 ORTA Orta',
      '5 ONAYSIZ Onay bekliyor',
    ]);
  });
});
