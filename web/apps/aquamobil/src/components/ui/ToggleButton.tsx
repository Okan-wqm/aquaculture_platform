/**
 * ToggleButton — AquaMobil's counterpart to the shared-ui primitive of the same
 * name (FE-HIGH-159).
 *
 * AquaMobil is a standalone PWA and deliberately does not federate shared-ui, so
 * the rule it enforces lives here too: `pressed` is required and drives both the
 * class that paints the selection and the `aria-pressed` that announces it.
 * Thirty-three of the app's buttons — the storage location rows, the movement
 * wizard's type pickers, the filter chips — painted a selection nothing said out
 * loud.
 *
 * Children stay arbitrary: the phone surfaces are tall cards with icons and two
 * lines of text, not pills, and a primitive that imposed markup would have gone
 * unused.
 */

import { clsx } from 'clsx';
import { forwardRef, ButtonHTMLAttributes } from 'react';

export interface ToggleButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Seçili mi — hem `aria-pressed` hem de uygulanan sınıf bundan türer */
  pressed: boolean;
  /** Her iki durumda da uygulanan taban sınıflar */
  className?: string;
  /** Yalnızca seçiliyken uygulanan sınıflar */
  pressedClassName?: string;
  /** Yalnızca seçili değilken uygulanan sınıflar */
  idleClassName?: string;
  /** `onClick` yerine sıradaki durumu doğrudan alan kısayol */
  onPressedChange?: (next: boolean) => void;
}

export const ToggleButton = forwardRef<HTMLButtonElement, ToggleButtonProps>(
  (
    {
      pressed,
      className,
      pressedClassName,
      idleClassName,
      onPressedChange,
      onClick,
      type = 'button',
      children,
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      aria-pressed={pressed}
      className={clsx(className, pressed ? pressedClassName : idleClassName)}
      onClick={(event) => {
        onClick?.(event);
        onPressedChange?.(!pressed);
      }}
      {...props}
    >
      {children}
    </button>
  ),
);

ToggleButton.displayName = 'ToggleButton';
