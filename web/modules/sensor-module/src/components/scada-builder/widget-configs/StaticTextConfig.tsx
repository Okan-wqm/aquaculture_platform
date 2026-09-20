import React from 'react';
import { AlignLeft, AlignCenter, AlignRight } from 'lucide-react';
import {
  ColorInput,
  colors as themeColors,
  Input,
  Select,
  Textarea,
  ToggleButton,
  useI18n,
} from '@aquaculture/shared-ui';

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
  const { t } = useI18n();
  const hasBg = !!config.backgroundColor && config.backgroundColor !== 'transparent';

  return (
    <div className="space-y-3">
      {/* ── Typography ── */}
      <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
        Typography
      </div>

      {/* Text */}
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Text</label>
        <Textarea
          className="resize-none"
          fullWidth
          rows={3}
          value={config.text || ''}
          onChange={(e) => onChange({ text: e.target.value })}
          placeholder="Text"
        />
      </div>

      {/* Font Size & Weight */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Font Size</label>
          <Input
            fullWidth
            type="number"
            min={8}
            max={72}
            value={config.fontSize ?? 14}
            onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Weight</label>
          <Select
            fullWidth
            options={[
              { value: 'light', label: 'Light' },
              { value: 'normal', label: 'Normal' },
              { value: 'bold', label: 'Bold' },
            ]}
            value={config.fontWeight || 'normal'}
            onChange={(e) => onChange({ fontWeight: e.target.value })}
          />
        </div>
      </div>

      {/* Text Align */}
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
          Horizontal Alignment
        </label>
        <div className="flex gap-1">
          {ALIGN_OPTIONS.map(({ value, icon: Icon }) => (
            <ToggleButton
              aria-label={`${t('a11y.textAlign')} ${value}`}
              key={value}
              type="button"
              onClick={() => onChange({ textAlign: value })}
              pressed={(config.textAlign || 'left') === value}
              className="flex-1 flex items-center justify-center py-2 rounded-lg border text-sm transition-colors"
              pressedClassName="border-info-500 bg-info-50 dark:bg-info-900/20 text-info-700 dark:text-info-300"
              idleClassName="border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              <Icon size={16} />
            </ToggleButton>
          ))}
        </div>
      </div>

      {/* Vertical Align */}
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
          Vertical Alignment
        </label>
        <Select
          fullWidth
          options={[
            { value: 'top', label: 'Top' },
            { value: 'middle', label: 'Middle' },
            { value: 'bottom', label: 'Bottom' },
          ]}
          value={config.verticalAlign || 'middle'}
          onChange={(e) => onChange({ verticalAlign: e.target.value })}
        />
      </div>

      {/* ── Appearance ── */}
      <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide pt-1">
        Appearance
      </div>

      {/* Text Color */}
      <ColorInput
        label="Text Color"
        value={config.color || themeColors.neutral[800]}
        onChange={(e) => onChange({ color: e.target.value })}
      />

      {/* Background Color */}
      <div>
        <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 mb-1">
          <input
            type="checkbox"
            checked={hasBg}
            onChange={(e) =>
              onChange({ backgroundColor: e.target.checked ? themeColors.white : 'transparent' })
            }
            className="rounded border-gray-300 dark:border-gray-600 text-info-600 focus:ring-info-500"
          />
          Background
        </label>
        {hasBg && (
          <ColorInput
            aria-label={t('scada.color.background')}
            value={config.backgroundColor || themeColors.white}
            onChange={(e) => onChange({ backgroundColor: e.target.value })}
          />
        )}
      </div>

      {/* Border */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
            Border Width
          </label>
          <Input
            fullWidth
            type="number"
            min={0}
            max={5}
            value={config.borderWidth ?? 0}
            onChange={(e) => onChange({ borderWidth: Number(e.target.value) })}
          />
        </div>
        <ColorInput
          label="Border Color"
          value={config.borderColor || themeColors.neutral[300]}
          onChange={(e) => onChange({ borderColor: e.target.value })}
        />
      </div>

      {/* Padding */}
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Padding (px)</label>
        <Input
          fullWidth
          type="number"
          min={0}
          max={32}
          value={config.padding ?? 8}
          onChange={(e) => onChange({ padding: Number(e.target.value) })}
        />
      </div>
    </div>
  );
};
