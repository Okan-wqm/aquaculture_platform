/**
 * MapViewConfig - Configuration panel for the Map View widget.
 *
 * Allows editing:
 * - Title text
 * - Background color
 * - Show grid toggle
 * - List of device markers (label, x, y, status, tagName)
 */

import React, { useCallback } from 'react';
import { Plus, Trash2 } from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type DeviceStatus = 'online' | 'offline' | 'unknown';

interface DeviceMarker {
  id: string;
  label: string;
  x: number;
  y: number;
  status: DeviceStatus;
  tagName?: string;
}

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const STATUS_OPTIONS: { value: DeviceStatus; label: string }[] = [
  { value: 'online', label: 'Online' },
  { value: 'offline', label: 'Offline' },
  { value: 'unknown', label: 'Unknown' },
];

const INPUT_CLASS =
  'w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500';

const SMALL_INPUT_CLASS =
  'w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500';

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const MapViewConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  const title = (config.title ?? 'Site Map') as string;
  const bgColor = (config.bgColor ?? '#0c4a6e') as string;
  const showGrid = (config.showGrid ?? true) as boolean;
  const markers = (config.markers ?? []) as DeviceMarker[];

  const updateMarkers = useCallback(
    (updated: DeviceMarker[]) => {
      onChange({ markers: updated });
    },
    [onChange],
  );

  const addMarker = useCallback(() => {
    const newMarker: DeviceMarker = {
      id: `marker-${Date.now()}`,
      label: `Device ${markers.length + 1}`,
      x: 50,
      y: 50,
      status: 'unknown',
    };
    updateMarkers([...markers, newMarker]);
  }, [markers, updateMarkers]);

  const removeMarker = useCallback(
    (id: string) => {
      updateMarkers(markers.filter((m) => m.id !== id));
    },
    [markers, updateMarkers],
  );

  const updateMarker = useCallback(
    (id: string, field: keyof DeviceMarker, value: string | number) => {
      updateMarkers(
        markers.map((m) => (m.id === id ? { ...m, [field]: value } : m)),
      );
    },
    [markers, updateMarkers],
  );

  return (
    <div className="space-y-3">
      {/* Title */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder="Site Map"
          className={INPUT_CLASS}
        />
      </div>

      {/* Background Color */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Background Color</label>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={bgColor}
            onChange={(e) => onChange({ bgColor: e.target.value })}
            className="w-8 h-8 rounded border border-gray-300 cursor-pointer"
          />
          <input
            type="text"
            value={bgColor}
            onChange={(e) => onChange({ bgColor: e.target.value })}
            className={INPUT_CLASS}
          />
        </div>
      </div>

      {/* Show Grid */}
      <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
        <input
          type="checkbox"
          checked={showGrid}
          onChange={(e) => onChange({ showGrid: e.target.checked })}
          className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
        />
        Show grid lines
      </label>

      {/* Markers */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-gray-500 font-medium">Device Markers</label>
          <button
            type="button"
            onClick={addMarker}
            className="flex items-center gap-1 px-2 py-1 text-xs text-cyan-700 bg-cyan-50 rounded-md hover:bg-cyan-100 transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add
          </button>
        </div>

        {markers.length === 0 && (
          <p className="text-[10px] text-gray-400 italic">
            No markers yet. Click &quot;Add&quot; to place a device on the map.
          </p>
        )}

        <div className="space-y-2 max-h-64 overflow-y-auto">
          {markers.map((marker, idx) => (
            <div
              key={marker.id}
              className="border border-gray-200 rounded-lg p-2 bg-gray-50 space-y-1.5"
            >
              {/* Header row */}
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium text-gray-400">
                  #{idx + 1}
                </span>
                <button
                  type="button"
                  onClick={() => removeMarker(marker.id)}
                  className="p-0.5 text-red-400 hover:text-red-600 transition-colors"
                  title="Remove marker"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>

              {/* Label */}
              <div>
                <label className="block text-[10px] text-gray-400 mb-0.5">Label</label>
                <input
                  type="text"
                  value={marker.label}
                  onChange={(e) => updateMarker(marker.id, 'label', e.target.value)}
                  placeholder="Device name"
                  className={SMALL_INPUT_CLASS}
                />
              </div>

              {/* X / Y coordinates */}
              <div className="grid grid-cols-2 gap-1.5">
                <div>
                  <label className="block text-[10px] text-gray-400 mb-0.5">X (0-100)</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={marker.x}
                    onChange={(e) =>
                      updateMarker(marker.id, 'x', Math.min(100, Math.max(0, Number(e.target.value))))
                    }
                    className={SMALL_INPUT_CLASS}
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-gray-400 mb-0.5">Y (0-100)</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={marker.y}
                    onChange={(e) =>
                      updateMarker(marker.id, 'y', Math.min(100, Math.max(0, Number(e.target.value))))
                    }
                    className={SMALL_INPUT_CLASS}
                  />
                </div>
              </div>

              {/* Status */}
              <div>
                <label className="block text-[10px] text-gray-400 mb-0.5">Status</label>
                <select
                  value={marker.status}
                  onChange={(e) => updateMarker(marker.id, 'status', e.target.value)}
                  className={SMALL_INPUT_CLASS}
                >
                  {STATUS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Tag Name (optional) */}
              <div>
                <label className="block text-[10px] text-gray-400 mb-0.5">
                  Tag Name <span className="text-gray-300">(optional)</span>
                </label>
                <input
                  type="text"
                  value={marker.tagName ?? ''}
                  onChange={(e) => updateMarker(marker.id, 'tagName', e.target.value)}
                  placeholder="e.g. sensor.ph.pond1"
                  className={SMALL_INPUT_CLASS}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
