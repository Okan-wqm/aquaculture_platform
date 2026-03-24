/**
 * CustomSvgConfig - Properties panel for the Custom SVG import widget
 *
 * Allows the user to upload a `.svg` file, displays the current file name,
 * and provides a remove button. Also exposes an optional label field.
 */

import React, { useCallback, useRef } from 'react';
import { Upload, Trash2 } from 'lucide-react';

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

export const CustomSvgConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasSvg = Boolean(config.svgContent);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !file.name.endsWith('.svg')) return;
    const text = await file.text();
    // Extract viewBox dimensions if available
    const vbMatch = text.match(/viewBox\s*=\s*["']([^"']+)["']/);
    const updates: Record<string, unknown> = { svgContent: text, svgFileName: file.name };
    if (vbMatch) {
      updates.svgViewBox = vbMatch[1];
    }
    onChange(updates);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [onChange]);

  const handleRemove = useCallback(() => {
    onChange({ svgContent: undefined, svgFileName: undefined, svgViewBox: undefined });
  }, [onChange]);

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 mb-1">SVG File</label>
        {hasSvg ? (
          <div className="flex items-center justify-between px-3 py-2 bg-green-50 border border-green-200 rounded-lg">
            <span className="text-xs text-green-700 truncate">
              {(config.svgFileName as string) || 'custom.svg'}
            </span>
            <button onClick={handleRemove} className="text-red-400 hover:text-red-600 ml-2">
              <Trash2 size={14} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full flex items-center justify-center gap-2 px-3 py-3 border-2 border-dashed border-gray-300 rounded-lg text-xs text-gray-500 hover:border-cyan-400 hover:text-cyan-600 transition-colors"
          >
            <Upload size={14} />
            Upload SVG
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".svg"
          className="hidden"
          onChange={handleFileSelect}
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Label</label>
        <input
          type="text"
          value={(config.label as string) || ''}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Optional label"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>
    </div>
  );
};
