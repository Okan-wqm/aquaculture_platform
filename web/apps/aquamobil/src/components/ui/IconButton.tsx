/**
 * IconButton — the touch-floor-compliant tap-target primitive (MOB-MEDIUM-009).
 *
 * AquaMobil is operated outdoors, with gloves, in sunlight. Every interactive
 * tap target must clear the 44px floor (the Tailwind `touch` = 2.75rem token).
 * This primitive BAKES the floor in — `min-h-touch min-w-touch` plus centering,
 * the shared `touch-feedback` affordance and a visible focus ring — so callers
 * get a correct target for free instead of hand-rolling `min-w-[44px]` on each
 * `<button>` (and occasionally getting it wrong, as the 28px VoicePlayer speed
 * toggle did). Prefer this over a raw `<button>` for any icon-only or compact
 * tap target. `aria-label` is required — an icon-only control must announce
 * itself to assistive tech.
 *
 * The field-ergonomics invariant (src/__tests__/field-ergonomics.invariant.spec.ts)
 * both asserts this primitive keeps the floor and bans any `touch-feedback`
 * element from declaring a sub-44px `min-h`/`min-w` — so the floor cannot regress.
 */
import { clsx } from 'clsx';
import { type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon-only / compact control must announce itself. */
  'aria-label': string;
  /** `md` = the 44px floor (default); `lg` = 48px for primary/high-traffic actions. */
  size?: 'md' | 'lg';
  children: ReactNode;
}

const SIZE_CLASS: Record<NonNullable<IconButtonProps['size']>, string> = {
  md: 'min-h-touch min-w-touch',
  lg: 'min-h-[3rem] min-w-[3rem]',
};

export function IconButton({
  size = 'md',
  className,
  type = 'button',
  children,
  ...rest
}: IconButtonProps): ReactElement {
  return (
    <button
      type={type}
      className={twMerge(
        clsx(
          SIZE_CLASS[size],
          'inline-flex items-center justify-center rounded-full touch-feedback',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ocean-500',
          'disabled:opacity-50 disabled:pointer-events-none',
        ),
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
