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

      case 'valueMappedRotation': {
        /**
         * Linear interpolation from tag value range to angle range.
         * Used for valve position indicators, gauge needles, and
         * directional displays that need value-proportional rotation.
         * Unlike 'rotate' (continuous spinning), this produces a static
         * angle that reflects the current tag value.
         */
        const vmrMinAngle = opts.minAngle ?? 0;
        const vmrMaxAngle = opts.maxAngle ?? 360;
        const vmrTagMin = rule.range.min;
        const vmrTagMax = rule.range.max;
        const vmrRatio = vmrTagMax !== vmrTagMin
          ? (effective - vmrTagMin) / (vmrTagMax - vmrTagMin)
          : 0;
        const vmrClamped = Math.max(0, Math.min(1, vmrRatio));
        state.mappedRotation = vmrMinAngle + vmrClamped * (vmrMaxAngle - vmrMinAngle);
        break;
      }

      case 'piston': {
        /**
         * Vertical oscillation animation for pump and compressor symbols.
         * Activated when the tag value falls within the rule's trigger range.
         * CSS keyframes handle the actual animation — the engine only sets
         * the distance and duration parameters for the renderer to consume.
         */
        state.pistoning = true;
        state.pistonDistance = opts.pistonDistance ?? 20;
        state.pistonDuration = opts.pistonDuration ?? 1000;
        break;
      }

      case 'imageAlongPath': {
        /**
         * Activates SVG animateMotion for an image traveling along a path.
         * Used for flow visualization in pipe networks where a small icon
         * (bubble, particle) follows a defined SVG path continuously.
         */
        state.motionActive = true;
        state.motionPath = opts.motionPath ?? '';
        state.motionDuration = opts.motionDuration ?? 3000;
        break;
      }

      case 'recursiveColor': {
        /**
         * Sets CSS custom properties that cascade to all SVG children.
         * Avoids expensive DOM walking — uses CSS inheritance instead.
         * Widgets reference var(--scada-fill) and var(--scada-stroke) in
         * their SVG markup so a single property change recolors everything.
         */
        const rcRanges = opts.ranges;
        if (rcRanges && Array.isArray(rcRanges)) {
          for (const r of rcRanges) {
            if (effective >= r.min && effective <= r.max) {
              state.cssVariables = {
                ...state.cssVariables,
                '--scada-fill': r.fill || '',
                '--scada-stroke': r.stroke || '',
              };
              break;
            }
          }
        }
        break;
      }

      case 'scale': {
        /**
         * Linear interpolation from tag value range to scale factor range.
         * Used for proportional size indicators (tank fill level icons,
         * load indicators) where the widget should grow/shrink based on
         * the current tag value.
         */
        const scMinScale = opts.minScale ?? 0.5;
        const scMaxScale = opts.maxScale ?? 2.0;
        const scTagMin = rule.range.min;
        const scTagMax = rule.range.max;
        const scRatio = scTagMax !== scTagMin
          ? (effective - scTagMin) / (scTagMax - scTagMin)
          : 0;
        const scClamped = Math.max(0, Math.min(1, scRatio));
        state.mappedScale = scMinScale + scClamped * (scMaxScale - scMinScale);
        break;
      }
    }
  }
  return state;
}
