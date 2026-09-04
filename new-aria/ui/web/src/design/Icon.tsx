import type { ReactNode } from 'react';

/**
 * The console's entire icon vocabulary — twelve inline glyphs, no icon package.
 *
 * WHY: an icon font or package would add a dependency and a network request for
 * decoration this product does not need. Icons here only mark a repeated action
 * (search, refresh, copy, sign out), a direction (chevrons, arrow) or a section
 * (core, legal); state is carried by colour and words, never by a glyph alone.
 * WHAT: one 16px stroke-based grid, drawn with currentColor so a glyph inherits
 * the tone of the text or button it sits in.
 */
export type IconName =
  | 'menu'
  | 'search'
  | 'refresh'
  | 'copy'
  | 'check'
  | 'alert'
  | 'chevron-down'
  | 'chevron-up'
  | 'arrow-right'
  | 'sign-out'
  | 'core'
  | 'legal';

export interface IconProps {
  readonly name: IconName;
  /** Edge length in px. 14 inside dense table cells, 16 default, 18 in the sidebar. */
  readonly size?: number | undefined;
  /**
   * Accessible name. Omit for decoration next to a text label (the glyph is then
   * hidden from assistive technology); supply it when the icon is the only label.
   */
  readonly title?: string | undefined;
  readonly className?: string | undefined;
}

const PATHS: Readonly<Record<IconName, ReadonlyArray<string>>> = {
  menu: ['M2.5 4.5h11', 'M2.5 8h11', 'M2.5 11.5h11'],
  search: ['M7.25 12a4.75 4.75 0 1 0 0-9.5 4.75 4.75 0 0 0 0 9.5Z', 'M10.75 10.75 13.5 13.5'],
  refresh: ['M13.5 8a5.5 5.5 0 1 1-1.86-4.12', 'M13.5 2.5V6H10'],
  copy: ['M6 6h6.5v6.5H6z', 'M3.5 10V3.5H10'],
  check: ['M3 8.5 6.5 12 13 4.5'],
  alert: ['M8 2.5 14.5 13.5h-13L8 2.5Z', 'M8 6.5v3.25', 'M8 11.75v.01'],
  'chevron-down': ['M4 6.5 8 10.5l4-4'],
  'chevron-up': ['M4 9.5 8 5.5l4 4'],
  'arrow-right': ['M3 8h10', 'M9 4l4 4-4 4'],
  'sign-out': ['M9.5 3.5H4a.5.5 0 0 0-.5.5v8a.5.5 0 0 0 .5.5h5.5', 'M11 5.5 13.5 8 11 10.5', 'M13.5 8H7'],
  core: ['M2.5 2.5h4.5v4.5H2.5z', 'M9 2.5h4.5v4.5H9z', 'M2.5 9h4.5v4.5H2.5z', 'M9 9h4.5v4.5H9z'],
  legal: ['M8 2.5v11', 'M3.5 5.5h9', 'M3.5 5.5 1.5 10h4l-2-4.5Z', 'M12.5 5.5 10.5 10h4l-2-4.5Z'],
};

export function Icon({ name, size = 16, title, className }: IconProps): ReactNode {
  const decorative = title === undefined;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={decorative ? true : undefined}
      role={decorative ? undefined : 'img'}
      aria-label={title}
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
