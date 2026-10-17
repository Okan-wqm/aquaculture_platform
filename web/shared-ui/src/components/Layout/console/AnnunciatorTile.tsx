/**
 * AnnunciatorTile — one button of the annunciator strip (README §7.5).
 *
 * WHAT: glyph, count (34 px Condensed, tabular) and the tile's code, with the
 * long label beside the code when the page container is at least 1204 px
 * (design decision D10: the prototype's 1500 px viewport minus the open rail)
 * and for screen readers always. The tone paints the tile:
 *   crit  — hazard red, white text (P1 holds alarms); the square flashes while
 *           one of them awaits acknowledgement (`flashing`)
 *   high  — hazard amber, ink text (P2 holds alarms)
 *   med   — the surface, an amber diamond (P3 holds alarms)
 *   unack — the surface, the code in neutral-700 (alarms await acknowledgement)
 *   idle  — grey: a zero count, a count still loading, or a failed query
 *
 * WHY content, not aria-label, names the button: the visible count and code
 * are then part of the accessible name (WCAG 2.5.3), and a count that is not
 * known yet is hidden behind its "—" and spoken as the status instead. The
 * `{' '}` separators keep the spoken parts apart; the flex layout drops them
 * from the painted row.
 */
import type { ReactElement } from 'react';

import { AnnunciatorGlyph, type AnnunciatorGlyphTone } from './AnnunciatorGlyph';
import type { AlarmPriority, AnnunciatorFilter } from './AnnunciatorPriority';

export type AnnunciatorTone = 'crit' | 'high' | 'med' | 'unack' | 'idle';

export interface AnnunciatorTileProps {
  readonly id: AnnunciatorFilter;
  readonly tone: AnnunciatorTone;
  /** The real count, or null while it is not known (loading, failed query). */
  readonly count: number | null;
  readonly code: string;
  readonly label: string;
  readonly pressed: boolean;
  /** The glyph flashes: a P1 alarm awaits acknowledgement (the Annunciator decides). */
  readonly flashing?: boolean;
  /** Spoken after the label while the count is not known. */
  readonly status?: string;
  /** Why the count is missing, shown on hover (failed query). */
  readonly title?: string;
  readonly onPress: () => void;
}

const SURFACE: Readonly<Record<AnnunciatorTone, string>> = {
  crit: 'bg-sd-hz-red-deep text-sd-hz-on-red',
  high: 'bg-sd-hz-amber text-sd-hz-on-amber',
  med: 'bg-sd-parchment text-sd-ink',
  unack: 'bg-sd-parchment text-sd-ink',
  idle: 'bg-sd-neutral-200 text-sd-neutral-700',
};

/** README §7.5: on the UNACK tile the count is ink and the code neutral-700. */
const CODE_COLOUR: Readonly<Record<AnnunciatorTone, string>> = {
  crit: '',
  high: '',
  med: '',
  unack: 'text-sd-neutral-700',
  idle: '',
};

/**
 * The pressed tile's foot bar: accent-900 as the prototype draws it, except on
 * the hazard fills, where it takes the tile's text colour — light-theme
 * accent-900 is 2.3:1 on red-deep, under the 3:1 a state indicator needs.
 */
const PRESSED_BAR: Readonly<Record<AnnunciatorTone, string>> = {
  crit: 'bg-current',
  high: 'bg-current',
  med: 'bg-sd-accent-900',
  unack: 'bg-sd-accent-900',
  idle: 'bg-sd-accent-900',
};

function glyphTone(tone: AnnunciatorTone): AnnunciatorGlyphTone {
  if (tone === 'idle') return 'muted';
  return tone === 'med' ? 'hazard' : 'lit';
}

function isPriority(id: AnnunciatorFilter): id is AlarmPriority {
  return id !== 'unack';
}

export function AnnunciatorTile({
  id,
  tone,
  count,
  code,
  label,
  pressed,
  flashing = false,
  status,
  title,
  onPress,
}: AnnunciatorTileProps): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      data-tone={tone}
      onClick={onPress}
      className={`relative flex min-h-[clamp(64px,6cqi,88px)] min-w-0 items-center gap-3.5 px-[clamp(12px,2cqi,28px)] text-left hover:brightness-95 focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-current motion-safe:transition-[filter] ${SURFACE[tone]}`}
    >
      {isPriority(id) && (
        <AnnunciatorGlyph
          priority={id}
          tone={glyphTone(tone)}
          blink={flashing && tone === 'crit'}
        />
      )}{' '}
      <span
        aria-hidden={count === null ? true : undefined}
        className="min-w-9 font-display-sd text-[34px] font-semibold leading-none tabular-nums"
      >
        {count ?? '—'}
      </span>{' '}
      <span className="flex min-w-0 flex-col gap-1">
        <span
          className={`whitespace-nowrap text-[13px] font-bold leading-none tracking-[0.12em] ${CODE_COLOUR[tone]}`}
        >
          {code}
        </span>{' '}
        {/* not-sr-only resets overflow, so the ellipsis sits on an inner span. */}
        <span className="sr-only min-w-0 @min-[1204px]/page:not-sr-only">
          <span className="block truncate text-[13px] leading-tight">{label}</span>
        </span>
      </span>
      {status !== undefined && (
        <>
          {' '}
          <span className="sr-only">{status}</span>
        </>
      )}
      {pressed && (
        // The active filter: a 4 px bar along the tile's foot (the prototype's inset shadow).
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-0 bottom-0 h-1 ${PRESSED_BAR[tone]}`}
        />
      )}
    </button>
  );
}
