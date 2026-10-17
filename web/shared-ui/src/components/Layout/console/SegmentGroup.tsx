/**
 * SegmentGroup — the user menu's segmented choice (language, theme), README
 * §7.4: equal cells in a 1px rule frame, condensed labels, the chosen one on
 * the accent-100 fill with accent-900 text (decision D7 — the prototype's
 * solid accent with ground-colour text is 3.7:1 in Drawing) and a 3px accent
 * bar along its foot. The bar is the state cue (WCAG 1.4.11, 1.4.1): the
 * fill is 1.03–1.14:1 against the paper and accent-900 against the other
 * cells' ink at most 1.29:1, while the accent bar holds 3:1 on the fill in
 * both themes and every workspace (web-theme-token-parity.spec.ts).
 *
 * WHY toggle buttons: each option is a `button` with `aria-pressed` in a
 * labelled group, the pattern the design names, reachable with Tab and Space
 * / Enter. Pressing the chosen option again does nothing, so a choice that
 * saves (the language goes to the account) is not saved twice.
 */
import type { ReactElement } from 'react';

export interface SegmentOption<V extends string> {
  readonly value: V;
  readonly label: string;
}

export interface SegmentGroupProps<V extends string> {
  /** The id of the visible label that names the group. */
  readonly labelledBy: string;
  readonly options: readonly SegmentOption<V>[];
  readonly value: V;
  readonly onChange: (value: V) => void;
}

export function SegmentGroup<V extends string>({
  labelledBy,
  options,
  value,
  onChange,
}: SegmentGroupProps<V>): ReactElement {
  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      className="grid auto-cols-fr grid-flow-col border border-sd-rule"
    >
      {options.map((option, index) => {
        const chosen = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={chosen}
            onClick={() => {
              if (!chosen) onChange(option.value);
            }}
            className={`min-h-[42px] px-2 font-display-sd text-[15px] font-semibold focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sd-accent ${
              index > 0 ? 'border-l border-sd-rule' : ''
            } ${
              chosen
                ? 'bg-sd-accent-100 text-sd-accent-900 shadow-[inset_0_-3px_0_var(--color-sd-accent)]'
                : 'bg-transparent text-sd-ink hover:bg-sd-neutral-200'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
