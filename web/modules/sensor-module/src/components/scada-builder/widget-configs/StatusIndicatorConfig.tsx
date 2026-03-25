import React from 'react';
import { TagBrowser } from '../TagBrowser';
import { RangeColorMapping } from './RangeColorMapping';
import type { ColorRange } from '../../../engine/animation/types';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
  deviceId?: string | null;
}

export const StatusIndicatorConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Tag</label>
        <TagBrowser
          deviceId={deviceId || null}
          value={config.tagName || ''}
          onChange={(tagName) => onChange({ tagName })}
          placeholder="Select tag..."
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Label</label>
        <input
          type="text"
          value={config.label || ''}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Pump Status"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Active Color</label>
          <div className="flex gap-1">
            {[
              { label: 'Green', value: '#22c55e' },
              { label: 'Red', value: '#ef4444' },
              { label: 'Yellow', value: '#eab308' },
              { label: 'Blue', value: '#3b82f6' },
              { label: 'Orange', value: '#f97316' },
            ].map((c) => (
              <button
                key={c.value}
                type="button"
                title={c.label}
                onClick={() => onChange({ activeColor: c.value })}
                style={{
                  width: 24, height: 24, borderRadius: '50%', background: c.value, border: config.activeColor === c.value ? '2px solid #111' : '2px solid transparent',
                  cursor: 'pointer',
                }}
              />
            ))}
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Inactive Color</label>
          <div className="flex gap-1">
            {[
              { label: 'Gray', value: '#9ca3af' },
              { label: 'Dark Gray', value: '#4b5563' },
              { label: 'Red', value: '#ef4444' },
            ].map((c) => (
              <button
                key={c.value}
                type="button"
                title={c.label}
                onClick={() => onChange({ inactiveColor: c.value })}
                style={{
                  width: 24, height: 24, borderRadius: '50%', background: c.value, border: config.inactiveColor === c.value ? '2px solid #111' : '2px solid transparent',
                  cursor: 'pointer',
                }}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 mb-1">ON Label</label>
          <input
            type="text"
            value={config.onLabel || ''}
            onChange={(e) => onChange({ onLabel: e.target.value })}
            placeholder="Running"
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">OFF Label</label>
          <input
            type="text"
            value={config.offLabel || ''}
            onChange={(e) => onChange({ offLabel: e.target.value })}
            placeholder="Stopped"
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        </div>
      </div>

      {/* Value-driven color ranges for analog tag values */}
      <div className="pt-2 border-t border-gray-100">
        <RangeColorMapping
          ranges={(config.colorRanges as ColorRange[]) || []}
          onChange={(colorRanges) => onChange({ colorRanges })}
          showLabel
          maxRanges={8}
        />
      </div>
    </div>
  );
};
