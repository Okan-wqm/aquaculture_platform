import React from 'react';
import { Select, NumberInput, Checkbox } from '@aquaculture/shared-ui';
import { useSolution } from '../../../context/SolutionContext';
import {
  SUBSTRATE_OPTIONS,
  FERTIGATION_MODE_OPTIONS,
} from '../../../types/solution.types';
import type { ReadjustmentSettings, SubstrateType } from '../../../types/modes.types';

const ReadjustmentSettingsTab: React.FC = () => {
  const { settings, setReadjustment } = useSolution();
  const rs = settings.readjustmentSettings ?? {
    isFirstReadjustment: true,
    fertigationMode: 'pulse',
    timeApplyingCurrentNs: 7,
    timeToRestore: 7,
    emittersPerPlant: 2,
    emitterFlowRate: 2.0,
    irrigationDuration: 5,
    irrigationsPerDay: 10,
    substrateType: 'rockwool',
    substrateVolumePerPlant: 15,
    drainageStorageVolume: 1000,
  };

  const update = (partial: Partial<ReadjustmentSettings>) => {
    setReadjustment(partial);
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-800 mb-2">Readjustment Settings</h3>
        <p className="text-xs text-gray-500 mb-4">
          Physical system parameters used for readjustment calculations.
        </p>

        {/* Timing */}
        <div className="space-y-4">
          <h4 className="text-xs font-semibold text-gray-500 uppercase">Timing</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <NumberInput
              label="Time Applying Current NS (days)"
              value={rs.timeApplyingCurrentNs}
              onChange={(e) => update({ timeApplyingCurrentNs: parseFloat(e.target.value) || 0 })}
              min={1}
              step={1}
            />
            <NumberInput
              label="Time to Restore (days)"
              value={rs.timeToRestore}
              onChange={(e) => update({ timeToRestore: parseFloat(e.target.value) || 0 })}
              min={1}
              step={1}
            />
          </div>
        </div>

        {/* Fertigation */}
        <div className="space-y-4 pt-4 border-t border-gray-100 mt-4">
          <h4 className="text-xs font-semibold text-gray-500 uppercase">Fertigation</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label="Fertigation Mode"
              options={FERTIGATION_MODE_OPTIONS}
              value={rs.fertigationMode}
              onChange={(e) => update({ fertigationMode: e.target.value as 'continuous' | 'pulse' })}
            />
            <NumberInput
              label="Irrigations Per Day"
              value={rs.irrigationsPerDay}
              onChange={(e) => update({ irrigationsPerDay: parseInt(e.target.value, 10) || 0 })}
              min={1}
              step={1}
            />
            <NumberInput
              label="Irrigation Duration (min)"
              value={rs.irrigationDuration}
              onChange={(e) => update({ irrigationDuration: parseFloat(e.target.value) || 0 })}
              min={0.5}
              step={0.5}
              unit="min"
            />
          </div>
        </div>

        {/* Emitters */}
        <div className="space-y-4 pt-4 border-t border-gray-100 mt-4">
          <h4 className="text-xs font-semibold text-gray-500 uppercase">Emitters</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <NumberInput
              label="Emitters Per Plant"
              value={rs.emittersPerPlant}
              onChange={(e) => update({ emittersPerPlant: parseInt(e.target.value, 10) || 0 })}
              min={1}
              step={1}
            />
            <NumberInput
              label="Emitter Flow Rate (L/h)"
              value={rs.emitterFlowRate}
              onChange={(e) => update({ emitterFlowRate: parseFloat(e.target.value) || 0 })}
              min={0.1}
              step={0.1}
              unit="L/h"
            />
          </div>
        </div>

        {/* Substrate */}
        <div className="space-y-4 pt-4 border-t border-gray-100 mt-4">
          <h4 className="text-xs font-semibold text-gray-500 uppercase">Substrate</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label="Substrate Type"
              options={SUBSTRATE_OPTIONS}
              value={rs.substrateType}
              onChange={(e) => update({ substrateType: e.target.value as SubstrateType })}
            />
            <NumberInput
              label="Substrate Volume Per Plant (L)"
              value={rs.substrateVolumePerPlant}
              onChange={(e) => update({ substrateVolumePerPlant: parseFloat(e.target.value) || 0 })}
              min={0}
              step={0.5}
              unit="L"
            />
            <NumberInput
              label="Drainage Storage Volume (L)"
              value={rs.drainageStorageVolume}
              onChange={(e) => update({ drainageStorageVolume: parseFloat(e.target.value) || 0 })}
              min={0}
              step={10}
              unit="L"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default ReadjustmentSettingsTab;
