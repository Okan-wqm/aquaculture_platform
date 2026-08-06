/**
 * Chip — the small status/filter pill used across the v4 screens.
 *
 * Two jobs, deliberately in one component because they share a shape: a STATIC
 * readout ("3 alarms", "On duty") and a TAPPABLE control (a scope switch, a
 * cause picker, a unit selector). Passing `onClick` is what makes it the second
 * — which keeps a non-interactive `<span>` out of the tab order rather than
 * shipping a button that does nothing.
 *
 * Tone maps onto the semantic tokens, so a chip cannot invent a colour: teal is
 * the accent/active state, amber watches, coral alarms, green confirms.
 */
import { clsx } from 'clsx';
import { type ReactElement, type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

type ChipTone = 'neutral' | 'accent' | 'warn' | 'crit' | 'ok';

export interface ChipProps {
  tone?: ChipTone;
  /** Renders as a button. Omit for a static readout. */
  onClick?: () => void;
  /** Filled accent treatment for the selected item in a group. */
  selected?: boolean;
  /** Accessible name — required when the chip is tappable and icon-led. */
  'aria-label'?: string;
  className?: string;
  children: ReactNode;
}

const TONE_CLASS: Record<ChipTone, string> = {
  neutral: 'bg-surface-1 border-line text-ink-2',
  accent: 'bg-acc-dim border-acc text-acc',
  warn: 'bg-warn-dim border-warn text-warn',
  crit: 'bg-crit-dim border-crit text-crit',
  ok: 'bg-surface-1 border-line text-ok',
};

export function Chip({
  tone = 'neutral',
  onClick,
  selected = false,
  className,
  children,
  ...rest
}: ChipProps): ReactElement {
  const shared = twMerge(
    clsx(
      'inline-flex items-center gap-2 h-tap-pill px-3 rounded-full border',
      'text-body font-medium whitespace-nowrap',
      selected ? TONE_CLASS.accent : TONE_CLASS[tone],
    ),
    className,
  );

  if (!onClick) {
    return (
      <span className={shared} {...rest}>
        {children}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      // min-h-touch keeps the floor even though the pill height is a density token.
      className={twMerge(
        shared,
        'min-h-touch touch-feedback focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc',
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * The live status dot used inside chips and list rows. The blip animation is the
 * v4 signal for "this is a live reading, not a stored one" — it stops under
 * prefers-reduced-motion via the global rule in src/styles/main.css.
 */
export function StatusDot({
  tone = 'ok',
  live = false,
}: {
  tone?: Exclude<ChipTone, 'neutral'>;
  live?: boolean;
}): ReactElement {
  const color: Record<Exclude<ChipTone, 'neutral'>, string> = {
    accent: 'bg-acc',
    warn: 'bg-warn',
    crit: 'bg-crit',
    ok: 'bg-ok',
  };
  return (
    <span
      aria-hidden
      className={clsx('w-1.5 h-1.5 rounded-full shrink-0', color[tone], live && 'animate-am-blip')}
    />
  );
}
