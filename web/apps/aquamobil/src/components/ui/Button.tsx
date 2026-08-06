/**
 * Button — the app's only text-button primitive.
 *
 * WHY this exists: before v4 there was no shared button. Every screen wrote a
 * raw `<button>` with an inline gradient class string, so the same action looked
 * different on two pages and no change could be made in one place. Worse, each
 * one re-decided its own height, which is how sub-floor tap targets got in.
 *
 * Heights come from the density tokens (src/styles/tokens.css), so the Gloves
 * switch in Account grows every button in the app at once. `min-h-touch` is
 * still applied underneath: the density scale can raise a control above the 44px
 * accessibility floor but never below it.
 */
import { clsx } from 'clsx';
import { type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * `primary` — the accent action. One per screen; the teal is what the eye
   *   goes to, so a second one costs the first its meaning.
   * `secondary` — a real but not-the-point action, on a raised surface.
   * `ghost` — low-emphasis, no surface until pressed.
   * `danger` — destructive. Coral is the alarm colour, so this reads as one.
   */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** `save` is the sheet's full-width commit height; `default` is everything else. */
  size?: 'default' | 'save';
  /** Stretch to the container. Sheet CTAs and dialog actions do. */
  block?: boolean;
  children: ReactNode;
}

const VARIANT_CLASS: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'bg-acc text-acc-on shadow-acc',
  secondary: 'bg-surface-2 text-ink-1',
  ghost: 'bg-transparent text-ink-2 active:bg-surface-2',
  danger: 'bg-crit text-white',
};

const SIZE_CLASS: Record<NonNullable<ButtonProps['size']>, string> = {
  default: 'h-tap-add px-4 rounded-2xl text-title',
  save: 'h-tap-save px-5 rounded-2xl text-title',
};

export function Button({
  variant = 'secondary',
  size = 'default',
  block = false,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps): ReactElement {
  return (
    <button
      type={type}
      className={twMerge(
        clsx(
          'inline-flex items-center justify-center gap-2 font-semibold',
          // The floor holds even if a density token were ever set too low.
          'min-h-touch touch-feedback',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc',
          'disabled:opacity-50 disabled:pointer-events-none',
          VARIANT_CLASS[variant],
          SIZE_CLASS[size],
          block && 'w-full',
        ),
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
