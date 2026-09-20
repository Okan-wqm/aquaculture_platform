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
import { Input, NumberInput, Select } from '@aquaculture/shared-ui';
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

const INPUT_CLS =
  'w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500 focus:border-info-500';
const SECTION_CLS = 'pt-2 border-t border-gray-100 dark:border-gray-700';

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const VfdDriveWidgetConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
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
      <Input
        label="VFD Device ID"
        value={(config.vfdDeviceId as string) || ''}
        onChange={handleChange('vfdDeviceId')}
        placeholder="Enter VFD device ID..."
        data-testid="vfd-config-device-id"
      />

      {/* Display Name */}
      <Input
        label="Display Name"
        value={(config.displayName as string) || ''}
        onChange={handleChange('displayName')}
        placeholder="VFD Drive"
      />

      {/* Brand */}
      <Select
        label="Brand"
        size="sm"
        value={(config.brand as string) || VfdBrand.ABB}
        onChange={handleChange('brand')}
        data-testid="vfd-config-brand"
        options={BRAND_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
      />

      {/* Size Preset */}
      <Select
        label="Size Preset"
        size="sm"
        value={(config.sizePreset as string) || 'standard'}
        onChange={handleChange('sizePreset')}
        options={SIZE_PRESETS.map((opt) => ({ value: opt.value, label: opt.label }))}
      />

      {/* Max Frequency */}
      <NumberInput
        label="Max Frequency (Hz)"
        min={1}
        max={200}
        value={(config.maxFrequency as number) || 60}
        onChange={handleChange('maxFrequency')}
      />

      {/* ---- Parameter Visibility ---- */}
      <div className={SECTION_CLS}>
        <label className="text-xs text-gray-500 dark:text-gray-400 font-medium mb-2 block">
          Visible Parameters
        </label>
        <div className="space-y-1.5">
          {[
            { field: 'showFrequency', label: 'Frequency' },
            { field: 'showCurrent', label: 'Current' },
            { field: 'showSpeed', label: 'Speed' },
            { field: 'showPower', label: 'Power' },
            { field: 'showTemperature', label: 'Temperature' },
          ].map(({ field, label }) => (
            <label
              key={field}
              className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={config[field] !== false}
                onChange={handleCheckbox(field)}
                className="rounded border-gray-300 dark:border-gray-600 text-info-500 focus:ring-info-500"
                data-testid={`vfd-config-${field}`}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      {/* ---- Thresholds ---- */}
      <div className={SECTION_CLS}>
        <label className="text-xs text-gray-500 dark:text-gray-400 font-medium mb-2 block">
          Warning Thresholds
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <NumberInput
            label="Temp (°C)"
            min={0}
            max={150}
            value={(config.tempWarningThreshold as number) || 70}
            onChange={handleChange('tempWarningThreshold')}
            data-testid="vfd-config-temp-threshold"
          />
          <NumberInput
            label="Current (A)"
            min={0}
            max={500}
            value={(config.currentWarningThreshold as number) || 15}
            onChange={handleChange('currentWarningThreshold')}
            data-testid="vfd-config-current-threshold"
          />
        </div>
      </div>

      {/* Quick Actions Toggle */}
      <div className={SECTION_CLS}>
        <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            checked={config.showQuickActions !== false}
            onChange={handleCheckbox('showQuickActions')}
            className="rounded border-gray-300 dark:border-gray-600 text-info-500 focus:ring-info-500"
          />
          Show Quick Actions (Start/Stop/Program)
        </label>
      </div>

      {/* Demo State (for builder preview) */}
      <div className={SECTION_CLS}>
        <Select
          label="Preview State (builder only)"
          size="sm"
          value={(config.demoState as string) || ''}
          onChange={handleChange('demoState')}
          options={DEMO_STATES.map((opt) => ({ value: opt.value, label: opt.label }))}
        />
      </div>

      {/* Risk Level (read-only display from last changeset) */}
      <div className={SECTION_CLS}>
        <Select
          label="Last Change Risk Level"
          size="sm"
          value={(config.riskLevel as string) || 'none'}
          onChange={handleChange('riskLevel')}
          options={[
            { value: 'none', label: 'None' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'critical', label: 'Critical' },
          ]}
        />
      </div>
    </div>
  );
};
