/**
 * Pump Output Bars - Acid, Base, Nutrient, Dilute
 * Pure div-based (no SVG), compact horizontal bars
 */
import React from 'react';
import { colors } from '@aquaculture/shared-ui';

interface PumpBarsProps {
  acidPump: number;
  basePump: number;
  nutPump: number;
  dilPump: number;
}

const PumpBar: React.FC<{
  label: string;
  value: number;
  color: string;
  bgColor: string;
}> = ({ label, value, color, bgColor }) => {
  const isOn = value > 1;
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1.5 w-[80px]">
        <div
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: isOn ? color : colors.neutral[300] }}
        />
        <span className="text-xs text-gray-600 dark:text-gray-400 truncate">{label}</span>
      </div>
      <div className="flex-1 h-4 rounded-sm overflow-hidden" style={{ backgroundColor: bgColor }}>
        <div
          className="h-full rounded-sm transition-all duration-100"
          style={{
            width: `${Math.min(100, value)}%`,
            backgroundColor: color,
            opacity: isOn ? 0.8 : 0.2,
          }}
        />
      </div>
      <span className="text-xs font-mono text-gray-500 dark:text-gray-400 w-[36px] text-right">
        {value.toFixed(1)}%
      </span>
    </div>
  );
};

const PumpBars: React.FC<PumpBarsProps> = ({ acidPump, basePump, nutPump, dilPump }) => (
  <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
    <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">Pumps</h4>
    <div className="space-y-1.5">
      <PumpBar label="ACID" value={acidPump} color={colors.error[500]} bgColor={colors.error[50]} />
      <PumpBar
        label="BASE"
        value={basePump}
        color={colors.success[600]}
        bgColor={colors.success[50]}
      />
      <PumpBar
        label="NUTRIENT"
        value={nutPump}
        color={colors.warning[600]}
        bgColor={colors.warning[50]}
      />
      <PumpBar label="DILUTE" value={dilPump} color={colors.info[600]} bgColor={colors.info[50]} />
    </div>
  </div>
);

export default PumpBars;
