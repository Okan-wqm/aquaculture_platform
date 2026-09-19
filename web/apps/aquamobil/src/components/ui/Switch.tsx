/**
 * Switch — an on/off control with switch semantics and the touch floor.
 *
 * WHY: the same control was spelled three ways (a hand-rolled translating
 * knob with no role, a raw checkbox, Konsta's Toggle never imported), one of
 * them silent to assistive technology. `role="switch"` + `aria-checked` on a
 * 44 px hit area, named by its label.
 */
import { clsx } from 'clsx';
import { useId, type ReactNode } from 'react';

export type SwitchTone = 'ocean' | 'sea' | 'violet';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  /** Keep the label for assistive technology only (the row already shows it) */
  hideLabel?: boolean;
  description?: ReactNode;
  disabled?: boolean;
  tone?: SwitchTone;
  className?: string;
}

const ON: Record<SwitchTone, string> = { ocean: 'bg-ocean-500', sea: 'bg-sea-600', violet: 'bg-violet-500' };

export function Switch({ checked, onChange, label, hideLabel = false, description, disabled = false, tone = 'ocean', className }: SwitchProps): ReactNode {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  const control = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={description ? descriptionId : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex min-h-touch min-w-touch flex-shrink-0 items-center justify-center rounded-full touch-feedback',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ocean-500',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      <span className={clsx('relative block h-7 w-12 rounded-full transition-colors duration-200', checked ? ON[tone] : 'bg-gray-200 dark:bg-gray-700')}>
        <span
          className={clsx(
            'absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow-sm transition-transform duration-200 dark:bg-gray-900',
            checked && 'translate-x-5',
          )}
        />
      </span>
    </button>
  );
  return (
    <div className={clsx('flex items-center justify-between gap-3', className)}>
      <span className={clsx(hideLabel && 'sr-only')}>
        <span id={labelId} className="block text-sm font-medium text-gray-900 dark:text-white">
          {label}
        </span>
        {description && (
          <span id={descriptionId} className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
            {description}
          </span>
        )}
      </span>
      {hideLabel && <span id={labelId} className="sr-only">{label}</span>}
      {control}
    </div>
  );
}
