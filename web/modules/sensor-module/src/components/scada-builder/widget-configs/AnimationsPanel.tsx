/**
 * AnimationsPanel — UI for adding/editing/removing AnimationRule[] on a widget.
 *
 * Animation rules bind to device tags for real-time value-driven animations.
 * TagBrowser integration replaces error-prone manual tag name entry
 * with validated selection from the device's tag inventory.
 */

import React, { useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import type { AnimationRule, AnimationRuleType, AnimationOptions, ColorRange } from '../../../engine/animation/types';
import { TagBrowser } from '../TagBrowser';

const ANIMATION_TYPES: AnimationRuleType[] = [
  'colorRange',
  'rotate',
  'blink',
  'hide',
  'show',
  'fillLevel',
  'move',
];

interface AnimationsPanelProps {
  animations: AnimationRule[];
  onChange: (animations: AnimationRule[]) => void;
  /** Edge device ID for tag discovery via TagBrowser */
  deviceId?: string | null;
}

export const AnimationsPanel: React.FC<AnimationsPanelProps> = ({ animations, onChange, deviceId }) => {
  const [expandedBitmask, setExpandedBitmask] = useState<Record<string, boolean>>({});

  const addAnimation = () => {
    const newRule: AnimationRule = {
      id: crypto.randomUUID(),
      tagName: '',
      range: { min: 0, max: 100 },
      type: 'colorRange',
      options: {},
    };
    onChange([...animations, newRule]);
  };

  const updateAnimation = (id: string, updates: Partial<AnimationRule>) => {
    onChange(
      animations.map((anim) => (anim.id === id ? { ...anim, ...updates } : anim)),
    );
  };

  const updateAnimationOptions = (id: string, optionUpdates: Partial<AnimationOptions>) => {
    onChange(
      animations.map((anim) =>
        anim.id === id
          ? { ...anim, options: { ...anim.options, ...optionUpdates } }
          : anim,
      ),
    );
  };

  const removeAnimation = (id: string) => {
    onChange(animations.filter((anim) => anim.id !== id));
  };

  const handleTypeChange = (id: string, type: AnimationRuleType) => {
    // Reset options when type changes
    updateAnimation(id, { type, options: {} });
  };

  const toggleBitmask = (id: string) => {
    setExpandedBitmask((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // Color range helpers
  const addColorRange = (animId: string, currentRanges: ColorRange[]) => {
    const newRange: ColorRange = { min: 0, max: 100, fill: '#22c55e' };
    updateAnimationOptions(animId, { ranges: [...currentRanges, newRange] });
  };

  const updateColorRange = (animId: string, ranges: ColorRange[], index: number, field: keyof ColorRange, value: string | number) => {
    const updated = ranges.map((r, i) =>
      i === index ? { ...r, [field]: value } : r,
    );
    updateAnimationOptions(animId, { ranges: updated });
  };

  const removeColorRange = (animId: string, ranges: ColorRange[], index: number) => {
    updateAnimationOptions(animId, { ranges: ranges.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-700">Animations</h4>
        <button
          onClick={addAnimation}
          className="flex items-center gap-1 text-xs text-cyan-600 hover:text-cyan-700"
        >
          <Plus className="w-3 h-3" />
          Add Animation
        </button>
      </div>

      {animations.length === 0 && (
        <p className="text-xs text-gray-500 py-4 text-center">No animations configured.</p>
      )}

      {animations.map((anim) => (
        <div key={anim.id} className="p-3 bg-gray-50 rounded-lg space-y-2 border border-gray-100">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-gray-400 uppercase">Animation</span>
            <button
              onClick={() => removeAnimation(anim.id)}
              className="text-red-400 hover:text-red-600"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Tag Name — uses TagBrowser for validated device tag selection */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Tag Name</label>
            <TagBrowser
              deviceId={deviceId ?? null}
              value={anim.tagName}
              onChange={(tag) => updateAnimation(anim.id, { tagName: tag })}
              placeholder="Select tag..."
            />
          </div>

          {/* Range */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Range Min</label>
              <input
                type="number"
                value={anim.range.min}
                onChange={(e) => updateAnimation(anim.id, { range: { ...anim.range, min: Number(e.target.value) } })}
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Range Max</label>
              <input
                type="number"
                value={anim.range.max}
                onChange={(e) => updateAnimation(anim.id, { range: { ...anim.range, max: Number(e.target.value) } })}
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
              />
            </div>
          </div>

          {/* Type */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Type</label>
            <select
              value={anim.type}
              onChange={(e) => handleTypeChange(anim.id, e.target.value as AnimationRuleType)}
              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
            >
              {ANIMATION_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          {/* Conditional options based on type */}

          {/* rotate */}
          {anim.type === 'rotate' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Speed (ms)</label>
                <input
                  type="number"
                  value={anim.options.rotationSpeed ?? 2000}
                  onChange={(e) => updateAnimationOptions(anim.id, { rotationSpeed: Number(e.target.value) })}
                  min={100}
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Direction</label>
                <select
                  value={anim.options.direction ?? 'cw'}
                  onChange={(e) => updateAnimationOptions(anim.id, { direction: e.target.value as 'cw' | 'ccw' })}
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                >
                  <option value="cw">Clockwise</option>
                  <option value="ccw">Counter-CW</option>
                </select>
              </div>
            </div>
          )}

          {/* blink */}
          {anim.type === 'blink' && (
            <div className="space-y-2">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Interval (ms)</label>
                <input
                  type="number"
                  value={anim.options.blinkInterval ?? 1000}
                  onChange={(e) => updateAnimationOptions(anim.id, { blinkInterval: Number(e.target.value) })}
                  min={100}
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Color A</label>
                  <div className="flex items-center gap-1">
                    <input
                      type="color"
                      value={anim.options.fillA || '#ef4444'}
                      onChange={(e) => updateAnimationOptions(anim.id, { fillA: e.target.value })}
                      className="w-8 h-7 border border-gray-300 rounded cursor-pointer"
                    />
                    <input
                      type="text"
                      value={anim.options.fillA || '#ef4444'}
                      onChange={(e) => updateAnimationOptions(anim.id, { fillA: e.target.value })}
                      className="flex-1 px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Color B</label>
                  <div className="flex items-center gap-1">
                    <input
                      type="color"
                      value={anim.options.fillB || '#22c55e'}
                      onChange={(e) => updateAnimationOptions(anim.id, { fillB: e.target.value })}
                      className="w-8 h-7 border border-gray-300 rounded cursor-pointer"
                    />
                    <input
                      type="text"
                      value={anim.options.fillB || '#22c55e'}
                      onChange={(e) => updateAnimationOptions(anim.id, { fillB: e.target.value })}
                      className="flex-1 px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* colorRange */}
          {anim.type === 'colorRange' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs text-gray-500 font-medium">Color Ranges</label>
                <button
                  onClick={() => addColorRange(anim.id, anim.options.ranges ?? [])}
                  className="text-xs text-cyan-600 hover:text-cyan-700"
                >
                  + Add Range
                </button>
              </div>
              {(anim.options.ranges ?? []).map((cr, idx) => (
                <div key={idx} className="flex items-center gap-1">
                  <input
                    type="number"
                    value={cr.min}
                    onChange={(e) => updateColorRange(anim.id, anim.options.ranges ?? [], idx, 'min', Number(e.target.value))}
                    className="w-14 px-2 py-1 text-xs border border-gray-300 rounded"
                    placeholder="Min"
                  />
                  <input
                    type="number"
                    value={cr.max}
                    onChange={(e) => updateColorRange(anim.id, anim.options.ranges ?? [], idx, 'max', Number(e.target.value))}
                    className="w-14 px-2 py-1 text-xs border border-gray-300 rounded"
                    placeholder="Max"
                  />
                  <input
                    type="color"
                    value={cr.fill}
                    onChange={(e) => updateColorRange(anim.id, anim.options.ranges ?? [], idx, 'fill', e.target.value)}
                    className="w-8 h-7 border border-gray-300 rounded cursor-pointer"
                  />
                  <button
                    onClick={() => removeColorRange(anim.id, anim.options.ranges ?? [], idx)}
                    className="text-red-400 hover:text-red-600 text-xs px-1"
                  >
                    X
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* fillLevel */}
          {anim.type === 'fillLevel' && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Fill Min</label>
                  <input
                    type="number"
                    value={anim.options.fillMin ?? 0}
                    onChange={(e) => updateAnimationOptions(anim.id, { fillMin: Number(e.target.value) })}
                    className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Fill Max</label>
                  <input
                    type="number"
                    value={anim.options.fillMax ?? 100}
                    onChange={(e) => updateAnimationOptions(anim.id, { fillMax: Number(e.target.value) })}
                    className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Warning %</label>
                  <input
                    type="number"
                    value={anim.options.fillWarningThreshold ?? 70}
                    onChange={(e) => updateAnimationOptions(anim.id, { fillWarningThreshold: Number(e.target.value) })}
                    min={0}
                    max={100}
                    className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Critical %</label>
                  <input
                    type="number"
                    value={anim.options.fillCriticalThreshold ?? 90}
                    onChange={(e) => updateAnimationOptions(anim.id, { fillCriticalThreshold: Number(e.target.value) })}
                    min={0}
                    max={100}
                    className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  />
                </div>
              </div>
            </div>
          )}

          {/* move */}
          {anim.type === 'move' && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">To X</label>
                  <input
                    type="number"
                    value={anim.options.toX ?? 0}
                    onChange={(e) => updateAnimationOptions(anim.id, { toX: Number(e.target.value) })}
                    className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">To Y</label>
                  <input
                    type="number"
                    value={anim.options.toY ?? 0}
                    onChange={(e) => updateAnimationOptions(anim.id, { toY: Number(e.target.value) })}
                    className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Duration (ms)</label>
                <input
                  type="number"
                  value={anim.options.duration ?? 1000}
                  onChange={(e) => updateAnimationOptions(anim.id, { duration: Number(e.target.value) })}
                  min={100}
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                />
              </div>
            </div>
          )}

          {/* Bitmask (collapsible) */}
          <div className="pt-1 border-t border-gray-200">
            <button
              onClick={() => toggleBitmask(anim.id)}
              className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-600"
            >
              {expandedBitmask[anim.id] ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              Bitmask (optional)
            </button>
            {expandedBitmask[anim.id] && (
              <div className="mt-1">
                <input
                  type="number"
                  value={anim.bitmask ?? ''}
                  onChange={(e) =>
                    updateAnimation(anim.id, {
                      bitmask: e.target.value === '' ? undefined : Number(e.target.value),
                    })
                  }
                  placeholder="Bitmask value"
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};
