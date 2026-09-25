import React from 'react';
import { TagBrowser } from '../TagBrowser';
import { ExpressionBindingSection } from './ExpressionBindingSection';
import { Button, ColorInput, Input, colors, useI18n } from '@aquaculture/shared-ui';

interface WidgetConfigProps {
  config: Record<string, any>;
  onChange: (updates: Record<string, any>) => void;
  deviceId?: string | null;
}

export const GaugeConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
  const { t } = useI18n();
  const zones: { min: number; max: number; color: string }[] = config.zones || [];

  const addZone = () => {
    onChange({ zones: [...zones, { min: 0, max: 100, color: colors.success[500] }] });
  };

  const updateZone = (index: number, field: string, value: any) => {
    const updated = zones.map((z, i) => (i === index ? { ...z, [field]: value } : z));
    onChange({ zones: updated });
  };

  const removeZone = (index: number) => {
    onChange({ zones: zones.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Tag</label>
        <TagBrowser
          deviceId={deviceId || null}
          value={config.tagName || ''}
          onChange={(tagName) => onChange({ tagName })}
          placeholder="Select tag..."
        />
      </div>

      {/*
       * Expression binding allows computed gauge values (e.g., unit conversion,
       * averaging, threshold detection) without server-side tag configuration.
       * The expression result feeds into the gauge's value display.
       */}
      <ExpressionBindingSection
        expression={config.expression as string | undefined}
        onChange={(expr) => onChange({ expression: expr })}
        deviceId={deviceId}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Input
          label="Min"
          fullWidth
          type="number"
          value={config.min ?? 0}
          onChange={(e) => onChange({ min: Number(e.target.value) })}
        />
        <Input
          label="Max"
          fullWidth
          type="number"
          value={config.max ?? 100}
          onChange={(e) => onChange({ max: Number(e.target.value) })}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Input
          label="Unit"
          fullWidth
          type="text"
          value={config.unit || ''}
          onChange={(e) => onChange({ unit: e.target.value })}
          placeholder="°C"
        />
        <Input
          label="Decimals"
          fullWidth
          type="number"
          min={0}
          max={6}
          value={config.decimals ?? 1}
          onChange={(e) => onChange({ decimals: Number(e.target.value) })}
        />
      </div>

      <div className="pt-2 border-t border-gray-100 dark:border-gray-700">
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-gray-500 dark:text-gray-400 font-medium">Zones</label>
          <Button variant="ghost" size="xs" onClick={addZone}>
            + Add Zone
          </Button>
        </div>
        <div className="space-y-2">
          {zones.map((zone, i) => (
            <div key={i} className="flex items-center gap-1">
              <Input
                type="number"
                value={zone.min}
                onChange={(e) => updateZone(i, 'min', Number(e.target.value))}
                placeholder="Min"
              />
              <Input
                type="number"
                value={zone.max}
                onChange={(e) => updateZone(i, 'max', Number(e.target.value))}
                placeholder="Max"
              />
              <ColorInput
                aria-label={t('scada.color.zone')}
                variant="swatch"
                value={zone.color}
                onChange={(e) => updateZone(i, 'color', e.target.value)}
              />
              <Button variant="ghost" size="xs" onClick={() => removeZone(i)}>
                X
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
