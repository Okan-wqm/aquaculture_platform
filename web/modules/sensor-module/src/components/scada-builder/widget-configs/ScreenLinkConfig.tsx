import React from 'react';
import { useScadaPackageStore } from '../../../store/scada';

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
        <label className="block text-xs text-gray-500 mb-1">Target Screen</label>
        <select
          value={config.targetScreenId || ''}
          onChange={(e) => onChange({ targetScreenId: e.target.value || undefined })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
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
        <label className="block text-xs text-gray-500 mb-1">Label</label>
        <input
          type="text"
          value={config.label || ''}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Go to Screen"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Display Style</label>
        <select
          value={config.style || 'card'}
          onChange={(e) => onChange({ style: e.target.value })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        >
          <option value="card">Card</option>
          <option value="button">Button</option>
          <option value="minimal">Minimal</option>
        </select>
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Color</label>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={config.color || '#06b6d4'}
            onChange={(e) => onChange({ color: e.target.value })}
            className="w-8 h-8 rounded border border-gray-300 cursor-pointer"
          />
          <input
            type="text"
            value={config.color || '#06b6d4'}
            onChange={(e) => onChange({ color: e.target.value })}
            placeholder="#06b6d4"
            className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        </div>
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Icon</label>
        <select
          value={config.icon || 'ArrowRight'}
          onChange={(e) => onChange({ icon: e.target.value })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        >
          <option value="ArrowRight">Arrow (ArrowRight)</option>
          <option value="ExternalLink">External Link (ExternalLink)</option>
          <option value="Monitor">Screen (Monitor)</option>
        </select>
      </div>
    </div>
  );
};
