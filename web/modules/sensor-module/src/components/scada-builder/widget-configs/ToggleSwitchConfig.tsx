import React from 'react';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
}

export const ToggleSwitchConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Tag</label>
        <input
          type="text"
          value={config.tag || ''}
          onChange={(e) => onChange({ tag: e.target.value })}
          placeholder="pump.control"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Label</label>
        <input
          type="text"
          value={config.label || ''}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Pompa Kontrol"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 mb-1">ON Label</label>
          <input
            type="text"
            value={config.onLabel || ''}
            onChange={(e) => onChange({ onLabel: e.target.value })}
            placeholder="Ac"
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">OFF Label</label>
          <input
            type="text"
            value={config.offLabel || ''}
            onChange={(e) => onChange({ offLabel: e.target.value })}
            placeholder="Kapat"
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        </div>
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Guvenlik Seviyesi</label>
        <select
          value={config.security || 'none'}
          onChange={(e) => onChange({ security: e.target.value })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        >
          <option value="none">Yok</option>
          <option value="confirm">Onay Gerekli</option>
          <option value="pin">PIN Gerekli</option>
        </select>
      </div>
    </div>
  );
};
