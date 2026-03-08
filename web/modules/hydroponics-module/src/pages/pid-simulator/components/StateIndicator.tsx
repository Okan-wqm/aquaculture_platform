/**
 * State Machine Indicator + Alarm Status
 */
import React from 'react';
import { SimStateName } from '../simulation/types';
import { alarmName } from '../simulation/safety';

interface StateIndicatorProps {
  currentState: SimStateName;
  alarmCode: number;
  alarmLatched: boolean;
  onAcknowledge: () => void;
}

const STATES: SimStateName[] = ['IDLE', 'EC', 'EC_WAIT', 'CHEM_DT', 'PH', 'PH_WAIT', 'DILUTE', 'ALARM'];

const STATE_COLORS: Record<SimStateName, { bg: string; text: string; activeBg: string }> = {
  IDLE:    { bg: 'bg-gray-100', text: 'text-gray-500', activeBg: 'bg-gray-600' },
  EC:      { bg: 'bg-orange-100', text: 'text-orange-500', activeBg: 'bg-orange-500' },
  EC_WAIT: { bg: 'bg-orange-50', text: 'text-orange-400', activeBg: 'bg-orange-400' },
  CHEM_DT: { bg: 'bg-yellow-100', text: 'text-yellow-600', activeBg: 'bg-yellow-500' },
  PH:      { bg: 'bg-blue-100', text: 'text-blue-500', activeBg: 'bg-blue-500' },
  PH_WAIT: { bg: 'bg-blue-50', text: 'text-blue-400', activeBg: 'bg-blue-400' },
  DILUTE:  { bg: 'bg-cyan-100', text: 'text-cyan-600', activeBg: 'bg-cyan-500' },
  ALARM:   { bg: 'bg-red-100', text: 'text-red-500', activeBg: 'bg-red-600' },
};

const StateIndicator: React.FC<StateIndicatorProps> = ({
  currentState, alarmCode, alarmLatched, onAcknowledge,
}) => {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-3">
      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">State Machine</h4>
      <div className="flex flex-wrap gap-1">
        {STATES.map(s => {
          const isActive = currentState === s;
          const colors = STATE_COLORS[s];
          return (
            <div
              key={s}
              className={`px-2 py-1 rounded text-[10px] font-mono font-semibold transition-colors ${
                isActive
                  ? `${colors.activeBg} text-white`
                  : `${colors.bg} ${colors.text}`
              }`}
            >
              {s}
            </div>
          );
        })}
      </div>
      {alarmLatched && (
        <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded flex items-center justify-between">
          <div>
            <div className="text-[10px] text-red-500 font-semibold">ALARM</div>
            <div className="text-[11px] text-red-700 font-mono">{alarmName(alarmCode)}</div>
          </div>
          <button
            onClick={onAcknowledge}
            className="px-3 py-1 text-[10px] font-semibold bg-red-600 hover:bg-red-700 text-white rounded"
          >
            ACK
          </button>
        </div>
      )}
    </div>
  );
};

export default StateIndicator;
