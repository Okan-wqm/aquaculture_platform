/**
 * AnimationsPanel — UI for adding/editing/removing AnimationRule[] on a widget.
 *
 * Animation rules bind to device tags for real-time value-driven animations.
 * TagBrowser integration replaces error-prone manual tag name entry
 * with validated selection from the device's tag inventory.
 *
 * Supports 12 animation types covering FUXA-parity features:
 * - Original 7: colorRange, rotate, blink, hide, show, fillLevel, move
 * - Extended 5: valueMappedRotation, piston, imageAlongPath, recursiveColor, scale
 *
 * Preview mode allows operators to test animations in-place by injecting
 * synthetic tag values through the TagValueBus without entering simulation mode.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight, Play, Pause } from 'lucide-react';
import type { AnimationRule, AnimationRuleType, AnimationOptions, ColorRange } from '../../../engine/animation/types';
import { TagBrowser } from '../TagBrowser';
import { RangeColorMapping } from './RangeColorMapping';
import { TagValueBus } from '../../../engine/tags/TagValueBus';

/**
 * Animation type options extended with FUXA-parity types.
 * Each option includes a descriptive label that helps operators
 * understand the visual effect without needing documentation.
 */
const ANIMATION_TYPE_OPTIONS: Array<{ value: AnimationRuleType; label: string }> = [
  { value: 'colorRange', label: 'Color Range' },
  { value: 'rotate', label: 'Continuous Rotation' },
  { value: 'blink', label: 'Blink' },
  { value: 'hide', label: 'Hide When In Range' },
  { value: 'show', label: 'Show When In Range' },
  { value: 'fillLevel', label: 'Fill Level' },
  { value: 'move', label: 'Move To Position' },
  { value: 'valueMappedRotation', label: 'Value-Mapped Rotation' },
  { value: 'piston', label: 'Piston (Vertical Oscillation)' },
  { value: 'imageAlongPath', label: 'Image Along Path' },
  { value: 'recursiveColor', label: 'Recursive Color (CSS Variables)' },
  { value: 'scale', label: 'Value-Mapped Scale' },
  { value: 'opacity', label: 'Opacity Fade' },
  { value: 'videoPlayback', label: 'Video Playback Control' },
  { value: 'textFormat', label: 'Text Value Format' },
];

/** Shared CSS class strings to keep JSX clean and consistent */
const INPUT_CLASS =
  'w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500';

interface AnimationsPanelProps {
  animations: AnimationRule[];
  onChange: (animations: AnimationRule[]) => void;
  /** Edge device ID for tag discovery via TagBrowser */
  deviceId?: string | null;
  /**
   * Optional TagValueBus instance for preview mode.
   * When provided, the preview slider publishes synthetic tag values
   * through this bus, driving the animation engine in real time.
   * Typically supplied by the ScadaRuntimeContext when available.
   */
  tagBus?: TagValueBus | null;
}

export const AnimationsPanel: React.FC<AnimationsPanelProps> = ({
  animations,
  onChange,
  deviceId,
  tagBus,
}) => {
  const [expandedBitmask, setExpandedBitmask] = useState<Record<string, boolean>>({});
  const [previewActive, setPreviewActive] = useState(false);
  const [previewValue, setPreviewValue] = useState(50);

  /**
   * Reference to the currently expanded/focused animation rule ID.
   * Preview slider drives this specific rule's tag when active.
   */
  const [focusedAnimId, setFocusedAnimId] = useState<string | null>(null);

  /**
   * Publish synthetic preview value to TagValueBus whenever the slider
   * changes or preview mode toggles. This feeds the normal animation
   * pipeline (TagValueBus -> AnimationEngine -> ScadaWidgetNode) without
   * requiring a separate rendering path.
   */
  const publishPreviewRef = useRef<((value: number) => void) | null>(null);

  useEffect(() => {
    if (!previewActive || !tagBus || !focusedAnimId) {
      publishPreviewRef.current = null;
      return;
    }
    const anim = animations.find((a) => a.id === focusedAnimId);
    if (!anim?.tagName) {
      publishPreviewRef.current = null;
      return;
    }
    const tagName = anim.tagName;
    publishPreviewRef.current = (val: number) => {
      tagBus.publish(tagName, val);
    };
    // Publish the current slider value immediately when preview starts
    tagBus.publish(tagName, previewValue);
  }, [previewActive, tagBus, focusedAnimId, animations, previewValue]);

  const handlePreviewSliderChange = useCallback(
    (value: number) => {
      setPreviewValue(value);
      publishPreviewRef.current?.(value);
    },
    [],
  );

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
    if (focusedAnimId === id) setFocusedAnimId(null);
  };

  const handleTypeChange = (id: string, type: AnimationRuleType) => {
    // Reset options when type changes to avoid stale config leaking between types
    updateAnimation(id, { type, options: {} });
  };

  const toggleBitmask = (id: string) => {
    setExpandedBitmask((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // Color range helpers (used by the inline colorRange type)
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

  /** Resolve range bounds for the focused animation (used by preview slider) */
  const getFocusedRange = (): { min: number; max: number } => {
    if (!focusedAnimId) return { min: 0, max: 100 };
    const anim = animations.find((a) => a.id === focusedAnimId);
    return anim?.range ?? { min: 0, max: 100 };
  };

  const focusedRange = getFocusedRange();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-700">Animations</h4>
        <div className="flex items-center gap-2">
          {/* Preview toggle — only visible when there are animations to preview */}
          {animations.length > 0 && (
            <button
              onClick={() => setPreviewActive((prev) => !prev)}
              className={`flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors ${
                previewActive
                  ? 'bg-cyan-100 text-cyan-700 border border-cyan-300'
                  : 'text-gray-500 hover:text-gray-700 border border-gray-200'
              }`}
              data-testid="preview-toggle"
              title={previewActive ? 'Stop animation preview' : 'Start animation preview'}
            >
              {previewActive ? (
                <Pause className="w-3 h-3" />
              ) : (
                <Play className="w-3 h-3" />
              )}
              Preview
            </button>
          )}
          <button
            onClick={addAnimation}
            className="flex items-center gap-1 text-xs text-cyan-600 hover:text-cyan-700"
          >
            <Plus className="w-3 h-3" />
            Add Animation
          </button>
        </div>
      </div>

      {/* Preview slider — appears when preview is active and an animation is focused */}
      {previewActive && focusedAnimId && (
        <div
          className="px-3 py-2 bg-cyan-50 border border-cyan-200 rounded-lg space-y-1"
          data-testid="preview-slider-container"
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-cyan-700 uppercase">
              Preview Value
            </span>
            <span className="text-xs text-cyan-600 font-mono">{previewValue}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-cyan-600 min-w-[2rem] text-right">
              {focusedRange.min}
            </span>
            <input
              type="range"
              min={focusedRange.min}
              max={focusedRange.max}
              step={(focusedRange.max - focusedRange.min) / 100 || 1}
              value={previewValue}
              onChange={(e) => handlePreviewSliderChange(Number(e.target.value))}
              className="flex-1 accent-cyan-600"
              data-testid="preview-slider"
            />
            <span className="text-[10px] text-cyan-600 min-w-[2rem]">
              {focusedRange.max}
            </span>
          </div>
        </div>
      )}

      {animations.length === 0 && (
        <p className="text-xs text-gray-500 py-4 text-center">No animations configured.</p>
      )}

      {animations.map((anim) => (
        <div
          key={anim.id}
          className={`p-3 bg-gray-50 rounded-lg space-y-2 border transition-colors ${
            previewActive && focusedAnimId === anim.id
              ? 'border-cyan-300 ring-1 ring-cyan-200'
              : 'border-gray-100'
          }`}
          onClick={() => setFocusedAnimId(anim.id)}
        >
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
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Range Max</label>
              <input
                type="number"
                value={anim.range.max}
                onChange={(e) => updateAnimation(anim.id, { range: { ...anim.range, max: Number(e.target.value) } })}
                className={INPUT_CLASS}
              />
            </div>
          </div>

          {/* Type */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Type</label>
            <select
              value={anim.type}
              onChange={(e) => handleTypeChange(anim.id, e.target.value as AnimationRuleType)}
              className={INPUT_CLASS}
              data-testid="animation-type-select"
            >
              {ANIMATION_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* ============================================================ */}
          {/*  Type-specific configuration inputs                           */}
          {/* ============================================================ */}

          {/* rotate — continuous rotation driven by tag threshold */}
          {anim.type === 'rotate' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Speed (ms)</label>
                <input
                  type="number"
                  value={anim.options.rotationSpeed ?? 2000}
                  onChange={(e) => updateAnimationOptions(anim.id, { rotationSpeed: Number(e.target.value) })}
                  min={100}
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Direction</label>
                <select
                  value={anim.options.direction ?? 'cw'}
                  onChange={(e) => updateAnimationOptions(anim.id, { direction: e.target.value as 'cw' | 'ccw' })}
                  className={INPUT_CLASS}
                >
                  <option value="cw">Clockwise</option>
                  <option value="ccw">Counter-CW</option>
                </select>
              </div>
            </div>
          )}

          {/* blink — alternating colors when tag is in range */}
          {anim.type === 'blink' && (
            <div className="space-y-2">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Interval (ms)</label>
                <input
                  type="number"
                  value={anim.options.blinkInterval ?? 1000}
                  onChange={(e) => updateAnimationOptions(anim.id, { blinkInterval: Number(e.target.value) })}
                  min={100}
                  className={INPUT_CLASS}
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

          {/* colorRange — value-to-color mapping with inline editor */}
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

          {/* fillLevel — tank/vessel fill visualization */}
          {anim.type === 'fillLevel' && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Fill Min</label>
                  <input
                    type="number"
                    value={anim.options.fillMin ?? 0}
                    onChange={(e) => updateAnimationOptions(anim.id, { fillMin: Number(e.target.value) })}
                    className={INPUT_CLASS}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Fill Max</label>
                  <input
                    type="number"
                    value={anim.options.fillMax ?? 100}
                    onChange={(e) => updateAnimationOptions(anim.id, { fillMax: Number(e.target.value) })}
                    className={INPUT_CLASS}
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
                    className={INPUT_CLASS}
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
                    className={INPUT_CLASS}
                  />
                </div>
              </div>
            </div>
          )}

          {/* move — translate widget position based on tag value */}
          {anim.type === 'move' && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">To X</label>
                  <input
                    type="number"
                    value={anim.options.toX ?? 0}
                    onChange={(e) => updateAnimationOptions(anim.id, { toX: Number(e.target.value) })}
                    className={INPUT_CLASS}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">To Y</label>
                  <input
                    type="number"
                    value={anim.options.toY ?? 0}
                    onChange={(e) => updateAnimationOptions(anim.id, { toY: Number(e.target.value) })}
                    className={INPUT_CLASS}
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
                  className={INPUT_CLASS}
                />
              </div>
            </div>
          )}

          {/* valueMappedRotation — linear mapping from tag value range to angle range */}
          {anim.type === 'valueMappedRotation' && (
            <div className="space-y-2" data-testid="value-mapped-rotation-config">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Min Angle</label>
                  <input
                    type="number"
                    value={anim.options.minAngle ?? 0}
                    onChange={(e) => updateAnimationOptions(anim.id, { minAngle: Number(e.target.value) })}
                    min={-360}
                    max={360}
                    className={INPUT_CLASS}
                    data-testid="min-angle-input"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Max Angle</label>
                  <input
                    type="number"
                    value={anim.options.maxAngle ?? 360}
                    onChange={(e) => updateAnimationOptions(anim.id, { maxAngle: Number(e.target.value) })}
                    min={-360}
                    max={360}
                    className={INPUT_CLASS}
                    data-testid="max-angle-input"
                  />
                </div>
              </div>
              {/* Visual hint: SVG needle showing rotation range */}
              <div className="flex justify-center py-2">
                <svg width="64" height="64" viewBox="0 0 64 64" className="opacity-40">
                  <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="4 2" />
                  <line
                    x1="32" y1="32"
                    x2={32 + 20 * Math.cos(((anim.options.minAngle ?? 0) - 90) * Math.PI / 180)}
                    y2={32 + 20 * Math.sin(((anim.options.minAngle ?? 0) - 90) * Math.PI / 180)}
                    stroke="#94a3b8" strokeWidth="2" strokeLinecap="round"
                  />
                  <line
                    x1="32" y1="32"
                    x2={32 + 24 * Math.cos(((anim.options.maxAngle ?? 360) - 90) * Math.PI / 180)}
                    y2={32 + 24 * Math.sin(((anim.options.maxAngle ?? 360) - 90) * Math.PI / 180)}
                    stroke="#0891b2" strokeWidth="2" strokeLinecap="round"
                  />
                  <circle cx="32" cy="32" r="3" fill="#0891b2" />
                </svg>
              </div>
            </div>
          )}

          {/* piston — vertical oscillation for pump/compressor symbols */}
          {anim.type === 'piston' && (
            <div className="grid grid-cols-2 gap-2" data-testid="piston-config">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Distance (px)</label>
                <input
                  type="number"
                  value={anim.options.pistonDistance ?? 20}
                  onChange={(e) => updateAnimationOptions(anim.id, { pistonDistance: Number(e.target.value) })}
                  min={5}
                  max={100}
                  className={INPUT_CLASS}
                  data-testid="piston-distance-input"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Duration (ms)</label>
                <input
                  type="number"
                  value={anim.options.pistonDuration ?? 1000}
                  onChange={(e) => updateAnimationOptions(anim.id, { pistonDuration: Number(e.target.value) })}
                  min={100}
                  max={5000}
                  className={INPUT_CLASS}
                  data-testid="piston-duration-input"
                />
              </div>
            </div>
          )}

          {/* imageAlongPath — image traveling along SVG path for flow visualization */}
          {anim.type === 'imageAlongPath' && (
            <div className="space-y-2" data-testid="image-along-path-config">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Motion Path (SVG d-attribute)</label>
                <textarea
                  value={anim.options.motionPath ?? ''}
                  onChange={(e) => updateAnimationOptions(anim.id, { motionPath: e.target.value })}
                  placeholder="M 0,50 C 25,0 75,100 100,50"
                  rows={3}
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 font-mono resize-y"
                  data-testid="motion-path-textarea"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Duration (ms)</label>
                <input
                  type="number"
                  value={anim.options.motionDuration ?? 3000}
                  onChange={(e) => updateAnimationOptions(anim.id, { motionDuration: Number(e.target.value) })}
                  min={500}
                  max={30000}
                  className={INPUT_CLASS}
                  data-testid="motion-duration-input"
                />
              </div>
            </div>
          )}

          {/* recursiveColor — CSS custom property cascading to all SVG children */}
          {anim.type === 'recursiveColor' && (
            <div className="space-y-2" data-testid="recursive-color-config">
              <div>
                <label className="block text-xs text-gray-500 mb-1">CSS Variable Name</label>
                <input
                  type="text"
                  value={anim.options.colorVariable ?? '--scada-fill'}
                  onChange={(e) => updateAnimationOptions(anim.id, { colorVariable: e.target.value })}
                  placeholder="--scada-fill"
                  className={INPUT_CLASS}
                  data-testid="color-variable-input"
                />
              </div>
              <RangeColorMapping
                ranges={anim.options.ranges ?? []}
                onChange={(ranges) => updateAnimationOptions(anim.id, { ranges })}
              />
            </div>
          )}

          {/* scale — tag value to scale factor mapping */}
          {anim.type === 'scale' && (
            <div className="grid grid-cols-2 gap-2" data-testid="scale-config">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Min Scale</label>
                <input
                  type="number"
                  value={anim.options.minScale ?? 0.5}
                  onChange={(e) => updateAnimationOptions(anim.id, { minScale: Number(e.target.value) })}
                  min={0.1}
                  max={5}
                  step={0.1}
                  className={INPUT_CLASS}
                  data-testid="min-scale-input"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Max Scale</label>
                <input
                  type="number"
                  value={anim.options.maxScale ?? 2.0}
                  onChange={(e) => updateAnimationOptions(anim.id, { maxScale: Number(e.target.value) })}
                  min={0.1}
                  max={5}
                  step={0.1}
                  className={INPUT_CLASS}
                  data-testid="max-scale-input"
                />
              </div>
            </div>
          )}

          {/* opacity — gradual fade based on tag value range */}
          {anim.type === 'opacity' && (
            <div className="grid grid-cols-2 gap-2" data-testid="opacity-config">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Min Opacity</label>
                <input
                  type="number"
                  value={anim.options.minOpacity ?? 0}
                  onChange={(e) => updateAnimationOptions(anim.id, { minOpacity: Number(e.target.value) })}
                  min={0}
                  max={1}
                  step={0.05}
                  className={INPUT_CLASS}
                  data-testid="min-opacity-input"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Max Opacity</label>
                <input
                  type="number"
                  value={anim.options.maxOpacity ?? 1}
                  onChange={(e) => updateAnimationOptions(anim.id, { maxOpacity: Number(e.target.value) })}
                  min={0}
                  max={1}
                  step={0.05}
                  className={INPUT_CLASS}
                  data-testid="max-opacity-input"
                />
              </div>
            </div>
          )}

          {/* videoPlayback — tag-driven video play/pause/stop control */}
          {anim.type === 'videoPlayback' && (
            <div data-testid="video-playback-config">
              <label className="block text-xs text-gray-500 mb-1">Video Action</label>
              <select
                value={anim.options.videoAction ?? 'play'}
                onChange={(e) => updateAnimationOptions(anim.id, { videoAction: e.target.value as 'play' | 'pause' | 'stop' })}
                className={INPUT_CLASS}
                data-testid="video-action-select"
              >
                <option value="play">Play</option>
                <option value="pause">Pause</option>
                <option value="stop">Stop</option>
              </select>
            </div>
          )}

          {/* textFormat — printf-style formatted tag value display */}
          {anim.type === 'textFormat' && (
            <div className="space-y-2" data-testid="text-format-config">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Format Template</label>
                <input
                  type="text"
                  value={anim.options.textFormat ?? '%.2f'}
                  onChange={(e) => updateAnimationOptions(anim.id, { textFormat: e.target.value })}
                  placeholder="%.2f"
                  className={`${INPUT_CLASS} font-mono`}
                  data-testid="text-format-input"
                />
              </div>
              <div className="text-[10px] text-gray-400 space-y-0.5 px-1">
                <p><code className="bg-gray-100 px-1 rounded">%.2f</code> &rarr; 3.14</p>
                <p><code className="bg-gray-100 px-1 rounded">%d%%</code> &rarr; 75%</p>
                <p><code className="bg-gray-100 px-1 rounded">Temp: %.1f&deg;C</code> &rarr; Temp: 23.5&deg;C</p>
              </div>
            </div>
          )}

          {/* Bitmask (collapsible) — optional bitwise filter for multi-flag tags */}
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
                  className={INPUT_CLASS}
                />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};
