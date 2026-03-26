/**
 * IFrameConfig - Configuration panel for the IFrame widget.
 *
 * Provides URL input with real-time validation (https-only enforcement),
 * sandbox permission toggles, and visual styling options. The URL is
 * validated on every keystroke to give immediate feedback about blocked
 * protocols or invalid formats.
 *
 * Security: The config panel itself prevents users from entering
 * javascript:, data:, or other dangerous protocol URLs. The renderer
 * double-checks at render-time as a defense-in-depth measure.
 */

import React, { useMemo } from 'react';
import { validateIFrameUrl } from '../widget-renderers/IFrameRenderer';

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

const INPUT_CLS = 'w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500';

export const IFrameConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  const url = (config.url ?? '') as string;
  const borderRadius = (config.borderRadius ?? 0) as number;
  const showBorder = (config.showBorder ?? true) as boolean;
  const label = (config.label ?? '') as string;
  const allowScripts = (config.allowScripts ?? false) as boolean;
  const allowForms = (config.allowForms ?? false) as boolean;
  const allowPopups = (config.allowPopups ?? false) as boolean;
  const allowSameOrigin = (config.allowSameOrigin ?? false) as boolean;

  // Real-time URL validation feedback
  const urlError = useMemo(() => {
    if (!url.trim()) return null; // Don't show error for empty field
    return validateIFrameUrl(url);
  }, [url]);

  return (
    <div className="space-y-3">
      {/* URL */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">URL (https only)</label>
        <input
          type="text"
          value={url}
          onChange={(e) => onChange({ url: e.target.value })}
          placeholder="https://example.com/dashboard"
          className={`${INPUT_CLS} ${urlError ? 'border-red-400 focus:ring-red-400 focus:border-red-400' : ''}`}
        />
        {urlError && (
          <p className="text-xs text-red-500 mt-1">{urlError}</p>
        )}
      </div>

      {/* Label */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Label</label>
        <input
          type="text"
          value={label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="External Dashboard"
          className={INPUT_CLS}
        />
      </div>

      {/* Sandbox Permissions */}
      <div className="pt-2 border-t border-gray-100">
        <label className="text-xs text-gray-500 font-medium mb-2 block">Sandbox Permissions</label>
        <p className="text-[10px] text-gray-400 mb-2">
          The iframe is sandboxed by default. Enable permissions only when needed.
        </p>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={allowScripts}
              onChange={(e) => onChange({ allowScripts: e.target.checked })}
              className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
            />
            Allow Scripts
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={allowForms}
              onChange={(e) => onChange({ allowForms: e.target.checked })}
              className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
            />
            Allow Forms
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={allowPopups}
              onChange={(e) => onChange({ allowPopups: e.target.checked })}
              className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
            />
            Allow Popups
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={allowSameOrigin}
              onChange={(e) => onChange({ allowSameOrigin: e.target.checked })}
              className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
            />
            Allow Same Origin
            <span className="text-[10px] text-amber-600">(security risk)</span>
          </label>
        </div>
      </div>

      {/* Visual styling */}
      <div className="pt-2 border-t border-gray-100">
        <label className="text-xs text-gray-500 font-medium mb-2 block">Appearance</label>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Border Radius</label>
            <input
              type="number"
              min={0}
              max={32}
              value={borderRadius}
              onChange={(e) => onChange({ borderRadius: Number(e.target.value) })}
              className={INPUT_CLS}
            />
          </div>
        </div>
        <div className="mt-2">
          <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={showBorder}
              onChange={(e) => onChange({ showBorder: e.target.checked })}
              className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
            />
            Show Border
          </label>
        </div>
      </div>
    </div>
  );
};
