/**
 * Control Panel - tank values, target ranges, reagent selection, system params
 */
import React from 'react';
import { Button, Select, Slider, useI18n } from '@aquaculture/shared-ui';
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

const ControlPanel: React.FC<ControlPanelProps> = ({
  state,
  config,
  running,
  onConfigChange,
  onStart,
  onStop,
  onReset,
  onDisturbance,
}) => {
  const { t } = useI18n();
  const phInRange = state.pH >= config.phMin && state.pH <= config.phMax;
  const ecInRange = state.EC >= config.ecMin && state.EC <= config.ecMax;
  const phColor = phInRange
    ? 'text-success-700 dark:text-success-300'
    : 'text-error-600 dark:text-error-400';
  const ecColor = ecInRange
    ? 'text-success-700 dark:text-success-300'
    : 'text-error-600 dark:text-error-400';

  // Calculate mL used from grams + concentration
  const acidML = config.acidConc > 0 ? state.acidTotalGrams / (config.acidConc / 1000) : 0;
  const baseML = config.baseConc > 0 ? state.baseTotalGrams / (config.baseConc / 1000) : 0;

  // Find selected reagent formulas for display
  const acidInfo = ACID_REAGENTS.find((r) => r.name === config.acidReagent);
  const baseInfo = BASE_REAGENTS.find((r) => r.name === config.baseReagent);

  return (
    <div className="w-[280px] flex-shrink-0 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-3 overflow-y-auto text-sm max-h-[calc(100vh_-_100px)]">
      {/* Tank Values */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
          Tank Values
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div
            className={`rounded p-2 text-center ${phInRange ? 'bg-success-50 dark:bg-success-900/20' : 'bg-error-50 dark:bg-error-900/20'}`}
          >
            <div className="text-xs text-gray-500 dark:text-gray-400">pH</div>
            <div className={`text-xl font-bold font-mono ${phColor}`}>{state.pH.toFixed(2)}</div>
            <div className="text-xs font-mono text-gray-400 dark:text-gray-500">
              eq:{' '}
              <span
                className={
                  state.eqPH >= config.phMin && state.eqPH <= config.phMax
                    ? 'text-success-600 dark:text-success-400'
                    : 'text-error-500'
                }
              >
                {state.eqPH.toFixed(2)}
              </span>
            </div>
          </div>
          <div
            className={`rounded p-2 text-center ${ecInRange ? 'bg-success-50 dark:bg-success-900/20' : 'bg-error-50 dark:bg-error-900/20'}`}
          >
            <div className="text-xs text-gray-500 dark:text-gray-400">EC (mS/cm)</div>
            <div className={`text-xl font-bold font-mono ${ecColor}`}>{state.EC.toFixed(2)}</div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-800 rounded p-2 text-center">
            <div className="text-xs text-gray-500 dark:text-gray-400">DIC (mmol/L)</div>
            <div className="text-sm font-mono text-gray-700 dark:text-gray-300">
              {state.DIC.toFixed(3)}
            </div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-800 rounded p-2 text-center">
            <div className="text-xs text-gray-500 dark:text-gray-400">ALK (meq/L)</div>
            <div className="text-sm font-mono text-gray-700 dark:text-gray-300">
              {state.ALK.toFixed(3)}
            </div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-800 rounded p-2 text-center">
            <div className="text-xs text-gray-500 dark:text-gray-400">CO₂ (mg/L)</div>
            <div className="text-sm font-mono text-gray-700 dark:text-gray-300">
              {state.co2.toFixed(1)}
              <span className="text-xs text-gray-400 dark:text-gray-500">
                {' '}
                / {state.co2Eq.toFixed(1)} eq
              </span>
            </div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-800 rounded p-2 text-center">
            <div className="text-xs text-gray-500 dark:text-gray-400">State</div>
            <div className="text-sm font-mono text-gray-700 dark:text-gray-300">{state.state}</div>
          </div>
        </div>
      </div>

      {/* Target Ranges */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
          pH Range
        </h4>
        <Slider
          size="xs"
          readout="beside-label"
          className="mb-2"
          label="pH Min"
          value={config.phMin}
          min={4.0}
          max={config.phMax - 0.1}
          step={0.1}
          onChange={(v) => onConfigChange({ ...config, phMin: v })}
        />
        <Slider
          size="xs"
          readout="beside-label"
          className="mb-2"
          label="pH Max"
          value={config.phMax}
          min={config.phMin + 0.1}
          max={8.0}
          step={0.1}
          onChange={(v) => onConfigChange({ ...config, phMax: v })}
        />
      </div>

      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
          EC Range
        </h4>
        <Slider
          size="xs"
          readout="beside-label"
          className="mb-2"
          label="EC Min"
          value={config.ecMin}
          min={0.5}
          max={config.ecMax - 0.1}
          step={0.1}
          unit=" mS/cm"
          onChange={(v) => onConfigChange({ ...config, ecMin: v })}
        />
        <Slider
          size="xs"
          readout="beside-label"
          className="mb-2"
          label="EC Max"
          value={config.ecMax}
          min={config.ecMin + 0.1}
          max={4.0}
          step={0.1}
          unit=" mS/cm"
          onChange={(v) => onConfigChange({ ...config, ecMax: v })}
        />
      </div>

      {/* Reagent Selection */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
          Acid
        </h4>
        <Select
          size="xs"
          className="mb-2"
          aria-label={t('hydroponics.pid.acidReagent')}
          value={config.acidReagent}
          onChange={(e) => onConfigChange({ ...config, acidReagent: e.target.value })}
          disabled={running}
          options={ACID_REAGENTS.map((r) => ({ value: r.name, label: `${r.formula} - ${r.name}` }))}
        />
        <Slider
          size="xs"
          readout="beside-label"
          className="mb-2"
          label="Concentration"
          value={config.acidConc}
          min={10}
          max={500}
          step={10}
          unit=" g/L"
          onChange={(v) => onConfigChange({ ...config, acidConc: v })}
          disabled={running}
        />
      </div>

      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
          Base
        </h4>
        <Select
          size="xs"
          className="mb-2"
          aria-label={t('hydroponics.pid.baseReagent')}
          value={config.baseReagent}
          onChange={(e) => onConfigChange({ ...config, baseReagent: e.target.value })}
          disabled={running}
          options={BASE_REAGENTS.map((r) => ({ value: r.name, label: `${r.formula} - ${r.name}` }))}
        />
        <Slider
          size="xs"
          readout="beside-label"
          className="mb-2"
          label="Concentration"
          value={config.baseConc}
          min={10}
          max={500}
          step={10}
          unit=" g/L"
          onChange={(v) => onConfigChange({ ...config, baseConc: v })}
          disabled={running}
        />
      </div>

      {/* System */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
          System
        </h4>
        <Slider
          size="xs"
          readout="beside-label"
          className="mb-2"
          label="Volume"
          value={config.volumeL}
          min={10}
          max={1000}
          step={10}
          unit=" L"
          onChange={(v) => onConfigChange({ ...config, volumeL: v })}
          disabled={running}
        />
        <Slider
          size="xs"
          readout="beside-label"
          className="mb-2"
          label="Temperature"
          value={config.tempC}
          min={10}
          max={40}
          step={1}
          unit=" °C"
          onChange={(v) => onConfigChange({ ...config, tempC: v })}
        />
        <Slider
          size="xs"
          readout="beside-label"
          className="mb-2"
          label="Salinity"
          value={config.salinity}
          min={0}
          max={5}
          step={0.1}
          unit=" ppt"
          onChange={(v) => onConfigChange({ ...config, salinity: v })}
        />
      </div>

      {/* Freshwater */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
          Freshwater
        </h4>
        <Slider
          size="xs"
          readout="beside-label"
          className="mb-2"
          label="Water ALK"
          value={config.freshwaterALK}
          min={0.5}
          max={8.0}
          step={0.1}
          unit=" meq/L"
          onChange={(v) => onConfigChange({ ...config, freshwaterALK: v })}
        />
        <Slider
          size="xs"
          readout="beside-label"
          className="mb-2"
          label="Water pH"
          value={config.freshwaterPH}
          min={5.0}
          max={8.5}
          step={0.1}
          onChange={(v) => onConfigChange({ ...config, freshwaterPH: v })}
        />
      </div>

      {/* Usage Summary */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
          Usage
        </h4>
        <div className="space-y-1.5 text-xs font-mono">
          <div className="flex justify-between items-center bg-error-50 dark:bg-error-900/20 rounded px-2 py-1.5">
            <span className="text-error-700 dark:text-error-300 font-semibold">
              {acidInfo?.formula || 'Acid'}
            </span>
            <span className="text-error-600 dark:text-error-400">
              {state.acidTotalGrams.toFixed(1)}g / {acidML.toFixed(0)}mL
            </span>
          </div>
          <div className="flex justify-between items-center bg-success-50 dark:bg-success-900/20 rounded px-2 py-1.5">
            <span className="text-success-700 dark:text-success-300 font-semibold">
              {baseInfo?.formula || 'Base'}
            </span>
            <span className="text-success-600 dark:text-success-400">
              {state.baseTotalGrams.toFixed(1)}g / {baseML.toFixed(0)}mL
            </span>
          </div>
          <div className="flex justify-between items-center bg-accent-50 dark:bg-accent-900/20 rounded px-2 py-1.5">
            <span className="text-accent-700 dark:text-accent-300 font-semibold">Nutrient</span>
            <span className="text-accent-600 dark:text-accent-400">
              {state.nutTotalML.toFixed(0)}mL
            </span>
          </div>
        </div>
      </div>

      {/* Disturbances */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
          Disturbances
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          <button
            onClick={() => onDisturbance('phUp')}
            className="px-2 py-1.5 text-xs bg-info-50 dark:bg-info-900/20 hover:bg-info-100 dark:hover:bg-info-900/50 text-info-700 dark:text-info-300 rounded border border-info-200 dark:border-info-800"
            disabled={!running}
          >
            pH +0.5 ALK
          </button>
          <button
            onClick={() => onDisturbance('phDown')}
            className="px-2 py-1.5 text-xs bg-error-50 dark:bg-error-900/20 hover:bg-error-100 dark:hover:bg-error-900/50 text-error-700 dark:text-error-300 rounded border border-error-200 dark:border-error-800"
            disabled={!running}
          >
            pH -0.5 ALK
          </button>
          <button
            onClick={() => onDisturbance('ecUp')}
            className="px-2 py-1.5 text-xs bg-accent-50 dark:bg-accent-900/20 hover:bg-accent-100 dark:hover:bg-accent-900/50 text-accent-700 dark:text-accent-300 rounded border border-accent-200 dark:border-accent-800"
            disabled={!running}
          >
            EC +0.3
          </button>
          <button
            onClick={() => onDisturbance('ecDown')}
            className="px-2 py-1.5 text-xs bg-success-50 dark:bg-success-900/20 hover:bg-success-100 dark:hover:bg-success-900/50 text-success-700 dark:text-success-300 rounded border border-success-200 dark:border-success-800"
            disabled={!running}
          >
            EC -0.3
          </button>
        </div>
      </div>

      {/* Speed */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
          Speed
        </h4>
        <div className="flex gap-1">
          {[1, 5, 20, 60].map((s) => (
            <button
              key={s}
              onClick={() => onConfigChange({ ...config, speedMultiplier: s })}
              className={`flex-1 py-1 text-xs rounded border ${
                config.speedMultiplier === s
                  ? 'bg-info-600 text-white border-info-700'
                  : 'bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700'
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
          <Button variant="primary" size="xs" className="flex-1" onClick={onStart}>
            START
          </Button>
        ) : (
          <Button variant="warning" size="xs" className="flex-1" onClick={onStop}>
            STOP
          </Button>
        )}
        <button
          onClick={onReset}
          className="flex-1 py-2 text-xs font-semibold bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 text-gray-700 dark:text-gray-300 rounded"
        >
          RESET
        </button>
      </div>

      <div className="mt-2 text-center text-xs text-gray-400 dark:text-gray-500 font-mono">
        Tick: {state.tick} | t = {(state.tick * config.dt).toFixed(1)}s
      </div>
    </div>
  );
};

export default ControlPanel;
