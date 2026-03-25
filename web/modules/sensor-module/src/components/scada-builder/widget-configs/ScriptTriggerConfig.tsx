/**
 * Trigger configuration for when a SCADA script should execute.
 *
 * Each trigger type surfaces different UI controls:
 * - event:     No extra config -- triggered by widget events via runScript action
 * - tagChange: TagBrowser for selecting the tag whose changes fire the script
 * - interval:  Number input for the execution interval (min 1000ms) with ms/s toggle
 * - load:      No extra config -- fires once when the SCADA view mounts
 *
 * Uses the same TagBrowser component as EventsPanel/AnimationsPanel for
 * consistency in tag selection UX across the builder.
 */

import React, { useState } from 'react';
import type { ScriptTrigger, ScadaScript } from '../../../engine/events/types';
import { TagBrowser } from '../TagBrowser';

const INPUT_CLASS =
  'w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500';

/** Trigger type options with human-readable labels for the dropdown. */
const TRIGGER_OPTIONS: Array<{ value: ScriptTrigger; label: string; description: string }> = [
  { value: 'event', label: 'Widget Event', description: 'Triggered by widget events via runScript action' },
  { value: 'tagChange', label: 'Tag Change', description: 'Fires when a tag value changes' },
  { value: 'interval', label: 'Interval', description: 'Repeats at a fixed time interval' },
  { value: 'load', label: 'On Load', description: 'Runs once when the view loads' },
];

interface ScriptTriggerConfigProps {
  trigger: ScriptTrigger;
  triggerTag?: string;
  triggerInterval?: number;
  deviceId?: string | null;
  onChange: (updates: Partial<ScadaScript>) => void;
}

export const ScriptTriggerConfig: React.FC<ScriptTriggerConfigProps> = ({
  trigger,
  triggerTag,
  triggerInterval,
  deviceId,
  onChange,
}) => {
  /**
   * Toggle between milliseconds and seconds display.
   * Internally always stores milliseconds -- the toggle is a UX convenience
   * since operators think in seconds but the runtime needs ms precision.
   */
  const [intervalUnit, setIntervalUnit] = useState<'ms' | 's'>('ms');

  const handleTriggerChange = (newTrigger: ScriptTrigger) => {
    // Reset trigger-specific fields when switching trigger type
    // to avoid stale config leaking between trigger modes
    onChange({
      trigger: newTrigger,
      triggerTag: undefined,
      triggerInterval: newTrigger === 'interval' ? 5000 : undefined,
    });
  };

  const handleIntervalChange = (displayValue: number) => {
    // Convert display value to ms based on current unit selection
    const msValue = intervalUnit === 's' ? displayValue * 1000 : displayValue;
    // Enforce minimum interval of 1000ms to prevent runaway execution
    onChange({ triggerInterval: Math.max(1000, msValue) });
  };

  const displayInterval = intervalUnit === 's'
    ? Math.round((triggerInterval ?? 5000) / 1000)
    : (triggerInterval ?? 5000);

  return (
    <div className="space-y-2" data-testid="script-trigger-config">
      {/* Trigger type dropdown */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Trigger</label>
        <select
          value={trigger}
          onChange={(e) => handleTriggerChange(e.target.value as ScriptTrigger)}
          className={INPUT_CLASS}
          data-testid="trigger-type-select"
        >
          {TRIGGER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Description hint for the selected trigger */}
      <p className="text-[10px] text-gray-400 italic" data-testid="trigger-description">
        {TRIGGER_OPTIONS.find((o) => o.value === trigger)?.description}
      </p>

      {/* tagChange: show TagBrowser for selecting trigger tag */}
      {trigger === 'tagChange' && (
        <div data-testid="trigger-tag-config">
          <label className="block text-xs text-gray-500 mb-1">Trigger Tag</label>
          <TagBrowser
            deviceId={deviceId ?? null}
            value={triggerTag ?? ''}
            onChange={(tag) => onChange({ triggerTag: tag })}
            placeholder="Select tag to watch..."
          />
        </div>
      )}

      {/* interval: show interval input with ms/s unit toggle */}
      {trigger === 'interval' && (
        <div data-testid="trigger-interval-config">
          <label className="block text-xs text-gray-500 mb-1">Interval</label>
          <div className="flex items-center gap-1">
            <input
              type="number"
              value={displayInterval}
              onChange={(e) => handleIntervalChange(Number(e.target.value))}
              min={intervalUnit === 's' ? 1 : 1000}
              step={intervalUnit === 's' ? 1 : 100}
              className="flex-1 px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
              data-testid="trigger-interval-input"
            />
            <div className="flex border border-gray-300 rounded-lg overflow-hidden">
              <button
                onClick={() => setIntervalUnit('ms')}
                className={`px-2 py-1.5 text-[10px] font-medium transition-colors ${
                  intervalUnit === 'ms'
                    ? 'bg-cyan-50 text-cyan-700'
                    : 'bg-white text-gray-500 hover:bg-gray-50'
                }`}
                data-testid="interval-unit-ms"
              >
                ms
              </button>
              <button
                onClick={() => setIntervalUnit('s')}
                className={`px-2 py-1.5 text-[10px] font-medium transition-colors border-l border-gray-300 ${
                  intervalUnit === 's'
                    ? 'bg-cyan-50 text-cyan-700'
                    : 'bg-white text-gray-500 hover:bg-gray-50'
                }`}
                data-testid="interval-unit-s"
              >
                s
              </button>
            </div>
          </div>
          {(triggerInterval ?? 5000) < 1000 && (
            <p className="text-[10px] text-amber-600 mt-0.5">
              Minimum interval is 1000ms to prevent excessive execution.
            </p>
          )}
        </div>
      )}

      {/* event and load triggers need no additional configuration */}
    </div>
  );
};
