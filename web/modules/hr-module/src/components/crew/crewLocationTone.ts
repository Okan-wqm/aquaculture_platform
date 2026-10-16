/**
 * Crew location tones — the one colour and name source for the offshore /
 * onshore / in-transit / on-leave series (SeaLandSplitView's split bar,
 * legend and sections; the offshore-rotation calendar and its legend).
 *
 * WHY its own module: the series was spelled in info / success / amber at each
 * call site. Under the Industry console info and success resolve to the same
 * gray, so offshore and onshore drew as one colour, and amber marked crew in
 * transit as a risk, which Industry reserves amber for (README §7.8).
 *
 * WHY lightness and not hue: the console paints primary in the workspace
 * accent, and the Company workspace — where the crew pages live — has a
 * near-neutral slate accent, so "accent for at a post, graphite for away"
 * collapsed there (offshore beside in transit, onshore beside on leave, at
 * 1.0–1.15:1). Each location therefore takes its own lightness step, chosen
 * per theme: every pair of fills, and each fill against the card, stays at
 * least 1.4:1 apart in all four workspaces and both themes, and the mark on a
 * fill holds 4.5:1. tests/invariants/web-console-series-contrast.spec.ts
 * resolves these classes through theme.css and suderra.css and holds them to
 * that. The bar also names each segment (`label`), so the series is never
 * told apart by colour alone.
 *
 * WHY MessageKey from its declaring module: that invariant imports this file
 * under a jsx-less project, and the `@aquaculture/shared-ui` barrel would pull
 * every TSX component in with it (see web/shell/src/console/nav/types.ts).
 */
import type { MessageKey } from '@platform/shared-ui/i18n/locales/en';

export const CREW_LOCATIONS = ['offshore', 'onshore', 'transit', 'leave'] as const;
export type CrewLocation = (typeof CREW_LOCATIONS)[number];

export interface CrewLocationTone {
  /** The location's name: legend, segment name, calendar entry. */
  label: MessageKey;
  /** Solid fill: split-bar segment, legend swatch, section icon tile, calendar entry. */
  fill: string;
  /** Icon or text drawn on `fill` (4.5:1 in both themes). */
  onFill: string;
  /** Icon on the card ground beside a count (3:1). */
  icon: string;
  /** Section background behind the location's crew list. */
  tint: string;
}

export const CREW_LOCATION_TONE: Readonly<Record<CrewLocation, CrewLocationTone>> = {
  offshore: {
    label: 'hr.crew.location.offshore',
    fill: 'bg-primary-800 dark:bg-primary-100',
    onFill: 'text-white dark:text-gray-900',
    icon: 'text-primary-800 dark:text-primary-100',
    tint: 'bg-primary-50 dark:bg-primary-900/20',
  },
  onshore: {
    label: 'hr.crew.location.onshore',
    fill: 'bg-primary-400 dark:bg-primary-600',
    onFill: 'text-gray-900 dark:text-white',
    icon: 'text-primary-500',
    tint: 'bg-primary-50 dark:bg-primary-900/20',
  },
  transit: {
    label: 'hr.crew.location.transit',
    fill: 'bg-gray-900 dark:bg-gray-300',
    onFill: 'text-white dark:text-gray-900',
    icon: 'text-gray-900 dark:text-gray-300',
    tint: 'bg-gray-50 dark:bg-gray-900/20',
  },
  leave: {
    label: 'hr.crew.location.leave',
    fill: 'bg-gray-400 dark:bg-gray-500',
    onFill: 'text-white dark:text-gray-900',
    icon: 'text-gray-400 dark:text-gray-500',
    tint: 'bg-gray-50 dark:bg-gray-900/20',
  },
};
