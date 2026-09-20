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
import {
  Button,
  Checkbox,
  ColorInput,
  colors as themeColors,
  Input,
  NumberInput,
  Select,
} from '@aquaculture/shared-ui';

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
  'w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500 focus:border-info-500';

const SMALL_INPUT_CLASS =
  'w-full px-2 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-md focus:ring-2 focus:ring-info-500 focus:border-info-500';

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const MapViewConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  const title = (config.title ?? 'Site Map') as string;
  const bgColor = (config.bgColor ?? themeColors.primary[700]) as string;
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
      updateMarkers(markers.map((m) => (m.id === id ? { ...m, [field]: value } : m)));
    },
    [markers, updateMarkers],
  );

  return (
    <div className="space-y-3">
      {/* Title */}
      <Input
        label="Title"
        value={title}
        onChange={(e) => onChange({ title: e.target.value })}
        placeholder="Site Map"
      />

      {/* Background Color */}
      <div>
        <label
          htmlFor="map-view-bg-color"
          className="block text-xs text-gray-500 dark:text-gray-400 mb-1"
        >
          Background Color
        </label>
        <div className="flex items-center gap-2">
          <ColorInput
            id="map-view-bg-color"
            variant="swatch"
            value={bgColor}
            onChange={(e) => onChange({ bgColor: e.target.value })}
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
      <Checkbox
        label="Show grid lines"
        checked={showGrid}
        onChange={(e) => onChange({ showGrid: e.target.checked })}
      />

      {/* Markers */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-gray-500 dark:text-gray-400 font-medium">
            Device Markers
          </label>
          <button
            type="button"
            onClick={addMarker}
            className="flex items-center gap-1 px-2 py-1 text-xs text-info-700 dark:text-info-300 bg-info-50 dark:bg-info-900/20 rounded-md hover:bg-info-100 dark:hover:bg-info-900/50 transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add
          </button>
        </div>

        {markers.length === 0 && (
          <p className="text-[10px] text-gray-400 dark:text-gray-500 italic">
            No markers yet. Click &quot;Add&quot; to place a device on the map.
          </p>
        )}

        <div className="space-y-2 max-h-64 overflow-y-auto">
          {markers.map((marker, idx) => (
            <div
              key={marker.id}
              className="border border-gray-200 dark:border-gray-700 rounded-lg p-2 bg-gray-50 dark:bg-gray-800 space-y-1.5"
            >
              {/* Header row */}
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium text-gray-400 dark:text-gray-500">
                  #{idx + 1}
                </span>
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label="Remove marker"
                  type="button"
                  onClick={() => removeMarker(marker.id)}
                  title="Remove marker"
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>

              {/* Label */}
              <Input
                label="Label"
                value={marker.label}
                onChange={(e) => updateMarker(marker.id, 'label', e.target.value)}
                placeholder="Device name"
              />

              {/* X / Y coordinates */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                <NumberInput
                  label="X (0-100)"
                  min={0}
                  max={100}
                  value={marker.x}
                  onChange={(e) =>
                    updateMarker(marker.id, 'x', Math.min(100, Math.max(0, Number(e.target.value))))
                  }
                />
                <NumberInput
                  label="Y (0-100)"
                  min={0}
                  max={100}
                  value={marker.y}
                  onChange={(e) =>
                    updateMarker(marker.id, 'y', Math.min(100, Math.max(0, Number(e.target.value))))
                  }
                />
              </div>

              {/* Status */}
              <Select
                label="Status"
                value={marker.status}
                onChange={(e) => updateMarker(marker.id, 'status', e.target.value)}
                options={STATUS_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
              />

              {/* Tag Name (optional) */}
              <div>
                <label className="block text-[10px] text-gray-400 dark:text-gray-500 mb-0.5">
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
