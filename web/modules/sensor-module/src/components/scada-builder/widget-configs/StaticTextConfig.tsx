import React from 'react';
import { AlignLeft, AlignCenter, AlignRight } from 'lucide-react';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
  deviceId?: string | null;
}

const ALIGN_OPTIONS = [
  { value: 'left', icon: AlignLeft },
  { value: 'center', icon: AlignCenter },
  { value: 'right', icon: AlignRight },
] as const;

export const StaticTextConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  const hasBg = !!config.backgroundColor && config.backgroundColor !== 'transparent';

  return (
    <div className="space-y-3">
      {/* ── Tipografi ── */}
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Tipografi</div>

      {/* Text */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Metin</label>
        <textarea
          rows={3}
          value={config.text || ''}
          onChange={(e) => onChange({ text: e.target.value })}
          placeholder="Metin"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 resize-none"
        />
      </div>

      {/* Font Size & Weight */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Yazi Boyutu</label>
          <input
            type="number"
            min={8}
            max={72}
            value={config.fontSize ?? 14}
            onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Kalinlik</label>
          <select
            value={config.fontWeight || 'normal'}
            onChange={(e) => onChange({ fontWeight: e.target.value })}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          >
            <option value="light">Ince</option>
            <option value="normal">Normal</option>
            <option value="bold">Kalin</option>
          </select>
        </div>
      </div>

      {/* Text Align */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Yatay Hizalama</label>
        <div className="flex gap-1">
          {ALIGN_OPTIONS.map(({ value, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => onChange({ textAlign: value })}
              className={`flex-1 flex items-center justify-center py-2 rounded-lg border text-sm transition-colors ${
                (config.textAlign || 'left') === value
                  ? 'border-cyan-500 bg-cyan-50 text-cyan-700'
                  : 'border-gray-300 bg-white text-gray-500 hover:bg-gray-50'
              }`}
            >
              <Icon size={16} />
            </button>
          ))}
        </div>
      </div>

      {/* Vertical Align */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Dikey Hizalama</label>
        <select
          value={config.verticalAlign || 'middle'}
          onChange={(e) => onChange({ verticalAlign: e.target.value })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        >
          <option value="top">Ust</option>
          <option value="middle">Orta</option>
          <option value="bottom">Alt</option>
        </select>
      </div>

      {/* ── Görünüm ── */}
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide pt-1">Gorunum</div>

      {/* Text Color */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Yazi Rengi</label>
        <input
          type="color"
          value={config.color || '#1f2937'}
          onChange={(e) => onChange({ color: e.target.value })}
          className="w-full h-8 rounded-lg border border-gray-300 cursor-pointer"
        />
      </div>

      {/* Background Color */}
      <div>
        <label className="flex items-center gap-2 text-xs text-gray-500 mb-1">
          <input
            type="checkbox"
            checked={hasBg}
            onChange={(e) =>
              onChange({ backgroundColor: e.target.checked ? '#ffffff' : 'transparent' })
            }
            className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
          />
          Arka Plan
        </label>
        {hasBg && (
          <input
            type="color"
            value={config.backgroundColor || '#ffffff'}
            onChange={(e) => onChange({ backgroundColor: e.target.value })}
            className="w-full h-8 rounded-lg border border-gray-300 cursor-pointer"
          />
        )}
      </div>

      {/* Border */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Kenarlık Kalinligi</label>
          <input
            type="number"
            min={0}
            max={5}
            value={config.borderWidth ?? 0}
            onChange={(e) => onChange({ borderWidth: Number(e.target.value) })}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Kenarlık Rengi</label>
          <input
            type="color"
            value={config.borderColor || '#d1d5db'}
            onChange={(e) => onChange({ borderColor: e.target.value })}
            className="w-full h-8 rounded-lg border border-gray-300 cursor-pointer"
          />
        </div>
      </div>

      {/* Padding */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Ic Bosluk (px)</label>
        <input
          type="number"
          min={0}
          max={32}
          value={config.padding ?? 8}
          onChange={(e) => onChange({ padding: Number(e.target.value) })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>
    </div>
  );
};
