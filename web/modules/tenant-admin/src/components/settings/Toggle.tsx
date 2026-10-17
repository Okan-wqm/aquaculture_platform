import React from 'react';

/**
 * Toggle switch component for settings pages. "On" is a selection, so it
 * takes the workspace accent (`primary` inside the console scope) as every
 * selected control in the console does; the knob lifts on the console's own
 * elevation token, which follows the theme.
 */
export const Toggle: React.FC<{
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  label: string;
  description?: string;
}> = ({ enabled, onChange, label, description }) => (
  <div className="flex items-center justify-between py-4">
    <div>
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{label}</p>
      {description && (
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>
      )}
    </div>
    {/* A11y: this IS a switch, so it announces as one and carries the row's
        label as its accessible name — otherwise a screen-reader user hears an
        unnamed button, and a test can only find it by DOM position. */}
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 ${
        enabled ? 'bg-primary-600' : 'bg-gray-200 dark:bg-gray-700'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white dark:bg-gray-900 shadow-(--shadow-sd-sm) ring-0 transition duration-200 ease-in-out ${
          enabled ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  </div>
);

/**
 * Small inline toggle for table cells. A cell has no row label beside the
 * switch, so the caller names it (`label`, required: "Ada Lovelace: Harvest")
 * — the accessible name a screen reader announces with the switch role and
 * its checked state. Keyboard focus draws the accent ring (WCAG 2.4.7).
 */
export const SmallToggle: React.FC<{
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  label: string;
}> = ({ enabled, onChange, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={enabled}
    aria-label={label}
    onClick={() => onChange(!enabled)}
    className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 ${
      enabled ? 'bg-primary-600' : 'bg-gray-200 dark:bg-gray-700'
    }`}
  >
    <span
      className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white dark:bg-gray-900 shadow-(--shadow-sd-sm) ring-0 transition duration-200 ease-in-out ${
        enabled ? 'translate-x-4' : 'translate-x-0'
      }`}
    />
  </button>
);
