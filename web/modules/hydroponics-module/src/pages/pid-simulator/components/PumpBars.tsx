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
          style={{ backgroundColor: isOn ? color : '#d1d5db' }}
        />
        <span className="text-[11px] text-gray-600 truncate">{label}</span>
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
      <span className="text-[10px] font-mono text-gray-500 w-[36px] text-right">
        {value.toFixed(1)}%
      </span>
    </div>
  );
};

const PumpBars: React.FC<PumpBarsProps> = ({ acidPump, basePump, nutPump, dilPump }) => (
  <div className="bg-white rounded-lg border border-gray-200 p-3">
    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Pumps</h4>
    <div className="space-y-1.5">
      <PumpBar label="ACID" value={acidPump} color="#e11d48" bgColor="#fce7f3" />
      <PumpBar label="BASE" value={basePump} color="#16a34a" bgColor="#dcfce7" />
      <PumpBar label="NUTRIENT" value={nutPump} color="#ea580c" bgColor="#fff7ed" />
      <PumpBar label="DILUTE" value={dilPump} color="#2563eb" bgColor="#eff6ff" />
    </div>
  </div>
);

export default PumpBars;
