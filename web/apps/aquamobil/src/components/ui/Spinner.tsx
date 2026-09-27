/**
 * Spinner — AquaMobil's one loading indicator.
 *
 * WHY a copy of shared-ui's Spinner: the PWA does not import
 * `@aquaculture/shared-ui` (own lockfile, offline-first), so its primitives
 * live under components/ui/ with the web design system's API: `size`,
 * `color`, `block`, `text`. `color="inherit"` takes the surrounding text colour
 * (a button label); `primary` is the ocean brand blue. The arc is the same
 * path shared-ui draws, so both products spin the same shape. Every other
 * spinner in the app is a hand-rolled ring or a spun icon, and
 * tests/invariants/web-design-system-ratchet.spec.ts keeps that count at zero.
 */
import type { ReactElement } from 'react';

export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** `inherit` takes the surrounding text colour (a button label) */
  color?: 'primary' | 'white' | 'gray' | 'inherit';
  /** Fill the row and centre — the loading block's only content */
  block?: boolean;
  text?: string;
  /** Screen-reader-only name when there is no visible text */
  label?: string;
  className?: string;
}

const SIZE = {
  sm: 'h-4 w-4',
  md: 'h-6 w-6',
  lg: 'h-8 w-8',
  xl: 'h-12 w-12',
} as const;

const COLOR = {
  primary: 'text-ocean-600',
  white: 'text-white',
  gray: 'text-gray-500 dark:text-gray-400',
  inherit: 'text-current',
} as const;

export function Spinner({
  size = 'md',
  color = 'primary',
  block = false,
  text,
  label,
  className = '',
}: SpinnerProps): ReactElement {
  return (
    <span className={`${block ? 'flex justify-center' : 'inline-flex'} items-center ${className}`}>
      <svg
        className={`animate-spin ${SIZE[size]} ${COLOR[color]}`}
        fill="none"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
      {text && <span className="ml-2 text-sm text-gray-600 dark:text-gray-300">{text}</span>}
      {!text && label && <span className="sr-only">{label}</span>}
    </span>
  );
}
