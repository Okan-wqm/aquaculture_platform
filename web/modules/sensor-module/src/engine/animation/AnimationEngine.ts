import type { AnimationRule, AnimationState, ColorRange } from './types';
import { DEFAULT_ANIMATION_STATE } from './types';

function applyBitmask(value: number, bitmask?: number): number {
  if (!bitmask) return value;
  const masked = value & bitmask;
  let shift = 0;
  let m = bitmask;
  while (m > 0 && (m & 1) === 0) { shift++; m >>= 1; }
  return masked >> shift;
}

function resolveColor(value: number, ranges: ColorRange[]): { fill?: string; stroke?: string } | null {
  for (const r of ranges) {
    if (value >= r.min && value <= r.max) return { fill: r.fill, stroke: r.stroke };
  }
  return null;
}

export function evaluate(rules: AnimationRule[], tagValues: Record<string, unknown>): AnimationState {
  const state: AnimationState = { ...DEFAULT_ANIMATION_STATE };

  for (const rule of rules) {
    const raw = tagValues[rule.tagName];
    if (raw === undefined) continue;
    const num = typeof raw === 'boolean' ? (raw ? 1 : 0) : Number(raw);
    if (Number.isNaN(num)) continue;
    const effective = applyBitmask(num, rule.bitmask);
    const inRange = effective >= rule.range.min && effective <= rule.range.max;
    if (!inRange) continue;

    const opts = rule.options;
    switch (rule.type) {
      case 'hide': state.visible = false; break;
      case 'show': state.visible = true; break;
      case 'rotate':
        state.rotating = true;
        state.rotationSpeed = opts.rotationSpeed ?? 2000;
        state.rotationDirection = opts.direction ?? 'cw';
        break;
      case 'blink':
        state.blinking = true;
        state.blinkInterval = opts.blinkInterval ?? 1000;
        state.blinkFillA = opts.fillA;
        state.blinkFillB = opts.fillB;
        state.blinkStrokeA = opts.strokeA;
        state.blinkStrokeB = opts.strokeB;
        break;
      case 'colorRange': {
        const resolved = resolveColor(effective, opts.ranges ?? []);
        if (resolved?.fill) state.fill = resolved.fill;
        if (resolved?.stroke) state.stroke = resolved.stroke;
        break;
      }
      case 'fillLevel': {
        const min = opts.fillMin ?? 0;
        const max = opts.fillMax ?? 100;
        const pct = Math.max(0, Math.min(100, ((effective - min) / (max - min)) * 100));
        state.fillPercent = pct;
        state.fillColor = opts.fillColor;
        if (opts.fillCriticalThreshold != null && pct >= opts.fillCriticalThreshold) {
          state.fillColor = opts.fillCriticalColor ?? '#ef4444';
        } else if (opts.fillWarningThreshold != null && pct >= opts.fillWarningThreshold) {
          state.fillColor = opts.fillWarningColor ?? '#eab308';
        }
        break;
      }
      case 'move':
        state.translateX = opts.toX ?? 0;
        state.translateY = opts.toY ?? 0;
        state.transitionDuration = opts.duration ?? 500;
        break;
    }
  }
  return state;
}
