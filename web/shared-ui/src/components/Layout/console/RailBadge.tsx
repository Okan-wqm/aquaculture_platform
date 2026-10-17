/**
 * RailBadge — the square count on a rail row or tile (digest §9).
 *
 * WHAT: the number, square, neutral-300 under the ink (badges take no alarm
 * colour, README §7.8); 22 px on an expanded row, 20 px pinned to the corner
 * of a collapsed tile. The bare number is visual; assistive technology hears
 * what it counts ("5 awaiting action").
 *
 * The caller draws a badge only for a count above zero that came from data.
 */
import type { ReactElement } from 'react';

import { useI18n } from '../../../i18n';

export interface RailBadgeProps {
  readonly count: number;
  readonly placement: 'row' | 'tile';
}

const PLACEMENT: Readonly<Record<RailBadgeProps['placement'], string>> = {
  row: 'h-[22px] min-w-[22px] px-1.5 text-[12.5px]',
  tile: 'absolute right-4 top-2 h-5 min-w-5 px-[5px] text-xs',
};

export function RailBadge({ count, placement }: RailBadgeProps): ReactElement {
  const { t } = useI18n();
  return (
    <span
      className={`grid shrink-0 place-items-center bg-sd-neutral-300 font-bold leading-none text-sd-ink tabular-nums ${PLACEMENT[placement]}`}
    >
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{t('console.rail.badge', { count })}</span>
    </span>
  );
}
