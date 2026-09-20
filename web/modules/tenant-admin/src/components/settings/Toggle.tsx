import React from 'react';

/**
 * Toggle switch component for settings pages.
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
      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden focus:ring-2 focus:ring-success-500 focus:ring-offset-2 ${
        enabled ? 'bg-success-600' : 'bg-gray-200 dark:bg-gray-700'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white dark:bg-gray-900 shadow ring-0 transition duration-200 ease-in-out ${
          enabled ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  </div>
);

/**
 * Small inline toggle for table cells.
 *
 * Same control as `Toggle` above, in a table cell, and it had none of the
 * semantics: no role, no aria-checked, no name. In a grid of them a screen
 * reader announced a row of unnamed buttons whose only difference was colour.
 * `label` is required rather than optional because a cell has no visible text
 * to fall back on — the caller builds the name from the column and the row.
 */
export const SmallToggle: React.FC<{
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  /** Accessible name — the cell has no visible label of its own */
  label: string;
}> = ({ enabled, onChange, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={enabled}
    aria-label={label}
    onClick={() => onChange(!enabled)}
    className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
      enabled ? 'bg-success-600' : 'bg-gray-200 dark:bg-gray-700'
    }`}
  >
    <span
      className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white dark:bg-gray-900 shadow ring-0 transition duration-200 ease-in-out ${
        enabled ? 'translate-x-4' : 'translate-x-0'
      }`}
    />
  </button>
);
