import React from 'react';
import { Checkbox, Input, Select } from '@aquaculture/shared-ui';

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
      <Input
        label="Stream URL"
        fullWidth
        type="text"
        value={streamUrl}
        onChange={(e) => onChange({ streamUrl: e.target.value })}
        placeholder="http://192.168.1.100/mjpg/video.mjpg"
      />

      {/* Stream Mode */}
      <Select
        label="Stream Mode"
        value={streamMode}
        onChange={(e) => onChange({ streamMode: e.target.value })}
        options={STREAM_MODE_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
      />

      {/* Refresh Interval (Image mode only) */}
      {streamMode === 'image' && (
        <Input
          label="Refresh Interval (seconds)"
          fullWidth
          type="number"
          min={1}
          max={300}
          value={refreshInterval}
          onChange={(e) => onChange({ refreshInterval: Math.max(1, Number(e.target.value)) })}
        />
      )}

      {/* Label */}
      <Input
        label="Label"
        fullWidth
        type="text"
        value={label}
        onChange={(e) => onChange({ label: e.target.value })}
        placeholder="Camera 1"
      />

      {/* Show Controls (HLS mode only) */}
      {streamMode === 'hls' && (
        <Checkbox
          label="Show video controls"
          checked={showControls}
          onChange={(e) => onChange({ showControls: e.target.checked })}
        />
      )}

      {/* HLS info note */}
      {streamMode === 'hls' && (
        <p className="text-[10px] text-gray-400 dark:text-gray-500 italic">
          Native HLS playback is supported in Safari. For Chrome/Firefox, an HLS.js library is
          required at the application level.
        </p>
      )}
    </div>
  );
};
