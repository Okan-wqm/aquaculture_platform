/**
 * Control Panel - tank values, setpoints, PID tuning, disturbances
 */
import React from 'react';
import { SimConfig, SimState, PIDParams } from '../simulation/types';

interface ControlPanelProps {
  state: SimState;
  config: SimConfig;
  phPIDParams: PIDParams;
  ecPIDParams: PIDParams;
  running: boolean;
  onConfigChange: (c: SimConfig) => void;
  onPhPIDChange: (p: PIDParams) => void;
  onEcPIDChange: (p: PIDParams) => void;
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
  state, config, phPIDParams, ecPIDParams, running,
  onConfigChange, onPhPIDChange, onEcPIDChange,
  onStart, onStop, onReset, onDisturbance,
}) => {
  const phColor = state.pH < 5.0 || state.pH > 7.5 ? 'text-red-600' : 'text-gray-900';
  const ecColor = state.EC < 0.5 || state.EC > 3.5 ? 'text-red-600' : 'text-gray-900';

  return (
    <div className="w-[280px] flex-shrink-0 bg-white rounded-lg border border-gray-200 p-3 overflow-y-auto text-sm"
         style={{ maxHeight: 'calc(100vh - 100px)' }}>
      {/* Tank Values */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Tank Values</h4>
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-gray-50 rounded p-2 text-center">
            <div className="text-[10px] text-gray-500">pH</div>
            <div className={`text-xl font-bold font-mono ${phColor}`}>{state.pH.toFixed(2)}</div>
          </div>
          <div className="bg-gray-50 rounded p-2 text-center">
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
          <div className="bg-gray-50 rounded p-2 text-center col-span-2">
            <div className="text-[10px] text-gray-500">CO₂ (mg/L)</div>
            <div className="text-sm font-mono text-gray-700">{state.co2.toFixed(1)}</div>
          </div>
        </div>
      </div>

      {/* Setpoints */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Setpoints</h4>
        <Slider
          label="Target pH"
          value={config.targetPH}
          min={4.0} max={8.0} step={0.1}
          onChange={v => onConfigChange({ ...config, targetPH: v })}
        />
        <Slider
          label="Target EC"
          value={config.targetEC}
          min={0.5} max={4.0} step={0.1}
          unit=" mS/cm"
          onChange={v => onConfigChange({ ...config, targetEC: v })}
        />
      </div>

      {/* System */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">System</h4>
        <Slider
          label="Volume"
          value={config.volumeL}
          min={10} max={1000} step={10}
          unit=" L"
          onChange={v => onConfigChange({ ...config, volumeL: v })}
          disabled={running}
        />
        <Slider
          label="Temperature"
          value={config.tempC}
          min={10} max={40} step={1}
          unit=" °C"
          onChange={v => onConfigChange({ ...config, tempC: v })}
        />
        <Slider
          label="Salinity"
          value={config.salinity}
          min={0} max={5} step={0.1}
          unit=" ppt"
          onChange={v => onConfigChange({ ...config, salinity: v })}
        />
      </div>

      {/* pH PID Tuning */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">pH PID</h4>
        <Slider
          label="Kp"
          value={phPIDParams.Kp}
          min={0} max={30} step={0.5}
          onChange={v => onPhPIDChange({ ...phPIDParams, Kp: v })}
        />
        <Slider
          label="Ki"
          value={phPIDParams.Ki}
          min={0} max={5} step={0.05}
          onChange={v => onPhPIDChange({ ...phPIDParams, Ki: v })}
        />
        <Slider
          label="Kd"
          value={phPIDParams.Kd}
          min={0} max={10} step={0.1}
          onChange={v => onPhPIDChange({ ...phPIDParams, Kd: v })}
        />
        <div className="flex justify-between text-[10px] text-gray-400 mt-1">
          <span>Gain Sched: {state.gainSchedule.toFixed(2)}x</span>
          <span>Buffer: {state.bufferCapacity.toFixed(1)}</span>
        </div>
      </div>

      {/* EC PID Tuning */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">EC PID</h4>
        <Slider
          label="Kp"
          value={ecPIDParams.Kp}
          min={0} max={50} step={1}
          onChange={v => onEcPIDChange({ ...ecPIDParams, Kp: v })}
        />
        <Slider
          label="Ki"
          value={ecPIDParams.Ki}
          min={0} max={10} step={0.1}
          onChange={v => onEcPIDChange({ ...ecPIDParams, Ki: v })}
        />
        <Slider
          label="Kd"
          value={ecPIDParams.Kd}
          min={0} max={5} step={0.1}
          onChange={v => onEcPIDChange({ ...ecPIDParams, Kd: v })}
        />
      </div>

      {/* Disturbances */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Disturbances</h4>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            onClick={() => onDisturbance('phUp')}
            className="px-2 py-1.5 text-[11px] bg-blue-50 hover:bg-blue-100 text-blue-700 rounded border border-blue-200"
            disabled={!running}
          >
            pH +0.5 ALK
          </button>
          <button
            onClick={() => onDisturbance('phDown')}
            className="px-2 py-1.5 text-[11px] bg-red-50 hover:bg-red-100 text-red-700 rounded border border-red-200"
            disabled={!running}
          >
            pH -0.5 ALK
          </button>
          <button
            onClick={() => onDisturbance('ecUp')}
            className="px-2 py-1.5 text-[11px] bg-orange-50 hover:bg-orange-100 text-orange-700 rounded border border-orange-200"
            disabled={!running}
          >
            EC +0.3
          </button>
          <button
            onClick={() => onDisturbance('ecDown')}
            className="px-2 py-1.5 text-[11px] bg-green-50 hover:bg-green-100 text-green-700 rounded border border-green-200"
            disabled={!running}
          >
            EC -0.3
          </button>
        </div>
      </div>

      {/* Speed */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Speed</h4>
        <div className="flex gap-1">
          {[1, 5, 20, 60].map(s => (
            <button
              key={s}
              onClick={() => onConfigChange({ ...config, speedMultiplier: s })}
              className={`flex-1 py-1 text-[11px] rounded border ${
                config.speedMultiplier === s
                  ? 'bg-blue-600 text-white border-blue-700'
                  : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'
              }`}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>

      {/* Control */}
      <div className="flex gap-1.5">
        {!running ? (
          <button
            onClick={onStart}
            className="flex-1 py-2 text-xs font-semibold bg-green-600 hover:bg-green-700 text-white rounded"
          >
            START
          </button>
        ) : (
          <button
            onClick={onStop}
            className="flex-1 py-2 text-xs font-semibold bg-yellow-500 hover:bg-yellow-600 text-white rounded"
          >
            STOP
          </button>
        )}
        <button
          onClick={onReset}
          className="flex-1 py-2 text-xs font-semibold bg-gray-200 hover:bg-gray-300 text-gray-700 rounded"
        >
          RESET
        </button>
      </div>

      {/* Tick counter */}
      <div className="mt-2 text-center text-[10px] text-gray-400 font-mono">
        Tick: {state.tick} | t = {(state.tick * config.dt).toFixed(1)}s
      </div>
    </div>
  );
};

export default ControlPanel;
