/**
 * AnnunciatorGlyph — the priority mark on an annunciator tile: P1 a filled
 * square ■, P2 a filled triangle ▲, P3 an outlined diamond ◇ (README §7.5).
 *
 * WHY shapes, not the Unicode characters: the three characters come from
 * whatever font has them, at three different sizes and baselines; a square, a
 * clipped square and a rotated outline are the same on every platform. The
 * glyph is decorative (the tile's code says the priority in words), so it is
 * hidden from assistive technology.
 *
 * WHAT: `tone` picks the paint — `lit` takes the tile's text colour (white on
 * the red CRIT tile, ink on the amber HIGH tile), `hazard` the hazard colour
 * on a surface tile (amber glyphs take amber-ink, the amber that holds 3:1 on
 * paper in both themes), `muted` the grey tile's text at half strength.
 * `blink` flashes the mark at 1 Hz, only under prefers-reduced-motion:
 * no-preference.
 *
 * WHY the flash is kept (WCAG 2.2.2, decided 2026-10-16): it is the alarm
 * system's call for attention — ISA-18.2 / ISA-101 flash an alarm until an
 * operator acknowledges it, and steady it after — so it is essential while
 * a critical alarm waits. It is also stoppable: the Annunciator flashes CRIT
 * only while a P1 alarm is unacknowledged, and acknowledging them in the
 * alarm list (the tile opens it) stops it; a reader who asked for reduced
 * motion never sees it. An acknowledged P1 keeps the tile lit, not flashing.
 *
 * `size` picks the drawing: `tile` on an annunciator tile,
 * `inline` beside a count in running text — the workspace menu's alarm pairs,
 * drawn as the design's `glyph(p, 12)`: a 12 px square, a 15×12 triangle, a
 * 9 px diamond with a 2 px border and 3 px either side.
 */
import type { ReactElement } from 'react';

import type { AlarmPriority } from './AnnunciatorPriority';

export type AnnunciatorGlyphTone = 'lit' | 'hazard' | 'muted';
export type AnnunciatorGlyphSize = 'tile' | 'inline';

export interface AnnunciatorGlyphProps {
  readonly priority: AlarmPriority;
  readonly tone: AnnunciatorGlyphTone;
  /** `tile` (default) on an annunciator tile; `inline` beside a count in a menu row. */
  readonly size?: AnnunciatorGlyphSize;
  readonly blink?: boolean;
}

const TRIANGLE = '[clip-path:polygon(50%_0,100%_100%,0_100%)]';

const SHAPE: Readonly<Record<AnnunciatorGlyphSize, Readonly<Record<AlarmPriority, string>>>> = {
  tile: {
    p1: 'size-3.5',
    p2: `h-3.5 w-4 ${TRIANGLE}`,
    p3: 'mx-0.5 size-2.5 rotate-45 border-[1.5px]',
  },
  inline: {
    p1: 'size-3',
    p2: `h-3 w-[15px] ${TRIANGLE}`,
    p3: 'mx-[3px] size-[9px] rotate-45 border-2',
  },
};

/** The filled shapes paint their background; the P3 outline paints its border. */
const PAINT: Readonly<Record<AlarmPriority, Readonly<Record<AnnunciatorGlyphTone, string>>>> = {
  p1: { lit: 'bg-current', hazard: 'bg-sd-hz-red', muted: 'bg-current opacity-50' },
  p2: { lit: 'bg-current', hazard: 'bg-sd-hz-amber-ink', muted: 'bg-current opacity-50' },
  p3: {
    lit: 'border-current',
    hazard: 'border-sd-hz-amber-ink',
    muted: 'border-current opacity-50',
  },
};

export function AnnunciatorGlyph({
  priority,
  tone,
  size = 'tile',
  blink = false,
}: AnnunciatorGlyphProps): ReactElement {
  const motion = blink ? ' motion-safe:animate-sd-blink' : '';
  return (
    <span
      aria-hidden="true"
      data-glyph={priority}
      className={`inline-block shrink-0 ${SHAPE[size][priority]} ${PAINT[priority][tone]}${motion}`}
    />
  );
}
