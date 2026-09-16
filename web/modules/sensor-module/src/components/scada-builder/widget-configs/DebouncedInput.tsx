/**
 * DebouncedInput — properties-panel text/number input with ~250ms debounce.
 *
 * The properties panel writes every keystroke through updateWidget; the
 * history layer additionally merges WIDGET_UPDATE entries within a 300ms
 * window. That merge window must not be load-bearing for typing feel, so
 * the INPUT itself debounces (~250ms) while keeping a fully controlled UX:
 *  - local state echoes the user's typing immediately;
 *  - external prop changes (undo/redo, canvas edits) re-sync local state;
 *  - the onChange commit fires once, 250ms after the last keystroke, with
 *    the latest value (trailing edge).
 */

import React, { useEffect, useRef, useState } from 'react';

const INPUT_CLASS =
  'w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500';

const LABEL_CLASS = 'block text-[11px] text-gray-600 mb-0.5 uppercase tracking-wide';

export const DEBOUNCE_MS = 250;

interface DebouncedInputProps {
  label: string;
  value: string | number;
  type?: 'text' | 'number';
  onCommit: (value: string) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  /** Debounce delay (defaults to 250ms). */
  delayMs?: number;
  /** Test hook selector. */
  testId?: string;
  /** Input element id (a11y). */
  inputId?: string;
  placeholder?: string;
}

export const DebouncedInput: React.FC<DebouncedInputProps> = ({
  label,
  value,
  type = 'text',
  onCommit,
  min,
  max,
  disabled = false,
  delayMs = DEBOUNCE_MS,
  testId,
  inputId,
  placeholder,
}) => {
  const [localValue, setLocalValue] = useState<string>(String(value));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-sync when the external (store) value changes and differs from the
  // pending local edit — undo/redo and canvas edits must be reflected.
  useEffect(() => {
    setLocalValue(String(value));
  }, [value]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    setLocalValue(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onCommit(next);
    }, delayMs);
  };

  return (
    <div>
      <label htmlFor={inputId} className={LABEL_CLASS}>{label}</label>
      <input
        id={inputId}
        type={type}
        value={localValue}
        onChange={handleChange}
        onBlur={() => {
          // Flush pending edits immediately when the field loses focus
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
            onCommit(String(localValue));
          }
        }}
        min={min}
        max={max}
        disabled={disabled}
        placeholder={placeholder}
        className={INPUT_CLASS}
        aria-label={label}
        data-testid={testId}
      />
    </div>
  );
};

export default DebouncedInput;
