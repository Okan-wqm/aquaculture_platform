/**
 * Control Panel - tank values, target ranges, reagent selection, system params
 */
import React from 'react';
import { SimConfig, SimState } from '../simulation/types';
import { ACID_REAGENTS, BASE_REAGENTS } from '../engine/reagents';

interface ControlPanelProps {
  state: SimState;
  config: SimConfig;
  running: boolean;
  onConfigChange: (c: SimConfig) => void;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
  onDisturbance: (type: 'phUp' | 'phDown' | 'ecUp' | 'ecDown') => void;
}

const Slider: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
  disabled?: boolean;
}> = ({ label, value, min, max, step, unit, onChange, disabled }) => (
  <div className="mb-2">
    <div className="flex justify-between text-[11px] text-gray-600">
      <span>{label}</span>
      <span className="font-mono">{value.toFixed(step < 1 ? (step < 0.1 ? 2 : 1) : 0)}{unit || ''}</span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={e => onChange(parseFloat(e.target.value))}
      className="w-full h-1.5 accent-blue-600"
      disabled={disabled}
    />
  </div>
);

const ControlPanel: React.FC<ControlPanelProps> = ({
  state, config, running,
  onConfigChange, onStart, onStop, onReset, onDisturbance,
}) => {
  const phInRange = state.pH >= config.phMin && state.pH <= config.phMax;
  const ecInRange = state.EC >= config.ecMin && state.EC <= config.ecMax;
  const phColor = phInRange ? 'text-green-700' : 'text-red-600';
  const ecColor = ecInRange ? 'text-green-700' : 'text-red-600';

  // Calculate mL used from grams + concentration
  const acidML = config.acidConc > 0 ? state.acidTotalGrams / (config.acidConc / 1000) : 0;
  const baseML = config.baseConc > 0 ? state.baseTotalGrams / (config.baseConc / 1000) : 0;

  // Find selected reagent formulas for display
  const acidInfo = ACID_REAGENTS.find(r => r.name === config.acidReagent);
  const baseInfo = BASE_REAGENTS.find(r => r.name === config.baseReagent);

  return (
    <div className="w-[280px] flex-shrink-0 bg-white rounded-lg border border-gray-200 p-3 overflow-y-auto text-sm"
         style={{ maxHeight: 'calc(100vh - 100px)' }}>
      {/* Tank Values */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Tank Values</h4>
        <div className="grid grid-cols-2 gap-2">
          <div className={`rounded p-2 text-center ${phInRange ? 'bg-green-50' : 'bg-red-50'}`}>
            <div className="text-[10px] text-gray-500">pH</div>
            <div className={`text-xl font-bold font-mono ${phColor}`}>{state.pH.toFixed(2)}</div>
          </div>
          <div className={`rounded p-2 text-center ${ecInRange ? 'bg-green-50' : 'bg-red-50'}`}>
            <div className="text-[10px] text-gray-500">EC (mS/cm)</div>
            <div className={`text-xl font-bold font-mono ${ecColor}`}>{state.EC.toFixed(2)}</div>
          </div>
          <div className="bg-gray-50 rounded p-2 text-center">
            <div className="text-[10px] text-gray-500">DIC (mmol/L)</div>
            <div className="text-sm font-mono text-gray-700">{state.DIC.toFixed(3)}</div>
          </div>
          <div className="bg-gray-50 rounded p-2 text-center">
            <div className="text-[10px] text-gray-500">ALK (meq/L)</div>
            <div className="text-sm font-mono text-gray-700">{state.ALK.toFixed(3)}</div>
          </div>
          <div className="bg-gray-50 rounded p-2 text-center">
            <div className="text-[10px] text-gray-500">CO₂ (mg/L)</div>
            <div className="text-sm font-mono text-gray-700">
              {state.co2.toFixed(1)}
              <span className="text-[9px] text-gray-400"> / {state.co2Eq.toFixed(1)} eq</span>
            </div>
          </div>
          <div className="bg-gray-50 rounded p-2 text-center">
            <div className="text-[10px] text-gray-500">State</div>
            <div className="text-sm font-mono text-gray-700">{state.state}</div>
          </div>
        </div>
      </div>

      {/* Target Ranges */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">pH Range</h4>
        <Slider label="pH Min" value={config.phMin} min={4.0} max={config.phMax - 0.1} step={0.1}
          onChange={v => onConfigChange({ ...config, phMin: v })} />
        <Slider label="pH Max" value={config.phMax} min={config.phMin + 0.1} max={8.0} step={0.1}
          onChange={v => onConfigChange({ ...config, phMax: v })} />
      </div>

      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">EC Range</h4>
        <Slider label="EC Min" value={config.ecMin} min={0.5} max={config.ecMax - 0.1} step={0.1} unit=" mS/cm"
          onChange={v => onConfigChange({ ...config, ecMin: v })} />
        <Slider label="EC Max" value={config.ecMax} min={config.ecMin + 0.1} max={4.0} step={0.1} unit=" mS/cm"
          onChange={v => onConfigChange({ ...config, ecMax: v })} />
      </div>

      {/* Reagent Selection */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Acid</h4>
        <select
          value={config.acidReagent}
          onChange={e => onConfigChange({ ...config, acidReagent: e.target.value })}
          className="w-full mb-2 px-2 py-1.5 text-[11px] border border-gray-200 rounded bg-white"
          disabled={running}
        >
          {ACID_REAGENTS.map(r => (
            <option key={r.name} value={r.name}>{r.formula} - {r.name}</option>
          ))}
        </select>
        <Slider label="Concentration" value={config.acidConc} min={10} max={500} step={10} unit=" g/L"
          onChange={v => onConfigChange({ ...config, acidConc: v })} disabled={running} />
      </div>

      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Base</h4>
        <select
          value={config.baseReagent}
          onChange={e => onConfigChange({ ...config, baseReagent: e.target.value })}
          className="w-full mb-2 px-2 py-1.5 text-[11px] border border-gray-200 rounded bg-white"
          disabled={running}
        >
          {BASE_REAGENTS.map(r => (
            <option key={r.name} value={r.name}>{r.formula} - {r.name}</option>
          ))}
        </select>
        <Slider label="Concentration" value={config.baseConc} min={10} max={500} step={10} unit=" g/L"
          onChange={v => onConfigChange({ ...config, baseConc: v })} disabled={running} />
      </div>

      {/* System */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">System</h4>
        <Slider label="Volume" value={config.volumeL} min={10} max={1000} step={10} unit=" L"
          onChange={v => onConfigChange({ ...config, volumeL: v })} disabled={running} />
        <Slider label="Temperature" value={config.tempC} min={10} max={40} step={1} unit=" °C"
          onChange={v => onConfigChange({ ...config, tempC: v })} />
        <Slider label="Salinity" value={config.salinity} min={0} max={5} step={0.1} unit=" ppt"
          onChange={v => onConfigChange({ ...config, salinity: v })} />
      </div>

      {/* Freshwater */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Freshwater</h4>
        <Slider label="Water ALK" value={config.freshwaterALK} min={0.5} max={8.0} step={0.1} unit=" meq/L"
          onChange={v => onConfigChange({ ...config, freshwaterALK: v })} />
        <Slider label="Water pH" value={config.freshwaterPH} min={5.0} max={8.5} step={0.1}
          onChange={v => onConfigChange({ ...config, freshwaterPH: v })} />
        <Slider label="Aeration" value={config.aerationRate} min={0.01} max={0.3} step={0.01} unit=" /min"
          onChange={v => onConfigChange({ ...config, aerationRate: v })} />
      </div>

      {/* Usage Summary */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Usage</h4>
        <div className="space-y-1.5 text-[10px] font-mono">
          <div className="flex justify-between items-center bg-red-50 rounded px-2 py-1.5">
            <span className="text-red-700 font-semibold">{acidInfo?.formula || 'Acid'}</span>
            <span className="text-red-600">{state.acidTotalGrams.toFixed(1)}g / {acidML.toFixed(0)}mL</span>
          </div>
          <div className="flex justify-between items-center bg-green-50 rounded px-2 py-1.5">
            <span className="text-green-700 font-semibold">{baseInfo?.formula || 'Base'}</span>
            <span className="text-green-600">{state.baseTotalGrams.toFixed(1)}g / {baseML.toFixed(0)}mL</span>
          </div>
          <div className="flex justify-between items-center bg-orange-50 rounded px-2 py-1.5">
            <span className="text-orange-700 font-semibold">Nutrient</span>
            <span className="text-orange-600">{state.nutTotalML.toFixed(0)}mL</span>
          </div>
        </div>
      </div>

      {/* Disturbances */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Disturbances</h4>
        <div className="grid grid-cols-2 gap-1.5">
          <button onClick={() => onDisturbance('phUp')}
            className="px-2 py-1.5 text-[11px] bg-blue-50 hover:bg-blue-100 text-blue-700 rounded border border-blue-200"
            disabled={!running}>pH +0.5 ALK</button>
          <button onClick={() => onDisturbance('phDown')}
            className="px-2 py-1.5 text-[11px] bg-red-50 hover:bg-red-100 text-red-700 rounded border border-red-200"
            disabled={!running}>pH -0.5 ALK</button>
          <button onClick={() => onDisturbance('ecUp')}
            className="px-2 py-1.5 text-[11px] bg-orange-50 hover:bg-orange-100 text-orange-700 rounded border border-orange-200"
            disabled={!running}>EC +0.3</button>
          <button onClick={() => onDisturbance('ecDown')}
            className="px-2 py-1.5 text-[11px] bg-green-50 hover:bg-green-100 text-green-700 rounded border border-green-200"
            disabled={!running}>EC -0.3</button>
        </div>
      </div>

      {/* Speed */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Speed</h4>
        <div className="flex gap-1">
          {[1, 5, 20, 60].map(s => (
            <button key={s} onClick={() => onConfigChange({ ...config, speedMultiplier: s })}
              className={`flex-1 py-1 text-[11px] rounded border ${
                config.speedMultiplier === s
                  ? 'bg-blue-600 text-white border-blue-700'
                  : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'
              }`}>{s}x</button>
          ))}
        </div>
      </div>

      {/* Control */}
      <div className="flex gap-1.5">
        {!running ? (
          <button onClick={onStart}
            className="flex-1 py-2 text-xs font-semibold bg-green-600 hover:bg-green-700 text-white rounded">START</button>
        ) : (
          <button onClick={onStop}
            className="flex-1 py-2 text-xs font-semibold bg-yellow-500 hover:bg-yellow-600 text-white rounded">STOP</button>
        )}
        <button onClick={onReset}
          className="flex-1 py-2 text-xs font-semibold bg-gray-200 hover:bg-gray-300 text-gray-700 rounded">RESET</button>
      </div>

      <div className="mt-2 text-center text-[10px] text-gray-400 font-mono">
        Tick: {state.tick} | t = {(state.tick * config.dt).toFixed(1)}s
      </div>
    </div>
  );
};

export default ControlPanel;
