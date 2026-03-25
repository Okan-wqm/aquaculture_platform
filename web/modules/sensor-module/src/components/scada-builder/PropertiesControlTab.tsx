/**
 * SCADA Builder — Control Security tab content
 * Extracted from PropertiesPanel for maintainability (<500 LOC rule).
 */

import React from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ControlSecurityConfig {
  none: string[];
  confirm: string[];
  pin: string[];
}

export interface EmergencyStopConfig {
  holdDuration: number;
  affectedTags: string[];
  resetRequiresPin: boolean;
}

interface PropertiesControlTabProps {
  controlSecurity: ControlSecurityConfig;
  onControlSecurityChange?: (config: ControlSecurityConfig) => void;
  emergencyStop: EmergencyStopConfig;
  onEmergencyStopChange?: (config: EmergencyStopConfig) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const PropertiesControlTab: React.FC<PropertiesControlTabProps> = ({
  controlSecurity,
  onControlSecurityChange,
  emergencyStop,
  onEmergencyStopChange,
}) => {
  // --- Control helpers ---
  const addTagToLevel = (level: keyof ControlSecurityConfig) => {
    onControlSecurityChange?.({
      ...controlSecurity,
      [level]: [...controlSecurity[level], ''],
    });
  };

  const updateTagInLevel = (level: keyof ControlSecurityConfig, index: number, value: string) => {
    const updated = controlSecurity[level].map((t, i) => (i === index ? value : t));
    onControlSecurityChange?.({ ...controlSecurity, [level]: updated });
  };

  const removeTagFromLevel = (level: keyof ControlSecurityConfig, index: number) => {
    onControlSecurityChange?.({
      ...controlSecurity,
      [level]: controlSecurity[level].filter((_, i) => i !== index),
    });
  };

  // --- Emergency stop helpers ---
  const addAffectedTag = () => {
    onEmergencyStopChange?.({
      ...emergencyStop,
      affectedTags: [...emergencyStop.affectedTags, ''],
    });
  };

  const updateAffectedTag = (index: number, value: string) => {
    const updated = emergencyStop.affectedTags.map((t, i) => (i === index ? value : t));
    onEmergencyStopChange?.({ ...emergencyStop, affectedTags: updated });
  };

  const removeAffectedTag = (index: number) => {
    onEmergencyStopChange?.({
      ...emergencyStop,
      affectedTags: emergencyStop.affectedTags.filter((_, i) => i !== index),
    });
  };

  return (
    <div className="space-y-4">
      <h4 className="text-sm font-medium text-gray-700">Security Levels</h4>

      {(['none', 'confirm', 'pin'] as const).map((level) => (
        <div key={level} className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-gray-600 capitalize">
              {level === 'none' ? 'No Security' : level === 'confirm' ? 'Confirmation Required' : 'PIN Required'}
            </label>
            <button
              onClick={() => addTagToLevel(level)}
              className="text-xs text-cyan-600 hover:text-cyan-700"
            >
              + Add
            </button>
          </div>
          {controlSecurity[level].map((tag, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                type="text"
                value={tag}
                onChange={(e) => updateTagInLevel(level, i, e.target.value)}
                placeholder="tag.name"
                className="flex-1 px-2 py-1.5 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
              />
              <button
                onClick={() => removeTagFromLevel(level, i)}
                aria-label="Remove tag"
                className="text-red-400 hover:text-red-600 text-xs px-1"
              >
                X
              </button>
            </div>
          ))}
        </div>
      ))}

      {/* Emergency Stop Config */}
      <div className="pt-3 border-t border-gray-200 space-y-2">
        <h5 className="text-xs font-medium text-gray-600">Emergency Stop</h5>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Hold Duration (ms)</label>
          <input
            type="number"
            min={500}
            step={100}
            value={emergencyStop.holdDuration}
            onChange={(e) => onEmergencyStopChange?.({ ...emergencyStop, holdDuration: Number(e.target.value) })}
            className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-gray-500">Affected Tags</label>
            <button onClick={addAffectedTag} className="text-xs text-cyan-600 hover:text-cyan-700">
              + Add
            </button>
          </div>
          {emergencyStop.affectedTags.map((tag, i) => (
            <div key={i} className="flex items-center gap-1 mb-1">
              <input
                type="text"
                value={tag}
                onChange={(e) => updateAffectedTag(i, e.target.value)}
                placeholder="tag.name"
                className="flex-1 px-2 py-1.5 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
              />
              <button
                onClick={() => removeAffectedTag(i)}
                aria-label="Remove affected tag"
                className="text-red-400 hover:text-red-600 text-xs px-1"
              >
                X
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="resetRequiresPin"
            checked={emergencyStop.resetRequiresPin}
            onChange={(e) => onEmergencyStopChange?.({ ...emergencyStop, resetRequiresPin: e.target.checked })}
            className="text-cyan-600 rounded focus:ring-cyan-500"
          />
          <label htmlFor="resetRequiresPin" className="text-xs text-gray-700">
            PIN required for reset
          </label>
        </div>
      </div>
    </div>
  );
};
