import React from 'react';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
}

export const PushButtonConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Tag</label>
        <input
          type="text"
          value={config.tag || ''}
          onChange={(e) => onChange({ tag: e.target.value })}
          placeholder="command.start"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Label</label>
        <input
          type="text"
          value={config.label || ''}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Baslat"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Gonderilecek Deger</label>
        <input
          type="text"
          value={config.value ?? ''}
          onChange={(e) => onChange({ value: e.target.value })}
          placeholder="1"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
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
