/**
 * NumPad — the in-sheet numeric keypad.
 *
 * WHY not the OS keyboard: on a phone held in one gloved hand at a pen edge, the
 * system numeric keyboard covers the sheet it is typing into, and its keys are
 * sized for thumbs without gloves. This pad sits inside the sheet's own scroll,
 * so the value, the unit, the stock line and the keys are all visible at once —
 * the worker can see the effect of what they are typing while typing it.
 *
 * Key height comes from the density tokens, so Gloves grows the pad with
 * everything else. Values are held as strings: a decimal being typed passes
 * through states ("8", "8.", "8.0") that a number cannot represent, and parsing
 * early is how trailing-zero and lone-dot bugs get in.
 */
import { Delete } from 'lucide-react';
import { type ReactElement } from 'react';

export interface NumPadProps {
  /** Current raw entry, e.g. "12.5" or "" for empty. */
  value: string;
  onChange: (next: string) => void;
  /** Whole-number fields (fish counts) hide the decimal key. */
  allowDecimal?: boolean;
  /** Guard against a fat-fingered 9-digit count; the sheet passes a sane cap. */
  maxLength?: number;
}

export function NumPad({
  value,
  onChange,
  allowDecimal = true,
  maxLength = 9,
}: NumPadProps): ReactElement {
  const press = (key: string): void => {
    if (key === 'del') {
      onChange(value.slice(0, -1));
      return;
    }
    if (key === '.') {
      // One decimal point, and never as the leading character.
      if (!allowDecimal || value.includes('.') || value === '') return;
      onChange(`${value}.`);
      return;
    }
    // Reject a second leading zero ("007") but keep "0." reachable.
    if (value === '0') {
      onChange(key);
      return;
    }
    if (value.replace('.', '').length >= maxLength) return;
    onChange(value + key);
  };

  const keys: Array<{ label: ReactElement | string; key: string; aria: string }> = [
    ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => ({
      label: d,
      key: d,
      aria: d,
    })),
    allowDecimal
      ? { label: '.', key: '.', aria: 'decimal point' }
      : { label: '', key: 'noop', aria: '' },
    { label: '0', key: '0', aria: '0' },
    { label: <Delete size={19} aria-hidden />, key: 'del', aria: 'delete' },
  ];

  return (
    <div className="grid grid-cols-3 gap-1" role="group" aria-label="Number pad">
      {keys.map((k, i) =>
        k.key === 'noop' ? (
          <span key={i} aria-hidden />
        ) : (
          <button
            key={i}
            type="button"
            onClick={() => press(k.key)}
            aria-label={k.aria}
            className="h-tap-key min-h-touch rounded-xl bg-surface-2 text-head font-mono font-semibold text-ink-1 inline-flex items-center justify-center touch-feedback active:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc"
          >
            {k.label}
          </button>
        ),
      )}
    </div>
  );
}
