/**
 * TypeTile — one entry type in the log sheet's type picker.
 *
 * Each log type carries its own hue (feed teal, mortality coral, water blue,
 * cull amber, transfer violet, harvest green). That colour coding is the one
 * place v4 lets colour be decorative, because a worker recognises the type they
 * want by hue before reading a word.
 *
 * `label` is REQUIRED and always rendered. That is the point of this component
 * rather than a styled button: the palette validator reports the six type hues
 * as discriminable under deuteranopia, protanopia and tritanopia (worst adjacent
 * pair ΔE 15.7 night / 14.7 day, against a floor of 8), but discriminable is not
 * identifiable — a worker who cannot separate coral from amber must still be
 * able to tell Mort from Cull. Making the label non-optional means colour-alone
 * type identity cannot be built out of this component by accident.
 *
 * Sizing comes from the density tokens, so the picker grows under Gloves.
 */
import { clsx } from 'clsx';
import { type ReactElement, type ReactNode } from 'react';

/** The six fast log types the v4 sheet covers. */
export type LogType = 'feeding' | 'mortality' | 'water' | 'cull' | 'transfer' | 'harvest';

const TYPE_CLASS: Record<LogType, { idle: string; active: string }> = {
  feeding: {
    idle: 'text-type-feeding border-line bg-surface-1',
    active: 'text-type-feeding border-type-feeding bg-type-feeding-dim',
  },
  mortality: {
    idle: 'text-type-mortality border-line bg-surface-1',
    active: 'text-type-mortality border-type-mortality bg-type-mortality-dim',
  },
  water: {
    idle: 'text-type-water border-line bg-surface-1',
    active: 'text-type-water border-type-water bg-type-water-dim',
  },
  cull: {
    idle: 'text-type-cull border-line bg-surface-1',
    active: 'text-type-cull border-type-cull bg-type-cull-dim',
  },
  transfer: {
    idle: 'text-type-transfer border-line bg-surface-1',
    active: 'text-type-transfer border-type-transfer bg-type-transfer-dim',
  },
  harvest: {
    idle: 'text-type-harvest border-line bg-surface-1',
    active: 'text-type-harvest border-type-harvest bg-type-harvest-dim',
  },
};

export interface TypeTileProps {
  type: LogType;
  /** Short label, always shown — see the note above; this is not optional. */
  label: string;
  /** Lucide icon element, sized by the caller (17px in the sheet). */
  icon: ReactNode;
  selected: boolean;
  onSelect: () => void;
}

export function TypeTile({ type, label, icon, selected, onSelect }: TypeTileProps): ReactElement {
  const tone = TYPE_CLASS[type];
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={clsx(
        'h-tap-tile min-h-touch rounded-2xl border',
        'flex flex-col items-center justify-center gap-1.5',
        'touch-feedback focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc',
        selected ? tone.active : tone.idle,
      )}
    >
      {icon}
      <span className="text-meta font-semibold">{label}</span>
    </button>
  );
}
