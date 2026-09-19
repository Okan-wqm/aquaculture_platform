import React from 'react';
import { useScadaPackageStore } from '../../../store/scada';
import { colors, Input, Select } from '@aquaculture/shared-ui';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
  deviceId?: string | null;
}

const SCREEN_TYPE_ICONS: Record<string, string> = {
  dashboard: 'LayoutDashboard',
  process: 'Workflow',
  alarms: 'AlertTriangle',
  trends: 'TrendingUp',
  calibration: 'Settings2',
  control: 'Gauge',
};

export const ScreenLinkConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  const screens = useScadaPackageStore((s) => s.screens);

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Target Screen</label>
        <select
          value={config.targetScreenId || ''}
          onChange={(e) => onChange({ targetScreenId: e.target.value || undefined })}
          className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        >
          <option value="">Select screen...</option>
          {screens.map((screen) => (
            <option key={screen.id} value={screen.id}>
              {SCREEN_TYPE_ICONS[screen.screenType] ? `[${screen.screenType}] ` : ''}
              {screen.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Label</label>
        <Input
          fullWidth
          type="text"
          value={config.label || ''}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Go to Screen"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Display Style</label>
        <Select
          fullWidth
          options={[
            { value: 'card', label: 'Card' },
            { value: 'button', label: 'Button' },
            { value: 'minimal', label: 'Minimal' },
          ]}
          value={config.style || 'card'}
          onChange={(e) => onChange({ style: e.target.value })}
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Color</label>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={config.color || colors.primary[400]}
            onChange={(e) => onChange({ color: e.target.value })}
            className="w-8 h-8 rounded border border-gray-300 dark:border-gray-600 cursor-pointer"
          />
          <Input
            type="text"
            value={config.color || colors.primary[400]}
            onChange={(e) => onChange({ color: e.target.value })}
            placeholder={colors.primary[400]}
          />
        </div>
      </div>
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Icon</label>
        <Select
          fullWidth
          options={[
            { value: 'ArrowRight', label: 'Arrow (ArrowRight)' },
            { value: 'ExternalLink', label: 'External Link (ExternalLink)' },
            { value: 'Monitor', label: 'Screen (Monitor)' },
          ]}
          value={config.icon || 'ArrowRight'}
          onChange={(e) => onChange({ icon: e.target.value })}
        />
      </div>
    </div>
  );
};
