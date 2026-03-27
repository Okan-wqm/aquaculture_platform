/**
 * VfdDriveWidgetConfig - Properties panel for VFD Drive widget.
 *
 * Provides:
 *   - VFD Device selector dropdown
 *   - Display name override
 *   - Brand selection (auto or manual)
 *   - Show/hide individual parameters
 *   - Temperature and current warning thresholds
 *   - Size preset and quick actions toggle
 *   - Demo state selector for builder preview
 */

import React, { useCallback } from 'react';
import { VfdBrand, VFD_BRAND_NAMES } from '../../../types/vfd.types';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Brand options                                                      */
/* ------------------------------------------------------------------ */

const BRAND_OPTIONS = Object.values(VfdBrand).map((b) => ({
  value: b,
  label: VFD_BRAND_NAMES[b],
}));

/* ------------------------------------------------------------------ */
/*  Size presets                                                       */
/* ------------------------------------------------------------------ */

const SIZE_PRESETS: Array<{ value: string; label: string }> = [
  { value: 'compact', label: 'Compact (200x300)' },
  { value: 'standard', label: 'Standard (300x400)' },
  { value: 'detailed', label: 'Detailed (400x500)' },
];

/* ------------------------------------------------------------------ */
/*  Demo states                                                        */
/* ------------------------------------------------------------------ */

const DEMO_STATES: Array<{ value: string; label: string }> = [
  { value: '', label: 'Running (default)' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'fault', label: 'Fault' },
  { value: 'warning', label: 'Warning' },
  { value: 'offline', label: 'Offline' },
  { value: 'programming', label: 'Programming' },
];

/* ------------------------------------------------------------------ */
/*  Shared input class                                                 */
/* ------------------------------------------------------------------ */

const INPUT_CLS = 'w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500';
const SELECT_CLS = INPUT_CLS;
const LABEL_CLS = 'block text-xs text-gray-500 mb-1';
const SECTION_CLS = 'pt-2 border-t border-gray-100';

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const VfdDriveWidgetConfig: React.FC<WidgetConfigProps> = ({
  config,
  onChange,
}) => {
  const handleChange = useCallback(
    (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const val = e.target.type === 'number' ? Number(e.target.value) : e.target.value;
      onChange({ [field]: val });
    },
    [onChange],
  );

  const handleCheckbox = useCallback(
    (field: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange({ [field]: e.target.checked });
    },
    [onChange],
  );

  return (
    <div className="space-y-3" data-testid="vfd-drive-widget-config">
      {/* VFD Device ID */}
      <div>
        <label className={LABEL_CLS}>VFD Device ID</label>
        <input
          type="text"
          value={(config.vfdDeviceId as string) || ''}
          onChange={handleChange('vfdDeviceId')}
          placeholder="Enter VFD device ID..."
          className={INPUT_CLS}
          data-testid="vfd-config-device-id"
        />
      </div>

      {/* Display Name */}
      <div>
        <label className={LABEL_CLS}>Display Name</label>
        <input
          type="text"
          value={(config.displayName as string) || ''}
          onChange={handleChange('displayName')}
          placeholder="VFD Drive"
          className={INPUT_CLS}
        />
      </div>

      {/* Brand */}
      <div>
        <label className={LABEL_CLS}>Brand</label>
        <select
          value={(config.brand as string) || VfdBrand.ABB}
          onChange={handleChange('brand')}
          className={SELECT_CLS}
          data-testid="vfd-config-brand"
        >
          {BRAND_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Size Preset */}
      <div>
        <label className={LABEL_CLS}>Size Preset</label>
        <select
          value={(config.sizePreset as string) || 'standard'}
          onChange={handleChange('sizePreset')}
          className={SELECT_CLS}
        >
          {SIZE_PRESETS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Max Frequency */}
      <div>
        <label className={LABEL_CLS}>Max Frequency (Hz)</label>
        <input
          type="number"
          min={1}
          max={200}
          value={(config.maxFrequency as number) || 60}
          onChange={handleChange('maxFrequency')}
          className={INPUT_CLS}
        />
      </div>

      {/* ---- Parameter Visibility ---- */}
      <div className={SECTION_CLS}>
        <label className="text-xs text-gray-500 font-medium mb-2 block">Visible Parameters</label>
        <div className="space-y-1.5">
          {[
            { field: 'showFrequency', label: 'Frequency' },
            { field: 'showCurrent', label: 'Current' },
            { field: 'showSpeed', label: 'Speed' },
            { field: 'showPower', label: 'Power' },
            { field: 'showTemperature', label: 'Temperature' },
          ].map(({ field, label }) => (
            <label key={field} className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={config[field] !== false}
                onChange={handleCheckbox(field)}
                className="rounded border-gray-300 text-cyan-500 focus:ring-cyan-500"
                data-testid={`vfd-config-${field}`}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      {/* ---- Thresholds ---- */}
      <div className={SECTION_CLS}>
        <label className="text-xs text-gray-500 font-medium mb-2 block">Warning Thresholds</label>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={LABEL_CLS}>Temp (&#176;C)</label>
            <input
              type="number"
              min={0}
              max={150}
              value={(config.tempWarningThreshold as number) || 70}
              onChange={handleChange('tempWarningThreshold')}
              className={INPUT_CLS}
              data-testid="vfd-config-temp-threshold"
            />
          </div>
          <div>
            <label className={LABEL_CLS}>Current (A)</label>
            <input
              type="number"
              min={0}
              max={500}
              value={(config.currentWarningThreshold as number) || 15}
              onChange={handleChange('currentWarningThreshold')}
              className={INPUT_CLS}
              data-testid="vfd-config-current-threshold"
            />
          </div>
        </div>
      </div>

      {/* Quick Actions Toggle */}
      <div className={SECTION_CLS}>
        <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={config.showQuickActions !== false}
            onChange={handleCheckbox('showQuickActions')}
            className="rounded border-gray-300 text-cyan-500 focus:ring-cyan-500"
          />
          Show Quick Actions (Start/Stop/Program)
        </label>
      </div>

      {/* Demo State (for builder preview) */}
      <div className={SECTION_CLS}>
        <label className={LABEL_CLS}>Preview State (builder only)</label>
        <select
          value={(config.demoState as string) || ''}
          onChange={handleChange('demoState')}
          className={SELECT_CLS}
        >
          {DEMO_STATES.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Risk Level (read-only display from last changeset) */}
      <div className={SECTION_CLS}>
        <label className={LABEL_CLS}>Last Change Risk Level</label>
        <select
          value={(config.riskLevel as string) || 'none'}
          onChange={handleChange('riskLevel')}
          className={SELECT_CLS}
        >
          <option value="none">None</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
      </div>
    </div>
  );
};
