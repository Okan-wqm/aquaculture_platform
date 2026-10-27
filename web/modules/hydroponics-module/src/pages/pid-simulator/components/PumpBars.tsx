/**
 * Pump Output Bars - Acid, Base, Nutrient, Dilute
 * Pure div-based (no SVG), compact horizontal bars
 */
import React from 'react';

interface PumpBarsProps {
  acidPump: number;
  basePump: number;
  nutPump: number;
  dilPump: number;
}

/**
 * WHAT: each pump's mark (dot + fill) and track, as design-system scale
 * classes — the page's pump legend: acid = error, base = success, nutrient =
 * primary (the workspace accent), dilute = info. The control panel's usage
 * rows follow it, and the EC+ disturbance and the EC controller state paint
 * nutrient from the same primary.
 * WHY classes and not the theme.ts mirror: an inline `colors.*` value is the
 * legacy palette at paint time, so inside the tenant console the bars stayed
 * green / blue while the scope re-maps every scale to Industry, and the light
 * tint stayed light in the dark theme. A class reads the re-mapped variable
 * and carries its own `dark:` track.
 * WHY nutrient is primary: dosing nutrient is normal operation, and README
 * §7.8 keeps red and amber for alarm and risk; an amber nutrient bar beside a
 * red alarm chip reads as a second alarm. The time-series chart still draws
 * from the theme.ts mirror (nutrient on the legacy amber), which the console
 * scope cannot reach — tracked with the other mirror-painted charts under
 * FE-MEDIUM-339, whose fix moves its nutrient line to primary as well.
 */
interface PumpTone {
  mark: string;
  track: string;
}

const ACID: PumpTone = { mark: 'bg-error-500', track: 'bg-error-50 dark:bg-error-900/30' };
const BASE: PumpTone = { mark: 'bg-success-600', track: 'bg-success-50 dark:bg-success-900/30' };
const NUTRIENT: PumpTone = {
  mark: 'bg-primary-600',
  track: 'bg-primary-50 dark:bg-primary-900/30',
};
const DILUTE: PumpTone = { mark: 'bg-info-600', track: 'bg-info-50 dark:bg-info-900/30' };

const PumpBar: React.FC<{
  label: string;
  value: number;
  tone: PumpTone;
}> = ({ label, value, tone }) => {
  const isOn = value > 1;
  const percent = Math.min(100, Math.max(0, value));
  // The simulation hands fractional outputs (37.84213); the label and the
  // announced value are the same one-decimal reading.
  const reading = `${value.toFixed(1)}%`;
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1.5 w-[80px]">
        <div
          className={`w-2 h-2 rounded-full flex-shrink-0 ${isOn ? tone.mark : 'bg-gray-300 dark:bg-gray-600'}`}
          aria-hidden="true"
        />
        <span className="text-xs text-gray-600 dark:text-gray-400 truncate">{label}</span>
      </div>
      {/* The bar is a meter: its fill width is the pump output, and
          aria-valuetext gives a screen reader the reading the percentage
          beside it shows, not the raw fraction in aria-valuenow. */}
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={reading}
        className={`flex-1 h-4 rounded-sm overflow-hidden ${tone.track}`}
      >
        <div
          className={`h-full rounded-sm transition-all duration-100 ${tone.mark} ${isOn ? 'opacity-80' : 'opacity-20'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400 w-[36px] text-right">
        {reading}
      </span>
    </div>
  );
};

const PumpBars: React.FC<PumpBarsProps> = ({ acidPump, basePump, nutPump, dilPump }) => (
  <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
    <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
      Pumps
    </h4>
    <div className="space-y-1.5">
      <PumpBar label="ACID" value={acidPump} tone={ACID} />
      <PumpBar label="BASE" value={basePump} tone={BASE} />
      <PumpBar label="NUTRIENT" value={nutPump} tone={NUTRIENT} />
      <PumpBar label="DILUTE" value={dilPump} tone={DILUTE} />
    </div>
  </div>
);

export default PumpBars;
