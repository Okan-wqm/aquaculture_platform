import React from 'react';

type StreamMode = 'mjpeg' | 'hls' | 'image';

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

const STREAM_MODE_OPTIONS: { value: StreamMode; label: string }[] = [
  { value: 'mjpeg', label: 'MJPEG' },
  { value: 'hls', label: 'HLS' },
  { value: 'image', label: 'Image (periodic refresh)' },
];

export const VideoStreamConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  const streamUrl = (config.streamUrl ?? '') as string;
  const streamMode = (config.streamMode ?? 'mjpeg') as StreamMode;
  const refreshInterval = (config.refreshInterval ?? 5) as number;
  const label = (config.label ?? '') as string;
  const showControls = (config.showControls ?? true) as boolean;

  return (
    <div className="space-y-3">
      {/* Stream URL */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Stream URL</label>
        <input
          type="text"
          value={streamUrl}
          onChange={(e) => onChange({ streamUrl: e.target.value })}
          placeholder="http://192.168.1.100/mjpg/video.mjpg"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>

      {/* Stream Mode */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Stream Mode</label>
        <select
          value={streamMode}
          onChange={(e) => onChange({ streamMode: e.target.value })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        >
          {STREAM_MODE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Refresh Interval (Image mode only) */}
      {streamMode === 'image' && (
        <div>
          <label className="block text-xs text-gray-500 mb-1">Refresh Interval (seconds)</label>
          <input
            type="number"
            min={1}
            max={300}
            value={refreshInterval}
            onChange={(e) => onChange({ refreshInterval: Math.max(1, Number(e.target.value)) })}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        </div>
      )}

      {/* Label */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Label</label>
        <input
          type="text"
          value={label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Camera 1"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>

      {/* Show Controls (HLS mode only) */}
      {streamMode === 'hls' && (
        <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={showControls}
            onChange={(e) => onChange({ showControls: e.target.checked })}
            className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
          />
          Show video controls
        </label>
      )}

      {/* HLS info note */}
      {streamMode === 'hls' && (
        <p className="text-[10px] text-gray-400 italic">
          Native HLS playback is supported in Safari. For Chrome/Firefox, an HLS.js library is required at the application level.
        </p>
      )}
    </div>
  );
};
