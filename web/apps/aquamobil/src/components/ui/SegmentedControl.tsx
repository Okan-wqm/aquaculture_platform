/**
 * SegmentedControl — a small set of mutually exclusive options, all visible.
 *
 * Used for the report period (7/30/90), the Units/Feeders tab switch, and the
 * theme and density pickers in Account. Deliberately not a dropdown: with four
 * or fewer options on a touch screen, showing them all costs one row and saves
 * a tap plus a popover that fights the keyboard.
 *
 * Generic over the option value so callers keep their union type end to end
 * rather than widening to `string` and casting it back.
 */
import { clsx } from 'clsx';
import { type ReactElement, type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Optional leading glyph — a lucide icon element, already sized by the caller. */
  icon?: ReactNode;
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (next: T) => void;
  /** Names the group for assistive tech, e.g. "Report period". */
  label: string;
  className?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: SegmentedControlProps<T>): ReactElement {
  return (
    // WHY role=group + aria-pressed rather than a radiogroup: these are buttons
    // that act immediately, not a form field awaiting submit, and screen readers
    // announce the pressed state without the arrow-key navigation contract a
    // radiogroup promises but a horizontal strip of buttons does not implement.
    <div
      role="group"
      aria-label={label}
      className={twMerge('flex gap-0.5 p-0.5 rounded-2xl bg-surface-2', className)}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className={clsx(
              'flex-1 inline-flex items-center justify-center gap-1.5 min-h-touch px-2 rounded-xl',
              'text-meta font-semibold touch-feedback transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc',
              active ? 'bg-surface-1 text-ink-1 shadow-token' : 'text-ink-3',
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
