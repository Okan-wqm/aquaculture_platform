import React from 'react';
import { colors, Input, Select } from '@aquaculture/shared-ui';

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

export const PipeFlowConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => (
  <div className="space-y-3">
    <div>
      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Direction</label>
      <Select fullWidth options={[{ value: 'horizontal', label: 'Horizontal' }, { value: 'vertical', label: 'Vertical' }]} value={(config.direction as string) || 'horizontal'} onChange={(e) => onChange({ direction: e.target.value })} />
    </div>
    <div>
      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Flow Direction</label>
      <Select fullWidth options={[{ value: 'forward', label: 'Forward' }, { value: 'reverse', label: 'Reverse' }]} value={(config.flowDirection as string) || 'forward'} onChange={(e) => onChange({ flowDirection: e.target.value })} />
    </div>
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Pipe Color</label>
        <input type="color" value={(config.pipeColor as string) || colors.gray[400]}
          onChange={(e) => onChange({ pipeColor: e.target.value })}
          className="w-full h-8 rounded border border-gray-300 dark:border-gray-600 cursor-pointer" />
      </div>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Flow Color</label>
        <input type="color" value={(config.flowColor as string) || colors.info[500]}
          onChange={(e) => onChange({ flowColor: e.target.value })}
          className="w-full h-8 rounded border border-gray-300 dark:border-gray-600 cursor-pointer" />
      </div>
    </div>
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Pipe Width</label>
        <Input fullWidth type="number" min={4} max={32} value={(config.pipeWidth as number) || 12} onChange={(e) => onChange({ pipeWidth: Number(e.target.value) })} />
      </div>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Flow Speed (s)</label>
        <Input fullWidth type="number" min={0.1} max={5} step={0.1} value={(config.flowSpeed as number) || 0.6} onChange={(e) => onChange({ flowSpeed: Number(e.target.value) })} />
      </div>
    </div>
  </div>
);
