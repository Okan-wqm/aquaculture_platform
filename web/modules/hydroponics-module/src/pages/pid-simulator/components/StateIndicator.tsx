/**
 * State Indicator - shows current dosing state
 */
import React from 'react';
import { SimStateName } from '../simulation/types';

interface StateIndicatorProps {
  currentState: SimStateName;
}

const STATE_INFO: Record<SimStateName, { label: string; bg: string; activeBg: string; text: string }> = {
  IDLE:      { label: 'IDLE',      bg: 'bg-gray-100',   activeBg: 'bg-gray-600',   text: 'text-gray-500' },
  DOSING_EC: { label: 'EC DOSE',   bg: 'bg-orange-100', activeBg: 'bg-orange-500', text: 'text-orange-500' },
  DOSING_PH: { label: 'pH DOSE',   bg: 'bg-blue-100',   activeBg: 'bg-blue-500',   text: 'text-blue-500' },
  DILUTE:    { label: 'DILUTE',    bg: 'bg-cyan-100',   activeBg: 'bg-cyan-500',   text: 'text-cyan-600' },
  CO2_WAIT:  { label: 'CO₂ WAIT',  bg: 'bg-yellow-100', activeBg: 'bg-yellow-500', text: 'text-yellow-600' },
};

const STATES: SimStateName[] = ['IDLE', 'DOSING_EC', 'DOSING_PH', 'DILUTE', 'CO2_WAIT'];

const StateIndicator: React.FC<StateIndicatorProps> = ({ currentState }) => {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-3">
      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Controller</h4>
      <div className="flex flex-wrap gap-1">
        {STATES.map(s => {
          const isActive = currentState === s;
          const info = STATE_INFO[s];
          return (
            <div
              key={s}
              className={`px-2 py-1 rounded text-[10px] font-mono font-semibold transition-colors ${
                isActive
                  ? `${info.activeBg} text-white`
                  : `${info.bg} ${info.text}`
              }`}
            >
              {info.label}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default StateIndicator;
