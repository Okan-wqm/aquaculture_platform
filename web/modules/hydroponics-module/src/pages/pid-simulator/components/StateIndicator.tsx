/**
 * State Indicator - shows current dosing state
 */
import React, { useId } from 'react';
import { SimStateName } from '../simulation/types';

interface StateIndicatorProps {
  currentState: SimStateName;
}

/**
 * WHAT: each controller state's idle chip (`bg` + `text`) and lit chip
 * (`active`, fill and ink together).
 * WHY the fill and ink are one string: the tenant console re-maps warning to
 * the hazard amber and error to the hazard red, and a lit chip has to read on
 * its own fill — cream on the amber is under 3:1, so an amber chip takes the
 * dark ink (README §7.5), the red chip takes the deep red (5.4:1 under
 * cream), and the graphite info chip steps darker in the dark theme, where
 * its 500 is too light for cream. The idle amber ink is 700: 600 on the 100
 * tint is 4.48:1 in the console, under the 4.5:1 a 12px label needs.
 * WHY EC paints from primary: EC is the nutrient-dosing step, normal
 * operation, and README §7.8 keeps red and amber for alarm and risk. The
 * `accent` scale it used to borrow is the design system's High alarm tier and
 * paints amber inside the console, so the nutrient category takes the
 * workspace accent here, on the nutrient pump bar, the usage row and the EC+
 * disturbance alike. EC WAIT and CHEM DT keep their pre-console warning hold
 * colour, tracked for a per-state call under FE-MEDIUM-339 (with acid on
 * error).
 */
const STATE_INFO: Record<
  SimStateName,
  { label: string; bg: string; active: string; text: string }
> = {
  IDLE: {
    label: 'IDLE',
    bg: 'bg-gray-100 dark:bg-gray-800',
    active: 'bg-gray-600 text-white',
    text: 'text-gray-500 dark:text-gray-400',
  },
  EC: {
    label: 'EC',
    bg: 'bg-primary-100 dark:bg-primary-900/40',
    active: 'bg-primary-600 text-white',
    text: 'text-primary-600 dark:text-primary-400',
  },
  EC_WAIT: {
    label: 'EC WAIT',
    bg: 'bg-warning-100 dark:bg-warning-900/40',
    active: 'bg-warning-400 text-gray-900',
    text: 'text-warning-700 dark:text-warning-400',
  },
  CHEM_DT: {
    label: 'CHEM DT',
    bg: 'bg-warning-100 dark:bg-warning-900/40',
    active: 'bg-warning-400 text-gray-900',
    text: 'text-warning-700 dark:text-warning-400',
  },
  PH: {
    label: 'pH',
    bg: 'bg-info-100 dark:bg-info-900/40',
    active: 'bg-info-500 dark:bg-info-600 text-white',
    text: 'text-info-500',
  },
  PH_WAIT: {
    label: 'pH WAIT',
    bg: 'bg-primary-100 dark:bg-primary-900/40',
    active: 'bg-primary-600 text-white',
    text: 'text-primary-600 dark:text-primary-400',
  },
  DILUTE: {
    label: 'DILUTE',
    bg: 'bg-info-100 dark:bg-info-900/40',
    active: 'bg-info-500 dark:bg-info-600 text-white',
    text: 'text-info-600 dark:text-info-400',
  },
  ALARM: {
    label: 'ALARM',
    bg: 'bg-error-100 dark:bg-error-900/40',
    active: 'bg-error-600 text-white',
    text: 'text-error-600 dark:text-error-400',
  },
};

/**
 * WHY a frame on the lit chip: the idle tint and the lit fill differ only in
 * lightness on several states (PH and DILUTE are ink-100 against ink-500 in
 * the console), and colour alone fails WCAG 1.4.1. The outline is a shape cue
 * every state shares; `aria-current="step"` gives assistive technology the
 * same fact. An outline takes no layout space, so the row does not shift as
 * the state moves.
 */
const LIT_FRAME = 'outline-2 outline-offset-1 outline-gray-900 dark:outline-gray-100';

const STATES: SimStateName[] = [
  'IDLE',
  'EC',
  'EC_WAIT',
  'CHEM_DT',
  'PH',
  'PH_WAIT',
  'DILUTE',
  'ALARM',
];

const StateIndicator: React.FC<StateIndicatorProps> = ({ currentState }) => {
  const headingId = useId();
  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
      <h4
        id={headingId}
        className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2"
      >
        Controller
      </h4>
      {/* The states are the controller's sequence, so they are a list named
          by the heading, and the current one is its current step. */}
      <ol aria-labelledby={headingId} className="flex flex-wrap gap-1">
        {STATES.map((s) => {
          const isActive = currentState === s;
          const info = STATE_INFO[s];
          return (
            <li
              key={s}
              aria-current={isActive ? 'step' : undefined}
              className={`px-2 py-1 rounded text-xs font-semibold transition-colors ${
                isActive ? `${info.active} ${LIT_FRAME}` : `${info.bg} ${info.text}`
              }`}
            >
              {info.label}
            </li>
          );
        })}
      </ol>
    </div>
  );
};

export default StateIndicator;
