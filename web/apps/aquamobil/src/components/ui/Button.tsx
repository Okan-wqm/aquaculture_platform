/**
 * Button — AquaMobil's text button on the touch floor.
 *
 * WHY: 170 raw <button> elements re-derived padding, radius, focus ring and
 * disabled state by hand (IconButton covered the icon-only case). One
 * primitive carries the 44 px floor, the touch affordance, the focus ring, a
 * loading state that keeps the width, and the four intents the app uses.
 */
import { clsx } from 'clsx';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'lg';
  block?: boolean;
  loading?: boolean;
  leading?: ReactNode;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-ocean-600 text-white shadow-sm hover:bg-ocean-700 active:bg-ocean-700',
  secondary:
    'bg-white text-gray-900 border border-gray-200 hover:bg-gray-50 dark:bg-gray-900 dark:text-white dark:border-gray-700 dark:hover:bg-gray-800',
  danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700',
  ghost:
    'bg-transparent text-ocean-600 hover:bg-ocean-50 dark:text-ocean-400 dark:hover:bg-ocean-900/20',
};
const SIZE = { md: 'min-h-touch px-4 py-2.5 text-sm', lg: 'min-h-[3.25rem] px-5 py-3.5 text-base' };

export function Button({
  variant = 'primary',
  size = 'md',
  block = false,
  loading = false,
  leading,
  className,
  type = 'button',
  disabled,
  children,
  ...rest
}: ButtonProps): ReactNode {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={twMerge(
        clsx(
          'inline-flex items-center justify-center gap-2 rounded-xl font-semibold touch-feedback transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ocean-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900',
          'disabled:cursor-not-allowed disabled:opacity-50',
          VARIANT[variant],
          SIZE[size],
          block && 'w-full',
        ),
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size="sm" color="inherit" /> : leading}
      {children}
    </button>
  );
}
