import React from 'react';
import { Input } from '@aquaculture/shared-ui';
import { TagBrowser } from '../TagBrowser';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
  deviceId?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Labels for equipment sub-types                                     */
/* ------------------------------------------------------------------ */

const SUBTYPE_LABELS: Record<string, string> = {
  centrifugalPump: 'Centrifugal Pump',
  gearPump: 'Gear Pump',
  diaphragmPump: 'Diaphragm Pump',
  pistonPump: 'Piston Pump',
  submersiblePump: 'Submersible Pump',
  vacuumPump: 'Vacuum Pump',
  gateValve: 'Gate Valve',
  ballValve: 'Ball Valve',
  butterflyValve: 'Butterfly Valve',
  globeValve: 'Globe Valve',
  checkValve: 'Check Valve',
  reliefValve: 'Relief Valve',
  controlValve: 'Control Valve',
  needleValve: 'Needle Valve',
  solenoidValve: 'Solenoid Valve',
  verticalTank: 'Vertical Tank',
  horizontalTank: 'Horizontal Tank',
  conicalBottomTank: 'Conical Bottom Tank',
  pressureVessel: 'Pressure Vessel',
  silo: 'Silo',
  mixingTank: 'Mixing Tank',
  shellAndTube: 'Shell and Tube',
  plateHeatExchanger: 'Plate Heat Exchanger',
  airCooler: 'Air Cooler',
  condenser: 'Condenser',
  evaporator: 'Evaporator',
};

/* ------------------------------------------------------------------ */
/*  Rotation options                                                   */
/* ------------------------------------------------------------------ */

const ROTATION_OPTIONS = [0, 90, 180, 270] as const;

/* ------------------------------------------------------------------ */
/*  Demo state options                                                 */
/* ------------------------------------------------------------------ */

const DEMO_STATE_OPTIONS = [
  { value: '', label: 'None (live value)' },
  { value: 'running', label: 'Running' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'fault', label: 'Fault' },
] as const;

/* ------------------------------------------------------------------ */
/*  EquipmentConfig                                                    */
/* ------------------------------------------------------------------ */

export const EquipmentConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
  const subType = (config.equipmentSubType as string) || '';
  const currentRotation = (config.rotation as number) || 0;

  return (
    <div className="space-y-3">
      {/* Equipment sub-type badge (read-only) */}
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
          Equipment Type
        </label>
        <div className="px-3 py-2 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-700 dark:text-gray-300 font-medium">
          {SUBTYPE_LABELS[subType] || subType || 'Not specified'}
        </div>
      </div>

      {/* Tag binding */}
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Tag</label>
        <TagBrowser
          deviceId={deviceId || null}
          value={config.tagName || ''}
          onChange={(tagName) => onChange({ tagName })}
          placeholder="Select tag..."
        />
      </div>

      {/* Label */}
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Label</label>
        <Input
          fullWidth
          type="text"
          value={config.label || ''}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Equipment label"
        />
      </div>

      {/* Rotation selector */}
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Rotation</label>
        <div className="flex gap-1">
          {ROTATION_OPTIONS.map((deg) => (
            <button
              key={deg}
              type="button"
              onClick={() => onChange({ rotation: deg })}
              className={`flex-1 px-2 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                currentRotation === deg
                  ? 'bg-info-50 dark:bg-info-900/20 border-info-500 text-info-700 dark:text-info-300'
                  : 'bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              {deg}°
            </button>
          ))}
        </div>
      </div>

      {/* Demo state selector */}
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Demo Status</label>
        <select
          value={config.demoState || ''}
          onChange={(e) => onChange({ demoState: e.target.value || undefined })}
          className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500 focus:border-info-500 bg-white dark:bg-gray-900"
        >
          {DEMO_STATE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Select a state to test the symbol in edit mode.
        </p>
      </div>
    </div>
  );
};
