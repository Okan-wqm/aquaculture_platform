/**
 * RailAreaTiles — the collapsed rail's icon column (README §7.2, digest §4).
 *
 * WHAT: one tile per area — its 24 px icon, its summed badge pinned to the
 * corner, the name for assistive technology (`sr-only`) and as the tooltip.
 * The tile holding the current page takes the accent fill and inset bar. A
 * tile expands the rail onto its area: the reader asked for that area's
 * pages, and the collapsed column has no room to list them. The expand
 * control returns to the labelled rail.
 */
import { PanelLeftOpen } from 'lucide-react';
import type { ReactElement } from 'react';

import { useI18n } from '../../../i18n';

import { areaBadge } from './railBadges';
import { RailBadge } from './RailBadge';
import { CONSOLE_RAIL_ICONS } from './railIcons';
import type { RailActive, RailArea, RailBadgeCounts } from './railTypes';

export interface RailAreaTilesProps {
  readonly areas: readonly RailArea[];
  readonly active: RailActive | undefined;
  readonly badgeCounts: RailBadgeCounts;
  /** A tile was chosen: expand the rail onto this area. */
  readonly onExpandArea: (areaId: string) => void;
  readonly onExpand: () => void;
}

const TILE_FOCUS =
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sd-accent';

export function RailAreaTiles({
  areas,
  active,
  badgeCounts,
  onExpandArea,
  onExpand,
}: RailAreaTilesProps): ReactElement {
  const { t } = useI18n();
  return (
    <>
      <ul className="flex flex-col">
        {areas.map((area) => {
          const Icon = CONSOLE_RAIL_ICONS[area.icon];
          const holdsCurrent = active !== undefined && active.areaId === area.id;
          const badge = areaBadge(area, badgeCounts);
          return (
            <li key={area.id}>
              <button
                type="button"
                title={area.label}
                aria-current={holdsCurrent ? 'true' : undefined}
                onClick={() => onExpandArea(area.id)}
                className={`relative flex min-h-16 w-full items-center justify-center px-2 py-2.5 ${TILE_FOCUS} ${
                  holdsCurrent
                    ? 'bg-sd-accent-100 text-sd-accent-800 shadow-[inset_3px_0_0_var(--color-sd-accent)]'
                    : 'text-sd-neutral-800 hover:bg-sd-neutral-200'
                }`}
              >
                <Icon size={24} strokeWidth={1.5} aria-hidden="true" />
                <span className="sr-only">{area.label}</span>
                {badge > 0 && <RailBadge count={badge} placement="tile" />}
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        data-rail-focus="expand"
        onClick={onExpand}
        aria-label={t('sidebar.expand')}
        title={t('sidebar.expand')}
        className={`mx-auto mt-2.5 grid h-11 w-[52px] shrink-0 place-items-center border border-sd-rule text-sd-neutral-800 hover:bg-sd-neutral-200 ${TILE_FOCUS}`}
      >
        <PanelLeftOpen size={20} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </>
  );
}
