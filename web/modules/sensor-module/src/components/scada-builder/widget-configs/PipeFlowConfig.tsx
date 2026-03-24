import React from 'react';

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

export const PipeFlowConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => (
  <div className="space-y-3">
    <div>
      <label className="block text-xs text-gray-500 mb-1">Direction</label>
      <select value={(config.direction as string) || 'horizontal'} onChange={(e) => onChange({ direction: e.target.value })}
        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500">
        <option value="horizontal">Horizontal</option>
        <option value="vertical">Vertical</option>
      </select>
    </div>
    <div>
      <label className="block text-xs text-gray-500 mb-1">Flow Direction</label>
      <select value={(config.flowDirection as string) || 'forward'} onChange={(e) => onChange({ flowDirection: e.target.value })}
        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500">
        <option value="forward">Forward</option>
        <option value="reverse">Reverse</option>
      </select>
    </div>
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Pipe Color</label>
        <input type="color" value={(config.pipeColor as string) || '#6b7280'}
          onChange={(e) => onChange({ pipeColor: e.target.value })}
          className="w-full h-8 rounded border border-gray-300 cursor-pointer" />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Flow Color</label>
        <input type="color" value={(config.flowColor as string) || '#3b82f6'}
          onChange={(e) => onChange({ flowColor: e.target.value })}
          className="w-full h-8 rounded border border-gray-300 cursor-pointer" />
      </div>
    </div>
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Pipe Width</label>
        <input type="number" min={4} max={32} value={(config.pipeWidth as number) || 12}
          onChange={(e) => onChange({ pipeWidth: Number(e.target.value) })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg" />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Flow Speed (s)</label>
        <input type="number" min={0.1} max={5} step={0.1} value={(config.flowSpeed as number) || 0.6}
          onChange={(e) => onChange({ flowSpeed: Number(e.target.value) })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg" />
      </div>
    </div>
  </div>
);
